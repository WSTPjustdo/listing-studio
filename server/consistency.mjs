import { createHash } from 'node:crypto';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const conclusions = review => ({ issues: review.issues.map(issue => [issue.rule_id, issue.field_path, issue.original, issue.severity].join('|')).sort(), checks: review.checks.map(check => `${check.rule_id}:${check.state}`).sort(), evidence: (review.evidence || []).map(item => `${item.field_path}:${item.claim}:${item.state}`).sort() });
export function inspectConsistency(previous, review, inputHash) {
  if (!previous?.trace.audit_input_hash || previous.trace.audit_input_hash !== inputHash) return { state: 'baseline', reason: '建立本次输入的审核基线；旧版本或不同输入不用于稳定性判断。' };
  const changed = fingerprint(conclusions(previous.review)) !== fingerprint(conclusions(review));
  return { state: changed ? 'changed' : 'consistent', compared_version: previous.version,
    reason: changed ? '文案、商品资料、规则、来源和模型配置未变化，但审核结论发生变化；请人工核对两个版本。本轮未再检出不表示问题已解决。' : '本次与上一版相同输入的审核结论一致；单次一致不代表长期稳定性。' };
}
