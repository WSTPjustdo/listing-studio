/**
 * 故障演练：模型超时 / 报错 / 乱返回时，演示当天到底会看到什么。
 *
 * 用法：
 *   node scripts/failure-drill.mjs                  # 只跑接口层（四个坏上游，几十秒）
 *   node scripts/failure-drill.mjs --ui             # 加跑界面：点一次生成，逐秒记录用户看到什么
 *   node scripts/failure-drill.mjs --json
 *
 * 为什么要有这个：
 *   演示当天最怕的不是报错，是"转圈转到底、台下看不懂在等什么"。这个脚本用假上游
 *   把四种坏情况摆出来，量三件事——
 *     1. 服务端多久才认输（秒）
 *     2. 这期间 run.stage 有没有变（变 = 用户能看出在干什么）
 *     3. 最后那句错误话说了什么、有没有下一步
 *
 * 假上游一律自报 model: fake-1，且不调用任何真实模型。数据库用 :memory:，不碰 .runtime。
 * 界面截图写到 .runtime/failure-drill/（.gitignore 已排除）。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { ROOT } from "../server/store.mjs";

const args = process.argv.slice(2);
const withUi = args.includes("--ui");
const asJson = args.includes("--json");
const PORT = 18799;
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = 8000; // 生产默认 60000；演练压到 8 秒只为不让人干等，注释里写明差别
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 可切换行为的假上游 ---------- */

function startFakeUpstream() {
  const state = { mode: "ok", hits: 0 };
  const sockets = new Set();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (req.url.startsWith("/__control")) {
        state.mode = new URL(req.url, "http://x").searchParams.get("mode") || "ok";
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ mode: state.mode }));
      }
      state.hits += 1;
      if (state.mode === "hang") return; // 永不响应，等客户端自己超时
      if (state.mode === "http500") {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "upstream exploded" } }));
      }
      if (state.mode === "http429") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
        return res.end(JSON.stringify({ error: { message: "rate limited" } }));
      }
      if (state.mode === "garbage") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            id: "fake-garbage",
            model: "fake-1",
            choices: [{ finish_reason: "stop", message: { content: "抱歉，我无法完成这个请求。" } }],
          }),
        );
      }
      // ok：回一份结构合法的空审阅，够让流程走完
      const content = {
        title: "Cotton Tote Bag",
        item_highlights: "100% cotton tote with a long handle.",
        bullet_points: [{ id: "b1", text: "Handle length: 67 cm." }],
        description: "Cotton tote bag for daily errands.",
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
                content: JSON.stringify({ content, review: { issues: [], checks: [] }, claim_map: [], patches: [] }),
              },
            },
          ],
        }),
      );
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      done({
        state,
        url: `http://127.0.0.1:${port}`,
        setMode: async (mode) => {
          state.mode = mode;
          await fetch(`http://127.0.0.1:${port}/__control?mode=${mode}`);
        },
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(r);
          }),
      });
    });
  });
}

/* ---------- 起服务 ---------- */

function startServer(upstreamUrl, { apiKey = "local-fake", baseUrl = upstreamUrl } = {}) {
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATABASE_PATH: ":memory:",
      MODEL_PROVIDER: "compatible",
      MODEL_BASE_URL: baseUrl,
      MODEL_NAME: "fake-1",
      MODEL_API_KEY: apiKey,
      MODEL_TIMEOUT_MS: String(TIMEOUT_MS),
    },
  });
  const log = [];
  child.stdout.on("data", (b) => log.push(String(b)));
  child.stderr.on("data", (b) => log.push(String(b)));
  return { child, log };
}

async function waitReady() {
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(50);
  }
  throw new Error("服务没起来");
}

const post = (path, data) =>
  fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

/* ---------- 接口层四个场景 ---------- */

async function runScenario(productId, mode) {
  const t0 = Date.now();
  const response = await post("/api/listings/create", {
    product_id: productId,
    product_revision: 1,
    request_id: `drill-${mode}-${t0}`,
  });
  const body = await response.json();
  const out = {
    scenario: mode,
    accept_status: response.status,
    accept_ms: Date.now() - t0,
    stages: [],
    total_ms: null,
    final_status: null,
    error_code: null,
    error_message: null,
  };
  if (!body.run_id) {
    out.final_status = "rejected_before_run";
    out.error_message = body.error?.message || JSON.stringify(body).slice(0, 200);
    out.error_code = body.error?.code || null;
    return out;
  }
  const deadline = Date.now() + TIMEOUT_MS * 3 + 20000;
  let lastStage = null;
  while (Date.now() < deadline) {
    const status = await (await fetch(`${BASE}/api/runs/${body.run_id}`)).json();
    if (status.stage && status.stage !== lastStage) {
      out.stages.push({ stage: status.stage, at_ms: Date.now() - t0 });
      lastStage = status.stage;
    }
    if (status.status === "failed" || status.status === "succeeded") {
      out.total_ms = Date.now() - t0;
      out.final_status = status.status;
      out.error_code = status.error?.code || null;
      out.error_message = status.error?.message || null;
      break;
    }
    await sleep(100);
  }
  if (out.total_ms == null) {
    out.final_status = "still_running_when_drill_gave_up";
    out.total_ms = Date.now() - t0;
  }
  return out;
}

/* ---------- 界面层：用户到底看到什么 ---------- */

async function drillUi(browser, mode) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const findings = { scenario: mode, samples: [], toast: null, hint_numbers: [], screenshots: [] };
  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".nav-item", { timeout: 60000 });
    // 2026-10-30 首页收敛为两条路径，旧入口折进「更多功能」，不展开就点不到
  await page.locator('.nav-item[aria-label="更多功能"]').click();
  await page.locator('.nav-item[aria-label="新品 Listing"]').click();
    const button = page.locator(".generate-button");
    await button.waitFor({ timeout: 15000 });
    await sleep(300);
    // 界面自己在告诉观众什么（有没有 Key 的时候，这句话会不一样吗）
    findings.caption = (await page.locator(".mode-caption").innerText()).replace(/\s+/g, " ").trim();
    const t0 = Date.now();
    await button.click();

    const shotDir = resolve(ROOT, ".runtime", "failure-drill");
    mkdirSync(shotDir, { recursive: true });

    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const overlay = page.locator(".busy-overlay");
      const visible = await overlay.count();
      if (visible) {
        const text = (await overlay.innerText()).replace(/\s+/g, " ").trim();
        if (!findings.samples.length || findings.samples.at(-1).text !== text)
          findings.samples.push({ at_ms: Date.now() - t0, text });
        // 界面上有没有出现过任何"秒数/进度"这类数字（空转的关键证据）
        if (/[0-9]/.test(text)) findings.hint_numbers.push({ at_ms: Date.now() - t0, text });
      } else {
        const toast = page.locator(".toast");
        if (await toast.count()) findings.toast = (await toast.innerText()).replace(/\s+/g, " ").trim();
        break;
      }
      if (i === 1 || i === 6) {
        const file = resolve(shotDir, `${mode}-${Math.round((Date.now() - t0) / 1000)}s.png`);
        await page.screenshot({ path: file });
        findings.screenshots.push(file);
      }
    }
    if (!findings.toast) {
      const toast = page.locator(".toast");
      if (await toast.count()) findings.toast = (await toast.innerText()).replace(/\s+/g, " ").trim();
    }
    findings.total_ms = Date.now() - t0;
  } catch (error) {
    findings.error = error.message.split("\n")[0];
  } finally {
    await context.close();
  }
  return findings;
}

/* ---------- 跑 ---------- */

const upstream = await startFakeUpstream();
const noKey = args.includes("--no-key");
// 无 Key 这一场景必须用 DeepSeek 的地址：providers.mjs 只在 hostname 是 api.deepseek.com 时
// 校验 Key，别的兼容端点没 Key 也照发请求。没 Key 时在 fetch 之前就抛错，不会真的联网。
const { child, log } = startServer(upstream.url, noKey ? { apiKey: "", baseUrl: "https://api.deepseek.com" } : {});
let browser;
let exitCode = 0;

try {
  await waitReady();
  const product = await (
    await post("/api/products", {
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
    })
  ).json();

  const apiResults = [];
  const scenarios = noKey ? ["ok"] : ["ok", "http500", "http429", "garbage", "hang"];
  for (const mode of scenarios) {
    await upstream.setMode(mode);
    const result = await runScenario(product.product_id, mode);
    if (noKey) result.scenario = "no_key";
    apiResults.push(result);
  }

  let uiResults = [];
  if (withUi) {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ channel: "msedge" });
    for (const mode of noKey ? ["no-key"] : ["hang", "http500"]) {
      await upstream.setMode(mode === "no-key" ? "ok" : mode);
      uiResults.push(await drillUi(browser, mode));
    }
  }

  const summary = {
    timeout_ms: TIMEOUT_MS,
    api: apiResults,
    ui: uiResults,
    upstream_hits: upstream.state.hits,
    server_log_tail: log.join("").slice(-400),
  };

  if (asJson) console.log(JSON.stringify(summary, null, 0));
  else {
    console.log(`\n故障演练 · 模型超时上限 ${TIMEOUT_MS}ms（生产默认 60000）· 假上游 ${upstream.state.hits} 次被调用\n`);
    console.log("  场景       接受状态  认输用时   stage 变化   最终      错误码 / 错误话");
    for (const r of apiResults) {
      const stages = r.stages.map((s) => `${s.stage}@${(s.at_ms / 1000).toFixed(1)}s`).join(" → ");
      console.log(
        `  ${r.scenario.padEnd(10)} ${String(r.accept_status).padEnd(9)} ${String(((r.total_ms || 0) / 1000).toFixed(1) + "s").padEnd(9)} ${String(r.stages.length).padEnd(12)} ${String(r.final_status).padEnd(9)} ${r.error_code || "-"} / ${r.error_message || "-"}`,
      );
      if (stages) console.log(`             ${stages}`);
    }
    for (const u of uiResults) {
      console.log(`\n  界面 · ${u.scenario}`);
      console.log(`    界面自述（.mode-caption）: ${u.caption || "（没读到）"}`);
      console.log(`    遮罩文字变化 ${u.samples.length} 次，总时长 ${(u.total_ms / 1000).toFixed(1)}s`);
      for (const s of u.samples) console.log(`      ${(s.at_ms / 1000).toFixed(1)}s  ${s.text}`);
      console.log(`    遮罩里出现过数字(秒数/进度)的采样: ${u.hint_numbers.length} 次`);
      console.log(`    失败后提示: ${u.toast || "（没看到提示）"}`);
      if (u.error) console.log(`    界面脚本出错: ${u.error}`);
      for (const p of u.screenshots) console.log(`    截图: ${p}`);
    }
    if (apiResults.some((r) => r.final_status !== "failed" && r.final_status !== "succeeded")) exitCode = 1;
  }
} catch (error) {
  console.error("演练失败：" + error.message);
  console.error(log.join("").slice(-1500));
  exitCode = 2;
} finally {
  if (browser) await browser.close();
  try { child.kill(); } catch { /* 已退出 */ }
  spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  await upstream.close();
}

process.exit(exitCode);
