// Engineering boundary tests on an archived real record; not live model acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, rulePack } from '../server/store.mjs';
import { auditContext } from '../server/audit-context.mjs';
import { ruleCitations, citationForField } from '../server/rules-doc.mjs';
import { exportListingReport, exportListingWorklist } from '../server/listing-report.mjs';
import { trendVerdict } from '../server/version-trend.mjs';
const archived = JSON.parse(readFileSync(resolve(ROOT, 'reports/merchant-improvements-2026-10-24/final-record.json'), 'utf8'));

test('legacy export uses its recorded rule version, not the new active pack', () => {
  const context = auditContext(archived);
  assert.equal(context.known, true);
  assert.equal(context.pack.rule_pack_version, archived.rule_pack_version);
  assert.notEqual(context.pack.rule_pack_version, rulePack.rule_pack_version);
  const html = exportListingReport(archived, [archived]);
  assert.ok(html.includes(archived.rule_pack_version));
  assert.ok(!html.includes(rulePack.rule_pack_version));
  assert.ok(html.includes(archived.product_snapshot.product_id));
});

test('unknown historical pack does not acquire current limits or citations', () => {
  const record = { ...archived, rule_pack_version: 'unknown-historical-version' };
  const context = auditContext(record);
  assert.equal(context.known, false);
  assert.deepEqual(context.pack.rules, []);
  const html = exportListingReport(record);
  assert.ok(html.includes('不套用当前规则'));
  assert.ok(html.includes('本规则包未规定上限'));
});

test('new snapshots take precedence and remain immutable during report generation', () => {
  const record = structuredClone(archived);
  record.rule_pack_snapshot = structuredClone(auditContext(archived).pack);
  record.rule_pack_snapshot.rules.find(r => r.rule_id === 'AMZ-01').constraint.max_characters = 7;
  const before = JSON.stringify(record);
  assert.equal(auditContext(record).pack.rules.find(r => r.rule_id === 'AMZ-01').constraint.max_characters, 7);
  exportListingReport(record);
  assert.equal(JSON.stringify(record), before);
});

test('highlight field override is project policy, while title retains official basis', () => {
  const citation = ruleCitations(rulePack).find(r => r.rule_id === 'AMZ-03');
  assert.equal(citationForField(citation, 'content.title').external, true);
  const highlight = citationForField(citation, 'content.item_highlights');
  assert.equal(highlight.external, false);
  assert.equal(highlight.basis_label, '项目内部约定');
  assert.ok(highlight.sources.every(source => !source.is_official));
});

test('trend cannot claim improvement across an algorithm or intermediate rule change', () => {
  const a = structuredClone(archived), b = structuredClone(archived), c = structuredClone(archived);
  a.version = 1; b.version = 2; c.version = 3;
  a.trace.parameter_link_version = 'v1'; b.trace.parameter_link_version = 'v2';
  assert.equal(trendVerdict([a, b]).direction, 'incomparable');
  b.trace.parameter_link_version = 'v1'; c.trace.parameter_link_version = 'v1';
  b.rule_pack_version = 'temporary-other-pack';
  assert.equal(trendVerdict([a, b, c]).direction, 'incomparable');
});

test('worklist includes uncovered parameters and escaped source text', () => {
  const record = structuredClone(archived);
  record.review.unmodeled_parameters = [{ field: 'pocket_count', original: '<script>alert(1)</script>', reason: '人工核对', field_path: 'content.title' }];
  const html = exportListingWorklist(record);
  assert.ok(html.includes('1 处参数不在当前核对范围'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
});

test('运行 ID 在身份卡里说一次就够（末尾不再重复规则/算法版本）', () => {
  const html = exportListingReport(archived);
  // 身份卡在第一屏："运行 ID"这个标签只该出现一次
  assert.equal((html.match(/运行 ID/g) || []).length, 1);
  // 那一行原来的格式（三个东西用 · 串起来）不许再出现
  assert.ok(!html.includes('规则版本：' + archived.rule_pack_version + ' · 算法版本：'));
  assert.ok(html.includes(archived.run_id), '运行 ID 本身不能丢');
});

// The teammate changed the rule contents under v8; old records without snapshots must keep the original pack.
test('integration v8 fallback retains its original rules after v9 migration', () => {
  const version = 'amazon-us-tote-2026-10-28.integration-v8';
  const context = auditContext({ rule_pack_version: version });
  assert.equal(context.known, true);
  assert.equal(context.pack.rule_pack_version, version);
  assert.ok(!context.pack.rules.some(rule => rule.rule_id === 'US-04'));
  assert.ok(!context.pack.sources.some(source => source.source_id === 'AMZS-DETAIL-PROMO'));
  assert.notEqual(rulePack.rule_pack_version, version);
  assert.ok(rulePack.rules.some(rule => rule.rule_id === 'US-04'));
});
