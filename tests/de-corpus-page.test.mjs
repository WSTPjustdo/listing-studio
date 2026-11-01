import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPage } from "../scripts/render-de-corpus-page.mjs";
import { rulePackFor } from "../server/store.mjs";

/**
 * `qa/de-corpus-evidence.html` 是给评委看的一页纸。它上面的每个数字都必须能被重算出来 ——
 * 所以这里不检查「看起来对不对」，而是拿同一份语料 + 同一个引擎重新生成一遍，
 * 再核对纸上写着的关键数字。语料改了、引擎改了，这一页就必须重新生成，否则这里红。
 */

const DEV = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(readFileSync(resolve(DEV, "data-research/de-listings-20261030.json"), "utf8"));
const page = readFileSync(resolve(DEV, "qa/de-corpus-evidence.html"), "utf8");
const rebuilt = buildPage(corpus, rulePackFor("DE"));
const pack = rulePackFor("DE");

test("页上的数字与语料 + 引擎重算一致（不一致就说明这页过期了）", () => {
  for (const needle of [
    `${corpus.items.length}</div>`,
    `${corpus.stats.title_chars.over_cap}/${corpus.items.length}`,
    `${corpus.stats.title_chars.median}</div>`,
  ])
    assert.ok(rebuilt.includes(needle), `重新生成的内容里找不到 ${needle}`);
  // 磁盘上的这一份必须是同一份
  for (const needle of [`跑过 ${corpus.items.length} 条真实在售商品`, `${corpus.stats.title_chars.over_cap}/${corpus.items.length}`])
    assert.ok(page.includes(needle), `qa/de-corpus-evidence.html 过期了：找不到「${needle}」，跑 node scripts/render-de-corpus-page.mjs 重生成`);
});

test("19 条规则一条不落，且每条都标了「本地可判 / 部分可判 / 需人工」", () => {
  for (const rule of pack.rules) assert.ok(page.includes(rule.rule_id), `${rule.rule_id} 没出现在这一页上`);
  assert.equal(page.includes("部分可判"), true);
  // DE-TEXTIL-01 是唯一「部分可判」的：错标成「本地可判」就等于宣称成分标注判完了
  const row = page.split("\n").find((line) => line.includes("DE-TEXTIL-01"));
  assert.match(row, /部分可判/);
});

test("判定方式用短标签，不把 method 英文长串排进表格（会撑破一页）", () => {
  // 这行守的是一个已经踩过的排版坑：`candidate_detection_and_contextual_review`
  // 直接排进 12% 宽的列，每行撑成四行，整页溢到第二张纸上。
  for (const method of ["candidate_detection_and_contextual_review", "structured_comparison_and_semantic_review"])
    assert.equal(page.includes(`>${method}<`), false, `表格里还排着 ${method} 这个长串`);
  assert.equal(rebuilt.includes("候选+复核"), true);
  assert.equal(rebuilt.includes("结构+语义"), true);
});
