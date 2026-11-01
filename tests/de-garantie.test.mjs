import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reviewContent, IMPLEMENTED_RULE_IDS, PARTIALLY_IMPLEMENTED_RULE_IDS } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";

/**
 * DE-GARANTIE-01 的候选检测（第 6 轮）：Garantie 宣称缺法定五项。
 *
 * 两条最容易做错的地方，都在下面钉住：
 *   1. 动词 `garantiert` 不是质保承诺（"garantiert Langlebigkeit" 属耐用性宣称），不许报；
 *   2. 德语复合词（Haltbarkeitsgarantie / Geld-zurück-Garantie）要整体认出来，
 *      报出来的原文得是商家真写的那个词，不是半截 "Garantie"。
 */

const de = rulePackFor("DE");
const us = rulePackFor("US");
const g = (r) => r.issues.filter((issue) => issue.rule_id === "DE-GARANTIE-01");
const stateOf = (r) => r.checks.find((check) => check.rule_id === "DE-GARANTIE-01")?.state;

const review = (content, { pack = de, marketplace = "DE" } = {}) =>
  reviewContent({
    content: { title: "Baumwolltasche 38 x 42 cm", item_highlights: "", bullet_points: [], description: "", ...content },
    profile: null,
    rulePack: pack,
    marketplace,
  });
const bullets = (...texts) => texts.map((text, index) => ({ id: `b${index + 1}`, text }));

const complete = (extra = "") =>
  "3 Jahre Haltbarkeitsgarantie der Beispiel GmbH, Musterstraße 1, 10115 Berlin. " +
  "Ihre gesetzlichen Mängelrechte bleiben unberührt und sind für Sie kostenlos. " +
  "Geltendmachung: E-Mail an garantie@beispiel.de. Geltungsbereich: Deutschland." +
  extra;

test("语料里的真实写法：写了期限与补偿，缺法定权利提示与保证人地址 → 逐项点名", () => {
  const r = review({
    bullet_points: bullets(
      "GARANTIE: wenn die Tasche beim normalem Gebrauch innerhalb von 3 Monaten beschädigt wird, bieten wir Ihnen einen kostenlosen Ersatz an.",
    ),
  });
  const issue = g(r)[0];
  assert.ok(issue, "质保宣称没被报出来");
  assert.match(issue.reason, /没有提示法定瑕疵权利不受影响/);
  assert.match(issue.reason, /没有保证人的名称与地址/);
  assert.match(issue.reason, /写了期限但没写地域范围/);
  assert.equal(issue.severity, "needs_review");
  assert.equal(stateOf(r), "needs_evidence");
});

test("动词 garantiert 不算质保宣称（那是耐用性宣称，归别的规则）", () => {
  const r = review({ bullet_points: bullets("Die hohe Grammatur garantiert Langlebigkeit.") });
  assert.equal(g(r).length, 0, "把动词当质保承诺报了");
  assert.equal(stateOf(r), "not_checked");
});

test("五项齐全时不报，但仍只到 not_checked（真兑付本地判不了）", () => {
  const r = review({ bullet_points: bullets(complete()) });
  assert.equal(g(r).length, 0, complete());
  const check = r.checks.find((item) => item.rule_id === "DE-GARANTIE-01");
  assert.equal(check.state, "not_checked");
});

test("复合词整体认出来：Haltbarkeitsgarantie / Geld-zurück-Garantie", () => {
  const a = review({ bullet_points: bullets("Haltbarkeitsgarantie ohne weitere Angaben.") });
  const b = review({ bullet_points: bullets("Geld-zurück-Garantie ohne weitere Angaben.") });
  assert.match(g(a)[0].original, /^Haltbarkeitsgarantie$/);
  assert.match(g(b)[0].original, /^Geld-zurück-Garantie$/);
});

test("只有法人名、没有门牌或邮编 → 仍算缺保证人地址", () => {
  const r = review({ bullet_points: bullets("2 Jahre Garantie der Beispiel GmbH. Ihre gesetzlichen Rechte bleiben unberührt.") });
  assert.match(g(r)[0].reason, /没有保证人的名称与地址/);
});

test("写了期限却没写地域，和完全没写期限要分开报", () => {
  const noTerritory = review({ bullet_points: bullets("2 Jahre Garantie, Kontakt: service@beispiel.de") });
  const noDuration = review({ bullet_points: bullets("Garantie, Kontakt: service@beispiel.de") });
  assert.match(g(noTerritory)[0].reason, /写了期限但没写地域范围/);
  assert.match(g(noDuration)[0].reason, /没有写保证期限/);
});

test("没提质保 → 不报，reason 写明动词不算、纸面质保卡本地看不到", () => {
  const r = review({ description: "Robuste Baumwolltasche, 140 g/m²." });
  assert.equal(g(r).length, 0);
  const check = r.checks.find((item) => item.rule_id === "DE-GARANTIE-01");
  assert.equal(check.state, "not_checked");
  assert.match(check.reason, /garantiert/);
});

test("美国包没有这条规则", () => {
  const r = review({ bullet_points: bullets("2 year warranty on all bags.") }, { pack: us, marketplace: "US" });
  assert.equal(g(r).length, 0);
});

test("这一条仍不进 IMPLEMENTED_RULE_IDS", () => {
  assert.ok(PARTIALLY_IMPLEMENTED_RULE_IDS.has("DE-GARANTIE-01"));
  assert.equal(IMPLEMENTED_RULE_IDS.has("DE-GARANTIE-01"), false);
});

test("真实语料：17 条里只有 1 条写质保（Garantie 名词），动词 garantiert 那条不算", () => {
  const corpus = JSON.parse(
    readFileSync(new URL("../data-research/de-listings-20261030.json", import.meta.url), "utf8"),
  );
  const flagged = [];
  for (const item of corpus.items) {
    const r = review({
      title: item.title,
      bullet_points: (item.bullets || []).map((text, index) => ({ id: `b${index + 1}`, text })),
      description: item.description || "",
    });
    for (const issue of g(r)) flagged.push(`${item.asin}:${issue.original}`);
  }
  assert.deepEqual(flagged, ["B0D2GJZXQJ:GARANTIE"]);
});
