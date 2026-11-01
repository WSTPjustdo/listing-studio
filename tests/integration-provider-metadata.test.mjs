import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonWithRepair } from '../server/json-repair.mjs';
import { parseResult, invokeModel } from '../server/providers.mjs';
import { normalizeCall, recordCall, listCalls, summarize, detachStore } from '../server/telemetry.mjs';
import { prepareRows, readTable } from '../server/batch.mjs';
import { createStore } from '../server/store.mjs';
import { readFileSync } from 'node:fs';

// Syntax and metadata boundaries only. These fixtures are not products or model acceptance results.
test('syntax recovery preserves literal text and exposes the original parse failure', () => {
  const original = '{"text":"line one\nline two,] and https://example.invalid","numbers":[1,2,],}';
  const result = parseJsonWithRepair(original);
  assert.equal(result.value.text, 'line one\nline two,] and https://example.invalid');
  assert.deepEqual(result.value.numbers, [1, 2]);
  assert.deepEqual(result.notes, ['escaped_literal_control_characters', 'removed_trailing_commas']);
  assert.equal(result.original_error_code, 'MODEL_INVALID_JSON');
  assert.deepEqual(parseJsonWithRepair('{"text":"unchanged"}').notes, []);
  const trace = {};
  parseResult('{"review":{"issues":[],"checks":[]},}', trace, 'diagnose');
  assert.equal(trace.json_repair.original_error_code, 'MODEL_INVALID_JSON');
});

test('recovery refuses truncation, omitted values, ambiguous quotes, prose and comments', () => {
  for (const raw of ['{"review":', '{"text":"unfinished', '{"checks":[,]}', '{"review":,}', '{,}', '{"checks":[...]}', '{"checks":[undefined]}', "{'checks':[]}", 'prefix {"checks":[]}', '{/*comment*/"checks":[]}'])
    assert.throws(() => parseJsonWithRepair(raw), SyntaxError, raw);
  assert.throws(() => parseResult('{"review":{},}', {}, 'diagnose'), { code: 'MODEL_INVALID_STRUCTURE' });
  assert.throws(() => parseResult('{"content":null,}', {}, 'create'), { code: 'MODEL_INVALID_STRUCTURE' });
  assert.throws(() => parseJsonWithRepair('{"review":{"issues":[1]},"review":{"issues":[]},}'), SyntaxError);
  assert.throws(() => parseJsonWithRepair('{"review":1,"\\u0072eview":2}'), SyntaxError);
});

test('telemetry allowlist removes contents and preserves missing values as unknown', () => {
  const row = normalizeCall({ operation: 'diagnose', prompt: 'PRIVATE', api_key: 'PRIVATE', output: 'PRIVATE' });
  assert.equal(row.model, null);
  assert.equal(row.duration_ms, null);
  assert.equal(row.request_id, null);
  assert.equal(row.total_tokens, null);
  assert.ok(!JSON.stringify(row).includes('PRIVATE'));
  const summary = summarize([row]);
  assert.equal(summary.tokens_total, null);
  assert.equal(summary.tokens_unknown_calls, 1);
  assert.equal(summary.avg_ms, null);
});

test('telemetry retains first attempt failure separately from retry and tolerates storage errors', () => {
  detachStore();
  recordCall({ attempts: 1, outcome: 'failed', error_code: 'MODEL_INVALID_JSON', total_tokens: 12, duration_ms: 10 });
  recordCall({ attempts: 2, outcome: 'ok', total_tokens: 15, duration_ms: 20 });
  const rows = listCalls();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].outcome, 'failed');
  assert.equal(rows[1].error_code, 'MODEL_INVALID_JSON');
  assert.equal(summarize(rows).tokens_total, 27);
  assert.doesNotThrow(() => recordCall({ saveCallTelemetry() { throw new Error('unavailable storage'); } }, { outcome: 'ok' }));
  assert.equal(summarize(rows).record_failures, 1);
  detachStore();
});

test('real-model gate and missing configuration do not create request telemetry', async () => {
  detachStore();
  await assert.rejects(() => invokeModel({ provider: 'demo', timeout_ms: 5000 }, { operation: 'diagnose' }), { code: 'REAL_MODEL_REQUIRED' });
  await assert.rejects(() => invokeModel({ provider: 'compatible', base_url: '', model: '', timeout_ms: 5000 }, { operation: 'diagnose' }), { code: 'MISSING_MODEL_CONFIG' });
  assert.equal(listCalls().length, 0);
});

test('batch depth requires explicit units while blank seller identity remains blocked', async () => {
  const store = createStore(':memory:');
  try {
    // Blank identity intentionally blocks model execution. Only the dimension parser is inspected.
    const source = { id: 'structure-only', ...(await readTable('structure.tsv', Buffer.from('SKU\tname\twidth\theight\tdepth\trated_load_kg\n\t\t20 cm\t30 cm\t4\t2 kg\n'))) };
    const input = { import_id: source.id, mapping: source.mapping, operation: 'create', duplicate: 'skip', confirm_scope: true, selected: source.rows.map(row => row.number), edits: {} };
    const row = prepareRows(store, source, input)[0];
    assert.equal(row.status, 'blocked');
    assert.deepEqual(row.product.dimensions_cm.value, { width: 20, height: 30, depth: 4 });
    assert.equal(row.product.rated_load_kg.value, 2);
    const unknown = prepareRows(store, source, { ...input, edits: { [row.row]: { width: '20', height: '30' } } })[0];
    assert.ok(unknown.errors.some(error => error.includes('深度或单位无效')));
    const mixed = prepareRows(store, source, { ...input, edits: { [row.row]: { width: '20 cm', height: '30 in' } } })[0];
    assert.ok(mixed.errors.some(error => error.includes('深度或单位无效')));
  } finally { store.close(); }
});

test('batch updates preserve an unmapped third axis and retain its source only for the same full tuple', async () => {
  // Controlled structure boundary on archived public-product facts, never a seller trial or model result.
  const recorded = JSON.parse(readFileSync(new URL('../reports/parameter-links-2026-10-23/actual-export.json', import.meta.url)));
  const product = structuredClone(recorded.product_snapshot);
  product.sku = 'structure-only-identity';
  product.dimensions_cm.value.depth = 10;
  product.fact_sources = { dimensions_cm: { source_id: 'structure-only-tuple', value: structuredClone(product.dimensions_cm.value) } };
  const store = { products: () => [product], libraryEntry: () => null };
  const source = { id: 'structure-only', ...(await readTable('structure.tsv', Buffer.from('sku\tname\twidth\theight\nstructure-only-identity\t\t38 cm\t42 cm\n'), undefined, 1)) };
  const input = { import_id: source.id, mapping: source.mapping, operation: 'create', duplicate: 'update', confirm_scope: true, selected: source.rows.map(row => row.number), edits: {} };
  const row = prepareRows(store, source, input)[0];
  assert.equal(row.product.dimensions_cm.value.depth, 10);
  assert.deepEqual(row.product.fact_sources.dimensions_cm, product.fact_sources.dimensions_cm);
  const changed = prepareRows(store, source, { ...input, edits: { [row.row]: { width: '39 cm' } } })[0];
  assert.deepEqual(changed.product.dimensions_cm.value, { width: 39, height: 42, depth: 10 });
  assert.equal(changed.product.fact_sources.dimensions_cm, undefined);
  assert.equal(product.dimensions_cm.value.width, 38);
  assert.equal(product.dimensions_cm.value.depth, 10);
});

test('mapped blank or explicitly cleared depth does not inherit the old confirmed third axis', async () => {
  const recorded = JSON.parse(readFileSync(new URL('../reports/parameter-links-2026-10-23/actual-export.json', import.meta.url)));
  const product = structuredClone(recorded.product_snapshot);
  product.sku = 'structure-only-identity';
  product.dimensions_cm.value.depth = 10;
  product.fact_sources = { dimensions_cm: { source_id: 'structure-only-tuple' } };
  const store = { products: () => [product], libraryEntry: () => null };
  const source = { id: 'structure-only', ...(await readTable('structure.tsv', Buffer.from('sku\tname\twidth\theight\tdepth\nstructure-only-identity\t\t38 cm\t42 cm\t\n'), undefined, 1)) };
  const input = { import_id: source.id, mapping: source.mapping, operation: 'create', duplicate: 'update', confirm_scope: true, selected: source.rows.map(row => row.number), edits: {} };
  for (const options of [input, { ...input, mapping: { ...input.mapping, depth: -1 }, edits: { [source.rows[0].number]: { depth: '' } } }]) {
    const row = prepareRows(store, source, options)[0];
    assert.deepEqual(row.product.dimensions_cm.value, { width: 38, height: 42 });
    assert.equal(row.product.fact_sources.dimensions_cm, undefined);
  }
});
