// 变体与父子 SKU 一致性审核：确定性检查，只对能从商品档案与文案中读到的字段下结论。
// 不推断类目规则、不判断图片内容、不冒充平台最终审核。
const KNOWN_THEMES = ["color", "size", "color_size", "size_color", "style", "pattern", "flavor", "scent", "count"];
const COLOR_WORDS = [
  "black", "white", "navy", "red", "natural", "beige", "grey", "gray", "blue",
  "green", "brown", "pink", "yellow", "orange", "purple", "khaki", "cream",
];

function flatText(content) {
  if (!content) return "";
  return [
    content.title,
    content.item_highlights,
    ...(content.bullet_points || []).map((b) => b.text),
    content.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function checkVariation(product, content) {
  const issues = [];
  const v = product?.variation;

  // 1. 父子关系完整性
  if (v) {
    if (!v.parent_sku)
      issues.push({ key: "parent_sku", label: "父 SKU 未关联", severity: "blocking", reason: "变体商品缺少父 SKU", action: "补父 SKU" });
    if (!v.theme)
      issues.push({ key: "theme", label: "变体主题缺失", severity: "blocking", reason: "未登记变体主题（颜色/尺寸等）", action: "补变体主题" });
    else {
      const normalized = String(v.theme).toLowerCase().replace(/\s+/g, "_");
      if (!KNOWN_THEMES.includes(normalized))
        issues.push({ key: "theme_invalid", label: "变体主题不在常见范围", severity: "warning", reason: `当前变体主题：${v.theme}`, action: "核对类目允许的变体主题" });
    }
    if (!v.relationship_type)
      issues.push({ key: "relationship", label: "父子关系类型缺失", severity: "warning", reason: "未登记父子关系类型", action: "补父子关系类型" });
  }

  const text = flatText(content);

  // 2. 颜色一致性（只在档案有颜色、且文案提到颜色时判断）
  const color = product?.color?.value;
  if (color && text) {
    const mentioned = COLOR_WORDS.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(text));
    if (mentioned.length && !mentioned.includes(String(color).toLowerCase())) {
      issues.push({
        key: "color_mismatch",
        label: "文案颜色与商品档案不一致",
        severity: "warning",
        reason: `档案颜色：${color}；文案提到：${mentioned.join("、")}`,
        action: "核对变体颜色，或改为对应子体",
      });
    }
  }

  // 3. 包装件数一致性
  const pack = product?.retail_pack_count?.value;
  if (pack != null && text) {
    const matches = text.match(/(\d+)\s*(pack|pcs|pieces?|count|set)/gi) || [];
    const nums = matches
      .map((m) => parseInt(m, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (nums.length && !nums.includes(Number(pack))) {
      issues.push({
        key: "pack_mismatch",
        label: "文案件数与零售件数不一致",
        severity: "warning",
        reason: `档案零售件数：${pack}；文案出现：${[...new Set(nums)].join("、")}`,
        action: "核对包装件数",
      });
    }
  }

  return {
    variation: v || null,
    issues,
    blocking: issues.filter((i) => i.severity === "blocking").length,
    warning: issues.filter((i) => i.severity === "warning").length,
    notice:
      "只核对能从商品档案与文案中读到的变体/父子关系字段；不推断类目规则、图片内容或平台最终审核。",
  };
}
