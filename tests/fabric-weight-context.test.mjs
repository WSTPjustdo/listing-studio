// Archived real model wording is the regression input. Controlled variants below only
// verify parsing boundaries; they are not new product data or live model acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectEvidence } from '../server/evidence.mjs';
import { reviewContent } from '../server/domain.mjs';
import { rulePack } from '../server/store.mjs';

const recorded = JSON.parse(readFileSync(new URL('../reports/teammate-sync-2026-10-30/final-record.json', import.meta.url)));
const product = recorded.product_snapshot;
const entries = (description, profile = product) => inspectEvidence({ title: '', item_highlights: '', bullet_points: [], description }, profile);
const parameters = values => values.flatMap(entry => [...entry.parameter_links, ...entry.unresolved_parameters, ...entry.not_covered_parameters]);

test('archived real W101 keeps its complete fabric-weight source without becoming a rated load', () => {
  const before = JSON.stringify(recorded);
  const evidence = inspectEvidence(recorded.content, product, [], recorded.source_snapshot);
  const all = parameters(evidence);
  assert.ok(all.some(link => link.original === '4.1oz/yd²' && link.status === 'matched' && link.field.startsWith('additional_facts.')));
  assert.ok(!all.some(link => link.field === 'rated_load_kg'));
  const review = reviewContent({ content: recorded.content, profile: product, rulePack });
  assert.ok(!review.issues.some(issue => issue.original === '4.1oz' && issue.rule_id === 'FACT-01'));
  assert.equal(JSON.stringify(recorded), before, 'parsing must not rewrite the archived text or facts');
});

test('unsupported square-yard units remain explicitly uncovered instead of borrowing gsm support', () => {
  const profile = structuredClone(product);
  profile.additional_facts = [];
  for (const text of ['4.1oz/yd²', '4.1 oz/yd2', '4.1 ounces per square yard', '4.1 oz / sq yd']) {
    const [link] = parameters(entries(text, profile));
    assert.equal(link.field, 'fabric_weight_oz_per_yd2', text);
    assert.equal(link.status, 'not_covered', text);
    assert.equal(link.original, text);
    assert.deepEqual(link.source_ids, []);
  }
});

test('a separate carrying or load clause cannot relabel product weight', () => {
  for (const text of ['Weighs 10 oz; holds 22 lbs.', 'Net weight: 10 oz; load capacity 10 kg.', '10 ounces; can be carried by hand.', '10 oz, holds 22 lbs.']) {
    const all = parameters(entries(text));
    const first = all.find(link => /10 (?:oz|ounces)/.test(link.original));
    assert.equal(first.field, 'product_weight', text);
    assert.equal(first.status, 'not_covered', text);
  }
});

test('explicit product weight takes precedence while genuine nearby rated loads remain checked', () => {
  const all = parameters(entries('Net weight: 10 oz, supports 10 kg.'));
  assert.equal(all.find(link => link.original === '10 oz').field, 'product_weight');
  assert.equal(all.find(link => link.original === '10 kg').field, 'rated_load_kg');
  for (const text of ['10 kg carrying capacity', 'holds up to 22 lbs', 'supports 10 oz', 'carries 10 kilograms', '4.1oz/yd²; carries 10 kg']) {
    const loads = parameters(entries(text)).filter(link => link.field === 'rated_load_kg');
    assert.equal(loads.length, 1, text);
    assert.equal(loads[0].status, 'needs_review', text);
  }
});
