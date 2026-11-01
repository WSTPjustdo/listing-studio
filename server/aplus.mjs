// A+ 内容（对比表素材）：由已登记的商品参数**确定性**生成，不做营销文案、不编造事实。
// A+ 模块正文/卖点措辞需用真实模型生成后独立审阅，这里只产出结构化的对比表与图片配文候选。

const ROWS = [
  { key: "material", label_en: "Material", label_zh: "材质" },
  { key: "dimensions_cm", label_en: "Dimensions", label_zh: "尺寸", unit: "cm", fmt: formatDimensions },
  { key: "fabric_weight_gsm", label_en: "Fabric weight", label_zh: "克重", unit: "g/m²" },
  { key: "capacity_l", label_en: "Capacity", label_zh: "容量", unit: "L" },
  { key: "handle_length_cm", label_en: "Handle length", label_zh: "提手长度", unit: "cm" },
  { key: "rated_load_kg", label_en: "Rated load", label_zh: "承重", unit: "kg" },
  { key: "retail_pack_count", label_en: "Pack size", label_zh: "包装件数" },
  { key: "brand", label_en: "Brand", label_zh: "品牌" },
  { key: "color", label_en: "Color", label_zh: "颜色" },
];

function formatDimensions(value) {
  if (!value || typeof value !== "object") return null;
  const parts = [value.width, value.height, value.depth].filter(
    (x) => x != null && Number.isFinite(x),
  );
  return parts.length ? parts.join(" × ") : null;
}

function valueText(spec, fact) {
  const raw = spec.fmt ? spec.fmt(fact.value) : fact.value;
  if (raw == null || raw === "") return null;
  const text = String(raw);
  return spec.unit ? `${text} ${spec.unit}` : text;
}

export function comparisonRows(product) {
  const rows = [];
  for (const spec of ROWS) {
    const fact = product?.[spec.key];
    if (!fact || fact.value == null || fact.value === "") continue;
    const value = valueText(spec, fact);
    if (value == null) continue;
    rows.push({
      field: spec.key,
      label_en: spec.label_en,
      label_zh: spec.label_zh,
      value,
      status: fact.status || "unknown",
      source_ids: Array.isArray(fact.source_ids) ? fact.source_ids : [],
    });
  }
  for (const extra of product?.additional_facts || []) {
    if (!extra || extra.value == null || extra.value === "") continue;
    rows.push({
      field: extra.id || extra.label || "extra",
      label_en: extra.label || "Additional",
      label_zh: extra.label || "额外事实",
      value: String(extra.value),
      status: extra.status || "unknown",
      source_ids: Array.isArray(extra.source_ids) ? extra.source_ids : [],
    });
  }
  return rows;
}

export function missingFields(product) {
  const missing = [];
  for (const spec of ROWS) {
    const fact = product?.[spec.key];
    if (!fact || fact.value == null || fact.value === "") {
      missing.push({ field: spec.key, label_en: spec.label_en, label_zh: spec.label_zh });
    }
  }
  return missing;
}

export function buildAplus(product, options = {}) {
  const rows = comparisonRows(product);
  const missing = missingFields(product);
  return {
    generated_at: new Date().toISOString(),
    product_ref: product?.product_id || null,
    revision: product?.revision ?? null,
    marketplace: options.marketplace || "US",
    language: options.language || "en",
    comparison_chart: rows,
    missing_parameters: missing,
    module_copy: {
      type: "comparison_chart",
      headline: null,
      feature_bullets: rows.slice(0, 5).map((r) => `${r.label_en}: ${r.value}`),
      note: "对比表与图片配文候选由已登记商品参数确定性生成，不构成 A+ 营销文案，也不代表平台审核结论；A+ 模块正文与卖点措辞需用真实模型生成后独立审阅。",
    },
  };
}
