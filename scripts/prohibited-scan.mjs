#!/usr/bin/env node
/**
 * 量「官方禁止项里我们没覆盖的那 6 类」在真实在售文案上的命中率。
 *
 * 为什么先量不加规则：上一轮（qa/research/official-source-check-20261029.md 第三节）
 * 量到「全大写」在 20 条真实文案上命中 14/20，全是五点小标题——照字面实现=瞎报机器。
 * 所以任何新类别进规则包之前，必须先在真实数据上量一遍命中率，再看命中的是不是真问题。
 *
 * 这个脚本**不进产品链路**，只读样本、只印数字。它的价值是「尺子」，不是「功能」。
 *
 * 口径（三条，读数字前先读这三条）：
 *   1. 命中次数 ≠ 违规率，只说明这类文字在真实在售文案里有多常见。
 *   2. pattern 是我按官方条目的**类别描述**自己写的正则，官方不给正则；
 *      所以它只用于「量有多大」，不能直接抄进规则包。
 *   3. 严格短语 0 命中时，用 --nearmiss 拆成单词再量一遍——否则
 *      「路上真没有」和「我短语写窄了」在输出上长得一模一样。
 *
 * 用法：
 *   node scripts/prohibited-scan.mjs                       # 摘要表
 *   node scripts/prohibited-scan.mjs --list                # 连命中原文一起印（判断误报用）
 *   node scripts/prohibited-scan.mjs --nearmiss            # 单词级宽松探测（几乎全是误报）
 *   node scripts/prohibited-scan.mjs --json                # 机器可读
 *   node scripts/prohibited-scan.mjs --selftest            # 量具自证：每类正则必须能打中构造句
 *   node scripts/prohibited-scan.mjs --file <样本.json>     # 默认读 qa/research/listings-20261027.json
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SAMPLE = resolve(here, "../../qa/research/listings-20261027.json");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/**
 * 第一栏：与 `G200390640`「None of the following are allowed…」逐条对应的 6 类。
 * `official_no` 是上一轮那份文档第二节表格里的编号，方便回查原文。
 */
const OFFICIAL = [
  {
    id: "testimonial",
    official_no: 6,
    zh: "评论、引用、用户证言",
    pattern:
      /\b(?:customers?\s+(?:love|say|agree|rave)|our\s+customers?\s+(?:say|love)|reviewers?\s+say|reviews?\s+(?:say|mention)|testimonials?|as\s+seen\s+in|featured\s+in|5[-\s]?star\s+(?:reviews?|rating)|rated\s+(?:5|five)\s+stars?|best[-\s]?reviewed|loved\s+by\s+(?:\d|thousands|millions))/gi,
    sample: "Our customers love it and reviewers say it lasts.",
  },
  {
    id: "solicit-review",
    official_no: 7,
    zh: "索评 / 引导评价",
    pattern:
      /\b(?:leave\s+(?:us\s+)?a\s+(?:5[-\s]?star\s+)?(?:review|feedback|rating)|write\s+(?:us\s+)?a\s+review|rate\s+us|give\s+us\s+(?:a\s+)?(?:5|five)[-\s]?star|contact\s+us\s+before\s+leav(?:ing|e)\s+(?:a\s+)?(?:review|feedback)|in\s+exchange\s+for\s+(?:a\s+)?review)/gi,
    sample: "Please leave us a 5-star review after purchase.",
  },
  {
    id: "promotional",
    official_no: 8,
    zh: "广告语 / 促销物",
    pattern:
      /\b(?:best[-\s]?sell(?:er|ing)|#\s?1\s+(?:best[-\s]?sell(?:er|ing)|seller)|top[-\s]?rated|money[-\s]?back\s+guarantee|satisfaction\s+guaranteed|buy\s+(?:now|2|one\s+get)|order\s+now|click\s+here|free\s+gift|bonus\s+included|\d+%\s+off|discount(?:ed)?|on\s+sale|clearance|coupon|watermark)/gi,
    sample: "Best seller, top rated, and 20% off this week.",
  },
  {
    id: "time-sensitive",
    official_no: 9,
    zh: "时间敏感信息",
    pattern:
      /\b(?:limited[-\s]?time|today\s+only|this\s+week\s+only|while\s+supplies\s+last|hurry|don'?t\s+miss|new\s+for\s+20\d\d|20(?:2[4-9])\s+(?:edition|version|model|upgrade)|black\s+friday|cyber\s+monday|prime\s+day|christmas\s+sale|back\s+to\s+school\s+sale|perfect\s+for\s+(?:christmas|halloween|valentine)) /gi,
    sample: "Limited time offer for Black Friday 2026.",
  },
  {
    id: "restricted-phrase",
    official_no: 11,
    zh: "受限短语（FSA/HSA eligible 一类）",
    pattern: /\b(?:fsa|hsa)[-\s]?(?:eligible|approved|reimbursable)\b/gi,
    sample: "FSA eligible and HSA eligible purchase.",
  },
  {
    id: "offensive",
    official_no: 1,
    zh: "色情 / 冒犯性内容",
    pattern:
      /\b(?:fuck\w*|shit\w*|bitch\w*|damn|ass(?:hole)?|bastard|crap|stupid|idiot|retard\w*|kill\w*|murder\w*|weapon|gun|knife\s+for\s+(?:killing|attack)|sex\w*|porn\w*|nude)\b/gi,
    sample: "This stupid bag is crap.",
  },
];

/**
 * 第二栏：**不在那一页上的**扩展探测。单独一栏，因为依据不同：
 * 医疗/绝对化/担保类宣称靠的是广告实证（FTC substantiation）与商品宣称政策，
 * 不是 `G200390640` 那张禁止清单。混在第一栏里会让「官方有 6 类没覆盖」这个数字失真。
 */
const EXTRA = [
  {
    id: "certification-claim",
    zh: "医疗 / 认证 / 绝对化宣称",
    basis: "FTC 广告实证 + 一般商品宣称政策（非 G200390640 清单）",
    pattern:
      /\b(?:fda\s+(?:approved|cleared)|epa\s+approved|medical[-\s]?grade|hospital[-\s]?grade|antibacterial|antimicrobial|kills?\s+(?:99|100)|cures?|treats?\s+(?:pain|acne|disease)|100%\s+(?:safe|guaranteed)|unbreakable|indestructible|strongest)\b/gi,
    sample: "FDA approved, medical grade, and unbreakable.",
  },
  {
    id: "warranty-promise",
    zh: "保修 / 售后承诺写进文案",
    basis: "Amazon 商品详情页政策（保修信息应在保修字段，不在文案）",
    pattern:
      /\b(?:warranty\b|lifetime\s+guarantee|guaranteed\s+for\s+life|free\s+replacement|replace(?:ment)?\s+for\s+free|refund\s+or\s+replacement)/gi,
    sample: "WARRANTY: we offer free replacement if it breaks.",
  },
];

const CATEGORIES = [
  ...OFFICIAL.map((c) => ({ ...c, lane: "official" })),
  ...EXTRA.map((c) => ({ ...c, lane: "extra" })),
];

// 量具自证：尺子自己得先能打到东西，否则「0 命中」和「正则写坏了」在输出上一模一样。
if (has("--selftest")) {
  let bad = 0;
  for (const category of CATEGORIES) {
    category.pattern.lastIndex = 0;
    const hit = category.sample.match(category.pattern);
    if (!hit) {
      bad += 1;
      console.log(`✗ ${category.zh}：构造句没命中 → ${category.sample}`);
    } else {
      console.log(`✓ ${category.zh}：${JSON.stringify(hit)}`);
    }
  }
  console.log(bad ? `\n${bad} 类正则打不中自己的样本句。` : `\n${CATEGORIES.length}/${CATEGORIES.length} 类量具可用。`);
  process.exit(bad ? 1 : 0);
}

// 坑（上一轮踩过）：顶层是 {items:[...]}，写成 d.listings 会静默得到 0 条。
const raw = JSON.parse(readFileSync(value("--file", DEFAULT_SAMPLE), "utf8"));
const items = Array.isArray(raw) ? raw : raw.items || [];

const FIELDS = (item) => [
  { path: "content.title", text: item.title || "" },
  { path: "content.item_highlights", text: (item.bullets || []).join(" ") },
  ...(item.bullets || []).map((text, i) => ({
    path: `content.bullet_points.b${i + 1}`,
    text,
  })),
  { path: "content.description", text: item.description || "" },
];

const results = new Map(
  CATEGORIES.map((c) => [c.id, { ...c, hits: [], listings: new Set() }]),
);

for (const item of items) {
  for (const field of FIELDS(item)) {
    if (!field.text) continue;
    for (const category of CATEGORIES) {
      category.pattern.lastIndex = 0;
      const found = field.text.match(category.pattern);
      if (!found) continue;
      const entry = results.get(category.id);
      for (const snippet of new Set(found.map((x) => x.trim()))) {
        entry.hits.push({
          asin: item.asin,
          field: field.path,
          snippet,
          context: context(field.text, snippet),
        });
        entry.listings.add(item.asin);
      }
    }
  }
}

/** 把命中片段前后各 40 字带出来，用来判断「这是真违规还是行业惯用词」。 */
function context(text, snippet) {
  const at = text.toLowerCase().indexOf(snippet.toLowerCase());
  if (at < 0) return snippet;
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + snippet.length + 40);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

const rows = [...results.values()].map((c) => ({
  id: c.id,
  lane: c.lane,
  official_no: c.official_no ?? null,
  zh: c.zh,
  basis: c.basis ?? "G200390640 禁止清单",
  listings: c.listings.size,
  total: items.length,
  hits: c.hits.length,
  detail: c.hits,
}));

if (has("--json")) {
  console.log(JSON.stringify({ sample: value("--file", DEFAULT_SAMPLE), listings: items.length, categories: rows }, null, 2));
  process.exit(0);
}

console.log(`样本：${value("--file", DEFAULT_SAMPLE)}　共 ${items.length} 条真实在售文案`);
console.log("口径：命中次数 ≠ 违规率，只说明这类文字在真实在售文案里有多常见。\n");

const table = (title, lane) => {
  console.log(`## ${title}\n`);
  console.log("| 类别 | 命中条数 / 样本 | 命中次数 |");
  console.log("|---|---|---|");
  for (const row of rows.filter((r) => r.lane === lane).sort((a, b) => b.listings - a.listings))
    console.log(`| ${row.zh} | ${row.listings} / ${row.total} | ${row.hits} |`);
  console.log("");
};
table("第一栏 · G200390640 禁止清单里我们没覆盖的 6 类", "official");
table("第二栏 · 不在那张清单上的扩展探测（依据不同，别并进上面的数字）", "extra");

if (has("--list")) {
  for (const row of rows) {
    if (!row.hits.length) continue;
    console.log(`\n## ${row.zh}（${row.listings} 条样本命中，依据：${row.basis}）`);
    for (const hit of row.hits.slice(0, 40)) {
      console.log(`- ${hit.asin} · ${hit.field} · \`${hit.snippet}\``);
      console.log(`  ${hit.context}`);
    }
    if (row.hits.length > 40) console.log(`  …另有 ${row.hits.length - 40} 处`);
  }
}

/**
 * 宽松探测：把上面那些短语拆成**单个关键词**再量一遍。
 * 用途只有一个——分清楚「真实文案里确实没有这类说法」和「我的短语写窄了所以什么都打不到」。
 * 这两件事在只看一个 0 的时候长得一模一样。关键词的命中几乎都是误报，别把这里的数字当结论。
 */
if (has("--nearmiss")) {
  const keywords = [
    "guarantee", "warranty", "replace", "refund", "review", "feedback", "customer",
    "sale", "discount", "free", "best", "rated", "new", "2025", "2026",
    "approved", "certified", "eligible", "safe", "premium", "professional", "tested",
  ];
  const corpus = items.map((item) => ({
    asin: item.asin,
    text: [item.title, ...(item.bullets || []), item.description].filter(Boolean).join(" "),
  }));
  console.log("\n## 宽松探测（单词级，几乎全是误报，只用来判断「是不是路上真没有」）\n");
  console.log("| 关键词 | 命中条数 / 样本 | 首处上下文 |");
  console.log("|---|---|---|");
  for (const word of keywords) {
    const re = new RegExp(`\\b${word}\\w*`, "i");
    const hit = corpus.filter((x) => re.test(x.text));
    if (!hit.length) continue;
    const first = context(hit[0].text, hit[0].text.match(re)[0]);
    console.log(`| ${word} | ${hit.length} / ${items.length} | ${first.replace(/\|/g, "\\|")} |`);
  }
}
