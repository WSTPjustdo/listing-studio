#!/usr/bin/env node
/**
 * 真实 Listing 采集器（第 19 轮 · 方向 F 数据与素材）
 *
 * 做什么：从真实 Amazon 商品详情页抽标题、五点、描述、参数表，用**项目自己的规则引擎**
 * （`server/domain.mjs` 的 `reviewContent` + `amazon-focus/rules.json`）跑一遍，
 * 得出「15 条规则在真实样本里命中多少」。
 *
 * 为什么要有第二个采集器（`qa/research/listings-20261027.json` 已经有 20 条）：
 *   20 条上算出来的命中率，标准误太大（US-01 命中 10/20，95% 区间约 27%–73%）。
 *   本轮目标是扩到 45+ 条，让「标题超限率」「环保词出现率」这类数字能站得住。
 *
 * 边界（很重要，和 10/27 那次一致）：
 * - 只读公开商品页，不登录、不绕验证、不解验证码。**撞到验证页就换 UA 重试一次，再不行就记下来放弃。**
 * - 抓不到的字段写 null，报告里写「未知」。**一个数字都不许编。**
 * - 每页间隔 2.5–4 秒；目标 45 条，最多发 70 次请求。
 *
 * 用法：
 *   node scripts/collect-listings.mjs --target 45 --out ../qa/research/listings-20261030.json
 *   node scripts/collect-listings.mjs --target 3 --max-fetch 6 --seeds B014XXJQ1I   # 冒烟
 *   node scripts/collect-listings.mjs --restat --out ../qa/research/listings-20261030.json   # 不请求，只重算
 *
 * 产物：
 *   <out>.json  逐条可核（含 http_status / page_bytes / retrieved_at / 用了哪条 UA）
 *   <out>.md    统计报告
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";
import { reviewContent, characterCount, ECO_CLAIM_PATTERN } from "../server/domain.mjs";
import { rulePack } from "../server/store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV = resolve(HERE, "..");

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (!token.startsWith("--")) continue;
  const next = process.argv[i + 1];
  args.set(token.slice(2), next && !next.startsWith("--") ? next : "1");
}
const TARGET = Number(args.get("target") || 45);
const MAX_FETCH = Number(args.get("max-fetch") || 70);
const OUT = resolve(DEV, args.get("out") || "../qa/research/listings-20261030.json");

// 10/27 那次用的 Chrome UA，10/30 复测时首页直接返回验证页（3,781 字节）。
// 实测：换 UA + 带 `?language=en_US` 能拿到 1.7 MB 的正常页面。所以这里轮换三条 UA，
// 撞验证页就换下一条重试一次；仍然失败才算「这个 ASIN 抓不到」，如实记进 skipped。
const UA_POOL = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];
const headersFor = (index) => ({
  "user-agent": UA_POOL[index % UA_POOL.length],
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
});

// 种子 = 10/27 那批 20 条里的 ASIN。从它们出发沿推荐位扩散，
// 这样新收的样本与旧样本同源（同一类目、同一扩散方式），可以直接合并统计。
const SEEDS = (
  args.get("seeds") ||
  "B014XXJQ1I,B0F7HF7KDZ,B07Q3B7SG8,B0G2M1C99Z,B0919143LR,B0DX7C3T18,B085CC9FDL,B083DHKJS5"
)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const titleKey = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const CAPTCHA = /Enter the characters you see below|api-services-support@amazon\.com|Robot Check/i;

// 明确不属于「棉质手提袋」的品类：混进来会把统计拉偏，且规则包也不覆盖。
const NON_COTTON = /\b(jute|burlap|thermal|insulated|cooler|non[-\s]?woven|polyester|nylon|leather|paper)\b/i;

/** 入选条件，返回 null 表示收下，返回字符串表示跳过原因。 */
function eligibilityReject(listing, seenTitleSet) {
  if (!/\b(tote|shopping bag|canvas bag|reusable bag|grocery bag)\b/i.test(listing.title)) return "类目不符";
  if (NON_COTTON.test(listing.title)) return "材质不符（非棉）";
  if (!listing.cotton_disclosed) return "未见棉成分披露";
  if (!listing.bullets.length) return "无可审文本（无五点）";
  if (seenTitleSet.has(titleKey(listing.title))) return "同款重复";
  return null;
}

/**
 * 取一页。撞验证页时换下一条 UA 重试；两次都撞就放弃并记录。
 * 返回里带 http_status 与 page_bytes —— 「抓到了」这件事本身也要可核。
 */
async function fetchPage(asin, uaIndex = 0, attempt = 1) {
  const url = `https://www.amazon.com/dp/${asin}?language=en_US`;
  try {
    const res = await fetch(url, {
      headers: headersFor(uaIndex),
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, status: res.status, bytes: 0, uaIndex };
    const html = await res.text();
    if (CAPTCHA.test(html.slice(0, 4000))) {
      if (attempt < 2) {
        await sleep(3000);
        return fetchPage(asin, uaIndex + 1, attempt + 1);
      }
      return { ok: false, reason: "验证页（两种 UA 都撞到）", status: res.status, bytes: html.length, uaIndex };
    }
    if (html.length < 20000) {
      return { ok: false, reason: `页面过短（${html.length} 字节，疑似降级页）`, status: res.status, bytes: html.length, uaIndex };
    }
    return { ok: true, html, url, status: res.status, bytes: html.length, uaIndex };
  } catch (error) {
    if (attempt < 2 && /timeout|ECONN|fetch failed/i.test(String(error.message))) {
      await sleep(4000);
      return fetchPage(asin, uaIndex + 1, attempt + 1);
    }
    return { ok: false, reason: `网络错误：${error.name}`, status: 0, bytes: 0, uaIndex };
  }
}

/**
 * 包装数的第二个落点：2026 年 page 的参数表里 `Number of Packs` / `Number of Items` / `Unit Count`。
 * 10/30 实测：25 条新样本里 21 条参数表有这几个字段，但 `pack_listed` 是空的——
 * 于是「缺包装数 71%」会被算成卖家的行为，其实是解析器只看了标题和正文。
 * 这一栏单独存、单独标出处，不和从标题推出来的那个数混在一起（4-pack of 2 ≠ 4 件）。
 */
function packFromDetails(details) {
  const order = [/^number of packs$/i, /^number of items$/i, /^unit count$/i, /^item package quantity$/i];
  for (const pattern of order) {
    const hit = (details || []).find((d) => pattern.test(d.label));
    const value = hit ? /(\d{1,4})/.exec(hit.value)?.[1] : null;
    if (value) return { value: Number(value), label: hit.label, raw: hit.value };
  }
  return null;
}

/** 从一页 HTML 抽出研究需要的字段；抽不到的一律 null。 */
function parseListing(html, asin, url, meta = {}) {
  const $ = load(html);
  $("script,style,noscript,iframe").remove();
  const title = clean($("#productTitle").first().text());
  if (!title) return null;

  // 两种页面版式都要覆盖：
  //   旧版 / A-B 测试的一半 → #feature-bullets
  //   2026 年的 product-facts 版式 → 五点被塞进 #productFactsDesktopExpander 的无序列表里
  let bullets = [...$("#feature-bullets li .a-list-item, #feature-bullets li span.a-list-item")]
    .map((el) => clean($(el).text()))
    .filter((text) => text && !/see more product details/i.test(text));
  if (!bullets.length)
    bullets = [...$("#productFactsDesktopExpander ul.a-unordered-list > li")]
      .map((el) => clean($(el).text()))
      .filter((text) => text && !/see more product details/i.test(text));
  bullets = [...new Set(bullets)];

  const description = clean(
    $("#productDescription").text() || $("#bookDescription_feature_div").text() || "",
  ).slice(0, 6000);

  const details = [];
  const pushDetail = (label, value) => {
    const l = clean(label).replace(/[‏‎\s]+$/g, "").trim();
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
    const parts = text.split(/[‏‎]?\s*:\s*[‏‎]?/);
    if (parts.length >= 2) pushDetail(parts[0], parts.slice(1).join(":"));
  });
  $("#productFactsDesktopExpander .product-facts-detail").each((_, el) => {
    const row = $(el);
    pushDetail(row.find(".a-col-left, .product-facts-title").first().text(), row.find(".a-col-right, .product-facts-value").last().text());
  });

  const detail = (pattern) => details.find((d) => pattern.test(d.label))?.value || null;
  const byline = clean($("#bylineInfo").text());
  const availabilityText = clean($("#availability").text()).slice(0, 300);
  const twisterColor =
    /"dimensionValueState":"SELECTED","dimensionValueDisplayText":"([^"]{1,60})"/.exec(html)?.[1] || null;

  const evidence = [title, ...bullets, ...details.map((d) => `${d.label}: ${d.value}`)].join("\n");
  const materials = [...new Set([...evidence.matchAll(/\b\d+(?:\.\d+)?\s*%\s*(?:natural\s+)?cotton\b/gi)].map((m) => clean(m[0]).toLowerCase()))];

  return {
    asin,
    url: `https://www.amazon.com/dp/${asin}`,
    fetch_url: url,
    title,
    title_chars: characterCount(title),
    bullets,
    bullet_count: bullets.length,
    bullet_chars: bullets.map((b) => characterCount(b)),
    description,
    description_chars: characterCount(description),
    brand: detail(/^brand$/i) || /^Brand:\s*(.+)$/i.exec(byline)?.[1] || /^Visit the (.+) Store$/i.exec(byline)?.[1] || null,
    color: detail(/^colou?r$/i) || clean($("#variation_color_name .selection").first().text()) || twisterColor || null,
    material_listed: detail(/^(fabric type|material composition|material)$/i) || (materials.length ? materials.join(" / ") : null),
    material_conflict: materials.length > 1,
    cotton_disclosed: /\bcotton\b/i.test(evidence),
    dimensions_listed:
      detail(/dimensions|^size$|product dimensions/i) ||
      /\bDimensions?:\s*([\d.]+\s*[x×]\s*[\d.]+(?:\s*[x×]\s*[\d.]+)?\s*(?:inches|inch|cm))/i.exec(evidence)?.[1] ||
      null,
    pack_listed: /\b(\d{1,3})\s*[- ]?pack\b/i.exec(title)?.[1] || /\b(\d{1,3})\s*(?:bags|pieces)\s+per\s+pack/i.exec(evidence)?.[1] || null,
    pack_details: packFromDetails(details),
    gsm_listed: /\b(\d+(?:\.\d+)?)\s*(?:g\s*\/\s*m[²2]|gsm)\b/i.exec(evidence)?.[1] || null,
    oz_listed: /\b(\d+(?:\.\d+)?)\s*oz\b/i.exec(evidence)?.[1] || null,
    availability_text: availabilityText || null,
    details,
    details_rendered: details.length > 0,
    retrieved_at: new Date().toISOString(),
    http_status: meta.status ?? null,
    page_bytes: meta.bytes ?? null,
    ua_index: meta.uaIndex ?? null,
    discovery: null,
  };
}

/** 用项目自己的规则引擎跑一遍，返回命中的 rule_id 与原文。 */
function runRules(listing) {
  const content = {
    title: String(listing.title || "").slice(0, 4000),
    item_highlights: "",
    bullet_points: (listing.bullets || []).slice(0, 20).map((text, i) => ({ id: `b${i + 1}`, text: String(text).slice(0, 9000) })),
    description: String(listing.description || "").slice(0, 60000),
  };
  const review = reviewContent({ content, profile: null, rulePack });
  return (review.issues || []).map((issue) => ({
    rule_id: issue.rule_id,
    field_path: issue.field_path,
    original: String(issue.original).slice(0, 300),
    severity: issue.severity,
  }));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function loadCorpus() {
  try {
    const parsed = JSON.parse(await readFile(OUT, "utf8"));
    if (!Array.isArray(parsed.items)) throw new Error("语料文件里没有 items");
    // 老条目没有 pack_details（那一栏是 10/30 加的）。details 原文还在，就地补算，
    // 不用再去请求一次 Amazon——这既是省事，也是"别再打人家站点"。
    for (const item of parsed.items) if (item.pack_details === undefined) item.pack_details = packFromDetails(item.details);
    return parsed;
  } catch {
    // 没有就新建；但旧那 20 条必须进来，否则「扩样本」变成「换样本」。
    const legacy = JSON.parse(await readFile(resolve(DEV, "../qa/research/listings-20261027.json"), "utf8"));
    for (const item of legacy.items) {
      if (!item.retrieved_at) item.retrieved_at = legacy.collected_at;
      if (item.http_status === undefined) item.http_status = null;
      if (item.page_bytes === undefined) item.page_bytes = null;
    }
    return {
      notice: "真实 Amazon 商品详情页的直接读取结果。字段只取页面上实际写出的内容，取不到即 null。不包含推断值。",
      collected_at: legacy.collected_at,
      query: legacy.query,
      items: legacy.items,
      skipped: legacy.skipped || [],
      fetched: legacy.fetched || 20,
      sources: [
        { file: "qa/research/listings-20261027.json", items: legacy.items.length, collected_at: legacy.collected_at },
      ],
    };
  }
}
function buildStats(items, fetched, skipped, searchPageBlocked) {
  const titles = items.map((x) => x.title_chars).filter((n) => typeof n === "number");
  const ruleHits = new Map();
  for (const item of items)
    for (const id of new Set((item.rules || []).map((r) => r.rule_id))) ruleHits.set(id, (ruleHits.get(id) || 0) + 1);

  const FIELD_LABELS = {
    material_listed: "材质",
    dimensions_listed: "尺寸",
    color: "颜色",
    pack_listed: "包装数（只看标题/正文，旧口径）",
    pack_any: "包装数（标题/正文 + 参数表，新口径）",
    fabric_weight: "克重",
  };
  const missing = {
    material_listed: items.filter((x) => !x.material_listed).length,
    dimensions_listed: items.filter((x) => !x.dimensions_listed).length,
    color: items.filter((x) => !x.color).length,
    // 包装数分两栏：只在标题/正文里写的，和只在参数表里写的。
    // 合并成一个「缺失率」会把「解析器没看参数表」说成「卖家没写」。
    pack_listed: items.filter((x) => !x.pack_listed).length,
    pack_any: items.filter((x) => !x.pack_listed && !x.pack_details).length,
    fabric_weight: items.filter((x) => !x.gsm_listed && !x.oz_listed).length,
  };
  const packLanes = {
    title_or_bullet: items.filter((x) => x.pack_listed).length,
    details_only: items.filter((x) => !x.pack_listed && x.pack_details).length,
    none: items.filter((x) => !x.pack_listed && !x.pack_details).length,
  };

  // 环保词汇分两族：US-01 现在能召回的，和同一句里出现了却召不回的。
  // 用产品自己的召回词表判断「有没有写环保词」，别在这里再抄一份。
  const RECALLED = ECO_CLAIM_PATTERN;
  const WIDER = new RegExp(ECO_CLAIM_PATTERN.source, "gi");
  const widerOnly = [];
  for (const item of items) {
    const text = [item.title, ...(item.bullets || []), item.description || "", ...(item.details || []).map((d) => `${d.label}: ${d.value}`)].join("\n");
    const words = [...new Set([...text.matchAll(WIDER)].map((m) => m[0].toLowerCase()))];
    item.eco_words = words;
    item.has_eco_claim = RECALLED.test(text) || words.length > 0;
    if (!RECALLED.test(text) && words.length) widerOnly.push({ asin: item.asin, words });
  }

  const buckets = { "≤75": 0, "76-125": 0, "126-200": 0, "201-300": 0, ">300": 0 };
  for (const n of titles) {
    if (n <= 75) buckets["≤75"]++;
    else if (n <= 125) buckets["76-125"]++;
    else if (n <= 200) buckets["126-200"]++;
    else if (n <= 300) buckets["201-300"]++;
    else buckets[">300"]++;
  }

  return {
    sample_size: items.length,
    fetched,
    skipped: skipped.length,
    search_page: searchPageBlocked || "可用",
    details_rendered: items.filter((x) => x.details_rendered).length,
    title_chars: {
      min: titles.length ? Math.min(...titles) : null,
      median: median(titles),
      max: titles.length ? Math.max(...titles) : null,
      over_75: titles.filter((n) => n > 75).length,
      over_200: titles.filter((n) => n > 200).length,
      buckets,
    },
    bullet_count: {
      min: items.length ? Math.min(...items.map((x) => x.bullet_count)) : null,
      median: median(items.map((x) => x.bullet_count)),
      max: items.length ? Math.max(...items.map((x) => x.bullet_count)) : null,
      zero: items.filter((x) => x.bullet_count === 0).length,
    },
    eco_claim: {
      any: items.filter((x) => x.has_eco_claim).length,
      rule_us01_hit: ruleHits.get("US-01") || 0,
      wider_only: widerOnly,
    },
    pack_lanes: packLanes,
    missing_fields: Object.entries(missing)
      .sort((a, b) => b[1] - a[1])
      .map(([field, count]) => ({
        field,
        label: FIELD_LABELS[field] || field,
        missing: count,
        rate: items.length ? +(count / items.length).toFixed(2) : null,
      })),
    rule_hits: rulePack.rules.map((rule) => ({
      rule_id: rule.rule_id,
      title: rule.title_zh,
      hits: ruleHits.get(rule.rule_id) || 0,
      rate: items.length ? +((ruleHits.get(rule.rule_id) || 0) / items.length).toFixed(2) : null,
    })),
  };
}

function renderMarkdown(items, stats, skipped, searchPageBlocked) {
  const lines = [];
  const day = new Date().toISOString().slice(0, 10);
  lines.push(`# 真实 Listing 语料：cotton tote bag（${day}）`);
  lines.push("");
  lines.push("> 全部数字来自 Amazon 商品详情页的原样读取。页面上没有写的字段一律记「未知」，不做推断、不做补全。");
  lines.push("");
  lines.push("## 这批是怎么来的");
  lines.push("");
  lines.push(`- 语料共 **${stats.sample_size} 条**，累计发起 ${stats.fetched} 次请求，累计跳过 ${stats.skipped} 个页面。`);
  lines.push(`- 搜索页：${searchPageBlocked ? `**不可用** —— ${searchPageBlocked}；改用种子商品的推荐位扩散发现 ASIN。` : "可用（本次未依赖）。"}`);
  lines.push("- 未登录、未绕验证、未解验证码；每页间隔 2.5–4 秒。撞验证页换 UA 重试一次，仍失败记进 skipped。");
  lines.push("- 每条都带 `retrieved_at` / `http_status` / `page_bytes`，可以逐条回到原页面核对。");
  lines.push("");
  lines.push("## 逐条记录");
  lines.push("");
  lines.push("| # | ASIN | 标题字符 | 五点条数 | 环保宣称 | 命中的规则 | 缺参数 |");
  lines.push("|---|---|---|---|---|---|---|");
  items.forEach((item, index) => {
    const miss = [
      item.material_listed ? null : "材质",
      item.dimensions_listed ? null : "尺寸",
      item.color ? null : "颜色",
      item.pack_listed || item.pack_details ? null : "包装数",
      item.gsm_listed || item.oz_listed ? null : "克重",
    ].filter(Boolean);
    const rules = [...new Set((item.rules || []).map((r) => r.rule_id))].join(" ") || "—";
    lines.push(
      `| ${index + 1} | [${item.asin}](${item.url}) | ${item.title_chars} | ${item.bullet_count} | ${item.has_eco_claim ? "有" : "无"} | ${rules} | ${miss.join("、") || "无"} |`,
    );
  });
  lines.push("");
  lines.push("## 统计");
  lines.push("");
  lines.push("### 标题长度");
  lines.push("");
  lines.push(
    `最小 ${stats.title_chars.min} / 中位 ${stats.title_chars.median} / 最大 ${stats.title_chars.max} 字符。` +
      `超过平台上限 75 字符的有 **${stats.title_chars.over_75}/${stats.sample_size}** 条，超过 200 字符的有 ${stats.title_chars.over_200} 条。`,
  );
  lines.push("");
  lines.push("| 区间 | 条数 |");
  lines.push("|---|---|");
  for (const [bucket, count] of Object.entries(stats.title_chars.buckets)) lines.push(`| ${bucket} | ${count} |`);
  lines.push("");
  lines.push("### 五点");
  lines.push("");
  lines.push(
    `条数 最少 ${stats.bullet_count.min} / 中位 ${stats.bullet_count.median} / 最多 ${stats.bullet_count.max}；完全没有五点的有 ${stats.bullet_count.zero} 条。`,
  );
  lines.push("");
  lines.push("### 环保宣称");
  lines.push("");
  lines.push(
    `任意环保类词汇出现 **${stats.eco_claim.any}/${stats.sample_size}** 条；其中被宽泛环保召回规则（US-01）命中的 ${stats.eco_claim.rule_us01_hit} 条。`,
  );
  if (stats.eco_claim.wider_only.length) {
    lines.push("");
    lines.push(`**US-01 没召回但确实写了环保词的还有 ${stats.eco_claim.wider_only.length} 条**（证据如下，原样摘录关键词）：`);
    lines.push("");
    lines.push("| ASIN | 出现的环保词 |");
    lines.push("|---|---|");
    for (const row of stats.eco_claim.wider_only) lines.push(`| ${row.asin} | ${row.words.join("、")} |`);
  }
  lines.push("");
  lines.push("### 最常见的缺失参数");
  lines.push("");
  lines.push(
    `口径：在**页面可读文本**（标题 + 五点 + 描述 + 参数表）里找不到，就算「没写」。` +
      (stats.details_rendered === stats.sample_size
        ? `这 ${stats.sample_size} 条的参数表全部读到了，所以下面接近真实缺失率。`
        : `这 ${stats.sample_size} 条里有 ${stats.details_rendered} 条读到了参数表，其余页面的参数表由前端异步加载、直连拿不到，所以下面是缺失率的**上界**，不是精确值。`),
  );
  lines.push("");
  lines.push("| 字段 | 缺失条数 | 缺失率 |");
  lines.push("|---|---|---|");
  for (const row of stats.missing_fields) lines.push(`| ${row.label} | ${row.missing} | ${row.rate} |`);
  lines.push("");
  if (stats.pack_lanes) {
    lines.push("**包装数为什么要分两栏**：这个数有两个落点——标题/正文里的 `4-pack`，和参数表里的");
    lines.push("`Number of Packs` / `Number of Items` / `Unit Count`。10/30 复采时发现，只看前一个落点会把");
    lines.push("「解析器没读参数表」算成「卖家没写」。两栏都算出来：");
    lines.push("");
    lines.push(`- 标题/正文里写了：${stats.pack_lanes.title_or_bullet} 条`);
    lines.push(`- 只有参数表写了（旧口径会把它们记成缺失）：${stats.pack_lanes.details_only} 条`);
    lines.push(`- 两处都没有：${stats.pack_lanes.none} 条`);
    lines.push("");
    lines.push("两个数不能互相冒充：`Number of Items` 是件数，不等于包装数（4-pack of 2 件 ≠ 4 件），所以 `pack_details` 单独存、单独标 `label`。");
    lines.push("");
  }
  lines.push("");
  lines.push(`### ${stats.rule_hits.length} 条规则在这批样本里的命中`);
  lines.push("");
  lines.push("| 规则 | 名称 | 命中 | 命中率 |");
  lines.push("|---|---|---|---|");
  for (const row of stats.rule_hits) lines.push(`| ${row.rule_id} | ${row.title} | ${row.hits} | ${row.rate} |`);
  lines.push("");
  lines.push("## 局限（必须跟着结论一起读）");
  lines.push("");
  lines.push("- 采样方式不是随机抽样：ASIN 来自种子商品的推荐位扩散，偏向「同类竞品」，不代表 Amazon 全站分布。");
  lines.push("- 快照不是实时库存；页面参数是卖家披露，不是独立检测证据。");
  lines.push("- 搜索页不可用时没有「按销量/评价数分层」，所以无法给出「头部卖家 vs 长尾」的对比。");
  lines.push("- 同一条 ASIN 的不同变体页可能被当成两条；标题去重只能挡住完全同标题的情况。");
  if (skipped.length) {
    lines.push("");
    lines.push("### 跳过的页面（透明记录）");
    lines.push("");
    for (const item of skipped) lines.push(`- \`${item.asin}\`：${item.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

function discoverAsins(html, seen) {
  const found = [];
  const push = (asin) => {
    if (!asin || seen.has(asin)) return;
    seen.add(asin);
    found.push({ asin });
  };
  const $ = load(html);
  $("div[data-asin]").each((_, el) => {
    const asin = $(el).attr("data-asin");
    if (/^[A-Z0-9]{10}$/.test(asin || "")) push(asin);
  });
  for (const match of html.matchAll(/\/dp\/([A-Z0-9]{10})/g)) push(match[1]);
  return found;
}

async function main() {
  const corpus = await loadCorpus();
  const items = corpus.items;
  const skipped = corpus.skipped || [];
  let fetched = corpus.fetched || 0;

  if (!args.has("restat")) {
    const startCount = items.length;
    const seen = new Set([...items.map((x) => x.asin), ...SEEDS]);
    const seenTitle = new Set(items.map((x) => titleKey(x.title)));
    const queue = SEEDS.map((asin) => ({ asin, discovery: "种子（10/27 那批的 ASIN）" }));
    let searchPageBlocked = null;
    let roundFetched = 0;

    try {
      const search = await fetch("https://www.amazon.com/s?k=cotton+tote+bag&language=en_US", {
        headers: headersFor(0),
        signal: AbortSignal.timeout(20000),
      });
      const text = await search.text().catch(() => "");
      searchPageBlocked = !/data-asin=/i.test(text) ? `搜索页不可用（HTTP ${search.status}，返回 ${text.length} 字节）` : null;
    } catch (error) {
      searchPageBlocked = `搜索页不可用（${error.name}）`;
    }
    corpus.search_page = searchPageBlocked;
    await sleep(1500);

    while (queue.length && roundFetched < MAX_FETCH && items.length < TARGET) {
      const next = queue.shift();
      roundFetched += 1;
      fetched += 1;
      process.stderr.write(`[${items.length}/${TARGET}] ${next.asin} … `);
      const page = await fetchPage(next.asin);
      if (!page.ok) {
        skipped.push({ asin: next.asin, reason: page.reason, at: new Date().toISOString() });
        process.stderr.write(`跳过（${page.reason}）\n`);
        await sleep(2000 + Math.random() * 1500);
        continue;
      }
      const listing = parseListing(page.html, next.asin, page.url, page);
      if (!listing) {
        skipped.push({ asin: next.asin, reason: "页面无 productTitle", at: new Date().toISOString() });
        process.stderr.write("跳过（无标题）\n");
        await sleep(2000 + Math.random() * 1500);
        continue;
      }
      const reject = eligibilityReject(listing, seenTitle);
      if (reject) {
        skipped.push({ asin: next.asin, reason: `${reject}：${listing.title.slice(0, 60)}`, at: new Date().toISOString() });
        process.stderr.write(`跳过（${reject}）\n`);
        for (const found of discoverAsins(page.html, seen)) queue.push({ ...found, discovery: `推荐位（来自 ${next.asin}）` });
        await sleep(2000 + Math.random() * 1500);
        continue;
      }
      seenTitle.add(titleKey(listing.title));
      listing.discovery = next.discovery;
      items.push(listing);
      process.stderr.write(`${listing.title_chars} 字符，${listing.bullet_count} 条要点（${page.bytes} 字节）\n`);

      for (const found of discoverAsins(page.html, seen)) queue.push({ ...found, discovery: `推荐位（来自 ${next.asin}）` });

      await sleep(2500 + Math.random() * 1500);
    }
    process.stderr.write(`\n本轮新增 ${items.length - startCount} 条；队列剩余 ${queue.length}\n`);
  }

  // 规则命中每次重算：内容没变，规则改了命中就变了。
  for (const item of items) item.rules = runRules(item);
  const stats = buildStats(items, fetched, skipped, corpus.search_page || null);
  await mkdir(dirname(OUT), { recursive: true });
  const payload = {
    notice: corpus.notice,
    collected_at: corpus.collected_at,
    extended_at: new Date().toISOString(),
    query: "cotton tote bag",
    method:
      "详情页直连（fetch，未登录）。搜索页不可用时，ASIN 由种子商品详情页的推荐位扩散发现。未绕验证、未解验证码。" +
      "第 19 轮起每条带 http_status / page_bytes / retrieved_at，可逐条回原页核对。",
    search_page: corpus.search_page || null,
    target: TARGET,
    fetched,
    items,
    skipped,
    stats,
    sources: corpus.sources || [],
  };
  const mdPath = OUT.replace(/\.json$/, ".md");
  await writeFile(OUT, JSON.stringify(payload, null, 2), "utf8");
  await writeFile(mdPath, renderMarkdown(items, stats, skipped, corpus.search_page || null), "utf8");
  process.stderr.write(`\n写入 ${OUT}\n写入 ${mdPath}\n`);
  console.log(
    JSON.stringify(
      { ok: true, corpus: items.length, fetched, skipped: skipped.length, over75: stats.title_chars.over_75, ecoAny: stats.eco_claim.any, us01: stats.eco_claim.rule_us01_hit },
      null,
      2,
    ),
  );
}

await main();
