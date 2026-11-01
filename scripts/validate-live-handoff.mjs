// Real public source + persisted real listing + paid DeepSeek. Never mocks responses.
import { chromium } from '@playwright/test';
import ExcelJS from 'exceljs';
import { load } from 'cheerio';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
if (!process.argv.includes('--real-api')) throw new Error('Use --real-api to authorize paid acceptance.');
const base = 'http://127.0.0.1:8787', directory = resolve('reports/product-readiness-2026-10-23'); mkdirSync(directory, { recursive: true });
const transferOnly = process.argv.includes('--transfer-only');
const report = { started_at: new Date().toISOString(), public_products_only: true, merchant_owned_sku_tested: false, publication_performed: false, steps: [], calls: [] };
const save = () => { const content = JSON.stringify(report, null, 2); writeFileSync(resolve(directory, transferOnly ? 'transfer-acceptance.json' : 'acceptance.json'), content); writeFileSync(resolve(directory, `${transferOnly ? 'transfer' : 'flow'}-${Date.parse(report.started_at)}.json`), content); };
const data = await (await fetch(`${base}/api/bootstrap`)).json();
let record = data.listings.find(item => item.product_snapshot?.reference_product_id === 'W101' && item.trace.actual_model_call && item.review.missing_data.some(item => item.field === 'retail_pack_count'));
assert.ok(record); let product = data.products.find(item => item.product_id === record.product_snapshot.product_id);
report.listing_id = record.listing_id;
const sourceUrl = 'https://westfordmill.com/products/w101';
let response;
try { response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) }); assert.equal(response.status, 200); }
catch (error) { report.failure = `Official source failed: ${error.name}: ${error.message}`; report.source_url = sourceUrl; save(); throw error; }
const $ = load(await response.text());
const excerpt = $('tr').toArray().map(row => $(row).text().replace(/\s+/g, ' ').trim()).filter(text => transferOnly ? /Pricelist Pack Qty/.test(text) : /Carton Quantity|Pricelist Pack Qty|Poly Bag Qty/.test(text)).reverse().join('\n');
assert.ok(/Carton Quantity|Pricelist Pack Qty/.test(excerpt) && excerpt.length >= 10);
report.source = { url: sourceUrl, checked_at: new Date().toISOString(), excerpt, interpretation: '物流装箱与批发包装信息，不能确认商家零售每包件数。' }; save();
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
page.setDefaultTimeout(20000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.url().endsWith('/api/evidence-handoffs/confirm')) console.log('confirmation HTTP', response.status()); });
async function open() { await page.goto(base); await page.locator(`[data-listing-id="${record.listing_id}"]`).click(); }
async function waitRun(queued, label) {
  for (let i = 0; i < 260; i++) {
    const run = await (await fetch(`${base}/api/runs/${queued.run_id}`)).json();
    if (run.status === 'failed') { report.steps.push({ label, status: 'failed', error: run.error, trace: run.trace }); save(); throw new Error(`${label}: ${run.error?.message}`); }
    if (run.status === 'succeeded') {
      const versions = await (await fetch(`${base}/api/listings/${record.listing_id}/versions`)).json(); record = versions.at(-1);
      report.calls.push(...(record.trace.calls || [record.trace]).map(trace => ({ request_id: trace.provider_request_id, model: trace.model, elapsed_ms: trace.elapsed_ms, usage: trace.usage })));
      report.steps.push({ label, version: record.version, consistency: record.review.consistency_check, issues: record.review.issues, missing_data: record.review.missing_data, changed_fields: record.changes.map(item => item.field_path) }); save();
      assert.ok(record.trace.actual_model_call && record.trace.provider_request_id); return record;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`${label}: deadline exceeded`);
}
try {
  await open(); await page.getByRole('region', { name: '下一步处理' }).getByRole('button', { name: '核对 / 补充商品资料', exact: true }).click();
  const handoff = page.getByRole('region', { name: '采购补资料交接' });
  const downloaded = page.waitForEvent('download'); await handoff.getByRole('button', { name: '导出补资料交接 Excel' }).click();
  const originalPath = resolve(directory, 'evidence-handoff.xlsx'); await (await downloaded).saveAs(originalPath);
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(originalPath); const sheet = book.getWorksheet('补资料回传');
  let targetRow; sheet.eachRow((row, index) => { if (index > 1 && row.getCell(8).text === '零售每包件数') targetRow = row; });
  if (!targetRow) sheet.eachRow((row, index) => { if (index > 1 && /零售|包装|每包/.test(row.getCell(8).text)) targetRow = row; });
  assert.ok(targetRow, 'Retail pack evidence task required');
  targetRow.getCell(13).value = 'W101 官方包装表原文（零售数量仍待确认）'; targetRow.getCell(14).value = 'Westford Mill W101'; targetRow.getCell(15).value = 'Westford Mill 官方产品页'; targetRow.getCell(16).value = sourceUrl; targetRow.getCell(17).value = excerpt;
  const payload = async () => ({ filename: 'evidence-handoff.xlsx', base64: Buffer.from(await book.xlsx.writeBuffer()).toString('base64'), product_id: product.product_id, listing_id: record.listing_id });
  const task = targetRow.getCell(2).value;
  targetRow.getCell(2).value = 'altered-task'; let bad = await page.request.post(`${base}/api/evidence-handoffs/preview`, { data: await payload() }); assert.equal(bad.status(), 400); targetRow.getCell(2).value = task;
  targetRow.getCell(17).value = { formula: '1+1', result: 2 }; bad = await page.request.post(`${base}/api/evidence-handoffs/preview`, { data: await payload() }); assert.equal(bad.status(), 400); targetRow.getCell(17).value = excerpt;
  const wrongProduct = { ...(await payload()), product_id: data.products.find(item => item.product_id !== product.product_id).product_id }; bad = await page.request.post(`${base}/api/evidence-handoffs/preview`, { data: wrongProduct }); assert.equal(bad.status(), 400);
  const replyPath = resolve(directory, 'evidence-handoff-returned.xlsx'); await book.xlsx.writeFile(replyPath);
  const existing = product.evidence_submissions?.find(item => item.target === 'retail_pack_count' && item.excerpt === excerpt && item.url === sourceUrl);
  if (!existing) {
    const previewResponse = page.waitForResponse(response => response.url().endsWith('/api/evidence-handoffs/preview'));
    await handoff.getByLabel('上传补资料回传表').setInputFiles(replyPath); const previewHttp = await previewResponse; assert.equal(previewHttp.status(), 200); const preview = await previewHttp.json();
    await page.getByRole('region', { name: '回传材料预览' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '采用当前资料并复检（保存新版本）', exact: true }).isDisabled(), true);
    await page.screenshot({ path: resolve(directory, 'handoff-preview.png'), animations: 'disabled' });
    const confirmedResponse = page.waitForResponse(response => response.url().endsWith('/api/evidence-handoffs/confirm'));
    await handoff.getByRole('button', { name: '确认接收 1 份材料（待核验）', exact: true }).click();
    console.log('confirm clicked');
    const confirmed = await confirmedResponse; console.log('confirmation headers received'); assert.equal(confirmed.status(), 201); const saved = await confirmed.json();
    console.log('confirm response received');
    assert.equal(saved.product.revision, product.revision + 1); assert.equal(saved.product.retail_pack_count.value, null); assert.equal(saved.product.evidence_submissions.at(-1).status, 'submitted_unverified');
    for (const [key, value] of Object.entries(product)) if (!['revision', 'evidence_submissions'].includes(key)) assert.deepEqual(saved.product[key], value);
    product = saved.product;
    console.log('immutable product checked');
    const duplicate = await page.request.post(`${base}/api/evidence-handoffs/confirm`, { data: { preview_id: preview.id, row_ids: [task] } }); assert.equal(duplicate.status(), 409);
    console.log('replay rejected');
    const stale = await page.request.post(`${base}/api/evidence-handoffs/preview`, { data: await payload() }); assert.equal(stale.status(), 409);
    report.steps.push({ label: 'browser_export_preview_confirm', product_revision: product.revision, guards: ['tampered_metadata', 'formulas', 'wrong_product', 'replay', 'stale_product'], source_id: product.evidence_submissions.at(-1).source_id }); save();
  } else { report.steps.push({ label: 'existing_real_submission_reused', source_id: existing.source_id }); save(); }
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390); await page.screenshot({ path: resolve(directory, 'handoff-mobile.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (transferOnly) { report.completed_at = new Date().toISOString(); save(); console.log(JSON.stringify({ directory, transfer: 'completed', report })); process.exitCode = 0; }
  else {
  const old = record;
  for (const label of ['补资料后真实复检', '相同输入真实复检一致性']) {
    const result = await page.request.post(`${base}/api/listings/${record.listing_id}/revisions`, { data: { kind: 'recheck_product', base_version: record.version, product_revision: product.revision } }); assert.equal(result.status(), 202); await waitRun(await result.json(), label);
  }
  assert.ok(['consistent', 'changed'].includes(record.review.consistency_check.state));
  if (record.review.consistency_check.state === 'changed') assert.equal(record.review.status, 'needs_consistency_review');
  assert.deepEqual(record.content, old.content); assert.equal(record.product_snapshot.retail_pack_count.value, null);
  assert.ok(record.review.missing_data.some(item => item.field === 'retail_pack_count'));
  const versions = await (await fetch(`${base}/api/listings/${record.listing_id}/versions`)).json(); assert.deepEqual(versions.find(item => item.version === old.version), old);
  for (const instruction of ['只改标题：把 W101 放到标题最前，保留品牌与棉布袋名称；其他字段逐字保持。不得补充任何参数。', '只改描述：改为两句简洁的美式英文，优先说明已确认的材质与携带方式；其他字段逐字保持。不得添加认证、环保、承重、颜色或零售件数。']) {
    await open(); await page.getByLabel('对话修改指令').fill(instruction);
    const allowed = instruction.startsWith('只改标题') ? 'content.title' : 'content.description';
    await page.getByLabel('对话修改范围').selectOption(allowed);
    const queuedResponse = page.waitForResponse(response => response.url().endsWith(`/api/listings/${record.listing_id}/revisions`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: '提交修改指令', exact: true }).click(); const queued = await queuedResponse; assert.equal(queued.status(), 202); await waitRun(await queued.json(), instruction);
    assert.ok(record.changes.every(change => change.field_path === allowed));
  }
  await open(); await page.screenshot({ path: resolve(directory, 'two-turn-result.png'), fullPage: true, animations: 'disabled' });
  assert.deepEqual(errors, []); report.completed_at = new Date().toISOString(); report.final_version = record.version; report.unresolved = { issues: record.review.issues, missing_data: record.review.missing_data, unchecked: record.review.checks.filter(check => ['not_checked', 'error'].includes(check.state)) }; save();
  console.log(JSON.stringify({ directory, calls: report.calls.length, final_version: record.version, unresolved: report.unresolved }));
  }
} catch (error) { report.failure = error.message; save(); throw error; } finally { await browser.close(); }
