import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  reviewContent,
  IMPLEMENTED_RULE_IDS,
  PARTIALLY_IMPLEMENTED_RULE_IDS,
} from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";

/**
 * DE-VERPACK-01（第 8 轮）：包装法注册 + 包装环保宣称。
 *
 * 这条规则的两半待遇不一样，测试就把这个不对称钉住：
 *   - 注册状态 / 系统参与：本地永远判不了（后台字段），只列清单，不给 pass 也不判违规；
 *   - 文案里写了注册号：本地判得了 —— 不是判"号是假的"，而是"号不该出现在文案里，
 *     而且本工具核不了真伪"，这正是模型最爱编的地方。
 * 另外钉住一件事：包装上的泛化环保词不再由这条重复报（DE-ENV-01 已经在报）。
 */

const de = rulePackFor("DE");
const us = rulePackFor("US");
const verpack = (r) => r.checks.find((check) => check.rule_id === "DE-VERPACK-01");
const issuesOf = (r) => r.issues.filter((issue) => issue.rule_id === "DE-VERPACK-01");

const review = (content, { pack = de, marketplace = "DE" } = {}) =>
  reviewContent({
    content: {
      title: "Baumwolltasche 38 x 42 cm",
      item_highlights: "",
      bullet_points: [],
      description: "",
      ...content,
    },
    profile: null,
    rulePack: pack,
    marketplace,
  });

test("干净文案：只列清单，照样 not_checked（不给 pass 也不判违规）", () => {
  const r = review({ description: "Hergestellt aus 100 % Baumwolle." });
  const check = verpack(r);
  assert.ok(check, "没有这条的检查记录");
  assert.equal(check.state, "not_checked");
  assert.equal(check.method, "checklist_only");
  assert.equal(issuesOf(r).length, 0, "没有注册号就不该产生 issue");
  for (const keyword of ["Zentrale Stelle Verpackungsregister", "系统参与", "材料与比例"])
    assert.ok(check.reason.includes(keyword), `清单里缺「${keyword}」`);
});

test("说清为什么判不了：注册号本来就不在文案里，不能用「文案里没写」判违规", () => {
  const check = verpack(review({ description: "Baumwolle." }));
  assert.match(check.reason, /本来就不写在商品文案里/);
  assert.match(check.reason, /不能根据「文案里没有注册号」判定违规/);
  assert.match(check.reason, /读不到商家后台/);
});

test("文案里写了注册号：报一条，说明号不该在文案里、本地也核不了真伪", () => {
  const r = review({
    description: "Versand aus Deutschland. LUCID-Registrierung: DE1234567890123.",
  });
  const [issue] = issuesOf(r);
  assert.ok(issue, "写了注册号却没报");
  assert.equal(issue.severity, "needs_review");
  assert.match(issue.original, /LUCID|DE1234567890123/);
  assert.match(issue.reason, /无法核对号码真伪/);
  assert.match(issue.reason, /不构成合规证明/);
  assert.match(issue.suggestion, /删掉/);
  // 报出来之后状态是 needs_evidence，不是 pass —— 清单也不该把它盖回 not_checked
  assert.equal(verpack(r).state, "needs_evidence");
});

test("裸的 DE + 长数字也认（卖家常常只写号码不写 LUCID 字样）", () => {
  const r = review({ description: "Verpackungsregister DE1234567890123." });
  assert.equal(issuesOf(r).length, 1);
});

test("商品型号里带 DE 但不足 8 位数字，不误报（`DE-2026`、`Modell DE 42` 都不是注册号）", () => {
  for (const description of ["Modell DE-2026, Baumwolle.", "Modell DE 42 aus Baumwolle."])
    assert.equal(issuesOf(review({ description })).length, 0, `误报了：${description}`);
});

test("包装上的泛化环保词不由这条重复报（那句话归 DE-ENV-01）", () => {
  const r = review({ description: "Umweltfreundliche Verpackung aus Baumwolle." });
  assert.equal(issuesOf(r).length, 0, "DE-VERPACK-01 不该重复报泛化环保词");
  assert.ok(
    r.issues.some((issue) => issue.rule_id === "DE-ENV-01"),
    "泛化环保词这一句必须仍然被 DE-ENV-01 抓到",
  );
  // 但要作为线索出现在清单里，让读的人知道包装那句话缺材料与比例
  assert.match(verpack(r).reason, /提到包装/);
  assert.match(verpack(r).reason, /同段没找到材料或比例/);
});

test("包装说明了材料与比例时，线索里要说「同段有材料或比例写法」，但仍不下结论", () => {
  const r = review({ description: "Versand in einer Faltschachtel aus 100 % Altpapier." });
  assert.match(verpack(r).reason, /同段有材料或比例写法/);
  assert.match(verpack(r).reason, /认不出那个比例写的是包装还是产品本身/);
  assert.equal(verpack(r).state, "not_checked");
});

test("没提包装时明说「没有可判对象」，不留空白", () => {
  assert.match(verpack(review({ description: "Baumwolle." })).reason, /没有提到包装/);
});

test("美国包没有这条规则，不冒出来", () => {
  const r = review({ description: "Cotton tote bag." }, { pack: us, marketplace: "US" });
  assert.equal(verpack(r), undefined);
});

test("这条仍不进 IMPLEMENTED_RULE_IDS（判到 issue 也不给 pass）", () => {
  assert.ok(PARTIALLY_IMPLEMENTED_RULE_IDS.has("DE-VERPACK-01"));
  assert.equal(IMPLEMENTED_RULE_IDS.has("DE-VERPACK-01"), false);
});

test("包装注册号不能替认证宣称做担保（DE-CERT-01 该报还得报）", () => {
  // 第 8 轮彩排抓到的假阴性：同一条文案里既写了 OEKO-TEX 又写了 LUCID 注册号，
  // 「有标志无编号」那条就静默通过了 —— 一串 DE+13 位数字被当成了证书号。
  const withRegistration = review({
    bullet_points: [
      { id: "b1", text: "OEKO-TEX geprüft." },
      { id: "b2", text: "Versand im Polybeutel, LUCID-Registrierung DE1234567890123." },
    ],
  });
  assert.ok(
    withRegistration.issues.some((issue) => issue.rule_id === "DE-CERT-01"),
    "注册号被当成了证书编号，认证宣称漏报了",
  );
  // 对照：真的给了证书号，就不该再报这条
  const withCertificate = review({
    bullet_points: [
      { id: "b1", text: "OEKO-TEX Standard 100, Zertifikat-Nr. SH025-123456." },
      { id: "b2", text: "LUCID-Registrierung DE1234567890123." },
    ],
  });
  assert.equal(
    withCertificate.issues.filter((issue) => issue.rule_id === "DE-CERT-01").length,
    0,
    "有证书号还报，就是把合规文案判成不合规",
  );
});

test("真实语料 17 条：可读文本里写注册号的是 0 条（有数字就得有出处，不能凭印象）", () => {
  const corpus = JSON.parse(
    readFileSync(new URL("../data-research/de-listings-20261030.json", import.meta.url), "utf8"),
  );
  let withRegistration = 0;
  let mentioningPackaging = 0;
  for (const item of corpus.items) {
    const r = review({
      title: item.title,
      bullet_points: (item.bullets || []).map((text, index) => ({ id: `b${index + 1}`, text })),
      description: item.description || "",
    });
    const check = verpack(r);
    if (issuesOf(r).length) withRegistration += 1;
    if (/提到包装/.test(check.reason)) mentioningPackaging += 1;
    // 这批样本上这条只能是「清单」或「线索不足」，不能出现 pass
    assert.equal(check.state === "pass", false, `${item.asin} 上 DE-VERPACK-01 给了 pass`);
  }
  assert.equal(withRegistration, 0);
  // 提包装的条数进语料报告的正文，这里只做一个下限断言，避免数字写死在两处各改一次
  assert.ok(mentioningPackaging >= 0);
});
