// Engineering checks for status transport and component lifetime only.
// Controlled fetch responses below are not product data or real model acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForRun } from '../src/runPolling.ts';

const runId = 'engineering status/id';
const running = { run_id: runId, status: 'running', stage: 'checking' };
const succeeded = { run_id: runId, status: 'succeeded', version: 2 };
const response = value => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' },
});

test('temporary status failures retain polling, deduplicate notices and clear them on recovery', async t => {
  const requests = [];
  const notices = [];
  const progress = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    if (requests.length <= 2) throw new TypeError('Engineering network interruption');
    return response(requests.length === 3 ? running : succeeded);
  });

  const result = await waitForRun(runId, {
    intervalMs: 0,
    onUnavailable: value => notices.push(value),
    onProgress: value => progress.push(value),
  });

  assert.deepEqual(result, succeeded);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(({ url, options }) =>
    url === '/api/runs/engineering%20status%2Fid' &&
    options.method === undefined && options.signal instanceof AbortSignal));
  assert.equal(notices.length, 2, 'identical consecutive failures produce one notice');
  assert.match(notices[0], /Engineering network interruption/);
  assert.match(notices[0], /请勿重复提交/);
  assert.equal(notices[1], null);
  assert.deepEqual(progress, [running, succeeded]);
});

test('a hung status request is aborted and the accepted run remains recoverable', async t => {
  let requests = 0;
  let aborted = false;
  const notices = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests++;
    if (requests > 1) return response(succeeded);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        aborted = true;
        reject(options.signal.reason);
      }, { once: true });
    });
  });

  const result = await waitForRun(runId, {
    intervalMs: 0,
    requestTimeoutMs: 10,
    onUnavailable: value => notices.push(value),
  });

  assert.equal(aborted, true);
  assert.equal(requests, 2);
  assert.deepEqual(result, succeeded);
  assert.equal(notices.length, 2);
  assert.match(notices[0], /继续查询/);
  assert.equal(notices[1], null);
});

test('a server failure is terminal and preserves the actual failure payload', async t => {
  const failed = { run_id: runId, status: 'failed', error: { code: 'ENGINEERING_ONLY', message: 'Engineering terminal failure' } };
  let requests = 0;
  const notices = [];
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return response(failed);
  });

  assert.deepEqual(await waitForRun(runId, {
    intervalMs: 0,
    onUnavailable: value => notices.push(value),
  }), failed);
  assert.equal(requests, 1, 'terminal failure must not cause a replacement task');
  assert.deepEqual(notices, []);
});

test('an inactive component performs no status request or callback', async t => {
  let requests = 0;
  const callbacks = [];
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return response(succeeded);
  });
  assert.equal(await waitForRun(runId, {
    isActive: () => false,
    intervalMs: 0,
    onProgress: value => callbacks.push(value),
    onUnavailable: value => callbacks.push(value),
  }), null);
  assert.equal(requests, 0);
  assert.deepEqual(callbacks, []);
});

for (const lateOutcome of ['success', 'network failure']) {
  test(`unmount during a pending request ignores a late ${lateOutcome}`, async t => {
    let active = true;
    let requests = 0;
    let completeRequest;
    let requestStarted;
    const started = new Promise(resolve => { requestStarted = resolve; });
    const pending = new Promise((resolve, reject) => {
      completeRequest = () => lateOutcome === 'success'
        ? resolve(response(succeeded))
        : reject(new TypeError('Engineering late network failure'));
    });
    const callbacks = [];
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      requestStarted();
      return pending;
    });
    const polling = waitForRun(runId, {
      intervalMs: 0,
      isActive: () => active,
      onProgress: value => callbacks.push(value),
      onUnavailable: value => callbacks.push(value),
    });

    await started;
    active = false;
    completeRequest();
    assert.equal(await polling, null);
    assert.equal(requests, 1);
    assert.deepEqual(callbacks, [], 'unmounted consumers must receive no late update');
  });
}
