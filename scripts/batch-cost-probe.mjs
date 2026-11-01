/**
 * 批量成本可见性实测：这一批到底花了多少次调用、多少 token，现在能不能查出来。
 *
 * 用法：
 *   node scripts/batch-cost-probe.mjs                 # 12 行，快（约 20 秒）
 *   node scripts/batch-cost-probe.mjs --rows 300      # 大样本，顺带量「全局台账 500 条上限」够不够
 *   node scripts/batch-cost-probe.mjs --operation diagnose   # 检查已有文案（create/diagnose/optimize）
 *   node scripts/batch-cost-probe.mjs --json
 *   node scripts/batch-cost-probe.mjs --strict        # 判 6 条，出退出码（npm run probe:cost:strict）
 *
 * 第 13 轮加的 `--operation`：界面上有一句写死的「每件通常 diagnose 1 次、其他 2 次」，
 * 那个 1 从来没量过（代码上看 diagnose 只调一次：不生成正文就不走独立审阅）。
 * 本脚本把它变成可复现的数字，三种操作各跑一次就知道那句能不能说。
 *
 * 为什么要有这把尺子：
 *   第 11 轮 handoff 写着「telemetry 里已有 request_id = ${batch.id}-${row}-${attempt}，
 *   可以按前缀聚合出这一批的调用次数」。那句话没验过。本脚本第二步就验它：
 *   把跑完的一批的 id 拿去比对台账里的 request_id，看能不能对上。
 *
 * 量四件事（全部走假上游 + 真 HTTP + 真 sqlite，不调任何真实模型）：
 *   1. 这一批实际让上游被打了几次（等于 2×行数，第 11 轮量过，这里当基准）
 *   2. /api/batches/:id 的响应里有没有任何 token / 次数 / 花费字段
 *   3. /api/batches/:id/cost 存不存在
 *   4. 全局台账 GET /api/telemetry 里有多少条能归到这一批（按 request_id 前缀比对）
 *
 * 假上游每次回 usage = {prompt:900, completion:120, total:1020}，所以「应有的 token 总数」
 * 是 2×行数×1020 —— 这是个能被算出来的数，不用信任何自报。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ROOT } from "../server/store.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const asJson = flag("--json");
const strict = flag("--strict");
const PORT = Number(opt("--port", "18839")) || 18839;
const BASE = `http://127.0.0.1:${PORT}`;
const rows = strict ? 8 : Math.max(4, Math.min(2000, Number(opt("--rows", "12")) || 12));
const concurrency = Math.max(1, Math.min(8, Number(opt("--concurrency", "4")) || 4));
const OPERATION = ["create", "diagnose", "optimize"].includes(opt("--operation", "create"))
  ? opt("--operation", "create")
  : "create";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKENS_PER_CALL = 1020; // 假上游固定回这个数，见 startFakeUpstream()

/**
 * 假设值（**未验**，来自界面上写死的 `operation === "diagnose" ? 1 : 2`）。
 * 本脚本的用处就是把它换成实测；两者不一致时以实测为准。
 */
const HYPOTHESIS_PER_ROW = OPERATION === "diagnose" ? 1 : 2;

const PRODUCT_HEADERS = ["SKU", "商品名称", "品类", "材质", "宽度", "高度", "克重", "提手长度", "每包件数"];
const CONTENT_HEADERS = ["标题", "亮点", "五点", "描述"];
const HEADERS = OPERATION === "create" ? PRODUCT_HEADERS : [...PRODUCT_HEADERS, ...CONTENT_HEADERS];
const MAPPING =
  OPERATION === "create"
    ? {
        sku: 0, name: 1, category: 2, material: 3, width: 4, height: 5,
        fabric_weight_gsm: 6, handle_length_cm: 7, retail_pack_count: 8,
      }
    : {
        sku: 0, name: 1, category: 2, material: 3, width: 4, height: 5,
        fabric_weight_gsm: 6, handle_length_cm: 7, retail_pack_count: 8,
        title: 9, item_highlights: 10, bullet_points: 11, description: 12,
      };
// 检查/优化走的是「已有英文文案」，所以这份 CSV 必须带现成文案（空标题会被判 blocker）。
const EXISTING_CONTENT = [
  "Cotton Canvas Tote Bag with Long Handles",
  "Everyday cotton tote for errands and commuting.",
  "100% cotton canvas body.\nHandle length: 67 cm.\nMeasures 38 x 42 cm.",
  "A plain cotton tote bag for daily use.",
];
const makeRows = (count) =>
  Array.from({ length: count }, (_, i) => [
    `SKU-${String(i + 1).padStart(5, "0")}`, `长提手棉布袋 ${i + 1}`, "棉布袋",
    "100% cotton", "38", "42", "140", "67", "1",
    ...(OPERATION === "create" ? [] : EXISTING_CONTENT),
  ]);
const csvOf = (data) =>
  [HEADERS, ...data]
    .map((cells) => cells.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(","))
    .join("\n") + "\n";

function startFakeUpstream() {
  const state = { hits: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.hits += 1;
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
          choices: [{
            finish_reason: "stop",
            message: {
              content: JSON.stringify({ content: draft, review: { issues: [], checks: [] }, claim_map: [], patches: [] }),
            },
          }],
          usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: TOKENS_PER_CALL },
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
      PORT: String(PORT), HOST: "127.0.0.1", DATABASE_PATH: dbPath,
      MODEL_PROVIDER: "compatible", MODEL_BASE_URL: upstreamUrl, MODEL_NAME: "fake-1",
      MODEL_API_KEY: "local-fake", MODEL_TIMEOUT_MS: "60000",
      BATCH_CONCURRENCY: String(concurrency),
    },
  });
  const log = [];
  child.stdout.on("data", (b) => log.push(String(b)));
  child.stderr.on("data", (b) => log.push(String(b)));
  return { child, log };
}

/** 上游次数是「真花钱的次数」，必须和行数对得上，否则后面所有 token 折算都是错的。 */
async function main() {
  const dir = mkdtempSync(join(tmpdir(), "ls-cost-"));
  const dbPath = join(dir, "probe.sqlite");
  const upstream = await startFakeUpstream();
  const { child, log } = startServer(upstream.url, dbPath);
  const out = { rows, concurrency, operation: OPERATION };
  const post = (path, data) =>
    fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  try {
    for (let i = 0; i < 600; i++) {
      try {
        if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) })).ok) break;
      } catch { /* 还在起 */ }
      await sleep(50);
    }

    const csv = Buffer.from(csvOf(makeRows(rows)), "utf8");
    const preview = await (await post("/api/batches/preview", { filename: `cost-${OPERATION}-${rows}.csv`, base64: csv.toString("base64") })).json();
    const startRes = await post("/api/batches", {
      import_id: preview.id, mapping: MAPPING, operation: OPERATION, duplicate: "skip",
      confirm_scope: true, selected: Array.from({ length: rows }, (_, i) => i + 2),
    });
    const batch = await startRes.json();
    if (!startRes.ok) throw new Error(`start 失败：${JSON.stringify(batch).slice(0, 300)}`);
    out.batch_id = batch.id;

    let state = null;
    for (let i = 0; i < 1200; i++) {
      await sleep(300);
      const list = await (await fetch(`${BASE}/api/batches`, { signal: AbortSignal.timeout(60000) })).json();
      state = list.find((b) => b.id === batch.id) || null;
      if (state && ["finished", "paused", "failed"].includes(state.status)) break;
    }
    out.final_status = state?.status || "unknown";
    out.completed = state?.completed ?? null;
    out.upstream_hits = upstream.state.hits;
    out.hypothesis_per_row = HYPOTHESIS_PER_ROW;
    out.expected_calls = rows * HYPOTHESIS_PER_ROW;  // 假设值，见 HYPOTHESIS_PER_ROW
    out.expected_tokens = out.expected_calls * TOKENS_PER_CALL;
    out.measured_per_row = Number((out.upstream_hits / rows).toFixed(2));

    // ① 批次详情里有没有任何成本字段
    const detail = await (await fetch(`${BASE}/api/batches/${batch.id}`, { signal: AbortSignal.timeout(60000) })).json();
    const costKeys = Object.keys(detail).filter((k) => /cost|token|spend|price|usage/i.test(k));
    out.detail_cost_fields = costKeys;

    // ② 有没有按批查成本的接口
    const costRes = await fetch(`${BASE}/api/batches/${batch.id}/cost`, { signal: AbortSignal.timeout(15000) });
    out.cost_endpoint_status = costRes.status;
    let costBody = null;
    try { costBody = await costRes.json(); } catch { costBody = null; }
    out.cost_endpoint_shape = costBody && costRes.ok ? Object.keys(costBody).sort() : null;

    // ③ 全局台账里能归到这一批的条数（按 request_id 前缀比对）
    const tele = await (await fetch(`${BASE}/api/telemetry?limit=500`, { signal: AbortSignal.timeout(30000) })).json();
    const calls = tele.calls || [];
    const attributable = calls.filter((row) => String(row.request_id || "").startsWith(batch.id));
    out.telemetry = {
      returned: calls.length,
      tokens_sum: calls.reduce((sum, row) => sum + (Number.isFinite(row.total_tokens) ? row.total_tokens : 0), 0),
      with_request_id: calls.filter((row) => row.request_id).length,
      request_id_sample: [...new Set(calls.map((row) => row.request_id).filter(Boolean))].slice(0, 3),
      attributable_calls: attributable.length,
      attributable_tokens: attributable.reduce((sum, row) => sum + (Number.isFinite(row.total_tokens) ? row.total_tokens : 0), 0),
    };
    // 台账上限：limit 最大 500，超出部分看不见
    out.telemetry_covers = calls.length ? Number((calls.length / Math.max(1, upstream.state.hits)).toFixed(3)) : null;

    // ④ 如果成本接口在，就把它的数和「应有」的数对一遍
    if (costBody && costRes.ok) {
      out.cost = {
        calls: costBody.calls?.total ?? null,
        tokens: costBody.tokens?.total ?? null,
        unknown_calls: costBody.tokens?.unknown_calls ?? null,
        calls_per_row: costBody.calls?.per_row ?? null,
        price: costBody.price ?? null,
        unknown_rows: costBody.rows?.without_calls ?? null,
      };
    }

    // ⑤ 可选：界面上的那句话是不是这三个数字（需要先 npm run build，服务端发的是 dist/）
    if (flag("--ui")) {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ channel: "msedge" });
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        await page.addInitScript((id) => localStorage.setItem("listing-batch-id", id), batch.id);
        await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
        await page.click('[aria-label="批量商品"]');
        await page.waitForSelector('[aria-label="模型调用与用量"]', { timeout: 30000 });
        const text = (await page.textContent('[aria-label="模型调用与用量"]')) || "";
        const shot = flag("--screenshot") ? String(opt("--screenshot", "")) : "";
        if (shot) await page.locator('[aria-label="模型调用与用量"]').screenshot({ path: shot });
        out.ui = { text: text.trim(), screenshot: shot || null };
      } finally {
        await browser.close();
      }
    }
    return out;
  } finally {
    try { spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 已退 */ }
    await upstream.close();
    await sleep(300);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结论 */ }
    out.log_tail = log.join("").slice(-400);
  }
}

function report(out) {
  const lines = [];
  lines.push(`## 批量成本可见性（${out.operation} · ${out.rows} 行，并发 ${out.concurrency}，假上游）`);
  lines.push("");
  lines.push(`- 这批跑完状态：${out.final_status}（完成 ${out.completed}/${out.rows}）`);
  lines.push(`- 上游实际被调：**${out.upstream_hits} 次**（= 每行 **${out.measured_per_row}** 次；假设 ${out.hypothesis_per_row} 次/行 → 应有 ${out.expected_calls} 次）`);
  lines.push(`- 应有 token 总数：**${out.expected_tokens.toLocaleString()}**（每次 ${TOKENS_PER_CALL}）`);
  lines.push(`- \`GET /api/batches/:id\` 里的成本类字段：**${out.detail_cost_fields.length}** 个${out.detail_cost_fields.length ? `（${out.detail_cost_fields.join(", ")}）` : ""}`);
  lines.push(`- \`GET /api/batches/:id/cost\`：**HTTP ${out.cost_endpoint_status}**`);
  lines.push(`- 全局台账 \`GET /api/telemetry?limit=500\` 返回 **${out.telemetry.returned}** 条，token 合计 **${out.telemetry.tokens_sum.toLocaleString()}**`);
  lines.push(`  - 台账条数 / 上游次数 = **${out.telemetry_covers === null ? "?" : (out.telemetry_covers * 100).toFixed(1) + "%"}**（500 条上限的覆盖率）`);
  lines.push(`  - 其中能归到这一批的（按 request_id 前缀，旧口径）：**${out.telemetry.attributable_calls}** 条 / ${out.telemetry.attributable_tokens.toLocaleString()} token`);
  lines.push(`  - 台账里的 request_id 长这样：${out.telemetry.request_id_sample.length ? out.telemetry.request_id_sample.map((v) => `\`${v}\``).join("、") : "（全是空）"}（这是**上游**的 id，不是我们的批次编号）`);
  if (out.cost) {
    lines.push("");
    lines.push(`- 成本接口回报：调用 **${out.cost.calls}** 次 / token **${out.cost.tokens}** / 未知用量 **${out.cost.unknown_calls}** 次 / 每行 **${out.cost.calls_per_row}** 次 / 零调用行 **${out.cost.unknown_rows}**`);
    lines.push(`- 单价：${out.cost.price ? `${out.cost.price.currency} ${out.cost.price.total}（${out.cost.price.source}）` : "**null**（未配置单价，只报 token）"}`);
  }
  if (out.ui) {
    lines.push("");
    lines.push(`- 界面上那句话：「${out.ui.text}」`);
    if (out.ui.screenshot) lines.push(`- 截图：${out.ui.screenshot}`);
  }
  return lines.join("\n");
}

const out = await main();
if (asJson) console.log(JSON.stringify(out, null, 2));
else {
  console.log(report(out));
  console.log("");
}

if (strict) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  add("上游次数 = 假设×行数", out.upstream_hits === out.expected_calls, `${out.upstream_hits} / ${out.expected_calls}（每行 ${out.measured_per_row} 次）`);
  add("成本接口存在（HTTP 200）", out.cost_endpoint_status === 200, `HTTP ${out.cost_endpoint_status}`);
  add("成本接口的调用次数 = 上游次数", out.cost?.calls === out.upstream_hits, `${out.cost?.calls} / ${out.upstream_hits}`);
  add("成本接口的 token = 应有总数", out.cost?.tokens === out.expected_tokens, `${out.cost?.tokens} / ${out.expected_tokens}`);
  add("单价未配置时必须是 null（不许编价）", out.cost ? out.cost.price === null : false, String(out.cost?.price));
  if (out.ui)
    add(
      "界面上的数字与接口一致（不是写死的）",
      out.ui.text.includes(out.cost.calls.toLocaleString()) && out.ui.text.includes(out.cost.tokens.toLocaleString()),
      out.ui.text.slice(0, 60),
    );
  const failed = checks.filter((c) => !c.ok);
  console.log("严格判定：");
  for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);
  console.log("");
  console.log(failed.length ? `${failed.length}/${checks.length} 条不通过` : `${checks.length}/${checks.length} 条通过`);
  process.exit(failed.length ? 1 : 0);
}
