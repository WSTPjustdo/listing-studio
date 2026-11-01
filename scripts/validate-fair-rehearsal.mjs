// Validate the actual saved case and real offline page; no model requests or response substitution.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';
import { flattenContent } from '../server/domain.mjs';

const directory = resolve('reports/fair-rehearsal-2026-11-01');
const data = JSON.parse(readFileSync(resolve(directory, 'case.json'), 'utf8'));
const source = JSON.parse(readFileSync(resolve(directory, 'product-source.json'), 'utf8'));
const checks = [];
function check(label, condition) { assert.ok(condition, label); checks.push(label); }
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
check('official_source_actual_http_200', source.source.http_status === 200 && source.source.response_sha256?.length === 64);
check('no_real_merchant_data_assumed', source.business_context.merchant_data_available === false && source.business_context.merchant_sku === null);
check('successful_independent_fact_recheck', data.acceptance.status === 'passed_within_fact_scope' && data.recheck.trace.actual_model_call === true && data.recheck.result.review.issues.length === 0);
check('final_copy_exactly_bound_to_recheck', data.acceptance.final_content_sha256 === sha(data.repaired.content) && data.recheck.content_sha256 === sha(data.repaired.content));
check('independent_request_and_recorded_usage', data.repaired.trace.provider_request_id !== data.recheck.trace.provider_request_id && data.recheck.trace.usage.total_tokens > 0);
check('limited_scope_checks_completed_and_outside_unchecked', ['BTL_FACT_MATCH','BTL_CLAIM_SCOPE','BTL_UNSUPPORTED'].every(id => data.recheck.result.review.checks.some(x => x.rule_id === id && x.state === 'pass')) && data.recheck.result.review.checks.some(x => x.rule_id === 'BTL_OUTSIDE_SCOPE' && x.state === 'not_checked'));
check('real_format_failures_preserved', data.calls.some(x => x.outcome === 'failed' && x.error_code === 'MODEL_INVALID_JSON' && x.request_id));
check('manual_model_miss_and_prior_audit_preserved', data.material_precision_correction?.model_missed_finding && data.material_precision_correction.status === 'corrected_and_independently_rechecked' && data.recheck_history?.length > 0 && data.acceptance_history?.some(x => x.superseded));
check('final_text_file_is_final_version', readFileSync(resolve(directory, 'listing-en.txt'), 'utf8').trim() === flattenContent(data.repaired.content).map(x => x.text).filter(Boolean).join('\n\n'));
for (const field of flattenContent(data.repaired.content)) check('no_injected_claims_in_final_' + field.path, !/48 hours|FDA certified|guaranteed health benefits|leak-proof in any condition/i.test(field.text));
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
const report = { checked_at: new Date().toISOString(), scope: '已保存真实结果的数据关联及离线展示交互；不发起新模型调用，不验证法规/上架。', model_calls: 0, checks, measurements: [], screenshots: [] };
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, offline: true });
    const page = await context.newPage();
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (/^https?:/.test(req.url())) external.push(req.url()); });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedEnglish = text; } } });
    });
    const started = performance.now();
    await page.goto(pathToFileURL(resolve(directory, 'index.html')).href, { waitUntil: 'load' });
    await page.locator('#facts .fact-row').first().waitFor();
    const elapsed = Math.round((performance.now() - started) * 10) / 10;
    report.measurements.push({ viewport, local_file_ready_ms: elapsed, html_bytes: Buffer.byteLength(readFileSync(resolve(directory, 'index.html'))), network: 'offline', note: '本机已有浏览器，已保存页面单次加载，不代表在线模型或工作台首装耗时。' });
    check(`offline_page_load_${viewport.width}`, await page.locator('h1').innerText() === '保温杯 · 模拟商家演练');
    check(`simulation_notice_visible_${viewport.width}`, (await page.locator('header').innerText()).includes('模拟业务流程'));
    check(`five_steps_and_audience_tasks_${viewport.width}`, await page.locator('.step-tab').count() === 5 && await page.locator('.stage .task').count() === 5);
    for (let index = 0; index < 5; index++) {
      await page.locator(`.step-tab[data-step="${index}"]`).click();
      check(`only_current_step_visible_${viewport.width}_${index}`, await page.locator('.stage:visible').count() === 1 && await page.locator(`#stage-${index}`).isVisible());
      check(`no_horizontal_overflow_${viewport.width}_${index}`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      check(`next_action_always_in_viewport_${viewport.width}_${index}`, await page.locator('#next').evaluate(button => { const r = button.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth; }));
      if (index === 0) {
        check(`product_capacity_and_unknowns_${viewport.width}`, (await page.locator('#facts').innerText()).includes('475') && await page.locator('#unknown-facts li').count() === source.unknown_facts.length);
        if (viewport.width === 1440) { const name = 'product-desktop.png'; await page.screenshot({ path: resolve(directory, name), fullPage: true }); report.screenshots.push(name); }
      }
      if (index === 1) {
        check(`prepared_english_is_final_copy_${viewport.width}`, (await page.locator('#generated-listing .listing-title').innerText()) === data.repaired.content.title && await page.locator('#generated-listing .bullet').count() === 5);
        await page.locator('#copy-generated').click();
        const copied = await page.evaluate(() => window.__copiedEnglish);
        check(`copy_has_real_newlines_and_correct_final_english_${viewport.width}`, copied === readFileSync(resolve(directory, 'listing-en.txt'), 'utf8').trim());
      }
      if (index === 2) {
        check(`risky_draft_marked_and_review_hidden_${viewport.width}`, (await page.locator('#stage-2 .notice').innerText()).includes('人工') && !(await page.locator('#risky-review').isVisible()));
        await page.locator('#reveal').click();
        check(`revealed_real_review_${viewport.width}`, await page.locator('#risky-review .issue').count() === data.risky.review.result.review.issues.length && (await page.locator('#risky-review').innerText()).includes(data.risky.review.trace.provider_request_id));
        if (viewport.width === 1440) { await page.locator('#toast').waitFor({ state: 'hidden' }); const name = 'risk-desktop.png'; await page.screenshot({ path: resolve(directory, name), fullPage: true }); report.screenshots.push(name); }
      }
      if (index === 3) {
        const before = new Map(flattenContent(data.risky.content).map(x => [x.path, x.text]));
        const changed = flattenContent(data.repaired.content).filter(x => before.get(x.path) !== x.text);
        check(`all_changed_fields_shown_${viewport.width}`, await page.locator('#diffs .diff-row').count() === changed.length);
        check(`manual_miss_disclosed_${viewport.width}`, (await page.locator('#precision-correction').innerText()).includes('模型漏检'));
      }
      if (index === 4) {
        check(`real_final_recheck_and_scope_visible_${viewport.width}`, (await page.locator('#acceptance-banner').innerText()).includes('已通过') && (await page.locator('#recheck-review').innerText()).includes(data.recheck.trace.provider_request_id) && (await page.locator('#limitations').innerText()).includes('食品接触'));
        check(`all_request_records_present_${viewport.width}`, await page.locator('#calls .call-row').count() === data.calls.length);
        if (viewport.width === 390) { await page.locator('#toast').waitFor({ state: 'hidden' }); const name = 'recheck-mobile.png'; await page.screenshot({ path: resolve(directory, name), fullPage: true }); report.screenshots.push(name); }
      }
    }
    await page.locator('#restart').click();
    check(`restart_resets_review_${viewport.width}`, await page.locator('#stage-0').isVisible() && !(await page.locator('#risky-review').isVisible()) && await page.locator('#reveal').getAttribute('aria-expanded') === 'false');
    await page.keyboard.press('3');
    check(`keyboard_jump_${viewport.width}`, await page.locator('#stage-2').isVisible());
    await page.keyboard.press('ArrowRight');
    check(`keyboard_next_${viewport.width}`, await page.locator('#stage-3').isVisible());
    await page.emulateMedia({ media: 'print' });
    check(`print_all_five_steps_without_old_draft_${viewport.width}`, await page.locator('.stage:visible').count() === 5 && !(await page.locator('.history-card').isVisible()));
    check(`no_page_errors_${viewport.width}`, errors.length === 0);
    check(`no_external_requests_${viewport.width}`, external.length === 0);
    await context.close();
  }
  report.status = 'passed';
  report.total_checks = checks.length;
  writeFileSync(resolve(directory, 'page-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: checks.length, model_calls: 0, measurements: report.measurements, screenshots: report.screenshots }));
} catch (error) {
  report.status = 'failed'; report.error = error.message;
  writeFileSync(resolve(directory, 'page-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  throw error;
} finally { await browser.close(); }
