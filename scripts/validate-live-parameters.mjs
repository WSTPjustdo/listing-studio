// Current real app, real official source, two paid unchanged-content rechecks.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { load } from 'cheerio';
if (!process.argv.includes('--real-api')) throw new Error('Use --real-api to authorize paid inference.');
const base = 'http://127.0.0.1:8787', directory = resolve('reports/parameter-links-2026-10-23'); mkdirSync(directory, { recursive: true });
const report = { started_at: new Date().toISOString(), public_product_only: true, merchant_owned_sku_tested: false, calls: [], versions: [], checks: [] };
const save = () => writeFileSync(resolve(directory, 'live-acceptance.json'), JSON.stringify(report, null, 2));
function trace(value) { if (!value) return; if (value.calls) { value.calls.forEach(trace); return; } trace(value.format_retry?.failed_attempt?.trace); if (value.provider_request_id && !report.calls.some(call => call.request_id === value.provider_request_id)) report.calls.push({ request_id: value.provider_request_id, model: value.model, elapsed_ms: value.elapsed_ms, usage: value.usage, format_retry: value.format_retry || null }); }
let browser;
try {
  const data = await (await fetch(`${base}/api/bootstrap`)).json();
  const current = data.listings.find(item => item.product_snapshot?.reference_product_id === 'W101' && item.trace.actual_model_call && !item.is_demo); assert.ok(current);
  const product = data.products.find(item => item.product_id === current.product_snapshot.product_id);
  const sourceUrl = 'https://westfordmill.com/products/w101';
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) }); assert.equal(response.status, 200); const $ = load(await response.text());
  const specs = $('table').text().replace(/\s+/g, ' '), pageText = $('body').text().replace(/\s+/g, ' ');
  assert.ok(pageText.includes('100% Cotton') && pageText.includes('140gsm') && specs.includes('38 x 42') && /Capacity\s*\(\s*litres\s*\)\s*10/i.test(specs));
  report.source = { url: response.url, checked_at: new Date().toISOString(), verified_fields: ['material', 'fabric_weight_gsm', 'dimensions_cm', 'capacity_l'], retail_pack_still_unknown: product.retail_pack_count.value === null }; save();
  let previous = current;
  const initial = JSON.stringify(current), references = data.sources.map(source => source.source_id);
  for (let pass = 0; pass < 2; pass++) {
    console.log(JSON.stringify({ stage: `real_recheck_${pass + 1}`, product_ref: `${product.product_id}@${product.revision}` }));
    const queuedResponse = await fetch(`${base}/api/listings/${previous.listing_id}/revisions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'recheck_product', base_version: previous.version, product_revision: product.revision }) }); assert.equal(queuedResponse.status, 202);
    const queued = await queuedResponse.json();
    let run;
    for (let i = 0; i < 260; i++) { run = await (await fetch(`${base}/api/runs/${queued.run_id}`)).json(); if (run.status === 'failed' || run.status === 'succeeded') break; await new Promise(resolve => setTimeout(resolve, 1000)); }
    trace(run.trace); trace(run.format_retry?.failed_attempt?.trace);
    if (run.status !== 'succeeded') { report.failed_run = run; save(); throw new Error(run.error?.message || 'Real recheck deadline exceeded'); }
    const versions = await (await fetch(`${base}/api/listings/${current.listing_id}/versions`)).json(), record = versions.at(-1);
    report.versions.push(record); save();
    assert.deepEqual(record.content, current.content); assert.equal(JSON.stringify(versions.find(item => item.version === current.version)), initial);
    const identity = record.review.evidence.find(entry => entry.claim === 'Westford Mill W101 cotton tote bag.'); assert.ok(identity);
    assert.equal(identity.state, 'parameters_aligned'); assert.equal(identity.association_method, 'structured-parameters-v1');
    assert.ok(identity.parameter_links.some(link => link.field === 'material')); assert.ok(identity.parameter_links.some(link => link.field === 'brand'));
    for (const entry of record.review.evidence) for (const link of entry.parameter_links) { assert.ok(link.source_ids.length && link.source_ids.every(id => references.includes(id))); assert.equal(link.product_ref, `${product.product_id}@${product.revision}`); assert.equal(entry.claim.slice(link.start, link.end), link.original); }
    assert.ok(!record.review.issues.some(issue => issue.original === identity.claim && ['SYS-01', 'EVID-01'].includes(issue.rule_id)));
    assert.ok(record.review.missing_data.some(item => item.field === 'retail_pack_count'));
    if (pass) assert.deepEqual(record.review.evidence.map(entry => entry.parameter_links), previous.review.evidence.map(entry => entry.parameter_links));
    previous = record;
  }
  const summary = report.versions.map(record => ({ version: record.version, trace: record.trace, issues: record.review.issues, missing_data: record.review.missing_data, evidence: record.review.evidence, consistency: record.review.consistency_check }));
  report.versions = summary;
  for (const format of ['json', 'txt', 'html']) {
    const response = await fetch(`${base}/api/listings/${previous.listing_id}/export?version=${previous.version}&format=${format}`); assert.equal(response.status, 200); const text = await response.text(); assert.ok(text.includes('structured-parameters-v1') && text.includes('material') && text.includes('LIVE-WESTFORD-W101')); writeFileSync(resolve(directory, `actual-export.${format}`), text);
  }
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.locator(`[data-listing-id="${previous.listing_id}"]`).click();
  await page.locator('details[aria-label="卖点证据对照"] > summary').click();
  await page.getByText('已确认参数由程序关联来源，不依赖模型补写引用。', { exact: false }).waitFor();
  const evidenceCard = page.locator('article.source-card').filter({ has: page.getByText('Westford Mill W101 cotton tote bag.', { exact: true }) });
  await evidenceCard.scrollIntoViewIfNeeded(); assert.ok((await evidenceCard.innerText()).includes('参数已对照')); assert.ok(await evidenceCard.getByRole('button', { name: '查看参数来源', exact: true }).count() >= 2);
  await page.screenshot({ path: resolve(directory, 'parameter-links-desktop.png'), animations: 'disabled' });
  await evidenceCard.getByRole('button', { name: '查看参数来源', exact: true }).last().click(); await page.getByRole('dialog').waitFor(); await page.screenshot({ path: resolve(directory, 'parameter-source.png'), animations: 'disabled' }); await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390); await evidenceCard.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(directory, 'parameter-links-mobile.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  report.checks = ['live_official_source', 'two_real_model_rechecks', 'atomic_links_identical_across_rechecks', 'identity_omission_no_longer_product_error', 'actual_recorded_source_ids', 'immutable_old_snapshot', 'unknown_retail_count_preserved', 'json_txt_html_atomic_links', 'browser_source_navigation', '390px_no_overflow'];
  report.completed_at = new Date().toISOString(); report.final_version = previous.version; report.unresolved = { issues: previous.review.issues, missing_data: previous.review.missing_data, unchecked: previous.review.checks.filter(check => ['not_checked', 'error'].includes(check.state)) }; save();
  console.log(JSON.stringify({ directory, version: previous.version, calls: report.calls.length, unresolved: report.unresolved }));
} catch (error) { report.failure = { name: error.name, message: error.message }; save(); throw error; } finally { await browser?.close(); }
