// Real running workbench UI regressions. No mocked product/model/network responses.
// Config-only tests run against a separate database containing no real credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { load } from 'cheerio';
import { createStore } from '../server/store.mjs';

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const base = arg('--base-url', 'http://127.0.0.1:3223').replace(/\/+$/, '');
const directory = resolve(arg('--output-dir', '.runtime/teammate-bugs-20261101/browser'));
const configPort = Number(arg('--config-port', '3224'));
const configBase = `http://127.0.0.1:${configPort}`;
const alias = arg('--insecure-host', '127.0.0.1');
const insecureBase = arg('--insecure-base', `http://${alias}:${new URL(base).port}`);
mkdirSync(directory, { recursive: true });
const report = {
  started_at: new Date().toISOString(), base_url: base,
  evidence_type: 'actual_workbench_browser_and_isolated_config_server',
  notice: 'Main workbench configuration and product data are read only. All configuration mutations use a separate database with noncredential test strings and no model calls. Rule entry uses a freshly fetched FTC guide and explicitly leaves policy changes and dates unknown. Browser localStorage is isolated from the user profile.',
  checks: [], screenshots: [], failures: [], page_errors: [], mutation_requests: [], model_calls: [], new_model_calls: 0,
};
const save = () => writeFileSync(resolve(directory, 'acceptance.json'), JSON.stringify(report, null, 2));
const hash = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
let browser, configServer;
let phase = 'bootstrap';
async function json(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `${new URL(url).pathname}: HTTP ${response.status}`);
  return response.json();
}
function observe(page, context) {
  page.on('pageerror', error => { report.page_errors.push({ context, message: error.message }); save(); });
  page.on('request', request => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      report.mutation_requests.push({ context, method: request.method(), path: new URL(request.url()).pathname }); save();
    }
  });
}
async function navigateMore(page, name, url = base) {
  await page.goto(url);
  await page.getByTestId('two-path-home').waitFor();
  await page.getByRole('button', { name: '更多功能', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
}
async function capture(page, name) {
  const file = `${name}.png`;
  await page.screenshot({ path: resolve(directory, file), fullPage: false, animations: 'disabled' });
  report.screenshots.push(file); save();
}
try {
  save();
  const before = await json(`${base}/api/bootstrap`);
  const batches = await json(`${base}/api/batches`);
  const existing = before.listings.find(item => !item.is_demo && item.trace?.actual_model_call && item.product_snapshot);
  assert.ok(existing, 'Existing real output is required, never substitute synthetic product data.');
  report.existing_real_output = { listing_id: existing.listing_id, version: existing.version, model: existing.trace.model, request_id: existing.trace.provider_request_id ?? null, reuse_notice: 'Read only existing real output; no new inference.' };
  report.main_settings_before_sha256 = hash(before.settings);
  const telemetryBefore = await json(`${base}/api/telemetry?limit=500`);
  const insecureUrl = new URL(insecureBase);
  const resolver = /^[a-z0-9.-]+$/i.test(insecureUrl.hostname) && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(insecureUrl.hostname) && insecureUrl.hostname !== 'localhost'
    ? [`--host-resolver-rules=MAP ${insecureUrl.hostname} 127.0.0.1`, `--proxy-bypass-list=${insecureUrl.hostname}`]
    : [];
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, args: ['--no-proxy-server', ...resolver] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); observe(page, 'main_read_only');

  phase = 'stale_batch_id';
  const staleId = 'missing-batch-from-previous-share-snapshot';
  await page.goto(base);
  await page.evaluate(id => localStorage.setItem('listing-batch-id', id), staleId);
  const failedDetailRequests = [];
  page.on('request', request => { if (new URL(request.url()).pathname === `/api/batches/${staleId}`) failedDetailRequests.push(request.url()); });
  await navigateMore(page, '批量商品');
  const history = page.locator('.batch-history');
  await expect(history).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('listing-batch-id'))).not.toBe(staleId);
  await expect(history.locator('button')).toHaveCount(batches.length);
  for (const batch of batches) await expect(history).toContainText(batch.name);
  await page.waitForTimeout(3300);
  assert.ok(failedDetailRequests.length <= 1, 'Missing batch detail must not be retried forever.');
  report.batch_history = { existing_batches: batches.length, missing_id_requests: failedDetailRequests.length, recovered_selection: await page.evaluate(() => localStorage.getItem('listing-batch-id')) };
  report.checks.push('stale_batch_selection_removed', 'actual_batch_history_remains_accessible', 'missing_batch_id_not_polled_forever');
  await capture(page, 'batch-recovered');

  phase = 'settings_validation_without_mutation';
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '模型与运行设置' });
  const timeout = modal.getByLabel('超时（秒）', { exact: true });
  const saveButton = modal.getByRole('button', { name: '保存配置', exact: true });
  await timeout.fill('');
  await expect(modal).toContainText('留空使用 60 秒');
  await expect(saveButton).toBeEnabled();
  await timeout.blur();
  await expect(timeout).toHaveValue('60');
  for (const invalid of ['0', '181']) {
    await timeout.fill(invalid);
    await expect(saveButton).toBeDisabled();
    await expect(modal.getByRole('alert')).toContainText('5–180 秒');
  }
  await timeout.fill('120');
  await expect(saveButton).toBeEnabled();
  await modal.getByRole('button', { name: '清除全部模型密钥', exact: true }).click();
  await expect(modal).toContainText('保存配置后将清除');
  await modal.getByRole('button', { name: '撤销清除密钥', exact: true }).click();
  await expect(modal.getByRole('button', { name: '清除全部模型密钥', exact: true })).toBeVisible();
  await capture(page, 'settings-timeout-and-clear');
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(hash((await json(`${base}/api/bootstrap`)).settings), report.main_settings_before_sha256);
  report.checks.push('empty_timeout_defaults_to_60_seconds', 'timeout_bounds_have_chinese_inline_validation', 'clear_secrets_can_be_pending_and_cancelled', 'main_real_model_configuration_unchanged');

  phase = 'insecure_context_source';
  const sourceUrl = 'https://www.ftc.gov/business-guidance/resources/environmental-claims-summary-green-guides';
  const sourceStarted = Date.now();
  const sourceResponse = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
  assert.equal(sourceResponse.status, 200, 'Fresh official FTC page required for the manual source record.');
  const html = await sourceResponse.text();
  const $ = load(html); $('script,style,nav,footer,header').remove();
  const title = $('h1').text().replace(/\s+/g, ' ').trim();
  assert.match(title, /Green Guides/i);
  const excerpt = $('main p').map((_, node) => $(node).text().replace(/\s+/g, ' ').trim()).get().find(text => /recycled content/i.test(text));
  assert.ok(excerpt && excerpt.length > 30);
  report.official_source = { url: sourceUrl, http_status: sourceResponse.status, checked_at: new Date().toISOString(), elapsed_ms: Date.now() - sourceStarted, title, excerpt, policy_change: 'unknown', published_at: null, effective_at: null };
  const insecureContext = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce' });
  const insecurePage = await insecureContext.newPage(); observe(insecurePage, 'insecure_http');
  phase = 'insecure_context_uuid';
  await navigateMore(insecurePage, 'Amazon 规则监测', insecureBase);
  const security = await insecurePage.evaluate(() => ({ isSecureContext, randomUUID: typeof crypto.randomUUID, getRandomValues: typeof crypto.getRandomValues }));
  assert.equal(security.isSecureContext, false);
  assert.equal(security.randomUUID, 'undefined');
  report.insecure_context = security;
  await insecurePage.getByRole('button', { name: '登记规则变化', exact: true }).click();
  const form = insecurePage.locator('.rm-form');
  await form.getByLabel('规则标题', { exact: true }).fill('FTC 官方指南来源核对（政策变化待核实）');
  await form.getByLabel('状态', { exact: true }).selectOption('待核实');
  await form.getByLabel('变化内容', { exact: true }).fill(`仅核对官方原文，不宣称存在新政策变化。原文：${excerpt}`);
  await form.getByLabel('官方来源链接', { exact: true }).fill(sourceUrl);
  await form.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(insecurePage.locator('.rm-entry')).toHaveCount(1);
  const savedEntries = await insecurePage.evaluate(() => JSON.parse(localStorage.getItem('listing-guardian-rule-monitor-v1')));
  assert.equal(savedEntries.length, 1);
  assert.ok(savedEntries[0].id);
  assert.equal(savedEntries[0].publishedAt, ''); assert.equal(savedEntries[0].effectiveAt, '');
  report.insecure_context.saved_record_id = savedEntries[0].id;
  report.checks.push('actual_insecure_http_has_no_native_randomUUID', 'manual_source_record_saves_with_uuid_fallback', 'unknown_policy_dates_remain_blank');
  await capture(insecurePage, 'insecure-http-rule-record');
  await insecureContext.close();

  phase = 'isolated_config_server';
  const isolatedDb = resolve(directory, 'config-only.sqlite');
  const configStore = createStore(isolatedDb);
  configStore.saveSettings({ provider: 'compatible', base_url: 'http://127.0.0.1:11434/v1', model: before.settings.model, api_key: 'config-check-only', dify_base_url: 'https://api.dify.ai/v1', dify_create_api_key: 'config-check-only', dify_diagnose_api_key: 'config-check-only', timeout_ms: 120000 });
  configStore.close();
  const configEnv = { ...process.env, HOST: '127.0.0.1', PORT: String(configPort), DATABASE_PATH: isolatedDb, MODEL_API_KEY: '', DEEPSEEK_API_KEY: '', DIFY_CREATE_API_KEY: '', DIFY_DIAGNOSE_API_KEY: '' };
  configServer = spawn(process.execPath, ['server/index.mjs'], { cwd: resolve('.'), env: configEnv, stdio: 'ignore', windowsHide: true });
  let started = false;
  for (let i = 0; i < 80; i++) {
    if (configServer.exitCode !== null) throw new Error(`Config-only server exited ${configServer.exitCode}`);
    try { const result = await fetch(`${configBase}/api/health`, { signal: AbortSignal.timeout(500) }); if (result.ok) { started = true; break; } } catch {}
    await delay(250);
  }
  assert.ok(started, 'Config-only server not ready.');
  const configPage = await context.newPage(); observe(configPage, 'isolated_config');
  await configPage.goto(configBase);
  await configPage.getByRole('button', { name: '模型设置', exact: true }).click();
  const configModal = configPage.getByRole('dialog', { name: '模型与运行设置' });
  await configModal.getByLabel('超时（秒）', { exact: true }).fill('');
  await configModal.getByRole('button', { name: '清除全部模型密钥', exact: true }).click();
  const savedConfigResponse = configPage.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'POST');
  await configModal.getByRole('button', { name: '保存配置', exact: true }).click();
  const clearResponse = await savedConfigResponse;
  assert.equal(clearResponse.status(), 200);
  const clearPayload = clearResponse.request().postDataJSON();
  assert.equal(clearPayload.clear_secrets, true);
  assert.equal(clearPayload.timeout_ms, 60000);
  const cleared = await clearResponse.json();
  for (const field of ['has_api_key', 'has_dify_create_api_key', 'has_dify_diagnose_api_key']) assert.equal(cleared[field], false);
  assert.equal(cleared.base_url, 'http://127.0.0.1:11434/v1');
  assert.equal(cleared.model, before.settings.model);
  report.checks.push('clear_secrets_button_posts_true_to_real_server', 'all_model_keys_cleared_in_credential_free_isolated_database', 'empty_timeout_saves_60000_not_zero');
  await expect(configModal).toHaveCount(0);
  const dify = await json(`${configBase}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'dify', base_url: '', model: ' ', dify_base_url: 'https://api.dify.ai/v1', timeout_ms: 60000, clear_secrets: true }) });
  assert.equal(dify.base_url, cleared.base_url); assert.equal(dify.model, cleared.model);
  await configPage.reload();
  await configPage.getByRole('button', { name: '模型设置', exact: true }).click();
  await configPage.getByRole('button', { name: /DeepSeek \/ 兼容接口/ }).click();
  await expect(configPage.getByLabel('服务地址（含 API 前缀）', { exact: true })).toHaveValue(cleared.base_url);
  await expect(configPage.getByLabel('模型名称', { exact: true })).toHaveValue(cleared.model);
  await capture(configPage, 'dify-compatible-fields-preserved');
  report.checks.push('dify_blank_fields_preserve_compatible_settings', 'switching_back_shows_preserved_endpoint_and_model');

  phase = 'final_integrity';
  const after = await json(`${base}/api/bootstrap`);
  assert.equal(hash(after.settings), report.main_settings_before_sha256);
  const telemetryAfter = await json(`${base}/api/telemetry?limit=500`);
  report.main_telemetry_unchanged = hash(telemetryBefore) === hash(telemetryAfter);
  assert.ok(report.mutation_requests.every(item => item.context === 'isolated_config'), 'Main workbench must receive no mutation requests.');
  assert.deepEqual(report.page_errors, []);
  report.completed_at = new Date().toISOString(); report.acceptance = 'passed_no_model_inference'; save();
  console.log(JSON.stringify({ report: resolve(directory, 'acceptance.json'), checks: report.checks.length, page_errors: report.page_errors.length }));
} catch (error) {
  report.failures.push({ phase, message: error.message, at: new Date().toISOString() }); save();
  throw error;
} finally {
  if (browser) await browser.close();
  if (configServer && configServer.exitCode === null) configServer.kill();
}
