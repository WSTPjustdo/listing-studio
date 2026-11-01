#!/usr/bin/env node
/**
 * 走真实接口量「评委贴一条真实 ASIN 来诊断」会看到多少条问题。
 *
 * 为什么不能只用引擎层的 `probe-issue-shape.mjs`：
 *   那个脚本直接调 `reviewContent`，绕过了接口、产品档案、假模型往返。
 *   而演示时走的是 `POST /api/listings/diagnose` 这一条路——中间任何一层把它拼回去，
 *   引擎层的数字就白量了。这个脚本走完整的 HTTP，模型用假上游（自报 fake-1，不烧钱）。
 *
 * 用法：
 *   node scripts/real-listing-probe.mjs                 # 20 条真实文案，不关联商品档案
 *   node scripts/real-listing-probe.mjs --profile       # 先建一条托特包档案再逐条诊断（含参数对照）
 *   node scripts/real-listing-probe.mjs --list         # 逐条打印接口返回的问题
 *   node scripts/real-listing-probe.mjs --file <样本.json>
 *
 * 只读：数据库 :memory:，不写 data/、不写 .runtime。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { ROOT } from "../server/store.mjs";
import { loadSample, listingContent } from "./sample-listings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SAMPLE = resolve(here, "../../qa/research/listings-20261027.json");
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = 18797;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假上游：把商家贴的文案原样回显、不报任何模型侧问题。
// 这样看到的问题**全部**来自确定性引擎——正是我们在量的那一层。
const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    // 把商家贴的文案原样回显：诊断这条路上模型只说"我看到了这段文案"，
    // 于是问题**全部**来自确定性引擎——正是我们在量的那一层。
    let content = null;
    try {
      const parsed = JSON.parse(body);
      const user = parsed.messages?.find((m) => m.role === "user")?.content || "";
      content = JSON.parse(user).current_content || null;
    } catch {
      content = null;
    }
    if (!content) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "probe：取不到请求里的 content" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "fake-probe",
        model: "fake-1",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({ content, review: { issues: [], checks: [] }, claim_map: [], patches: [] }),
            },
          },
        ],
      }),
    );
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

const child = spawn(process.execPath, ["server/index.mjs"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    DATABASE_PATH: ":memory:",
    MODEL_PROVIDER: "compatible",
    MODEL_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    MODEL_NAME: "fake-1",
    MODEL_API_KEY: "local-fake",
    MODEL_TIMEOUT_MS: "60000",
  },
});
const serverLog = [];
child.stdout.on("data", (b) => serverLog.push(String(b)));
child.stderr.on("data", (b) => serverLog.push(String(b)));

const post = (path, data) =>
  fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

let exitCode = 0;
try {
  for (let i = 0; i < 200; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) })).ok) break;
    } catch {
      /* 还在起 */
    }
    await sleep(50);
  }

  let product = null;
  if (has("--profile")) {
    const created = await post("/api/products", {
      fields: {
        name_zh: "长提手棉布袋",
        material: "100% cotton",
        width: 38,
        height: 42,
        fabric_weight_gsm: 140,
        capacity_l: 10,
        handle_length_cm: 67,
        retail_pack_count: 1,
        brand: "",
        color: "",
      },
    });
    product = await created.json();
    if (!product.product_id) throw new Error(`建档失败：${JSON.stringify(product).slice(0, 200)}`);
  }

  // 与 claim-recall-probe.mjs 共用同一份映射：这里以前把五点拼成「亮点」，
  // 于是 20 条真实文案的 AMZ-02 20/20 全报（2026-10-29 实测 52 → 31 条问题）。
  const { items } = loadSample(value("--file", DEFAULT_SAMPLE));
  const rows = [];
  for (const item of items) {
    const content = listingContent(item);
    const response = await post("/api/listings/diagnose", {
      product_id: product?.product_id ?? null,
      product_revision: product?.revision,
      content,
    });
    const run = await response.json();
    if (!response.ok) throw new Error(`诊断失败 ${response.status}：${JSON.stringify(run).slice(0, 300)}`);
    // 诊断是异步的（202 + run_id），要等 run 跑完再读记录——这不是"多发一次请求"，是接口本来的形状。
    let finished = null;
    for (let i = 0; i < 600; i += 1) {
      const state = await (await fetch(`${BASE}/api/runs/${run.run_id}`)).json();
      if (state.status === "failed") throw new Error(`运行失败：${JSON.stringify(state.error || {}).slice(0, 200)}`);
      if (state.status === "succeeded") {
        finished = state;
        break;
      }
      await sleep(50);
    }
    if (!finished) throw new Error("等待超时：run 没有跑完");
    const records = await (await fetch(`${BASE}/api/listings/${run.listing_id}/versions`)).json();
    const latest = (Array.isArray(records) ? records : records.records || []).sort((a, b) => b.version - a.version)[0];
    if (!latest?.review) throw new Error(`取不到记录：${JSON.stringify(records).slice(0, 200)}`);
    rows.push({ asin: item.asin, issues: latest.review.issues, checks: latest.review.checks });
  }

  const counts = new Map();
  let total = 0;
  for (const row of rows)
    for (const issue of row.issues) {
      total += 1;
      counts.set(issue.rule_id, (counts.get(issue.rule_id) || 0) + 1);
    }
  const sorted = rows.map((x) => x.issues.length).sort((a, b) => a - b);
  const median = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : 0;

  console.log(`样本：${value("--file", DEFAULT_SAMPLE)}　${items.length} 条真实在售文案`);
  console.log(`路径：POST /api/listings/diagnose（假上游 model=fake-1，${product ? "关联新建档案" : "不关联档案"}）`);
  console.log(`问题总数 ${total}　中位每条 ${median}　最少 ${sorted[0] ?? 0}　最多 ${sorted.at(-1) ?? 0}\n`);
  console.log("| 规则 | 条数 | 占总数 |");
  console.log("|---|---|---|");
  for (const [rule, n] of [...counts].sort((a, b) => b[1] - a[1]))
    console.log(`| ${rule} | ${n} | ${((n / Math.max(total, 1)) * 100).toFixed(0)}% |`);

  if (has("--list")) {
    for (const row of rows) {
      console.log(`\n## ${row.asin}（${row.issues.length} 条）`);
      for (const issue of row.issues)
        console.log(`- [${issue.severity}] ${issue.rule_id} · ${issue.field_path} · ${String(issue.original).slice(0, 50)}`);
    }
  }
} catch (error) {
  exitCode = 1;
  console.error(String(error?.message || error));
  console.error(serverLog.join("").split("\n").slice(-8).join("\n"));
} finally {
  child.kill();
  await new Promise((r) => upstream.close(r));
}
process.exit(exitCode);
