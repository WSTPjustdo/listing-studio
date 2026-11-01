// 市场基线：把「同类真实在售商品通常怎么写」变成产品能说出口的话。
//
// 这个模块只做三件事：
//   1. 读聚合基线（server/benchmark/baseline-*.json，只有计数和分位，没有别人的原文）
//   2. 量一份 listing 自己的指标
//   3. 给出一组「你 vs 同类」的对照句，每个数字都带样本量
//
// 一条硬规矩：样本只有 45 条，所以话必须说成「45 条里 13 条（29%）」，
// 不许说「市场上普遍」。分位排名只在基线带 sorted 时才算，算不出就直说算不出。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rulePackFor } from "./store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// 环保「证据」：百分比后面必须跟环保属性，或出现可核查的认证名。
// 注意 「100% cotton」是成分，不是证据——第一版把这条算成了证据，11 条误判。
export const ECO_EVIDENCE_PATTERN =
  /\b\d+(?:\.\d+)?\s*%\s*(?:post-?consumer\s+)?(?:recycled|organic|recyclable)\b|\bmade (?:from|with)\s+\d+\s*%\s*recycled|\b(GOTS|OEKO-TEX|GRS|FSC|bluesign)\b|\bcertified\b/i;

export const ECO_WORD_PATTERN =
  /\b(?:eco-?friendly|environmentally friendly|sustainabl[ey]|green|biodegradable|compostable|recycl(?:ed|able)|carbon neutral|carbon footprint|organic)\b/i;

const MEASUREMENT_PATTERN = /\d+(?:\.\d+)?\s*(?:in\b|inch|inches|cm\b|'')/i;
const OZ_PATTERN = /\b\d+(?:\.\d+)?\s*oz\b/i;
const GSM_PATTERN = /\b\d{2,4}\s*(?:gsm|g\/m2|g\/m²)\b/i;
const PACK_PATTERN = /\b\d+\s*[- ]?(?:pack|pcs|pieces|count|set)\b/i;

let cached = null;

export function loadBaseline(file) {
  const target = file ? path.resolve(file) : path.join(here, "benchmark", "baseline-amazon-us-tote.json");
  if (cached && cached.file === target) return cached.data;
  const data = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!data || data.schema !== "market-baseline/1") throw new Error(`基线文件格式不认识：${target}`);
  cached = { file: target, data };
  return data;
}

// 这个仓库里有两套形状：语料是 `bullets: ["…"]`，引擎 content 是
// `bullet_points: [{id, text}]`。第一版只认前者，结果真实样本量出来「0 条要点」，
// 五点与克重的判定全错。两种都要认。
const bulletTexts = (listing) => {
  const raw = listing.bullet_points ?? listing.bullets ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((b) => (typeof b === "string" ? b : (b && b.text) || "")).filter(Boolean);
};

const bodyOf = (listing) =>
  [listing.title || "", ...bulletTexts(listing), listing.description || ""].join(" ").trim();

export function measureListing(listing) {
  const body = bodyOf(listing);
  const title = listing.title || "";
  const bullets = bulletTexts(listing);
  const hasEcoClaim = ECO_WORD_PATTERN.test(body);
  return {
    title_chars: title.length,
    bullet_count: bullets.length,
    has_eco_claim: hasEcoClaim,
    has_eco_evidence: hasEcoClaim && ECO_EVIDENCE_PATTERN.test(body),
    weight_units: { oz: OZ_PATTERN.test(body), gsm: GSM_PATTERN.test(body) },
    has_measurement: MEASUREMENT_PATTERN.test(body),
    declares_pack: PACK_PATTERN.test(body),
  };
}

// 比 x 小或相等的样本占比（0–100 的整数）。算不出就返回 null，不估。
function percentileOf(value, sorted) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  return Math.round((sorted.filter((v) => v <= value).length / sorted.length) * 100);
}

const pct = (x) => `${Math.round(x * 100)}%`;

/**
 * 给出一组对照事实。每条都有 level：
 *   attention —— 建议改（统计上明显偏离，而且偏离方向有风险）
 *   ok        —— 你的做法在同类里是主流
 *   info      —— 只是现状，不代表对错
 */
/**
 * 标题上限的唯一出处是规则包（AMZ-01）。这里原来写死 75，
 * 换一份上限不同的包，报告就会印一个错的阈值。
 * 取不到就返回 null —— 下面宁可不说是否合规，也不猜一个数。
 */
function defaultTitleLimit() {
  const value = rulePackFor("US").rules.find((rule) => rule.rule_id === "AMZ-01")?.constraint?.max_characters;
  return typeof value === "number" ? value : null;
}

export function compareToListing(listing, baseline = loadBaseline(), { titleLimit = defaultTitleLimit() } = {}) {
  const mine = measureListing(listing);
  const scope = baseline.scope;
  const facts = [];
  const add = (key, level, sentence, extra = {}) => facts.push({ key, level, sentence, ...extra });

  // 1. 标题长度
  const t = baseline.title_chars;
  const rank = percentileOf(mine.title_chars, t.sorted);
  const overShare = pct(t.over_75_share);
  if (titleLimit === null) {
    add(
      "title_chars",
      "info",
      `标题 ${mine.title_chars} 字符；${scope.n} 条同类中位 ${t.p50} 字符。当前规则包没有规定标题上限，这里不判定是否合规。`,
      { yours: mine.title_chars, peer: { p50: t.p50, p90: t.p90 } },
    );
  } else if (mine.title_chars > titleLimit) {
    add(
      "title_chars",
      "attention",
      `${scope.n} 条同类在售商品里，标题中位 ${t.p50} 字符，但 ${t.over_75} 条（${overShare}）超过 ${titleLimit} 字符——` +
        `平台的新要求是压到 ${titleLimit} 以内。你现在 ${mine.title_chars} 字符` +
        (rank === null ? "。" : `，比 ${rank}% 的同类都长。`),
      { yours: mine.title_chars, peer: { p50: t.p50, p90: t.p90, over_75_share: t.over_75_share } },
    );
  } else {
    add(
      "title_chars",
      "ok",
      `标题 ${mine.title_chars} 字符，在 ${titleLimit} 以内（${scope.n} 条同类里只有 ${scope.n - t.over_75} 条做到，中位 ${t.p50}）。`,
      { yours: mine.title_chars, peer: { p50: t.p50 } },
    );
  }

  // 2. 五点条数
  const b = baseline.bullet_count;
  const fiveShare = pct(b.five_share);
  if (mine.bullet_count === 5) {
    add("bullet_count", "ok", `五点 5 条，与 ${scope.n} 条同类里的 ${fiveShare} 一致。`, { yours: 5 });
  } else {
    const dist = Object.entries(b.distribution)
      .sort((x, y) => y[1] - x[1])
      .map(([count, n]) => `${n} 条写了 ${count} 点`)
      .join("、");
    add(
      "bullet_count",
      "attention",
      `你有 ${mine.bullet_count} 条要点；${scope.n} 条同类里 ${fiveShare} 写 5 条（${dist}）。条数与平台模板不同，展示位可能对不齐。`,
      { yours: mine.bullet_count, peer: b.distribution },
    );
  }

  // 3. 环保宣称与证据
  const e = baseline.eco;
  if (mine.has_eco_claim && !mine.has_eco_evidence) {
    add(
      "eco",
      "attention",
      `${scope.n} 条同类里 ${e.claims} 条（${pct(e.claim_share)}）用了环保词，但只有 ${e.with_evidence} 条给出可核查证据。` +
        `你的写法落在另外 ${e.claims - e.with_evidence} 条那一类：有词，没有百分比也没有认证。`,
      { yours: "claim_without_evidence", peer: { claims: e.claims, with_evidence: e.with_evidence } },
    );
  } else if (mine.has_eco_claim) {
    add(
      "eco",
      "ok",
      `环保宣称带了可核查的依据——${scope.n} 条同类里只有 ${e.with_evidence} 条做到。`,
      { yours: "claim_with_evidence", peer: { with_evidence: e.with_evidence } },
    );
  } else {
    add(
      "eco",
      "info",
      `没有使用环保词。${scope.n} 条同类里有 ${e.claims} 条（${pct(e.claim_share)}）用了，其中 ${e.with_evidence} 条有证据。`,
      { yours: "none", peer: { claims: e.claims } },
    );
  }

  // 4. 克重单位（本地化的具体证据：美国买家按 oz 读）
  const u = baseline.units;
  if (mine.weight_units.gsm && !mine.weight_units.oz) {
    add(
      "weight_unit",
      "attention",
      `${scope.n} 条同类里 ${u.oz} 条用 oz 标克重（${pct(baseline.weight_unit_share.oz)}），${u.gsm} 条用 gsm。` +
        `你只写了 gsm，美国买家需要自己换算。`,
      { yours: "gsm_only", peer: u },
    );
  } else if (mine.weight_units.oz) {
    add(
      "weight_unit",
      "ok",
      `克重用了 oz，与 ${scope.n} 条同类里 ${pct(baseline.weight_unit_share.oz)} 的做法一致。`,
      { yours: "oz" },
    );
  }

  // 5. 正文有没有具体测量值
  if (!mine.has_measurement) {
    add(
      "measurement",
      "attention",
      `${scope.n} 条同类里 ${baseline.measurement_in_text} 条在正文写了具体尺寸数值（in / cm），你这条没有。`,
      { yours: false, peer: { with_measurement: baseline.measurement_in_text } },
    );
  }

  // 6. 包装数
  if (!mine.declares_pack && baseline.pack_listed > 0) {
    add(
      "pack",
      "info",
      `${scope.n} 条同类里只有 ${baseline.pack_listed} 条（${pct(baseline.pack_listed / scope.n)}）写明包装数。不写不算错，但买家会问。`,
      { yours: false, peer: { pack_listed: baseline.pack_listed } },
    );
  }

  return {
    baseline: { scope, generated_from: baseline.scope.sample_date },
    measured: mine,
    facts,
    attention: facts.filter((f) => f.level === "attention").length,
  };
}

// 给报告用的一段一句话摘要，避免把 6 条都塞到人眼前。
export function summaryLine(result) {
  const { scope } = result.baseline;
  if (result.attention === 0) {
    return `与 ${scope.n} 条同类在售商品相比，没有明显偏离的写法（口径：${scope.category} / ${scope.marketplace}，${scope.sample_date} 快照）。`;
  }
  return (
    `与 ${scope.n} 条同类在售商品相比，有 ${result.attention} 处写法偏离主流，` +
    `其中 ${result.facts.filter((f) => f.level === "attention").map((f) => LABEL[f.key] || f.key).join("、")}。`
  );
}

export const LABEL = {
  title_chars: "标题长度",
  bullet_count: "五点条数",
  eco: "环保宣称证据",
  weight_unit: "克重单位",
  measurement: "尺寸数值",
  pack: "包装数",
};
