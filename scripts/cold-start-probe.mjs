/**
 * 冷启动：从「服务还没起」到「屏幕上能点那个按钮」，实际几秒。
 *
 * 用法：
 *   node scripts/cold-start-probe.mjs
 *   node scripts/cold-start-probe.mjs --json
 *
 * 为什么要有这个：
 *   演示当天最尴尬的一种翻车是先双击、再等——如果"能点"要 40 秒，
 *   而主持人只留了 10 秒，那就是事故。这个数必须**量**，不能估。
 *
 * 量的是什么（也说清楚没量什么）：
 *   量：spawn 服务进程 → /api/health 通；浏览器起 → 首页可交互 → 生成按钮可点。
 *   没量：`npm ci` 装依赖。依赖已经装好了，那是"第一次拿到包的人"的经历，
 *        不在这台机器上能测出来的范围里（别把这两个数混成一个）。
 *
 * 全程不联网、假上游、DATABASE_PATH=:memory:。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { ROOT } from "../server/store.mjs";

const asJson = process.argv.includes("--json");
const PORT = 18804;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startUpstream() {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "probe-1",
          model: "probe-model",
          choices: [{ finish_reason: "stop", message: { content: '{"review":{"issues":[],"checks":[]}}' } }],
        }),
      );
    });
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => done({ url: `http://127.0.0.1:${server.address().port}`, server })),
  );
}

function distSize() {
  const dir = join(ROOT, "dist", "assets");
  try {
    return readdirSync(dir)
      .map((name) => ({ name, kb: statSync(join(dir, name)).size / 1024 }))
      .filter((f) => /\.(js|css)$/.test(f.name))
      .map((f) => ({ name: f.name, kb: Number(f.kb.toFixed(1)) }));
  } catch {
    return null;
  }
}

const upstream = await startUpstream();
const t0 = performance.now();
const child = spawn(process.execPath, ["server/index.mjs"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    DATABASE_PATH: ":memory:",
    MODEL_PROVIDER: "compatible",
    MODEL_BASE_URL: upstream.url,
    MODEL_NAME: "probe-model",
    MODEL_API_KEY: "sk-fake-local",
    MODEL_TIMEOUT_MS: "8000",
  },
});

const out = { server_ready_ms: null, browser_launch_ms: null, first_paint_ms: null,
  interactive_ms: null, total_ms: null, dist: distSize(), error: null };
let browser;

try {
  // 1) 服务起来（/api/health 通）要多久
  for (let i = 0; i < 400; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        out.server_ready_ms = Math.round(performance.now() - t0);
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(25);
  }
  if (out.server_ready_ms === null) throw new Error("服务 10 秒内没起来");

  // 2) 浏览器从启动到能点
  const { chromium } = await import("playwright");
  const tLaunch = performance.now();
  browser = await chromium.launch({ channel: "msedge" });
  out.browser_launch_ms = Math.round(performance.now() - tLaunch);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const tPage = performance.now();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".nav-item", { timeout: 60000 });
  out.first_paint_ms = Math.round(performance.now() - tPage);
  // 空库时的「新品 Listing」：这就是一台新机器上第一眼看到的东西
  // 2026-10-30 首页收敛为两条路径，旧入口折进「更多功能」，不展开就点不到
  await page.locator('.nav-item[aria-label="更多功能"]').click();
  await page.locator('.nav-item[aria-label="新品 Listing"]').click();
  const button = page.locator(".generate-button");
  await button.waitFor({ state: "visible", timeout: 30000 });
  await sleep(1500);
  const { mkdirSync } = await import("node:fs");
  const shotDir = join(ROOT, ".runtime", "cold-start");
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, "empty-create-page.png") });
  out.empty_state = {
    button_enabled: await button.isEnabled(),
    // 页面上有没有一句"先去准备资料"的指路话
    // 空库时有没有"先去录一条商品"的指路（页面上真有一块引导卡，不是只有灰按钮）
    guides_to_entry: /先有一条商品资料|还没有商品资料/.test(
      (await page.locator("main, .workspace").first().innerText().catch(() => "")),
    ),
    // 整页文字，用来判断"第一眼看到的东西"够不够看懂
    page_text: (await page.locator(".workspace, main").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 600),
    screenshot: join(shotDir, "empty-create-page.png"),
  };

  // 有商品之后：从页面加载到按钮真的可点
  const product = await fetch(`${BASE}/api/products`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fields: {
        name_zh: "长提手棉布袋", material: "100% cotton", width: 38, height: 42,
        fabric_weight_gsm: 140, capacity_l: 10, handle_length_cm: 67,
        retail_pack_count: 1, brand: "", color: "",
      },
    }),
  }).then((r) => r.json());
  const tReload = performance.now();
  await page.reload({ waitUntil: "domcontentloaded" });
  // 2026-10-30 首页收敛为两条路径，旧入口折进「更多功能」，不展开就点不到
  await page.locator('.nav-item[aria-label="更多功能"]').click();
  await page.locator('.nav-item[aria-label="新品 Listing"]').click();
  await button.waitFor({ state: "visible", timeout: 30000 });
  for (let i = 0; i < 200; i++) {
    if (await button.isEnabled()) break;
    await sleep(50);
  }
  out.with_product = {
    product_id: product.product_id || null,
    interactive_ms: Math.round(performance.now() - tReload),
    button_enabled: await button.isEnabled(),
  };
  out.total_ms = Math.round(performance.now() - t0);
} catch (error) {
  out.error = String(error.message || error).split("\n")[0];
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  upstream.server.close();
}

const verdict = out.error ? "probe_failed" : out.with_product?.button_enabled ? "ok" : "button_never_enabled";

if (asJson) console.log(JSON.stringify({ ...out, verdict }, null, 2));
else {
  console.log("\n冷启动实测（依赖已装、假上游、:memory:）\n");
  console.log(`  服务进程 → /api/health 通        ${out.server_ready_ms ?? "—"} ms`);
  console.log(`  浏览器启动（msedge）             ${out.browser_launch_ms ?? "—"} ms`);
  console.log(`  页面 → 首屏导航可见              ${out.first_paint_ms ?? "—"} ms`);
  console.log(`  空库时「新品 Listing」按钮可点    ${out.empty_state?.button_enabled ? "是" : "否（要先有商品）"}`);
  console.log(`  空库时有"去录一条商品"的指路     ${out.empty_state?.guides_to_entry ? "有" : "没有"}`);
  if (out.empty_state?.page_text) console.log(`  空库时整页文字                  ${out.empty_state.page_text.slice(0, 200)}`);
  console.log(`  有商品后 → 生成按钮可点           ${out.with_product?.interactive_ms ?? "—"} ms`);
  console.log(`  合计（spawn 服务 → 走完上面全部） ${out.total_ms ?? "—"} ms`);
  if (out.dist)
    console.log(`  构建产物：${out.dist.map((f) => `${f.name} ${f.kb} KB`).join(" · ")}`);
  if (out.error) console.log(`  脚本出错：${out.error}`);
  console.log(`\n  verdict: ${verdict}`);
  console.log("  没量：npm ci 装依赖（依赖已装好）。别把这个数当成\"第一次拿到包的人\"的体验。");
}
