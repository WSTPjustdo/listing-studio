import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent, IMPLEMENTED_RULE_IDS, PARTIALLY_IMPLEMENTED_RULE_IDS } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";
import { compositionRuns } from "../server/material.mjs";

/**
 * DE-TEXTIL-01 的确定性部分：(EU) 1007/2011 要求的成分标注里，有三条是机器能判的 ——
 *   1. 同一句成分声明里并列的百分比要合计 100 %；
 *   2. 要按占比降序；
 *   3. 写了 100 % 就不能再列第二种带百分比的纤维。
 *
 * 这份文件同时守一条更容易出错的事：**判干净不等于通过**。
 * 这条规则的另外一半（纤维名是否用了德语、成分是否购买前可见）本地判不了，
 * 所以「没找到问题」必须停在 not_checked，不能变成绿色的 pass。
 */

const de = rulePackFor("DE");
const us = rulePackFor("US");
const profile = {
  product_id: "P-DE-TEXTIL", revision: 1, name_zh: "棉布手提袋", material: "Baumwolle",
  width: 38, height: 42, depth: null, fabric_weight_gsm: 140, capacity_l: null,
  handle_length_cm: 60, retail_pack_count: 1, brand: "", color: "natur",
};

const review = (description, pack = de, marketplace = "DE") =>
  reviewContent({
    content: { title: "Baumwolltasche natur, 38 × 42 cm", item_highlights: "", bullet_points: [], description },
    profile,
    rulePack: pack,
    marketplace,
  });
const textile = (r) => r.issues.filter((issue) => issue.rule_id === "DE-TEXTIL-01");
const stateOf = (r) => r.checks.find((check) => check.rule_id === "DE-TEXTIL-01")?.state;

test("DE-TEXTIL-01 只在「部分实现」名单里，不进全量实现名单", () => {
  // 进了 IMPLEMENTED_RULE_IDS 就意味着「本地判完」，那样一句英文成分会拿到绿色 pass。
  assert.equal(IMPLEMENTED_RULE_IDS.has("DE-TEXTIL-01"), false);
  assert.equal(PARTIALLY_IMPLEMENTED_RULE_IDS.has("DE-TEXTIL-01"), true);
});

test("降序且合计 100 % 的写法不报，但也不给 pass（另一半本地判不了）", () => {
  const r = review("Hergestellt aus 65 % Baumwolle, 35 % Polyester, waschbar bei 30 °C.");
  assert.deepEqual(textile(r), []);
  assert.equal(stateOf(r), "not_checked");
  assert.match(r.checks.find((check) => check.rule_id === "DE-TEXTIL-01").reason, /合计、降序、100 % 与多纤维矛盾三项都没有问题/);
});

test("降序写错要报，理由里引的是原文写法", () => {
  const r = review("Hergestellt aus 35 % Polyester, 65 % Baumwolle.");
  const issue = textile(r)[0];
  assert.ok(issue, "降序错误没被报出来");
  assert.equal(stateOf(r), "needs_evidence");
  assert.match(issue.reason, /没有按占比降序/);
  assert.match(issue.reason, /35 % Polyester \+ 65 % Baumwolle/);
  // 严重度来自规则包（needs_review），不该偷偷升成 blocking
  assert.equal(issue.severity, "needs_review");
});

test("合计不足 100 % 要报，并写清合计多少", () => {
  const issue = textile(review("Material: 60 % Baumwolle, 30 % Polyester."))[0];
  assert.ok(issue, "合计 90 % 没被报出来");
  assert.match(issue.reason, /合计 90 %/);
});

test("写了 100 % 又列第二种纤维：一句里两条都点出来", () => {
  const issue = textile(review("100 % Baumwolle, 5 % Polyester – besonders weich."))[0];
  assert.ok(issue);
  assert.match(issue.reason, /合计 105 %/);
  assert.match(issue.reason, /两句不能同时成立/);
});

test("单一纤维 100 % 不报（这是法规要求的正例）", () => {
  const r = review("Hergestellt aus 100 % Baumwolle.");
  assert.deepEqual(textile(r), []);
});

test("「sonstige Fasern」这类认不出的纤维不替商家补事实：只剩一个成分时不判合计", () => {
  // 按规则包 note 里的正例：95 % 棉 + 5 % sonstige Fasern 是合法写法。
  // 引擎只认得 Baumwolle，剩一个成分就不判「合计 95 %」，否则会把合法写法报成错。
  assert.deepEqual(textile(review("95 % Baumwolle, 5 % sonstige Fasern.")), []);
});

test("德语小数逗号不被读成半个数：99,5 % 不许变成 5 %", () => {
  // 99,5 % Baumwolle 若被读成 5 % Baumwolle，再撞上 0,5 % Elasthan 就会凭空报一条「合计 5.5 %」。
  // 现在的做法是：认不出（负数守卫）→ 不判，而不是读错。
  const runs = compositionRuns("99,5 % Baumwolle, 0,5 % Elasthan");
  assert.deepEqual(runs, []);
  assert.deepEqual(textile(review("99,5 % Baumwolle, 0,5 % Elasthan.")), []);
});

test("比价句不算成分声明（than / im Vergleich zu）", () => {
  assert.deepEqual(textile(review("Spart Wasser im Vergleich zu 60 % Baumwolle, 40 % Polyester.")), []);
});

test("美国包里没有这条规则，同样的描述不冒出 DE-TEXTIL-01", () => {
  const r = review("Made of 35 % polyester, 65 % cotton.", us, "US");
  assert.deepEqual(r.issues.filter((issue) => issue.rule_id === "DE-TEXTIL-01"), []);
  assert.equal(r.checks.some((check) => check.rule_id === "DE-TEXTIL-01"), false);
});

// —— 生成侧要和审核侧同一套判据 ——
// 引擎现在会拦「合计不是 100 / 没降序 / 100 % 又列第二种纤维」，
// 提示词里如果只写「100 % Baumwolle 这种写法」，模型就不知道另外三条，生成完自己撞自己。

test("德语生成提示词写明成分三条：合计 100 %、按占比降序、100 % 只配单一纤维", async () => {
  const { buildSystemPrompt } = await import("../server/providers.mjs");
  const prompt = buildSystemPrompt({ rules: de.rules, language: "de", marketplace: "DE" });
  assert.match(prompt, /\(EU\) 1007\/2011/);
  assert.match(prompt, /largest share to the smallest/);
  assert.match(prompt, /total 100 %/);
  assert.match(prompt, /never write 100 % next to a second fibre/);
  // 不许为了凑 100 % 编比例：资料没给就只写纤维名
  assert.match(prompt, /Never invent or re-split percentages/);
  // 上限没有因此被放宽
  assert.match(prompt, /Title <= 75; Item highlights <= 125/);
});
