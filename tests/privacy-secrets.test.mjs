// 「清除密钥」这条路到底清干净了没有（离线，临时库，不碰 .runtime/listing-studio.sqlite）。
// 第 7 轮量到：清除后接口读不回，但 -wal 里还留着旧页，逐字节仍搜得到；关掉服务才归零。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createStore, ROOT } from '../server/store.mjs';
import { getConfig, saveConfig } from '../server/providers.mjs';

const KEY = 'sk-selftest-0000-1111-2222-333344445555';
const DIR = resolve(ROOT, '.runtime/privacy-secrets-test');

function freshDb(name) {
  mkdirSync(DIR, { recursive: true });
  const file = resolve(DIR, `${name}-${randomUUID()}.sqlite`);
  return file;
}

function bytesOf(file) {
  return ['', '-wal', '-shm']
    .map((suffix) => file + suffix)
    .filter(existsSync)
    .map((path) => readFileSync(path).toString('latin1'))
    .join('');
}

const base = (extra) => ({
  provider: 'compatible',
  base_url: 'https://api.siliconflow.cn/v1',
  model: 'probe-model',
  dify_base_url: 'https://api.dify.ai/v1',
  timeout_ms: 60000,
  ...extra,
});

test('清除密钥后，主文件和 WAL 里都搜不到旧 Key', () => {
  const file = freshDb('clear');
  const store = createStore(file);
  try {
    saveConfig(store, base({ api_key: KEY }));
    assert.equal(bytesOf(file).split(KEY).length - 1, 1, '写入后应当能搜到 1 次');
    saveConfig(store, base({ clear_secrets: true }));
    assert.equal(Boolean(getConfig(store).api_key), false, '接口层应当已经读不回');
    const residue = bytesOf(file).split(KEY).length - 1;
    assert.equal(residue, 0, `清除后文件里还剩 ${residue} 次 —— 删了但没删干净`);
    assert.equal(existsSync(`${file}-wal`) ? readFileSync(`${file}-wal`).length : 0, 0, 'WAL 应当被截断到 0 字节');
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
  }
});

test('在 DeepSeek 官方接口下也允许清除密钥', () => {
  const file = freshDb('deepseek');
  const store = createStore(file);
  try {
    saveConfig(store, { ...base({ api_key: KEY }), base_url: 'https://api.deepseek.com', model: 'deepseek-flash' });
    // 不能因为"没有 Key"就拒绝"删掉 Key" —— 那样唯一一条删除路径就断了。
    assert.doesNotThrow(() =>
      saveConfig(store, {
        provider: 'compatible', base_url: 'https://api.deepseek.com', model: 'deepseek-flash',
        dify_base_url: 'https://api.dify.ai/v1', timeout_ms: 60000, clear_secrets: true,
      }),
    );
    assert.equal(Boolean(getConfig(store).api_key), false);
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
  }
});

test('不带 clear_secrets 时，DeepSeek 缺 Key 仍然要拒绝（防误清空）', () => {
  const file = freshDb('guard');
  const store = createStore(file);
  try {
    assert.throws(
      () =>
        saveConfig(store, {
          provider: 'compatible', base_url: 'https://api.deepseek.com', model: 'deepseek-flash',
          dify_base_url: 'https://api.dify.ai/v1', timeout_ms: 60000,
        }),
      (error) => error.code === 'MISSING_API_KEY',
    );
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
  }
});