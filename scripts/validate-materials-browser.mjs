// Actual local workbench + official public documents. Never intercept model or extraction responses.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const argument = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const base = argument('--base-url', 'http://127.0.0.1:3221');
const directory = resolve(argument('--report-dir', '.runtime/materials-acceptance/browser'));
const sourceDirectory = resolve(argument('--source-dir', '.runtime/materials-acceptance/live-materials'));
const realApi = process.argv.includes('--real-api');
const origin = new URL(base);
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname) && origin.protocol === 'http:');
const sourcePaths = [resolve(sourceDirectory, 'official-w101-public-text.txt'), resolve(sourceDirectory, 'official-w101-specification.pdf'), resolve('reports/flat-file-live-2026-10-28/public-derived-w101-without-seller-sku.tsv')];
sourcePaths.forEach(file => assert.ok(existsSync(file), `Missing real public-source file: ${file}`));
mkdirSync(directory, { recursive: true });
const report = {
  started_at: new Date().toISOString(), base_url: base,
  evidence_type: 'actual_browser_official_public_documents_and_public_derived_tsv',
  merchant_original_word: 'unknown', merchant_original_excel: 'unknown', merchant_wechat_screenshot: 'unknown',
  genuine_merchant_acceptance: 'pending', official_amazon_template: 'unknown', seller_sku: null,
  paid_analysis_authorized: realApi, model_calls: [], checks: [], screenshots: [], overflow: [],
  page_errors: [], mutation_requests: [], previews: [], failures: [],
  notice: 'Uses a real official W101 PDF and literal public page text plus an existing source-derived TSV. Unsupported DOC/XLS checks rename real TXT bytes only to exercise extension rejection; these are not merchant files. No synthetic product or mocked response is used.',
};
const save = () => writeFileSync(resolve(directory, 'browser-acceptance.json'), JSON.stringify(report, null, 2));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedHashes = new Map(sourcePaths.map(file => [file.split(/[\\/]/).pop(), hash(readFileSync(file))]));
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', error => { report.page_errors.push(error.message); save(); });
page.on('request', request => {
  const url = new URL(request.url());
  if (url.origin !== origin.origin || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) return;
  report.mutation_requests.push({ method: request.method(), path: url.pathname });
  save();
});
async function capture(label, selector) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    if (selector) {
      await page.locator(selector).scrollIntoViewIfNeeded();
      await page.locator(selector).evaluate(element => scrollBy(0, element.getBoundingClientRect().top - 100));
    }
    else await page.evaluate(() => scrollTo(0, 0));
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    report.overflow.push({ label, ...dimensions });
    assert.ok(dimensions.scroll <= dimensions.width + 1, `${label}: ${dimensions.scroll}px at ${width}px`);
    const filename = `${label}-${width}.png`;
    await page.screenshot({ path: resolve(directory, filename), fullPage: false, animations: 'disabled' });
    report.screenshots.push(filename); save();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}
async function home() {
  await page.goto(base);
  await page.getByTestId('two-path-home').waitFor();
}
async function unsupportedExtensions() {
  for (const extension of ['doc', 'xls']) {
    const filename = `official-text-extension-rejection.${extension}`;
    const bytes = readFileSync(sourcePaths[0]);
    await page.getByLabel('选择工厂资料文件', { exact: true }).setInputFiles({ name: filename, mimeType: 'application/octet-stream', buffer: bytes });
    assert.match(await page.locator('.material-intake > .material-error').innerText(), /暂不支持此格式/);
    const response = await page.request.post(`${base}/api/materials/preview`, { data: { files: [{ filename, base64: bytes.toString('base64') }] } });
    assert.equal(response.status(), 201);
    const data = await response.json();
    assert.equal(data.documents[0].status, 'failed');
    assert.equal(data.documents[0].error.code, 'MATERIAL_FORMAT');
    report.checks.push(`actual_client_and_api_${extension}_extension_rejection`);
    report.failures.push({ kind: 'intentional_unsupported_extension_check', filename, source_bytes_sha256: hash(bytes), status: data.documents[0].status, error: data.documents[0].error });
  }
}
async function materialFlow(mode) {
  await home();
  await page.getByTestId(`choose-${mode}`).click();
  await page.getByTestId('material-intake').waitFor();
  if (mode === 'improve') {
    await page.getByLabel('现有提示词', { exact: true }).fill('支持批量导入亚马逊标准模板 Excel/TSV，也要考虑中文 Word、微信截图、产品实拍备注、零散 Excel 与 PDF 说明书。仅按确认过的真实商品资料写作。');
    await unsupportedExtensions();
  }
  const manualNote = 'Westford Mill W101 Cotton Tote';
  await page.getByLabel('商品资料文字', { exact: true }).fill(manualNote);
  await page.getByLabel('选择工厂资料文件', { exact: true }).setInputFiles(sourcePaths.slice(0, 1));
  await page.getByLabel('选择工厂资料文件', { exact: true }).setInputFiles(sourcePaths.slice(0, 1));
  assert.equal(await page.locator('.material-file-list > li').count(), 1);
  assert.match(await page.locator('.material-intake > .material-error').innerText(), /已经在资料列表中/);
  await page.getByLabel('选择工厂资料文件', { exact: true }).setInputFiles(sourcePaths.slice(1));
  assert.equal(await page.locator('.material-file-list > li').count(), 3);
  assert.match(await page.locator('.material-intake > .material-error').innerText(), /已经在资料列表中/);
  report.checks.push(`${mode}_duplicate_file_notice_survives_successful_addition`);
  await page.getByTestId('guided-next').click();
  assert.match(await page.locator('.guided-error').innerText(), /先提取并核对/);
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/materials/preview' && response.request().method() === 'POST', { timeout: 180000 });
  await page.getByTestId('materials-extract').click();
  const extracted = await responsePromise;
  assert.equal(extracted.status(), 201);
  const preview = await extracted.json();
  assert.equal(preview.documents.length, 3);
  assert.ok(preview.documents.every(document => document.status === 'ready'), JSON.stringify(preview.documents.map(document => ({ filename: document.filename, error: document.error }))));
  for (const document of preview.documents) {
    assert.equal(document.sha256, expectedHashes.get(document.filename));
    assert.ok(document.segments.length > 0 && document.segments.every(segment => segment.locator && segment.text));
  }
  report.previews.push({ mode, id: preview.id, documents: preview.documents.map(document => ({ id: document.id, filename: document.filename, sha256: document.sha256, status: document.status, segment_count: document.segments.length, first_locator: document.segments[0]?.locator })) });
  await page.getByTestId('materials-use').waitFor();
  assert.ok(await page.getByTestId('materials-use').isDisabled());
  assert.equal(await page.getByLabel('确认所选资料属于同一商品', { exact: true }).isChecked(), false);
  const pdfDetails = page.locator('.material-document').filter({ has: page.locator('summary > span', { hasText: 'official-w101-specification.pdf' }) });
  await pdfDetails.locator('summary').click();
  assert.match(await pdfDetails.innerText(), /第 1 页/);
  const correction = page.getByLabel('核对工厂资料文字', { exact: true });
  const original = await correction.inputValue();
  assert.match(original, /【official-w101-specification.pdf \/ 第 1 页】/);
  const corrected = `${original}\n\n核对备注：来源为 Westford Mill 官方 W101 规格。`;
  await correction.fill(corrected);
  await page.getByLabel('确认所选资料属于同一商品', { exact: true }).check();
  await page.getByTestId('materials-use').click();
  assert.equal(await page.getByLabel('商品资料文字', { exact: true }).inputValue(), `${corrected}\n\n【补充说明】\n${manualNote}`);
  assert.ok(await page.getByTestId('materials-use').isDisabled());
  const merchantInput = page.getByLabel('商品资料文字', { exact: true });
  const additionalNote = '人工补充：颜色与零售包装尚未确认，继续保持未知。';
  const adoptedWithNote = (await merchantInput.inputValue()) + '\n\n' + additionalNote;
  await merchantInput.fill(adoptedWithNote);
  await correction.fill(corrected + '\n核对后待再次采用。');
  assert.equal(await merchantInput.inputValue(), adoptedWithNote);
  const pdfCheckbox = page.getByLabel('采用资料 official-w101-specification.pdf', { exact: true });
  await pdfCheckbox.uncheck();
  assert.equal(await merchantInput.inputValue(), adoptedWithNote);
  assert.equal(await page.getByLabel('确认所选资料属于同一商品', { exact: true }).isChecked(), false);
  assert.ok(await page.getByTestId('materials-use').isDisabled());
  await pdfCheckbox.check();
  await page.getByLabel('确认所选资料属于同一商品', { exact: true }).check();
  await page.getByTestId('materials-use').click();
  const afterReapply = await merchantInput.inputValue();
  assert.ok(afterReapply.includes(manualNote));
  assert.ok(afterReapply.includes(additionalNote));
  assert.equal(afterReapply.split('【official-w101-specification.pdf / 第 1 页】').length, 2);
  await capture(`${mode}-sources`, '.material-preview');
  report.checks.push(`${mode}_actual_multi_file_extraction_source_locators_and_user_edits_preserved_on_material_changes`);
  if (mode === 'improve' && realApi) {
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/research/analyze' && response.request().method() === 'POST', { timeout: 180000 });
    await page.getByTestId('guided-next').click();
    const response = await responsePromise;
    const analysis = await response.json();
    if (response.status() !== 200) {
      report.failures.push({ operation: 'actual_ui_research_analyze', http_status: response.status(), error: analysis.error || analysis }); save();
    }
    assert.equal(response.status(), 200, JSON.stringify(analysis));
    assert.ok(analysis.trace?.actual_model_call && analysis.trace?.provider_request_id);
    const submitted = response.request().postDataJSON();
    assert.equal(submitted.material_context.preview_id, preview.id);
    assert.equal(submitted.material_context.document_ids.length, 3);
    await page.getByTestId('guided-step-confirm').waitFor();
    const trace = analysis.trace;
    report.model_calls.push({ operation: 'research_analyze', request_id: trace.provider_request_id, model: trace.model, elapsed_ms: trace.elapsed_ms, usage: trace.usage, actual_model_call: trace.actual_model_call });
    assert.ok(await page.getByTestId('guided-generate').isDisabled());
    await capture('improve-real-analysis-confirmation', '.guided-confirm');
    const parametersScreenshot = 'improve-real-analysis-confirmation-parameters.png';
    await page.locator('.guided-known-specs').screenshot({ path: resolve(directory, parametersScreenshot), animations: 'disabled' });
    report.screenshots.push(parametersScreenshot);
    report.checks.push('real_browser_material_context_to_DeepSeek_analysis_and_unconfirmed_product_gate');
    const nameField = page.getByLabel('确认商品名称', { exact: true });
    const revisedName = (await nameField.inputValue()) + '（人工核对）';
    await nameField.fill(revisedName);
    await page.getByLabel('确认当前商品信息与检查范围', { exact: true }).check();
    await page.getByRole('button', { name: '上一步', exact: true }).click();
    await page.getByTestId('guided-next').click();
    await page.getByTestId('guided-step-confirm').waitFor();
    assert.equal(await nameField.inputValue(), revisedName);
    assert.ok(await page.getByLabel('确认当前商品信息与检查范围', { exact: true }).isChecked());
    assert.equal(report.mutation_requests.filter(request => request.path === '/api/research/analyze').length, 1);
    report.checks.push('back_next_preserves_manual_confirmation_without_second_paid_analysis');
  }
  save();
}
try {
  await home();
  await capture('home-batch-entry', '.guided-home-import');
  await page.getByRole('button', { name: '批量导入模板', exact: false }).click();
  await page.getByLabel('上传商品表', { exact: true }).waitFor({ state: 'attached' });
  report.checks.push('home_direct_amazon_batch_import_navigation');
  await capture('amazon-batch-import');
  await materialFlow('improve');
  await materialFlow('automatic');
  assert.equal(report.mutation_requests.filter(request => request.path === '/api/research/analyze').length, realApi ? 1 : 0);
  assert.equal(report.mutation_requests.filter(request => ['/api/guided/plan', '/api/guided/generate', '/api/batches'].includes(request.path)).length, 0);
  assert.deepEqual(report.page_errors, []);
  report.status = realApi ? 'passed_available_public_source_scope_with_real_analysis' : 'passed_public_source_browser_extraction_only';
  report.completed_at = new Date().toISOString(); save();
  console.log(JSON.stringify({ report: resolve(directory, 'browser-acceptance.json'), status: report.status, checks: report.checks, model_calls: report.model_calls, screenshots: report.screenshots.length }));
} catch (error) {
  report.status = 'failed'; report.failed_at = new Date().toISOString();
  report.failure = { message: error.message, code: error.code || null };
  save();
  await page.screenshot({ path: resolve(directory, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
