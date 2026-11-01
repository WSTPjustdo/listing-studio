import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";
import { parseComposition, canonicalFiber } from "../server/material.mjs";

/**
 * 法语纤维名（`coton` / `lin`）—— 第四门语言的第一个"会认错"的地方。
 *
 * 修之前：`100 % coton` 里的 coton 不在词表里，百分比就成了"没有说明对象的百分比"，
 * 一句完全合规的法语文案凭空一条 EVID-01；和法语商品资料对照也永远对不上。
 *
 * 出处（不是凭"法语一般这么写"）：(EU) 1007/2011 附件 I 表 1
 *   第 5 行法文版「coton (m.) — fibre provenant des graines du cotonnier (Gossypium)」
 *   第 7 行法文版「lin (m.) — fibre provenant du liber du lin (Linum usitatissimum)」
 *   EUR-Lex CELEX 32011R1007 法文版 ANNEXE I Tableau 1（OJ L 272/1 FR），核验 2026-10-31。
 * 法语里 polyester / polyamide 与英文同词，所以不用另加。
 */

const P = (value) => ({ value, status: "merchant_confirmed", source_ids: ["LOCAL-MERCHANT-INPUT"] });
const profile = (material) => ({
  product_id: "P-FR", revision: 1, name_zh: "棉布手提袋",
  material: P(material),
  dimensions_cm: P({ width: 38, height: 42 }),
  fabric_weight_gsm: P(140),
  capacity_l: P(10),
  handle_length_cm: P(60),
  retail_pack_count: P(1),
  brand: P("Exemple"),
  color: P("naturel"),
  rated_load_kg: { value: null, status: "unknown", source_ids: [] },
  additional_facts: [],
});

// 法语是语言层：站点仍是美国站（法国站规则包没接），所以用 US 包跑。
const review = (material, description) =>
  reviewContent({
    content: { title: "Sac en coton naturel", item_highlights: "", bullet_points: [], description },
    profile: profile(material),
    rulePack: rulePackFor("US"),
    marketplace: "US",
  });

const evid01 = (r) => r.issues.filter((issue) => issue.rule_id === "EVID-01");

test("coton / lin 都换成同一个标准纤维名", () => {
  assert.equal(canonicalFiber("coton"), "cotton");
  assert.equal(canonicalFiber("lin"), "linen");
  // 英法同词的两种不能因为加了法语就认错
  assert.equal(canonicalFiber("polyester"), "polyester");
  assert.equal(canonicalFiber("polyamide"), "nylon");
});

test("100 % coton 不再报「这个百分比没说清指什么」", () => {
  const r = review("100% coton", "Fabriqué en 100 % coton, anses de 60 cm.");
  assert.deepEqual(evid01(r).map((issue) => issue.reason).filter((reason) => /没说清它是/.test(reason)), []);
});

test("法语的成分对照得上法语商品资料", () => {
  const r = review("60% coton, 40% lin", "Composition : 60 % coton, 40 % lin.");
  const conflicts = r.issues.filter((issue) => issue.rule_id === "AMZ-05");
  assert.deepEqual(conflicts.map((issue) => issue.reason), []);
});

test("法语文案里的英文写法不按德语规则报（本地没有法语写法规则，不替商家判）", () => {
  // DE-TEXTIL-01 只在德国包里；法语文案走美国包，不该冒出"要用德文写"这种结论。
  const r = review("100% coton", "Fabriqué en 100 % cotton.");
  assert.equal(r.issues.filter((issue) => issue.rule_id === "DE-TEXTIL-01").length, 0);
});

test("成分解析把法语写法按同一套规则算", () => {
  assert.deepEqual(parseComposition("60 % coton, 40 % lin").ingredients, [
    { fiber: "cotton", percent: 60 },
    { fiber: "linen", percent: 40 },
  ]);
});
