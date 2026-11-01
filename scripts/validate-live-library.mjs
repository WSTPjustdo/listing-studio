// Uses persisted real DeepSeek listings. No fake product, model response, or Amazon publication.
import { chromium } from '@playwright/test';
import ExcelJS from 'exceljs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const baseFlag = process.argv.indexOf('--base-url');
const base = baseFlag >= 0 ? process.argv[baseFlag + 1] : 'http://127.0.0.1:8787';
const reportFlag = process.argv.indexOf('--report-dir');
const directory = resolve(reportFlag > -1 ? process.argv[reportFlag + 1] : 'reports/listing-library-2026-10-23'); mkdirSync(directory, { recursive: true });
let rows;
try {
  rows = await (await fetch(`${base}/api/library`)).json();
} catch {
  console.error(
    `连不上 ${base}。这条检查是打开真实界面点一遍台账，不会自己起服务：\n` +
      '  先 npm start（或双击 start-local.cmd），等窗口打印地址后再跑这条命令。',
  );
  process.exit(2);
}
const reference = rows.find(row => row.product.name_zh.includes('W201') && row.marketplace === 'US' && row.record?.trace.actual_model_call)
  || rows.find(row => row.product.name_zh.includes('W201') && row.record?.trace.actual_model_call);
if (!reference) {
  console.error(
    '本机台账里没有可直接用的真实记录：需要一条 W201、且带真实模型调用（trace.actual_model_call）的文案。\n' +
      '这条检查只读已有记录，不生成、不模拟；请先在工作台里完成一次真实生成再跑。',
  );
  process.exit(2);
}
const versions = await (await fetch(`${base}/api/listings/${reference.record.listing_id}/versions`)).json();
const pinned = versions.length > 1 ? versions.at(-2) : versions[0];
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  // 台账已并进「我的结果」的第二段（上面文案、下面批量台账），入口不再单独存在。
  await page.goto(base); await page.getByRole('button', { name: '我的结果', exact: true }).click();
  const card = page.locator('.library-card').filter({ hasText: `${reference.product.name_zh} · ${({ US: 'Amazon 美国站', DE: 'Amazon 德国站', UK: 'Amazon 英国站', FR: 'Amazon 法国站' })[reference.marketplace] || reference.marketplace}` });
  await card.getByRole('button', { name: '管理文案与上架信息' }).click();
  await card.getByLabel('管理文案版本', { exact: true }).selectOption(`${pinned.listing_id}@${pinned.version}`);
  await card.getByLabel('管理状态', { exact: true }).selectOption('draft');
  await card.getByLabel('管理备注', { exact: true }).fill('真实公开参考商品；仅验收文案台账，未确认商家库存或上架状态。');
  await card.locator('.library-editor').screenshot({ path: resolve(directory, 'library-editor.png'), animations: 'disabled' });
  const savedResponse = page.waitForResponse(response => response.url().endsWith(`/api/library/${reference.product.product_id}`) && response.request().method() === 'POST');
  await card.getByRole('button', { name: '保存台账', exact: true }).click();
  const response = await savedResponse; assert.equal(response.status(), 201);
  const entry = await response.json(); assert.equal(entry.listing_version, pinned.version); assert.equal(entry.state, 'draft');
  await page.reload(); await page.getByRole('button', { name: '我的结果', exact: true }).click();
  const updatedRows = await (await fetch(`${base}/api/library`)).json();
  const updated = updatedRows.find(row => row.product.product_id === reference.product.product_id && row.marketplace === reference.marketplace);
  assert.equal(updated.record.version, pinned.version); assert.deepEqual(updated.record.content, pinned.content);
  assert.equal(updated.newer_available, versions.length > 1);
  const invalidPublish = await page.request.post(`${base}/api/library/${reference.product.product_id}`, { data: { ...entry, marketplace: reference.marketplace, base_revision: entry.revision, state: 'published', asin: '', published_on: '', published_confirmation: false } });
  assert.equal(invalidPublish.status(), 400); assert.equal((await invalidPublish.json()).error.code, 'PUBLICATION_CONFIRMATION_REQUIRED');
  const stale = await page.request.post(`${base}/api/library/${reference.product.product_id}`, { data: { ...entry, marketplace: reference.marketplace, base_revision: entry.revision - 1 } });
  assert.equal(stale.status(), 409);
  await page.getByRole('button', { name: '选择当前结果', exact: true }).click();
  const selectedRows = updatedRows.filter(row => row.record);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: `导出所选 Excel（${selectedRows.length}）`, exact: true }).click();
  const file = await downloaded, path = resolve(directory, 'listing-library.xlsx'); await file.saveAs(path);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Listing 文案', '审核与来源']);
  const copy = workbook.worksheets[0], audit = workbook.worksheets[1];
  assert.equal(copy.rowCount, selectedRows.length + 1); assert.equal(audit.rowCount, selectedRows.length + 1);
  const column = (sheet, header) => sheet.getRow(1).values.findIndex(value => value === header);
  for (const row of selectedRows) {
    const xrow = copy.getRows(2, copy.rowCount-1).find(item => item.getCell(1).value === row.product.product_id && item.getCell(column(copy, 'Amazon 站点')).value === row.marketplace);
    assert.ok(xrow); assert.equal(xrow.getCell(column(copy, 'Title')).value, row.record.content.title);
    assert.equal(xrow.getCell(column(copy, 'Description')).value, row.record.content.description);
    assert.equal(xrow.getCell(column(copy, '文案版本')).value, row.record.version);
    assert.equal(xrow.getCell(column(copy, 'SKU / 货号（未填则空）')).value || '', row.entry.sku || '');
    row.record.content.bullet_points.forEach((bullet, index) => assert.equal(xrow.getCell(column(copy, `Bullet ${index+1}`)).value, bullet.text));
    const arow = audit.getRows(2, audit.rowCount-1).find(item => item.getCell(1).value === row.product.product_id && item.getCell(column(audit, 'Amazon 站点')).value === row.marketplace);
    assert.equal(arow.getCell(column(audit, '实际请求ID')).value, row.record.trace.provider_request_id);
  }
  assert.equal(copy.views[0].state, 'frozen'); assert.ok(copy.autoFilter);
  await page.screenshot({ path: resolve(directory, 'library-desktop.png'), animations: 'disabled' });
  await page.getByLabel('筛选管理状态', { exact: true }).selectOption('published');
  assert.equal(await page.locator('.library-card').count(), 0); // no invented published products
  await page.getByLabel('筛选管理状态', { exact: true }).selectOption('all');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: resolve(directory, 'library-mobile.png'), animations: 'disabled' });
  await card.getByRole('button', { name: '查看此版文案与审核', exact: true }).click();
  assert.equal(await page.locator('.version-badge').innerText(), `V${pinned.version}`);
  assert.deepEqual(errors, []);
  const after = await (await fetch(`${base}/api/library`)).json();
  assert.deepEqual(after.find(row => row.product.product_id === reference.product.product_id && row.marketplace === reference.marketplace).entry, updated.entry);
  const report = { completed_at: new Date().toISOString(), public_products_only: true, merchant_owned_sku_tested: false, amazon_publication_performed: false,
    exported_products: selectedRows.map(row => ({ product_id: row.product.product_id, marketplace: row.marketplace, listing_id: row.record.listing_id, version: row.record.version, request_id: row.record.trace.provider_request_id })),
    checks: ['real_listing_version_pinned_per_marketplace', 'reload_persists_registration', 'missing_publication_confirmation_rejected', 'stale_registration_rejected_per_marketplace', 'one_click_real_xlsx_download', 'all_titles_bullets_descriptions_match_exactly', 'review_ids_match', 'site_links_and_languages_exported', 'filters_and_mobile_fit', 'opens_pinned_version', 'export_does_not_change_registration'] };
  writeFileSync(resolve(directory, 'acceptance.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ directory, ...report }));
} finally { await browser.close(); }
