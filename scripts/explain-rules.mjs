import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, rulePack } from '../server/store.mjs';
import { ruleInventory, rulesMarkdown } from '../server/rules-doc.mjs';

const inventory = ruleInventory(rulePack);
if (inventory.missing_sources.length) throw new Error('规则包包含无法定位的来源。');
if (new Set(rulePack.rules.map(rule => rule.rule_id)).size !== rulePack.rules.length)
  throw new Error('规则 ID 重复。');
const text = rulesMarkdown(rulePack);
const file = resolve(ROOT, 'amazon-focus/rules-explained.md');
if (process.argv.includes('--write')) writeFileSync(file, text);
else if (readFileSync(file, 'utf8').replaceAll('\r\n', '\n') !== text.replaceAll('\r\n', '\n'))
  throw new Error('规则说明已过期，请运行 npm run rules:doc。');
console.log(JSON.stringify({ rule_pack_version: rulePack.rule_pack_version, total: inventory.total,
  external_rules: inventory.external_count, internal_rules: inventory.internal_count,
  notice: '只校验配置和说明一致，不代表官方规则重新核验或真实模型验收。' }));
