// Engineering transport checks only; these do not establish live DeepSeek acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchModelResponse, readModelJson } from '../server/model-transport.mjs';
import { normalizeCall } from '../server/telemetry.mjs';
import { invokeModel } from '../server/providers.mjs';

const config = { provider: 'compatible', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', api_key: 'transport-test-not-a-real-key', timeout_ms: 5000 };
const request = { operation: 'diagnose', product: null, current_content: null, rules: [], sources: [] };
const socketError = code => new TypeError('unsafe URL / key / headers must never be persisted', { cause: Object.assign(new Error('unsafe details'), { code }) });
const validResponse = () => new Response(JSON.stringify({ id: 'transport-protocol-id', model: config.model, usage: { total_tokens: 1 }, choices: [{ message: { content: JSON.stringify({ review: { issues: [], checks: [] } }) } }] }));

test('a proven preconnect failure reconnects once with the same body and deadline', async () => {
  const trace = {}; const calls = [];
  const response = await fetchModelResponse('https://example.invalid', { method: 'POST', body: 'unchanged' }, {
    timeoutMs: 5000, trace,
    fetcher: async (_url, options) => { calls.push(options); if (calls.length === 1) throw socketError('ENOTFOUND'); return validResponse(); },
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].signal, calls[1].signal);
  assert.equal(trace.connection_retry.recovered, true);
  assert.deepEqual(trace.connection_retry.failed_attempt.transport_error.codes, ['ENOTFOUND']);
  assert.ok(!trace.transport_error);
  assert.ok(!JSON.stringify(trace).includes('unsafe'));
});

test('repeated preconnect failure is bounded; uncertain socket failures and workflow calls are not replayed', async () => {
  for (const [code, retryConnection, expectedCalls] of [['ECONNREFUSED', true, 2], ['ECONNRESET', true, 1], ['UND_ERR_HEADERS_TIMEOUT', true, 1], ['ENOTFOUND', false, 1]]) {
    let calls = 0; const trace = {};
    await assert.rejects(() => fetchModelResponse('https://example.invalid', {}, { timeoutMs: 5000, trace, retryConnection, fetcher: async () => { calls++; throw socketError(code); } }), error => {
      assert.equal(error.code, code === 'UND_ERR_HEADERS_TIMEOUT' ? 'MODEL_TIMEOUT' : 'MODEL_CONNECTION_FAILED');
      assert.deepEqual(error.transport_error.codes, [code]);
      return true;
    });
    assert.equal(calls, expectedCalls);
    if (expectedCalls === 2) assert.equal(trace.connection_retry.recovered, false);
  }
});

test('the transport deadline remains active while reading a response body', async () => {
  let signal;
  const trace = {};
  const response = await fetchModelResponse('https://example.invalid', {}, { timeoutMs: 15, trace, fetcher: async (_url, options) => {
    signal = options.signal;
    return { json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) };
  } });
  // Keep the event loop alive: AbortSignal.timeout alone uses an unref'ed timer.
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(() => readModelJson(response, trace), error => error.code === 'MODEL_TIMEOUT' && error.transport_error.phase === 'response_body');
    assert.equal(signal.aborted, true);
  } finally { clearTimeout(keepAlive); }
});

test('aggregate connection errors with any unknown branch are never treated as proven preconnect failures', async () => {
  for (const unknown of [new Error('unknown branch'), Object.assign(new Error('unknown code'), { code: 'UNRECOGNIZED_FAILURE' })]) {
    let calls = 0; const trace = {};
    const error = new TypeError('fetch failed', { cause: new AggregateError([Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), unknown]) });
    await assert.rejects(() => fetchModelResponse('https://example.invalid', {}, { timeoutMs: 5000, trace, fetcher: async () => { calls++; throw error; } }), failure => failure.code === 'MODEL_CONNECTION_FAILED');
    assert.equal(calls, 1);
    assert.equal(trace.transport_error.phase, 'request');
    assert.ok(!JSON.stringify(trace).includes('UNRECOGNIZED_FAILURE'));
  }
});

test('an interrupted successful HTTP body retains its request ID and never triggers a paid format retry', async () => {
  const original = globalThis.fetch;
  for (const readError of [socketError('UND_ERR_SOCKET'), new DOMException('untrusted details', 'TimeoutError')]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return { ok: true, status: 200, headers: new Headers({ 'x-request-id': 'body-request-id' }), json: async () => { throw readError; } }; };
    try {
      await assert.rejects(() => invokeModel(config, request), error => {
        assert.equal(error.code, readError.name === 'TimeoutError' ? 'MODEL_TIMEOUT' : 'MODEL_CONNECTION_FAILED');
        assert.equal(error.model_trace.provider_request_id, 'body-request-id');
        assert.equal(error.model_trace.http_status, 200);
        assert.equal(error.model_trace.transport_error.phase, 'response_body');
        assert.ok(!error.format_retry);
        assert.ok(!JSON.stringify(error.model_trace).includes('unsafe'));
        return true;
      });
      assert.equal(calls, 1);
    } finally { globalThis.fetch = original; }
  }
});

test('an internal adapter exception is not reported as a connection failure or replayed', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return { status: 200, headers: { get: () => { throw new TypeError('internal adapter defect'); } } }; };
  try {
    await assert.rejects(() => invokeModel(config, request), error => error.code === 'MODEL_PROCESSING_FAILED' && !error.model_trace.transport_error);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('a known HTTP rejection stays actionable even if its body cannot be read', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 401, headers: new Headers({ 'x-request-id': 'rejected-body' }), json: async () => { throw socketError('UND_ERR_SOCKET'); } }; };
  try {
    await assert.rejects(() => invokeModel(config, request), error => error.code === 'MODEL_HTTP_401' && error.model_trace.transport_error.phase === 'response_body');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('public telemetry includes only allowed transport codes and no raw messages, URLs or headers', () => {
  const entry = normalizeCall({ transport_error: { phase: 'response_body', kind: 'connection', codes: ['UND_ERR_SOCKET', 'private-key-value'], message: 'secret' },
    connection_retry: { attempts: 2, recovered: false, failed_attempt: { elapsed_ms: 7, transport_error: { phase: 'connect', kind: 'connection', codes: ['ENOTFOUND'], headers: 'secret' }, body: 'secret' } } });
  assert.deepEqual(entry.transport_error.codes, ['UND_ERR_SOCKET']);
  assert.deepEqual(entry.connection_retry.failed_attempt.transport_error.codes, ['ENOTFOUND']);
  assert.ok(!JSON.stringify(entry).includes('secret'));
  assert.ok(!JSON.stringify(entry).includes('private-key-value'));
});
