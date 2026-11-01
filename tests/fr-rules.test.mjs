import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent, IMPLEMENTED_RULE_IDS, PARTIALLY_IMPLEMENTED_RULE_IDS } from "../server/domain.mjs";
import {
  languagesFor,
  languageTier,
  rulePack,
  rulePackFor,
  rulePacks,
  supportedMarketplaces,
  WORKFLOW_MARKETPLACES,
  DEFAULT_MARKETPLACE,
  normalizeMarketplace,
} from "../server/store.mjs";
import { guidedPlanInputSchema, prepareGuidedPlan, guidedPlanSystemPrompt } from "../server/guided.mjs";
import { buildSystemPrompt } from "../server/providers.mjs";

/**
 * 法国站（2026-10-31 接通：界面 / 生成 / 批量 / 报告 / 批量导出）。
 *
 * 这份文件守五件事：
 *   1. 换法域不改引擎：`rulePackFor("FR")` 取得到包，4 条平台层按 constraint 真的出结论；
 *   2. 法国站比英国站多的那一条：FR-LANG-01 能本地判「这段读起来是英语」；
 *   3. 不许假绿：5 条法国/EU 法域规则没有本地实现，必须全记 not_checked；
 *   4. 不许串包：法国站的审阅里不许冒出美 / 德 / 英的规则 id；
 *   5. 站点与语言绑死：法国站只收法语（Loi Toubon 是硬要求，不是风格偏好）。
 *
 * 平台层那 4 条的出处是 amazon.fr 帮助页（GYTR6SYGFA5E3EQC，locale=fr-FR，2026-10-31 抓取），
 * 与 amazon.de / amazon.co.uk 是**同一个帮助页换 locale**，所以 75 / 125 / 禁用字符 / 同词两次四地同值。
 * 这不是「法国另有一套」，写测试时别把它当巧合删掉。
 */

const fr = rulePackFor("FR");
const us = rulePackFor("US");
const de = rulePackFor("DE");
const uk = rulePackFor("UK");

const BASE = {
  title: "Sac cabas en coton 38 x 42 cm",
  item_highlights: "",
  bullet_points: [],
  description: "",
};
const review = (content, pack = fr, marketplace = "FR") =>
  reviewContent({ content: { ...BASE, ...content }, profile: null, rulePack: pack, marketplace });
const stateOf = (r, ruleId) => r.checks.find((check) => check.rule_id === ruleId)?.state;
const issueOf = (r, ruleId) => r.issues.find((issue) => issue.rule_id === ruleId);
const legalIds = ["FR-TEXTIL-01", "FR-ENV-01", "FR-TRIMAN-01", "FR-EPR-01", "FR-GPSR-01"];

// —— 取包入口 ——

test("法国包能被 rulePackFor 取到，10 条市场规则加 6 条项目内部检查，默认市场仍是美国站", () => {
  assert.equal(fr.pack_id, "amazon-fr-tote");
  assert.equal(fr.rules.length, 16);
  assert.equal(fr.rules.filter(rule => rule.source_ids.every(sourceId => sourceId === 'PROJECT-AMAZON-QUALITY')).length, 6);
  assert.equal(fr.scope.marketplace, "FR");
  assert.equal(fr.scope.locale, "fr-FR");
  assert.deepEqual(supportedMarketplaces(), ["US", "DE", "UK", "FR"]);
  assert.equal(DEFAULT_MARKETPLACE, "US");
  assert.equal(rulePack, rulePacks.US, "默认包被顺手改了：老入口会跟着变味");
  assert.equal(normalizeMarketplace("fr"), "FR");
  assert.equal(normalizeMarketplace("france"), null, "没有 france 这个包，不许悄悄映射到 FR");
});

test("法国包的顶层字段与顺序和美国包一致（界面按字段名取，错一个就静默空白）", () => {
  assert.deepEqual(Object.keys(fr), Object.keys(us));
});

test("法国包的单条规则没有美国包之外的自创字段", () => {
  const allowed = new Set(us.rules.flatMap((rule) => Object.keys(rule)));
  const extra = fr.rules.flatMap((rule) =>
    Object.keys(rule).filter((key) => !allowed.has(key)).map((key) => `${rule.rule_id}::${key}`),
  );
  assert.deepEqual(extra, []);
});

test("四个包互不影响：美国 15 条、德国 19 条，英法各 10 条市场规则加 6 条内部检查", () => {
  assert.equal(us.rules.length, 15);
  assert.equal(de.rules.length, 19);
  assert.equal(uk.rules.length, 16);
  assert.equal(fr.rules.length, 16);
  assert.equal(us.rules.some((rule) => rule.rule_id.startsWith("FR-")), false);
  assert.equal(de.rules.some((rule) => rule.rule_id.startsWith("FR-")), false);
});

// —— 平台层四条：真的出结论，数字从包里读 ——

test("平台层：标题上限从法国包读，75 通过、76 报错", () => {
  const ok = "Sac cabas en coton 38 x 42 cm, anses longues, naturel"; // 52 字符
  assert.ok([...ok].length <= 75);
  assert.equal(stateOf(review({ title: ok }), "AMZ-01"), "pass");
  // 用一整句法语凑到 76 字符：法语比英语长 15–20 %，这个场景在法国站是真实的
  const tooLong = `${ok}, réutilisable pour les courses et le marché du samedi`;
  assert.ok([...tooLong].length > 75, `这条要真的超 75，实际 ${[...tooLong].length}`);
  const r = review({ title: tooLong });
  assert.equal(stateOf(r, "AMZ-01"), "fail");
  assert.match(issueOf(r, "AMZ-01").reason, /上限 75/);
});

test("平台层：亮点上限也是 125（从包里读，不是写死美国站那份）", () => {
  const r = review({ item_highlights: "a".repeat(126) });
  assert.equal(stateOf(r, "AMZ-02"), "fail");
  assert.match(issueOf(r, "AMZ-02").reason, /上限为 125|上限 125/);
});

test("平台层：禁用特殊字符与同词两次真的出结论（不是「跑了但不说」）", () => {
  const r = review({ title: "Sac cabas! cabas cabas coton" });
  assert.equal(stateOf(r, "FR-TITLE-01"), "fail");
  assert.match(issueOf(r, "FR-TITLE-01").reason, /「!」/);
  assert.equal(stateOf(r, "FR-TITLE-02"), "fail");
  assert.match(issueOf(r, "FR-TITLE-02").reason, /「cabas」出现 3 次/);
});

test("法语虚词不算重复：pour / avec / le 出现三次也不报", () => {
  // 法语站最容易被误报的写法：同一个介词复现。官方豁免的正是这三类词。
  const r = review({ title: "Sac cabas pour le travail, pour l'école, pour le voyage" });
  assert.equal(stateOf(r, "FR-TITLE-02"), "pass");
});

test("法语虚词表不能把实词一起豁免：coton 出现三次照样报", () => {
  const r = review({ title: "Sac coton coton coton pour le travail" });
  assert.equal(stateOf(r, "FR-TITLE-02"), "fail");
});

// —— FR-LANG-01：法国站比英国站多的那一条 ——

test("FR-LANG-01：整段英语要报，理由是 Loi Toubon 而不是风格偏好", () => {
  const r = review({
    description: "This cotton tote bag is perfect for shopping and the beach. It is made of strong fabric with long handles.",
  });
  assert.equal(stateOf(r, "FR-LANG-01"), "fail");
  const issue = issueOf(r, "FR-LANG-01");
  assert.match(issue.reason, /Loi Toubon/);
  assert.equal(issue.severity, "blocking");
});

test("FR-LANG-01：英语标题也报（不只查描述）", () => {
  const r = review({ title: "Cotton tote bag with long handles for work and school" });
  assert.equal(stateOf(r, "FR-LANG-01"), "fail");
});

test("FR-LANG-01：法语正文不给 pass —— 判得了「像不像英语」，判不了内容对不对", () => {
  const r = review({
    description:
      "Ce sac cabas en coton est parfait pour les courses et la plage. Il est fabriqué dans un tissu résistant avec des anses longues.",
  });
  assert.equal(stateOf(r, "FR-LANG-01"), "not_checked");
});

test("FR-LANG-01 三条保守闸门：短标题、带重音、判不出，都不许报", () => {
  // ① 品牌名 + 尺寸拼出来的短标题，信号不够
  assert.equal(stateOf(review({ title: "Sac cabas coton 38 x 42 cm" }), "FR-LANG-01"), "not_checked");
  // ② 有法语重音字符 → 不判成英语
  assert.equal(
    stateOf(review({ description: "Ce sac est très joli and it is the best bag for you and your friends." }), "FR-LANG-01"),
    "not_checked",
  );
  // ③ 一个法语功能词就把结论挡住
  assert.equal(
    stateOf(review({ description: "Sac en coton pour the beach with long handles and a small pocket inside." }), "FR-LANG-01"),
    "not_checked",
  );
});

test("FR-LANG-01 不误伤商品资料 / 品牌词堆出来的英文专有名词", () => {
  // 全大写型号 + 品牌，没有功能词 → 不报
  const r = review({ title: "WESTFORD MILL WM101 Sac coton naturel" });
  assert.notEqual(stateOf(r, "FR-LANG-01"), "fail");
});

// —— 不许假绿 ——

test("5 条法国法域规则一律 not_checked，一条都不许默认 pass", () => {
  const r = review({
    title: "Sac cabas en coton 38 x 42 cm",
    description:
      "Sac cabas en coton biologique, 100 % coton. Écologique et respectueux de l'environnement. IDU FR123456_ABCDEF.",
  });
  for (const ruleId of legalIds) {
    assert.equal(stateOf(r, ruleId), "not_checked", `${ruleId} 没有本地实现却给了非 not_checked 的结论`);
    assert.equal(IMPLEMENTED_RULE_IDS.has(ruleId), false, `${ruleId} 被登记成本地可判了`);
  }
  assert.ok(legalIds.every((ruleId) => fr.rules.some((rule) => rule.rule_id === ruleId)));
});

test("FR-LANG-01 也不许被登记成「本地能判完」——它只判语言，不判内容", () => {
  assert.equal(IMPLEMENTED_RULE_IDS.has("FR-LANG-01"), false);
  assert.equal(PARTIALLY_IMPLEMENTED_RULE_IDS.has("FR-LANG-01"), false, "没登记就靠「不在名单里」兜住 not_checked，别再塞名字");
});

test("不串包：法国站审阅里不出现美 / 德 / 英的规则 id", () => {
  const r = review({ title: "Sac cabas en coton 38 x 42 cm", description: "100 % coton, réutilisable." });
  const ids = r.checks.map((check) => check.rule_id);
  for (const leaked of ["US-01", "US-02", "DE-TEXTIL-01", "DE-TITLE-02", "UK-TITLE-01", "UK-GREEN-01"])
    assert.equal(ids.includes(leaked), false, `${leaked} 不该出现在法国站的检查清单里`);
});

test("法国包每条规则的 source_id 都能在包内找到（引不出处就是没出处）", () => {
  const known = new Set(fr.sources.map((source) => source.source_id));
  for (const rule of fr.rules) {
    assert.ok(rule.source_ids?.length, `${rule.rule_id} 没有 source_ids`);
    for (const sourceId of rule.source_ids)
      assert.ok(known.has(sourceId), `${rule.rule_id} 引了包里没有的出处 ${sourceId}`);
  }
});

// —— 站点与语言的组合表 ——

test("生成链路：四个站点都在，法国站收法语（主体）和英语（对照）", () => {
  assert.deepEqual(WORKFLOW_MARKETPLACES, ["US", "DE", "UK", "FR"]);
  const base = {
    mode: "automatic",
    product_id: "P-FR-1",
    product_revision: 1,
    marketplace: "FR",
    language: "fr",
    scope_confirmed: true,
  };
  assert.equal(guidedPlanInputSchema.safeParse(base).success, true, "法国站已接通，引导流程应该能收 FR");
  // 英语在法国站是合法的，只是档位为「仅内部核对」，见下一条
  assert.equal(guidedPlanInputSchema.safeParse({ ...base, language: "en" }).success, true);
  // 西语/德语法国站没有：报错必须指出这个站能写哪几种，不能只说不行
  assert.throws(() => prepareGuidedPlan({}, { ...base, language: "es" }), /这个站可写：法语/);
  assert.throws(() => prepareGuidedPlan({}, { ...base, language: "de" }), /这个站可写：法语/);
});

test("法国站的英语是「仅内部核对」，不是可上架语言 —— 这是 Loi Toubon 定的，不是我们保守", () => {
  assert.equal(languageTier("FR", "fr"), "primary");
  assert.equal(languageTier("FR", "en"), "internal");
  assert.equal(languageTier("FR", "zh"), null);
  // 法国站连中文都不收：能写的只有表里那两种
  assert.deepEqual(languagesFor("FR"), ["fr", "en"]);
});

test("每站 2–3 种，按市场价值派：美国站和德国站各 3 种，英国站和法国站各 2 种", () => {
  assert.deepEqual(languagesFor("US"), ["en", "es", "zh"]);
  assert.deepEqual(languagesFor("DE"), ["de", "en", "zh"]);
  assert.deepEqual(languagesFor("UK"), ["en", "zh"]);
  assert.deepEqual(languagesFor("FR"), ["fr", "en"]);
  for (const market of ["US", "DE", "UK", "FR"]) {
    const count = languagesFor(market).length;
    assert.ok(count >= 2 && count <= 3, `${market} 站配了 ${count} 种语言，超出 2–3 的范围`);
    // 第一种必须是 primary：界面拿它当默认，也拿它当「这个站本来是说什么语言的」的唯一答案
    assert.equal(languageTier(market, languagesFor(market)[0]), "primary");
  }
});

test("中文在任何站点都不是可上架语言", () => {
  for (const market of ["US", "DE", "UK"]) {
    assert.equal(languageTier(market, "zh"), "internal", `${market} 站的中文被当成了可上架语言`);
  }
});

test("美国站不再收法语：法语有了自己的站点，不该还留着一条无人维护的后门", () => {
  assert.equal(languageTier("US", "fr"), null);
  assert.throws(
    () => prepareGuidedPlan({}, {
      mode: "automatic",
      product_id: "P-US-1",
      product_revision: 1,
      marketplace: "US",
      language: "fr",
      scope_confirmed: true,
    }),
    /这个站可写：英语/,
  );
});

// —— 提示词 ——

test("法国站的方案提示要写出法国法域要求，并且不许宣称已核", () => {
  const prompt = guidedPlanSystemPrompt(false, "fr", "FR");
  assert.match(prompt, /Loi Toubon/);
  assert.match(prompt, /Triman/);
  assert.match(prompt, /unique identifier/);
  assert.match(prompt, /must NOT claim that a Triman marking has been printed/);
  assert.doesNotMatch(prompt, /not targeting the France marketplace/);
});

test("法国站的系统提示写法语约定 + 法国法域要求，且指明是 Amazon.fr", () => {
  const prompt = buildSystemPrompt({ rules: fr.rules, language: "fr", marketplace: "FR" });
  assert.match(prompt, /Amazon FR listing author/);
  assert.match(prompt, /French shopper on Amazon\.fr/);
  assert.match(prompt, /Loi Toubon article 2/);
  assert.match(prompt, /coton, lin, polyester, polyamide/);
  assert.match(prompt, /écologique/);
  assert.match(prompt, /Title <= 75; Item highlights <= 125/);
});

test("法国站的提示词不把德国站那套带进来", () => {
  const prompt = buildSystemPrompt({ rules: fr.rules, language: "fr", marketplace: "FR" });
  assert.doesNotMatch(prompt, /100 % Baumwolle|Amazon DE|German shopper/);
});
