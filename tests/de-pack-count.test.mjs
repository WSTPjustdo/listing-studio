import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";

/**
 * 德语里的零售件数写法（`Lieferumfang: 1 Tasche`、`10er-Pack`、`4 Stück`）。
 *
 * 为什么补这条：2026-10-31 那次真实德语生成，描述和五点里各写了一遍
 * `Lieferumfang: 1 Tasche`，引擎认不出这个 `1` 指的是什么，
 * 于是同一件事报了两条「数值尚不能明确关联到具体商品字段和单位」。
 * 商家没法按这条改稿（他写的就是对的），演示里也会变成「生成完还有 2 条改不掉的问题」。
 *
 * 判据只有一条：**认得出 → 拿去和档案的零售件数比**。对得上就是通过，
 * 对不上就是真冲突（那是商家该改的），绝不让它落回「读不懂」。
 */

const de = rulePackFor("DE");
const fact = (value) => ({ value, status: "public_source", source_ids: ["S-TEST"] });
const base = {
  product_id: "P-DE-PACK", revision: 1, name_zh: "棉布手提袋", is_demo: false, reference_product_id: "W101",
  material: fact("100% cotton"), fabric_weight_gsm: fact(140), dimensions_cm: fact({ width: 38, height: 42 }),
  capacity_l: fact(null), handle_length_cm: fact(null), retail_pack_count: fact(1),
  brand: fact("Westford Mill"), color: fact(null), rated_load_kg: fact(null),
  additional_facts: [], degradation_evidence: [], certification_evidence: [], performance_evidence: [],
};

const review = (text, pack = 1) =>
  reviewContent({
    content: {
      title: "Baumwolltasche, 38 × 42 cm",
      item_highlights: "",
      bullet_points: [{ id: "b1", text }],
      description: "",
    },
    profile: { ...base, retail_pack_count: fact(pack) },
    rulePack: de,
    marketplace: "DE",
  });
const ids = (r) => r.issues.map((issue) => issue.rule_id);

test("Lieferumfang: 1 Tasche 与档案 1 件一致：不再报「数值读不懂」", () => {
  const r = review("Lieferumfang: 1 Tasche");
  assert.deepEqual(ids(r), [], `不该有问题，实际：${r.issues.map((i) => `${i.rule_id}/${i.reason}`).join(" | ")}`);
});

test("10er-Pack / 4 Stück 认成件数：对得上就通过", () => {
  assert.deepEqual(ids(review("4 Stück", 4)), []);
  assert.deepEqual(ids(review("Praktischer 10er-Pack", 10)), []);
});

test("件数对不上时是真冲突，不是「读不懂」", () => {
  // 档案 4 件、文案写 1 件 —— 这是商家该改的，必须报 AMZ-05 而不是 EVID-01
  const mismatch = review("Lieferumfang: 1 Tasche", 4);
  assert.ok(ids(mismatch).includes("AMZ-05"), `实际：${ids(mismatch).join(",")}`);
  assert.equal(ids(mismatch).includes("EVID-01"), false, "件数冲突不该退化成「数值读不懂」");
});

test("英文件数写法不受影响（`Package includes: 1 tote bag` 仍按英文规则判）", () => {
  // 英语里 "1 tote bag" 这种写法原本就不进 retail_pack_count 的正则（`N x Bags` 才进），
  // 这里只确认新加的德语句式不会把它误认成件数冲突。
  const r = review("Package includes: 1 tote bag", 4);
  assert.equal(ids(r).includes("AMZ-05"), false, "英文句子被德语规则误判成件数冲突");
});
