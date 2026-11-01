// 同一句话不许被两条规则各报一遍——但「不重复报」不许变成「假装核对过了」。
// 一组输入是记录的 W101 快照（只读），不是模型结果。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewContent } from '../server/domain.mjs';

const recorded = JSON.parse(readFileSync(new URL('../reports/parameter-links-2026-10-23/actual-export.json', import.meta.url)));
const profile = recorded.product_snapshot;
const rulePack = JSON.parse(readFileSync(new URL('../amazon-focus/rules.json', import.meta.url)));
const content = (title) => ({ title, item_highlights: '', bullet_points: [], description: '' });
const review = (title) => reviewContent({ content: content(title), profile, rulePack });
const onTitle = (r) => r.issues.filter((x) => x.field_path === 'content.title');
const evidCheck = (r) => r.checks.find((x) => x.rule_id === 'EVID-01');

// 背景：20 条真实在售文案上量过，97 条 EVID-01 里 79 条（81%）所在的字段上，
// 另一条规则已经就同一句话给过更重的结论。同一句被念两遍，读的人会以为有两处问题。

test('同一句已经由 AMZ-05 报过冲突时，EVID-01 不再单独报一遍', () => {
  const r = review('15 x 16.5 in');
  assert.ok(onTitle(r).some((x) => x.rule_id === 'AMZ-05'), '冲突本身仍要报');
  assert.equal(onTitle(r).filter((x) => x.rule_id === 'EVID-01').length, 0, '同一句不再出现第二条');
  assert.equal(onTitle(r).length, 1, '标题上只剩一条问题');
});

test('不重复报 ≠ 假装核对通过：被盖掉的那句仍然让 EVID-01 停在待核对', () => {
  const r = review('15 x 16.5 in');
  const check = evidCheck(r);
  assert.notEqual(check.state, 'pass');
  assert.equal(check.state, 'needs_evidence');
  assert.match(check.reason, /1 句/, '状态里要能数出被盖掉了几句');
});

test('没有别的规则报过的句子，EVID-01 仍然单独报（合并不许吞信息）', () => {
  const r = review('20 inch wide'); // 只写了一个长度，说不清是宽还是高
  const evid = onTitle(r).filter((x) => x.rule_id === 'EVID-01');
  assert.equal(evid.length, 1, '别无他人的句子必须自己报出来');
  assert.equal(evid[0].severity, 'needs_review');
  assert.equal(onTitle(r).length, 1, '也不能因此多报一条别的');
  assert.equal(evidCheck(r).state, 'needs_evidence');
});
