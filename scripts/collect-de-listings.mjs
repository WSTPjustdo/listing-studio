#!/usr/bin/env node
/**
 * 德国站竞品语料采集器（第 4 轮 · 自选区 3c）
 *
 * 做什么：从**真实 amazon.de 在售商品页**抽标题、五点、描述、参数表，用项目自己的规则引擎
 * （`server/domain.mjs` 的 `reviewContent` + `amazon-focus/rules-de.json`）跑一遍，
 * 得出「德国站 19 条规则在真实德语样本里命中多少」。
 *
 * 与 `scripts/collect-listings.mjs`（美国站）的关系：
 *   解析与统计口径刻意分开写 —— 入选条件、语言判定、报告口径都不一样（德语标题里没有 "tote bag"）。
 *   两份共用的是**规则引擎**，不是解析器；合到一个脚本里只会变成一堆 if (market === 'de')。
 *
 * 边界（和美国站那次一致）：
 * - 只读公开页面，不登录、不绕验证、不解验证码。撞空壳页/验证页/英文变体换 UA 重试一次，再不行记进 skipped。
 * - 抓不到的字段写 null，报告写「未知」。一个数字都不许编。
 * - 每页间隔 3–5 秒；默认最多 30 次请求（含搜索页）。
 *
 * 两个实测坑（2026-10-30，本机）：
 * 1. **Node 内置 fetch 在 amazon.de 上拿到的是 3.8 KB 空壳页**；同样的 UA 用 curl 能拿到 220 KB 正常页。
 *    差别在 TLS 指纹，不在请求头 —— 所以这里走 curl。
 * 2. **站内语言由 cookie `lc-acbde` 决定**。不带 cookie 时搜索页是 1.3 KB 空壳；带上才出德语结果页。
 *    另外 amazon.de 上确实存在「英文标题的在售商品」（未翻译的 listing），
 *    所以入样时要判语言，否则会把英文文案算进「德语语料」。
 *
 * 用法：
 *   node scripts/collect-de-listings.mjs                       # 默认目标 12 条
 *   node scripts/collect-de-listings.mjs --target 3 --max-fetch 8 --out .runtime/de-smoke.json
 *   node scripts/collect-de-listings.mjs --restat --out data-research/de-listings-20261030.json
 *
 * 产物：<out>.json（逐条可核） + 同名 .md（统计报告）
 */
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { load } from "cheerio";
import { reviewContent, characterCount, IMPLEMENTED_RULE_IDS, PARTIALLY_IMPLEMENTED_RULE_IDS } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV = resolve(HERE, "..");

/**
 * 只实现了确定性那一半的规则：本地到底跑了什么、还剩什么判不了。
 *
 * 必须一条一条写清楚，不能用一句「确定性那一半」套所有规则 —— 上一版就是这么套的，
 * 结果 DE-ENV-01 接进来以后表格里显示「部分本地判（确定性五项）」，读者会以为
 * 环保词也查了五项成分。
 *
 * 新加一条 partial 规则而没在这里登记 -> 直接报错，不许悄悄套用别人的描述。
 */
const PARTIAL_SCOPE = {
  "DE-TEXTIL-01": {
    label: "部分本地判（成分五项）",
    done: "成分百分比合计、降序、100 % 与多纤维矛盾、纤维名是否用德语、成分是否写进文案，五项",
    missing: "棉/亚麻之外的纤维名（Wolle、Viskose）、只写在图文页里的成分标注",
  },
  "DE-ENV-01": {
    label: "部分本地判（环保词候选）",
    done: "泛化环保词候选检测（按包里的词表：klimaneutral / umweltfreundlich / nachhaltig / öko 等）",
    missing: "「同媒介上有没有清晰醒目的具体说明」「宣称是否覆盖整个产品」「补偿型说法有没有写所依据的排放量」",
  },
  "DE-CERT-01": {
    label: "部分本地判（认证宣称）",
    done: "认证标志候选检测（按包里的词表：OEKO-TEX / TÜV / GS / CE）+ 全篇有没有可核对的证书编号 + 在不适用 CE 的品类上标 CE",
    missing: "证书是否真的持有、编号与发证机构是否对得上、检测项是否覆盖本产品",
  },
  "DE-GARANTIE-01": {
    label: "部分本地判（质保宣称）",
    done: "Garantie 类质保宣称的候选检测 + 四项法定内容（法定权利提示 / 保证人名称与地址 / 行使方式 / 期限与地域）",
    missing: "质保是否真的兑付、地域是否覆盖买家所在地、以及「必须点名商品」这一项",
  },
  "DE-VERPACK-01": {
    label: "部分本地判（包装注册号写法）",
    done: "文案里有没有写包装注册号（LUCID / Verpackungsregister 字样，或裸的 DE + 8 位以上数字）+ 提到包装时同段有没有材料与比例写法",
    missing: "商家到底有没有在 Zentrale Stelle Verpackungsregister 注册、系统参与是否完成（都在商家后台）、以及注册号真伪 —— 这几件本地永远读不到",
  },
};

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (!token.startsWith("--")) continue;
  const next = process.argv[i + 1];
  args.set(token.slice(2), next && !next.startsWith("--") ? next : "1");
}

const TARGET = Number(args.get("target") || 12);
const MAX_FETCH = Number(args.get("max-fetch") || 30);
const OUT = resolve(DEV, args.get("out") || "data-research/de-listings-20261030.json");
const RESTAT = args.has("restat");

const PACK = rulePackFor("DE");
const DOMAIN = "www.amazon.de";
const COOKIE = "lc-acbde=de_DE; i18n-prefs=EUR";
const QUERIES = (args.get("queries") || "Baumwolltasche,Stofftasche Baumwolle,Einkaufstasche Baumwolle")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const titleKey = (title) => title.toLowerCase().replace(/[^a-zäöüß0-9]+/g, " ").trim();
const CAPTCHA = /Enter the characters you see below|api-services-support@amazon\.com|Robot Check|Geben Sie die Zeichen unten ein/i;
/** 德语页判定：页面语言标记，或商品标题里有德语字符。 */
const isGermanPage = (html) =>
  /<html[^>]*lang="de/i.test(html.slice(0, 3000)) || /id="productTitle"[^>]*>[^<]*[äöüßÄÖÜ]/.test(html);

/** 德语「棉质手提袋/购物袋」类目词。德国站标题不会写 "tote bag"。 */
const CATEGORY = /(tasche|taschen|beutel|shopper|tragetasche|einkaufstasche|stofftasche|einkaufsbeutel)/i;
/** 明确不属于棉质的，混进来会把统计拉偏。 */
const NON_COTTON = /(jute|polyester|nylon|leder|papier|vlies|non[-\s]?woven|thermo|kühl|leinen(?!.*baumwoll))/i;
const COTTON = /(baumwoll|cotton)/i;

function eligibilityReject(listing, seenTitles) {
  if (!CATEGORY.test(listing.title)) return "类目不符";
  if (NON_COTTON.test(listing.title)) return "材质不符（含非棉纤维或非棉，如黄麻/涤纶/棉麻混纺）";
  if (!listing.cotton_disclosed) return "未见棉成分披露";
  if (!listing.bullets.length) return "无可审文本（无五点）";
  if (seenTitles.has(titleKey(listing.title))) return "同款重复";
  return null;
}

/**
 * 取一页。用 curl 而不是 fetch（见文件头坑 1）。`--compressed` 后写进文件的字节数
 * 会大于 `%{size_download}`（那是压缩后的传输量），所以 bytes 一律用读回来的长度。
 */
async function curlGet(url, uaIndex = 0) {
  const tmp = resolve(DEV, `.runtime/de-fetch-${process.pid}-${Date.now()}.html`);
  await mkdir(dirname(tmp), { recursive: true });
  const argv = [
    "-sS", "--compressed", "--max-time", "30", "--location",
    "-A", UA_POOL[uaIndex % UA_POOL.length],
    "-H", "accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "-H", "accept-language: de-DE,de;q=0.9,en;q=0.5",
    "-H", `cookie: ${COOKIE}`,
    "-o", tmp,
    "-w", "%{http_code}",
    url,
  ];
  try {
    const out = await new Promise((settle) => execFile("curl", argv, { maxBuffer: 1 << 20 }, (err, stdout) => settle({ err, stdout })));
    const status = Number(String(out.stdout || "").trim()) || 0;
    if (out.err || !status) return { ok: false, reason: `网络错误：${String(out.err?.message || "curl 无状态码").slice(0, 70)}`, status, bytes: 0 };
    const html = await readFile(tmp, "utf8");
    return { ok: status === 200, reason: status === 200 ? null : `HTTP ${status}`, status, bytes: html.length, html };
  } finally {
    await rm(tmp, { force: true });
  }
}

async function fetchProduct(asin, uaIndex = 0, attempt = 1) {
  const url = `https://${DOMAIN}/dp/${asin}?language=de_DE`;
  const page = await curlGet(url, uaIndex);
  if (!page.ok) {
    if (attempt < 2 && page.status === 0) {
      await sleep(4000);
      return fetchProduct(asin, uaIndex + 1, attempt + 1);
    }
    return { ...page, uaIndex };
  }
  if (CAPTCHA.test(page.html.slice(0, 4000))) {
    if (attempt < 2) {
      await sleep(3000);
      return fetchProduct(asin, uaIndex + 1, attempt + 1);
    }
    return { ok: false, reason: "验证页（两种 UA 都撞到）", status: page.status, bytes: page.bytes, uaIndex };
  }
  // 空壳页（实测 1.3–3.8 KB，title 是 &nbsp;）：amazon.de 对无 cookie / 非浏览器的默认应答，不是商品下架。
  if (page.bytes < 20000) return { ok: false, reason: `页面过短（${page.bytes} 字节，疑似空壳页）`, status: page.status, bytes: page.bytes, uaIndex };
  if (!isGermanPage(page.html)) {
    if (attempt < 2) {
      await sleep(3000);
      return fetchProduct(asin, uaIndex + 1, attempt + 1);
    }
    return { ok: false, reason: "非德语页面（英文变体）", status: page.status, bytes: page.bytes, uaIndex };
  }
  return { ok: true, html: page.html, url, status: page.status, bytes: page.bytes, uaIndex };
}

/** 搜索结果页发现 ASIN。搜索页只有在带 lc-acbde cookie 时才返回德语结果（见文件头坑 2）。 */
async function discover(query) {
  const url = `https://${DOMAIN}/s?k=${encodeURIComponent(query)}&language=de_DE`;
  const page = await curlGet(url, 0);
  if (!page.ok || page.bytes < 20000) return { query, ok: false, reason: page.reason || `页面过短（${page.bytes} 字节）`, asins: [] };
  const asins = [...new Set([...page.html.matchAll(/data-asin="([A-Z0-9]{10})"/g)].map((m) => m[1]))].filter((x) => /^B0/.test(x));
  return { query, ok: true, bytes: page.bytes, asins, status: page.status };
}

function parseListing(html, asin, url, meta = {}) {
  const $ = load(html);
  $("script,style,noscript,iframe").remove();
  const title = clean($("#productTitle").first().text());
  if (!title) return null;

  let bullets = [...$("#feature-bullets li .a-list-item, #feature-bullets li span.a-list-item")]
    .map((el) => clean($(el).text()))
    .filter((text) => text && !/Weitere Produktdetails|see more product details/i.test(text));
  if (!bullets.length)
    bullets = [...$("#productFactsDesktopExpander ul.a-unordered-list > li")]
      .map((el) => clean($(el).text()))
      .filter((text) => text && !/Weitere Produktdetails|see more product details/i.test(text));
  bullets = [...new Set(bullets)];

  const description = clean($("#productDescription").text() || $("#bookDescription_feature_div").text() || "").slice(0, 6000);

  const details = [];
  const pushDetail = (label, value) => {
    const l = clean(label).replace(/[\u200e\u200f\s]+$/g, "").trim();
    const v = clean(value);
    if (l && v && l.length < 100 && v.length < 600) details.push({ label: l, value: v });
  };
  $("table.a-keyvalue tr").each((_, el) => {
    const row = $(el);
    const cells = row.find("th, td");
    if (cells.length >= 2) pushDetail($(cells[0]).text(), $(cells[cells.length - 1]).text());
  });
  $("#detailBullets_feature_div li").each((_, el) => {
    const text = clean($(el).text());
    const parts = text.split(/[\u200e\u200f]?\s*:\s*[\u200e\u200f]?/);
    if (parts.length >= 2) pushDetail(parts[0], parts.slice(1).join(":"));
  });
  $("#productFactsDesktopExpander .product-facts-detail").each((_, el) => {
    const row = $(el);
    pushDetail(row.find(".a-col-left, .product-facts-title").first().text(), row.find(".a-col-right, .product-facts-value").last().text());
  });

  const detail = (pattern) => details.find((d) => pattern.test(d.label))?.value || null;
  const byline = clean($("#bylineInfo").text());
  const availabilityText = clean($("#availability").text()).slice(0, 300);
  const evidence = [title, ...bullets, ...details.map((d) => `${d.label}: ${d.value}`)].join("\n");
  // 德语成分写法：`100 % Baumwolle`（% 前带空格是德语惯例）、`Baumwolle`、`cotton`。
  const fibers = [
    ...new Set(
      [...evidence.matchAll(/\b\d+(?:[.,]\d+)?\s*%\s*(?:Baumwolle|Cotton|Polyester|Leinen|Viskose|Elasthan|Jute)\b/gi)].map((m) => clean(m[0])),
    ),
  ];

  return {
    asin,
    url: `https://${DOMAIN}/dp/${asin}`,
    fetched_url: url,
    title,
    title_chars: characterCount(title),
    bullets,
    bullet_count: bullets.length,
    bullet_chars: bullets.map((b) => characterCount(b)),
    description,
    description_chars: characterCount(description),
    brand: detail(/^marke$|^brand$/i) || /^Besuche den (.+?)[- ]?Store$/i.exec(byline)?.[1] || null,
    color: detail(/^farbe$|^colou?r$/i) || null,
    material_listed: detail(/^(material|materialzusammensetzung|stoffart|fabric type)$/i) || (fibers.length ? fibers.join(" / ") : null),
    cotton_disclosed: COTTON.test(evidence),
    dimensions_listed: detail(/gr[öo]ße|abmessung|maße|dimensions/i) || null,
    pack_listed: /\b(\d{1,3})\s*[- ]?(?:er[- ]?set|er[- ]?pack|st[üu]ck|pack)\b/i.exec(title)?.[1] || null,
    gsm_listed: /\b(\d+(?:[.,]\d+)?)\s*(?:g\s*\/\s*m[²2]|g\/m²|gsm)\b/i.exec(evidence)?.[1] || null,
    availability_text: availabilityText || null,
    details,
    details_rendered: details.length > 0,
    retrieved_at: new Date().toISOString(),
    http_status: meta.status ?? null,
    page_bytes: meta.bytes ?? null,
    ua_index: meta.uaIndex ?? null,
    discovery: meta.query ?? null,
  };
}

function runRules(listing) {
  // 每条的 `checks` 也要留下来：19 条规则里只有 6 条是本引擎能判的（其余要真实模型或人工），
  // 只报「命中 0/9」会被读成「9 条都合规」——那是假绿，正是这个项目一直在防的东西。
  const content = {
    title: String(listing.title || "").slice(0, 4000),
    item_highlights: "",
    bullet_points: (listing.bullets || []).slice(0, 20).map((text, i) => ({ id: `b${i + 1}`, text: String(text).slice(0, 9000) })),
    description: String(listing.description || "").slice(0, 60000),
  };
  const review = reviewContent({ content, profile: null, rulePack: PACK, marketplace: "DE" });
  return {
    rules: (review.issues || []).map((issue) => ({
      rule_id: issue.rule_id,
      field_path: issue.field_path,
      original: String(issue.original).slice(0, 300),
      severity: issue.severity,
    })),
    rule_states: Object.fromEntries((review.checks || []).map((check) => [check.rule_id, check.state])),
  };
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

function buildStats(items, fetched, skipped) {
  const titles = items.map((x) => x.title_chars);
  const ruleHits = new Map();
  for (const item of items) for (const id of new Set((item.rules || []).map((r) => r.rule_id))) ruleHits.set(id, (ruleHits.get(id) || 0) + 1);
  const cap = PACK.rules.find((r) => r.rule_id === "AMZ-01")?.constraint?.max_characters ?? null;
  return {
    sample_size: items.length,
    fetched,
    skipped: skipped.length,
    title_cap: cap,
    title_chars: {
      min: titles.length ? Math.min(...titles) : null,
      median: median(titles),
      max: titles.length ? Math.max(...titles) : null,
      over_cap: cap === null ? null : titles.filter((n) => n > cap).length,
    },
    bullet_count: {
      min: items.length ? Math.min(...items.map((x) => x.bullet_count)) : null,
      median: median(items.map((x) => x.bullet_count)),
      zero: items.filter((x) => x.bullet_count === 0).length,
    },
    missing: {
      material: items.filter((x) => !x.material_listed).length,
      dimensions: items.filter((x) => !x.dimensions_listed).length,
      color: items.filter((x) => !x.color).length,
      pack: items.filter((x) => !x.pack_listed).length,
      gsm: items.filter((x) => !x.gsm_listed).length,
    },
    engine: (() => {
      const checkable = PACK.rules.filter((rule) => IMPLEMENTED_RULE_IDS.has(rule.rule_id));
      // 只实现了确定性那一半的规则（目前只有 DE-TEXTIL-01 的成分合计/降序/纯纺）：
      // 它算在 `model_or_human_only` 里 —— 因为判不干净，不能对外说「本地可判」。
      const partial = PACK.rules.filter((rule) => PARTIALLY_IMPLEMENTED_RULE_IDS.has(rule.rule_id));
      const notCheckedPerRule = new Map();
      for (const item of items)
        for (const [ruleId, state] of Object.entries(item.rule_states || {}))
          if (state === "not_checked") notCheckedPerRule.set(ruleId, (notCheckedPerRule.get(ruleId) || 0) + 1);
      return {
        total: PACK.rules.length,
        checkable: checkable.length,
        model_or_human_only: PACK.rules.length - checkable.length,
        checkable_ids: checkable.map((rule) => rule.rule_id),
        partial_ids: partial.map((rule) => rule.rule_id),
        model_or_human_ids: PACK.rules.filter((rule) => !IMPLEMENTED_RULE_IDS.has(rule.rule_id)).map((rule) => rule.rule_id),
        // 「引擎扫过但这条没给出结论」的条数（not_checked）：用来区分「查了没问题」和「根本没查」。
        not_checked: Object.fromEntries(notCheckedPerRule),
      };
    })(),
    rule_hits: PACK.rules.map((rule) => ({
      rule_id: rule.rule_id,
      title: rule.title_zh,
      method: rule.method,
      checkable: IMPLEMENTED_RULE_IDS.has(rule.rule_id),
      partial: PARTIALLY_IMPLEMENTED_RULE_IDS.has(rule.rule_id),
      hits: ruleHits.get(rule.rule_id) || 0,
      rate: items.length ? +((ruleHits.get(rule.rule_id) || 0) / items.length).toFixed(2) : null,
    })),
  };
}

function renderMarkdown(corpus, stats, skipped) {
  const L = [];
  // 标题上的日期用**采集日**，不是渲染日：`--restat` 只是拿同一批快照重算规则，
  // 写成今天会让人以为昨天刚抓过一遍页面（上一版就是这么写的）。
  const day = String(corpus.collected_at || new Date().toISOString()).slice(0, 10);
  L.push(`# 德国站真实在售语料：棉质手提袋（${day}）`);
  L.push("");
  L.push("> 数字全部来自 amazon.de 商品详情页的原样读取；页面上没写的字段记「未知」，不推断、不补全。");
  L.push("> 这不是全站随机抽样：样本来自 amazon.de 搜索页前几屏，只代表这一批页面。");
  L.push("");
  L.push("## 这批是怎么来的");
  L.push("");
  L.push(`- 语料 **${stats.sample_size} 条**，累计 ${stats.fetched} 次请求，跳过 ${stats.skipped} 个页面。`);
  L.push(`- 发现路径：amazon.de 搜索页（${(corpus.searches || []).map((s) => `\`${s.query}\``).join("、")}）取 ASIN，再逐个打开商品页。`);
  L.push("- 未登录、未绕验证、未解验证码；每页间隔 3–5 秒。撞空壳页/英文变体换 UA 重试一次，仍失败记进 skipped。");
  L.push("- 每条带 `retrieved_at` / `http_status` / `page_bytes`，可逐条回原页面核对。");
  L.push("");
  L.push("## 规则命中（用本项目的德国规则包实跑，不是人工判断）");
  L.push("");
  L.push(`规则包 \`${corpus.pack_id}\` / ${corpus.rule_pack_version}，共 ${PACK.rules.length} 条。`);
  L.push("");
  L.push(
    `包的 ${stats.engine.total} 条规则里，**本引擎能自己判完的只有 ${stats.engine.checkable} 条**（${stats.engine.checkable_ids.join("、")}）；` +
      `另外 ${stats.engine.model_or_human_only} 条要真实模型或人工（${stats.engine.model_or_human_ids.join("、")}）` +
      (stats.engine.partial_ids?.length ? `，其中 ${stats.engine.partial_ids.join("、")} 只有确定性那一半在本地跑了` : "") +
      "。所以下面「0 命中」对第一类意味着「查了、没问题」，对其余两类只意味着「本地能查的那部分没犯」。",
  );
  for (const ruleId of stats.engine.partial_ids || []) {
    const scope = PARTIAL_SCOPE[ruleId];
    if (!scope)
      throw new Error(
        `${ruleId} 进了 PARTIALLY_IMPLEMENTED_RULE_IDS，但 PARTIAL_SCOPE 里没有它的描述 —— 别套用别的规则的说法，去 scripts/collect-de-listings.mjs 补一条`,
      );
    L.push(
      "",
      `其中 ${ruleId} 本地跑的是：${scope.done}；${scope.missing}仍然判不了，所以它照样列在「需模型/人工」里` +
        "——这条的命中与否都只覆盖上面那几项，不构成整条规则的结论。",
    );
  }
  L.push("");
  L.push("| 规则 | 名称 | 方法 | 引擎 | 命中 | 命中率 |");
  L.push("|---|---|---|---|---|---|");
  for (const row of stats.rule_hits)
    L.push(
      `| ${row.rule_id} | ${row.title} | ${row.method} | ${row.checkable ? "本地可判" : row.partial ? PARTIAL_SCOPE[row.rule_id]?.label || "部分本地判" : "需模型/人工"} | ${row.hits}/${stats.sample_size} | ${row.rate} |`,
    );
  L.push("");
  L.push("命中 ≠ 违规：`candidate_detection_and_contextual_review` 一类只说明「这段文字需要人工看一眼」，");
  L.push("`deterministic` 一类（标题长度、重复词、特殊字符）才是机器可以直接判定的。表里把方法列一起放着，");
  L.push("就是为了不让「提示」被读成「违规」。");
  L.push("");
  L.push(`## 标题长度（德国站上限 ${stats.title_cap} 字符，读自规则包）`);
  L.push("");
  L.push(
    `最小 ${stats.title_chars.min} / 中位 ${stats.title_chars.median} / 最大 ${stats.title_chars.max} 字符；` +
      `超过 ${stats.title_cap} 字符的有 **${stats.title_chars.over_cap}/${stats.sample_size}** 条。`,
  );
  L.push("");
  L.push("## 字段缺失（口径：标题 + 五点 + 描述 + 参数表里都找不到）");
  L.push("");
  L.push("| 字段 | 缺失 | 缺失率 |");
  L.push("|---|---|---|");
  const label = { material: "材质", dimensions: "尺寸", color: "颜色", pack: "包装数", gsm: "克重" };
  for (const [key, count] of Object.entries(stats.missing)) L.push(`| ${label[key]} | ${count} | ${(count / stats.sample_size).toFixed(2)} |`);
  L.push("");
  L.push("## 逐条记录");
  L.push("");
  L.push("| # | ASIN | 标题字符 | 五点 | 材质写法 | 命中规则 |");
  L.push("|---|---|---|---|---|---|");
  corpus.items.forEach((item, i) => {
    const rules = [...new Set((item.rules || []).map((r) => r.rule_id))].join(" ") || "—";
    L.push(`| ${i + 1} | [${item.asin}](${item.url}) | ${item.title_chars} | ${item.bullet_count} | ${item.material_listed || "—"} | ${rules} |`);
  });
  L.push("");
  if (skipped.length) {
    L.push("## 抓不到 / 被跳过的页面");
    L.push("");
    L.push("| ASIN | 原因 | HTTP | 字节 |");
    L.push("|---|---|---|---|");
    for (const row of skipped) L.push(`| ${row.asin} | ${row.reason} | ${row.status ?? "—"} | ${row.bytes ?? "—"} |`);
    L.push("");
  }
  L.push("## 这份语料不能证明什么");
  L.push("");
  L.push("- 不能证明「德国站卖家普遍违规」：样本来自搜索页前几屏，同类高价/推广位商品会被放大。");
  L.push("- 不能证明 GPSR 四要素缺失：四要素大多落在**页面上的卖家信息区 / 产品标识区**，本采集器只读主商品区文本。");
  L.push("- 不能替代生成验收：这里跑的是规则引擎对**别人写的文案**的召回，不是本产品生成德语的能力（那是 C2 真模型那次）。");
  return L.join("\n");
}

async function main() {
  let corpus;
  if (RESTAT) {
    corpus = JSON.parse(await readFile(OUT, "utf8"));
    // 重算时顺手把规则结论也重跑一遍：引擎改了以后不用再打一次 Amazon 就能更新命中表。
    for (const item of corpus.items) Object.assign(item, runRules(item));
  } else {
    const items = [];
    const skipped = [];
    const seenTitles = new Set();
    const searches = [];
    const queue = [];
    let fetches = 0;

    // 取样框有两种来源：
    //   a) 现抓搜索页（`/s?k=`）——注意 amazon.de 会时不时光出 `bm-verify` 人机校验页（实测 1.4 KB），
    //      这时 discover 会失败，脚本会整批拿不到 ASIN，所以必须支持 b。
    //   b) 已经存下来的 ASIN 清单（`data-research/de-search-asins-*.json`）——清单来自一次真实搜索页读取，
    //      存下来是为了**取样框可复现**：过几天再抓，前几屏的商品就变了。
    const seedsFile = args.get("seeds-file");
    if (seedsFile) {
      const saved = JSON.parse(await readFile(resolve(DEV, seedsFile), "utf8"));
      searches.push({
        query: saved.query,
        ok: true,
        source: "saved_search_page",
        file: seedsFile,
        captured_at: saved.captured_at,
        bytes: saved.page_bytes ?? null,
        asins: (saved.asins || []).length,
        reason: null,
      });
      for (const asin of saved.asins || []) queue.push({ asin, query: saved.query });
    } else {
      for (const query of QUERIES) {
        const result = await discover(query);
        fetches += 1;
        searches.push({ query, ok: result.ok, status: result.status ?? null, bytes: result.bytes ?? null, asins: result.asins.length, reason: result.reason ?? null });
        for (const asin of result.asins) queue.push({ asin, query });
        await sleep(3000 + Math.random() * 2000);
        if (queue.length >= TARGET * 4) break;
      }
    }

    const visited = new Set();
    while (queue.length && fetches < MAX_FETCH && items.length < TARGET) {
      const { asin, query } = queue.shift();
      if (visited.has(asin)) continue;
      visited.add(asin);
      const page = await fetchProduct(asin);
      fetches += 1;
      if (!page.ok) {
        skipped.push({ asin, reason: page.reason, status: page.status, bytes: page.bytes });
      } else {
        const listing = parseListing(page.html, asin, page.url, { status: page.status, bytes: page.bytes, uaIndex: page.uaIndex, query });
        if (!listing) skipped.push({ asin, reason: "页面无 #productTitle", status: page.status, bytes: page.bytes });
        else {
          const reject = eligibilityReject(listing, seenTitles);
          if (reject) skipped.push({ asin, reason: reject, status: page.status, bytes: page.bytes, title: listing.title.slice(0, 120) });
          else {
            seenTitles.add(titleKey(listing.title));
            Object.assign(listing, runRules(listing));
            items.push(listing);
          }
        }
      }
      await sleep(3000 + Math.random() * 2000);
    }

    corpus = {
      notice:
        "真实 amazon.de 商品详情页的直接读取结果。字段只取页面实际写出的内容，取不到即 null，不含推断值。样本来自搜索页前几屏，非全站随机抽样。",
      collected_at: new Date().toISOString(),
      marketplace: "DE",
      searches,
      pack_id: PACK.pack_id,
      rule_pack_version: PACK.rule_pack_version,
      items,
      skipped,
      fetched: fetches,
    };
  }

  const stats = buildStats(corpus.items, corpus.fetched ?? 0, corpus.skipped || []);
  corpus.stats = stats;
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(corpus, null, 2), "utf8");
  const mdPath = OUT.replace(/\.json$/, ".md");
  await writeFile(mdPath, renderMarkdown(corpus, stats, corpus.skipped || []), "utf8");
  console.log(
    JSON.stringify(
      {
        ok: true,
        out: OUT,
        md: mdPath,
        corpus: stats.sample_size,
        fetched: stats.fetched,
        skipped: stats.skipped,
        overCap: stats.title_chars.over_cap,
        searches: (corpus.searches || []).map((s) => ({ q: s.query, ok: s.ok, n: s.asins })),
      },
      null,
      2,
    ),
  );
}

await main();
