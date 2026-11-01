// 从公开语料生成「市场基线」聚合统计。
//
// 为什么是聚合而不是原文：真实在售 listing 的文案是别人的内容，打包进产品不合适。
// 产品只需要"同类商品通常怎么写"的分布，不需要那 45 段原文。所以这里只输出计数与分位。
//
// 用法：
//   node scripts/build-benchmark.mjs                       # 默认读 ../qa/research/listings-20261030.json
//   node scripts/build-benchmark.mjs <语料.json> <输出.json>
//
// 语料不在仓库里（有意为之），所以这个脚本是维护工具，不参与构建、不参与测试运行。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.resolve(
  process.argv[2] || path.join(here, "..", "..", "qa", "research", "listings-20261030.json"),
);
const outPath = path.resolve(process.argv[3] || path.join(here, "..", "server", "benchmark", "baseline-amazon-us-tote.json"));

const raw = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
const items = Array.isArray(raw) ? raw : raw.items || Object.values(raw)[0];
if (!Array.isArray(items) || items.length === 0) {
  console.error("语料读不出条目");
  process.exit(1);
}

const bodyOf = (x) => [x.title || "", ...(x.bullets || []), x.description || ""].join(" ");

// 环保「证据」必须跟环保语境绑定。第一版用 `\d+%` 就中了 11 条——那是 "100% cotton"，
// 成分不是证据。现在要求百分比后面直接跟 recycled / organic / recyclable，
// 或者出现可核查的认证名。
const ECO_EVIDENCE =
  /\b\d+(?:\.\d+)?\s*%\s*(?:post-?consumer\s+)?(?:recycled|organic|recyclable)\b|\bmade (?:from|with)\s+\d+\s*%\s*recycled|\b(GOTS|OEKO-TEX|GRS|FSC|bluesign)\b|\bcertified\b/i;

const MEASUREMENT = /\d+(?:\.\d+)?\s*(?:in\b|inch|inches|cm\b|'')/i;

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
const share = (n) => Math.round((n / items.length) * 1000) / 1000;

const titles = items.map((x) => x.title_chars).filter((v) => typeof v === "number" && isFinite(v)).sort((a, b) => a - b);
const bulletCounts = {};
for (const x of items) {
  const c = typeof x.bullet_count === "number" ? x.bullet_count : null;
  if (c !== null) bulletCounts[c] = (bulletCounts[c] || 0) + 1;
}

const ecoClaims = items.filter((x) => x.has_eco_claim === true);
const ecoWithEvidence = ecoClaims.filter((x) => ECO_EVIDENCE.test(bodyOf(x)));
const ecoWords = {};
for (const x of ecoClaims) for (const w of x.eco_words || []) ecoWords[w.toLowerCase()] = (ecoWords[w.toLowerCase()] || 0) + 1;
const ecoNoEvidenceExamples = ecoClaims
  .filter((x) => !ECO_EVIDENCE.test(bodyOf(x)))
  .slice(0, 3)
  .map((x) => ({ asin: x.asin, words: x.eco_words || [] }));

const units = {
  oz: items.filter((x) => x.oz_listed !== null && x.oz_listed !== undefined && x.oz_listed !== "").length,
  gsm: items.filter((x) => x.gsm_listed !== null && x.gsm_listed !== undefined && x.gsm_listed !== "").length,
};

const baseline = {
  schema: "market-baseline/1",
  scope: {
    marketplace: "amazon.com",
    category: "cotton tote bag",
    sample_date: "2026-10-30",
    n: items.length,
    method: "公开商品详情页快照，只做聚合统计，不收录原文",
    excludes: "不含评论、不含图片、不含价格",
  },
  title_chars: {
    min: titles[0],
    p25: quantile(titles, 0.25),
    p50: quantile(titles, 0.5),
    p75: quantile(titles, 0.75),
    p90: quantile(titles, 0.9),
    max: titles.at(-1),
    over_75: titles.filter((t) => t > 75).length,
    over_75_share: share(titles.filter((t) => t > 75).length),
    over_150: titles.filter((t) => t > 150).length,
    counted: titles.length,
    // 45 个整数，不是文本。有了它才能说「你的标题比 80% 的同行长」这种精确话，
    // 而不是拿分位点插值估个假的。
    sorted: titles,
  },
  bullet_count: {
    distribution: bulletCounts,
    five_share: share(bulletCounts[5] || 0),
  },
  eco: {
    claims: ecoClaims.length,
    claim_share: share(ecoClaims.length),
    with_evidence: ecoWithEvidence.length,
    words: ecoWords,
    no_evidence_examples: ecoNoEvidenceExamples,
  },
  units,
  weight_unit_share: { oz: share(units.oz), gsm: share(units.gsm) },
  pack_listed: items.filter((x) => x.pack_listed !== null && x.pack_listed !== undefined && x.pack_listed !== "").length,
  measurement_in_text: items.filter((x) => MEASUREMENT.test(bodyOf(x))).length,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
console.log(`基线已生成：${outPath}`);
console.log(
  `n=${baseline.scope.n} 标题中位 ${baseline.title_chars.p50} / 超75 ${baseline.title_chars.over_75} 条` +
    ` / 环保词 ${baseline.eco.claims} 条（有证据 ${baseline.eco.with_evidence}）/ oz ${units.oz} gsm ${units.gsm}`,
);
