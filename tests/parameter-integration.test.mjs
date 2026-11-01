// Engineering boundaries on a recorded real W101 snapshot. Modified phrases/facts below
// are controlled adversarial inputs, never real model results or live acceptance evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectEvidence, PARAMETER_LINK_VERSION } from '../server/evidence.mjs';
import { detectMultiPackTitle, editProfile, reviewContent } from '../server/domain.mjs';
import { extractPackCount } from '../server/amazon.mjs';
import { saveProductFacts } from '../server/product-facts.mjs';

const recorded = JSON.parse(readFileSync(new URL('../reports/parameter-links-2026-10-23/actual-export.json', import.meta.url)));
const base = recorded.product_snapshot;
const rulePack = JSON.parse(readFileSync(new URL('../amazon-focus/rules.json', import.meta.url)));
const textContent = title => ({ title, item_highlights: '', bullet_points: [], description: '' });
const inspect = (text, profile = base) => inspectEvidence(textContent(text), profile);
const review = (text, profile = base) => reviewContent({ content: textContent(text), profile, rulePack });
const editFields = profile => ({ name_zh: profile.name_zh, material: profile.material.value ?? '',
  width: profile.dimensions_cm.value?.width ?? null, height: profile.dimensions_cm.value?.height ?? null,
  fabric_weight_gsm: profile.fabric_weight_gsm.value, capacity_l: profile.capacity_l.value,
  handle_length_cm: profile.handle_length_cm.value, retail_pack_count: profile.retail_pack_count.value,
  brand: profile.brand.value ?? '', color: profile.color.value ?? '' });

test('v2 keeps exact conversion and gives the rule engine the same conflicts', () => {
  assert.equal(PARAMETER_LINK_VERSION, 'structured-parameters-v2.6-original-dimension-tuples');
  for (const phrase of ['380 x 420 mm', '38cm x 42cm', '42H x 38W cm']) {
    const entry = inspect(phrase)[0];
    assert.equal(entry.state, 'parameters_aligned', phrase);
    assert.ok(!review(phrase).issues.some(issue => issue.rule_id === 'AMZ-05'), phrase);
  }
  for (const phrase of ['15 x 16.5 in', 'approximately 15 x 16.5 in', '42 x 38 cm']) {
    assert.equal(inspect(phrase)[0].state, 'needs_evidence', phrase);
    assert.ok(review(phrase).issues.some(issue => issue.rule_id === 'AMZ-05'), phrase);
  }
});

test('third axis is optional, editable and source-bound without changing identity', () => {
  const profile = structuredClone(base);
  profile.sku = 'engineering-identity-sentinel';
  profile.variation = { parentage: 'child', parent_sku: 'engineering-parent-sentinel' };
  const next = editProfile(profile, { ...editFields(profile), depth: 10 });
  assert.equal(next.dimensions_cm.value.depth, 10);
  assert.equal(next.sku, profile.sku);
  assert.deepEqual(next.variation, profile.variation);
  assert.equal(inspect('38 x 42 x 10 cm', next)[0].state, 'parameters_aligned');
  assert.equal(inspect('10D x 42H x 38W cm', next)[0].state, 'parameters_aligned');
  assert.equal(inspect('38 x 42 x 11 cm', next)[0].state, 'needs_evidence');
  assert.ok(review('38 x 42 x 11 cm', next).issues.some(issue => issue.rule_id === 'AMZ-05'));
  assert.equal(inspect('38 x 42 x 10 cm', base)[0].state, 'needs_evidence');
  assert.equal(editProfile(next, editFields(next)).dimensions_cm.value.depth, 10);
  assert.throws(() => editProfile(base, { ...editFields(base), width: null, depth: 10 }), { code: 'DEPTH_WITHOUT_SIZE' });
});

test('explicit wide/high axes in recorded real model wording are compared as one tuple', () => {
  // Real W101 wording observed during integration acceptance; no new product fact is inferred.
  const realWording = 'Measures approximately 38 cm wide x 42 cm high and holds about 10 litres.';
  for (const phrase of [realWording, '42 cm high x 38 cm wide', '38 cm width x 42 cm height']) {
    const entry = inspect(phrase)[0];
    assert.equal(entry.state, 'parameters_aligned', phrase);
    assert.equal(entry.unresolved_parameters.length, 0, phrase);
    const tuple = entry.parameter_links.find(link => link.field === 'dimensions_cm');
    assert.equal(tuple.method, 'dimension_pair_by_axis_label', phrase);
    assert.deepEqual(tuple.value, base.dimensions_cm.value, phrase);
    assert.ok(!review(phrase).issues.some(issue => ['AMZ-05', 'EVID-01'].includes(issue.rule_id)), phrase);
  }
  const withDepth = editProfile(base, { ...editFields(base), depth: 10 });
  for (const phrase of ['38 cm wide x 42 cm high x 10 cm deep', '10 cm depth x 42 cm height x 38 cm width'])
    assert.equal(inspect(phrase, withDepth)[0].state, 'parameters_aligned', phrase);
  // Length still cannot be presumed to mean bag height or depth.
  for (const phrase of ['38 cm wide x 42 cm length', '38 cm wide x 42 cm long'])
    assert.equal(inspect(phrase)[0].state, 'needs_evidence', phrase);
  assert.ok(review('42 cm wide x 38 cm high').issues.some(issue => issue.rule_id === 'AMZ-05'));
});

test('saved real DALIX highlights keep the full bag tuple after a pocket clause', () => {
  // Saved real DeepSeek request 9a6154f3-6c44-4261-a1ea-cfee2f49a837, 2026-10-28.
  // Keep only the recorded text here; delivery deliberately excludes .runtime.
  const savedHighlights = '100% cotton canvas tote with a top zipper and an outer pocket; measures 22" X 16" X 6".';
  const dalix = JSON.parse(readFileSync(new URL('../reports/merchant-improvements-2026-10-24/final-record.json', import.meta.url))).product_snapshot;
  const before = JSON.stringify(dalix);
  const entries = inspectEvidence({ title: 'DALIX', item_highlights: savedHighlights, bullet_points: [], description: '' }, dalix);
  const entry = entries.find(value => value.field_path === 'content.item_highlights');
  const dimensions = entry.unresolved_parameters.filter(value => value.field === 'dimensions_cm');
  assert.equal(dimensions.length, 1);
  assert.equal(dimensions[0].original.trim(), '22" X 16" X 6"');
  assert.equal(dimensions[0].method, 'dimension_triple_missing_confirmed_depth');
  assert.ok(dimensions[0].reason.includes('未确认结构化尺寸'));
  assert.ok(!entry.unresolved_parameters.some(value => value.method === 'dimension_single_axis'));
  assert.equal(JSON.stringify(dalix), before);
});

test('rated load is distinct from volume and remains a separate performance claim', () => {
  const next = editProfile(base, { ...editFields(base), rated_load_kg: 10 });
  const entry = inspect('holds up to 10 kg', next)[0];
  assert.ok(entry.parameter_links.some(link => link.field === 'rated_load_kg'));
  assert.equal(entry.semantic_status, 'separate_review_required');
  assert.equal(entry.state, 'needs_evidence');
  assert.ok(review('holds 11 kg', next).issues.some(issue => issue.rule_id === 'AMZ-05'));
  assert.ok(review('holds 10 kg', base).issues.some(issue => issue.rule_id === 'FACT-01'));
  assert.ok(!inspect('10 kg carrying capacity', base)[0].parameter_links.some(link => link.field === 'capacity_l'));
  const pounds = editProfile(base, { ...editFields(base), rated_load_kg: 22 * 0.45359237 });
  assert.ok(inspect('holds 22 lbs', pounds)[0].parameter_links.some(link => link.field === 'rated_load_kg'));
  assert.ok(!inspect('holds 10 grams', next)[0].parameter_links.some(link => link.field === 'rated_load_kg'));
  assert.ok(!inspect('supports 10 oz', next)[0].parameter_links.some(link => link.field === 'rated_load_kg'));
  assert.ok(!review('weighs 65 g').issues.some(issue => issue.rule_id === 'FACT-01'));
});

test('mixed fibers compare each composition component, not only the first', () => {
  const next = editProfile(base, { ...editFields(base), material: '75% Polyester, 25% Cotton' });
  assert.equal(inspect('75% Polyester, 25% Cotton', next)[0].state, 'parameters_aligned');
  assert.ok(!review('75% Polyester, 25% Cotton', next).issues.some(issue => issue.rule_id === 'AMZ-05'));
  assert.ok(review('100% cotton', next).issues.some(issue => issue.rule_id === 'AMZ-05'));
  assert.ok(review('polyester-cotton blend', base).issues.some(issue => issue.rule_id === 'AMZ-05'));
  assert.ok(review('cotton blend', base).issues.some(issue => issue.rule_id === 'AMZ-05'));
  assert.equal(inspect('99.8% cotton', base)[0].state, 'needs_evidence');
  const lining = inspect('100% cotton shell, 100% polyester lining')[0];
  assert.equal(lining.state, 'partially_covered');
  assert.ok(lining.not_covered_parameters.some(item => item.field === 'lining_material'));
  assert.ok(!review('100% cotton shell, 100% polyester lining').issues.some(issue => issue.rule_id === 'AMZ-05'));
});

test('uncovered values stay visible and never masquerade as aligned parameters', () => {
  const entry = inspect('6 Inner Pockets')[0];
  assert.equal(entry.state, 'not_covered');
  assert.equal(entry.mapped, false);
  assert.equal(entry.parameter_coverage.not_covered, 1);
  const result = review('6 Inner Pockets');
  assert.equal(result.parameter_coverage.not_covered, 1);
  assert.equal(result.parameter_coverage.whole_sentence_proven, false);
  assert.equal(result.coverage.uncovered_parameters, 1);
  assert.equal(result.checks.find(check => check.rule_id === 'EVID-01').state, 'not_checked');
  assert.ok(result.unmodeled_parameters.some(item => item.field === 'pocket_count'));
  assert.notEqual(result.status, 'reviewed_within_scope');
  assert.equal(inspect('Width 15.')[0].unresolved_parameters[0].original, '15');
});

test('every declared unit and source remains subject to verification', () => {
  const dual = inspect('67cm/26 inches long handles')[0];
  assert.equal(dual.state, 'needs_evidence');
  assert.equal(dual.parameter_links.length, 0);
  assert.equal(inspect('26-inch (67 cm) long handles')[0].state, 'needs_evidence');
  for (const phrase of ['38 cm (1 in) x 42 cm', '38 cm (999 mm) x 42 cm', '38 cm (size 1) x 42 cm']) {
    const entry = inspect(phrase)[0];
    assert.equal(entry.state, 'needs_evidence', phrase);
    assert.equal(entry.parameter_links.length, 0, phrase);
    assert.ok(entry.unresolved_parameters.some(item => item.reason.includes('括号')), phrase);
  }
  assert.equal(inspect('38 cm (380 mm) x 42 cm (420 mm)')[0].state, 'parameters_aligned');
  const unverified = structuredClone(base);
  unverified.material.status = 'submitted_unverified';
  assert.equal(inspect('cotton', unverified)[0].parameter_links.length, 0);
  const policy = structuredClone(base);
  policy.material.source_ids = ['POLICY'];
  assert.equal(inspectEvidence(textContent('cotton'), policy, [], [{ source_id: 'POLICY', kind: 'official_platform_policy' }])[0].parameter_links.length, 0);
  assert.ok(!inspect('12 oz canvas')[0].parameter_links.some(link => link.field === 'fabric_weight_gsm'));
  const originalUnit = structuredClone(base);
  originalUnit.additional_facts = [{ value: '12 oz cotton canvas', status: 'merchant_confirmed', source_ids: base.material.source_ids }];
  const originalEntry = inspect('12 oz cotton canvas', originalUnit)[0];
  assert.ok(originalEntry.parameter_links.some(link => link.field === 'additional_facts.0' && link.original === '12 oz'));
  assert.ok(!originalEntry.parameter_links.some(link => link.field === 'fabric_weight_gsm'));
});

test('ambiguous pack options never become a guessed retail quantity', () => {
  assert.equal(extractPackCount('2 | 6 | 12 Pack Tote'), null);
  assert.equal(extractPackCount('2 | 6 | 12 Pack Tote (Pack of 2)'), 2);
  assert.equal(extractPackCount('Pack of 2, Set of 3'), null);
  assert.equal(extractPackCount('0 Pack Tote'), null);
  assert.equal(extractPackCount('Tote', '2 bags per pack, 3 bags per pack'), null);
  assert.equal(extractPackCount('2-Pack Tote'), 2);
  assert.equal(extractPackCount('Tote', '250 bags per carton'), null);
  const title = 'Tote 2-Pack, or 6-Pack';
  assert.ok(title.includes(detectMultiPackTitle(title).original));
  const result = review(title);
  assert.ok(result.issues.filter(issue => issue.rule_id === 'AMZ-06').every(issue => title.includes(issue.original)));
});

test('rated-load and depth edits invalidate only their old fact bindings', () => {
  const profile = structuredClone(base);
  const source = { url: 'https://westfordmill.com/products/w101', publisher: 'Engineering boundary only',
    applicable_model: 'W101', excerpt: 'Controlled boundary text, never claimed as an observed official load specification.' };
  let saved;
  const store = { saveProductWithSources(product, sources) { saved = { product, sources }; } };
  const next = saveProductFacts(store, profile, { ...editFields(profile), depth: 10, rated_load_kg: 10,
    fact_sources: { rated_load_kg: source, dimensions_cm: source } });
  assert.equal(saved.sources.length, 2);
  assert.equal(next.fact_sources.rated_load_kg.value, 10);
  const edited = saveProductFacts(store, next, { ...editFields(next), depth: 12, rated_load_kg: 11 });
  assert.equal(edited.fact_sources.rated_load_kg, undefined);
  assert.equal(edited.fact_sources.dimensions_cm, undefined);
  assert.deepEqual(edited.material, next.material);
});
