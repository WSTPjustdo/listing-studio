#!/usr/bin/env node
/**
 * 生成侧契约量具（第 6 轮 · 方向 B）。
 *
 * 为什么需要它：审核侧有 14 条规则、有 100 条回归、有逐条官方依据；
 * **生成侧只有一段谁都没测过的英文 system prompt**（`server/providers.mjs` 的 `SYSTEM_PROMPT`）。
 * 改它没有红灯，删它也没有红灯，写错一个数字更不会有红灯——而它决定了模型写出来的东西长什么样。
 *
 * 这个脚本只量"发出去的字节"，不评价"模型照不照做"。两者必须分开说：
 *   能证明的：system 消息里到底有什么字、有没有某个数字、三种风格会不会让这段话变化。
 *   不能证明的：模型读到之后会不会执行（本机没有 Key，真模型一次都没跑过）。
 *   凡是属于后者的，输出里一律标 `unverified`，不许写成"已生效"。
 *
 * 用法：
 *   node scripts/generation-contract.mjs            # 人读的报告
 *   node scripts/generation-contract.mjs --json     # 机器读
 *   node scripts/generation-contract.mjs --strict   # 契约不达标就 exit 1（给 CI/一键命令用）
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPrompt, characterLimits, invokeModel } from '../server/providers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------------------------------------------------------- 一、字段上限 */

/** 把渲染出来的 prompt 里的 `X <= N` 全抓回来。抓不回来说明那句话的格式坏了。 */
function parseLimitsFromPrompt(text) {
  const out = [];
  const re = /([A-Za-z][A-Za-z ]*?) <= (\d+)/g;
  let hit;
  while ((hit = re.exec(String(text)))) out.push({ label: hit[1].trim(), max: Number(hit[2]) });
  return out;
}

/** 现行包 + `amazon-focus/history/` 下所有历史包。历史包是"过去真的存在过的上限"。 */
function allPacks() {
  const packs = [];
  const current = JSON.parse(readFileSync(resolve(ROOT, 'amazon-focus/rules.json'), 'utf8'));
  packs.push({ file: 'amazon-focus/rules.json', pack: current });
  const histDir = resolve(ROOT, 'amazon-focus/history');
  for (const name of readdirSync(histDir).filter((x) => x.endsWith('.json')).sort()) {
    packs.push({ file: `history/${name}`, pack: JSON.parse(readFileSync(resolve(histDir, name), 'utf8')) });
  }
  return packs;
}

function currentPack() {
  return JSON.parse(readFileSync(resolve(ROOT, 'amazon-focus/rules.json'), 'utf8'));
}

/**
 * 渲染回读：把 prompt 里印出来的数字抓回来，和规则包里的上限逐条对。
 *
 * 这不是同义反复：`characterLimits` 算出 12 行，渲染那句话可能漏掉字段、写错标签、
 * 或者被后来的人改回写死。抓回来的东西才是模型真看到的。
 */
function limitTable() {
  const rows = [];
  for (const { file, pack } of allPacks()) {
    const expected = characterLimits(pack.rules || []);
    const printed = parseLimitsFromPrompt(buildSystemPrompt({ rules: pack.rules || [] }));
    const missing = expected.filter((item) => !printed.some((p) => p.label === item.label && p.max === item.max));
    const extra = printed.filter((p) => !expected.some((item) => item.label === p.label && item.max === p.max));
    rows.push({
      pack: pack.rule_pack_version || file,
      file,
      expected_count: expected.length,
      printed_count: printed.length,
      agree: expected.length === printed.length && missing.length === 0 && extra.length === 0,
      missing,
      extra,
      printed,
    });
  }
  return rows;
}

/**
 * 合成一个把上限改成 80 / 140 的包，看 prompt 跟不跟。
 *
 * 仓库里 6 个真实包的标题上限**全是 75**，所以拿真实数据永远证明不了"数字是从包里来的"。
 * 只有造一个不一样的包才能分清"读包"和"写死"——这是这一段存在的唯一理由。
 */
function syntheticPackCheck() {
  const rules = [
    { rule_id: 'TEST-01', field_paths: ['content.title'], constraint: { max_characters: 80 } },
    { rule_id: 'TEST-02', field_paths: ['content.item_highlights'], constraint: { max_characters: 140 } },
  ];
  const text = buildSystemPrompt({ rules });
  const printed = parseLimitsFromPrompt(text);
  return {
    printed,
    follows_pack: printed.some((x) => x.max === 80) && printed.some((x) => x.max === 140),
    no_stale_numbers: !/<= 75\b/.test(text) && !/<= 125\b/.test(text), // allow-hardcoded-limit
  };
}

/* ---------------------------------------------------------------- 二、生成侧禁令 */

/**
 * 每一类要求**同一句话里同时出现这一类目和禁止动词**，不是"出现了这个词"。
 *
 * 为什么按句子判而不按固定字符窗口：prompt 里这一整段是一句话加一串分号，
 * 固定窗口（先写 90 字符）第一次就漏判了——`Never write any of the following ...:` 之后
 * 隔了 150 个字符才是 reviews。窗口调大又会把别的段落算进来，两头都不对。
 * 句子边界是这份文本里唯一真实的结构。
 *
 * **但"有禁止动词 + 出现某个词"仍然会误报**：第一版把
 * `review must be an object ... never null` 判成了"禁了引用评价"——那是 JSON 契约，
 * 跟评价毫无关系，只因为句子里有 never 和 review。所以关键词必须是**这一类目本身**
 * （`customer reviews` 而不是 `review`），这和上一轮 `featured in Black` 是同一类错。
 */
const PROHIBITIONS = [
  { key: 'review_quote', label: '引用顾客评价 / 证言', keywords: [/\bcustomer reviews?\b/i, /\btestimonials?\b/i, /\bstar ratings?\b/i, /\bwhat customers say\b/i] },
  { key: 'review_solicit', label: '索评 / 诱导评价', keywords: [/\bleave a review\b/i, /\bleave feedback\b/i, /\bstar rating\b/i, /\bin exchange\b/i] },
  { key: 'promotion', label: '促销语 / 折扣 / 包邮', keywords: [/\bdiscounts?\b/i, /\bcoupons?\b/i, /\bpromo codes?\b/i, /\bfree shipping\b/i, /\bon-sale\b/i, /\bprice-comparison\b/i] },
  { key: 'time_sensitive', label: '时间敏感 / 限时催单', keywords: [/\blimited time\b/i, /\btoday only\b/i, /\bwhile supplies last\b/i, /\bact now\b/i] },
  { key: 'price_contact', label: '价格 / 联系方式', keywords: [/\bprices\b/i, /\bphone numbers?\b/i, /\be-?mail addresses?\b/i, /\bcontact information\b/i] },
  { key: 'offensive', label: '冒犯性 / 歧视性表述', keywords: [/\boffensive\b/i, /\bdiscriminatory\b/i, /\bderogatory\b/i, /\bprofan\w*\b/i] },
];

const PROHIBITION_VERB = /\b(?:do not|never|must not|avoid|prohibited|not allowed)\b/i;

/** 把 prompt 切成句子。英文句号 + 空白，够用；这份文本里没有小数与缩写干扰。 */
function sentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function prohibitionCoverage(prompt = buildSystemPrompt({ rules: currentPack().rules || [] })) {
  const list = sentences(prompt);
  return PROHIBITIONS.map((item) => {
    for (const sentence of list) {
      if (!PROHIBITION_VERB.test(sentence)) continue;
      if (!item.keywords.some((pattern) => pattern.test(sentence))) continue;
      return { key: item.key, label: item.label, covered: true, evidence: sentence.slice(0, 180) };
    }
    return { key: item.key, label: item.label, covered: false, evidence: '' };
  });
}

/* ---------------------------------------------------------------- 三、表达风格传导 */

/** 界面上的三选一（`src/ContentBrief.tsx`）。这里刻意抄一份：界面改了要有人发现两组不一致。 */
export const UI_STYLES = ['简洁自然', '参数清晰', '场景导向'];

/** 四栏 brief 的字段名。locomotion 上它们靠一个中文 label 传递。 */
export const BRIEF_FIELDS = ['audience', 'use_case', 'concern', 'style'];

/**
 * 只差一个 style 的三份请求，看"整份发给模型的东西"差多少。
 *
 * 刻意量整份（system + user）而不是只看 system：`localization_policy` 在 user 侧，
 * 里面确实出现了 style 这个词——只量 system 会把它算成"完全没提"，那是低估。
 */
async function styleTransfer() {
  const rules = currentPack().rules || [];
  const prompt = buildSystemPrompt({ rules });
  const briefFor = (style) => ({
    audience: '日常购物用户',
    use_case: '日常携带',
    concern: '尺寸与使用便利',
    style,
  });
  const captured = [];
  for (const style of UI_STYLES) captured.push(await wireCall(rules, briefFor(style)));

  const base = captured[0];
  // 逐位比对整串是错的：插进去一段文字，后面每个字符都"不同"，会报出 6913 这种假数字
  // （第一次跑就报了这个）。改成两件结构上说得清的事：system 段长度差 + 请求 JSON 里变了哪些键。
  const diffs = captured.slice(1).map((item) => ({
    against: item.style,
    system_length_delta: item.system.length - base.system.length,
    system_identical: item.system === base.system,
    changed_payload_keys: changedKeys(JSON.parse(base.user || '{}'), JSON.parse(item.user || '{}')),
  }));

  const whole = base.system + base.user;
  return {
    styles: UI_STYLES.map((style, index) => ({
      style,
      chars: style.length,
      // 这 4 个汉字会不会真的出现在发出去的 system 消息里（而不只是躺在请求 JSON 里）。
      in_system_message: captured[index].system.includes(style),
      // 带这个 brief 比不带 brief 多出来的字符数（写法要求就是这部分）。用长度差，不用逐位比对。
      extra_system_chars: captured[index].system.length - prompt.length,
    })),
    // 四栏 brief 的字段名有没有在"发给模型的整份文本"里被解释过。
    brief_fields_in_system: BRIEF_FIELDS.filter((f) => new RegExp(`\\b${f}\\b`, 'i').test(whole)),
    brief_fields_in_payload: BRIEF_FIELDS.filter((f) => whole.includes(f)),
    diffs,
    max_system_delta: diffs.reduce((max, item) => Math.max(max, Math.abs(item.system_length_delta)), 0),
    system_message_invariant: diffs.every((item) => item.system_identical),
    whole_chars: whole.length,
  };
}

/** 两份请求 JSON 里哪些键变了。递归到底，返回 `a.b` 形式的路径。 */
function changedKeys(before, after, prefix = '') {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changed = [];
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const a = before?.[key];
    const b = after?.[key];
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
      changed.push(...changedKeys(a, b, path));
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      changed.push(path);
    }
  }
  return changed;
}

/* ---------------------------------------------------------------- 四、真发一次，确认拦到的是同一段 */

/** 拦一份真实请求体。只替换 fetch，其余（拼 system 消息、加输出契约）全走生产代码。 */
async function wireCall(rules, brief = null) {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return new Response(
      JSON.stringify({
        id: 'contract-probe-1',
        model: 'contract-probe',
        usage: { total_tokens: 1 },
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                content: { title: 'T', item_highlights: 'H', bullet_points: [{ id: 'b1', text: 'x' }], description: 'D' },
              }),
            },
          },
        ],
      }),
    );
  };
  try {
    await invokeModel(
      { provider: 'compatible', base_url: 'http://127.0.0.1:9', model: 'contract-probe', api_key: '', timeout_ms: 5000 },
      {
        operation: 'create',
        product: null,
        current_content: null,
        rules,
        sources: [],
        ...(brief ? { content_brief: brief } : {}),
      },
    );
  } finally {
    globalThis.fetch = original;
  }
  const system = captured?.messages?.[0]?.content || '';
  const user = captured?.messages?.[1]?.content || '';
  return { system, user, style: brief?.style ?? null };
}

/* ---------------------------------------------------------------- 六、写死的上限还剩几处 */

/**
 * 扫一遍生产代码里还有几处"把 75 / 125 当数字写出来"。
 *
 * 为什么这一节必须存在：这两个数字在这个仓库里被写死过四次（prompt、报告脚注、改稿模板、
 * 联调脚本），每一次都不报错、只是悄悄和规则包脱轨。改完不钉住，下一轮很容易又写回去。
 *
 * 允许剩下的两类：官方报错原文引用（必须逐字）、测试里当反例。其余一律算红。
 */
function hardcodedLimitScan() {
  const targets = [
    ['server', /\.mjs$/],
    ['src', /\.(ts|tsx)$/],
    ['scripts', /\.mjs$/],
  ];
  const hits = [];
  for (const [dir, pattern] of targets) {
    const base = resolve(ROOT, dir);
    for (const name of readdirSync(base).filter((file) => pattern.test(file))) {
      const text = readFileSync(resolve(base, name), 'utf8');
      text.split('\n').forEach((line, index) => {
        // 注释行不算：本仓库的注释里大量引用这两个数字来解释历史，那是有价值的记录。
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        // 官方报错原文必须逐字引用，放行。
        if (/Length cannot be more than 75 characters/.test(line)) return;
        // 量具自己拿这两个数字当反例（「旧数字不许再出现」这条断言的模式），显式标记放行。
        if (line.includes('allow-hardcoded-limit')) return;
        if (/<=\s*(?:75|125)\b|under (?:75|125) characters|\b75 or 125\b/.test(line)) {
          hits.push(`${dir}/${name}:${index + 1}`);
        }
      });
    }
  }
  return hits;
}

/* ---------------------------------------------------------------- 报告 */

function render(report) {
  const lines = [];
  const L = (s = '') => lines.push(s);

  L('生成侧契约 · 发出去的字节到底长什么样');
  L('='.repeat(66));
  L('');

  L('[1] 上限：把 prompt 印出来的数字抓回来，和规则包逐条对');
  const bad = report.limit_rows.filter((row) => !row.agree);
  L(`    对照 ${report.pack_count} 个规则包（现行 1 + 历史 ${report.pack_count - 1}），渲染回读不一致 ${bad.length} 个包`);
  for (const row of report.limit_rows) {
    L(
      `    ${row.agree ? '✓' : '✗'} ${row.pack}：包内上限 ${row.expected_count} 处 / prompt 印出 ${row.printed_count} 处` +
        (row.printed.length ? `（${row.printed.map((x) => `${x.label} <= ${x.max}`).join('，')}）` : ''),
    );
    for (const item of row.missing) L(`        漏印：${item.label} <= ${item.max}`);
    for (const item of row.extra) L(`        多印：${item.label} <= ${item.max}`);
  }
  const synth = report.synthetic;
  L(`    合成一个上限为 80 / 140 的包：prompt ${synth.follows_pack ? '跟着变成 80 / 140' : '没有跟着变'}，` +
    `旧数字${synth.no_stale_numbers ? '已不再出现' : '仍然残留'}`);
  L('    （必须造一个不一样的包：6 个真实包的标题上限全是 75，拿真实数据证不了数字是从包里读的。）');
  L('');

  L('[2] 生成侧禁令：六类各有没有一句英文禁止句');
  const covered = report.prohibitions.filter((x) => x.covered);
  L(`    覆盖 ${covered.length}/${report.prohibitions.length}`);
  for (const item of report.prohibitions) {
    L(`    ${item.covered ? '✓' : '✗'} ${item.label}${item.covered ? `  ← ${item.evidence}` : '  （prompt 里没有这一类的禁止句）'}`);
  }
  L('');

  L('[3] 表达风格：界面上三选一，发出去的请求差在哪');
  for (const item of report.styles.styles) {
    L(
      `    ${item.style}：${item.chars} 个中文字；出现在 system 消息里：${item.in_system_message ? '是' : '否'}；` +
        `带这个 brief 比不带多出 ${item.extra_system_chars} 字符`,
    );
  }
  L(`    brief 四个字段名在整份请求里被解释过：${report.styles.brief_fields_in_system.length}/4 ${JSON.stringify(report.styles.brief_fields_in_system)}`);
  for (const item of report.styles.diffs) {
    L(`    换到「${item.against}」：system 段 ${item.system_length_delta >= 0 ? '+' : ''}${item.system_length_delta} 字符` +
      `（同一份文本：${item.system_identical ? '是' : '否'}）；请求 JSON 里变的键：${item.changed_payload_keys.join('、') || '无'}`);
  }
  L(`    → system 段最大差异 ${report.styles.max_system_delta} 字符；三种风格${report.styles.system_message_invariant ? '发出去的 system 消息逐字节相同' : '各带一段不同的英文写法要求'}`);
  if (report.styles.system_message_invariant) {
    L('    → 结论：换风格时模型收到的唯一新信息，就是 content_brief.style 那几个中文字；');
    L('      没有一句英文说这几种风格各自该怎么写——界面上这个三选一等于没落到模型那边。');
  } else {
    L('    → 结论：三种风格各自带一段英文写法要求（说什么、按什么顺序说、什么不许说），');
    L(`      所以 system 消息不再相同。模型是否照做 ${report.styles.model_behavior}。`);
  }
  L('');

  L('[4] 拦一次真实的请求体，确认量的是同一段话');
  L(`    发出去的 system 消息 ${report.wire.sent_system_chars} 字符，与自己拼的那份一致：${report.wire.starts_with_prompt ? '是' : '否'}`);
  L('    这就是每次生成固定要付的 prompt 开销——除此之外没有第二个 system 段。');
  L(`    同一次请求的 user 消息 ${report.wire.user_message_chars} 字符：带的是现行包的整份规则，但没有商品档案，`);
  L('    所以这个数不代表真实商品请求；真实请求的 user 侧随商品档案大小变化，本脚本不量它。');
  L('');

  L('[5] 生产代码里还有几处把 75 / 125 当数字写出来');
  if (!report.hardcoded.length) {
    L('    0 处。上限只从规则包来，数字只有一个出处。');
  } else {
    for (const hit of report.hardcoded) L(`    ✗ ${hit}`);
    L('    这些地方换包之后不会跟着变，也不会有红灯——它们只会静静地和审核结果打脸。');
  }
  L('');

  L('[6] 不能证明的部分（别读成已生效）');
  for (const line of report.unverified) L(`    - ${line}`);

  return lines.join('\n');
}

async function main() {
  const json = process.argv.includes('--json');
  const strict = process.argv.includes('--strict');

  const rows = limitTable();
  const noBriefPrompt = buildSystemPrompt({ rules: currentPack().rules || [] });
  const wire = await wireCall(currentPack().rules || []);
  const report = {
    generated_by: 'scripts/generation-contract.mjs',
    prompt_chars: noBriefPrompt.length,
    prompt_version: (() => {
      const hit = readFileSync(resolve(ROOT, 'server/service.mjs'), 'utf8').match(/const PROMPT_VERSION\s*=\s*'([^']+)'/);
      return hit ? hit[1] : null;
    })(),
    limit_rows: rows,
    synthetic: syntheticPackCheck(),
    pack_count: allPacks().length,
    prohibitions: prohibitionCoverage(noBriefPrompt),
    hardcoded: hardcodedLimitScan(),
    styles: await styleTransfer(),
    wire: {
      sent_system_chars: wire.system.length,
      starts_with_prompt: wire.system.startsWith(noBriefPrompt),
      user_message_chars: wire.user.length,
    },
    unverified: [
      '模型读到这些禁止句之后是否真的遵守：本机没有 Key，真模型一次都没跑过。',
      '三种风格在真模型输出里是否产生可辨差异：同样没跑过；离线只能证明请求不同，不能证明输出不同。',
    ],
  };
  report.styles.model_behavior = 'unverified';

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(render(report) + '\n');
  }

  if (strict) {
    const failures = [];
    if (report.limit_rows.some((row) => !row.agree)) failures.push('上限数字没有从规则包渲染出来');
    if (!report.synthetic.follows_pack) failures.push('换一个上限不同的包，prompt 没有跟着变');
    if (!report.synthetic.no_stale_numbers) failures.push('prompt 里还残留写死的上限数字');
    if (!report.wire.starts_with_prompt) failures.push('发出去的 system 消息与自己拼的那份不一致');
    if (report.prohibitions.some((x) => !x.covered)) failures.push('生成侧禁令缺类');
    if (report.styles.brief_fields_in_system.length < 4) failures.push('brief 字段没有在发给模型的文本里解释过');
    if (report.styles.system_message_invariant) failures.push('三种风格发出去的 system 消息逐字节相同');
    if (report.hardcoded.length) failures.push(`生产代码里还有 ${report.hardcoded.length} 处写死的上限数字`);
    if (failures.length) {
      process.stderr.write(`契约不达标：${failures.join('；')}\n`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
