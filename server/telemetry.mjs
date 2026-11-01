/** One row per dispatched request. Only explicitly allowed metadata is persisted. */
import { transportMetadata } from './model-transport.mjs';
let attachedStore = null;
const memory = [];
let recordFailures = 0;
const nullableString = (value, max = 200) => typeof value === 'string' && value ? value.slice(0, max) : null;
const nullableNumber = value => Number.isFinite(value) && value >= 0 ? value : null;
const isStore = value => Boolean(value && typeof value.saveCallTelemetry === 'function');
const limitOf = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.min(500, Math.floor(Number(value))) : 50;
export function attachStore(store) { attachedStore = store; return store; }
export function detachStore() { attachedStore = null; memory.length = 0; recordFailures = 0; }
export function normalizeCall(entry = {}) {
  const usage = entry.usage || {};
  const tokens = nullableNumber(entry.total_tokens ?? usage.total_tokens);
  return {
    at: nullableString(entry.at, 40) || new Date().toISOString(),
    operation: nullableString(entry.operation, 80), provider: nullableString(entry.provider, 80),
    model: nullableString(entry.model), requested_model: nullableString(entry.requested_model),
    duration_ms: nullableNumber(entry.duration_ms), total_tokens: tokens,
    prompt_tokens: nullableNumber(entry.prompt_tokens ?? usage.prompt_tokens),
    completion_tokens: nullableNumber(entry.completion_tokens ?? usage.completion_tokens),
    attempts: Number.isInteger(entry.attempts) && entry.attempts > 0 ? entry.attempts : 1,
    json_repaired: entry.json_repaired === true,
    json_repair_notes: Array.isArray(entry.json_repair_notes) ? entry.json_repair_notes.filter(value => typeof value === 'string').slice(0, 8).map(value => value.slice(0, 100)) : [],
    original_error_code: nullableString(entry.original_error_code, 80),
    outcome: entry.outcome === 'failed' ? 'failed' : 'ok',
    error_code: nullableString(entry.error_code, 80), request_id: nullableString(entry.request_id),
    http_status: Number.isInteger(entry.http_status) ? entry.http_status : null,
    ...transportMetadata(entry),
    // 归属：这一行属于哪一批的哪一行。批量任务的成本只能靠它算出来。
    // 注意 `request_id` 存的是**上游**返回的 id（providers.mjs 里 trace.provider_request_id），
    // 不是我们的 `${batch.id}-${row}-${attempt}`，所以不能拿它做前缀聚合（第 12 轮实测 0/24 条对得上）。
    batch_id: nullableString(entry.batch_id, 60),
    batch_row: Number.isInteger(entry.batch_row) && entry.batch_row > 0 ? entry.batch_row : null,
    batch_attempt: Number.isInteger(entry.batch_attempt) && entry.batch_attempt >= 0 ? entry.batch_attempt : null,
  };
}
export function recordCall(first, second) {
  const store = isStore(first) ? first : attachedStore;
  const row = normalizeCall(isStore(first) ? second : first);
  try {
    if (store) store.saveCallTelemetry(row);
    else { memory.unshift(row); if (memory.length > 500) memory.pop(); }
  } catch { recordFailures += 1; }
  return row;
}
export function listCalls(first, second) {
  const store = isStore(first) ? first : attachedStore;
  const limit = limitOf(isStore(first) ? second : first);
  return store ? store.callTelemetry(limit) : memory.slice(0, limit).map(row => structuredClone(row));
}
export function summarize(calls = []) {
  const durations = calls.map(row => row.duration_ms).filter(Number.isFinite);
  const tokenValues = calls.map(row => row.total_tokens).filter(Number.isFinite);
  const failed = calls.filter(row => row.outcome === 'failed').length;
  const byOperation = {};
  for (const row of calls) {
    const bucket = byOperation[row.operation || 'unknown'] ||= { count: 0, failed: 0, total_ms: 0, measured: 0 };
    bucket.count += 1; if (row.outcome === 'failed') bucket.failed += 1;
    if (Number.isFinite(row.duration_ms)) { bucket.total_ms += row.duration_ms; bucket.measured += 1; }
  }
  for (const bucket of Object.values(byOperation)) bucket.avg_ms = bucket.measured ? Math.round(bucket.total_ms / bucket.measured) : null;
  return { total: calls.length, ok: calls.length - failed, failed,
    failed_rate: calls.length ? Number((failed / calls.length).toFixed(3)) : null,
    avg_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    slowest_ms: durations.length ? Math.max(...durations) : null,
    tokens_total: tokenValues.length ? tokenValues.reduce((a, b) => a + b, 0) : null,
    tokens_unknown_calls: calls.length - tokenValues.length,
    json_repaired: calls.filter(row => row.json_repaired).length,
    retried: calls.filter(row => row.attempts > 1).length,
    record_failures: recordFailures, by_operation: byOperation };
}
