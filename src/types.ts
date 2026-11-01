export type View =
  | "home"
  | "guided"
  | "create"
  | "diagnose"
  | "products"
  | "history"
  | "rules"
  | "ruleMonitor"
  | "batch"
  | "research"
  | "library";
export type Content = {
  title: string;
  item_highlights: string;
  bullet_points: { id: string; text: string }[];
  description: string;
};
export type Fact<T> = { value: T; status: string; source_ids: string[] };
/** GPSR 第 19 条要的一方的六个字段；六项全空等于没填（存 null）。 */
export type Party = {
  name: string;
  street: string;
  postal_code: string;
  city: string;
  country: string;
  electronic_address: string;
};
export type FactSourceInput = {
  url: string;
  publisher: string;
  applicable_model: string;
  excerpt: string;
};
export type FactSource = FactSourceInput & {
  source_id: string;
  recorded_at: string;
};
export type Product = {
  sku?: string;
  variation?: {
    parent_sku: string;
    parentage: string;
    theme: string;
    relationship_type: string;
    size: string;
  };
  product_id: string;
  revision: number;
  name_zh: string;
  is_demo: boolean;
  reference_product_id: string | null;
  material: Fact<string | null>;
  dimensions_cm: Fact<{ width: number; height: number; depth?: number } | null>;
  fabric_weight_gsm: Fact<number | null>;
  capacity_l: Fact<number | null>;
  handle_length_cm: Fact<number | null>;
  retail_pack_count: Fact<number | null>;
  brand: Fact<string | null>;
  color: Fact<string | null>;
  rated_load_kg: Fact<number | null>;
  manufacturer?: Fact<Party | null>;
  eu_responsible?: Fact<Party | null>;
  fact_sources?: Record<string, FactSource>;
  additional_facts?: (Fact<string> & {
    id?: string;
    label: string;
    source?: FactSource;
  })[];
  evidence_submissions?: {
    source_id: string;
    target: string;
    target_label: string;
    original: string;
    field_path: string;
    title: string;
    applicable_model: string;
    publisher: string;
    url: string;
    excerpt: string;
    submitted_at: string;
    status: "submitted_unverified";
    listing_id: string;
    listing_version: number;
    owner?: string;
    due_on?: string;
    handoff_id?: string;
    verification_status?: "unverified" | "source_verified" | "scope_verified" | "not_applicable" | "expired" | "conflict";
    issuing_organization?: string;
    test_standard?: string;
    test_date?: string;
    expiry_date?: string;
    supported_claims?: string[];
    reviewer?: string;
    verification_history?: { at: string; status: string; reviewer?: string; note?: string }[];
  }[];
  amazon?: {
    asin: string;
    url: string;
    title: string;
    checked_at: string;
    import_mode: "live" | "snapshot";
    availability: string;
    availability_text: string;
    freshness: string;
    source_ids: string[];
  };
};
export type Source = {
  snapshot?: unknown;
  source_id: string;
  kind: string;
  url: string | null;
  publisher?: string;
  description?: string;
  checked_at?: string;
  note?: string;
};
export type Rule = {
  rule_id: string;
  category: string;
  title_zh: string;
  method: string;
  source_ids: string[];
  repair: string;
  constraint: Record<string, unknown>;
};
export type Issue = {
  issue_id: string;
  rule_id: string;
  category: string;
  title: string;
  severity: string;
  field_path: string;
  original: string;
  reason: string;
  suggestion: string;
  method: string;
  source_ids: string[];
  status: string;
};
export type Check = {
  rule_id: string;
  state: string;
  method: string;
  reason: string;
};
export type Patch = {
  patch_id: string;
  field_path: string;
  expected_before: string;
  replacement: string;
  reason: string;
  issue_ids: string[];
  method: string;
};
export type Trace = {
  provider: string;
  actual_model_call: boolean;
  provider_request_id: string | null;
  model: string | null;
  requested_model?: string | null;
  json_repair?: {
    repaired: boolean;
    notes: string[];
    original_error_code: string | null;
  };
  elapsed_ms?: number;
  source_ids?: string[];
  prompt_version?: string;
  rule_selection?: string;
  usage?: {
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
};
export type Listing = {
  guided_plan?: import("./GuidedWorkspace").GuidedPlan | null;
  intake_context?: {
    role: "own_draft" | "competitor_reference";
    source_tool: string;
    source_url: string | null;
    source_asin: string | null;
    source_filename?: string | null;
    selected_terms: string[];
    scope_confirmed: boolean;
    original_content: Content;
    imported_at: string;
  } | null;
  keyword_usage?: {
    term: string;
    before_count: number;
    after_count: number;
    status: "retained" | "removed" | "added" | "absent";
  }[];
  content_brief?: {
    audience: string;
    use_case: string;
    concern: string;
    style: string;
  } | null;
  listing_id: string;
  version: number;
  parent_version: number | null;
  workflow: string;
  operation: string;
  product_ref: string | null;
  product_change?: { before: string | null; after: string | null } | null;
  product_snapshot: Product | null;
  content: Content;
  run_id: string;
  created_at: string;
  is_demo: boolean;
  instruction: string;
  rule_pack_version: string;
  /** 这条结果生成时用的站点与语言（服务端落库字段）。看旧结果时以它为准，不跟当前下拉走。 */
  marketplace?: string;
  language?: string;
  variant_adoption?: { variant_set_id: string; angle: string; base_version: number };
  rule_pack_snapshot?: { scope?: { marketplace?: string } };
  rule_citations?: RuleCitation[];
  trace: Trace;
  review: {
    consistency_check?: {
      state: "baseline" | "consistent" | "changed";
      compared_version?: number;
      reason: string;
    };
    evidence?: {
      field_path: string;
      claim: string;
      state: string;
      reason: string;
      association_method?: string;
      product_ref?: string;
      semantic_status?: string;
      model_mapped?: boolean;
      parameter_links?: {
        original: string;
        field: string;
        value?: unknown;
        method: string;
        source_ids: string[];
        product_ref: string;
        start: number;
        end: number;
      }[];
      unresolved_parameters?: {
        original: string;
        field: string;
        status: string;
        reason: string;
      }[];
      not_covered_parameters?: {
        original: string;
        field: string;
        field_label?: string;
        parsed_value?: { value: number; unit: string };
        reason: string;
      }[];
      facts: { field: string; value: unknown; source_ids: string[] }[];
    }[];
    unmodeled_parameters?: {
      field_path: string;
      field: string;
      field_label?: string;
      original: string;
      unit: string | null;
      reason: string;
    }[];
    parameter_coverage?: {
      recognized: number;
      matched: number;
      unresolved: number;
      not_covered: number;
      whole_sentence_proven: false;
    };
    issues: Issue[];
    checks: Check[];
    status: string;
    missing_data: { field: string; label: string; reason: string }[];
    coverage: {
      total: number;
      completed: number;
      failed: number;
      pending: number;
      uncovered_parameters?: number;
    };
    publication_readiness: string;
  };
  patches: Patch[];
  repair_warnings?: string[];
  changes: { field_path: string; before: string; after: string }[];
  risk_changes: {
    resolved: Issue[];
    remaining: Issue[];
    added: Issue[];
  } | null;
};
export type Run = {
  run_id: string;
  listing_id: string;
  status: string;
  stage: string;
  operation: string;
  created_at: string;
  version?: number;
  provider: string;
  actual_model_call: boolean;
  elapsed_ms?: number;
  error?: {
    code: string;
    message: string;
    /** 人话标题与下一步，由服务端 errors.mjs 的 describeFailure 统一给。 */
    title?: string;
    action?: string;
    category?: string;
    retryable?: boolean;
    /** 上游自己的错误码与原文（只有服务方明确给了才带）。 */
    upstream?: {
      status?: number | null;
      code?: string | null;
      message?: string | null;
    };
  };
  trace?: Trace;
};
export type Settings = {
  provider: "demo" | "compatible" | "dify";
  base_url: string;
  model: string;
  dify_base_url: string;
  timeout_ms: number;
  has_api_key: boolean;
  has_dify_create_api_key: boolean;
  has_dify_diagnose_api_key: boolean;
  /** 服务端拼好的完整请求地址（providers.mjs 的 describeEndpoint）。 */
  endpoint?: {
    url: string | null;
    valid: boolean;
    reason: string | null;
  } | null;
};
/** 规则依据：官方文件还是项目内部约定，由服务端判定，界面只负责显示。 */
export type RuleCitationSource = {
  source_id: string;
  publisher: string;
  kind: string | null;
  kind_label: string;
  /** false 时界面上只能写"项目内部约定"，不许带官方口吻。 */
  is_official: boolean;
  url: string | null;
  local_document: string | null;
  document_date: string | null;
  effective_from: string | null;
  updated_on: string | null;
  checked_at: string | null;
  access_note: string | null;
};
export type RuleCitation = {
  field_basis_overrides?: Record<string, Partial<RuleCitation>>;
  rule_id: string;
  title_zh: string;
  category_label: string;
  severity_label: string;
  method_label: string;
  constraint: string;
  repair: string;
  note: string;
  external: boolean;
  basis_label: string;
  sources: RuleCitationSource[];
};
export type Bootstrap = {
  products: Product[];
  listings: Listing[];
  runs: Run[];
  sources: Source[];
  /**
   * 服务端把整个规则包原样发过来，界面只声明这里真正用到的字段。
   * `scope.marketplace` 用来在规则页标明「这是哪个站的包」——
   * 以服务端实际下发的包为准，而不是界面上下拉选了什么，
   * 免得切换站点时请求还没回来就把标题写成德国站。
   */
  rules: {
    rules: Rule[];
    rule_pack_version: string;
    label?: string;
    scope?: { marketplace?: string; locale?: string };
  };
  fixtures: { fixture_id: string; content: Content }[];
  settings: Settings;
  /** 每行会调几次模型（实测值，服务端唯一来源）。键是批量操作类型：create / diagnose / optimize。 */
  batch_calls_per_row?: Record<string, number>;
  rule_citations?: RuleCitation[];
  rule_citations_by_version?: Record<string, RuleCitation[]>;
  /** 每个站当前规则包版本：判断某条结果是否在旧规则下审的时候，按该结果自己的站点取。 */
  rule_pack_versions?: Record<string, string>;
};

/** A+ 对比表的一行：由已登记商品参数确定性生成，不是营销文案。 */
export type AplusRow = {
  field: string;
  label_en: string;
  label_zh: string;
  value: string;
  status: string;
  source_ids: string[];
};
export type AplusContent = {
  generated_at: string;
  product_ref: string | null;
  revision: number | null;
  marketplace: string;
  language: string;
  comparison_chart: AplusRow[];
  missing_parameters: { field: string; label_en: string; label_zh: string }[];
  module_copy: {
    type: string;
    headline: string | null;
    feature_bullets: string[];
    note: string;
  };
};

export type VocContent = {
  total_reviews: number;
  signals: { term: string; zh: string; count: number }[];
  pain_points: { theme: string; zh: string; evidence: string }[];
  grounded_bullets: { theme: string; bullet: string }[];
  unsupported: string[];
  gap_analysis: {
    strengthen: { theme: string; field: string; value: string }[];
    needData: { theme: string; missing: string[] }[];
    cannotProve: { theme: string; reason: string }[];
    avoidClaims: { claim: string; reason: string }[];
    notice: string;
  } | null;
  model_used: boolean;
  notice: string;
};

export type KeywordContent = {
  total_terms: number;
  covered: number;
  missing: string[];
  in_title: string[];
  rows: { term: string; present: boolean; in_title: boolean }[];
  notice: string;
};

export type VariantContent = {
  variant_set_id: string;
  listing_id: string;
  base_version: number;
  generated_at: string;
  variants: { angle: string; content: Content }[];
  angles: { id: string; en: string; zh: string }[];
  model_used: boolean;
  trace: Trace;
  review_status: "not_reviewed";
  notice: string;
};

export type RolesContent = {
  total: number;
  board: { role: string; items: { field: string; label: string; reason: string }[] }[];
  counts?: {
    blocking: number;
    needs_review: number;
    suggestion: number;
    missing_data: number;
    evidence_unverified: number;
    evidence_expired: number;
  };
  notice: string;
};

/** 上架前完整度检查：由已登记商品档案确定性生成，不是 Amazon 官方结论。 */
export type ReadinessItem = {
  key: string;
  label: string;
  status: "complete" | "blocking" | "todo" | "warning" | "na";
  status_label: string;
  reason: string;
  action: string;
};
export type ReadinessContent = {
  marketplace: string;
  generated_at: string;
  score: number;
  total: number;
  complete: number;
  blocking: number;
  todo: number;
  warning: number;
  items: ReadinessItem[];
  blockers: ReadinessItem[];
  notice: string;
};

/** 变体与父子 SKU 一致性审核：确定性检查，不是平台结论。 */
export type VariationIssue = {
  key: string;
  label: string;
  severity: "blocking" | "warning";
  reason: string;
  action: string;
};
export type VariationCheckContent = {
  variation: {
    parent_sku: string;
    parentage: string;
    theme: string;
    relationship_type: string;
    size: string;
  } | null;
  issues: VariationIssue[];
  blocking: number;
  warning: number;
  notice: string;
};

/** 商品证据生命周期台账：只读、确定性，文件存在不等于报告真实。 */
export type EvidenceBoardItem = {
  source_id: string;
  title: string;
  target: string;
  target_label: string;
  applicable_model: string;
  publisher: string;
  submitted_at: string;
  status: string;
  status_label: string;
  expired: boolean;
  expiry_date: string | null;
  issuing_organization: string | null;
  test_standard: string | null;
  supported_claims: string[];
  reviewer: string | null;
  history: { at: string; status: string; reviewer?: string; note?: string }[];
};
export type EvidenceBoardContent = {
  total: number;
  verified: number;
  unverified: number;
  expired: number;
  conflict: number;
  items: EvidenceBoardItem[];
  notice: string;
};
