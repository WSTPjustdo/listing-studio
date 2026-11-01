import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";

/**
 * 法语的提手长度写法 —— 和德语 `Henkellänge beträgt 67 cm` 是同一类误报：
 * 认不出来就落进「读不懂的数值」，而档案里明明有这一项。
 *
 * `anses de 60 cm` / `poignées de 60 cm` / `60 cm de long` 三种形态。
 * 第三种必须后面跟 anse/poignée：光写「60 cm de long」不知道在说哪个部位，
 * 认成提手就是替商家猜。
 */

const P = (value) => ({ value, status: "merchant_confirmed", source_ids: ["LOCAL-MERCHANT-INPUT"] });
const profile = {
  product_id: "P-FR-HANDLE", revision: 1, name_zh: "棉布手提袋",
  material: P("100% coton"),
  dimensions_cm: P({ width: 38, height: 42 }),
  fabric_weight_gsm: P(140),
  capacity_l: P(10),
  handle_length_cm: P(60),
  retail_pack_count: P(1),
  brand: P("Exemple"),
  color: P("naturel"),
  rated_load_kg: { value: null, status: "unknown", source_ids: [] },
  additional_facts: [],
};

const review = (text) =>
  reviewContent({
    content: { title: "Sac en coton", item_highlights: "", bullet_points: [], description: text },
    profile,
    rulePack: rulePackFor("US"),
    marketplace: "US",
  });

const links = (r) => (r.evidence || []).flatMap((item) => item.parameter_links || []);
const evid01 = (r) => r.issues.filter((issue) => issue.rule_id === "EVID-01");

test("anses de 60 cm 认成提手长度，不再报「读不懂的数值」", () => {
  const r = review("Fabriqué en 100 % coton, anses de 60 cm.");
  assert.deepEqual(evid01(r), []);
  const handle = links(r).filter((link) => link.field === "handle_length_cm");
  assert.equal(handle.length, 1);
  assert.equal(handle[0].method, "handle_length_fr_wording");
  assert.equal(handle[0].parsed_value, 60);
});

test("poignées de 60,5 cm 也认，并按小数逗号读成 60.5", () => {
  // 档案写 60，文案写 60,5 —— 读对才会报这一条冲突。若读成 5 或 60，这里就不是冲突了。
  const r = review("Fabriqué en 100 % coton, poignées de 60,5 cm.");
  const conflict = r.issues.filter((issue) => issue.rule_id === "AMZ-05");
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0].original, "poignées de 60,5 cm");
});

test("60 cm de long 后面没有 anse/poignée 时不猜成提手", () => {
  const r = review("Fabriqué en 100 % coton, 60 cm de long.");
  assert.equal(links(r).filter((link) => link.field === "handle_length_cm").length, 0);
});

test("德语写法照旧能认（别为了加法语碰坏德语）", () => {
  const de = reviewContent({
    content: { title: "Baumwolltasche", item_highlights: "", bullet_points: [], description: "Hergestellt aus 100 % Baumwolle, Henkellänge beträgt 60 cm." },
    profile, rulePack: rulePackFor("DE"), marketplace: "DE",
  });
  const handle = (de.evidence || []).flatMap((item) => item.parameter_links || []).filter((link) => link.field === "handle_length_cm");
  assert.equal(handle.length, 1);
  assert.equal(handle[0].method, "handle_length_de_wording");
});
