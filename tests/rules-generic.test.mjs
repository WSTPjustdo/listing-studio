import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";

/**
 * 「规则是数据，不是散在代码里的 if」——这句话得拿检查本身验，不是靠架构图。
 *
 * 原来标题那两条确定性检查是按 id 取的（`rules.get("DE-TITLE-02")`），
 * 换一个市场（英国站复用同一批平台规则、只是 id 前缀不同）就一条都不跑，
 * 而检查清单上还显示「通过」。这份文件把「同一个 constraint、换个 id 照样跑」钉住。
 */

const de = rulePackFor("DE");
const us = rulePackFor("US");
const profile = {
  product_id: "P-GENERIC", revision: 1, name_zh: "棉布手提袋", material: "Baumwolle",
  width: 38, height: 42, depth: null, fabric_weight_gsm: 140, capacity_l: null,
  handle_length_cm: 60, retail_pack_count: 1, brand: "", color: "natur",
};
const content = (title) => ({ title, item_highlights: "", bullet_points: [], description: "" });

/** 把德国包的两条标题规则改成别的 id，模拟「另一个市场复用同一批平台规则」。 */
const renamed = {
  ...de,
  rules: de.rules.map((rule) =>
    rule.rule_id === "DE-TITLE-02"
      ? { ...rule, rule_id: "XX-TITLE-02" }
      : rule.rule_id === "DE-TITLE-03"
        ? { ...rule, rule_id: "XX-TITLE-03" }
        : rule,
  ),
};

test("换个 id，同一个 constraint 照样跑：结论挂在包自己的规则号上", () => {
  const review = reviewContent({
    content: content("Baumwolltasche_Bio! Baumwolltasche Baumwolltasche"),
    profile,
    rulePack: renamed,
    marketplace: "DE",
  });
  const ids = new Set(review.issues.map((issue) => issue.rule_id));
  assert.ok(ids.has("XX-TITLE-02"), "重复词检查没有跟着 constraint 走");
  assert.ok(ids.has("XX-TITLE-03"), "禁用字符检查没有跟着 constraint 走");
  assert.equal(ids.has("DE-TITLE-02") || ids.has("DE-TITLE-03"), false, "改了 id 还在报旧 id，说明代码里另有写死的地方");
});

test("没声明这两个 constraint 的包（美国站）一条都不跑", () => {
  const review = reviewContent({
    content: content("Cotton Tote Bag Cotton Tote Bag Cotton_Bag!"),
    profile: null,
    rulePack: us,
    marketplace: "US",
  });
  assert.equal(review.issues.some((issue) => issue.rule_id.startsWith("DE-TITLE")), false);
  assert.equal(review.issues.some((issue) => issue.rule_id.startsWith("XX-")), false);
});

test("德国包原样照跑（改法不许把德国站自己的两条弄丢）", () => {
  const review = reviewContent({
    content: content("Baumwolltasche_Bio! Baumwolltasche Baumwolltasche"),
    profile,
    rulePack: de,
    marketplace: "DE",
  });
  const ids = new Set(review.issues.map((issue) => issue.rule_id));
  assert.ok(ids.has("DE-TITLE-02"));
  assert.ok(ids.has("DE-TITLE-03"));
});
