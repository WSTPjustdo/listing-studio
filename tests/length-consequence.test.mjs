// 标题超限这句话必须分场景说清后果：新建会拒收，存量会被平台 AI 代改。
// 20 条真实在售文案里 11 条（55%）标题超 75，全都在正常卖——只说「阻断」等于吓人。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { characterCount, reviewContent } from '../server/domain.mjs';
import { rulePack, scenarios, ROOT } from '../server/store.mjs';
import { exportListingReport } from '../server/listing-report.mjs';

const profile = scenarios.product_profiles[0];
const content = (title) => ({ title, item_highlights: '', bullet_points: [], description: '' });
const review = (value) => reviewContent({ content: value, profile, rulePack });
const titleIssue = (value) => review(value).issues.find((x) => x.rule_id === 'AMZ-01');

test('标题超限要说清两种后果，不能只说「阻断」', () => {
  const issue = titleIssue(content('A'.repeat(80) + ' tote bag'));
  assert.ok(issue, '超过 75 应当报出来');
  assert.match(issue.reason, /拒收/, '新建这条路：平台直接拒收');
  assert.match(issue.suggestion, /存量/, '存量这条路要单独说，否则读的人以为马上要下架');
  assert.match(issue.suggestion, /AI/, '存量的真实后果是被平台 AI 代改');
  assert.equal(issue.severity, 'blocking', '严重度不许在这条改动里被动过');
});

test('上限数字来自规则包，不写死在文案里', () => {
  const max = rulePack.rules.find((x) => x.rule_id === 'AMZ-01').constraint.max_characters;
  const issue = titleIssue(content('A'.repeat(max + 1)));
  assert.ok(issue.reason.includes(String(max)));
  assert.ok(characterCount('A'.repeat(max + 1)) > max);
});

test('亮点超限的后果官方没写，所以不许编', () => {
  const max = rulePack.rules.find((x) => x.rule_id === 'AMZ-02').constraint.max_characters;
  const issue = review({ ...content('ok'), item_highlights: 'B'.repeat(max + 1) }).issues.find(
    (x) => x.rule_id === 'AMZ-02',
  );
  assert.ok(issue);
  assert.doesNotMatch(issue.reason, /拒收/, '没核过的后果不许写进界面');
  assert.doesNotMatch(issue.suggestion, /存量/, '同上');
});

// 界面/报告上看到的才算数：只改 engine 的字符串，导出的纸还是旧话，等于没改。
test('两种后果要能落到导出的报告上（不只是 engine 里那句）', () => {
  const archived = JSON.parse(
    readFileSync(`${ROOT}/reports/merchant-improvements-2026-10-24/final-record.json`, 'utf8'),
  );
  const review = reviewContent({
    content: content('A'.repeat(90) + ' tote bag'),
    profile: archived.product_snapshot,
    rulePack,
  });
  const record = { ...structuredClone(archived), review };
  const html = exportListingReport(record, [record]);
  assert.ok(html.includes('拒收'), '报告里要能看到「新建会拒收」');
  assert.ok(html.includes('存量'), '报告里要能看到「存量不下架但会被改」');
});

// 第 21 轮（方向 C）：这句话里曾经带一个引号里的「报错原文」，而那个帖子的完整链接没留住、
// 唯一登记的来源（公告帖 AMZS-TITLE-2026）里也没有这句话。能复核的才写原文，不能复核的写「转述」。
test('不能复核的「原文」不许带引号出现，要明说是转述', () => {
  const issue = titleIssue(content('A'.repeat(90) + ' tote bag'));
  assert.doesNotMatch(issue.reason, /报错原文/, '「报错原文」四个字等于宣称自己引了原文');
  assert.doesNotMatch(issue.reason, /Length cannot be more than/, '这句原文的帖子本项目已无法打开');
  assert.match(issue.reason, /转述/, '不能复核的结论要自己说是转述');
  assert.equal(issue.severity, 'blocking', '严重度不在这一改里动（降不降级是待拍板项）');
});

test('公告帖自己能背书的部分照旧：存量不下架 + 75 这个数字', () => {
  const issue = titleIssue(content('A'.repeat(90) + ' tote bag'));
  assert.match(issue.reason, /75/);
  assert.match(issue.suggestion, /不会因此下架/);
  assert.match(issue.suggestion, /listings stay active|逐步改写/);
});
