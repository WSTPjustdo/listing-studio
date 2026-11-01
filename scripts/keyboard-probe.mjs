/**
 * 键盘可达实测：只用键盘（Tab / Shift+Tab / Enter / Esc），把界面走一遍，把"看不见的"变成数字。
 *
 * 用法：
 *   node scripts/keyboard-probe.mjs            # 打印实测结果
 *   node scripts/keyboard-probe.mjs --json     # 机器可读
 *   node scripts/keyboard-probe.mjs --strict   # 有条目不合规时以退出码 1 结束（给 CI 用）
 *
 * 它量四件事：
 *   1. 从打开页面到主操作，要按几次 Tab；中间停下的每个东西叫什么、在不在视口里
 *   2. 焦点指示器在不在：outline 宽度 / 阴影环与背景的对比度（这里只报数字，不下"合规"结论）
 *   3. 对话框：焦点会不会跑出去、Esc 能不能关、关掉后焦点回不回到触发它的按钮
 *   4. 等模型那段时间：焦点会不会落到遮罩下面（看得见才叫焦点）
 *
 * 一律离线：假上游自报 model: fake-1，数据库 :memory:，不碰 data/ 与 .runtime 以外的路径。
 * 注意：服务端发的是构建产物 dist/，改了 src/ 必须先 `npm run build`，否则量的是上一版。
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import process from "node:process";
import { ROOT } from "../server/store.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");
const PORT = 18799;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 假上游（与 demo-walk 同形状，自报 fake-1） ---------- */
function startFakeUpstream(modelMs) {
  const state = { hits: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      state.hits += 1;
      await sleep(modelMs);
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
                content: JSON.stringify({ content: draft, review: { issues: [], checks: [] }, claim_map: [], patches: [] }),
              },
            },
          ],
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

function startServer(upstreamUrl) {
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
      MODEL_TIMEOUT_MS: "60000",
    },
  });
  const log = [];
  child.stdout.on("data", (b) => log.push(String(b)));
  child.stderr.on("data", (b) => log.push(String(b)));
  return { child, log };
}

/* ---------- 对比度：只算阴影环/边框色与背景的亮度比 ----------
   注意：Playwright 的 page.evaluate(fn) 是把函数源码序列化后送进页面执行，
   所以 Node 侧的模板插值带不进去。这里统一拼成"一个字符串表达式"再送进去。 */
const HELPERS = `
  function parseColor(css) {
    if (!css) return null;
    const m = css.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  // 半透明颜色必须先压到背景上，再算亮度：rgba(0,122,255,0.6) 画在白底上不是那个蓝。
  function composite(fg, bg) {
    const f = parseColor(fg), b = parseColor(bg);
    if (!f || !b) return null;
    const mix = (x, y) => Math.round(x * f.a + y * (1 - f.a));
    return { r: mix(f.r, b.r), g: mix(f.g, b.g), b: mix(f.b, b.b) };
  }
  function lumRgb(c) {
    if (!c) return null;
    const to = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * to(c.r) + 0.7152 * to(c.g) + 0.0722 * to(c.b);
  }
  function ratio(fg, bg) {
    const composed = composite(fg, bg);
    const a = lumRgb(composed), b = lumRgb(parseColor(bg));
    if (a === null || b === null) return null;
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  }
`;

const DESCRIBE = `(() => {
  ${HELPERS}
  const el = document.activeElement;
  if (!el || el === document.body) return { tag: "BODY", label: "(没有焦点)", visible: false };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const text = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || "").replace(/\\s+/g, " ").trim();

  // 焦点指示器只认两种：描边（outline）和"环状"阴影（0 0 0 Npx 且 N>=2）。
  // 装饰性投影（0 2px 3px）不算——它一直画着，按下 Tab 前后一模一样，等于没提示。
  // 输入框常常把指示器画在父容器上（:focus-within），所以向上找三级。
  function ringColorOf(node) {
    const st = getComputedStyle(node);
    if (st.outlineStyle !== "none" && parseFloat(st.outlineWidth) >= 2) {
      return { kind: "描边", color: st.outlineColor, node: node.tagName + (node.className ? "." + String(node.className).split(" ")[0] : "") };
    }
    if (st.boxShadow && st.boxShadow !== "none") {
      const nums = (st.boxShadow.match(/-?[\d.]+px/g) || []).map(parseFloat);
      const spread = nums.length >= 4 ? nums[3] : 0;
      if (nums[0] === 0 && nums[1] === 0 && (nums[2] || 0) === 0 && spread >= 2) {
        const c = (st.boxShadow.match(/rgba?\([^)]+\)/) || [])[0];
        if (c) return { kind: "环状阴影", color: c, node: node.tagName + (node.className ? "." + String(node.className).split(" ")[0] : "") };
      }
    }
    return null;
  }
  // 元素背后真正露出来的颜色（沿祖先找第一个不透明背景）
  function backdrop(node) {
    let cur = node;
    while (cur && cur !== document.documentElement) {
      const bg = getComputedStyle(cur).backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
      cur = cur.parentElement;
    }
    return "rgb(255, 255, 255)";
  }
  let found = null, where = el;
  for (let node = el, i = 0; node && i < 4 && !found; node = node.parentElement, i++) {
    found = ringColorOf(node);
    where = node;
  }
  // 描边/环都画在元素外沿，所以要比的是"外面那层"的背景，不是元素自己的底色
  const bg = backdrop(where.parentElement || where);
  return {
    tag: el.tagName,
    label: text.slice(0, 44),
    cls: String(el.className || "").slice(0, 36),
    visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none",
    inViewport: r.top >= 0 && r.bottom <= window.innerHeight,
    ring: found ? found.kind : "无",
    ringOn: found ? found.node.split(".")[0] + (where === el ? "(自身)" : "(祖先)" ) : "",
    ringContrast: found ? ratio(found.color, bg) : null,
    ringRaw: found ? found.color + " on " + bg : "",
  };
})()`;

const WHERE_FOCUS = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return "BODY";
  const inOverlay = Boolean(el.closest(".busy-overlay"));
  const text = (el.getAttribute("aria-label") || el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 24);
  return (inOverlay ? "遮罩内:" : "遮罩外:") + text;
})()`;

const upstream = await startFakeUpstream(1200);
const { child, log } = startServer(upstream.url);
let browser;
let stepName = "startup";
const findings = []; // { id, ok, detail }
const fail = (id, ok, detail) => findings.push({ id, ok, detail });

try {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) })).ok) break;
    } catch {
      /* 还在起 */
    }
    await sleep(50);
  }

  // 演示要从有商品的状态开始（演示商品被 bootstrap 过滤，这里走商家录入路径）
  const created = await fetch(`${BASE}/api/products`, {
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
  if (!created.ok) throw new Error(`建商品失败 HTTP ${created.status}：${(await created.text()).slice(0, 200)}`);

  const { chromium } = await import("playwright");
  browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  stepName = "load";
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".nav-item", { timeout: 60000 });

  /* ---------- 1. Tab 顺序 ---------- */
  const stops = [];
  let tabsToMain = null;
  for (let i = 1; i <= 30; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(DESCRIBE);
    info.press = i;
    stops.push(info);
    if (tabsToMain === null && (await page.evaluate(() => Boolean(document.activeElement?.closest(".heading-actions"))))) {
      tabsToMain = i;
    }
    if (info.tag === "BODY" && i > 3) break;
  }
  // 第一个焦点落在哪：跳转链接 or 侧栏第一个导航
  const first = stops[0];
  const firstIsSkip = /跳到|跳转|skip/i.test(first?.label || "");
  fail(
    "tab:first-stop",
    Boolean(firstIsSkip),
    `第一个 Tab 落在「${first?.label || "?"}」(${first?.tag})；${firstIsSkip ? "是" : "不是"}跳转链接`,
  );
  // 这一条只报数不判定：首页没有 .heading-actions，量到的次数取决于是哪个页面，判"合不合规"没意义。
  // 真正可判的是下面创作页那条（有跳转链接就能在 12 次内够到主操作）。
  const invisible = stops.filter((s) => s.visible === false && s.tag !== "BODY");
  fail("tab:all-stops-visible", invisible.length === 0, `不可见的 tab 停点 ${invisible.length} 个`);

  /* ---------- 1b. 创作页：从页面顶部按几次 Tab 才够到"生成英文草稿" ---------- */
  stepName = "tab-create";
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".nav-item", { timeout: 60000 });
  // 2026-10-30 首页收敛为两条路径，旧入口折进「更多功能」，不展开就点不到
  await page.locator('.nav-item[aria-label="更多功能"]').click();
  await page.locator('.nav-item[aria-label="新品 Listing"]').click();
  await page.locator(".generate-button").waitFor({ timeout: 15000 });
  // 把"顺序焦点起点"重置到文档开头：只 blur 不行，浏览器会从上次聚焦的元素继续往右数
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    window.scrollTo(0, 0);
  });
  let tabsToGenerate = null;
  for (let i = 1; i <= 45; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => Boolean(document.activeElement?.classList?.contains("generate-button")))) {
      tabsToGenerate = i;
      break;
    }
  }
  // 用跳转链接的那条路：Tab（落在"跳到主要内容"）→ Enter 把焦点送到内容区 → 再数几次到生成按钮
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".nav-item", { timeout: 60000 });
  // 2026-10-30 首页收敛为两条路径，旧入口折进「更多功能」，不展开就点不到
  await page.locator('.nav-item[aria-label="更多功能"]').click();
  await page.locator('.nav-item[aria-label="新品 Listing"]').click();
  await page.locator(".generate-button").waitFor({ timeout: 15000 });
  // 把"顺序焦点起点"重置到文档开头：只 blur 不行，浏览器会从上次聚焦的元素继续往右数
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    window.scrollTo(0, 0);
  });
  await page.keyboard.press("Tab");
  const skipLabel = await page.evaluate(() => (document.activeElement?.innerText || "").trim());
  if (args.includes("--shot")) {
    await sleep(250); // 跳转链接有个 0.15s 的滑入，截太快会拍到它还在屏幕外
    mkdirSync(resolve(ROOT, ".runtime", "keyboard-probe"), { recursive: true });
    await page.screenshot({ path: resolve(ROOT, ".runtime", "keyboard-probe", "skip-link.png") });
  }
  await page.keyboard.press("Enter");
  const skipLanded = await page.evaluate(
    () => document.activeElement?.id === "main-content" || Boolean(document.activeElement?.closest("#main-content")),
  );
  let tabsViaSkip = null;
  if (skipLanded) {
    for (let i = 1; i <= 45; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(() => Boolean(document.activeElement?.classList?.contains("generate-button")))) {
        tabsViaSkip = i;
        break;
      }
    }
  }
  fail(
    "tab:to-generate",
    skipLanded && tabsViaSkip !== null && tabsViaSkip <= 12,
    `创作页从顶部到「生成英文草稿」：不用跳转链接 ${tabsToGenerate ?? "45+"} 次 Tab；` +
      `用「${skipLabel || "?"}」${skipLanded ? `再按 ${tabsViaSkip ?? "45+"} 次` : "没把焦点送到内容区"}`,
  );

  /* ---------- 2. 焦点指示器 ---------- */
  const noRing = stops.filter((s) => s.tag !== "BODY" && s.ring === "无");
  const weakRing = stops.filter((s) => s.ringContrast !== null && s.ringContrast < 3);
  const byKind = {};
  for (const s of stops.filter((x) => x.tag !== "BODY")) {
    const k = s.tag;
    byKind[k] = byKind[k] || { n: 0, weak: 0 };
    byKind[k].n += 1;
    if (s.ringContrast !== null && s.ringContrast < 3) byKind[k].weak += 1;
  }
  fail(
    "focus:ring",
    noRing.length === 0 && weakRing.length === 0,
    `无焦点指示 ${noRing.length} 个 / 指示器对比度 <3:1 的 ${weakRing.length} 个（按标签：${Object.entries(byKind)
      .map(([k, v]) => `${k} ${v.weak}/${v.n}`)
      .join("，")}）`,
  );

  /* ---------- 3. 对话框：焦点陷阱 / Esc / 焦点回归 ---------- */
  // 只用键盘走到「模型设置」，按下 Enter
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".nav-item", { timeout: 60000 });
  let reachedSettings = false;
  for (let i = 1; i <= 30; i++) {
    await page.keyboard.press("Tab");
    const isIt = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "模型设置");
    if (isIt) {
      reachedSettings = true;
      break;
    }
  }
  let dialog = { opened: false, enterFocusInside: false, leaks: 0, escapeClosed: false, focusReturned: false, tabs: 0 };
  if (reachedSettings) {
    await page.keyboard.press("Enter");
    dialog.opened = await page
      .locator('[role="dialog"][aria-modal="true"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (dialog.opened) {
      await sleep(150);
      dialog.enterFocusInside = await page.evaluate(
        () => Boolean(document.activeElement?.closest('[role="dialog"][aria-modal="true"]')),
      );
      for (let i = 1; i <= 20; i++) {
        await page.keyboard.press("Tab");
        dialog.tabs = i;
        const inside = await page.evaluate(
          () => Boolean(document.activeElement?.closest('[role="dialog"][aria-modal="true"]')),
        );
        if (!inside) dialog.leaks += 1;
      }
      await page.keyboard.press("Escape");
      await sleep(250);
      dialog.escapeClosed =
        (await page.locator('[role="dialog"][aria-modal="true"]').count()) === 0;
      dialog.focusReturned = await page.evaluate(
        () => document.activeElement?.getAttribute("aria-label") === "模型设置",
      );
    }
  }
  fail("dialog:keyboard-open", dialog.opened, reachedSettings ? "键盘能打开「模型设置」" : "30 次 Tab 没走到「模型设置」");
  fail("dialog:initial-focus", dialog.enterFocusInside, `打开后焦点${dialog.enterFocusInside ? "在" : "不在"}对话框内`);
  fail("dialog:trap", dialog.leaks === 0, `${dialog.tabs} 次 Tab 中跑出对话框 ${dialog.leaks} 次`);
  fail("dialog:escape", dialog.escapeClosed, `Esc ${dialog.escapeClosed ? "能" : "不能"}关闭`);
  fail("dialog:focus-return", dialog.focusReturned, `关闭后焦点${dialog.focusReturned ? "回到" : "没回到"}触发按钮`);

  // 不管上面结果如何，先把对话框收掉：Esc 若无效，遮罩会拦住后面所有的点击（这就是它危险的原因）
  stepName = "close-dialog";
  if ((await page.locator('[role="dialog"][aria-modal="true"]').count()) > 0) {
    await page.locator('[role="dialog"][aria-modal="true"] button[aria-label="关闭"]').first().click({ timeout: 4000 }).catch(() => {});
    await page.locator('[role="dialog"][aria-modal="true"]').first().waitFor({ state: "detached", timeout: 4000 }).catch(() => {});
  }

  /* ---------- 4. 等模型时的状态卡：是不是全屏遮罩？焦点会被它盖住吗？ ----------
     一开始我以为它是遮罩，量"焦点掉到遮罩下面"——错。它 pointer-events:none、
     只占屏幕一小块，页面本来就该能继续点。所以改量三件真事：
     它盖了多大面积、有没有挡住焦点所在的元素、上面的秒数是不是真的在走。 */
  stepName = "busy-card";
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".nav-item", { timeout: 60000 });
  // 2026-10-30 首页收敛为两条路径，旧入口折进「更多功能」，不展开就点不到
  await page.locator('.nav-item[aria-label="更多功能"]').click();
  await page.locator('.nav-item[aria-label="新品 Listing"]').click();
  await page.locator(".generate-button").waitFor({ timeout: 15000 });
  await page.locator(".generate-button").click();
  await page.locator(".busy-overlay").waitFor({ timeout: 10000 });
  const CARD_INFO = `(() => {
    const el = document.querySelector(".busy-overlay");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      coverage: Math.round((r.width * r.height) / (innerWidth * innerHeight) * 1000) / 10,
      pointerEvents: cs.pointerEvents,
      role: el.getAttribute("role"), live: el.getAttribute("aria-live"),
      text: el.innerText.replace(/\s+/g, " ").trim(),
      rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
    };
  })()`;
  const CARD_OVERLAP = `(() => {
    const el = document.querySelector(".busy-overlay");
    const a = document.activeElement;
    if (!el || !a || a === document.body) return { hit: false, what: "BODY" };
    const r = el.getBoundingClientRect(), q = a.getBoundingClientRect();
    const ox = Math.max(0, Math.min(r.right, q.right) - Math.max(r.left, q.left));
    const oy = Math.max(0, Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top));
    const overlap = ox * oy;
    const area = Math.max(1, q.width * q.height);
    return { hit: overlap / area > 0.5, what: (a.getAttribute("aria-label") || a.innerText || "").trim().slice(0, 20) };
  })()`;
  const card = await page.evaluate(CARD_INFO);
  const covered = [];
  for (let i = 1; i <= 6; i++) {
    await page.keyboard.press("Tab");
    covered.push(await page.evaluate(CARD_OVERLAP));
  }
  const coveredCount = covered.filter((c) => c.hit).length;
  const t1 = card?.text || "";
  await sleep(1600);
  const t2 = await page.evaluate(`(() => document.querySelector(".busy-overlay")?.innerText.replace(/\s+/g, " ").trim() || "")()`);
  const counterMoves = t1 !== "" && t2 !== "" && t1 !== t2;
  fail(
    "busy:status-card",
    Boolean(card) && card.coverage < 30 && coveredCount === 0 && card.pointerEvents === "none",
    `状态卡占屏 ${card?.coverage ?? "?"}%（${card?.w}×${card?.h}px，pointer-events: ${card?.pointerEvents}）；` +
      `Tab 6 次里 ${coveredCount} 次焦点被它盖住；1.6 秒内文字${counterMoves ? "在变（有秒数）" : "没变"}`,
  );
  fail("busy:announced", card?.role === "status" && card?.live === "polite", `role=${card?.role} aria-live=${card?.live}`);
  await page.locator(".toast").waitFor({ timeout: 60000 });
  // 跑完之后界面必须还能用（这条是给以后可能加的 inert / 禁焦点改动兜底的）
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  await page.keyboard.press("Tab");
  const usableAfter = await page.evaluate(() => document.activeElement !== document.body);
  fail("busy:app-usable-after", usableAfter, `跑完后第一个 Tab ${usableAfter ? "能" : "不能"}落到控件上`);

  /* ---------- 5. 390px 底部标签栏 ---------- */
  await page.setViewportSize({ width: 390, height: 780 });
  await sleep(300);
  const mobile = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".nav-item")];
    return {
      count: items.length,
      noName: items.filter((el) => !el.getAttribute("aria-label")).length,
      rects: items.map((el) => {
        const r = el.getBoundingClientRect();
        return { label: el.getAttribute("aria-label") || "", h: Math.round(r.height), top: Math.round(r.top) };
      }),
      // 标签栏在视口底部吗：所有 nav-item 都挤在最后 80px 内
      allNearBottom: items.every((el) => el.getBoundingClientRect().top > window.innerHeight - 100),
    };
  });
  fail("mobile:nav", mobile.noName === 0 && mobile.allNearBottom, `390px 下 ${mobile.count} 个导航项，无 aria-label 的 ${mobile.noName} 个`);

  /* ---------- 汇总 ---------- */
  const ringValues = stops.map((s) => s.ringContrast).filter((v) => typeof v === "number");
  const ringRange = ringValues.length
    ? `${Math.min(...ringValues)}–${Math.max(...ringValues)}:1`
    : "没量到";
  const bad = findings.filter((f) => !f.ok);
  const summary = {
    tab_stops: stops.length,
    tabs_to_generate: tabsToGenerate,
    tabs_to_generate_via_skip: tabsViaSkip,
    skip_link_label: skipLabel,
    tabs_to_main_action_home: tabsToMain,
    first_stop: first?.label || "",
    focus_ring_missing: noRing.length,
    focus_ring_contrast_range: ringRange,
    focus_ring_weak: weakRing.map((s) => `${s.tag}:${s.label || s.cls}(${s.ringContrast}:1)`),
    dialog,
    busy_card: { ...card, covered_by_card: coveredCount, counter_moves: counterMoves },
    mobile_nav: mobile,
    findings,
    bad_count: bad.length,
  };
  if (asJson) console.log(JSON.stringify(summary, null, 0));
  else {
    console.log(`\n键盘可达实测 · 1440×900（1 项移动端另测）· 假上游 1.2s/次\n`);
    console.log(`  首页 Tab 停点 ${stops.length} 个（页头没有主操作按钮，这条只看数量）`);
    console.log(`  第一个 Tab 落在「${first?.label || "?"}」`);
    console.log(`  创作页到「生成英文草稿」：不用跳转链接 ${tabsToGenerate ?? "45+"} 次；用跳转链接 ${tabsViaSkip ?? "未测到"} 次`);
    console.log(`  焦点指示器：缺失 ${noRing.length} 个，对比度 <3:1 的 ${weakRing.length} 个，全部停点的环对比度 ${ringRange}`);
    for (const s of weakRing.slice(0, 6)) console.log(`    · ${s.tag}「${s.label || s.cls}」 环对比度 ${s.ringContrast}:1（${s.ring}｜${s.ringRaw}）`);
    console.log(`  对话框：焦点陷阱 ${dialog.leaks === 0 ? "OK" : `漏 ${dialog.leaks}/${dialog.tabs}`}／Esc ${dialog.escapeClosed ? "OK" : "无效"}／焦点回归 ${dialog.focusReturned ? "OK" : "失败"}`);
    console.log(
      `  等模型：状态卡占屏 ${card?.coverage ?? "?"}%（pointer-events: ${card?.pointerEvents}），` +
        `Tab 6 次里 ${coveredCount} 次焦点被它盖住，秒数${counterMoves ? "在走" : "没走"}`,
    );
    console.log(`  390px：${mobile.count} 个导航项，${mobile.allNearBottom ? "全部在底部" : "有项不在底部"}`);
    console.log(`\n  条目 ${findings.length - bad.length}/${findings.length} 合规`);
    for (const f of bad) console.log(`    ✗ ${f.id}  ${f.detail}`);
    console.log("\n  Tab 顺序（按下的第 N 次 → 聚焦到的元素）：");
    for (const s of stops) {
      const ring = s.ring === "无" ? "无指示" : `${s.ring} ${s.ringContrast ?? "?"}:1`;
      console.log(
        `    ${String(s.press).padStart(2)}  ${s.tag.padEnd(7)} ${(s.label || s.cls || "").slice(0, 30).padEnd(32)} ${ring}${s.inViewport === false ? "  [不在视口]" : ""}`,
      );
    }
    console.log("");
  }
  if (strict && bad.length) process.exitCode = 1;
} catch (error) {
  console.error("实测中断（步骤 " + stepName + "）：" + error.message.split("\n")[0]);
  try {
    const pages = browser?.contexts?.()[0]?.pages?.() || [];
    const p = pages[0];
    if (p) {
      mkdirSync(resolve(ROOT, ".runtime", "keyboard-probe"), { recursive: true });
      const file = resolve(ROOT, ".runtime", "keyboard-probe", "failure.png");
      await p.screenshot({ path: file });
      console.error("失败截图：" + file);
      console.error(
        "当时的对话框数：" +
          (await p.locator('[role="dialog"][aria-modal="true"]').count()) +
          "，遮罩：" +
          (await p.locator(".busy-overlay").count()),
      );
    }
  } catch {
    /* 截图失败就算了 */
  }
  console.error(log.join("").slice(-1000));
  process.exitCode = 2;
} finally {
  if (browser) await browser.close();
  try {
    child.kill();
  } catch {
    /* 已退出 */
  }
  spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  await upstream.close();
}
