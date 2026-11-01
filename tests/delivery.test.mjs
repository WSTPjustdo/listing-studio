import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TABLE_FORMATS, TABLE_LIMITS } from '../server/flat-file.mjs';
import { CALLS_PER_ROW } from '../server/batch-cost.mjs';

// 交付物（技术侧）的守卫：platform-export/ 里说的数字必须等于代码里的数字。
// 这些断言不测产品行为，测的是「交付给别人的那几份文件有没有跟产品走散」。

const root = resolve(import.meta.dirname, '..');
const exportDir = resolve(root, 'platform-export');
const platform = JSON.parse(readFileSync(resolve(exportDir, 'platform.json'), 'utf8'));

function runExport(args) {
  return execFileSync(process.execPath, [resolve(root, 'scripts/export-platform.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('platform.json 与代码常量一致（`export:platform --check` 通过，且不改文件）', () => {
  const before = readFileSync(resolve(exportDir, 'platform.json'), 'utf8');
  const output = runExport(['--check']);
  assert.match(output, /已是最新/);
  assert.equal(readFileSync(resolve(exportDir, 'platform.json'), 'utf8'), before, '--check 不许写盘');
});

test('量具自证：把 max_rows 改回 200，--check 必须变红', () => {
  // 这条是给上面那条兜底的。没有它，"检查通过"和"检查根本没比"在输出上一样。
  const scratch = mkdtempSync(join(tmpdir(), 'platform-check-'));
  const copy = join(scratch, 'platform.json');
  try {
    copyFileSync(resolve(exportDir, 'platform.json'), copy);
    const stale = JSON.parse(readFileSync(copy, 'utf8'));
    stale.batch.limits.max_rows = 200;
    writeFileSync(copy, `${JSON.stringify(stale, null, 2)}\n`);
    let failed = null;
    try {
      runExport(['--check', '--target', copy]);
    } catch (error) {
      failed = error;
    }
    assert.ok(failed, 'max_rows 与代码不符时 --check 必须 exit 1');
    assert.equal(failed.status, 1);
    assert.match(String(failed.stdout), /max_rows|max_rows|不一致/);
    assert.match(String(failed.stdout), /修复：npm run export:platform/);
    assert.notEqual(readFileSync(copy, 'utf8'), '', '--check 不许把目标文件清空');
    assert.equal(JSON.parse(readFileSync(copy, 'utf8')).batch.limits.max_rows, 200, '--check 不许改目标文件');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('platform.json 的上限与格式逐项等于代码常量', () => {
  assert.deepEqual(platform.batch.formats, [...TABLE_FORMATS]);
  assert.equal(platform.batch.limits.max_rows, TABLE_LIMITS.rows);
  assert.equal(platform.batch.limits.max_columns, TABLE_LIMITS.columns);
  assert.equal(platform.batch.limits.max_file_bytes, TABLE_LIMITS.bytes);
  assert.equal(platform.batch.limits.max_cell_chars, TABLE_LIMITS.cell);
  assert.deepEqual(platform.batch.calls_per_row, { ...CALLS_PER_ROW });
  // 曾经手抄成 200 行 / 60 列 / 两种格式，产品早就不是这样了。
  assert.ok(platform.batch.limits.max_rows >= 2000, '2000 行是产品声明过的上限');
  assert.ok(platform.batch.formats.includes('tsv'), 'README 写着支持 TSV');
});

test('platform.json 里每个路径字段都指向真实文件，恢复命令都是真脚本', () => {
  const paths = [
    platform.environment_template,
    platform.dependency_lock,
    platform.workflow_manifest,
    ...platform.runtime_implementation,
    ...platform.configuration_directories,
    platform.batch.implementation,
  ].filter(Boolean);
  assert.ok(paths.length >= 7, '路径字段不该突然变少');
  for (const relative of paths) {
    assert.ok(existsSync(resolve(exportDir, relative)), `${relative} 在 platform.json 里被引用但磁盘上没有`);
  }

  const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts;
  assert.deepEqual(platform.restore_commands, ['npm ci', 'npm run build', 'npm start']);
  const runnable = new Set(['npm ci', 'npm install', 'npm start', ...Object.keys(scripts).map(name => `npm run ${name}`)]);
  for (const command of platform.restore_commands) {
    assert.ok(runnable.has(command), `恢复命令 ${command} 不是 package.json 里的脚本`);
  }
});

test('平台配置导出里不含密钥、数据库路径或账号记录', () => {
  const files = readdirSync(exportDir, { withFileTypes: true }).filter(entry => entry.isFile());
  assert.ok(files.length >= 3, 'platform-export 至少要有 README / platform.json / 环境模板');
  // 逐行看「名字里带 KEY/SECRET/TOKEN 且等号后面真有一个值」——
  // 第一版写成 `\s*[:=]\s*[A-Za-z0-9_-]{16,}`，`\s` 跨了行，把
  // 「API_KEY=」的下一行变量名当成密钥值，报了假红。
  const offenders = [];
  for (const entry of files) {
    const text = readFileSync(join(exportDir, entry.name), 'utf8');
    if (/sk-[A-Za-z0-9_-]{16,}/.test(text)) offenders.push(`${entry.name}: 出现 sk- 开头的串`);
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const named = /^[ \t]*(?:[-*] )?([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*)[ \t]*[:=][ \t]*(.*)$/.exec(line);
      if (!named) continue;
      const value = named[2].trim().replace(/^["']|["']$/g, '');
      if (value.length >= 16) offenders.push(`${entry.name}:${index + 1} ${named[1]} 有非空值`);
    }
  }
  assert.deepEqual(offenders, [], '导出目录里出现了像密钥的字符串');
  assert.equal(platform.credentials_included, false);
  assert.equal(platform.user_database_included, false);
});
