#!/usr/bin/env node
/**
 * 量「官方点名的宣称类型，我们自己的引擎召回几个」。
 *
 * 与 `prohibited-scan.mjs` 的分工（别混）：
 *   · `prohibited-scan.mjs` 用**我自己写的正则**量真实在售文案里这类词有多常见 → 它的数字不能当产品能力；
 *   · 本脚本把官方句子**喂进 `reviewContent()`**，量的是**引擎本身** → 它的数字就是产品对外能说的那种。
 *   第 5 轮吃过一次亏：用自己写的正则夸自己覆盖率高。这里只认引擎吐出来的 `rule_id`。
 *
 * 四栏，口径不同，别加在一起：
 *   第一栏 16 CFR 260 的 14 个宣称条款（16 句）——判据分 must / optional / out_of_scope 三档，
 *     `out_of_scope` 是不该补的（袋类商品不会出现），算进分母会把成绩压低，算成漏报又会让下一轮去凑数。
 *   第二栏 Amazon Detail Page 公告的 6 类禁用项（9 句）——依据不同（平台政策，不是 FTC）。
 *   第三栏 医疗、健康与抗菌宣称（`US-04`，35 句）——依据 `FTCS-AD-SUBSTANTIATION`，
 *     判据分 must / other 两档：`other` 是"看着像、其实不归这条管"的写法（气味事实、舒适度、防静电），
 *     它们**命中反而算误报**，所以要单独一档，不能并进 must 的分母里。
 *   第四栏 20 条真实在售文案跑一遍引擎——看误报会不会因为新规则涨，以及证据能不能落到那一句。
 *
 * 量具自证（每次跑都做，不是开关）：先喂一条**一定该命中**的句子（`a@b.com` / `$19.99`），
 * 再喂一条**一定不该命中**的干净句。两条都过，后面的 0 才是"路上没有"，不是"引擎没跑"。
 *
 * 用法：
 *   node scripts/claim-recall-probe.mjs                # 三栏摘要 + 自证
 *   node scripts/claim-recall-probe.mjs --list         # 连每句命中了哪条规则一起印
 *   node scripts/claim-recall-probe.mjs --candidates   # 落规则之前的候选词在真实样本上的命中预览
 *   node scripts/claim-recall-probe.mjs --json         # 机器可读（给回归/对比用）
 *   node scripts/claim-recall-probe.mjs --file <样本.json>
 *
 * 只读：不写库、不联网、不调模型。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { medicalClaimAdvisory, reviewContent } from "../server/domain.mjs";
import { rulePack } from "../server/store.mjs";
import { loadSample, listingContent } from "./sample-listings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SAMPLE = resolve(here, "../../qa/research/listings-20261027.json");
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/** 一次调用只喂一句话放在 `description` 里：标题字段另有 75 字符上限，会把结论搅混。 */
const sentenceContent = (text) => ({
  title: "Cotton canvas tote bag",
  item_highlights: "",
  bullet_points: [{ id: "b1", text }],
  description: "",
});

const CLAIM_RULES = new Set(["US-01", "US-02", "US-03"]);

function runEngineIssues(text) {
  return reviewContent({
    content: sentenceContent(text),
    profile: null,
    rulePack,
    marketplace: "US",
  }).issues;
}

function runEngine(text) {
  return runEngineIssues(text).map((issue) => issue.rule_id);
}

/**
 * 第一栏：16 CFR 260 的 14 个宣称条款，16 句（260.8、260.9 各两句，官方在那两条里点了不同的词）。
 * `judge`：
 *   must        —— 袋类文案里真会出现，不命中就是漏报；
 *   optional    —— 会出现但很少（臭氧层友好），补了加分、不补不算洞；
 *   out_of_scope —— 袋类基本不会出现（可补充/可再生能源/再生材料/源头减量），**补了是纯凑数**。
 */
const CASES_260 = [
  { clause: "260.4", judge: "must", term: "General environmental benefit", text: "Eco-friendly tote bag for daily shopping" },
  { clause: "260.5", judge: "must", term: "Carbon offsets", text: "Carbon neutral shipping on every order" },
  { clause: "260.6", judge: "must", term: "Certifications and seals", text: "GREENGUARD Gold certified low VOC fabric" },
  { clause: "260.7", judge: "must", term: "Compostable", text: "100% compostable within 90 days" },
  { clause: "260.8a", judge: "must", term: "Degradable", text: "Biodegradable shopping bag" },
  { clause: "260.8b", judge: "must", term: "Degradable (前缀变形)", text: "Photodegradable mailer bag" },
  { clause: "260.9a", judge: "must", term: "Free-of", text: "BPA free inner liner" },
  { clause: "260.9b", judge: "must", term: "Free-of (plastic)", text: "Plastic-free packaging" },
  { clause: "260.10", judge: "must", term: "Non-toxic", text: "Non-toxic water based dyes" },
  { clause: "260.11", judge: "optional", term: "Ozone-safe", text: "Ozone friendly manufacturing process" },
  { clause: "260.12", judge: "must", term: "Recyclable", text: "Recyclable kraft paper bag" },
  { clause: "260.13", judge: "must", term: "Recycled content", text: "Made with 30% recycled cotton" },
  { clause: "260.14", judge: "out_of_scope", term: "Refillable", text: "Refillable pouch for repeat use" },
  { clause: "260.15", judge: "out_of_scope", term: "Renewable energy", text: "Made with renewable energy" },
  { clause: "260.16", judge: "out_of_scope", term: "Renewable materials", text: "Made from renewable bamboo fiber" },
  { clause: "260.17", judge: "out_of_scope", term: "Source reduction", text: "30% less packaging than before" },
];

/**
 * 第二栏：Detail Page 公告点名的 6 类（原始 9 句，出处见 qa/research/regulatory-gap-20261029.md §4.1）。
 * 判据只有两档：这些句子**都该被平台层拦下**（AMZ-03 联系信息 / AMZ-04 交易与促销信息）。
 */
const CASES_DETAIL = [
  { kind: "company-specific", text: "Our company has 20 years of manufacturing experience" },
  { kind: "引导店铺", text: "Visit our store for more colors" },
  { kind: "another product", text: "Also available in navy blue and olive green" },
  { kind: "promotional", text: "On sale now for a limited time" },
  { kind: "promotional", text: "Buy 2 get 1 free this week" },
  { kind: "promotional", text: "Best deal of the season" },
  { kind: "promotional", text: "Save 20% off today" },
  { kind: "排名宣称", text: "Amazon best seller in tote bags" },
  { kind: "promotional", text: "Free shipping on orders over 50" },
];

/**
 * 第三栏：医疗、健康与抗菌宣称（`US-04`）。
 *
 * 为什么要有这一栏：这条规则第 9 轮才落地，此前只有 `tests/us-medical-claims.test.mjs`
 * 里 7 句"应该命中"的用例 —— 那是**单测**，钉的是"这几个写法别退化"，不是"商家真会怎么写"。
 * 没有这一栏的时候，没人知道 `pain relief` / `mildew proof` / `dust mite resistant`
 * 这些**名词形式**整片漏掉。
 *
 * 判据两档：
 *   must  —— 在美国属于需要实证支持的客观宣称，不命中就是漏报；
 *   other —— 看着沾边但**不归这条管**（气味事实、舒适度、防静电、食品接触），命中算误报。
 *
 * 测试句来源：中国供应商英文文案的常见写法（不是我自己编的刁钻句子）。
 * 这一栏只说明"引擎认不认这种写法"，**不说明这类写法在真实在售文案里有多常见**——
 * 20 条真实样本里 0 条（见第四栏），因为样本是棉布袋，本来就不写抗菌。
 */
const CASES_MEDICAL = [
  { kind: "成品词", judge: "must", text: "Antibacterial lining keeps the bag fresh" },
  { kind: "成品词", judge: "must", text: "Anti-microbial finish resists mildew" },
  { kind: "成品词", judge: "must", text: "Hypoallergenic cotton for sensitive skin" },
  { kind: "成品词", judge: "must", text: "Clinically proven to reduce odor" },
  { kind: "成品词", judge: "must", text: "Made from medical grade canvas" },
  { kind: "成品词", judge: "must", text: "Dermatologist recommended fabric" },
  { kind: "名词·微生物", judge: "must", text: "Anti-odor technology built into the fabric" },
  { kind: "名词·微生物", judge: "must", text: "Mildew proof coating for humid climates" },
  { kind: "名词·微生物", judge: "must", text: "Mold-resistant inner layer" },
  { kind: "名词·微生物", judge: "must", text: "Dust mite resistant cotton" },
  { kind: "名词·微生物", judge: "must", text: "Anti-mite treated fabric" },
  { kind: "名词·微生物", judge: "must", text: "Germ-free storage for gym clothes" },
  { kind: "名词·微生物", judge: "must", text: "Sanitized lining after every wash" },
  { kind: "名词·微生物", judge: "must", text: "Sterile packaging for hospitals" },
  { kind: "名词·过敏", judge: "must", text: "Allergy tested and safe for kids" },
  { kind: "名词·过敏", judge: "must", text: "Non-allergenic cotton lining" },
  { kind: "名词·身体", judge: "must", text: "Pain relief for sore shoulders after a long day" },
  { kind: "名词·身体", judge: "must", text: "Anti-inflammatory bamboo charcoal lining" },
  { kind: "医疗场景", judge: "must", text: "Medical use approved fabric" },
  { kind: "医疗场景", judge: "must", text: "FDA registered facility" },
  { kind: "动词", judge: "must", text: "Kills 99% of bacteria on contact" },
  { kind: "动词", judge: "must", text: "Helps relieve back pain on long commutes" },
  { kind: "动词", judge: "must", text: "Prevents mold and mildew in humid weather" },
  { kind: "动词", judge: "must", text: "Fights germs between washes" },
  { kind: "动词", judge: "must", text: "Reduces body odor naturally" },
  { kind: "动词", judge: "must", text: "Soothes soreness after a day out" },
  { kind: "疗效暗示", judge: "must", text: "Eases shoulder strain from carrying" },
  { kind: "疗效暗示", judge: "must", text: "Helps heal chapped hands" },
  { kind: "不该收", judge: "other", text: "Odor-free lining keeps clothes fresh" },
  { kind: "不该收", judge: "other", text: "Skin-friendly soft cotton" },
  { kind: "不该收", judge: "other", text: "Anti-fatigue shoulder strap" },
  { kind: "不该收", judge: "other", text: "Food safe for packed lunches" },
  { kind: "不该收", judge: "other", text: "Anti-static lining" },
  { kind: "不该收", judge: "other", text: "Moisture-wicking mesh pocket" },
  { kind: "不该收", judge: "other", text: "Breathable cotton keeps you cool" },
];

/** 自证用：这两条**必须**命中，否则引擎没跑起来。 */
const CONTROLS_HIT = [
  { id: "AMZ-03", text: "Contact us at sales@example.com" },
  { id: "AMZ-04", text: "Price: $19.99 for one bag" },
];
/** 自证用：这条**不许**命中，否则量具在瞎报。 */
const CONTROL_CLEAN = "Cotton canvas tote bag with long handles, 38 by 42 cm";

const results = [];
let selfTest = { ok: true, lines: [] };

for (const control of CONTROLS_HIT) {
  const ids = runEngine(control.text);
  const ok = ids.includes(control.id);
  if (!ok) selfTest.ok = false;
  selfTest.lines.push(`${ok ? "✓" : "✗"} 自证命中 ${control.id}：${control.text} → ${ids.join(",") || "空"}`);
}
{
  const ids = runEngine(CONTROL_CLEAN);
  const ok = ids.length === 0;
  if (!ok) selfTest.ok = false;
  selfTest.lines.push(`${ok ? "✓" : "✗"} 自证不瞎报：${CONTROL_CLEAN} → ${ids.join(",") || "空"}`);
}

for (const item of CASES_260) {
  const ids = runEngine(item.text);
  const claimHits = ids.filter((x) => CLAIM_RULES.has(x));
  results.push({ lane: "260", key: item.clause, judge: item.judge, label: item.term, text: item.text, ids, hit: claimHits.length > 0 });
}
for (const item of CASES_DETAIL) {
  const ids = runEngine(item.text);
  const platformHits = ids.filter((x) => x === "AMZ-03" || x === "AMZ-04");
  results.push({ lane: "detail", key: item.kind, judge: "must", label: item.kind, text: item.text, ids, hit: platformHits.length > 0 });
}
/**
 * 每条还要记下**它给出的下一步是哪一类**（`medicalClaimAdvisory`）。
 * 这一栏存在的另一半原因就是这个：改之前 28 条命中共用 1 句话，改之后按类分。
 * 分类是从命中的那段原文反推的（分类器吃原文），所以这里拿 `issue.original` 就能还原。
 */
const medicalRows = CASES_MEDICAL.map((item) => {
  const issues = runEngineIssues(item.text);
  const hit = issues.find((issue) => issue.rule_id === "US-04");
  const ids = issues.map((issue) => issue.rule_id);
  return {
    ...item,
    ids,
    hit: Boolean(hit),
    cls: hit ? medicalClaimAdvisory(hit.original).label : "—",
    suggestion: hit ? hit.suggestion : "",
  };
});
const distinctMedicalSuggestions = new Set(medicalRows.filter((x) => x.hit).map((x) => x.suggestion)).size;

// 第三栏：真实在售文案。字段映射与 scripts/real-listing-probe.mjs **共用一份**（sample-listings.mjs）——
// 原来这段在两个脚本里各写一遍，两份都错，于是引擎层和 HTTP 层给出同一个错数字，互相"印证"。
const samplePath = value("--file", DEFAULT_SAMPLE);
const { items } = loadSample(samplePath);

const fieldLength = (content, path) => {
  if (path === "content.title") return content.title.length;
  if (path === "content.item_highlights") return content.item_highlights.length;
  if (path === "content.description") return content.description.length;
  const match = /^content\.bullet_points\.(.+)$/.exec(path);
  if (match) return (content.bullet_points.find((b) => b.id === match[1])?.text || "").length;
  return content.title.length + content.item_highlights.length + content.description.length;
};

const perRule = new Map();
const fieldWide = new Map(); // 证据落不到那一句：original 长度 ≥ 字段长度 90%
let totalIssues = 0;
const perListing = [];
const listingIssueDetails = [];

for (const item of items) {
  const content = listingContent(item);
  const issues = reviewContent({ content, profile: null, rulePack, marketplace: "US" }).issues;
  perListing.push(issues.length);
  totalIssues += issues.length;
  for (const issue of issues) {
    perRule.set(issue.rule_id, (perRule.get(issue.rule_id) || 0) + 1);
    const size = fieldLength(content, issue.field_path) || 1;
    const ratio = String(issue.original || "").length / size;
    const wide = ratio >= 0.9;
    const bucket = fieldWide.get(issue.rule_id) || { wide: 0, total: 0 };
    bucket.total += 1;
    if (wide) bucket.wide += 1;
    fieldWide.set(issue.rule_id, bucket);
    listingIssueDetails.push({ asin: item.asin, rule: issue.rule_id, field: issue.field_path, ratio, original: String(issue.original || "").slice(0, 60) });
  }
}

const sortedCounts = [...perListing].sort((a, b) => a - b);
const median = sortedCounts.length
  ? sortedCounts.length % 2
    ? sortedCounts[(sortedCounts.length - 1) / 2]
    : (sortedCounts[sortedCounts.length / 2 - 1] + sortedCounts[sortedCounts.length / 2]) / 2
  : 0;

/**
 * 候选预览：**还没落进规则包**的促销语词表，先在这 20 条真实文案上量一遍。
 * 第 5 轮的教训：官方有 ≠ 该实现；「全大写」照字面做会命中 14/20 全是五点小标题。
 * 这里的数字只说明"会报多少条"，能不能看出真问题得看 `--candidates --list` 的上下文。
 * 这是**尺子**，不进产品。
 */
const CANDIDATES = [
  { id: "sale", zh: "打折 / 降价", pattern: /\b(?:on\s+sale|sale\s+price|clearance|discount(?:ed)?|\d{1,3}\s*%\s*off|save\s+\d{1,3}\s*%|coupon|promo\s*code)\b/gi },
  { id: "deal", zh: "划算 / 特惠", pattern: /\b(?:best\s+deal|great\s+deal|hot\s+deal|deal\s+of\s+the\s+(?:day|week|season))\b/gi },
  { id: "bestseller", zh: "销量 / 排名宣称", pattern: /\b(?:best[-\s]?sell(?:er|ing)|#\s?1\s+(?:best[-\s]?seller|seller)|top[-\s]?rated|amazon'?s\s+choice)\b/gi },
  { id: "urgency", zh: "时间紧迫", pattern: /\b(?:limited[-\s]?time|today\s+only|while\s+supplies\s+last|act\s+now|order\s+now|hurry|don'?t\s+miss)\b/gi },
  { id: "gift-offer", zh: "赠品 / 包邮 / 退款承诺", pattern: /\b(?:buy\s+\d+\s+get\s+\d+|free\s+gift|free\s+shipping|money[-\s]?back\s+guarantee|satisfaction\s+guaranteed)\b/gi },
  { id: "cta", zh: "行动号召 / 导流", pattern: /\b(?:click\s+here|shop\s+now|visit\s+(?:our|the)\s+store|check\s+out\s+our)\b/gi },
];

const candidateRows = CANDIDATES.map((candidate) => {
  const hits = [];
  const asins = new Set();
  for (const item of items) {
    const content = listingContent(item);
    for (const field of [
      { path: "content.title", text: content.title },
      { path: "content.item_highlights", text: content.item_highlights },
      ...content.bullet_points.map((b) => ({ path: `content.bullet_points.${b.id}`, text: b.text })),
      { path: "content.description", text: content.description },
    ]) {
      if (!field.text) continue;
      candidate.pattern.lastIndex = 0;
      const found = field.text.match(candidate.pattern);
      if (!found) continue;
      for (const snippet of new Set(found.map((x) => x.trim()))) {
        hits.push({ asin: item.asin, field: field.path, snippet, context: contextOf(field.text, snippet) });
        asins.add(item.asin);
      }
    }
  }
  return { id: candidate.id, zh: candidate.zh, listings: asins.size, hits };
});

function contextOf(text, snippet) {
  const at = text.toLowerCase().indexOf(snippet.toLowerCase());
  if (at < 0) return snippet;
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + snippet.length + 40);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

const must = results.filter((x) => x.lane === "260" && x.judge === "must");
const optional = results.filter((x) => x.lane === "260" && x.judge === "optional");
const outOfScope = results.filter((x) => x.lane === "260" && x.judge === "out_of_scope");
const detail = results.filter((x) => x.lane === "detail");

/**
 * 第四栏：**同一句话的字符变体**。
 * 商家文案大多从供应商表格 / Word / 微信里粘过来，连字符常常不是 ASCII 的 `-`：
 * U+2011 不换行连字符、U+2013 en dash、U+FF0D 全角减号、U+2212 减号、U+200B 零宽空格。
 * 这些字在屏幕上和 `-` 一模一样，正则里的 `-` 一个都认不出来 —— 实测改前 14 条漏 6 条。
 *
 * 判据：每一条都必须命中，命中规则不要求具体是哪条（US-01/02/03/AMZ-04 都算数）。
 */
const VARIANTS = [
  ["ASCII 基线", "ECO-FRIENDLY tote bag"],
  ["en dash U+2013", "ECO\u2013FRIENDLY tote bag"],
  ["不换行连字符 U+2011", "ECO\u2011FRIENDLY tote bag"],
  ["全角减号 U+FF0D", "ECO\uFF0DFRIENDLY tote bag"],
  ["零宽空格 U+200B", "ECO\u200B-FRIENDLY tote bag"],
  ["NBSP 代替空格", "ECO\u00A0FRIENDLY tote bag"],
  ["BPA 不换行连字符", "BPA\u2011free inner liner"],
  ["carbon 不换行连字符", "Carbon\u2011neutral shipping"],
  ["limited 不换行连字符", "limited\u2011time offer"],
  ["photo 连字符变体", "Photo\u2010degradable mailer"],
  ["compostable 大写", "100% COMPOSTABLE within 90 days"],
  ["certified 全大写带 en dash", "OEKO\u2013TEX certified cotton"],
];
const variantRows = VARIANTS.map(([label, text]) => {
  const ids = runEngine(text);
  return { label, text, ids, hit: ids.length > 0 };
});

const summary = {
  self_test: selfTest.ok,
  ftc: {
    must_total: must.length,
    must_hit: must.filter((x) => x.hit).length,
    optional_total: optional.length,
    optional_hit: optional.filter((x) => x.hit).length,
    out_of_scope_total: outOfScope.length,
    out_of_scope_hit: outOfScope.filter((x) => x.hit).length,
    all_total: results.filter((x) => x.lane === "260").length,
    all_hit: results.filter((x) => x.lane === "260" && x.hit).length,
  },
  detail: { total: detail.length, hit: detail.filter((x) => x.hit).length },
  medical: {
    must_total: medicalRows.filter((x) => x.judge === "must").length,
    must_hit: medicalRows.filter((x) => x.judge === "must" && x.hit).length,
    other_total: medicalRows.filter((x) => x.judge === "other").length,
    other_hit: medicalRows.filter((x) => x.judge === "other" && x.hit).length,
    distinct_suggestions: distinctMedicalSuggestions,
    classes: [...new Set(medicalRows.filter((x) => x.hit).map((x) => x.cls))],
  },
  variants: { total: variantRows.length, hit: variantRows.filter((x) => x.hit).length },
  sample: {
    path: samplePath,
    listings: items.length,
    issues_total: totalIssues,
    issues_median: median,
    per_rule: Object.fromEntries([...perRule].sort((a, b) => b[1] - a[1])),
    field_wide: Object.fromEntries([...fieldWide].map(([rule, v]) => [rule, v.wide])),
  },
  candidates: candidateRows.map((row) => ({ id: row.id, zh: row.zh, listings: row.listings, hits: row.hits.length })),
};

if (has("--json")) {
  console.log(JSON.stringify({ summary, results, candidates: candidateRows }, null, 2));
  process.exit(selfTest.ok ? 0 : 1);
}

console.log("自证（先确认尺子能打到东西，再看后面的 0）");
for (const line of selfTest.lines) console.log(`  ${line}`);
console.log("");

console.log(`## 一 · 16 CFR Part 260（14 个宣称条款，16 句）　引擎：reviewContent，不经模型`);
console.log("| 条 | 官方类别 | 判据 | 测试句 | 命中 |");
console.log("|---|---|---|---|---|");
for (const row of results.filter((x) => x.lane === "260"))
  console.log(`| ${row.key} | ${row.label} | ${row.judge} | ${row.text} | ${row.hit ? `✓ ${row.ids.filter((x) => CLAIM_RULES.has(x)).join(",")}` : "**无**"} |`);
console.log("");
console.log(
  `must 召回 **${summary.ftc.must_hit}/${must.length}**　optional ${summary.ftc.optional_hit}/${optional.length}　` +
    `out_of_scope（不该补，别算进漏报）${summary.ftc.out_of_scope_hit}/${outOfScope.length}`,
);
console.log(`全 16 句合计 ${summary.ftc.all_hit}/${summary.ftc.all_total}（这个数字对外不许直接用：分母里有 4 条与袋类无关）`);
console.log("");

console.log("## 二 · Amazon Detail Page 公告的 6 类禁用项（9 句）");
console.log("| 类别 | 测试句 | 命中 |");
console.log("|---|---|---|");
for (const row of detail)
  console.log(`| ${row.key} | ${row.text} | ${row.hit ? `✓ ${row.ids.filter((x) => x === "AMZ-03" || x === "AMZ-04").join(",")}` : "**无**"} |`);
console.log("");
console.log(`平台层召回 **${summary.detail.hit}/${detail.length}**`);
console.log("");

const medicalMust = medicalRows.filter((x) => x.judge === "must");
const medicalOther = medicalRows.filter((x) => x.judge === "other");
console.log(`## 三 · 医疗、健康与抗菌宣称（US-04，${medicalRows.length} 句）　依据：FTC 广告实证要求`);
console.log("| 类 | 判据 | 测试句 | 命中 | 给出的下一步属于 |");
console.log("|---|---|---|---|---|");
for (const row of medicalRows)
  console.log(
    `| ${row.kind} | ${row.judge} | ${row.text} | ${row.hit ? "✓ US-04" : "**无**"} | ${row.cls} |`,
  );
console.log("");
console.log(
  `US-04 召回 **${summary.medical.must_hit}/${medicalMust.length}**　` +
    `不该收的写法命中 ${summary.medical.other_hit}/${medicalOther.length}（命中即误报）`,
);
console.log(
  `命中之后给出的「下一步」去重后 **${distinctMedicalSuggestions} 种**` +
    `（第 16 轮之前 28 条共用 1 种：「补充对应检测报告或临床依据」——对「FDA 注册」「缓解酸痛」都是错的动作）`,
);
console.log("");

console.log("## 四 · 同一句话的字符变体（从 Word / 表格里粘过来就会这样）");
console.log("| 变体 | 测试句 | 命中 |");
console.log("|---|---|---|");
for (const row of variantRows) {
  const shown = [...row.text].map((ch) => (ch.codePointAt(0) > 0x2000 && ch.codePointAt(0) < 0x2100 ? `\\u${ch.codePointAt(0).toString(16)}` : ch === "\u00a0" ? "\\u00a0" : ch)).join("");
  console.log(`| ${row.label} | ${shown} | ${row.hit ? `✓ ${row.ids.join(",")}` : "**无**"} |`);
}
console.log("");
console.log(`变体召回 **${summary.variants.hit}/${summary.variants.total}**`);
console.log("");

console.log(`## 五 · 20 条真实在售文案（不关联档案）`);
console.log(`问题总数 ${totalIssues}　中位每条 ${median}　最少 ${sortedCounts[0] ?? 0}　最多 ${sortedCounts.at(-1) ?? 0}`);
console.log("");
console.log("| 规则 | 条数 | 其中「证据=整个字段」 |");
console.log("|---|---|---|");
for (const [rule, n] of [...perRule].sort((a, b) => b[1] - a[1]))
  console.log(`| ${rule} | ${n} | ${fieldWide.get(rule)?.wide ?? 0} |`);
console.log("");
console.log("「证据=整个字段」= `issue.original` 占了该字段 90% 以上，等于没定位到那一句。");

if (has("--candidates")) {
  console.log("\n## 六 · 候选词预览（还没落进规则包，这只是尺子）\n");
  console.log("| 候选类 | 命中条数 / 样本 | 命中次数 |");
  console.log("|---|---|---|");
  for (const row of candidateRows.sort((a, b) => b.listings - a.listings))
    console.log(`| ${row.zh} | ${row.listings} / ${items.length} | ${row.hits.length} |`);
  if (has("--list")) {
    for (const row of candidateRows) {
      if (!row.hits.length) continue;
      console.log(`\n### ${row.zh}（${row.hits.length} 处）`);
      for (const hit of row.hits.slice(0, 20)) {
        console.log(`- ${hit.asin} · ${hit.field} · \`${hit.snippet}\``);
        console.log(`  ${hit.context}`);
      }
    }
  }
}

/**
 * 宽松探测：上面的候选类 0 命中时，必须能分清两件事——
 *   「真实文案里确实没这类说法」和「我的短语写窄了所以什么都打不到」。
 * 这两件事在只看得 0 的时候长得一模一样。单词级命中几乎全是误报，别把这里当结论。
 *
 * 注意：不要在 `node -e` 里敲这些正则。Git Bash 会把命令里的 `\\b` 吃掉一层，
 * 于是 `\bperfect` 变成退格符 + perfect，输出一排 0 —— 我本轮第一次就是这么被骗的。
 */
if (has("--nearmiss")) {
  const words = ["sale", "deal", "best", "free", "save", "limited", "discount", "coupon", "shipping", "gift", "perfect", "premium", "guarantee", "warranty", "certified"];
  const corpus = items.map((item) => ({
    asin: item.asin,
    text: [item.title, ...(item.bullets || []), item.description].filter(Boolean).join(" "),
  }));
  console.log("\n## 七 · 宽松探测（单词级，几乎全是误报，只用来判断「是不是路上真没有」）\n");
  console.log("| 关键词 | 命中条数 / 样本 | 首处上下文 |");
  console.log("|---|---|---|");
  for (const word of words) {
    const re = new RegExp(`\\b${word}\\w*`, "i");
    const hit = corpus.filter((x) => re.test(x.text));
    if (!hit.length) {
      console.log(`| ${word} | 0 / ${items.length} | — |`);
      continue;
    }
    const first = hit[0].text.match(re)[0];
    console.log(`| ${word} | ${hit.length} / ${items.length} | ${contextOf(hit[0].text, first).replace(/\|/g, "\\|")} |`);
  }
}

if (has("--list")) {
  console.log("\n## 附 · 真实样本里证据没定位到句子的条目\n");
  for (const row of listingIssueDetails.filter((x) => x.ratio >= 0.9).slice(0, 30))
    console.log(`- ${row.asin} · ${row.rule} · ${row.field} · 占比 ${(row.ratio * 100).toFixed(0)}% · \`${row.original}\``);
}

/**
 * `--strict`：给一键命令用的硬门槛。四条都过才算过，缺一条就 exit 1：
 *   1. 量具自证（能打到、不瞎报）；
 *   2. `must` 全部召回（11/11）——漏一条就是漏一个官方条款；
 *   3. `out_of_scope` 一条都不许命中——命中了说明词表把不相干的词也吃了；
 *   4. 医疗宣称栏：`must` 全部召回（28/28）且 `other` 一条都不许命中。
 * 不把 optional、第二栏纳入门槛：臭氧层友好对袋类商品几乎不出现；
 * company-specific / another-product 两类需要语义判断，本地层不做（已写进 coverage_limits）。
 */
function strictOk(mustCases = must, medicalCases = medicalMust) {
  const mustMiss = mustCases.filter((x) => !x.hit).map((x) => x.key);
  const scopeNoise = outOfScope.filter((x) => x.hit).map((x) => x.key);
  const detailMiss = detail.filter((x) => !x.hit).map((x) => x.key);
  const variantMiss = variantRows.filter((x) => !x.hit).map((x) => x.label);
  const medicalMiss = medicalCases.filter((x) => !x.hit).map((x) => x.text);
  const medicalNoise = medicalOther.filter((x) => x.hit).map((x) => x.text);
  if (mustMiss.length) console.log(`\n✗ must 漏召回：${mustMiss.join(", ")}`);
  if (scopeNoise.length) console.log(`\n✗ out_of_scope 被误召回：${scopeNoise.join(", ")}`);
  if (variantMiss.length) console.log(`\n✗ 字符变体漏召回：${variantMiss.join(", ")}`);
  if (medicalMiss.length) console.log(`\n✗ US-04 漏召回：${medicalMiss.join(" / ")}`);
  if (medicalNoise.length) console.log(`\n✗ US-04 误报（不归这条管的写法被报了）：${medicalNoise.join(" / ")}`);
  if (detailMiss.length) console.log(`\n· 平台层未召回（已知缺口，不算失败）：${detailMiss.join(", ")}`);
  return !mustMiss.length && !scopeNoise.length && !variantMiss.length && !medicalMiss.length && !medicalNoise.length;
}

/**
 * 门槛自己也要被验：手工去掉一条 must 用例，`strictOk` 必须变红。
 * 否则"全过"和"门槛根本没在判"在输出上一模一样（这个项目为此吃过好几回）。
 * 第 16 轮加了医疗栏，所以**两道门槛各验一次**：新门槛没验过，等于没有。
 */
if (has("--gate-check")) {
  // 注意：要**把一条改成没命中**，不是"删掉一条"——删掉一条仍然全是命中，门槛当然还是绿的。
  // 我第一次就写成了删掉，输出"仍然全绿"，差点以为门槛坏了。
  const faked = must.map((x, index) => (index === 0 ? { ...x, hit: false } : x));
  const wentRed = !strictOk(faked);
  console.log(`\n门槛自检：假装 ${must[0]?.key} 漏召回之后 ${wentRed ? "变红 ✓" : "仍然全绿 ✗"}`);
  // 医疗栏：一条 must 漏 + 一条 other 误报，两个方向都要能红。
  const fakeMiss = medicalMust.map((x, index) => (index === 0 ? { ...x, hit: false } : x));
  const missRed = !strictOk(must, fakeMiss);
  console.log(`门槛自检：假装 US-04 漏一条之后 ${missRed ? "变红 ✓" : "仍然全绿 ✗"}`);
  console.log(`门槛自检：US-04 门槛本身 ${medicalMust.length} 条 must / ${medicalOther.length} 条不该收，已纳入 strictOk ✓`);
  process.exit(wentRed && missRed ? 0 : 1);
}

process.exit(selfTest.ok && (!has("--strict") || strictOk()) ? 0 : 1);
