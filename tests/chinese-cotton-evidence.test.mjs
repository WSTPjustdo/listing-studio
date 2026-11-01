// Engineering boundaries on a saved real official W101 snapshot. Chinese translations
// and adversarial phrases are controlled inputs, never new product/model acceptance evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseComposition, compareFiber, canonicalFiber } from '../server/material.mjs';
import { inspectEvidence } from '../server/evidence.mjs';
import { reviewContent } from '../server/domain.mjs';

const recorded = JSON.parse(readFileSync(new URL('../reports/parameter-links-2026-10-23/actual-export.json', import.meta.url)));
const base = recorded.product_snapshot;
const rulePack = JSON.parse(readFileSync(new URL('../amazon-focus/rules.json', import.meta.url)));
const content = title => ({ title, item_highlights: '', bullet_points: [], description: '' });
const translatedProfile = material => {
  const profile = structuredClone(base);
  profile.material.value = material;
  return profile;
};
const inspect = (text, profile = base) => inspectEvidence(content(text), profile)[0];
const review = (text, profile = base) => reviewContent({ content: content(text), profile, rulePack });

test('a Chinese 100% cotton record supports the same complete percentage in English and Chinese', () => {
  const english = ['100% cotton', '100.0% cotton', '100 % cotton'];
  const chinese = ['100% 棉', '100%棉', '100.0% 棉', '100 % 棉', '100% 棉纤维'];
  for (const material of chinese) {
    assert.deepEqual(parseComposition(material).ingredients, [{ fiber: 'cotton', percent: 100 }], material);
    assert.equal(compareFiber(parseComposition(material), 'cotton', 100).state, 'match', material);
    const profile = translatedProfile(material);
    const before = JSON.stringify(profile);
    for (const text of [...english, ...chinese]) {
      const entry = inspect(text, profile);
      assert.equal(entry.state, 'parameters_aligned', `${material}: ${text}`);
      assert.equal(entry.unresolved_parameters.length, 0, text);
      assert.equal(entry.parameter_links.length, 1, text);
      assert.equal(entry.parameter_links[0].method, 'material_percentage', text);
      assert.equal(entry.parameter_links[0].original, text.slice(0, text.indexOf('%') + 1), text);
      assert.ok(!review(text, profile).issues.some(issue => ['AMZ-05', 'EVID-01'].includes(issue.rule_id)), text);
    }
    assert.equal(JSON.stringify(profile), before, 'parameter review must not rewrite the recorded profile');
  }
  assert.equal(canonicalFiber('棉'), 'cotton');
  assert.equal(canonicalFiber('棉纤维'), 'cotton');
});

test('0% and 10% remain true ratio conflicts instead of being silently changed to 100%', () => {
  const profile = translatedProfile('100% 棉');
  for (const percentage of [0, 10]) {
    for (const fiber of ['cotton', '棉']) {
      const text = `${percentage}% ${fiber}`;
      assert.equal(parseComposition(text).percents.cotton, percentage, text);
      const entry = inspect(text, profile);
      assert.equal(entry.parameter_links.length, 0, text);
      assert.equal(entry.unresolved_parameters[0].status, 'conflict', text);
      assert.ok(entry.unresolved_parameters[0].reason.includes(`${percentage}%`), text);
      assert.ok(entry.unresolved_parameters[0].reason.includes('100%'), text);
      assert.ok(review(text, profile).issues.some(issue => issue.rule_id === 'AMZ-05'), text);
    }
  }
  assert.deepEqual(parseComposition('99.5% 棉').ingredients, [{ fiber: 'cotton', percent: 99.5 }]);
  assert.deepEqual(parseComposition('0.5% 棉').ingredients, [{ fiber: 'cotton', percent: 0.5 }]);
});

test('unrecognized words do not prove absence of cotton or receive inferred composition percentages', () => {
  for (const material of ['棉布', '棉花糖', '石棉', '100% 棉布', '100% 棉花糖', '100% 石棉', '纯棉', '全棉', '不含棉', '不含 棉', '不含100% 棉']) {
    const composition = parseComposition(material);
    assert.deepEqual(composition.fibers, [], material);
    assert.equal(compareFiber(composition, 'cotton', 100).state, 'unknown_composition', material);
    const profile = translatedProfile(material);
    for (const text of ['100% cotton', 'cotton']) {
      const entry = inspect(text, profile);
      assert.equal(entry.state, 'needs_evidence', `${material}: ${text}`);
      assert.equal(entry.parameter_links.length, 0, material);
      assert.equal(entry.unresolved_parameters[0].status, 'needs_review', material);
      assert.ok(entry.unresolved_parameters[0].reason.includes('人工核对'), material);
      const result = review(text, profile);
      assert.ok(!result.issues.some(issue => issue.rule_id === 'AMZ-05'), material);
      assert.ok(result.issues.some(issue => issue.rule_id === 'EVID-01'), material);
    }
  }
  // A recognized contradictory composition still yields a definite conflict.
  assert.equal(compareFiber(parseComposition('100% polyester'), 'cotton', 100).state, 'missing_fiber');
  assert.ok(review('100% cotton', translatedProfile('100% polyester')).issues.some(issue => issue.rule_id === 'AMZ-05'));
});

test('negative cotton statements are never linked as affirmative composition evidence', () => {
  for (const text of ['not made of cotton', 'not made of 100% cotton', '不含棉', '不含 棉', '不含100% 棉', '并非 100% 棉']) {
    const entries = inspectEvidence(content(text), base);
    assert.ok(entries.every(entry => entry.state !== 'parameters_aligned'), text);
    assert.ok(entries.every(entry => entry.parameter_links.length === 0), text);
  }
});

test('an explicit 0% product record cannot support even an unquantified cotton claim', () => {
  for (const material of ['0% cotton', '0% 棉']) {
    assert.equal(compareFiber(parseComposition(material), 'cotton').state, 'missing_fiber', material);
    for (const text of ['cotton', '棉']) {
      const entry = inspect(text, translatedProfile(material));
      assert.equal(entry.parameter_links.length, 0, text);
      assert.equal(entry.unresolved_parameters[0].status, 'conflict', text);
      assert.ok(review(text, translatedProfile(material)).issues.some(issue => issue.rule_id === 'AMZ-05'), text);
    }
  }
});
