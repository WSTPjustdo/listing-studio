import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { inspectEvidence } from "./evidence.mjs";
import { compositionRuns, parseComposition, germanWordingFor } from "./material.mjs";
import { isEuCountry, normalizeParty, partySchema, summarizeParty } from "./gpsr-parties.mjs";

export const contentSchema = z
  .object({
    title: z.string().trim().min(1, "请填写标题").max(5000),
    item_highlights: z.string().max(10000).default(""),
    bullet_points: z
      .array(
        z.object({
          id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
          text: z.string().max(10000),
        }),
      )
      .max(20)
      .refine(
        (items) => new Set(items.map((x) => x.id)).size === items.length,
        "要点 ID 不能重复",
      ),
    description: z.string().max(100000),
  })
  .strict();

export const profileEditSchema = z
  .object({
    name_zh: z.string().trim().min(1).max(120),
    material: z.string().trim().max(100),
    width: z.number().positive().max(1000).nullable(),
    height: z.number().positive().max(1000).nullable(),
    depth: z.number().positive().max(1000).nullable().optional(),
    fabric_weight_gsm: z.number().positive().max(3000).nullable(),
    capacity_l: z.number().positive().max(1000).nullable(),
    handle_length_cm: z.number().positive().max(1000).nullable(),
    rated_load_kg: z.number().positive().max(1000).nullable().optional(),
    retail_pack_count: z.number().int().positive().max(10000).nullable(),
    brand: z.string().max(120),
    color: z.string().max(120),
    // GPSR 第 19 条要的两方：制造商、制造商在欧盟外时的欧盟责任人。
    // 两者都可选、都可空 —— 商家填一半也能存（存了才有东西可判「缺哪项」），
    // 传 null 表示清空，传 undefined 表示本次不动这一项。
    manufacturer: partySchema.nullable().optional(),
    eu_responsible: partySchema.nullable().optional(),
  })
  .strict();

export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const characterCount = (text) => [...text].length;
export const contentHash = (content) =>
  createHash("sha256").update(JSON.stringify(content)).digest("hex");
export const clone = (value) => structuredClone(value);
export const id = (prefix) => `${prefix}-${randomUUID()}`;

export function flattenContent(content) {
  return [
    { path: "content.title", text: content.title },
    { path: "content.item_highlights", text: content.item_highlights },
    ...content.bullet_points.map((b) => ({
      path: `content.bullet_points.${b.id}`,
      text: b.text,
    })),
    { path: "content.description", text: content.description },
  ];
}

export function uniquePatches(patches) {
  const fields = new Map();
  for (const patch of patches) {
    const existing = fields.get(patch.field_path);
    if (existing && (existing.expected_before !== patch.expected_before || existing.replacement !== patch.replacement))
      throw new AppError("CONFLICTING_PATCHES", "同一字段存在不同的修复建议，请只选择其中一条，或使用一键审查重新生成建议。");
    if (!existing) fields.set(patch.field_path, patch);
  }
  return [...fields.values()];
}

export function applyPatches(content, patches, baseVersion, currentVersion) {
  if (baseVersion !== currentVersion)
    throw new AppError(
      "STALE_VERSION",
      "内容已有新版本，请刷新后重新选择修改建议。",
      409,
    );
  const result = clone(content);
  const values = new Map(flattenContent(content).map((x) => [x.path, x.text]));
  const seen = new Set();
  for (const patch of patches) {
    if (!values.has(patch.field_path) || seen.has(patch.field_path))
      throw new AppError("INVALID_PATCH", "修改路径无效或重复。");
    if (
      typeof patch.replacement !== "string" ||
      patch.replacement.length > 100000
    )
      throw new AppError("INVALID_PATCH", "修改内容无效。");
    if (values.get(patch.field_path) !== patch.expected_before)
      throw new AppError(
        "STALE_PATCH",
        "建议对应的原文已变化，请重新诊断。",
        409,
      );
    seen.add(patch.field_path);
    const bullet = /^content\.bullet_points\.([a-zA-Z0-9_-]+)$/.exec(
      patch.field_path,
    );
    if (bullet)
      result.bullet_points.find((b) => b.id === bullet[1]).text =
        patch.replacement;
    else result[patch.field_path.slice(8)] = patch.replacement;
  }
  return contentSchema.parse(result);
}

export function diffContent(before, after) {
  const old = new Map(flattenContent(before).map((x) => [x.path, x.text]));
  const current = new Map(flattenContent(after).map((x) => [x.path, x.text]));
  return [...new Set([...old.keys(), ...current.keys()])].flatMap(
    (field_path) =>
      old.get(field_path) === current.get(field_path)
        ? []
        : [
            {
              field_path,
              before: old.get(field_path) ?? "",
              after: current.get(field_path) ?? "",
            },
          ],
  );
}

function supportedValue(profile, key) {
  return profile?.[key]?.value ?? null;
}
export const valueOf = supportedValue;

export function missingData(profile) {
  if (!profile)
    return [
      {
        field: "product",
        label: "商品档案",
        reason: "未关联商品，只能执行部分文本检查。",
      },
    ];
  return ["brand", "color", "retail_pack_count", ...(profile.amazon || profile.imported_table ? ["material"] : [])]
    .filter((key) => supportedValue(profile, key) === null)
    .map((field) => ({
      field,
      label: { brand: "品牌", color: "颜色", retail_pack_count: "零售包装", material: "材质" }[
        field
      ],
      reason: field === "color"
        ? "实际售卖变体的颜色未确认；请核对该 ASIN / SKU 的选定颜色及来源原文，不能采用系列可选色或页面默认色。草稿不推测，正式上架前仍需确认。"
        : field === "retail_pack_count"
          ? "该零售 SKU 每包袋子件数未确认；请核对销售包装或订单规格及来源原文，工厂装箱数、页面购买数量和单数 bag 均不能代替每包件数。草稿不推测，正式上架前仍需确认。"
          : "未确认，草稿中不推测；正式上架仍需核对。",
    }));
}

export function generateLocalDraft(profile, purpose = "") {
  if (!profile)
    throw new AppError("MISSING_PRODUCT", "创建草稿前请选择商品档案。");
  const material = supportedValue(profile, "material");
  const dimensions = supportedValue(profile, "dimensions_cm");
  const gsm = supportedValue(profile, "fabric_weight_gsm");
  const capacity = supportedValue(profile, "capacity_l");
  const handles = supportedValue(profile, "handle_length_cm");
  const pack = supportedValue(profile, "retail_pack_count");
  const name = /cotton|棉/i.test(material) ? "Cotton Tote Bag" : "Tote Bag";
  const commute = /通勤|commut/i.test(purpose);
  const use = commute
    ? "daily commuting and everyday carrying"
    : "everyday carrying";
  const bullets = [];
  if (material)
    bullets.push({
      id: "b1",
      text: `Material: ${material}${gsm ? `; fabric weight ${gsm} g/m²` : ""}.`,
    });
  if (dimensions)
    bullets.push({
      id: "b2",
      text: `Dimensions: ${dimensions.width} × ${dimensions.height} cm (approximately ${(dimensions.width / 2.54).toFixed(1)} × ${(dimensions.height / 2.54).toFixed(1)} in).`,
    });
  if (capacity) bullets.push({ id: "b3", text: `Capacity: ${capacity} L.` });
  if (handles)
    bullets.push({ id: "b4", text: `Handle length: ${handles} cm.` });
  if (pack)
    bullets.push({
      id: "b5",
      text: `Pack contents: ${pack} tote ${pack === 1 ? "bag" : "bags"}.`,
    });
  const brand = supportedValue(profile, "brand");
  return contentSchema.parse({
    title: `${brand ? `${brand} ` : ""}${name}${handles ? " with Long Handles" : ""}${pack ? `, ${pack} Pack` : ""}`,
    item_highlights:
      [
        material,
        gsm && `${gsm} g/m² fabric`,
        capacity && `${capacity} L capacity`,
        handles && `${handles} cm handles`,
      ]
        .filter(Boolean)
        .join("; ") + ".",
    bullet_points: bullets,
    description: `A ${material || ""} tote bag for ${use}.${dimensions ? ` The bag measures ${dimensions.width} × ${dimensions.height} cm.` : ""}${capacity ? ` It has a ${capacity} L capacity.` : ""}${pack ? ` Each pack contains ${pack} ${pack === 1 ? "bag" : "bags"}.` : ""}`,
  });
}

export function localRevision(content, instruction, profile) {
  const result = clone(content);
  const conflicts = [];
  const gsm =
    /(?:改成|改为|改到|change.{0,15}to)\s*(\d+)\s*(?:g\s*\/\s*m[²2]|gsm|克)/i.exec(
      instruction,
    );
  if (gsm && Number(gsm[1]) !== supportedValue(profile, "fabric_weight_gsm"))
    conflicts.push("面料克重与已确认档案不一致，请先在商品资料中确认新版本。");
  if (
    /(?:加上|加入|标上|add|claim).{0,20}(?:有机|organic|防水|waterproof|认证|certif|承重|降解)/i.test(
      instruction,
    )
  )
    conflicts.push("该修改涉及未提供证据的认证或性能宣称，已保留原文。");
  if (conflicts.length) return { content: result, conflicts };
  let recognized = false;
  if (
    /(?:标题|title)/i.test(instruction) &&
    /简|短|short|concise/i.test(instruction)
  ) {
    const pack = supportedValue(profile, "retail_pack_count");
    result.title = `${/cotton|棉/i.test(supportedValue(profile, "material") || "") ? "Cotton Tote Bag" : "Tote Bag"}${pack ? `, ${pack} Pack` : ""}`;
    recognized = true;
  }
  if (/通勤|commut/i.test(instruction)) {
    result.description = generateLocalDraft(profile, "通勤").description;
    recognized = true;
  }
  if (!recognized)
    throw new AppError(
      "DEMO_INSTRUCTION_UNSUPPORTED",
      "本地演示支持“标题简洁一些”和“突出日常通勤”。自由改写请配置模型，也可以直接编辑字段。",
    );
  return { content: contentSchema.parse(result), conflicts };
}

export function sourceIdsForProfile(profile) {
  const ids = new Set();
  function walk(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'source_id' && typeof child === 'string') ids.add(child);
      else if (key === "source_ids" && Array.isArray(child))
        child.forEach((x) => ids.add(x));
      else walk(child);
    }
  }
  walk(profile);
  return [...ids];
}

// These are conservative local candidates, never presented as a model or legal decision.

/**
 * 从 Word / Excel / 微信 / 公众号复制过来的文案，常带着「看起来一样、编码不一样」的字符：
 * `‐‑‒–—−－` 六种连字符、零宽空格、不换行空格。我们的正则只写了 ASCII 的 `-` 与 `\s`，
 * 于是一个连字符就能让整条宣称漏掉。
 *
 * 实测（2026-10-29，14 条变体句）：漏 6 条 ——
 *   `ECO–FRIENDLY`（U+2013）、`ECO‑FRIENDLY`（U+2011）、`ECO－FRIENDLY`（全角减号）、
 *   `ECO\u200B-FRIENDLY`（零宽空格）、`BPA‑free`、`limited‑time`、`Carbon‑neutral`。
 * 这不是边角情况：商家的大部分文案是从供应商表格里粘过来的。
 *
 * 归一化只用于**匹配**，报告里引用的仍是原文那串字符（见 `matchView`）。
 */
const INVISIBLE = /[\u200B-\u200D\uFEFF\u2060]/;
const DASH_VARIANT = /[\u2010-\u2015\u2212\uFF0D]/;

export function normalizeForMatch(text) {
  let out = "";
  for (const ch of String(text)) {
    if (INVISIBLE.test(ch)) continue;
    out += DASH_VARIANT.test(ch) ? "-" : ch === "\u00A0" ? " " : ch;
  }
  return out;
}

/**
 * 归一化后的文本 + 回原文的位置映射。
 * 为什么不能直接拿归一化串当原文：删掉零宽空格会让后面的下标整体前移，
 * 报告里的 `original` 就会指到别的字上，甚至印出用户没写过的那版（`BPA‑free` 印成 `BPA-free`）。
 */
function matchView(text) {
  const source = String(text);
  let normalized = "";
  const map = [];
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (INVISIBLE.test(ch)) continue;
    normalized += DASH_VARIANT.test(ch) ? "-" : ch === "\u00A0" ? " " : ch;
    map.push(i);
  }
  return {
    text: normalized,
    /** 归一化串里的 [start, start+length) 回到原串是什么。 */
    original(start, length) {
      if (!length) return "";
      const from = map[start];
      const to = map[start + length - 1];
      return to === undefined ? "" : source.slice(from, to + 1);
    },
  };
}

/**
 * 否定判断：只在「否定词直接管着这个宣称」时才算被否定。
 *
 * 以前是「命中位置前 110 字符里出现 no/not/never/without 就整句跳过」，
 * 于是 `No plastic, antibacterial lining keeps the bag fresh.` 里的 US-04（抗菌）被吃掉——
 * 那个 no 管的是塑料成分，不是抗菌。评测集 ES-001 把这条固化成了一个可复现的用例。
 *
 * 现在的判据：否定词与命中位置之间**只隔着空格和副词/系动词**（not really waterproof、
 * not be waterproof），才算否定它。中间夹了别的名词（no plastic, antibacterial）就说明
 * 那个否定管的是别的东西。
 *
 * 两个刻意保留的边界：
 * - `not only … but also waterproof` 仍然是肯定句，先整体删掉 `not only` / `not just`；
 * - 句号、感叹号、分号依旧是硬边界（跨句不管），逗号**不再**是边界——
 *   `Not waterproof, so bring a cover.` 这种写法里，逗号后面的词反而更该被否定。
 */
const NEGATOR_SOURCE = "\\b(?:no|not|never|without|cannot|can't|do not|don't)\\b";
// 否定词与宣称之间允许夹的词：副词、系动词，以及「用/加/含」这类动词——
// `We do not use antimicrobial treatments` 是典型的否定结构，`use` 夹在中间不能算"管的是别的东西"。
// 但名词不行：`No plastic, antibacterial lining` 里的 plastic 说明这个 no 管的是塑料。
const NEGATION_BRIDGE = new RegExp(
  "^(?:[\\s,]|(?:really|very|entirely|fully|completely|necessarily|actually|ever|any|be|been|being|is|are|was|were|" +
    "going to be|going to|guaranteed|use|uses|used|using|add|adds|added|adding|apply|applies|applied|" +
    "contain|contains|contained|containing|include|includes|included|including|have|has|had|having|" +
    "feature|features|featured|need|needs|needed|require|requires|required|make|makes|made|the|a|an|of)\\b)*$",
  "i",
);

function isNegated(text, index) {
  const start =
    Math.max(
      text.lastIndexOf(".", index - 1),
      text.lastIndexOf("!", index - 1),
      text.lastIndexOf(";", index - 1),
    ) + 1;
  const prefix = text.slice(start, index).slice(-110).replace(/\bnot (?:only|just)\b/gi, "");
  const negators = [...prefix.matchAll(new RegExp(NEGATOR_SOURCE, "gi"))];
  if (!negators.length) return false;
  return negators.some((match) => {
    const bridge = prefix.slice(match.index + match[0].length);
    return NEGATION_BRIDGE.test(bridge);
  });
}

function positiveMatch(text, pattern) {
  const regex = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g",
  );
  for (const match of text.matchAll(regex))
    if (!isNegated(text, match.index)) return match;
  return null;
}

// free-of 这一类官方（16 CFR 260.9）点名的是「不含某成分」这个**结构**，不是某一个词：
// 以前只写了 `plastic-free`，于是 `BPA free` / `phthalate-free` / `PFAS-free` 全部静默漏掉
// （实测见 scripts/claim-recall-probe.mjs 的 260.9a）。这里按结构收，成分名可扩展。
const FREE_OF_SOURCE =
  "(?:plastic|bpa|phthalates?|pfas|pfoa|pvc|formaldehyde|chemicals?|sulfates?|parabens?)";
export const ECO_CLAIM_PATTERN = new RegExp(
  `\\b(?:eco[-\\s]?friendly|environmentally\\s+friendly|planet[-\\s]?friendly|earth[-\\s]?friendly|zero\\s+environmental\\s+impact|zero\\s+waste|100%\\s*green|sustainab(?:le|ly|ility)|recycl(?:ed|able|ing)|upcycled|${FREE_OF_SOURCE}[-\\s]?free|carbon[-\\s]?neutral|carbon[-\\s]?offset)\\b`,
  "i",
);

// 认证印章（16 CFR 260.6）：官方点名「不能用不说明认证依据的印章」，而中国制造商文案里
// GREENGUARD / OEKO-TEX / GOTS 是高频卖点。以前只有 `certified organic` 一个写法能召回，
// `GREENGUARD Gold certified` 一个字都不抓（实测 260.6 漏）。
// 这条**不核验认证真伪**：召回之后交给人看，人手里才有证书。
const CERTIFICATION_SEAL_SOURCE =
  "(?:greenguard(?:\\s+gold)?|oeko[-\\s]?tex|bluesign|cradle[-\\s]?to[-\\s]?cradle|gots|global\\s+organic\\s+textile\\s+standard|fsc|certified)";
export const PERFORMANCE_CLAIM_PATTERN = new RegExp(
  `\\b(?:certified\\s+organic|organic\\s+certified|waterproof|water[-\\s]?resistant|water[-\\s]?repellent|leak[-\\s]?proof|non[-\\s]?toxic|tear[-\\s]?resistant|stain[-\\s]?resistant|${CERTIFICATION_SEAL_SOURCE}|\\d+(?:\\.\\d+)?\\s*(?:kg|kgs|lbs?|pounds?)\\s*(?:carrying|load|capacity)|(?:holds?|supports?|carries?|tested\\s+to|rated\\s+(?:for|at)|load(?:ed)?\\s+(?:up\\s+)?to)\\s*(?:up\\s+to\\s*)?\\d+(?:\\.\\d+)?\\s*(?:kg|kgs|lbs?|pounds?))\\b`,
  "i",
);

/**
 * 促销语（promotional language）。依据是 Detail Page 公告原文：
 * `do not include … promotional language such as "sale" or "free shipping"`（源 `AMZS-DETAIL-PROMO`）。
 *
 * 只收**整短语**，不收裸 `best` / `sale` / `free`：
 *   · 20 条真实在售文案里 `gift bag` 命中 14/20、`perfect for` 8/20 全是正常卖点；
 *   · 裸 `sale` 还会打到 `wholesale`，裸 `free` 会打到 `freezer`。
 * 宁可窄：这条的用途是「平台直接抑制」的理由，报出来的每一条得让人一眼认出来。
 */
export const PROMO_LANGUAGE_PATTERN =
  /\b(?:(?:on\s+sale|sale\s+price|clearance\s+sale|discount(?:ed)?\s+price|\d{1,3}\s*%\s*off|save\s+\d{1,3}\s*%|(?:use\s+)?(?:coupon|promo\s*code))|(?:best\s+deal|great\s+deal|hot\s+deal|deal\s+of\s+the\s+(?:day|week|season))|(?:best[-\s]?sell(?:er|ing)|#\s?1\s+(?:best[-\s]?seller|seller)|top[-\s]?rated|amazon'?s\s+choice)|(?:limited[-\s]?time|today\s+only|this\s+week\s+only|while\s+supplies\s+last|act\s+now|order\s+now|buy\s+now|hurry|don'?t\s+miss)|(?:buy\s+\d+\s+get\s+\d+|free\s+gift|free\s+shipping|money[-\s]?back\s+guarantee|satisfaction\s+guaranteed)|(?:click\s+here|shop\s+now|visit\s+(?:our|the)\s+store|check\s+out\s+our))\b/i;

/**
 * 医疗、健康与抗菌宣称（`US-04`）。
 *
 * 为什么单开一条：中国纺织品文案里「抗菌 / 防霉 / 除螨 / 缓解酸痛」是常规卖点，
 * 而它们在美国属于**客观宣称**，FTC 要求"有可依据的科学证据"（`FTCS-AD-SUBSTANTIATION`）。
 * 以前引擎对这类词零覆盖：20 条真实文案之外，只要商家自己写了，报告会说"没问题"。
 *
 * 收法分三支，避免误报：
 *   1. **成品写法**（antibacterial / sterile / allergy tested…）——整词收，
 *      这类词单独出现就是宣称，不需要上下文。
 *   2. **名词式作用宣称**（mildew proof / mold-resistant / dust mite resistant / germ-free）——
 *      中国供应商文案里「防霉 / 抗菌 / 除螨」最常见的英文写法就是这几种 `-proof / -resistant / -free`，
 *      而第 16 轮之前一支都不认（`scripts/claim-recall-probe.mjs` 第三栏实测 0/16）。
 *      **只收微生物对象**：气味状态（odor-free）与舒适度（anti-fatigue / skin-friendly）不是医疗claim，
 *      收进来就是瞎报；它们该由性能宣称那条管，本包还没实现，这条限制写进了 rules.json 的 note。
 *   3. **动词 + 身体或病菌对象**——`relieve` 后面必须 3 个词内挂到 `pain`/`bacteria` 之类的宾语。
 *      这一支是必需的：裸 `treat` 会打到 `treat yourself`，裸 `reduce` 会打到 `reduce waste`，
 *      裸 `protect` 会打到 `protect your phone`。所以只认"动词真的指向身体/病菌"的句子。
 *
 * 本规则**不判断宣称真伪**，也不区分「有没有做检测」——那要证书，人手里才有。
 */
const MEDICAL_VERB_SOURCE =
  "reliev(?:e|es|ed|ing)|alleviat(?:e|es|ed|ing)|eas(?:e|es|ed|ing)|soothe?s?|soothing|cures?|curing|heals?|healing|treats?|treating|prevents?|preventing|fights?|fighting|combats?|combating|reduces?|reducing|eliminates?|eliminating|kills?|killing";
// `strains?` 只收「肩/背/颈/关节/肌肉 + 劳损」这种写法：
// 裸 `strain` 会打到 `reduces strain on the seams`（那是耐用性宣称，不是医疗）。
const MEDICAL_OBJECT_SOURCE =
  "pains?|aches?|soreness|(?:shoulder|back|neck|joint|muscle)\\s+strains?|chapped|inflammation|swelling|arthritis|rashes?|eczema|acne|infections?|bacteri(?:a|um)|germs?|vir(?:us|uses)|odou?rs?|molds?|mou?lds?|mildew|dust\\s*mites?|mites?|diseases?|symptoms?|allerg(?:y|ies|ens)";
// 名词式：对象 + -proof / -resistant / -free / -repellent / -control。只认微生物对象（见上面第 2 支）。
const MEDICAL_MICROBE_SOURCE =
  "molds?|mou?lds?|mildew|germs?|bacteri(?:a|um)|vir(?:us|uses)|dust\\s*mites?|mites?";
const MEDICAL_QUALIFIER_SOURCE = "proof|resistant|free|repellent|repelling|control";
const MEDICAL_TERM_SOURCE =
  "antibacterial|anti[-\\s]?bacterial|antimicrobial|anti[-\\s]?microbial|antifungal|anti[-\\s]?fungal|antiseptic|antibiotic|disinfect(?:ant|ants|ing|s)?|sterili[sz](?:e|es|ed|ing|ation)|sterile|saniti[sz](?:e|es|ed|ing|ation)|non[-\\s]?allergenic|allergy[-\\s]?tested|anti[-\\s]?(?:mites?|molds?|mou?lds?|mildew|germs?|odou?r|inflammator(?:y|ies)|inflammation|allerg(?:y|ies))|pain[-\\s]?relie(?:f|ving)|hypoallergenic|hypo[-\\s]?allergenic|medical[-\\s]?grade|medical[-\\s]?use|medical[-\\s]?purpose|surgical[-\\s]?grade|hospital[-\\s]?grade|clinically\\s+(?:proven|tested|shown)|dermatologist[-\\s]?(?:recommended|tested|approved)|fda[-\\s]?(?:approved|registered|cleared)|epa[-\\s]?registered|non[-\\s]?irritating";
export const MEDICAL_CLAIM_PATTERN = new RegExp(
  [
    // 中间允许 0–3 个词：`kills 99% of bacteria` 里 `99%` 不是 `\w+`，用 `\S+` 才收得住。
    `\\b(?:${MEDICAL_TERM_SOURCE})\\b`,
    `\\b(?:${MEDICAL_MICROBE_SOURCE})\\s*[-\\s]\\s*(?:${MEDICAL_QUALIFIER_SOURCE})\\b`,
    `\\b(?:${MEDICAL_VERB_SOURCE})\\s+(?:\\S+\\s+){0,3}(?:${MEDICAL_OBJECT_SOURCE})\\b`,
  ].join("|"),
  "i",
);

const PACK_UNIT_SOURCE = "(?:packs?|pcs|pieces|count|sets?)";
/**
 * 医疗/健康/抗菌宣称的四类分法。
 *
 * 为什么必须分：这 28 种写法命中之后，商家要做的**不是同一件事**。
 *   · 「抗菌」→ 补一份第三方检测报告（写明方法、菌种、抑菌率）就能留；
 *   · 「缓解肩背酸痛」→ 补报告也留不住，它把商品往药品/医疗器械的口径上推，只能删；
 *   · 「低敏」→ 要的是人体测试，且「不会过敏」几乎无法证明；
 *   · 「FDA 注册」→ 不是证据问题，是**说法本身会误导**（FDA 原文：注册不表示批准）。
 * 第 16 轮之前这四类共用一句话：「补充对应检测报告或临床依据」。对第 2、4 类那是错的动作。
 *
 * 依据只写能对上原文的部分：FDA 那句原文见 `fda.gov` 的
 * Important Reminders about Registration and Listing（`does not denote approval, clearance or authorization`），
 * 出处是**医疗器械**语境，我们只引用「注册 ≠ 批准」这一点，不引申到食品接触设施。
 */
const MEDICAL_ADVISORIES = [
  {
    id: "regulatory",
    match: /\b(?:fda|epa|medical[\s-]?(?:grade|use|purpose)|surgical[\s-]?grade|hospital[\s-]?grade)\b/i,
    label: "监管状态类（FDA 注册 / 医疗级）",
    reason:
      "「FDA 注册」不等于「FDA 批准」。FDA 官方原文：注册与列名 does not denote approval, clearance or authorization。把注册号当卖点，读起来像官方背书。",
    suggestion:
      "要么删掉 FDA 字样，要么写清「已注册，注册号 X，不代表 FDA 批准」；「医疗级 / 手术级」没有对应的官方分级，属于自造等级，建议一并删掉。",
  },
  {
    id: "therapeutic",
    match:
      /\b(?:reliev(?:e|es|ed|ing)|alleviat(?:e|es|ed|ing)|eas(?:e|es|ed|ing)|soothe?s?|soothing|cures?|heals?|healing|treats?|treating|pain[\s-]?relie(?:f|ving)|anti[\s-]?inflammator(?:y|ies)|inflammation|(?:shoulder|back|neck|joint|muscle)\s+strains?|chapped)\b/i,
    label: "疗效类（缓解疼痛 / 抗炎）",
    reason:
      "这类句子在说「用了它对人体有生理作用」。在美国这会把商品往药品或医疗器械的监管口径上推，不是补一份检测报告能解决的。",
    suggestion:
      "直接删掉这句，换成能验证的舒适性描述（宽肩带、加厚提手、装 15 kg 不勒手）。棉布袋卖「缓解肩背酸痛」多赚不到信任，反而给平台和下架留了理由。",
  },
  {
    id: "allergen",
    match: /\b(?:hypo[\s-]?allergenic|non[\s-]?allergenic|allergy[\s-]?tested|non[\s-]?irritating)\b/i,
    label: "过敏类（低敏 / 抗过敏）",
    reason:
      "「低敏」「抗过敏」说的是人对它的反应，属于要依据的客观宣称；而「不会引起过敏」这种绝对说法基本证不出来——谁也不能保证每个人不过敏。",
    suggestion:
      "有斑贴试验或人体测试报告才保留，并写明测的是什么、多少人；没有就改成可验证的写法，例如「未添加香精与染料」。",
  },
  {
    id: "endorsement",
    match:
      /\b(?:dermatologist[\s-]?(?:recommended|tested|approved)|clinically\s+(?:proven|tested|shown)|tested\s+by\s+dermatologists|doctor[\s-]?recommended)\b/i,
    label: "专家背书类（皮肤科推荐 / 临床验证）",
    reason:
      "「皮肤科医生推荐」「临床验证」是拿第三方的名义做担保：读者会理解成有人做过研究并得出这个结论。没有出处时，这句话本身就是编的。",
    suggestion:
      "要么写清是谁做的、什么时候、多少人、结论原文（并把报告留档），要么删掉这半句只留后面的产品事实。别留着「clinically proven」当形容词用。",
  },
  {
    id: "microbe",
    match: null,
    label: "微生物类（抗菌 / 防霉 / 除螨 / 无菌）",
    reason:
      "抗菌、防霉、除螨、消毒、无菌都是可验证的客观宣称，需要第三方检测报告：写明测试方法、靶标菌种或螨种、抑菌率或除螨率与测试条件。厂里自己说不算。",
    suggestion:
      "有第三方检测报告就写清「经 X 方法检测，对 Y 菌抑菌率 Z%」并把报告编号留在内部档案；没有就删掉这个词，别只留「抗菌」两个字——那句话在平台侧最容易被要求举证。",
  },
];

/** 拿一次命中的原文判断它属于哪一类。认不出来的一律按最后一类（微生物）处理——宁可多说检测报告，不许漏。 */
export function medicalClaimAdvisory(claim) {
  const text = String(claim || "");
  const found = MEDICAL_ADVISORIES.find((x) => x.match && x.match.test(text));
  return found || MEDICAL_ADVISORIES[MEDICAL_ADVISORIES.length - 1];
}

/**
 * 环保宣称的六类分法，依据 `FTCS-GREEN-SUMMARY`（Green Guides 摘要页，2012 版仍是现行版）。
 *
 * 为什么必须分：`ECO_CLAIM_PATTERN` 一口气召回 8 种词，官方对它们的处理**不是一件事**——
 * 可回收加限定语就能用，含再生材料要说比例，不含某成分要满足三条件，
 * 碳中和要披露抵消范围，零废弃几乎证不出来，eco-friendly / sustainable 是官方点名"别泛用"。
 * 一律说「移除宽泛宣称」，等于让商家把能用的卖点也删掉。
 *
 * 顺序有讲究：先判最具体的（carbon / zero / free-of），再判再生与可回收，最后才落到 broad。
 * `100% green` 归 zero 而不是 broad：它的问题在"100%"这个绝对量，不在"green"。
 */
const ECO_ADVISORIES = [
  {
    id: "carbon",
    match: /\bcarbon[-\s]?(?:neutral|offset)\b/i,
    label: "碳中和 / 碳抵消",
    reason:
      "碳中和与碳抵消是对外的确定性承诺，官方要求说明抵消的是哪一部分排放、按什么口径核算，光一个词说明不了。",
    suggestion:
      "想保留就得补两件事：抵消范围（哪一段排放，例如「运输环节」）与核算依据。补不出来就改成能验证的做法，例如「包装使用再生纸」。",
  },
  {
    id: "zero",
    match: /\b(?:zero[-\s]?(?:waste|environmental\s+impact)|100%\s*green)\b/i,
    label: "零废弃 / 零环境影响的绝对化说法",
    reason: "「零」「100%」是绝对量，要证明整条流程都成立才敢写，实际上几乎做不到。",
    suggestion:
      "换成能拿出证据的具体说法（「包装 100% 再生纸」可以，「零废弃」不行）。这类词最容易在评委追问时塌掉。",
  },
  {
    id: "free-of",
    match: new RegExp(`\\b${FREE_OF_SOURCE}[-\\s]?free\\b`, "i"),
    label: "不含某成分（free-of）",
    reason:
      "「不含某成分」要同时满足三点：确实不含（含微量判定口径）、不暗示因此有其他环境收益、必要处说明限定范围。",
    suggestion:
      "保留可以，但要写清「哪个部件不含什么」（例如「外层帆布不含塑料」），别让它顺带暗示「所以更环保」。",
  },
  {
    id: "recycled-content",
    match: /\b(?:recycled|upcycled)\b/i,
    label: "含再生材料",
    reason: "含再生材料是可以说的具体宣称，但买家会默认成「全部都是再生的」，比例不写清就是误导。",
    suggestion: "补上再生成分比例（例如「面料含 30% 再生棉」），比例拿不到就先别写这个词。",
  },
  {
    id: "recyclable",
    match: /\brecycl(?:able|ing)\b/i,
    label: "可回收",
    reason:
      "「可回收」取决于买家当地有没有对应的回收设施。官方口径是：覆盖不到 60% 消费者时要加限定语。",
    suggestion:
      "这个词通常不用删：加一句限定就行——「在提供塑料回收设施的地区可回收」。删掉是把卖点白丢了。",
  },
  {
    id: "broad",
    match: null,
    label: "宽泛环保宣称",
    reason:
      "官方点名 eco-friendly / sustainable / green 这类泛用词：不做限定就不能用，因为买家会理解成「整个产品对环境都好」。",
    suggestion: "移除这个泛用词，换成具体的、能拿出证据的表述（材质、比例、可回收性各说各的）。",
  },
];

/** 拿一次命中的原文判断它属于哪一类。认不出来的一律按最泛的那类处理（宁可多说一句，不许漏）。 */
export function ecoClaimAdvisory(claim) {
  const text = String(claim || "");
  const found = ECO_ADVISORIES.find((x) => x.match && x.match.test(text));
  return found || ECO_ADVISORIES[ECO_ADVISORIES.length - 1];
}
export function detectMultiPackTitle(title) {
  const text = typeof title === "string" ? title : "";
  if (!text) return null;
  const seen = new Map(); // 件数 -> 首次出现的原文片段
  const order = [];
  const take = (value, snippet) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1 || n > 999 || seen.has(n)) return;
    seen.set(n, snippet);
    order.push(n);
  };
  // 并列写法：斜杠或竖线把几个规格串在一起，单位词只写一次（`1 | 3 | 6 | 30 Pack`）。
  for (const match of text.matchAll(
    new RegExp(
      `\\b(\\d{1,3}(?:\\s*[/|]\\s*\\d{1,3})+)\\s*[-‐‑‒–—−－]?\\s*${PACK_UNIT_SOURCE}\\b`,
      "gi",
    ),
  )) {
    const snippet = match[0].trim();
    for (const part of match[1].split(/[/|]/)) take(part, snippet);
  }
  // 独立写法：6-Pack / 12 Pack / 2 pcs / 4 Count。
  for (const match of text.matchAll(
    new RegExp(`\\b(\\d{1,3})\\s*[-‐‑‒–—−－]?\\s*${PACK_UNIT_SOURCE}\\b`, "gi"),
  ))
    take(match[1], match[0].trim());
  // 后置写法：Pack of 2 / Set of 3。
  for (const match of text.matchAll(
    new RegExp(`\\b${PACK_UNIT_SOURCE}\\s+of\\s+(\\d{1,3})\\b`, "gi"),
  ))
    take(match[1], match[0].trim());
  if (seen.size < 2) return null;
  const snippets = [...new Set(seen.values())];
  const spans = snippets.map(snippet => ({ start: text.indexOf(snippet), end: text.indexOf(snippet) + snippet.length }));
  return {
    counts: order.sort((a, b) => a - b),
    original: text.slice(Math.min(...spans.map(span => span.start)), Math.max(...spans.map(span => span.end))),
  };
}


const semanticRuleIds = [
  "AMZ-03",
  "AMZ-04",
  "AMZ-05",
  "US-01",
  "US-02",
  "US-03",
  "US-04",
  "FACT-01",
  "FACT-02",
];

/*
 * 引擎**真的有检查代码**的规则 id（美国站 15 条全覆盖）。
 * 别的包（德国站）里如果出现这里没有的 id，结果记 not_checked，而不是默认的 pass。
 * 不这么做的后果：新包加一条规则、检查没实现，界面上会是绿色的「通过」——
 * 包越全，假绿越多，这比漏检更糟。
 */
/*
 * 德语里的介词、冠词、连词不算进「同一个词不超过两次」。
 * 这张表只为了让 DE-TITLE-02 少报假阳性；官方原文只说这三类例外，没给词表，
 * 所以这里只收最常见、绝不会有实义的那批，宁可漏豁免也不误豁免实词。
 */
const GERMAN_FUNCTION_WORDS = new Set([
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "eines",
  "und", "oder", "aber", "sowie", "denn", "sondern", "als", "wie", "dass", "wenn",
  "mit", "ohne", "für", "von", "zu", "zum", "zur", "im", "in", "am", "an", "auf", "aus",
  "bei", "nach", "vor", "über", "unter", "zwischen", "durch", "gegen", "um", "je", "pro",
]);

/*
 * 英语里的介词 / 冠词 / 连词。英国站（en-GB）用这张，因为官方豁免的是**词类**，不是德语词 ——
 * 2026-10-31 实测：`Tote bag for work, for school, for travel` 在德语表下会被报成
 * 「for 出现 3 次」，那是把合法写法当违规。只收绝不会是实义的词，宁可漏豁免。
 */
const ENGLISH_FUNCTION_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "nor", "for", "of", "to", "with", "without",
  "in", "on", "at", "by", "from", "into", "onto", "over", "under", "between", "through",
  "about", "as", "than", "per", "via", "up", "down", "off", "out",
]);

/**
 * 法语里的介词 / 冠词 / 连词。法国站（fr-FR）用这张。
 *
 * 官方豁免的是**词类**，不是某张词表，所以这里只收绝不会是实义的词：
 * - 不收 `a`（法语的 avoir 变位，是实义动词：「il a 2 poches」），
 * - 不收 `l` / `d`（单字母省音冠词，分词后噪声大于收益），
 * - 不收 `or` 之外的英语词（`or` 在法语里是连词「然而」，收）。
 * 宁可漏豁免也不误豁免实词：漏豁免最多多报一条，误豁免会放过真的重复。
 */
const FRENCH_FUNCTION_WORDS = new Set([
  "le", "la", "les", "un", "une", "des", "du", "de", "au", "aux",
  "et", "ou", "or", "mais", "donc", "ni", "car",
  "à", "dans", "par", "pour", "sans", "sous", "sur", "vers", "chez", "entre",
  "avec", "contre", "depuis", "pendant", "selon", "via", "en", "y",
]);

/** 按规则包的语言挑豁免词表；包里没写语言时用三张表的并集（豁免多一个词只会少报，不会多报）。 */
function functionWordsFor(pack) {
  const locale = String(pack?.scope?.locale || "").toLowerCase();
  if (locale.startsWith("de")) return GERMAN_FUNCTION_WORDS;
  if (locale.startsWith("fr")) return FRENCH_FUNCTION_WORDS;
  if (locale) return ENGLISH_FUNCTION_WORDS;
  return new Set([...GERMAN_FUNCTION_WORDS, ...ENGLISH_FUNCTION_WORDS, ...FRENCH_FUNCTION_WORDS]);
}

/*
 * FR-LANG-01 用：只属于英语、法语里不会出现的功能词。
 *
 * 刻意排除三个跟法语撞形的：`a`（法语 avoir 的变位）、`en`（法语介词）、`on`（法语代词）。
 * 少收几个词只会漏报，收错一个就会把法语标题判成英语 —— 后者是替商家挑错，代价更大。
 */
const ENGLISH_ONLY_FUNCTION_WORDS = new Set([
  "the", "and", "with", "for", "this", "that", "these", "those", "your", "you", "our",
  "from", "are", "is", "was", "were", "its", "it", "we", "all", "any", "each", "every",
  "some", "more", "most", "very", "just", "also", "but", "not", "no", "than", "then",
  "when", "which", "who", "what", "how", "in", "of", "to", "by", "at", "as",
]);

/*
 * 法国站的语言要求（Loi Toubon 第 2 条）：面向法国消费者的商品信息必须用法语。
 *
 * 本地只判一件判得了的事：**这段文案看起来是不是英语**。
 * 判据刻意保守 —— 三个条件同时成立才报：至少 2 个英语专属功能词、一个法语功能词都没有、
 * 全篇没有法语重音字符。缺一条就不报，宁可漏报也不把「品牌名 + 尺寸」这种短标题挑出来。
 * 判不出来就保持 not_checked：这条规则本来就不在 IMPLEMENTED_RULE_IDS 里。
 */
function languageSignal(text) {
  const words = String(text ?? "").toLowerCase().match(/[\p{L}]+/gu) || [];
  return {
    english: words.filter((word) => ENGLISH_ONLY_FUNCTION_WORDS.has(word)).length,
    french: words.filter((word) => FRENCH_FUNCTION_WORDS.has(word)).length,
    accented: /[àâçéèêëîïôûùüÿœæ]/i.test(String(text ?? "")),
  };
}

export const IMPLEMENTED_RULE_IDS = new Set([
  "AMZ-01",
  "AMZ-02",
  "AMZ-03",
  "AMZ-04",
  "AMZ-05",
  "AMZ-06",
  "US-01",
  "US-02",
  "US-03",
  "US-04",
  "FACT-01",
  "FACT-02",
  "EVID-01",
  "SYS-01",
  "SYS-02",
  "DE-TITLE-02",
  "DE-TITLE-03",
  /*
   * 英国站的两条标题规则（uk-engine 分支）：实现与德国站是**同一段代码**，
   * 按 constraint 找规则（fd560e0），所以这里只登记 id，不复制判断逻辑。
   * 不登记的话，检查跑了也会被上面那条「引擎没有本地检查」的守卫改写成 not_checked ——
   * 也就是「跑了但不说结论」，看起来和没跑一样。
   */
  "UK-TITLE-01",
  "UK-TITLE-02",
  /*
   * 法国站（2026-10-31）：实现与美德英是同一段代码，按 constraint 找规则。
   * 同样只登记 id —— 不登记的话检查跑了也会被下面的守卫改写成 not_checked。
   */
  "FR-TITLE-01",
  "FR-TITLE-02",
]);

/*
 * 只实现了**确定性那一半**的规则：引擎会真的跑，却**不给 pass**。
 *
 * 为什么不直接塞进 `IMPLEMENTED_RULE_IDS`：那张名单的语义是「这条规则本地能判完」。
 * DE-TEXTIL-01 能本地判的只有三条（成分合计 100 % / 降序 / 100 % 又列第二种纤维），
 * 剩下的「纤维名是否用了德语」「是否购买前可见」本地判不了。塞进去的后果是：
 * 一句英文成分（`100% Cotton`）在德国站会拿到一个绿色的 pass —— 正是这张名单本来要防的假绿。
 * 所以它留在这里：跑出来有错就报错，跑干净也只到「未完成，缺人工复核」。
 */
export const PARTIALLY_IMPLEMENTED_RULE_IDS = new Set([
  "DE-TEXTIL-01",
  "DE-ENV-01",
  "DE-CERT-01",
  "DE-GARANTIE-01",
  // DE-VERPACK-01 的确定性那一半只有「文案里写了注册号」这一件（号码真伪核不了），
  // 注册状态与系统参与只能靠商家后台 —— 所以它同样永远不给 pass。
  "DE-VERPACK-01",
]);

export function reviewContent({
  content: raw,
  profile,
  rulePack,
  modelReview = null,
  hasRealModel = false,
  claimMap = [],
  conflicts = [],
  marketplace = "US",
  sourceCatalog = null,
}) {
  const content = contentSchema.parse(raw);
  const allowedSources = new Set([
    ...rulePack.sources.map((x) => x.source_id),
    ...sourceIdsForProfile(profile),
  ]);
  const rules = new Map(rulePack.rules.map((x) => [x.rule_id, x]));
  const issues = [];
  const checks = new Map(
    rulePack.rules.map((r) => [
      r.rule_id,
      {
        rule_id: r.rule_id,
        state: "pass",
        method: "deterministic",
        reason: "",
      },
    ]),
  );
  for (const ruleId of semanticRuleIds) {
    // 只种「这份包里真的有」的规则：semanticRuleIds 是一张按美国站写的固定表，
    // 无条件种下去会让德国站评审凭空多出 US-01..04 四条（2026-10-30 实测）。
    if (!rules.has(ruleId)) continue;
    checks.set(ruleId, {
      rule_id: ruleId,
      state: "not_checked",
      method: "local_heuristic",
      reason: "已执行本地候选检查；完整语义审阅需要真实模型。",
    });
  }
  // 包里存在、但引擎没有本地检查代码的规则：记 not_checked，绝不落成默认的 pass。
  // 顺序放在上面那条之后：语义规则仍按原样显示，只有「本引擎不认识的 id」才走这里。
  for (const rule of rulePack.rules)
    if (!IMPLEMENTED_RULE_IDS.has(rule.rule_id))
      checks.set(rule.rule_id, {
        rule_id: rule.rule_id,
        state: "not_checked",
        method: rule.method || "not_implemented",
        reason: "这条规则在本站规则包里，但引擎还没有对应的本地检查；需要真实模型或人工复核。",
      });

  function add(
    ruleId,
    field,
    original,
    reason,
    suggestion,
    severity,
    method = "local_heuristic",
  ) {
    const rule = rules.get(ruleId);
    if (!rule)
      throw new AppError('RULE_PACK_INCOMPLETE', `当前规则包缺少检查 ${ruleId} 的定义，不能保存为审阅完成。请更新规则包后重试。`, 500);
    const basis =
      rule.field_basis_overrides?.[field]?.source_ids ?? rule.source_ids;
    const fingerprint = createHash("sha256")
      .update(`${ruleId}:${field}:${original}`)
      .digest("hex")
      .slice(0, 14);
    if (issues.some((x) => x.issue_id === fingerprint)) return;
    issues.push({
      issue_id: fingerprint,
      rule_id: ruleId,
      category: rule.category,
      title: rule.title_zh,
      severity: severity || rule.severity_on_failure,
      field_path: field,
      original,
      reason,
      suggestion,
      method,
      source_ids: basis,
      status: "open",
    });
    checks.set(ruleId, {
      rule_id: ruleId,
      state: severity === "needs_review" ? "needs_evidence" : "fail",
      method,
      reason,
    });
  }

  for (const [field, ruleId] of [
    ["title", "AMZ-01"],
    ["item_highlights", "AMZ-02"],
  ]) {
    // 包里有这条规则才检查：德国包和美国包都声明了 AMZ-01/02，但别让缺规则变成崩溃。
    const max = rules.get(ruleId)?.constraint?.max_characters;
    if (typeof max !== "number") continue;
    const len = characterCount(content[field]);
    if (len <= max) continue;
    if (ruleId === "AMZ-01") {
      // 超 75 的后果**分场景**，一律说「阻断」会让拿已有文案来检查的人以为马上要下架：
      //   新建 / 提交更新 → 硬报错拒收；
      //   存量不动 → 不下架，平台按 AI 建议逐步改写（公告帖 `Your listings stay active throughout this process`），
      //   且非品牌卖家没有审阅窗口，改写后可能丢关键词。
      // 两个场景都指向「该改」，所以严重度仍是 blocking（任何一次提交都会被拒），但话得说清是哪种后果。
      //
      // 第 21 轮（方向 C）改掉了一句**假装是原文**的话：这里原本写
      // 「（报错原文 Length cannot be more than 75 characters）」。那句话来自卖家论坛的一条官方回复，
      // 当初只存了 8 位前缀 `t/675168a2`，补不出完整链接（第 20 轮实测），
      // 而规则包登记的来源（公告帖 `AMZS-TITLE-2026`）里**没有这句话**——
      // 2026-10-30 重新抓原文核对：公告只写了 75/125 两个数字、生效日、「存量标题逐步被 AI 改写、
      // listings stay active」。也就是说，纸面上那句带引号的「原文」指向的是一个打不开的帖子。
      // 现在改成明说是转述：**能复核的写原文，不能复核的写「转述」**。
      // 严重度没动（降不降级是待拍板项，不在这一改里）。
      add(
        "AMZ-01",
        `content.${field}`,
        content[field],
        `当前 ${len} 字符，适用上限 ${max}（含空格）。新建或提交更新时平台会直接拒收` +
          `（这一句依据是卖家论坛官方回复的转述，本项目没留存该帖完整链接，无法再次复核）。`,
        `缩到 ${max} 字符以内再提交，放不下的细节移进亮点。已经在售的存量标题不会因此下架，但平台会用 AI 逐步改写它（非品牌卖家没有审阅窗口）——改写后可能丢关键词，所以存量也建议改。`,
        "blocking",
        "deterministic",
      );
      continue;
    }
    // 亮点超限的后果官方没写（这个字段 2026 年才推出），所以这句只说数字，不编后果。
    add(
      ruleId,
      `content.${field}`,
      content[field],
      `当前 ${len} 字符，适用上限为 ${max}（含空格）。`,
      "缩短该字段并重新检查。",
      "blocking",
      "deterministic",
    );
  }

  /*
   * 标题的两条确定性检查：同一个词出现次数上限、禁用字符。
   *
   * **按 constraint 的形状找规则，不按 id 找**：原来写的是 `rules.get("DE-TITLE-02")`，
   * 于是「换一个市场」就得改代码——英国站复用的是同一条平台规则，只是 id 不同（`UK-…`），
   * 写死 id 的结果就是新市场的包摆在那儿、这两条检查一条都不跑，
   * 而检查清单上显示的是「通过」（因为规则在包里、引擎又「认识」这个 id）。
   * 现在：谁在包里声明了 `max_occurrences_per_word` / `prohibited_characters`，就检查谁，
   * 报出来的 issue 也挂它自己的 rule_id。美国包两个 constraint 都没有，这段对它是死代码。
   */
  const repeatRule = rulePack.rules.find((rule) => typeof rule.constraint?.max_occurrences_per_word === "number");
  if (repeatRule && content.title) {
    const maxTimes = repeatRule.constraint.max_occurrences_per_word;
    // 豁免的是**词类**（介词/冠词/连词），所以词表要跟着规则包的语言走：
    // 德语包用德语表，英国包（en-GB）用英语表。以前固定德语表，英国站的
    // `for work, for school, for travel` 会被报成「for 出现 3 次」。
    const functionWords = functionWordsFor(rulePack);
    const counts = new Map();
    for (const word of content.title.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
      if (word.length > 1 && !functionWords.has(word)) counts.set(word, (counts.get(word) || 0) + 1);
    const repeated = [...counts.entries()]
      .filter(([, times]) => times > maxTimes)
      .sort((left, right) => right[1] - left[1]);
    if (repeated.length)
      add(
        repeatRule.rule_id,
        "content.title",
        content.title,
        `标题里${repeated.map(([word, times]) => `「${word}」出现 ${times} 次`).join("、")}，` +
          `平台要求同一个词不超过 ${maxTimes} 次（介词、冠词、连词除外）。`,
        "删掉重复的词，换成同义表达，或把该属性移进亮点；品牌名同样受限，不能靠品牌名规避。",
        "blocking",
        "deterministic",
      );
  }

  const bannedCharRule = rulePack.rules.find((rule) => Array.isArray(rule.constraint?.prohibited_characters));
  if (bannedCharRule && content.title) {
    const banned = new Set(bannedCharRule.constraint.prohibited_characters || []);
    const hit = [...new Set([...content.title].filter((char) => banned.has(char)))];
    if (hit.length)
      add(
        bannedCharRule.rule_id,
        "content.title",
        content.title,
        `标题含平台禁用的特殊字符：${hit.map((char) => `「${char}」`).join("")}。`,
        "删掉这些符号；品牌名里带这些符号的，把品牌名填进 Brand name 字段，不要写进标题。",
        "blocking",
        "deterministic",
      );
  }

  /*
   * FR-LANG-01（法国站）：文案是不是法语。
   *
   * 只查三个纯文本字段（标题 / 亮点 / 描述），不查 bullet —— 那边要拼 stable id，
   * 而这里判的是整段语气，单条 bullet 太短，信号不够。三个条件同时成立才报，见 languageSignal 的注释。
   * 只在包里声明了 `french_mandatory_for` 时才跑；美英德三个包没有这个 constraint，这段对它们是死代码。
   */
  const frenchRule = rulePack.rules.find((rule) => rule.constraint?.french_mandatory_for);
  if (frenchRule)
    for (const key of ["title", "item_highlights", "description"]) {
      const value = content[key];
      if (typeof value !== "string" || value.trim().length < 20) continue;
      const signal = languageSignal(value);
      if (signal.english >= 2 && signal.french === 0 && !signal.accented) {
        add(
          frenchRule.rule_id,
          `content.${key}`,
          value,
          "这段读起来是英语：没有任何法语功能词，也没有法语重音字符，法国站要求面向消费者的商品信息用法语（Loi Toubon 第 2 条）。",
          "整段改写法语；品牌名、型号、SKU、证书号保持原样。判不准的地方宁可留空，别为了凑语言编内容。",
          "blocking",
          "local_heuristic",
        );
        break;
      }
    }

  /*
   * DE-TEXTIL-01 的确定性部分（(EU) 1007/2011 的成分标注）：
   *   1. 同一句里并列写的百分比要合计 100%；
   *   2. 要按占比降序；
   *   3. 写了 100 % 就不能再列第二种带百分比的纤维（两句不能同时成立）；
   *   4. 纤维名要用德语写法（英文写法取代德语 → 报；只作并列补充 → 不报）；
   *   5. 成分要在商品文案里写得出来（资料能确定是纺织品，而文案里一处成分都没有 → 报）。
   *
   * 五条都跑，这一条规则**仍然不给 pass**：第 4 条只认得棉/亚麻这类两地写法不同的纤维，
   * 第 5 条只在"资料写得出成分"时才判 —— 认不出的小众纤维（Wolle、Viskose、sonstige Fasern）
   * 和图文页里的成分标注本地都判不了。给 pass 等于替引擎没查的那部分背书。
   * 只在包里声明了这条规则时才跑；美国包没有它，这段对主站是死代码。
   */
  const textileRule = rules.get("DE-TEXTIL-01");
  let textileScanned = 0;
  if (textileRule)
    for (const field of textileRule.field_paths || []) {
      const key = String(field).replace(/^content\./, "");
      const value = content[key];
      if (typeof value !== "string" || !value.trim()) continue;
      const runs = compositionRuns(value);

      /*
       * 第 4 条：纤维名是不是德语。
       *
       * 只有「英文写法**取代**了德语写法」才报：同一段里已经有对应的德语词，说明英文只是并列补充，
       * (EU) 1007/2011 与规则包的 `other_languages_allowed_only_as_addition` 都允许，报了就是冤枉。
       * `polyester` / `nylon` 两地同词，`germanWordingFor` 返回 null，这里天然不判。
       *
       * 德语写法用 `\b` 匹配：`Baumwolltasche` 这种复合词**不算**写了德语成分 ——
       * 它是商品名（语料里 17 条标题有 12 条这么写），不是成分声明。
       */
      const englishParts = runs
        .flatMap((run) => (run.comparison ? [] : run.parts))
        .filter((part) => {
          if (!part.english_only) return false;
          const german = germanWordingFor(part.fiber);
          return german && !new RegExp(`\\b${german.german}\\b`, "i").test(value);
        });
      if (englishParts.length) {
        const words = [...new Set(englishParts.map((part) => part.text))];
        const targets = [...new Set(englishParts.map((part) => germanWordingFor(part.fiber).label))];
        add(
          "DE-TEXTIL-01",
          `content.${key}`,
          words.join(" / "),
          `成分声明用的是英文纤维名（${words.map((word) => `「${word}」`).join("")}）。德国站按 (EU) 1007/2011 要用德文纤维名称标注（该写 ${targets.map((label) => `「${label}」`).join("")}）；英文写法只能和德文并列作补充，不能取代德文。`,
          `把纤维名改成德文名称（${targets.map((label) => `「${label}」`).join("")}），例如「100 % Baumwolle」；想保留英文，就写成「100 % Baumwolle (100 % cotton)」并列出现的形式。`,
          "needs_review",
          "deterministic",
        );
      }

      for (const run of runs) {
        if (run.comparison) continue;
        textileScanned += 1;
        if (run.parts.length < 2) continue;
        // 理由里引用**原文**写法（`65 % Baumwolle`），不翻成中文纤维名：
        // 商家看到的是自己写的那句，报告里换成「棉」反而要再对一次。
        const shown = run.parts.map((part) => part.text).join(" + ");
        const reasons = [];
        if (Math.abs(run.total - 100) > 1e-9)
          reasons.push(`这句成分写的是「${shown}」，合计 ${run.total} %`);
        if (!run.descending)
          reasons.push(`百分比没有按占比降序（「${shown}」把小的写在前面）`);
        if (run.pure_conflict)
          reasons.push(`同时写了 100 % 和第二种纤维，「${shown}」两句不能同时成立`);
        if (!reasons.length) continue;
        add(
          "DE-TEXTIL-01",
          `content.${key}`,
          run.text,
          `${reasons.join("；")}。德国站按 (EU) 1007/2011 标注纤维成分：一句成分声明内的占比要合计 100 %、按占比从大到小排、单一纤维才写 100 %。`,
          "按降序重写成「65 % Baumwolle, 35 % Polyester」这种形式；合计不足 100 % 的部分要么补全，要么用「sonstige Fasern」带总百分比（≤ 15 %）；纯的成分只留「100 % Baumwolle」一句。",
          "needs_review",
          "deterministic",
        );
      }
    }
  /*
   * 第 5 条：成分是否购买前可见（规则包 constraint.visible_before_purchase_online）。
   *
   * 两个前提同时成立才判，都是为了避免把合规当违规：
   *   1. **商品资料写得出成分**（`material` 里认到了纤维）—— 认不出是不是纺织品就不判，
   *      否则一件塑料收纳盒也会被要求写纤维成分；
   *   2. **文案里连一个百分号都没有、也认不到任何纤维** —— 只要出现过 `50 %` 这种写法，
   *      哪怕纤维名认不出（Wolle、Viskose、sonstige Fasern），也说明商家写了成分，不能在本地判"没写"。
   */
  if (textileRule && !issues.some((issue) => issue.rule_id === "DE-TEXTIL-01")) {
    const record = String(profile?.material || "");
    const allText = flattenContent(content)
      .map((item) => item.text)
      .join("\n");
    /*
     * 第三个前提：**这份文案已经写过了**（描述或五点里有字）。
     * 标题只有一个商品名的空稿，报「成分不可见」等于催人写稿时顺手扣一顶合规帽子 ——
     * 空稿该说的已经在别处（标题缺失、内容为空），这里不抢话。
     */
    const written = Boolean(String(content.description || "").trim()) ||
      content.bullet_points.some((item) => String(item.text || "").trim());
    if (written && parseComposition(record).fibers.length && !parseComposition(allText).fibers.length && !/%/.test(allText))
      add(
        "DE-TEXTIL-01",
        "content.description",
        record,
        `商品资料的材质是「${record}」，但标题、五点与描述里没有任何成分声明（既没有纤维名，也没有百分比）。德国站按 (EU) 1007/2011，买家在网上购买前要能看到纤维成分。`,
        "在五点或描述里补一句德语成分声明，比例照商品资料写（例：100 % Baumwolle）；资料没给比例就只写纤维名，不要替商家编比例。",
        "needs_review",
        "deterministic",
      );
  }
  // 没有命中时也不能落成默认的 pass：这条规则还有本地判不了的一半。
  if (textileRule && !issues.some((issue) => issue.rule_id === "DE-TEXTIL-01"))
    checks.set("DE-TEXTIL-01", {
      rule_id: "DE-TEXTIL-01",
      state: "not_checked",
      method: "deterministic_partial",
      reason: textileScanned
        ? "已跑确定性部分：文中成分声明的百分比合计、降序、100 % 与多纤维矛盾三项都没有问题，纤维名用了德文写法、文案里也写得出成分；但棉/亚麻之外的纤维名、图文页里的成分标注本地判不了，仍需人工复核。"
        : "标题与描述里没有成分声明可判（合计 / 降序 / 纯纺三条都无从下手）；商品资料也没给出可核对的成分，纤维名与可见性仍需人工复核。",
    });

  /*
   * DE-ENV-01 的候选检测：泛化环保词。
   *
   * 词表**从包里读**（`constraint.banned_generic_terms`），代码里不重复一遍法律清单 ——
   * 加一条词是改包，不是改引擎。这条规则的方法是 candidate_detection_and_contextual_review，
   * 所以本地只回答「有没有这类词」，不回答「有没有被具体说明豁免」：命中一律 needs_review，
   * 没命中也不给 pass（见下面的收尾块）。
   *
   * 两处刻意不判（宁可漏报）：
   *   1. **ÖKO-TEX / OEKO-TEX**：那是证书名称，不是泛化环保宣称；证书本身对不上才是 DE-CERT-01 的事。
   *   2. **grün**：德语里 "grüne Tasche" 是颜色。仅凭一个词分不出颜色和环保 —— 替商家判就是编。
   *
   * 词形用 `[\p{L}]*` 一路吃到词尾（nachhaltig → nachhaltigkeit / nachhaltiger、
   * öko → ökologisch），边界用 `(?<![\p{L}\p{N}])`：JS 的 `\b` 把 ö/ü/ä 当非单词字符，
   * `\böko` 永远匹配不到。两头都不设上限，是为了把整个词原样贴进报告 —— 截断的
   * 「ökolog」商家看不懂，也没法在文案里搜。
   */
  const envRule = rulePack.rules.find((rule) => Array.isArray(rule.constraint?.banned_generic_terms));
  if (envRule) {
    const terms = envRule.constraint.banned_generic_terms
      .filter((term) => !/^gr(?:ü|u)n$/i.test(String(term)))
      .map((term) => String(term));
    const patterns = terms.map((term) => ({
      term,
      regex: new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\p{L}]*`, "giu"),
    }));
    for (const { path, text } of flattenContent(content)) {
      if (!text) continue;
      const withoutCertificates = String(text).replace(/öko-?\s?tex|oeko-?\s?tex/giu, " ");
      const found = [];
      for (const { term, regex } of patterns) {
        // 同一段里同一个词可能变格出现多次（nachhaltig / nachhaltige），按小写去重后全列出：
        // 只贴第一个的话，商家按提示去搜「nachhaltig」可能只搜到一半。
        const seen = new Set();
        for (const match of withoutCertificates.matchAll(regex)) {
          const word = match[0];
          const key = word.toLocaleLowerCase("de");
          if (seen.has(key)) continue;
          seen.add(key);
          found.push({ term, sample: word, index: match.index });
        }
      }
      if (!found.length) continue;
      // 按在原文里出现的先后排，报告里读起来和文案顺序一致。
      found.sort((a, b) => a.index - b.index);
      const samples = found.map((item) => item.sample);
      add(
        envRule.rule_id,
        path,
        samples.join(" / "),
        `文案里出现泛化环保词${samples.map((sample) => `「${sample}」`).join("")}。德国站对这类词的口径是：单独使用会被读成对**整体**环境表现的宣称，必须有同一媒介上清晰醒目的具体说明与可核实的依据；补偿型的「klimaneutral」还必须写明所依据的排放量。`,
        "删掉泛化词，或改成资料能证明的具体事实（材料、比例、可回收成分、证书编号）；要保留「klimaneutral」这类说法，就必须同时写出所依据的排放量，并确认它覆盖的是整个产品而不是某一个部件。",
        envRule.severity_on_failure || "needs_review",
        "deterministic",
      );
    }
    // 没命中也不给 pass：有没有"具体说明"、宣称是否覆盖整个产品，本地判不了。
    if (!issues.some((issue) => issue.rule_id === envRule.rule_id))
      checks.set(envRule.rule_id, {
        rule_id: envRule.rule_id,
        state: "not_checked",
        method: "deterministic_partial",
        reason:
          "已跑候选检测：文案里没有出现包内列的泛化环保词（grün 因与颜色同词不判、ÖKO-TEX 属证书名称不判）；但「有没有同媒介的具体说明」「宣称是否覆盖整个产品」「补偿型说法有没有写排放量」仍需人工或模型复核。",
      });
  }

  /*
   * DE-CERT-01 的候选检测：认证标志类宣称（OEKO-TEX / TÜV / GS / CE）。
   *
   * 三个判断全部从包里读，引擎里不写死：
   *   1. 哪些词算认证宣称 → `constraint.claim_must_match_held_certificate`
   *   2. 棉布袋在不在 CE 范围 → `constraint.cotton_tote_bag_in_ce_scope`
   *   3. 失败严重度 → `severity_on_failure`
   *
   * 本地只判两件真判得了的事：
   *   a. 宣称了认证，整篇却找不到任何可核对的证书编号 → 宣称无法核对（不是判违规）；
   *   b. 标了 CE，而包里写明这个品类不在 CE 范围 → 反向风险（误导性标志）。
   * 判不了的：证书是否真的持有、编号对不对得上、检测项是否覆盖本产品 —— 所以照样不给 pass。
   */
  const certRule = rulePack.rules.find((rule) =>
    Array.isArray(rule.constraint?.claim_must_match_held_certificate),
  );
  if (certRule) {
    const certTerms = certRule.constraint.claim_must_match_held_certificate.map((term) => String(term));
    // 同一个标志的德文写法要一起认：包里的 `OEKO-TEX`，文案常写成 `ÖKO-TEX`。
    // 允许连字符/空格互换（`TÜV-geprüft` / `TÜV geprüft`），边界不能用 \b（ö/ü 在 JS 里算非单词字符）。
    const claimRegexes = certTerms.map((term) => {
      const variants = [term];
      if (/oeko/i.test(term)) variants.push(term.replace(/oeko/i, "öko"));
      return {
        term,
        regexes: variants.map((variant) => {
          const body = variant
            .split(/[\s-]+/)
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("[\\s-]*");
          return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
        }),
      };
    });
    /*
     * 「有没有可核对的证书编号」按 token 判，不看上下文窗口 —— 编号写在第五条、
     * 宣称写在第一条也算数（商家只要在文案里给过一次就能核对）。
     * 只认两种形态：连续 ≥5 位数字（`123456`、EAN `4006381333931`），
     * 或带分隔符的字母数字号（`13.HDE.12345`、`SH025-123456`）。
     * 刻意不认的三种，都在测试里钉着：
     *   - 尺寸写法 `22x26cm` / `45x38x10`（否则每条棉布袋都自带一个"证书号"）；
     *   - 数值+单位词 `100Gewicht`（连写导致 token 里既有数字又有字母）；
     *   - 法条号 `1007/2011`（4 位一串、没有字母）。
     */
    const hasCertificateId = (text) =>
      String(text)
        .split(/[^\p{L}\p{N}.\-/]+/u)
        .some((token) => {
          // 包装法注册号（LUCID，`DE` + 13 位数字）也是「连续 ≥5 位数字」，但它不是证书编号。
          // 第一次把它当证书号是在第 8 轮：彩排自证里同一条文案既写了认证标志又写了注册号，
          // 结果「有标志无编号」这条静默通过 —— 一条无关的号码替认证宣称做了担保。
          // 注意句末的句号：split 保留 `.`（证书号本身带分隔符），`…0123.` 这种要去掉尾巴再判。
          if (/^DE\d{8,}$/iu.test(token.replace(/[.\-/]+$/u, ""))) return false;
          if (/\d{5,}/.test(token)) return true;
          const digits = (token.match(/\d/g) || []).length;
          const letters = (token.match(/\p{L}/gu) || []).length;
          return digits >= 3 && letters >= 2 && /[.\-/]/.test(token);
        });
    const allText = flattenContent(content)
      .map((item) => item.text)
      .join("\n");
    const hasId = hasCertificateId(allText);
    const ceOutOfScope = certRule.constraint.cotton_tote_bag_in_ce_scope === false;
    const reported = new Set();
    for (const { path, text } of flattenContent(content)) {
      if (!text) continue;
      for (const { term, regexes } of claimRegexes) {
        if (reported.has(term)) continue;
        let sample = null;
        for (const regex of regexes) {
          sample = String(text).match(regex)?.[0] ?? null;
          if (sample) break;
        }
        if (!sample) continue;
        const isCe = /^ce$/i.test(term.trim());
        if (isCe && ceOutOfScope) {
          reported.add(term);
          add(
            certRule.rule_id,
            path,
            sample,
            `文案里出现了「${sample}」。这个品类不在 CE 标志的适用范围内（CE 只能加在欧盟指令/法规明确要求加标的产品上），标上去属于误导性的合格标志，德国站按 UWG § 5 与 765/2008 Art. 30(2) 处理。`,
            "删掉 CE 字样与 CE 图形。棉布袋不需要 CE；如果文案想说的是别的认证（例如纺织品有害物质检测），改成那个认证的准确名称并给出证书编号。",
            certRule.severity_on_failure || "needs_review",
            "deterministic",
          );
          continue;
        }
        if (isCe) continue; // CE 在适用范围内时，本地没有可判的东西
        if (hasId) continue;
        reported.add(term);
        add(
          certRule.rule_id,
          path,
          sample,
          `文案宣称了「${sample}」，但整篇（标题/亮点/五点/描述）找不到任何可核对的证书编号。认证类宣称要有对应证书才能证明，只写标志名称属于无法核实的「资质/荣誉」类表述，德国站按 UWG § 5(1)(2) 与 § 5(2) Nr. 3 处理。`,
          "补上证书编号与发证机构（例如「OEKO-TEX Standard 100, Zertifikat-Nr. XX-XXXXX, Hohenstein」），或者删掉这条宣称 —— 两者选一个，不要只留标志名。",
          certRule.severity_on_failure || "needs_review",
          "deterministic",
        );
      }
    }
    // 没命中也不给 pass：证书真伪、编号是否对得上、检测项是否覆盖本产品，本地都判不了。
    if (!issues.some((issue) => issue.rule_id === certRule.rule_id))
      checks.set(certRule.rule_id, {
        rule_id: certRule.rule_id,
        state: "not_checked",
        method: "deterministic_partial",
        reason: hasId
          ? "已跑候选检测：文案里的认证标志都带着可核对的编号（≥5 位数字或字母数字证书号），也没有在不适用 CE 的品类上标 CE；但证书是否真的持有、编号与发证机构是否对得上、检测项是否覆盖本产品，仍需人工复核。"
          : "已跑候选检测：文案里没有出现包内列的认证标志（OEKO-TEX / TÜV / GS / CE），所以没有可判的宣称；证书是否实际持有仍需人工复核。",
      });
  }

  /*
   * DE-GARANTIE-01 的候选检测：Garantie（自愿质保）宣称缺法定五项。
   *
   * 只认名词 `Garantie`（含 Garantien / Garantieerklärung / Garantiebedingungen），
   * 不认动词 `garantiert` —— "garantiert Langlebigkeit" 是耐用性宣称，不是质保承诺，
   * 混进来就是替别的规则抢活。`\b` 在这里够用，但为了和上面几段一致仍用
   * (?<![\p{L}\p{N}])：德语词尾变化多，边界靠字符类别比靠 \b 稳。
   *
   * 包里给的 required_content 是五项，本地只判其中四项能判的：
   *   法定权利提示 / 保证人名称与地址 / 行使方式 / 期限与地域。
   * 剩下「指明商品」本地不判：文案本来就在讲这个商品，认不出"有没有点名"。
   * 判不干净也不给 pass：真兑付、地域是否覆盖买家所在地，都得人看。
   */
  const garantieRule = rulePack.rules.find(
    (rule) => Array.isArray(rule.constraint?.required_content) && rule.constraint?.must_be_simple_and_understandable,
  );
  if (garantieRule) {
    // 德语把限定词并进复合词：Haltbarkeitsgarantie / Zufriedenheitsgarantie / Geld-zurück-Garantie。
    // 前缀一起吃掉，报出来的 `original` 才是商家真正写下的那个词，而不是半截 "Garantie"。
    const claimRegex = /(?<![\p{L}\p{N}])[\p{L}-]*Garantie(?:n|erklärung|bedingungen|frist|zeit|geber)?(?![\p{L}\p{N}])/iu;
    const hasRightsNotice = /gesetzliche[rn]?\s+(?:Mängel|Gewährleistungs|Sachmängel)rechte|gesetzlichen Rechte|Ihre Rechte als Verbraucher/iu;
    // 保证人：法人后缀 + 门牌号/邮编。两个都要，只有「Beispiel GmbH」不算有地址。
    const hasGuarantor = /\b(?:GmbH|AG|e\.K\.|KG|OHG|UG|Ltd\.?|S\.A\.|B\.V\.)\b/u;
    const hasPostal = /\b\d{5}\s+\p{Lu}[\p{L}-]+|[\p{L}-]+(?:straße|str\.|weg|allee|platz)\s+\d+/iu;
    const hasClaimProcedure = /E-Mail|@|Kontakt|Service|Reklamation|wenden Sie sich|Anspruch|Ersatz/iu;
    const hasDuration = /\b\d+\s*(?:Jahr|Jahre|Jahren|Monat|Monate|Monaten|Tag|Tage|Tagen)\b|lebenslang/iu;
    const hasTerritory = /\bDeutschland\b|\bEU\b|\bEuropäische Union\b|\bweltweit\b|\bÖsterreich\b|\bSchweiz\b/u;
    for (const { path, text } of flattenContent(content)) {
      if (!text) continue;
      const claim = String(text).match(claimRegex)?.[0];
      if (!claim) continue;
      const missing = [];
      if (!hasRightsNotice.test(text)) missing.push("没有提示法定瑕疵权利不受影响（§ 479 Abs. 1 Nr. 4 BGB 要求写明，且须说明行使免费）");
      if (!(hasGuarantor.test(text) && hasPostal.test(text))) missing.push("没有保证人的名称与地址");
      if (!hasClaimProcedure.test(text)) missing.push("没有写清怎么行使（联系方式或流程）");
      if (!hasDuration.test(text)) missing.push("没有写保证期限");
      else if (!hasTerritory.test(text)) missing.push("写了期限但没写地域范围");
      if (!missing.length) continue;
      add(
        garantieRule.rule_id,
        path,
        claim,
        `文案里出现了质保宣称「${claim}」，但同一段里缺法定内容：${missing.join("；")}。德国站的质保声明是自愿承诺，一旦写出来就必须把 § 479 BGB 要求的五项写全，缺项属于不完整的消费者信息。`,
        "把这段改成一个完整区块：「3 Jahre Haltbarkeitsgarantie der <保证人> GmbH, <街道 门牌>, <邮编 城市>. Ihre gesetzlichen Mängelrechte bleiben unberührt und sind für Sie kostenlos. Geltendmachung: E-Mail an <邮箱>. Geltungsbereich: Deutschland.」——或者删掉质保宣称，只留法定权利。",
        garantieRule.severity_on_failure || "needs_review",
        "deterministic",
      );
    }
    if (!issues.some((issue) => issue.rule_id === garantieRule.rule_id))
      checks.set(garantieRule.rule_id, {
        rule_id: garantieRule.rule_id,
        state: "not_checked",
        method: "deterministic_partial",
        reason:
          "已跑候选检测：文案里没有出现 Garantie 类质保宣称（动词 garantiert 不算），所以没有可判的声明；如果实际在包装或详情页里给了质保卡，本地看不到，仍需人工确认。",
      });
  }

  /*
   * DE-GPSR-19：本地**不给结论**，只把四要素逐项摊开，说清哪一项缺什么数据。
   *
   * 为什么不做检测：文案里没有四要素不等于违规 —— Amazon 的「Herstellerinformationen」
   * 栏位也是报价页面的一部分，但那是另一个渲染位置，本工具抓不到。硬判就会把合规的
   * 卖家判成不合规。
   *
   * 第 9 轮的变化：商品档案里现在**有**制造商 / 欧盟责任人的专门字段了（各六项，见
   * gpsr-parties.mjs），所以「缺哪一项」能按字段逐项说，而不是只丢一句「判不了」。
   * 但仍然只到 not_checked：字段填了 ≠ 报价页面上展示了，后半段本地看不见。
   */
  const gpsrRule = rulePack.rules.find(
    (rule) => Array.isArray(rule.constraint?.required_elements) && rule.constraint?.must_be_on_the_offer_itself,
  );
  if (gpsrRule) {
    const elementLabels = {
      manufacturer_name_and_postal_and_electronic_address: "制造商名称 + 邮政地址 + 电子地址",
      eu_responsible_person_when_manufacturer_outside_eu: "制造商在欧盟外时的欧盟责任人（同三项）",
      product_identification_type_or_batch_or_ean_and_picture: "型号 / 批次 / EAN 与图片",
      warnings_in_german_when_the_product_needs_them: "需要警告时的德语警告原文（棉布袋通常不需要，记不适用即可）",
    };
    const allText = flattenContent(content)
      .map((item) => item.text || "")
      .join("\n");
    const hasEmail = /[\w.+-]+@[\w-]+\.[\p{L}]{2,}/u.test(allText);
    const hasManufacturerWord = /Hersteller|Manufacturer|EU-Verantwortlicher|Verantwortliche[rn]? Person|Bevollmächtigt/i.test(allText);
    const hasProductId = /\bEAN\b|Modell(?:nummer)?|Art\.-?Nr|Charge|Batch/i.test(allText);
    const elements = gpsrRule.constraint.required_elements.map(
      (element) => elementLabels[element] || String(element),
    );
    const seen = [hasManufacturerWord && "Hersteller 字样", hasEmail && "电子地址", hasProductId && "型号/EAN"].filter(Boolean);
    /*
     * 第 8 轮：档案里到底有没有可用的制造商信息。
     *
     * 第 6 轮写的「档案里根本没有字段」只对了一半：**专门字段**确实没有，但商品档案还有一种
     * 通用通道 —— `additional_facts`（界面上叫「补充事实」，会原样进生成上下文，见 providers 的
     * 「Only structured product facts and additional_facts authorize listing statements」）。
     * 第 9 轮补上了专门字段，两种通道都算数，所以这段要说清「哪一种填了、另一种有没有」。
     */
    const merchantLabel =
      /Hersteller|Manufacturer|EU-Verantwortlich|Verantwortliche[rn]?\s*Person|Bevollmächtigt|制造商|欧盟责任人|欧盟授权代表/iu;
    const merchantFacts = (profile?.additional_facts || [])
      .map((fact) => ({ label: String(fact.label || ""), value: String(fact.value ?? "") }))
      .filter((fact) => merchantLabel.test(fact.label) || merchantLabel.test(fact.value));
    const manufacturer = profile?.manufacturer?.value || null;
    const euResponsible = profile?.eu_responsible?.value || null;
    const manufacturerCountry = manufacturer?.country || "";
    const manufacturerInEu = isEuCountry(manufacturerCountry);
    /*
     * 逐项状态。顺序照包里 required_elements 的顺序（①制造商 ②欧盟责任人 ③型号/EAN ④警告），
     * 每一项都只说本地知道的那部分：档案填了没有、缺哪个子字段、这一项要不要填。
     */
    const elementStatus = (element, index) => {
      const label = elementLabels[element] || String(element);
      if (element === "manufacturer_name_and_postal_and_electronic_address")
        return `${label}：${manufacturer ? summarizeParty(manufacturer) : "档案里没填"}`;
      if (element === "eu_responsible_person_when_manufacturer_outside_eu") {
        if (!manufacturer)
          return `${label}：先填制造商的国家，才判得出这一项要不要（现在判不了）`;
        if (manufacturerInEu === true)
          return `${label}：不适用 —— 制造商在欧盟内（${manufacturerCountry}），这一项不用填`;
        if (manufacturerInEu === false)
          return `${label}：${euResponsible ? summarizeParty(euResponsible) : `没填 —— 制造商国家是「${manufacturerCountry}」，不在欧盟，这一项必须有`}`;
        return `${label}：${euResponsible ? summarizeParty(euResponsible) : `没填 —— 制造商国家「${manufacturerCountry}」认不出在不在欧盟，先填上更稳`}`;
      }
      if (element === "product_identification_type_or_batch_or_ean_and_picture")
        return `${label}：商品档案没有这个字段（型号/EAN 走「补充事实」）；${hasProductId ? "文案里认得出型号或 EAN 字样" : "文案里也没认出型号或 EAN 字样"}，图片本地看不到`;
      if (element === "warnings_in_german_when_the_product_needs_them")
        return `${label}：棉布袋通常不需要，记不适用；真要警告才需德语原文，本地判不了该不该有`;
      return `${label}：本地判不了`;
    };
    const lines = gpsrRule.constraint.required_elements.map(
      (element, index) => `${["①", "②", "③", "④"][index] || `${index + 1})`} ${elementStatus(element, index)}`,
    );
    checks.set(gpsrRule.rule_id, {
      rule_id: gpsrRule.rule_id,
      state: "not_checked",
      method: "checklist_only",
      reason:
        `这条本地判不了，只列清单。德国站要求报价页面上直接可见四要素（${elements.length} 项），逐项对着商品档案看：` +
        `${lines.join("；")}。` +
        `数据通道：` +
        (merchantFacts.length
          ? `「补充事实」里有 ${merchantFacts.length} 条相关记录（${merchantFacts
              .map((fact) => fact.label)
              .join("、")}）；档案里有不等于报价页面上有，页面是否真的展示、四要素是否齐全，本地判不了`
          : manufacturer || euResponsible
            ? `制造商 / 欧盟责任人的专门字段已经填了，「补充事实」里也没有这类记录（不影响上面的逐项结论）`
            : profile
              ? `商品档案的制造商 / 欧盟责任人专门字段都空着，「补充事实」里也没有这类记录（本地按 label 与 value 搜过），生成侧写不出来`
              : `商品档案里没有制造商与欧盟责任人字段，「补充事实」里也没有这类记录（本地按 label 与 value 搜过），生成侧写不出来`) +
        `，所以不能根据「文案里没写」判定违规。` +
        (seen.length
          ? `文案里能认出的相关线索：${seen.join("、")}（认得出不等于合规，还要核对是否完整、是否对得上档案）。`
          : "文案里没有认出任何一种相关线索（Hersteller 字样 / 电子地址 / 型号或 EAN）。") +
        `补法：商品资料页现在有「制造商 / 欧盟责任人」两块专门字段（各六项：名称、街道门牌、邮编、城市、国家、电子地址），` +
        `填完这两块，生成侧就能按档案写「Hersteller: …｜EU-Verantwortlicher: …」；型号/EAN 走「补充事实」，label 用 Modell und EAN。` +
        `老填法也还能用：「补充事实」里加三条，label 分别用 Hersteller / EU-Verantwortlicher / Modell und EAN，` +
        `值写「名称, 街道 门牌, 邮编 城市, 邮箱」；描述末尾再补一块「Hersteller: …｜EU-Verantwortlicher: …｜Modell/EAN: …」。` +
        "如果信息填在 Amazon 后台的「Herstellerinformationen」栏位，也算报价页面的一部分 —— 本工具读不到那个栏位，需人工确认。" +
        // 这两条要求在同一份文案里是打架的：GPSR 要电子地址，Amazon 的详情页公告又禁止文案里出现
        // 邮箱/电话/链接（本工具 AMZ-03 按阻断处理）。不写清这一点，商家照我们的补法改完会立刻
        // 撞上一条 blocking —— 那是工具自己挖的坑。
        `另外注意：电子地址在 Amazon 文案里属于禁止项（AMZ-03 会按阻断处理），邮箱只填后台栏位，` +
        `档案字段里也只作记录、不要写进文案；文案里写制造商名称与邮政地址即可；四要素到底在哪一屏凑齐，仍需人工确认。`,
    });
  }

  /*
   * DE-VERPACK-01：包装法注册 + 包装环保宣称。这条规则的两半，本地能做的完全不一样。
   *
   * a. 注册号本身**不是商品文案的一部分**，它是上架前置条件（包里 § 6(1)：首次在德国
   *    提供包装前须在 Zentrale Stelle Verpackungsregister 注册；§ 13(1)：未注册不得提供包装）。
   *    本工具读不到商家后台的注册状态，档案里也没有这个字段 —— 判不了，只列清单。
   * b. 但文案里**写了**注册号是另一回事，这一件本地判：本工具无法核对号码真伪，写进文案
   *    也不构成合规证明，而模型被要求「体现合规」时最容易编一个号码出来（包里 note 明写
   *    「注册号本身不写在商品文案里…不能让模型把它编进文案」）。
   *
   * 包装环保宣称那半**不重复判**：泛化环保词已经由 DE-ENV-01 报，同一句话报两次会让商家
   * 以为是两件事要改两处。这里只把「文案提到包装时有没有材料/比例写法」当线索列进清单。
   */
  const verpackRule = rulePack.rules.find(
    (rule) =>
      rule.constraint?.registration_required_before_placing_on_market &&
      rule.constraint?.packaging_environmental_claim,
  );
  if (verpackRule) {
    const packWords =
      /Verpackung|verpackt|Versand(?:tasche|beutel|karton|material)|Umverpackung|Faltschachtel|Polybeutel|Kartonage/iu;
    // 号码形态只用来「认出来」，不用来判真伪：LUCID 号以 DE 开头，但具体位数本项目没核到
    // 官方规格，所以只要求「DE + 8 位以上连续数字」，宁可漏认也不替法规规定格式。
    const registrationClaim =
      /LUCID|Verpackungsregister|Registrierungsnummer|Registrierungs-Nr\.?|Verpackungsregister-Nr\.?|(?<![\p{L}\p{N}])DE\s?\d{8,}(?![\p{L}\p{N}])/iu;
    // 「材料 + 比例」只认两种写法：`80 % Rezyklat` 这类百分比，或 `aus (recyceltem) Altpapier` 这类来源。
    const concretePackaging =
      /\d{1,3}\s?%\s*[\p{L}]+|aus\s+(?:\d{1,3}\s?%\s*)?(?:recyceltem?|Altpapier|Wellpappe|Karton|Papier|Rezyklat|Kunststoff|Polyethylen|PE|PP)(?![\p{L}])/iu;
    let reportedRegistration = false;
    const clues = [];
    for (const { path, text } of flattenContent(content)) {
      if (!text) continue;
      if (!reportedRegistration) {
        const reg = String(text).match(registrationClaim)?.[0];
        if (reg) {
          reportedRegistration = true;
          add(
            verpackRule.rule_id,
            path,
            reg,
            `文案里出现了包装注册相关的写法「${reg}」。注册号不是商品文案的一部分：它是上架前置条件（首次在德国提供包装前须在 Zentrale Stelle Verpackungsregister 注册，未注册不得提供包装），本工具既读不到商家后台的注册状态，也无法核对号码真伪 —— 写进文案既不构成合规证明，还把一个未经核实的号码公开给了买家。`,
            "把注册号从文案里删掉，只在商家档案与 LUCID 后台保留；文案里要说包装，就写材料与比例（例如「Versand in einer Faltschachtel aus 100 % Altpapier」）。",
            verpackRule.severity_on_failure || "needs_review",
            "deterministic",
          );
        }
      }
      const packWord = String(text).match(packWords)?.[0];
      if (packWord) clues.push({ path, packWord, concrete: concretePackaging.test(text) });
    }
    // 有 issue 时 `add()` 已经写过这条的状态与理由，别再拿清单覆盖掉。
    if (!reportedRegistration) {
      const clueText = clues.length
        ? `文案里提到包装的有 ${clues.length} 处：${clues
            .map(
              (clue) =>
                `${clue.path} 的「${clue.packWord}」${clue.concrete ? "（同段有材料或比例写法）" : "（同段没找到材料或比例）"}`,
            )
            .join("；")}。本地只认得「有没有」，认不出那个比例写的是包装还是产品本身。`
        : "文案里没有提到包装，所以「包装宣称要写材料与比例」这一半没有可判对象。";
      checks.set(verpackRule.rule_id, {
        rule_id: verpackRule.rule_id,
        state: "not_checked",
        method: "checklist_only",
        reason:
          "这条本地判不了，只列清单。① 注册：首次在德国提供包装前须在 Zentrale Stelle Verpackungsregister 注册，" +
          "未注册不得提供包装（包内条文 VerpackDG § 6(1) / § 13(1)）；注册号**本来就不写在商品文案里**，" +
          "本工具读不到商家后台的注册状态、档案里也没有这个字段，所以不能根据「文案里没有注册号」判定违规。" +
          "② 系统参与（dual system）同样只看商家后台，本地读不到。" +
          "③ 包装宣称：提到包装时写具体材料与比例，不要只用泛化环保词（泛化词本身由 DE-ENV-01 报，这条只问「有没有给材料与比例」）。" +
          clueText +
          "补法：在商家档案/后台补齐 LUCID 注册号与系统参与记录，文案里的包装说明改成「材料 + 比例」。",
      });
    }
  }

  // 多规格标题只是"表达建议"，不阻断发布；它和 FACT-02/AMZ-05 的件数冲突是两件事：
  // 后者是"写错了件数"，这里只是"写了太多个件数"。
  const multiPack = detectMultiPackTitle(content.title);
  if (multiPack && rules.has("AMZ-06"))
    add(
      "AMZ-06",
      "content.title",
      multiPack.original,
      `标题同时出现 ${multiPack.counts.length} 个包装规格（${multiPack.counts.join(" / ")}），买家无法判断实际件数，件数解析也会取错值。`,
      "标题只保留本变体的件数，其余规格放到变体或可选规格里。",
      "suggestion",
      "deterministic",
    );


  for (const { path, text } of flattenContent(content)) {
    // 匹配跑在归一化串上（连字符 / 零宽字符变体），证据仍取原文那一串字符。
    const view = matchView(text);
    const scan = view.text;
    const origin = (match) => (match ? view.original(match.index, match[0].length) : "");
    const contact = scan.match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:https?:\/\/|www\.)[^\s]+|\+\d[\d ()-]{7,}\d|(?:call|phone|tel)\s*:?\s*\d[\d ()-]{7,}\d/i,
    );
    if (contact)
      add(
        "AMZ-03",
        path,
        origin(contact),
        "面向买家的商品文案包含联系信息或站外链接。",
        "移除该联系信息，内部来源链接可保留。",
        "blocking",
      );
    const offer = scan.match(
      /[$€£]\s*\d+(?:\.\d+)?|\b(?:USD|EUR|GBP)\s*\d+(?:\.\d+)?|\b(?:in stock|out of stock|limited stock|brand new condition)\b/i,
    );
    if (offer)
      add(
        "AMZ-04",
        path,
        origin(offer),
        "商品内容字段混入价格、库存或其他交易信息。",
        "从文案移除；专门的售价和库存字段单独处理。",
        "blocking",
      );
    // 促销语单独一条：它和价格不是一回事（`best seller` 里没有数字），处置也换了个说法。
    // 以前这一类**只有生成侧禁**（providers.mjs 的 prompt 里写了 discounts / limited time），
    // 审核侧一个字不查 → 模型没照做、或商家自己手改，文案带着促销语进报告，而报告说"没问题"。
    // 依据是 Detail Page 公告（`AMZS-DETAIL-PROMO`）：promotional language 与价格同属禁止项，
    // 且这类是**平台直接抑制**的理由，不用走执法程序 —— 比 FTC 那几条更贴日常。
    const promo = scan.match(PROMO_LANGUAGE_PATTERN);
    if (promo)
      add(
        "AMZ-04",
        path,
        origin(promo),
        "商品内容字段出现促销语。平台在详情页公告里明确禁止这类措辞（与价格、库存同一条），后果是搜索抑制。",
        "删掉促销语；折扣、包邮、活动价放到后台促销工具里，不写进文案。",
        "blocking",
      );
    const eco = positiveMatch(scan, ECO_CLAIM_PATTERN);
    // US-01…US-04 是**美国站自己**的召回，德国包里没有这几条（德国站用 DE-ENV-01 那一套，标准更严）。
    // 所以每处都先问一句「这个包里有没有这条规则」——`add()` 里是 `rules.get(ruleId)`，
    // 拿着德国包硬调会直接 TypeError（2026-10-30 抓德国语料时踩到：一条带 "abbaubar" 的德语文案把整批跑挂）。
    // 不在这里做「包缺失就静默丢」的兜底：那会把「美国规则跑到德国包上」这种错藏起来。
    if (eco && rules.has("US-01")) {
      // 环保宣称不是一种东西，官方对每一类的处理办法不一样（`FTCS-GREEN-SUMMARY`）：
      //   recyclable → 加限定语就能用（覆盖不到 60% 消费者时）；
      //   recycled   → 要说明再生成分比例；
      //   free-of    → 三条件（确实不含、不暗示其他收益、必要处说明）；
      //   carbon     → 要披露抵消范围与核算口径；
      //   zero/100%  → 绝对化，几乎无法证明；
      //   eco-friendly / sustainable / green → 官方点名"不要泛用"。
      // 以前 8 种词一律给「移除宽泛宣称」：对 broad 是对的（20 条真实文案里 11/13 属这一档），
      // 对 recyclable / recycled 是**让商家白丢卖点**（2/13）。
      const advisory = ecoClaimAdvisory(eco[0]);
      add("US-01", path, origin(eco), advisory.reason, advisory.suggestion, "needs_review");
    }
    // 降解与可堆肥：`bio|photo|hydro|oxo` 前缀 + `compost` 都归这一条。
    // 以前写的是 `\bdegrad(?:able|es?)\b`，而 `photodegradable` 里 degradable 前面是字母 `o`，
    // **词边界不存在**，于是官方 260.8 的第二种写法静默漏掉（`\b` 这个坑本次是第三回复发）。
    const degradation = positiveMatch(
      scan,
      /\b(?:(?:bio|photo|hydro|oxo)?degrad(?:able|es?|ability)|compost(?:able|ability))\b/i,
    );
    if (degradation && rules.has("US-02"))
      // 证据只给命中的那个词，不给整句：写进报告时"哪一句有问题"要能点到，整段原文等于没定位。
      add(
        "US-02",
        path,
        origin(degradation),
        "该降解或可堆肥宣称需要与商品、时间和处置条件匹配的证据。系统尚不能确认其充分性。",
        "补充适用测试与条件供人工审阅，或移除该宣称。",
        "needs_review",
      );
    const performance = positiveMatch(scan, PERFORMANCE_CLAIM_PATTERN);
    if (performance && rules.has("US-03")) {
      const reason = profile
        ? "检测到认证或性能宣称；现有商品参数不能替代相应证明。需核对适用范围和证据充分性。"
        : "没有关联商品与证据，无法确认这项宣称。";
      add(
        "US-03",
        path,
        origin(performance),
        reason,
        "补充对应商品的有效证据并人工复核，或删除该宣称。",
        "needs_review",
      );
    }
    // 医疗、健康与抗菌（`US-04`）。放在 US-03 之后判：一条句子同时说"防水"和"抗菌"时，
    // 两条都该报——它们是不同的实证要求，合并成一条会让人以为改一处就够。
    const medical = positiveMatch(scan, MEDICAL_CLAIM_PATTERN);
    if (medical && rules.has("US-04")) {
      // 四类宣称的下一步不是同一件事（见 `MEDICAL_ADVISORIES`）：
      // 「抗菌」补报告能留，「缓解酸痛」补报告也留不住，「FDA 注册」压根不是证据问题。
      const advisory = medicalClaimAdvisory(medical[0]);
      add(
        "US-04",
        path,
        origin(medical),
        advisory.reason,
        advisory.suggestion,
        "needs_review",
      );
    }
    if (profile) {
      const wrongGsm =
        /(?:fabric weight\s*:?\s*)(\d+)\s*g(?!\s*\/|sm|\/m)/i.exec(scan);
      if (wrongGsm)
        add(
          "FACT-01",
          path,
          origin(wrongGsm),
          "面料克重应区分 g/m² 与单件重量 g。",
          "按来源填写单位。",
          "blocking",
        );
      const pack =
        /\b(?:pack of|pack contains|pack contents:\s*)\s*(\d+)\s*(?:tote\s*)?bags?\b/i.exec(
          scan,
        );
      if (
        pack &&
        supportedValue(profile, "retail_pack_count") !== null &&
        Number(pack[1]) !== supportedValue(profile, "retail_pack_count")
      ) {
        add(
          "FACT-02",
          path,
          origin(pack),
          `零售包装已确认为 ${supportedValue(profile, "retail_pack_count")} 件；供应商装箱数不能替代零售包装。`,
          `改为每包 ${supportedValue(profile, "retail_pack_count")} 件。`,
          "blocking",
          "deterministic",
        );
        add(
          "AMZ-05",
          path,
          origin(pack),
          "描述中的包装件数与商品档案冲突。",
          "按确认过的零售包装修正。",
          "blocking",
          "deterministic",
        );
      }

    }
  }

  let invalidSources = false;
  const fields = new Map(flattenContent(content).map((x) => [x.path, x.text]));
  if (modelReview) {
    for (const issue of modelReview.issues || []) {
      if (
        !rules.has(issue.rule_id) ||
        !fields.has(issue.field_path) ||
        !issue.original ||
        !fields.get(issue.field_path).includes(issue.original)
      ) {
        invalidSources = true;
        continue;
      }
      if (
        !Array.isArray(issue.source_ids) ||
        !issue.source_ids.length ||
        issue.source_ids.some((x) => !allowedSources.has(x))
      ) {
        invalidSources = true;
        continue;
      }
      add(
        issue.rule_id,
        issue.field_path,
        issue.original,
        issue.reason,
        issue.suggestion,
        ["blocking", "needs_review", "suggestion"].includes(issue.severity)
          ? issue.severity
          : "needs_review",
        "model_assisted",
      );
    }
    if (hasRealModel)
      for (const result of modelReview.checks || []) {
        if (
          // 规则必须真的在这份包里：只看 semanticRuleIds 会让模型自己编的美国规则
          // 混进德国站评审（2026-10-30 实测：德国包 19 条，评审里出现 US-01..04 四条）。
          // 美国包里 US-01..04 本来就有，所以这条对旧行为零影响。
          !rules.has(result.rule_id) ||
          !semanticRuleIds.includes(result.rule_id) ||
          issues.some((x) => x.rule_id === result.rule_id)
        )
          continue;
        if (
          result.state === "pass" &&
          (profile ||
            !["AMZ-05", "FACT-01", "FACT-02"].includes(result.rule_id))
        )
          checks.set(result.rule_id, { ...result, method: "model_assisted" });
      }
  }
  const productFactSources = new Set(sourceIdsForProfile(profile));
  for (const claim of claimMap || []) {
    if (
      !fields.has(claim.field_path) ||
      !claim.claim ||
      !fields.get(claim.field_path).includes(claim.claim) ||
      !Array.isArray(claim.source_ids) ||
      !claim.source_ids.length ||
      claim.source_ids.some((x) => !allowedSources.has(x) || !productFactSources.has(x))
    )
      invalidSources = true;
  }
  const evidence = inspectEvidence(content, profile, claimMap, sourceCatalog);
  const unmodeledParameters = [...new Map(evidence.flatMap(entry => (entry.not_covered_parameters || []).map(item => [
    [entry.field_path, item.field, item.original].join('|'),
    { field_path: entry.field_path, field: item.field, field_label: item.field_label || item.field,
      original: item.original, unit: item.parsed_value?.unit ?? null, reason: item.reason }
  ]))).values()];
  const parameterCoverage = evidence.reduce((total, entry) => {
    total.matched += entry.parameter_links.length;
    total.unresolved += entry.unresolved_parameters.length;
    total.not_covered += (entry.not_covered_parameters || []).length;
    return total;
  }, { recognized: 0, matched: 0, unresolved: 0, not_covered: 0, whole_sentence_proven: false });
  parameterCoverage.recognized = parameterCoverage.matched + parameterCoverage.unresolved + parameterCoverage.not_covered;
  checks.set('EVID-01', { rule_id: 'EVID-01',
    state: !profile || parameterCoverage.not_covered ? 'not_checked' : 'pass',
    method: 'deterministic_structured_facts',
    reason: !profile ? '没有关联商品，无法对照商品参数。' : parameterCoverage.not_covered
      ? '有 ' + parameterCoverage.not_covered + ' 处参数不在当前核对范围，未判定对错；已关联的参数不证明整句、认证或性能成立。'
      : '仅对照可识别的商品参数与记录来源；同单位、未标约数的数值一律精确比对，只有原文自标约数且换算了单位时才按原文标注的最后一位精度比对；整句语义、适用条件及宣称另行审阅。' });
  if (profile) {
    for (const entry of evidence) {
      for (const parameter of entry.unresolved_parameters) {
        if (parameter.status === 'conflict' && parameter.expected_value !== null)
          add('AMZ-05', entry.field_path, parameter.original, parameter.reason,
            '按已确认商品资料修正，或先更新该参数及其来源再复检。', 'blocking', 'deterministic_structured_facts');
        if (parameter.field === 'rated_load_kg' && parameter.expected_value === null)
          add('FACT-01', entry.field_path, parameter.original,
            '额定承重尚未确认；容量、面料克重和单件重量都不能证明承重。',
            '补充适用商品的额定承重来源，或删除无法证实的数值。', 'blocking', 'deterministic_structured_facts');
      }
    }
    // 兜底那条「这句里还有我们没核对清的东西」：**同一字段、同一句话，别的规则已经报过就不再报一遍**。
    // 为什么：拿 20 条真实在售文案量过——97 条 EVID-01 里有 79 条（81%）所在的字段上，
    // 另一条规则已经就同一句话给出了更重的结论（最多的是 AMZ-05 数值冲突）。
    // 同一句话在问题列表里出现两次、名字不同，读的人只会以为有两处问题；
    // 演示时评委贴一条真实 ASIN，看到的就是同一句被念两遍。
    // 边界：只在「同字段 + 原文互相包含」时算重复。不同的句子照旧各报一条，
    // 一条信息都没少——参数对照表里每一处的结论仍然逐条列着，变的只是问题列表不再刷屏。
    let suppressed = 0;
    for (const entry of evidence) {
      if (entry.state !== 'needs_evidence') continue;
      const covered =
        issues.some((x) =>
          x.rule_id !== 'EVID-01' && x.field_path === entry.field_path &&
          (x.original === entry.claim || entry.claim.includes(x.original) || x.original.includes(entry.claim)));
      if (covered) {
        suppressed += 1;
        continue;
      }
      add('EVID-01', entry.field_path, entry.claim, entry.reason,
        '核对商品原文与适用条件；补充依据或删除无法证实的表述。', 'needs_review', 'deterministic');
    }
    // 检查状态按「有没有待核对的句子」定，**不能按「有没有单独报出来」定**：
    // 被别的规则盖掉的那几句，EVID-01 本身仍然没有核对过，写 pass 就是假绿（这条有守卫用例）。
    if (suppressed)
      checks.set('EVID-01', {
        rule_id: 'EVID-01',
        state: 'needs_evidence',
        method: 'deterministic',
        reason: `共 ${suppressed + issues.filter((x) => x.rule_id === 'EVID-01').length} 句含待核对的参数或宣称；其中 ${suppressed} 句已由同一字段上的其它规则报出，不在这里重复列。`,
      });
  }
  if (invalidSources)
    add(
      "SYS-01",
      "content.title",
      content.title,
      "模型返回了无法映射到本次输入的引用或字段，相关结论未采用。",
      "重新生成或核对引用。",
      "blocking",
      "deterministic",
    );
  for (const conflict of conflicts)
    add(
      "AMZ-05",
      "content.title",
      content.title,
      conflict,
      "请在商品资料中确认真实变化，或使用有依据的表达。",
      "blocking",
      "deterministic",
    );
  if (!profile)
    for (const ruleId of ["AMZ-05", "FACT-01", "FACT-02"])
      if (!issues.some((x) => x.rule_id === ruleId))
        checks.set(ruleId, {
          rule_id: ruleId,
          state: "not_checked",
          method: "deterministic",
          reason: "没有关联商品，无法完成事实对照。",
        });
  // 规则包覆盖的市场和这次请求的市场对不上时，不许拿一份包的结论冒充另一站的结论。
  // 判断依据改成读包里的 scope.marketplace，不再写死 "US"——写死的话德国包会被自己的守卫拦下。
  const packMarketplace = rulePack.scope?.marketplace || "US";
  if (marketplace !== packMarketplace) {
    add(
      "SYS-02",
      "content.title",
      content.title,
      `当前规则包覆盖 ${packMarketplace} 站，本次请求是 ${marketplace} 站。`,
      `选择 ${packMarketplace} 站，或导入 ${marketplace} 站的规则包。`,
      "needs_review",
      "deterministic",
    );
    for (const ruleId of ["AMZ-01", "AMZ-02", ...semanticRuleIds])
      checks.set(ruleId, {
        rule_id: ruleId,
        state: "not_checked",
        method: "deterministic",
        reason: "当前站点不在规则覆盖范围内。",
      });
  }
  const unchecked = [...checks.values()].filter((x) =>
    ["not_checked", "error"].includes(x.state),
  );
  if (unchecked.length && !issues.some((x) => x.rule_id === "SYS-02"))
    checks.set("SYS-02", {
      rule_id: "SYS-02",
      state: "not_checked",
      method: "deterministic",
      reason: `${unchecked.length} 条检查仍未完成，结果保留为部分审阅。`,
    });
  const checkResults = [...checks.values()];
  return {
    evidence,
    parameter_coverage: parameterCoverage,
    unmodeled_parameters: unmodeledParameters,
    issues,
    checks: checkResults,
    status:
      issues.length ||
      checkResults.some((x) => !["pass", "not_applicable"].includes(x.state))
        ? "needs_attention"
        : "reviewed_within_scope",
    missing_data: missingData(profile),
    coverage: {
      uncovered_parameters: parameterCoverage.not_covered,
      total: checkResults.length,
      completed: checkResults.filter(
        (x) => !["not_checked", "error"].includes(x.state),
      ).length,
      failed: issues.filter((x) => x.severity === "blocking").length,
      pending: issues.filter((x) => x.severity === "needs_review").length,
    },
    publication_readiness: "not_verified",
  };
}

export function proposeLocalRepairs(content, profile, review) {
  const clean = profile ? generateLocalDraft(profile) : null;
  const old = new Map(flattenContent(content).map((x) => [x.path, x.text]));
  const cleanFields = new Map(
    clean ? flattenContent(clean).map((x) => [x.path, x.text]) : [],
  );
  const byField = new Map();
  for (const issue of review.issues) {
    if (!old.has(issue.field_path) || issue.rule_id.startsWith("SYS")) continue;
    if (!byField.has(issue.field_path)) byField.set(issue.field_path, []);
    byField.get(issue.field_path).push(issue);
  }
  return [...byField.entries()]
    .map(([field_path, issues]) => {
      let replacement = cleanFields.get(field_path);
      if (replacement === undefined) replacement = "";
      // No unrelated field is rewritten; an unsupported bullet is removed rather than invented.
      return {
        patch_id: id("patch"),
        field_path,
        expected_before: old.get(field_path),
        replacement,
        reason: clean
          ? "以当前商品档案中的可支持信息替换此字段；请预览确认。"
          : "当前缺少事实依据，建议移除此字段中的问题表达。",
        issue_ids: issues.map((x) => x.issue_id),
        method: "local_template",
      };
    })
    .filter(
      (x) =>
        x.expected_before !== x.replacement &&
        (x.field_path !== "content.title" || x.replacement.trim()),
    );
}

export function editProfile(previous, input) {
  const data = profileEditSchema.parse(input);
  const result = clone(previous);
  result.revision += 1;
  result.name_zh = data.name_zh;
  const depth = data.depth === undefined ? previous.dimensions_cm?.value?.depth ?? null : data.depth;
  if (depth !== null && (data.width === null || data.height === null))
    throw new AppError('DEPTH_WITHOUT_SIZE', '填写深度前请先确认宽度和高度。');
  const values = {
    material: data.material || null,
    dimensions_cm: data.width !== null && data.height !== null ? { width: data.width, height: data.height, ...(depth !== null ? { depth } : {}) } : null,
    fabric_weight_gsm: data.fabric_weight_gsm,
    capacity_l: data.capacity_l,
    handle_length_cm: data.handle_length_cm,
    retail_pack_count: data.retail_pack_count,
    brand: data.brand.trim() || null,
    color: data.color.trim() || null,
  };
  if (data.rated_load_kg !== undefined) values.rated_load_kg = data.rated_load_kg;
  // 制造商 / 欧盟责任人：只在本轮传了这两项时才动，六个子字段全空按 null 存（＝没填）。
  // 不在这里卡「填一半不许存」：商家往往先拿到公司名、过两天才拿到门牌号，
  // 卡死在保存这一步等于逼他先编一个地址。缺哪项由审核侧清单逐项点出来。
  for (const key of ["manufacturer", "eu_responsible"])
    if (data[key] !== undefined) values[key] = normalizeParty(data[key]);
  for (const [key, value] of Object.entries(values))
    if (JSON.stringify(value) !== JSON.stringify(previous[key]?.value)) {
      if (result.fact_sources) delete result.fact_sources[key];
      result[key] = {
        value,
        status: value === null ? "unknown" : "merchant_confirmed",
        source_ids: value === null ? [] : ["LOCAL-MERCHANT-INPUT"],
      };
    }
  return result;
}
