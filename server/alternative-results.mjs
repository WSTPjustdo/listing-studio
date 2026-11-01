import { createHash } from 'node:crypto';
import { AppError, clone, contentSchema, id } from './domain.mjs';
const TYPES = new Set(['variants', 'voc']);
const latestKey = (record, kind) => `alternative-latest:${kind}:${record.listing_id}:${record.version}`;
const fingerprint = record => createHash('sha256').update(JSON.stringify({ product: record.product_snapshot, marketplace: record.marketplace || 'US', language: record.language || 'en', rules: record.rule_pack_version })).digest('hex');
export function latestAlternativeResult(store, record, kind) {
  if (!TYPES.has(kind)) throw new AppError('INVALID_ALTERNATIVE_KIND', '未知备选结果类型。');
  const pointer = store.getImport(latestKey(record, kind));
  if (!pointer?.result_id) return null;
  const result = store.getImport(pointer.result_id);
  if (!result || result.listing_id !== record.listing_id || result.listing_version !== record.version || result.input_fingerprint !== fingerprint(record)) return null;
  return result;
}
/** Persist the complete result before publishing the pointer; generation never replaces a Listing. */
export function saveAlternativeResult(store, record, kind, result, input = {}) {
  if (!TYPES.has(kind)) throw new AppError('INVALID_ALTERNATIVE_KIND', '未知备选结果类型。');
  if (!record.product_snapshot || record.product_snapshot.is_demo || record.is_demo)
    throw new AppError('REAL_PRODUCT_REQUIRED', '请选择关联真实商品资料的文案。');
  const resultId = id('alternative-result');
  const saved = { ...clone(result), id: resultId, result_id: resultId, kind, listing_id: record.listing_id,
    listing_version: record.version, product_id: record.product_snapshot.product_id, product_revision: record.product_snapshot.revision,
    input_fingerprint: fingerprint(record), input: clone(input), created_at: new Date().toISOString(),
    review_status: result.model_used ? 'not_reviewed' : 'not_generated' };
  store.saveImport(saved);
  store.upsertImport({ id: latestKey(record, kind), result_id: resultId, kind: 'alternative_result_pointer' });
  return saved;
}
/** Produce a draft from a saved alternative; only the main review service may publish it. */
export function alternativeContent(store, record, resultId, index) {
  const result = store.getImport(resultId);
  if (!result || result.id !== resultId || !TYPES.has(result.kind) || result.listing_id !== record.listing_id || result.listing_version !== record.version)
    throw new AppError('ALTERNATIVE_NOT_FOUND', '找不到当前版本的备选结果，请重新打开面板。', 404);
  if (result.input_fingerprint !== fingerprint(record))
    throw new AppError('STALE_ALTERNATIVE', '备选结果使用的商品或规则快照已变化，请重新生成。', 409);
  if (!result.model_used || !result.trace?.actual_model_call || !result.trace?.provider_request_id)
    throw new AppError('REAL_MODEL_REQUIRED', '只有已保存的真实模型结果可采用并复检。');
  let content;
  if (result.kind === 'variants') {
    if (!Number.isInteger(index) || index < 0 || index >= result.variants.length)
      throw new AppError('INVALID_ALTERNATIVE_INDEX', '请选择要采用的一版文案。');
    content = result.variants[index].content;
  } else {
    if (!Array.isArray(result.grounded_bullets) || !result.grounded_bullets.length)
      throw new AppError('NO_GROUNDED_BULLETS', '本次没有可采用的真实模型卖点。');
    // Retain all non-bullet fields; the final full draft is independently checked by the main service.
    content = { ...clone(record.content), bullet_points: result.grounded_bullets.slice(0, 5).map((row, i) => ({ id: `b${i + 1}`, text: row.bullet })) };
  }
  return { content: contentSchema.parse(clone(content)), source: { result_id: result.id, kind: result.kind,
    ...(result.kind === 'variants' ? { variant_index: index, angle: result.variants[index].angle } : {}),
    trace: clone(result.trace), review_status: 'not_reviewed', created_at: result.created_at } };
}
