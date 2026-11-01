// Real public sources + existing local DeepSeek only. No mock upstream or generated fixture copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { load } from 'cheerio';
import { createStore } from '../server/store.mjs';
import { getConfig } from '../server/providers.mjs';

const prepare = process.argv.includes('--prepare');
if (!prepare && !process.argv.includes('--real-api')) throw new Error('Use --real-api to authorize paid inference.');
const marker = path.resolve('.runtime/live-intake-current.json');
const argument = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const base = argument('--base-url', 'http://127.0.0.1:8788');
const archived = JSON.parse(fs.readFileSync('reports/teammate-sync-2026-10-30/final-record.json', 'utf8'));

if (prepare) {
  const directory = path.resolve('.runtime', `live-intake-${Date.now()}`);
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync('.runtime/listing-studio.sqlite', { readOnly: true });
  const saved = JSON.parse(db.prepare("SELECT data FROM settings WHERE id='provider'").get()?.data || '{}');
  db.close();
  const config = getConfig({ settings: () => saved });
  assert.ok(config.api_key && config.provider === 'compatible' && new URL(config.base_url).hostname === 'api.deepseek.com', 'Existing DeepSeek configuration required.');
  const sources = [];
  let competitor;
  for (const [model, url] of [['W101', 'https://westfordmill.com/products/w101'], ['W201', 'https://westfordmill.com/products/w201-premium-cotton-tote']]) {
    const started = Date.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, `Official source ${model}`);
    const html = await response.text();
    const $ = load(html);
    const material = $('li').filter((_, el) => /100% Cotton\s*-\s*(?:140|200)gsm/.test($(el).text())).first();
    const bullets = material.parent().children('li').map((_, el) => $(el).text().trim()).get().filter(Boolean);
    const title = $('h1').text().trim();
    assert.ok(title && bullets.length >= 3, `Could not extract official ${model} copy`);
    const body = $('body').text().replace(/\s+/g, ' ');
    assert.ok(body.includes(model === 'W101' ? '4.1oz/yd²' : '200gsm'));
    const source = { model, url, publisher: 'Westford Mill', checked_at: new Date().toISOString(), http_status: response.status, elapsed_ms: Date.now() - started, title, bullets, specifications: $('table').text().replace(/\s+/g, ' ').trim() };
    sources.push(source);
    if (model === 'W201') competitor = { title, item_highlights: '', bullet_points: bullets.map((text, i) => ({ id: `b${i + 1}`, text })), description: '' };
    fs.writeFileSync(path.join(directory, `${model.toLowerCase()}-source.html`), html);
  }
  const ownSource = sources.find(x => x.model === 'W101');
  for (const value of ['100% Cotton', '140', '38 x 42', '67']) assert.ok(ownSource.specifications.includes(value) || ownSource.bullets.some(x => x.includes(value)), `Official W101 fact changed: ${value}`);
  const store = createStore(path.join(directory, 'validation.sqlite'));
  store.saveSettings(config); // Private runtime DB only; never copy to delivery.
  store.saveSource({ source_id: 'LIVE-WESTFORD-W101', kind: 'public_reference', url: ownSource.url, publisher: ownSource.publisher, checked_at: ownSource.checked_at, description: '本轮实时官方公开来源；非商家库存或供货确认。', snapshot: { specifications: ownSource.specifications, excerpts: ownSource.bullets } });
  // Re-import the unchanged real facts into a fresh workspace; its local revision starts at 1.
  const ownProduct = { ...archived.product_snapshot, revision: 1 };
  store.saveProduct(ownProduct);
  store.close();
  const state = { directory, database: path.join(directory, 'validation.sqlite'), prepared_at: new Date().toISOString(), product_id: ownProduct.product_id, product_revision: ownProduct.revision, archived_product_revision: archived.product_snapshot.revision, own_content: archived.content, competitor_content: competitor, sources, notice: '公开真实商品及已有真实模型稿；档案事实不变，重新导入隔离库后本地版本从1起；不是商家试用、SKU、库存或上架验收。' };
  fs.writeFileSync(marker, JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(directory, 'prepared-public-inputs.json'), JSON.stringify({ ...state, directory: undefined, database: undefined }, null, 2));
  console.log(JSON.stringify({ prepared: true, directory, database: state.database, sources: sources.map(x => ({ model: x.model, status: x.http_status })) }));
} else {
  const state = JSON.parse(fs.readFileSync(marker, 'utf8'));
  const report = { started_at: new Date().toISOString(), base, evidence_type: 'real_official_sources_and_real_DeepSeek', sources: state.sources, checks: [], records: [], failures: [] };
  const save = () => fs.writeFileSync(path.join(state.directory, 'intake-acceptance.json'), JSON.stringify(report, null, 2));
  const request = async (route, data) => {
    const r = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
  };
  const wait = async queued => {
    const started = Date.now();
    for (;;) {
      const run = await (await fetch(`${base}/api/runs/${queued.run_id}`)).json();
      if (run.status === 'failed') { report.failures.push(run); save(); throw new Error(`${run.error?.code}: ${run.error?.message}`); }
      if (run.status === 'succeeded') {
        const versions = await (await fetch(`${base}/api/listings/${queued.listing_id}/versions`)).json();
        const record = versions.at(-1);
        assert.ok(record.trace.actual_model_call && record.trace.provider_request_id);
        report.records.push(record); save();
        console.log(JSON.stringify({ listing: record.listing_id, version: record.version, request_id: record.trace.provider_request_id, issues: record.review.issues.length, elapsed_ms: Date.now() - started }));
        return record;
      }
      if (Date.now() - started > 300000) throw new Error('Real intake acceptance deadline exceeded');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  };
  try {
    const payload = { role: 'own_draft', content: state.own_content, product_id: state.product_id, product_revision: state.product_revision, source_tool: '已有真实 DeepSeek 文案', source_url: state.sources[0].url, selected_terms: ['cotton', 'CutAway', '4.1oz/yd²'], scope_confirmed: true };
    const counts = () => {
      const db = new DatabaseSync(state.database, { readOnly: true });
      try { return ['runs', 'call_telemetry'].map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n); }
      finally { db.close(); }
    };
    const initialCounts = counts();
    for (const [label, bad] of [
      ['unknown_scope_rejected', { ...payload, scope_confirmed: false }],
      ['competitor_without_own_product_rejected', { ...payload, role: 'competitor_reference', product_id: undefined, product_revision: undefined }],
      ['invalid_source_url_rejected', { ...payload, source_url: 'javascript:alert(1)' }],
    ]) {
      const result = await request('/api/listings/intake', bad);
      assert.equal(result.status, 400, `${label}: ${JSON.stringify(result.body)}`); report.checks.push(label);
    }
    assert.deepEqual(counts(), initialCounts, 'Rejected inputs must not queue runs or paid requests');
    report.checks.push('rejected_inputs_create_no_runs_or_provider_calls');
    const own = await request('/api/listings/intake', payload); assert.equal(own.status, 202, JSON.stringify(own.body));
    const first = await wait(own.body);
    assert.deepEqual(first.content, state.own_content);
    assert.equal(first.intake_context.role, 'own_draft');
    assert.deepEqual(first.intake_context.selected_terms, payload.selected_terms);
    assert.ok(first.keyword_usage.some(x => x.term === '4.1oz/yd²' && x.after_count > 0));
    assert.ok(!first.review.issues.some(x => x.original === '4.1oz' && /承重/.test(x.reason)), 'Known real fabric weight false positive remains');
    report.checks.push('real_own_copy_diagnosed_without_mutation', 'source_and_keywords_recorded', 'fabric_weight_not_misclassified_as_load'); save();
    const field = `content.bullet_points.${first.content.bullet_points[0].id}`;
    const revised = await request(`/api/listings/${first.listing_id}/revisions`, { kind: 'instruction', base_version: first.version, allowed_fields: [field], instruction: '仅对所选这一条要点改换句式，使表达简洁自然。保留它已有依据的商品参数和卖点，不引入新功能、认证或性能；其他字段原文保留。' });
    assert.equal(revised.status, 202, JSON.stringify(revised.body));
    const next = await wait(revised.body);
    for (const key of ['title', 'item_highlights', 'description']) assert.equal(next.content[key], first.content[key]);
    for (const bullet of first.content.bullet_points.slice(1)) assert.deepEqual(next.content.bullet_points.find(x => x.id === bullet.id), bullet);
    assert.deepEqual(next.competitor_research.selected_terms, payload.selected_terms);
    assert.deepEqual(next.intake_context, first.intake_context);
    const providerAudit = path.join(state.directory, 'provider-audit.jsonl');
    assert.ok(fs.existsSync(providerAudit), 'Start the real service with the live-intake provider audit preload');
    const captured = fs.readFileSync(providerAudit, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const actualRevisions = captured.filter(row => row.operation === 'revise');
    assert.ok(actualRevisions.length > 0, 'No actual revise request captured');
    for (const row of actualRevisions) {
      assert.deepEqual(row.selected_terms, payload.selected_terms, 'Actual model request lost keywords');
      assert.deepEqual(row.allowed_fields, [field], 'Actual model request lost its editing scope');
    }
    report.checks.push('single_bullet_scope_enforced', 'keywords_and_source_survive_revision', 'actual_provider_revision_request_contains_selected_terms'); save();
    const reference = await request('/api/listings/intake', { ...payload, role: 'competitor_reference', content: state.competitor_content, source_tool: 'Westford Mill 官方公开参考原文', source_url: state.sources[1].url });
    assert.equal(reference.status, 202, JSON.stringify(reference.body));
    const created = await wait(reference.body);
    assert.equal(created.intake_context.role, 'competitor_reference');
    assert.deepEqual(created.intake_context.original_content, state.competitor_content);
    assert.equal(created.product_snapshot.fabric_weight_gsm.value, 140);
    const text = [created.content.title, created.content.item_highlights, ...created.content.bullet_points.map(x => x.text), created.content.description].join('\n');
    assert.ok(!/\b200\s*(?:gsm|g\/m)|\b6\s*oz\/yd|\bW201\b/i.test(text), 'Reference product facts leaked into own W101 copy');
    report.checks.push('official_w201_reference_kept_separate_from_own_w101_facts');
    for (const format of ['json', 'txt', 'html', 'worklist', 'copy']) {
      const r = await fetch(`${base}/api/listings/${next.listing_id}/export?version=${next.version}&format=${format}`);
      assert.equal(r.status, 200); const body = await r.text();
      if (format !== 'copy') assert.ok(body.includes(format === 'json' ? 'intake_context' : '导入材料与关键词'));
      else assert.ok(!body.includes('导入材料与关键词'));
      fs.writeFileSync(path.join(state.directory, `intake-export.${format === 'worklist' ? 'worklist.html' : format === 'copy' ? 'copy.txt' : format}`), body);
    }
    report.checks.push('json_txt_html_worklist_provenance_and_clean_copy_exports');
    report.completed_at = new Date().toISOString(); report.acceptance = 'real_intake_workflow_completed_quality_requires_review'; save();
    console.log(JSON.stringify({ report: path.join(state.directory, 'intake-acceptance.json'), checks: report.checks, unresolved: report.records.map(r => ({ listing_id: r.listing_id, version: r.version, issues: r.review.issues, missing_data: r.review.missing_data })) }));
  } catch (error) {
    report.failures.push({ at: new Date().toISOString(), message: error.message, code: error.code || null }); save(); throw error;
  }
}
