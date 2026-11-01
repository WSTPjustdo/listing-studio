// 竞品差评 VOC 挖掘：
//   1) 确定性痛点词召回（不调用模型，可离线复现）；
//   2) 真实模型语义分析（提取痛点主题，并只依据商品事实生成"打痛点"卖点）。
// 模型未配置或失败时，保留确定性召回结果并明确标注原因，绝不伪造模型输出。
import { z } from "zod";
import { chatUrl } from "./providers.mjs";
import { parseJsonWithRepair } from "./json-repair.mjs";
import { comparisonRows } from "./aplus.mjs";

// 常见差评痛点召回词（英文，棉布袋/日用通用）。召回只是"候选"，不是语义结论。
const PAIN_TERMS = [
  { term: "too small", zh: "尺寸偏小" },
  { term: "too short", zh: "过短" },
  { term: "smaller than", zh: "比预期小" },
  { term: "too thin", zh: "太薄" },
  { term: "flimsy", zh: "单薄" },
  { term: "broke", zh: "损坏" },
  { term: "ripped", zh: "撕裂" },
  { term: "tore", zh: "撕裂" },
  { term: "faded", zh: "褪色" },
  { term: "color ran", zh: "掉色" },
  { term: "smell", zh: "异味" },
  { term: "handle", zh: "提手/把手" },
  { term: "strap", zh: "肩带/背带" },
  { term: "zipper", zh: "拉链" },
  { term: "seam", zh: "缝线" },
  { term: "stitch", zh: "走线" },
  { term: "not durable", zh: "不耐用" },
  { term: "fell apart", zh: "散架" },
  { term: "cheap", zh: "廉价感" },
  { term: "poor quality", zh: "质量差" },
  { term: "not as described", zh: "与描述不符" },
  { term: "wrong color", zh: "颜色不符" },
  { term: "different color", zh: "颜色有差" },
];

export function parseReviews(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*\d+[.)、]\s*/, "").trim())
    .filter(Boolean);
}

export function painSignals(reviews) {
  const signals = [];
  for (const item of PAIN_TERMS) {
    const needle = item.term.toLowerCase();
    const count = reviews.filter((r) => r.toLowerCase().includes(needle)).length;
    if (count > 0) signals.push({ term: item.term, zh: item.zh, count });
  }
  signals.sort((a, b) => b.count - a.count);
  return { total_reviews: reviews.length, signals };
}

export function productFacts(product) {
  return comparisonRows(product);
}

// 竞品差异分析：把 VOC 痛点确定性映射到商品事实，输出四类结论。
const PAIN_TO_FACTS = [
  { match: /handle|strap|提手|肩带/i, fields: ["handle_length_cm"], label: "提手长度" },
  { match: /small|size|dimension|尺寸|偏小|预期小/i, fields: ["dimensions_cm"], label: "尺寸" },
  { match: /thin|fabric|material|材质|薄/i, fields: ["fabric_weight_gsm", "material"], label: "面料/克重" },
  { match: /capacity|容量/i, fields: ["capacity_l"], label: "容量" },
  { match: /pack|count|件数|包装/i, fields: ["retail_pack_count"], label: "零售件数" },
  { match: /color|faded|褪色|掉色|颜色/i, fields: ["color"], label: "颜色" },
  { match: /broke|ripped|tear|durable|承重|耐用|撕裂|散架/i, fields: ["rated_load_kg"], label: "承重/耐用" },
  { match: /zipper|拉链/i, fields: [], label: "拉链" },
  { match: /smell|异味/i, fields: [], label: "异味" },
];
const FIELD_LABEL = {
  handle_length_cm: "提手长度",
  dimensions_cm: "尺寸",
  fabric_weight_gsm: "克重",
  material: "材质",
  capacity_l: "容量",
  retail_pack_count: "零售件数",
  color: "颜色",
  rated_load_kg: "承重",
};
const UNSUPPORTED_CLAIMS = [
  { match: /durable|耐用|strong|坚固|承重/i, label: "耐用/承重", support: ["rated_load_kg"] },
  { match: /waterproof|防水/i, label: "防水", support: [] },
  { match: /biodegrad|降解|compost/i, label: "可降解", support: [] },
  { match: /eco|环保|green/i, label: "环保", support: [] },
];

function factValue(product, field) {
  const f = product?.[field];
  return f && f.value != null ? f.value : null;
}

function formatFact(field, value) {
  if (value == null) return null;
  if (field === "dimensions_cm" && typeof value === "object") {
    const parts = [value.width, value.height, value.depth].filter((x) => x != null);
    return parts.length ? `${parts.join(" × ")} cm` : null;
  }
  return String(value);
}

export function buildGapAnalysis(painThemes, product) {
  const strengthen = [];
  const needData = [];
  const cannotProve = [];
  const seen = new Set();
  for (const theme of painThemes || []) {
    if (!theme || seen.has(theme)) continue;
    seen.add(theme);
    const rule = PAIN_TO_FACTS.find((r) => r.match.test(theme));
    if (!rule || !rule.fields.length) {
      cannotProve.push({
        theme,
        reason: rule ? `商品档案没有「${rule.label}」字段可核验` : "没有对应的商品事实字段可回应",
      });
      continue;
    }
    const known = rule.fields.filter((f) => factValue(product, f) != null);
    const unknown = rule.fields.filter((f) => factValue(product, f) == null);
    if (unknown.length === 0) {
      strengthen.push({
        theme,
        field: rule.label,
        value: known
          .map((f) => formatFact(f, factValue(product, f)))
          .filter(Boolean)
          .join(" / "),
      });
    } else {
      needData.push({ theme, missing: unknown.map((f) => FIELD_LABEL[f] || f) });
    }
  }
  const avoidClaims = [];
  const themeText = (painThemes || []).join(" ");
  for (const claim of UNSUPPORTED_CLAIMS) {
    if (!claim.match.test(themeText)) continue;
    const missing = claim.support.filter((f) => factValue(product, f) == null);
    if (claim.support.length && missing.length === 0) continue; // 有支撑事实，不必列"不建议"
    avoidClaims.push({
      claim: claim.label,
      reason: missing.length
        ? `缺少支撑事实：${missing.map((f) => FIELD_LABEL[f] || f).join("、")}`
        : "商品档案没有对应证据，写出来无法证明",
    });
  }
  return {
    strengthen,
    needData,
    cannotProve,
    avoidClaims,
    notice:
      "竞品差异分析由痛点与商品档案确定性映射得出；可强化项仍需人工确认表述，需补资料项请补充对应商品事实，不建议表述项不要在文案中使用。",
  };
}

const vocResultSchema = z.object({
  pain_points: z
    .array(
      z.object({
        theme: z.string().max(200),
        zh: z.string().max(200),
        evidence: z.string().max(500),
      }),
    )
    .max(20)
    .default([]),
  grounded_bullets: z
    .array(
      z.object({
        theme: z.string().max(200),
        bullet: z.string().max(2000),
      }),
    )
    .max(20)
    .default([]),
  unsupported: z.array(z.string().max(200)).max(20).default([]),
});

const LANG_NAME = {
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
  zh: "Simplified Chinese",
};

function buildVocPrompt(language = "en") {
  return `You analyze competitor product reviews (1-3 star complaints) to extract customer pain points, then draft "pain-addressing" bullet points that are GROUNDED ONLY in the supplied product facts.
Return one JSON object only: {"pain_points":[{"theme":"...","zh":"...","evidence":"..."}],"grounded_bullets":[{"theme":"...","bullet":"..."}],"unsupported":["..."]}.
Rules:
- pain_points: distinct customer complaints actually mentioned in the reviews. theme in English, zh in Simplified Chinese, evidence is a short verbatim fragment from the reviews.
- grounded_bullets: for each pain point the supplied product facts CAN address, draft ONE customer-facing bullet in ${LANG_NAME[language] || "English"} that addresses it, using ONLY supported facts with their exact values and original units. Never invent a capability, material, dimension, certification or performance claim.
- unsupported: the theme of each pain point the product facts cannot address. Do not write a bullet for these.
- Keep bullets factual and concise; no superlatives, no review/testimonial references, no prices, no contact info.`;
}

export async function analyzeReviews({
  reviews,
  product,
  config,
  language = "en",
}) {
  const signals = painSignals(reviews);
  const base = {
    total_reviews: reviews.length,
    signals: signals.signals,
    pain_points: [],
    grounded_bullets: [],
    unsupported: [],
    gap_analysis: null,
    model_used: false,
    notice: "",
  };
  // 无论模型是否可用，都基于已得到的痛点（召回词 / 语义主题）做确定性差异分析。
  const finalize = () => {
    const themes = [
      ...(base.pain_points || []).map((p) => p.theme),
      ...(signals.signals || []).map((s) => s.term),
    ];
    base.gap_analysis = buildGapAnalysis(themes, product);
    return base;
  };
  if (
    !config ||
    config.provider !== "compatible" ||
    !config.api_key ||
    !config.model ||
    !config.base_url
  ) {
    base.notice =
      "尚未配置真实模型，仅完成确定性痛点词召回与竞品差异分析；语义痛点与打痛点卖点需在模型设置中配置后生成。";
    return finalize();
  }
  const facts = productFacts(product);
  try {
    const deepseek =
      new URL(config.base_url).hostname === "api.deepseek.com" ||
      /deepseek/i.test(String(config.model || ""));
    const response = await fetch(chatUrl(config.base_url), {
      method: "POST",
      signal: AbortSignal.timeout(Number(config.timeout_ms) || 60000),
      headers: {
        "Content-Type": "application/json",
        ...(config.api_key ? { Authorization: `Bearer ${config.api_key}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        stream: false,
        ...(deepseek
          ? {
              response_format: { type: "json_object" },
              max_tokens: 4096,
              thinking: { type: "disabled" },
            }
          : {}),
        messages: [
          { role: "system", content: buildVocPrompt(language) },
          {
            role: "user",
            content: JSON.stringify({
              reviews,
              product_facts: facts,
              deterministic_signals: signals.signals,
            }),
          },
        ],
      }),
    });
    if (!response.ok) {
      const upstream = await response.json().catch(() => null);
      const msg =
        upstream?.error?.message || upstream?.message || `HTTP ${response.status}`;
      throw new Error(`模型服务返回 ${msg}`);
    }
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim())
      throw new Error("模型未返回文本结果");
    const parsed = parseJsonWithRepair(content);
    const data = vocResultSchema.parse(parsed.value);
    base.pain_points = data.pain_points;
    base.grounded_bullets = data.grounded_bullets;
    base.unsupported = data.unsupported;
    base.model_used = true;
    return finalize();
  } catch (error) {
    base.notice = `模型语义分析失败：${
      error?.message || "未知错误"
    }。已保留确定性痛点词召回与竞品差异分析。`;
    return finalize();
  }
}
