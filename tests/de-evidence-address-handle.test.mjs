import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";

/**
 * 第 9 轮真模型跑德语时抓到的两类误报 —— 都发生在**完全合规**的德语上：
 *
 * ① GPSR 要求文案里写制造商与欧盟责任人的邮政地址，地址里的门牌号（2 / 18）和
 *    邮编（20095 / 518000）被当成"读不懂的数值"，两家公司各报两条，一条文案多出 4 条 EVID-01。
 * ② 提手长度写成德语（`Henkellänge beträgt 67 cm`）认不出来，"67" 又落进"读不懂"，
 *    而档案里明明有 67 —— 一次生成多出 3 条 EVID-01。
 *
 * 这跟第 8 轮那个坑是同一类：合规写法被自己的解析器判成问题。修法都是**加窄模式**：
 * 地址只认「街道词 + 门牌号」和「4–6 位数字 + 首字母大写城市」两种形态；
 * 提手只认德语那几个词，中间窗口不许出现别的数字。
 */

const P = (value) => ({ value, status: "merchant_confirmed", source_ids: ["LOCAL-MERCHANT-INPUT"] });
const profile = {
  product_id: "P-HANDLE",
  revision: 1,
  name_zh: "长提手棉布袋",
  material: P("100% Baumwolle"),
  dimensions_cm: P({ width: 38, height: 42 }),
  fabric_weight_gsm: P(140),
  capacity_l: P(10),
  handle_length_cm: P(67),
  retail_pack_count: P(1),
  brand: P("Beispiel"),
  color: P("natur"),
  rated_load_kg: { value: null, status: "unknown", source_ids: [] },
  additional_facts: [],
};

const review = (text) =>
  reviewContent({
    content: { title: "Baumwolltasche", item_highlights: "", bullet_points: [{ id: "b1", text }], description: "" },
    profile,
    rulePack: rulePackFor("DE"),
    marketplace: "DE",
  });

const evidenceOf = (text) => review(text).evidence || [];
/** 认得出、但档案里没有对应字段的参数（地址就走这一档）。 */
const notCovered = (text) =>
  evidenceOf(text).flatMap((entry) => entry.not_covered_parameters || []);
/** 真正关联到档案字段的参数。 */
const links = (text) => evidenceOf(text).flatMap((entry) => entry.parameter_links || []);

test("GPSR 地址块里的门牌号与邮编不再报「数值读不懂」", () => {
  const text = "Hersteller: Beispiel Textil Co., Ltd., Baogang Road 18, 518000 Shenzhen, China. EU-Verantwortlicher: Beispiel EU GmbH, Hauptstraße 2, 20095 Hamburg, Deutschland.";
  const out = review(text);
  assert.deepEqual(out.issues, [], "地址是法规要求写的，不该因此报问题");
  const addressEntries = notCovered(text).filter((entry) => entry.field === "postal_address");
  // 两家公司 × 两段（街道门牌 / 邮编城市）= 4 处，全部登记成 not_covered
  assert.equal(addressEntries.length, 4, "地址的每一段都要登记成 not_covered");
  const labels = new Set(addressEntries.map((entry) => entry.field_label));
  assert.ok(labels.has("地址（街道与门牌号）"));
  assert.ok(labels.has("地址（邮编与城市）"));
  for (const entry of addressEntries) {
    assert.equal(entry.status, "not_covered", "地址不是商品参数，只登记不判定");
    assert.match(entry.reason, /不是商品参数/);
  }
});

test("地址登记成「不在检查范围」，不占「证据待补」的名额", () => {
  const text = "Hersteller: Beispiel GmbH, Hauptstraße 2, 20095 Hamburg.";
  const out = review(text);
  const check = out.evidence
    .flatMap((entry) => entry.not_covered_parameters || [])
    .find((entry) => entry.field === "postal_address");
  assert.ok(check, "地址要登记成 not_covered");
  assert.equal(out.missing_data.some((item) => /postal_address|地址/.test(item.label || "")), false);
});

test("德语提手长度：与档案一致就不报问题", () => {
  for (const text of [
    "Die Henkellänge beträgt 67 cm.",
    "Henkel sind 67 cm lang.",
    "Lange Henkel mit 67 cm.",
    "Tragehenkel: 67 cm.",
  ]) {
    assert.deepEqual(review(text).issues, [], text);
  }
});

test("德语提手长度写成 67,5 cm（小数逗号）也读得懂", () => {
  const out = review("Die Henkellänge beträgt 67,5 cm.");
  // 档案是 67 —— 67,5 应当被当成"与档案不一致"，而不是"读不懂"
  const issue = out.issues.find((item) => item.rule_id === "AMZ-05");
  assert.ok(issue, "小数逗号要被读成 67.5，然后按不一致报冲突");
  assert.match(issue.reason, /不一致|冲突/);
});

test("德语提手与档案不一致：报冲突，不静默通过", () => {
  const out = review("Die Henkellänge beträgt 60 cm.");
  const issue = out.issues.find((item) => item.rule_id === "AMZ-05");
  assert.ok(issue, "60 ≠ 67 必须报");
  assert.match(issue.original, /60 cm/);
});

test("中间夹着别的数字时不认：`Henkel: 2 Stück, Länge 67 cm` 不许把 2 当提手长度", () => {
  const entries = links("Henkel: 2 Stück, Länge 67 cm.").filter(
    (entry) => entry.field === "handle_length_cm",
  );
  // 一句两处：2 是件数/个数，67 才是长度。允许 67 被认到，绝不允许 2 被当成 67 cm。
  for (const entry of entries)
    assert.notEqual(String(entry.parsed_value), "2", "2 不许当提手长度");
});

test("`1000 Stück` 不会被当成邮编（数量写法要排除）", () => {
  const entries = notCovered("Lieferumfang: 1000 Stück.").filter(
    (entry) => entry.field === "postal_address",
  );
  assert.equal(entries.length, 0, "1000 Stück 是件数，不是邮编 + 城市");
});

test("美国站文案不受影响：English 的提手写法照旧认", () => {
  const out = reviewContent({
    content: {
      title: "Cotton tote bag",
      item_highlights: "",
      bullet_points: [{ id: "b1", text: "Handle length: 67 cm." }],
      description: "",
    },
    profile,
    rulePack: rulePackFor("US"),
    marketplace: "US",
  });
  assert.equal(out.issues.filter((item) => item.rule_id === "AMZ-05").length, 0);
});
