// Fresh official source + existing real model copy + paid unlinked/association review.
// No mock provider, fabricated product, seller SKU, or platform processing report.
import assert from 'node:assert/strict';
import { PARAMETER_LINK_VERSION } from '../server/evidence.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
if (!process.argv.includes('--real-api')) throw new Error('Use --real-api to authorize paid inference.');
const option = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
const base = option('--base-url', 'http://127.0.0.1:8787');
const directory = resolve(option('--report-dir', '.runtime/live-integration'));
mkdirSync(directory, { recursive: true });
const report = { started_at: new Date().toISOString(), mode: 'live_official_source_and_real_deepseek', checks: [], calls: [],
  pending: ['商家原始库存模板、真实卖家SKU及平台处理报告尚未提供。', '并发提速、服装品类与Seller Central上传未验收。'] };
const save = () => writeFileSync(resolve(directory, 'integration-acceptance.json'), JSON.stringify(report, null, 2));
const get = async path => { const r = await fetch(base + path); const value = await r.json(); if (!r.ok) throw new Error(value.error?.message || `HTTP ${r.status}`); return value; };
const post = async (path, data) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); const value = await r.json(); if (!r.ok) throw new Error(value.error?.message || `HTTP ${r.status}`); return value; };
let currentRun;
async function waitRun(run) {
  currentRun = run.run_id;
  for (let n = 0; n < 400; n++) {
    const state = await get(`/api/runs/${run.run_id}`);
    if (state.status === 'failed') { report.failed_run = state; save(); throw new Error(state.error?.message); }
    if (state.status === 'succeeded') {
      const versions = await get(`/api/listings/${run.listing_id}/versions`);
      const record = versions.find(v => v.version === state.version);
      assert.ok(record.trace.actual_model_call && record.trace.provider_request_id);
      report.calls.push({ run_id: state.run_id, model: record.trace.model, request_id: record.trace.provider_request_id,
        elapsed_ms: record.trace.elapsed_ms, usage: record.trace.usage, issues: record.review.issues.length });
      save(); return record;
    }
    await new Promise(done => setTimeout(done, 750));
  }
  throw new Error('Real model review deadline exceeded');
}
let browser;
try {
  const bootstrap = await get('/api/bootstrap');
  assert.equal(bootstrap.settings.provider, 'compatible');
  assert.equal(new URL(bootstrap.settings.base_url).hostname, 'api.deepseek.com');
  const existing = bootstrap.listings.find(v => v.trace.actual_model_call && !v.is_demo && v.product_snapshot?.reference_product_id === 'W101');
  assert.ok(existing, 'An existing real W101 listing is required');
  const product = bootstrap.products.find(p => p.product_id === existing.product_snapshot.product_id);
  const sourceUrl = 'https://westfordmill.com/products/w101';
  const source = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
  assert.ok(source.ok, `Official source HTTP ${source.status}`);
  const html = await source.text();
  for (const snippet of ['100% Cotton', '140gsm', '38 x 42']) assert.ok(html.includes(snippet), `Official source changed: ${snippet}`);
  report.source = { url: sourceUrl, checked_at: new Date().toISOString(), sha256: createHash('sha256').update(html).digest('hex'),
    known_facts: ['100% Cotton', '140gsm', '38 x 42'], input_listing_id: existing.listing_id, input_version: existing.version };
  const unlinked = await waitRun(await post('/api/listings/diagnose', { content: existing.content, product_id: null, request_id: `integration-unlinked-${Date.now()}` }));
  assert.equal(unlinked.product_ref, null);
  assert.deepEqual(unlinked.content, existing.content);
  assert.ok(unlinked.review.checks.some(c => c.state === 'not_checked'));
  report.checks.push('真实文案不关联商品诊断保留未执行项');
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.locator(`[data-listing-id="${unlinked.listing_id}"]`).click();
  await page.screenshot({ path: resolve(directory, 'unlinked-desktop.png'), fullPage: true });
  const linked = await waitRun(await post(`/api/listings/${unlinked.listing_id}/revisions`, {
    kind: 'recheck_product', base_version: unlinked.version, product_id: product.product_id, product_revision: product.revision,
  }));
  assert.equal(linked.listing_id, unlinked.listing_id);
  assert.equal(linked.version, unlinked.version + 1);
  assert.deepEqual(linked.content, unlinked.content);
  assert.ok(linked.rule_pack_snapshot && linked.source_snapshot && linked.rule_citations);
  assert.equal(linked.trace.parameter_link_version, PARAMETER_LINK_VERSION);
  const versions = await get(`/api/listings/${linked.listing_id}/versions`);
  assert.deepEqual(versions[0], unlinked);
  const trend = await get(`/api/listings/${linked.listing_id}/trend`);
  assert.equal(trend.direction, 'scope_changed');
  report.checks.push('补关联后真实复检正文不变且历史不可变', '规则来源快照与当前算法版本写入记录', '检查范围变化不宣称改稿改善');
  writeFileSync(resolve(directory, 'real-associated-record.json'), JSON.stringify(linked, null, 2));
  await page.reload(); await page.locator(`[data-listing-id="${linked.listing_id}"]`).click();
  await page.screenshot({ path: resolve(directory, 'linked-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(directory, 'linked-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  report.checks.push('桌面与390px真实工作台无页面脚本异常或横向溢出');
  const output = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  for (const format of ['html', 'worklist']) {
    const response = await fetch(`${base}/api/listings/${linked.listing_id}/export?version=${linked.version}&format=${format}&disposition=inline`);
    assert.equal(response.status, 200); assert.ok(response.headers.get('content-disposition').startsWith('inline'));
    const body = await response.text(); assert.ok(body.includes(linked.rule_pack_version));
    assert.ok(body.includes(product.product_id)); assert.ok(body.includes('不表示平台审核'));
    assert.ok(!body.includes('真人 Amazon 文案量过'));
    writeFileSync(resolve(directory, `real-${format}.html`), body);
    await output.setViewportSize({ width: 1440, height: 1000 }); await output.setContent(body);
    assert.equal(await output.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await output.screenshot({ path: resolve(directory, `${format}-desktop.png`), fullPage: true });
    await output.pdf({ path: resolve(directory, `real-${format}.pdf`), format: 'A4', printBackground: true, preferCSSPageSize: true });
    await output.setViewportSize({ width: 390, height: 844 });
    assert.equal(await output.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await output.screenshot({ path: resolve(directory, `${format}-mobile.png`), fullPage: true });
  }
  report.checks.push('真实报告与工作单inline导出、A4打印及390px布局');
  assert.deepEqual(errors, []);
  report.page_errors = errors;
  report.request_ledger = (await get('/api/telemetry?limit=500')).calls;
  report.completed_at = new Date().toISOString();
  report.status = 'real_integration_workflow_completed_quality_requires_review'; save();
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, requests: report.calls.map(c => c.request_id), report: resolve(directory, 'integration-acceptance.json') }));
} catch (error) {
  report.status = 'failed'; report.failure = { at: new Date().toISOString(), message: error.message, run_id: currentRun || null };
  try { report.request_ledger = (await get('/api/telemetry?limit=500')).calls; } catch {}
  save(); throw error;
} finally { await browser?.close(); }
