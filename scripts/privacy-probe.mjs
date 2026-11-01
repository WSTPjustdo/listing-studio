#!/usr/bin/env node
/**
 * 隐私与安全量具（第 7 轮 · 方向 K）。
 *
 * 为什么需要它：这个产品手里有**商家的真实商品资料**，也有**模型 API Key**。
 * 到第 6 轮为止，全仓库没有任何一处检查过「这两样东西会不会跑出这台机器」——
 * 报告导出、CSV 回填、API 响应、错误信息、打包清单，一条都没量过。
 *
 * 这个脚本只量**能离线量的事**：
 *   能证明的：某个字符串到底在不在那份字节里、某个单元格开头是不是 `=`、哪些文件被 git 跟踪。
 *   不能证明的：真 Key 在真网络下会不会被中间人看到、评委的浏览器会不会真的执行。
 *   凡是属于后者的，输出里一律标 `unverified`。
 *
 * 用法：
 *   node scripts/privacy-probe.mjs            # 人读的报告
 *   node scripts/privacy-probe.mjs --json     # 机器读
 *   node scripts/privacy-probe.mjs --strict   # 发现泄漏就 exit 1
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import { readTable } from '../server/flat-file.mjs';
import { exportFlatFile } from '../server/flat-file-export.mjs';
import { exportListingReport, exportListingWorklist } from '../server/listing-report.mjs';
import { createStore } from '../server/store.mjs';
import { getConfig, saveConfig } from '../server/providers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = resolve(ROOT, '.runtime/privacy-probe');
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const strict = argv.includes('--strict');

/** 假密钥。长得像真的（前缀 + 足够长），但每个字符都是这里写死的。 */
const FAKE_KEY = 'sk-privacyprobe-0123456789abcdef-PLACEHOLDER';
const ARCHIVED = JSON.parse(readFileSync(resolve(ROOT, 'reports/merchant-improvements-2026-10-24/final-record.json'), 'utf8'));

/** 一次到位地把哨兵字符串拆成两半存着，免得这个脚本自己变成"泄漏源"。 */
const half = (text) => [text.slice(0, text.length - 8), text.slice(-8)];

const checks = [];
function check(id, label, value, verdict, detail = '') {
  checks.push({ id, label, value, verdict, detail });
}
const countIn = (haystack, needle) => String(haystack).split(needle).length - 1;

/* ------------------------------------------------------------ 一、API 响应里有没有密钥 */

async function apiSurface() {
  const db = resolve(SCRATCH, 'api.sqlite');
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(db + suffix)) rmSync(db + suffix);
  const port = 18000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_PATH: db,
      MODEL_PROVIDER: 'compatible',
      MODEL_BASE_URL: 'https://api.deepseek.com',
      MODEL_NAME: 'deepseek-flash',
      MODEL_API_KEY: FAKE_KEY,
      DIFY_CREATE_API_KEY: FAKE_KEY,
      DIFY_DIAGNOSE_API_KEY: FAKE_KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    await delay(120);
    try { up = (await fetch(`${base}/api/health`)).ok; } catch { up = false; }
  }
  const rows = [];
  if (!up) {
    child.kill();
    return { up: false, rows, error: '服务没起来，本节没量到' };
  }
  const routes = ['/api/bootstrap', '/api/settings', '/api/telemetry', '/api/products', '/api/listings', '/api/batches'];
  for (const route of routes) {
    let body = '';
    try {
      const response = await fetch(`${base}${route}`);
      body = await response.text();
      rows.push({
        route,
        status: response.status,
        bytes: body.length,
        key_hits: countIn(body, FAKE_KEY),
        has_api_key_flag: /has_api_key/.test(body),
        leaks_setting_value: /"api_key"\s*:\s*"[^"]+/.test(body),
      });
    } catch (error) {
      rows.push({ route, status: null, bytes: 0, key_hits: 0, error: String(error?.message || error) });
    }
  }
  child.kill();
  await delay(200);
  return { up: true, rows };
}

/* ------------------------------------------------------ 二、导出文件里有没有密钥与本机痕迹 */

function exportSurface() {
  const report = exportListingReport(ARCHIVED, [ARCHIVED]);
  const worklist = exportListingWorklist(ARCHIVED, [ARCHIVED]);
  const record = structuredClone(ARCHIVED);
  record.trace = { ...record.trace, api_key: FAKE_KEY, provider_base_url: `https://api.example.com/?key=${FAKE_KEY}` };
  const tainted = exportListingReport(record, [record]);
  const files = [
    { name: '审阅报告.html', text: report },
    { name: '改稿工作单.html', text: worklist },
    { name: '审阅报告（trace 里塞了密钥的合成版）.html', text: tainted },
  ];
  const scanners = [
    { id: 'fake_key', pattern: FAKE_KEY, why: '假密钥原文' },
    { id: 'bearer', pattern: 'Bearer ', why: '鉴权头写法' },
    { id: 'machine_path', pattern: 'C:\\Users\\', why: '本机绝对路径' },
    { id: 'runtime_dir', pattern: '.runtime', why: '运行时目录名' },
    { id: 'sqlite', pattern: 'listing-studio.sqlite', why: '本地库文件名' },
  ];
  return files.map((file) => ({
    name: file.name,
    bytes: Buffer.byteLength(file.text),
    hits: scanners.map((scanner) => ({
      ...scanner,
      count: countIn(file.text, scanner.pattern),
    })),
  }));
}

/* ------------------------------------------------- 三、商家文案里的 HTML 载荷会不会被原样印出来 */

/**
 * 载荷分两类，量法不一样 —— 这一条是第一版量具自己错了才补上的。
 *
 * `markup`：带尖括号，只有**原样**出现在 HTML 里才危险（会被解析成标签）。
 * `url_scheme`：`javascript:alert(1)` 这串字**原样出现在正文里完全无害**，
 *   它只有在 `href=` / `src=` 的属性值位置上才成真。
 * 第一版把两者一起数，得出「原样出现 6 处」的假数字；正确的指标是
 * 「标记类原样 0 处」+「属性位置 0 处」。
 */
const PAYLOADS = [
  { id: 'script', kind: 'markup', text: '<script>alert(1)</script>' },
  { id: 'img_onerror', kind: 'markup', text: '<img src=x onerror="alert(1)">' },
  { id: 'svg_onload', kind: 'markup', text: '<svg onload=alert(1)>' },
  { id: 'attr_break', kind: 'markup', text: '" onmouseover="alert(1)' },
  { id: 'js_url', kind: 'url_scheme', text: 'javascript:alert(1)' },
  { id: 'style_break', kind: 'markup', text: '</style><script>alert(1)</script>' },
];

const escapeOf = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 某个字符串出现在「属性值位置」的次数：`href="…"` 或 `src="…"` 里含它。 */
const inAttribute = (html, needle) => {
  let hits = 0;
  const re = /(?:href|src)="([^"]*)"/gi;
  let hit;
  while ((hit = re.exec(html))) if (hit[1].includes(needle)) hits += 1;
  return hits;
};

function htmlSurface() {
  const record = structuredClone(ARCHIVED);
  record.content.title = PAYLOADS.map((p) => p.text).join(' ');
  record.content.item_highlights = PAYLOADS[0].text;
  record.content.description = PAYLOADS[1].text;
  record.content.bullet_points = [{ id: 'b1', text: PAYLOADS[2].text }];
  record.review = {
    ...record.review,
    issues: [{
      rule_id: 'AMZ-01', field_path: 'content.title', title: PAYLOADS[3].text,
      original: PAYLOADS[4].text, reason: PAYLOADS[0].text, suggestion: PAYLOADS[1].text,
      method: 'hard_rule', severity: 'blocking', source_ids: [],
    }, ...(record.review?.issues || [])],
    unmodeled_parameters: [],
  };
  // 规则的原文链接也塞一个 javascript: —— 它是唯一真的会被写进 <a href> 的位置。
  const pack = structuredClone(ARCHIVED);
  pack.rule_pack_snapshot = {
    rule_pack_version: ARCHIVED.rule_pack_version,
    rules: [],
    sources: [{ source_id: 'PROBE-SRC', publisher: 'probe', url: 'javascript:alert(1)', is_official: true, document_date: null, checked_at: null }],
  };
  pack.review = {
    ...pack.review,
    issues: [{ rule_id: 'AMZ-01', field_path: 'content.title', title: 't', original: 'o', reason: 'r', suggestion: 's', method: 'hard_rule', severity: 'blocking', source_ids: ['PROBE-SRC'] }],
  };

  const report = exportListingReport(record, [record]);
  const worklist = exportListingWorklist(record, [record]);
  // 规则包的 source.url 是另一条路：它会被写进 `href="…"`，而 HTML 转义不改变协议。
  const linkReport = exportListingReport(pack, [pack]);
  const rows = PAYLOADS.map((payload) => ({
    id: payload.id,
    kind: payload.kind,
    raw_report: countIn(report, payload.text),
    escaped_report: countIn(report, escapeOf(payload.text)),
    raw_worklist: countIn(worklist, payload.text),
    in_attr_report: inAttribute(report, payload.text),
    in_attr_worklist: inAttribute(worklist, payload.text),
  }));
  const markup = rows.filter((row) => row.kind === 'markup');
  return {
    rows,
    markup_raw_total: markup.reduce((sum, row) => sum + row.raw_report + row.raw_worklist, 0),
    attribute_total: rows.reduce((sum, row) => sum + row.in_attr_report + row.in_attr_worklist, 0),
    script_tag_report: (report.match(/<script/gi) || []).length,
    script_tag_worklist: (worklist.match(/<script/gi) || []).length,
    js_href_report: (report.match(/href="javascript:/gi) || []).length,
    js_href_worklist: (worklist.match(/href="javascript:/gi) || []).length,
    js_href_from_rule_source: (linkReport.match(/href="javascript:/gi) || []).length,
    link_probe_bytes: Buffer.byteLength(linkReport),
    bytes: { report: Buffer.byteLength(report), worklist: Buffer.byteLength(worklist) },
  };
}

/* ------------------------------------------- 四、CSV/TSV 回填会不会写出可执行的公式单元格 */

/** OWASP 的判据：首字符属于这五个之一，且长度大于 1，电子表格软件就当成公式/远程引用。 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * 一个够用的 CSV/TSV 解析器：认双引号包裹与 `""` 转义。
 *
 * 第一版用 `line.split(',')` 数格子，结果 `=HYPERLINK("https://…","Click me")`
 * 被逗号劈成两半，两头都不以 `=` 开头 —— **恰好那一条最像攻击的反而没数进去**。
 * 数错了方向和数对了方向一样坏：会让人以为「只有 2 个字符格」。
 */
function splitDelimited(line, delimiter) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { cells.push(cell); cell = ''; }
    else cell += char;
  }
  cells.push(cell);
  return cells;
}

function formulaCells(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.length);
  const delimiter = lines[0]?.includes('\t') ? '\t' : ',';
  const cells = [];
  for (const line of lines)
    for (const [column, raw] of splitDelimited(line, delimiter).entries())
      if (FORMULA_LEAD.test(raw.trim()) && raw.trim().length > 1)
        cells.push({ column, value: raw.trim() });
  return cells;
}

async function csvSurface() {
  const csv = [
    'sku,item_name,product_description,bullet_point1,bullet_point2,bullet_point3,bullet_point4,bullet_point5,generic_keywords',
    `SKU-PROBE-1,=1+1,plain description,plain bullet,plain bullet,plain bullet,plain bullet,plain bullet,@SUM(A1:A2)`,
    `SKU-PROBE-2,plain title,plain description,plain bullet,plain bullet,plain bullet,plain bullet,plain bullet,+1+1`,
  ].join('\r\n');
  const original = Buffer.from(csv, 'utf8');
  const source = await readTable('privacy-probe.csv', original);
  const record = structuredClone(ARCHIVED);
  record.content.title = '=HYPERLINK("https://example.com/leak","Click me")';
  const store = { latest: () => record };
  const batch = {
    rows: [
      { row: source.data_start_row, sku: 'SKU-PROBE-1', status: 'completed', listing_id: 'probe-listing' },
      { row: source.data_start_row + 1, sku: 'SKU-PROBE-2', status: 'completed', listing_id: 'probe-listing' },
    ],
    mapping: source.mapping,
  };
  const result = await exportFlatFile(store, batch, source, { format: 'csv' });
  const cells = formulaCells(result.buffer);
  // 同一批数据再导一次 xlsx，把格子读回来看看它是「字符串」还是「公式对象」。
  // 报警里写着「xlsx 里按文本写入」，这句话必须被量过。
  const xlsxResult = await exportFlatFile(store, batch, source, { format: 'xlsx' });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(xlsxResult.buffer);
  const xlsxCells = [];
  book.worksheets[0].eachRow({ includeEmpty: false }, (row, number) => {
    row.eachCell({ includeEmpty: false }, (cell, column) => {
      const value = cell.value;
      const looksFormula = typeof value === 'string' && FORMULA_LEAD.test(value.trim());
      const isFormulaObject = Boolean(value && typeof value === 'object' && 'formula' in value);
      if (looksFormula || isFormulaObject) xlsxCells.push({ row: number, column, is_formula_object: isFormulaObject, text: String(value?.formula ?? value).slice(0, 60) });
    });
  });
  // 量具自检：喂一行"带引号 + 带逗号"的已知值，看解析器能不能只切出 2 格。
  const selfcheckLine = '"=HYPERLINK(""https://example.com/leak"",""Click me"")",plain';
  const selfcheckCells = splitDelimited(selfcheckLine, ',');
  const parserSelfcheck = {
    cells: selfcheckCells.length,
    first_starts_with_formula: FORMULA_LEAD.test(selfcheckCells[0].trim()),
    ok: selfcheckCells.length === 2 && FORMULA_LEAD.test(selfcheckCells[0].trim()),
  };
  return {
    parser_selfcheck: parserSelfcheck,
    output_bytes: result.buffer.length,
    safe_to_export: result.validation.safe_to_export,
    formula_cells_declared: result.validation.formula_cells ?? null,
    xlsx_cells: xlsxCells,
    xlsx_safe_to_export: xlsxResult.validation.safe_to_export,
    warnings: result.validation.warnings,
    formula_cells: cells,
    mentioned: result.validation.warnings.concat(result.validation.issues.map((i) => i.message))
      .some((line) => /公式|formula/i.test(line)),
    sample: result.buffer.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).slice(0, 3),
  };
}

/* --------------------------------------------------- 五、打包边界：私密文件会不会跟着走 */

/** 与 `scripts/package-share.mjs` 第 15 行完全一致的那条正则，抄一遍以便单独量。 */
const DENY = /(^|\/)(?:\.runtime|\.git|node_modules|__pycache__|\.cache|test-results|playwright-report|releases)(\/|$)|(?:^|\/)\.env(?:$|\.(?!example$))|\.(?:sqlite(?:-shm|-wal)?|db|pyc|log)$|(?:^|\/)(?:credentials|secrets)(?:\.|\/|$)/i;

function packagingSurface() {
  let tracked = [];
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    tracked = [];
  }
  const privateish = tracked.filter((file) => DENY.test(file));
  const probes = [
    { path: '.env', should_deny: true },
    { path: '.runtime/listing-studio.sqlite', should_deny: true },
    { path: 'releases/listing-studio.zip', should_deny: true },
    { path: 'node_modules/x/i.js', should_deny: true },
    { path: '.env.example', should_deny: false },
    { path: 'src/App.tsx', should_deny: false },
    { path: 'reports/merchant-improvements-2026-10-24/final-record.json', should_deny: false },
  ].map((probe) => ({ ...probe, denied: DENY.test(probe.path), agree: DENY.test(probe.path) === probe.should_deny }));
  const exported = tracked.filter((file) => /^reports\/.*\.(json|md|html)$/.test(file));
  return { tracked_count: tracked.length, privateish, probes, exported_records: exported };
}

/* ---------------------------------------------------------- 六、本地库：密钥与商品原文的落点 */

function storageSurface() {
  // 用**临时库**验证「密钥怎么落盘」，绝不往 `.runtime/listing-studio.sqlite` 里写假 Key：
  // 那是这台机器上真实在用的库，写进去就等于我自己制造了一次泄漏。
  const file = resolve(SCRATCH, 'storage.sqlite');
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) rmSync(file + suffix);
  const readAll = () => ['', '-wal', '-shm'].map((suffix) => file + suffix).filter(existsSync)
    .map((path) => readFileSync(path).toString('latin1')).join('');
  const walBytes = () => (existsSync(`${file}-wal`) ? readFileSync(`${file}-wal`).length : 0);
  let settings = { present: false };
  try {
    const store = createStore(file);
    saveConfig(store, {
      provider: 'compatible', base_url: 'https://api.siliconflow.cn/v1', model: 'probe-model',
      api_key: FAKE_KEY, dify_base_url: 'https://api.dify.ai/v1', timeout_ms: 60000,
    });
    const afterWrite = { hits: countIn(readAll(), FAKE_KEY), wal_bytes: walBytes(), visible: Boolean(getConfig(store).api_key) };
    saveConfig(store, {
      provider: 'compatible', base_url: 'https://api.siliconflow.cn/v1', model: 'probe-model',
      dify_base_url: 'https://api.dify.ai/v1', timeout_ms: 60000, clear_secrets: true,
    });
    const afterClear = { hits: countIn(readAll(), FAKE_KEY), wal_bytes: walBytes(), visible: Boolean(getConfig(store).api_key) };
    store.close();
    const afterClose = { hits: countIn(readAll(), FAKE_KEY), wal_bytes: walBytes() };
    settings = { present: true, after_write: afterWrite, after_clear: afterClear, after_close: afterClose };
  } catch (error) {
    settings = { present: false, error: String(error?.message || error) };
  }
  // 「在 DeepSeek 官方接口下点清除密钥」会不会被"没有 Key"的校验拦住。
  let deepseekClear = { allowed: false, error: null };
  try {
    const file2 = resolve(SCRATCH, 'storage-deepseek.sqlite');
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(file2 + suffix)) rmSync(file2 + suffix);
    const store2 = createStore(file2);
    saveConfig(store2, { provider: 'compatible', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', api_key: FAKE_KEY, dify_base_url: 'https://api.dify.ai/v1', timeout_ms: 60000 });
    saveConfig(store2, { provider: 'compatible', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', dify_base_url: 'https://api.dify.ai/v1', timeout_ms: 60000, clear_secrets: true });
    deepseekClear = { allowed: true, error: null, still_visible: Boolean(getConfig(store2).api_key) };
    store2.close();
  } catch (error) {
    deepseekClear = { allowed: false, error: `${error.code || ''} ${error.message || error}`.trim() };
  }
  const sources = [
    'server/store.mjs', 'server/index.mjs', 'server/service.mjs', 'server/batch.mjs', 'server/library.mjs',
  ].map((file) => ({ file, delete_statements: (readFileSync(resolve(ROOT, file), 'utf8').match(/DELETE\s+FROM/gi) || []).length }));
  return { settings, deepseek_clear: deepseekClear, delete_paths: sources, delete_total: sources.reduce((sum, row) => sum + row.delete_statements, 0) };
}

/* ------------------------------------ 七、配置写错时，批量会不会一路打下去烧额度 */

async function runawaySurface(configured = 8) {
  const { prepareRows, createBatchManager } = await import('../server/batch.mjs');
  const { createService } = await import('../server/service.mjs');
  const store = createStore(':memory:');
  const original = globalThis.fetch;
  let calls = 0;
  let body = '';
  for (let index = 1; index <= configured; index += 1)
    body += `SKU-${index},棉布袋${index},棉布手提袋,100% cotton,38,42,140,Cotton Tote Bag ${index},Simple tote bag\r\n`;
  const csv = `SKU,商品名称,品类,材质,宽度,高度,克重,英文标题,英文描述\r\n${body}`;
  store.saveSettings({
    provider: 'compatible', base_url: 'http://127.0.0.1:9/v1', model: 'fake-1',
    api_key: 'wrong-key', timeout_ms: 8000,
  });
  // 假上游只会回 401：模拟「Key 写错 / 额度用错账号」，这一类错误重试多少次都不会好。
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  };
  const manager = createBatchManager(store, createService(store));
  try {
    const source = { id: 'runaway', ...(await readTable('runaway.csv', Buffer.from(csv, 'utf8'))) };
    store.saveImport(source);
    const batch = manager.start({
      import_id: source.id, mapping: source.mapping, operation: 'create', duplicate: 'skip',
      confirm_scope: false, selected: source.rows.map((row) => row.number), edits: {},
    });
    const startedAt = Date.now();
    for (let i = 0; i < 400; i += 1) {
      const current = store.batch(batch.id);
      if (current.status === 'finished' || current.status === 'paused') break;
      manager.tick();
      await delay(20);
    }
    const final = store.batch(batch.id);
    return {
      configured_rows: configured,
      upstream_calls: calls,
      final_status: final.status,
      failed_rows: final.rows.filter((row) => row.status === 'failed').length,
      retryable_rows: final.rows.filter((row) => row.retryable === true).length,
      error_codes: [...new Set(final.rows.map((row) => row.error_code).filter(Boolean))],
      first_action: final.rows[0]?.error_action || null,
      seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    };
  } finally {
    globalThis.fetch = original;
    manager.close();
    store.close();
  }
}

/* -------------------------------------------------------------------------- 输出 */

function render(report) {
  const lines = [];
  const row = (id, label, value, verdict, detail) =>
    lines.push(`| ${id} | ${label} | ${value} | ${verdict === 'pass' ? '通过' : verdict === 'fail' ? '**失败**' : '读数'} |${detail ? ` ${detail} |` : ''}`);

  lines.push('# 隐私与安全量具（离线可复现）', '');
  lines.push(`- 假密钥长度 ${FAKE_KEY.length} 字符，形如 \`${half(FAKE_KEY)[0]}…\``);
  lines.push(`- 导出样本：\`reports/merchant-improvements-2026-10-24/final-record.json\`（真实记录，未改内容）`);
  lines.push('', '## 一、API 响应里有没有密钥', '');
  if (!report.api.up) lines.push(`- 服务没起来：${report.api.error}`);
  else {
    lines.push('| 路由 | 状态 | 字节 | 密钥命中 | 只回布尔 |');
    lines.push('|---|---|---|---|---|');
    for (const item of report.api.rows)
      lines.push(`| \`${item.route}\` | ${item.status ?? '—'} | ${item.bytes} | ${item.key_hits} | ${item.has_api_key_flag === undefined ? '—' : item.has_api_key_flag ? '是' : '否'} |`);
  }

  lines.push('', '## 二、导出文件里有没有密钥 / 本机痕迹', '', '| 文件 | 字节 | 密钥 | Bearer | 本机路径 | .runtime | 库文件名 |', '|---|---|---|---|---|---|---|');
  for (const file of report.exports)
    lines.push(`| ${file.name} | ${file.bytes} | ${file.hits[0].count} | ${file.hits[1].count} | ${file.hits[2].count} | ${file.hits[3].count} | ${file.hits[4].count} |`);

  lines.push('', '## 三、HTML 载荷会不会被原样印出来', '', '| 载荷 | 类型 | 报告里原样 | 报告里已转义 | 工作单里原样 | 属性位置 |', '|---|---|---|---|---|---|');
  for (const item of report.html.rows)
    lines.push(`| \`${item.id}\` | ${item.kind} | ${item.raw_report} | ${item.escaped_report} | ${item.raw_worklist} | ${item.in_attr_report + item.in_attr_worklist} |`);
  lines.push('', `- **标记类载荷原样出现：${report.html.markup_raw_total} 处**（这是会变成标签的那种）`);
  lines.push(`- 属性位置（\`href=\`/\`src=\`）命中：${report.html.attribute_total} 处`);
  lines.push(`- \`<script\` 标签：报告 ${report.html.script_tag_report} 处，工作单 ${report.html.script_tag_worklist} 处`);
  lines.push(`- 规则包 source.url 写成 \`javascript:\` 时，报告里的 \`href="javascript:\`：**${report.html.js_href_from_rule_source}** 处（样本 ${report.html.link_probe_bytes} 字节）`);

  lines.push('', '## 四、CSV 回填的公式注入面', '');
  lines.push(`- 输出 ${report.csv.output_bytes} 字节，\`safe_to_export\` = ${report.csv.safe_to_export}`);
  lines.push(`- 以公式前缀（\`= + - @\` 制表符 回车）开头的单元格：**${report.csv.formula_cells.length}** 个`);
  for (const cell of report.csv.formula_cells) lines.push(`  - 第 ${cell.column + 1} 列：\`${cell.value.slice(0, 60)}\``);
  lines.push(`- validation 里申报的数量：${report.csv.formula_cells_declared ?? '（没申报）'}`);
  lines.push(`- validation 里有没有一句提到公式风险：${report.csv.mentioned ? '有' : '**没有**'}`);
  lines.push(`- 同一批数据导成 xlsx：以公式前缀开头的格子 ${report.csv.xlsx_cells.length} 个，其中真的存成公式对象的 **${report.csv.xlsx_cells.filter((c) => c.is_formula_object).length}** 个`);

  lines.push('', '## 五、打包边界', '');
  lines.push(`- git 跟踪的文件 ${report.packaging.tracked_count} 个，其中命中私密路径正则的：**${report.packaging.privateish.length}** 个`);
  for (const file of report.packaging.privateish) lines.push(`  - \`${file}\``);
  lines.push('', '| 样本路径 | 应该被排除 | 正则判定 | 一致 |', '|---|---|---|---|');
  for (const probe of report.packaging.probes)
    lines.push(`| \`${probe.path}\` | ${probe.should_deny ? '是' : '否'} | ${probe.denied ? '是' : '否'} | ${probe.agree ? '✓' : '✗'} |`);

  lines.push('', '## 六、本地库：密钥落盘与「清除」之后还剩什么', '');
  if (report.storage.settings.present) {
    const s = report.storage.settings;
    lines.push('在**临时库**里写一个假 Key，再看它在文件里还剩几次。三个时刻：');
    lines.push('');
    lines.push('| 时刻 | 字节里能搜到 | `-wal` 大小 | 接口读回 |');
    lines.push('|---|---|---|---|');
    lines.push(`| 写入后（服务未关） | **${s.after_write.hits}** | ${s.after_write.wal_bytes}B | ${s.after_write.visible ? '有 Key' : '无'} |`);
    lines.push(`| 点「清除密钥」后（服务未关） | **${s.after_clear.hits}** | ${s.after_clear.wal_bytes}B | ${s.after_clear.visible ? '有 Key' : '无'} |`);
    lines.push(`| 关掉服务后（WAL 落盘） | **${s.after_close.hits}** | ${s.after_close.wal_bytes}B | — |`);
  } else lines.push(`- 临时库没建起来：${report.storage.settings.error || '未知'}`);
  const ds = report.storage.deepseek_clear;
  lines.push(`- 在 **DeepSeek 官方接口**下点「清除密钥」：${ds.allowed ? `允许，清除后接口读回${ds.still_visible ? '**仍有 Key**' : '无 Key'}` : `**被拒绝** —— ${ds.error}`}`);
  lines.push('');
  lines.push(`- 服务端 5 个模块里 \`DELETE FROM\` 共 **${report.storage.delete_total}** 处 —— 也就是说**没有任何"删掉这个商品"的路径**`);

  const r = report.runaway;
  lines.push('', '## 七、模型配置写错时，批量会不会一路打下去', '');
  lines.push('假上游对每一次调用都回 401（Key 写错 / 账号不对，这一类重试多少次都不会自己好）。');
  lines.push('');
  lines.push('| 配了几行 | 上游被调用 | 跑完用了 | 批次最终状态 | 失败行 | 标记可重试的行 |');
  lines.push('|---|---|---|---|---|---|');
  lines.push(`| ${r.configured_rows} | **${r.upstream_calls}** | ${r.seconds}s | ${r.final_status} | ${r.failed_rows} | ${r.retryable_rows} |`);
  lines.push('');
  lines.push(`- 错误码：${r.error_codes.join('、') || '（无）'}；界面给的第一句动作：${r.first_action || '（无）'}`);
  lines.push(`- 判读：上游调用 ${r.upstream_calls} 次 / 配置 ${r.configured_rows} 行 —— ${r.upstream_calls >= r.configured_rows ? '**每一行都打了**，没有熔断' : '有提前收手'}`);

  lines.push('', '## 不能证明的（unverified）', '');
  for (const line of report.unverified) lines.push(`- ${line}`);
  return lines.join('\n');
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  const api = await apiSurface();
  const exports = exportSurface();
  const html = htmlSurface();
  const csv = await csvSurface();
  const packaging = packagingSurface();
  const storage = storageSurface();
  const runaway = await runawaySurface();

  const apiLeaks = api.rows.reduce((sum, row) => sum + (row.key_hits || 0), 0);
  const apiSettingValue = api.rows.some((row) => row.leaks_setting_value);
  check('api_key_in_response', 'API 响应里出现密钥原文', apiLeaks, api.up ? (apiLeaks ? 'fail' : 'pass') : 'info');
  check('api_setting_value', 'API 响应里出现 settings 的 api_key 字段值', apiSettingValue ? 1 : 0, apiSettingValue ? 'fail' : 'pass');
  const exportLeaks = exports.reduce((sum, file) => sum + file.hits.reduce((inner, hit) => inner + (hit.id === 'fake_key' ? hit.count : 0), 0), 0);
  check('export_key', '导出文件里出现密钥原文', exportLeaks, exportLeaks ? 'fail' : 'pass');
  check('export_paths', '导出文件里出现本机绝对路径 / 运行时目录', exports.reduce((sum, f) => sum + f.hits[2].count + f.hits[3].count + f.hits[4].count, 0), 'info');
  check('html_raw', '标记类 HTML 载荷原样出现在导出页面里', html.markup_raw_total, html.markup_raw_total ? 'fail' : 'pass');
  check('html_attr', '载荷出现在 href/src 属性位置', html.attribute_total, html.attribute_total ? 'fail' : 'pass');
  check('html_js_rule_url', '规则包 source.url 为 javascript: 时报告里的 href', html.js_href_from_rule_source, html.js_href_from_rule_source ? 'fail' : 'pass');
  check('csv_formula', 'CSV 输出里以公式前缀开头的单元格（只计数，策略是不改字节）', csv.formula_cells.length, 'info');
  check('csv_mention', 'CSV validation 提到公式风险', csv.mentioned ? 1 : 0, csv.mentioned ? 'pass' : 'fail');
  check('csv_declared', 'validation 申报的格数与实际一致', csv.formula_cells_declared === csv.formula_cells.length ? 1 : 0, csv.formula_cells_declared === csv.formula_cells.length ? 'pass' : 'fail');
  check('xlsx_not_formula', 'xlsx 导出把这类格子存成公式对象', csv.xlsx_cells.filter((c) => c.is_formula_object).length, csv.xlsx_cells.every((c) => !c.is_formula_object) ? 'pass' : 'fail');
  check('csv_parser', 'CSV 解析器自检（带引号与逗号的单元格）', csv.parser_selfcheck.ok ? 1 : 0, csv.parser_selfcheck.ok ? 'pass' : 'fail');
  check('tracked_private', 'git 跟踪的私密文件数', packaging.privateish.length, packaging.privateish.length ? 'fail' : 'pass');
  check('deny_regex', '打包排除正则与样本判定一致', packaging.probes.filter((p) => p.agree).length, packaging.probes.every((p) => p.agree) ? 'pass' : 'fail');
  const clearHits = storage.settings.present ? storage.settings.after_clear.hits : null;
  check('key_residue', '清除密钥后，文件字节里还能搜到旧 Key 几次', clearHits, clearHits === 0 ? 'pass' : 'fail');
  check('deepseek_clear', 'DeepSeek 接口下允许清除密钥', storage.deepseek_clear.allowed ? 1 : 0, storage.deepseek_clear.allowed ? 'pass' : 'fail');
  check('runaway', '配置写错时上游被调用的次数（应当少于配的行数）', runaway.upstream_calls, runaway.upstream_calls < runaway.configured_rows ? 'pass' : 'fail');

  const report = {
    fake_key_shape: `${half(FAKE_KEY)[0]}…`,
    api, exports, html, csv, packaging, storage, runaway, checks,
    unverified: [
      '真 Key 在真网络下会不会被中间人看到：本节只量本地字节，不量链路。',
      '评委/商家双击打开 CSV 时 Excel 会不会真的执行那条公式：本节只判首字符，没有用 Excel 打开过。',
      '导出的 HTML 用浏览器打开会不会弹出对话框：本节只扫字节，没在浏览器里打开过。',
      '真模型生成的文案里会不会真出现公式前缀：本机没有 Key，一次都没跑过。',
    ],
  };
  writeFileSync(resolve(SCRATCH, 'report.json'), JSON.stringify(report, null, 2));

  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write(render(report) + '\n');

  if (strict) {
    const failures = checks.filter((item) => item.verdict === 'fail');
    if (failures.length) {
      process.stderr.write(`隐私检查未通过：${failures.map((item) => item.label).join('；')}\n`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
