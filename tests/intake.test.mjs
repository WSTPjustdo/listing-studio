// Input/context/field-preservation boundaries on archived public text, not live model acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareIntakeRun, effectiveRunContext, keywordUsage, validateAllowedFields, preserveAllowedContent } from '../server/intake.mjs';
import { buildSystemPrompt } from '../server/providers.mjs';

const archived = JSON.parse(readFileSync(new URL('../reports/teammate-sync-2026-10-30/final-record.json', import.meta.url), 'utf8'));
const base = () => ({
  role: 'own_draft', content: structuredClone(archived.content), scope_confirmed: true,
  source_tool: '粘贴的真实存档文本', source_url: 'https://westfordmill.com/products/w101',
  selected_terms: ['cotton', 'Cotton', 'cotton tote', 'not-in-this-archived-text'],
});

test('own draft intake preserves the reviewed content and provenance without creating product identity', () => {
  const input = base();
  const run = prepareIntakeRun(input, () => null);
  assert.equal(run.operation, 'diagnose');
  assert.equal(run.product, null);
  assert.deepEqual(run.content, input.content);
  assert.equal(run.intake_context.role, 'own_draft');
  assert.equal(run.intake_context.source_asin, null);
  assert.equal(run.intake_context.marketplace, 'US');
  assert.equal(run.intake_context.category, 'cotton_tote');
  assert.deepEqual(run.intake_context.selected_terms, ['cotton', 'cotton tote', 'not-in-this-archived-text']);
  assert.ok(!('sku' in run));
  assert.ok(!('product_id' in run));
  assert.deepEqual(run.intake_context.original_content, input.content);
  assert.ok(!Number.isNaN(Date.parse(run.intake_context.imported_at)));
  run.content.description = 'Boundary mutation only';
  assert.equal(run.intake_context.original_content.description, archived.content.description);
});

test('unconfirmed scope and invalid references are rejected before lookup or inference', () => {
  let lookups = 0;
  const lookup = () => { lookups++; return archived.product_snapshot; };
  assert.throws(() => prepareIntakeRun({ ...base(), scope_confirmed: false, product_id: archived.product_snapshot.product_id }, lookup), { code: 'INTAKE_SCOPE_UNCONFIRMED' });
  assert.equal(lookups, 0);
  for (const source_url of ['javascript:alert(1)', 'https://user:password@example.invalid/', 'file:///private'])
    assert.throws(() => prepareIntakeRun({ ...base(), source_url }, lookup), /来源链接/);
  assert.throws(() => prepareIntakeRun({ ...base(), source_asin: 'unknown' }, lookup), /ASIN/);
  assert.throws(() => prepareIntakeRun({ ...base(), role: 'unknown' }, lookup));
  assert.throws(() => prepareIntakeRun({ ...base(), marketplace: 'DE' }, lookup));
  assert.equal(lookups, 0);
});

test('competitor text is reference material only and cannot be submitted without a real own product', () => {
  const input = { ...base(), role: 'competitor_reference' };
  assert.throws(() => prepareIntakeRun(input, () => null), { code: 'OWN_PRODUCT_REQUIRED' });
  assert.throws(() => prepareIntakeRun({ ...input, product_id: 'missing-reference' }, () => null), { code: 'PRODUCT_NOT_FOUND' });
  assert.throws(() => prepareIntakeRun({ ...input, product_id: archived.product_snapshot.product_id }, () => ({ ...archived.product_snapshot, is_demo: true })), { code: 'REAL_PRODUCT_REQUIRED' });
  const product = structuredClone(archived.product_snapshot), before = JSON.stringify(product);
  const run = prepareIntakeRun({ ...input, product_id: product.product_id }, () => product);
  assert.equal(run.operation, 'create');
  assert.ok(!('content' in run), 'reference cannot be the current own draft');
  assert.equal(JSON.stringify(product), before, 'own product facts stay unchanged');
  const context = effectiveRunContext(run);
  assert.deepEqual(context.research_context.items[0].reference_content, input.content);
  assert.equal(context.research_context.items[0].reference_only, true);
  assert.ok(!('source_ids' in context.research_context.items[0]));
});

test('a later repair inherits the same effective selected terms and reference snapshot as its saved record', () => {
  const prepared = prepareIntakeRun(base(), () => null);
  const initial = effectiveRunContext(prepared);
  const previous = { intake_context: initial.intake_context, competitor_research: initial.research_context };
  const next = effectiveRunContext({ operation: 'revise' }, previous);
  assert.deepEqual(next.research_context, initial.research_context);
  assert.deepEqual(next.intake_context, initial.intake_context);
  assert.deepEqual(next.selected_terms, initial.selected_terms);
  next.research_context.selected_terms.push('boundary-only-change');
  assert.notDeepEqual(next.research_context, previous.competitor_research);
  const cleared = effectiveRunContext({ research_context: { selected_terms: [], items: [] } }, previous);
  assert.deepEqual(cleared.selected_terms, []);
  assert.deepEqual(cleared.research_context.selected_terms, []);
});

test('legacy research without intake metadata also survives subsequent repair requests', () => {
  const previous = { competitor_research: { research_id: 'archived-reference', items: [], selected_terms: ['cotton'] } };
  const context = effectiveRunContext({}, previous);
  assert.equal(context.intake_context, null);
  assert.deepEqual(context.research_context, previous.competitor_research);
  assert.deepEqual(context.selected_terms, ['cotton']);
});

test('raw paste and filename remain provenance while model research uses only confirmed structured text', () => {
  const raw_text = 'Original paste before field confirmation';
  const prepared = prepareIntakeRun({ ...base(), raw_text, source_filename: 'public-case.txt' }, () => null);
  const context = effectiveRunContext(prepared);
  assert.equal(context.intake_context.raw_text, raw_text);
  assert.equal(context.intake_context.source_filename, 'public-case.txt');
  assert.ok(!JSON.stringify(context.research_context).includes(raw_text));
});

test('a single existing bullet can change while every other field and bullet identity stays byte-for-byte', () => {
  const original = structuredClone(archived.content);
  const selected = original.bullet_points[0].id;
  const candidate = structuredClone(original);
  candidate.title = 'Unselected structural probe';
  candidate.description = 'Unselected structural probe';
  candidate.bullet_points[0].text += ' [selected field structural probe]';
  if (candidate.bullet_points[1]) candidate.bullet_points[1].text = 'Unselected structural probe';
  const path = `content.bullet_points.${selected}`;
  const preserved = preserveAllowedContent(original, candidate, [path]);
  assert.equal(preserved.bullet_points[0].text, candidate.bullet_points[0].text);
  assert.equal(preserved.title, original.title);
  assert.equal(preserved.item_highlights, original.item_highlights);
  assert.equal(preserved.description, original.description);
  assert.deepEqual(preserved.bullet_points.slice(1), original.bullet_points.slice(1));
  assert.deepEqual(preserved.bullet_points.map(item => item.id), original.bullet_points.map(item => item.id));
  assert.throws(() => validateAllowedFields(original, ['content.bullet_points.missing']), { code: 'INVALID_ALLOWED_FIELD' });
  assert.throws(() => validateAllowedFields(original, [path, path]), { code: 'INVALID_ALLOWED_FIELD' });
  assert.throws(() => validateAllowedFields(original, ['product.material']));
  const missing = structuredClone(candidate);
  missing.bullet_points[0].id = 'model-renamed-id';
  assert.throws(() => preserveAllowedContent(original, missing, [path]), { code: 'MODEL_FIELD_MISSING' });
});

test('keyword usage reports literal changes without treating substring, cross-field text or regex as terms', () => {
  const before = { title: 'Cotton tote', item_highlights: '', bullet_points: [{ id: 'b1', text: 'bag; c++ examples only' }], description: '' };
  const after = { ...before, title: 'Cotton tote bag', description: 'Cotton.' };
  const changes = keywordUsage(['cotton', 'tote bag', 'c++', 'absent', 'ton'], before, after);
  assert.deepEqual(changes.map(item => [item.term, item.before_count, item.after_count, item.status]), [
    ['cotton', 1, 2, 'retained'], ['tote bag', 0, 1, 'added'], ['c++', 1, 1, 'retained'], ['absent', 0, 0, 'absent'], ['ton', 0, 0, 'absent'],
  ]);
  const removed = keywordUsage(['cotton'], after, { ...after, title: 'Text', description: '' });
  assert.equal(removed[0].status, 'removed');
});

test('provider contract treats imported material as data and preserves only facts supported by own product', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('competitor_reference'));
  assert.ok(prompt.includes('never proof about this product'));
  assert.ok(prompt.includes('stable ID of a single bullet'));
});
