// Engineering guards on an archived real record. No model call or new merchant-acceptance claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { benchmarkData, benchmarkForRecord, benchmarkSection, recordedBenchmarkScope } from '../server/benchmark-section.mjs';
import { exportListingReport } from '../server/listing-report.mjs';

const archived = JSON.parse(readFileSync(new URL('../reports/teammate-sync-2026-10-30/final-record.json', import.meta.url), 'utf8'));
const content = archived.content;

test('legacy US/en scope stays usable and labels the unverified historical aggregate', () => {
  const old = { content };
  assert.deepEqual(recordedBenchmarkScope(old), { marketplace: 'US', language: 'en' });
  const data = benchmarkForRecord(old);
  assert.equal(data.supported, true);
  assert.equal(data.baseline.n, 45);
  assert.match(data.notice, /队友提供历史聚合快照，原始样本待补/);
  assert.ok(data.facts.every(fact => !/在售|平台的新要求/.test(fact.sentence)));
  const html = benchmarkSection(content);
  assert.match(html, /历史样本写法对照（45 条/);
  assert.doesNotMatch(html, /同类真实在售商品怎么写/);
});

test('DE/UK/FR versions have no matching baseline and receive no US writing advice', () => {
  for (const [marketplace, language] of [['DE', 'de'], ['UK', 'en'], ['FR', 'fr']]) {
    const data = benchmarkForRecord({ content, marketplace, language });
    assert.equal(data.supported, false, marketplace);
    assert.equal(data.baseline, null);
    assert.deepEqual(data.facts, []);
    assert.equal(data.attention, 0);
    const html = benchmarkSection(content, { marketplace, language });
    assert.match(html, /暂无匹配/);
    assert.doesNotMatch(html, /45 条|amazon\.com|美国买家|写 5 条/);
  }
});

test('Spanish and internal Chinese output do not inherit English-only US baseline', () => {
  for (const language of ['es', 'zh']) {
    const data = benchmarkForRecord({ content, marketplace: 'US', language });
    assert.equal(data.supported, false);
    assert.deepEqual(data.facts, []);
  }
});

test('saved plan and rule snapshot preserve scope when a legacy top-level field is absent', () => {
  assert.deepEqual(recordedBenchmarkScope({ guided_plan: { marketplace: 'DE', language: 'de' } }), { marketplace: 'DE', language: 'de' });
  assert.deepEqual(recordedBenchmarkScope({ rule_pack_snapshot: { scope: { marketplace: 'FR' } }, language: 'fr' }), { marketplace: 'FR', language: 'fr' });
  assert.equal(benchmarkForRecord({ content, guided_plan: { marketplace: 'DE', language: 'de' }, marketplace: 'US' }).supported, false);
});

test('request scope cannot relabel a stored version to unlock the US baseline', () => {
  const german = { content, marketplace: 'DE', language: 'de' };
  assert.throws(() => benchmarkForRecord(german, { marketplace: 'US', language: 'en' }), error => error.code === 'BENCHMARK_SCOPE_MISMATCH' && error.status === 409);
  assert.throws(() => benchmarkForRecord({ content, marketplace: 'US', language: 'zh' }, { language: 'en' }), error => error.code === 'BENCHMARK_SCOPE_MISMATCH');
  assert.equal(benchmarkForRecord({ content, marketplace: 'US', language: 'en' }, { marketplace: 'US', language: 'en' }).supported, true);
});

test('unsupported scope stops before reading or interpreting the US aggregate', () => {
  const baseline = { get schema() { throw new Error('must not inspect US aggregate'); } };
  const data = benchmarkData(content, { marketplace: 'DE', language: 'de', baseline });
  assert.equal(data.supported, false);
  assert.deepEqual(data.facts, []);
});

test('HTML report uses recorded marketplace and language instead of a default US comparison', () => {
  for (const scope of [
    { marketplace: 'DE', language: 'de' },
    { guided_plan: { marketplace: 'FR', language: 'fr' } },
    { rule_pack_snapshot: { scope: { marketplace: 'UK' } }, language: 'en' },
    { marketplace: 'US', language: 'zh' },
  ]) {
    const record = { ...structuredClone(archived), ...scope };
    // Only report scope is varied to exercise dispatch; archived content is not a translated acceptance result.
    delete record.guided_plan;
    if (scope.guided_plan) record.guided_plan = { ...scope.guided_plan, id: 'scope-guard-only', optimized_prompt: '', changes: [], missing: [] };
    if (!Object.hasOwn(scope, 'marketplace')) delete record.marketplace;
    if (!Object.hasOwn(scope, 'language')) delete record.language;
    const html = exportListingReport(record);
    assert.match(html, /历史样本写法对照/);
    assert.match(html, /暂无匹配的历史聚合基线/);
    assert.doesNotMatch(html, /45 条 · 2026-10-30 快照|cotton tote bag \/ amazon\.com/);
  }
});
