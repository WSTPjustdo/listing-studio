// 交付物对账：文档里写的每条命令、每个链接、每个数字，跟仓库实际对一遍。
//
// 为什么要有它：README / DELIVERY / 队友首次运行 是别人接触这个工程的唯一入口。
// 第 16 轮之前这些文件从没被「照着执行」过——本轮第一次照做就发现
// 「29 项融合工程检查」实际是 30 项，而 `npm run test:parameters` 在本机会
// 抛一句没有上下文的 `assert.ok(record)`。
//
// 用法：
//   node scripts/delivery-audit.mjs          静态三节（命令 / 链接 / 数字）
//   node scripts/delivery-audit.mjs --run    再加「真跑」一节（会启动子进程）
//   --strict   有任何红就 exit 1

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const withRun = process.argv.includes('--run');
const strict = process.argv.includes('--strict');

const DOCS = [
  'README.md',
  'DELIVERY.md',
  '队友首次运行.md',
  'platform-export/README.md',
  'CURRENT-STATUS.md',
  'PRODUCT-READINESS.md',
];

// 「不需要本机状态、不需要网络、不调用付费模型」的那几条，必须真的能跑通。
const DETERMINISTIC = ['rules:check', 'test:integration', 'test:merchant-facts', 'test:flat-file'];
// 这几条在 README 的「真实验收」里，天然依赖本机已有真实记录或已启动的服务。
// 对账时只报告「这里为什么跑不了」，不算失败——但必须说得出理由。
const NEEDS_LOCAL_STATE = ['test:parameters', 'test:live:flat-file', 'test:live:library'];

const red = [];
const notes = [];
const section = title => console.log(`\n## ${title}`);

const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts;
const BUILTIN_OK = new Set(['ci', 'install', 'start', 'test']);
const docTexts = new Map();
for (const doc of DOCS) {
  const path = resolve(root, doc);
  if (!existsSync(path)) {
    red.push(`文档不存在：${doc}`);
    continue;
  }
  docTexts.set(doc, readFileSync(path, 'utf8'));
}

// ── 一节：文档里的每条 npm 命令是不是真的有 ────────────────────────────
section('一 · 命令对账');
const commandHits = [];
for (const [doc, text] of docTexts) {
  for (const match of text.matchAll(/npm (?:run )?([a-z][\w:.-]*)/g)) {
    const isRun = /npm run /.test(match[0]);
    commandHits.push({ doc, command: match[1], form: isRun ? 'run' : 'bare' });
  }
}
const uniqueCommands = [...new Set(commandHits.map(hit => hit.command))].sort();
const brokenCommands = [];
for (const command of uniqueCommands) {
  const hit = commandHits.find(item => item.command === command);
  const ok = hit.form === 'run' ? Object.hasOwn(scripts, command) : BUILTIN_OK.has(command);
  if (!ok) brokenCommands.push(`${command}（${hit.doc}）`);
}
console.log(`文档 ${docTexts.size} 份，出现 ${uniqueCommands.length} 条不同的 npm 命令；找不到的 ${brokenCommands.length} 条。`);
if (brokenCommands.length) {
  for (const item of brokenCommands) console.log(`  ✗ ${item}`);
  red.push(`文档引用了不存在的命令：${brokenCommands.join('、')}`);
} else {
  console.log('  ✓ 全部能在 package.json 或 npm 内置命令里找到');
}
const notInReadme = Object.keys(scripts).filter(name => !commandHits.some(hit => hit.command === name));
notes.push(`package.json 有 ${Object.keys(scripts).length} 个脚本，其中 ${notInReadme.length} 个文档里没提（量具与内部脚本，不必写进 README）`);

// ── 二节：相对链接是否都指得到 ─────────────────────────────────────────
section('二 · 链接对账');
const linkHits = [];
for (const [doc, text] of docTexts) {
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const clean = target.replace(/#.*$/, '');
    if (!clean) continue;
    linkHits.push({ doc, target: clean, abs: resolve(dirname(resolve(root, doc)), clean) });
  }
}
const brokenLinks = linkHits.filter(hit => !existsSync(hit.abs));
console.log(`${linkHits.length} 条站内链接，指不到的 ${brokenLinks.length} 条。`);
if (brokenLinks.length) {
  for (const hit of brokenLinks) console.log(`  ✗ ${hit.doc} → ${hit.target}`);
  red.push(`站内链接失效 ${brokenLinks.length} 条`);
} else {
  console.log('  ✓ 全部指得到真实文件或目录');
}

// ── 三节：文档里的「N 项」是不是真的 N ────────────────────────────────
section('三 · 数字对账');
const INTEGRATION_FILES = [
  'tests/parameter-integration.test.mjs',
  'tests/integration-report.test.mjs',
  'tests/integration-batch-ops.test.mjs',
  'tests/integration-provider-metadata.test.mjs',
];
let measuredIntegration = null;
function measureIntegration() {
  try {
    const output = execFileSync(process.execPath, ['--test', '--test-force-exit', '--test-reporter=tap', ...INTEGRATION_FILES], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return Number(/^# tests (\d+)$/m.exec(output)?.[1] ?? NaN);
  } catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    const count = Number(/^# tests (\d+)$/m.exec(text)?.[1] ?? NaN);
    return Number.isFinite(count) ? count : null;
  }
}
measuredIntegration = measureIntegration();
const claimPattern = /(\d+)\s*项融合工程检查/g;
const claims = [];
for (const [doc, text] of docTexts) {
  for (const match of text.matchAll(claimPattern)) claims.push({ doc, claimed: Number(match[1]) });
}
if (!Number.isFinite(measuredIntegration)) {
  console.log('  ? 量不出 test:integration 的条数（子进程没给出 TAP 汇总）');
  red.push('无法实测融合工程检查条数');
} else if (!claims.length) {
  console.log(`  实测 test:integration = ${measuredIntegration} 项；文档里没有引用这个数字`);
} else {
  const wrong = claims.filter(claim => claim.claimed !== measuredIntegration);
  console.log(`  实测 test:integration = ${measuredIntegration} 项；文档引用 ${claims.length} 处，不一致 ${wrong.length} 处。`);
  for (const claim of wrong) {
    console.log(`  ✗ ${claim.doc}：写的是 ${claim.claimed} 项`);
    red.push(`${claim.doc} 的「${claim.claimed} 项融合工程检查」与实测 ${measuredIntegration} 项不一致`);
  }
  if (!wrong.length) console.log('  ✓ 数字与实测一致');
}

// ── 四节：第三方组件声明跟锁文件、跟已装依赖对不对得上 ─────────────────
section('四 · 第三方组件声明');
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const inventory = JSON.parse(readFileSync(resolve(root, 'THIRD_PARTY_INVENTORY.json'), 'utf8'));
const lockEntries = Object.entries(lock.packages).filter(([path]) => path);

// 清单是 scripts/export-licenses.mjs 按锁文件顺序逐条生成的，所以按下标对齐；
// 顺手用 name 校验顺序没串行——串了就整批报，而不是静默比错行。
function compareInventory(entries, rows) {
  const findings = [];
  if (entries.length !== rows.length) findings.push(`清单 ${rows.length} 条 / 锁文件 ${entries.length} 个包`);
  entries.forEach(([path, entry], index) => {
    const row = rows[index];
    if (!row) {
      findings.push(`${path} 没有对应清单行`);
      return;
    }
    const leaf = path.split('node_modules/').at(-1);
    if (row.name !== leaf) findings.push(`第 ${index + 1} 行是 ${row.name}，锁文件是 ${leaf}（顺序串了）`);
    if (row.version !== entry.version) findings.push(`${row.name}: 清单 ${row.version} / 锁文件 ${entry.version}`);
  });
  return findings;
}

function compareTable(declaredRows, packages, mapping) {
  const findings = [];
  for (const [label, pkgName] of mapping) {
    const row = declaredRows.get(label);
    const entry = packages[`node_modules/${pkgName}`];
    if (!row) {
      findings.push(`表里没有 ${label}`);
      continue;
    }
    if (!entry) {
      findings.push(`锁文件里没有 ${pkgName}（表里却写着）`);
      continue;
    }
    if (row.version !== entry.version) findings.push(`${label} 版本：表里 ${row.version} / 锁文件 ${entry.version}`);
    if (entry.license && row.license !== entry.license) findings.push(`${label} 许可证：表里 ${row.license} / 锁文件 ${entry.license}`);
  }
  return findings;
}

function parseDeclaredTable() {
  const declared = new Map();
  for (const line of readFileSync(resolve(root, 'THIRD_PARTY.md'), 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length < 3 || /^-+$/.test(cells[0]) || cells[0] === '组件') continue;
    declared.set(cells[0], { version: cells[1], license: cells[2] });
  }
  return declared;
}

// THIRD_PARTY.md 那张表是给人看的，最容易与代码走散：版本抄错、许可证抄错。
const TABLE_ROWS = [
  ['React / React DOM', 'react'],
  ['Cheerio', 'cheerio'],
  ['ExcelJS', 'exceljs'],
  ['lucide-react', 'lucide-react'],
  ['Zod', 'zod'],
  ['Vite', 'vite'],
  ['@vitejs/plugin-react', '@vitejs/plugin-react'],
  ['TypeScript', 'typescript'],
  ['concurrently', 'concurrently'],
  ['@playwright/test', '@playwright/test'],
  ['@types/node', '@types/node'],
  ['@types/react', '@types/react'],
  ['@types/react-dom', '@types/react-dom'],
  ['Prettier', 'prettier'],
];

const declared = parseDeclaredTable();
const inventoryFindings = compareInventory(lockEntries, inventory);
const tableFindings = compareTable(declared, lock.packages, TABLE_ROWS);
const missingLicenseFiles = inventory.flatMap(row => (row.license_files ?? []).filter(file => !existsSync(resolve(root, file))).map(file => `${row.name}: ${file}`));

console.log(`锁文件 ${lockEntries.length} 个包；清单 ${inventory.length} 条；清单登记的许可正文 ${inventory.reduce((sum, row) => sum + (row.license_files?.length ?? 0), 0)} 个文件，缺 ${missingLicenseFiles.length} 个。`);
console.log(`  THIRD_PARTY.md 直接依赖表 ${declared.size} 行；版本/许可对不上 ${tableFindings.length} 处。`);
for (const finding of [...inventoryFindings.slice(0, 5), ...tableFindings.slice(0, 5)]) console.log(`  ✗ ${finding}`);
if (inventoryFindings.length) red.push(`第三方清单与锁文件不一致：${inventoryFindings.slice(0, 3).join('；')}`);
if (tableFindings.length) red.push(`THIRD_PARTY.md 组件表与锁文件不一致：${tableFindings.slice(0, 3).join('；')}`);
if (missingLicenseFiles.length) red.push(`清单里指向的许可正文缺失：${missingLicenseFiles.slice(0, 3).join('；')}`);

if (process.argv.includes('--self-test')) {
  // 「0 处不一致」和「一个都没比」在输出上长得一样。动一个版本号，看它会不会红。
  const doctored = inventory.map(row => ({ ...row }));
  doctored[3] = { ...doctored[3], version: '0.0.1-not-real' };
  const inventoryCaught = compareInventory(lockEntries, doctored);
  const tableCopy = new Map(declared);
  const firstLabel = [...tableCopy.keys()][0];
  tableCopy.set(firstLabel, { ...tableCopy.get(firstLabel), license: 'WTFPL-not-real' });
  const tableCaught = compareTable(tableCopy, lock.packages, TABLE_ROWS);
  console.log(`  自证：改掉清单第 4 行版本 → 报 ${inventoryCaught.length} 条；改掉「${firstLabel}」的许可证 → 报 ${tableCaught.length} 条。`);
  if (!inventoryCaught.length || !tableCaught.length) red.push('自证失败：改错数据却没被报出来，说明这一节的比对是空转');
}

// ── 五节（可选）：真跑那几条不需要 Key 的命令 ─────────────────────────
if (withRun) {
  section('五 · 真跑（不需要 Key）');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const run = name => {
    const started = Date.now();
    const result = spawnSync(`${npm} run --silent ${name}`, {
      cwd: root,
      shell: true,
      encoding: 'utf8',
      timeout: 180_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    // 第一版把 `triggerUncaughtException(` 和 `Error.captureStackTrace(err);` 当成了错误信息
    // —— 那两行是 Node 打印堆栈的壳子，里面没有一个字告诉你缺什么。
    const noise = /^(at |\^|node:|\(node:|\(Use |Node\.js v|npm ERR|#)/;
    const codeFragment = /^[A-Za-z_$][\w.$]*\([^)]*[;,) ]?$/;
    const literalLine = /^[\w"'[\]]+: (true|false|null|\d|[\[\]{}]+,?)$|^\}[,;]?$/;
    const candidates = output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line
        && line.length >= 12
        && !noise.test(line)
        && !codeFragment.test(line)
        && !literalLine.test(line)
        && !/^[-=]{3,}$/.test(line));
    // 有的脚本会先打一行「...，因为：」，真正的原因在下一行。
    let firstErrorLine = candidates[0] ?? '';
    if (/[:：]$/.test(firstErrorLine) && candidates[1]) firstErrorLine = `${firstErrorLine} ${candidates[1]}`;
    return { name, code: result.status, ms: Date.now() - started, firstErrorLine };
  };

  console.log('必须通过的一组：');
  for (const name of DETERMINISTIC) {
    const outcome = run(name);
    const ok = outcome.code === 0;
    console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(20)} exit=${outcome.code} ${outcome.ms}ms${ok ? '' : `  ${outcome.firstErrorLine}`}`);
    if (!ok) red.push(`npm run ${name} 失败（exit ${outcome.code}）`);
  }

  console.log('需要本机状态的一组（跑不通要能说清缺什么）：');
  for (const name of NEEDS_LOCAL_STATE) {
    const outcome = run(name);
    const ok = outcome.code === 0;
    console.log(`  ${ok ? '✓' : '·'} ${name.padEnd(20)} exit=${outcome.code} ${outcome.ms}ms${ok ? '' : `  ${outcome.firstErrorLine}`}`);
    if (!ok) notes.push(`${name} 在本机跑不了：${outcome.firstErrorLine || '（没有任何可读的错误行）'}`);
  }
}

console.log('\n## 结论');
console.log(`红 ${red.length} 条${red.length ? `：\n  - ${red.join('\n  - ')}` : ''}`);
if (notes.length) {
  console.log(`备注 ${notes.length} 条：`);
  for (const note of notes) console.log(`  · ${note}`);
}
if (strict && red.length) process.exit(1);
