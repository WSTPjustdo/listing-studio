import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, rulePack } from './store.mjs';
import { ruleCitations } from './rules-doc.mjs';

// Historical rule data is recovered from reviewed commits, never inferred from today's pack.
const history = new Map(readdirSync(resolve(ROOT, 'amazon-focus/history'))
  .filter(name => name.endsWith('.json'))
  .map(name => JSON.parse(readFileSync(resolve(ROOT, 'amazon-focus/history', name), 'utf8')))
  .map(pack => [pack.rule_pack_version, pack]));
history.set(rulePack.rule_pack_version, rulePack);

export function auditContext(record, recordedSources = []) {
  const snapshot = record?.rule_pack_snapshot;
  const pack = snapshot?.rule_pack_version === record?.rule_pack_version
    ? snapshot : history.get(record?.rule_pack_version);
  const known = Boolean(pack);
  const resolved = pack || { rule_pack_version: record?.rule_pack_version || null, rules: [], sources: [] };
  const sources = record?.source_snapshot || [
    ...(resolved.sources || []),
    ...recordedSources.filter(source => record?.trace?.source_ids?.includes(source.source_id)
      && !resolved.sources.some(item => item.source_id === source.source_id)),
  ];
  return {
    pack: resolved, sources, known,
    citations: known ? ruleCitations(resolved) : [],
    notice: known ? '' : '该历史版本未记录规则快照；规则数量、字符上限及具体依据未知，不套用当前规则。',
  };
}

export const citationsByVersion = () => Object.fromEntries(
  [...history].map(([version, pack]) => [version, ruleCitations(pack)]),
);
