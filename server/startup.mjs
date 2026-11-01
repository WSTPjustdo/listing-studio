/**
 * 「服务起不来」的这一小段：把 Node 的 listen 错误翻译成现场能照着做的一句话。
 *
 * 为什么单独一个模块：
 *   2026-10-30 实测，8787 已被占用时窗口里是 18 行 Node 堆栈（`Unhandled 'error' event` +
 *   `at Server.setupListenHandle`），一个字都没说「已经有窗口在跑」或「换端口」。
 *   而演示当天最容易犯的错就是双击两次 —— 第二次双击的人看到的就是这堆东西。
 *
 * 判据不是猜：先 GET /api/health 问一下占着这个端口的东西，
 *   - 回 `{ok:true, version:"x"}`  → 是我们自己的旧实例（已经在跑，直接用）
 *   - 回了但不是这个形状        → 别的程序（换端口）
 *   - 连不上                    → 刚退出或状态不正常（等两秒 / 换端口）
 * 没有这一步就分不清「我开过了」和「别的软件占了 8787」，两种情况的下一步完全不同。
 */

import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WILDCARD = new Set(["0.0.0.0", "::", "[::]", ""]);

// 自己算根目录，不 import store.mjs：那个模块会在 import 时读三份 JSON，
// 而这一句提醒只需要一个路径。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 监听在通配地址上时，探针要打 127.0.0.1（打 0.0.0.0 在某些环境上会被拒）。 */
export function probeHost(hostname = "127.0.0.1") {
  return WILDCARD.has(hostname) ? "127.0.0.1" : hostname;
}

/** 这部分前端源码改了就必须重新构建才能看到（服务端发的是 dist/）。 */
const FRONTEND_SOURCES = ["src", "index.html", "vite.config.ts", "tsconfig.json"];

function newestIn(target, cutoff = 0) {
  // 递归取最新 mtime。entries 很少（src 下几十个文件），启动时算一次不心疼。
  let newest = null;
  let count = 0;
  const walk = (path) => {
    let info;
    try {
      info = statSync(path);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      let names = [];
      try {
        names = readdirSync(path);
      } catch {
        return;
      }
      for (const name of names) walk(join(path, name));
      return;
    }
    if (info.mtimeMs <= cutoff) return;
    count += 1;
    if (!newest || info.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: info.mtimeMs };
  };
  walk(target);
  return { newest, count };
}

/**
 * 前端产物（dist/）是不是比源码旧。
 *
 * 为什么要有这个：这个仓库踩过不止一次「改完 src/ 直接 npm start，界面上一点变化都没有」，
 * 因为服务端发的是 dist/。以前窗口里一句话都没有，只能靠人自己想起来先 build。
 * `npm run dev`（--watch）走的是 5173，不该被这条吵到，所以默认在 watch 模式下不打印。
 */
export function frontendStaleness({ root = ROOT, distDir = join(ROOT, "dist") } = {}) {
  const indexHtml = join(distDir, "index.html");
  let buildTime = null;
  try {
    buildTime = statSync(indexHtml).mtimeMs;
  } catch {
    // 没构建过：由 /api/health 之外的 BUILD_REQUIRED 负责解释，这里不重复
    return { missing: true, stale: false };
  }
  let newest = null;
  let count = 0;
  for (const rel of FRONTEND_SOURCES) {
    const found = newestIn(join(root, rel), buildTime);
    count += found.count;
    if (found.newest && (!newest || found.newest.mtimeMs > newest.mtimeMs)) newest = found.newest;
  }
  // 1 秒的余量：同一秒内写完的文件不报，避免刚 build 完就假红。
  const stale = Boolean(newest) && newest.mtimeMs > buildTime + 1000;
  return {
    missing: false,
    stale,
    build_time_ms: buildTime,
    newest_source: newest ? relative(root, newest.path).replace(/\\/g, "/") : null,
    newer_count: count,
    seconds_behind: stale ? Math.round((newest.mtimeMs - buildTime) / 1000) : 0,
  };
}

/** 启动时的一句话提醒；不值得提醒时返回 []。 */
export function stalenessWarning(info, { watching = false } = {}) {
  if (!info || info.missing || !info.stale || watching) return [];
  const behind = humanDuration(info.seconds_behind);
  return [
    `注意：前端产物比源码旧（${info.newest_source} 等 ${info.newer_count} 个文件比 dist/ 新 ${behind}）。`,
    `这个地址现在发的是上一次构建的页面。要看到改动先跑 npm run build，再刷新浏览器。`,
  ];
}

function humanDuration(seconds) {
  if (seconds < 90) return `${seconds} 秒`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} 分钟`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} 小时`;
  return `${Math.round(seconds / 86400)} 天`;
}

/**
 * 问一下端口上那个进程是谁。
 * 返回 { kind: "ours" | "other" | "unreachable", ... }，永不抛异常。
 */
export async function probeOccupant({ hostname = "127.0.0.1", port, timeoutMs = 1500 } = {}) {
  const host = probeHost(hostname);
  const url = `http://${host}:${port}/api/health`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    // 只认我们自己 /api/health 的形状：ok 为 true 且带 version。
    // 只判 status 200 是不够的（200 + HTML 也能是「连上了」以外的任何东西）。
    if (body && body.ok === true && typeof body.version === "string")
      return { kind: "ours", version: body.version, status: res.status };
    return {
      kind: "other",
      status: res.status,
      contentType: String(res.headers.get("content-type") || "").split(";")[0] || null,
      sample: text.replace(/\s+/g, " ").trim().slice(0, 60),
    };
  } catch (error) {
    const reason =
      error?.name === "TimeoutError"
        ? "timeout"
        : error?.cause?.code || error?.code || "unreachable";
    return { kind: "unreachable", reason };
  }
}

/**
 * 纯函数：给定 listen 错误与探针结果，给出「说什么 + 用哪个退出码」。
 * 退出码是给 start-local.cmd 用的：3 = 自己已经在跑（不算失败），4 = 端口被别人占。
 */
export function describeListenFailure({ error, hostname = "127.0.0.1", port, probe = null } = {}) {
  const code = error?.code || "UNKNOWN";

  if (code !== "EADDRINUSE") {
    return {
      exitCode: 1,
      lines: [
        `本地服务起不来：${code}。`,
        error?.message ? `Node 原文：${error.message}` : null,
        `如果不是端口被占，多半是地址写错了（当前 ${hostname}:${port}）。`,
        `可以换一个端口再试：set PORT=8788 然后 npm start。`,
      ].filter(Boolean),
    };
  }

  if (probe?.kind === "ours") {
    return {
      exitCode: 3,
      lines: [
        `端口 ${port} 上已经有一个 Listing Studio 在运行（版本 ${probe.version}）。`,
        `不用再启动一次，直接打开 http://127.0.0.1:${port}/ 就能用。`,
        `如果那个窗口找不到了：netstat -ano | findstr :${port} 看最后一列的进程号，再用 taskkill /PID <进程号> /T /F 结束它。`,
      ],
    };
  }

  if (probe?.kind === "other") {
    return {
      exitCode: 4,
      lines: [
        `端口 ${port} 被别的程序占着（它回的是 ${probe.contentType || "非 JSON 内容"}，不是 Listing Studio）。`,
        `换一个端口启动：set PORT=8788 然后 npm start，浏览器打开 http://127.0.0.1:8788/。`,
        `想知道是谁占着：netstat -ano | findstr :${port}，最后一列是进程号。`,
      ],
    };
  }

  return {
    exitCode: 4,
    lines: [
      `端口 ${port} 报告被占用，但连不上里面的进程（${probe?.reason || "unreachable"}）。`,
      `等两秒再点一次；还是一样就换端口：set PORT=8788 然后 npm start。`,
    ],
  };
}
