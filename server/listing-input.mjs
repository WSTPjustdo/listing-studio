import { z } from 'zod';
import { ALL_LANGUAGES, DEFAULT_MARKETPLACE, languagesFor, WORKFLOW_MARKETPLACES } from './store.mjs';

// Shared by the advanced create and diagnose endpoints. Pair validation happens
// before looking up a product, queuing a run or dispatching a paid model call.
export const listingRunInputSchema = z.object({
  content_brief: z.object({
    audience: z.enum(['日常购物用户', '活动采购人员', '企业采购人员']),
    use_case: z.enum(['日常携带', '活动赠品', '企业定制']),
    concern: z.enum(['尺寸与使用便利', '材质与规格', '定制适用性']),
    style: z.enum(['简洁自然', '参数清晰', '场景导向']),
  }).optional(),
  product_id: z.string().max(100).nullable().optional(),
  product_revision: z.number().int().positive().optional(),
  instruction: z.string().max(10000).default(''),
  language: z.enum(ALL_LANGUAGES).default('en'),
  marketplace: z.enum(WORKFLOW_MARKETPLACES).default(DEFAULT_MARKETPLACE),
  request_id: z.string().max(120).optional(),
}).superRefine((input, context) => {
  const allowed = languagesFor(input.marketplace);
  if (!allowed.includes(input.language)) context.addIssue({
    code: 'custom', path: ['language'],
    message: `Amazon ${input.marketplace} 站不支持所选文案语言；可选：${allowed.join(' / ')}。`,
  });
});
