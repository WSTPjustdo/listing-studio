// Real API acceptance run. npm test requires -- --real-api; never substitutes mocks.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { load } from 'cheerio';
import { createStore } from '../server/store.mjs';
import { getConfig } from '../server/providers.mjs';
import { createService } from '../server/service.mjs';
import { attachStore } from '../server/telemetry.mjs';

if (!process.argv.includes('--real-api')) throw new Error('Run with --real-api to authorize paid inference.');
const userStore = createStore();
const config = getConfig(userStore);
userStore.close();
if (!config.api_key || config.provider !== 'compatible' || new URL(config.base_url).hostname !== 'api.deepseek.com')
  throw new Error('Existing DeepSeek API configuration is required; no demo fallback.');
const resume = process.argv.indexOf('--resume');
const directory = resume > -1 ? resolve(process.argv[resume + 1]) : resolve('.runtime', `live-acceptance-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const realFetch = globalThis.fetch;
let callNumber = 0;
globalThis.fetch = async (...args) => {
  const result = await realFetch(...args);
  if (new URL(String(args[0])).hostname === 'api.deepseek.com') {
    const body = await result.clone().text();
    writeFileSync(resolve(directory, `response-${Date.now()}-${++callNumber}.json`), body);
  }
  return result;
};
const store = createStore(resolve(directory, 'validation.sqlite'));
attachStore(store);
store.settings = () => config; // Credentials stay in memory, never serialized.
const service = createService(store);
const url = 'https://westfordmill.com/products/w101';
const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Official product source HTTP ${response.status}`);
const html = await response.text();
const $ = load(html); $('script,style,nav,footer').remove();
const text = $('body').text().replace(/\s+/g, ' ').trim();
for (const snippet of ['100% Cotton', '140gsm', '38 x 42', '4.1oz/yd²', 'Can be carried by hand or over the shoulder', 'CutAway label for ease of rebranding'])
  if (!text.includes(snippet)) throw new Error(`Official product page changed: ${snippet}`);
const sourceId = 'LIVE-WESTFORD-W101';
const now = new Date().toISOString();
const fact = value => ({ value, status: value === null ? 'unknown' : 'public_source', source_ids: value === null ? [] : [sourceId] });
store.saveSource({ source_id: sourceId, kind: 'public_reference', url, publisher: 'Westford Mill', checked_at: now,
  description: '品牌官方 W101 商品规格；真实公开商品，非商家库存或零售包装确认。',
  snapshot: { specifications: $('table').text().replace(/\s+/g, ' '), excerpts: ['100% Cotton - 140gsm (4.1oz/yd²)', 'Can be carried by hand or over the shoulder', 'CutAway label for ease of rebranding'].filter(snippet => text.includes(snippet)) } });
const chineseMaterial = process.argv.includes('--material-zh');
let product = { product_id: 'REAL-WESTFORD-W101', revision: 1, name_zh: 'Westford Mill W101 官方公开商品',
  is_demo: false, reference_product_id: 'W101', material: fact(chineseMaterial ? '100% 棉' : '100% cotton'), fabric_weight_gsm: fact(140),
  dimensions_cm: fact(null), capacity_l: fact(null), handle_length_cm: fact(null), retail_pack_count: fact(null),
  brand: fact('Westford Mill'), color: fact(null), rated_load_kg: fact(null),
  additional_facts: [fact('4.1oz/yd²'), fact('Can be carried by hand or over the shoulder'), fact('CutAway label for ease of rebranding')].map(f => ({...f, label: '官方页面原文'})),
  degradation_evidence: [], certification_evidence: [], performance_evidence: [] };
if (!store.product(product.product_id)) store.saveProduct(product);
else product = store.product(product.product_id);
const report = resume > -1 ? JSON.parse(readFileSync(resolve(directory, 'report.json'), 'utf8')) : { started_at: now, source_url: url, model: config.model, provider: 'DeepSeek', source_checked_live: true,
  material_original: '100% Cotton', material_in_product: product.material.value,
  material_notice: chineseMaterial ? '官方原文 100% Cotton 的中文等义登记，用于复核中文资料与英文文案对照；未新增或更改商品事实。' : '采用官方英文材质原文。',
  input_notice: '真实品牌官方公开商品；非用户库存，不虚构零售包装、颜色、认证与性能。', steps: [], directory };
const save = () => writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
async function run(label, input) {
  console.log(JSON.stringify({ stage: label, status: 'calling_real_api', model: config.model }));
  const started = Date.now(), queued = service.enqueue(input);
  for (;;) {
    const value = store.run(queued.run_id);
    if (value.status === 'failed') {
      report.steps.push({ label, status: 'failed', elapsed_ms: Date.now() - started, run: value, error: value.error }); save();
      throw new Error(`${label}: ${value.error?.code}: ${value.error?.message}`);
    }
    if (value.status === 'succeeded') {
      const record = store.latest(queued.listing_id);
      if (!record.trace.actual_model_call) throw new Error('Real model call was not recorded.');
      report.steps.push({ label, status: 'succeeded', elapsed_ms: Date.now() - started, record }); save();
      console.log(JSON.stringify({ stage: label, status: 'succeeded', version: record.version, issues: record.review.issues.length,
        request_id: record.trace.provider_request_id, elapsed_ms: Date.now() - started }));
      return record;
    }
    if (Date.now() - started > config.timeout_ms * 3 + 10000) throw new Error('Acceptance run deadline exceeded');
    await delay(500);
  }
}
try {
  const created = resume > -1 ? report.steps.find(x => x.record)?.record : await run('真实商品生成与独立审核', { operation: 'create', product,
    content_brief: { audience: '日常购物用户', use_case: '日常携带', concern: '材质与规格', style: '参数清晰' },
    instruction: '为真实公开的 Westford Mill W101 制作英文商品内容草稿，只写已有依据的信息。不推测颜色、零售包装、未知尺寸或认证；不要把缺失数据说明写进对客英文文案。' });
  const repaired = await run('真实问题审查修复与复检', { operation: 'revise', previous: created, product,
    base_version: created.version, review_issues: true,
    instruction: '审查全部实际发现的问题，局部修复并保留正确的商品参数。不虚构证据或参数，无法解决的事项继续报告。' });
  // Supplement only specifications independently re-read from the official source.
  const specs = $('table').text().replace(/\s+/g, ' ');
  if (!/Capacity\s*\(\s*litres\s*\)\s*10/i.test(specs) || !/Handle length\s*\(\s*cm\s*\)\s*67/i.test(specs))
    throw new Error('Cannot verify supplementary specifications from official table.');
  product = { ...product, revision: 2, dimensions_cm: fact({ width: 38, height: 42 }), capacity_l: fact(10), handle_length_cm: fact(67) };
  store.saveProduct(product);
  const rechecked = await run('补充真实规格后原任务复检', { operation: 'patch', previous: repaired, product, patches: [], base_version: repaired.version });
  if (rechecked.listing_id !== created.listing_id || store.versions(created.listing_id).length !== 3)
    throw new Error('Version continuity failed');
  if (JSON.stringify(rechecked.content) !== JSON.stringify(repaired.content)) throw new Error('Recheck unexpectedly changed copy');
  report.completed_at = new Date().toISOString(); report.acceptance = 'real_api_workflow_completed_quality_requires_review'; save();
  console.log(JSON.stringify({ report: resolve(directory, 'report.json'), remaining: rechecked.review.issues.map(x => ({ original: x.original, reason: x.reason })) }));
} finally { store.close(); }
