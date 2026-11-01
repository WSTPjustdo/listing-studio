// Real official product source, real browser, one paid DeepSeek recheck. No mocked responses.
import { chromium } from '@playwright/test';
import { load } from 'cheerio';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
if (!process.argv.includes('--real-api')) throw new Error('Use --real-api to authorize paid recheck.');
const base = 'http://127.0.0.1:8787';
const directory = resolve('.runtime', `evidence-acceptance-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const data = await (await fetch(`${base}/api/bootstrap`)).json();
const current = data.listings.find(item => item.product_snapshot?.reference_product_id === 'W101' && item.review.missing_data.some(field => field.field === 'retail_pack_count'));
assert.ok(current, 'Existing real W101 listing with unknown retail packaging required');
const product = data.products.find(item => item.product_id === current.product_snapshot.product_id);
assert.ok(!product.is_demo && current.trace.actual_model_call);
const url = 'https://westfordmill.com/products/w101';
const source = await fetch(url, { signal: AbortSignal.timeout(30000) });
assert.equal(source.status, 200);
const $ = load(await source.text());
const excerpt = $('table').text().replace(/\s+/g, ' ').trim();
assert.ok(excerpt.includes('Carton Quantity') && excerpt.includes('Pack Qty'));
writeFileSync(resolve(directory, 'official-excerpt.txt'), excerpt);
const input = { base_revision: product.revision, listing_id: current.listing_id, listing_version: current.version, target: 'retail_pack_count',
  title: 'W101 官方装箱资料（不确认零售件数）', applicable_model: 'Westford Mill W101', publisher: 'Westford Mill 官方产品页', url, excerpt };
const existing = product.evidence_submissions?.find(item => item.target === input.target && item.excerpt === excerpt && item.url === url);
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(base);
  await page.locator(`[data-listing-id="${current.listing_id}"]`).click();
  await page.getByRole('region', { name: '下一步处理' }).getByRole('button', { name: '核对 / 补充商品资料', exact: true }).click();
  const form = page.getByRole('region', { name: '按问题补充原文材料' });
  await form.getByLabel('对应问题 / 待补资料').selectOption('retail_pack_count');
  await form.getByLabel('材料名称', { exact: true }).fill(input.title);
  await form.getByLabel('适用商品型号 / SKU', { exact: true }).fill(input.applicable_model);
  await form.getByLabel('来源 / 出具方', { exact: true }).fill(input.publisher);
  await form.getByLabel('来源链接（没有可留空）', { exact: true }).fill(url);
  await form.getByLabel('来源原文（至少 10 字符）', { exact: true }).fill(excerpt);
  assert.equal(await page.getByRole('button', { name: '采用当前资料并复检（保存新版本）', exact: true }).isDisabled(), true);
  const savedResponse = page.waitForResponse(response => response.url().endsWith(`/api/products/${product.product_id}/evidence`) && response.request().method() === 'POST');
  await form.getByRole('button', { name: '保存材料到商品新版本' }).click();
  const saved = await savedResponse; assert.equal(saved.status(), existing ? 409 : 201);
  const nextProduct = existing ? product : await saved.json();
  if (existing) await form.getByRole('button', { name: '清空未提交材料', exact: true }).click();
  assert.equal(nextProduct.revision, product.revision + (existing ? 0 : 1));
  assert.equal(nextProduct.retail_pack_count.value, null);
  const submitted = existing ? nextProduct.evidence_submissions.find(item => item.source_id === existing.source_id) : nextProduct.evidence_submissions.at(-1);
  assert.equal(submitted.excerpt, excerpt); assert.equal(submitted.status, 'submitted_unverified');
  await form.getByText('已提交 · 待核验', { exact: true }).last().waitFor();
  await page.screenshot({ path: resolve(directory, 'saved-evidence.png'), animations: 'disabled' });
  const duplicate = await page.request.post(`${base}/api/products/${product.product_id}/evidence`, { data: { ...input, base_revision: nextProduct.revision } });
  assert.equal(duplicate.status(), 409); assert.equal((await duplicate.json()).error.code, 'DUPLICATE_EVIDENCE');
  const stale = await page.request.post(`${base}/api/products/${product.product_id}/evidence`, { data: { ...input, base_revision: nextProduct.revision - 1 } });
  assert.equal(stale.status(), 409);
  const badTarget = await page.request.post(`${base}/api/products/${product.product_id}/evidence`, { data: { ...input, base_revision: nextProduct.revision, target: 'not-a-current-finding' } });
  assert.equal(badTarget.status(), 400);
  const queuedResponse = page.waitForResponse(response => response.url().endsWith(`/api/listings/${current.listing_id}/revisions`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '采用当前资料并复检（保存新版本）', exact: true }).click();
  const queued = await (await queuedResponse).json();
  let run;
  for (let i = 0; i < 260; i++) {
    run = await (await fetch(`${base}/api/runs/${queued.run_id}`)).json();
    if (run.status === 'failed') throw new Error(run.error?.message);
    if (run.status === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(run.status, 'succeeded');
  const versions = await (await fetch(`${base}/api/listings/${current.listing_id}/versions`)).json();
  const record = versions.at(-1);
  assert.deepEqual(record.content, current.content);
  assert.deepEqual(versions.find(item => item.version === current.version), current);
  assert.equal(record.product_snapshot.revision, nextProduct.revision);
  assert.equal(record.product_snapshot.retail_pack_count.value, null);
  assert.ok(record.review.missing_data.some(item => item.field === 'retail_pack_count'));
  assert.ok(record.trace.actual_model_call && record.trace.provider_request_id);
  assert.ok(record.trace.source_ids.includes(submitted.source_id));
  for (const format of ['html', 'txt', 'json', 'copy']) {
    const response = await fetch(`${base}/api/listings/${current.listing_id}/export?version=${record.version}&format=${format}`);
    assert.equal(response.status, 200); const body = await response.text();
    if (format === 'copy') assert.ok(!body.includes(submitted.source_id));
    else assert.ok(body.includes(submitted.source_id) && body.includes(excerpt));
  }
  await page.reload(); await page.locator(`[data-listing-id="${current.listing_id}"]`).click();
  await page.getByRole('region', { name: '下一步处理' }).getByRole('button', { name: '核对 / 补充商品资料', exact: true }).click();
  await page.locator(`[data-source-id="${submitted.source_id}"]`).getByRole('button', { name: '查看保存的原文与来源' }).click();
  await page.getByText('提交材料 · 尚未核验', { exact: true }).waitFor();
  await page.getByText('查看保存的来源原文', { exact: true }).click();
  await page.getByText(excerpt, { exact: true }).waitFor();
  await page.screenshot({ path: resolve(directory, 'source-proof.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: resolve(directory, 'mobile-evidence.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  const report = { completed_at: new Date().toISOString(), public_product_only: true, merchant_owned_sku_tested: false,
    listing_id: record.listing_id, listing_version: record.version, product_revision: nextProduct.revision,
    source_url: url, source_id: submitted.source_id, reused_existing_submission: !!existing, model: record.trace.model, request_id: record.trace.provider_request_id,
    usage: record.trace.usage, elapsed_ms: record.trace.elapsed_ms, issues: record.review.issues, missing_data: record.review.missing_data,
    checks: ['real_source_excerpt_submitted_in_browser', 'unsubmitted_material_blocks_recheck', 'duplicate_stale_invalid_target_rejected', 'immutable_old_snapshot', 'real_deepseek_recheck', 'submitted_not_verified', 'retail_count_still_unknown', 'source_view_and_all_exports', 'mobile_no_horizontal_overflow'] };
  writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, ...report }));
} finally { await browser.close(); }
