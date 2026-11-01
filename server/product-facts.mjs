import { z } from "zod";
import { AppError, editProfile, id } from "./domain.mjs";

const keys = [
  "material",
  "dimensions_cm",
  "fabric_weight_gsm",
  "capacity_l",
  "handle_length_cm",
  "rated_load_kg",
  "retail_pack_count",
  "brand",
  "color",
  // 制造商 / 欧盟责任人也是「商家给的参数」，同样允许挂来源链接（GPSR 四要素的出处）。
  "manufacturer",
  "eu_responsible",
];
const sourceSchema = z
  .object({
    url: z
      .string()
      .trim()
      .max(2000)
      .url()
      .refine((value) => {
        try {
          const u = new URL(value);
          return (
            ["https:", "http:"].includes(u.protocol) &&
            !u.username &&
            !u.password
          );
        } catch {
          return false;
        }
      }, "来源链接须为不含凭据的 HTTP(S) 地址"),
    publisher: z.string().trim().min(1).max(200),
    applicable_model: z.string().trim().min(1).max(200),
    excerpt: z.string().trim().min(10).max(12000),
  })
  .strict();
const extraSchema = z
  .object({
    id: z.string().max(100).optional(),
    label: z.string().trim().min(1).max(100),
    value: z.string().trim().min(1).max(2000),
    source: sourceSchema.nullable().optional(),
  })
  .strict();
const bindingsSchema = z.partialRecord(z.enum(keys), sourceSchema.nullable());
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// User-selected links are recorded as provenance, never fetched or treated as independent proof.
export function saveProductFacts(store, previous, input) {
  const { fact_sources, additional_facts, ...fields } = input || {};
  const bindings =
    fact_sources === undefined ? {} : bindingsSchema.parse(fact_sources);
  const extra =
    additional_facts === undefined
      ? undefined
      : z.array(extraSchema).max(30).parse(additional_facts);
  const next = editProfile(previous, fields);
  next.fact_sources = structuredClone(previous.fact_sources || {});
  const sources = [];
  function bind(field, value, source) {
    const source_id = id("MERCHANT-FACT");
    const saved = {
      ...source,
      source_id,
      recorded_at: new Date().toISOString(),
      value: structuredClone(value),
      field,
      product_ref: `${next.product_id}@${next.revision}`,
    };
    sources.push({
      source_id,
      kind: "merchant_fact_source",
      url: source.url,
      publisher: source.publisher,
      checked_at: saved.recorded_at,
      description: `商家核对后关联的${field}来源；未独立核验`,
      note: "链接与原文由商家填写，不等于独立检测、认证或整句宣称成立。",
      snapshot: saved,
    });
    return saved;
  }
  for (const key of keys) {
    const changed = !equal(previous[key]?.value, next[key]?.value);
    if (changed) delete next.fact_sources[key];
    if (Object.hasOwn(bindings, key)) {
      const source = bindings[key];
      if (source && next[key]?.value == null)
        throw new AppError(
          "SOURCE_WITHOUT_FACT",
          "未知参数不能绑定为已确认来源，请先填写该参数。",
        );
      if (source) {
        const saved = bind(key, next[key].value, source);
        next.fact_sources[key] = saved;
        next[key] = {
          ...next[key],
          status: "merchant_confirmed",
          source_ids: [saved.source_id],
        };
      } else {
        delete next.fact_sources[key];
        if (next[key]?.value != null)
          next[key] = {
            ...next[key],
            status: "merchant_confirmed",
            source_ids: ["LOCAL-MERCHANT-INPUT"],
          };
      }
    }
  }
  if (extra !== undefined) {
    const seen = new Set();
    next.additional_facts = extra.map((entry) => {
      if (entry.id && seen.has(entry.id))
        throw new AppError("DUPLICATE_FACT", "原文资料重复，请刷新后重试。");
      if (entry.id) seen.add(entry.id);
      const old = entry.id
        ? (previous.additional_facts || []).find(
            (f, i) => (f.id || `legacy-${i}`) === entry.id,
          )
        : null;
      if (entry.id && !old)
        throw new AppError("UNKNOWN_FACT", "原文资料已变化，请刷新后重试。");
      const same =
        old && old.label === entry.label && old.value === entry.value;
      if (same && entry.source === undefined)
        return { ...old, id: old.id || entry.id };
      const factId = old?.id || id("fact");
      const source = entry.source
        ? bind(`additional_facts.${factId}`, entry.value, entry.source)
        : null;
      return {
        id: factId,
        label: entry.label,
        value: entry.value,
        status: "merchant_confirmed",
        source_ids: source ? [source.source_id] : ["LOCAL-MERCHANT-INPUT"],
        ...(source ? { source } : {}),
      };
    });
  }
  store.saveProductWithSources(next, sources);
  return next;
}
