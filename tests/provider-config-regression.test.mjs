// Configuration persistence regression checks only: no product data or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.mjs';
import { getConfig, publicConfig, saveConfig, settingsSchema } from '../server/providers.mjs';

const compatible = {
  provider: 'compatible',
  base_url: 'http://127.0.0.1:11434/v1',
  model: 'local-config-regression',
  api_key: '',
  dify_base_url: 'https://api.dify.ai/v1',
  dify_create_api_key: 'config-only-create',
  dify_diagnose_api_key: 'config-only-diagnose',
  timeout_ms: 120000,
};

function withStore(run) {
  const store = createStore(':memory:');
  try { run(store); } finally { store.close(); }
}

function withEnvironment(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('Dify saves preserve compatible endpoint and model across mode switches', () => withStore(store => {
  store.saveSettings(compatible);
  const dify = saveConfig(store, {
    provider: 'dify', base_url: '  ', model: '', timeout_ms: 120000,
    dify_base_url: 'https://api.dify.ai/v1',
  });
  assert.equal(dify.provider, 'dify');
  assert.equal(dify.base_url, compatible.base_url);
  assert.equal(dify.model, compatible.model);
  assert.equal(store.settings().base_url, compatible.base_url);
  assert.equal(store.settings().model, compatible.model);
  const back = saveConfig(store, { ...store.settings(), provider: 'compatible' });
  assert.equal(back.base_url, compatible.base_url);
  assert.equal(back.model, compatible.model);
}));

test('historical empty Dify fields recover environment settings without restoring cleared secrets', () => {
  withEnvironment({
    MODEL_BASE_URL: 'http://127.0.0.1:12345/v1', MODEL_NAME: 'environment-config-regression',
    MODEL_API_KEY: 'environment-only-config-value', DIFY_CREATE_API_KEY: 'environment-only-create',
  }, () => withStore(store => {
    store.saveSettings({ provider: 'dify', base_url: '', model: ' ', api_key: '', dify_create_api_key: '' });
    const current = getConfig(store);
    assert.equal(current.base_url, process.env.MODEL_BASE_URL);
    assert.equal(current.model, process.env.MODEL_NAME);
    assert.equal(Boolean(current.api_key), false);
    assert.equal(Boolean(current.dify_create_api_key), false);
    const safe = publicConfig(current);
    assert.equal(safe.has_api_key, false);
    assert.equal(safe.has_dify_create_api_key, false);
    assert.equal('api_key' in safe, false);
  }));
});

test('compatible mode rejects blank active endpoint or model without changing saved configuration', () => withStore(store => {
  store.saveSettings(compatible);
  for (const patch of [{ base_url: '' }, { model: '   ' }]) {
    assert.throws(() => saveConfig(store, { ...compatible, ...patch }), { code: 'MISSING_MODEL_CONFIG' });
    assert.deepEqual(store.settings(), compatible);
  }
}));

test('first Dify save persists usable fallback compatible fields', () => {
  withEnvironment({ MODEL_BASE_URL: '', MODEL_NAME: '' }, () => withStore(store => {
    const result = saveConfig(store, { ...compatible, provider: 'dify', base_url: '', model: '' });
    assert.equal(result.base_url, 'https://api.deepseek.com');
    assert.equal(result.model, 'deepseek-flash');
    assert.equal(store.settings().model, result.model);
  }));
});

test('clear_secrets clears all provider keys while retaining mode configuration', () => withStore(store => {
  store.saveSettings({ ...compatible, api_key: 'config-only-compatible' });
  const result = saveConfig(store, { provider: 'dify', base_url: '', model: '', clear_secrets: true });
  assert.equal(result.base_url, compatible.base_url);
  assert.equal(result.model, compatible.model);
  assert.equal(result.has_api_key, false);
  assert.equal(result.has_dify_create_api_key, false);
  assert.equal(result.has_dify_diagnose_api_key, false);
  for (const field of ['api_key', 'dify_create_api_key', 'dify_diagnose_api_key']) {
    assert.equal(getConfig(store)[field], '');
    assert.equal(field in result, false);
  }
}));

test('timeout settings accept only whole milliseconds in the 5 to 180 second range', () => {
  assert.equal(settingsSchema.parse({ provider: 'compatible' }).timeout_ms, 60000);
  for (const timeout_ms of [5000, 60000, 180000]) {
    assert.equal(settingsSchema.parse({ ...compatible, timeout_ms }).timeout_ms, timeout_ms);
  }
  for (const timeout_ms of [0, 4999, 180001, 5000.5]) {
    assert.equal(settingsSchema.safeParse({ ...compatible, timeout_ms }).success, false);
  }
});
