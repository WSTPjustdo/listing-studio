import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectEvidence } from '../server/evidence.mjs';
import { reviewContent } from '../server/domain.mjs';
import { rulePack, scenarios } from '../server/store.mjs';

const product = scenarios.product_profiles[0];
const content = { title: 'Cotton Tote Bag', item_highlights: '140 g/m² cotton fabric.', bullet_points: [], description: '' };

test('evidence separates parameter alignment, wrong numbers, unsupported performance and rule-only citations', () => {
  const source = product.fabric_weight_gsm.source_ids[0];
  const map = [{ field_path: 'content.item_highlights', claim: content.item_highlights, source_ids: [source] }];
  const aligned = inspectEvidence(content, product, map).find(x => x.field_path === map[0].field_path);
  assert.equal(aligned.state, 'parameters_aligned');
  assert.equal(aligned.mapped, true);
  const wrong = inspectEvidence({ ...content, item_highlights: '200 g/m² cotton fabric.' }, product, map);
  assert.equal(wrong.find(x => x.field_path === map[0].field_path).state, 'needs_evidence');
  const performance = inspectEvidence({ ...content, description: 'Certified organic cotton, waterproof.' }, product, []);
  assert.equal(performance.find(x => x.field_path === 'content.description').state, 'needs_evidence');
  const ruleOnly = inspectEvidence(content, product, [{ ...map[0], source_ids: [rulePack.sources[0].source_id] }]);
  assert.equal(ruleOnly.find(x => x.field_path === map[0].field_path).mapped, false);
});

test('one valid citation cannot conceal an unmapped objective sentence', () => {
  const value = { ...content, description: 'Certified organic cotton.' };
  const review = reviewContent({ content: value, profile: product, rulePack, hasRealModel: true,
    claimMap: [{ field_path: 'content.title', claim: value.title, source_ids: product.material.source_ids }],
    modelReview: { issues: [], checks: [{ rule_id: 'FACT-01', state: 'pass', reason: 'mock' }] } });
  assert.ok(review.issues.some(x => x.field_path === 'content.description' && x.severity === 'needs_review'));
  assert.notEqual(review.checks.find(x => x.rule_id === 'EVID-01').state, 'pass');
});
