// Real running app only: one paid recheck, no mocked routes or model responses.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
if (!process.argv.includes('--real-api')) throw new Error('Use --real-api to authorize the recheck.');
const baseFlag = process.argv.indexOf('--base-url');
const base = baseFlag > -1 ? process.argv[baseFlag + 1] : 'http://127.0.0.1:8787';
const executableFlag = process.argv.indexOf('--browser-executable');
const executablePath = executableFlag > -1 ? process.argv[executableFlag + 1] : undefined;
const browser = await chromium.launch(executablePath
  ? { executablePath }
  : { channel: process.platform === 'win32' ? 'msedge' : undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const failures = [];
let activeRunId;
page.on('pageerror', error => failures.push(error.message));
try {
  const data = await (await page.request.get(`${base}/api/bootstrap`)).json();
  const current = data.listings.find(x => !x.is_demo && x.product_snapshot && x.trace.actual_model_call);
  assert.ok(current && !current.is_demo && current.trace.actual_model_call);
  const product = data.products.find(x => x.product_id === current.product_snapshot.product_id);
  await page.goto(base);
  await page.getByTestId('choose-improve').click();
  const w101 = data.products.find(item => item.product_id === 'REAL-WESTFORD-W101');
  assert.ok(w101 && !w101.is_demo, 'W101 draft recovery uses the real public-source product in the local workspace');
  const guidedFacts = 'Westford Mill W101: 100% Cotton - 140gsm (4.1oz/yd²); 38 x 42 cm; capacity 10 litres; handle length 67 cm; CutAway label for ease of rebranding.';
  const guidedPrompt = 'Write concise natural English listing copy using only confirmed product facts. Keep unknown color, pack size, and certifications unknown.';
  await page.getByLabel('现有提示词').fill(guidedPrompt);
  await page.getByLabel('商品资料文字').fill(guidedFacts);
  await page.locator('input[aria-label="选择工厂资料文件"]').setInputFiles({ name: 'w101-official-source.txt', mimeType: 'text/plain', buffer: Buffer.from(guidedFacts) });
  await page.getByLabel('文案语言').selectOption('DE-de');
  await page.getByText('使用已有商品档案', { exact: true }).click();
  await page.getByLabel('使用已有商品档案').selectOption(w101.product_id);
  await page.getByTestId('guided-next').click();
  await page.getByTestId('guided-step-confirm').waitFor();
  assert.equal(await page.getByLabel('确认商品名称').inputValue(), w101.name_zh);
  assert.equal(await page.getByLabel('确认商品材质').inputValue(), w101.material.value);
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '我的结果', exact: true }).click();
  await page.getByRole('button', { name: '首页', exact: true }).click();
  await page.getByTestId('choose-improve').click();
  await page.getByTestId('guided-step-confirm').waitFor();
  assert.equal(await page.getByLabel('确认商品名称').inputValue(), w101.name_zh);
  assert.equal((await page.locator('.market-label').innerText()).replace(/\s+/g, ' ').trim(), 'Amazon DE · 德语');
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  assert.equal(await page.getByLabel('现有提示词').inputValue(), guidedPrompt);
  assert.equal(await page.getByLabel('商品资料文字').inputValue(), guidedFacts);
  assert.equal(await page.getByLabel('文案语言').inputValue(), 'DE-de');
  await page.getByText('w101-official-source.txt', { exact: false }).waitFor();
  await page.getByRole('button', { name: '清除草稿并新建', exact: true }).click();
  const path = `${base}/api/listings/${current.listing_id}/revisions`;
  const stale = await page.request.post(path, { data: { kind: 'recheck_product', base_version: current.version, ...(product.revision > 1 ? { product_revision: product.revision - 1 } : {}) } });
  assert.equal(stale.status(), product.revision > 1 ? 409 : 400);
  const result = await page.request.post(path, { data: { kind: 'recheck_product', base_version: current.version, product_revision: product.revision } });
  assert.equal(result.status(), 202);
  const queued = await result.json();
  activeRunId = queued.run_id;
  let completed;
  for (let i = 0; i < 260; i++) {
    const status = await (await page.request.get(`${base}/api/runs/${queued.run_id}`)).json();
    if (status.status === 'failed') throw new Error(status.error?.message);
    if (status.status === 'succeeded') { completed = status; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(completed);
  const versions = await (await page.request.get(`${base}/api/listings/${current.listing_id}/versions`)).json();
  const record = versions.at(-1);
  assert.equal(record.version, current.version + 1);
  assert.ok(record.trace.actual_model_call && record.trace.provider_request_id);
  assert.deepEqual(record.content, current.content);
  assert.deepEqual(versions.find(item => item.version === current.version), current);
  await page.goto(base);
  await page.getByRole('button', { name: '我的结果', exact: true }).click();
  await page.locator(`[data-listing-id="${current.listing_id}"]`).click();
  if (await page.getByTestId('guided-step-result').count()) await page.getByRole('button', { name: '处理问题与局部改稿', exact: true }).click();
  await page.getByRole('button', { name: /^检查与依据/ }).click();
  await page.locator('details[aria-label="卖点证据对照"] > summary').click();
  assert.equal(await page.locator('.version-badge').innerText(), `V${record.version}`);
  assert.equal(await page.getByText('真实模型调用中', { exact: false }).count(), 0);
  for (const format of ['html', 'txt', 'json', 'copy']) {
    const exported = await page.request.get(`${base}/api/listings/${current.listing_id}/export?version=${record.version}&format=${format}`);
    assert.equal(exported.status(), 200);
    const body = await exported.text();
    if (format === 'copy') { assert.ok(body.includes(record.content.title)); assert.ok(!body.includes('内部审阅说明')); }
    else { assert.ok(body.includes(product.product_id)); }
  }
  const screenshot = resolve('.runtime/live-acceptance-browser.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  const variantPosts = [];
  page.on('request', request => {
    if (request.url().includes(`/api/listings/${current.listing_id}/variants`) && request.method() === 'POST') variantPosts.push(request);
  });
  await page.getByRole('button', { name: 'A/B 变体', exact: true }).click();
  // Hold delivery of the actual server response while checking the paid-request
  // close guards. The upstream request and returned body remain real and unmodified.
  let releaseVariantResponse;
  const variantResponseGate = new Promise(resolve => { releaseVariantResponse = resolve; });
  await page.route(`**/api/listings/${current.listing_id}/variants?version=${record.version}`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const actualResponse = route.fetch({ timeout: 180000, maxRetries: 0 });
    await variantResponseGate;
    await route.fulfill({ response: await actualResponse });
  });
  const generatedResponse = page.waitForResponse(response => response.url().includes(`/api/listings/${current.listing_id}/variants?version=${record.version}`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '生成三版变体', exact: true }).click();
  try {
    const dialog = page.getByRole('dialog', { name: 'A/B 变体生成', exact: true });
    await page.getByRole('button', { name: '生成中…', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 1, 'Escape must retain a paid generation in progress');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('.modal-backdrop').click({ position: { x: 2, y: 2 } });
    assert.equal(await dialog.count(), 1, 'close button and backdrop must retain the pending request');
    assert.equal(await page.getByRole('button', { name: '首页', exact: true }).isDisabled(), true);
    assert.equal(variantPosts.length, 1, 'close attempts must not submit another paid generation');
  } finally {
    releaseVariantResponse();
  }
  const generatedResult = await generatedResponse;
  assert.equal(generatedResult.status(), 201);
  const variantSet = await generatedResult.json();
  assert.equal(variantSet.review_status, 'not_reviewed');
  assert.equal(variantSet.variants.length, 3);
  assert.ok(variantSet.trace.actual_model_call && variantSet.trace.model);
  const savedVariantSet = await (await page.request.get(`${base}/api/listings/${current.listing_id}/variants?version=${record.version}`)).json();
  assert.equal(savedVariantSet.variant_set_id, variantSet.variant_set_id);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'A/B 变体', exact: true }).click();
  await page.getByText(variantSet.trace.provider_request_id || variantSet.trace.model, { exact: false }).waitFor();
  assert.equal(variantPosts.length, 1, 'reopening must restore results without another generation call');
  const adoptionResponse = page.waitForResponse(response => response.url().endsWith(`/api/listings/${current.listing_id}/revisions`) && response.request().method() === 'POST' && response.request().postDataJSON()?.kind === 'adopt_variant');
  await page.getByRole('button', { name: '采用为新版并复检', exact: true }).first().click();
  const adoptionQueued = await adoptionResponse;
  assert.equal(adoptionQueued.status(), 202);
  const adoptionRun = await adoptionQueued.json();
  let adoptionStatus;
  for (let i = 0; i < 260; i++) {
    adoptionStatus = await (await page.request.get(`${base}/api/runs/${adoptionRun.run_id}`)).json();
    if (adoptionStatus.status === 'failed') throw new Error(adoptionStatus.error?.message);
    if (adoptionStatus.status === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(adoptionStatus?.status, 'succeeded');
  const afterAdoptionVersions = await (await page.request.get(`${base}/api/listings/${current.listing_id}/versions`)).json();
  const adopted = afterAdoptionVersions.find(item => item.version === record.version + 1);
  assert.ok(adopted?.trace.actual_model_call && adopted.trace.provider_request_id);
  assert.deepEqual(adopted.content, variantSet.variants.find(item => item.angle === adopted.variant_adoption.angle).content);
  assert.equal(adopted.variant_adoption.variant_set_id, variantSet.variant_set_id);
  await page.waitForFunction(expected => document.querySelector('.version-badge')?.textContent === expected, `V${adopted.version}`);
  assert.deepEqual(failures, []);
  const report = { completed_at: new Date().toISOString(), listing_id: record.listing_id, version: record.version,
    model: record.trace.model, request_id: record.trace.provider_request_id, actual_model_call: true,
    elapsed_ms: record.trace.elapsed_ms, usage: record.trace.usage, issues: record.review.issues, missing_data: record.review.missing_data,
    ab: { variant_set_id: variantSet.variant_set_id, base_version: variantSet.base_version, review_status_before_adoption: variantSet.review_status,
      generation: { model: variantSet.trace.model, request_id: variantSet.trace.provider_request_id, elapsed_ms: variantSet.trace.elapsed_ms, usage: variantSet.trace.usage, format_retry: variantSet.trace.format_retry || null },
      adopted_version: adopted.version, angle: adopted.variant_adoption.angle,
      independent_review: { model: adopted.trace.model, request_id: adopted.trace.provider_request_id, elapsed_ms: adopted.trace.elapsed_ms, usage: adopted.trace.usage, issues: adopted.review.issues, missing_data: adopted.review.missing_data } },
    checks: ['guided_draft_survives_navigation', 'invalid_product_revision_rejected', 'real_api_recheck', 'version_history_preserved', 'evidence_visible', 'html_txt_json_copy_exports', 'ab_generation_blocks_escape_close_backdrop_and_navigation', 'real_ab_set_persisted_on_reopen', 'ab_adoption_saved_as_independently_reviewed_version'],
    transport_check: 'The actual A/B server response was delayed until close guards were checked; the model request and response body were not substituted.', screenshot };
  writeFileSync(resolve('.runtime/live-browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  const run = activeRunId ? await (await fetch(`${base}/api/runs/${activeRunId}`)).json() : null;
  writeFileSync(resolve(`.runtime/live-browser-failure-${Date.now()}.json`), JSON.stringify({ failed_at: new Date().toISOString(), message: error.message, run }, null, 2));
  throw error;
} finally { await browser.close(); }
