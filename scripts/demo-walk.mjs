/**
 * 演示走查：一条命令把「演示当天要点的那几下」跑一遍，打印每一步的耗时。
 *
 * 用法：
 *   node scripts/demo-walk.mjs                 # 默认假上游每次调用慢 1200ms，模拟真实响应
 *   node scripts/demo-walk.mjs --model-ms 0    # 让假上游立刻回
 *   node scripts/demo-walk.mjs --json
 *   node scripts/demo-walk.mjs --shot          # 存确认页截图到 .runtime/demo-walk/
 *
 * 它量的是"流程会不会卡"，不是讲稿：
 *   1. 打开工作台要多久、两条路径是不是都在
 *   2. 进「我有提示词」、填完能不能往下走
 *   3. 确认页不勾选时，生成按钮是不是灰的（演示时最容易卡在这里）
 *   4. 点生成 → 出结果之前要等多久（这一格是台上最长的空白）
 *   5. 生成完能不能拿到导出报告（字节数、耗时）
 *   6. 另一条「我没有提示词」能不能进到输入页
 *   7. 德国站：第一步下拉切「德国站 · 德语」，走完一条之后记录与导出报告都得是德国的
 *      （站点/语言/规则包三样对不上就判失败，不靠截图自证）
 *   8. 法国站：同上，另外多守一条 —— FR-LANG-01（语言要求）必须在检查清单里且真的判了
 *
 * 2026-10-30 更新：首页收敛成两条路径后，旧入口收进了「更多功能」折叠。
 * 这里改走 data-testid（two-path-home / choose-improve / choose-automatic /
 * guided-next / guided-generate / guided-step-confirm|result），假上游也补上了
 * plan 步骤（prompt_plan）。旧写法点 .nav-item[aria-label="新品 Listing"] 会 30 秒超时。
 *
 * 假上游一律自报 model: fake-1，不调用任何真实模型；数据库 :memory:，不碰 .runtime 与 data/。
 * 数字只在 --model-ms 指定的假设下成立：真模型那一段没人跑过（本机没有 Key）。
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import process from "node:process";
import { ROOT } from "../server/store.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const modelMs = Number(args.includes("--model-ms") ? args[args.indexOf("--model-ms") + 1] : 1200) || 0;
const PORT = 18797;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 写作方案（guided/plan）的合法返回：必须原样带两个占位符，否则服务端会判结构不符 */
const PLAN = {
  optimized_prompt:
    "Write an Amazon US listing for a cotton tote bag. Use {{PRODUCT_FACTS}} for every factual claim and {{KEYWORDS}} for keyword candidates. Keep each statement verifiable, avoid medical or environmental claims unless certified, and follow the rule pack supplied at use time for character limits.",
  changes: ["把中文口语要求改成可直接复用的英文写作指令", "去掉没有依据的环保宣称"],
  missing: [],
};

/* 假上游：每次调用先睡 modelMs，再回一份结构合法的结果 */
function startFakeUpstream() {
  const state = { hits: 0, operations: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      state.hits += 1;
      await sleep(modelMs);
      let operation = "create";
      try {
        operation = JSON.parse(JSON.parse(body).messages[1].content).operation || operation;
      } catch {
        /* 不是我们的请求形状，按 create 回 */
      }
      state.operations.push(operation);
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
      const echo = {
        title: "Cotton Canvas Tote Bag",
        item_highlights: "Waterproof and 100% organic cotton.",
        bullet_points: [{ id: "b1", text: "Handle length: 70 cm." }],
        description: "Messenger bag, waterproof, eco friendly.",
      };
      // plan 只回方案；生成与审核要回「文案 + 审核 + 证据」，少了这层服务端判 MODEL_INVALID_STRUCTURE
      const payload =
        operation === "prompt_plan"
          ? PLAN
          : {
              content: operation === "diagnose" ? echo : draft,
              review: { issues: [], checks: [] },
              claim_map: [],
              patches: [],
            };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `fake-${state.hits}`,
          model: "fake-1",
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(payload) } }],
          usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
        }),
      );
    });
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      done({
        state,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
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

const post = (path, data) =>
  fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

const upstream = await startFakeUpstream();
const { child, log } = startServer(upstream.url);
let browser;
const steps = [];
const t0 = Date.now();
const record = (name, ms, note = "") => steps.push({ name, ms, note });

try {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) })).ok) break;
    } catch {
      /* 还在起 */
    }
    await sleep(50);
  }
  record("服务就绪（/api/health）", Date.now() - t0);

  const { chromium } = await import("playwright");
  browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  let t = Date.now();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("two-path-home").waitFor({ timeout: 60000 });
  const chooseImprove = await page.getByTestId("choose-improve").count();
  const chooseAutomatic = await page.getByTestId("choose-automatic").count();
  record("打开工作台（两条路径都在）", Date.now() - t, `改进=${chooseImprove} 帮我完成=${chooseAutomatic}`);
  if (!chooseImprove || !chooseAutomatic) record("首页两条路径", 0, "缺一条路径");

  // 演示要有商品可点：走商家真实录入路径建一条，不用演示商品（演示商品已被 bootstrap 过滤）
  t = Date.now();
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
  record("建一条商品资料", Date.now() - t, product.product_id || "失败");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("two-path-home").waitFor({ timeout: 60000 });

  // 路径一：我有提示词，帮我改进
  t = Date.now();
  await page.getByTestId("choose-improve").click();
  await page.getByLabel("现有提示词", { exact: true }).fill("禁止夸大、不能用 medical claim、美式表达、不要堆砌");
  // 「使用已有商品档案」折在 <details> 里，不点开 summary 就选不到（这一步本身就值得记一条）
  await page.getByText("使用已有商品档案", { exact: true }).click();
  const selector = page.getByLabel("使用已有商品档案", { exact: true });
  let options = 0;
  if (await selector.count()) {
    options = await selector.locator("option").count();
    if (options > 1) await selector.selectOption({ index: 1 });
  }
  await page.getByTestId("guided-next").click();
  await page.getByTestId("guided-step-confirm").waitFor({ timeout: 15000 });
  record("路径一·填提示词 → 确认页", Date.now() - t, `商品档案选项 ${options} 个`);

  // 演示最容易卡的一格：没勾确认，生成按钮就是灰的，台上会以为程序坏了
  t = Date.now();
  const disabledBefore = await page.getByTestId("guided-generate").isDisabled();
  await page.getByLabel("确认当前商品信息与检查范围", { exact: true }).check();
  const disabledAfter = await page.getByTestId("guided-generate").isDisabled();
  record("确认页·勾选后才可按", Date.now() - t, `勾选前${disabledBefore ? "灰" : "可按"} → 勾选后${disabledAfter ? "灰" : "可按"}`);
  if (disabledAfter) record("生成按钮", 0, "按钮是灰的");

  // 投影仪/笔记本常见分辨率：确认页有没有横向溢出、主操作还在不在屏内
  t = Date.now();
  const widths = [1280, 1366, 1440, 1920];
  const viewLines = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 800 });
    await sleep(250);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const rect = await page.getByTestId("guided-generate").evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), vh: window.innerHeight, y: window.scrollY };
    });
    const inView = rect.top >= 0 && rect.bottom <= rect.vh ? "在屏内" : "需滚动";
    viewLines.push(`${width}·溢出${overflow}px·生成键${inView}(${rect.top}~${rect.bottom}/屏高${rect.vh}/滚动${rect.y})`);
  }
  record("常见演示分辨率自检", Date.now() - t, viewLines.join("｜"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(200);
  if (args.includes("--shot")) {
    const shotDir = resolve(ROOT, ".runtime", "demo-walk");
    mkdirSync(shotDir, { recursive: true });
    const file = resolve(shotDir, "confirm-first-screen.png");
    await page.screenshot({ path: file, fullPage: false });
    record("确认页截图", 0, file);
  }

  // 点生成 → 出结果：中间有 plan、生成、审核三次模型调用，这一格是台上最长的空白
  t = Date.now();
  await page.getByTestId("guided-generate").click();
  const settled = await page
    .locator('[data-testid="guided-step-result"], .guided-error, .toast, [role="alert"]')
    .first()
    .waitFor({ timeout: 180000 })
    .then(() => true)
    .catch(() => false);
  if (!settled) record("点生成 → 出结果", Date.now() - t, "既没出结果也没有报错，页面可能卡住");
  else {
    const onResult = await page.getByTestId("guided-step-result").count();
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
    record("点生成 → 出结果", Date.now() - t, onResult ? "已到结果页" : `停在提示：${text.slice(0, 60)}`);
    if (!onResult) record("生成结果", 0, "没到结果页");
  }

  // 导出报告：演示最后一步往往是"给评委看这张纸"
  t = Date.now();
  const listing = (await (await fetch(`${BASE}/api/listings`)).json()).at(0);
  let exportNote = "没有可导出的记录";
  if (listing) {
    const res = await fetch(`${BASE}/api/listings/${listing.listing_id}/export?version=1&format=html`);
    const bytes = (await res.text()).length;
    exportNote = `HTTP ${res.status} · ${bytes} 字节`;
  }
  record("导出 HTML 报告", Date.now() - t, exportNote);

  /*
   * 德国站：同一条引导流程，第一步下拉换成「德国站 · 德语」。
   * 彩排要能自己证明德国站是通的，而不是靠一张截图：
   * 走完之后从接口读那条记录，站点、语言、规则包版本三样都得是德国的。
   */
  t = Date.now();
  await page.locator('.nav-item[aria-label="首页"]').click();
  await page.getByTestId("two-path-home").waitFor({ timeout: 15000 });
  await page.getByTestId("choose-improve").click();
  await page.getByLabel("现有提示词", { exact: true }).fill("德语、德式单位写法、不要英式直译、不做环保宣称");
  // 和路径一一样，得先选一条已确认的商品档案——不选就只剩"从粘贴的文字里识别"，
  // 而这条路径的输入框是空的，会停在第一步。
  await page.getByText("使用已有商品档案", { exact: true }).click();
  const germanProduct = page.getByLabel("使用已有商品档案", { exact: true });
  if ((await germanProduct.locator("option").count()) > 1)
    await germanProduct.selectOption({ index: 1 });
  const languageSelect = page.getByTestId("guided-language");
  const languageOptions = await languageSelect.locator("option").allInnerTexts();
  const hasGerman = languageOptions.some((text) => text.includes("德国站"));
  // 按选项文字找、再取它的 value 去选：不写死 "de" 也不写死 "DE-de"。
  // 2026-10-31 加英国站时把 value 从语言名改成了站点键（en → US-en），
  // 写死 value 的脚本当场超时。按文字找只依赖界面上看得见的东西。
  const germanValue = await languageSelect
    .locator("option", { hasText: "德国站" })
    .first()
    .getAttribute("value");
  await languageSelect.selectOption(germanValue ?? "de");
  await page.getByTestId("guided-next").click();
  await page.getByTestId("guided-step-confirm").waitFor({ timeout: 15000 });
  const confirmText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  // 顶栏那行「Amazon US · 英文」也得跟着走，否则同屏两处自相矛盾
  const headerText = (await page.locator(".market-label").first().innerText()).replace(/\s+/g, " ");
  record("德国站·下拉有「德国站 · 德语」并切过去", Date.now() - t,
    `下拉 ${languageOptions.length} 项${hasGerman ? "" : "（没有德国站！）"} · 顶栏${headerText.includes("Amazon DE") ? "写德国站" : "仍是美国站"} · 确认页${confirmText.includes("德语") ? "写着德语" : "没说德语"}${confirmText.includes("德国站棉布手提袋") ? "·范围也是德国站" : "·范围仍写美国站"}`);
  if (!hasGerman) record("德国站下拉", 0, "缺一条路径");
  if (!headerText.includes("Amazon DE")) record("德国站顶栏", 0, "缺一条路径");
  // 勾选那句"确认本次用于 X 棉布手提袋"如果还写美国站，人会在台上以为自己勾错了
  if (!confirmText.includes("德国站棉布手提袋")) record("德国站确认话术", 0, "缺一条路径");

  t = Date.now();
  await page.getByLabel("确认当前商品信息与检查范围", { exact: true }).check();
  await page.getByTestId("guided-generate").click();
  const germanSettled = await page
    .locator('[data-testid="guided-step-result"], .guided-error, .toast, [role="alert"]')
    .first()
    .waitFor({ timeout: 180000 })
    .then(() => true)
    .catch(() => false);
  const onGermanResult = await page.getByTestId("guided-step-result").count();
  // 从接口读这条记录：界面说德语但记录说美国站，是最难在台上发现的那种错
  const german = (await (await fetch(`${BASE}/api/listings`)).json())
    .filter((item) => item.marketplace === "DE")
    .at(0);
  const germanNote = !germanSettled
    ? "既没出结果也没有报错"
    : !onGermanResult
      ? "没到结果页"
      : !german
        ? "没保存成德国站记录"
        : `站点=${german.marketplace} 语言=${german.language} 包=${german.rule_pack_version} 问题=${german.review?.issues?.length ?? "?"}项`;
  record("德国站·生成并落库", Date.now() - t, germanNote);
  if (!german || german.language !== "de" || !String(german.rule_pack_version).includes("-de-"))
    record("德国站记录", 0, "站点/语言/规则包不对");
  if (german) {
    t = Date.now();
    const res = await fetch(`${BASE}/api/listings/${german.listing_id}/export?version=${german.version}&format=html`);
    const html = await res.text();
    record("德国站·导出报告只列德国规则", Date.now() - t,
      `HTTP ${res.status} · ${html.includes("amazon-de") ? "包版本是德国" : "包版本不是德国"} · ${html.includes("US-01") ? "混进了美国规则" : "无美国规则"}`);
    if (!html.includes("amazon-de") || html.includes("US-01")) record("德国站报告", 0, "规则包混了");
  }

  /*
   * 法国站：同一条引导流程，第一步下拉换成「法国站 · 法语」。
   *
   * 为什么法国站值得单独走一遍（而不是"跟德国站一样"）：它是唯一一个**多出一条本地检查**的站点。
   * 德国/英国/美国都只有 4 条平台层能出结论，法国站的 FR-LANG-01 会真的判「这段文案读起来是不是英语」。
   * 所以这里除了站点 / 语言 / 规则包三样，还要确认那条规则真的出现在检查清单里 ——
   * 光看"没报错"是看不出来的。
   */
  t = Date.now();
  await page.locator('.nav-item[aria-label="首页"]').click();
  await page.getByTestId("two-path-home").waitFor({ timeout: 15000 });
  await page.getByTestId("choose-improve").click();
  await page.getByLabel("现有提示词", { exact: true }).fill("法语、法式数字写法、购物袋用途、不做环保宣称、不写注册号");
  await page.getByText("使用已有商品档案", { exact: true }).click();
  const frenchProduct = page.getByLabel("使用已有商品档案", { exact: true });
  if ((await frenchProduct.locator("option").count()) > 1)
    await frenchProduct.selectOption({ index: 1 });
  const frenchSelect = page.getByTestId("guided-language");
  const frenchOptions = await frenchSelect.locator("option").allInnerTexts();
  const hasFrench = frenchOptions.some((text) => text.includes("法国站"));
  const frenchValue = await frenchSelect
    .locator("option", { hasText: "法国站" })
    .first()
    .getAttribute("value");
  await frenchSelect.selectOption(frenchValue ?? "FR-fr");
  await page.getByTestId("guided-next").click();
  await page.getByTestId("guided-step-confirm").waitFor({ timeout: 15000 });
  const frenchConfirm = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const frenchHeader = (await page.locator(".market-label").first().innerText()).replace(/\s+/g, " ");
  record("法国站·下拉有「法国站 · 法语」并切过去", Date.now() - t,
    `下拉 ${frenchOptions.length} 项${hasFrench ? "" : "（没有法国站！）"} · 顶栏${frenchHeader.includes("Amazon FR") ? "写法国站" : "仍是美国站"} · 确认页${frenchConfirm.includes("法语") ? "写着法语" : "没说法语"}${frenchConfirm.includes("法国站棉布手提袋") ? "·范围也是法国站" : "·范围仍写美国站"}`);
  if (!hasFrench) record("法国站下拉", 0, "缺一条路径");
  if (!frenchHeader.includes("Amazon FR")) record("法国站顶栏", 0, "缺一条路径");
  if (!frenchConfirm.includes("法国站棉布手提袋")) record("法国站确认话术", 0, "缺一条路径");

  t = Date.now();
  await page.getByLabel("确认当前商品信息与检查范围", { exact: true }).check();
  await page.getByTestId("guided-generate").click();
  const frenchSettled = await page
    .locator('[data-testid="guided-step-result"], .guided-error, .toast, [role="alert"]')
    .first()
    .waitFor({ timeout: 180000 })
    .then(() => true)
    .catch(() => false);
  const onFrenchResult = await page.getByTestId("guided-step-result").count();
  const french = (await (await fetch(`${BASE}/api/listings`)).json())
    .filter((item) => item.marketplace === "FR")
    .at(0);
  const frenchNote = !frenchSettled
    ? "既没出结果也没有报错"
    : !onFrenchResult
      ? "没到结果页"
      : !french
        ? "没保存成法国站记录"
        : `站点=${french.marketplace} 语言=${french.language} 包=${french.rule_pack_version} 问题=${french.review?.issues?.length ?? "?"}项`;
  record("法国站·生成并落库", Date.now() - t, frenchNote);
  if (!french || french.language !== "fr" || !String(french.rule_pack_version).includes("-fr-"))
    record("法国站记录", 0, "站点/语言/规则包不对");
  if (french) {
    /*
     * FR-LANG-01 必须在这条记录的检查清单里。
     * 注意这里**期望它 fail**：假上游的 fixture 是英文的（它不写德语也不写法语），
     * 而法国站比德国站多一条语言检查，所以英文稿在法国站被抓出来是正确行为 ——
     * 真正要防的是"英文稿被判 pass"，那说明这条检查根本没生效。
     */
    const frenchChecks = french.review?.checks || [];
    const langCheck = frenchChecks.find((check) => check.rule_id === "FR-LANG-01");
    record("法国站·语言检查确实在清单里", Date.now() - t,
      langCheck
        ? `FR-LANG-01 = ${langCheck.state}${langCheck.state === "fail" ? "（假上游只写英文，它正确抓到了）" : ""}`
        : "检查清单里没有 FR-LANG-01");
    if (!langCheck) record("法国站语言检查", 0, "缺一条本地检查");
    else if (langCheck.state === "pass") record("法国站语言检查", 0, "英文文案被判 pass —— 检查没生效");
    const leaked = frenchChecks.some((check) =>
      ["US-01", "DE-TEXTIL-01", "UK-TITLE-01"].includes(check.rule_id));
    t = Date.now();
    const res = await fetch(`${BASE}/api/listings/${french.listing_id}/export?version=${french.version}&format=html`);
    const html = await res.text();
    record("法国站·导出报告只列法国规则", Date.now() - t,
      `HTTP ${res.status} · ${html.includes("amazon-fr") ? "包版本是法国" : "包版本不是法国"} · ${html.includes("US-01") || leaked ? "混进了别站规则" : "无别站规则"}`);
    if (!html.includes("amazon-fr") || html.includes("US-01") || leaked) record("法国站报告", 0, "规则包混了");
  }

  /*
   * 引擎自证：上面那条德语记录是"干净的"（0 项问题），看不出本地检查到底跑没跑。
   * 这里直接喂一条**故意写坏**的德语文案，确认四条本地检查各报一条。
   * 走的是同一个 reviewContent + 同一份德国包，不经过界面 —— 它证明的是引擎，
   * 所以以后谁把某条检查改坏了，彩排会当场说出来，不用靠人记。
   */
  {
    const probeStart = Date.now();
    const { rulePackFor } = await import("../server/store.mjs");
    const { reviewContent } = await import("../server/domain.mjs");
    const probe = reviewContent({
      content: {
        title: "Baumwolltasche 38 × 42 cm",
        item_highlights: "",
        bullet_points: [
          { id: "b1", text: "Umweltfreundlich und nachhaltig." },
          { id: "b2", text: "OEKO-TEX geprüft." },
          { id: "b3", text: "GARANTIE: 3 Monate Ersatz." },
          // 注册号不该出现在文案里，而且本地核不了真伪 —— 第 8 轮接上的那半条
          { id: "b4", text: "Versand im Polybeutel, LUCID-Registrierung DE1234567890123." },
        ],
        description: "Hergestellt aus 100 % Baumwolle.",
      },
      profile: null,
      rulePack: rulePackFor("DE"),
      marketplace: "DE",
    });
    const fired = new Set(probe.issues.map((issue) => issue.rule_id));
    const want = ["DE-ENV-01", "DE-CERT-01", "DE-GARANTIE-01", "DE-VERPACK-01"];
    const missing = want.filter((id) => !fired.has(id));
    record(
      "德国站·本地检查自证（环保词 / 认证 / 质保 / 包装注册号各报一条）",
      Date.now() - probeStart,
      missing.length ? `本地检查没跑：缺 ${missing.join("、")}` : `四条都报到了 · 共 ${probe.issues.length} 条问题`,
    );
  }

  /*
   * GPSR 四要素自证：第 9 轮把「制造商 / 欧盟责任人」做成了专门档案字段，
   * 清单要能按字段逐项说话，而不是笼统一句「判不了」。这里喂两份档案：
   *   ① 制造商在中国、没填欧盟责任人 → 必须点出「不在欧盟，这一项必须有」
   *   ② 补上欧盟责任人且六项齐全   → 这一项必须改口说齐全，同时**仍然不是 pass**
   * 判据写在彩排里，以后谁把清单改坏了，彩排当场红。
   */
  {
    const gpsrStart = Date.now();
    const { rulePackFor } = await import("../server/store.mjs");
    const { reviewContent } = await import("../server/domain.mjs");
    const party = (value) => ({ value, status: value ? "merchant_confirmed" : "unknown", source_ids: [] });
    const manufacturerInChina = {
      name: "Beispiel Textil Co., Ltd.",
      street: "Baogang Road 18",
      postal_code: "518000",
      city: "Shenzhen",
      country: "China",
      electronic_address: "sales@beispiel.cn",
    };
    const euResponsible = {
      name: "Beispiel EU GmbH",
      street: "Hauptstraße 2",
      postal_code: "20095",
      city: "Hamburg",
      country: "Deutschland",
      electronic_address: "eu@beispiel.de",
    };
    const check = (manufacturer, responsible) =>
      reviewContent({
        content: {
          title: "Baumwolltasche 38 × 42 cm",
          item_highlights: "",
          bullet_points: [],
          description: "100 % Baumwolle.",
        },
        profile: {
          product_id: "P-DEMO-GPSR",
          revision: 1,
          name_zh: "棉布袋",
          additional_facts: [],
          manufacturer: party(manufacturer),
          eu_responsible: party(responsible),
        },
        rulePack: rulePackFor("DE"),
        marketplace: "DE",
      }).checks.find((item) => item.rule_id === "DE-GPSR-19");
    const before = check(manufacturerInChina, null);
    const after = check(manufacturerInChina, euResponsible);
    const problems = [
      before.reason?.includes("不在欧盟，这一项必须有") ? "" : "没填欧盟责任人时不报缺项",
      after.reason?.includes("6 项齐全") ? "" : "填齐后不改口报齐全",
      after.state === "not_checked" ? "" : "给了 pass（页面是否展示本地判不了）",
    ].filter(Boolean);
    record(
      "德国站·GPSR 四要素按档案逐项判",
      Date.now() - gpsrStart,
      problems.length
        ? `清单没按档案判：${problems.join("、")}`
        : `制造商在中国→②报「必须有」；补欧盟责任人→②报「6 项齐全」；状态仍是 not_checked`,
    );
  }

  // 路径二：我没有提示词，帮我完成
  t = Date.now();
  await page.locator('.nav-item[aria-label="首页"]').click();
  await page.getByTestId("two-path-home").waitFor({ timeout: 15000 });
  await page.getByTestId("choose-automatic").click();
  await page.getByTestId("guided-step-input").waitFor({ timeout: 15000 });
  record("路径二·进入输入页", Date.now() - t);

  record("页面脚本错误", 0, pageErrors.length ? pageErrors.slice(0, 2).join(" / ") : "无");

  const total = Date.now() - t0;
  const summary = {
    model_latency_assumed_ms: modelMs,
    upstream_calls: upstream.state.hits,
    upstream_operations: upstream.state.operations,
    total_ms: total,
    steps,
    page_errors: pageErrors,
  };
  if (asJson) console.log(JSON.stringify(summary, null, 0));
  else {
    console.log(
      `\n演示走查 · 假上游每次调用慢 ${modelMs}ms（假设，不是实测模型速度）· 共 ${upstream.state.hits} 次调用（${upstream.state.operations.join("/")}）\n`,
    );
    for (const s of steps) {
      if (s.name === "常见演示分辨率自检") {
        console.log(`  ${String((s.ms / 1000).toFixed(2) + "s").padStart(7)}  ${s.name}`);
        for (const line of s.note.split("｜")) console.log(`             · ${line}`);
        continue;
      }
      console.log(`  ${String((s.ms / 1000).toFixed(2) + "s").padStart(7)}  ${s.name}${s.note ? `  · ${s.note}` : ""}`);
    }
    console.log(`  ${"—".repeat(7)}`);
    console.log(`  ${String((total / 1000).toFixed(2) + "s").padStart(7)}  合计（不含人讲解与手动改稿）`);
    const broken = steps.filter((s) => s.note && /按钮是灰的|缺一条路径|没到结果页|可能卡住|规则包不对|规则包混了|本地检查没跑|清单没按档案判/.test(s.note));
    if (broken.length) {
      console.log(`\n  ⚠ 演示会卡在：${broken.map((s) => s.name).join("、")}——先把这几格查清再上台。`);
      process.exitCode = 1;
    }
    if (pageErrors.length) {
      console.log(`\n  ⚠ 页面出现脚本错误：${pageErrors.slice(0, 3).join(" / ")}`);
      process.exitCode = 1;
    }
  }
  await context.close();
} catch (error) {
  console.error("走查中断：" + error.message.split("\n")[0]);
  // 断在哪一步比错误原文有用：把已经走完的步列出来，最后一条就是断点前面那格
  if (steps.length) console.error("已走完：" + steps.map((s) => s.name).join(" → "));
  // 断点现场截一张：光看超时信息判断不出页面停在哪
  try {
    if (browser) {
      const pages = browser.contexts()[0]?.pages() || [];
      if (pages.length) {
        const dir = resolve(ROOT, ".runtime", "demo-walk");
        mkdirSync(dir, { recursive: true });
        await pages[0].screenshot({ path: resolve(dir, "failure.png"), fullPage: false });
        console.error("断点截图：.runtime/demo-walk/failure.png");
      }
    }
  } catch { /* 截图失败不影响退出码 */ }
  console.error(log.join("").slice(-1200));
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
