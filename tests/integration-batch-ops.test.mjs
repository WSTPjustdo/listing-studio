import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { summarizeBatch, ruleWorklist } from '../server/batch-summary.mjs';
import { errorSummary } from '../server/errors.mjs';
import { createGovernor } from '../server/concurrency-governor.mjs';
import { batchConcurrency, createBatchManager, exportFailedRows } from '../server/batch.mjs';
import { createStore } from '../server/store.mjs';

// Structure-only boundary checks. No goods, model responses, upstream service or paid calls.
test('batch denominator excludes preserved, unfinished, and records without coverage', () => {
  const batch = { rows: [{ row: 2, status: 'preserved' }, { row: 3, status: 'completed' }, { row: 4, status: 'completed' }, { row: 5, status: 'failed' }, { row: 6, status: 'completed' }] };
  const records = new Map([
    [3, { review: { issues: [], coverage: { total: 10, completed: 10 }, checks: [] } }],
    [4, { review: { issues: [], coverage: { total: 10, completed: 6 }, checks: [] } }],
    [6, { review: { issues: [], checks: [] } }],
  ]);
  const before = structuredClone(batch);
  const summary = summarizeBatch(batch, row => records.get(row.row));
  assert.equal(summary.rows_preserved, 1);
  assert.equal(summary.rows_concluded, 3);
  assert.equal(summary.rows_clean, 1);
  assert.equal(summary.rows_incomplete_checks, 2);
  assert.deepEqual(batch, before);
});

test('worklist keeps unknown historical rule meaning and separates versions', () => {
  const batch = { rows: [{ row: 2, status: 'completed' }, { row: 3, status: 'completed' }] };
  const recordOf = row => ({ rule_pack_version: `v${row.row}`, review: { issues: [{ rule_id: 'R', severity: 'needs_review', field_path: 'content.title' }] } });
  const worklist = ruleWorklist(batch, recordOf, { rule_pack_version: 'v9', rules: [], sources: [] });
  assert.equal(worklist.length, 2);
  assert.ok(worklist.every(item => !item.historical_basis_known && !item.in_rule_pack));
});

test('retry changes selected failed rows only, retains successful and preserved identities', () => {
  const store = createStore(':memory:');
  store.saveSettings({ provider: 'compatible', model: 'configured' });
  const manager = createBatchManager(store, { enqueue() { assert.fail('No model execution is allowed in this boundary check'); } });
  try {
    const rows = [
      { row: 2, status: 'failed', attempt: 1, error_code: 'MODEL_TIMEOUT', retryable: true },
      { row: 3, status: 'completed', listing_id: 'saved-version-identity', version: 7 },
      { row: 4, status: 'preserved' },
      { row: 5, status: 'failed', error_code: 'STALE_VERSION', retryable: false },
      { row: 6, status: 'failed', error_code: 'MODEL_TIMEOUT', retryable: true },
    ];
    store.saveBatch({ id: 'structure-only-batch', rows, status: 'finished', mapping: { sku: 0 }, file_revision: 4, import_id: 'original-file-id' });
    const result = manager.action('structure-only-batch', 'retry', { rows: [2, 3, 4, 5] });
    assert.equal(result.retry.requeued, 1);
    assert.equal(result.retry.skipped_non_failed, 2);
    assert.equal(result.retry.skipped_non_retryable, 1);
    assert.equal(result.rows[0].attempt, 2);
    assert.deepEqual(result.rows[1], rows[1]);
    assert.deepEqual(result.rows[2], rows[2]);
    assert.equal(result.rows[4].status, 'failed');
    assert.equal(result.file_revision, 4);
    assert.throws(() => manager.action(result.id, 'retry', { rows: [999] }), { code: 'INVALID_ROWS' });
  } finally { manager.close(); store.close(); }
});

test('recovery export contains original string cells and excludes completed rows', async () => {
  const store = createStore(':memory:');
  try {
    store.saveImport({ id: 'original-file', filename: 'structure.tsv', sheet: 'Sheet', headers: ['seller_sku', 'item_name'], rows: [{ number: 7, cells: ['', '=plain text'] }, { number: 8, cells: ['', 'kept elsewhere'] }] });
    const buffer = await exportFailedRows(store, { id: 'structure-only', import_id: 'original-file', rows: [{ row: 7, status: 'failed' }, { row: 8, status: 'completed' }] });
    const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer);
    const sheet = book.getWorksheet('失败原行');
    assert.equal(sheet.rowCount, 2);
    assert.equal(sheet.getCell('A2').value, '');
    assert.equal(sheet.getCell('B2').value, '=plain text');
    assert.equal(sheet.getCell('B2').type, ExcelJS.ValueType.String);
  } finally { store.close(); }
});

test('optional concurrency is bounded; rate limiting delays dispatch even at one slot', () => {
  assert.equal(batchConcurrency({}), 1);
  assert.equal(batchConcurrency({ BATCH_CONCURRENCY: '-3' }), 1);
  assert.equal(batchConcurrency({ BATCH_CONCURRENCY: '999' }), 8);
  let at = 0;
  const governor = createGovernor({ now: () => at, cooldownMs: 100, growAfter: 2 });
  governor.failure('MODEL_HTTP_429');
  assert.equal(governor.slots(), 1);
  assert.equal(governor.backoffMs(), 100);
  governor.success(); governor.success(); assert.equal(governor.slots(), 1);
  at = 101; governor.success(); assert.equal(governor.slots(), 2);
  governor.failure('MODEL_TIMEOUT'); assert.equal(governor.slots(), 2);
  governor.failure('MODEL_HTTP_429'); assert.equal(governor.slots(), 1);
  assert.equal(errorSummary('MODEL_HTTP_400').category, 'config');
  assert.equal(errorSummary('UNREGISTERED'), null);
});
