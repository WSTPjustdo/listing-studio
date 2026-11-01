// Real W101 public facts + the existing local model service. This script never
// substitutes model responses or products; it stops and preserves real failures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { rulePackFor } from '../server/store.mjs';

if (!process.argv.includes('--real-api')) throw new Error('Use --real-api to authorize paid inference.');
const argument = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const base = argument('--base-url', 'http://127.0.0.1:8788').replace(/\/$/, '');
const expected = {
  US: { language: 'en', locale: 'en-US', rules: 15, gpsr: null },
  DE: { language: 'de', locale: 'de-DE', rules: 19, gpsr: 'DE-GPSR-19' },
  UK: { language: 'en', locale: 'en-GB', rules: 16, gpsr: 'UK-GPSR-01' },
  FR: { language: 'fr', locale: 'fr-FR', rules: 16, gpsr: 'FR-GPSR-01' },
};
const markets = [...new Set(argument('--markets', 'DE,UK,FR').split(',').map(value => value.trim().toUpperCase()).filter(Boolean))];
assert.ok(markets.length && markets.every(market => Object.hasOwn(expected, market)), '--markets must contain US, DE, UK or FR.');
const state = JSON.parse(fs.readFileSync('.runtime/live-intake-current.json', 'utf8'));
assert.equal(state.product_id, 'REAL-WESTFORD-W101', 'Prepare the actual official W101 product first.');
assert.equal(state.product_revision, 1, 'This acceptance uses the unchanged prepared W101 revision 1.');
assert.ok(state.sources.some(source => source.model === 'W101' && source.http_status === 200 && source.checked_at), 'A real checked W101 source is required.');
const file = path.join(state.directory, 'teammate-e-api.json');
const report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
  started_at: new Date().toISOString(), base, checks: [], plans: [], records: [], runs: [], failures: [], executions: [], exports: [],
  input_provenance: 'Real official Westford Mill W101 public product facts. Prompt quotes user-provided interview requirements; no private merchant template, SKU, address or inventory is fabricated.',
};
// Repeated explicit runs append evidence. Earlier failures and records are retained.
const execution = { started_at: new Date().toISOString(), markets, completed_markets: [] };
report.executions ||= [];
report.executions.push(execution);
const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2));
const phase = (marketplace, operation) => { report.phase = { marketplace, operation, at: new Date().toISOString() }; save(); };
async function request(route, data) {
  const response = await fetch(`${base}${route}`, {
    ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(data === undefined ? 20000 : 180000),
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = { unparsed_response: raw.slice(0, 2000) }; }
  return { status: response.status, body };
}
async function generate(marketplace, plan) {
  phase(marketplace, 'generate');
  const queued = await request('/api/guided/generate', { plan_id: plan.id, product_id: state.product_id, product_revision: state.product_revision, scope_confirmed: true });
  if (queued.status !== 202) report.failures.push({ at: new Date().toISOString(), marketplace, operation: 'generate', response: queued });
  save();
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  report.runs.push({ marketplace, ...queued.body }); save();
  const started = Date.now();
  let lastStage;
  while (Date.now() - started < 420000) {
    const polled = await request(`/api/runs/${queued.body.run_id}`);
    assert.equal(polled.status, 200, JSON.stringify(polled.body));
    const run = polled.body;
    if (run.stage !== lastStage) { lastStage = run.stage; report.phase = { marketplace, operation: 'poll', run_id: run.run_id, stage: run.stage, at: new Date().toISOString() }; save(); }
    if (run.status === 'failed') {
      report.failures.push({ at: new Date().toISOString(), marketplace, operation: 'run', run }); save();
      throw new Error(`${marketplace} real run failed: ${run.error?.code || 'unknown'}: ${run.error?.message || 'unknown'}`);
    }
    if (run.status === 'succeeded') {
      const versions = await request(`/api/listings/${queued.body.listing_id}/versions`);
      assert.equal(versions.status, 200);
      const record = versions.body.find(value => value.version === run.version);
      assert.ok(record, 'The actual saved version was not found.');
      report.records.push(record); save();
      return record;
    }
    await delay(750);
  }
  throw new Error(`${marketplace} real run deadline exceeded; no substitute result was generated.`);
}
function verifyRecord(marketplace, plan, record, product) {
  const scope = expected[marketplace];
  const pack = rulePackFor(marketplace);
  assert.equal(record.marketplace, marketplace);
  assert.equal(record.language, scope.language);
  assert.equal(record.locale, scope.locale);
  assert.equal(record.guided_plan.id, plan.id);
  assert.equal(record.guided_plan.marketplace, marketplace);
  assert.equal(record.guided_plan.language, scope.language);
  assert.equal(record.rule_pack_snapshot.rules.length, scope.rules);
  assert.equal(record.rule_pack_version, pack.rule_pack_version);
  assert.deepEqual(record.rule_pack_snapshot, pack);
  assert.deepEqual(record.product_snapshot, product, 'The model must not change or invent product facts, parties or SKU.');
  const supplied = new Map(record.source_snapshot.map(source => [source.source_id, source]));
  for (const source of pack.sources) assert.deepEqual(supplied.get(source.source_id), source, `Missing current source text: ${source.source_id}`);
  assert.ok(record.trace.actual_model_call && record.trace.provider_request_id && record.trace.model);
  assert.ok(record.trace.calls?.length >= 2, 'Generation must have a separate model audit.');
  assert.ok(record.trace.calls.every(call => call.actual_model_call && call.provider_request_id));
  assert.notEqual(record.trace.calls[0].provider_request_id, record.trace.calls.at(-1).provider_request_id);
  assert.equal(record.review.publication_readiness, 'not_verified');
  if (scope.gpsr) {
    const gpsr = record.review.checks.find(check => check.rule_id === scope.gpsr);
    assert.ok(gpsr, 'GPSR coverage must remain explicit.');
    assert.ok(!['pass', 'verified'].includes(gpsr.state), 'Unknown GPSR requirements cannot be verified.');
    assert.ok(!record.review.issues.some(issue => /^US-/.test(issue.rule_id)));
    assert.ok(!record.review.checks.some(check => /^US-/.test(check.rule_id)));
    assert.ok(!record.source_snapshot.some(source => /^FTCS-/.test(source.source_id)), 'US legal sources must not leak into a foreign-market request.');
  }
  report.checks.push({ marketplace, check: 'saved_market_locale_language_pack_sources_and_independent_audit', rules: scope.rules,
    plan_request_id: plan.trace.provider_request_id, audit_request_id: record.trace.provider_request_id,
    issues: record.review.issues.length, missing_data: record.review.missing_data,
    unchecked: record.review.checks.filter(check => ['not_checked', 'error'].includes(check.state)), elapsed_ms: record.trace.elapsed_ms, usage: record.trace.usage });
  save();
}
async function verifyExports(marketplace, plan, record) {
  phase(marketplace, 'exports');
  for (const format of ['json', 'txt', 'html']) {
    const response = await fetch(`${base}/api/listings/${record.listing_id}/export?version=${record.version}&format=${format}`, { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, `${marketplace} ${format} export`);
    const text = await response.text();
    assert.ok(text.includes(plan.id), `${format} lost the actual plan context`);
    if (format === 'json') assert.deepEqual(JSON.parse(text), record);
    if (format === 'txt') {
      assert.ok(text.includes(`Amazon ${marketplace}`), 'TXT must identify the saved market.');
      if (marketplace !== 'US') assert.ok(!text.includes('检查范围：Amazon US '), 'TXT must not relabel a foreign-market run as US.');
    }
    if (format === 'html' && marketplace !== 'US') {
      assert.ok(text.includes('当前站点及文案语言暂无匹配的历史聚合基线'));
      assert.ok(!text.includes('历史聚合样本写法对照（45'), 'Do not use a US sample baseline for another market.');
    }
    const filename = `teammate-e-${marketplace}-v${record.version}.${format}`;
    fs.writeFileSync(path.join(state.directory, filename), text);
    report.exports.push({ marketplace, listing_id: record.listing_id, version: record.version, format, filename, status: response.status }); save();
  }
  if (marketplace !== 'US') {
    const result = await request(`/api/listings/${record.listing_id}/benchmark?version=${record.version}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.supported, false);
    assert.equal(result.body.baseline, null);
    assert.deepEqual(result.body.facts, []);
    report.checks.push({ marketplace, check: 'non_us_benchmark_explicitly_unavailable', result: result.body }); save();
  }
  report.checks.push({ marketplace, check: 'json_txt_html_exports_preserve_scope_and_saved_version' }); save();
}
try {
  save();
  const products = await request('/api/products');
  assert.equal(products.status, 200, JSON.stringify(products.body));
  const product = products.body.find(value => value.product_id === state.product_id && value.revision === state.product_revision);
  assert.ok(product && !product.is_demo, 'The unchanged real W101 product is missing from this service.');
  report.product_snapshot = product; report.sources = state.sources; save();
  for (const marketplace of markets) {
    phase(marketplace, 'plan');
    console.log(JSON.stringify({ marketplace, phase: 'plan', status: 'calling_real_api' }));
    const started = Date.now();
    const response = await request('/api/guided/plan', { mode: 'improve', prompt: '禁止夸大、不能用medical claim、美式表达、不要堆砌', product_id: state.product_id,
      product_revision: state.product_revision, marketplace, language: expected[marketplace].language, research_status: 'not_requested', scope_confirmed: true });
    if (response.status !== 201) { report.failures.push({ at: new Date().toISOString(), marketplace, operation: 'plan', response }); save(); }
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const plan = response.body; report.plans.push(plan); save();
    assert.ok(plan.trace.actual_model_call && plan.trace.provider_request_id && plan.trace.model);
    assert.equal(plan.marketplace, marketplace);
    assert.equal(plan.language, expected[marketplace].language);
    assert.ok(plan.optimized_prompt.includes('{{PRODUCT_FACTS}}') && plan.optimized_prompt.includes('{{KEYWORDS}}'));
    const record = await generate(marketplace, plan);
    verifyRecord(marketplace, plan, record, product);
    await verifyExports(marketplace, plan, record);
    execution.completed_markets.push(marketplace); save();
    console.log(JSON.stringify({ marketplace, status: 'real_workflow_completed_quality_requires_review', listing_id: record.listing_id, version: record.version,
      elapsed_ms: Date.now() - started, plan_request_id: plan.trace.provider_request_id, audit_request_id: record.trace.provider_request_id, issues: record.review.issues.length }));
  }
  execution.completed_at = new Date().toISOString();
  report.phase = { operation: 'complete', at: execution.completed_at };
  report.acceptance = 'requested_real_market_workflows_completed_quality_and_missing_data_require_review'; save();
  console.log(JSON.stringify({ report: file, completed_markets: execution.completed_markets, failures_retained: report.failures.length }));
} catch (error) {
  report.failures.push({ at: new Date().toISOString(), phase: report.phase, code: error.code || null, message: error.message });
  execution.failed_at = new Date().toISOString(); execution.failure = { message: error.message, code: error.code || null }; save();
  throw error;
}
