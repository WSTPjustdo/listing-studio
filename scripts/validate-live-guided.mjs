// Two real paths. The prompt input is the user's interview requirements, not a claimed merchant template.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
if (!process.argv.includes('--real-api')) throw new Error('Use --real-api to authorize paid inference.');
const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const base = arg('--base-url', 'http://127.0.0.1:8788');
const phase = arg('--phase', 'all');
assert.ok(['all', 'improve', 'automatic'].includes(phase));
const state = JSON.parse(fs.readFileSync('.runtime/live-intake-current.json', 'utf8'));
const file = path.join(state.directory, 'guided-acceptance.json');
const report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
  started_at: new Date().toISOString(), base, checks: [], plans: [], records: [], failures: [],
  input_provenance: 'Real official W101 data. Existing-prompt input quotes the user-provided interview requirements; no original private merchant prompt was supplied.',
};
const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2));
const post = async (route, data) => {
  const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return { status: response.status, body: await response.json() };
};
const counts = () => {
  const db = new DatabaseSync(state.database, { readOnly: true });
  try { return ['runs', 'call_telemetry'].map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n); }
  finally { db.close(); }
};
async function generate(plan) {
  const result = await post('/api/guided/generate', { plan_id: plan.id, product_id: plan.product_id, product_revision: plan.product_revision, scope_confirmed: true });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  for (let n = 0; n < 300; n++) {
    const status = await (await fetch(`${base}/api/runs/${result.body.run_id}`)).json();
    if (status.status === 'failed') { report.failures.push(status); save(); throw new Error(JSON.stringify(status.error)); }
    if (status.status === 'succeeded') {
      const records = await (await fetch(`${base}/api/listings/${result.body.listing_id}/versions`)).json();
      const record = records.at(-1);
      assert.ok(record.trace.actual_model_call && record.trace.provider_request_id);
      assert.equal(record.guided_plan.id, plan.id);
      assert.equal(record.guided_plan.trace.provider_request_id, plan.trace.provider_request_id);
      assert.deepEqual(record.competitor_research.selected_terms, plan.research_context.selected_terms);
      report.records.push(record); save();
      console.log(JSON.stringify({ mode: plan.mode, listing_id: record.listing_id, version: record.version, plan_request_id: plan.trace.provider_request_id, review_request_id: record.trace.provider_request_id, issues: record.review.issues.length }));
      return record;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Real guided generation deadline exceeded');
}
async function makePlan(input) {
  const result = await post('/api/guided/plan', input);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const plan = result.body;
  assert.ok(plan.trace.actual_model_call && plan.trace.provider_request_id);
  assert.ok(plan.optimized_prompt.includes('{{PRODUCT_FACTS}}') && plan.optimized_prompt.includes('{{KEYWORDS}}'));
  assert.ok(!/Westford\s*Mill|\bW101\b|\b140\s*(?:gsm|g\/m)|\b38\s*(?:cm|centimet)/i.test(plan.optimized_prompt), 'Reusable template hardcoded this product');
  report.plans.push(plan); save(); return plan;
}
try {
  if (phase === 'all' || phase === 'improve') {
    const input = { mode: 'improve', prompt: '禁止夸大、不能用medical claim、美式表达、不要堆砌', product_id: state.product_id, product_revision: state.product_revision, selected_terms: ['cotton', 'CutAway'], research_status: 'not_requested', scope_confirmed: true };
    const before = counts();
    for (const [label, bad] of [['unknown_scope_rejected', { ...input, scope_confirmed: false }], ['missing_prompt_rejected', { ...input, prompt: '' }]]) {
      const result = await post('/api/guided/plan', bad); assert.equal(result.status, 400); report.checks.push(label);
    }
    assert.deepEqual(counts(), before); report.checks.push('invalid_plan_inputs_do_not_queue_or_call_model');
    const plan = await makePlan(input);
    assert.equal(plan.mode, 'improve'); assert.equal(plan.original_prompt, input.prompt);
    const record = await generate(plan);
    report.checks.push('real_existing_requirements_improved_to_reusable_template', 'real_listing_generated_then_independently_audited');
    for (const format of ['json', 'txt', 'html', 'worklist', 'copy']) {
      const response = await fetch(`${base}/api/listings/${record.listing_id}/export?version=${record.version}&format=${format}`);
      assert.equal(response.status, 200); const text = await response.text();
      if (format !== 'copy') assert.ok(text.includes(plan.id), `${format} lost the writing plan`);
      else assert.ok(!text.includes(plan.id));
    }
    report.checks.push('plan_and_trace_exported_but_clean_copy_excludes_internal_plan'); save();
  }
  if (phase === 'all' || phase === 'automatic') {
    const source = state.sources.find(item => item.model === 'W101');
    const text = [source.title, ...source.bullets, source.specifications].join('\n');
    const response = await post('/api/research/analyze', { text });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const analysis = response.body;
    assert.ok(analysis.trace.actual_model_call && analysis.trace.provider_request_id);
    assert.ok(analysis.facts.length > 0);
    assert.ok(analysis.facts.every(fact => text.includes(fact.evidence)), 'Adopted analysis facts lack exact source excerpts');
    report.analysis = analysis; report.analysis_input = text; save();
    const saved = await post('/api/research/product', { name: analysis.name, material: '100% cotton', facts: analysis.facts.map(fact => fact.value).join('\n'), category_confirmed: true, analysis_id: analysis.id, confirmed_fields: analysis.suggested_fields || {} });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const product = saved.body;
    const researched = await post('/api/research/search', { query: 'cotton tote bag' });
    let research = researched.body;
    if (researched.status !== 200) {
      report.research_failure = researched; save();
      const official = await post('/api/research/search', { query: 'cotton tote bag', source: 'official_public' });
      assert.equal(official.status, 200, JSON.stringify(official.body));
      research = official.body;
      assert.equal(research.provider, 'official-public');
      assert.ok(research.items.every(item => item.reference_id && item.asin === null));
      report.checks.push('amazon_failure_preserved_explicit_official_reference_request');
    } else assert.ok(research.items.every(item => /^[A-Z0-9]{10}$/.test(item.asin)));
    report.research = research; save();
    assert.ok(research.items.length > 0);
    const candidate = research.items.find(item => item.bullets.length > 0) || research.items[0];
    const terms = research.terms.filter(term => (candidate.reference_id ? term.reference_ids?.includes(candidate.reference_id) : term.asins.includes(candidate.asin)) && /^(?:cotton|tote|bag|cotton tote|tote bag)$/.test(term.term)).slice(0, 3).map(term => term.term);
    const selected = candidate.reference_id ? { selected_reference_ids: [candidate.reference_id] } : { selected_asins: [candidate.asin] };
    const plan = await makePlan({ mode: 'automatic', product_id: product.product_id, product_revision: product.revision, analysis_id: analysis.id, research_id: research.id, ...selected, selected_terms: terms, research_status: 'available', scope_confirmed: true });
    assert.equal(plan.research_status, 'available'); assert.equal(plan.research_context.provider, research.provider);
    const record = await generate(plan);
    assert.deepEqual(record.product_snapshot, product);
    report.checks.push('real_text_analysis_with_exact_excerpts', 'confirmed_own_facts_saved_separately', 'real_public_references_and_keyword_sources', 'automatic_reusable_plan_then_real_listing_audit'); save();
  }
  report.completed_at = new Date().toISOString(); report.acceptance = 'real_guided_workflows_completed_quality_requires_review'; save();
  console.log(JSON.stringify({ report: file, checks: report.checks, remaining: report.records.map(record => ({ listing_id: record.listing_id, issues: record.review.issues, missing_data: record.review.missing_data })) }));
} catch (error) {
  report.failures.push({ at: new Date().toISOString(), message: error.message, code: error.code || null }); save(); throw error;
}
