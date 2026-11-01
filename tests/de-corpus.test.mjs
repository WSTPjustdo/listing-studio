import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewContent, characterCount, IMPLEMENTED_RULE_IDS } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";

/**
 * 德国站竞品语料的可复现性。
 *
 * 为什么要有这份测试：`data-research/de-listings-20261030.md` 里的数字（标题超 75 是 5/17、
 * 各规则命中几）是拿给评委看的。这些数字只由两样东西决定 —— 落盘的语料 + 当前的规则引擎。
 * 两样都在仓库里，所以**它们必须能在这里重算出来**：
 * 引擎一改、包一改，报告里的数就该跟着红，而不是继续躺在纸上。
 *
 * 这份测试不联网：语料是 2026-10-30 抓下来的快照，页面上的字不会变。
 */

const DEV = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(readFileSync(resolve(DEV, "data-research/de-listings-20261030.json"), "utf8"));
const pack = rulePackFor("DE");
const reviewOf = (item) =>
  reviewContent({
    content: {
      title: item.title,
      item_highlights: "",
      bullet_points: (item.bullets || []).map((text, i) => ({ id: `b${i + 1}`, text })),
      description: item.description || "",
    },
    profile: null,
    rulePack: pack,
    marketplace: "DE",
  });

test("语料是德国站的、每一条都能回到原页面", () => {
  assert.equal(corpus.marketplace, "DE");
  assert.ok(corpus.items.length >= 15, `样本量 ${corpus.items.length} 条，太少就不该拿去做统计`);
  for (const item of corpus.items) {
    assert.match(item.url, /^https:\/\/www\.amazon\.de\/dp\/[A-Z0-9]{10}$/, `${item.asin} 的 URL 不是德国站商品页`);
    assert.equal(item.http_status, 200, `${item.asin} 不是 200`);
    assert.ok(item.page_bytes > 20000, `${item.asin} 的页面只有 ${item.page_bytes} 字节，可能是空壳页`);
    assert.ok(item.retrieved_at, `${item.asin} 没有读取时间，别人没法判断这份快照有多旧`);
  }
});

test("报告里的「标题超 75」条数能在这里重算出来", () => {
  const cap = pack.rules.find((rule) => rule.rule_id === "AMZ-01").constraint.max_characters;
  const over = corpus.items.filter((item) => characterCount(item.title) > cap).length;
  assert.equal(over, corpus.stats.title_chars.over_cap, "语料里的字符数或包里的上限变了，报告的 5/17 就不成立了");
  assert.equal(over, 5, `本轮报告写的是 5 条超限，重算是 ${over} 条`);
});

test("每条规则在这批语料上的命中数能重算，且不冒出美国规则号", () => {
  const hits = new Map();
  for (const item of corpus.items) {
    const review = reviewOf(item);
    for (const id of new Set(review.issues.map((issue) => issue.rule_id))) hits.set(id, (hits.get(id) || 0) + 1);
    const us = review.issues.filter((issue) => /^US-0\d$/.test(issue.rule_id));
    assert.deepEqual(us, [], `${item.asin} 报了美国站的规则号：${us.map((x) => x.rule_id).join(",")}`);
  }
  const expected = new Map(corpus.stats.rule_hits.map((row) => [row.rule_id, row.hits]));
  for (const [ruleId, count] of hits) assert.equal(expected.get(ruleId), count, `${ruleId} 命中数对不上：报告 ${expected.get(ruleId)}，重算 ${count}`);
  for (const [ruleId, count] of expected) if (!hits.has(ruleId) && count !== 0) assert.fail(`${ruleId} 报告 ${count} 条，重算一次都没命中`);
});

test("报告里的「本地可判 13 / 需模型人工 6」和引擎白名单一致", () => {
  const checkable = pack.rules.filter((rule) => IMPLEMENTED_RULE_IDS.has(rule.rule_id)).length;
  assert.equal(corpus.stats.engine.checkable, checkable, "IMPLEMENTED_RULE_IDS 变了，报告的分档就要跟着改");
  assert.equal(corpus.stats.engine.total, pack.rules.length);
  assert.equal(corpus.stats.engine.checkable + corpus.stats.engine.model_or_human_only, pack.rules.length);
});

test("每条都是从德国站端点取的，且标题带德语品类词", () => {
  // 「标题里有没有 ä/ö/ü」和「有没有 tote bag」都不能当语言判据：
  // 德语卖家常写 Baumwolltasche（不带变音），也常用 Tote Bag 这个外来词
  // （真实样本里就有 `Stoffbeutel … Baumwolltasche 145 g/m² - Tote Bag zum Bemalen`）。
  // 能核的是**取数端点**：URL 必须是 amazon.de 且显式带 language=de_DE，否则拿到的可能是别的语言变体。
  for (const item of corpus.items) {
    assert.match(item.fetched_url, /^https:\/\/www\.amazon\.de\/dp\/[A-Z0-9]{10}\?language=de_DE$/, `${item.asin} 不是从德国站端点取的`);
    assert.match(item.title, /(tasche|taschen|beutel|shopper|tragetasche|einkaufstasche|stofftasche|einkaufsbeutel)/i, `${item.asin} 的标题里没有德语品类词：${item.title.slice(0, 80)}`);
  }
});
