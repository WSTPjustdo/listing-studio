/**
 * 空状态探针：数据库是空的时候，界面第一条路指不指得出来。
 *
 * 用法：
 *   node scripts/empty-state-probe.mjs
 *   node scripts/empty-state-probe.mjs --json
 *
 * 为什么单独一个脚本：
 *   演示当天最可能的第一步就是"打开、想新建"，而 store 里种的两条演示商品被 bootstrap 过滤掉了，
 *   所以真实起点是【零商品、零记录】。这个脚本就在零商品状态下逐页读屏，看每页说不说人话：
 *   有没有告诉人下一步点哪里，还是只剩一个灰按钮。
 *
 * 只读：数据库 :memory:，不写 data/、不写 .runtime。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import process from "node:process";
import { ROOT } from "../server/store.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const PORT = 18796;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 页面上不可能有任何记录，模型也不会被调用；仍起一个假上游，防止误配真地址
const upstream = createServer((req, res) => {
  res.writeHead(503, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "probe does not call models" } }));
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

const child = spawn(process.execPath, ["server/index.mjs"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    DATABASE_PATH: ":memory:",
    MODEL_PROVIDER: "compatible",
    MODEL_BASE_URL: upstreamUrl,
    MODEL_NAME: "fake-1",
    MODEL_API_KEY: "local-fake",
    MODEL_TIMEOUT_MS: "5000",
  },
});
const log = [];
child.stdout.on("data", (b) => log.push(String(b)));
child.stderr.on("data", (b) => log.push(String(b)));

const PAGES = [
  // 侧栏按钮的 aria-label 是「首页」，界面上的字是「工作台」——这里按 aria-label 点。
  ["工作台", "首页"],
  ["新品 Listing", "新品 Listing"],
  ["诊断与修复", "诊断与修复"],
  ["商品资料", "商品资料"],
  // 「Listing 台账」和「版本记录」两个入口已合并进「我的结果」（上面文案、下面批量台账）。
  ["我的结果", "我的结果"],
];

let browser;
const out = { bootstrap_counts: null, pages: [] };
try {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) })).ok) break;
    } catch {
      /* 还在起 */
    }
    await sleep(50);
  }
  const boot = await (await fetch(`${BASE}/api/bootstrap`)).json();
  out.bootstrap_counts = {
    products: boot.products.length,
    listings: boot.listings.length,
    fixtures: boot.fixtures.length,
  };

  const { chromium } = await import("playwright");
  browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".nav-item", { timeout: 60000 });

  for (const [label, navLabel] of PAGES) {
    // 2026-10-30 首页收敛为两条路径，旧入口折进「更多功能」，不展开就点不到
    const navTarget = page.locator(`.nav-item[aria-label="${navLabel}"]`).first();
    if (!(await navTarget.isVisible())) {
      await page.locator('.nav-item[aria-label="更多功能"]').click();
      await sleep(150);
    }
    await navTarget.click();
    await sleep(500);
    // 主内容区（去掉左侧导航与顶栏）里，屏幕上真正看得到的字
    const main = page.locator(".page-content");
    const text = (await main.innerText()).replace(/\s+/g, " ").trim();
    const primary = page.locator(".page-content .primary-button");
    const buttons = [];
    for (let i = 0; i < Math.min(await primary.count(), 4); i += 1) {
      const btn = primary.nth(i);
      buttons.push({
        text: (await btn.innerText()).replace(/\s+/g, " ").trim(),
        enabled: await btn.isEnabled(),
      });
    }
    out.pages.push({
      page: label,
      chars: text.length,
      text: text,
      primary_buttons: buttons,
    });
  }

  // 对照组 A：诊断页贴了标题之后，「按钮为什么是灰的」那句必须消失、按钮必须能按。
  // 只查空状态会出现是不够的 —— 只加不减，就变成永久挂在那儿的骚扰。
  // 2026-10-30 旧入口折进「更多功能」，同样先展开
  if (!(await page.locator('.nav-item[aria-label="诊断与修复"]').first().isVisible())) {
    await page.locator('.nav-item[aria-label="更多功能"]').click();
    await sleep(150);
  }
  await page.locator('.nav-item[aria-label="诊断与修复"]').first().click();
  await sleep(400);
  const hintBefore = (await page.locator(".page-content").innerText()).includes("现在是灰的");
  const diagnoseBtn = page.locator(".page-content .generate-button");
  // 界面改版后诊断页的主按钮和输入框都换了名字。找不到就记 null / 跳过，
  // 让这条检查如实报"量不到"，而不是卡在这里 30 秒超时把整个探针拖挂。
  const hasGenerate = await diagnoseBtn.count();
  const disabledBefore = hasGenerate ? !(await diagnoseBtn.first().isEnabled()) : null;
  const oldInput = page.locator('.page-content textarea[placeholder*="product title"]');
  const hasOldInput = await oldInput.count();
  if (hasOldInput) await oldInput.first().fill("Cotton Canvas Tote Bag");
  await sleep(300);
  const hintAfter = (await page.locator(".page-content").innerText()).includes("现在是灰的");
  const disabledAfter = hasGenerate ? !(await diagnoseBtn.first().isEnabled()) : null;
  if (!hasGenerate || !hasOldInput)
    console.log(`提示：诊断页已换控件（generate-button ${hasGenerate}，旧输入框 ${hasOldInput}），这两项记为 null / 跳过，不算通过`);
  out.checks = { ...(out.checks || {}), diagnose_hint: { hintBefore, disabledBefore, hintAfter, disabledAfter } };

  // 对照组 B：建一条真实商品资料后，同一页的文案还是不是原来那句（改空状态不许把正常文案带歪）
  if (args.includes("--with-product")) {
    await fetch(`${BASE}/api/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
      }),
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".nav-item", { timeout: 60000 });
    await page.locator('.nav-item[aria-label="新品 Listing"]').first().click();
    await sleep(500);
    const withProduct = (await page.locator(".page-content").innerText()).replace(/\s+/g, " ").trim();
    out.pages.push({
      page: "新品 Listing（有商品）",
      chars: withProduct.length,
      text: withProduct,
      primary_buttons: [],
    });
  }
  await context.close();
} catch (error) {
  out.error = error.message.split("\n")[0];
  out.server_log_tail = log.join("").slice(-800);
} finally {
  if (browser) await browser.close();
  try { child.kill(); } catch { /* 已退出 */ }
  spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  await new Promise((r) => upstream.close(r));
}

if (asJson) console.log(JSON.stringify(out, null, 0));
else {
  console.log(`\n空状态探针 · 起始资源 products=${out.bootstrap_counts?.products} listings=${out.bootstrap_counts?.listings} fixtures=${out.bootstrap_counts?.fixtures}\n`);
  for (const p of out.pages) {
    console.log(`【${p.page}】正文 ${p.chars} 字`);
    console.log(`  ${p.text.slice(0, 420)}`);
    if (p.primary_buttons.length)
      console.log(`  主按钮: ${p.primary_buttons.map((b) => `${b.text}${b.enabled ? "" : "（灰）"}`).join(" / ")}`);
    console.log("");
  }
  if (out.checks?.diagnose_hint) {
    const c = out.checks.diagnose_hint;
    const ok = c.hintBefore && c.disabledBefore && !c.hintAfter && !c.disabledAfter;
    console.log("对照组（诊断页：贴标题前 → 后）：");
    console.log(`  「现在是灰的」那句：${c.hintBefore} → ${c.hintAfter}；按钮仍是灰：${c.disabledBefore} → ${c.disabledAfter}`);
    console.log(`  ${ok ? "符合预期" : "不符合预期"}：贴了内容后提示要消失、按钮要能按\n`);
  }
  if (out.error) console.log("出错：" + out.error + "\n" + (out.server_log_tail || ""));
}
process.exit(out.error ? 2 : 0);
