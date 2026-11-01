// 环保宣称六类分流：官对对每一类的处理办法不一样，一句「移除宽泛宣称」会让人白丢卖点。
// 依据 `FTCS-GREEN-SUMMARY`（Green Guides 2012 现行版摘要页）。
import test from "node:test";
import assert from "node:assert/strict";
import { ecoClaimAdvisory, reviewContent } from "../server/domain.mjs";
import { rulePack, scenarios } from "../server/store.mjs";

const product = scenarios.product_profiles[0];
const oneLine = (text) => ({
  title: text,
  item_highlights: "",
  bullet_points: [],
  description: "",
});
const us01 = (text) =>
  reviewContent({ content: oneLine(text), profile: product, rulePack }).issues.find(
    (issue) => issue.rule_id === "US-01",
  );

test("八个召回词分流到六类，每一类的处置办法不一样", () => {
  const expected = {
    "eco-friendly": "broad",
    sustainable: "broad",
    "planet-friendly": "broad",
    recyclable: "recyclable",
    recycled: "recycled-content",
    upcycled: "recycled-content",
    "plastic-free": "free-of",
    "carbon-neutral": "carbon",
    "carbon offset": "carbon",
    "zero waste": "zero",
  };
  for (const [claim, family] of Object.entries(expected))
    assert.equal(ecoClaimAdvisory(claim).id, family, claim);
});

test("可回收与含再生材料的建议里不许出现「移除或直接删掉」", () => {
  for (const claim of ["recyclable bags", "recycled cotton"]) {
    const issue = us01(claim);
    assert.ok(issue, `${claim} 应当被召回`);
    assert.doesNotMatch(issue.suggestion, /移除这个泛用词|直接删/, claim);
    assert.match(issue.suggestion, /限定|比例/, claim);
  }
});

test("宽泛词照旧按「移除」处理（这一档不许被分流冲淡）", () => {
  for (const claim of ["eco-friendly tote", "sustainable tote", "100% green tote"]) {
    const issue = us01(claim);
    assert.ok(issue, claim);
    assert.doesNotMatch(issue.suggestion, /不用删/, claim);
  }
  assert.match(us01("eco-friendly tote").suggestion, /移除/);
});

test("六类建议两两不同，不能只换了开头一句", () => {
  const texts = new Map();
  for (const claim of ["eco-friendly", "recyclable", "recycled", "plastic-free", "carbon-neutral", "zero waste"]) {
    const { reason, suggestion } = ecoClaimAdvisory(claim);
    const key = `${reason}|${suggestion}`;
    assert.ok(!texts.has(key), `${claim} 与 ${texts.get(key)} 拿到了同一段建议`);
    texts.set(key, claim);
  }
  assert.equal(texts.size, 6);
});

test("数字仍取自规则包，严重度仍是待核对（不升级成阻断）", () => {
  assert.equal(us01("eco-friendly tote").severity, "needs_review");
  const raw = JSON.parse(
    JSON.stringify(rulePack.rules.find((x) => x.rule_id === "US-01")),
  );
  assert.equal(raw.severity_on_failure, "needs_review");
});

// ---- 2026-10-29 第 9 轮（方向 C）：按 16 CFR 260 的条款逐条补召回 ----
// 数字出处：`node scripts/claim-recall-probe.mjs`，改前 must 7/11、改后 11/11。
// 这几条测试钉的是「官方条款对应的那句话，引擎要能召回」，
// 不钉具体措辞——建议文案可以改，但召回通道不许再静默丢掉。
const issueOf = (ruleId, text) =>
  reviewContent({ content: oneLine(text), profile: product, rulePack }).issues.find(
    (issue) => issue.rule_id === ruleId,
  );

test("260.9 free-of 按结构收：BPA / phthalate / PFAS 与 plastic-free 同类", () => {
  for (const claim of ["BPA free inner liner", "Phthalate-free print", "PFAS free coating", "Plastic-free packaging"]) {
    const issue = issueOf("US-01", claim);
    assert.ok(issue, `${claim} 应当被召回`);
    assert.equal(ecoClaimAdvisory(issue.original).id, "free-of", claim);
  }
});

test("260.6 认证印章按名称召回，但不假装核验证书", () => {
  for (const claim of ["GREENGUARD Gold certified fabric", "OEKO-TEX Standard 100 cotton", "GOTS certified organic cotton"]) {
    const issue = issueOf("US-03", claim);
    assert.ok(issue, `${claim} 应当被召回`);
    assert.match(issue.reason, /证据|适用/, claim);
    assert.doesNotMatch(issue.suggestion, /已核实|证书有效/, `${claim}：不许替商家担保`);
  }
});

test("260.7 / 260.8 降解与可堆肥：前缀变形和 compostable 都要召回", () => {
  for (const claim of ["Biodegradable bag", "Photodegradable mailer", "Oxo-degradable film", "100% compostable within 90 days"]) {
    assert.ok(issueOf("US-02", claim), `${claim} 应当被召回`);
  }
});

test("降解宣称的证据只给命中的那个词，不给整句（报告里要能点到）", () => {
  const sentence = "ECO-FRIENDLY & SUSTAINABLE: our mailer is photodegradable and ships flat.";
  const issue = issueOf("US-02", sentence);
  assert.ok(issue);
  assert.ok(issue.original.length < sentence.length, "证据不该是整句");
  assert.match(issue.original, /degradable/i);
});
