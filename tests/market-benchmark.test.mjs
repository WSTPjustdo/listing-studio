import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compareToListing, loadBaseline, measureListing, summaryLine } from "../server/market-benchmark.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const factOf = (result, key) => result.facts.find((f) => f.key === key);

const good = {
  title: "Cotton Canvas Tote Bag, 15 x 16 in, 12 oz, Reusable Grocery Bag",
  bullet_points: [
    { id: "b1", text: "Size: 15 x 16 x 4 in." },
    { id: "b2", text: "12 oz cotton canvas." },
    { id: "b3", text: "Holds up to 10 kg." },
    { id: "b4", text: "Machine washable." },
    { id: "b5", text: "1 pack, reusable for years." },
  ],
  description: "Everyday canvas tote.",
};

test("基线能读，且样本量与快照日期都写在里面", () => {
  const baseline = loadBaseline();
  assert.equal(baseline.schema, "market-baseline/1");
  assert.equal(baseline.scope.n, 45);
  assert.equal(baseline.scope.marketplace, "amazon.com");
  assert.equal(baseline.title_chars.sorted.length, 45);
  // 分位必须有序，否则「比 X% 的同类长」会算错
  const sorted = baseline.title_chars.sorted;
  assert.deepEqual(sorted, [...sorted].sort((a, b) => a - b));
});

test("基线里不许出现别人的 listing 原文（只许聚合数字）", () => {
  const raw = readFileSync(join(here, "..", "server", "benchmark", "baseline-amazon-us-tote.json"), "utf8");
  // 连续 60 个以上英文词字符＝可能是一段原文；我们的字段名最长也就几十。
  const longEnglish = raw.match(/[A-Za-z][A-Za-z ,.'"()-]{60,}/g) || [];
  assert.deepEqual(longEnglish, [], `基线里出现了疑似原文：${longEnglish[0]}`);
  assert.ok(raw.length < 8000, `基线 ${raw.length} 字节，聚合统计不该这么大`);
});

test("两种文案形状都要认：bullet_points 与 bullets", () => {
  const a = measureListing(good);
  const b = measureListing({
    title: good.title,
    bullets: good.bullet_points.map((x) => x.text),
    description: good.description,
  });
  assert.equal(a.bullet_count, 5);
  assert.deepEqual(a, b);
});

test("标题超 75 时给 attention，并说清样本量与分位", () => {
  const long = { ...good, title: `${good.title} with Reinforced Handles for Beach Travel School Work Daily Use` };
  const result = compareToListing(long);
  const fact = factOf(result, "title_chars");
  assert.equal(fact.level, "attention");
  assert.match(fact.sentence, /45 条/);
  assert.match(fact.sentence, /42%/);
  assert.match(fact.sentence, /比 \d+% 的同类都长/);
});

test("标题在 75 以内时给 ok，不制造焦虑", () => {
  const result = compareToListing(good);
  assert.equal(factOf(result, "title_chars").level, "ok");
});

test("环保词没有证据要报 attention，而 100% cotton 不算证据", () => {
  const result = compareToListing({
    ...good,
    bullet_points: [...good.bullet_points.slice(0, 4), { id: "b5", text: "100% cotton, eco-friendly, good for the planet." }],
  });
  const fact = factOf(result, "eco");
  assert.equal(fact.level, "attention");
  assert.equal(result.measured.has_eco_evidence, false, "100% cotton 是成分，不是环保证据");
  assert.match(fact.sentence, /只有 1 条给出可核查证据/);
});

test("环保词带可核查证据时给 ok", () => {
  const result = compareToListing({
    ...good,
    bullet_points: [...good.bullet_points.slice(0, 4), { id: "b5", text: "Made from 100% recycled cotton." }],
  });
  assert.equal(result.measured.has_eco_evidence, true);
  assert.equal(factOf(result, "eco").level, "ok");
});

test("只写 gsm 不写 oz 要报 attention（美国买家按 oz 读）", () => {
  // 注意：不能沿用 good 的 bullet（里面有 12 oz），否则 oz 与 gsm 同时存在，走的是 ok 分支。
  const result = compareToListing({
    title: "Cotton Canvas Tote Bag, 15 x 16 in, Reusable Grocery Bag",
    bullet_points: [
      { id: "b1", text: "Size: 15 x 16 x 4 in." },
      { id: "b2", text: "320 gsm cotton canvas." },
      { id: "b3", text: "Holds up to 10 kg." },
      { id: "b4", text: "Machine washable." },
      { id: "b5", text: "1 pack." },
    ],
    description: "Everyday canvas tote.",
  });
  const fact = factOf(result, "weight_unit");
  assert.equal(fact.level, "attention");
  assert.match(fact.sentence, /82%/);
  assert.equal(result.measured.weight_units.gsm, true);
  assert.equal(result.measured.weight_units.oz, false);
});

test("五点条数不是 5 时要提示，且列出同类的真实分布", () => {
  const result = compareToListing({ ...good, bullet_points: good.bullet_points.slice(0, 4) });
  const fact = factOf(result, "bullet_count");
  assert.equal(fact.level, "attention");
  assert.match(fact.sentence, /42 条写了 5 点/);
});

test("一份没有毛病的文案，不该有一条 attention", () => {
  const result = compareToListing(good);
  assert.equal(result.attention, 0, JSON.stringify(result.facts.filter((f) => f.level === "attention")));
  assert.match(summaryLine(result), /没有明显偏离/);
});

test("每条结论都必须带样本量，不许说「市场普遍」", () => {
  const result = compareToListing({ ...good, title: `${good.title} extra words to push it over seventy five chars` });
  for (const fact of result.facts) {
    assert.match(fact.sentence, /45 条/, `${fact.key} 的结论没写样本量：${fact.sentence}`);
    assert.doesNotMatch(fact.sentence, /普遍|大多数人都|众所周知/);
  }
});

// ---- 接进报告的那一节 ----

import { benchmarkSection } from "../server/benchmark-section.mjs";

test("报告里的一节：带样本量、带字符标记（黑白打印也读得懂）", () => {
  const html = benchmarkSection(good);
  assert.match(html, /历史样本写法对照（45 条/);
  assert.match(html, /队友提供历史聚合快照，原始样本待补/);
  assert.match(html, /口径：/);
  // 三档必须有字符标记，不能只靠颜色
  assert.match(html, /[▲✓·] /);
  assert.match(html, /不是整个市场的结论/);
});

test("报告里的一节：不回声商家原文，所以没有注入面", () => {
  // 这一节只说数字（「你现在 171 字符」），从不把商家文案粘进来。
  // 因此既不该出现标签，也不该出现被转义后的原文——两者都不该有。
  const html = benchmarkSection({
    ...good,
    title: '<script>alert(1)</script> Cotton Tote Bag, 15 x 16 in, 12 oz, Canvas Grocery Bag',
  });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /alert\(1\)/);
  assert.doesNotMatch(html, /&lt;script&gt;/, "既然不回声，就不该出现转义后的副本");
});

test("没有文案时不出这一节，不给空白小节", () => {
  assert.equal(benchmarkSection(null), "");
  assert.equal(benchmarkSection({ title: "", bullet_points: [] }), "");
});

test("基线文件读不到时整节消失，不许拿半截数据糊结论", () => {
  assert.equal(benchmarkSection(good, { baseline: { schema: "unknown" } }), "");
});
