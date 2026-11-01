// Real official product input, actual UI requests and existing local DeepSeek. No intercepted responses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
if (!process.argv.includes('--real-api')) throw new Error('Use --real-api to authorize paid inference.');
const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const base = arg('--base-url', 'http://127.0.0.1:8788');
const phase = arg('--phase', 'all');
assert.ok(['improve', 'automatic', 'all'].includes(phase));
const state = JSON.parse(fs.readFileSync('.runtime/live-intake-current.json', 'utf8'));
const file = path.join(state.directory, `guided-browser-${phase}-${Date.now()}.json`);
const report = { started_at: new Date().toISOString(), checks: [], records: [], plans: [], page_errors: [], screenshots: [], research_failures: [], input_provenance: 'Real official W101 public text and saved facts. Prompt quotes interview requirements supplied by the user, not a private merchant template.' };
const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2));
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', e => report.page_errors.push(e.message));
page.on('response', async response => {
  if (response.request().method() === 'POST' && response.url() === `${base}/api/research/search` && !response.ok()) {
    report.research_failures.push({ at: new Date().toISOString(), status: response.status(), body: await response.json().catch(() => null) }); save();
  }
});
async function capture(name) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} overflows at ${width}`);
    await page.evaluate(() => scrollTo(0, 0));
    const filename = `guided-${name}-${width}.png`;
    await page.screenshot({ path: path.join(state.directory, filename), fullPage: true });
    report.screenshots.push(filename);
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); save();
}
async function submit(mode) {
  await page.getByLabel('确认当前商品信息与检查范围', { exact: true }).check();
  const planResponse = page.waitForResponse(r => r.url() === `${base}/api/guided/plan` && r.request().method() === 'POST', { timeout: 180000 });
  await page.getByTestId('guided-generate').click();
  const response = await planResponse;
  const plan = await response.json(); report.plans.push(plan); save();
  assert.equal(response.status(), 201, JSON.stringify(plan));
  assert.ok(plan.trace.actual_model_call && plan.trace.provider_request_id);
  assert.ok(plan.optimized_prompt.includes('{{PRODUCT_FACTS}}') && plan.optimized_prompt.includes('{{KEYWORDS}}'));
  await page.getByTestId('guided-step-result').waitFor({ timeout: 360000 });
  const bootstrap = await (await page.request.get(`${base}/api/bootstrap`)).json();
  const record = bootstrap.listings.find(r => r.guided_plan?.id === plan.id);
  assert.ok(record?.trace.actual_model_call && record.trace.provider_request_id);
  assert.equal(record.guided_plan.mode, mode);
  assert.equal(record.guided_plan.trace.provider_request_id, plan.trace.provider_request_id);
  report.records.push(record); save();
  const exported = await page.request.get(`${base}/api/listings/${record.listing_id}/export?version=${record.version}&format=copy`);
  assert.equal(exported.status(), 200); assert.ok((await exported.text()).includes(record.content.title));
  await page.getByText('查看改进后的提示词', { exact: true }).click();
  assert.ok((await page.locator('.guided-plan pre').innerText()).includes('{{PRODUCT_FACTS}}'));
  await page.getByText('查看改进后的提示词', { exact: true }).click();
  await capture(`${mode}-result`);
  report.checks.push(`${mode}_real_ui_plan_generation_independent_audit_and_export`); save();
}
try {
  await page.goto(base); await page.getByTestId('two-path-home').waitFor();
  assert.equal(await page.getByTestId('choose-improve').count(), 1);
  assert.equal(await page.getByTestId('choose-automatic').count(), 1);
  await capture('home');
  if (phase === 'all' || phase === 'improve') {
    await page.getByTestId('choose-improve').click();
    await page.getByLabel('现有提示词', { exact: true }).fill('禁止夸大、不能用medical claim、美式表达、不要堆砌');
    await page.getByText('使用已有商品档案', { exact: true }).click();
    await page.getByLabel('使用已有商品档案', { exact: true }).selectOption(state.product_id);
    await page.getByTestId('guided-next').click();
    await page.getByTestId('guided-step-confirm').waitFor();
    assert.ok(await page.getByTestId('guided-generate').isDisabled());
    await page.getByLabel('确认当前商品信息与检查范围', { exact: true }).check();
    const name = page.getByLabel('确认商品名称', { exact: true });
    await name.fill(`${await name.inputValue()} `);
    assert.ok(!await page.getByLabel('确认当前商品信息与检查范围', { exact: true }).isChecked());
    report.checks.push('editing_revokes_confirmation');
    await capture('improve-confirm'); await submit('improve');
  }
  if (phase === 'all' || phase === 'automatic') {
    await page.getByRole('button', { name: '首页', exact: true }).click();
    await page.getByTestId('choose-automatic').click();
    const source = state.sources.find(s => s.model === 'W101');
    const text = [source.title, ...source.bullets].join('\n');
    report.analysis_input = { text, url: source.url, checked_at: source.checked_at }; save();
    await page.getByLabel('商品资料文字', { exact: true }).fill(text);
    const analysisResponse = page.waitForResponse(r => r.url() === `${base}/api/research/analyze` && r.request().method() === 'POST', { timeout: 180000 });
    const searchResponse = page.waitForResponse(r => r.url() === `${base}/api/research/search` && r.request().method() === 'POST', { timeout: 180000 });
    await page.getByTestId('guided-next').click();
    const analyzed = await analysisResponse; report.analysis = await analyzed.json(); save();
    assert.equal(analyzed.status(), 200, JSON.stringify(report.analysis));
    assert.ok(report.analysis.trace.actual_model_call && report.analysis.trace.provider_request_id);
    assert.ok(report.analysis.facts.every(f => text.includes(f.evidence)));
    await page.getByTestId('guided-step-confirm').waitFor();
    const searched = await searchResponse;
    if (!searched.ok()) {
      assert.ok(await page.getByTestId('guided-generate').isDisabled());
      await capture('automatic-amazon-failure');
      const explicit = page.waitForResponse(r => r.url() === `${base}/api/research/search` && r.request().method() === 'POST' && r.request().postDataJSON()?.source === 'official_public', { timeout: 60000 });
      await page.getByRole('button', { name: '改用官方公开商品参考', exact: true }).click();
      const response = await explicit; report.research = await response.json(); save();
      assert.equal(response.status(), 200, JSON.stringify(report.research));
      assert.equal(report.research.provider, 'official-public');
      assert.ok(report.research.items.every(i => i.asin === null && i.reference_id));
      report.checks.push('blocked_amazon_preserved_then_explicit_real_official_source');
    } else report.research = await searched.json();
    await page.getByLabel('确认商品材质', { exact: true }).fill('100% cotton');
    await capture('automatic-confirm'); await submit('automatic');
  }
  assert.deepEqual(report.page_errors, []);
  report.completed_at = new Date().toISOString();
  report.checks.push('desktop_mobile_no_overflow_or_page_errors'); save();
  console.log(JSON.stringify({ report: file, checks: report.checks, records: report.records.map(r => ({ listing_id: r.listing_id, version: r.version, issues: r.review.issues.length, request_id: r.trace.provider_request_id })) }));
} catch (error) {
  report.failed_at = new Date().toISOString(); report.failure = { message: error.message, code: error.code || null }; save();
  await page.screenshot({ path: path.join(state.directory, `guided-failure-${Date.now()}.png`), fullPage: true }).catch(() => {}); throw error;
} finally { await browser.close(); }
