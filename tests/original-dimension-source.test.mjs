// Archived real DALIX product facts and source bindings are the regression input.
// Modified source scopes/phrases below are engineering guard checks, not live acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectEvidence } from '../server/evidence.mjs';
import { reviewContent } from '../server/domain.mjs';
import { rulePack } from '../server/store.mjs';

const archived = JSON.parse(readFileSync(new URL('../reports/merchant-improvements-2026-10-24/final-record.json', import.meta.url)));
const product = archived.product_snapshot;
// Reconstruct the archived source rows from their original saved binding metadata.
// product-facts.mjs persists these same bindings as merchant_fact_source.snapshot.
const sourceRows = Object.values(product.fact_sources || {}).concat(product.additional_facts.map(fact => fact.source).filter(Boolean))
  .map(binding => ({ source_id: binding.source_id, kind: 'merchant_fact_source', url: binding.url, snapshot: binding }));
const content = description => ({ title: 'DALIX', item_highlights: '', bullet_points: [], description });
const entries = (description, profile = product, sources = sourceRows) => inspectEvidence(content(description), profile, [], sources);
const links = values => values.flatMap(entry => [...entry.parameter_links, ...entry.unresolved_parameters, ...entry.not_covered_parameters]);
const rawLinks = values => links(values).filter(link => link.method === 'recorded_original_dimension_tuple');

test('archived DALIX raw dimensions match their sourced original unit and order without assigning axes', () => {
  const before = JSON.stringify(product);
  for (const text of ['Measures 22" X 16" X 6".', 'Dimensions: 22 x 16 x 6 inches.', '100% cotton canvas tote with a top zipper and an outer pocket; measures 22" X 16" X 6".']) {
    const raw = rawLinks(entries(text));
    assert.equal(raw.length, 1, text);
    assert.equal(raw[0].status, 'matched');
    assert.equal(raw[0].field, 'additional_facts.0');
    assert.equal(raw[0].value, product.additional_facts[0].value);
    assert.match(raw[0].reason, /不推定哪一轴是宽、高或深/);
    const review = reviewContent({ content: content(text), profile: product, rulePack, sourceCatalog: sourceRows });
    assert.ok(!review.issues.some(issue => ['EVID-01', 'AMZ-05'].includes(issue.rule_id) && /22|16|6/.test(issue.original)), text);
  }
  assert.equal(product.dimensions_cm.value, null);
  assert.equal(product.color.value, null);
  assert.equal(product.retail_pack_count.value, null);
  assert.equal(JSON.stringify(product), before, 'inspection must not promote raw dimensions or unknown variants into structured facts');
});

test('named axes, changed values or units and ambiguous options cannot borrow raw tuple support', () => {
  for (const text of ['22 cm x 16 cm x 6 cm', '16" X 22" X 6"', '22" X 16" X 7"',
    '22" wide x 16" high x 6" deep', 'Dimensions 22" x 16" x 6" (L x W x H)', 'Dimensions 22" x 16" x 6" (width,height,depth)', 'W x H x D: 22" x 16" x 6"', 'LWH: 22" x 16" x 6"',
    'Available sizes: 22" x 16" x 6" or 22" x 16" x 7"']) {
    assert.equal(rawLinks(entries(text)).length, 0, text);
    assert.ok(links(entries(text)).some(link => link.status !== 'matched'), text);
  }
});

test('raw tuples never override existing structured dimensions or borrow package, pocket or missing sources', () => {
  const structured = structuredClone(product);
  structured.dimensions_cm = { value: { width: 30, height: 40 }, status: 'merchant_confirmed', source_ids: [product.additional_facts[0].source_ids[0]] };
  assert.equal(rawLinks(entries('22" x 16" x 6"', structured)).length, 0);
  for (const scope of ['Package dimensions', 'Carton size', 'Pocket dimensions', 'Handle dimensions', 'Maximum print size']) {
    const scoped = structuredClone(product);
    scoped.additional_facts[0].label = scope;
    assert.equal(rawLinks(entries('22" x 16" x 6"', scoped)).length, 0, scope);
    const scopedSource = structuredClone(sourceRows);
    scopedSource.find(source => source.source_id === product.additional_facts[0].source_ids[0]).snapshot.excerpt = `${scope}: 22" x 16" x 6"`;
    assert.equal(rawLinks(entries('22" x 16" x 6"', product, scopedSource)).length, 0, `source: ${scope}`);
  }
  for (const text of ['Package dimensions: 22" x 16" x 6"', 'Pocket dimensions: 22" x 16" x 6"', '22" x 16" x 6" package dimensions', '22" x 16" x 6" for the shipping carton'])
    assert.equal(rawLinks(entries(text)).length, 0, text);
  for (const excerpt of ['Outer Pocket; Top Zipper Closure', '22" x 16" x 6" or 20" x 12" x 5"',
    '22" x 16" x 6" package dimensions', '22" x 16" x 6" (pocket dimensions)',
    '22" x 16" x 6" maximum print size', '22" x 16" x 6" (L x W x H)',
    'W x H x D: 22" x 16" x 6"', 'LWH: 22" x 16" x 6"']) {
    const unrelatedSource = structuredClone(sourceRows);
    unrelatedSource.find(source => source.source_id === product.additional_facts[0].source_ids[0]).snapshot.excerpt = excerpt;
    assert.equal(rawLinks(entries('22" x 16" x 6"', product, unrelatedSource)).length, 0, excerpt);
  }
  assert.equal(rawLinks(entries('22" x 16" x 6"', product, [])).length, 0);
  assert.equal(rawLinks(entries('22" x 16" x 6"', product, null)).length, 0);
  const unresolved = links(entries('22" x 16" x 6"', product, []));
  assert.match(unresolved[0].reason, /未确认结构化尺寸/);
  assert.doesNotMatch(unresolved[0].reason, /只有宽、高/);
});
