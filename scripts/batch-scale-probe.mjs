/**
 * 批量规模实测：2000 行到底能不能跑、代价随行数怎么涨。
 *
 * 用法：
 *   node scripts/batch-scale-probe.mjs                     # micro + e2e，行数 200/2000
 *   node scripts/batch-scale-probe.mjs --sizes 100,400,800 # 只跑 micro，改行数
 *   node scripts/batch-scale-probe.mjs --micro             # 只跑进程内（快）
 *   node scripts/batch-scale-probe.mjs --e2e               # 只跑 HTTP 端到端（慢）
 *   node scripts/batch-scale-probe.mjs --json
 *   node scripts/batch-scale-probe.mjs --strict            # 只跑 200 行的门槛判定，出退出码
 *   node scripts/batch-scale-probe.mjs --restart --restart-rows 300   # 断点续跑：跑到一半杀进程
 *
 * --strict 判两条结构指标（与机器快慢无关，只看写了多少）：
 *     每行整批落盘次数 <= 2、每行写入 <= 1024 KB（200 行时）。
 *   门槛自检：改之前是 3 次 / 1359.7 KB，两条都超线；这次没删断言，是把它压到线内。
 *   谁再在 tick/dispatch 里加一次「顺手 saveBatch」，这条会红。
 *
 * 两段各量什么：
 *
 *   micro（进程内，不联网、不调模型）
 *     真实 store + 真实 createBatchManager，只把 service.enqueue 换成立刻成功的桩。
 *     量三样：每行要 saveBatch 几次、每次写进去多少字节（写放大）、每行 tick 花多少毫秒。
 *     再单独量「单次 saveBatch / store.batches() 本身多贵」—— 后者是 tick 里每 250ms 跑一次的。
 *
 *   e2e（假上游 + 真 HTTP，不调任何真实模型）
 *     造 N 行 CSV → POST /api/batches/preview → POST /api/batches → 轮询到 finished。
 *     量墙钟时间、峰值 RSS、sqlite 文件增长、上游调用次数。
 *
 * 说明：
 *   - 模型是本地假上游（秒回，自报 model: fake-1），数字等于「存储与调度下限」，
 *     不含真实模型延迟；真模型每行还要加上自己的往返时间（本机无 Key，没跑过）。
 *   - 数据库写到系统临时目录，不碰 .runtime/ 与 data/。
 *   - --concurrency 默认 1：并发会让两件事同时写同一个 blob，量不准单行代价。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { ROOT, createStore } from "../server/store.mjs";
import { createBatchManager } from "../server/batch.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const asJson = flag("--json");
const strict = flag("--strict");
const restartMode = flag("--restart");
const onlyMicro = flag("--micro") || strict;
const onlyE2e = flag("--e2e");
const runMicro = !onlyE2e && !restartMode;
const runE2e = !onlyMicro && !restartMode;
const sizes = String(opt("--sizes", "200,2000"))
  .split(",")
  .map((n) => Number(n))
  .filter((n) => Number.isInteger(n) && n > 1)
  .sort((a, b) => a - b);
const concurrency = Math.max(1, Math.min(8, Number(opt("--concurrency", "1")) || 1));
const PORT = Number(opt("--port", "18831")) || 18831;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 造 N 行商品表：列映射与真实模板同序，SKU 不重复、品类落在支持范围内。 */
const HEADERS = ["SKU", "商品名称", "品类", "材质", "宽度", "高度", "克重", "提手长度", "每包件数"];
const MAPPING = {
  sku: 0,
  name: 1,
  category: 2,
  material: 3,
  width: 4,
  height: 5,
  fabric_weight_gsm: 6,
  handle_length_cm: 7,
  retail_pack_count: 8,
};
function makeRows(count) {
  return Array.from({ length: count }, (_, i) => [
    `SKU-${String(i + 1).padStart(5, "0")}`,
    `长提手棉布袋 ${i + 1}`,
    "棉布袋",
    "100% cotton",
    "38",
    "42",
    "140",
    "67",
    "1",
  ]);
}
const csvOf = (rows) =>
  [HEADERS, ...rows].map((cells) => cells.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(",")).join("\n") + "\n";

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/* ───────────────────────── micro：进程内量写放大 ───────────────────────── */

function microRun(size) {
  const store = createStore(":memory:");
  const realSaveBatch = store.saveBatch;
  const writes = { calls: 0, bytes: 0, ms: 0, largest: 0 };
  store.saveBatch = (value) => {
    const text = JSON.stringify(value);
    const t = performance.now();
    realSaveBatch(value);
    writes.ms += performance.now() - t;
    writes.calls += 1;
    writes.bytes += Buffer.byteLength(text);
    writes.largest = Math.max(writes.largest, Buffer.byteLength(text));
    return value;
  };
  let seq = 0;
  const service = {
    // 立刻成功的桩：只为了让 tick 走完「派发 → 完成」这一圈，没有任何模型调用。
    enqueue(input) {
      seq += 1;
      const listingId = `listing-probe-${seq}`;
      const run = store.createRun({
        listing_id: listingId,
        operation: input.operation,
        provider: "compatible",
        actual_model_call: false,
        request_id: input.request_id || null,
      });
      store.updateRun(run.run_id, { status: "succeeded", listing_id: listingId, version: 1 });
      return run;
    },
  };
  store.saveSettings({ provider: "compatible", model: "probe-model" });
  const manager = createBatchManager(store, service);
  const rows = makeRows(size);
  const importId = `import-probe-${size}`;
  store.saveImport({
    id: importId,
    filename: `probe-${size}.csv`,
    sheet: "Sheet1",
    headers: HEADERS,
    rows: rows.map((cells, i) => ({ number: i + 2, cells })),
    selection_required: false,
  });
  try {
    const tPrepare = performance.now();
    const batch = manager.start({
      import_id: importId,
      mapping: MAPPING,
      operation: "create",
      duplicate: "skip",
      confirm_scope: true,
      selected: rows.map((_, i) => i + 2),
    });
    const prepareMs = performance.now() - tPrepare;
    writes.calls = 0;
    writes.bytes = 0;
    writes.ms = 0;
    writes.largest = 0;

    const t0 = performance.now();
    let ticks = 0;
    // tick 本身是 250ms 定时器驱动的；这里手动驱动，量的是纯计算不是等待。
    while (ticks < 200000) {
      manager.tick();
      ticks += 1;
      if (store.batch(batch.id).status === "finished") break;
    }
    const loopMs = performance.now() - t0;
    const finished = store.batch(batch.id);
    const done = finished.rows.filter((r) => r.status === "completed").length;
    const tSave = performance.now();
    realSaveBatch(finished);
    const oneSaveMs = performance.now() - tSave;
    const tLoad = performance.now();
    store.batches();
    const loadAllMs = performance.now() - tLoad;
    return {
      size,
      prepare_ms: Math.round(prepareMs),
      rows_completed: done,
      ticks,
      loop_ms: Math.round(loopMs),
      ms_per_row: Number((loopMs / Math.max(1, size)).toFixed(2)),
      save_writes: writes.calls,
      writes_per_row: Number((writes.calls / Math.max(1, size)).toFixed(2)),
      written_mb: Number((writes.bytes / 1048576).toFixed(1)),
      written_per_row_kb: Number((writes.bytes / Math.max(1, size) / 1024).toFixed(1)),
      blob_kb: Number((writes.largest / 1024).toFixed(1)),
      save_batch_ms: Number(oneSaveMs.toFixed(1)),
      batches_load_ms: Number(loadAllMs.toFixed(1)),
    };
  } finally {
    manager.close();
    store.close();
  }
}

/* ───────────────────────── e2e：假上游 + 真 HTTP ───────────────────────── */

function startFakeUpstream(delayMs = 0) {
  const state = { hits: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      state.hits += 1;
      if (delayMs) await sleep(delayMs);
      const draft = {
        title: "Cotton Canvas Tote Bag with Long Handles",
        item_highlights: "Everyday cotton tote for errands and commuting.",
        bullet_points: [
          { id: "b1", text: "100% cotton canvas body." },
          { id: "b2", text: "Handle length: 67 cm." },
          { id: "b3", text: "Measures 38 x 42 cm." },
        ],
        description: "A plain cotton tote bag for daily use.",
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `fake-${state.hits}`,
          model: "fake-1",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  content: draft,
                  review: { issues: [], checks: [] },
                  claim_map: [],
                  patches: [],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
        }),
      );
    });
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      done({ state, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function startServer(upstreamUrl, dbPath) {
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATABASE_PATH: dbPath,
      MODEL_PROVIDER: "compatible",
      MODEL_BASE_URL: upstreamUrl,
      MODEL_NAME: "fake-1",
      MODEL_API_KEY: "local-fake",
      MODEL_TIMEOUT_MS: "60000",
      BATCH_CONCURRENCY: String(concurrency),
    },
  });
  const log = [];
  child.stdout.on("data", (b) => log.push(String(b)));
  child.stderr.on("data", (b) => log.push(String(b)));
  return { child, log };
}

function rssMb(pid) {
  // Windows: tasklist 的「内存使用」列，单位 K。取不到就返回 null，不猜。
  try {
    const out = spawn("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    let text = "";
    out.stdout.on("data", (b) => (text += b));
    return new Promise((done) => {
      out.on("close", () => {
        const m = text.match(/"([\d.,]+) K"/);
        done(m ? Math.round(Number(m[1].replace(/[.,]/g, "")) / 1024) : null);
      });
      out.on("error", () => done(null));
    });
  } catch {
    return Promise.resolve(null);
  }
}

const fileSize = (path) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

async function e2eRun(size) {
  const dir = mkdtempSync(join(tmpdir(), "ls-scale-"));
  const dbPath = join(dir, "probe.sqlite");
  const upstream = await startFakeUpstream();
  const { child, log } = startServer(upstream.url, dbPath);
  const post = (path, data) =>
    fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  const out = { size, port: PORT };
  let peakRss = 0;
  try {
    const tBoot = performance.now();
    for (let i = 0; i < 600; i++) {
      try {
        if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) })).ok) break;
      } catch {
        /* 还在起 */
      }
      await sleep(50);
    }
    out.boot_ms = Math.round(performance.now() - tBoot);

    const csv = Buffer.from(csvOf(makeRows(size)), "utf8");
    out.csv_kb = Number((csv.length / 1024).toFixed(1));
    let t = performance.now();
    const previewRes = await post("/api/batches/preview", {
      filename: `probe-${size}.csv`,
      base64: csv.toString("base64"),
    });
    const preview = await previewRes.json();
    out.preview_ms = Math.round(performance.now() - t);
    if (!previewRes.ok) throw new Error(`preview 失败：${JSON.stringify(preview).slice(0, 300)}`);

    t = performance.now();
    const startRes = await post("/api/batches", {
      import_id: preview.id,
      mapping: MAPPING,
      operation: "create",
      duplicate: "skip",
      confirm_scope: true,
      selected: Array.from({ length: size }, (_, i) => i + 2),
    });
    const startText = await startRes.text();
    out.start_ms = Math.round(performance.now() - t);
    if (!startRes.ok) throw new Error(`start 失败：${startText.slice(0, 300)}`);
    const batch = JSON.parse(startText);
    out.batch_response_kb = Number((Buffer.byteLength(startText) / 1024).toFixed(1));
    out.status_at_start = batch.status;

    const tRun = performance.now();
    let state = null;
    let lastPollError = null;
    for (let i = 0; i < 4000; i++) {
      await sleep(2000);
      const rss = await rssMb(child.pid);
      if (Number.isFinite(rss)) peakRss = Math.max(peakRss, rss);
      // 用列表接口轮询：它只回 id/状态/计数，不会每次都把整批行搬一遍。
      const res = await fetch(`${BASE}/api/batches`, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) {
        lastPollError = `HTTP ${res.status}`;
        continue;
      }
      const list = await res.json();
      state = list.find((b) => b.id === batch.id) || null;
      if (!state) continue;
      if (["finished", "paused", "failed"].includes(state.status)) break;
    }
    out.run_ms = Math.round(performance.now() - tRun);
    out.final_status = state?.status || "unknown";
    out.completed = state?.completed ?? null;
    out.total = state?.total ?? null;
    out.rows_per_sec = Number((size / Math.max(0.001, out.run_ms / 1000)).toFixed(2));
    out.ms_per_row = Number((out.run_ms / Math.max(1, size)).toFixed(2));
    out.upstream_hits = upstream.state.hits;
    out.db_main_kb = Number((fileSize(dbPath) / 1024).toFixed(1));
    out.db_wal_kb = Number((fileSize(dbPath + "-wal") / 1024).toFixed(1));
    out.peak_rss_mb = peakRss || null;
    if (lastPollError) out.poll_error = lastPollError;
    return out;
  } finally {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* 已经退了 */
    }
    await upstream.close();
    await sleep(300);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响结论 */
    }
    out.log_tail = log.join("").slice(-400);
  }
}

/* ───────────────────── e2e：杀进程再重启（断点续跑） ───────────────────── */

async function restartRun(size) {
  const dir = mkdtempSync(join(tmpdir(), "ls-restart-"));
  const dbPath = join(dir, "probe.sqlite");
  const upstream = await startFakeUpstream(60);
  const out = { size, db: dbPath };
  let child = startServer(upstream.url, dbPath).child;
  const post = (path, data) =>
    fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  const waitHealth = async () => {
    for (let i = 0; i < 600; i++) {
      try {
        if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) })).ok) return;
      } catch {
        /* 还在起 */
      }
      await sleep(50);
    }
    throw new Error("服务没起来");
  };
  const readBatch = async (id) =>
    (await (await fetch(`${BASE}/api/batches/${id}`, { signal: AbortSignal.timeout(60000) })).json());
  const counts = (batch) => {
    const by = {};
    for (const row of batch.rows || []) by[row.status] = (by[row.status] || 0) + 1;
    return by;
  };
  try {
    await waitHealth();
    const csv = Buffer.from(csvOf(makeRows(size)), "utf8");
    const preview = await (
      await post("/api/batches/preview", { filename: `restart-${size}.csv`, base64: csv.toString("base64") })
    ).json();
    const batch = await (
      await post("/api/batches", {
        import_id: preview.id,
        mapping: MAPPING,
        operation: "create",
        duplicate: "skip",
        confirm_scope: true,
        selected: Array.from({ length: size }, (_, i) => i + 2),
      })
    ).json();

    // 等到「有进展但没做完」，再拔电源。40% 这个点足够让队列里同时存在三种行。
    let last = null;
    for (let i = 0; i < 600; i++) {
      await sleep(1000);
      last = await readBatch(batch.id);
      const done = last.rows.filter((r) => r.status === "completed").length;
      if (done >= Math.floor(size * 0.4)) break;
      if (["finished", "paused"].includes(last.status)) break;
    }
    const beforeCounts = counts(last);
    out.before_kill = { status: last.status, counts: beforeCounts };
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    await sleep(1500);

    // 同一个数据库，新进程。index.mjs 启动时会 interruptRuns()，把在跑的 run 标成中断。
    child = startServer(upstream.url, dbPath).child;
    await waitHealth();
    const boot = await readBatch(batch.id);
    out.after_boot = { status: boot.status, counts: counts(boot) };
    out.boot_failures = (boot.rows || []).filter((r) => r.status === "failed").map((r) => r.error_code || "无");
    const tResume = performance.now();
    let resumed = null;
    for (let i = 0; i < 900; i++) {
      await sleep(1000);
      resumed = await readBatch(batch.id);
      if (["finished", "paused"].includes(resumed.status)) break;
    }
    out.resume_ms = Math.round(performance.now() - tResume);
    out.hits_after_resume = upstream.state.hits;
    out.after_restart = { status: resumed.status, counts: counts(resumed) };

    // 失败行能不能一次重试收干净
    const retry = await (
      await post(`/api/batches/${batch.id}/retry`, {})
    ).json();
    out.retry = retry.retry || null;
    let final = null;
    for (let i = 0; i < 900; i++) {
      await sleep(1000);
      final = await readBatch(batch.id);
      if (["finished", "paused"].includes(final.status)) break;
    }
    out.after_retry = { status: final.status, counts: counts(final) };
    out.upstream_hits = upstream.state.hits;
    out.attempts = (final.rows || []).filter((r) => (r.attempt || 0) > 0).length;
    return out;
  } finally {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* 已经退了 */
    }
    await upstream.close();
    await sleep(300);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 删不掉不影响结论 */
    }
  }
}

/* ───────────────────────── 输出 ───────────────────────── */

if (strict) {
  const row = microRun(200);
  const checks = [
    { label: "每行整批落盘次数", value: row.writes_per_row, limit: 2, unit: "次/行" },
    { label: "每行写入量", value: row.written_per_row_kb, limit: 1024, unit: "KB" },
  ].map((check) => ({ ...check, ok: Number.isFinite(check.value) && check.value <= check.limit }));
  const allOk = checks.every((c) => c.ok);
  if (asJson) console.log(JSON.stringify({ strict: true, ok: allOk, checks, sample: row }, null, 2));
  else {
    console.log(`批量写放大门槛 · 200 行 · 并发 1`);
    for (const c of checks)
      console.log(`  ${c.ok ? "过" : "红"}  ${c.label}：${c.value} ${c.unit}（上限 ${c.limit}）`);
    console.log(allOk ? "  全部在门槛内。" : "  超出上限：有地方又把整批重写了一遍。");
  }
  process.exit(allOk ? 0 : 1);
}

const result = { generated_at: new Date().toISOString(), concurrency, sizes, micro: [], e2e: [] };

if (runMicro) {
  for (const size of sizes) {
    try {
      result.micro.push(microRun(size));
    } catch (error) {
      result.micro.push({ size, error: String(error?.message || error) });
    }
  }
}

if (runE2e) {
  // 端到端一个尺寸就要真跑一遍，默认只跑最大的那个；要对比就显式 --sizes。
  const e2eSizes = String(opt("--e2e-sizes", String(sizes.at(-1))))
    .split(",")
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 1);
  for (const size of e2eSizes) {
    try {
      result.e2e.push(await e2eRun(size));
    } catch (error) {
      result.e2e.push({ size, error: String(error?.message || error) });
    }
  }
}

if (restartMode) {
  const rowsToKill = Number(opt("--restart-rows", "300")) || 300;
  const restart = await restartRun(rowsToKill);
  if (asJson) console.log(JSON.stringify({ restart }, null, 2));
  else {
    const line = (label, entry) =>
      entry && console.log(`  ${label}：状态 ${entry.status} · ${Object.entries(entry.counts).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
    console.log(`断点续跑实测 · ${rowsToKill} 行 · 并发 ${concurrency} · 假上游每次调用 ${60} ms`);
    line("杀进程那一刻", restart.before_kill);
    line("重启刚起来那一刻", restart.after_boot);
    if (restart.boot_failures?.length)
      console.log(`      带失败码的行：${restart.boot_failures.join("、")}`);
    line("重启后自己跑到停", restart.after_restart);
    if (restart.retry)
      console.log(`  重试：申请 ${restart.retry.requested} 行，重排 ${restart.retry.requeued}，不可重试 ${restart.retry.skipped_non_retryable}，非失败 ${restart.retry.skipped_non_failed}`);
    line("重试后", restart.after_retry);
    console.log(`  重启到再次停住 ${(restart.resume_ms / 1000).toFixed(1)} 秒 · 上游调用：续跑前 ${restart.hits_after_resume} 次，重试后 ${restart.upstream_hits} 次`);
  }
  process.exit(0);
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`批量规模实测 · 并发 ${concurrency} · ${result.generated_at}`);
  if (result.micro.length) {
    console.log("\n【进程内】真实 store + 真实批次管理器，模型换成立刻成功的桩");
    console.log("  行数 | 每行 saveBatch 次数 | 每行写入 | 单次 blob | 每行耗时 | 单次 saveBatch | 全表载入");
    for (const row of result.micro) {
      if (row.error) {
        console.log(`  ${row.size} | 失败：${row.error}`);
        continue;
      }
      console.log(
        `  ${String(row.size).padStart(4)} | ${String(row.writes_per_row).padStart(6)} 次/行 | ${String(row.written_per_row_kb).padStart(7)} KB | ${String(row.blob_kb).padStart(7)} KB | ${String(row.ms_per_row).padStart(6)} ms | ${String(row.save_batch_ms).padStart(8)} ms | ${String(row.batches_load_ms).padStart(8)} ms`,
      );
    }
    const total = result.micro.filter((r) => !r.error).reduce((sum, r) => sum + r.written_mb, 0);
    if (total) console.log(`  合计写入 ${total.toFixed(1)} MB（这几次实测加起来）`);
  }
  if (result.e2e.length) {
    console.log("\n【端到端】假上游秒回 + 真 HTTP + 真 sqlite 文件");
    for (const row of result.e2e) {
      if (row.error) {
        console.log(`  ${row.size} 行失败：${row.error}`);
        continue;
      }
      console.log(
        `  ${row.size} 行：${(row.run_ms / 1000).toFixed(1)} 秒 · ${row.ms_per_row} ms/行 · ${row.rows_per_sec} 行/秒 · 完成 ${row.completed}/${row.total} · 状态 ${row.final_status}`,
      );
      console.log(
        `      上传 ${row.csv_kb} KB · 预览 ${row.preview_ms} ms · 建批 ${row.start_ms} ms（响应 ${row.batch_response_kb} KB）· 上游 ${row.upstream_hits} 次 · 峰值 RSS ${row.peak_rss_mb ?? "未知"} MB · 库 ${row.db_main_kb}+${row.db_wal_kb} KB`,
      );
    }
  }
}
