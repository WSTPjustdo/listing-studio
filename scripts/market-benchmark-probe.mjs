// 市场基线的量具：拿真实在售文案跑一遍「你 vs 同类」，看结论站不站得住。
//
// 用法：
//   node scripts/market-benchmark-probe.mjs                 # 默认跑 3 条真实语料
//   node scripts/market-benchmark-probe.mjs --asin B0DX7C3T18
//   node scripts/market-benchmark-probe.mjs --strict        # 结构判据，出退出码
//
// --strict 判的是「这个功能有没有在瞎说话」，不是「文案好不好」：
//   a) 一份明确合规的 listing（标题短、五点齐全、无环保词、oz、有尺寸）必须 0 条 attention
//   b) 一份明确有毛病的 listing（超长标题、4 条要点、eco 无证据、只有 gsm）必须 ≥ 4 条 attention
// 任何一条不成立，说明对照逻辑错了，退出 1。

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { compareToListing, loadBaseline, summaryLine, LABEL } from "../server/market-benchmark.mjs";
import { listingContent, loadSample } from "./sample-listings.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.join(here, "..", "..", "qa", "research", "listings-20261030.json");
const args = process.argv.slice(2);
const strict = args.includes("--strict");
const asinArg = args.indexOf("--asin") >= 0 ? args[args.indexOf("--asin") + 1] : null;

const baseline = loadBaseline();

function show(label, content) {
  const result = compareToListing(content, baseline);
  console.log(`\n── ${label} ──`);
  console.log(summaryLine(result));
  for (const fact of result.facts) {
    const mark = fact.level === "attention" ? "! " : fact.level === "ok" ? "✓ " : "· ";
    console.log(`${mark}${LABEL[fact.key] || fact.key}：${fact.sentence}`);
  }
  return result;
}

const CLEAN = {
  title: "Cotton Canvas Tote Bag, 15 x 16 in, 12 oz, Reusable Grocery Bag",
  bullet_points: [
    { id: "b1", text: "Size: 15 x 16 x 4 in." },
    { id: "b2", text: "12 oz cotton canvas." },
    { id: "b3", text: "Holds up to 10 kg." },
    { id: "b4", text: "Machine washable." },
    { id: "b5", text: "1 pack." },
  ],
  description: "Everyday canvas tote.",
};

const BAD = {
  title:
    "Premium Heavy Duty Extra Large Cotton Canvas Tote Bag Reusable Grocery Shopping Bag with Reinforced Handles for Beach Travel School Work Daily Use Eco Friendly Sustainable",
  bullet_points: [
    { id: "b1", text: "Eco-friendly and sustainable, good for the planet." },
    { id: "b2", text: "Made of 320 gsm cotton canvas." },
    { id: "b3", text: "Large capacity." },
    { id: "b4", text: "Nice bag." },
  ],
  description: "A tote bag.",
};

if (strict) {
  const cleanResult = compareToListing(CLEAN, baseline);
  const badResult = compareToListing(BAD, baseline);
  const checks = [
    ["合规样本 0 条 attention", cleanResult.attention === 0, `实际 ${cleanResult.attention} 条`],
    ["问题样本 ≥ 4 条 attention", badResult.attention >= 4, `实际 ${badResult.attention} 条`],
    [
      "问题样本必须抓到 eco 无证据",
      badResult.facts.some((f) => f.key === "eco" && f.level === "attention"),
      "没抓到 eco",
    ],
    [
      "问题样本必须抓到 gsm 单用",
      badResult.facts.some((f) => f.key === "weight_unit" && f.level === "attention"),
      "没抓到单位",
    ],
    ["合规样本必须抓到 oz 用法正确", cleanResult.facts.some((f) => f.key === "weight_unit" && f.level === "ok"), "没认 oz"],
  ];
  let bad = 0;
  console.log(`\n市场基线结构判据（n=${baseline.scope.n}，快照 ${baseline.scope.sample_date}）`);
  for (const [name, ok, detail] of checks) {
    if (!ok) bad += 1;
    console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` —— ${detail}`}`);
  }
  console.log(bad === 0 ? "\n全部通过" : `\n${bad} 条不通过`);
  process.exit(bad === 0 ? 0 : 1);
}

const { items } = loadSample(corpusPath);
if (items.length === 0) {
  console.error(`语料读不出条目：${corpusPath}`);
  process.exit(1);
}

const picked = asinArg ? items.filter((x) => x.asin === asinArg) : items.slice(0, 3);
if (picked.length === 0) {
  console.error(`语料里没有 ASIN ${asinArg}`);
  process.exit(1);
}
for (const item of picked) show(`真实在售 ${item.asin}`, listingContent(item));
console.log(`\n基线：${baseline.scope.n} 条 ${baseline.scope.category}（${baseline.scope.marketplace}），${baseline.scope.sample_date} 快照`);
