import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProduct, normalizeCompetitor, sourceGroundedSuggestions, extractTerms, createResearchProduct } from '../server/research.mjs';
import { createStore } from '../server/store.mjs';
import { inspectEvidence } from '../server/evidence.mjs';

// Engineering boundary checks using the archived real official W101 text.
// Injected model responses below test validation/trace only and are not live acceptance.
// Excerpt copied from reports/secondary-processing-2026-10-30/prepared-public-inputs.json.
// Original: https://westfordmill.com/products/w101, checked 2026-10-30T04:40:32.969Z.
const source = {
  title: 'Bag for Life - Long Handles',
  bullets: ['100% Cotton - 140gsm (4.1oz/yd²)', 'Can be carried by hand or over the shoulder', 'CutAway label for ease of rebranding'],
  specifications: 'Approx Product Weight ( g ) 65 Dimensions ( cm ) - width x height x depth 38 x 42 Capacity ( litres ) 10 Fabric Weight (gsm) 140 Handle length ( cm ) 67 Approx Carton Weight ( kg ) 19 Carton Dimensions ( cm ) 50 x 40 x 33 Carton Quantity 250 Pricelist Pack Qty 25 Poly Bag Qty 25 Maximum Print Area ( cm ) 33 x 36 Maximum Embroidery ( cm tubular hoop ) 18 Commodity Code 4202929890',
};
const officialText = [source.title, ...source.bullets, source.specifications].join('\n');
const suggestions = { width: 38, height: 42, fabric_weight_gsm: 140, capacity_l: 10, handle_length_cm: 67, retail_pack_count: 25, brand: 'Westford Mill', color: 'Natural' };
const config = { text_model_config: { provider: 'compatible', base_url: 'https://engineering-fixture.invalid/v1', model: 'engineering-fixture', api_key: 'engineering-fixture' } };
const modelPayload = (overrides = {}) => ({ name: 'W101', category: '棉布手提袋', search_query: 'cotton tote bag', observations: [], facts: [], missing: [], suggested_fields: suggestions, ...overrides });
const response = (payload, extra = {}) => new Response(JSON.stringify({ id: 'engineering-fixture-request', model: 'engineering-fixture', usage: { prompt_tokens: 17, completion_tokens: 23, total_tokens: 40 }, choices: [{ message: { content: JSON.stringify(payload) } }], ...extra }), { status: 200 });

test('official W101 table preserves exact body cm/gsm/L values but excludes supplier pack counts', () => {
  const result = sourceGroundedSuggestions(suggestions, officialText);
  assert.deepEqual(result.fields, { ...suggestions, retail_pack_count: null, brand: '', color: '' });
  assert.deepEqual(result.rejected, ['retail_pack_count', 'brand', 'color']);
  const wrong = sourceGroundedSuggestions({ width: 50, height: 40, depth: 33, fabric_weight_gsm: 65, capacity_l: 19, handle_length_cm: 18, retail_pack_count: 250 }, officialText);
  assert.ok(Object.values(wrong.fields).every(value => value === null), 'carton, product weight, print hoop and supplier quantities are not body fields');
});

test('official W101 feature-only material separator preserves literal 140gsm without accepting negative or converted values', () => {
  const featuresOnly = [source.title, ...source.bullets].join('\n');
  assert.deepEqual(sourceGroundedSuggestions({ fabric_weight_gsm: 140 }, featuresOnly), { fields: { fabric_weight_gsm: 140 }, rejected: [] });
  assert.equal(sourceGroundedSuggestions({ fabric_weight_gsm: 141 }, featuresOnly).fields.fabric_weight_gsm, null);
  for (const unsupported of ['Fabric weight: -140gsm', '100% Cotton - 4.1oz/yd²', 'Carton cotton - 140gsm', 'Pocket fabric - 140gsm']) {
    assert.equal(sourceGroundedSuggestions({ fabric_weight_gsm: 140 }, unsupported).fields.fabric_weight_gsm, null, unsupported);
  }
});

test('image-only suggestions remain unknown, including material, certifications and load', () => {
  const result = sourceGroundedSuggestions({ ...suggestions, material: '100% cotton', certification: 'OEKO-TEX', rated_load_kg: 20 });
  assert.ok(Object.values(result.fields).every(value => value === null || value === ''));
});

test('matching digits in other attributes cannot ground body dimensions, capacity or retail count', () => {
  for (const text of [
    'Carton Dimensions (cm) 38 x 42. Pocket capacity 10L. Shipping pack of 25.',
    'Shipping box dimensions (cm) 38 x 42. Carton Capacity (litres) 10. Wholesale pack of 25.',
    'Print area dimensions (cm) 38 x 42. Pocket Capacity (litres) 10. Poly bag: pack of 25.',
  ]) {
    const result = sourceGroundedSuggestions({ width: 38, height: 42, capacity_l: 10, retail_pack_count: 25 }, text);
    assert.ok(Object.values(result.fields).every(value => value === null), text);
  }
  const supported = sourceGroundedSuggestions({ width: 38, height: 42, capacity_l: 10, retail_pack_count: 2, brand: 'Acme', color: 'Natural' }, 'Bag dimensions: 38 x 42 cm. Bag capacity: 10L. Pack of 2.\nBrand: Acme\nColor: Natural');
  assert.deepEqual(supported.rejected, []);
});

test('converted measurements and approximate matches do not become adoptable native values', () => {
  const result = sourceGroundedSuggestions({ width: 38.1, height: 40.64, capacity_l: 10, handle_length_cm: 67, fabric_weight_gsm: 140 }, 'Bag dimensions: 15 x 16 inches. Capacity: 10000 ml. Handle length: 670 mm. Fabric: 4.1oz/yd².');
  assert.ok(Object.values(result.fields).every(value => value === null));
  const approximate = sourceGroundedSuggestions({ width: 38, height: 42 }, 'Bag dimensions approximately 38.01 x 42.01 cm.');
  assert.deepEqual(approximate.fields, { width: null, height: null });
});

test('analysis strips unrelated or image-only facts and suggestions while retaining raw suggestions in trace', async () => {
  const result = await analyzeProduct(config, { text: officialText }, async () => response(modelPayload({ facts: [
    { label: '材质', value: '100% Cotton', source: 'merchant_text', evidence: source.bullets[0] },
    { label: '错误借用', value: '100% polyester', source: 'merchant_text', evidence: source.bullets[0] },
  ] })));
  assert.equal(result.facts.length, 1);
  assert.equal(result.suggested_fields.retail_pack_count, null);
  assert.equal(result.trace.model_suggested_fields.retail_pack_count, 25);
  assert.equal(result.trace.provider_request_id, 'engineering-fixture-request');
  assert.equal(result.trace.usage.total_tokens, 40);
  const imageResult = await analyzeProduct({ vision_base_url: config.text_model_config.base_url, vision_model: 'engineering-fixture' }, { image: 'data:image/png;base64,iVBORw0KGgo=' }, async () => response(modelPayload({ facts: [
    { label: '猜测材质', value: '100% Cotton', source: 'merchant_text', evidence: '100% Cotton' },
  ] })));
  assert.equal(imageResult.facts.length, 0);
  assert.ok(Object.values(imageResult.suggested_fields).every(value => value === null || value === ''));
  assert.ok(imageResult.missing.length);
});

test('HTTP and response-format failures retain only obtained model trace metadata', async () => {
  await assert.rejects(analyzeProduct(config, { text: officialText }, async () => new Response('', { status: 503, headers: { 'x-request-id': 'engineering-fixture-http' } })), error => {
    assert.equal(error.code, 'RESEARCH_HTTP');
    assert.equal(error.model_trace.provider_request_id, 'engineering-fixture-http');
    assert.equal(error.model_trace.http_status, 503);
    assert.equal(error.model_trace.model, null);
    assert.equal(error.model_trace.usage, null);
    assert.ok(error.model_trace.elapsed_ms >= 0);
    assert.equal(JSON.stringify(error.model_trace).includes('api_key'), false);
    return true;
  });
  await assert.rejects(analyzeProduct(config, { text: officialText }, async () => response({}, { choices: [{ message: { content: 'broken-json' } }] })), error => {
    assert.equal(error.code, 'ANALYSIS_FORMAT');
    assert.equal(error.model_trace.model, 'engineering-fixture');
    assert.equal(error.model_trace.usage.total_tokens, 40);
    assert.equal(error.model_trace.provider_request_id, 'engineering-fixture-request');
    return true;
  });
});

test('normalization preserves actual description, timestamps, failed detail reasons and unknown fields', () => {
  const result = normalizeCompetitor({ product: { asin: 'B082DCF7LF', title: 'TOPDesign', description: 'Actual source description' }, fetched_at: '2026-10-30T04:40:32.969Z', detail_status: 'failed', detail_error: { code: 'SOURCE_FAILED', message: 'Source unavailable' } });
  assert.equal(result.description, 'Actual source description');
  assert.equal(result.checked_at, '2026-10-30T04:40:32.969Z');
  assert.equal(result.source_type, 'merchant_listing_claim');
  assert.deepEqual(result.missing_fields, ['bullets']);
  assert.equal(result.price, null);
  assert.equal(result.detail_error.code, 'SOURCE_FAILED');
});

test('reference keyword phrases use literal source adjacency without invented traffic measurements', () => {
  const terms = extractTerms([{ asin: null, title: source.title, bullets: source.bullets }]);
  assert.ok(terms.some(item => item.term === 'cutaway label'));
  assert.ok(!terms.some(item => ['cotton gsm', 'carried hand', 'shoulder cutaway'].includes(item.term)));
  assert.ok(terms.every(item => item.count === 1 && !('search_volume' in item) && !('traffic' in item)));
});

test('confirmed exact analysis labels and values remain separate and original-unit parameters can link', () => {
  const store = createStore(':memory:');
  try {
    const fact = { label: '面料克重（英制）', value: '4.1oz/yd²', source: 'merchant_text', evidence: source.bullets[0] };
    store.saveImport({ id: 'analysis-engineering-w101-exact', facts: [fact], checked_at: '2026-10-30T04:40:32.969Z' });
    for (const line of [`${fact.label}：${fact.value}`, `${fact.label}: ${fact.value}`]) {
      const product = createResearchProduct(store, { name: source.title, material: '100% Cotton', facts: line, category_confirmed: true, analysis_id: 'analysis-engineering-w101-exact' });
      assert.equal(product.additional_facts[0].label, fact.label);
      assert.equal(product.additional_facts[0].value, '4.1oz/yd²');
      assert.equal(product.fabric_weight_gsm.value, null, 'no conversion from the imperial value');
      assert.deepEqual(product.additional_facts[0].source_ids, ['LOCAL-MERCHANT-INPUT', 'analysis-engineering-w101-exact']);
      const inspection = inspectEvidence({ title: '', item_highlights: '', bullet_points: [], description: 'Fabric weight: 4.1oz/yd².' }, product);
      assert.ok(inspection.some(entry => entry.parameter_links.some(link => link.field === 'additional_facts.0' && link.original === '4.1oz/yd²')));
      assert.ok(!inspection.some(entry => entry.not_covered_parameters.some(item => item.field === 'fabric_weight_oz_per_yd2')));
    }
  } finally { store.close(); }
});

test('merchant changes, unlinked text and ambiguous formatted labels retain their full original line', () => {
  const store = createStore(':memory:');
  try {
    const original = { label: '面料克重（英制）', value: '4.1oz/yd²', source: 'merchant_text', evidence: source.bullets[0] };
    store.saveImport({ id: 'analysis-engineering-w101-edits', facts: [original, { label: 'A', value: 'B：C' }, { label: 'A：B', value: 'C' }] });
    const lines = ['面料克重（英制）：5oz/yd²', '面料克重（英制）：4.1 oz/yd²', '面料克重（英制）：4.1oz/yd²（商家补充）', '自填字段: 4.1oz/yd²', 'A：B：C'];
    const input = { name: source.title, material: '100% Cotton', facts: lines.join('\n'), category_confirmed: true, analysis_id: 'analysis-engineering-w101-edits' };
    const product = createResearchProduct(store, input);
    assert.deepEqual(product.additional_facts.map(fact => fact.value), lines);
    assert.ok(product.additional_facts.every(fact => fact.label === '商品文字资料（商家确认）'));
    const unlinked = createResearchProduct(store, { ...input, analysis_id: undefined, facts: `${original.label}：${original.value}` });
    assert.equal(unlinked.additional_facts[0].value, `${original.label}：${original.value}`);
  } finally { store.close(); }
});
