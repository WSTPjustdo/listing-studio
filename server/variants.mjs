import { z } from 'zod';
import { AppError, contentSchema } from './domain.mjs';
import { characterLimits } from './providers.mjs';
import { comparisonRows } from './aplus.mjs';
import { invokeAlternativeModel } from './alternative-model.mjs';

export const ANGLES = [
  { id: 'spec_first', en: 'Specification-first', zh: '参数清晰' },
  { id: 'scenario_first', en: 'Scenario-first', zh: '场景导向' },
  { id: 'concise', en: 'Concise and natural', zh: '简洁自然' },
];
export const variantsSchema = z.object({ variants: z.array(z.object({ angle: z.enum(['spec_first', 'scenario_first', 'concise']), content: contentSchema })).length(3)
  .refine(rows => new Set(rows.map(row => row.angle)).size === 3, '三个角度必须各出现一次') }).strict();
export function variantForAdoption(store, { listingId, baseVersion, variantSetId, angle }) {
  const variantSet = variantSetId && store.variantSet(variantSetId);
  if (!variantSet || variantSet.listing_id !== listingId || variantSet.base_version !== baseVersion)
    throw new AppError('VARIANT_SET_NOT_FOUND', '找不到此版本对应的已保存 A/B 结果，请刷新后重试。', 404);
  const variant = variantSet.variants.find(item => item.angle === angle);
  if (!variant)
    throw new AppError('VARIANT_ANGLE_NOT_FOUND', '找不到所选 A/B 角度，请刷新后重试。', 404);
  return { variantSet, variant };
}
function languageInstruction(language, marketplace) { return language === 'en' ? (marketplace === 'UK' ? 'Write natural British English with British spelling.' : 'Write natural US English.') : 'Write all customer-facing copy in ' + ({de:'German',fr:'French',es:'Spanish',zh:'Simplified Chinese'}[language] || 'English') + '; keep proper names and exact original units unchanged.'; }
function limitsSentence(rules) {
  const limits = characterLimits(rules);
  return limits.length ? `Hard limits counted in Unicode code points including spaces: ${limits.map(l => `${l.label} <= ${l.max}`).join('; ')}.` : 'Keep all fields concise. Do not invent a character limit.';
}
export async function generateVariants({ product, config, language = 'en', marketplace = 'US', rules = [] }) {
  const result = await invokeAlternativeModel({ config, operation: 'ab_variants', schema: variantsSchema,
    system: `You write source-grounded Amazon ${marketplace} listing alternatives. Produce exactly THREE complete alternatives for the SAME product, one per angle: ${ANGLES.map(a => `${a.id} = ${a.en}`).join('; ')}.
Return exactly {"variants":[{"angle":"spec_first","content":{"title":"...","item_highlights":"...","bullet_points":[{"id":"b1","text":"..."}],"description":"..."}}, ...]}.
Each angle must occur exactly once. Every content object must contain only title, item_highlights, bullet_points and description. ${languageInstruction(language, marketplace)}
Use only supplied confirmed product facts with exact values and original units. Never transfer a competitor feature or infer brand, color, pack size, certification, performance, print/customisation ability or suitability from a removable label. Unknown facts stay unknown. No prices, contact information, review/testimonial references, urgency, promotions, environmental claims without specific proof or unsupported benefits. Do not repeat a specification list as an extra bullet; use fewer useful distinct bullets when facts are sparse. Stable bullet IDs b1..b5, at most five bullets. ${limitsSentence(rules)}`,
    input: { product_facts: comparisonRows(product) }, validate: data => {
      if (data.variants.some(v => !v.content.bullet_points.length || v.content.bullet_points.length > 5))
        throw new AppError('MODEL_INVALID_STRUCTURE', '每个备选稿需有1至5条不重复卖点，本次未保存成功结果。', 502);
    } });
  return { variants: result.data.variants, angles: ANGLES, model_used: true, trace: result.trace,
    review_status: 'not_reviewed', notice: '备选文案已保存，但尚未执行独立审核。采用为新版本并复检后，再核对未解决问题和交付状态。' };
}

