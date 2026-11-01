// Recheck the previously persisted real W101 copy after the explicit-axis parser fix.
import assert from 'node:assert/strict';
import { PARAMETER_LINK_VERSION } from '../server/evidence.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
if (!process.argv.includes('--real-api')) throw new Error('Use --real-api to authorize paid recheck.');
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const base = option('--base-url', 'http://127.0.0.1:8787');
const directory = resolve(option('--report-dir', '.runtime/live-integration'));
const saved = JSON.parse(readFileSync(resolve(directory, 'real-associated-record.json'), 'utf8'));
const report = { started_at: new Date().toISOString(), purpose: '复核真实W101英文明确宽高误报的修复', previous_version: saved.version,
  old_finding_preserved: true, request_ledger: [], checks: [] };
const save = () => writeFileSync(resolve(directory, 'followup-acceptance.json'), JSON.stringify(report, null, 2));
const get = async path => { const r = await fetch(base + path); assert.ok(r.ok); return r.json(); };
let browser;
try {
  const versions = await get(`/api/listings/${saved.listing_id}/versions`);
  const previous = versions.at(-1);
  assert.deepEqual(versions.find(x => x.version === saved.version), saved);
  const products = await get('/api/products');
  const product = products.find(x => x.product_id === previous.product_snapshot.product_id);
  const response = await fetch(`${base}/api/listings/${saved.listing_id}/revisions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      kind: 'recheck_product', base_version: previous.version, product_id: product.product_id, product_revision: product.revision,
    }),
  });
  assert.equal(response.status, 202);
  const queued = await response.json(); report.run_id = queued.run_id; save();
  let record;
  for (let n = 0; n < 400; n++) {
    const run = await get(`/api/runs/${queued.run_id}`);
    if (run.status === 'failed') { report.failed_run = run; throw new Error(run.error?.message); }
    if (run.status === 'succeeded') { record = (await get(`/api/listings/${saved.listing_id}/versions`)).at(-1); break; }
    await new Promise(done => setTimeout(done, 750));
  }
  assert.ok(record?.trace.actual_model_call && record.trace.provider_request_id);
  assert.deepEqual(record.content, previous.content);
  assert.equal(record.trace.parameter_link_version, PARAMETER_LINK_VERSION);
  if (previous.trace.parameter_link_version !== PARAMETER_LINK_VERSION) assert.equal(record.review.consistency_check.state, 'baseline');
  const exactPhrase = 'Measures approximately 38 cm wide x 42 cm high and holds about 10 litres.';
  assert.ok(record.content.bullet_points.some(x => x.text.includes(exactPhrase)));
  assert.ok(!record.review.issues.some(x => x.method === 'deterministic' && x.original === exactPhrase));
  assert.ok(record.review.evidence.some(x => x.parameter_links?.some(p => p.field === 'dimensions_cm' && /wide/i.test(p.original))));
  assert.deepEqual((await get(`/api/listings/${saved.listing_id}/versions`)).find(x => x.version === saved.version), saved);
  report.checks.push('同一真实正文保留，宽高明确的整串尺寸准确关联', '旧版误报及原文保留，复检另存新版本');
  report.latest_version = record.version; report.trace = record.trace;
  report.remaining_issues = record.review.issues; report.missing_data = record.review.missing_data;
  writeFileSync(resolve(directory, 'real-followup-record.json'), JSON.stringify(record, null, 2));
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.locator(`[data-listing-id="${record.listing_id}"]`).click();
  await page.screenshot({ path: resolve(directory, 'followup-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve(directory, 'followup-mobile.png'), fullPage: true });
  for (const format of ['html', 'worklist']) {
    const url = `${base}/api/listings/${record.listing_id}/export?version=${record.version}&format=${format}&disposition=inline`;
    const exported = await fetch(url); assert.ok(exported.ok);
    const body = await exported.text(); writeFileSync(resolve(directory, `followup-${format}.html`), body);
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.setContent(body);
    await page.pdf({ path: resolve(directory, `followup-${format}.pdf`), format: 'A4', printBackground: true, preferCSSPageSize: true });
  }
  assert.deepEqual(errors, []); report.checks.push('真实新版本桌面、手机及报告工作单打印无页面脚本异常');
  report.status = 'real_followup_completed_quality_requires_review'; report.completed_at = new Date().toISOString();
  report.request_ledger = (await get('/api/telemetry?limit=500')).calls; save();
  console.log(JSON.stringify({ status: report.status, request_id: record.trace.provider_request_id, version: record.version,
    issues: record.review.issues.length, report: resolve(directory, 'followup-acceptance.json') }));
} catch (error) {
  report.status = 'failed'; report.failure = { at: new Date().toISOString(), message: error.message };
  try { report.request_ledger = (await get('/api/telemetry?limit=500')).calls; } catch {}
  save(); throw error;
} finally { await browser?.close(); }
