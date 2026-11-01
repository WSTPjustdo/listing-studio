import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent, IMPLEMENTED_RULE_IDS } from "../server/domain.mjs";
import {
  rulePack,
  rulePackFor,
  rulePacks,
  supportedMarketplaces,
  WORKFLOW_MARKETPLACES,
  DEFAULT_MARKETPLACE,
  normalizeMarketplace,
} from "../server/store.mjs";
import { guidedPlanInputSchema, prepareGuidedPlan } from "../server/guided.mjs";

/**
 * 英国站（2026-10-31 接通界面与生成链路，英国法域规则仍未实现）。
 *
 * 这份文件守四件事：
 *   1. 换法域不改引擎：`rulePackFor("UK")` 取得到包，平台层四条按 constraint 真的出结论；
 *   2. 不许假绿：6 条英国法域规则没有本地实现，必须全记 not_checked；
 *   3. 不许串包：英国站的审阅里不许冒出美国站 / 德国站的规则 id；
 *   4. 生成链路不跟着开：英国站没核过语料与 en-GB locale，批量与引导流程仍只收 US / DE。
 */

const uk = rulePackFor("UK");
const us = rulePackFor("US");
const de = rulePackFor("DE");

const review = (content, pack = uk, marketplace = "UK") =>
  reviewContent({ content: { item_highlights: "", bullet_points: [], description: "", ...content }, profile: null, rulePack: pack, marketplace });
const stateOf = (r, ruleId) => r.checks.find((check) => check.rule_id === ruleId)?.state;
const legalIds = ["UK-GREEN-01", "UK-GREEN-02", "UK-BAG-01", "UK-GPSR-01", "UK-UKCA-01", "UK-TEXTIL-01"];

test("英国包能被 rulePackFor 取到，10 条市场规则加 6 条项目内部检查，默认市场仍是美国站", () => {
  assert.equal(uk.pack_id, "amazon-uk-tote");
  assert.equal(uk.rules.length, 16);
  assert.equal(uk.rules.filter(rule => rule.source_ids.every(sourceId => sourceId === 'PROJECT-AMAZON-QUALITY')).length, 6);
  assert.deepEqual(supportedMarketplaces(), ["US", "DE", "UK", "FR"]);
  assert.equal(DEFAULT_MARKETPLACE, "US");
  assert.equal(rulePack, rulePacks.US, "默认包被顺手改了：老入口会跟着变味");
  assert.equal(normalizeMarketplace("uk"), "UK");
  assert.equal(normalizeMarketplace("gb"), null, "没有 gb 这个包，不许悄悄映射到 UK");
});

test("英国包的顶层字段与顺序和美国包一致（界面按字段名取，错一个就静默空白）", () => {
  assert.deepEqual(Object.keys(uk), Object.keys(us));
});

test("英国包的单条规则没有美国包之外的自创字段", () => {
  const allowed = new Set(us.rules.flatMap((rule) => Object.keys(rule)));
  const extra = uk.rules.flatMap((rule) =>
    Object.keys(rule).filter((key) => !allowed.has(key)).map((key) => `${rule.rule_id}::${key}`),
  );
  assert.deepEqual(extra, []);
});

test("平台层：标题上限从英国包读，75 通过、76 报错", () => {
  const ok = "Cotton tote bag 38 x 42 cm, long handles, natural, reusable"; // 58 字符
  assert.ok([...ok].length <= 75);
  assert.equal(stateOf(review({ title: ok }), "AMZ-01"), "pass");
  const tooLong = `${ok}, ${"extra words ".repeat(3)}`;
  const r = review({ title: tooLong });
  assert.ok([...tooLong].length > 75);
  assert.equal(stateOf(r, "AMZ-01"), "fail");
  assert.match(r.issues.find((issue) => issue.rule_id === "AMZ-01").reason, /上限 75/);
});

test("平台层：禁用特殊字符与同词两次真的出结论（不是「跑了但不说」）", () => {
  const r = review({ title: "Cotton tote bag! bag bag" });
  assert.equal(stateOf(r, "UK-TITLE-01"), "fail");
  assert.match(r.issues.find((issue) => issue.rule_id === "UK-TITLE-01").reason, /「!」/);
  assert.equal(stateOf(r, "UK-TITLE-02"), "fail");
  assert.match(r.issues.find((issue) => issue.rule_id === "UK-TITLE-02").reason, /「bag」出现 3 次/);
});

test("虚词不算重复：for / with / and 出现三次也不报", () => {
  const r = review({ title: "Tote bag for work, for school, for travel with handles and straps" });
  assert.equal(stateOf(r, "UK-TITLE-02"), "pass");
});

test("6 条英国法域规则一律 not_checked，一条都不许默认 pass", () => {
  const r = review({ title: "Cotton tote bag 38 x 42 cm", description: "Reusable cotton tote, plastic free, made in the UK." });
  for (const ruleId of legalIds) {
    assert.equal(stateOf(r, ruleId), "not_checked", `${ruleId} 没有本地实现却给了非 not_checked 的结论`);
    assert.equal(IMPLEMENTED_RULE_IDS.has(ruleId), false, `${ruleId} 被登记成本地可判了`);
  }
  assert.ok(legalIds.every((ruleId) => uk.rules.some((rule) => rule.rule_id === ruleId)));
});

test("不串包：英国站审阅里不出现美国站 / 德国站的规则 id", () => {
  const r = review({ title: "Cotton tote bag 38 x 42 cm", description: "100 % cotton, reusable." });
  const ids = r.checks.map((check) => check.rule_id);
  for (const leaked of ["US-01", "US-02", "US-03", "US-04", "DE-TEXTIL-01", "DE-TITLE-02", "DE-TITLE-03"])
    assert.equal(ids.includes(leaked), false, `${leaked} 不该出现在英国站的检查清单里`);
});

test("三个包互不影响：美国仍是 15 条、德国 19 条，英国 10 条市场规则加 6 条内部检查", () => {
  assert.equal(us.rules.length, 15);
  assert.equal(de.rules.length, 19);
  assert.equal(uk.rules.length, 16);
  assert.equal(us.rules.some((rule) => rule.rule_id.startsWith("UK-")), false);
  assert.equal(de.rules.some((rule) => rule.rule_id.startsWith("UK-")), false);
});

/*
 * 2026-10-31 改：这条原来断言「英国站不许进生成链路」（当时只有引擎能取到包）。
 * 现在英国站正式接通了 —— 站点选项、locale en-GB、报告、6 条法域规则的 not_checked
 * 边界都做完，所以断言反过来：US / DE / UK 三个都在，顺序不变，美国站一个数字没动。
 *
 * 注意它守的仍然是同一件事：**开的是"能跑"，不是"全通"** —— 英国那 6 条法域规则
 * 没有本地实现，必须还是 not_checked；这条断言挪到下面单独一条去守。
 */
test("生成链路已经开了英国站：四个站点都在，美国/德国行为不变", () => {
  assert.deepEqual(WORKFLOW_MARKETPLACES, ["US", "DE", "UK", "FR"]);
  const base = {
    mode: 'automatic',
    product_id: 'P-UK-1',
    product_revision: 1,
    marketplace: 'UK',
    language: 'en',
    scope_confirmed: true,
  };
  const parsed = guidedPlanInputSchema.safeParse(base);
  assert.equal(parsed.success, true, "英国站已接通，引导流程应该能收 UK");
  assert.equal(guidedPlanInputSchema.safeParse({ ...base, marketplace: "DE" }).success, true);
  assert.equal(guidedPlanInputSchema.safeParse({ ...base, marketplace: "US" }).success, true);
  // 组合查表：英国站收英语（主体）和中文（内部核对），不收西语/德语。
  // 给错了要报，不许静默按对的跑。这层校验在 prepareGuidedPlan 里（不是 zod），
  // 而且排在取商品之前，所以传一个空 store 也能测到。
  assert.throws(
    () => prepareGuidedPlan({}, { ...base, language: "es" }),
    /这个站可写：英语/,
  );
  assert.throws(
    () => prepareGuidedPlan({}, { ...base, language: "de" }),
    /这个站可写：英语/,
  );
  assert.throws(
    () => prepareGuidedPlan({}, { ...base, marketplace: "US", language: "de" }),
    /这个站可写：英语/,
  );
  // 中文在英国站是存在的，只是档位为「仅内部核对」——不许因为它不能上架就把组合判非法
  assert.equal(guidedPlanInputSchema.safeParse({ ...base, language: "zh" }).success, true);
});

test("英国包自述与实现一致：接通到哪、哪几条不给结论，都得写在包里", () => {
  assert.equal(uk.implementation_status, "wired_platform_layer_only");
  const text = [uk.notice, uk.label, ...uk.coverage_limits].join("\n");
  // 接通的事实要写进去，否则包自述过期，读包的人会以为界面里还没有英国站
  assert.match(text, /已接通界面/);
  // 边界也要写死：4 条平台层能出结论，6 条法域规则 not_checked，不许声称英国法域合规已核
  assert.match(text, /not_checked/);
  assert.match(text, /不得声称英国法域/);
  // 6 条法域规则一条都不许悄悄变成"有实现"
  assert.equal(
    uk.rules.filter((rule) => rule.rule_id.startsWith("UK-") && !/TITLE/.test(rule.rule_id)).length,
    6,
  );
});

test("英国站写的是英式英语，不是把美国站那套换个包名", async () => {
  const { buildSystemPrompt } = await import("../server/providers.mjs");
  const { guidedPlanSystemPrompt } = await import("../server/guided.mjs");

  // 生成阶段：站点决定拼写习惯，语言仍是 en
  const uk = buildSystemPrompt({ language: "en", marketplace: "UK" });
  assert.match(uk, /British English/);
  assert.match(uk, /no Americanisms/);
  const us = buildSystemPrompt({ language: "en", marketplace: "US" });
  assert.match(us, /Listing content is natural US English\./);
  assert.doesNotMatch(us, /British English/);

  // 方案阶段：要让写手知道用英式拼写，并且不许把 EU / GPSR 当成英国要求
  const ukPlan = guidedPlanSystemPrompt(false, "en", "UK");
  assert.match(ukPlan, /British English/);
  assert.match(ukPlan, /UKCA/);
  const usPlan = guidedPlanSystemPrompt(false, "en", "US");
  assert.match(usPlan, /natural US English/);
  assert.doesNotMatch(usPlan, /British English/);
});
