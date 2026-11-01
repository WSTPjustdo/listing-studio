// Real W101 + local DeepSeek acceptance. Only two GET transports are aborted;
// product facts, model responses and recovered server results are never replaced.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { load } from 'cheerio';

if (!process.argv.includes('--real-api')) throw new Error('Use --real-api to authorize paid inference.');
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const base = arg('--base-url', 'http://127.0.0.1:3233').replace(/\/+$/, '');
const directory = resolve(arg('--output-dir', `.runtime/live-polling-recovery-${Date.now()}`));
mkdirSync(directory, { recursive: true });
const report = {
  started_at: new Date().toISOString(), base_url: base,
  notice: 'Fresh official W101 source and existing real product; one paid plan and generation with independent audit. Two browser GETs are deliberately aborted to verify recovery. No synthetic product or substituted model response.',
  checks: [], transport_faults: [], submissions: [], page_errors: [], failures: [],
};
const save = () => writeFileSync(resolve(directory, 'acceptance.json'), JSON.stringify(report, null, 2));
const json = async route => {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, `${route}: HTTP ${response.status}`);
  return response.json();
};
let browser, phase = 'official_source', queued;
try {
  save();
  const sourceUrl = 'https://westfordmill.com/products/w101';
  const sourceStarted = Date.now();
  const sourceResponse = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
  assert.equal(sourceResponse.status, 200);
  const $ = load(await sourceResponse.text());
  $('script,style,nav,footer').remove();
  const sourceText = $('body').text().replace(/\s+/g, ' ').trim();
  for (const fact of ['100% Cotton', '140gsm', '38 x 42', '4.1oz/yd²', 'CutAway label for ease of rebranding'])
    assert.ok(sourceText.includes(fact), `Official source changed: ${fact}`);
  report.official_source = { url: sourceUrl, http_status: sourceResponse.status, checked_at: new Date().toISOString(), elapsed_ms: Date.now() - sourceStarted, title: $('h1').text().trim() };
  const data = await json('/api/bootstrap');
  assert.equal(data.settings.provider, 'compatible');
  assert.ok(data.settings.has_api_key && /deepseek/i.test(data.settings.model));
  const product = data.products.find(item => item.product_id === 'REAL-WESTFORD-W101' && !item.is_demo);
  assert.ok(product, 'Existing actual W101 product is required.');
  assert.match(product.material.value, /100%\s*cotton/i);
  assert.equal(product.fabric_weight_gsm.value, 140);
  assert.deepEqual(product.dimensions_cm.value, { width: 38, height: 42 });
  assert.equal(product.color.value, null);
  assert.equal(product.retail_pack_count.value, null);
  report.product = { product_id: product.product_id, revision: product.revision };

  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { report.page_errors.push(error.message); save(); });
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/guided\/(?:plan|generate)$/.test(new URL(request.url()).pathname)) {
      report.submissions.push({ path: new URL(request.url()).pathname, at: new Date().toISOString() }); save();
    }
  });
  let statusAborted = false, versionAborted = false;
  await page.route('**/api/runs/*', async route => {
    if (queued && new URL(route.request().url()).pathname.endsWith(`/${queued.run_id}`) && !statusAborted) {
      statusAborted = true;
      report.transport_faults.push({ operation: 'status_get', run_id: queued.run_id, at: new Date().toISOString() }); save();
      return route.abort('internetdisconnected');
    }
    return route.continue();
  });
  await page.route('**/api/listings/*/versions', async route => {
    if (queued && new URL(route.request().url()).pathname === `/api/listings/${queued.listing_id}/versions` && !versionAborted) {
      versionAborted = true;
      report.transport_faults.push({ operation: 'saved_versions_get', listing_id: queued.listing_id, at: new Date().toISOString() }); save();
      return route.abort('internetdisconnected');
    }
    return route.continue();
  });
  phase = 'guided_inputs';
  await page.goto(base);
  await page.getByTestId('choose-improve').click();
  await page.getByLabel('现有提示词', { exact: true }).fill('Write concise natural English listing copy using only confirmed product facts. Keep unknown color, retail pack size and certifications unknown. Do not exaggerate or invent claims.');
  await page.getByText('使用已有商品档案', { exact: true }).click();
  await page.getByLabel('使用已有商品档案', { exact: true }).selectOption(product.product_id);
  await page.getByTestId('guided-next').click();
  await expect(page.getByLabel('确认商品名称', { exact: true })).toHaveValue(product.name_zh);
  await page.getByLabel('确认当前商品信息与检查范围', { exact: true }).check();
  phase = 'real_plan_and_generation';
  const planResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/guided/plan' && response.request().method() === 'POST', { timeout: 240000 });
  const generationResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/guided/generate' && response.request().method() === 'POST', { timeout: 240000 });
  // Observe failures as soon as they arrive; never replace a failed plan/run.
  generationResponse.catch(() => {});
  await page.getByTestId('guided-generate').click();
  const actualPlanResponse = await planResponse;
  const plan = await actualPlanResponse.json();
  report.plan = plan; save();
  assert.equal(actualPlanResponse.status(), 201, JSON.stringify(plan));
  assert.ok(plan.trace.actual_model_call && plan.trace.provider_request_id);
  const actualGenerationResponse = await generationResponse;
  queued = await actualGenerationResponse.json();
  report.run = queued; save();
  assert.equal(actualGenerationResponse.status(), 202, JSON.stringify(queued));

  phase = 'status_transport_recovery';
  await expect(page.getByText(/暂时无法读取运行状态/)).toBeVisible();
  await expect(page.getByTestId('guided-generate')).toBeDisabled();
  report.checks.push('status_disconnect_keeps_generation_locked_and_shows_retry_notice'); save();
  phase = 'saved_version_recovery';
  const resume = page.getByRole('button', { name: '继续查看运行结果', exact: true });
  await expect(resume).toBeEnabled({ timeout: 240000 });
  assert.ok(statusAborted && versionAborted, 'Both intended read failures must occur.');
  const completed = await json(`/api/runs/${queued.run_id}`);
  report.completed_run = completed; save();
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
  await expect(page.getByTestId('guided-generate')).toBeDisabled();
  assert.equal(report.submissions.filter(item => item.path === '/api/guided/generate').length, 1);
  await page.screenshot({ path: resolve(directory, 'saved-version-recovery.png'), fullPage: true });
  report.checks.push('failed_saved_version_read_retains_pending_run_and_prevents_resubmission');
  await resume.click();
  await page.getByTestId('guided-step-result').waitFor();
  const versions = await json(`/api/listings/${queued.listing_id}/versions`);
  const record = versions.find(item => item.version === completed.version);
  assert.ok(record?.trace.actual_model_call && record.trace.provider_request_id);
  assert.ok(record.trace.calls.length >= 2, 'Generation needs a separate real audit.');
  assert.deepEqual(record.product_snapshot, product);
  assert.equal(record.product_snapshot.color.value, null);
  assert.equal(record.product_snapshot.retail_pack_count.value, null);
  assert.equal(report.submissions.filter(item => item.path === '/api/guided/plan').length, 1);
  assert.equal(report.submissions.filter(item => item.path === '/api/guided/generate').length, 1);
  await expect(page.getByText(/暂时无法读取运行状态/)).toHaveCount(0);
  await page.screenshot({ path: resolve(directory, 'guided-recovered-real-result.png'), fullPage: true });
  report.record = record;
  report.checks.push('resume_reads_same_real_version_without_new_plan_or_generation', 'independent_real_audit_preserved', 'unknown_color_and_retail_pack_remain_unknown');
  assert.deepEqual(report.page_errors, []);
  report.completed_at = new Date().toISOString();
  report.acceptance = 'real_guided_generation_and_transport_recovery_completed_quality_requires_review'; save();
  console.log(JSON.stringify({ report: resolve(directory, 'acceptance.json'), run_id: queued.run_id, version: record.version, checks: report.checks.length, model: record.trace.model, request_id: record.trace.provider_request_id, elapsed_ms: record.trace.elapsed_ms, usage: record.trace.usage }));
} catch (error) {
  report.failures.push({ phase, at: new Date().toISOString(), message: error.message });
  if (queued?.run_id) report.last_run = await json(`/api/runs/${queued.run_id}`).catch(() => null);
  save();
  throw error;
} finally {
  if (browser) await browser.close();
}
