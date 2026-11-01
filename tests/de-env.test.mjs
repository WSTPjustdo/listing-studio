import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reviewContent, IMPLEMENTED_RULE_IDS, PARTIALLY_IMPLEMENTED_RULE_IDS } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";

/**
 * DE-ENV-01 的候选检测（第 6 轮）：泛化环保词。
 *
 * 规则本身的方法是 candidate_detection_and_contextual_review —— 本地只回答
 * 「有没有这类词」，不回答「有没有被具体说明豁免」。所以：
 *   - 命中一律 needs_review，绝不给 pass；
 *   - 没命中也不给 pass，只落 not_checked 并写清还缺什么；
 *   - 词表从包里读，代码里不许再抄一遍法律清单。
 *
 * 两处刻意不判，都在下面钉住：grün（颜色同词）、ÖKO-TEX（证书名称）。
 */

const de = rulePackFor("DE");
const us = rulePackFor("US");
const env = (r) => r.issues.filter((issue) => issue.rule_id === "DE-ENV-01");
const stateOf = (r) => r.checks.find((check) => check.rule_id === "DE-ENV-01")?.state;

const review = (
  content,
  { pack = de, marketplace = "DE" } = {},
) =>
  reviewContent({
    content: { title: "Baumwolltasche 38 x 42 cm", item_highlights: "", bullet_points: [], description: "", ...content },
    profile: null,
    rulePack: pack,
    marketplace,
  });

const bullets = (...texts) => texts.map((text, index) => ({ id: `b${index + 1}`, text }));

test("德语文案里的泛化环保词要报，并把原词贴出来（大小写不敏感）", () => {
  const r = review({
    title: "Baumwolltasche 38 x 42 cm",
    bullet_points: bullets("HOCHWERTIG und NACHHALTIG: robuste Baumwolle.", "UMWELTFREUNDLICH: Alternative zu Plastik."),
  });
  const issues = env(r);
  assert.equal(issues.length, 2, "两个五点各有一处，应该各报一条");
  assert.match(issues[0].original, /NACHHALTIG/);
  assert.match(issues[1].original, /UMWELTFREUNDLICH/);
  assert.equal(issues[0].field_path, "content.bullet_points.b1");
  assert.equal(issues[0].severity, "needs_review");
  assert.equal(stateOf(r), "needs_evidence");
});

test("变格与派生词也要认（nachhaltige / Ökologische / Klimaneutralität）", () => {
  const r = review({
    bullet_points: bullets("Eine nachhaltige Wahl.", "Ökologische Verantwortung.", "Wir liefern Klimaneutralität."),
  });
  const words = env(r).map((issue) => issue.original);
  assert.ok(words.includes("nachhaltige"), `没认出 nachhaltige：${words.join(",")}`);
  assert.ok(words.includes("Ökologische"), `没认出 Ökologische：${words.join(",")}`);
  assert.ok(words.includes("Klimaneutralität"), `没认出 Klimaneutralität：${words.join(",")}`);
});

test("grün 不判：德语里「grüne Tasche」是颜色，本地分不出颜色和环保", () => {
  const r = review({ bullet_points: bullets("Grüne Tasche mit grünem Griff.") });
  assert.equal(env(r).length, 0, "颜色当环保宣称报了，商家会来问凭什么");
  assert.equal(stateOf(r), "not_checked");
});

test("ÖKO-TEX 是证书名称，不判；同一句里别的泛化词照报", () => {
  const clean = review({ description: "OEKO-TEX Standard 100 geprüft." });
  assert.equal(env(clean).length, 0, "证书名称被当成环保宣称");

  const mixed = review({ description: "OEKO-TEX geprüft und umweltfreundlich verpackt." });
  const issues = env(mixed);
  assert.equal(issues.length, 1);
  assert.match(issues[0].original, /umweltfreundlich/);
  assert.doesNotMatch(issues[0].original, /TEX/i);
});

test("没命中不给 pass：这条规则还有本地判不了的一半", () => {
  const r = review({ description: "Hergestellt aus 100 % Baumwolle, 140 g/m²." });
  assert.equal(env(r).length, 0);
  const check = r.checks.find((item) => item.rule_id === "DE-ENV-01");
  assert.equal(check.state, "not_checked", "本地判干净也不许给 pass");
  assert.match(check.reason, /具体说明|整体/);
});

test("词表从包里读：给包加一个词，不改引擎就能命中；去掉词表就整条不跑", () => {
  const custom = structuredClone(de);
  const rule = custom.rules.find((item) => item.rule_id === "DE-ENV-01");
  rule.constraint.banned_generic_terms = [...rule.constraint.banned_generic_terms, "baumwollwunder"];
  const hit = review({ description: "Unsere Baumwollwunder-Tasche." }, { pack: custom });
  assert.equal(env(hit).length, 1, "包里新加的词没生效，说明词表被写死在代码里");
  assert.match(env(hit)[0].original, /Baumwollwunder/i);

  const stripped = structuredClone(de);
  const strippedRule = stripped.rules.find((item) => item.rule_id === "DE-ENV-01");
  delete strippedRule.constraint.banned_generic_terms;
  const skipped = review({ description: "Umweltfreundlich und nachhaltig." }, { pack: stripped });
  assert.equal(env(skipped).length, 0, "包里没有词表却还在跑，等于引擎自带了法律清单");
  assert.equal(stateOf(skipped), "not_checked", "规则没跑就只能是 not_checked，不能落到默认的 pass");
});

test("美国包没有这条规则，英文 eco-friendly 不会冒出 DE-ENV-01", () => {
  const r = review({ description: "Eco-friendly and sustainable cotton tote." }, { pack: us, marketplace: "US" });
  assert.equal(env(r).length, 0);
});

test("标题也查：Klimaneutral 写在标题里要报 content.title", () => {
  const r = review({ title: "Klimaneutral Baumwolltasche 38 x 42 cm" });
  const issues = env(r);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field_path, "content.title");
});

test("同一段里多个词按出现顺序列出、同一个词不重复列", () => {
  const r = review({
    description: "Umweltfreundlich, nachhaltig und wirklich umweltfreundlich.",
  });
  const original = env(r)[0].original;
  assert.equal(original, "Umweltfreundlich / nachhaltig", "去重或排序不对：" + original);
});

test("这一条仍不进 IMPLEMENTED_RULE_IDS（判干净也不给 pass）", () => {
  assert.ok(PARTIALLY_IMPLEMENTED_RULE_IDS.has("DE-ENV-01"));
  assert.equal(IMPLEMENTED_RULE_IDS.has("DE-ENV-01"), false);
});

test("真实语料：9 条 amazon.de 在售商品命中，只有 OEKO-TEX 的 5 条不报", () => {
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
    if (env(r).length) flagged.push(item.asin);
  }
  // 这批语料是 2026-10-30 抓的 17 条棉布袋：9 条带 nachhaltig / umweltfreundlich / öko，
  // 另外 5 条只写了 OEKO-TEX 证书号（不算泛化宣称），3 条一个都没写。
  // 数字变了先看是不是语料换了，不要直接把断言改成新数字。
  assert.deepEqual(flagged.sort(), [
    "B07F5Y19N8",
    "B08FHKJP47",
    "B0924BTR4P",
    "B09541HH6P",
    "B0CGJ16JV2",
    "B0D2GJZXQJ",
    "B0D97XSBRZ",
    "B0D9QWKDRZ",
    "B0FWQPDNXV",
  ].sort());
});
