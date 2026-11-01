// Allowlisted delivery of either a reviewed commit or an explicitly identified workspace snapshot.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const snapshot = process.argv.includes('--snapshot');
const dirty = Boolean(git('status', '--porcelain'));
if (dirty && !snapshot) throw new Error('Workspace has uncommitted changes. Use --snapshot to package them with an explicit baseline manifest, or package a reviewed clean commit.');
const baselineCommit = git('rev-parse', 'HEAD');
const commit = snapshot ? null : baselineCommit;
const tagIndex = process.argv.indexOf('--tag');
const deliveryTag = tagIndex >= 0 ? process.argv[tagIndex + 1] : 'hackathon-final';
if (!deliveryTag || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(deliveryTag)) throw new Error('Invalid delivery tag.');
if (!snapshot && git('rev-parse', `${deliveryTag}^{commit}`) !== commit) throw new Error(`${deliveryTag} must point to the current reviewed commit.`);
const labelIndex = process.argv.indexOf('--label');
const snapshotLabel = labelIndex >= 0 ? process.argv[labelIndex + 1] : 'working-tree-snapshot';
if (!snapshotLabel || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(snapshotLabel)) throw new Error('Invalid snapshot label.');
const staging = path.join(root, 'releases', `product-readiness-${Date.now()}`, 'listing-studio-hackathon-final'); fs.mkdirSync(staging, { recursive: true });
const denied = /(^|\/)(?:\.runtime|\.git|node_modules|__pycache__|\.cache|test-results|playwright-report|releases|output|tmp)(\/|$)|(?:^|\/)\.env(?:$|\.(?!example$))|\.(?:sqlite(?:-shm|-wal)?|db|pyc|log|pem|key|pfx|p12)$|(?:^|\/)(?:credentials|secrets|\.feishu-[^/]*)(?:\.|\/|$)|(?:^|\/)(?:response-\d[^/]*|raw[-_]?(?:model[-_]?)?responses?)(?:\.|\/|$)/i;
const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
const untracked = snapshot ? git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean) : [];
// New code and sanitized public reports must be shipped together with tracked edits.
const publicNewFile = /^(?:(?:src|server|scripts|tests|docs|reports|platform-export|workflows|third-party-licenses)\/|[^/.][^/]*\.(?:md|json|ts|html|cmd)$)/i;
const candidates = [...new Set([...tracked, ...untracked.filter(relative => publicNewFile.test(relative))])].sort();
const excluded = [];
for (const relative of candidates) {
  if (denied.test(relative)) { excluded.push(relative); continue; }
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) continue; // A deletion in a workspace snapshot stays deleted.
  if (!fs.lstatSync(source).isFile()) throw new Error(`Only regular files are supported: ${relative}`);
  const target = path.join(staging, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, relative), target);
}
function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('No symlinks in delivery');
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to); else fs.copyFileSync(from, to);
  }
}
copyDirectory(path.join(root, 'dist'), path.join(staging, 'dist'));
execFileSync('git', ['bundle', 'create', path.join(staging, 'repository.bundle'), 'HEAD', ...(!snapshot ? [deliveryTag] : [])], { cwd: root });
const files = [];
function inventory(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isSymbolicLink()) throw new Error('No symlinks in delivery'); if (entry.isDirectory()) inventory(file); else { const relative = path.relative(staging, file).replaceAll('\\', '/'); if (denied.test(relative)) throw new Error(`Forbidden package entry: ${relative}`); files.push({ path: relative, bytes: fs.statSync(file).size, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }); } } }
inventory(staging);
files.sort((a, b) => a.path.localeCompare(b.path));
fs.writeFileSync(path.join(staging, 'DELIVERY-MANIFEST.json'), JSON.stringify({
  commit, tag: snapshot ? null : deliveryTag, baseline_commit: baselineCommit,
  working_tree_snapshot: snapshot, snapshot_label: snapshot ? snapshotLabel : null,
  dirty_worktree: dirty, bundle_commit: baselineCommit,
  bundle_notice: snapshot ? 'Git bundle contains the committed baseline only; the shipped source files and their hashes define this workspace snapshot.' : 'Git bundle and source files refer to the reviewed commit.',
  created_at: new Date().toISOString(), public_product_cases_only: true, excluded, files,
}, null, 2));
const zip = path.join(root, 'releases', 'listing-studio-hackathon-final.zip');
// 用 PowerShell 原生 zip 能力，但**逐条自己写 entry 名**：
// ZipFile::CreateFromDirectory 在 Windows 上会写 `a\b\c.txt` 这种反斜杠路径，
// Windows 资源管理器能解，但 Info-ZIP / macOS 会警告并把整个路径当成一个文件名
// （2026-10-30 实测：unzip 报 263 条反斜杠警告、还误报一张 PNG 的 CRC）。
const quote = value => `'${value.replaceAll("'", "''")}'`;
const freshZip = path.join(path.dirname(staging), 'listing-studio-hackathon-final.zip');
const archive = [
  "[void][System.Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem')",
  `$staging = ${quote(staging)}`,
  '$root = Split-Path $staging -Leaf',
  `$out = ${quote(freshZip)}`,
  // 模式名用字符串，别写 [System.IO.Compression.ZipArchiveMode]::Create：
  // 只加载 FileSystem 程序集时这个类型名取不到（PowerShell 5.1 实测 TypeNotFound）。
  "$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')",
  'try {',
  '  foreach ($item in (Get-ChildItem -LiteralPath $staging -Recurse -File)) {',
  '    $rel = $root + "/" + $item.FullName.Substring($staging.Length + 1).Replace("\\", "/")',
  '    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $item.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal)',
  '  }',
  '} finally { $zip.Dispose() }',
].join('; ');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', archive], { windowsHide: true });
// Preserve the previous fixed delivery before replacing it; no Git tags are moved.
let backup = null;
if (fs.existsSync(zip) || fs.existsSync(`${zip}.sha256`)) {
  backup = path.join(root, 'releases', 'backups', `before-${Date.now()}`);
  fs.mkdirSync(backup, { recursive: true });
  for (const previous of [zip, `${zip}.sha256`]) if (fs.existsSync(previous)) fs.copyFileSync(previous, path.join(backup, path.basename(previous)));
}
fs.copyFileSync(freshZip, zip);
const sha256 = createHash('sha256').update(fs.readFileSync(zip)).digest('hex'); fs.writeFileSync(`${zip}.sha256`, `${sha256}  listing-studio-hackathon-final.zip\n`);
console.log(JSON.stringify({ zip, sha256, commit, baseline_commit: baselineCommit, working_tree_snapshot: snapshot, snapshot_label: snapshot ? snapshotLabel : null, files: files.length, staging, backup }));
