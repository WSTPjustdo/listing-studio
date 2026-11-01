import type { Issue, Listing, Product } from './types';

export function productSourceIds(product: Product) {
  return [...new Set([...Object.values(product).flatMap(value => value && typeof value === 'object' && 'source_ids' in value && Array.isArray(value.source_ids) ? value.source_ids as string[] : []), ...(product.additional_facts || []).flatMap(fact => fact.source_ids), ...(product.evidence_submissions || []).map(item => item.source_id)])];
}

export const factLabels: Record<string, string> = { material: '材质', dimensions_cm: '尺寸', fabric_weight_gsm: '面料克重', capacity_l: '容量', handle_length_cm: '提手长度', retail_pack_count: '零售件数', brand: '品牌', color: '颜色', rated_load_kg: '额定承重' };
export function factText(field: string, value: unknown) {
  // 第三轴（深）是可选的：老档案只有宽高，仍然照旧显示两轴，不补一个假深度。
  if (value && typeof value === 'object' && 'width' in value && 'height' in value) {
    const size = value as { width: number; height: number; depth?: number };
    return `${size.width} × ${size.height}${typeof size.depth === 'number' ? ` × ${size.depth}` : ''} cm`;
  }
  const units: Record<string, string> = { fabric_weight_gsm: ' g/m²', capacity_l: ' L', handle_length_cm: ' cm', retail_pack_count: ' 件 / 包', rated_load_kg: ' kg' };
  return `${String(value ?? '待确认')}${units[field] || ''}`;
}
export function issueKind(issue: Issue) {
  if (issue.category === 'system_integrity') return '检查或引用异常';
  if (issue.severity === 'suggestion') return '表达建议';
  if (issue.rule_id === 'EVID-01' || issue.severity === 'needs_review') return '依据待核实';
  if (issue.category === 'product_fact_quality' || issue.rule_id === 'AMZ-05') return '参数冲突';
  return '文本规则问题';
}
export function requestedEvidence(issue: Issue) {
  if (issue.category === 'system_integrity') return '请核对已有来源并重新审阅。这是检查或引用异常，无需向采购重复索取相同资料。';
  if (/certif|organic|认证|有机/i.test(issue.original)) return '请提供适用本商品型号的证书或认证原文、出具机构及有效期；仅填写“已认证”不能作为证明。';
  if (/waterproof|leakproof|load|kg|防水|承重/i.test(issue.original)) return '请提供对应商品型号、测试条件和结论的检测材料；没有材料时可删除该性能表述。';
  return '请核对下方原句对应的商品参数及来源原文；数据已存在时先核对单位和型号，不要重复编造或补填资料。';
}
export function outstandingText(record: Listing) {
  return [`商品：${record.product_snapshot?.name_zh || record.content.title}`, `文案 V${record.version} · 商品资料 ${record.product_ref || '未关联'}`, '',
    ...record.review.missing_data.map(item => `${item.label}：${item.field === 'retail_pack_count' ? '请确认这个零售SKU每包件数，不能把工厂装箱数当作零售数量。' : item.field === 'color' ? '请确认实际所选变体的颜色，不是整个系列可选颜色。' : item.reason}`),
    ...record.review.issues.map(issue => `${issueKind(issue)}｜${issue.original}\n${issue.reason}\n${requestedEvidence(issue)}`),
    ...record.review.checks.filter(check => ['not_checked', 'error'].includes(check.state)).map(check => `检查待完成：${check.rule_id}；${check.reason}`),
    ...(record.product_snapshot?.evidence_submissions || []).map(item => `已提交待核验：${item.title}｜${item.target_label}｜${item.source_id}；提交材料不表示问题已解决。`),
    '', '未知项保持未知；这份清单不代表平台审核结论。'].join('\n');
}
export function sourceExcerpt(snapshot: unknown): string {
  if (typeof snapshot === 'string') return snapshot;
  if (Array.isArray(snapshot)) return snapshot.map(sourceExcerpt).filter(Boolean).join('\n');
  if (snapshot && typeof snapshot === 'object') {
    if ('facts' in snapshot && Array.isArray(snapshot.facts)) return snapshot.facts.map(fact => `${fact.label || ''}：${fact.evidence || fact.value || ''}`).join('\n\n');
    return Object.values(snapshot).map(sourceExcerpt).filter(Boolean).join('\n');
  }
  return '';
}
