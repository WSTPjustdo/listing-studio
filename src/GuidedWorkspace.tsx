import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  Copy,
  Download,
  FileText,
  LoaderCircle,
  Search,
  Sparkles,
  Upload,
} from "lucide-react";
import { api, post } from "./api";
import { listingScope } from "./listingScope";
import { waitForRun } from "./runPolling";
import { adoptMaterialText, guidedAnalysisFingerprint, guidedSelectionError } from "./guidedInput";
import type { AppliedMaterial } from "./guidedInput";
import { MaterialIntake, emptyMaterialDraft } from "./MaterialIntake";
import type { MaterialContext, MaterialDraft } from "./MaterialIntake";
import { readGuidedDraft, removeGuidedDraft, writeGuidedDraft } from "./guidedDraftStorage";
import type { Listing, Product, Run } from "./types";
import "./guided.css";

export type GuidedMode = "improve" | "automatic";
export type GuidedPlan = {
  id: string;
  mode: GuidedMode;
  optimized_prompt: string;
  changes: string[];
  missing: string[];
  product_id: string;
  product_revision: number;
  language?: "en" | "es" | "zh" | "de" | "fr";
  marketplace?: string;
  research_status?: string;
  research_context?: { provider?: string; notice?: string };
  trace?: { actual_model_call: boolean; provider_request_id: string | null };
};
type Analysis = {
  id: string;
  name: string;
  category: string;
  search_query: string;
  observations: string[];
  facts: { label: string; value: string; evidence: string }[];
  missing: string[];
  suggested_fields?: Record<string, string | number | null>;
};
type Candidate = {
  asin: string | null;
  reference_id?: string;
  url: string;
  title: string;
  bullets: string[];
  warnings?: string[];
  detail_status?: string;
};
type Research = {
  id: string;
  query: string;
  items: Candidate[];
  provider?: string;
  notice?: string;
  warnings?: string[];
  failures?: {
    reference_id: string;
    url: string;
    publisher?: string;
    http_status?: number | null;
    code?: string;
    message: string;
  }[];
  terms: {
    term: string;
    count: number;
    asins: string[];
    reference_ids?: string[];
  }[];
};
const candidateKey = (item: Candidate) => item.reference_id || item.asin || "";
/**
 * 引导流程只有一个下拉，但它同时决定「哪个站」和「写哪种语言」——发请求时拆成两个字段。
 * 德语只在德国站成立，所以选德语就切到 Amazon DE；西语、中文、英语都仍挂在美国站。
 * 默认（英语）仍是美国站，跟改造前一致。
 */
/*
 * 站点 = 市场 + 语言，一张显式表。
 *
 * 以前只靠语言反推市场（de→DE，其余→US）。加英国站以后这条推不出来：
 * 英国站也是英语，跟美国站同语言、不同法域、不同规则包。
 * 所以改成"选站点键，市场与语言各取一列"，不再从语言猜市场。
 *
 * 每站 2–3 种语言，按市场价值派（与服务端 store.mjs 的 SITE_LANGUAGES 一一对应，
 * 服务端那张表是唯一真相，这里只是它的界面投影）：
 *   美国站 3 种、德国站 3 种、英国站 2 种、法国站 2 种。
 * tier 决定界面上怎么说话：
 *   primary   主体语言
 *   listing   能在这个站上架的第二语言
 *   internal  **不能直接上架**，只作内部核对或翻译对照（中文；法国站的英语）
 */
const GUIDED_SITES = [
  { key: "US-en", market: "US", language: "en", tier: "primary", label: "美国站 · 英语" },
  { key: "US-es", market: "US", language: "es", tier: "listing", label: "美国站 · 西班牙语" },
  { key: "US-zh", market: "US", language: "zh", tier: "internal", label: "美国站 · 中文（内部核对）" },
  { key: "DE-de", market: "DE", language: "de", tier: "primary", label: "德国站 · 德语" },
  { key: "DE-en", market: "DE", language: "en", tier: "listing", label: "德国站 · 英语" },
  { key: "DE-zh", market: "DE", language: "zh", tier: "internal", label: "德国站 · 中文（内部核对）" },
  { key: "UK-en", market: "UK", language: "en", tier: "primary", label: "英国站 · 英语（英式）" },
  { key: "UK-zh", market: "UK", language: "zh", tier: "internal", label: "英国站 · 中文（内部核对）" },
  { key: "FR-fr", market: "FR", language: "fr", tier: "primary", label: "法国站 · 法语" },
  { key: "FR-en", market: "FR", language: "en", tier: "internal", label: "法国站 · 英语（对照，不上架）" },
] as const;
type GuidedSiteKey = (typeof GUIDED_SITES)[number]["key"];
const siteOf = (key: string) => GUIDED_SITES.find((item) => item.key === key) ?? GUIDED_SITES[0];
const MARKET_ZH: Record<string, string> = { US: "美国站", DE: "德国站", UK: "英国站", FR: "法国站" };
// 每个站点那一段"这个站的规则包是什么情况"的说明。四张包的边界不一样，混着说会让人以为都一样。
const MARKET_NOTE: Record<string, string> = {
  DE: "德国站使用独立规则包，文案按所选语言生成；缺失资料和未覆盖的检查会保留。",
  UK: "英国站使用独立规则包；平台标题与亮点规则、项目文本与证据检查分别列出。绿色宣称、塑料袋收费事实、UKCA/CE、纺织品标注、一般安全义务等英国法域规则目前只列清单，不作合规结论。",
  FR: "法国站：4 条平台层（标题长度、亮点长度、禁用字符、同词两次）能出结论；法语语言要求（Loi Toubon）、纤维成分、环保宣称、EPR 注册号这 4 条只做候选检测或本地能判的那一半，Triman 标志与 GPSR 四要素只列清单、不给结论 —— 标志有没有印、注册号真不真，文本层看不到。",
  US: "",
};
// 语言名只用于说清"这份内容是什么语言"。少一种语言就会在德语文案旁边写"英文"，
// 所以这里收成一张表，界面各处都从它取。
const LANGUAGE_ZH: Record<string, string> = {
  en: "英语",
  es: "西班牙语",
  zh: "中文",
  de: "德语",
  fr: "法语",
};
const languageZhOf = (value?: string) => LANGUAGE_ZH[value || "en"] || value || "英语";
const termMatches = (term: Research["terms"][number], keys: string[]) =>
  [...(term.asins || []), ...(term.reference_ids || [])].some((key) =>
    keys.includes(key),
  );
const referenceProvider = (provider?: string) =>
  provider === "official-public"
    ? "Westford Mill 官方公开商品页（official-public）"
    : provider || "未记录来源服务";
const fields = [
  ["width", "宽度（cm）"],
  ["height", "高度（cm）"],
  ["depth", "深度（cm）"],
  ["fabric_weight_gsm", "面料克重（gsm）"],
  ["capacity_l", "容量（L）"],
  ["handle_length_cm", "提手长度（cm）"],
  ["retail_pack_count", "零售包装件数"],
  ["brand", "品牌"],
  ["color", "颜色"],
] as const;
const fieldValue = (product: Product, key: string): string => {
  const value =
    key === "width" || key === "height" || key === "depth"
      ? product.dimensions_cm.value?.[key]
      : (product as unknown as Record<string, { value?: unknown }>)[key]?.value;
  return value === null || value === undefined ? "" : String(value);
};

/** 队友提供的历史聚合快照对照（GET /api/listings/:id/benchmark）。 */
type BenchmarkView = {
  supported?: boolean;
  notice?: string;
  baseline: {
    n: number;
    sample_date: string;
    category: string;
    marketplace: string;
    method: string;
    excludes: string;
  } | null;
  attention: number;
  facts: { level: "attention" | "ok" | "info"; sentence: string }[];
  unavailable?: string;
};
type GuidedDraftSnapshot = {
  schema: 1;
  step: 0 | 1;
  siteKey: GuidedSiteKey;
  prompt: string;
  merchantText: string;
  materialDraft: MaterialDraft;
  materialContext: MaterialContext | null;
  appliedMaterial?: AppliedMaterial | null;
  analysisInputFingerprint?: string;
  reference: string;
  image: string;
  imageName: string;
  productId: string;
  analysis: Analysis | null;
  name: string;
  material: string;
  facts: string;
  specs: Record<string, string>;
  originalFingerprint: string;
  confirmed: boolean;
  query: string;
  research: Research | null;
  selected: string[];
  terms: string[];
  keywordText: string;
  searchStatus: "not_requested" | "available" | "failed";
  searchError: string;
  searchFailures: NonNullable<Research["failures"]>;
  amazonSearchError: string;
  searchSource: "amazon" | "official_public";
  continueWithoutResearch: boolean;
};
// 报告是打印件，只能靠字符分三档；屏幕上沿用同一套符号，口语和纸上才对得上。
const BENCH_MARK: Record<string, string> = { attention: "▲", ok: "✓", info: "·" };
const BENCH_VERDICT: Record<string, string> = {
  attention: "与历史快照有差异",
  ok: "本项与快照相近",
  info: "快照对照",
};

export default function GuidedWorkspace({
  mode,
  products,
  modelConfigured,
  onRefresh,
  onHome,
  onSettings,
  onLegacy,
  onAdvanced,
  onSources,
  onWorkingChange,
  onSiteChange,
  initialSite,
  initialRecord,
}: {
  mode: GuidedMode;
  products: Product[];
  modelConfigured: boolean;
  onRefresh: () => Promise<unknown>;
  onHome: () => void;
  onSettings: () => void;
  onLegacy: () => void;
  onAdvanced: (record: Listing) => void;
  onSources: (sourceIds: string[]) => void;
  onWorkingChange: (working: boolean) => void;
  // 顶栏写的「Amazon US · 英文」要跟着这里选的语言走，否则同一屏幕上两处自相矛盾
  onSiteChange?: (site: { market: string; language: string }) => void;
  initialSite?: { market: string; language: string };
  initialRecord?: Listing | null;
}) {
  const [step, setStep] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [merchantText, setMerchantText] = useState("");
  const [materialDraft, setMaterialDraft] = useState(emptyMaterialDraft);
  const [materialContext, setMaterialContext] = useState<MaterialContext | null>(null);
  const [appliedMaterial, setAppliedMaterial] = useState<AppliedMaterial | null>(null);
  const [analysisInputFingerprint, setAnalysisInputFingerprint] = useState("");
  const [materialsWorking, setMaterialsWorking] = useState(false);
  const [reference, setReference] = useState("");
  const [image, setImage] = useState("");
  const [imageName, setImageName] = useState("");
  const [hasVision, setHasVision] = useState(false);
  const [productId, setProductId] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [name, setName] = useState("");
  const [material, setMaterial] = useState("");
  const [facts, setFacts] = useState("");
  const [specs, setSpecs] = useState<Record<string, string>>({});
  const [originalFingerprint, setOriginalFingerprint] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [query, setQuery] = useState("");
  const [research, setResearch] = useState<Research | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [terms, setTerms] = useState<string[]>([]);
  const [keywordText, setKeywordText] = useState("");
  const [searchStatus, setSearchStatus] = useState<
    "not_requested" | "loading" | "available" | "failed"
  >("not_requested");
  const [searchError, setSearchError] = useState("");
  const [searchFailures, setSearchFailures] = useState<
    NonNullable<Research["failures"]>
  >([]);
  const [amazonSearchError, setAmazonSearchError] = useState("");
  const [searchSource, setSearchSource] = useState<
    "amazon" | "official_public"
  >("amazon");
  const [continueWithoutResearch, setContinueWithoutResearch] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [retryable, setRetryable] = useState(false);
  // 站点键（市场 + 语言）。市场决定取哪个规则包，语言只决定写哪种语言、
  // 不改任何字符上限。两者分开，英国站才可能做到"英语文案、英国规则包"。
  const [siteKey, setSiteKey] = useState<GuidedSiteKey>(() => {
    const market = initialRecord ? listingScope(initialRecord).marketplace : initialSite?.market || "US";
    const language = initialRecord ? listingScope(initialRecord).language : initialSite?.language || "en";
    return siteOf(`${market}-${language}`).key;
  });
  const site = siteOf(siteKey);
  const language = site.language;
  const market = site.market;
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<Listing | null>(null);
  const [plan, setPlan] = useState<GuidedPlan | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkView | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [pendingRun, setPendingRun] = useState<Run | null>(null);
  const [runStatusNotice, setRunStatusNotice] = useState<string | null>(null);
  const [draftStorageReady, setDraftStorageReady] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftStorageError, setDraftStorageError] = useState("");
  const busyLock = useRef(false);
  const mounted = useRef(true);
  const searchTicket = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const onSiteChangeRef = useRef(onSiteChange);
  onSiteChangeRef.current = onSiteChange;
  const realProducts = products.filter((product) => !product.is_demo);
  const product = realProducts.find((item) => item.product_id === productId);
  const draftStorageKey = `guided-${mode}`;

  useEffect(() => {
    mounted.current = true;
    void api<{ vision_base_url: string; vision_model: string }>(
      "/api/research/config",
    )
      .then((config) => {
        if (mounted.current)
          setHasVision(Boolean(config.vision_base_url && config.vision_model));
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      searchTicket.current++;
    };
  }, []);
  useEffect(() => {
    if (!initialRecord) return;
    setResult(initialRecord);
    setPlan(initialRecord.guided_plan || null);
    const scope = listingScope(initialRecord);
    setSiteKey(siteOf(`${scope.marketplace}-${scope.language}`).key);
    setStep(2);
  }, [initialRecord]);
  useEffect(() => {
    let alive = true;
    if (initialRecord) {
      setDraftStorageReady(true);
      return () => { alive = false; };
    }
    void readGuidedDraft<GuidedDraftSnapshot>(draftStorageKey)
      .then((saved) => {
        if (!alive || !saved || saved.schema !== 1 || ![0, 1].includes(saved.step)) return;
        setStep(saved.step);
        setSiteKey(saved.siteKey);
        setPrompt(saved.prompt);
        setMerchantText(saved.merchantText);
        setMaterialDraft(saved.materialDraft);
        setMaterialContext(saved.materialContext);
        setAppliedMaterial(saved.appliedMaterial || (saved.materialDraft.applied && saved.materialDraft.preview ? { previewId: saved.materialDraft.preview.id, text: saved.materialDraft.text } : null));
        setAnalysisInputFingerprint(saved.analysisInputFingerprint || "");
        setReference(saved.reference);
        setImage(saved.image);
        setImageName(saved.imageName);
        setProductId(saved.productId);
        setAnalysis(saved.analysis);
        setName(saved.name);
        setMaterial(saved.material);
        setFacts(saved.facts);
        setSpecs(saved.specs);
        setOriginalFingerprint(saved.originalFingerprint);
        setConfirmed(saved.confirmed);
        setQuery(saved.query);
        setResearch(saved.research);
        setSelected(saved.selected);
        setTerms(saved.terms);
        setKeywordText(saved.keywordText);
        setSearchStatus(saved.searchStatus);
        setSearchError(saved.searchError);
        setSearchFailures(saved.searchFailures);
        setAmazonSearchError(saved.amazonSearchError);
        setSearchSource(saved.searchSource);
        setContinueWithoutResearch(saved.continueWithoutResearch);
        setDraftRestored(true);
        const restoredSite = siteOf(saved.siteKey);
        onSiteChangeRef.current?.({ market: restoredSite.market, language: restoredSite.language });
      })
      .catch(() => {
        if (alive) setDraftStorageError("无法读取本机草稿；当前内容仍可继续，但暂时不能保证切页后恢复。");
      })
      .finally(() => { if (alive) setDraftStorageReady(true); });
    return () => { alive = false; };
  }, [draftStorageKey, initialRecord]);
  useEffect(() => {
    if (!draftStorageReady || initialRecord) return;
    if (step === 2 && result) {
      void removeGuidedDraft(draftStorageKey).catch(() => {
        if (mounted.current) setDraftStorageError("已生成结果，但未能清除本机旧草稿。可从“我的结果”打开已保存版本。");
      });
      return;
    }
    const snapshot: GuidedDraftSnapshot = {
      schema: 1,
      step: step === 1 ? 1 : 0,
      siteKey,
      prompt,
      merchantText,
      materialDraft,
      materialContext,
      appliedMaterial,
      analysisInputFingerprint,
      reference,
      image,
      imageName,
      productId,
      analysis,
      name,
      material,
      facts,
      specs,
      originalFingerprint,
      confirmed,
      query,
      research,
      selected,
      terms,
      keywordText,
      searchStatus: searchStatus === "loading" ? (research ? "available" : "not_requested") : searchStatus,
      searchError,
      searchFailures,
      amazonSearchError,
      searchSource,
      continueWithoutResearch,
    };
    const timer = window.setTimeout(() => {
      void writeGuidedDraft(draftStorageKey, snapshot)
        .then(() => { if (mounted.current) setDraftStorageError(""); })
        .catch(() => { if (mounted.current) setDraftStorageError("本机草稿保存失败；当前内容仅保留在此页面内存中。"); });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [draftStorageReady, initialRecord, draftStorageKey, step, siteKey, prompt, merchantText, materialDraft, materialContext, appliedMaterial, analysisInputFingerprint, reference, image, imageName, productId, analysis, name, material, facts, specs, originalFingerprint, confirmed, query, research, selected, terms, keywordText, searchStatus, searchError, searchFailures, amazonSearchError, searchSource, continueWithoutResearch, result]);
  // 出结果就去取同类对照。基线没随包就整块不显示——不拿半截数据凑一份结论。
  useEffect(() => {
    const { marketplace: resultMarket, language: resultLanguage } = listingScope(result);
    if (!result || resultMarket !== "US" || resultLanguage !== "en") {
      setBenchmark(null);
      return;
    }
    setBenchmark(null);
    let alive = true;
    api<BenchmarkView>(
      `/api/listings/${result.listing_id}/benchmark?version=${result.version}&marketplace=${resultMarket}&language=${resultLanguage}`,
    )
      .then((data) => {
        if (alive) setBenchmark(data.supported !== false && data.facts?.length ? data : null);
      })
      .catch(() => {
        if (alive) setBenchmark(null);
      });
    return () => {
      alive = false;
    };
  }, [result]);
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [Boolean(busy)]);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [step]);
  useEffect(() => {
    onWorkingChange(Boolean(busy) || Boolean(pendingRun) || materialsWorking);
  }, [Boolean(busy), Boolean(pendingRun), materialsWorking, onWorkingChange]);
  useEffect(() => () => onWorkingChange(false), [onWorkingChange]);

  const currentFingerprint = JSON.stringify({ name, material, facts, specs });
  const selectedTerms = research
    ? terms
    : [
        ...new Set(
          keywordText
            .split(/[\n,，;；]+/)
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ];

  const selectionError = guidedSelectionError(Boolean(research), selected, selectedTerms);

  async function searchCompetitors(
    search: string,
    source: "amazon" | "official_public" = "amazon",
  ) {
    if (busyLock.current) return;
    const ticket = ++searchTicket.current;
    setSearchStatus("loading");
    setSearchError("");
    setSearchFailures([]);
    if (source === "amazon") setAmazonSearchError("");
    setSearchSource(source);
    setContinueWithoutResearch(false);
    setResearch(null);
    setSelected([]);
    setTerms([]);
    try {
      const found = await post<Research>("/api/research/search", {
        query: search,
        ...(source === "official_public" ? { source } : {}),
      });
      if (!mounted.current || ticket !== searchTicket.current) return;
      setSearchFailures(found.failures || []);
      if (!found.items.length)
        throw new Error("这次没有取得可用的同类商品。可以调整检索词后重试。");
      const defaultKeys = found.items.slice(0, 1).map(candidateKey);
      setResearch(found);
      setSelected(defaultKeys);
      setTerms(
        found.terms
          .filter((item) => termMatches(item, defaultKeys))
          .slice(0, 8)
          .map((item) => item.term),
      );
      setSearchStatus("available");
    } catch (cause) {
      if (!mounted.current || ticket !== searchTicket.current) return;
      setSearchError((cause as Error).message);
      if (source === "amazon") setAmazonSearchError((cause as Error).message);
      setSearchStatus("failed");
    }
  }

  async function next() {
    if (busyLock.current || materialsWorking) return;
    setError("");
    setNotice("");
    if (!product && merchantText.length > 60000) {
      setError("商品资料文字超过 60,000 字符，请保留本商品相关内容或分次整理。");
      return;
    }
    if (!product && materialDraft.files.length > 0 && !materialDraft.applied) {
      setError("请先提取并核对工厂资料，确认属于同一商品后点击「使用这些资料」；也可以移除文件，只使用商品资料文字。");
      return;
    }
    if (mode === "improve" && !prompt.trim()) {
      setError("先粘贴你正在用的提示词。已有成稿可以使用下方的文案检查入口。");
      return;
    }
    if (!product && !merchantText.trim() && !reference.trim() && !image) {
      setError("提供一段商品说明、商品链接或图片，也可以选择已有商品档案。");
      return;
    }
    if (!modelConfigured) {
      setError("请先在模型设置中配置本机真实模型。");
      return;
    }
    if (!product && image && !hasVision) {
      setError(
        "当前尚未配置图片识别模型。请先移除图片，使用文字、链接或已有档案；也可以在更多功能的研究设置中配置视觉模型。",
      );
      return;
    }
    const inputFingerprint = guidedAnalysisFingerprint({ product, merchantText, reference, image, materialContext });
    if (analysisInputFingerprint === inputFingerprint && originalFingerprint) {
      setStep(1);
      setNotice("商品来源资料未变化，已保留核对内容与手工修改，本次未重复调用识别模型。");
      return;
    }
    busyLock.current = true;
    setBusy(product ? "读取已保存的商品资料" : "识别你提供的商品资料");
    try {
      let nextName = "",
        nextMaterial = "",
        nextFacts = "",
        nextSpecs: Record<string, string> = {},
        nextQuery = "";
      if (product) {
        nextName = product.name_zh;
        nextMaterial = product.material.value || "";
        nextFacts = (product.additional_facts || [])
          .map((fact) => fact.value)
          .join("\n");
        nextSpecs = Object.fromEntries(
          fields.map(([key]) => [key, fieldValue(product, key)]),
        );
        nextQuery = `${product.material.value || "cotton"} tote bag`;
        setAnalysis(null);
      } else {
        const extracted = await post<Analysis>("/api/research/analyze", {
          text: merchantText,
          reference,
          ...(materialContext ? { material_context: materialContext } : {}),
          ...(image ? { image } : {}),
        });
        if (!mounted.current) return;
        setAnalysis(extracted);
        nextName = extracted.name;
        const materialFact = extracted.facts.find((fact) =>
          /材质|材料|material|fabric|cotton/i.test(fact.label),
        );
        nextMaterial = materialFact?.value || "";
        nextFacts = extracted.facts
          .map((fact) => `${fact.label}：${fact.value}`)
          .join("\n");
        nextSpecs = Object.fromEntries(
          fields.map(([key]) => [
            key,
            String(extracted.suggested_fields?.[key] ?? ""),
          ]),
        );
        nextQuery = extracted.search_query || "cotton tote bag";
      }
      setName(nextName);
      setMaterial(nextMaterial);
      setFacts(nextFacts);
      setSpecs(nextSpecs);
      setQuery(nextQuery);
      setOriginalFingerprint(
        JSON.stringify({
          name: nextName,
          material: nextMaterial,
          facts: nextFacts,
          specs: nextSpecs,
        }),
      );
      setAnalysisInputFingerprint(inputFingerprint);
      setConfirmed(false);
      setStep(1);
      busyLock.current = false;
      setBusy("");
      if (mode === "automatic") void searchCompetitors(nextQuery);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      busyLock.current = false;
      setBusy("");
    }
  }

  async function generate() {
    if (busyLock.current || pendingRun) return;
    setError("");
    setRetryable(false);
    if (!confirmed || !name.trim() || !material.trim()) {
      setError(
        "请核对商品名称与材质，并确认本次检查范围。未知材质请先补充真实资料。",
      );
      return;
    }
    if (
      mode === "automatic" &&
      (searchStatus === "loading" || (!research && !continueWithoutResearch))
    ) {
      setError(
        "同类参考尚未完成。检索失败时，请重试或明确选择只按自家资料继续。",
      );
      return;
    }
    if (selectionError) {
      setError(selectionError);
      return;
    }
    busyLock.current = true;
    setBusy("保存已确认的商品信息");
    try {
      let own = product;
      if (!own || currentFingerprint !== originalFingerprint) {
        const confirmed_fields = Object.fromEntries(
          fields.map(([key]) => [
            key,
            ["brand", "color"].includes(key)
              ? specs[key] || ""
              : specs[key]?.trim()
                ? Number(specs[key])
                : null,
          ]),
        );
        for (const [key, value] of Object.entries(confirmed_fields))
          if (
            typeof value === "number" &&
            (!Number.isFinite(value) || value <= 0)
          )
            throw new Error(
              `${fields.find(([field]) => field === key)?.[1]}应为正数；未知请留空。`,
            );
        own = await post<Product>("/api/research/product", {
          name,
          material,
          facts,
          category_confirmed: true,
          confirmed_fields,
          ...(analysis ? { analysis_id: analysis.id } : {}),
        });
        await onRefresh();
      }
      setBusy(
        mode === "improve"
          ? "改进你的提示词，保留可复用的写作要求"
          : "结合商品和参考资料，整理写作要求",
      );
      const built = await post<GuidedPlan>("/api/guided/plan", {
        mode,
        language,
        marketplace: market,
        ...(mode === "improve" ? { prompt } : {}),
        product_id: own.product_id,
        product_revision: own.revision,
        ...(analysis ? { analysis_id: analysis.id } : {}),
        ...(research
          ? {
              research_id: research.id,
              selected_asins: research.items
                .filter(
                  (item) => item.asin && selected.includes(candidateKey(item)),
                )
                .map((item) => item.asin),
              selected_reference_ids: research.items
                .filter(
                  (item) =>
                    item.reference_id && selected.includes(candidateKey(item)),
                )
                .map((item) => item.reference_id),
            }
          : {}),
        selected_terms: selectedTerms,
        research_status: research
          ? "available"
          : searchStatus === "failed"
            ? "failed"
            : "not_requested",
        scope_confirmed: true,
      });
      setPlan(built);
      setBusy(`生成${languageZhOf(language)}草稿，再独立检查商品事实和文本问题`);
      const run = await post<Run>("/api/guided/generate", {
        plan_id: built.id,
        product_id: own.product_id,
        product_revision: own.revision,
        scope_confirmed: true,
      });
      setPendingRun(run);
      await finishRun(run);
    } catch (cause) {
      setError((cause as Error).message);
      // 生成走到这一步才算"跑过但失败"：前面那些校验失败重试也没意义，
      // 只有真跑过一遍才给"用同样的输入再试一次"。
      setRetryable(true);
    } finally {
      busyLock.current = false;
      setBusy("");
    }
  }

  async function finishRun(run: Run) {
    const status = await waitForRun(run.run_id, {
      isActive: () => mounted.current,
      onProgress: (current) => setBusy(current.stage || "正在生成并检查"),
      onUnavailable: setRunStatusNotice,
    });
    if (!status) return;
    if (status.status === "failed") {
      setPendingRun(null);
      throw new Error(
        status.error?.message || "本次生成失败，材料已保留，请重试。",
      );
    }
    // Keep the accepted run locked until its saved version can be read. A failed
    // version read can be resumed without submitting another paid generation.
    const versions = await api<Listing[]>(
      `/api/listings/${run.listing_id}/versions`,
    );
    if (!mounted.current) return;
    const record = versions.find((item) => item.version === status.version);
    if (!record)
      throw new Error("未读到已保存的文案版本，请继续查看运行结果。");
    setResult(record);
    setPendingRun(null);
    setStep(2);
    try {
      await onRefresh();
    } catch {
      if (mounted.current)
        setError("文案已保存，但未能刷新工作台列表。可从“我的结果”查看，请勿重复生成。");
    }
  }
  async function resumeRun() {
    if (!pendingRun || busyLock.current) return;
    busyLock.current = true;
    setError("");
    setBusy("继续读取已提交任务");
    try {
      await finishRun(pendingRun);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      busyLock.current = false;
      setBusy("");
    }
  }

  async function readImage(file?: File) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 3000000) {
      setError("请使用3MB以内的PNG、JPEG或WebP图片。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImage(String(reader.result));
      setImageName(file.name);
      setError("");
    };
    reader.readAsDataURL(file);
  }
  const clearResearch = () => {
    searchTicket.current++;
    setResearch(null);
    setSelected([]);
    setTerms([]);
    setContinueWithoutResearch(true);
    setSearchStatus((previous) =>
      previous === "loading" ? "failed" : previous,
    );
  };
  async function clearDraft() {
    try {
      await removeGuidedDraft(draftStorageKey);
      setDraftStorageError("");
    } catch {
      setDraftStorageError("未能清除本机草稿；请确认后再离开此页面。");
    }
    setDraftRestored(false);
    setStep(0);
    setPrompt("");
    setMerchantText("");
    setMaterialDraft(emptyMaterialDraft());
    setMaterialContext(null);
    setAppliedMaterial(null);
    setAnalysisInputFingerprint("");
    setReference("");
    setImage("");
    setImageName("");
    setProductId("");
    setAnalysis(null);
    setName("");
    setMaterial("");
    setFacts("");
    setSpecs({});
    setOriginalFingerprint("");
    setConfirmed(false);
    setQuery("");
    setResearch(null);
    setSelected([]);
    setTerms([]);
    setKeywordText("");
    setSearchStatus("not_requested");
    setSearchError("");
    setSearchFailures([]);
    setAmazonSearchError("");
    setSearchSource("amazon");
    setContinueWithoutResearch(false);
    setError("");
    setNotice("");
    const nextSite = siteOf(`${initialSite?.market || "US"}-${initialSite?.language || "en"}`);
    setSiteKey(nextSite.key);
    onSiteChangeRef.current?.({ market: nextSite.market, language: nextSite.language });
  }
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${label}已复制。`);
    } catch {
      setError("剪贴板不可用，请选择文本复制或导出。");
    }
  };
  const resultPlan = result?.guided_plan || plan;
  // 看已有结果时按记录自己的语言说"这是什么文案"；只有新草稿才看下拉选的语言。
  // 否则打开一份德语记录，导出按钮却写着"纯英文文案"。
  const resultLanguageZh = languageZhOf(result ? listingScope(result).language : resultPlan?.language || language);
  const resultSite = result
    ? siteOf(`${listingScope(result).marketplace}-${listingScope(result).language}`)
    : site;

  return (
    <div className="guided-workspace" data-testid="guided-workspace">
      {draftStorageError && <p className="helper warm-text" role="alert">{draftStorageError}</p>}
      <button
        className="guided-back text-button"
        disabled={Boolean(busy) || Boolean(pendingRun) || materialsWorking}
        onClick={onHome}
      >
        <ArrowLeft size={15} />
        返回首页
      </button>
      <header className="guided-header">
        <p className="eyebrow">
          {mode === "improve" ? "从已有提示词开始" : "从商品资料开始"}
        </p>
        <h1>
          {step === 2
            ? "这份文案，已经为你整理好"
            : mode === "improve"
              ? "我有提示词，帮我改进"
              : "我没有提示词，帮我完成"}
        </h1>
        <p>
          {step === 2
            ? "先看推荐文案，再处理需要确认的事项。"
            : "每次只做一步，商品事实和原始材料会保留下来。"}
        </p>
      </header>
      <ol className="guided-steps" aria-label="制作步骤">
        {["交材料", "确认商品信息", "查看结果"].map((label, index) => (
          <li
            key={label}
            aria-current={step === index ? "step" : undefined}
            className={step >= index ? "active" : ""}
          >
            <span>{step > index ? <Check size={15} /> : index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      {error && (
        <div className="guided-error" role="alert">
          <span>{error}</span>
          {retryable && !busy && !pendingRun && (
            <button
              className="secondary-button"
              data-testid="guided-retry"
              onClick={() => void generate()}
            >
              用同样的输入再试一次
            </button>
          )}
        </div>
      )}
      {notice && (
        <p className="guided-notice" role="status">
          {notice}
        </p>
      )}
      {runStatusNotice && (
        <p className="guided-notice" role="status">{runStatusNotice}</p>
      )}
      {!!busy && (
        <div className="guided-progress" role="status">
          <LoaderCircle className="spin" size={19} />
          <div>
            <strong>{busy}</strong>
            <small>已用 {elapsed} 秒 · 真实服务处理中，输入已保留</small>
          </div>
        </div>
      )}
      {pendingRun && !busy && (
        <button className="secondary-button" onClick={() => void resumeRun()}>
          继续查看运行结果
        </button>
      )}
      {step === 0 && (
        <section className="panel guided-panel" data-testid="guided-step-input">
          {!draftStorageReady && <p role="status" className="helper">正在读取本机草稿…</p>}
          {draftRestored && <div className="guided-reference-source" role="status">
            已从本机恢复未完成的流程草稿，商品资料、站点和来源选择均已保留。
            <button type="button" className="text-button guided-inline-action" onClick={() => void clearDraft()}>清除草稿并新建</button>
          </div>}
          <fieldset disabled={Boolean(busy) || Boolean(pendingRun) || !draftStorageReady}>
            {mode === "improve" && (
              <>
                <label className="guided-label">
                  你正在用的提示词
                  <textarea
                    aria-label="现有提示词"
                    value={prompt}
                    maxLength={15000}
                    rows={7}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="直接粘贴你的固定模板，中文或英文都可以。"
                  />
                </label>
                <p className="helper">
                  会整理成可复用模板，商品参数单独绑定。已有成稿可
                  <button
                    type="button"
                    className="text-button guided-inline-action"
                    disabled={Boolean(busy) || Boolean(pendingRun)}
                    onClick={() => {
                      if (!busyLock.current && !pendingRun) onLegacy();
                    }}
                  >
                    直接检查文案
                  </button>
                  。
                </p>
              </>
            )}
            <MaterialIntake
              draft={materialDraft}
              onChange={setMaterialDraft}
              disabled={Boolean(busy) || Boolean(pendingRun)}
              onWorkingChange={setMaterialsWorking}
              onUse={(text, context) => {
                try {
                  const adopted = adoptMaterialText(merchantText, text, context, materialContext, appliedMaterial);
                  setMerchantText(adopted.text);
                  setMaterialContext(adopted.context);
                  setAppliedMaterial(adopted.applied);
                  setProductId("");
                  setImage("");
                  setImageName("");
                  setError("");
                  setNotice(adopted.preservedEditedBlock
                    ? "原资料片段已有手工修改，已完整保留并追加本次核对内容；请核对重复或冲突后继续。"
                    : "已采用本次资料，并保留商品资料中的补充说明和已有来源。");
                  return true;
                } catch (cause) {
                  setError((cause as Error).message);
                  return false;
                }
              }}
              onInvalidate={() => {
                setNotice("资料区已修改，商品资料和已采用来源均已保留。重新核对并点击「使用这些资料」后才会应用本次修改。");
              }}
            />
            <label className="guided-label">
              {mode === "improve"
                ? "这次处理哪个商品？"
                : "把你的商品资料交给我"}
              <textarea
                aria-label="商品资料文字"
                value={merchantText}
                maxLength={60000}
                rows={mode === "improve" ? 4 : 7}
                onChange={(e) => {
                  setMerchantText(e.target.value);
                  if (materialContext) setMaterialContext({ ...materialContext, corrected_text: e.target.value });
                }}
                placeholder="粘贴供应商规格、商品说明或你确认过的卖点。未知参数可以不填。"
              />
            </label>
            <div className="guided-input-options">
              <label className="guided-label guided-language">
                站点与文案语言
                <select
                  aria-label="文案语言"
                  data-testid="guided-language"
                  value={siteKey}
                  onChange={(e) => {
                    const next = siteOf(e.target.value);
                    setSiteKey(next.key);
                    // 切站点要连市场一起告诉外层：顶栏、规则页、报告都要跟着变，
                    // 不能只把文案语言改了、规则还按上一个站点算。
                    onSiteChange?.({ market: next.market, language: next.language });
                  }}
                >
                  {GUIDED_SITES.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              {siteKey !== "US-en" && (
                <p className="helper">
                  {site.tier === "internal" && (
                    <>
                      <strong>
                        这一档不能直接上架：
                        {site.language === "zh"
                          ? "平台没有中文 listing，中文稿只用于内部核对（给团队/老板看，或对照原稿校对）。"
                          : "法国要求法语版与外语版同样易读，只出一份英文稿时买家拿不到法语版，所以它只能作翻译对照。"}
                      </strong>
                      <br />
                    </>
                  )}
                  {MARKET_NOTE[site.market] || "站点仍是 Amazon 美国站，只是文案换成所选语言。"}
                  长度限制按所选站点的当前规则包执行。生成时会先压缩次要信息，不会为凑字数编事实；品牌名、型号、单位一律保持原样，不换算。
                </p>
              )}
              <details>
                <summary>使用已有商品档案</summary>
                <label className="guided-label">
                  选择自家商品
                  <select
                    aria-label="使用已有商品档案"
                    value={productId}
                    onChange={(e) => setProductId(e.target.value)}
                  >
                    <option value="">不选择，识别上方提供的资料</option>
                    {realProducts.map((item) => (
                      <option key={item.product_id} value={item.product_id}>
                        {item.name_zh}
                      </option>
                    ))}
                  </select>
                </label>
                {product && (
                  <p className="helper">
                    将使用所选档案，跳过本次文字或图片识别。已有记录不会被覆盖。
                  </p>
                )}
              </details>
              <details>
                <summary>添加商品链接或使用视觉模型看图（可选）</summary>
                <label className="guided-label">
                  自家商品链接
                  <input
                    aria-label="自家商品链接"
                    type="url"
                    value={reference}
                    maxLength={2000}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="Amazon.com 商品链接或 ASIN"
                  />
                </label>
                <input
                  ref={fileInput}
                  type="file"
                  aria-label="上传商品图片"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => {
                    void readImage(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload size={15} />
                  上传图片
                </button>
                {image && (
                  <div className="guided-image">
                    <img src={image} alt="本次上传的商品参考" />
                    <span>{imageName}</span>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setImage("");
                        setImageName("");
                      }}
                    >
                      移除图片
                    </button>
                  </div>
                )}
                <p className="helper">
                  {hasVision
                    ? "图片只用于外观与检索提示，材质、尺寸、认证须来自文字或真实资料。"
                    : "当前未配置图片识别模型，文字、链接或已有档案仍可使用。"}
                </p>
              </details>
            </div>
            <div className="guided-footer">
              <span>当前服务范围：Amazon {MARKET_ZH[market] || "美国站"}棉布手提袋</span>
              <button
                className="primary-button"
                data-testid="guided-next"
                disabled={!modelConfigured || materialsWorking}
                onClick={() => void next()}
              >
                下一步：确认商品信息
                <ArrowRight size={16} />
              </button>
            </div>
            {!modelConfigured && (
              <button className="text-button" onClick={onSettings}>
                先配置本机真实模型
              </button>
            )}
          </fieldset>
        </section>
      )}
      {step === 1 && (
        <section data-testid="guided-step-confirm">
          <section className="panel guided-panel">
            <fieldset disabled={Boolean(busy) || Boolean(pendingRun)}>
              <div className="guided-section-heading">
                <span className="app-icon blue">
                  <CheckCheck size={20} />
                </span>
                <div>
                  <h2>只需确认关键信息</h2>
                  <p>
                    识别结果仍需你确认；未知资料继续留空。本次文案语言：
                    <strong>{languageZhOf(language)}</strong>
                    （页面顶部可改）。
                  </p>
                </div>
              </div>
              <div className="guided-two-columns">
                <label className="guided-label">
                  商品名称
                  <input
                    aria-label="确认商品名称"
                    value={name}
                    maxLength={120}
                    onChange={(e) => {
                      setName(e.target.value);
                      setConfirmed(false);
                    }}
                  />
                </label>
                <label className="guided-label">
                  真实材质
                  <input
                    aria-label="确认商品材质"
                    value={material}
                    maxLength={100}
                    onChange={(e) => {
                      setMaterial(e.target.value);
                      setConfirmed(false);
                    }}
                    placeholder="以真实规格为准"
                  />
                </label>
              </div>
              {fields.some(([key]) => specs[key]?.trim()) && (
                <dl className="guided-known-specs" aria-label="已识别商品参数">
                  {fields
                    .filter(([key]) => specs[key]?.trim())
                    .map(([key, label]) => (
                      <div key={key}>
                        <dt>{label}</dt>
                        <dd>{specs[key]}</dd>
                      </div>
                    ))}
                </dl>
              )}
              <details className="guided-specs">
                <summary>查看与补充商品参数</summary>
                <div className="guided-two-columns">
                  {fields.map(([key, label]) => (
                    <label key={key} className="guided-label">
                      {label}
                      <input
                        aria-label={label}
                        value={specs[key] || ""}
                        onChange={(e) => {
                          setSpecs((old) => ({
                            ...old,
                            [key]: e.target.value,
                          }));
                          setConfirmed(false);
                        }}
                        placeholder="未知留空"
                      />
                    </label>
                  ))}
                </div>
                <label className="guided-label">
                  确认采用的原文事实
                  <textarea
                    aria-label="确认商品原文事实"
                    rows={5}
                    value={facts}
                    onChange={(e) => {
                      setFacts(e.target.value);
                      setConfirmed(false);
                    }}
                  />
                </label>
                {analysis && (
                  <>
                    <p className="helper">已匹配的原文依据：</p>
                    <ul className="guided-evidence">
                      {analysis.facts.map((fact, i) => (
                        <li key={i}>
                          <strong>{fact.label}：</strong>
                          {fact.value}
                          <small>原文：{fact.evidence}</small>
                        </li>
                      ))}
                    </ul>
                    {analysis.missing.length > 0 && (
                      <p className="helper">
                        识别待核：{analysis.missing.join("；")}
                      </p>
                    )}
                  </>
                )}
              </details>
              {mode === "automatic" && (
                <section className="guided-research" aria-label="同类商品参考">
                  <div className="guided-section-heading">
                    <Search size={18} />
                    <div>
                      <h3>同类商品，只作写法参考</h3>
                      <p>参考它们的关键词与结构，不继承参数和认证。</p>
                    </div>
                  </div>
                  <div className="guided-search-row">
                    <input
                      aria-label="同类商品检索词"
                      value={query}
                      maxLength={250}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={
                        searchStatus === "loading" || query.trim().length < 2
                      }
                      onClick={() => void searchCompetitors(query)}
                    >
                      {searchStatus === "loading"
                        ? "正在读取真实商品…"
                        : "重新查找 Amazon 商品"}
                    </button>
                  </div>
                  {searchStatus === "loading" && (
                    <p className="helper" role="status">
                      {searchSource === "official_public"
                        ? "正在读取已登记的两款 Westford Mill 官方公开商品页。"
                        : "正在检索并读取 Amazon 公开商品详情，可能需要一些时间。"}
                    </p>
                  )}
                  {searchError && (
                    <div className="guided-research-error" role="alert">
                      <p>{searchError}</p>
                      <button
                        className="secondary-button"
                        type="button"
                        data-testid="guided-official-references"
                        onClick={() =>
                          void searchCompetitors(query, "official_public")
                        }
                      >
                        改用官方公开商品参考
                      </button>
                      <small>
                        由你选择后，读取当前登记的两款 Westford Mill
                        官方公开商品；不是 Amazon 竞品采集或全市场检索。
                      </small>
                      <button
                        className="text-button"
                        type="button"
                        onClick={clearResearch}
                      >
                        只按自家资料继续
                      </button>
                      <small>本次未取得同类参考，结果会如实记录。</small>
                    </div>
                  )}
                  {continueWithoutResearch && (
                    <p className="helper">
                      已选择只按自家资料继续。本次没有取得或采用同类参考。
                    </p>
                  )}
                  {searchFailures.length > 0 && (
                    <details className="guided-source-failures">
                      <summary>
                        查看未取得的来源与原因（{searchFailures.length}）
                      </summary>
                      <ul>
                        {searchFailures.map((failure, index) => (
                          <li key={`${failure.reference_id}-${index}`}>
                            <strong>
                              {failure.publisher || failure.reference_id}
                            </strong>
                            <p>{failure.message}</p>
                            <small>
                              {failure.code || "读取失败"}
                              {failure.http_status
                                ? ` · HTTP ${failure.http_status}`
                                : ""}
                            </small>
                            <a
                              href={failure.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              查看来源页
                            </a>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {research && (
                    <>
                      <div
                        className="guided-reference-source"
                        data-testid="guided-reference-source"
                      >
                        <strong>
                          参考来源：{referenceProvider(research.provider)}
                        </strong>
                        {research.notice && <p>{research.notice}</p>}
                        {research.provider === "official-public" &&
                          amazonSearchError && (
                            <details>
                              <summary>
                                本次 Amazon 采集未完成，已由你选择官方参考
                              </summary>
                              <p>{amazonSearchError}</p>
                            </details>
                          )}
                        {research.warnings?.map((warning, index) => (
                          <p key={index}>{warning}</p>
                        ))}
                      </div>
                      <div className="guided-candidates">
                        {research.items.map((item) => (
                          <label key={candidateKey(item)}>
                            <input
                              type="checkbox"
                              checked={selected.includes(candidateKey(item))}
                              disabled={!selected.includes(candidateKey(item)) && selected.length >= 5}
                              onChange={(e) => {
                                if (e.target.checked && selected.length >= 5) return;
                                const next = e.target.checked
                                  ? [...selected, candidateKey(item)]
                                  : selected.filter(
                                      (key) => key !== candidateKey(item),
                                    );
                                setSelected(next);
                                setTerms((old) =>
                                  old.filter((term) => {
                                    const source = research.terms.find(
                                      (t) => t.term === term,
                                    );
                                    return Boolean(
                                      source && termMatches(source, next),
                                    );
                                  }),
                                );
                              }}
                            />
                            <span>
                              <strong>{item.title}</strong>
                              <small>
                                {item.reference_id || item.asin} ·{" "}
                                {item.detail_status === "failed"
                                  ? "详情读取失败，谨慎参考"
                                  : "公开商品参考"}
                              </small>
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                查看原页
                              </a>
                            </span>
                          </label>
                        ))}
                      </div>
                      <p className="helper">已选择 {selected.length} / 5 个参考商品。取消一个选择后可更换。</p>
                      <details>
                        <summary>调整参考关键词</summary>
                        <div className="guided-term-options">
                          {research.terms
                            .filter((item) => termMatches(item, selected))
                            .slice(0, 60)
                            .map((item) => (
                              <label key={item.term}>
                                <input
                                  type="checkbox"
                                  checked={terms.includes(item.term)}
                                  disabled={!terms.includes(item.term) && (terms.length >= 60 || item.term.length > 100)}
                                  onChange={(e) =>
                                    setTerms((old) =>
                                      e.target.checked
                                        ? old.length < 60 && item.term.length <= 100 ? [...old, item.term] : old
                                        : old.filter(
                                            (term) => term !== item.term,
                                          ),
                                    )
                                  }
                                />
                                {item.term}
                              </label>
                            ))}
                        </div>
                        <p className="helper">
                          已选择 {terms.length} / 60 个关键词；每个最多 100 字符。词条来自取得的公开文案，出现频次不等于搜索量。
                        </p>
                      </details>
                      <button
                        className="text-button"
                        type="button"
                        onClick={clearResearch}
                      >
                        本次不采用这些参考
                      </button>
                    </>
                  )}
                </section>
              )}
              {mode === "improve" && (
                <details>
                  <summary>补充希望保留的关键词（可选）</summary>
                  <textarea
                    aria-label="引导关键词"
                    value={keywordText}
                    maxLength={6000}
                    rows={3}
                    onChange={(e) => setKeywordText(e.target.value)}
                    placeholder="每行一个词组。只使用有本商品资料支持的词。"
                  />
                </details>
              )}
              {selectionError && <p className="guided-error" role="alert" data-testid="guided-selection-error">{selectionError}</p>}
              <label className="guided-confirm">
                <input
                  type="checkbox"
                  aria-label="确认当前商品信息与检查范围"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>
                  我已核对商品信息，确认本次用于
                  {MARKET_ZH[market] || "美国站"}棉布手提袋
                  <small>来源材料和竞品词条不能代替自家商品事实。</small>
                </span>
              </label>
              <div className="guided-footer">
                <button className="text-button" onClick={() => setStep(0)}>
                  <ArrowLeft size={15} />
                  上一步
                </button>
                <button
                  className="primary-button"
                  data-testid="guided-generate"
                  disabled={
                    !confirmed ||
                    !name.trim() ||
                    !material.trim() ||
                    Boolean(selectionError) ||
                    searchStatus === "loading" ||
                    (mode === "automatic" &&
                      !research &&
                      !continueWithoutResearch)
                  }
                  onClick={() => void generate()}
                >
                  生成并检查
                  <ArrowRight size={16} />
                </button>
              </div>
              <p className="helper">
                将真实整理提示词、生成文案并独立审核；按模型实际用量计费，失败重试可能增加调用。
              </p>
            </fieldset>
          </section>
        </section>
      )}
      {step === 2 && result && (
        <section data-testid="guided-step-result" className="guided-result">
          {resultSite.tier === "internal" && (
            <p className="guided-reference-source" data-testid="guided-internal-notice">
              此稿用于内部核对或翻译对照，不能直接用于上架。导出会保留原语言，不会自动生成可上架的主体语言版本。
            </p>
          )}
          {resultPlan?.research_context?.provider && (
            <div
              className="guided-reference-source"
              data-testid="guided-result-reference-source"
            >
              <strong>
                本次参考来源：
                {referenceProvider(resultPlan.research_context.provider)}
              </strong>
              {resultPlan.research_context.notice && (
                <p>{resultPlan.research_context.notice}</p>
              )}
            </div>
          )}
          {resultPlan?.research_status === "failed" && (
            <p className="guided-reference-source">
              本次未取得同类参考，已按你确认的自家商品资料继续。
            </p>
          )}
          <section className="panel guided-panel">
            <div className="guided-section-heading">
              <span className="app-icon blue">
                <FileText size={20} />
              </span>
              <div>
                <h2>
                  推荐文案
                  <span className="tiny-badge" style={{ marginLeft: 8 }}>
                    {resultSite.label}
                  </span>
                </h2>
                <p>已保存 V{result.version}，原始资料和审阅结果随版本保留。</p>
              </div>
            </div>
            <div className="guided-copy">
              <h3>{result.content.title}</h3>
              {result.content.item_highlights && (
                <p>{result.content.item_highlights}</p>
              )}
              <ul>
                {result.content.bullet_points.map((item) => (
                  <li key={item.id}>{item.text}</li>
                ))}
              </ul>
              <p>{result.content.description}</p>
            </div>
            <div className="guided-result-actions">
              <button
                className="primary-button"
                onClick={() =>
                  void copy(
                    [
                      result.content.title,
                      result.content.item_highlights,
                      ...result.content.bullet_points.map((item) => item.text),
                      result.content.description,
                    ]
                      .filter(Boolean)
                      .join("\n\n"),
                    `${resultLanguageZh}文案`,
                  )
                }
              >
                <Copy size={16} />
                复制文案
              </button>
              <a
                className="secondary-button"
                href={`/api/listings/${result.listing_id}/export?version=${result.version}&format=copy`}
              >
                <Download size={16} />
                导出文案
              </a>
            </div>
            {/* 五种导出格式和各自说明原来只在老工作台的弹窗里，三步流程走到这一步只有一个按钮，
                评委问"还有别的格式吗"答不上来。这里把同一批格式和同样的说明摊开。 */}
            <details className="guided-exports" data-testid="guided-exports">
              <summary>更多导出格式（五种，都不是同一份东西）</summary>
              <ul>
                {[
                  {
                    format: "copy",
                    title: `纯${resultLanguageZh}文案`,
                    text: resultSite.tier === "internal"
                      ? "只有标题、亮点、五点、描述，供内部核对或翻译对照，不能直接上架"
                      : "只有标题、亮点、五点、描述；核对待确认项后由运营使用",
                  },
                  {
                    format: "txt",
                    title: `${resultLanguageZh}文案与审阅说明`,
                    text: "对客内容与内部说明分段保留",
                  },
                  {
                    format: "worklist",
                    title: "改稿工作单",
                    text: "按文案顺序逐条列原文与标准改法，给写手用",
                  },
                  {
                    format: "html",
                    title: "可打印审阅报告",
                    text: "依据、问题、缺失项与文案在一页，给评审/客户看",
                  },
                  {
                    format: "json",
                    title: "完整结构化结果",
                    text: "商品快照、检查、版本与调用信息，给系统对接",
                  },
                ].map(({ format, title, text }) => (
                  <li key={format}>
                    <a
                      href={`/api/listings/${result.listing_id}/export?version=${result.version}&format=${format}${format === "worklist" || format === "html" ? "&disposition=inline" : ""}`}
                      {...(format === "worklist" || format === "html"
                        ? { target: "_blank", rel: "noreferrer" }
                        : { download: true })}
                    >
                      <strong>{title}</strong>
                      <small>{text}</small>
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          </section>
          <section className="panel guided-panel guided-pending">
            <h2>需要你确认</h2>
            {!result.review.issues.length && (
              <p>本次已执行的检查未发现内容问题，请继续核对缺失资料。</p>
            )}
            <ul>
              {result.review.issues.map((issue) => (
                <li key={issue.issue_id}>
                  <strong>{issue.original || issue.title}</strong>
                  <p>{issue.reason}</p>
                  <small>{issue.suggestion}</small>
                  {/* 结果页原来只有「为什么」和「怎么改」，没有「凭什么」。
                      规则原文和发布方在老界面的 IssueCard 里能点开，这里补上同一个入口。 */}
                  {issue.source_ids?.length ? (
                    <button
                      className="text-button"
                      onClick={() => onSources(issue.source_ids)}
                    >
                      看这条规则的依据原文
                    </button>
                  ) : null}
                </li>
              ))}
              {result.review.missing_data.map((item) => (
                <li key={item.field}>
                  <strong>{item.label}</strong>
                  <p>{item.reason}</p>
                </li>
              ))}
              {result.review.checks
                .filter((check) =>
                  ["not_checked", "error"].includes(check.state),
                )
                .map((check) => (
                  <li key={check.rule_id}>
                    <strong>尚未完成检查</strong>
                    <p>{check.reason}</p>
                  </li>
                ))}
            </ul>
            <button
              className="secondary-button"
              onClick={() => onAdvanced(result)}
            >
              处理问题与局部改稿
              <ArrowRight size={16} />
            </button>
          </section>
          {benchmark && (
            <details className="panel guided-benchmark">
              <summary>
                历史样本写法对照
                {benchmark.baseline ? `（${benchmark.baseline.n} 条）` : ""}
                {benchmark.attention > 0 ? (
                  <span className="guided-benchmark-count">
                    {benchmark.attention} 处差异
                  </span>
                ) : null}
              </summary>
              <p className="helper">
                {benchmark.attention === 0
                  ? "在已对照的几项上，与这份历史快照没有明显差异。"
                  : `有 ${benchmark.attention} 处写法与这份历史快照不同，下面逐条列出。`}
              </p>
              <p className="helper">
                队友提供历史聚合快照，原始样本待补；不代表当前市场或其他站点、语言的写法。
                {benchmark.notice ? ` ${benchmark.notice}` : ""}
              </p>
              <ul className="guided-benchmark-list">
                {benchmark.facts.map((fact, index) => (
                  <li key={`${fact.level}-${index}`} className={`bench-${fact.level}`}>
                    <strong>
                      {BENCH_MARK[fact.level] || "·"}{" "}
                      {BENCH_VERDICT[fact.level] || fact.level}
                    </strong>
                    <span>{fact.sentence}</span>
                  </li>
                ))}
              </ul>
              {benchmark.baseline && (
                <p className="helper">
                  口径：{benchmark.baseline.category} /{" "}
                  {benchmark.baseline.marketplace}，
                  {benchmark.baseline.method}（{benchmark.baseline.excludes}）。
                  样本只有 {benchmark.baseline.n} 条，说的是「这一批商品大多怎么写」，
                  不是整个市场的结论；同类这么写也不等于这么做就对。
                </p>
              )}
            </details>
          )}
          {resultPlan && (
            <details className="panel guided-plan">
              <summary>
                <Sparkles size={16} />
                查看改进后的提示词
              </summary>
              <p className="helper">
                参数与关键词以占位符保留，复用时重新绑定本次商品资料。
              </p>
              <pre>{resultPlan.optimized_prompt}</pre>
              {resultPlan.changes?.length > 0 && (
                <ul>
                  {resultPlan.changes.map((change, i) => (
                    <li key={i}>{change}</li>
                  ))}
                </ul>
              )}
              <button
                className="secondary-button"
                onClick={() => void copy(resultPlan.optimized_prompt, "提示词")}
              >
                <Copy size={15} />
                复制可复用提示词
              </button>
            </details>
          )}
          <details className="guided-advanced">
            <summary>完整报告与来源</summary>
            <p>
              完整审阅包含来源、检查范围、版本差异和实际模型调用记录。导出不表示
              Amazon 已接收或已经上架。
            </p>
            <div className="guided-result-actions">
              <a
                className="secondary-button"
                href={`/api/listings/${result.listing_id}/export?version=${result.version}&format=html`}
              >
                下载审阅报告
              </a>
              <button
                className="text-button"
                onClick={() => onAdvanced(result)}
              >
                打开完整工作区
              </button>
            </div>
          </details>
        </section>
      )}
    </div>
  );
}
