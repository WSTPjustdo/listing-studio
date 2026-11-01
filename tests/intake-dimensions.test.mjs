// Recorded real DeepSeek wording from intake request
// 58c5c202-9bce-4327-9f5a-58f3a24e2e34 (2026-10-30). The archived public W101
// snapshot has the same confirmed width/height. Variants test parser boundaries
// only; neither the original replay nor these checks are new live acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectEvidence } from '../server/evidence.mjs';
import { reviewContent } from '../server/domain.mjs';
import { rulePack } from '../server/store.mjs';

const archived = JSON.parse(readFileSync(new URL('../reports/teammate-sync-2026-10-30/final-record.json', import.meta.url)));
const product = archived.product_snapshot;
const realDescription = 'Westford Mill W101 is a 100% cotton tote bag made from 140gsm (4.1oz/yd²) fabric. It measures 38 cm wide by 42 cm high and has a 10 litre capacity. The 67 cm handles allow it to be carried by hand or over the shoulder. A CutAway label makes it easy to rebrand.';
const content = description => ({ title: archived.content.title, item_highlights: '', bullet_points: [], description });
const inspect = description => inspectEvidence(content(description), product, [], archived.source_snapshot);
const dimensions = description => inspect(description).flatMap(entry => [...entry.parameter_links, ...entry.unresolved_parameters])
  .filter(link => link.field === 'dimensions_cm');

test('recorded real intake description retains explicit wide/high axes separated by by', () => {
  const before = JSON.stringify(product);
  const [link] = dimensions(realDescription);
  assert.equal(link.original.trim(), '38 cm wide by 42 cm high');
  assert.equal(link.status, 'matched');
  assert.equal(link.method, 'dimension_pair_by_axis_label');
  assert.deepEqual(link.value, product.dimensions_cm.value);
  const review = reviewContent({ content: content(realDescription), profile: product, rulePack, sourceCatalog: archived.source_snapshot });
  assert.ok(!review.issues.some(issue => ['AMZ-05', 'EVID-01'].includes(issue.rule_id) && /38|42/.test(issue.original)));
  assert.equal(JSON.stringify(product), before);
});

test('explicit reordered and mixed-unit by axes are checked by their labels', () => {
  for (const text of ['42 cm high by 38 cm wide', '380 mm wide by 42 cm high', '38 cm wide BY 42 cm high'])
    assert.equal(dimensions(text)[0].status, 'matched', text);
  for (const text of ['42 cm wide by 38 cm high', '38 cm wide by 43 cm high'])
    assert.equal(dimensions(text)[0].status, 'conflict', text);
});

test('word separators do not infer unknown or length axes as width and height', () => {
  for (const text of ['38 by 42 cm', '38 cm wide by 42 cm', '38 cm wide by 42 cm length', '38 cm wide by 42 cm long']) {
    const entries = inspect(text);
    assert.ok(!entries.flatMap(entry => entry.parameter_links).some(link => link.field === 'dimensions_cm'), text);
    assert.ok(entries.some(entry => entry.unresolved_parameters.length > 0), text);
  }
});

test('explicit by axes still respect pocket context and missing depth', () => {
  const pocket = inspect('Outside pocket measures 38 cm wide by 42 cm high.');
  assert.ok(!pocket.flatMap(entry => entry.parameter_links).some(link => link.field === 'dimensions_cm'));
  assert.ok(pocket.flatMap(entry => entry.not_covered_parameters).some(link => link.field === 'pocket_size'));
  const [triple] = dimensions('38 cm wide by 42 cm high by 10 cm deep');
  assert.equal(triple.status, 'needs_review');
  assert.equal(triple.method, 'dimension_triple_missing_confirmed_depth');
});
