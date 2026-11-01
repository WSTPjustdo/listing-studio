const PROJECT_CHECK_IDS = ['AMZ-05', 'FACT-01', 'FACT-02', 'EVID-01', 'SYS-01', 'SYS-02'];
const SOURCE_ID = 'PROJECT-AMAZON-QUALITY';

// These checks validate this workspace's facts, evidence and execution state.
// They add no platform or jurisdiction requirements. Old snapshots remain data;
// current UK/FR registrations get a distinct version and a complete rule basis.
export function withProjectChecks(pack, baseline) {
  const known = new Set(pack.rules.map(rule => rule.rule_id));
  const missing = PROJECT_CHECK_IDS.filter(ruleId => !known.has(ruleId));
  if (!missing.length) return pack;
  const additions = missing.map(ruleId => {
    const original = baseline.rules.find(rule => rule.rule_id === ruleId);
    if (!original) throw new Error(`Missing project check definition: ${ruleId}`);
    const rule = structuredClone(original);
    return { ...rule,
      ...(ruleId === 'AMZ-05' ? { category: 'product_fact_quality', title_zh: '商品描述与确认资料一致性（项目检查）' } : {}),
      scope: { ...rule.scope, marketplace: pack.scope.marketplace },
      source_ids: [SOURCE_ID],
    };
  });
  const projectSource = baseline.sources.find(source => source.source_id === SOURCE_ID);
  if (!projectSource) throw new Error('Missing project integrity source');
  return { ...pack,
    rule_pack_version: `${pack.rule_pack_version}.project-integrity-v1`,
    notice: `${pack.notice}\n另有 ${additions.length} 条项目内部事实、来源和运行完整性检查；它们不是本站平台或法域要求，也不能证明法律合规。`,
    rules: [...pack.rules, ...additions],
    sources: pack.sources.some(source => source.source_id === SOURCE_ID) ? pack.sources : [...pack.sources, structuredClone(projectSource)],
  };
}
