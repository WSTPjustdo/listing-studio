/**
 * 把规则包渲染成一份人能读的说明书。
 *
 * 只做两件事：`ruleInventory` 把 rules.json 整理成结构化清单（顺手查出引用不到的来源），
 * `rulesMarkdown` 把清单排成 Markdown。都是纯函数，不读文件、不写文件，方便单测。
 *
 * 一条原则：**官方来源和项目内部约定必须分开写**。
 * 我们自己定的检查（例如"标题别写多个包装规格"）不能混在"平台规定"里，
 * 否则等于替 Amazon 编规定——这是这类合规产品最容易犯、也最致命的错。
 */

const CATEGORY_LABELS = {
  platform_rules: "平台规则",
  target_country_claims_review: "目标国宣称审查",
  // 目标国法规要求商品页必须「给出哪些信息」（GPSR 四要素、纺织成分、包装注册号）。
  // 它既不是平台规则，也不是宣称审查——混进前两类会让读者把欧盟法律当成 Amazon 规定。
  target_country_product_info: "目标国产品信息要求",
  product_fact_quality: "商品事实质量",
  system_integrity: "系统完整性",
  // 品类专属检查：只有那个品类的规则包才声明。必须跟平台规则分开显示，
  // 否则我们自己定的"标题要写尺码"会被读成 Amazon 的规定。
  category_rules: "品类专属（项目内部约定）",
};

const KIND_LABELS = {
  official_platform_policy: "平台官方",
  official_regulatory_guidance: "监管机构指南",
  project_check: "项目内部约定",
};

const SEVERITY_LABELS = {
  blocking: "阻断（blocking）",
  needs_review: "待人工核（needs_review）",
  suggestion: "表达建议（suggestion）",
};

const METHOD_LABELS = {
  deterministic: "确定性代码检查，可复现",
  patterns_with_context_review: "模式匹配 + 上下文复核",
  patterns_and_semantic_review: "模式匹配 + 语义复核",
  structured_comparison_and_semantic_review: "结构化参数对照 + 语义复核",
  candidate_detection_and_contextual_review: "候选召回 + 上下文复核",
  claim_extraction_and_evidence_review: "宣称抽取 + 证据审查",
  typed_fact_comparison: "按字段类型对照商品事实",
  explicit_field_comparison: "按明确字段对照",
};

const isExternal = (source) => /^official_/.test(source?.kind || "");

function constraintText(constraint = {}) {
  const parts = [];
  if (typeof constraint.max_characters === "number")
    parts.push(
      `上限 ${constraint.max_characters} 字符${constraint.include_spaces ? "（含空格）" : "（不含空格）"}`,
    );
  if (Array.isArray(constraint.candidates))
    parts.push(`检查项：${constraint.candidates.join(" / ")}`);
  if (Array.isArray(constraint.keep_distinct))
    parts.push(
      `不能互相替代：${constraint.keep_distinct.map((pair) => pair.join(" ↔ ")).join("；")}`,
    );
  if (typeof constraint.max_distinct_pack_counts_in_title === "number")
    parts.push(
      `标题里不同包装件数不得超过 ${constraint.max_distinct_pack_counts_in_title} 种（认 ${(constraint.pack_units || []).join(" / ")}）`,
    );
  if (constraint.pack_claim_must_match)
    parts.push(`件数声明必须等于 ${constraint.pack_claim_must_match}`);
  if (constraint.must_match_confirmed_product_facts)
    parts.push("所有数值必须与已确认的商品档案一致");
  if (constraint.no_pass_from_error_or_missing_checks)
    parts.push("未执行的检查不能算通过");
  if (constraint.source_must_exist_and_be_supplied_to_current_run)
    parts.push("引用必须存在于本轮输入中");
  if (!parts.length) {
    const rest = Object.entries(constraint).filter(([, value]) => value !== false);
    if (rest.length)
      parts.push(rest.map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("；"));
  }
  return parts.join("；") || "—";
}

/** 整理规则包：每条规则带上它的来源（含是否官方），并找出引用不到的来源 id。 */
export function ruleInventory(rulePack) {
  const sources = new Map((rulePack.sources || []).map((x) => [x.source_id, x]));
  const used = new Set();
  const rules = (rulePack.rules || []).map((rule) => {
    const declared = rule.source_ids || [];
    declared.forEach((id) => used.add(id));
    const resolved = declared.map((id) => sources.get(id)).filter(Boolean);
    return {
      rule_id: rule.rule_id,
      title_zh: rule.title_zh,
      category: rule.category,
      category_label: CATEGORY_LABELS[rule.category] || rule.category,
      severity: rule.severity_on_failure,
      severity_label: SEVERITY_LABELS[rule.severity_on_failure] || rule.severity_on_failure,
      method: rule.method,
      method_label: METHOD_LABELS[rule.method] || rule.method,
      field_paths: rule.field_paths || [],
      field_basis_overrides: rule.field_basis_overrides || {},
      constraint: constraintText(rule.constraint),
      external: resolved.some(isExternal),
      sources: resolved,
      missing_sources: declared.filter((id) => !sources.has(id)),
      note: rule.note || "",
      repair: rule.repair || "",
    };
  });
  return {
    version: rulePack.rule_pack_version,
    total: rules.length,
    by_category: Object.entries(CATEGORY_LABELS)
      .map(([category, label]) => ({
        category,
        label,
        count: rules.filter((x) => x.category === category).length,
      }))
      .filter((x) => x.count)
      .concat(
        rules
          .filter((x) => !CATEGORY_LABELS[x.category])
          .map((x) => ({ category: x.category, label: x.category, count: 1 })),
      ),
    external_count: rules.filter((x) => x.external).length,
    internal_count: rules.filter((x) => !x.external).length,
    rules,
    missing_sources: [...new Set(rules.flatMap((x) => x.missing_sources))],
    unused_sources: [...sources.keys()].filter((id) => !used.has(id)),
    coverage_limits: rulePack.coverage_limits || [],
  };
}

/**
 * 界面用的「这一条依据什么」。
 *
 * 不直接把手里的 rulePack 丢给前端拼，是因为「官方文件 / 项目内部约定」这个区分
 * 一旦由界面各自实现一次，迟早有一处会把我们自己的检查显示成平台规定。
 * 这里只吐一份紧凑清单：谁发布的、哪份文件、哪天核对的、链接是什么。
 * `is_official` 为 false 的来源必须在界面上以"项目内部约定"出现，不许带任何官方口吻。
 */
export function ruleCitations(rulePack) {
  const citations = ruleInventory(rulePack).rules.map((rule) => ({
    rule_id: rule.rule_id,
    title_zh: rule.title_zh,
    category_label: rule.category_label,
    severity_label: rule.severity_label,
    method_label: rule.method_label,
    constraint: rule.constraint,
    repair: rule.repair,
    note: rule.note,
    external: rule.external,
    basis_label: rule.external ? "官方文件" : "项目内部约定",
    sources: rule.sources.map((source) => ({
      source_id: source.source_id,
      publisher: source.publisher || source.source_id,
      kind: source.kind || null,
      kind_label: KIND_LABELS[source.kind] || "未标注类型",
      is_official: isExternal(source),
      url: source.url || null,
      local_document: source.local_document || null,
      document_date: source.document_date || null,
      effective_from: source.effective_from || null,
      updated_on: source.updated_on || null,
      checked_at: source.checked_at || null,
      access_note: source.access_note || null,
    })),
  }));
  const sources = new Map((rulePack.sources || []).map(source => [source.source_id, source]));
  return citations.map(citation => {
    const rule = rulePack.rules.find(item => item.rule_id === citation.rule_id);
    const field_basis_overrides = Object.fromEntries(Object.entries(rule.field_basis_overrides || {}).map(([field, override]) => {
      const selected = (override.source_ids || []).map(id => sources.get(id)).filter(Boolean);
      const external = override.kind !== 'project_check' && selected.some(isExternal);
      return [field, {
        ...citation, external, basis_label: external ? '官方文件' : '项目内部约定',
        note: override.note || citation.note,
        sources: selected.map(source => ({ ...source, publisher: source.publisher || source.source_id,
          kind_label: KIND_LABELS[source.kind] || '未标注类型', is_official: external && isExternal(source) })),
      }];
    }));
    return { ...citation, field_basis_overrides };
  });
}

export function citationForField(citation, fieldPath) {
  return citation?.field_basis_overrides?.[fieldPath] || citation || null;
}

const dateLine = (source) => {
  const bits = [];
  if (source.document_date) bits.push(`文件日期 ${source.document_date}`);
  if (source.effective_from) bits.push(`生效 ${source.effective_from}`);
  if (source.updated_on) bits.push(`更新 ${source.updated_on}`);
  if (source.checked_at) bits.push(`核对于 ${source.checked_at}`);
  return bits.join(" · ");
};

function sourceLine(source) {
  const kind = KIND_LABELS[source.kind] || source.kind || "未标注类型";
  const where = source.url || source.local_document || "（无链接）";
  const dates = dateLine(source);
  return `- **${source.publisher || source.source_id}**（${kind}）\`${source.source_id}\` ${where}${dates ? ` — ${dates}` : ""}${source.access_note ? `；${source.access_note}` : ""}`;
}

export function rulesMarkdown(rulePack) {
  const inventory = ruleInventory(rulePack);
  const lines = [];
  lines.push("# 规则说明书（由 rules.json 生成，不要手改）");
  lines.push("");
  lines.push(`> 规则包版本：\`${inventory.version}\``);
  lines.push("> 生成方式：`node scripts/explain-rules.mjs --write`；`--check` 会在文档与规则不一致时报错。");
  lines.push(
    `> 共 ${inventory.total} 条：${inventory.by_category.map((x) => `${x.label} ${x.count}`).join("、")}。` +
      `其中引用官方文件的 ${inventory.external_count} 条，纯项目内部约定 ${inventory.internal_count} 条。`,
  );
  lines.push("> 这里写的是「我们查什么、依据什么、不查什么」，不表示 Amazon 审核通过，也不构成法律意见。");
  lines.push("");
  lines.push("## 一览");
  lines.push("");
  lines.push("| 规则 | 名称 | 类别 | 严重度 | 判定方式 | 依据类型 |");
  lines.push("|---|---|---|---|---|---|");
  for (const rule of inventory.rules)
    lines.push(
      `| ${rule.rule_id} | ${rule.title_zh} | ${rule.category_label} | ${rule.severity} | ${rule.method_label} | ${rule.external ? "官方文件" : "项目内部约定"} |`,
    );
  lines.push("");
  lines.push("## 逐条说明");
  for (const rule of inventory.rules) {
    lines.push("");
    lines.push(`### ${rule.rule_id} · ${rule.title_zh}`);
    lines.push("");
    lines.push(`- 类别：${rule.category_label}`);
    lines.push(`- 查哪些字段：${rule.field_paths.map((x) => `\`${x}\``).join("、")}`);
    for (const [field, override] of Object.entries(rule.field_basis_overrides))
      lines.push(`- 字段例外：\`${field}\` 使用${override.kind === 'project_check' ? '项目内部约定，不能称为官方规定' : override.kind || '未标注类型'}；${override.note || '请核对字段级依据。'}`);
    lines.push(`- 判定条件：${rule.constraint}`);
    lines.push(`- 怎么判：${rule.method_label}`);
    lines.push(`- 命中后：${rule.severity_label}`);
    lines.push(`- 建议怎么改：${rule.repair || "—"}`);
    if (rule.note) lines.push(`- 边界与说明：${rule.note}`);
    lines.push("");
    lines.push(rule.external ? "依据：" : "依据（项目内部约定，不是平台规定）：");
    if (!rule.sources.length) lines.push("- **没有登记来源**——这条规则不应出现在规则包里。");
    for (const source of rule.sources) lines.push(sourceLine(source));
  }
  if (inventory.coverage_limits.length) {
    lines.push("");
    lines.push("## 这套规则明确不覆盖什么");
    lines.push("");
    for (const limit of inventory.coverage_limits) lines.push(`- ${limit}`);
  }
  // 有些来源不挂在某条规则上，而是支撑"规则边界"的说法（例如 Green Guides 不是独立可执行法规）。
  // 它们也必须在说明书里出现，否则下次没人知道这份文件为什么被登记。
  if (inventory.unused_sources.length) {
    const sources = new Map((rulePack.sources || []).map((x) => [x.source_id, x]));
    lines.push("");
    lines.push("## 补充参考来源（未直接绑定到某条规则）");
    lines.push("");
    lines.push("这些来源支撑的是规则边界的说明，不构成某条规则的判定依据：");
    lines.push("");
    for (const id of inventory.unused_sources) {
      const source = sources.get(id);
      if (!source) {
        lines.push(`- **${id}**（登记了但找不到定义）`);
        continue;
      }
      lines.push(sourceLine(source));
    }
  }
  lines.push("");
  return lines.join("\n");
}
