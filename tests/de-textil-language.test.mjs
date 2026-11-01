import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent, IMPLEMENTED_RULE_IDS, PARTIALLY_IMPLEMENTED_RULE_IDS } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";
import { compositionRuns } from "../server/material.mjs";

/**
 * DE-TEXTIL-01 剩下两半（第 6 轮）：
 *   ④ 纤维名是不是德语 —— 英文写法**取代**德语才报，并列补充不报；
 *   ⑤ 成分是否购买前可见 —— 只有"资料写得出成分、文案里一处成分都没有"才报。
 *
 * 两条都是"宁可漏报不误报"：认不出的纤维（Wolle / Viskose / sonstige Fasern）、
 * 复合词商品名（Baumwolltasche）、并列的英文补充，一律不许变成红色。
 * 这一条规则仍然不进 IMPLEMENTED_RULE_IDS（还是不给 pass），此处同时钉住这一点。
 */

const de = rulePackFor("DE");
const us = rulePackFor("US");
const profile = {
  product_id: "P-DE-TEXTIL-LANG", revision: 1, name_zh: "棉布手提袋", material: "100% cotton",
  width: 38, height: 42, depth: null, fabric_weight_gsm: 140, capacity_l: null,
  handle_length_cm: 60, retail_pack_count: 1, brand: "", color: "natur",
};

const review = (description, { pack = de, marketplace = "DE", title = "Baumwolltasche natur, 38 × 42 cm", record = profile } = {}) =>
  reviewContent({
    content: { title, item_highlights: "", bullet_points: [], description },
    profile: { ...profile, ...record },
    rulePack: pack,
    marketplace,
  });
const textile = (r) => r.issues.filter((issue) => issue.rule_id === "DE-TEXTIL-01");
const stateOf = (r) => r.checks.find((check) => check.rule_id === "DE-TEXTIL-01")?.state;

test("成分句用英文纤维名要报（100 % Cotton），并指出该写 Baumwolle", () => {
  const r = review("Robuste Tasche aus 100 % Cotton.");
  const issue = textile(r)[0];
  assert.ok(issue, "英文纤维名没被报出来");
  assert.match(issue.reason, /英文纤维名/);
  assert.match(issue.reason, /Baumwolle/);
  assert.equal(issue.severity, "needs_review");
  assert.equal(stateOf(r), "needs_evidence");
});

test("英文与德文并列出现时不算违规（其他语言只作补充）", () => {
  const r = review("Robuste Tasche aus 100 % Baumwolle (100 % cotton).");
  assert.deepEqual(textile(r), []);
  assert.equal(stateOf(r), "not_checked");
});

test("polyester / nylon 两地同词，本地不判（不许凭印象说它是英文）", () => {
  const r = review("Außenmaterial aus 100 % polyester.");
  assert.deepEqual(textile(r), []);
});

test("复合词商品名不是成分声明：Baumwolltasche 未写德语成分时，英文成分仍然要报", () => {
  // 标题里有 Baumwolltasche（商品名），描述里只有英文成分 —— 这正是"英文取代了德语"。
  const r = review("Robuste Tasche aus 100 % Cotton.", { title: "Baumwolltasche 38 × 42 cm" });
  assert.ok(textile(r).length, "复合词被当成了德语成分声明");
});

test("资料写得出成分、文案里一处成分都没有 → 报「买家购买前看不到」", () => {
  const r = review("Praktische Tasche für den Einkauf, mit langen Henkeln.", { title: "Stofftasche natur, 38 × 42 cm" });
  const issue = textile(r)[0];
  assert.ok(issue, "成分不可见没被报出来");
  assert.match(issue.reason, /购买前要能看到纤维成分/);
  assert.equal(issue.field_path, "content.description");
});

test("文案里出现了百分比但纤维名认不出（Wolle）→ 不判「不可见」（认不出不等于没写）", () => {
  const r = review("Hergestellt aus 100 % Wolle.", { title: "Stofftasche natur" });
  assert.deepEqual(textile(r), []);
});

test("资料里认不出纤维（不是纺织品）→ 不要求文案写成分", () => {
  const r = review("Aufbewahrungsbox aus Kunststoff, 30 × 20 × 15 cm.", {
    title: "Aufbewahrungsbox 30 × 20 × 15 cm",
    record: { material: "Kunststoff" },
  });
  assert.deepEqual(textile(r), []);
});

test("美国包没有这条规则：同样的英文成分与缺成分文案都不冒出 DE-TEXTIL-01", () => {
  const r = review("Made of 100 % Cotton.", { pack: us, marketplace: "US", title: "Cotton tote bag" });
  assert.deepEqual(r.issues.filter((issue) => issue.rule_id === "DE-TEXTIL-01"), []);
  assert.equal(r.checks.some((check) => check.rule_id === "DE-TEXTIL-01"), false);
});

test("两半都跑了也仍然不给 pass", () => {
  assert.equal(IMPLEMENTED_RULE_IDS.has("DE-TEXTIL-01"), false);
  assert.equal(PARTIALLY_IMPLEMENTED_RULE_IDS.has("DE-TEXTIL-01"), true);
  const r = review("Hergestellt aus 100 % Baumwolle, waschbar bei 30 °C.");
  assert.deepEqual(textile(r), []);
  const check = r.checks.find((x) => x.rule_id === "DE-TEXTIL-01");
  assert.equal(check.state, "not_checked");
  assert.match(check.reason, /仍需人工复核/);
});

test("compositionRuns 标出英文写法，德语写法不标", () => {
  const [english] = compositionRuns("100 % Cotton");
  assert.equal(english.parts[0].english_only, true);
  assert.equal(english.parts[0].word, "Cotton");
  const [german] = compositionRuns("100 % Baumwolle");
  assert.equal(german.parts[0].english_only, false);
  // 同词纤维没有"德语写法"这回事，不许标成英文
  const [same] = compositionRuns("100 % Polyester");
  assert.equal(same.parts[0].english_only, false);
});

test("生成侧提示词同步：要德文纤维名、成分必须写进文案本身", async () => {
  const { buildSystemPrompt } = await import("../server/providers.mjs");
  const prompt = buildSystemPrompt({ rules: de.rules, language: "de", marketplace: "DE" });
  assert.match(prompt, /never the English spelling as the only name/);
  assert.match(prompt, /"100 % Cotton" and "100 % Linen" are not acceptable/);
  assert.match(prompt, /not a composition statement/);
  assert.match(prompt, /before purchase/);
  // 上限没有因此被放宽
  assert.match(prompt, /Title <= 75; Item Highlights <= 125|Title <= 75; Item highlights <= 125/i);
});
