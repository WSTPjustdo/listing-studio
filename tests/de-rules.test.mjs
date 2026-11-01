import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent, characterCount, IMPLEMENTED_RULE_IDS } from "../server/domain.mjs";
import { rulePack, rulePackFor, rulePacks, normalizeMarketplace } from "../server/store.mjs";
import { ruleInventory, ruleCitations } from "../server/rules-doc.mjs";
import { buildSystemPrompt } from "../server/providers.mjs";
import { parseComposition, canonicalFiber, compareFiber } from "../server/material.mjs";

/**
 * 德国站规则包与按站点取包。
 *
 * 这份文件守的是三类错，都是"看起来绿、其实没查"：
 *   1. 包里的规则没人实现检查 → 界面显示 pass（假绿）
 *   2. 上限不是从包里读的 → 改了包数字不变（纸质报告和实际检查对不上）
 *   3. 站点和包错配 → 拿美国规则给德国站出结论
 */

const de = rulePackFor("DE");
const us = rulePackFor("US");

const profile = {
  product_id: "P-DE", revision: 1, name_zh: "棉布手提袋", material: "Baumwolle",
  width: 38, height: 42, depth: null, fabric_weight_gsm: 140, capacity_l: null,
  handle_length_cm: 60, retail_pack_count: 1, brand: "", color: "natur",
};

const content = (title) => ({ title, item_highlights: "", bullet_points: [], description: "" });
const stateOf = (review, ruleId) =>
  review.checks.find((check) => check.rule_id === ruleId)?.state;

// —— 结构：字段照抄美国包，不许自创 ——

test("德国包的顶层字段与顺序和美国包一致（界面按字段名取，错一个就静默空白）", () => {
  assert.deepEqual(Object.keys(de), Object.keys(us));
});

test("德国包的单条规则没有美国包之外的自创字段", () => {
  const allowed = new Set(us.rules.flatMap((rule) => Object.keys(rule)));
  const extra = de.rules.flatMap((rule) =>
    Object.keys(rule).filter((key) => !allowed.has(key)).map((key) => `${rule.rule_id}::${key}`),
  );
  assert.deepEqual(extra, []);
});

test("德国包每个来源都能被规则定位，没有悬空引用", () => {
  const inventory = ruleInventory(de);
  assert.deepEqual(inventory.missing_sources, []);
  const cited = ruleCitations(de);
  assert.equal(cited.length, de.rules.length);
  assert.equal(cited.filter((item) => item.sources.length === 0).length, 0);
});

test("每条德国站自己的规则都写了正例与反例，且标明核验出处", () => {
  const own = de.rules.filter((rule) => rule.rule_id.startsWith("DE-"));
  assert.ok(own.length >= 8, `德国站自有规则应至少 8 条，实际 ${own.length}`);
  for (const rule of own) {
    assert.match(rule.note || "", /正例/, `${rule.rule_id} 缺正例`);
    assert.match(rule.note || "", /反例/, `${rule.rule_id} 缺反例`);
    assert.ok(rule.source_ids.length > 0, `${rule.rule_id} 没有来源`);
  }
});

// —— 上限真的从包里读 ——

test("标题上限从规则包读：默认德国包 75，同一句话改包上限立刻跟着变", () => {
  const longTitle = "Baumwolltasche Natur, 38 × 42 cm, 140 g/m², mit langen Henkeln, wiederverwendbar, faltbar";
  assert.ok(characterCount(longTitle) > 75 && characterCount(longTitle) < 100);

  const strict = reviewContent({ content: content(longTitle), profile, rulePack: de, marketplace: "DE" });
  assert.equal(stateOf(strict, "AMZ-01"), "fail");

  // 把上限提到 200：还是同一句话、同一份包结构，只是数字换了 —— 结论必须跟着换
  const loose = {
    ...de,
    rules: de.rules.map((rule) =>
      rule.rule_id === "AMZ-01" ? { ...rule, constraint: { ...rule.constraint, max_characters: 200 } } : rule,
    ),
  };
  const relaxed = reviewContent({ content: content(longTitle), profile, rulePack: loose, marketplace: "DE" });
  assert.equal(stateOf(relaxed, "AMZ-01"), "pass");
});

test("美国站上限没被德国站改动：仍是 75 / 125", () => {
  const amz01 = us.rules.find((rule) => rule.rule_id === "AMZ-01");
  const amz02 = us.rules.find((rule) => rule.rule_id === "AMZ-02");
  assert.equal(amz01.constraint.max_characters, 75);
  assert.equal(amz02.constraint.max_characters, 125);
  // 德国包现在也是 75/125（2026-10-30 抓到的 amazon.de 帮助页），但两条来自不同来源
  assert.equal(de.rules.find((rule) => rule.rule_id === "AMZ-01").constraint.max_characters, 75);
  assert.notDeepEqual(de.rules.find((rule) => rule.rule_id === "AMZ-01").source_ids, amz01.source_ids);
});

// —— 不许假绿 ——

test("德国包 19 条规则：引擎认识的全跑，不认识的必须 not_checked，一条都不许默认 pass", () => {
  assert.equal(de.rules.length, 19);
  const review = reviewContent({ content: content("Baumwolltasche"), profile, rulePack: de, marketplace: "DE" });
  for (const rule of de.rules) {
    const state = stateOf(review, rule.rule_id);
    assert.ok(state, `${rule.rule_id} 没有出现在检查清单里`);
    if (!IMPLEMENTED_RULE_IDS.has(rule.rule_id)) {
      assert.equal(state, "not_checked", `${rule.rule_id} 没有本地检查却给了一个非 not_checked 的结论`);
    }
  }
  // 已实现：DE-TITLE-02（重复词）、DE-TITLE-03（禁用符号）；其余 6 条仍待实现
  const unimplemented = de.rules.filter((rule) => !IMPLEMENTED_RULE_IDS.has(rule.rule_id));
  assert.equal(unimplemented.length, 6, "德国站自有规则应恰好 6 条尚未实现本地检查");
  assert.deepEqual(
    unimplemented.map((rule) => rule.rule_id).sort(),
    ["DE-CERT-01", "DE-ENV-01", "DE-GARANTIE-01", "DE-GPSR-19", "DE-TEXTIL-01", "DE-VERPACK-01"],
  );
});

test("站点与规则包对不上时，SYS-02 必须拦下，不拿美国包给德国站出结论", () => {
  const mismatch = reviewContent({
    content: content("Cotton Tote Bag"),
    profile,
    rulePack: us,
    marketplace: "DE",
  });
  assert.equal(stateOf(mismatch, "SYS-02"), "needs_evidence");
  const issue = mismatch.issues.find((item) => item.rule_id === "SYS-02");
  assert.match(issue.reason, /覆盖 US 站.*请求是 DE 站/);
});

// —— 取包入口 ——

test("默认市场仍是美国站；未知站点直接报错，不静默回落", () => {
  assert.equal(rulePack, rulePacks.US);
  assert.equal(normalizeMarketplace(undefined), "US");
  assert.equal(normalizeMarketplace("de"), "DE");
  // 2026-10-31 起 FR 是合法站点（法国站接通），所以这里改用真正不存在的站点当反例。
  assert.equal(normalizeMarketplace("FR"), "FR");
  assert.equal(normalizeMarketplace("JP"), null);
  assert.throws(() => rulePackFor("JP"), /没有 JP 站的规则包/);
});

// —— 德语提示词 ——

test("德语系统提示带德式数字与单位写法、不许英式直译、品牌型号原样保留", () => {
  const prompt = buildSystemPrompt({ rules: de.rules, language: "de", marketplace: "DE" });
  assert.match(prompt, /Amazon DE listing author/);
  assert.match(prompt, /38 × 42 cm/);
  assert.match(prompt, /140 g\/m²/);
  assert.match(prompt, /100 % Baumwolle/);
  assert.match(prompt, /never translate or localise them/);
  assert.match(prompt, /Title <= 75; Item highlights <= 125/);
});

test("德语分支不污染英语提示词", () => {
  const english = buildSystemPrompt({ rules: us.rules, language: "en", marketplace: "US" });
  assert.doesNotMatch(english, /38 × 42 cm|100 % Baumwolle|Amazon DE/);
  assert.match(english, /natural US English/);
});

// —— 法语分支：语言层 ——
// 法语能同时挂到两个市场下（美国站的语言层、法国站的正式站点），所以语言和站点分开看。
// 这里守的是两句：「美国站·法语」的提示词写法语、且不顺手宣称法国法域已核。
test("法语系统提示写法语约定，且不冒充已接入法国站", () => {
  const french = buildSystemPrompt({ rules: us.rules, language: "fr", marketplace: "US" });
  assert.match(french, /Listing content is French/);
  assert.match(french, /99,5 %/);
  assert.match(french, /1 000/);
  assert.match(french, /100 % coton/);
  assert.match(french, /15 to 20 percent longer/);
  assert.doesNotMatch(french, /100 % Baumwolle|Amazon DE/);
  // 站点是 US，所以不提法国站那套（Loi Toubon / amazon.fr）；Triman 只允许出现在否定句里。
  assert.doesNotMatch(french, /Loi Toubon|Amazon\.fr/);
  assert.match(french, /Do not claim French or EU compliance, a Triman marking/);
  assert.match(french, /not targeting the France marketplace/);
});

// —— 两条德国站标题规则的引擎级正反例 ——

test("DE-TITLE-02 重复词：同一个实词出现三次要报，介词连词重复不报", () => {
  const bad = "Baumwolltasche Baumwolltasche Baumwolltasche natur";
  const badReview = reviewContent({ content: content(bad), profile, rulePack: de, marketplace: "DE" });
  assert.equal(stateOf(badReview, "DE-TITLE-02"), "fail");
  assert.match(
    badReview.issues.find((item) => item.rule_id === "DE-TITLE-02").reason,
    /「baumwolltasche」出现 3 次/,
  );

  // 正例：每个实词只出现一次；mit / und / der 这类功能词出现三次也不报
  const good = "Baumwolltasche mit langen Henkeln und Tragegriffen für den Einkauf mit der Familie";
  const goodReview = reviewContent({ content: content(good), profile, rulePack: de, marketplace: "DE" });
  assert.equal(stateOf(goodReview, "DE-TITLE-02"), "pass");
});

test("DE-TITLE-03 禁用符号：_ ! ? 要报，× 与 ² 这类德语尺寸写法不报", () => {
  const bad = "Baumwolltasche_Bio! Jetzt kaufen?";
  const badReview = reviewContent({ content: content(bad), profile, rulePack: de, marketplace: "DE" });
  assert.equal(stateOf(badReview, "DE-TITLE-03"), "fail");
  const reason = badReview.issues.find((item) => item.rule_id === "DE-TITLE-03").reason;
  for (const char of ["_", "!", "?"]) assert.ok(reason.includes(`「${char}」`), `${char} 没被指出`);

  // 正例：乘号、上标、百分号、加号都不在禁用清单里
  const good = "Baumwolltasche, 38 × 42 cm, 140 g/m², 100 % Baumwolle";
  const goodReview = reviewContent({ content: content(good), profile, rulePack: de, marketplace: "DE" });
  assert.equal(stateOf(goodReview, "DE-TITLE-03"), "pass");
});

test("模型自报的规则 id 不在当前包里时一律丢弃（德国站评审不许出现 US-01..04）", () => {
  const modelReview = {
    issues: [],
    checks: [
      { rule_id: "US-01", state: "pass", reason: "模型自己报的，德国包里没有这条" },
      { rule_id: "DE-ENV-01", state: "pass", reason: "德国站环保规则，模型认为已通过" },
    ],
  };
  const review = reviewContent({
    content: content("Baumwolltasche, 38 × 42 cm"),
    profile,
    rulePack: de,
    modelReview,
    hasRealModel: true,
    marketplace: "DE",
  });
  assert.equal(
    review.checks.some((check) => check.rule_id === "US-01"),
    false,
    "包外的 US-01 被收进了德国站评审",
  );
  // 包内但引擎没实现本地检查的德国规则：模型说 pass 也不采纳，保持 not_checked。
  // 理由：德国站这几条是法律要求，模型"觉得没问题"不构成核实；宁可显示未完成。
  assert.equal(stateOf(review, "DE-ENV-01"), "not_checked");
});

// —— 德语纤维写法：合规写法不许被判成"没说清的百分比" ——
// 2026-10-30 真模型跑德国站：标题和亮点里的 `100 % Baumwolle`（(EU) 1007/2011 第 16 条
// 要求的成员国语言写法）被读成"这句里有一个百分比，但原文没说清它是'什么的百分比'"，
// 同一句德语文案凭空多出 2 条待核对。原因是纤维表只有英文词，而且 evidence.mjs 里
// 还另抄了一份 `cotton|polyester|nylon|linen`。

test("德语整词写法（100 % Baumwolle）认成棉 100%，不是「没有对象的百分比」", () => {
  const composition = parseComposition("100 % Baumwolle");
  assert.deepEqual(composition.fibers, ["cotton"]);
  assert.equal(composition.percents.cotton, 100);
  assert.equal(canonicalFiber("Baumwolle"), "cotton");
});

test("德语混纺两个成分都认，合计百分比按 100 判", () => {
  const composition = parseComposition("75 % Polyester, 25 % Baumwolle");
  assert.deepEqual(composition.fibers.sort(), ["cotton", "polyester"]);
  assert.equal(composition.totalPercent, 100);
  assert.equal(composition.blend, true);
});

test("德语写法与英文档案能对上（100 % Baumwolle vs 100% cotton 不算材质冲突）", () => {
  const verdict = compareFiber(parseComposition("100% cotton"), "cotton", 100);
  assert.equal(verdict.state, "match", `判成了 ${verdict.state}：${verdict.note}`);
});

test("只认整词，不猜德语复合词（Baumwolltasche 是商品名，不是成分声明）", () => {
  // 认不出只是"没关联"，不会变成"说错了"。按词根猜成分等于替商家补事实。
  assert.deepEqual(parseComposition("Baumwolltasche mit 140 g/m²").fibers, []);
  assert.deepEqual(parseComposition("100 % Baumwollgewebe").fibers, []);
});

// —— 站点必须显式传给评审 ——
// service.mjs 曾经没把 marketplace 传下去，reviewContent 默认按 "US" 判，
// 于是德国站每次生成都多一条「规则包覆盖 DE 站，本次请求是 US 站」的假警报（已落库的真实记录里就有）。

test("德国包 + 站点 DE：没有「包与请求对不上」的假警报", () => {
  const review = reviewContent({
    content: content("Baumwolltasche, 38 × 42 cm"),
    profile,
    rulePack: de,
    marketplace: "DE",
  });
  assert.equal(review.issues.some((issue) => issue.rule_id === "SYS-02"), false);
});

test("德国包 + 站点 US：守卫仍然开枪（不传站点时默认 US，所以要显式传）", () => {
  const review = reviewContent({
    content: content("Baumwolltasche, 38 × 42 cm"),
    profile,
    rulePack: de,
    marketplace: "US",
  });
  const sys = review.issues.find((issue) => issue.rule_id === "SYS-02");
  assert.ok(sys, "包与请求站点不一致时必须报 SYS-02");
  assert.match(sys.reason, /DE/);
});

// —— 美国专有的召回不许在德国包上跑 ——
// 2026-10-30 抓德国站真实语料时踩到：一条德语描述里带 "abbaubar"，引擎走到 US-02 那段，
// `add("US-02", …)` 里 `rules.get("US-02")` 是 undefined，直接 TypeError —— 整批采集中断。
// 这不是采集脚本的问题：德国站的商品文案只要出现「可降解 / 可堆肥」字样，评审就会 500。

test("德国包遇到降解/环保类文案不崩，也不冒出美国规则号", () => {
  const review = reviewContent({
    content: {
      title: "Baumwolltasche natur, 38 × 42 cm",
      item_highlights: "",
      bullet_points: [
        { id: "b1", text: "Biologisch abbaubar und kompostierbar, umweltfreundlich." },
        { id: "b2", text: "Eco-friendly und nachhaltig für den täglichen Einkauf." },
      ],
      description: "Hergestellt aus 100 % Baumwolle, waschbar bei 30 °C.",
    },
    profile,
    rulePack: de,
    marketplace: "DE",
  });
  const usIssues = review.issues.filter((issue) => /^US-0\d$/.test(issue.rule_id));
  assert.deepEqual(usIssues, [], "德国包里没有 US-01…US-04，报了就是拿美国标准给德国站出结论");
  // 美国包反过来必须照旧报：这条守的是「守卫别加错地方」。
  const usReview = reviewContent({
    content: {
      title: "Cotton tote bag",
      item_highlights: "",
      bullet_points: [{ id: "b1", text: "Biodegradable and compostable, eco-friendly." }],
      description: "",
    },
    profile: null,
    rulePack: us,
    marketplace: "US",
  });
  assert.ok(
    usReview.issues.some((issue) => issue.rule_id === "US-02"),
    "美国包里这条仍然要报，否则就是把召回整段关掉了",
  );
});

// 第 9 轮：附件 I 里同一行的"另一个名字"要认，凭原文加、不凭印象加。
//   linen 收 flachs：附件 I 表 1 第 7 条德文原文「Flachs bzw. Leinen」——
//     一句话里两个名字，是同一行的同一种纤维，不是两种。
//   nylon 收 polyamide：附件 I 表 2 第 30 条英文原文「polyamide or nylon」。
// 德文的 `Polyamid` 仍然不认 —— 附件 I 德文版第 30 条原文本轮没取到，不凭"一般这么写"加。
test("附件 I 同一行的另一个名字也认：Flachs 是亚麻、polyamide 是尼龙", () => {
  assert.equal(canonicalFiber("Flachs"), "linen");
  assert.equal(canonicalFiber("flachs"), "linen");
  assert.equal(canonicalFiber("polyamide"), "nylon");
  const composition = parseComposition("100 % Flachs");
  assert.deepEqual(composition.fibers, ["linen"]);
  assert.equal(composition.percents.linen, 100);
});

test("德文 Polyamid 仍不认（没有原文就不加，认不出只是没关联，不会变成说错了）", () => {
  assert.equal(canonicalFiber("Polyamid"), "polyamid");
  assert.deepEqual(parseComposition("100 % Polyamid").fibers, []);
});
