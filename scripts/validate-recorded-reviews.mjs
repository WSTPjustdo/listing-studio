// Replays only saved real model reviews; no invented goods or model responses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStore, rulePack } from '../server/store.mjs';
import { reviewContent } from '../server/domain.mjs';
import { inspectConsistency } from '../server/consistency.mjs';
import { sameEvidence } from '../server/submissions.mjs';
const store = createStore();
const report = { checked_at: new Date().toISOString(), kind: 'recorded_real_response_replay_not_live_inference', cases: [] };
try {
  for (const latest of store.allLatestListings().filter(record => !record.is_demo && record.trace.actual_model_call)) {
    const versions = store.versions(latest.listing_id);
    for (const record of versions) {
      if (!record.trace.actual_model_call || !record.product_snapshot) continue;
      const original = JSON.stringify(record);
      const review = reviewContent({ content: record.content, profile: record.product_snapshot, rulePack, hasRealModel: true, claimMap: record.claim_map,
        sourceCatalog: store.sources(), modelReview: { issues: record.review.issues.filter(issue => issue.method === 'model_assisted'), checks: record.review.checks.filter(check => check.method === 'model_assisted') } });
      for (const evidence of review.evidence) if (evidence.state === 'parameters_aligned') {
        assert.equal(evidence.association_method, 'structured-parameters-v1');
        assert.ok(evidence.parameter_links.length);
        assert.ok(!review.issues.some(issue => issue.rule_id === 'EVID-01' && issue.field_path === evidence.field_path && issue.original === evidence.claim));
      }
      assert.equal(JSON.stringify(record), original);
      const previous = versions.find(item => item.version === record.version - 1);
      const consistency = inspectConsistency(previous, record.review, record.trace.audit_input_hash);
      if (record.review.consistency_check?.state === 'changed') assert.equal(consistency.state, 'changed');
      report.cases.push({ listing_id: record.listing_id, version: record.version, original_request_id: record.trace.provider_request_id, remapped_review_errors: review.issues.filter(issue => issue.rule_id === 'SYS-01').length, consistency: consistency.state });
    }
    const submission = store.product(latest.product_snapshot.product_id)?.evidence_submissions?.[0];
    if (submission) assert.equal(sameEvidence(submission, { ...submission, excerpt: submission.excerpt.replace(/\s+/g, '\n  ') }), true);
  }
  const reportFlag = process.argv.indexOf('--report-dir');
  const directory = reportFlag > -1 ? process.argv[reportFlag + 1] : 'reports/parameter-links-2026-10-23';
  assert.ok(report.cases.length > 0); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(`${directory}/recorded-replay.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ replayed_real_versions: report.cases.length }));
} finally { store.close(); }
