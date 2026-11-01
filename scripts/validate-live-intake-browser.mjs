// Real UI submission and paid model calls. No route interception or synthetic product copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
if (!process.argv.includes('--real-api')) throw new Error('Use --real-api to authorize paid inference.');
const flag = process.argv.indexOf('--base-url');
const base = flag < 0 ? 'http://127.0.0.1:8788' : process.argv[flag + 1];
const state = JSON.parse(fs.readFileSync('.runtime/live-intake-current.json', 'utf8'));
const directory = state.directory;
const report = { started_at: new Date().toISOString(), checks: [], page_errors: [], records: [], screenshots: [] };
const save = () => fs.writeFileSync(path.join(directory, 'intake-browser-acceptance.json'), JSON.stringify(report, null, 2));
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', error => report.page_errors.push(error.message));
const wait = async run => {
  const started = Date.now();
  for (;;) {
    const status = await (await page.request.get(`${base}/api/runs/${run.run_id}`)).json();
    if (status.status === 'failed') throw new Error(JSON.stringify(status.error));
    if (status.status === 'succeeded') {
      const versions = await (await page.request.get(`${base}/api/listings/${run.listing_id}/versions`)).json();
      const record = versions.at(-1);
      assert.ok(record.trace.actual_model_call && record.trace.provider_request_id);
      report.records.push(record); save(); return record;
    }
    if (Date.now() - started > 300000) throw new Error('Real UI acceptance deadline exceeded');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
};
try {
  const content = state.own_content;
  const raw = ['Title', content.title, '', 'Item Highlights', content.item_highlights, '', 'Bullet Points', ...content.bullet_points.map(b => `• ${b.text}`), '', 'Description', content.description].join('\n');
  await page.goto(base);
  await page.getByRole('button', { name: '更多功能', exact: true }).click();
  await page.getByRole('button', { name: '导入已有文案', exact: true }).click();
  await page.getByLabel('读取 UTF-8 TXT 文案').setInputFiles({ name: 'existing-real-w101.txt', mimeType: 'text/plain', buffer: Buffer.from(raw, 'utf8') });
  await page.getByTestId('intake-parse').click();
  assert.equal(await page.getByLabel('导入标题预览').inputValue(), content.title);
  assert.equal(await page.getByLabel('导入亮点预览').inputValue(), content.item_highlights);
  for (const [i, bullet] of content.bullet_points.entries()) assert.equal(await page.getByLabel(`导入要点 ${i + 1}`, { exact: true }).inputValue(), bullet.text);
  assert.equal(await page.getByLabel('导入描述预览').inputValue(), content.description);
  assert.ok(await page.getByTestId('intake-submit').isDisabled());
  await page.getByLabel('确认导入字段').check();
  assert.ok(await page.getByTestId('intake-submit').isDisabled());
  await page.getByLabel('确认检查范围').check();
  await page.getByRole('button', { name: /竞品参考/ }).click();
  assert.ok(await page.getByTestId('intake-submit').isDisabled());
  await page.getByRole('button', { name: /我的初稿/ }).click();
  await page.getByLabel('导入关联自家商品').selectOption(state.product_id);
  await page.getByLabel('导入关键词').fill('cotton\nCutAway\n4.1oz/yd²');
  report.checks.push('real_saved_copy_txt_roundtrip', 'preview_scope_and_competitor_product_gates');
  const queuedResponse = page.waitForResponse(r => r.request().method() === 'POST' && r.url() === `${base}/api/listings/intake`);
  await page.getByTestId('intake-submit').click();
  const response = await queuedResponse; assert.equal(response.status(), 202);
  const first = await wait(await response.json());
  assert.deepEqual(first.content, content);
  assert.equal(first.intake_context.source_filename, 'existing-real-w101.txt');
  assert.equal(first.intake_context.raw_text, raw);
  await page.getByTestId('intake-record-context').waitFor();
  assert.equal(await page.getByTestId('keyword-usage').getByText('cotton', { exact: false }).count(), 1);
  report.checks.push('real_ui_paid_diagnosis', 'original_txt_and_source_saved', 'actual_keyword_usage_visible');
  const field = `content.bullet_points.${first.content.bullet_points[0].id}`;
  await page.getByLabel('修改范围').selectOption(field);
  await page.getByLabel('对话修改指令').fill('仅对选中的这一条要点调整句式，保持意思和有依据的参数不变。使用自然美式英文，不增加商品性能、认证或功能；其他字段保持原文。');
  const revisionResponse = page.waitForResponse(r => r.request().method() === 'POST' && r.url() === `${base}/api/listings/${first.listing_id}/revisions`);
  await page.getByRole('button', { name: '提交修改指令', exact: true }).click();
  const revised = await revisionResponse; assert.equal(revised.status(), 202);
  const next = await wait(await revised.json());
  for (const key of ['title', 'item_highlights', 'description']) assert.equal(next.content[key], first.content[key]);
  assert.deepEqual(next.content.bullet_points.slice(1), first.content.bullet_points.slice(1));
  const versions = await (await page.request.get(`${base}/api/listings/${first.listing_id}/versions`)).json();
  assert.deepEqual(versions.find(x => x.version === first.version), first);
  report.checks.push('real_ui_single_bullet_revision_and_independent_audit', 'unselected_content_and_original_version_unchanged');
  await page.waitForFunction(version => document.querySelector('.version-badge')?.textContent === `V${version}`, next.version);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.evaluate(() => window.scrollTo(0, 0));
    const name = `intake-live-${width}.png`; await page.screenshot({ path: path.join(directory, name), fullPage: true }); report.screenshots.push(name);
  }
  assert.deepEqual(report.page_errors, []);
  report.checks.push('desktop_mobile_no_overflow_or_page_error');
  report.completed_at = new Date().toISOString(); save();
  console.log(JSON.stringify({ report: path.join(directory, 'intake-browser-acceptance.json'), checks: report.checks, final: { listing_id: next.listing_id, version: next.version, issues: next.review.issues, missing_data: next.review.missing_data } }));
} catch (error) {
  report.failed_at = new Date().toISOString(); report.failure = { message: error.message, code: error.code || null }; save(); throw error;
} finally { await browser.close(); }
