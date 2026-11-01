// 字符变体：同一句话，从 Word / Excel / 微信里粘过来，连字符常常不是 ASCII 的 `-`。
// U+2011 不换行连字符、U+2013 en dash、U+FF0D 全角减号、U+2212 减号、U+200B 零宽空格 ——
// 屏幕上和 `-` 一模一样，正则里写 `-` 就一个都认不出来。
//
// 数字出处：`node scripts/claim-recall-probe.mjs`（第二·五栏），改前 14 条漏 6 条，改后全中。
// 这不算边角情况：中国卖家的文案大部分是从供应商表格里复制出来的。
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeForMatch, reviewContent } from "../server/domain.mjs";
import { rulePack } from "../server/store.mjs";

const oneBullet = (text) => ({
  title: "Cotton canvas tote bag",
  item_highlights: "",
  bullet_points: [{ id: "b1", text }],
  description: "",
});
const issuesOf = (text) =>
  reviewContent({ content: oneBullet(text), profile: null, rulePack, marketplace: "US" }).issues;

const CASES = [
  ["ECO-FRIENDLY tote bag", "US-01"],
  ["ECO\u2013FRIENDLY tote bag", "US-01"], // en dash
  ["ECO\u2011FRIENDLY tote bag", "US-01"], // 不换行连字符
  ["ECO\uFF0DFRIENDLY tote bag", "US-01"], // 全角减号
  ["ECO\u200B-FRIENDLY tote bag", "US-01"], // 零宽空格
  ["ECO\u00A0FRIENDLY tote bag", "US-01"], // 不换行空格
  ["BPA\u2011free inner liner", "US-01"],
  ["Carbon\u2011neutral shipping", "US-01"],
  ["limited\u2011time offer", "AMZ-04"],
  ["Photo\u2010degradable mailer", "US-02"],
  ["100% COMPOSTABLE within 90 days", "US-02"],
  ["OEKO\u2013TEX certified cotton", "US-03"],
];

test("同一个词，换了连字符/零宽字符也要召回", () => {
  for (const [text, ruleId] of CASES) {
    const hit = issuesOf(text).find((issue) => issue.rule_id === ruleId);
    assert.ok(hit, `${JSON.stringify(text)} 应当命中 ${ruleId}`);
  }
});

test("证据引的是原文那串字符，不是我们归一化之后的那版", () => {
  for (const [text] of CASES) {
    for (const issue of issuesOf(text)) {
      assert.ok(
        text.includes(issue.original),
        `证据 ${JSON.stringify(issue.original)} 在原句里找不到 —— 报告会引一段用户没写过的字`,
      );
    }
  }
});

test("归一化只动特殊字符，不动正常文字", () => {
  assert.equal(normalizeForMatch("ECO\u2011FRIENDLY"), "ECO-FRIENDLY");
  assert.equal(normalizeForMatch("A\u200BB"), "AB");
  assert.equal(normalizeForMatch("cotton\u00A0canvas"), "cotton canvas");
  assert.equal(normalizeForMatch("普通中文，带全角逗号"), "普通中文，带全角逗号");
  assert.equal(normalizeForMatch("17.5 x 16.5 inches"), "17.5 x 16.5 inches");
});

test("变体不影响本来就不该报的句子", () => {
  for (const text of [
    "Cotton canvas tote bag\u2011with long handles",
    "Hand wash with cold water.",
    "Not eco\u2011friendly packaging is not what we claim.", // 否定句不该报
  ]) {
    assert.equal(
      issuesOf(text).filter((issue) => issue.rule_id === "US-01").length,
      0,
      text,
    );
  }
});
