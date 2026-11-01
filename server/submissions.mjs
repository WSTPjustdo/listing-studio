import { z } from 'zod';
import { AppError, id } from './domain.mjs';
export const sameEvidence = (left, right) => left.target === right.target && left.url === right.url && String(left.excerpt).replace(/\s+/g, ' ').trim() === String(right.excerpt).replace(/\s+/g, ' ').trim();

const schema = z.object({
  base_revision: z.number().int().positive(),
  listing_id: z.string().min(1), listing_version: z.number().int().positive(),
  target: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  applicable_model: z.string().trim().min(1).max(200),
  publisher: z.string().trim().min(1).max(200),
  url: z.union([z.literal(''), z.url().refine(value => /^https?:\/\//i.test(value), '仅支持 HTTP(S) 来源链接')]).default(''),
  excerpt: z.string().trim().min(10).max(20000),
});

export function submitEvidence(store, productId, input) {
  const data = schema.parse(input);
  const product = store.product(productId);
  if (!product || product.is_demo) throw new AppError('REAL_PRODUCT_REQUIRED', '请选择真实商品。', 400);
  if (product.revision !== data.base_revision) throw new AppError('STALE_PRODUCT', '商品已更新，请刷新后再提交。', 409);
  const listing = store.latest(data.listing_id);
  if (!listing || listing.version !== data.listing_version) throw new AppError('STALE_VERSION', '审核记录已更新，请刷新后再提交。', 409);
  if (listing.product_snapshot?.product_id !== productId) throw new AppError('PRODUCT_MISMATCH', '材料必须关联当前审核商品。', 400);
  const issue = listing.review.issues.find(item => item.issue_id === data.target);
  if (issue?.category === 'system_integrity') throw new AppError('REVIEW_RECHECK_REQUIRED', '检查或引用异常需核对已有来源并重新审阅，不需要重复提交商品资料。');
  const missing = listing.review.missing_data.find(item => item.field === data.target);
  if (!issue && !missing) throw new AppError('INVALID_EVIDENCE_TARGET', '请选择当前审核中的问题或待补资料。', 400);
  const previous = product.evidence_submissions || [];
  if (previous.some(item => sameEvidence(item, data)))
    throw new AppError('DUPLICATE_EVIDENCE', '这份原文已提交，请直接复检或补充不同材料。', 409);
  const sourceId = id('evidence');
  const submission = { ...data, source_id: sourceId, status: 'submitted_unverified', submitted_at: new Date().toISOString(),
    target_label: issue?.title || missing.label, original: issue?.original || '', field_path: issue?.field_path || missing.field };
  const next = { ...structuredClone(product), revision: product.revision + 1, evidence_submissions: [...previous, submission] };
  const source = { source_id: sourceId, kind: 'merchant_submission', publisher: data.publisher, url: data.url || null,
    description: `${data.title} · 适用型号：${data.applicable_model}`, checked_at: submission.submitted_at,
    note: '用户提交的原文材料，尚未独立核验真实性、有效期或适用性；不可代替检测或认证结论。', snapshot: data.excerpt };
  store.saveProductWithSource(next, source);
  return next;
}
