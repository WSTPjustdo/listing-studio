import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";
import { parseComposition } from "../server/material.mjs";

/**
 * 小数逗号（`99,5 %`）在**证据层**必须被当成一个完整的数。
 *
 * 为什么这条值得单独钉：我们自己的德语/法语生成指令里就写着「小数用逗号（99,5 %）」。
 * 修之前，`99,5 % Baumwolle, 0,5 % Elasthan` 会被读成 `5 %` 和 `0 %`，
 * 于是一句**完全合规**的德语同时报「含量 5% 与档案不一致」和「这个百分比没说清指什么」——
 * 把自己要求写对的格式判成错。2026-10-31 复现，修前同一条文案 4 个假数值。
 *
 * 注意这一层和 `compositionRuns` 的分工：那边算的"合计多少"直接进报告结论，
 * 目前**故意不认**小数逗号（认不出就不判，见 tests/de-textil.test.mjs 里那条）。
 * 这里管的是"要不要指控商家"，认错一个数就会冤枉人，所以必须认。
 */

const P = (value) => ({ value, status: "merchant_confirmed", source_ids: ["LOCAL-MERCHANT-INPUT"] });
const profile = (material) => ({
  product_id: "P-DECIMAL", revision: 1, name_zh: "棉布手提袋",
  material: P(material),
  dimensions_cm: P({ width: 38, height: 42 }),
  fabric_weight_gsm: P(140),
  capacity_l: P(10),
  handle_length_cm: P(60),
  retail_pack_count: P(1),
  brand: P("Beispiel"),
  color: P("natur"),
  rated_load_kg: { value: null, status: "unknown", source_ids: [] },
  additional_facts: [],
});

const review = (material, description, marketplace = "DE") =>
  reviewContent({
    content: { title: "Baumwolltasche natur", item_highlights: "", bullet_points: [], description },
    profile: profile(material),
    rulePack: rulePackFor(marketplace),
    marketplace,
  });

const evidence = (r) => r.evidence || [];
const links = (r) => evidence(r).flatMap((item) => item.parameter_links || []);
const uncovered = (r) => evidence(r).flatMap((item) => item.not_covered_parameters || []);
const evid01 = (r) => r.issues.filter((issue) => issue.rule_id === "EVID-01");

test("99,5 被读成 99.5，不是 5", () => {
  assert.deepEqual(parseComposition("99,5 % Baumwolle, 0,5 % Polyester").ingredients, [
    { fiber: "cotton", percent: 99.5 },
    { fiber: "polyester", percent: 0.5 },
  ]);
});

test("一句合规的德语小数逗号成分不再触发 EVID-01", () => {
  const r = review("99,5 % Baumwolle, 0,5 % Polyester", "Hergestellt aus 99,5 % Baumwolle, 0,5 % Polyester, Henkel 60 cm.");
  assert.deepEqual(evid01(r), [], `不该有 EVID-01，实际：${JSON.stringify(evid01(r).map((x) => x.reason))}`);
});

test("小数逗号的那个数按整段 99,5 % 登记，不按半截 5 % 登记", () => {
  const r = review("99,5 % Baumwolle, 0,5 % Polyester", "Hergestellt aus 99,5 % Baumwolle, 0,5 % Polyester.");
  const cotton = links(r).filter((link) => link.field === "material");
  const originals = cotton.map((link) => link.original);
  assert.ok(originals.includes("99,5 %"), `原件里没有整段 99,5 %：${originals}`);
  assert.ok(!originals.includes("5 %"), `出现半截数：${originals}`);
});

test("认不出的纤维名不再被判成「商家没说清」", () => {
  // Elasthan 不在本地认得的那几种纤维里（只认棉/涤纶/尼龙/亚麻）。原文说得很清楚，
  // 是我们认不出这个词——按这一层的总原则落 not_covered，不算商家缺证据。
  const r = review("99,5 % Baumwolle, 0,5 % Polyester", "Hergestellt aus 99,5 % Baumwolle, 0,5 % Elasthan.");
  assert.deepEqual(evid01(r), []);
  const unknown = uncovered(r).filter((link) => link.method === "composition_fiber_outside_known_fibers");
  assert.equal(unknown.length, 1);
  assert.match(unknown[0].reason, /Elasthan/);
});

test("没有配方语境的百分比仍按「没说清指什么」报（别把这条放宽成什么都不报）", () => {
  // `100% Premium 18 oz.` 后面跟的 Premium 也是大写词，但这句没有配方语境，
  // 仍然要请商家说明这个百分比是什么。
  const r = review("100% cotton", "HIGH QUALITY CANVAS - 100% Premium 18 oz.", "US");
  const issues = evid01(r);
  assert.equal(issues.length, 1);
  assert.match(issues[0].reason, /没说清它是/);
});

test("英语小数点写法不受影响", () => {
  const r = review("99.5% cotton, 0.5% polyester", "Made of 99.5% cotton, 0.5% polyester.", "US");
  assert.deepEqual(evid01(r), []);
});
