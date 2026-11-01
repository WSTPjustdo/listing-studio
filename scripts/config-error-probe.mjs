/**
 * 配置错误探测：模型接错时，界面上到底说了什么。
 *
 * 用法：
 *   node scripts/config-error-probe.mjs            # 人读
 *   node scripts/config-error-probe.mjs --json     # 机器读
 *
 * 为什么要有这个：
 *   10/30 晚上要人工把真实模型接上，那一刻最容易错的就是"只配错一个东西"——
 *   Key 没填、Key 贴少了一半、地址写错、模型名不存在、额度用完。
 *   这几种如果界面上说的是同一句话，配的人就只能靠猜。
 *
 * 第 14 轮实测过这个网关（tokenhubcloud）的错误体是**扁平的** `{code,message}`，
 * 不是 OpenAI 的 `{"error":{...}}`；而且 base_url 带不带 /v1 都能连，
 * 所以"地址错"撞出来的也是 401，和"Key 错"在状态码上分不开。
 *
 * 这里的假上游按**实测原文**逐字节复刻那几条已知的；没有 Key 拿不到的（429 / 模型名不存在）
 * 一律打上 source: "assumed" 标签，不允许当成测过的事实。
 *
 * 全程不联网、不调真实模型、DATABASE_PATH=:memory:（不碰 .runtime/listing-studio.sqlite）。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { ROOT } from "../server/store.mjs";

const asJson = process.argv.includes("--json");
const PORT = 18801;
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 假网关：照第 14 轮实测的字节复刻 ---------- */

/**
 * source 字段是这份探测里最要紧的诚实标记：
 *   "measured" = 2026-10-30 第 14 轮不带 Key 打真网关录下来的原文；
 *   "assumed"  = 没有 Key 拿不到，按公共网关惯例写的，**不能当事实引用**。
 */
const MODES = {
  no_key: {
    source: "measured",
    status: 401,
    contentType: "application/json",
    body: { code: "API_KEY_REQUIRED", message: "API key is required in Authorization header." },
    label: "没填 Key",
  },
  bad_key: {
    source: "measured",
    status: 401,
    contentType: "application/json",
    body: { code: "INVALID_API_KEY", message: "Invalid API key" },
    label: "Key 贴错/作废",
  },
  wrong_path: {
    source: "measured",
    status: 404,
    contentType: "text/plain",
    body: "404 page not found",
    label: "地址写到不存在的路径",
  },
  model_missing: {
    source: "assumed",
    status: 404,
    contentType: "application/json",
    body: { code: "MODEL_NOT_FOUND", message: "model not found" },
    label: "模型名不存在",
  },
  quota: {
    source: "assumed",
    status: 429,
    contentType: "application/json",
    body: { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota" } },
    label: "额度用完（OpenAI 体例）",
  },
  rate_limit: {
    source: "assumed",
    status: 429,
    contentType: "application/json",
    body: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests, slow down" },
    label: "限流（扁平体例）",
  },
  server_500: {
    source: "assumed",
    status: 500,
    contentType: "text/plain",
    body: "Internal Server Error",
    label: "上游故障",
  },
  /** 地址填成网站首页的样子：200 + 一张 HTML。第 15 轮误打真网关时真撞到了。 */
  html: {
    source: "measured",
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><html><head><title>TokenHub</title></head><body><div id=\"app\"></div></body></html>",
    label: "地址填成网站首页（200 + HTML）",
  },
};

function startFakeGateway() {
  const state = { mode: "no_key", hits: 0 };
  const sockets = new Set();
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      state.hits += 1;
      // 测试连接走的是 GET /models：models_* 开头的模式单独应答，
      // 其余模式照旧把同一份错误体吐给任何路径（够用来演"接错"）。
      const isModels = req.method === "GET" && /\/models$/.test(req.url || "");
      const modelsMode = String(state.mode).startsWith("models_");
      if (isModels && modelsMode) {
        if (state.mode === "models_ok") {
          res.writeHead(200, { "content-type": "application/json", "x-request-id": `probe-${state.hits}` });
          return res.end(JSON.stringify({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }] }));
        }
        const spec = MODES[state.mode.slice("models_".length)] || MODES.no_key;
        res.writeHead(spec.status, { "content-type": spec.contentType, "x-request-id": `probe-${state.hits}` });
        return res.end(typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body));
      }
      const spec = MODES[state.mode] || MODES.no_key;
      // x-request-id：第 14 轮实测这个网关的响应头里确实有
      res.writeHead(spec.status, {
        "content-type": spec.contentType,
        "x-request-id": `probe-${state.hits}`,
      });
      res.end(typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body));
    });
  });
  for (const s of server.listeners("connection")) void s;
  return new Promise((done) => {
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      done({
        state,
        url: `http://127.0.0.1:${port}`,
        setMode: (mode) => {
          state.mode = mode;
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

function startServer(upstreamUrl, { apiKey = "sk-fake-local", baseUrl = upstreamUrl, model = "fake-1" } = {}) {
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
      MODEL_NAME: model,
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

/* ---------- 一个场景：点一次「创建草稿」，记下用户看到的那句话 ---------- */

async function runScenario(productId, mode, { baseUrlNote = null } = {}) {
  const spec = MODES[mode];
  const t0 = Date.now();
  const response = await post("/api/listings/create", {
    product_id: productId,
    product_revision: 1,
    request_id: `config-${mode}-${t0}`,
  });
  const accepted = await response.json();
  const out = {
    mode,
    label: spec.label,
    upstream_shape_source: spec.source,
    upstream_status: spec.status,
    base_url_note: baseUrlNote,
    accept_status: response.status,
    final_status: null,
    error_code: null,
    user_message: null,
    user_title: null,
    user_action: null,
    upstream_code_shown: null,
    upstream_message_shown: null,
    total_ms: null,
  };
  if (!accepted.run_id) {
    out.final_status = "rejected_before_run";
    out.error_code = accepted.error?.code || null;
    out.user_message = accepted.error?.message || JSON.stringify(accepted).slice(0, 200);
    return out;
  }
  const deadline = Date.now() + TIMEOUT_MS * 3 + 20000;
  while (Date.now() < deadline) {
    const status = await (await fetch(`${BASE}/api/runs/${accepted.run_id}`)).json();
    if (status.status === "failed" || status.status === "succeeded") {
      out.total_ms = Date.now() - t0;
      out.final_status = status.status;
      out.error_code = status.error?.code || null;
      out.user_message = status.error?.message || null;
      out.user_title = status.error?.title || null;
      out.user_action = status.error?.action || null;
      out.upstream_code_shown = status.error?.upstream?.code || null;
      out.upstream_message_shown = status.error?.upstream?.message || null;
      break;
    }
    await sleep(100);
  }
  return out;
}

async function makeProduct() {
  const response = await post("/api/products", {
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
  return (await response.json()).product_id;
}

/* ---------- 界面层：真的点一遍，看屏幕上出现了什么 ---------- */

/**
 * 接口层说得再好听，也得界面上真的显示出来才算数。
 * 这里只走一条路（Key 无效），因为它是 10/30 晚上最可能发生的那一种：
 * Key 复制少了几位 → 401。要看的是运行卡片上有没有"不认这个密钥"和"下一步"。
 */
async function probeUi(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const out = { scenario: "bad_key", run_card_text: null, toast: null, settings_endpoint: null,
    probe_failed_text: null, probe_ok_text: null, probe_unreachable_text: null,
    probe_html_text: null, probe_saved_base_url: null, screenshots: [] };
  const shotDir = resolve(ROOT, ".runtime", "config-error-probe");
  mkdirSync(shotDir, { recursive: true });
  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".nav-item", { timeout: 60000 });

    // 设置页：填一个不带 /v1 的地址，看它有没有把拼完的地址摆在眼前。
    // 只填不点——点了会真的打到那个域名上（第 15 轮就这么误打过一次）。
    await page.locator('button[aria-label="模型设置"]').click();
    const baseInput = page.locator("#base-url");
    await baseInput.waitFor({ timeout: 15000 });
    await baseInput.fill("https://api.tokenhubcloud.net");
    await sleep(700); // 等弹窗淡入结束，否则截出来是半透明的
    const endpointLine = await page.locator("p.helper", { hasText: "实际请求" }).first().innerText();
    out.settings_endpoint = endpointLine.replace(/\s+/g, " ").trim();

    const clickProbe = async () => {
      await page.locator(".settings-probe button").click();
      await sleep(150);
      await page.locator(".probe-result").first().waitFor({ timeout: 20000 });
      await sleep(500);
      return (await page.locator(".probe-result").first().innerText()).replace(/\s+/g, " ").trim();
    };

    // ① 连不上：端口 1 不动，本机一定拒连。顺便证明"测试"不会把地址存进去。
    await baseInput.fill("http://127.0.0.1:1/v1");
    out.probe_unreachable_text = await clickProbe();
    const savedAfterProbe = await (await fetch(`${BASE}/api/settings`)).json();
    out.probe_saved_base_url = savedAfterProbe.base_url;

    // ② 网关不认 Key
    gateway.setMode("bad_key");
    await baseInput.fill(gateway.url + "/v1");
    out.probe_failed_text = await clickProbe();
    out.screenshots.push(resolve(shotDir, "settings-probe-failed.png"));
    await page.screenshot({ path: out.screenshots.at(-1) });

    // ③ 连上了：同一处按钮，结果块要变成模型列表
    gateway.setMode("models_ok");
    out.probe_ok_text = await clickProbe();
    out.screenshots.push(resolve(shotDir, "settings-probe-ok.png"));
    await page.screenshot({ path: out.screenshots.at(-1) });

    // ④ 200 + 网页（地址填成网站首页的真实表现）：不许说"连上了"
    gateway.setMode("models_html");
    out.probe_html_text = await clickProbe();

    gateway.setMode("bad_key");
    await page.keyboard.press("Escape");

    // 生成 → 失败 → 打开运行记录
    // 2026-10-30 首页收敛为两条路径，旧入口折进「更多功能」，不展开就点不到
    await page.locator('.nav-item[aria-label="更多功能"]').click();
    await page.locator('.nav-item[aria-label="新品 Listing"]').click();
    const button = page.locator(".generate-button");
    await button.waitFor({ timeout: 15000 });
    await sleep(300);
    await button.click();
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (!(await page.locator(".busy-overlay").count())) {
        const toast = page.locator(".toast");
        if (await toast.count()) out.toast = (await toast.innerText()).replace(/\s+/g, " ").trim();
        break;
      }
    }
    await page.locator('button[aria-label="查看运行记录"]').click();
    const card = page.locator(".run-card").first();
    await card.waitFor({ timeout: 15000 });
    // 等提示条自己淡出，否则截图里正好盖在卡片上，看不出排版。
    await sleep(1800);
    out.run_card_text = (await card.innerText()).replace(/\s+/g, " ").trim();
    out.screenshots.push(resolve(shotDir, "run-card.png"));
    await page.screenshot({ path: out.screenshots.at(-1) });
  } catch (error) {
    out.error = String(error.message || error).split("\n")[0];
  } finally {
    await context.close();
  }
  return out;
}

/* ---------- 跑 ---------- */

const gateway = await startFakeGateway();
const results = [];
const services = [];
const withUi = process.argv.includes("--ui");
let browser;
let ui = null;

try {
  // 第一段：有 Key 的各种"接错"（Key 填了，但地址/模型名/额度有问题）
  const normal = startServer(gateway.url);
  services.push(normal);
  await waitReady();
  const productId = await makeProduct();
  for (const mode of ["wrong_path", "model_missing", "quota", "rate_limit", "server_500"]) {
    gateway.setMode(mode);
    results.push(await runScenario(productId, mode));
  }
  normal.child.kill();
  await sleep(300);

  // 第二段：没有 Key（真网关此时直接 401 API_KEY_REQUIRED）
  const noKey = startServer(gateway.url, { apiKey: "" });
  services.push(noKey);
  gateway.setMode("no_key");
  await waitReady();
  const productId2 = await makeProduct();
  results.push(await runScenario(productId2, "no_key"));

  // 第三段：Key 填了但作废
  gateway.setMode("bad_key");
  results.push(await runScenario(productId2, "bad_key"));
  noKey.child.kill();
  await sleep(400);

  // 第四段：base_url 少写 /v1 —— 第 14 轮实测这个网关两种写法都能通，
  // 所以这里量的是"我们自己会不会发现这件事"，不是"网关会不会拒绝"。
  gateway.setMode("no_key");
  const noV1 = startServer(gateway.url + "/chat", { apiKey: "" });
  services.push(noV1);
  await waitReady();
  const productId3 = await makeProduct();
  results.push(await runScenario(productId3, "no_key", { baseUrlNote: "base_url 指向了 /chat 这一层（模拟少写/多写一段路径）" }));
  noV1.child.kill();
  await sleep(400);

  // 第五段（可选）：界面层，Key 无效
  if (withUi) {
    gateway.setMode("bad_key");
    const uiServer = startServer(gateway.url);
    services.push(uiServer);
    await waitReady();
    await makeProduct();
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ channel: "msedge" });
    ui = await probeUi(browser);
    uiServer.child.kill();
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const s of services) s.child.kill();
  await gateway.close();
}

/* ---------- 汇总：几种原因变成了几句话 ---------- */

const messages = results.map((r) => r.user_message || `（无错误话）${r.final_status}`);
const distinct = new Set(messages);
const withUpstreamCode = results.filter((r) => r.upstream_code_shown).length;
const withTitle = results.filter((r) => r.user_title).length;
const withAction = results.filter((r) => r.user_action).length;

const summary = {
  scenarios: results.length,
  distinct_causes: new Set(results.map((r) => r.label)).size,
  distinct_user_messages: distinct.size,
  distinct_after_stripping_http_status: new Set(
    messages.map((m) => m.replace(/HTTP \d{3}/g, "HTTP <n>")),
  ).size,
  // 同一个 label 量了两次（比如"没填 Key"换个 base_url 再来一遍）不算新原因，按 label 去重。
  collapsed_causes: [...distinct].map((message) => ({
    message,
    causes: [...new Set(results.filter((r) => (r.user_message || "") === message).map((r) => r.label))],
  })).filter((group) => group.causes.length > 1),
  scenarios_echoing_upstream_code: withUpstreamCode,
  scenarios_with_title: withTitle,
  scenarios_with_next_action: withAction,
  ui,
  results,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`\n配置错误探测 · ${summary.distinct_causes} 种"只配错一个东西"的情形 · 假网关 ${gateway.state.hits} 次被调用\n`);
  console.log("  场景                 上游   错误码                    用户看到的那句话");
  for (const r of results) {
    const m = (r.user_message || "-").replace(/\s+/g, " ").slice(0, 78);
    console.log(
      `  ${r.label.padEnd(18)} ${String(r.upstream_status).padEnd(6)} ${String(r.error_code).padEnd(24)} ${m}`,
    );
    if (r.user_action) console.log(`      ↳ 下一步：${r.user_action.replace(/\s+/g, " ").slice(0, 76)}`);
    if (r.base_url_note) console.log(`      ↳ ${r.base_url_note}`);
  }
  console.log(`\n  ${summary.distinct_causes} 种原因 → **${summary.distinct_user_messages} 句话**` +
    `（把 HTTP 状态码抹平后 ${summary.distinct_after_stripping_http_status} 句）`);
  if (summary.collapsed_causes.length)
    for (const g of summary.collapsed_causes)
      console.log(`  ⚠ 仍塌成同一句话：${g.causes.join(" / ")} → ${g.message.slice(0, 50)}`);
  else console.log("  ✓ 没有两种不同的原因共用一个说法");
  console.log(`  带上游 code 的场景：${summary.scenarios_echoing_upstream_code}/${summary.scenarios}`);
  console.log(`  带标题的场景：${summary.scenarios_with_title}/${summary.scenarios}`);
  console.log(`  带"下一步"的场景：${summary.scenarios_with_next_action}/${summary.scenarios}`);
  if (ui) {
    console.log("\n  界面 · Key 无效（真的用 msedge 点了一遍）");
    console.log(`    设置页：${ui.settings_endpoint || "（没读到）"}`);
    console.log(`    测试连接·连不上：${ui.probe_unreachable_text || "（没读到）"}`);
    console.log(`    测试连接·Key 无效：${ui.probe_failed_text || "（没读到）"}`);
    console.log(`    测试连接·成功：${ui.probe_ok_text || "（没读到）"}`);
    console.log(`    测试连接·200+网页：${ui.probe_html_text || "（没读到）"}`);
    console.log(`    测完再读已保存的地址：${ui.probe_saved_base_url ?? "（没读到）"}`);
    console.log(`    运行卡片：${ui.run_card_text || "（没读到）"}`);
    if (ui.toast) console.log(`    弹窗提示：${ui.toast}`);
    if (ui.error) console.log(`    脚本出错：${ui.error}`);
  }
}
