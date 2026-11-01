// 工作单纸面上的「怎么改」：两句话都在，而且按词分流的那句不许被规则包一句盖掉。
//
// 为什么值得一组测试（第 21 轮 · 方向 C）：渲染层原来是
// `action ? 只印 action : 才印 suggestion`，45 条真实语料里 **42/42 条问题的具体建议
// 一个字都没到纸面**。这个缺陷在屏幕上量不出来（界面显示的是 suggestion），
// 只有把工作单折出来数原文才看得见。
import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent } from "../server/domain.mjs";
import { rulePack, scenarios } from "../server/store.mjs";
import { advicePair, buildWorklist, worklistSection } from "../server/worklist.mjs";
import { escapeHtml } from "../server/report.mjs";

const product = scenarios.product_profiles[0];

const content = (text) => ({
  title: "Cotton Canvas Tote Bag",
  item_highlights: "",
  bullet_points: [{ id: "b1", text }],
  description: "",
});

/** 一段文案 → 工作单 HTML（与报告、单页导出走同一条渲染路径）。 */
function paper(text, rules = rulePack.rules) {
  const review = reviewContent({ content: content(text), profile: product, rulePack });
  const worklist = buildWorklist(review.issues, rules, new Map());
  return { html: worklistSection(worklist, escapeHtml), issues: review.issues, worklist };
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

test("含再生材料与宽泛环保：纸面上的「这一条」不是同一句话", () => {
  const recycled = paper("Made from 100% recycled cotton canvas.");
  const eco = paper("Eco-friendly tote for everyday shopping.");
  const line = (html) => /<strong>怎么改（这一条）：<\/strong>([^<]*)</.exec(html)?.[1] || "";
  const a = line(recycled.html);
  const b = line(eco.html);
  assert.ok(a, "含再生材料那条没有「怎么改（这一条）」");
  assert.ok(b, "宽泛环保那条没有「怎么改（这一条）」");
  assert.notEqual(a, b, "两条不同类的环保宣称拿到了同一句改法");
  assert.match(a, /比例/, "含再生材料应当要求补比例");
  assert.match(b, /移除|换成具体/);
});

test("每个问题都同时印出「这一条」和「这条规则的标准改法」", () => {
  const { html, issues } = paper("Eco-friendly and made from recycled cotton canvas.");
  assert.ok(issues.some((x) => x.rule_id === "US-01"));
  assert.match(html, /怎么改（这一条）：/);
  assert.match(html, /这条规则的标准改法：/);
  // 两句话必须都是原文里那句，不许拿摘要替身。
  const issue = issues.find((x) => x.rule_id === "US-01");
  assert.ok(html.includes(escapeHtml(issue.suggestion)), "具体建议没印到纸上");
  const repair = rulePack.rules.find((x) => x.rule_id === "US-01").repair;
  assert.ok(html.includes(escapeHtml(repair)), "标准改法没印到纸上");
});

test("两句话是同一件事时只印一遍（避免读成要改两处）", () => {
  const { issues } = paper("Eco-friendly tote.");
  const issue = issues.find((x) => x.rule_id === "US-01");
  // 把规则包的 repair 换成与这一条建议一模一样的句子。
  const rules = [{ rule_id: "US-01", title_zh: "环保宣称", repair: issue.suggestion }];
  const one = paper("Eco-friendly tote.", rules);
  assert.equal(count(one.html, escapeHtml(issue.suggestion)), 1, "同一句话被印了两遍");
  assert.doesNotMatch(one.html, /这条规则的标准改法：/);
  assert.doesNotMatch(one.html, /怎么改（这一条）：/, "同一句话不该标成两句");
});

test("规则包里没有 repair：明说没有，但建议照样印", () => {
  const { issues } = paper("Eco-friendly tote.", []);
  const issue = issues.find((x) => x.rule_id === "US-01");
  const html = worklistSection(buildWorklist([issue], [], new Map()), escapeHtml);
  assert.match(html, /这条规则没有写标准改法。/);
  assert.ok(html.includes(escapeHtml(issue.suggestion)));
});

test("两句都空：不留一个空的「怎么改：」", () => {
  const html = worklistSection(
    buildWorklist(
      [{ rule_id: "US-01", field_path: "content.title", severity: "needs_review", title: "环保宣称" }],
      [],
      new Map(),
    ),
    escapeHtml,
  );
  assert.match(html, /按规则说明人工判断/);
  assert.doesNotMatch(html, /<strong>怎么改：<\/strong><\/p>/);
});

test("advicePair：包含关系只印长的那个，不按谁是谁判", () => {
  // 标准改法是建议的一部分（规则包写得更细）→ 只印标准改法那句。
  const contained = advicePair({ action: "删掉这个词。", suggestion: "删掉这个词，或换成具体证据。" });
  assert.equal(contained.lines.length, 1);
  assert.equal(contained.lines[0].text, "删掉这个词，或换成具体证据。");
  assert.equal(contained.deduped, true);
  // 两句不相干 → 两句都印，且「这一条」在前。
  const both = advicePair({ action: "标准改法一句话。", suggestion: "这一条的具体建议。" });
  assert.deepEqual(
    both.lines.map((x) => x.label),
    ["怎么改（这一条）", "这条规则的标准改法"],
  );
  // 空白不算内容。
  assert.equal(advicePair({ action: "  ", suggestion: "" }).missing, true);
});
