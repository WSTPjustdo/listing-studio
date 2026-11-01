// Real W101 regression acceptance. This script makes paid model calls only with --real-api.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import { chromium } from '@playwright/test';

if (!process.argv.includes('--real-api')) throw new Error('Use --real-api to authorize real paid DeepSeek calls; no simulated fallback is available.');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `${name} requires a value.`);
  return process.argv[index + 1];
};
const base = arg('--base-url', 'http://127.0.0.1:8788').replace(/\/+$/, '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Run against the isolated local real workbench.');
const directory = resolve(arg('--output-dir', `.runtime/live-bugfix-${Date.now()}`));
const runtimeRelative = relative(resolve('.runtime'), directory);
assert.ok(runtimeRelative && runtimeRelative !== '..' && !runtimeRelative.startsWith(`..\\`) && !runtimeRelative.startsWith('../') && !isAbsolute(runtimeRelative), 'Detailed acceptance output must stay inside .runtime.');
mkdirSync(directory, { recursive: true });
const reportFile = resolve(directory, 'report.json');
const report = {
  started_at: new Date().toISOString(), base, source_url: 'https://westfordmill.com/products/w101',
  evidence_type: 'live_official_W101_and_real_DeepSeek', steps: [], checks: [], records: [], failures: [], limitations: [],
  notice: 'Official public product, not merchant inventory. No synthetic products, fake SKU, simulated responses, or assumed publication status.',
};
const save = () => writeFileSync(reportFile, JSON.stringify(report, null, 2));
let activeRun = null;
let telemetryBefore = null;
let browser = null;
const pageErrors = [];

async function request(path, body, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(400000),
  });
  const data = await response.json();
  if (response.status !== expected) {
    const error = new Error(`${path}: HTTP ${response.status}: ${data.error?.message || 'Unexpected response'}`);
    error.details = { status: response.status, response: data };
    throw error;
  }
  return data;
}

const fields = (content) => new Map([
  ['content.title', content.title], ['content.item_highlights', content.item_highlights],
  ...content.bullet_points.map(point => [`content.bullet_points.${point.id}`, point.text]),
  ['content.description', content.description],
]);
function assertScope(before, after, allowed, requireChange = true) {
  assert.deepEqual(after.bullet_points.map(point => point.id), before.bullet_points.map(point => point.id), 'Stable bullet IDs and ordering must be preserved.');
  const oldFields = fields(before), newFields = fields(after);
  const changed = [...oldFields.keys()].filter(key => oldFields.get(key) !== newFields.get(key));
  for (const key of oldFields.keys()) if (!allowed.includes(key)) assert.equal(newFields.get(key), oldFields.get(key), `Unauthorized change to ${key}`);
  if (requireChange) assert.ok(changed.length, `Model did not change the requested field ${allowed.join(', ')}; recheck alone does not satisfy a revision.`);
  return changed;
}
function assertTrace(trace) {
  assert.equal(trace.actual_model_call, true);
  assert.ok(trace.provider_request_id, 'Actual provider request ID is required.');
  assert.match(trace.model || '', /^deepseek/i, 'Actual response must identify DeepSeek.');
  assert.ok(Number.isFinite(trace.elapsed_ms));
  // Missing usage stays unknown in the evidence; it must never be replaced with an estimate.
  if (!trace.usage) report.limitations.push(`Usage unknown for request ${trace.provider_request_id}`);
}
function assertChineseCotton(record) {
  assert.match(record.product_snapshot?.material?.value || '', /100(?:[.,]0+)?\s*%\s*棉/, 'This regression requires the actual Chinese material fact 100% 棉.');
  assert.match([...fields(record.content).values()].join('\n'), /\bcotton\b/i, 'Actual English copy must still describe cotton.');
  const falseConflicts = (record.review.issues || []).filter(issue =>
    issue.method === 'deterministic_structured_facts' && /里没有棉|不含棉/.test(issue.reason || ''));
  assert.deepEqual(falseConflicts, [], 'Chinese cotton must not produce a deterministic missing-cotton conflict. Real model findings remain in the report.');
}
async function completedVersion(label, queued, previous, previousVersions, allowed) {
  activeRun = queued.run_id;
  const started = Date.now();
  const timeout = Math.max(300000, (report.config.timeout_ms || 120000) * 3 + 30000);
  for (;;) {
    const status = await request(`/api/runs/${queued.run_id}`);
    if (status.status === 'failed') {
      report.failures.push({ label, run: status }); save();
      throw new Error(`${label}: ${status.error?.code}: ${status.error?.message}`);
    }
    if (status.status === 'succeeded') {
      const versions = await request(`/api/listings/${previous.listing_id}/versions`);
      const record = versions.at(-1);
      report.records.push(record); save(); // Retain actual output even when a regression assertion fails.
      assert.equal(record.listing_id, previous.listing_id);
      assert.equal(record.version, previous.version + 1);
      assert.equal(record.parent_version, previous.version);
      assert.equal(versions.length, previousVersions.length + 1);
      assert.deepEqual(versions.slice(0, previousVersions.length), previousVersions, 'Earlier versions must remain byte-equivalent JSON records.');
      assertTrace(record.trace);
      assertChineseCotton(record);
      const changes = assertScope(previous.content, record.content, allowed);
      report.steps.push({ label, status: 'succeeded', listing_id: record.listing_id, version: record.version,
        elapsed_ms: Date.now() - started, changed_fields: changes, trace: record.trace,
        remaining: { issues: record.review.issues, missing_data: record.review.missing_data, checks: record.review.checks.filter(check => check.state === 'not_checked') } });
      report.checks.push(`${label}:version_continuity_old_versions_and_field_scope_preserved`);
      activeRun = null; save();
      console.log(JSON.stringify({ stage: label, status: 'succeeded', version: record.version, request_id: record.trace.provider_request_id, model: record.trace.model, elapsed_ms: record.trace.elapsed_ms, usage: record.trace.usage || null, remaining_issues: record.review.issues.length }));
      return record;
    }
    if (Date.now() - started > timeout) throw new Error(`${label}: deadline exceeded; server execution state is unknown, no replay was sent.`);
    await delay(750);
  }
}

async function applyPatch(previous) {
  const available = (previous.patches || []).filter(patch => patch.method === 'model_assisted' && patch.expected_before !== patch.replacement && fields(previous.content).get(patch.field_path) === patch.expected_before);
  if (!available.length) {
    report.limitations.push('No existing non-no-op model-assisted repair suggestion on the selected latest genuine W101 model record. The apply-and-recheck button was not exercised; no suggestion was fabricated. Legacy local-template suggestions remain disabled.');
    save(); return previous;
  }
  const patch = available.find(item => item.method === 'model_assisted') || available[0];
  report.applied_patch = { patch_id: patch.patch_id, field_path: patch.field_path, method: patch.method, origin: 'existing_genuine_model_record', requires_real_model_recheck: true };
  save();
  assert.equal(fields(previous.content).get(patch.field_path), patch.expected_before, 'Existing patch must still refer to the exact latest original.');
  assert.notEqual(patch.expected_before, patch.replacement, 'A no-op patch does not verify repair.');
  const versions = await request(`/api/listings/${previous.listing_id}/versions`);
  let queued;
  if (process.argv.includes('--api-patch')) {
    queued = await request(`/api/listings/${previous.listing_id}/revisions`, { kind: 'patch', base_version: previous.version, patch_ids: [patch.patch_id], request_id: randomUUID() }, 202);
    report.limitations.push('Repair suggestion applied through the API (--api-patch); browser button behavior is outside this run.');
  } else {
    const executablePath = arg('--browser-executable', undefined);
    browser = await chromium.launch(executablePath ? { executablePath } : { channel: process.platform === 'win32' ? 'msedge' : undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(base);
    await page.getByRole('button', { name: '我的结果', exact: true }).click();
    await page.locator(`[data-listing-id="${previous.listing_id}"]`).click();
    if (await page.getByTestId('guided-step-result').count()) await page.getByRole('button', { name: '处理问题与局部改稿', exact: true }).click();
    await page.getByRole('button', { name: /^检查与依据/ }).click();
    await page.locator(`.repair-section .patch-choice[data-patch-id="${patch.patch_id}"] input[type="checkbox"]`).check();
    await page.locator('.repair-section').getByRole('button', { name: /^预览/ }).click();
    await page.screenshot({ path: resolve(directory, 'apply-preview.png'), fullPage: true });
    const responsePromise = page.waitForResponse(response => response.url() === `${base}/api/listings/${previous.listing_id}/revisions` && response.request().method() === 'POST');
    await page.getByRole('button', { name: '应用并重新检查', exact: true }).click();
    const response = await responsePromise;
    const body = await response.json();
    assert.equal(response.status(), 202, JSON.stringify(body));
    const submitted = response.request().postDataJSON();
    assert.equal(submitted.kind, 'patch');
    assert.deepEqual(submitted.patch_ids, [patch.patch_id]);
    queued = body;
    const record = await completedVersion('browser_apply_and_recheck', queued, previous, versions, [patch.field_path]);
    assert.equal(fields(record.content).get(patch.field_path), patch.replacement);
    await page.waitForFunction(version => document.querySelector('.version-badge')?.textContent?.trim() === `V${version}`, record.version, { timeout: 15000 });
    await page.screenshot({ path: resolve(directory, 'apply-completed.png'), fullPage: true });
    assert.deepEqual(pageErrors, []);
    report.checks.push('actual_browser_apply_and_recheck_click_created_new_version'); save();
    return record;
  }
  const record = await completedVersion('api_apply_and_recheck', queued, previous, versions, [patch.field_path]);
  assert.equal(fields(record.content).get(patch.field_path), patch.replacement);
  return record;
}

try {
  save();
  const bootstrap = await request('/api/bootstrap');
  const settings = bootstrap.settings;
  assert.equal(settings.provider, 'compatible');
  assert.equal(new URL(settings.base_url).hostname, 'api.deepseek.com', 'Only the existing real DeepSeek service is accepted.');
  assert.equal(settings.has_api_key, true);
  report.config = { provider: settings.provider, requested_model: settings.model, timeout_ms: settings.timeout_ms };
  telemetryBefore = (await request('/api/telemetry?limit=500')).calls;
  const candidates = bootstrap.listings.filter(record => !record.is_demo && record.trace?.actual_model_call && record.product_snapshot &&
    /\bW101\b/i.test([record.product_snapshot.reference_product_id, record.product_snapshot.name_zh, record.product_snapshot.product_id].join(' ')));
  const hasRepair = record => record.patches?.some(patch => patch.method === 'model_assisted' && patch.expected_before !== patch.replacement && fields(record.content).get(patch.field_path) === patch.expected_before);
  const original = candidates.find(hasRepair) || candidates[0];
  assert.ok(original, 'Seed the isolated real workbench with an existing genuine W101 model listing before running this acceptance.');
  report.original = original; save();
  assert.equal(original.marketplace || original.rule_pack_snapshot?.scope?.marketplace || 'US', 'US', 'This focused regression uses the existing English US W101 record.');
  assert.equal(original.language || 'en', 'en');
  assert.ok(original.content.bullet_points.length > 0, 'A genuine existing bullet is needed for the second local revision.');
  const product = bootstrap.products.find(item => item.product_id === original.product_snapshot.product_id && item.revision === original.product_snapshot.revision);
  assert.ok(product, 'Selected listing must use the current real product revision; do not silently substitute facts.');
  const official = await fetch(report.source_url, { signal: AbortSignal.timeout(30000) });
  assert.equal(official.status, 200);
  const $ = load(await official.text()); $('script,style,nav,footer').remove();
  const sourceText = $('body').text().replace(/\s+/g, ' ').trim();
  for (const snippet of ['100% Cotton', '140gsm', '38 x 42']) assert.ok(sourceText.includes(snippet), `Official W101 fact changed: ${snippet}`);
  assert.match(product.material?.value || '', /100(?:[.,]0+)?\s*%\s*(?:cotton|棉)/i);
  assertChineseCotton(original);
  report.source_checked_at = new Date().toISOString();
  report.source_excerpts = ['100% Cotton', '140gsm', '38 x 42'];
  report.product_ref = `${product.product_id}@${product.revision}`;
  report.checks.push('live_official_W101_source_and_existing_genuine_model_record_verified'); save();
  report.checks.push('actual_Chinese_cotton_fact_matches_English_copy_without_deterministic_missing_cotton_conflict');

  const started = Date.now();
  const reusePlanReport = arg('--reuse-plan-report', null);
  const plan = reusePlanReport ? JSON.parse(readFileSync(resolve(reusePlanReport), 'utf8')).plan
    : await request('/api/guided/plan', { mode: 'automatic', product_id: product.product_id, product_revision: product.revision,
      selected_terms: [], research_status: 'not_requested', language: 'en', marketplace: 'US', scope_confirmed: true }, 201);
  assert.equal(plan.product_id, product.product_id);
  assert.equal(plan.product_revision, product.revision);
  if (reusePlanReport) report.reused_real_plan = { report: resolve(reusePlanReport), request_id: plan.trace.provider_request_id,
    notice: 'Reused the successful genuine model plan from the retained previous attempt; no new plan inference was dispatched.' };
  report.plan = plan; save(); // A malformed real response remains evidence of failure.
  assertTrace(plan.trace);
  assert.ok(plan.optimized_prompt.includes('{{PRODUCT_FACTS}}'));
  assert.ok(plan.optimized_prompt.includes('{{KEYWORDS}}'));
  assert.ok(!/Westford\s*Mill|\bW101\b|\b140\s*(?:gsm|g\/m)|\b38\s*(?:cm|centimet)/i.test(plan.optimized_prompt), 'Reusable plan must not hardcode product facts.');
  report.steps.push({ label: 'real_automatic_writing_plan', status: 'succeeded', elapsed_ms: Date.now() - started, trace: plan.trace });
  report.checks.push('actual_automatic_writing_plan_saved_without_demo_fallback'); save();
  console.log(JSON.stringify({ stage: 'real_automatic_writing_plan', status: 'succeeded', request_id: plan.trace.provider_request_id, model: plan.trace.model, elapsed_ms: plan.trace.elapsed_ms, usage: plan.trace.usage || null }));

  let current = await applyPatch(original);
  for (const [label, field, instruction] of [
    ['round_1_title_revision', 'content.title', '只调整标题的表达和词序，写成简洁自然的英文商品标题。保留 Westford Mill、W101 和已写出的受支持材质事实；不要新增颜色、包装数量、环保、认证或性能。必须对标题做实际文字修改；其它字段与卖点 ID 原样保留。'],
    ['round_2_bullet_revision', `content.bullet_points.${current.content.bullet_points[0].id}`, '只改第一条卖点的句式，使用不同于原句的自然英文表达，说明已有依据的材质或产品事实。100% cotton 表示棉含量为百分之百，不得误读为0%或不含棉；不要新增未核实的承重、包装数量、认证、环保或性能。必须对该卖点做实际文字修改；标题、其它卖点、亮点和描述原样保留。'],
  ]) {
    const versions = await request(`/api/listings/${current.listing_id}/versions`);
    const queued = await request(`/api/listings/${current.listing_id}/revisions`, { kind: 'instruction', base_version: current.version,
      allowed_fields: [field], instruction, request_id: randomUUID() }, 202);
    current = await completedVersion(label, queued, current, versions, [field]);
  }
  report.final_record = current;
  report.completed_at = new Date().toISOString();
  report.acceptance = 'real_plan_and_two_actual_local_revisions_completed_quality_requires_review';
} catch (error) {
  report.failures.push({ at: new Date().toISOString(), message: error.message, details: error.details || null });
  if (activeRun) {
    try { report.active_run_on_failure = await request(`/api/runs/${activeRun}`); }
    catch (readError) { report.active_run_state = { state: 'unknown', reason: readError.message }; }
  }
  report.failed_at = new Date().toISOString();
  throw error;
} finally {
  try {
    if (telemetryBefore) {
      const calls = (await request('/api/telemetry?limit=500')).calls;
      const known = new Set(telemetryBefore.map(call => JSON.stringify(call)));
      report.new_model_calls = calls.filter(call => !known.has(JSON.stringify(call)));
    }
  } catch (error) { report.limitations.push(`Cannot read final model call ledger: ${error.message}`); }
  report.browser_page_errors = pageErrors;
  save();
  if (browser) await browser.close();
  console.log(JSON.stringify({ report: reportFile, acceptance: report.acceptance || 'failed', failures: report.failures.length, limitations: report.limitations }));
}
