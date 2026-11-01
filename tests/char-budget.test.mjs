import test from "node:test";
import assert from "node:assert/strict";
import { charBudget, charBudgetSection } from "../server/char-budget.mjs";

// 为什么单开一个文件：字符数上限这句话在本仓库里被写死过两次（prompt 一处、这份报告的脚注一处），
// 两处都不会自己报错。prompt 那处已经改成读规则包（第 6 轮），这里盯住脚注这一处。

const pack = (limits) => ({
  rules: limits.map(([rule_id, field_paths, max]) => ({ rule_id, field_paths, constraint: { max_characters: max } })),
});

test("the footnote prints this pack's numbers, never a hardcoded 75/125", () => {
  const rules = pack([
    ["AMZ-01", ["content.title"], 80],
    ["AMZ-02", ["content.item_highlights"], 140],
  ]).rules;
  const html = charBudgetSection(charBudget({ title: "x".repeat(90), item_highlights: "h" }, rules));
  assert.match(html, /标题 80/);
  assert.match(html, /亮点 140/);
  // 换包之后旧数字不许再印到纸上——印错一个数字，商家按它改稿就是白改。
  assert.doesNotMatch(html, /标题 75/);
  assert.doesNotMatch(html, /亮点 125/);
});

test("a pack with no limits prints no numbers at all", () => {
  const html = charBudgetSection(charBudget({ title: "abc", item_highlights: "h" }, []));
  assert.match(html, /本规则包未规定上限/);
  // 上限一列全是「未规定」，脚注就不该出现任何数字（除了表头里没有数字）。
  assert.doesNotMatch(html, /本次：/);
});

test("over-limit is counted per field and only where the pack sets a limit", () => {
  const rules = pack([["AMZ-01", ["content.title"], 10]]).rules;
  const budget = charBudget({ title: "12345678901", item_highlights: "h", description: "d" }, rules);
  assert.equal(budget.over_limit, 1);
  assert.equal(budget.limited, 1, "只有标题有上限，其余字段不许算进这一列");
});
