// Actual local workbench and freshly fetched FTC text. No product or model mocks.
// Storage failures below are isolated engineering fault checks, not model acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { load } from 'cheerio';
import { chromium, expect } from '@playwright/test';

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `${name} needs a value.`);
  return process.argv[index + 1];
};
const base = argument('--base-url', 'http://127.0.0.1:8787').replace(/\/+$/, '');
const origin = new URL(base);
assert.ok(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname));
const directory = resolve(argument('--output-dir', '.runtime/rule-monitor-sync-20261031/browser'));
const relativeDirectory = relative(resolve('.runtime'), directory);
assert.ok(relativeDirectory && !isAbsolute(relativeDirectory) && !/^\.\.(?:[\\/]|$)/.test(relativeDirectory), 'Detailed evidence must stay inside .runtime.');
mkdirSync(directory, { recursive: true });
const storageKey = 'listing-guardian-rule-monitor-v1';
const sourceUrl = 'https://www.ftc.gov/business-guidance/resources/environmental-claims-summary-green-guides';
const report = {
  started_at: new Date().toISOString(), base_url: base,
  evidence_type: 'actual_browser_and_live_official_FTC_source',
  notice: 'A real FTC guide is registered only as a source-check record, with policy change unverified. Publication and effective dates remain unknown. The isolated browser does not alter the user browser or server rules. Existing real DeepSeek output is read only; this script does not perform model inference.',
  live_source: null, checks: [], engineering_checks: [], screenshots: [], overflow: [],
  page_errors: [], mutation_requests: [], failures: [],
  model_calls: [], new_model_calls: 0, new_tokens: 0,
};
const reportPath = resolve(directory, 'browser-acceptance.json');
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const backendHash = data => hash({ products: data.products, listings: data.listings, sources: data.sources, rules: data.rules, rule_pack_versions: data.rule_pack_versions });
let browser;
let currentPhase = 'live_source';

async function api(route) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `${route}: HTTP ${response.status}`);
  return response.json();
}
function observe(page, label) {
  page.on('pageerror', error => { report.page_errors.push({ context: label, message: error.message }); save(); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === origin.origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      report.mutation_requests.push({ context: label, method: request.method(), path: url.pathname }); save();
    }
  });
}
async function openMonitor(page) {
  await page.goto(base);
  await page.getByTestId('two-path-home').waitFor();
  const more = page.getByRole('button', { name: '更多功能', exact: true });
  if (await more.getAttribute('aria-expanded') !== 'true') await more.click();
  await page.getByRole('button', { name: 'Amazon 规则监测', exact: true }).click();
  await page.locator('.rule-monitor-page').waitFor();
}
async function capture(page, label, selector = '.rule-monitor-page') {
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    if (width <= 760) await expect(page.getByRole('button', { name: '更多功能', exact: true })).toHaveAttribute('aria-expanded', 'false');
    if (selector === '.rule-monitor-page') await page.evaluate(() => scrollTo(0, 0));
    else {
      await page.locator(selector).evaluate(element => element.scrollIntoView({ block: 'start' }));
      await page.evaluate(() => scrollBy(0, -80));
    }
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
    report.overflow.push({ label, ...dimensions }); save();
    assert.ok(dimensions.scroll <= dimensions.viewport + 1, `${label}: ${dimensions.scroll}px exceeds ${width}px viewport`);
    const filename = `${label}-${width}.png`;
    await page.screenshot({ path: resolve(directory, filename), animations: 'disabled', fullPage: false });
    report.screenshots.push(filename); save();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}
async function fillRealSource(page, source) {
  await page.getByRole('button', { name: '登记规则变化', exact: true }).click();
  const form = page.locator('.rm-form');
  await form.getByLabel('规则标题', { exact: true }).fill('FTC Green Guides 官方指南来源核对（政策变化待核实）');
  await form.getByLabel('适用站点', { exact: true }).selectOption('US');
  await form.getByLabel('规则类别', { exact: true }).selectOption('环保/性能/认证宣称');
  await form.getByLabel('状态', { exact: true }).selectOption('待核实');
  await form.getByLabel('变化内容', { exact: true }).fill(`本次仅核对实时官方指南原文，不宣称发现了新政策。官方原文：${report.live_source.excerpt}`);
  await form.locator('textarea').nth(1).fill('环保宣称需回看官方适用范围与证据；是否构成新的政策变化、发布日期与生效日期均待核实。本记录不会自动修改审核规则包。');
  await form.getByLabel('官方来源链接', { exact: true }).fill(source);
  return form;
}

try {
  save();
  const sourceStarted = Date.now();
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `Official FTC source: HTTP ${response.status}; no offline substitute.`);
  assert.ok(new URL(response.url).hostname === 'www.ftc.gov');
  const html = await response.text();
  const $ = load(html);
  $('script,style,nav,footer,header').remove();
  const sourceTitle = $('h1').text().replace(/\s+/g, ' ').trim();
  assert.match(sourceTitle, /Environmental Claims.*Green Guides/i);
  const excerpt = $('main p').map((_, element) => $(element).text().replace(/\s+/g, ' ').trim()).get().find(text => /Claiming.*recycled content.*deceptive/i.test(text));
  assert.ok(excerpt && excerpt.length > 50, 'Expected substantive FTC text was not found; no invented excerpt.');
  report.live_source = { url: sourceUrl, final_url: response.url, http_status: response.status, checked_at: new Date().toISOString(), elapsed_ms: Date.now() - sourceStarted, title: sourceTitle, excerpt, page_sha256: hash(html), policy_change: 'unverified', published_at: null, effective_at: null };
  report.checks.push('fresh_official_FTC_source_and_literal_excerpt'); save();

  currentPhase = 'workbench_baseline';
  const before = await api('/api/bootstrap');
  const telemetryBefore = await api('/api/telemetry?limit=500');
  assert.ok(['US', 'UK', 'DE', 'FR'].every(market => typeof before.rule_pack_versions?.[market] === 'string'));
  const realListing = before.listings.find(record => !record.is_demo && record.product_snapshot?.product_id === 'REAL-WESTFORD-W101' && record.trace?.actual_model_call && record.trace?.provider_request_id);
  assert.ok(realListing, 'Existing real DeepSeek W101 output is required; demo data is not acceptance.');
  report.existing_real_listing = { listing_id: realListing.listing_id, version: realListing.version, model: realListing.trace.model, request_id: realListing.trace.provider_request_id, elapsed_ms: realListing.trace.elapsed_ms, usage: realListing.trace.usage ?? null, reuse_notice: 'Existing real output read only; not a new model request.' };
  report.backend_before_sha256 = backendHash(before);
  report.rule_pack_versions = before.rule_pack_versions;
  const executablePath = argument('--browser-executable', undefined);
  browser = await chromium.launch(executablePath ? { executablePath } : { channel: process.platform === 'win32' ? 'msedge' : undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  observe(page, 'real_source_flow');
  currentPhase = 'monitor_entry';
  await openMonitor(page);
  await expect(page.getByRole('heading', { name: 'Amazon 规则监测', exact: true })).toBeVisible();
  for (const market of ['US', 'UK', 'DE', 'FR']) await expect(page.locator('.rule-monitor-page')).toContainText(`包 ${before.rule_pack_versions[market]}`);
  await expect(page.locator('.rm-plan')).not.toContainText('计划启用');
  await expect(page.locator('.rm-plan')).not.toContainText('每周监测计划已建立');
  await expect(page.locator('.rm-entry')).toHaveCount(0);
  await expect(page.locator('.rm-empty')).toContainText(/不会自动抓取/);
  const links = await page.locator('.rm-source').evaluateAll(elements => elements.map(element => ({ href: element.href, target: element.target, rel: element.rel })));
  assert.ok(links.length >= 5);
  for (const link of links) {
    assert.equal(new URL(link.href).protocol, 'https:');
    assert.equal(link.target, '_blank');
    assert.match(link.rel, /noreferrer/);
  }
  assert.ok(links.some(link => link.href === sourceUrl));
  report.checks.push('latest_navigation_opens_monitor', 'all_four_live_rule_pack_versions_visible', 'manual_schedule_and_empty_state_are_truthful', 'official_external_links_are_https');
  await capture(page, 'monitor-empty');

  currentPhase = 'register_actual_source';
  const form = await fillRealSource(page, sourceUrl);
  assert.equal(await form.getByLabel('发布日期', { exact: true }).inputValue(), '');
  assert.equal(await form.getByLabel('生效日期', { exact: true }).inputValue(), '');
  await capture(page, 'monitor-form', '.rm-form');
  await form.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(page.locator('.rm-entry')).toHaveCount(1);
  await expect(page.locator('.rm-entry .rm-status')).toHaveText('待核实');
  await expect(page.locator('.rm-entry')).toContainText(excerpt);
  await expect(page.locator('.rm-entry')).toContainText('发布日期：未注明');
  await expect(page.locator('.rm-entry')).toContainText('生效日期：未注明');
  assert.equal(await page.locator('.rm-entry a').getAttribute('href'), sourceUrl);
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, '待核实');
  assert.equal(saved[0].source, sourceUrl);
  assert.ok(saved[0].summary.includes(excerpt));
  assert.equal(saved[0].publishedAt, '');
  assert.equal(saved[0].effectiveAt, '');
  report.registered_record = saved[0];
  report.checks.push('real_official_excerpt_registered_as_unverified', 'unknown_policy_dates_remain_blank', 'entry_and_source_persist_in_isolated_localStorage'); save();
  await capture(page, 'monitor-registered', '.rm-log');

  currentPhase = 'reload_filter_delete';
  await openMonitor(page);
  await expect(page.locator('.rm-entry')).toHaveCount(1);
  assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey), saved);
  for (const [label, expectedCount] of [['美国 US', 1], ['英国 UK', 0], ['德国 DE', 0], ['法国 FR', 0], ['全部站点', 1]]) {
    await page.locator('.rm-tabs').getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('.rm-entry')).toHaveCount(expectedCount);
  }
  for (const [status, expectedCount] of [['已生效', 0], ['即将生效', 0], ['政策澄清', 0], ['待核实', 1], ['全部状态', 1]]) {
    await page.locator('.rm-status-filter select').selectOption(status);
    await expect(page.locator('.rm-entry')).toHaveCount(expectedCount);
  }
  report.checks.push('reload_preserves_original_record', 'all_four_market_filters', 'all_status_filters');
  page.on('dialog', dialog => dialog.accept());
  await page.locator('.rm-entry').getByRole('button', { name: /^删除记录：/ }).click();
  await expect(page.locator('.rm-entry')).toHaveCount(0);
  await openMonitor(page);
  await expect(page.locator('.rm-entry')).toHaveCount(0);
  assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey), []);
  report.checks.push('deletion_persists_after_reload');

  currentPhase = 'existing_real_result';
  await page.getByRole('button', { name: '我的结果', exact: true }).click();
  await page.locator(`[data-listing-id="${realListing.listing_id}"]`).click();
  if (await page.getByTestId('guided-step-result').count()) await page.getByRole('button', { name: '处理问题与局部改稿', exact: true }).click();
  await expect(page.locator('.version-badge')).toHaveText(`V${realListing.version}`);
  report.checks.push('existing_real_DeepSeek_W101_result_still_opens');
  await page.setViewportSize({ width: 390, height: 1000 });
  await openMonitor(page);
  await expect(page.getByRole('button', { name: '更多功能', exact: true })).toHaveAttribute('aria-expanded', 'false');
  report.checks.push('mobile_monitor_navigation_closes_the_function_menu');
  await context.close();

  currentPhase = 'engineering_invalid_url';
  const invalidContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const invalidPage = await invalidContext.newPage();
  observe(invalidPage, 'engineering_invalid_url');
  await openMonitor(invalidPage);
  for (const invalidUrl of ['javascript:alert(1)', 'https://www.ftc.gov@untrusted.example/policy']) {
    if (await invalidPage.locator('.rm-form').count()) await invalidPage.locator('.rm-form').getByRole('button', { name: '关闭', exact: true }).click();
    const invalidForm = await fillRealSource(invalidPage, invalidUrl);
    const saveButton = invalidForm.getByRole('button', { name: '保存记录', exact: true });
    if (await saveButton.isEnabled()) await saveButton.click();
    await expect(invalidPage.locator('.rm-entry')).toHaveCount(0);
  }
  report.engineering_checks.push('unsafe_and_credential_bearing_urls_cannot_be_saved');
  await invalidContext.close();

  currentPhase = 'engineering_corrupt_storage';
  for (const corruptRaw of ['{', '{"unexpected":"object"}']) {
    const corruptContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await corruptContext.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: storageKey, value: corruptRaw });
    const corruptPage = await corruptContext.newPage();
    observe(corruptPage, 'engineering_corrupt_storage');
    await openMonitor(corruptPage);
    await expect(corruptPage.locator('.rm-entry')).toHaveCount(0);
    assert.equal(await corruptPage.evaluate(key => localStorage.getItem(key), storageKey), corruptRaw, 'Damaged storage must not be silently overwritten.');
    await expect(corruptPage.locator('.rule-monitor-page')).toContainText(/(?:损坏|读取失败|无法读取|格式|恢复)/);
    await corruptContext.close();
  }
  report.engineering_checks.push('malformed_json_and_invalid_shape_do_not_crash_or_overwrite_original_storage');

  currentPhase = 'engineering_storage_unavailable';
  const deniedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await deniedContext.addInitScript(key => {
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Intentional isolated storage failure', 'QuotaExceededError');
      return originalSet.call(this, name, value);
    };
  }, storageKey);
  const deniedPage = await deniedContext.newPage();
  observe(deniedPage, 'engineering_storage_unavailable');
  await openMonitor(deniedPage);
  const deniedForm = await fillRealSource(deniedPage, sourceUrl);
  const deniedSave = deniedForm.getByRole('button', { name: '保存记录', exact: true });
  if (await deniedSave.isEnabled()) await deniedSave.click();
  await expect(deniedPage.locator('.rm-saved')).toHaveCount(0);
  assert.equal(await deniedPage.evaluate(key => localStorage.getItem(key), storageKey), null);
  await expect(deniedPage.locator('.rule-monitor-page')).toContainText(/(?:保存失败|无法保存|存储|空间)/);
  report.engineering_checks.push('storage_write_failure_is_visible_and_never_reported_as_saved');
  await deniedContext.close();

  currentPhase = 'backend_preservation';
  const after = await api('/api/bootstrap');
  const telemetryAfter = await api('/api/telemetry?limit=500');
  report.backend_after_sha256 = backendHash(after);
  assert.equal(report.backend_after_sha256, report.backend_before_sha256, 'Manual browser records must not alter server products, sources, copy or rule packs.');
  assert.deepEqual(telemetryAfter.calls, telemetryBefore.calls, 'Unexpected model activity: run this script without concurrent inference on the same server.');
  assert.deepEqual(report.mutation_requests, []);
  assert.deepEqual(report.page_errors, []);
  report.checks.push('server_products_copy_sources_and_rules_unchanged', 'no_server_mutation_or_model_call', 'no_browser_page_errors');
  report.completed_at = new Date().toISOString();
  report.acceptance = 'real_source_browser_flow_completed_engineering_boundaries_checked';
  save();
  console.log(JSON.stringify({ report: reportPath, checks: report.checks.length, engineering_checks: report.engineering_checks.length, screenshots: report.screenshots, new_model_calls: 0, new_tokens: 0 }));
} catch (error) {
  report.failures.push({ phase: currentPhase, at: new Date().toISOString(), name: error.name, message: error.message });
  report.acceptance = 'failed_without_mock_or_demo_fallback';
  save();
  console.error(JSON.stringify({ report: reportPath, phase: currentPhase, error: error.message }));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
