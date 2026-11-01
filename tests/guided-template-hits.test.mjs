import test from "node:test";
import assert from "node:assert/strict";
import { guidedPlanSystemPrompt, templateHardcodeHits, validateGuidedPlanResult } from "../server/guided.mjs";

/**
 * 第 10 轮踩出来的：法语引导流程连着两次被判「模板固化了具体商品信息」，
 * 失败记录里只有一个错误码 —— 不知道是哪条判据、命中的是哪几个字。
 * 于是只能再花一次付费调用去猜。
 *
 * 这里钉两件事：
 *   1) 命中项要说清（哪条判据 + 命中文字），并且进 trace（失败记录只存 trace）；
 *   2) 系统提示里为了说清数字惯例而带的示例（`99,5 %`、`38 × 42 cm`…）**正好是**校验会拒的字面量，
 *      所以提示里必须有一条明确的「别把示例数字抄进模板」禁令。
 */

const prepared = {
  product: { product_id: "P-TPL", revision: 1, brand: { value: "Beispiel" }, reference_product_id: null, sku: null },
  research_context: { items: [] },
};
const raw = (prompt) => JSON.stringify({ optimized_prompt: prompt, changes: [], missing: [] });
const WITH_PLACEHOLDERS = "Write the title, item highlights, bullets and description from {{PRODUCT_FACTS}}, and use {{KEYWORDS}} as candidate keywords only — never as evidence of product facts or performance.";

test("四类字面量都能被认出来（这正是模型最容易从提示里抄走的东西）", () => {
  assert.deepEqual(templateHardcodeHits("keep the title within the limits"), []);
  assert.equal(templateHardcodeHits("size 38 × 42")[0].pattern, "dimension_values");
  assert.equal(templateHardcodeHits("dimensions 38 × 42 cm")[0].pattern, "fixed_units");
  assert.equal(templateHardcodeHits("fabric weight 140 g/m²")[0].pattern, "fixed_units");
  assert.equal(templateHardcodeHits("write 99,5 % with a comma")[0].pattern, "fixed_units");
  assert.equal(templateHardcodeHits("state 100 % coton")[0].pattern, "fixed_units");
  assert.equal(templateHardcodeHits("sell it as 3 bags")[0].pattern, "pack_values");
  assert.equal(templateHardcodeHits("title max 80 characters")[0].pattern, "fixed_units");
});

test("「20 percent longer」是散文，不是商品数据（符号形式的百分比照旧算）", () => {
  // 第 10 轮第 3 次付费调用换来的：法语提示里那句「French runs 15 to 20 percent longer than English」
  // 被模型原样抄进模板，校验把 20 percent 当成硬编码百分比，模板第三次被拒。
  assert.deepEqual(templateHardcodeHits("French runs 15 to 20 percent longer than English"), []);
  assert.deepEqual(templateHardcodeHits("30 percent smaller than the old model"), []);
  // 但写成含量就必须拦：这是商品数据
  assert.equal(templateHardcodeHits("state 100 percent cotton")[0].pattern, "fixed_units");
  assert.equal(templateHardcodeHits("state 100 % coton")[0].pattern, "fixed_units");
});

test("品牌名出现在模板里也算硬编码（复用时会带着上一家的名字）", () => {
  const hits = templateHardcodeHits("Made by Beispiel for everyday use", ["Beispiel"]);
  assert.equal(hits[0].pattern, "product_identifier");
});

test("被拒时要说清命中哪一条，并写进 trace（否则下一轮只能再付费猜一次）", () => {  const trace = {};
  assert.throws(
    () => validateGuidedPlanResult(raw(`${WITH_PLACEHOLDERS} Keep it 38 × 42.`), prepared, trace),
    (error) => error.code === "GUIDED_TEMPLATE_INVALID" && /命中：dimension_values「38 × 42」/.test(error.message),
  );
  assert.equal(trace.template_hits[0].pattern, "dimension_values");
  assert.equal(trace.template_hits[0].match, "38 × 42");
});

test("干净模板照旧通过，trace 里不留命中记录", () => {
  const trace = {};
  const result = validateGuidedPlanResult(raw(`${WITH_PLACEHOLDERS} Describe the fibre composition from the facts.`), prepared, trace);
  assert.equal(typeof result.optimized_prompt, "string");
  assert.equal(trace.template_hits, undefined);
});

test('系统提示必须写明「示例数字不是商品数据，别抄进模板」', () => {
  for (const [language, marketplace] of [["en", "US"], ["es", "US"], ["de", "DE"], ["fr", "US"]]) {
    const prompt = guidedPlanSystemPrompt(false, language, marketplace);
    assert.match(prompt, /is a \*\*format example\*\*, not this product's data/, `${language} 缺这条禁令`);
  }
});

test("德语/法语提示里确实还带着示例字面量（所以那条禁令不是可有可无的）", () => {
  // 这两门语言的提示为了说清数字惯例，必须给出示例（99,5 %、38 × 42 cm、140 g/m²、100 % coton），
  // 而这些正好是模板校验会拒的东西。记在这里是为了下次想把禁令删掉时先看到这句话。
  for (const [language, marketplace] of [["de", "DE"], ["fr", "US"]]) {
    const hits = templateHardcodeHits(guidedPlanSystemPrompt(false, language, marketplace));
    assert.ok(hits.length > 0, `${language} 提示里的示例没了？那就把这条测试改成"无风险"并说明原因`);
  }
});
