import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reviewContent, IMPLEMENTED_RULE_IDS, PARTIALLY_IMPLEMENTED_RULE_IDS } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";

/**
 * DE-CERT-01 的候选检测（第 6 轮）：认证标志类宣称。
 *
 * 本地只判两件事，其余一律不判：
 *   a. 宣称了认证、整篇却没有可核对的证书编号 → needs_review；
 *   b. 在不适用 CE 的品类上标 CE → needs_review（反向风险）。
 * 证书是否真的持有、编号是否对得上、检测项是否覆盖本产品 —— 判不了，所以不给 pass。
 */

const de = rulePackFor("DE");
const us = rulePackFor("US");
const cert = (r) => r.issues.filter((issue) => issue.rule_id === "DE-CERT-01");
const stateOf = (r) => r.checks.find((check) => check.rule_id === "DE-CERT-01")?.state;

const review = (content, { pack = de, marketplace = "DE" } = {}) =>
  reviewContent({
    content: { title: "Baumwolltasche 38 x 42 cm", item_highlights: "", bullet_points: [], description: "", ...content },
    profile: null,
    rulePack: pack,
    marketplace,
  });
const bullets = (...texts) => texts.map((text, index) => ({ id: `b${index + 1}`, text }));

test("写了 OEKO-TEX 却没给证书编号 → 报「宣称无法核对」，并给出补编号或删宣称两条路", () => {
  const r = review({ bullet_points: bullets("Hergestellt aus OEKO-TEX Standard 100 zertifizierter Baumwolle.") });
  const issue = cert(r)[0];
  assert.ok(issue, "无编号的认证宣称没被报出来");
  assert.equal(issue.original, "OEKO-TEX");
  assert.equal(issue.field_path, "content.bullet_points.b1");
  assert.match(issue.reason, /找不到任何可核对的证书编号/);
  assert.match(issue.suggestion, /Zertifikat-Nr/);
  assert.equal(issue.severity, "needs_review");
  assert.equal(stateOf(r), "needs_evidence");
});

test("同一篇里给了证书编号就算数（编号写在第五条、宣称写在第一条也行）", () => {
  const r = review({
    bullet_points: bullets("OEKO-TEX Standard 100 geprüft.", "Zertifikat-Nr. SH025 123456, geprüft von Hohenstein."),
  });
  assert.equal(cert(r).length, 0, "文案里已经给了编号，不该再报");
  assert.equal(stateOf(r), "not_checked", "证书真伪本地判不了，所以是未完成而不是 pass");
});

test("ÖKO-TEX 是同一标志的德文写法，一起认", () => {
  const r = review({ bullet_points: bullets("ORIGINAL ÖKO-TEX GEPRÜFT.") });
  assert.equal(cert(r).length, 1);
  assert.match(cert(r)[0].original, /ÖKO-TEX/);
});

test("棉布袋标 CE 属反向风险：不是「缺编号」，是根本不该标", () => {
  const r = review({ bullet_points: bullets("Mit CE-Kennzeichnung für geprüfte Qualität.") });
  const issue = cert(r)[0];
  assert.ok(issue, "CE 没被报出来");
  assert.match(issue.reason, /不在 CE 标志的适用范围/);
  assert.match(issue.reason, /765\/2008/);
  assert.doesNotMatch(issue.reason, /证书编号/, "CE 不该走「缺编号」那条话术");
});

test("法条号不能当证书编号（1007/2011 不该顶替 Zertifikat-Nr.）", () => {
  const r = review({ description: "Baumwolle nach (EU) 1007/2011, OEKO-TEX geprüft." });
  assert.equal(cert(r).length, 1, "把法条号当成证书编号了，等于替商家糊过去");
});

test("TÜV geprüft 与 TÜV-geprüft 两种写法都认，虚词不当真", () => {
  const spaced = review({ bullet_points: bullets("TÜV geprüft nach DIN.") });
  const hyphen = review({ bullet_points: bullets("TÜV-geprüft nach DIN.") });
  assert.equal(cert(spaced).length, 1);
  assert.equal(cert(hyphen).length, 1);
  assert.match(cert(spaced)[0].original, /TÜV geprüft/);
});

test("没提到认证标志 → 不报，且照样不给 pass", () => {
  const r = review({ description: "Robuste Baumwolltasche, 38 × 42 cm, 140 g/m²." });
  assert.equal(cert(r).length, 0);
  const check = r.checks.find((item) => item.rule_id === "DE-CERT-01");
  assert.equal(check.state, "not_checked");
  assert.match(check.reason, /没有出现包内列的认证标志/);
});

test("词表从包里读：换掉包里的标志词，同一句话就不再报", () => {
  const custom = structuredClone(de);
  const rule = custom.rules.find((item) => item.rule_id === "DE-CERT-01");
  rule.constraint.claim_must_match_held_certificate = ["Öko-Zertifikat"];
  const skipped = review({ bullet_points: bullets("Aus OEKO-TEX zertifizierter Baumwolle.") }, { pack: custom });
  assert.equal(cert(skipped).length, 0, "包里没这个词却还在报，说明词表被写死在引擎里");
});

test("美国包没有这条规则，同一句话不会冒出 DE-CERT-01", () => {
  const r = review({ bullet_points: bullets("Made from OEKO-TEX certified cotton.") }, { pack: us, marketplace: "US" });
  assert.equal(cert(r).length, 0);
});

test("这一条仍不进 IMPLEMENTED_RULE_IDS", () => {
  assert.ok(PARTIALLY_IMPLEMENTED_RULE_IDS.has("DE-CERT-01"));
  assert.equal(IMPLEMENTED_RULE_IDS.has("DE-CERT-01"), false);
});

test("真实语料：12 条提 OEKO-TEX 的全都没有证书编号，剩下 5 条不提", () => {
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
    if (cert(r).length) flagged.push(item.asin);
  }
  // 2026-10-30 抓的 17 条棉布袋：12 条写 OEKO-TEX，无一给出证书编号（也没有一条标 CE）。
  assert.equal(flagged.length, 12, `命中数变了，先确认语料是否换过：${flagged.join(",")}`);
  assert.ok(!flagged.includes("B0HCZH8TRB"), "这条没提任何认证标志，不该报");
});
