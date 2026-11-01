/**
 * 量「双击 start-local.cmd」这条路：第一次拿到包的人，实际会经历什么。
 *
 * 用法：
 *   node scripts/start-local-probe.mjs              # 跑三个场景
 *   node scripts/start-local-probe.mjs --json
 *   node scripts/start-local-probe.mjs --strict     # 有红退出 1
 *   node scripts/start-local-probe.mjs --only cold
 *   node scripts/start-local-probe.mjs --keep       # 留住临时目录（排查用）
 *
 * 为什么要有这个：
 *   start-local.cmd 是 README 里唯一的「双击到能用」入口，但从第 1 版到第 17 轮
 *   **没有任何一次是照着它真跑过的**。冷启动 probe（cold-start-probe.mjs）量的是
 *   「依赖已装、spawn 服务 → 能点按钮」，它不是给人双击的那条路。
 *
 * 三个场景：
 *   A old-node  机器上装的是 Node 22（<24）时会看到什么
 *   B cold      干净导出（无 node_modules / 无 dist）→ 双击 → 到 /api/health 通
 *   C warm      同一个目录第二次双击（演示当天最常见的一次）
 *   D busy      8787 已经被占时，窗口里说的是什么（这是本轮要修的那个）
 *
 * 不联网（npm ci 走本机缓存；冷场景仍需要 npm registry 有缓存，没有缓存会变慢，
 * 这里如实记录，不掩饰）。不配 API Key，不调模型。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import process from "node:process";
import { ROOT } from "../server/store.mjs";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const strict = argv.includes("--strict");
const keep = argv.includes("--keep");
const onlyIndex = argv.indexOf("--only");
const only = onlyIndex >= 0 ? String(argv[onlyIndex + 1] || "").split(",") : null;

const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWin = process.platform === "win32";

const result = { scenarios: {}, checks: [], error: null };
const check = (name, ok, detail) => result.checks.push({ name, ok: Boolean(ok), detail: detail ?? null });

// ---------- 通用小工具 ----------

function killTree(pid) {
  if (!pid) return;
  if (isWin) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* 已经没了 */
    }
  }
}

async function waitPortFree(port, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await healthOf(port, 300)) return false;
    await sleep(150);
  }
  return true;
}

async function healthOf(port, timeout = 800) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body && body.ok === true ? body : null;
  } catch {
    return null;
  }
}

/** 把仓库 HEAD 导出成一个干净目录（和「解压交付包」最接近的一步，但不含 zip 的坑）。 */
function exportHead(dir) {
  const tarPath = join(dir, "__head.tar");
  const archive = spawnSync("git", ["archive", "--format=tar", "-o", tarPath, "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (archive.status !== 0) throw new Error(`git archive 失败：${(archive.stderr || "").trim()}`);
  // 本机 tar 会把 `C:\...` 当成「远程主机 C」，所以 cwd 设在目录里、只传裸文件名。
  const untar = spawnSync("tar", ["-xf", "__head.tar"], { cwd: dir, encoding: "utf8" });
  if (untar.status !== 0) throw new Error(`tar 解包失败：${(untar.stderr || "").trim()}`);
  rmSync(tarPath, { force: true });
  const count = countFiles(dir);
  if (!count) throw new Error("导出目录是空的");
  return count;
}

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else n += 1;
  }
  return n;
}

/** 本机找一个 major < 24 的 node，用来量「版本太旧」那条分支。找不找得到都不影响别的场景。 */
function findOldNode() {
  const candidates = [];
  try {
    candidates.push(dirname(process.execPath));
  } catch {
    /* ignore */
  }
  const versions = join(homedir(), ".workbuddy", "binaries", "node", "versions");
  if (existsSync(versions))
    for (const name of readdirSync(versions)) candidates.push(join(versions, name));
  candidates.push("C:\\Program Files\\nodejs");
  const seen = new Set();
  for (const dir of candidates) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const exe = join(dir, isWin ? "node.exe" : "node");
    if (!existsSync(exe)) continue;
    const v = spawnSync(exe, ["-v"], { encoding: "utf8" });
    const text = (v.stdout || "").trim();
    const major = Number((text.match(/^v(\d+)\./) || [])[1]);
    if (major && major < 24) return { dir, version: text };
  }
  return null;
}

/**
 * 跑一个 .cmd / 命令，异步（要边跑边探端口）。
 * stdin 设成 ignore：脚本里的 `pause` 读到 NUL 会立刻返回，不会把探针挂住。
 */
function run(cmd, args, { cwd, env, timeoutMs = 300000 } = {}) {
  const started = Date.now();
  const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  // 记下每一批输出到达的时刻：双击后窗口「看起来卡住」的唯一证据是两批输出之间的空档。
  const arrivals = [];
  const stamp = () => arrivals.push(Date.now() - started);
  child.stdout.on("data", (d) => {
    stdout += d.toString();
    stamp();
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
    stamp();
  });
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      killTree(child.pid);
      resolve({ code: null, timedOut: true, ms: Date.now() - started, stdout, stderr, arrivals });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false, ms: Date.now() - started, stdout, stderr, arrivals });
    });
  });
  return { child, done, log: () => `${stdout}${stderr}` };
}

/** 第一批输出多久到、最长一段完全没有输出有多久（从 0 起算，含启动那一段）。 */
function silence(arrivals, untilMs) {
  if (!arrivals.length) return { first_ms: untilMs, max_gap_ms: untilMs };
  const points = [0, ...arrivals, untilMs];
  let maxGap = 0;
  for (let i = 1; i < points.length; i++) maxGap = Math.max(maxGap, points[i] - points[i - 1]);
  return { first_ms: arrivals[0], max_gap_ms: Math.round(maxGap) };
}

const tail = (text, n = 24) => text.trim().split("\n").slice(-n).join("\n");

// ---------- 场景 A：Node 版本太旧 ----------

async function scenarioOldNode(dir) {
  const old = findOldNode();
  if (!old) return { skipped: "本机找不到 major < 24 的 node，这一条没量" };
  const env = {
    ...process.env,
    PATH: `${old.dir};${process.env.SystemRoot || "C:\\Windows"}\\system32;${process.env.SystemRoot || "C:\\Windows"}`,
    SystemRoot: process.env.SystemRoot || "C:\\Windows",
  };
  const r = run("cmd", ["/c", "start-local.cmd"], { cwd: dir, env, timeoutMs: 60000 });
  const out = await r.done;
  const log = `${out.stdout}${out.stderr}`;
  const out_record = {
    node_version: old.version,
    exit_code: out.code,
    ms: out.ms,
    says_install_24: /Node\.js 24/.test(log),
    says_installed_version: /v?\d+\.\d+\.\d+/.test(log.replace(/Node\.js 24/g, "")),
    output: tail(log, 6),
  };
  check("A 旧版本会被人话挡住", out.code !== 0 && out_record.says_install_24, out_record.output);
  check("A 提示里说清「你装的是哪个版本」", out_record.says_installed_version, out_record.output);
  return out_record;
}

// ---------- 场景 B/C：干净目录双击，冷 / 热各一次 ----------

function parseBuildNumbers(log) {
  return {
    npm_ci_seconds: Number((log.match(/added \d+ packages.*? in (\d+(?:\.\d+)?)s/) || [])[1]) || null,
    vite_build_ms: Number((log.match(/built in (\d+(?:\.\d+)?)(ms|s)/) || [])[1]) || null,
    vite_build_unit: (log.match(/built in (\d+(?:\.\d+)?)(ms|s)/) || [])[2] || null,
    warns: (log.match(/npm warn/g) || []).length,
  };
}

/** 把自己这个 node 放到 PATH 最前面：探针本身跑在 24+ 上，场景 B/C/D 要的是「>=24 的机器」。 */
function envWithThisNode() {
  const here = dirname(process.execPath);
  return { ...process.env, PATH: `${here};${process.env.PATH}` };
}

async function runStartLocal(dir, { label }) {
  const env = envWithThisNode();
  const startAt = Date.now();
  const r = run("cmd", ["/c", "start-local.cmd"], { cwd: dir, env, timeoutMs: 300000 });
  let ready = null;
  for (let i = 0; i < 1200; i++) {
    if (await healthOf(PORT, 400)) {
      ready = Date.now();
      break;
    }
    if (r.child.exitCode !== null) break;
    await sleep(100);
  }
  // 已经通了就停：start-local.cmd 会一直挂着窗口，探针自己收尸
  const health = await healthOf(PORT, 800);
  const page = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(3000) })
    .then((res) => res.status)
    .catch(() => null);
  killTree(r.child.pid);
  const out = await r.done;
  const log = `${out.stdout}${out.stderr}`;
  await waitPortFree(PORT);
  if (!ready) throw new Error(`${label}: 1200 次探测（约 120 秒）内 /api/health 没通`);
  const quiet = silence(out.arrivals, ready - startAt);
  return {
    label,
    _readyAt: ready,
    page_status: page,
    health_version: health?.version ?? null,
    has_open_url_line: /Open the URL printed by the server/.test(log),
    has_api_banner: /Listing Studio API: http:\/\/127\.0\.0\.1:8787/.test(log),
    first_output_ms: quiet.first_ms,
    max_silence_ms: quiet.max_gap_ms,
    ...parseBuildNumbers(log),
    output: tail(log, 10),
  };
}

async function scenarioColdWarm(dir, { exported }) {
  const files = exported;
  if (!files) exportHead(dir);
  const t0 = Date.now();
  const cold = await runStartLocal(dir, { label: "cold" });
  cold.ready_ms = cold._readyAt - t0;
  delete cold._readyAt;
  cold.files_in_export = files;
  cold.has_node_modules_after = existsSync(join(dir, "node_modules"));
  cold.has_dist_after = existsSync(join(dir, "dist"));

  const t1 = Date.now();
  const warm = await runStartLocal(dir, { label: "warm" });
  warm.ready_ms = warm._readyAt - t1;
  delete warm._readyAt;

  check("B 冷启动能到 /api/health 通", cold.ready_ms > 0, `${cold.ready_ms} ms`);
  check("B 首页返回 200", cold.page_status === 200, String(cold.page_status));
  check("B 窗口里打印了该打开的地址", cold.has_open_url_line && cold.has_api_banner, cold.output);
  // 双击后窗口 2 秒内必须有人说话，否则就是「点了没反应」。
  check("B 双击后 2 秒内窗口有输出", cold.first_output_ms < 2000, `${cold.first_output_ms} ms`);
  // 冷启动那段空档是 npm ci 自己在干活，实测 6–7 秒；[1/3] 先把话说明白，15 秒是上限。
  check(
    "B 最长一段完全没有输出 < 15 秒",
    cold.max_silence_ms < 15000,
    `${cold.max_silence_ms} ms（B 冷启动）／${warm.max_silence_ms} ms（C 第二次）`,
  );
  check("C 第二次双击也能到（依赖不再重装）", warm.ready_ms > 0 && warm.npm_ci_seconds === null, `${warm.ready_ms} ms`);
  return { cold, warm };
}

// ---------- 场景 D：8787 已被占 ----------

async function scenarioBusy(dir) {
  const env = envWithThisNode();

  // 单独跑这一条（--only busy）时目录里还没有依赖：先按 start-local.cmd 的前两步补上，
  // 否则第一个实例根本起不来，量到的是「缺依赖」而不是「端口被占」。
  if (!existsSync(join(dir, "node_modules"))) {
    const install = run("cmd", ["/c", "npm ci --no-audit --no-fund"], { cwd: dir, env, timeoutMs: 300000 });
    const out = await install.done;
    if (out.code !== 0) throw new Error(`D: 准备依赖失败（npm ci exit ${out.code}）`);
  }
  if (!existsSync(join(dir, "dist"))) {
    const build = run("cmd", ["/c", "npm run build"], { cwd: dir, env, timeoutMs: 300000 });
    const out = await build.done;
    if (out.code !== 0) throw new Error(`D: 准备构建失败（build exit ${out.code}）`);
  }

  // 先起一个真的（模拟「上一个窗口没关，又点了一次」）
  const first = run("cmd", ["/c", "npm start"], { cwd: dir, env, timeoutMs: 120000 });
  let up = null;
  for (let i = 0; i < 400; i++) {
    if (await healthOf(PORT, 300)) {
      up = true;
      break;
    }
    await sleep(100);
  }
  if (!up) {
    killTree(first.child.pid);
    await first.done;
    throw new Error("D: 第一个实例没起来，这一条没量成");
  }

  const second = run("cmd", ["/c", "npm start"], { cwd: dir, env, timeoutMs: 60000 });
  const out = await second.done;
  const log = `${out.stdout}${out.stderr}`;

  // 再走一次 start-local.cmd：双击两次才是演示当天真实的动作
  const third = run("cmd", ["/c", "start-local.cmd"], { cwd: dir, env, timeoutMs: 120000 });
  const out3 = await third.done;
  const log3 = `${out3.stdout}${out3.stderr}`;

  killTree(first.child.pid);
  await first.done;
  await waitPortFree(PORT);

  const record = {
    npm_start: {
      exit_code: out.code,
      ms: out.ms,
      raw_stack: /Unhandled 'error' event|at Server\.setupListenHandle|Node\.js v\d/.test(log),
      line_count: log.trim().split("\n").length,
      names_port: /8787/.test(log),
      names_cause: /EADDRINUSE|已被占用|port .*in use/i.test(log),
      says_already_running: /already running|already serving|已经有一个|已经在运行/.test(log),
      gives_next_step: /PORT=|set PORT|打开 http:\/\/127\.0\.0\.1:8787|netstat/i.test(log),
      output: tail(log, 14),
    },
    start_local: {
      exit_code: out3.code,
      raw_stack: /Unhandled 'error' event|at Server\.setupListenHandle|Node\.js v\d/.test(log3),
      says_already_running: /already running|already serving|已经有一个|已经在运行/.test(log3),
      output: tail(log3, 12),
    },
  };
  check("D npm start 不甩裸堆栈", !record.npm_start.raw_stack, record.npm_start.output);
  check("D npm start 说清「是哪个端口」", record.npm_start.names_port, null);
  check("D npm start 说清「是不是自己的旧实例」", record.npm_start.says_already_running, null);
  check("D npm start 给出下一步（换端口 / 打开现成的）", record.npm_start.gives_next_step, null);
  check("D 双击第二次也不会甩堆栈", !record.start_local.raw_stack, record.start_local.output);
  check("D 双击第二次说得清「已经有窗口在跑」", record.start_local.says_already_running, null);
  return record;
}

// ---------- 场景 E：源码比 dist 新（改成「看不到变化」的那个坑） ----------

async function startServer(dir, env) {
  const r = run("cmd", ["/c", "npm start"], { cwd: dir, env, timeoutMs: 120000 });
  let up = false;
  for (let i = 0; i < 400; i++) {
    if (await healthOf(PORT, 300)) {
      up = true;
      break;
    }
    if (r.child.exitCode !== null) break;
    await sleep(100);
  }
  await sleep(300);
  killTree(r.child.pid);
  const out = await r.done;
  await waitPortFree(PORT);
  if (!up) throw new Error("服务没起来，这一条没量成");
  return `${out.stdout}${out.stderr}`;
}

async function scenarioStale(dir) {
  const env = envWithThisNode();
  if (!existsSync(join(dir, "node_modules"))) {
    const install = await run("cmd", ["/c", "npm ci --no-audit --no-fund"], { cwd: dir, env, timeoutMs: 300000 }).done;
    if (install.code !== 0) throw new Error(`E: 准备依赖失败（exit ${install.code}）`);
  }
  if (!existsSync(join(dir, "dist"))) {
    const build = await run("cmd", ["/c", "npm run build"], { cwd: dir, env, timeoutMs: 300000 }).done;
    if (build.code !== 0) throw new Error(`E: 准备构建失败（exit ${build.code}）`);
  }

  const fresh = await startServer(dir, env);
  const warnsWhenFresh = /npm run build/.test(fresh);

  // 同一秒内写的文件不该被当成「比产物新」，所以先等一下再动源码
  await sleep(1600);
  const now = new Date();
  utimesSync(join(dir, "src", "App.tsx"), now, now);
  const stale = await startServer(dir, env);
  const warnsWhenStale = /前端产物比源码旧/.test(stale);

  check("E 刚构建完启动不乱报", !warnsWhenFresh, null);
  check("E 源码比产物新时会提醒", warnsWhenStale, tail(stale, 6));
  check("E 提醒里说了先跑 npm run build", /npm run build/.test(stale), null);
  return {
    warns_when_fresh: warnsWhenFresh,
    warns_when_stale: warnsWhenStale,
    output: tail(stale, 8),
  };
}

// ---------- 主流程 ----------

const workRoot = join(tmpdir(), "ls-start-local");
mkdirSync(workRoot, { recursive: true });
const dir = mkdtempSync(join(workRoot, "run-"));
const want = (name) => !only || only.includes(name);

try {
  // 前置条件：8787 必须是空的。否则每个场景的「到 /api/health 通」都会命中那个旧进程，
  // 量出 26 ms 这种漂亮但毫无意义的数（本轮就撞了一次：残留的 npm start 让 B/C/E 全失真）。
  const squatter = await healthOf(PORT, 600);
  if (squatter)
    throw new Error(
      `8787 已经被别的进程占着（version ${squatter.version}），先关掉它再量。否则每个场景都会量到那个进程，数字全是假的。`,
    );
  // 先导出：A 场景也要在一个真的目录里跑（空目录里 cmd 只会说「找不到 start-local.cmd」，
  // 那是探针自己的错，不是产品的问题——第一次跑就撞上了）。
  const needDir = want("old") || want("cold") || want("warm") || want("busy") || want("stale");
  const exported = needDir ? exportHead(dir) : 0;
  if (want("old")) result.scenarios["A_old_node"] = await scenarioOldNode(dir);
  if (want("cold") || want("warm")) result.scenarios["B_C_cold_warm"] = await scenarioColdWarm(dir, { exported });
  if (want("busy")) result.scenarios["D_busy"] = await scenarioBusy(dir);
  if (want("stale")) result.scenarios["E_stale"] = await scenarioStale(dir);
} catch (error) {
  result.error = String(error.message || error).split("\n")[0];
} finally {
  await waitPortFree(PORT, 4000);
  if (!keep) rmSync(dir, { recursive: true, force: true });
  else console.log(`临时目录保留：${dir}`);
}

const failed = result.checks.filter((c) => !c.ok);
result.verdict = result.error ? "probe_failed" : failed.length ? "red" : "ok";

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("\nstart-local.cmd 实测（干净导出 → 双击 → 到 8787 可用）\n");
  const a = result.scenarios.A_old_node;
  if (a) {
    if (a.skipped) console.log(`  A 旧版本场景          ${a.skipped}`);
    else
      console.log(
        `  A Node ${a.node_version} 时      exit ${a.exit_code}／${a.ms} ms／说「装 24+」${a.says_install_24 ? "是" : "否"}／说清当前版本 ${a.says_installed_version ? "是" : "否"}`,
      );
  }
  const b = result.scenarios.B_C_cold_warm;
  if (b) {
    for (const run of [b.cold, b.warm]) {
      console.log(
        `  ${run.label === "cold" ? "B 冷启动（无依赖）" : "C 第二次双击    "}  ${run.ready_ms} ms 到 /api/health 通` +
          `／首页 ${run.page_status}／npm ci ${run.npm_ci_seconds ?? "—"}s／vite ${run.vite_build_ms ?? "—"}${run.vite_build_unit ?? ""}`,
      );
      console.log(
        `      窗口里：首批输出 ${run.first_output_ms} ms／最长一段完全没有输出 ${run.max_silence_ms} ms`,
      );
    }
    console.log(`  B 干净导出文件数      ${b.cold.files_in_export} 个（无 node_modules / dist）`);
    console.log(`  B 跑完后的目录        node_modules ${b.cold.has_node_modules_after ? "有" : "无"}／dist ${b.cold.has_dist_after ? "有" : "无"}`);
  }
  const d = result.scenarios.D_busy;
  if (d) {
    console.log("");
    console.log("  8787 已被占（又点了一次）时：");
    console.log(
      `    npm start        exit ${d.npm_start.exit_code}／${d.npm_start.ms} ms／裸堆栈 ${d.npm_start.raw_stack ? "有" : "无"}` +
        `／提到端口 ${d.npm_start.names_port ? "是" : "否"}／说「已在运行」${d.npm_start.says_already_running ? "是" : "否"}／给下一步 ${d.npm_start.gives_next_step ? "是" : "否"}`,
    );
    console.log(
      `    start-local.cmd  exit ${d.start_local.exit_code}／裸堆栈 ${d.start_local.raw_stack ? "有" : "无"}` +
        `／说「已在运行」${d.start_local.says_already_running ? "是" : "否"}`,
    );
    console.log("    ——— 第二次双击窗口里的原文 ———");
    for (const line of d.start_local.output.split("\n")) console.log(`    ${line}`);
  }
  const e = result.scenarios.E_stale;
  if (e) {
    console.log("");
    console.log(`  改了 src/ 但没重新构建就 npm start：`);
    console.log(`    刚构建完启动       提醒 ${e.warns_when_fresh ? "有（多余）" : "无"}`);
    console.log(`    源码比产物新       提醒 ${e.warns_when_stale ? "有" : "无"}`);
  }
  console.log("");
  for (const c of result.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `（${String(c.detail).split("\n")[0]}）` : ""}`);
  if (result.error) console.log(`  探针出错：${result.error}`);
  console.log(`\n  verdict: ${result.verdict}（${failed.length} 红 / ${result.checks.length} 条）`);
}

if (strict && result.verdict !== "ok") process.exit(1);
