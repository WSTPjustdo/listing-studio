// Rechecks the existing real DALIX listing. No inferred axis names, colors,
// retail counts, mocked responses, or replacement product are introduced.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { load } from 'cheerio';

if (!process.argv.includes('--real-api')) throw new Error('Use --real-api for one paid independent DeepSeek recheck.');
const baseFlag = process.argv.indexOf('--base-url');
const base = baseFlag >= 0 ? process.argv[baseFlag + 1] : 'http://127.0.0.1:8787';
const directory = resolve('reports/dalix-source-fix-2026-10-31');
const runtime = resolve('.runtime', `dalix-source-fix-${Date.now()}`);
mkdirSync(directory, { recursive: true });
mkdirSync(runtime, { recursive: true });
const report = { started_at: new Date().toISOString(), source_observations: [], checks: [], user_confirmed_unknown: ['color', 'retail_pack_count'] };
const save = () => writeFileSync(resolve(directory, 'acceptance.json'), JSON.stringify(report, null, 2));
let queued;
async function get(path) {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
}
try {
  const bootstrap = await get('/api/bootstrap');
  const before = bootstrap.listings.find(record => record.listing_id === 'listing-06ebe642-4bf9-4dc7-8316-b6da881a12a0');
  assert.ok(before?.trace.actual_model_call && !before.is_demo);
  const product = bootstrap.products.find(item => item.product_id === 'AMAZON-US-B0732NPDRB');
  assert.ok(product && !product.is_demo && product.product_id === before.product_snapshot.product_id);
  assert.equal(product.color.value, null);
  assert.equal(product.retail_pack_count.value, null);
  const raw = product.additional_facts.find(item => item.label === 'Original dimensions');
  assert.equal(raw?.value, '22" X 16" X 6"');
  assert.ok(raw.source_ids.length && raw.source?.url && raw.source.excerpt.includes(raw.value));
  assert.equal(product.dimensions_cm.value, null, 'this run preserves raw dimensions rather than guessing named axes');
  report.listing_id = before.listing_id;
  report.before_version = before.version;
  report.product_id = product.product_id;
  report.product_revision = product.revision;
  report.existing_dimension_source = { value: raw.value, source_id: raw.source.source_id, url: raw.source.url,
    publisher: raw.source.publisher, excerpt: raw.source.excerpt, recorded_at: raw.source.recorded_at,
    status: raw.status, applicable_model: raw.source.applicable_model, independent_verification: false };
  writeFileSync(resolve(runtime, 'before.json'), JSON.stringify(before, null, 2));
  for (const url of [raw.source.url, product.amazon.url]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const html = await response.text();
      const $ = load(html);
      $('script,style,noscript').remove();
      const text = $.text().replace(/\s+/g, ' ').trim();
      const productTitle = $('#productTitle').text().trim();
      const verification = /continue shopping|captcha|robot check|verify you are|access denied|local_rate_limited/i.test(text);
      const available = response.ok && !verification && (url.includes('amazon.com') ? Boolean(productTitle) : text.includes(raw.value));
      report.source_observations.push({ url, checked_at: new Date().toISOString(), http_status: response.status,
        usable_new_product_facts: available,
        reason: !response.ok ? `HTTP ${response.status}` : verification ? 'verification_or_access_limit_page' : available ? 'source_text_available_no_automatic_variant_inference' : 'recorded_excerpt_not_located',
        notice: 'No new color or retail quantity is inferred from a default selection or singular product title.' });
      writeFileSync(resolve(runtime, `source-${report.source_observations.length}.txt`), text);
    } catch (error) {
      report.source_observations.push({ url, checked_at: new Date().toISOString(), http_status: null, usable_new_product_facts: false, reason: error.message });
    }
  }
  save();
  const response = await fetch(`${base}/api/listings/${before.listing_id}/revisions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'recheck_product', base_version: before.version, product_revision: product.revision,
      request_id: `dalix-source-fix-${Date.now()}` }),
  });
  assert.equal(response.status, 202);
  queued = await response.json();
  report.run_id = queued.run_id;
  save();
  let run;
  for (let attempt = 0; attempt < 300; attempt++) {
    run = await get(`/api/runs/${queued.run_id}`);
    if (run.status === 'failed' || run.status === 'succeeded') break;
    await delay(1000);
  }
  report.run_status = run.status;
  report.trace = run.trace || null;
  report.failure = run.error || null;
  save();
  assert.equal(run.status, 'succeeded', run.error?.message || 'live recheck did not finish');
  const versions = await get(`/api/listings/${before.listing_id}/versions`);
  const record = versions.find(item => item.version === run.version);
  assert.deepEqual(versions.find(item => item.version === before.version), before, 'historical snapshot stays immutable');
  assert.deepEqual(record.content, before.content, 'recheck must preserve the real copy');
  assert.deepEqual(record.product_snapshot, product, 'no unknown field or axis is filled');
  assert.ok(record.trace.actual_model_call && record.trace.provider_request_id && record.trace.model);
  const links = record.review.evidence.flatMap(item => item.parameter_links);
  const rawLinks = links.filter(item => item.method === 'recorded_original_dimension_tuple');
  assert.ok(rawLinks.length >= 1, 'source-backed raw tuples must be explicitly associated');
  assert.ok(rawLinks.every(item => item.field.startsWith('additional_facts.') && item.source_ids.includes(raw.source.source_id)));
  assert.ok(!record.review.evidence.flatMap(item => item.unresolved_parameters).some(item => item.method === 'dimension_triple_missing_confirmed_depth'));
  for (const field of ['color', 'retail_pack_count']) assert.ok(record.review.missing_data.some(item => item.field === field));
  assert.ok(!record.review.evidence.flatMap(item => item.parameter_links).some(item => item.field === 'dimensions_cm'));
  report.checks.push('real_existing_source_tuple_associated_without_axis_inference', 'verbatim_copy_preserved', 'original_product_and_historical_listing_unchanged', 'unknown_color_and_retail_count_preserved', 'one_independent_real_model_recheck');
  report.after_version = record.version;
  report.trace = record.trace;
  report.issues_before = before.review.issues;
  report.issues_after = record.review.issues;
  report.missing_data = record.review.missing_data;
  report.dimension_links = rawLinks;
  report.completed_at = new Date().toISOString();
  writeFileSync(resolve(runtime, 'after.json'), JSON.stringify(record, null, 2));
  save();
  console.log(JSON.stringify({ directory, listing_id: record.listing_id, version: record.version,
    model: record.trace.model, request_id: record.trace.provider_request_id, elapsed_ms: record.trace.elapsed_ms,
    usage: record.trace.usage, issues: record.review.issues.length, missing_fields: record.review.missing_data.map(item => item.field), checks: report.checks }));
} catch (error) {
  report.failure = { message: error.message, ...(queued ? { run: await get(`/api/runs/${queued.run_id}`).catch(() => null) } : {}) };
  save();
  throw error;
}
