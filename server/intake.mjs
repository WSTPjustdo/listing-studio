import { z } from 'zod';
import { AppError, applyPatches, clone, contentSchema, diffContent, flattenContent } from './domain.mjs';

// Importing reference text never creates a product, SKU, inventory row or evidence source.
const optionalText = (max) => z.string().trim().max(max).nullish().transform(value => value || null);
const sourceUrl = optionalText(2000).refine(value => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}, '来源链接仅支持不含用户名和密码的 http(s) 地址。');

export const intakeInputSchema = z.object({
  role: z.enum(['own_draft', 'competitor_reference']),
  content: contentSchema,
  product_id: optionalText(100),
  product_revision: z.number().int().positive().optional(),
  source_tool: z.string().trim().max(100).default('复制粘贴'),
  source_url: sourceUrl,
  source_asin: optionalText(10).transform(value => value?.toUpperCase() || null)
    .refine(value => !value || /^[A-Z0-9]{10}$/.test(value), '来源 ASIN 应为 10 位字母或数字；未知可留空。'),
  source_filename: optionalText(250),
  raw_text: z.string().max(100000).optional(),
  selected_terms: z.array(z.string().trim().min(1).max(100)).max(60).default([]),
  scope_confirmed: z.boolean(),
  request_id: z.string().max(120).optional(),
}).strict();

export const editableFieldSchema = z.string().regex(
  /^content\.(?:title|item_highlights|description|bullet_points\.[a-zA-Z0-9_-]{1,40})$/,
  '请选择标题、亮点、描述或已有的某条五点。',
);

const termKey = value => String(value).replace(/\s+/g, ' ').trim().toLowerCase();
export function selectedTerms(values = []) {
  const seen = new Set();
  return values.filter(value => typeof value === 'string' && value.trim())
    .map(value => value.replace(/\s+/g, ' ').trim())
    .filter(value => {
      const key = termKey(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 60);
}

export function prepareIntakeRun(raw, lookupProduct) {
  const input = intakeInputSchema.parse(raw);
  if (!input.scope_confirmed)
    throw new AppError('INTAKE_SCOPE_UNCONFIRMED', '当前仅支持 Amazon 美国站棉布手提袋。请先确认本次站点和品类；未知或不适用时可整理文案，暂不提交此范围的审核。');
  const product = input.product_id ? lookupProduct(input.product_id, input.product_revision) : null;
  if (input.product_id && !product) throw new AppError('PRODUCT_NOT_FOUND', '找不到所选的自家商品资料，请刷新后重新选择。', 404);
  if (product?.is_demo) throw new AppError('REAL_PRODUCT_REQUIRED', '请选择真实的自家商品资料，演示商品不能用于导入后二次加工。');
  if (input.role === 'competitor_reference' && !product)
    throw new AppError('OWN_PRODUCT_REQUIRED', '竞品文案只能作为参考。请先选择真实的自家商品资料，再形成自己的草稿；不会把竞品参数存为自家事实。');
  const context = {
    role: input.role,
    source_tool: input.source_tool || '复制粘贴',
    source_url: input.source_url,
    source_asin: input.source_asin,
    source_filename: input.source_filename,
    ...(input.raw_text !== undefined ? { raw_text: input.raw_text } : {}),
    selected_terms: selectedTerms(input.selected_terms),
    scope_confirmed: true,
    marketplace: 'US',
    category: 'cotton_tote',
    original_content: clone(input.content),
    imported_at: new Date().toISOString(),
  };
  return {
    operation: input.role === 'own_draft' ? 'diagnose' : 'create',
    product,
    ...(input.role === 'own_draft' ? { content: input.content } : {}),
    instruction: input.role === 'competitor_reference'
      ? '根据自家商品资料形成英文草稿。导入文本是竞品参考，只参考有依据的表达方向；不得照抄竞品句子，不得继承竞品品牌、参数、认证或性能。选词仅在自家资料支持且适用规则允许时采用，不为埋词创造事实。'
      : '',
    intake_context: context,
    ...(input.request_id ? { request_id: input.request_id } : {}),
  };
}

/** One effective context feeds both the provider request and the saved version. */
export function effectiveRunContext(input, previous = null) {
  const intake = input.intake_context || previous?.intake_context || null;
  let research = input.research_context ?? previous?.competitor_research ?? null;
  if (input.intake_context) {
    research = {
      source_type: input.intake_context.role,
      imported_at: input.intake_context.imported_at,
      items: input.intake_context.role === 'competitor_reference' ? [{
        asin: input.intake_context.source_asin,
        url: input.intake_context.source_url,
        reference_content: clone(input.intake_context.original_content),
        reference_only: true,
      }] : [],
      selected_terms: selectedTerms(input.intake_context.selected_terms),
    };
  }
  // An empty explicit term list clears the selection; absence inherits it.
  const terms = selectedTerms(research?.selected_terms ?? intake?.selected_terms ?? []);
  return {
    intake_context: intake ? clone(intake) : null,
    research_context: research ? { ...clone(research), selected_terms: terms } : terms.length ? { items: [], selected_terms: terms } : null,
    selected_terms: terms,
  };
}

export function validateAllowedFields(content, fields) {
  if (!fields) return undefined;
  const parsed = z.array(editableFieldSchema).min(1).max(23).parse(fields);
  const allowed = new Set(flattenContent(content).map(item => item.path));
  if (new Set(parsed).size !== parsed.length || parsed.some(field => !allowed.has(field)))
    throw new AppError('INVALID_ALLOWED_FIELD', '修改范围含不存在或重复的字段，请从当前版本选择具体标题、亮点、描述或五点。');
  return parsed;
}

export function preserveAllowedContent(before, candidate, fields) {
  const validated = validateAllowedFields(before, fields);
  if (!validated) return candidate;
  const returned = new Set(flattenContent(candidate).map(item => item.path));
  if (validated.some(field => !returned.has(field)))
    throw new AppError('MODEL_FIELD_MISSING', '模型未保留所选字段或五点 ID，本次未保存修改；原版本仍保留，请重新核对。', 502);
  const allowed = new Set(validated);
  const patches = diffContent(before, candidate).filter(change => allowed.has(change.field_path))
    .map(change => ({ field_path: change.field_path, expected_before: change.before, replacement: change.after }));
  return applyPatches(before, patches, 1, 1);
}

function countTerm(content, term) {
  if (!content) return 0;
  const escaped = termKey(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu');
  // Count per field so a phrase cannot be manufactured across two unrelated fields.
  return flattenContent(content).reduce((sum, field) => sum + [...termKey(field.text).matchAll(pattern)].length, 0);
}

export function keywordUsage(terms, before, after) {
  return selectedTerms(terms).map(term => {
    const before_count = countTerm(before, term), after_count = countTerm(after, term);
    return { term, before_count, after_count, status: before_count && after_count ? 'retained' : before_count ? 'removed' : after_count ? 'added' : 'absent' };
  });
}
