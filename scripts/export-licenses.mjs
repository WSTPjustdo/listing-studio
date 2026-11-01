import { readFileSync, readdirSync, mkdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const rows = [];
for (const [path, info] of Object.entries(lock.packages)) {
  if (!path) continue;
  const dir = resolve(root, path);
  const installed = existsSync(resolve(dir, 'package.json'));
  const pkg = installed ? JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) : {};
  const name = pkg.name || path.split('node_modules/').at(-1);
  const output = path.replaceAll('/', '__');
  const files = installed ? readdirSync(dir).filter(f => /^(license|licence|copying|notice)(\.|$|-)/i.test(f)) : [];
  for (const file of files) {
    mkdirSync(resolve(root, 'third-party-licenses', output), { recursive: true });
    copyFileSync(resolve(dir, file), resolve(root, 'third-party-licenses', output, file));
  }
  rows.push({ name, version: info.version, license: pkg.license || info.license || 'See upstream package', dev: !!info.dev, optional: !!info.optional, installed, resolved: info.resolved, integrity: info.integrity, license_files: files.map(f => `third-party-licenses/${output}/${f}`) });
}
writeFileSync(resolve(root, 'THIRD_PARTY_INVENTORY.json'), JSON.stringify(rows, null, 2) + '\n');
console.log(`Exported ${rows.length} locked package records; ${rows.filter(r => r.installed).length} installed on this platform.`);
