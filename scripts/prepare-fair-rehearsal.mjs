// Prepare a simulated merchant journey from public product facts and real saved AI results.
// No credentials, database, invented inventory or simulated model response is exported.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.mjs';
import { getConfig, invokeModel } from '../server/providers.mjs';
import { detachStore, listCalls, summarize } from '../server/telemetry.mjs';
import { contentSchema, flattenContent } from '../server/domain.mjs';

if (!process.argv.includes('--real-api')) throw new Error('Use --real-api to authorize paid preparation. There is no mocked fallback.');
const directory = resolve('reports/fair-rehearsal-2026-11-01');
const file = resolve(directory, 'case.json');
mkdirSync(directory, { recursive: true });
if (existsSync(file) && !process.argv.includes('--resume')) throw new Error('Prepared case already exists. Use --resume to continue without replacing saved calls.');
const source = JSON.parse(readFileSync(resolve(directory, 'product-source.json'), 'utf8'));
const local = createStore();
const config = getConfig(local);
local.close();
if (config.provider !== 'compatible' || !config.api_key || new URL(config.base_url).hostname !== 'api.deepseek.com')
  throw new Error('Existing local DeepSeek configuration required. No demo fallback.');
detachStore();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {
  schema_version: 1,
  product_name: 'THERMOS Stainless King 16oz Tumbler',
  scope: '公开保温杯样例的模拟商家流程；仅审核文案与厂家公开资料的一致性及无依据宣称，不是完整品类、法规或上架验收。',
  prepared_at: new Date().toISOString(), source_file: 'product-source.json',
  simulation_notice: '无真实商家资料。商家操作与问题稿为演练；公开商品资料及标为真实的 DeepSeek 调用可追溯。无商家 SKU、库存或上架登记。',
  calls: [], steps: [], limitations: [
    '官方页面是厂家公开宣称，未取得独立保温测试、食品接触/迁移检测或认证原件。',
    '无真实商家授权、库存、零售包装、商家SKU、价格、物流、售后或 Seller Central 数据。',
    '未覆盖保温杯品类和食品接触法规、平台完整规则或卖家上架资质。',
    '预先保存的成功结果不保证现场网络或新模型请求成功；失败保留原因，不显示为成功。',
  ], acceptance: { status: 'incomplete' },
};
const priorCalls = [...data.calls];
function save() {
  data.calls = [...priorCalls, ...listCalls(500).reverse()];
  data.call_summary = summarize(data.calls);
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

const rules = [
  { rule_id: 'BTL_FACT_MATCH', description: '逐句核对商品名、容量、材质与厂家来源。仅比较现有文案，不要求补写未知字段。' },
  { rule_id: 'BTL_CLAIM_SCOPE', description: '核对保温时间及限定条件。只允许把厂家宣称明确归因给 THERMOS（如 THERMOS states...），不得把厂家资料称为独立测试或平台认可；up to 7 hours hot / up to 18 hours cold，不可扩大。防漏必须保留 closed and properly assembled 条件。没有保温或防漏宣称时本项只确认文案未作该宣称，不代表性能被证实。' },
  { rule_id: 'BTL_UNSUPPORTED', description: '识别未经证实的 FDA/食品接触认证、治病、绝对化安全、永久保温、环保等实际文案宣称。没有宣称就不因缺证本身报文字问题。未知资料不许编造。' },
  { rule_id: 'BTL_OUTSIDE_SCOPE', description: '食品接触法规、完整品类规则、卖家资质、品牌授权和上架状态始终 not_checked；不因此将不存在的声明写为 issues。' },
];
const sourceId = source.source.id;
const fact = value => ({ value, status: 'public_source', source_ids: [sourceId] });
// These snippets must be present in the actually captured official page.
const sourceText = JSON.stringify(source);
for (const value of ['475', '18/8', '7', '18', 'properly assembled'])
  assert.ok(sourceText.includes(value), `Official captured source is missing ${value}`);
const product = {
  product_id: 'PUBLIC-THERMOS-SK1005-FAIR', name_zh: data.product_name,
  brand: fact('THERMOS'), material: fact('18/8 stainless steel'),
  capacity_ml: fact(475), merchant_sku: { value: null, status: 'unknown', source_ids: [] },
  additional_facts: [
    ['Manufacturer published capacity', '16oz / 475 ml'],
    ['Manufacturer insulation claim (not independently tested)', 'THERMOS states: keeps beverages hot for up to 7 hours and cold for up to 18 hours.'],
    ['Manufacturer lid claim (retain conditions)', 'DrinkLock sealing lid is leak-proof when closed and properly assembled.'],
    ['Care statement', 'Dishwasher safe — top rack only.'],
    ['Feature', 'Built-in tea hook.'],
    ['Fit statement', 'Fits most standard car cup holders.'],
  ].map(([label, value]) => ({ label, ...fact(value) })),
  certification_evidence: [], performance_evidence: [],
};
const base = {
  marketplace: 'US', language: 'en', product, rules,
  sources: [{ source_id: sourceId, kind: 'public_reference', publisher: 'THERMOS',
    url: source.source.url, snapshot: source }],
  content_brief: { audience: '日常饮用用户', use_case: '日常饮用', concern: '规格准确与宣称边界', style: '简洁自然' },
  scope: data.scope,
};
async function call(label, request) {
  console.log(JSON.stringify({ stage: label, status: 'calling_real_deepseek', model: config.model }));
  const started = Date.now();
  try {
    const output = await invokeModel(config, { ...base, ...request });
    assert.equal(output.trace.actual_model_call, true);
    assert.ok(output.trace.provider_request_id, 'Missing real provider request ID');
    data.steps.push({ label, status: 'succeeded', at: new Date().toISOString(), elapsed_ms: Date.now() - started, trace: output.trace });
    save();
    console.log(JSON.stringify({ stage: label, status: 'succeeded', request_id: output.trace.provider_request_id, elapsed_ms: output.trace.elapsed_ms, issues: output.result.review.issues.length }));
    return output;
  } catch (error) {
    data.steps.push({ label, status: 'failed', at: new Date().toISOString(), elapsed_ms: Date.now() - started,
      error: { code: error.code || 'PREPARATION_FAILED', message: error.message },
      trace: error.model_trace || null, format_retry: error.format_retry || null });
    data.acceptance = { status: 'incomplete', reason: `${label} 失败，未以模拟结果替换。` };
    save();
    throw error;
  }
}
const auditInstruction = '本轮是模拟商家流程的公开保温杯资料一致性审核，只执行所附四项 BTL 规则，不套用棉布袋品类规则，不声称 Amazon 或法规验收。审查 current_content 的每句真实文字：数值、来源归因、up to 限定、防漏条件以及认证等无依据宣称。厂家宣称只有明确归因时才可判与资料一致，不能证明实际性能。完整返回四个 rule_id 的 checks，BTL_OUTSIDE_SCOPE 必须 not_checked，其余如确实检查无问题才 pass。发现真实错误就逐项保留，issues.original 必须是对应字段精确子串。没有出现的宣称不产生 issue；不要求文案提及所有规格。';
function validateReview(output, content) {
  const fields = new Map(flattenContent(content).map(x => [x.path, x.text]));
  for (const issue of output.result.review.issues) {
    assert.ok(rules.some(x => x.rule_id === issue.rule_id), 'Unknown audit rule');
    assert.ok(fields.get(issue.field_path)?.includes(issue.original), 'Review issue must quote an actual field');
  }
}
try {
  if (process.argv.includes('--precision-repair') && !data.material_precision_correction) {
    assert.ok(data.repaired && data.recheck, 'Precision repair requires the previous saved draft and audit.');
    data.repair_history = [...(data.repair_history || []), data.repaired];
    data.recheck_history = [...(data.recheck_history || []), data.recheck];
    data.acceptance_history = [...(data.acceptance_history || []), { ...data.acceptance, superseded: true,
      reason: '人工来源核对发现模型漏检：18/8 stainless steel construction 不能证明内外壁各为18/8；原0发现不视为最终通过。' }];
    data.material_precision_correction = { status: 'pending', at: new Date().toISOString(),
      issue: '官方分别说明 stainless steel interior and exterior 及18/8 stainless steel construction，不能合并成内外壁各为18/8。',
      affected_fields: ['content.bullet_points.b2', 'content.description'],
      model_missed_finding: true };
    data.acceptance = { status: 'incomplete', reason: data.material_precision_correction.issue };
    delete data.repaired;
    delete data.recheck;
    save();
  }
  if (!data.generated) {
    const generated = await call('预生成英文 Listing', { operation: 'create', instruction:
      '用公开 THERMOS 商品资料写一份自然简洁的英文 Listing：标题、简短 highlights、五条各不重复卖点、描述。保留16oz (475 ml)、18/8 stainless steel。若写保温时间必须明确 THERMOS states up to 7 hours hot / up to 18 hours cold，防漏保留 when closed and properly assembled。也可以省略性能宣称。不要写未核实颜色、型号变体、包装、卖家SKU、价格、认证或未知资料说明；不表示真实商家拥有该商品或已上架。' });
    data.generated = { content: contentSchema.parse(generated.result.content), trace: generated.trace };
    save();
  }
  if (!data.risky) {
    const content = structuredClone(data.generated.content);
    const before = content.bullet_points[0].text;
    const after = 'Keeps drinks hot for 48 hours and cold for 48 hours. Leak-proof in any condition. FDA certified for guaranteed health benefits.';
    content.bullet_points[0].text = after;
    data.risky = { content, notice: '人工植入的错误演练稿，非品牌原文、非真实商家原稿、非模型实际失误。',
      injected: [{ field_path: `content.bullet_points.${content.bullet_points[0].id}`, before, after,
        explanation: '故意把厂家 up to 7h /18h 扩大为48h，删除防漏适用条件，并植入没有证据的 FDA 认证和健康保证。' }] };
    save();
  }
  if (!data.risky.review) {
    const review = await call('真实审核人工问题稿', { operation: 'diagnose', current_content: data.risky.content, instruction: auditInstruction });
    data.risky.review = review;
    save();
    validateReview(review, data.risky.content);
    assert.ok(review.result.review.issues.some(x => x.original.includes('48')), 'Actual audit did not identify the deliberately false insulation claim');
    assert.ok(review.result.review.issues.some(x => /FDA|health|any condition/i.test(x.original)), 'Actual audit did not identify unsupported certification or conditions');
  }
  validateReview(data.risky.review, data.risky.content);
  assert.ok(data.risky.review.result.review.issues.some(x => x.original.includes('48')), 'Saved audit did not identify the deliberately false insulation claim');
  assert.ok(data.risky.review.result.review.issues.some(x => /FDA|health|any condition/i.test(x.original)), 'Saved audit did not identify unsupported certification or conditions');
  if (!data.repaired) {
    const repaired = await call('真实改写问题稿', { operation: 'revise', current_content: data.risky.content,
      review: data.risky.review.result.review,
      instruction: '按真实审核发现修复人工问题稿，返回完整英文Listing并保留五条有依据且互不重复卖点。删除48小时、FDA、健康保证、无条件防漏等无依据宣称。优先只写容量、材质、茶钩、top rack dishwasher safe、fits most standard cup holders等已知事实。可以完全省略保温、防漏性能，避免把厂家宣称误当独立测试。不添加未知值、不把内部缺项写进对客文案。特别修正模型之前漏检的材质范围：官方只有18/8 stainless steel construction，没有分别确认内外壁材质牌号。全文每处（包括b2和description）只能写18/8 stainless steel construction，不得写18/8 stainless steel interior and exterior或inside and out；普通stainless steel interior and exterior有原文但不要把18/8联到两层。' });
    data.repaired = { content: contentSchema.parse(repaired.result.content), trace: repaired.trace };
    save();
  }
  if (!data.recheck) {
    const recheck = await call('修改后独立真实复检', { operation: 'diagnose', current_content: data.repaired.content, instruction: auditInstruction + ' 特别逐字段核对：官方18/8 stainless steel construction不能证明内外壁各为18/8，若出现18/8 stainless steel interior and exterior或inside and out须保留事实范围错误；不得将两条不同范围资料合并放大。' });
    data.recheck = { ...recheck, content_sha256: hash(data.repaired.content) };
    save();
  }
  validateReview(data.recheck, data.repaired.content);
  assert.equal(data.recheck.content_sha256, hash(data.repaired.content), 'Recheck must bind to this exact saved copy');
  for (const field of flattenContent(data.repaired.content))
    assert.ok(!/18\/8[^.!;\n]{0,65}(?:interior and exterior|inside and out)/i.test(field.text), 'Manual source precision check: separate material grades per wall remain unknown');
  const review = data.recheck.result.review;
  assert.deepEqual(review.issues, [], 'Actual independent audit still has findings; retain them as unresolved');
  for (const rule_id of ['BTL_FACT_MATCH', 'BTL_CLAIM_SCOPE', 'BTL_UNSUPPORTED']) {
    const checks = review.checks.filter(x => x.rule_id === rule_id);
    assert.equal(checks.length, 1, `${rule_id}: exactly one completed check required`);
    assert.equal(checks[0].state, 'pass', `${rule_id} is unresolved`);
  }
  assert.equal(review.checks.find(x => x.rule_id === 'BTL_OUTSIDE_SCOPE')?.state, 'not_checked');
  assert.ok(data.generated.trace.provider_request_id !== data.recheck.trace.provider_request_id);
  data.acceptance = { status: 'passed_within_fact_scope', completed_at: new Date().toISOString(),
    scope: data.scope, final_content_sha256: hash(data.repaired.content),
    final_request_id: data.recheck.trace.provider_request_id, issues: 0, outside_scope: 'not_checked',
    notice: '这是修改后文案与公开资料的一致性复检成功，不是产品实际性能、食品接触法规或上架通过。' };
  if (data.material_precision_correction) data.material_precision_correction.status = 'corrected_and_independently_rechecked';
  save();
  const text = content => [content.title, content.item_highlights, ...content.bullet_points.map(x => x.text), content.description].filter(Boolean).join('\n\n');
  writeFileSync(resolve(directory, 'listing-en.txt'), text(data.repaired.content) + '\n');
  writeFileSync(resolve(directory, 'generated-en.txt'), text(data.generated.content) + '\n');
  writeFileSync(resolve(directory, 'risk-draft-en.txt'), '人工预设问题稿，仅供演练；非品牌/商家原文。\n\n' + text(data.risky.content) + '\n');
  console.log(JSON.stringify({ case: file, acceptance: data.acceptance, calls: data.call_summary }));
} catch (error) {
  data.acceptance = { status: 'incomplete', reason: error.message };
  save();
  console.error(JSON.stringify({ status: 'incomplete', code: error.code || 'PREPARATION_INCOMPLETE', message: error.message }));
  process.exitCode = 1;
}
