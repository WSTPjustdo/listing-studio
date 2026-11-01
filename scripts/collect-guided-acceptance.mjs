// Publish only an allowlisted summary of real acceptance; never copy settings, databases or raw model responses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const standardDirectory = arg('--standard-directory');
assert.ok(standardDirectory, '--standard-directory is required');
const output = path.resolve(arg('--output', 'reports/two-path-guided-2026-10-30'));
const state = JSON.parse(fs.readFileSync('.runtime/live-intake-current.json', 'utf8'));
fs.mkdirSync(output, { recursive: true });
const write = (file, data) => fs.writeFileSync(path.join(output, file), JSON.stringify(data, null, 2));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const telemetry = directory => {
  const db = new DatabaseSync(path.join(directory, 'validation.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT data FROM call_telemetry ORDER BY id').all().map(row => JSON.parse(row.data)); }
  finally { db.close(); }
};
const audit = fs.readFileSync(path.join(state.directory, 'provider-audit.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const measured = [...telemetry(state.directory), ...telemetry(standardDirectory)];
const standardReport = read(path.join(standardDirectory, 'report.json'));
const standardTraces = new Map();
function collectTraces(value, stage, failureCode = null) {
  if (!value || typeof value !== 'object') return;
  if (value.actual_model_call && value.provider_request_id) standardTraces.set(value.provider_request_id, {
    model: value.model || null, elapsed_ms: value.elapsed_ms ?? null, stage,
    elapsed_scope: failureCode ? 'single_failed_attempt_trace' : value.format_retry ? 'recorded_call_sequence_including_format_retry' : 'recorded_call_trace',
    outcome: failureCode ? 'failed' : 'ok', error_code: failureCode, usage: value.usage || null,
  });
  for (const [key, child] of Object.entries(value)) {
    const code = key === 'trace' && value.error_code ? value.error_code : failureCode;
    collectTraces(child, stage, code);
  }
}
for (const step of standardReport.steps) collectTraces(step.record, step.label);
const observations = audit.map(row => ({ ...row, elapsed_scope: 'observed_single_http_fetch', origin: 'isolated_guided_server' }));
for (const file of fs.readdirSync(standardDirectory).filter(name => /^response-.*\.json$/.test(name))) {
  const body = read(path.join(standardDirectory, file));
  const trace = standardTraces.get(body.id);
  observations.push({ ...trace, request_id: body.id || null, model: body.model || trace?.model || null, usage: body.usage || trace?.usage || null, origin: 'standard_live_command', http_status: body.error ? null : 200 });
}
const ledger = new Map();
for (const row of observations) {
  if (!row.request_id) continue;
  const trace = measured.find(item => item.request_id === row.request_id);
  ledger.set(row.request_id, { ...row, operation: row.operation || trace?.operation || 'unknown', elapsed_ms: row.elapsed_ms ?? trace?.duration_ms ?? null, outcome: trace?.outcome || row.outcome || 'unrecorded', error_code: trace?.error_code || row.error_code || null, telemetry: trace || null });
}
for (const row of measured) if (row.request_id && !ledger.has(row.request_id)) ledger.set(row.request_id, {
  request_id: row.request_id, model: row.model, operation: row.operation, elapsed_ms: row.duration_ms, outcome: row.outcome,
  error_code: row.error_code, usage: { prompt_tokens: row.prompt_tokens, completion_tokens: row.completion_tokens, total_tokens: row.total_tokens }, telemetry: row,
});
const rows = [...ledger.values()];
const modelReport = { collected_at: new Date().toISOString(), actual_request_ids: rows.length,
  total_tokens: rows.reduce((sum, row) => sum + (row.usage?.total_tokens || 0), 0),
  failures: rows.filter(row => row.outcome === 'failed'),
  no_request_id_telemetry: measured.filter(row => !row.request_id), rows,
  notice: 'Actual observed requests only; retries and invalid model formats remain recorded. No price or long-term reliability inferred. Raw responses/settings remain private.' };
write('model-acceptance.json', modelReport);
const reports = fs.readdirSync(state.directory).filter(name => /^guided-browser-.*\.json$/.test(name)).sort();
for (const name of reports) write(name, read(path.join(state.directory, name)));
write('api-before-final-source-boundary.json', { ...read(path.join(state.directory, 'guided-acceptance.json')), notice_final_boundary: 'The earlier Amazon search happened before verification handling was disabled. This is historical input, not acceptance of the final safe Amazon collector; use final browser records and explicit official-public selection.' });
write('standard-live-api.json', { ...standardReport, directory: undefined });
write('standard-live-browser.json', { ...read('.runtime/live-browser-report.json'), screenshot: 'standard-live-browser.png' });
write('public-inputs.json', { ...state, directory: undefined, database: undefined });
for (const [from, to] of [['.runtime/two-paths-research-probe/after-search.json', 'amazon-safe-search-failure.json'], ['.runtime/two-paths-research-probe/official-source-search.json', 'official-live-source-probe.json']]) write(to, read(from));
for (const name of ['guided-home-1440.png', 'guided-home-390.png', 'guided-improve-confirm-1440.png', 'guided-improve-result-1440.png', 'guided-automatic-confirm-1440.png', 'guided-automatic-result-1440.png', 'guided-automatic-result-390.png', 'guided-automatic-amazon-failure-1440.png']) fs.copyFileSync(path.join(state.directory, name), path.join(output, name));
fs.copyFileSync('.runtime/live-acceptance-browser.png', path.join(output, 'standard-live-browser.png'));
const before = new DatabaseSync('.runtime/two-paths-development-20261030/before.sqlite', { readOnly: true });
const after = new DatabaseSync('.runtime/listing-studio.sqlite', { readOnly: true });
const preservation = ['products', 'versions', 'runs', 'batches', 'settings'].map(table => {
  const left = before.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const right = after.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return { table, before: left.length, after: right.length, unchanged: JSON.stringify(left) === JSON.stringify(right) };
});
before.close(); after.close();
assert.ok(preservation.every(row => row.unchanged), 'Original workspace data changed');
write('original-data-preservation.json', { checked_at: new Date().toISOString(), tables: preservation, secrets_included: false });
console.log(JSON.stringify({ output, request_ids: rows.length, total_tokens: modelReport.total_tokens, model_format_failures: modelReport.failures.length, browser_reports: reports, original_data_unchanged: true }));
