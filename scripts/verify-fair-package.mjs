// Verify the fixed delivery without extracting files or persisting credentials.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, posix } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { createStore } from '../server/store.mjs';
import { getConfig } from '../server/providers.mjs';

const root = resolve(import.meta.dirname, '..');
const archivePath = 'releases/listing-studio-hackathon-final.zip';
const resultPath = resolve(root, 'releases/fair-rehearsal-package-verification.json');
const prefix = 'listing-studio-hackathon-final/';
const expectedLabel = 'fair-rehearsal-20261101-working-tree-snapshot';
const denied = /(^|\/)(?:\.runtime|\.git|node_modules|__pycache__|\.cache|cache|caches|test-results|playwright-report|releases|output|tmp)(\/|$)|(?:^|\/)\.env(?:$|\.(?!example$))|\.(?:sqlite(?:-shm|-wal)?|db|pyc|log|pem|key|pfx|p12)$|(?:^|\/)(?:credentials|secrets|\.feishu-[^/]*)(?:\.|\/|$)|(?:^|\/)(?:response-\d[^/]*|raw[-_]?(?:model[-_]?)?responses?)(?:\.|\/|$)/i;
const required = [
  'start-fair.cmd',
  'start-local.cmd',
  'start-workbench.cmd',
  'scripts/open-workbench.mjs',
  'scripts/prepare-fair-rehearsal.mjs',
  'scripts/build-fair-rehearsal.mjs',
  'scripts/validate-fair-rehearsal.mjs',
  'scripts/verify-fair-package.mjs',
  'reports/fair-rehearsal-2026-11-01/index.html',
  'reports/fair-rehearsal-2026-11-01/case.json',
  'reports/fair-rehearsal-2026-11-01/product-source.json',
  'reports/fair-rehearsal-2026-11-01/listing-en.txt',
  'reports/fair-rehearsal-2026-11-01/README.md',
  'reports/fair-rehearsal-2026-11-01/page-acceptance.json',
  'reports/fair-rehearsal-2026-11-01/workbench-acceptance.json',
  'reports/fair-rehearsal-2026-11-01/workbench-entry-acceptance.json',
  'reports/fair-rehearsal-2026-11-01/workbench-entry-browser.json',
  'README.md',
  'CURRENT-STATUS.md',
  'DELIVERY.md',
  'package.json',
];
const sha = value => createHash('sha256').update(value).digest('hex');
let currentCheck = 'initialization';
let archiveSha = null;
let verifiedFiles = 0;
let scannedFiles = 0;

function check(condition, code) {
  currentCheck = code;
  if (!condition) throw Object.assign(new Error(code), { verificationCode: code });
}

function canonicalRelative(name, directory = false) {
  if (typeof name !== 'string' || !name || /[\\:\u0000-\u001f\u007f]/.test(name) || name.startsWith('/')) return false;
  const relative = directory && name.endsWith('/') ? name.slice(0, -1) : name;
  return Boolean(relative) && !relative.split('/').some(segment => !segment || segment === '.' || segment === '..') && posix.normalize(relative) === relative;
}

// JSZip normalizes ../ in file names. Validate the original central-directory
// names first as well, so normalization cannot hide traversal or duplicate entries.
function originalNames(bytes) {
  currentCheck = 'central_directory';
  let eocd = -1;
  const earliest = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= earliest; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { eocd = offset; break; }
  }
  check(eocd >= 0, 'zip_end_record');
  const count = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  check(bytes.readUInt16LE(eocd + 4) === 0 && bytes.readUInt16LE(eocd + 6) === 0 && bytes.readUInt16LE(eocd + 8) === count, 'single_disk_archive');
  check(count !== 0xffff && directorySize !== 0xffffffff && directoryOffset !== 0xffffffff, 'non_zip64_archive');
  check(directoryOffset + directorySize === eocd, 'central_directory_bounds');
  const names = new Set();
  let cursor = directoryOffset;
  for (let index = 0; index < count; index++) {
    check(cursor + 46 <= eocd && bytes.readUInt32LE(cursor) === 0x02014b50, 'central_directory_record');
    const length = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const next = cursor + 46 + length + extraLength + commentLength;
    check(next <= eocd, 'central_directory_entry_bounds');
    const name = bytes.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    check(canonicalRelative(name, name.endsWith('/')) && name.startsWith(prefix), 'canonical_archive_paths');
    check(!denied.test(name.slice(prefix.length)), 'forbidden_archive_entry');
    const key = name.toLowerCase();
    check(!names.has(key), 'unique_archive_paths');
    names.add(key);
    cursor = next;
  }
  check(cursor === directoryOffset + directorySize, 'central_directory_size');
  return names.size;
}

try {
  currentCheck = 'read_fixed_archive';
  const bytes = readFileSync(resolve(root, archivePath));
  archiveSha = sha(bytes);
  currentCheck = 'read_sha256_file';
  const sidecar = readFileSync(resolve(root, `${archivePath}.sha256`), 'utf8').trim();
  const checksum = /^([a-f\d]{64})\s+\*?listing-studio-hackathon-final\.zip$/i.exec(sidecar);
  check(checksum && checksum[1].toLowerCase() === archiveSha, 'sha256_sidecar_matches');
  const originalCount = originalNames(bytes);
  currentCheck = 'crc32';
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  check(Object.values(zip.files).length === originalCount, 'original_and_loaded_entry_counts');
  const manifestFile = zip.file(`${prefix}DELIVERY-MANIFEST.json`);
  check(Boolean(manifestFile), 'delivery_manifest_present');
  currentCheck = 'read_delivery_manifest';
  const manifest = JSON.parse(await manifestFile.async('string'));
  check(manifest.snapshot_label === expectedLabel && manifest.working_tree_snapshot === true, 'fair_snapshot_label');
  check(Array.isArray(manifest.files), 'manifest_file_list');
  const inventory = new Map();
  const foldedPaths = new Set();
  for (const entry of manifest.files) {
    check(entry && canonicalRelative(entry.path) && !denied.test(entry.path), 'canonical_allowed_manifest_paths');
    check(!foldedPaths.has(entry.path.toLowerCase()), 'unique_manifest_paths');
    check(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && typeof entry.sha256 === 'string' && /^[a-f\d]{64}$/i.test(entry.sha256), 'manifest_size_and_sha256_types');
    foldedPaths.add(entry.path.toLowerCase());
    inventory.set(entry.path, entry);
  }

  currentCheck = 'read_configured_credentials_in_memory';
  const store = createStore();
  let secrets;
  try {
    const config = getConfig(store);
    secrets = [...new Set(['api_key', 'dify_create_api_key', 'dify_diagnose_api_key'].map(key => config[key]).filter(value => typeof value === 'string' && value.length > 0))].map(value => Buffer.from(value));
  } finally { store.close(); }
  check(secrets.length > 0, 'configured_credentials_available_for_scan');

  const archiveFiles = Object.values(zip.files).filter(entry => !entry.dir);
  check(archiveFiles.length === inventory.size + 1, 'manifest_accounts_for_every_file');
  for (const file of Object.values(zip.files)) {
    check(canonicalRelative(file.name, file.dir) && file.name.startsWith(prefix), 'loaded_canonical_archive_paths');
    if (file.unsafeOriginalName !== undefined) check(file.unsafeOriginalName === file.name, 'no_sanitized_original_paths');
    const relative = file.name.slice(prefix.length);
    check(!denied.test(relative), 'loaded_forbidden_entry');
    const permissions = typeof file.unixPermissions === 'string' ? Number.parseInt(file.unixPermissions, 8) : file.unixPermissions;
    check(!Number.isFinite(permissions) || (permissions & 0xf000) !== 0xa000, 'no_archive_symlinks');
    if (file.dir) continue;
    currentCheck = 'read_archive_file_for_verification';
    const data = await file.async('nodebuffer');
    for (const secret of secrets) check(!data.includes(secret), 'configured_credential_absent');
    scannedFiles++;
    if (relative === 'DELIVERY-MANIFEST.json') continue;
    const entry = inventory.get(relative);
    check(Boolean(entry), 'archive_file_has_manifest_entry');
    check(data.length === entry.bytes, 'archive_file_size_matches_manifest');
    check(sha(data) === entry.sha256.toLowerCase(), 'archive_file_sha256_matches_manifest');
    verifiedFiles++;
  }
  for (const relative of required) {
    const entry = inventory.get(relative);
    check(Boolean(entry), 'required_fair_delivery_file_present');
    currentCheck = 'read_required_workspace_source';
    const source = readFileSync(resolve(root, relative));
    check(source.length === entry.bytes && sha(source) === entry.sha256.toLowerCase(), 'required_fair_files_match_current_sources');
  }
  const result = {
    checked_at: new Date().toISOString(), status: 'passed', zip: archivePath, sha256: archiveSha,
    snapshot_label: manifest.snapshot_label, files_verified: verifiedFiles, files_scanned_for_configured_credentials: scannedFiles,
    required_current_files_verified: required.length, crc32: 'passed', sha256_file: 'passed',
    manifest_sizes_and_sha256: 'passed', canonical_paths: 'passed', forbidden_entries: 0,
    configured_credentials_found: 0, current_changes_match: true,
  };
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, files_verified: verifiedFiles, report: 'releases/fair-rehearsal-package-verification.json' }));
} catch (error) {
  // Never emit arbitrary upstream exception text, config values or ZIP contents.
  const result = {
    checked_at: new Date().toISOString(), status: 'failed', zip: archivePath, sha256: archiveSha,
    failed_check: error?.verificationCode || currentCheck, files_verified: verifiedFiles,
    notice: 'Verification stopped. No credentials or archive contents are included in this report.',
  };
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  console.error(JSON.stringify({ status: result.status, failed_check: result.failed_check, report: 'releases/fair-rehearsal-package-verification.json' }));
  process.exitCode = 1;
}
