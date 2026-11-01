#!/usr/bin/env node
/**
 * 生成侧结构量具（第 6 轮 · 方向 B 第三件）。
 *
 * 问题：prompt 里写着「一条新品用 1–5 条五点」「id 稳定为 b1..b5」「稀疏事实就少写几条」。
 * 但**这些只是请求，不是保证**——模型返回 6 条、返回空文本、返回两句一模一样，服务端收不收？
 * 收下来之后，我们自己的 14 条规则会不会说一句话？
 *
 * 这条路以前一条都没量过：回归里所有假上游返回的都是 `generateLocalDraft()`（我们自己写的模板），
 * 结构永远合规，所以「结构不合规会怎样」永远走不到。
 *
 * 走的是完整链路：真 store（内存库）→ createService → invokeModel → 假上游 → 确定性审核引擎。
 * 假的只有"模型那一跳"，其余每一跳都是生产代码。
 *
 * 用法：
 *   node scripts/generation-shape-probe.mjs
 *   node scripts/generation-shape-probe.mjs --json
 */
import { setTimeout as delay } from 'node:timers/promises';
import { createStore, scenarios } from '../server/store.mjs';
import { createService } from '../server/service.mjs';

const LONG_TITLE =
  'Premium Heavy Duty Cotton Canvas Shopping Tote Bag with Reinforced Handles and Inner Pocket for Grocery, Beach, School and Daily Use, 4 Pack';

/** 七种"模型可能返回、prompt 却不允许"的结构。每一条都只改一个变量。 */
const CASES = [
  {
    key: 'baseline',
    label: '合规：5 条五点、标题 55 字符',
    content: (base) => base,
  },
  { key: 'six_bullets', label: '六条五点（prompt 说 1–5）', content: (base) => ({ ...base, bullet_points: [...base.bullet_points, { id: 'b6', text: 'Ships flat in a plain carton.' }] }) },
  { key: 'zero_bullets', label: '零条五点', content: (base) => ({ ...base, bullet_points: [] }) },
  { key: 'empty_bullet', label: '其中一条五点是空串', content: (base) => ({ ...base, bullet_points: base.bullet_points.map((x, i) => (i === 1 ? { ...x, text: '' } : x)) }) },
  { key: 'duplicate_bullet', label: '两条五点文本完全相同', content: (base) => ({ ...base, bullet_points: base.bullet_points.map((x, i) => (i === 2 ? { ...x, text: base.bullet_points[0].text } : x)) }) },
  { key: 'long_title', label: `${LONG_TITLE.length} 字符标题（上限 75）`, content: (base) => ({ ...base, title: LONG_TITLE }) },
  { key: 'odd_bullet_id', label: '五点 id 不是 b1..b5（是 item-1）', content: (base) => ({ ...base, bullet_points: base.bullet_points.map((x, i) => ({ ...x, id: `item-${i + 1}` })) }) },
];

/** 一份最小可用的"真实商品"（服务端拒收演示商品，所以把 product_id 换成中性名）。 */
function realProduct() {
  return { ...scenarios.product_profiles[0], product_id: 'SHAPE-PROBE-W101', is_demo: false };
}

async function runCase(item) {
  const store = createStore(':memory:');
  store.saveSettings({
    provider: 'compatible',
    base_url: 'http://127.0.0.1:9/v1',
    model: 'shape-probe',
    api_key: 'not-real',
    timeout_ms: 8000,
  });
  const product = realProduct();

  const original = globalThis.fetch;
  let draft = null;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(JSON.parse(options.body).messages[1].content);
    if (request.operation === 'diagnose') {
      // 诊断那一跳：模型侧一律"没问题"，过滤掉它，剩下的全是确定性引擎的判断。
      return new Response(
        JSON.stringify({
          id: 'probe-diagnose',
          model: 'shape-probe',
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ review: { issues: [], checks: [] }, claim_map: [], patches: [] }) } }],
        }),
        { status: 200 },
      );
    }
    // 生成那一跳：交出这个用例想验的那份结构。
    draft = item.content(structuredClone(BASELINE));
    return new Response(
      JSON.stringify({
        id: 'probe-create',
        model: 'shape-probe',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ content: draft }) } }],
      }),
      { status: 200 },
    );
  };

  const wait = async (run) => {
    for (let i = 0; i < 400; i += 1) {
      const value = store.run(run.run_id);
      if (value.status === 'failed') return { failed: value.error };
      if (value.status === 'succeeded') return { record: store.latest(value.listing_id) };
      await delay(10);
    }
    return { failed: { code: 'TIMEOUT', message: '探针超时' } };
  };

  try {
    const service = createService(store);
    const outcome = await wait(service.enqueue({ operation: 'create', product, content_brief: null }));
    if (outcome.failed) return { key: item.key, label: item.label, accepted: false, error: outcome.failed };
    const record = outcome.record;
    const issues = record.review?.issues || [];
    return {
      key: item.key,
      label: item.label,
      accepted: true,
      bullets: (record.content?.bullet_points || []).length,
      empty_bullets: (record.content?.bullet_points || []).filter((x) => !String(x.text || '').trim()).length,
      title_chars: [...String(record.content?.title || '')].length,
      issues: issues.length,
      blocking: issues.filter((x) => x.severity === 'blocking').length,
      // 有没有哪条问题是在说"结构"本身（条数 / 空文本 / 重复），而不是在说内容。
      structural: issues.filter((x) => /条五点|五点.{0,8}(?:数量|条数)|为空|空文本|重复|duplicate|too many bullet/i.test(x.reason || '')).map((x) => x.rule_id),
      details: issues.map((x) => `${x.rule_id}/${x.severity}: ${String(x.reason || '').replace(/\s+/g, ' ').slice(0, 60)}`),
      rule_ids: [...new Set(issues.map((x) => x.rule_id))],
      checks_completed: (record.review?.checks || []).length,
    };
  } finally {
    globalThis.fetch = original;
    store.close?.();
  }
}

const BASELINE = {
  title: 'Cotton Canvas Tote Bag 4-Pack',
  item_highlights: 'Reusable grocery tote in 7 oz cotton canvas',
  bullet_points: [
    { id: 'b1', text: 'Made of 7 oz cotton canvas.' },
    { id: 'b2', text: 'Measures 17.5 x 16.5 x 5 inches.' },
    { id: 'b3', text: 'Four bags per pack.' },
    { id: 'b4', text: 'Hand wash with cold water.' },
    { id: 'b5', text: 'Wide opening for groceries.' },
  ],
  description: 'A reusable cotton canvas tote for everyday shopping.',
};

function render(rows) {
  const lines = [];
  lines.push('生成侧结构 · 模型返回不合规的结构时，服务端收不收、审不审');
  lines.push('='.repeat(78));
  lines.push('');
  for (const row of rows) {
    if (!row.accepted) {
      lines.push(`✗ ${row.label}`);
      lines.push(`    服务端拒收：${row.error?.code} ${row.error?.message || ''}`);
      continue;
    }
    lines.push(`· ${row.label}`);
    lines.push(
      `    服务端：接受 · 存下五点 ${row.bullets} 条（空文本 ${row.empty_bullets} 条）· 标题 ${row.title_chars} 字 · ` +
        `issue ${row.issues} 条（阻断 ${row.blocking}）· 已查规则 ${row.checks_completed}`,
    );
    lines.push(`    其中在说「结构」的：${row.structural.length ? row.structural.join('、') : '0 条'}`);
    for (const detail of row.details) lines.push(`      - ${detail}`);
  }
  lines.push('');
  lines.push('读法：');
  lines.push('  「在说结构」= 有哪条 issue 在说条数 / 空文本 / 重复，而不是在说文案内容。');
  lines.push('  0 不等于「没问题」，只等于「我们没有任何一条规则在看这件事」。');
  return lines.join('\n');
}

async function main() {
  const rows = [];
  for (const item of CASES) rows.push(await runCase(item));
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }
  process.stdout.write(render(rows) + '\n');
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
