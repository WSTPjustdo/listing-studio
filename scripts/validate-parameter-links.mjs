// Deterministic boundary probes on an existing REAL product snapshot. No model invocation.
// Modified phrases below are adversarial test text, not real listings or model responses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStore, rulePack } from '../server/store.mjs';
import { inspectEvidence } from '../server/evidence.mjs';
import { reviewContent } from '../server/domain.mjs';
const store = createStore();
const reportIndex = process.argv.indexOf('--report-dir');
const directory = reportIndex >= 0 ? process.argv[reportIndex + 1] : '.runtime/parameter-boundaries'; fs.mkdirSync(directory, { recursive: true });
const report = { started_at: new Date().toISOString(), kind: 'deterministic_checks_on_real_snapshot_not_live_model_acceptance', cases: [] };
try {
  const record = store.allLatestListings().find(record => record.trace.actual_model_call && !record.is_demo && record.product_snapshot?.reference_product_id === 'W101');
  if (!record) {
    console.error(
      '缺少前置数据：本机数据库里没有真实的 W101 记录（要求 trace.actual_model_call 且有商品快照）。\n' +
        '这条检查只读已有真实记录，不生成、不模拟文案。先在工作台里跑一次真实生成，改用不需要记录的量具请跑 npm run probe:claims 或 npm run test:flat-file。',
    );
    process.exit(2);
  }
  const profile = record.product_snapshot, sources = store.sources();
  report.product_ref = record.product_ref; report.original_request_id = record.trace.provider_request_id;
  const content = text => ({ title: text, item_highlights: '', bullet_points: [], description: '' });
  const inspect = text => inspectEvidence(content(text), profile, [], sources);
  function check(label, text, predicate) { const evidence = inspect(text); predicate(evidence); report.cases.push({ label, text, controlled_test_phrase: true, evidence }); }
  const identity = record.content.bullet_points.find(point => point.text === 'Westford Mill W101 cotton tote bag.')?.text;
  assert.ok(identity, 'Recorded real identity sentence required');
  check('observed_model_omission_no_longer_blocks_parameter_link', identity, evidence => { assert.equal(evidence[0].state, 'parameters_aligned'); assert.equal(evidence[0].model_mapped, false); assert.ok(evidence[0].parameter_links.some(link => link.field === 'material')); });
  const actual = inspectEvidence(record.content, profile, record.claim_map, sources), omitted = inspectEvidence(record.content, profile, [], sources);
  assert.deepEqual(actual.map(entry => entry.parameter_links), omitted.map(entry => entry.parameter_links));
  check('material_and_gsm', `${profile.material.value}, ${profile.fabric_weight_gsm.value} gsm.`, evidence => assert.equal(evidence[0].state, 'parameters_aligned'));
  const { width, height } = profile.dimensions_cm.value;
  check('exact_mm_conversion', `${width * 10} x ${height * 10} mm.`, evidence => assert.equal(evidence[0].state, 'parameters_aligned'));
  check('exact_ml_conversion', `${profile.capacity_l.value * 1000} ml.`, evidence => assert.equal(evidence[0].state, 'parameters_aligned'));
  check('exact_handle_conversion', `${profile.handle_length_cm.value * 10} mm handles.`, evidence => assert.equal(evidence[0].state, 'parameters_aligned'));
  check('dimension_axis_swap', `${height} x ${width} cm.`, evidence => assert.equal(evidence[0].state, 'needs_evidence'));
  check('capacity_is_not_load', `${profile.capacity_l.value} kg carrying capacity.`, evidence => { assert.equal(evidence[0].state, 'needs_evidence'); assert.ok(!evidence[0].parameter_links.some(link => link.field === 'capacity_l')); });
  check('mass_is_not_mass_per_area', `${profile.fabric_weight_gsm.value} g fabric weight.`, evidence => assert.equal(evidence[0].state, 'needs_evidence'));
  check('unknown_retail_pack', '25-pack.', evidence => { assert.equal(evidence[0].state, 'needs_evidence'); assert.ok(!evidence[0].parameter_links.some(link => link.field === 'retail_pack_count')); });
  check('no_full_sentence_proof', `${profile.material.value}, waterproof.`, evidence => { assert.ok(evidence[0].parameter_links.length); assert.equal(evidence[0].state, 'needs_evidence'); assert.equal(evidence[0].semantic_status, 'separate_review_required'); });
  check('negation', 'Not made of cotton.', evidence => assert.equal(evidence[0].state, 'needs_evidence'));
  check('percentage_mismatch', '90% cotton.', evidence => assert.equal(evidence[0].state, 'needs_evidence'));
  check('equivalent_percentage_format', '100.0% cotton.', evidence => assert.equal(evidence[0].state, 'parameters_aligned'));
  check('hyphenated_handle_expression', `${profile.handle_length_cm.value}-cm-long handles.`, evidence => assert.equal(evidence[0].state, 'parameters_aligned'));
  check('hyphenated_gsm_expression', `${profile.fabric_weight_gsm.value}-gsm cotton.`, evidence => assert.equal(evidence[0].state, 'parameters_aligned'));
  check('negative_parameter', `-${profile.fabric_weight_gsm.value} gsm.`, evidence => assert.equal(evidence[0].state, 'needs_evidence'));
  check('material_boundary', 'Cottonwood tote.', evidence => assert.equal(evidence.length, 0));
  check('other_attribute_dimensions', `Print area: ${width} x ${height} cm.`, evidence => assert.equal(evidence[0].state, 'needs_evidence'));
  const unavailable = inspectEvidence(content(identity), profile, [], []); assert.equal(unavailable[0].state, 'needs_evidence');
  // Source status / availability are inputs to the linker, not new products or fake model output.
  const unverified = structuredClone(profile); unverified.material.status = 'submitted_unverified';
  assert.ok(!inspectEvidence(content('cotton'), unverified, [], sources)[0].parameter_links.length);
  const policyAsFact = structuredClone(profile); policyAsFact.material.source_ids = [rulePack.sources.find(source => source.kind === 'official_platform_policy').source_id];
  assert.ok(!inspectEvidence(content('cotton'), policyAsFact, [], sources)[0].parameter_links.length);
  const ruleOnlyMap = reviewContent({ content: content('cotton'), profile, rulePack, sourceCatalog: sources, hasRealModel: false, claimMap: [{ field_path: 'content.title', claim: 'cotton', source_ids: policyAsFact.material.source_ids }] });
  assert.ok(ruleOnlyMap.issues.some(issue => issue.rule_id === 'SYS-01'));
  const reviewWithoutModel = reviewContent({ content: record.content, profile, rulePack, sourceCatalog: sources });
  assert.ok(reviewWithoutModel.checks.some(check => check.rule_id === 'AMZ-05' && check.state === 'not_checked'));
  assert.notEqual(reviewWithoutModel.status, 'reviewed_within_scope');
  const replay = [];
  for (const current of store.allLatestListings().filter(item => !item.is_demo && item.trace.actual_model_call)) {
    for (const version of store.versions(current.listing_id)) {
      const before = JSON.stringify(version), evidence = inspectEvidence(version.content, version.product_snapshot, version.claim_map, sources);
      for (const entry of evidence) for (const link of entry.parameter_links) {
        assert.equal(entry.claim.slice(link.start, link.end), link.original);
        assert.ok(link.source_ids.every(id => sources.some(source => source.source_id === id)));
      }
      assert.equal(JSON.stringify(version), before);
      replay.push({ listing_id: version.listing_id, version: version.version, original_request_id: version.trace.provider_request_id, sentences: evidence.length, links: evidence.reduce((n, entry) => n + entry.parameter_links.length, 0), pending: evidence.filter(entry => entry.state !== 'parameters_aligned').map(entry => entry.claim) });
    }
  }
  report.replayed_real_versions = replay; report.completed_at = new Date().toISOString();
  fs.writeFileSync(`${directory}/deterministic-checks.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ probes: report.cases.length, historical_real_versions: replay.length, directory }));
} finally { store.close(); }
