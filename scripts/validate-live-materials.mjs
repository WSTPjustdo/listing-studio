// Live official W101 documents + the existing local DeepSeek service. No mocked model or merchant samples.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { load } from 'cheerio';

if (!process.argv.includes('--real-api')) throw new Error('Use --real-api to authorize the real paid DeepSeek extraction; there is no demo fallback.');
const argument = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const base = argument('--base-url', process.env.APP_URL || 'http://127.0.0.1:3221').replace(/\/$/, '');
const resumeFile = argument('--resume', null);
const directory = resumeFile ? path.dirname(path.resolve(resumeFile)) : path.resolve(argument('--report-dir', `.runtime/live-materials-${Date.now()}`));
mkdirSync(directory, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const report = resumeFile ? JSON.parse(readFileSync(path.resolve(resumeFile), 'utf8')) : {
  started_at: new Date().toISOString(), base, evidence_type: 'live_official_documents_and_real_DeepSeek',
  sources: [], checks: [], requests: [], failures: [],
  merchant_original_word: 'not_provided', merchant_wechat_screenshot: 'not_provided',
  merchant_amazon_template: 'not_provided', merchant_seller_sku: null,
  merchant_stock: 'unknown', amazon_upload: 'not_performed',
  notice: '真实品牌官方公开商品资料及明确标记的公开数据衍生文本；不是商家私有样表、微信记录、库存、上架或官方模板兼容验收。',
};
report.base = base;
const save = () => {
  report.checks = [...new Set(report.checks)];
  writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify(report, null, 2));
};
const request = async (route, payload) => {
  const response = await fetch(`${base}${route}`, {
    ...(payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(240000),
  });
  const body = await response.json();
  if (!response.ok) {
    report.failures.push({ route, status: response.status, response: body }); save();
    throw new Error(`${route}: HTTP ${response.status}: ${body.error?.code || body.code || 'unknown'}: ${body.error?.message || body.message || 'request failed'}`);
  }
  return body;
};
const publicSource = async (url, filename, kind) => {
  const started = Date.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
  assert.equal(response.status, 200, `Live official source HTTP ${response.status}; do not substitute a saved snapshot.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(path.join(directory, filename), bytes);
  report.sources.push({ url, final_url: response.url, publisher: 'Westford Mill', source_kind: kind, filename, http_status: response.status, checked_at: new Date().toISOString(), elapsed_ms: Date.now() - started, bytes: bytes.length, sha256: hash(bytes) });
  save();
  return bytes;
};
const traceRow = (operation, trace) => ({ operation, request_id: trace?.provider_request_id ?? null, model: trace?.model ?? null, elapsed_ms: trace?.elapsed_ms ?? null, usage: trace?.usage ?? null, actual_model_call: trace?.actual_model_call === true });
const addTrace = (operation, trace) => {
  const row = traceRow(operation, trace);
  if (!report.requests.some(saved => saved.request_id && saved.request_id === row.request_id)) report.requests.push(row);
  const failed = trace?.format_retry?.failed_attempt;
  if (failed?.trace?.provider_request_id && !report.requests.some(saved => saved.request_id === failed.trace.provider_request_id))
    report.requests.push({ ...traceRow(`${operation}_first_attempt`, failed.trace), outcome: 'failed', error_code: failed.error_code || null, recovered_by_request_id: row.request_id });
};
async function completeWorkflow() {
  assert.ok(report.analysis?.trace?.actual_model_call && report.analysis?.id, 'Resume requires the already successful real extraction and its stored analysis ID.');
  if (report.workflow_completed_at) return;
  report.workflow_started_at ||= new Date().toISOString();
  report.fact_confirmation = { by: 'developer_public_source_verification', merchant_confirmation: false, merchant_inventory: false, notice: '仅为工程验收核对真实官方公开参数；未取得商家供货、库存、零售包装或 SKU 确认。' };
  const literalText = readFileSync(path.join(directory, 'official-w101-public-text.txt'), 'utf8');
  for (const snippet of ['100% Cotton', '140gsm', '38 x 42', 'Handle length ( cm ): 67', 'Capacity ( litres ): 10']) assert.ok(literalText.includes(snippet), `Saved exact official source missing ${snippet}.`);
  if (!report.product) {
    const confirmedFields = { width: 38, height: 42, fabric_weight_gsm: 140, capacity_l: 10, handle_length_cm: 67, retail_pack_count: null, brand: '', color: '' };
    const factLines = report.analysis.facts.filter(fact => fact.source_refs?.length && /^(?:材质|面料克重|尺寸|容量|提手长度)/.test(fact.label)).map(fact => `${fact.label}：${fact.value}`);
    assert.ok(factLines.length, 'No source-backed core product parameters were extracted.');
    report.product = await request('/api/research/product', { name: 'Westford Mill W101 官方公开商品', material: '100% Cotton', facts: factLines.join('\n'), category_confirmed: true, analysis_id: report.analysis.id, confirmed_fields: confirmedFields });
    save();
  }
  const product = report.product;
  assert.ok(!product.is_demo && product.material_context?.preview_id === report.preview.id);
  assert.equal(product.sku ?? null, null, 'A manufacturer model code must not be turned into a seller SKU.');
  assert.equal(product.retail_pack_count.value, null);
  assert.equal(product.rated_load_kg.value, null);
  assert.deepEqual(product.material_context.source_ids, report.preview.documents.map(document => document.id));
  report.checks.push('public_product_adopted_with_material_hashes_pages_and_unknown_seller_identity');
  if (!report.guided_plan) {
    report.guided_plan = await request('/api/guided/plan', { mode: 'automatic', product_id: product.product_id, product_revision: product.revision, analysis_id: report.analysis.id, language: 'en', marketplace: 'US', selected_terms: [], research_status: 'not_requested', scope_confirmed: true });
    addTrace('guided_plan', report.guided_plan.trace); save();
  }
  const plan = report.guided_plan;
  assert.ok(plan.trace?.actual_model_call && plan.trace.provider_request_id);
  assert.ok(plan.optimized_prompt.includes('{{PRODUCT_FACTS}}'), 'Reusable plan must retain its fact placeholder.');
  if (!report.workflow_run) {
    report.workflow_run = await request('/api/guided/generate', { plan_id: plan.id, product_id: product.product_id, product_revision: product.revision, scope_confirmed: true }); save();
  }
  const started = Date.now();
  for (;;) {
    const run = await request(`/api/runs/${encodeURIComponent(report.workflow_run.run_id)}`);
    if (run.status === 'failed') { report.workflow_failure = run; save(); throw new Error(`${run.error?.code || 'WORKFLOW_FAILED'}: ${run.error?.message || 'Real guided run failed'}`); }
    if (run.status === 'succeeded') break;
    if (Date.now() - started > 300000) throw new Error('Real materials guided generation exceeded the acceptance deadline.');
    await delay(500);
  }
  const versions = await request(`/api/listings/${encodeURIComponent(report.workflow_run.listing_id)}/versions`);
  const record = versions.at(-1); report.record = record; save();
  assert.equal(record.guided_plan?.id, plan.id);
  assert.equal(record.product_snapshot.material_context.preview_id, report.preview.id);
  assert.ok(record.trace?.actual_model_call && record.trace.provider_request_id);
  assert.equal(record.trace.calls?.length, 2, 'Generation must have its separate real independent review call.');
  for (const [index, trace] of record.trace.calls.entries()) {
    assert.ok(trace.actual_model_call && trace.provider_request_id && /^deepseek/i.test(trace.model || ''));
    addTrace(index ? 'independent_review' : 'listing_generation', trace);
  }
  for (const document of report.preview.documents) assert.ok(record.source_snapshot.some(source => source.source_id === document.id), `Source snapshot lost ${document.filename}.`);
  report.checks.push('real_guided_plan_then_generation_and_independent_review_preserve_materials'); save();
  const sourcePdf = report.preview.documents.find(document => document.kind === 'pdf');
  report.exports = [];
  for (const format of ['json', 'txt', 'html', 'worklist', 'copy']) {
    const response = await fetch(`${base}/api/listings/${encodeURIComponent(record.listing_id)}/export?version=${record.version}&format=${format}`, { signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, `${format} export`);
    const text = await response.text();
    const filename = `materials-export.${format === 'worklist' ? 'worklist.html' : format === 'copy' ? 'copy.txt' : format}`;
    writeFileSync(path.join(directory, filename), text);
    if (format !== 'copy') {
      assert.ok(text.includes(sourcePdf.filename), `${format} export lost the original filename.`);
      assert.ok(text.includes(sourcePdf.sha256), `${format} export lost the original file SHA256.`);
      assert.ok(sourcePdf.segments.some(segment => text.includes(segment.locator)), `${format} export lost page locators.`);
    } else assert.ok(!text.includes(sourcePdf.sha256), 'Clean copy must not include internal material hashes.');
    report.exports.push({ format, filename, sha256: hash(Buffer.from(text)), bytes: Buffer.byteLength(text) });
  }
  report.checks.push('json_txt_html_worklist_exports_retain_original_file_hash_and_page_clean_copy_excludes_metadata');
  const telemetry = await request('/api/telemetry?limit=100');
  const requestIds = new Set(report.requests.map(row => row.request_id));
  report.workflow_telemetry = telemetry.calls.filter(call => requestIds.has(call.request_id));
  report.workflow_unresolved = { issues: record.review.issues, missing_data: record.review.missing_data, unchecked: record.review.checks?.filter(check => ['not_checked', 'error', 'needs_evidence'].includes(check.state)) || [] };
  report.workflow_completed_at = new Date().toISOString();
  report.acceptance = 'real_public_materials_to_guided_listing_and_review_completed_merchant_acceptance_pending';
  save();
}
save();
try {
  if (!resumeFile) {
  const settings = await request('/api/settings');
  assert.equal(settings.provider, 'compatible', 'Start the isolated real service with the existing DeepSeek configuration.');
  assert.equal(new URL(settings.base_url).hostname, 'api.deepseek.com', 'Existing DeepSeek only; no mocked upstream is accepted.');
  report.model_configuration = { provider: settings.provider, model: settings.model, hostname: new URL(settings.base_url).hostname };

  const officialUrl = 'https://westfordmill.com/products/w101';
  const html = await publicSource(officialUrl, 'official-w101.html', 'official_live_product_page');
  const $ = load(html.toString('utf8'));
  const title = $('h1').text().trim();
  const material = $('li').filter((_, element) => /100% Cotton\s*-\s*140gsm/.test($(element).text())).first();
  const bullets = material.parent().children('li').map((_, element) => $(element).text().trim()).get().filter(Boolean);
  const specifications = $('table').map((_, table) => $(table).find('tr').map((_, row) => $(row).find('th,td').map((_, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get().join(': ')).get().join('\n')).get().join('\n');
  const literalText = [title, ...bullets, specifications].filter(Boolean).join('\n');
  for (const value of ['100% Cotton', '140gsm', '38 x 42']) assert.ok(literalText.includes(value), `Official W101 source fact missing or changed: ${value}`);
  const textBuffer = Buffer.from(literalText, 'utf8');
  writeFileSync(path.join(directory, 'official-w101-public-text.txt'), textBuffer);
  report.sources.push({ filename: 'official-w101-public-text.txt', source_kind: 'literal_text_derived_from_live_official_page', merchant_original: false, source_url: officialUrl, sha256: hash(textBuffer), bytes: textBuffer.length });

  const pdfHref = $('a[href]').map((_, element) => $(element).attr('href')).get().find(href => /\/print\/pdf\/node\//.test(href));
  assert.ok(pdfHref, 'The live official product page no longer links its PDF; source must be checked manually.');
  const pdfUrl = new URL(pdfHref, officialUrl).href;
  const pdfBuffer = await publicSource(pdfUrl, 'official-w101-specification.pdf', 'official_live_product_specification_pdf');
  assert.equal(pdfBuffer.subarray(0, 5).toString('ascii'), '%PDF-', 'Official PDF source did not return PDF content.');

  const tsvPath = path.resolve('reports/flat-file-live-2026-10-28/public-derived-w101-without-seller-sku.tsv');
  const tsvBuffer = readFileSync(tsvPath);
  report.sources.push({ filename: path.basename(tsvPath), source_kind: 'existing_public_source_and_real_model_text_derived_table', merchant_original: false, official_amazon_template: false, merchant_seller_sku: null, source_url: officialUrl, sha256: hash(tsvBuffer), bytes: tsvBuffer.length });
  const files = [
    { filename: 'official-w101-specification.pdf', base64: pdfBuffer.toString('base64') },
    { filename: 'official-w101-public-text.txt', base64: textBuffer.toString('base64') },
    { filename: path.basename(tsvPath), base64: tsvBuffer.toString('base64') },
  ];
  const extractionStarted = Date.now();
  const preview = await request('/api/materials/preview', { files });
  report.preview = preview;
  report.local_extraction_elapsed_ms = Date.now() - extractionStarted;
  save();
  assert.equal(preview.documents.length, files.length, 'Every supplied file needs an explicit result.');
  const pdf = preview.documents.find(document => document.filename.endsWith('.pdf'));
  assert.equal(pdf?.status, 'ready', `Official PDF extraction failed: ${JSON.stringify(pdf?.error || pdf?.warnings)}`);
  assert.ok(pdf.segments?.length && pdf.segments.every(segment => segment.locator && segment.text), 'PDF evidence needs source page locators.');
  assert.ok(/Cotton/i.test(pdf.text) && /140/.test(pdf.text), 'PDF extraction did not retain the official material and weight.');
  for (const document of preview.documents) {
    assert.equal(document.status, 'ready', `${document.filename}: ${JSON.stringify(document.error || document.warnings)}`);
    assert.equal(document.sha256, hash(Buffer.from(files.find(file => file.filename === document.filename).base64, 'base64')), 'Attachment hash mismatch.');
    assert.ok(document.text.trim());
  }
  report.checks.push('official_live_pdf_text_and_public_derived_tsv_extracted_without_model_substitution', 'all_attachments_have_status_hash_and_source_locators');
  save();

  const materialContext = { preview_id: preview.id, document_ids: preview.documents.map(document => document.id) };
  const modelStarted = Date.now();
  const analysis = await request('/api/research/analyze', { material_context: materialContext });
  report.analysis = analysis;
  report.requests.push({ operation: 'research_analyze', request_id: analysis.trace?.provider_request_id ?? null, model: analysis.trace?.model ?? null, elapsed_ms: analysis.trace?.elapsed_ms ?? null, measured_elapsed_ms: Date.now() - modelStarted, usage: analysis.trace?.usage ?? null, actual_model_call: analysis.trace?.actual_model_call === true });
  save();
  assert.ok(analysis.trace?.actual_model_call && analysis.trace?.provider_request_id, 'An actual model response and upstream request ID are required.');
  assert.ok(/^deepseek/i.test(analysis.trace.model || ''), 'The returned model must identify DeepSeek.');
  assert.ok(analysis.facts?.length, 'The real model returned no grounded product facts.');
  const sourceTexts = preview.documents.map(document => document.text);
  for (const fact of analysis.facts) {
    assert.ok(sourceTexts.some(text => text.includes(fact.evidence)) || preview.text.includes(fact.evidence), 'Accepted fact lacks an exact source excerpt.');
    assert.ok(fact.evidence.replace(/\s+/g, ' ').toLowerCase().includes(fact.value.replace(/\s+/g, ' ').toLowerCase()), 'Fact value is not retained literally in its excerpt.');
  }
  assert.ok(analysis.suggested_fields?.retail_pack_count == null, 'Supplier/carton pack counts must not be inferred as a seller retail pack.');
  assert.ok(analysis.material_context?.preview_id === preview.id, 'The model analysis must retain the selected file provenance.');
  report.checks.push('actual_DeepSeek_request_model_duration_usage_recorded', 'adopted_facts_match_exact_extracted_source_text', 'material_provenance_retained_and_unknown_retail_pack_not_invented');
  report.unresolved = analysis.missing || [];
  report.completed_at = new Date().toISOString();
  report.acceptance = 'real_public_materials_extraction_completed_merchant_originals_and_manual_fact_confirmation_pending';
  save();
  }
  if (process.argv.includes('--complete-workflow')) await completeWorkflow();
  console.log(JSON.stringify({ report: path.join(directory, 'acceptance.json'), checks: report.checks, requests: report.requests, unresolved: report.workflow_unresolved || report.unresolved }));
} catch (error) {
  report.failures.push({ at: new Date().toISOString(), code: error.code || null, message: error.message });
  report.acceptance = 'failed_no_mock_or_demo_fallback';
  save();
  throw error;
}
