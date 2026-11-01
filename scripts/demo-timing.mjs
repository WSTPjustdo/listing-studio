/**
 * 冷启动实测：从敲命令到"第一个按钮能点"，到底几秒。
 *
 * 用法：
 *   node scripts/demo-timing.mjs                 # 生产模式（npm start，读 dist/）
 *   node scripts/demo-timing.mjs --mode dev      # 开发模式（npm run dev，vite 5173）
 *   node scripts/demo-timing.mjs --runs 3        # 重复几轮取中位数（默认 3）
 *   node scripts/demo-timing.mjs --json          # 只打一行 JSON
 *
 * 量的四段：
 *   1. spawn → /api/health 200          （服务起来没有）
 *   2. spawn → 首屏 HTML 拿到            （页面开始下载）
 *   3. spawn → .nav-item 可见            （界面真的能点了，这一格才是"演示可以开始"）
 *   4. 首屏请求数 / 传输字节             （为什么慢：是在等编译还是在传一堆模块）
 *
 * 说明：
 *   - 浏览器用本机 Edge（playwright 的 chromium 没装，`channel: "msedge"` 不需要下载）。
 *   - 只读项目，只写 stdout（--json 时写 stdout 一行）。不写 data/、不改 dist/。
 *   - 生产模式要求 dist/ 已存在；不存在会直接报错说清楚，而不是量一个假数。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { ROOT } from "../server/store.mjs";

const args = process.argv.slice(2);
const mode = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "prod";
const runs = Number(args.includes("--runs") ? args[args.indexOf("--runs") + 1] : 3) || 3;
const asJson = args.includes("--json");
const PORT = 8787;
const VITE_PORT = 5173;
const isWin = process.platform === "win32";

if (!["prod", "dev"].includes(mode)) {
  console.error("--mode 只能是 prod 或 dev");
  process.exit(2);
}
if (mode === "prod" && !existsSync(resolve(ROOT, "dist", "index.html"))) {
  console.error("dist/index.html 不存在：先跑 npm run build，否则生产模式量的是 404 页面。");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, startedAt, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return Date.now() - startedAt;
    } catch {
      /* 还没起来 */
    }
    await sleep(50);
  }
  throw new Error(`${url} 在 ${timeoutMs}ms 内没有就绪`);
}

function startServer() {
  const cmd = isWin ? "npm.cmd" : "npm";
  const child = spawn(cmd, mode === "prod" ? ["start"] : ["run", "dev"], {
    cwd: ROOT,
    shell: isWin,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), BROWSER: "none" },
  });
  const log = [];
  child.stdout.on("data", (b) => log.push(String(b)));
  child.stderr.on("data", (b) => log.push(String(b)));
  return { child, log };
}

function killTree(pid) {
  if (!pid) return;
  if (isWin) {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { /* 已经退了 */ }
  }
}

async function oneRun(browser, index) {
  const startedAt = Date.now();
  const { child, log } = startServer();
  const out = { run: index, mode };

  try {
    out.api_ready_ms = await waitHttp(`http://127.0.0.1:${PORT}/api/health`, startedAt);
    out.spawn_to_api_ready = out.api_ready_ms;

    const pageUrl =
      mode === "dev"
        ? `http://127.0.0.1:${VITE_PORT}/`
        : `http://127.0.0.1:${PORT}/`;
    if (mode === "dev") {
      out.vite_ready_ms = await waitHttp(`http://127.0.0.1:${VITE_PORT}/`, startedAt);
    }

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    let requests = 0;
    let bytes = 0;
    page.on("response", async (res) => {
      requests += 1;
      const len = Number(res.headers()["content-length"] || 0);
      if (len) bytes += len;
      else {
        try { bytes += (await res.body()).length; } catch { /* 取消的请求 */ }
      }
    });

    const tGoto = Date.now();
    const response = await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    out.http_status = response ? response.status() : null;
    out.goto_domcontentloaded_ms = Date.now() - startedAt;
    out.goto_only_ms = Date.now() - tGoto;

    await page.waitForSelector(".nav-item", { timeout: 120000 });
    out.ui_ready_ms = Date.now() - startedAt;

    // 首屏文本留证：确认看到的是工作台，不是错误页
    const bodyText = (await page.locator("body").innerText()).slice(0, 200);
    out.first_screen_text = bodyText.replace(/\s+/g, " ").trim();
    out.nav_items = await page.locator(".nav-item").count();
    out.requests = requests;
    out.bytes = bytes;

    // 再等一帧，确认导航真的可点（不是骨架屏）
    const clickable = await page.locator(".nav-item").first().isEnabled();
    out.nav_clickable = clickable;

    await context.close();
  } catch (error) {
    out.error = error.message;
    out.server_log_tail = log.join("").slice(-1200);
  } finally {
    killTree(child.pid);
    // 等端口真的释放，否则下一轮会去连上一轮的旧进程
    await sleep(600);
  }
  return out;
}

const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

const results = [];
let browser;
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ channel: "msedge" });
} catch (error) {
  console.error("启不动本机 Edge（playwright channel=msedge）：" + error.message.split("\n")[0]);
  process.exit(2);
}

try {
  for (let i = 0; i < runs; i += 1) results.push(await oneRun(browser, i + 1));
} finally {
  await browser.close();
}

const ok = results.filter((r) => !r.error);
const summary = {
  mode,
  runs: results.length,
  ok_runs: ok.length,
  spawnto_api_ready_ms_median: median(ok.map((r) => r.spawn_to_api_ready)),
  goto_domcontentloaded_ms_median: median(ok.map((r) => r.goto_domcontentloaded_ms)),
  ui_ready_ms_median: median(ok.map((r) => r.ui_ready_ms)),
  ui_ready_ms_all: ok.map((r) => r.ui_ready_ms),
  requests_median: median(ok.map((r) => r.requests)),
  bytes_median: median(ok.map((r) => r.bytes)),
  errors: results.filter((r) => r.error).map((r) => ({ run: r.run, error: r.error })),
  details: results,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 0));
} else {
  const line = (k, v, unit = "ms") => console.log(`  ${k.padEnd(30)} ${String(v).padStart(8)}${v == null ? "" : " " + unit}`);
  console.log(`\n冷启动实测 · mode=${mode} · ${ok.length}/${results.length} 轮有效\n`);
  line("spawn → /api/health 200", summary.spawnto_api_ready_ms_median);
  line("spawn → DOMContentLoaded", summary.goto_domcontentloaded_ms_median);
  line("spawn → 界面可点(.nav-item)", summary.ui_ready_ms_median);
  line("首屏请求数", summary.requests_median, "个");
  line("首屏传输", summary.bytes_median, "字节");
  console.log(`\n  各轮: ${summary.ui_ready_ms_all.join(" / ")} ms`);
  for (const d of results) {
    if (d.error) console.log(`\n  第 ${d.run} 轮失败：${d.error}\n  ${d.server_log_tail || ""}`);
  }
}

process.exit(summary.errors.length ? 1 : 0);
