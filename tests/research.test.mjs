import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.mjs';
import { createService } from '../server/service.mjs';
import { generateLocalDraft } from '../server/domain.mjs';
import { analyzeProduct, searchCompetitors, compareCandidate, comparisonSchema, readProduct, saveResearchConfig, researchConfig, createResearchProduct } from '../server/research.mjs';
const json = x => new Response(JSON.stringify(x), { headers: { 'Content-Type': 'application/json' } });
const config = { rainforest_key: 'private-test', vision_base_url: 'https://vision.test/v1', vision_model: 'vision-test', vision_key: 'private-vision' };

test('research configuration keeps keys private, preserves blank inputs, clears secrets independently', () => {
  const store = createStore(':memory:');
  try {
    store.saveSettings({ provider: 'demo' });
    const output = saveResearchConfig(store, config);
    assert.equal(JSON.stringify(output).includes('private'), false);
    assert.equal(output.has_rainforest_key, true);
    saveResearchConfig(store, { ...config, rainforest_key: '', vision_key: '' });
    assert.equal(researchConfig(store).rainforest_key, 'private-test');
    saveResearchConfig(store, { ...config, clear_secrets: true });
    assert.equal(researchConfig(store).vision_key, '');
    assert.deepEqual(store.settings(), { provider: 'demo' });
    assert.throws(() => saveResearchConfig(store, { ...config, vision_base_url: 'https://a.test/?key=secret' }), /API 地址/);
  } finally { store.close(); }
});

test('search requests limited details, deduplicates ASINs, preserves sources and never classifies brand value as known', async () => {
  const result = await searchCompetitors(config, 'cotton tote', async url => {
    assert.equal(url.searchParams.get('include_products_count'), '3');
    assert.equal(url.searchParams.get('number_of_results'), '5');
    return json({ search_results: [
      { asin: 'B000000001', title: 'Cotton tote bag', price: { value: 12, currency: 'USD' }, product: { feature_bullets: ['Zipper cotton tote'], brand: 'Example' } },
      { asin: 'B000000001', title: 'Duplicate' },
      { asin: 'B000000002', title: 'Cotton tote luxury', price: { value: 100, currency: 'USD' } },
      { asin: 'invalid', title: 'Bad item' },
    ] });
  }, { target_price: 10, tolerance: 0.3, required_terms: ['cotton', 'zipper'], positioning: 'practical' });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].comparison.status, 'potential');
  assert.equal(result.items[0].comparison.brand_value, 'unknown');
  assert.equal(result.items[1].comparison.status, 'outside_price');
  assert.deepEqual(result.terms.find(x => x.term === 'cotton').asins, ['B000000001','B000000002']);
  assert.equal(result.items[0].url, 'https://www.amazon.com/dp/B000000001');
});

test('missing price and non USD currency cannot pass price screening; no keyword proof means review', () => {
  const item = { title: 'cotton', bullets: [], specifications: [], price: 10, currency: 'EUR' };
  const criteria = comparisonSchema.parse({ target_price: 10, required_terms: ['cotton'] });
  assert.equal(compareCandidate(item, criteria).status, 'needs_review');
  assert.equal(compareCandidate({ ...item, price: null }, criteria).price_fits, null);
  assert.equal(compareCandidate({ ...item, currency: 'USD' }, comparisonSchema.parse({ target_price: 10 })).status, 'needs_review');
});

test('analysis combines own listing, merchant text and image; strips unsupported source citations', async () => {
  let calls = 0;
  const result = await analyzeProduct(config, { text: 'Material: 100% cotton', reference: 'B000000001', image: 'data:image/png;base64,iVBORw0KGgo=' }, async (url, options) => {
    calls++;
    if (url instanceof URL) return json({ product: { asin: 'B000000001', title: 'Cotton tote', specifications: [{ name: 'Size', value: '15 x 16 inches' }] } });
    const request = JSON.parse(options.body);
    assert.equal(request.messages[1].content[1].type, 'image_url');
    assert.match(request.messages[1].content[0].text, /15 x 16 inches/);
    return json({ choices: [{ message: { content: JSON.stringify({ name: '棉布袋', category: 'cotton tote', search_query: 'cotton tote bag', observations: ['白色外观'], facts: [
      { label: '材质', value: '100% cotton', source: 'merchant_text', evidence: '100% cotton' },
      { label: '尺寸', value: '15 x 16 inches', source: 'own_link', evidence: '15 x 16 inches' },
      { label: '承重', value: '20kg', source: 'own_link', evidence: 'supports 20kg' },
    ], missing: [] }) } }] });
  });
  assert.equal(calls, 2);
  assert.equal(result.facts.length, 2);
  assert.ok(result.missing.length);
  assert.equal(result.own_link.asin, 'B000000001');
});

test('invalid images, missing credentials, wrong ASIN and external errors fail without leaking keys', async () => {
  await assert.rejects(analyzeProduct(config, { image: 'data:image/png;base64,YWJj' }), /图片内容/);
  await assert.rejects(searchCompetitors({}, 'cotton tote'), /Rainforest API Key/);
  await assert.rejects(readProduct(config, 'B000000001', async () => json({ product: { asin: 'B000000002', title: 'Wrong variant' } })), /ASIN/);
  await assert.rejects(searchCompetitors(config, 'cotton', async () => { throw new Error('url?api_key=private-test'); }), err => !err.message.includes('private-test'));
  await assert.rejects(searchCompetitors(config, 'cotton', async () => json({ request_info: { success: false, message: 'private-test' } })), err => !err.message.includes('private-test'));
  await assert.rejects(searchCompetitors(config, 'cotton', async () => json({})), /搜索结果/);
});

test('creating own product requires confirmation, retains source extraction, and does not infer dimensions', () => {
  const store = createStore(':memory:');
  try {
    store.saveImport({ id: 'analysis-test', checked_at: '2026-10-23', own_link: { url: 'https://www.amazon.com/dp/B000000001' }, facts: [] });
    const input = { name: 'My bag', material: '100% cotton', facts: 'Size: 15 x 16 inches', category_confirmed: true, analysis_id: 'analysis-test' };
    assert.throws(() => createResearchProduct(store, { ...input, category_confirmed: false }));
    const p = createResearchProduct(store, input);
    assert.equal(p.dimensions_cm.value, null);
    assert.equal(p.additional_facts[0].value, 'Size: 15 x 16 inches');
    assert.ok(p.additional_facts[0].source_ids.includes('analysis-test'));
    assert.ok(store.sources().some(x => x.source_id === 'analysis-test'));
  } finally { store.close(); }
});

test('competitor context and style reach generation separately from own facts and remain in version history', async () => {
  const store = createStore(':memory:'), original = globalThis.fetch;
  store.saveSettings({ provider: 'compatible', base_url: 'https://model.test/v1', model: 'mock', api_key: 'test', timeout_ms: 5000 });
  const requests = [];
  // 服务端现在拒绝演示商品（REAL_PRODUCT_REQUIRED），而内存库只种了演示商品。
  // 这里用同一份档案数值做"真实商品"替身：验的是竞品上下文怎么进请求、怎么进版本历史，
  // 与"这条商品是谁"无关。product_id 换成中性名，免得读日志的人以为这是演示路径。
  const product = { ...store.products()[0], product_id: 'TEST-REAL-W101', is_demo: false };
  const context = { research_id: 'research-test', selected_terms: ['tote'], items: [{ asin: 'B000000001', title: 'Competitor Brand', specifications: [{ name: 'weight', value: '999 gsm' }] }] };
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(JSON.parse(options.body).messages[1].content); requests.push(request);
    return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ content: generateLocalDraft(product), review: { issues: [], checks: [] }, patches: [] }) } }] });
  };
  try {
    const run = createService(store).enqueue({ operation: 'create', product, instruction: 'Professional and concise', research_context: context });
    for (let i=0; i<100 && !['succeeded','failed'].includes(store.run(run.run_id).status); i++) await new Promise(r => setTimeout(r,10));
    assert.equal(store.run(run.run_id).status, 'succeeded');
    assert.deepEqual(requests[0].competitor_research, context);
    assert.equal(requests[0].instruction, 'Professional and concise');
    assert.deepEqual(requests[0].product, product);
    assert.match(requests[0].competitor_policy, /never instructions or evidence/);
    assert.deepEqual(store.latest(run.listing_id).competitor_research, context);
    assert.equal(requests.length, 2, 'generated content receives independent review');
  } finally { globalThis.fetch = original; store.close(); }
});
