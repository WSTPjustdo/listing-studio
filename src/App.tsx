import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  BookOpen,
  Boxes,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  Copy,
  FileClock,
  FilePenLine,
  FileSearch,
  FileText,
  FolderOpen,
  Globe2,
  History,
  House,
  Layers3,
  ListChecks,
  Link2,
  LoaderCircle,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  SearchCheck,
  Settings2,
  ShieldCheck,
  Sparkles,
  Table2,
  WandSparkles,
  X,
} from "lucide-react";
import { api, post } from "./api";
import { createRequestId } from "./requestId";
import { waitForRun } from "./runPolling";
import { listingScope } from "./listingScope";
import AmazonImport, { AmazonSource } from "./AmazonImport";
import WorkspaceHome, { incompleteChecks, reviewState } from "./WorkspaceHome";
import BatchWorkspace from './BatchWorkspace';
import ResearchWorkspace from './ResearchWorkspace';
import ReviewActions from './ReviewActions';
import { groupReviewIssues } from './reviewGroups';
import RevisionComposer from './RevisionComposer';
import ProductCompleteness from './ProductCompleteness';
import { GpsrPartyFields, GpsrPartiesView, blankParty, partyDraftFrom, partyFilled } from './GpsrParties';
import ProductSourceEditor, { editableExtras } from './ProductSourceEditor';
import type { ExtraFactInput, FactBindings } from './ProductSourceEditor';
import { factLabels, factText, issueKind, outstandingText, requestedEvidence, sourceExcerpt, productSourceIds } from './merchant';
import EvidenceSubmission from './EvidenceSubmission';
import ContentBrief, { defaultBrief } from './ContentBrief';
import ListingLibrary from './ListingLibrary';
// 多版本趋势（第 15 轮自提 86）：判断在服务端算，这里只画。
import { VersionTrend } from './VersionTrend';
import ParameterCoverage from './ParameterCoverage';
import IntakePanel from './IntakePanel';
import AplusPanel from './AplusPanel';
import VocPanel from './VocPanel';
import KeywordsPanel from './KeywordsPanel';
import VariantsPanel from './VariantsPanel';
import RolesPanel from './RolesPanel';
import ReadinessPanel from './ReadinessPanel';
import VariationPanel from './VariationPanel';
import EvidenceLifecyclePanel from './EvidenceLifecyclePanel';
import RuleMonitor from './RuleMonitor';
import IntakeRecordContext from './IntakeRecordContext';
import GuidedWorkspace from './GuidedWorkspace';
import type { GuidedMode } from './GuidedWorkspace';
import { emptyIntakeDraft } from './intake';
import type {
  Bootstrap,
  Content,
  Issue,
  Listing,
  Product,
  Run,
  Rule,
  RuleCitation,
  Settings,
  Source,
  View,
} from "./types";

/**
 * 站点 = 市场 + 语言，一个下拉选一个，发请求时拆成两个字段。
 * 不把「站点」和「语言」混成一个值：德国站德语和美国站西语是两回事，
 * 规则包按 market 取，文案按 language 写，分开才能各自正确。
 * 默认仍是美国站-英语（与改造前一致）。
 */
const SITE_OPTIONS = [
  {
    value: "US-en",
    market: "US",
    language: "en",
    tier: "primary",
    label: "美国站 · 英语",
    marketLabel: "Amazon US",
    marketZh: "美国",
    languageShort: "英文",
    languageZh: "英文",
    promptZh: "将商品资料转化为有依据、符合美国市场表达习惯的英文内容。",
  },
  {
    value: "US-es",
    market: "US",
    language: "es",
    tier: "listing",
    label: "美国站 · 西班牙语",
    marketLabel: "Amazon US",
    marketZh: "美国",
    languageShort: "西班牙语",
    languageZh: "西班牙文",
    promptZh: "将商品资料转化为有依据、符合美国市场表达习惯的西班牙文内容。",
  },
  {
    value: "US-zh",
    market: "US",
    language: "zh",
    tier: "internal",
    label: "美国站 · 中文（内部核对）",
    marketLabel: "Amazon US",
    marketZh: "美国",
    languageShort: "中文",
    languageZh: "中文",
    promptZh: "将商品资料转化为有依据的中文内容，供内部核对。",
  },
  {
    value: "DE-de",
    market: "DE",
    language: "de",
    tier: "primary",
    label: "德国站 · 德语",
    marketLabel: "Amazon DE",
    marketZh: "德国",
    languageShort: "德语",
    languageZh: "德文",
    promptZh: "将商品资料转化为有依据、符合德国市场表达习惯的德文内容。",
  },
  {
    value: "DE-en",
    market: "DE",
    language: "en",
    tier: "listing",
    label: "德国站 · 英语",
    marketLabel: "Amazon DE",
    marketZh: "德国",
    languageShort: "英语",
    languageZh: "英文",
    promptZh: "将商品资料转化为有依据、符合德国市场表达习惯的英文内容。",
  },
  {
    value: "DE-zh",
    market: "DE",
    language: "zh",
    tier: "internal",
    label: "德国站 · 中文（内部核对）",
    marketLabel: "Amazon DE",
    marketZh: "德国",
    languageShort: "中文",
    languageZh: "中文",
    promptZh: "将商品资料转化为有依据的中文内容，供内部核对。",
  },
  {
    value: "UK-en",
    market: "UK",
    language: "en",
    tier: "primary",
    label: "英国站 · 英语（英式）",
    marketLabel: "Amazon UK",
    marketZh: "英国",
    languageShort: "英文",
    languageZh: "英文",
    promptZh: "将商品资料转化为有依据、符合英国市场表达习惯的英文内容。",
  },
  {
    value: "UK-zh",
    market: "UK",
    language: "zh",
    tier: "internal",
    label: "英国站 · 中文（内部核对）",
    marketLabel: "Amazon UK",
    marketZh: "英国",
    languageShort: "中文",
    languageZh: "中文",
    promptZh: "将商品资料转化为有依据的中文内容，供内部核对。",
  },
  {
    value: "FR-fr",
    market: "FR",
    language: "fr",
    tier: "primary",
    label: "法国站 · 法语",
    marketLabel: "Amazon FR",
    marketZh: "法国",
    languageShort: "法语",
    languageZh: "法文",
    promptZh: "将商品资料转化为有依据、符合法国市场表达习惯的法文内容。",
  },
  {
    value: "FR-en",
    market: "FR",
    language: "en",
    tier: "internal",
    label: "法国站 · 英语（对照，不上架）",
    marketLabel: "Amazon FR",
    marketZh: "法国",
    languageShort: "英语",
    languageZh: "英文",
    promptZh: "将商品资料转化为有依据的英文内容，作为法文稿的翻译对照。",
  },
] as const;
type SiteKey = (typeof SITE_OPTIONS)[number]["value"];
const siteOf = (key: SiteKey) =>
  SITE_OPTIONS.find((option) => option.value === key) ?? SITE_OPTIONS[0];

/**
 * 规则页写「这是哪个站的包」时，看服务端实际下发的包，不看下拉选了什么。
 * 切换站点要重新拉 bootstrap，请求没回来之前下拉已经是德国站、包还是美国包，
 * 按包标注才不会出现「标题写德国站、下面列着美国规则」。
 */
function marketName(market?: string) {
  if (market === "DE") return { label: "Amazon DE", zh: "德国" };
  if (market === "US") return { label: "Amazon US", zh: "美国" };
  if (market === "UK") return { label: "Amazon UK", zh: "英国" };
  if (market === "FR") return { label: "Amazon FR", zh: "法国" };
  return { label: market ? `Amazon ${market}` : "站点未标注", zh: market || "该站" };
}
const packMarketName = (pack: { scope?: { marketplace?: string } }) =>
  marketName(pack.scope?.marketplace);

/**
 * 语言名只用于说清「这份内容是哪种语言」。
 * 生成时用下拉选的语言；看已有结果时用那条记录自己记下的语言 ——
 * 切了站点不该把旧结果的导出标题改成新语言。
 */
const LANGUAGE_ZH: Record<string, string> = {
  en: "英文",
  es: "西班牙文",
  zh: "中文",
  de: "德文",
  fr: "法文",
};
const languageZhOf = (language?: string) =>
  LANGUAGE_ZH[language || "en"] ?? language ?? "英文";

/**
 * 文案区上方那行「English · United States」。
 * 原来写死英文美国，选了德国站还是这么写，等于告诉用户"这是英文"。
 * 看已有结果时按**这条记录自己的语言**，新草稿按下拉选的语言。
 */
const LOCALE_LABEL: Record<string, string> = {
  en: "English",
  es: "Español",
  zh: "中文",
  de: "Deutsch",
  fr: "Français",
};
const MARKET_LABEL: Record<string, string> = { US: "United States", DE: "Deutschland", UK: "United Kingdom", FR: "France" };
const localeLabelOf = (language?: string, marketplace?: string) =>
  `${LOCALE_LABEL[language || "en"] ?? language ?? ""} · ${MARKET_LABEL[marketplace || "US"] ?? marketplace ?? ""}`;

/**
 * 字段上限只从当前规则包读，代码里不再写 75 / 125。
 * 包里没写（或写错字段名）就返回 undefined —— 界面上就不显示上限，
 * 而不是拿一个我们没核对过的经验值充数。
 */
function ruleCharLimit(rules: Rule[], ruleId: string): number | undefined {
  const value = rules.find((rule) => rule.rule_id === ruleId)?.constraint
    ?.max_characters;
  return typeof value === "number" ? value : undefined;
}

const emptyContent = (): Content => ({
  title: "",
  item_highlights: "",
  bullet_points: [1, 2, 3, 4, 5].map((i) => ({ id: `b${i}`, text: "" })),
  description: "",
});
const fieldLabel = (path: string) =>
  path === "content.title"
    ? "商品标题"
    : path === "content.item_highlights"
      ? "商品亮点"
      : path === "content.description"
        ? "商品描述"
        : `商品要点 ${path.split(".").at(-1)?.replace("b", "") || ""}`;
const count = (text: string) => [...text].length;
const measurement = (value: number | null, unit: string) => value === null ? "未披露" : `${value} ${unit}`;
const dimensionsText = (product: Product) => product.dimensions_cm.value
  ? `${product.dimensions_cm.value.width} × ${product.dimensions_cm.value.height}${typeof product.dimensions_cm.value.depth === "number" ? ` × ${product.dimensions_cm.value.depth}` : ""} cm`
  : "见来源原始尺寸 / 未披露";
/**
 * 设置页要显示的完整请求地址。规则与服务端 providers.mjs 的 chatUrl 一致：
 * 去掉结尾斜杠；已经写到 /chat/completions 就原样用，否则补上这一段。
 * 放在前端是因为它要跟着输入框逐字变——每次敲键都打一次接口不值当。
 */
const previewEndpoint = (base: string) => {
  const trimmed = (base || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
};
const validHttpEndpoint = (base: string) => {
  try { const url = new URL(base); return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname); }
  catch { return false; }
};
const time = (date: string) =>  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
const methodLabel = (method: string) =>
  ({
    deterministic: "程序检查",
    model_assisted: "模型辅助",
    local_heuristic: "本地候选规则",
    local_template: "本地模板",
  })[method] || method;

function BagIllustration({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      className={compact ? "bag-illustration compact" : "bag-illustration"}
      viewBox="0 0 200 170"
      role="img"
      aria-label="棉布袋规格示意图，非商品实拍"
    >
      <defs>
        <linearGradient id="bag-fill" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#e7dbc2" />
          <stop offset="1" stopColor="#cdbd9e" />
        </linearGradient>
        <pattern
          id="bag-weave"
          width="3"
          height="3"
          patternUnits="userSpaceOnUse"
        >
          <path d="M0 1.5h3M1.5 0v3" stroke="#a99879" strokeWidth=".2" />
        </pattern>
      </defs>
      <ellipse cx="104" cy="151" rx="59" ry="7" fill="#d7dfd6" opacity=".5" />
      <path
        d="M70 54V35c0-30 56-30 56 0v19"
        fill="none"
        stroke="#baab8b"
        strokeWidth="9"
      />
      <path
        d="M75 54V35c0-23 46-23 46 0v19"
        fill="none"
        stroke="#e6d9bd"
        strokeWidth="5"
      />
      <path d="M44 47l111-2 7 101c-28 10-79 10-119 1z" fill="url(#bag-fill)" />
      <path d="M44 47l111-2 7 101c-28 10-79 10-119 1z" fill="url(#bag-weave)" />
      <path
        d="M49 51l101-2 7 93c-36 7-68 7-109 0z"
        fill="none"
        stroke="#bdad8d"
        strokeWidth="1"
        strokeDasharray="2 2"
      />
      <path d="M68 50l1 24m58-24v23" stroke="#a59474" strokeWidth="2" />
      <rect
        x="89"
        y="90"
        width="29"
        height="32"
        rx="1"
        fill="#f4eddd"
        opacity=".65"
      />
      <path d="M97 100h13m-13 5h9m-9 5h12" stroke="#879982" strokeWidth="1.5" />
    </svg>
  );
}

function Modal({
  title,
  subtitle,
  children,
  onClose,
  onBeforeClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  onBeforeClose?: () => boolean;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const requestCloseRef = useRef<() => void>(() => {});
  const closeTimer = useRef<number | null>(null);
  const [closing, setClosing] = useState(false);
  closeRef.current = onClose;
  requestCloseRef.current = () => {
    if (closing) return;
    if (onBeforeClose && !onBeforeClose()) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      closeRef.current();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(() => closeRef.current(), 170);
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const handler = (e: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== ref.current) return;
      if (e.key === "Escape") requestCloseRef.current();
      if (e.key === "Tab") {
        const nodes = [...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
        ) || [])].filter(node => node.offsetParent !== null);
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (document.activeElement === ref.current) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
        else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handler);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      document.body.style.overflow = old;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className={`modal-backdrop ${closing ? "is-closing" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestCloseRef.current();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""} ${closing ? "is-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="关闭" onClick={() => requestCloseRef.current()}>
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [view, setView] = useState<View>("home");
  const [guidedMode, setGuidedMode] = useState<GuidedMode>('improve');
  const [guidedRecord, setGuidedRecord] = useState<Listing | null>(null);
  const [guidedSession, setGuidedSession] = useState(0);
  const [guidedBusy, setGuidedBusy] = useState(false);
  const [moreNavigation, setMoreNavigation] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [productId, setProductId] = useState("");
  // 「不关联，仅检查文本」是用户做过的一次选择，不能被随后的 refresh 悄悄改回去。
  // 这个 ref 记的就是"用户/记录已经给出了关联意图"，空字符串也算数（空=明确不关联）。
  const productPinned = useRef(false);
  const [draft, setDraft] = useState<Content>(emptyContent);
  const [intakeDraft, setIntakeDraft] = useState(emptyIntakeDraft);
  const [current, setCurrent] = useState<Listing | null>(null);
  const [versions, setVersions] = useState<Listing[]>([]);
  const [tab, setTab] = useState<"editor" | "review" | "versions">("editor");
  const [purpose, setPurpose] = useState(
    "日常携带，表达简洁自然，保留准确规格。",
  );
  const [instruction, setInstruction] = useState("");
  const [revisionScope, setRevisionScope] = useState('all');
  const [contentBrief, setContentBrief] = useState(defaultBrief);
  const [busy, setBusy] = useState<Run | null>(null);
  const executing = useRef(false);
  const [runStatusNotice, setRunStatusNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    error?: boolean;
  } | null>(null);
  const [fatal, setFatal] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState<string[] | null>(null);
  const [runsOpen, setRunsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [aplusOpen, setAplusOpen] = useState(false);
  const [vocOpen, setVocOpen] = useState(false);
  const [keywordOpen, setKeywordOpen] = useState(false);
  const [variantsOpen, setVariantsOpen] = useState(false);
  const [variantsAdopting, setVariantsAdopting] = useState(false);
  const [variantsGenerating, setVariantsGenerating] = useState(false);
  const navigationLocked = guidedBusy || variantsGenerating || variantsAdopting;
  const [rolesOpen, setRolesOpen] = useState(false);
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [variationOpen, setVariationOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [highlight, setHighlight] = useState("");
  const [selectedPatches, setSelectedPatches] = useState<string[]>([]);
  const [previewPatches, setPreviewPatches] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("all");
  // 老创建页的产出语言：只影响写哪种语言，规则上限不变。
  const [siteKey, setSiteKey] = useState<SiteKey>("US-en");
  const site = siteOf(siteKey);
  const outputLanguage = site.language;
  const outputMarket = site.market;
  const outputMarketRef = useRef(outputMarket);
  outputMarketRef.current = outputMarket;
  const [issueFilter, setIssueFilter] = useState("all");
  const [factsOpen, setFactsOpen] = useState(false);
  const [evidenceEditing, setEvidenceEditing] = useState(false);
  const [factsIssue, setFactsIssue] = useState<Issue | null>(null);
  const [factsEditing, setFactsEditing] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  // 等模型的时候要有"时间感"：遮罩上那个秒数就是它。
  const busyStartedAt = useRef(0);
  const [, setBusyTick] = useState(0);

  useEffect(() => {
    if (view !== "ruleMonitor") return;
    const mobile = window.matchMedia("(max-width: 760px)");
    const closeMobileMenu = () => {
      if (mobile.matches) setMoreNavigation(false);
    };
    closeMobileMenu();
    mobile.addEventListener("change", closeMobileMenu);
    return () => mobile.removeEventListener("change", closeMobileMenu);
  }, [view]);

  const notify = (message: string, error = false) => {
    setToast({ message, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  };
  async function refresh() {
    const requestedMarket = outputMarketRef.current;
    const result = await api<Bootstrap>(`/api/bootstrap?marketplace=${requestedMarket}`);
    setData(previous => requestedMarket === outputMarketRef.current || !previous
      ? result
      : { ...result, rules: previous.rules, rule_citations: previous.rule_citations });
    // 只有在用户还没表达过关联意图时才补一个默认商品。
    // 原来的写法 `previous || first` 会把用户刚选的「不关联」在下一次刷新时改回第一个商品，
    // 结果是：审核按"仅文本"算的，右栏却显示着档案——15 条和 21 条就是这么混起来的。
    setProductId(
      (previous) =>
        productPinned.current ? previous : previous || result.products[0]?.product_id || "",
    );
    return result;
  }
  /*
   * 切站点时只换规则：/api/bootstrap?marketplace=DE 拿德国包与本页引用。
   * 不整份重刷的原因：refresh() 会顺手改 productId，而用户可能刚手动选了「不关联」。
   * 规则页的条数、输入框上限、每条的依据都跟着这份数据走，所以必须真的换掉。
   */
  useEffect(() => {
    let alive = true;
    api<Bootstrap>(`/api/bootstrap?marketplace=${outputMarket}`)
      .then((result) => {
        if (!alive) return;
        setData((previous) =>
          previous
            ? { ...previous, rules: result.rules, rule_citations: result.rule_citations }
            : previous,
        );
      })
      .catch(() => {
        notify("未取得所选站点的规则，暂时保留上一份规则；请重试后核对规则页的站点。", true);
      });
    return () => {
      alive = false;
    };
  }, [outputMarket]);
  useEffect(() => {
    mounted.current = true;
    refresh().catch((error) => setFatal(error.message));
    return () => {
      mounted.current = false;
    };
  }, []);
  const product =
    data?.products.find((x) => x.product_id === productId) || null;
  const displayProduct = current?.product_snapshot || product;
  const availablePatches = current?.patches.filter(patch => patch.method === "model_assisted") || [];
  const dirty = Boolean(
    current && JSON.stringify(draft) !== JSON.stringify(current.content),
  );
  const isLatest =
    !current ||
    current.version === (versions.at(-1)?.version ?? current.version);
  const activeView = view === "create" || view === "diagnose";
  useEffect(() => { window.scrollTo({ top: 0, behavior: "instant" }); }, [view]);
  // 轮询本身每 500ms 也会重渲染，但状态查询一旦自己卡住，秒表就停了 —— 所以单独走一个 1 秒的计时器。
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setBusyTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [Boolean(busy)]);

  async function openRecord(
    record: Listing,
    targetTab: "editor" | "review" | "versions" = "editor",
    forceAdvanced = false,
  ) {
    if (guidedBusy || variantsGenerating) return;
    // 站点下拉跟着这条结果走：打开一份德语文案时，顶栏还写「Amazon US · 英文」、
    // 规则页还在列美国规则，同一个屏幕上三处互相矛盾。
    // 这不是"改默认值"——默认仍是美国站-英语；只是让界面说清"你现在看的是哪一站"。
    const { marketplace: recordMarket, language: recordLanguage } = listingScope(record);
    const recordSite =
      SITE_OPTIONS.find(
        (option) => option.market === recordMarket && option.language === recordLanguage,
      ) ?? SITE_OPTIONS.find((option) => option.market === recordMarket);
    if (recordSite) setSiteKey(recordSite.value);
    if (record.guided_plan && !forceAdvanced) {
      setSidebarCollapsed(true);
      setGuidedMode(record.guided_plan.mode); setGuidedRecord(record); setView('guided'); setMoreNavigation(false); return;
    }
    setCurrent(record);
    setDraft(structuredClone(record.content));
    // 记录自己的关联情况就是用户意图：以前没有记录关联（null）会被下一次刷新补成第一个商品。
    productPinned.current = true;
    setProductId(record.product_snapshot?.product_id || "");
    setSidebarCollapsed(true);
    setView(record.workflow === "listing_create" ? "create" : "diagnose");
    setTab(targetTab);
    setSelectedPatches([]);
    setInstruction("");
    const all = await api<Listing[]>(
      `/api/listings/${record.listing_id}/versions`,
    );
    setVersions(all);
  }
  async function execute(path: string, payload: unknown) {
    if (executing.current || busy) return;
    executing.current = true;
    setRunStatusNotice(null);
    busyStartedAt.current = Date.now();
    try {
      const run = await post<Run>(path, {
        ...(payload as object),
        request_id: createRequestId(),
      });
      if (!mounted.current) return;
      setBusy(run);
      const status = await waitForRun(run.run_id, {
        isActive: () => mounted.current,
        onProgress: setBusy,
        onUnavailable: setRunStatusNotice,
      });
      if (!status) return;
      if (status.status === "failed") {
        await refresh().catch(() => undefined);
        throw new Error(status.error?.message || "运行失败，输入已保留。");
      }
      const all = await api<Listing[]>(
        `/api/listings/${status.listing_id}/versions`,
      );
      const result = all.find((x) => x.version === status.version);
      if (!result) throw new Error("运行已完成，结果暂未加载，请从运行记录打开；无需再次生成。");
      await refresh();
      await openRecord(
        result,
        result.workflow === "listing_diagnose" || result.operation !== "create" || result.review.issues.length ? "review" : "editor",
      );
      notify(
        result.operation === "revise" && !result.changes.length ? `V${result.version} 已保存复检结果；模型未修改正文，请明确修改目标。` : `V${result.version} 已保存${result.trace.actual_model_call ? " · 实际模型调用" : " · 本地规则演示"}`,
      );
    } catch (error) {
      if (mounted.current) notify((error as Error).message, true);
    } finally {
      executing.current = false;
      if (mounted.current) { setBusy(null); setRunStatusNotice(null); }
    }
  }
  function newTask(next: View) {
    if (navigationLocked) return;
    if (dirty) { notify("当前文案有未保存修改，请先保存并重新检查。", true); return; }
    setSidebarCollapsed(true);
    setView(next);
    // 现有文案导入仍只确认美国站范围，不继承上一份外国站记录的顶栏。
    if (next === "diagnose") setSiteKey("US-en");
    if (next === "create" && !productId)
      setProductId(data?.products[0]?.product_id || "");
    setCurrent(null);
    setVersions([]);
    setDraft(emptyContent());
    setIntakeDraft(emptyIntakeDraft());
    setTab("editor");
    setSelectedPatches([]);
    setInstruction("");
    setHighlight("");
    setIssueFilter("all");
  }
  function startGuided(mode: GuidedMode) {
    if (navigationLocked) return;
    if (dirty) { notify('当前文案有未保存修改，请先保存。', true); return; }
    setSidebarCollapsed(true);
    setGuidedMode(mode); setGuidedRecord(null); setGuidedSession(value => value + 1); setMoreNavigation(false); setView('guided');
  }
  function focusField(path: string) {
    setTab("editor");
    setHighlight(path);
    setTimeout(() => {
      const node = document.getElementById(path);
      node?.scrollIntoView({ behavior: "smooth", block: "center" });
      node?.focus();
    }, 80);
  }
  async function copyContent() {
    try {
      await navigator.clipboard.writeText(
        [
          draft.title,
          draft.item_highlights,
          ...draft.bullet_points.map((b) => b.text),
          draft.description,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      notify(`${languageZhOf(current?.language)}文案已复制，内部审阅说明不包含在内。`);
    } catch {
      notify("浏览器未允许剪贴板，请选择字段文本复制。", true);
    }
  }
  const createListing = () =>
    execute("/api/listings/create", {
      product_id: productId,
      language: outputLanguage,
      marketplace: outputMarket,
      product_revision: product?.revision,
      instruction: purpose,
      content_brief: contentBrief,
    });
  const diagnoseListing = () =>
    execute("/api/listings/diagnose", {
      product_id: productId || null,
      product_revision: product?.revision,
      content: draft,
    });
  const revise = () =>
    current &&
    execute(`/api/listings/${current.listing_id}/revisions`, {
      base_version: current.version,
      kind: "instruction",
      instruction,
      ...(revisionScope !== 'all' ? { allowed_fields: [revisionScope] } : {}),
    });
  const reviewAllIssues = () => current && execute(`/api/listings/${current.listing_id}/revisions`, {
    base_version: current.version,
    kind: "review_issues",
  });
  const saveManual = () =>
    current &&
    execute(`/api/listings/${current.listing_id}/revisions`, {
      base_version: current.version,
      kind: "manual",
      content: draft,
    });
  const applySelected = () => {
    setPreviewPatches(false);
    if (current)
      execute(`/api/listings/${current.listing_id}/revisions`, {
        base_version: current.version,
        kind: "patch",
        patch_ids: selectedPatches,
      });
  };

  if (fatal)
    return (
      <div className="startup-error">
        <CircleAlert size={36} />
        <h1>暂时无法连接工作台</h1>
        <p>{fatal}</p>
        <p>请确认本地服务已启动，然后刷新。</p>
        <button className="primary-button" onClick={() => location.reload()}>
          重新连接
        </button>
      </div>
    );
  if (!data)
    return (
      <div className="startup-error">
        <LoaderCircle className="spin" size={30} />
        <p>正在准备你的工作空间…</p>
      </div>
    );
  const settings = data.settings;
  const endpointConfigured = settings.provider === "compatible"
    ? Boolean(validHttpEndpoint(settings.base_url) && settings.model?.trim())
    : settings.provider === "dify" && validHttpEndpoint(settings.dify_base_url);
  const modelConfigured = Boolean(endpointConfigured && (settings.provider === "compatible" ? settings.has_api_key : settings.has_dify_create_api_key && settings.has_dify_diagnose_api_key));
  // 等模型的时候，遮罩上要有个会动的秒数；上限也照实说：
  // 一次"生成/改稿"含两次调用（写文案 + 独立审阅），"诊断/套补丁"只有一次，所以最长不是 timeout×1。
  const modelTimeoutSeconds = Math.round((Number(settings.timeout_ms) || 60000) / 1000);
  const busyCalls = busy?.operation === "create" || busy?.operation === "revise" ? 2 : 1;
  const busyCeilingSeconds = modelTimeoutSeconds * busyCalls;
  const busySeconds = busy ? Math.max(0, Math.round((Date.now() - busyStartedAt.current) / 1000)) : 0;
  // 界面自己也在做承诺。"兼容接口 · 实际模型调用"在没填 Key 的时候是假的：
  // 实测（scripts/failure-drill.mjs --no-key）点了会直接 MISSING_API_KEY，一次请求都没发出去。
  const providerLabel = settings.provider === "dify" ? "Dify" : "兼容接口";
  const missingKeyCaption =
    settings.provider === "dify"
      ? !(settings.has_dify_create_api_key && settings.has_dify_diagnose_api_key)
      : settings.provider === "compatible"
        ? !settings.has_api_key
        : false;
  const deepseekEndpoint = (settings.base_url || "").includes("api.deepseek.com");
  const modeCaption = {
    text:
      settings.provider === "demo"
        ? "本地演示 · 不调用模型"
        : !endpointConfigured
          ? `${providerLabel} · 请补齐有效服务地址与模型配置`
        : !missingKeyCaption
          ? `${providerLabel} · 实际模型调用`
          : settings.provider === "dify"
            ? "Dify · 工作流 Key 不全，现在点生成会直接报错"
            : deepseekEndpoint
              ? "兼容接口 · 没填 DeepSeek Key，现在点生成会立刻报错"
              : "兼容接口 · 没填 Key（该地址是否要求 Key 由服务方决定）",
    warn: settings.provider === "demo" || !endpointConfigured || missingKeyCaption,
  };
  const review = current?.review;
  const visibleIssues = (review?.issues || []).filter(
    (x) => issueFilter === "all" || x.category === issueFilter,
  );
  // 优先使用文案快照或同版本登记的依据，不能让当前规则覆盖历史结论。
  const citationFor = (ruleId: string, fieldPath?: string) => {
    const recorded = current?.rule_citations
      ?? data.rule_citations_by_version?.[current?.rule_pack_version || data.rules.rule_pack_version]
      ?? (!current || current.rule_pack_version === data.rules.rule_pack_version ? data.rule_citations : undefined);
    const base = recorded?.find((entry) => entry.rule_id === ruleId);
    return base && fieldPath && base.field_basis_overrides?.[fieldPath]
      ? { ...base, ...base.field_basis_overrides[fieldPath] }
      : base;
  };
  // `short` 只在 420px 以下的底部标签栏里用（第 19 轮自提 109）：
  // 360px 下九个 tab 平分，每个 36px，而「图片与竞品研究」六个字在 9px 字号下折成三行——
  // 不溢出、能点，前面几条断言全绿，而拿手机的人一眼就看见它挤成一坨。
  // 短名只换显示，不换 `aria-label` 与视图 key：读屏软件和测试都还认全名。
  const nav = [
    { key: "home" as View, label: "工作台", short: "工作台", icon: House },
    { key: "batch" as View, label: "批量商品", short: "批量", icon: Layers3 },
    { key: "create" as View, label: "新品 Listing", short: "新品", icon: FilePenLine },
    { key: "diagnose" as View, label: "诊断与修复", short: "诊断", icon: SearchCheck },
    { key: "products" as View, label: "商品资料", short: "资料", icon: Boxes },
    { key: "research" as View, label: "图片与竞品研究", short: "研究", icon: Globe2 },
    { key: "ruleMonitor" as View, label: "Amazon 规则监测", short: "规则监测", icon: Activity },
    { key: "history" as View, label: "我的结果", short: "结果", icon: FileClock },
  ];
  const amazonImport = <AmazonImport onRefresh={refresh} onProduct={(id) => { setProductId(id); setView("products"); }} onOpen={(record) => openRecord(record)} />;

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      {/* 键盘用户按 Tab 的第一个落点原来是品牌 Logo，然后是 11 个侧栏按钮 ——
          想到创作页的「生成英文草稿」要按 19 次（npm run a11y:keys 量的）。 */}
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          const target = document.getElementById("main-content");
          target?.focus();
          target?.scrollIntoView({ block: "start" });
        }}
      >
        跳到主要内容
      </a>
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            if (navigationLocked) return;
            setView("home");
          }}
          aria-label="Listing Studio 首页"
        >
          <span className="brand-mark">
            <Layers3 size={22} />
          </span>
          <span>
            Listing<span className="brand-light">Studio</span>
            <small>Amazon 上架内容审核助手</small>
          </span>
        </a>
        <div className="workspace-switch">
          <span className="workspace-avatar">
            <Boxes size={19} />
          </span>
          <div>
            <strong>运营工作空间</strong>
            <small>商品内容与审核</small>
          </div>
        </div>
        <div className="nav-caption">开始制作</div>
        <nav className="simple-nav">
          <button disabled={navigationLocked} className={`nav-item ${view === 'home' || view === 'guided' ? 'active' : ''}`} aria-label="首页" onClick={() => { setView('home'); setMoreNavigation(false); }}><span className="nav-icon nav-home"><House size={18} /></span><span className="nav-label">首页</span></button>
          <button disabled={navigationLocked} className={`nav-item ${view === 'history' ? 'active' : ''}`} aria-label="我的结果" onClick={() => { setView('history'); setMoreNavigation(false); }}><span className="nav-icon nav-history"><FolderOpen size={18} /></span><span className="nav-label">我的结果</span></button>
          <button disabled={navigationLocked} className={`nav-item ${moreNavigation ? 'active' : ''}`} aria-label="更多功能" aria-expanded={moreNavigation} onClick={() => setMoreNavigation(value => !value)}><span className="nav-icon nav-more"><MoreHorizontal size={18} /></span><span className="nav-label">更多功能</span></button>
          {moreNavigation && <div className="guided-nav-more" aria-label="更多工作台功能">{nav.filter(item => !['home', 'history'].includes(item.key)).map(({ key, label, short, icon: Icon }) => (
            <button
              key={key}
              disabled={navigationLocked}
              className={`nav-item ${view === key ? "active" : ""}`}
              aria-label={label}
              aria-current={view === key ? "page" : undefined}
              onClick={() => {
                if (key === "create" || key === "diagnose") {
                  const matchingWorkflow = key === "create" ? "listing_create" : "listing_diagnose";
                  if (!current || current.workflow !== matchingWorkflow) {
                    newTask(key);
                    return;
                  }
                  const scope = listingScope(current);
                  const savedSite = SITE_OPTIONS.find(option => option.market === scope.marketplace && option.language === scope.language);
                  if (savedSite) setSiteKey(savedSite.value);
                }
                setView(key);
              }}
            >
              <span className={`nav-icon nav-${key}`}>
                <Icon size={18} />
              </span>
              <span className="nav-label">
                <span className="nav-label-full">{label}</span>
                <span className="nav-label-short">{short}</span>
              </span>
              {view === key && <span className="nav-dot" />}
            </button>
          ))}
        <button disabled={navigationLocked} className="nav-item" aria-label="导入已有文案" onClick={() => { newTask('diagnose'); }}><span className="nav-icon nav-import"><FileText size={18} /></span><span className="nav-label">导入已有文案</span></button>
        <button
          className={`nav-item ${view === "rules" ? "active" : ""}`}
          aria-label="规则与来源"
          disabled={navigationLocked}
          aria-current={view === "rules" ? "page" : undefined}
          onClick={() => { setView("rules"); }}
        >
          <span className="nav-icon nav-rules">
            <BookOpen size={18} />
          </span>
          <span className="nav-label">
            <span className="nav-label-full">规则与来源</span>
            <span className="nav-label-short">规则</span>
          </span>
          <span className="nav-number">{data.rules.rules.length}</span>
        </button>
        </div>}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="sidebar-collapse-toggle"
            type="button"
            aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed(value => !value)}
          >
            <PanelLeftClose size={17} />
            <span>{sidebarCollapsed ? "展开侧栏" : "收起侧栏"}</span>
          </button>
          {guidedBusy && (
            <p className="sidebar-busy" role="status">
              正在生成，完成后可以切换功能
            </p>
          )}
          <div className="scope-note">
            <ShieldCheck size={20} />
            <strong>每一处修改，都有依据</strong>
            <p>商品事实、规则来源与版本记录，始终随内容保留。</p>
            <button onClick={() => setSourcesOpen([])}>
              查看资料来源 <ArrowUpRight size={13} />
            </button>
          </div>
          <button
            className="provider-switch"
            onClick={() => setSettingsOpen(true)}
          >
            <span
              className={`status-dot ${!modelConfigured ? "amber" : ""}`}
            />
            <span>
              <strong>
                {modelConfigured ? "模型服务已配置" : "真实模型待配置"}
              </strong>
              <small>
                {!modelConfigured
                  ? "点击配置真实模型"
                  : settings.model || "Dify 工作流"}
              </small>
            </span>
            <Settings2 size={17} />
          </button>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            工作空间 <ChevronRight size={13} />
            <span>
              {
                {
                  home: "工作台",
                  guided: guidedMode === 'improve' ? '改进提示词' : '自动整理文案',
                  library: "我的结果",
                  batch: "批量商品",
                  research: "图片与竞品研究",
                  create: "新品 Listing",
                  diagnose: "诊断与修复",
                  products: "商品资料",
                  history: "我的结果",
                  rules: "规则与来源",
                  ruleMonitor: "Amazon 规则监测",
                }[view]
              }
            </span>
          </div>
          <div className="topbar-actions">
            <span className="market-label">
              <Globe2 size={15} /> {site.marketLabel}{" "}
              <span className="market-language">· {site.languageShort}</span>
            </span>
            <span className="top-divider" />
            <button
              className="icon-button"
              aria-label="查看运行记录"
              onClick={() => setRunsOpen(true)}
            >
              <History size={18} />
            </button>
            <button
              className="icon-button"
              aria-label="模型设置"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={18} />
            </button>
            <span className="user-avatar">S</span>
          </div>
        </header>
        <div className="page-content" id="main-content" tabIndex={-1}>
          {view === 'guided' && <GuidedWorkspace key={`${guidedMode}-${guidedSession}`} mode={guidedMode} initialSite={{ market: outputMarket, language: outputLanguage }} products={data.products} modelConfigured={modelConfigured} onRefresh={refresh} onHome={() => setView('home')} onSettings={() => setSettingsOpen(true)} onLegacy={() => newTask('diagnose')} onAdvanced={record => { void openRecord(record, 'review', true); }} onSources={setSourcesOpen} onWorkingChange={setGuidedBusy} onSiteChange={next => {
            // 引导流程里选了哪个站点，顶栏就写哪个站点。四个站点各有下拉项，
            // 所以这里一定匹配得到；匹配不到就保持原样，不硬凑。
            const matched = SITE_OPTIONS.find(option => option.market === next.market && option.language === next.language);
            if (matched) setSiteKey(matched.value);
          }} initialRecord={guidedRecord} />}
          {view === 'batch' && <BatchWorkspace settings={settings} callsPerRow={data?.batch_calls_per_row} onOpen={record=>{void refresh();void openRecord(record,'review');}} onRefresh={refresh}/>}
          {view === 'research' && <ResearchWorkspace products={data.products} onRefresh={refresh} onOpen={record=>openRecord(record,'review')}/>}
          {view === "home" && (
            <WorkspaceHome
              amazonImport={amazonImport}
              data={data}
              onNavigate={setView}
              onStart={newTask}
              onOpen={openRecord}
              onGuided={startGuided}
            />
          )}
          {activeView && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    {view === "create"
                      ? "CREATE / EVIDENCE FIRST"
                      : "REVIEW / BEFORE DELIVERY"}
                  </div>
                  <h1>
                    {view === "create"
                      ? "新品 Listing 创建"
                      : "已有 Listing 诊断与修复"}
                  </h1>
                  <p>
                    {view === "create"
                      ? site.promptZh
                      : "接收你的初稿或竞品参考，确认材料与适用范围后继续审改。"}
                  </p>
                </div>
                <div className="heading-actions">
                  {current && (
                    <button
                      className="secondary-button"
                      onClick={() => newTask(view)}
                    >
                      <Plus size={16} />
                      新建任务
                    </button>
                  )}
                  {!current && view === "create" && (
                    <button
                      className="primary-button"
                      disabled={
                        Boolean(busy) ||
                        (view === "create" ? !product : !draft.title.trim())
                      }
                      onClick={() =>
                        view === "create" ? createListing() : diagnoseListing()
                      }
                    >
                      {view === "create" ? (
                        <Sparkles size={16} />
                      ) : (
                        <SearchCheck size={16} />
                      )}{" "}
                      {view === "create" ? "开始创建" : "检查这份文案"}
                    </button>
                  )}
                  <button
                    className="secondary-button"
                    disabled={!current || dirty}
                    onClick={() => setExportOpen(true)}
                  >
                    <ArrowDownToLine size={16} />
                    导出
                  </button>
                  {/* 演示时评委看的是界面，而报告比界面好看得多。这里直接在新标签打开同一份报告
                      （disposition=inline，不然浏览器会存盘），不用先下载再去找文件。
                      草稿有未保存改动时不给入口：看了旧版本会以为改动没生效。 */}
                  {current && !dirty && (
                    <a
                      className="secondary-button"
                      href={`/api/listings/${current.listing_id}/export?version=${current.version}&format=html&disposition=inline`}
                      target="_blank"
                      rel="noreferrer"
                      title="在新标签打开审阅报告（含打印样式），可直接打印或另存 PDF"
                    >
                      <FileSearch size={16} />
                      看报告
                    </a>
                  )}
                  {current && !dirty && (
                    <button
                      className="secondary-button"
                      onClick={() => setAplusOpen(true)}
                      title="由已登记商品参数生成 A+ 对比表素材"
                    >
                      <Table2 size={16} />
                      A+ 内容
                    </button>
                  )}
                  {current && !dirty && (
                    <button
                      className="secondary-button"
                      onClick={() => setVocOpen(true)}
                      title="粘贴竞品差评，挖掘买家痛点并生成打痛点卖点"
                    >
                      <WandSparkles size={16} />
                      竞品差评
                    </button>
                  )}
                  {current && !dirty && (
                    <button
                      className="secondary-button"
                      onClick={() => setKeywordOpen(true)}
                      title="粘贴搜索词/ABA 报告，核对哪些已写进文案"
                    >
                      <SearchCheck size={16} />
                      搜索词
                    </button>
                  )}
                  {current && !dirty && (
                    <button
                      className="secondary-button"
                      onClick={() => setVariantsOpen(true)}
                      title="用同一商品事实生成三版卖点角度文案，供 A/B 测试"
                    >
                      <Layers3 size={16} />
                      A/B 变体
                    </button>
                  )}
                  {current && !dirty && (
                    <button
                      className="secondary-button"
                      onClick={() => setRolesOpen(true)}
                      title="按岗位分组待补资料，合规/美工/采购/运营各看各的"
                    >
                      <Boxes size={16} />
                      协同看板
                    </button>
                  )}
                  {current && !dirty && (
                    <button
                      className="secondary-button"
                      onClick={() => setReadinessOpen(true)}
                      title="上架前完整度检查：品牌/分类/识别码/变体/图片/包装/合规/库存"
                    >
                      <BadgeCheck size={16} />
                      上架检查
                    </button>
                  )}
                  {current && !dirty && (
                    <button
                      className="secondary-button"
                      onClick={() => setVariationOpen(true)}
                      title="变体与父子 SKU 一致性审核"
                    >
                      <Layers3 size={16} />
                      变体审核
                    </button>
                  )}
                  {current && !dirty && (
                    <button
                      className="secondary-button"
                      onClick={() => setEvidenceOpen(true)}
                      title="商品证据生命周期台账：核验状态、有效期、支持的宣称"
                    >
                      <FileSearch size={16} />
                      证据台账
                    </button>
                  )}
                </div>
              </div>
              <div className="step-strip">
                <span className="step active">
                  <span>01</span>
                  {view === "create" ? "确认商品资料" : "导入已有文案"}
                </span>
                <i />
                <span className={`step ${current ? "active" : ""}`}>
                  <span>02</span>
                  {view === "create" ? `生成${site.languageZh}草稿` : "检查规则与证据"}
                </span>
                <i />
                <span
                  className={`step ${current && current.version > 1 ? "active" : ""}`}
                >
                  <span>03</span>审核与修复
                </span>
                <i />
                <span className="step">
                  <span>04</span>确认与交付
                </span>
                <span className="strip-end">
                  <ShieldCheck size={14} />
                  事实与来源全程保留
                </span>
              </div>
              {view === "diagnose" && !current && <IntakePanel value={intakeDraft} onChange={setIntakeDraft} products={data.products} busy={Boolean(busy)} modelConfigured={modelConfigured} onSubmit={payload => { void execute("/api/listings/intake", payload); }} onSettings={() => setSettingsOpen(true)} onProducts={() => setView("products")} />}
              {(view !== "diagnose" || current) && <div className="workspace-grid">
                <aside className="input-column">
                  <section className="panel product-panel">
                    <div className="panel-title">
                      <h2>商品资料</h2>
                      <button
                        className="text-button"
                        onClick={() => setView("products")}
                      >
                        管理 <ArrowUpRight size={13} />
                      </button>
                    </div>
                    <div className="product-visual">
                      <BagIllustration />
                      <span>规格示意 · 非商品实拍</span>
                    </div>
                    <label className="form-label" htmlFor="product-select">
                      关联商品
                    </label>
                    <div className="select-wrap">
                      <select
                        id="product-select"
                        disabled={Boolean(busy)}
                        value={productId}
                        onChange={(e) => {
                          if (dirty) { notify("请先保存当前文案修改，再切换商品。", true); return; }
                          // 「不关联」也是选择，记下来，别被下一次 refresh 补回第一个商品。
                          productPinned.current = true;
                          setProductId(e.target.value);
                          // 打开着的记录如果**本身没关联过商品**，这次选择是"给它补关联"，
                          // 不是"开新任务"——原来一律 setCurrent(null)，记录直接从右栏消失，
                          // 「关联并复检」按钮也就永远没机会出现（第 17 轮修的缺口）。
                          if (!(current && !current.product_snapshot)) {
                            setCurrent(null);
                            setVersions([]);
                            if (view === "create") setDraft(emptyContent());
                          }
                        }}
                      >
                        {view === "diagnose" && (
                          <option value="">不关联，仅检查文本</option>
                        )}
                        {data.products.map((p) => (
                          <option key={p.product_id} value={p.product_id}>
                            {p.name_zh}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={15} />
                    </div>
                    {displayProduct ? (
                      <>
                        <div className="product-meta">
                          <span className="tiny-badge">
                            {displayProduct.amazon ? "Amazon 公开商品" : displayProduct.is_demo ? "演示商品" : displayProduct.material.status === "public_source" ? "官方公开资料" : "商家资料"}
                          </span>
                          <span>资料 V{displayProduct.revision}</span>
                        </div>
                        <dl className="facts-list">
                          <div>
                            <dt>材质</dt>
                            <dd>{displayProduct.material.value || "未披露"}</dd>
                          </div>
                          <div>
                            <dt>尺寸</dt>
                            <dd>
                              {dimensionsText(displayProduct)}
                            </dd>
                          </div>
                          <div>
                            <dt>面料克重</dt>
                            <dd>{measurement(displayProduct.fabric_weight_gsm.value, "g/m²")}</dd>
                          </div>
                          <div>
                            <dt>容量 / 提手</dt>
                            <dd>
                              {measurement(displayProduct.capacity_l.value, "L")} /{" "}
                              {measurement(displayProduct.handle_length_cm.value, "cm")}
                            </dd>
                          </div>
                          <div>
                            <dt>零售包装</dt>
                            <dd>
                              {displayProduct.retail_pack_count.value
                                ? `${displayProduct.retail_pack_count.value} 件 / 包`
                                : "待确认"}
                            </dd>
                          </div>
                        </dl>
                        <button
                          className="source-link"
                          onClick={() =>
                            setSourcesOpen(productSourceIds(displayProduct))
                          }
                        >
                          <Link2 size={13} />
                          查看商品事实来源 <ArrowUpRight size={13} />
                        </button>
                      </>
                    ) : view === "create" && !data.products.length ? (
                      // 零商品是这个仓库的真实起点（演示商品被 bootstrap 过滤掉了）。
                      // 原来这里只解释"没关联会怎样"，不说下一步去哪 —— 台上第一步就卡在灰按钮上。
                      <>
                        <p className="muted small">
                          还没有商品资料。生成{site.languageZh}文案要先有一条带规格的档案：手动录入约 1
                          分钟，也可以从 Amazon 商品页导入公开资料。
                        </p>
                        <button
                          className="secondary-button"
                          onClick={() => setView("products")}
                        >
                          <Boxes size={15} />
                          去录入商品资料
                        </button>
                      </>
                    ) : (
                      <p className="muted small">
                        没有关联商品时，材质、包装及性能等检查会标记为资料不足。
                      </p>
                    )}
                  </section>
                  <section className="panel task-panel">
                    <h2>{view === "create" ? "内容偏好" : "诊断范围"}</h2>
                    {view === "create" ? (
                      <>
                        <ContentBrief value={contentBrief} onChange={setContentBrief} />
                        <label className="form-label" htmlFor="purpose">
                          用途与表达要求
                        </label>
                        <textarea
                          id="purpose"
                          rows={3}
                          value={purpose}
                          onChange={(e) => setPurpose(e.target.value)}
                          placeholder="例如：用于日常通勤，表达简洁自然"
                        />
                        <p className="helper">
                          事实、认证与性能以商品档案为准。
                          目标买家和场景只影响表达顺序；定制能力也须有本商品资料支持。
                        </p>
                      </>
                    ) : (
                      <div className="scope-checks">
                        <span>
                          <Check size={14} />
                          {site.marketLabel} 文本规则
                        </span>
                        <span>
                          <Check size={14} />
                          {site.marketZh}广告宣称证据预审
                        </span>
                        {product ? (
                          <span>
                            <Check size={14} />
                            商品事实与包装核对 · {product.name_zh} V{product.revision}
                          </span>
                        ) : (
                          // 没关联商品时这一项根本不会执行，原来照样打勾——那是在给一个没做过的检查打勾。
                          <span className="off">
                            <CircleAlert size={14} />
                            商品事实与包装核对 · 本次不执行（未关联商品）
                          </span>
                        )}
                        <p className="helper">
                          {product
                            ? "参数对照、材质与包装件数以这份档案为准，逐项与文案核对。"
                            : "没有关联商品时，以档案为准的检查不参与，问题数会少于关联时；它们在结果里显示为「未完成」，不等于通过。"}
                        </p>
                        <p className="helper">原稿本身不作为真实性证明。</p>
                      </div>
                    )}
                    <div className="fixed-options">
                      <span>
                        <Globe2 size={14} />
                        站点
                      </span>
                      {view === "create" ? (
                        <select
                          aria-label="站点与产出语言"
                          className="inline-select"
                          value={siteKey}
                          onChange={(e) => setSiteKey(e.target.value as SiteKey)}
                        >
                          {SITE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span>{site.label} · 按你贴的原文语言检查</span>
                      )}
                    </div>
                    {/* 诊断页零文案时，两个主按钮全是灰的，页面上没有一句说"为什么灰、要去哪"。
                        实测（scripts/empty-state-probe.mjs）这一页 615 字正文里没有指路的那一句。 */}
                    {view === "diagnose" && !current && !draft.title.trim() && (
                      <p className="block-reason">
                        <CircleAlert size={13} />
                        <span>
                          「开始诊断」现在是灰的：还没有可检查的内容。把 Listing 的标题贴到右边
                          「文案编辑」里（五点、描述可选），或者
                          <button
                            type="button"
                            className="text-button inline"
                            onClick={() => setView("history")}
                          >
                            到版本记录打开一份
                          </button>
                          。
                        </span>
                      </p>
                    )}
                    <button
                      className="primary-button generate-button"
                      disabled={
                        Boolean(busy) ||
                        (view === "create" ? !product : !draft.title.trim())
                      }
                      onClick={() =>
                        view === "create" ? createListing() : diagnoseListing()
                      }
                    >
                      {busy ? (
                        <LoaderCircle size={17} className="spin" />
                      ) : view === "create" ? (
                        <Sparkles size={17} />
                      ) : (
                        <SearchCheck size={17} />
                      )}{" "}
                      {view === "create" ? current ? "用此资料另建草稿" : `生成${site.languageZh}草稿` : "开始诊断"}
                      <ArrowRight size={15} />
                    </button>
                    <p className="mode-caption">
                      <span
                        className={`status-dot ${modeCaption.warn ? "amber" : ""}`}
                      />
                      {modeCaption.text}
                    </p>
                  </section>
                  <div className="input-note">
                    <BookOpen size={16} />
                    <p>
                      当前覆盖{site.marketZh}站文本与宣称预审。正式上架还需核对商品类型及其他必要资料。
                    </p>
                  </div>
                </aside>
                <section className="output-column">
                  {current && <IntakeRecordContext record={current} />}
                  {current && (
                    <section
                      className="delivery-status"
                      aria-label="交付前检查状态"
                    >
                      <span className={`app-icon ${reviewState(current, data.rule_pack_versions).tone}`}>
                        <ShieldCheck size={21} />
                      </span>
                      <div>
                        <strong>
                          {dirty
                            ? "文案已修改，需重新检查"
                            : reviewState(current, data.rule_pack_versions).label}
                        </strong>
                        <p>
                          {dirty
                            ? "保存后重新检查，当前审核对应上一份已保存文案。"
                            : `${review!.issues.length} 项内容风险 · ${incompleteChecks(current)} 项检查未完成 · ${review!.missing_data.length} 项资料待补充`}
                        </p>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => setTab("review")}
                      >
                        查看审核 <ChevronRight size={15} />
                      </button>
                    </section>
                  )}
                  <div className="panel editor-panel">
                    <div className="editor-top">
                      <div>
                        <span className="document-icon">
                          <FileText size={17} />
                        </span>
                        <strong>
                          {current ? "Listing 草稿" : "内容工作区"}
                        </strong>
                        {current && (
                          <span className="version-badge">
                            V{current.version}
                          </span>
                        )}
                        {dirty && <span className="unsaved-dot">未保存</span>}
                      </div>
                      <div>
                        <button
                          className="icon-button"
                          aria-label={`复制${languageZhOf(current?.language)}文案`}
                          disabled={!draft.title}
                          onClick={copyContent}
                        >
                          <Copy size={16} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label="查看当前运行详情"
                          disabled={!current}
                          onClick={() => setRunsOpen(true)}
                        >
                          <MoreHorizontal size={19} />
                        </button>
                      </div>
                    </div>
                    <div className="editor-tabs">
                      <button
                        aria-pressed={tab === "editor"}
                        className={tab === "editor" ? "selected" : ""}
                        onClick={() => setTab("editor")}
                      >
                        <FilePenLine size={15} />
                        文案编辑
                      </button>
                      <button
                        aria-pressed={tab === "review"}
                        className={tab === "review" ? "selected" : ""}
                        onClick={() => setTab("review")}
                      >
                        <ShieldCheck size={15} />
                        检查与依据
                        {review && <span>{review.issues.length}</span>}
                      </button>
                      <button
                        aria-pressed={tab === "versions"}
                        className={tab === "versions" ? "selected" : ""}
                        onClick={() => setTab("versions")}
                      >
                        <History size={15} />
                        版本对比{current && <span>{versions.length}</span>}
                      </button>
                    </div>
                    {tab === "editor" && (
                      <fieldset
                        className="editor-body"
                        disabled={
                          Boolean(busy) || (!isLatest && Boolean(current))
                        }
                      >
                        {!current && view === "create" ? (
                          <div className="empty-editor">
                            <span className="empty-icon">
                              <FilePenLine size={29} />
                              <span className="mini-spark">
                                <Sparkles size={14} />
                              </span>
                            </span>
                            <h3>
                              {data.products.length
                                ? "好内容，从准确的事实开始"
                                : "先有一条商品资料"}
                            </h3>
                            <p>
                              {data.products.length ? (
                                <>
                                  确认左侧商品资料，生成第一版{site.languageZh}草稿。
                                  <br />
                                  参数、来源与检查结果会一起保留。
                                </>
                              ) : (
                                <>
                                  生成要按档案核对事实，所以第一步是录入一条商品。
                                  <br />
                                  手动录入约 1 分钟，也可以从 Amazon 商品页导入。
                                </>
                              )}
                            </p>
                            <div className="empty-field-preview">
                              <div>
                                <span>PRODUCT TITLE</span>
                                <i className="placeholder-line long" />
                                <i className="placeholder-line medium" />
                              </div>
                              <div>
                                <span>KEY HIGHLIGHTS</span>
                                <i className="placeholder-line" />
                                <i className="placeholder-line long" />
                              </div>
                            </div>
                            <div className="empty-feature-row">
                              <span>
                                <BadgeCheck size={15} />
                                基于商品事实
                              </span>
                              <span>
                                <ShieldCheck size={15} />
                                规则可追溯
                              </span>
                              <span>
                                <History size={15} />
                                修改有记录
                              </span>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="content-section-note">
                              <span>
                                <Globe2 size={13} />
                                {localeLabelOf(current ? listingScope(current).language : outputLanguage, current ? listingScope(current).marketplace : outputMarket)}
                              </span>
                              <span>
                                {current
                                  ? `保存于 ${time(current.created_at)}`
                                  : "粘贴标题、亮点、要点及描述"}
                              </span>
                            </div>
                            <Field
                              label="商品标题"
                              english="PRODUCT TITLE"
                              path="content.title"
                              value={draft.title}
                              max={ruleCharLimit(data.rules.rules, "AMZ-01")}
                              highlight={highlight}
                              issues={review?.issues || []}
                              onChange={(text) =>
                                setDraft({ ...draft, title: text })
                              }
                              rows={2}
                              placeholder="Paste or write your product title…"
                            />
                            <Field
                              label="商品亮点"
                              english="ITEM HIGHLIGHTS"
                              path="content.item_highlights"
                              value={draft.item_highlights}
                              max={ruleCharLimit(data.rules.rules, "AMZ-02")}
                              highlight={highlight}
                              issues={review?.issues || []}
                              onChange={(text) =>
                                setDraft({ ...draft, item_highlights: text })
                              }
                              rows={2}
                              placeholder="Materials, key attributes or use cases…"
                            />
                            <div className="field-heading">
                              <span>
                                商品要点 <small>BULLET POINTS</small>
                              </span>
                              <span className="muted">逐项清楚表达</span>
                            </div>
                            <div className="bullet-editors">
                              {draft.bullet_points.map((bullet, index) => (
                                <div className="bullet-row" key={bullet.id}>
                                  <span className="bullet-number">
                                    {String(index + 1).padStart(2, "0")}
                                  </span>
                                  <Field
                                    label={`要点 ${index + 1}`}
                                    path={`content.bullet_points.${bullet.id}`}
                                    value={bullet.text}
                                    highlight={highlight}
                                    issues={review?.issues || []}
                                    onChange={(text) =>
                                      setDraft({
                                        ...draft,
                                        bullet_points: draft.bullet_points.map(
                                          (b) =>
                                            b.id === bullet.id
                                              ? { ...b, text }
                                              : b,
                                        ),
                                      })
                                    }
                                    rows={2}
                                    compact
                                    placeholder="One useful, supported product detail…"
                                  />
                                </div>
                              ))}
                            </div>
                            <Field
                              label="商品描述"
                              english="DESCRIPTION"
                              path="content.description"
                              value={draft.description}
                              highlight={highlight}
                              issues={review?.issues || []}
                              onChange={(text) =>
                                setDraft({ ...draft, description: text })
                              }
                              rows={5}
                              placeholder="Describe your product with supported facts…"
                            />
                            {current && (
                              <div className="editor-save-row">
                                <p>
                                  {isLatest
                                    ? "手动修改保存后，将重新检查并创建新版本。"
                                    : "你正在查看历史版本；修改请回到最新版本。"}
                                </p>
                                <button
                                  className="secondary-button"
                                  disabled={
                                    !dirty || !isLatest || Boolean(busy)
                                  }
                                  onClick={saveManual}
                                >
                                  <CheckCheck size={15} />
                                  保存并重新检查
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </fieldset>
                    )}
                    {tab === "review" && (
                      <div className="review-body">
                        {!current ? (
                          <EmptyState
                            icon={<ShieldCheck size={30} />}
                            title="检查结果将在这里呈现"
                            description="创建草稿或诊断已有文案后，可以查看字段风险、依据和处理建议。"
                          />
                        ) : (
                          <>
                            <div className="review-summary">
                              <span className="review-summary-icon">
                                <ShieldCheck size={23} />
                              </span>
                              <div>
                                <strong>
                                  {review!.issues.length
                                    ? "发现需要处理的内容"
                                    : "已执行检查未发现问题"}
                                </strong>
                                <p>
                                  完成 {review!.coverage.completed}/
                                  {review!.coverage.total} 项检查 ·
                                  正式上架状态未验证
                                </p>
                              </div>
                              <span className="tiny-badge warm">
                                {current.trace.actual_model_call
                                  ? "含模型辅助审阅"
                                  : "本地候选检查"}
                              </span>
                            </div>
                            <ReviewActions record={current} product={product} ruleVersion={data.rules.rule_pack_version} disabled={dirty || !isLatest || Boolean(busy)}
                              onRepair={reviewAllIssues} onFacts={() => { setFactsIssue(null); setFactsOpen(true); }}
                              onRecheck={() => execute(`/api/listings/${current.listing_id}/revisions`, {
                                base_version: current.version,
                                kind: "recheck_product",
                                // 没关联过的记录要带上"要关联哪一个"；已关联的不带，由服务端沿用快照里的商品
                                // （带错了会被 PRODUCT_MISMATCH 挡住，但那条路不该从界面上走去）。
                                ...(current.product_snapshot ? {} : { product_id: productId }),
                                product_revision: product?.revision,
                              })}
                              onExport={() => setExportOpen(true)} onCopy={async () => { try { await navigator.clipboard.writeText(outstandingText(current)); notify("待补资料清单已复制，可交给商品负责人核对。"); } catch { notify("剪贴板不可用，请导出审阅报告查看待补事项。", true); } }} />
                            <ParameterCoverage review={current.review} onLocate={focusField} />
                            {!!review?.evidence?.length && <details className="repair-section" aria-label="卖点证据对照">
                              <summary>卖点证据对照 · {review.evidence.length} 条原句</summary>
                              <p>商品资料版本：{current.product_ref || "未关联"}{current.product_change && ` · 本轮采用新版资料（${current.product_change.before} → ${current.product_change.after}）`}</p>
                              <p className="helper">逐句对照结构化参数；参数一致不代表认证、性能或整句语义已获证明。</p>
                              <p className="helper">已确认参数由程序关联来源，不依赖模型补写引用。来源记录支持参数对照，不代表已独立核验来源真实性。</p>
                              {review.evidence.map((entry, index) => <article className="source-card" key={`${entry.field_path}-${index}`}>
                                <strong>{entry.claim}</strong>
                                <p>{entry.state === "parameters_aligned" ? "参数已对照" : entry.state === "not_covered" ? "参数未在核对范围内" : entry.state === "partially_covered" ? "部分参数已关联，仍有未覆盖项" : "证据待补充"} · {entry.reason}</p>
                                {entry.association_method && <p>参数关联：程序执行 · 商品快照 {entry.product_ref} · 整句语义另行审阅</p>}
                                {entry.parameter_links?.map((link, index) => <p key={`${link.field}-${index}`}><code>{link.original}</code> → {factLabels[link.field] || '补充原文'}：{factText(link.field, link.value)}{link.method === 'material_presence_only' ? '（仅关联材质词，不增加含量宣称）' : link.method === 'recorded_original_dimension_tuple' ? '（按原单位及顺序关联；未确认宽、高、深分别对应哪一轴）' : ''} <button className="text-button" onClick={() => setSourcesOpen(link.source_ids)}>查看参数来源</button></p>)}
                                {entry.unresolved_parameters?.map((item, index) => <p className="warm-text" key={index}>待核对：{item.original} · {item.reason}</p>)}
                                {/* 认得出但档案里没这一项（目前是单件重量）：既不报错，也不假装查过。 */}
                                {entry.not_covered_parameters?.map((item, index) => <p className="muted" key={`nc-${index}`}>不在检查范围：<code>{item.original}</code> → {item.field_label || item.field} · {item.reason}</p>)}
                                {!entry.parameter_links?.length && entry.facts.map(fact => <p key={fact.field}>{factLabels[fact.field] || "原文补充资料"}：{factText(fact.field, fact.value)} <button className="text-button" onClick={() => setSourcesOpen(fact.source_ids)}>查看来源</button></p>)}
                                <button className="text-button" onClick={() => focusField(entry.field_path)}>定位原文</button>
                              </article>)}
                            </details>}

                            <div className="review-filters">
                              {[
                                { id: "all", label: "全部问题" },
                                { id: "platform_rules", label: "平台规则" },
                                {
                                  id: "target_country_claims_review",
                                  label: `${marketName(listingScope(current).marketplace).zh}宣称预审`,
                                },
                                {
                                  id: "product_fact_quality",
                                  label: "事实一致性",
                                },
                              ].map((filter) => (
                                <button
                                  key={filter.id}
                                  className={
                                    issueFilter === filter.id ? "selected" : ""
                                  }
                                  onClick={() => setIssueFilter(filter.id)}
                                >
                                  {filter.label}
                                </button>
                              ))}
                            </div>
                            {groupReviewIssues(current, visibleIssues).map(group => <section key={group.key} className={group.issues.length > 1 ? 'review-group' : undefined}>
                              {group.issues.length > 1 && <><h3>{group.label}</h3><p>同一参数待核对，影响 {group.issues.length} 处文案。补充一次资料后复检全部相关位置；原始发现和修复入口保留。</p></>}
                              {group.issues.length > 1 ? <details><summary>展开 {group.issues.length} 处原文与处理入口</summary>{group.issues.map(issue => <IssueCard key={issue.issue_id} issue={issue} citation={citationFor(issue.rule_id, issue.field_path)} onLocate={() => focusField(issue.field_path)} onSources={() => setSourcesOpen(issue.source_ids)} onFacts={() => { setFactsIssue(issue); setFactsOpen(true); }} onRepair={availablePatches.some(p => p.field_path === issue.field_path) ? () => { setSelectedPatches([availablePatches.find(p => p.field_path === issue.field_path)!.patch_id]); setPreviewPatches(true); } : undefined} disabled={!isLatest || Boolean(busy)} repairDisabled={dirty} />)}</details> : group.issues.map((issue) => (
                              <IssueCard
                                key={issue.issue_id}
                                issue={issue}
                                citation={citationFor(issue.rule_id, issue.field_path)}
                                onLocate={() => focusField(issue.field_path)}
                                onSources={() =>
                                  setSourcesOpen(issue.source_ids)
                                }
                                onFacts={issue.rule_id === "AMZ-05" || issue.category === "product_fact_quality" || issue.severity === "needs_review" ? () => { setFactsIssue(issue); setFactsOpen(true); } : undefined}
                                onRepair={availablePatches.some((patch) => patch.field_path === issue.field_path) ? () => {
                                  setSelectedPatches([availablePatches.find((patch) => patch.field_path === issue.field_path)!.patch_id]);
                                  setPreviewPatches(true);
                                } : undefined}
                                disabled={!isLatest || Boolean(busy)}
                                repairDisabled={dirty}
                              />
                            ))}</section>)}
                            {!visibleIssues.length && (
                              <div className="no-issues">
                                <CircleCheck size={25} />
                                <p>此分类下没有已发现的问题。</p>
                              </div>
                            )}
                            {current.repair_warnings?.map((warning) => <p className="helper warm-text" role="status" key={warning}>{warning}</p>)}
                            {availablePatches.length > 0 && (
                              <section className="repair-section">
                                <div className="section-heading">
                                  <div>
                                    <WandSparkles size={17} />
                                    <h3>局部修复建议</h3>
                                  </div>
                                  <span>{availablePatches.length} 处</span>
                                </div>
                                <p>只替换选中的字段，原版本始终保留。同一字段有多个建议时，只选择其中一条。</p>
                                {availablePatches.map((patch) => (
                                  <label
                                    className="patch-choice"
                                    key={patch.patch_id}
                                    data-patch-id={patch.patch_id}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={selectedPatches.includes(
                                        patch.patch_id,
                                      )}
                                      disabled={!isLatest || dirty}
                                      onChange={(e) =>
                                        setSelectedPatches((items) =>
                                          e.target.checked
                                            ? [...items.filter((id) => availablePatches.find((candidate) => candidate.patch_id === id)?.field_path !== patch.field_path), patch.patch_id]
                                            : items.filter(
                                                (x) => x !== patch.patch_id,
                                              ),
                                        )
                                      }
                                    />
                                    <span>
                                      <strong>
                                        {fieldLabel(patch.field_path)}
                                      </strong>
                                      <small>{patch.reason}</small>
                                    </span>
                                    <span className="tiny-badge">
                                      {methodLabel(patch.method)}
                                    </span>
                                  </label>
                                ))}
                                <button
                                  className="primary-button"
                                  disabled={
                                    !selectedPatches.length ||
                                    !isLatest ||
                                    dirty ||
                                    Boolean(busy)
                                  }
                                  onClick={() => setPreviewPatches(true)}
                                >
                                  <WandSparkles size={15} />
                                  预览 {selectedPatches.length || ""} 处修改
                                  <ArrowRight size={15} />
                                </button>
                              </section>
                            )}
                            <section className="coverage-section">
                              <h3>检查覆盖与资料缺口</h3>
                              <button className="secondary-button" disabled={Boolean(busy) || !isLatest} onClick={() => setFactsOpen(true)}>
                                核对 / 补充商品资料
                              </button>
                              {!isLatest && <p className="helper">当前为历史版本，请在“版本对比”中切换到最新版本后处理。</p>}
                              {review!.missing_data.map((x) => (
                                <div className="missing-row" key={x.field}>
                                  <CircleAlert size={15} />
                                  <span>
                                    <strong>{x.label}待确认</strong>
                                    {x.reason}
                                  </span>
                                </div>
                              ))}
                              <div className="checks-table">
                                {review!.checks.map((check) => (
                                  <div key={check.rule_id}>
                                    <code>{check.rule_id}</code>
                                    <span>
                                      {
                                        data.rules.rules.find(
                                          (x) => x.rule_id === check.rule_id,
                                        )?.title_zh
                                      }
                                    </span>
                                    <span
                                      className={`check-state ${check.state}`}
                                    >
                                      {{
                                        pass: "已执行 · 通过",
                                        fail: "发现问题",
                                        needs_evidence: "证据待核",
                                        not_checked: "未完成",
                                        error: "执行失败",
                                        not_applicable: "不适用",
                                      }[check.state] || check.state}
                                    </span>
                                    {check.reason && (
                                      <small>{check.reason}</small>
                                    )}
                                    {check.rule_id === "AMZ-05" && check.state !== "pass" && (
                                      <button className="text-button" disabled={Boolean(busy) || !isLatest} onClick={() => {
                                        setIssueFilter("all");
                                        const issue = review!.issues.find((item) => item.rule_id === "AMZ-05");
                                        if (issue) focusField(issue.field_path);
                                        else setFactsOpen(true);
                                      }}>处理准确性问题 <ArrowRight size={14} /></button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </section>
                          </>
                        )}
                      </div>
                    )}
                    {tab === "versions" && (
                      <div className="versions-body">
                        {!current ? (
                          <EmptyState
                            icon={<History size={30} />}
                            title="每次修改，都会留下记录"
                            description="创建草稿后，通过对话或字段编辑产生 V2、V3，并查看内容及风险变化。"
                          />
                        ) : (
                          <>
                            {/* 先给"这几版怎么变的"，再给逐版选择器：
                                "我改了五版到底有没有用"是这一页最先要回答的问题。 */}
                            <VersionTrend
                              listingId={current.listing_id}
                              versionCount={versions.length}
                            />
                            <div className="version-selector">
                              {versions.map((record) => (
                                <button
                                  key={record.version}
                                  className={
                                    current.version === record.version
                                      ? "selected"
                                      : ""
                                  }
                                  onClick={() => openRecord(record, "versions")}
                                >
                                  <span>V{record.version}</span>
                                  <small>{time(record.created_at)}</small>
                                </button>
                              ))}
                            </div>
                            <div className="version-context">
                              <span className="tiny-badge">
                                {current.operation === "create"
                                  ? "首次创建"
                                  : current.operation === "diagnose"
                                    ? "独立诊断"
                                    : current.operation === "patch"
                                      ? current.changes.length ? "字段修复" : "重新检查"
                                      : "对话修改"}
                              </span>
                              <p>
                                {current.instruction ||
                                  (current.version > 1 && !current.changes.length ? "本轮只重新检查，文案与上一版一致；审核结果另存新版本。" : "保留输入与检查结果，创建内容快照。")}
                              </p>
                            </div>
                            {current.risk_changes && (
                              <div className="risk-delta">
                                <span>
                                  <CircleCheck size={14} />
                                  本轮未再检出 {current.risk_changes.resolved.length}
                                </span>
                                <span>
                                  <CircleAlert size={14} />
                                  仍存在 {current.risk_changes.remaining.length}
                                </span>
                                <span>
                                  新增 {current.risk_changes.added.length}
                                </span>
                              </div>
                            )}
                            {current.changes.length ? (
                              current.changes.map((change) => (
                                <div
                                  className="diff-card"
                                  key={change.field_path}
                                >
                                  <h4>{fieldLabel(change.field_path)}</h4>
                                  <div className="diff-before">
                                    <span>修改前</span>
                                    <p>{change.before || "（空）"}</p>
                                  </div>
                                  <div className="diff-after">
                                    <span>修改后</span>
                                    <p>{change.after || "（移除）"}</p>
                                  </div>
                                </div>
                              ))
                            ) : (
                              <EmptyState
                                icon={<Layers3 size={26} />}
                                title={current.version === 1 ? "这是初始版本" : "本轮文案未变化"}
                                description={current.version === 1 ? "后续修改会在这里逐字段展示前后差异。" : "正文保持不变，本轮仅更新审核结果或采用的商品资料。"}
                              />
                            )}
                          </>
                        )}
                      </div>
                    )}
                    {current && (
                      <footer className="document-footer">
                        <span>
                          <span
                            className={`status-dot ${current.trace.actual_model_call ? "" : "amber"}`}
                          />
                          {current.trace.actual_model_call
                            ? "实际模型调用"
                            : "本地规则演示"}
                          <i />
                          商品事实快照已保存
                        </span>
                        <button onClick={() => setRunsOpen(true)}>
                          运行详情 <ArrowUpRight size={12} />
                        </button>
                      </footer>
                    )}
                  </div>
                  {current && (
                    <div><RevisionComposer value={instruction} onChange={setInstruction} scope={revisionScope} onScope={setRevisionScope} bullets={current.content.bullet_points} disabled={dirty || !isLatest || Boolean(busy)} readOnly={!isLatest} busy={Boolean(busy)} onSubmit={revise} onVersions={() => setTab("versions")} />{dirty && <p className="helper warm-text">请先保存手动编辑，再提交对话修改。</p>}</div>
                  )}
                </section>
              </div>}
            </>
          )}
          {view === "products" && (
            <ProductsPage
              amazonImport={amazonImport}
              products={data.products}
              selectedId={productId}
              onSelect={setProductId}
              onSources={setSourcesOpen}
              notify={notify}
              onSaved={async () => {
                await refresh();
              }}
              onCreate={() => newTask("create")}
            />
          )}
          {(view === "history" || view === "library") && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">MY RESULTS</div>
                  <h1>我的结果</h1>
                  <p>
                    上面是生成过的文案，下面是批量台账（按商品登记上架信息、导出选定版本）。
                  </p>
                </div>
                <button
                  className="primary-button"
                  onClick={() => newTask("create")}
                >
                  <Plus size={16} />
                  创建新文案
                </button>
              </div>
              <h2 className="results-section-title">生成过的文案</h2>
              <div className="history-controls">
                {[
                  { id: "all", label: "全部任务" },
                  { id: "listing_create", label: "新品创建" },
                  { id: "listing_diagnose", label: "已有文案诊断" },
                ].map((item) => (
                  <button
                    className={historyFilter === item.id ? "selected" : ""}
                    key={item.id}
                    onClick={() => setHistoryFilter(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
                <span>
                  {
                    data.listings.filter(
                      (x) =>
                        historyFilter === "all" || x.workflow === historyFilter,
                    ).length
                  }{" "}
                  个任务
                </span>
              </div>
              <div className="panel history-panel">
                {!data.listings.length ? (
                  <EmptyState
                    icon={<FileClock size={32} />}
                    title="第一份内容，从这里开始留存"
                    description="创建或诊断 Listing 后，版本与运行信息会自动保存在本机。"
                  />
                ) : (
                  data.listings
                    .filter(
                      (x) =>
                        historyFilter === "all" || x.workflow === historyFilter,
                    )
                    .map((record) => (
                      <button
                        className="history-row"
                        key={record.listing_id}
                        data-listing-id={record.listing_id}
                        onClick={() => openRecord(record)}
                      >
                        <span className="history-document">
                          <FileText size={22} />
                        </span>
                        <span className="history-name">
                          <strong>{record.content.title}</strong>
                          <small>
                            {record.workflow === "listing_create"
                              ? "新品创建"
                              : "已有文案诊断"}{" "}
                            · {record.product_snapshot?.name_zh || "未关联商品"}{" "}
                            · {time(record.created_at)}
                          </small>
                        </span>
                        <span className="tiny-badge">V{record.version}</span>
                        <span className="history-issues">
                          {record.review.issues.length} 项待处理
                        </span>
                        <ChevronRight size={17} />
                      </button>
                    ))
                )}
              </div>
              {/* 原来「我的结果」和「Listing 台账」是两个入口、两套列表，谁也分不清哪个放什么。
                  现在合成一页：上面是生成过的文案，下面是批量台账。台账的详情、登记与导出原样保留。 */}
              <ListingLibrary
                embedded
                notify={notify}
                onOpen={(record) => openRecord(record, "review")}
              />
            </>
          )}
          {view === "ruleMonitor" && <RuleMonitor rulePackVersions={data.rule_pack_versions} />}
          {view === "rules" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">KNOWLEDGE & EVIDENCE</div>
                  <h1>规则与资料来源</h1>
                  <p>明确适用范围，让检查结论有来源、可复核。</p>
                </div>
                <button
                  className="secondary-button"
                  onClick={() => setSourcesOpen([])}
                >
                  <Link2 size={16} />
                  全部来源
                </button>
              </div>
              <div className="rules-intro">
                <ShieldCheck size={25} />
                <div>
                  <strong>
                    {packMarketName(data.rules).label} · 棉布手提袋文本场景
                  </strong>
                  <p>
                    平台规则与{packMarketName(data.rules).zh}广告宣称证据预审。规则包{" "}
                    {data.rules.rule_pack_version}
                    ；未覆盖完整商品类型、图片、进口或全部国家要求。
                  </p>
                </div>
              </div>
              <div className="rule-grid">
                {data.rules.rules.map((rule) => (
                  <button
                    className="panel rule-card"
                    key={rule.rule_id}
                    onClick={() => setSourcesOpen(rule.source_ids)}
                  >
                    <span className="rule-top">
                      <code>{rule.rule_id}</code>
                      <ArrowUpRight size={15} />
                    </span>
                    <h3>{rule.title_zh}</h3>
                    <span className="tiny-badge">
                      {{
                        platform_rules: "平台规则",
                        target_country_claims_review: `${packMarketName(data.rules).zh}宣称预审`,
                        product_fact_quality: "事实质量",
                        system_integrity: "系统完整性",
                      }[rule.category] || rule.category}
                    </span>
                    <p>{rule.repair}</p>
                    <span className="rule-source">
                      <Link2 size={12} />
                      查看依据与来源
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          <footer className="page-footer">
            <span>
              Listing Studio <span className="footer-dot">·</span>{" "}
              为准确的商品内容而设计
            </span>
            <span>
              {site.marketLabel} <span className="footer-dot">·</span> 本地工作空间
            </span>
          </footer>
        </div>
      </main>
      {toast && (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <CircleAlert size={18} /> : <CircleCheck size={18} />}
          <span>{toast.message}</span>
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setToast(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {busy && (
        <div className="busy-overlay" role="status" aria-live="polite">
          <div>
            <LoaderCircle className="spin" size={22} />
            <span>
              <strong>
                {busy.stage}
                {/* 秒数不进无障碍名字：每秒重播一遍会把读屏用户烦死，进度由 stage 那句承担 */}
                <span className="busy-elapsed" aria-hidden="true"> · 已等 {busySeconds} 秒</span>
              </strong>
              <small>
                {runStatusNotice ? runStatusNotice : busy.provider === "demo"
                  ? "执行本地模板与规则候选检查"
                  : missingKeyCaption
                    ? settings.provider === "dify" || deepseekEndpoint
                      ? "没填 Key，这一步会直接报错，不用等"
                      : "没填 Key，是否报错取决于服务方"
                    : busySeconds > busyCeilingSeconds
                      ? `已超过本轮调用预计时间（约 ${busyCeilingSeconds} 秒），重试可能延长等待；仍在等服务端结论，不用重新点。`
                      : `真实模型调用中 · 单次超时 ${modelTimeoutSeconds} 秒，本轮约 ${busyCeilingSeconds} 秒；重试可能延长`}
              </small>
            </span>
            <span className="busy-pulse" />
          </div>
        </div>
      )}
      {factsOpen && current && (
        <Modal title="核对商品资料并重新诊断" subtitle="先保存资料，再采用新版资料复检。结果保存为当前任务的新版本，旧文案与商品快照保留。" onBeforeClose={() => { if (factsEditing) { notify('请先保存商品资料，或点“取消”放弃本次编辑。', true); return false; } if (evidenceEditing) { notify('请先保存或清空未提交材料。', true); return false; } return true; }} onClose={() => setFactsOpen(false)} wide>
          {factsIssue && <div className="fact-request"><strong>{issueKind(factsIssue)} · {factsIssue.title}</strong><blockquote>{factsIssue.original}</blockquote><p>{requestedEvidence(factsIssue)}</p><p>当前表单可更新商品规格；认证与检测材料仍需核验，不能用填写参数代替证明。</p></div>}
          {product && <EvidenceSubmission key={`${current.listing_id}-${factsIssue?.issue_id || 'all'}`} record={current} product={product} issue={factsIssue}
            onSaved={async () => { await refresh(); }} onEditingChange={setEvidenceEditing} onSources={setSourcesOpen} notify={notify}
            disabled={Boolean(busy) || dirty || !isLatest || factsEditing} />}
          <ProductsPage
            focused
            products={data.products}
            selectedId={productId}
            onSelect={setProductId}
            onSources={setSourcesOpen}
            notify={notify}
            onSaved={async () => { await refresh(); }}
            onEditingChange={setFactsEditing}
            onCreate={() => { setFactsOpen(false); newTask("create"); }}
          />
          <div className="issue-actions">
            <button className="secondary-button" disabled={factsEditing || evidenceEditing} onClick={() => setFactsOpen(false)}>返回文案</button>
            <button className="primary-button" disabled={factsEditing || evidenceEditing || !product || Boolean(busy) || dirty || !isLatest || Boolean(current.product_snapshot && product.product_id !== current.product_snapshot.product_id)} onClick={() => {
              setFactsOpen(false);
              execute(`/api/listings/${current.listing_id}/revisions`, {
                base_version: current.version,
                kind: "recheck_product",
                ...(current.product_snapshot ? {} : { product_id: product!.product_id }),
                product_revision: product!.revision,
              });
            }}>采用当前资料并复检（保存新版本）</button>
          </div>
          <p className="helper">{factsEditing ? "请先保存商品资料，或取消编辑后再离开此窗口。" : evidenceEditing ? "请先保存或清空未提交材料。" : dirty ? "当前文案有未保存修改，请先返回文案保存并重新检查。" : "认证、性能等证据仍需人工核验；补齐资料不代表所有检查自动通过。"}</p>
        </Modal>
      )}
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={async () => {
            await refresh();
            setSettingsOpen(false);
            notify("模型设置已保存在本机。");
          }}
        />
      )}
      {sourcesOpen !== null && (
        <Modal
          title="依据与资料来源"
          subtitle="区分商品事实、平台规则与内部检查；来源存在不代表整句已获证明。"
          onClose={() => setSourcesOpen(null)}
          wide
        >
          <div className="source-list">
            {data.sources
              .filter(
                (source) =>
                  !sourcesOpen.length || sourcesOpen.includes(source.source_id),
              )
              .map((source) => (
                <SourceCard key={source.source_id} source={source} />
              ))}
          </div>
        </Modal>
      )}
      {runsOpen && (
        <Modal
          title="运行记录"
          subtitle="实际调用、运行状态及来源选择均保留记录。"
          onClose={() => setRunsOpen(false)}
          wide
        >
          <div className="runs-list">
            {!data.runs.length ? (
              <EmptyState
                icon={<Clock3 size={28} />}
                title="还没有运行记录"
                description="创建或诊断后，可以在这里查看真实执行情况。"
              />
            ) : (
              data.runs.map((run) => (
                <div className="run-card" key={run.run_id}>
                  <div>
                    <span className={`run-status ${run.status}`}>
                      {run.status === "succeeded" ? (
                        <Check size={14} />
                      ) : run.status === "failed" ? (
                        <X size={14} />
                      ) : (
                        <Clock3 size={14} />
                      )}
                    </span>
                    <strong>
                      {{
                        create: "创建草稿",
                        diagnose: "独立诊断",
                        revise: "对话修改",
                        patch: "字段修复",
                      }[run.operation] || run.operation}
                    </strong>
                    <span className="tiny-badge">
                      {run.actual_model_call
                        ? "实际模型调用"
                        : run.provider === "demo"
                          ? "本地演示"
                          : "模型运行未完成"}
                    </span>
                    <time>{time(run.created_at)}</time>
                  </div>
                  <code>{run.run_id}</code>
                  <p>
                    {run.stage}
                    {run.elapsed_ms !== undefined
                      ? ` · ${(run.elapsed_ms / 1000).toFixed(1)}s`
                      : ""}
                    {run.provider !== "demo" ? ` · ${run.trace?.model || "未记录模型"}` : ""}
                  </p>
                  {run.error && (
                    <div className="run-failure">
                      <p className="error-text">
                        <strong>{run.error.title || "运行失败"}</strong>
                        <span>{run.error.message}</span>
                      </p>
                      {run.error.action && (
                        <p className="helper">下一步：{run.error.action}</p>
                      )}
                      {run.error.upstream?.code && (
                        <small className="run-failure-upstream">
                          上游错误码 {run.error.upstream.code}
                          {run.error.upstream.status
                            ? `（HTTP ${run.error.upstream.status}）`
                            : ""}
                          {run.error.code ? ` · 本机错误码 ${run.error.code}` : ""}
                        </small>
                      )}
                      {!run.error.upstream?.code && run.error.code && (
                        <small className="run-failure-upstream">
                          本机错误码 {run.error.code}
                        </small>
                      )}
                    </div>
                  )}
                  {run.trace?.provider_request_id && (
                    <small>服务调用 ID：{run.trace.provider_request_id}</small>
                  )}
                  {run.trace?.source_ids && (
                    <small>来源选择：{run.trace.source_ids.join("、")}</small>
                  )}
                  {run.status === "succeeded" && (
                    <button
                      className="text-button"
                      onClick={async () => {
                        const all = await api<Listing[]>(
                          `/api/listings/${run.listing_id}/versions`,
                        );
                        const record = all.find(
                          (x) => x.version === run.version,
                        );
                        if (record) {
                          setRunsOpen(false);
                          await openRecord(record);
                        }
                      }}
                    >
                      打开结果 <ArrowUpRight size={13} />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </Modal>
      )}
      {aplusOpen && current && (
        <Modal
          title="A+ 内容（对比表）"
          subtitle={`由 V${current.version} 已登记商品参数确定性生成 · 用作 A+ 模块素材`}
          onClose={() => setAplusOpen(false)}
        >
          <AplusPanel listingId={current.listing_id} version={current.version} />
        </Modal>
      )}
      {vocOpen && current && (
        <Modal
          title="竞品差评 · 买家痛点挖掘"
          subtitle={`按 V${current.version} 关联商品事实生成打痛点卖点 · 仅用已登记资料，不编造`}
          onClose={() => setVocOpen(false)}
        >
          <VocPanel listingId={current.listing_id} version={current.version} />
        </Modal>
      )}
      {keywordOpen && current && (
        <Modal
          title="搜索词覆盖核对"
          subtitle={`核对 V${current.version} 文案里哪些搜索词已覆盖、哪些缺失`}
          onClose={() => setKeywordOpen(false)}
        >
          <KeywordsPanel listingId={current.listing_id} version={current.version} />
        </Modal>
      )}
      {variantsOpen && current && (
        <Modal
          title="A/B 变体生成"
          subtitle={`同一商品事实 · 三版卖点角度 · 供点击/转化测试`}
          onBeforeClose={() => {
            if (variantsGenerating) {
              notify("变体正在生成，请等待结果保存后再关闭，避免重复提交。", true);
              return false;
            }
            if (variantsAdopting) {
              notify("独立复检正在运行，请等待结果保存后再关闭。", true);
              return false;
            }
            return true;
          }}
          onClose={() => setVariantsOpen(false)}
        >
          <VariantsPanel listingId={current.listing_id} version={current.version} onAdopted={record => {
            setVariantsOpen(false);
            void openRecord(record, "review", true);
          }} onAdoptingChange={setVariantsAdopting} onGeneratingChange={setVariantsGenerating} />
        </Modal>
      )}
      {rolesOpen && current && (
        <Modal
          title="补资料协同看板"
          subtitle={`按岗位分组待补资料 · 合规/美工/采购/运营各看各的`}
          onClose={() => setRolesOpen(false)}
        >
          <RolesPanel listingId={current.listing_id} version={current.version} />
        </Modal>
      )}
      {readinessOpen && current && (
        <Modal
          title="上架前完整度检查"
          subtitle={`按 V${current.version} 关联商品档案判断「距离可提交上架还差什么」`}
          onClose={() => setReadinessOpen(false)}
        >
          <ReadinessPanel listingId={current.listing_id} version={current.version} />
        </Modal>
      )}
      {variationOpen && current && (
        <Modal
          title="变体一致性审核"
          subtitle={`核对 V${current.version} 的父子 SKU、变体主题与文案中的颜色/件数`}
          onClose={() => setVariationOpen(false)}
        >
          <VariationPanel listingId={current.listing_id} version={current.version} />
        </Modal>
      )}
      {evidenceOpen && current && (
        <Modal
          title="证据生命周期台账"
          subtitle={`V${current.version} 关联商品已提交的核验材料`}
          onClose={() => setEvidenceOpen(false)}
        >
          <EvidenceLifecyclePanel listingId={current.listing_id} version={current.version} />
        </Modal>
      )}
      {exportOpen && current && (
        <Modal
          title={`导出 V${current.version}`}
          subtitle={`交付包保留${languageZhOf(current.language)}内容、商品快照、审核依据与版本记录。`}
          onClose={() => setExportOpen(false)}
        >
          <div className="export-readiness">
            <ShieldCheck size={21} />
            <div>
              <strong>{reviewState(current, data.rule_pack_versions).label} · 待运营确认</strong>
              <p>
                {current.review.issues.length} 项内容风险，
                {incompleteChecks(current)} 项检查未完成，
                {current.review.missing_data.length} 项资料待补充。
                {!current.trace.actual_model_call &&
                  "当前为本地演示，未执行完整模型语义审阅。"}
                导出不代表已通过 Amazon 上架审核。
              </p>
            </div>
          </div>
          <div className="export-options">
            {[
              {
                format: "html",
                icon: FileSearch,
                title: "在浏览器里看报告（可打印）",
                text: "不下载 · 新标签打开同一份报告，Ctrl/⌘+P 可直接另存 PDF",
                inline: true,
              },
              { format: "copy", icon: FileText, title: `仅${languageZhOf(current.language)}文案`, text: "TXT · 便于复制到运营工具，不含内部审阅说明" },
              {
                // 改稿工作单（第 15 轮自提 87）：给动手改稿的人一张纸，不是给存档的人。
                // 不下载、新标签打开，现场想打印就直接 Ctrl/⌘+P。
                format: "worklist",
                icon: ListChecks,
                title: "改稿工作单（按文案顺序）",
                text: "不下载 · 标题 → 亮点 → 五点 → 描述，每条带原文与标准改法",
                inline: true,
              },
              {
                format: "txt",
                icon: FileText,
                title: `${languageZhOf(current.language)}文案与审阅说明`,
                text: "TXT · 对客内容与内部说明分段保留",
              },
              {
                format: "json",
                icon: Boxes,
                title: "完整结构化结果",
                text: "JSON · 商品快照、检查、版本与调用信息",
              },
              {
                format: "html",
                icon: FileSearch,
                title: "下载可打印审阅报告",
                text: "HTML · 依据、问题、缺失项与文案",
                inline: false,
              },
            ].map(({ format, icon: Icon, title, text, inline }) => (
              <a
                key={`${format}-${inline}`}
                href={`/api/listings/${current.listing_id}/export?version=${current.version}&format=${format}${inline ? "&disposition=inline" : ""}`}
                onClick={() => setExportOpen(false)}
                {...(inline ? { target: "_blank", rel: "noreferrer" } : { download: true })}
              >
                <Icon size={23} />
                <span>
                  <strong>{title}</strong>
                  <small>{text}</small>
                </span>
                {/* 预览那只不是下载：用"打开"的箭头，免得商家以为是存盘。 */}
                {inline ? <ArrowUpRight size={17} /> : <ArrowDownToLine size={17} />}
              </a>
            ))}
          </div>
          <p className="modal-footnote">
            当前为
            {current.trace.actual_model_call
              ? "含模型辅助审阅的"
              : "本地规则演示的"}
            草稿结果，正式上架准备状态未验证。
          </p>
        </Modal>
      )}
      {previewPatches && current && (
        <Modal
          title="确认局部修改"
          subtitle="确认后会创建新版本并重新检查，原稿保留。"
          onClose={() => setPreviewPatches(false)}
          wide
        >
          <div className="patch-preview">
            {availablePatches
              .filter((p) => selectedPatches.includes(p.patch_id))
              .map((patch) => (
                <div className="diff-card" key={patch.patch_id}>
                  <h4>{fieldLabel(patch.field_path)}</h4>
                  <div className="diff-before">
                    <span>修改前</span>
                    <p>{patch.expected_before}</p>
                  </div>
                  <div className="diff-after">
                    <span>修改后</span>
                    <p>{patch.replacement || "（移除此处未支持的表达）"}</p>
                  </div>
                </div>
              ))}
          </div>
          <div className="modal-actions">
            <button
              className="secondary-button"
              onClick={() => setPreviewPatches(false)}
            >
              返回检查
            </button>
            <button className="primary-button" onClick={applySelected}>
              <CheckCheck size={16} />
              应用并重新检查
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Field({
  label,
  english,
  path,
  value,
  max,
  highlight,
  issues,
  onChange,
  rows,
  placeholder,
  compact = false,
}: {
  label: string;
  english?: string;
  path: string;
  value: string;
  max?: number;
  highlight: string;
  issues: Issue[];
  onChange: (text: string) => void;
  rows: number;
  placeholder?: string;
  compact?: boolean;
}) {
  const linked = issues.filter((x) => x.field_path === path);
  return (
    <div
      className={`content-field ${compact ? "compact" : ""} ${highlight === path ? "highlighted" : ""} ${linked.length ? "has-issues" : ""}`}
    >
      <label htmlFor={path}>
        {!compact && (
          <span>
            {label}
            {english && <small>{english}</small>}
          </span>
        )}
        {compact && <span className="sr-only">{label}</span>}
        {max && (
          <span
            className={`character-count ${count(value) > max ? "over" : ""}`}
          >
            {count(value)}
            <i>/ {max}</i>
          </span>
        )}
      </label>
      <textarea
        id={path}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {linked.length > 0 && (
        <div className="field-issue-hint">
          <CircleAlert size={12} />
          {linked.length} 条检查提示 · 保存后重新判断
        </div>
      )}
    </div>
  );
}
function EmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
/** 规则依据里那几个日期，只显示真正登记过的；没登记就不写，别用"—"占位假装查过。 */
const citationDates = (source: RuleCitation["sources"][number]) =>
  [
    source.document_date && `文件日期 ${source.document_date}`,
    source.effective_from && `生效 ${source.effective_from}`,
    source.updated_on && `更新 ${source.updated_on}`,
    source.checked_at && `核对于 ${source.checked_at}`,
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * 「这一条凭什么」。
 *
 * 关键不是把文件名列出来，而是**不让项目内部约定看起来像平台规定**：
 * 没有官方来源的规则，这里只写"我们自己的检查"，不出现任何官方口吻，
 * 也不给一个像官方文件的链接。判定由服务端 rules-doc.mjs 给，界面不自己猜。
 */
function RuleBasis({ citation }: { citation: RuleCitation }) {
  const official = citation.sources.filter((source) => source.is_official);
  const internal = citation.sources.filter((source) => !source.is_official);
  return (
    <details className="issue-basis">
      <summary>
        <ShieldCheck size={13} />
        依据 · {citation.basis_label}
      </summary>
      <div className="issue-basis-body">
        <p>
          <strong>查什么：</strong>
          {citation.constraint}
        </p>
        {official.length > 0 && (
          <>
            <p className="issue-basis-label">官方文件</p>
            {official.map((source) => (
              <p key={source.source_id} className="issue-basis-source">
                <span className="tiny-badge">{source.kind_label}</span>
                <strong>{source.publisher}</strong>
                {citationDates(source) && <span>{citationDates(source)}</span>}
                {source.url ? (
                  <a href={source.url} target="_blank" rel="noreferrer">
                    原始文件 <ArrowUpRight size={12} />
                  </a>
                ) : (
                  <span>（未登记公开链接）</span>
                )}
              </p>
            ))}
          </>
        )}
        {internal.length > 0 && (
          <>
            <p className="issue-basis-label">
              {official.length > 0 ? "另有项目内部约定" : "项目内部约定"}
            </p>
            <p className="issue-basis-source">
              这是我们自己加的检查，不是 Amazon 的平台规定
              {internal.some((source) => source.local_document)
                ? `；出处：${internal
                    .map((source) => source.local_document)
                    .filter(Boolean)
                    .join("、")}`
                : ""}
              。
            </p>
          </>
        )}
        {citation.note && <p className="issue-basis-note">{citation.note}</p>}
      </div>
    </details>
  );
}

function IssueCard({
  issue,
  citation,
  onLocate,
  onSources,
  onFacts,
  onRepair,
  disabled,
  repairDisabled,
}: {
  issue: Issue;
  /** 这条规则自己的依据（官方文件 / 项目内部约定）。拿不到就不显示，不编一份。 */
  citation?: RuleCitation;
  onLocate: () => void;
  onSources: () => void;
  onFacts?: () => void;
  onRepair?: () => void;
  disabled?: boolean;
  repairDisabled?: boolean;
}) {
  return (
    <article className={`issue-card ${issue.severity}`} data-rule-id={issue.rule_id}>
      <div className="issue-card-heading">
        <span className="issue-dot" />
        <h3>{issue.title}</h3>
        <span className="issue-level">
          {issue.severity === "blocking"
            ? "需要修正"
            : issue.severity === "needs_review"
              ? "证据待核"
              : "表达建议"}
        </span>
      </div>
      <button className="issue-quote" onClick={onLocate}>
        <span>{fieldLabel(issue.field_path)}</span>
        <p>{issue.original}</p>
        <ArrowUpRight size={14} />
      </button>
      <p>{issue.reason}</p>
      {citation ? <RuleBasis citation={citation} /> : <p className="helper">此版未记录该规则的依据，请保留原结论并人工核对。</p>}
      <div className="issue-suggestion">
        <WandSparkles size={14} />
        <span>{issue.suggestion}</span>
      </div>
      <div className="issue-actions">
        <button className="secondary-button" disabled={disabled} onClick={onLocate}>修改这段文案</button>
        {onRepair && <button className="primary-button" disabled={disabled || repairDisabled} onClick={onRepair}>预览修复</button>}
        {onFacts && <button className="secondary-button" disabled={disabled} onClick={onFacts}>核对 / 补充商品资料</button>}
      </div>
      <p className="helper">{disabled ? "请在最新版本中处理；运行期间请等待检查完成。" : repairDisabled ? "有未保存的文案修改，请先保存并重新检查。" : "按已确认的事实修改，删除无法证实的表述，再点击“保存并重新检查”。"}</p>
      <footer>
        <span>
          {issue.rule_id} · {methodLabel(issue.method)}
        </span>
        <button onClick={onSources}>
          <Link2 size={12} />
          查看依据
        </button>
      </footer>
    </article>
  );
}
function SourceCard({ source }: { source: Source }) {
  return (
    <article className="source-card">
      <div>
        <span
          className={`tiny-badge ${source.kind === "synthetic_demo" ? "warm" : ""}`}
        >
          {{
            official_platform_policy: "官方平台规则",
            official_regulatory_guidance: "官方监管指引",
            public_reference: "公开商品事实",
            merchant_product_extraction: "商品资料提取原文",
            synthetic_demo: "合成演示条件",
            project_check: "项目检查约定",
            merchant_input: "商家确认资料",
            merchant_submission: "提交材料 · 尚未核验",
            merchant_fact_source: "商家关联参数来源 · 未独立核验",
          }[source.kind] || source.kind}
        </span>
        <code>{source.source_id}</code>
      </div>
      <h3>{source.publisher || source.description || source.source_id}</h3>
      {source.description && <p>{source.description}</p>}
      {source.note && <p>{source.note}</p>}
      {source.checked_at && <small>资料采集于 {time(source.checked_at)}</small>}
      {Boolean(source.snapshot) && <details className="source-excerpt"><summary>查看保存的来源原文</summary><pre>{source.kind === 'merchant_submission' ? sourceExcerpt(source.snapshot) : sourceExcerpt(source.snapshot).slice(0, 18000)}</pre></details>}
      {source.url && (
        <a href={source.url} target="_blank" rel="noreferrer">
          查看原始资料 <ArrowUpRight size={14} />
        </a>
      )}
    </article>
  );
}

function SettingsModal({
  settings,
  onClose,
  onSaved,
}: {
  settings: Settings;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    ...settings,
    api_key: "",
    dify_create_api_key: "",
    dify_diagnose_api_key: "",
  });
  const [timeoutSeconds, setTimeoutSeconds] = useState(String((Number(settings.timeout_ms) || 60000) / 1000));
  const [clearSecrets, setClearSecrets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<
    | { state: "idle" }
    | { state: "running" }
    | {
        state: "done";
        ok: boolean;
        models: string[];
        endpoint: string | null;
        model_known: boolean | null;
        error: Run["error"] | null;
      }
  >({ state: "idle" });
  // 结果块在表单最下面，弹窗本身是滚动区（.modal 是 overflow:auto，底部按钮是 sticky）：
  // 不滚过去，人以为"点了没反应"。用 seq 计数，重复点也能再滚一次。
  const probeRef = useRef<HTMLDivElement | null>(null);
  const [probeSeq, setProbeSeq] = useState(0);
  useEffect(() => {
    if (probe.state !== "done") return;
    const node = probeRef.current;
    if (!node) return;
    const frame = requestAnimationFrame(() => {
      const scroller = node.closest(".modal") as HTMLElement | null;
      if (scroller) scroller.scrollTo({ top: scroller.scrollHeight });
    });
    return () => cancelAnimationFrame(frame);
  }, [probe.state, probeSeq]);
  const testConnection = async () => {
    setProbe({ state: "running" });
    setProbeSeq((n) => n + 1);
    try {
      const result = await post<{
        ok: boolean;
        models: string[];
        endpoint: string | null;
        model_known: boolean | null;
        error: Run["error"] | null;
      }>("/api/settings/probe", {
        base_url: form.base_url,
        model: form.model,
        api_key: form.api_key,
      });
      setProbe({ state: "done", ...result });
    } catch (e) {
      setProbe({
        state: "done",
        ok: false,
        models: [],
        endpoint: null,
        model_known: null,
        error: { code: "PROBE_FAILED", message: (e as Error).message },
      });
    }
  };
  const timeoutValue = timeoutSeconds.trim() === "" ? 60 : Number(timeoutSeconds);
  const timeoutValid = Number.isFinite(timeoutValue) && timeoutValue >= 5 && timeoutValue <= 180 && Number.isInteger(timeoutValue * 1000);
  const save = async () => {
    if (!timeoutValid) { setError("超时请输入 5–180 秒；留空将使用 60 秒。"); return; }
    setSaving(true);
    setError("");
    try {
      await post("/api/settings", {
        provider: form.provider,
        base_url: form.base_url,
        model: form.model,
        api_key: form.api_key,
        dify_base_url: form.dify_base_url,
        dify_create_api_key: form.dify_create_api_key,
        dify_diagnose_api_key: form.dify_diagnose_api_key,
        timeout_ms: Math.round(timeoutValue * 1000),
        ...(clearSecrets ? { clear_secrets: true } : {}),
      });
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title="模型与运行设置"
      subtitle="配置保存在本机服务端；密钥不会通过接口返回浏览器。"
      onClose={onClose}
    >
      <div className="settings-body">
        <div className="provider-choices">
          {[
            {
              key: "compatible" as const,
              label: "DeepSeek / 兼容接口",
              description: "默认 DeepSeek，也可接入其他兼容服务",
            },
            {
              key: "dify" as const,
              label: "Dify 工作流",
              description: "连接已有的创建与诊断工作流",
            },
          ].map((item) => (
            <button
              key={item.key}
              className={form.provider === item.key ? "selected" : ""}
              onClick={() => setForm({ ...form, provider: item.key })}
            >
              <span className="radio-indicator" />
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
              {form.provider === item.key && <Check size={16} />}
            </button>
          ))}
        </div>
        {form.provider === "compatible" && (
          <>
            <div className="settings-preset">
              <span>DeepSeek 官方服务</span>
              <button
                className="text-button"
                onClick={() =>
                  setForm({
                    ...form,
                    base_url: "https://api.deepseek.com",
                    model: "deepseek-flash",
                  })
                }
              >
                填入 DeepSeek 预设 <ArrowRight size={12} />
              </button>
            </div>
            <label className="form-label" htmlFor="base-url">
              服务地址（含 API 前缀）
            </label>
            <input
              id="base-url"
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              placeholder="https://your-provider.example/v1"
            />
            <label className="form-label" htmlFor="model-name">
              模型名称
            </label>
            <input
              id="model-name"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder="例如 deepseek-flash"
              list="model-presets"
            />
            <datalist id="model-presets">
              <option value="deepseek-flash" />
              <option value="deepseek-v4-pro" />
            </datalist>
            <label className="form-label" htmlFor="model-key">
              API Key{" "}
              {settings.has_api_key && (
                <span className="tiny-badge">已配置</span>
              )}
            </label>
            <input
              id="model-key"
              type="password"
              autoComplete="new-password"
              value={form.api_key}
              onChange={(e) => { setClearSecrets(false); setForm({ ...form, api_key: e.target.value }); }}
              placeholder={
                settings.has_api_key
                  ? "留空保留已配置的密钥"
                  : "仅本地服务时可按需要留空"
              }
            />
            <p className="helper">
              实际请求：<code>{previewEndpoint(form.base_url) || "（还没填服务地址）"}</code>
            </p>
            <div className="settings-probe">
              <button
                className="text-button"
                onClick={testConnection}
                disabled={probe.state === "running"}
              >
                {probe.state === "running" ? "正在连接…" : "测试连接"}
                {probe.state !== "running" && <ArrowRight size={12} />}
              </button>
              <span className="helper">只拉一次模型列表，不消耗生成额度，也不会保存配置。</span>
            </div>
            <div ref={probeRef}>
            {probe.state === "done" &&
              (probe.ok ? (
                <div className="probe-result ok" role="status">
                  <strong>连上了</strong>
                  <p>
                    {probe.models.length === 0
                      ? "这个地址回的是合法 JSON，但没有模型列表；地址和密钥至少是通的，能不能生成还得真跑一次才知道。"
                      : `服务商列出 ${probe.models.length} 个模型。`}
                  </p>
                  {probe.model_known === false && (
                    <p className="error-text">
                      当前填的「{form.model}」不在这个账号的模型列表里，保存前先改过来。
                    </p>
                  )}
                  {probe.models.length > 0 && (
                    <p className="helper">
                      可用：{probe.models.slice(0, 12).join("、")}
                      {probe.models.length > 12 ? ` 等 ${probe.models.length} 个` : ""}
                    </p>
                  )}
                </div>
              ) : (
                <div className="probe-result failed" role="alert">
                  <strong>{probe.error?.title || "连不上"}</strong>
                  <p>{probe.error?.message || "没有拿到原因。"}</p>
                  {probe.error?.action && <p className="helper">下一步：{probe.error.action}</p>}
                </div>
              ))}
            </div>
            <p className="helper">
              保存配置后，通过创建或诊断执行真实调用。地址与密钥只要有一个不对，
              执行时的报错会写明是哪一个。
            </p>
          </>
        )}
        {form.provider === "dify" && (
          <>
            <label className="form-label" htmlFor="dify-base">
              Dify API 地址
            </label>
            <input
              id="dify-base"
              value={form.dify_base_url}
              onChange={(e) =>
                setForm({ ...form, dify_base_url: e.target.value })
              }
            />
            <label className="form-label" htmlFor="dify-create">
              创建工作流 API Key{" "}
              {settings.has_dify_create_api_key && "（已配置）"}
            </label>
            <input
              id="dify-create"
              type="password"
              autoComplete="new-password"
              value={form.dify_create_api_key}
              onChange={(e) =>
                (setClearSecrets(false), setForm({ ...form, dify_create_api_key: e.target.value }))
              }
            />
            <label className="form-label" htmlFor="dify-diagnose">
              诊断工作流 API Key{" "}
              {settings.has_dify_diagnose_api_key && "（已配置）"}
            </label>
            <input
              id="dify-diagnose"
              type="password"
              autoComplete="new-password"
              value={form.dify_diagnose_api_key}
              onChange={(e) =>
                (setClearSecrets(false), setForm({ ...form, dify_diagnose_api_key: e.target.value }))
              }
            />
            <p className="helper">
              两个工作流接收 request_json，返回
              result_json。具体字段见工程接入文档。
            </p>
          </>
        )}
        {form.provider !== "demo" && (
          <>
            <label className="form-label" htmlFor="model-timeout">
              超时（秒）
            </label>
            <input
              id="model-timeout"
              type="number"
              min={5}
              max={180}
              step="0.001"
              value={timeoutSeconds}
              aria-invalid={!timeoutValid}
              aria-describedby="model-timeout-help"
              onChange={(e) => { setTimeoutSeconds(e.target.value); setError(""); }}
              onBlur={() => { if (!timeoutSeconds.trim()) setTimeoutSeconds("60"); }}
            />
          </>
        )}
        <p id="model-timeout-help" className={timeoutValid ? "helper" : "inline-error"} role={timeoutValid ? undefined : "alert"}>
          {timeoutValid ? "单次调用超时为 5–180 秒；留空使用 60 秒。生成和独立审阅会分别调用模型。" : "超时请输入 5–180 秒；留空将使用 60 秒。"}
        </p>
        <div className="settings-secrets">
          <button type="button" className="secondary-button" disabled={saving} onClick={() => {
            setClearSecrets(value => !value);
            setForm(value => ({ ...value, api_key: "", dify_create_api_key: "", dify_diagnose_api_key: "" }));
            setProbe({ state: "idle" });
          }}>{clearSecrets ? "撤销清除密钥" : "清除全部模型密钥"}</button>
          <p className="helper" role="status">{clearSecrets
            ? "保存配置后将清除兼容接口与两个 Dify 工作流的密钥；取消可保留原密钥。服务地址和模型名称保留。"
            : "密钥留空会保留原值。需要删除时，点清除全部模型密钥，再保存配置。"}</p>
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose}>
          取消
        </button>
        <button className="primary-button" disabled={saving || !timeoutValid} onClick={save}>
          {saving ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Check size={16} />
          )}
          保存配置
        </button>
      </div>
    </Modal>
  );
}

function ProductsPage({
  focused = false,
  amazonImport,
  products,
  selectedId,
  onSelect,
  onSources,
  notify,
  onSaved,
  onCreate,
  onEditingChange,
}: {
  focused?: boolean;
  amazonImport?: ReactNode;
  products: Product[];
  selectedId: string;
  onSelect: (id: string) => void;
  onSources: (ids: string[]) => void;
  notify: (message: string, error?: boolean) => void;
  onSaved: () => Promise<void>;
  onCreate: () => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const product =
    products.find((x) => x.product_id === selectedId) || products[0] || {
      product_id: "", revision: 0, name_zh: "", is_demo: false, reference_product_id: null,
      ...Object.fromEntries(["material", "dimensions_cm", "fabric_weight_gsm", "capacity_l", "handle_length_cm", "retail_pack_count", "brand", "color", "rated_load_kg"].map(key => [key, { value: null, status: "unknown", source_ids: [] }]))
    } as Product;
  const [editing, setEditing] = useState(!product.product_id);
  const [creating, setCreating] = useState(!product.product_id);
  const [saving, setSaving] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [factSources,setFactSources]=useState<FactBindings>({});
  const [extraFacts,setExtraFacts]=useState<ExtraFactInput[]>([]);
  // GPSR 两方：界面上填的是六个字符串，保存时按「全空即 null」交给服务端收口。
  const [parties,setParties]=useState<{manufacturer:Record<string,string>;eu_responsible:Record<string,string>}>({manufacturer:blankParty(),eu_responsible:blankParty()});
  useEffect(() => { onEditingChange?.(editing || saving); }, [editing, saving, onEditingChange]);
  function edit() {
    setFactSources({}); setExtraFacts(editableExtras(product));
    setParties({manufacturer: partyDraftFrom(product.manufacturer), eu_responsible: partyDraftFrom(product.eu_responsible)});
    setCreating(false);
    setFields({
      name_zh: product.name_zh,
      material: product.material.value || "",
      width: String(product.dimensions_cm.value?.width ?? ""),
      height: String(product.dimensions_cm.value?.height ?? ""),
      depth: String(product.dimensions_cm.value?.depth ?? ""),
      rated_load_kg: String(product.rated_load_kg?.value ?? ""),
      fabric_weight_gsm: String(product.fabric_weight_gsm.value ?? ""),
      capacity_l: String(product.capacity_l.value ?? ""),
      handle_length_cm: String(product.handle_length_cm.value ?? ""),
      retail_pack_count: String(product.retail_pack_count.value || ""),
      brand: product.brand.value || "",
      color: product.color.value || "",
    });
    setEditing(true);
  }
  function startNew() {
    setFactSources({}); setExtraFacts([]);
    setParties({manufacturer:blankParty(),eu_responsible:blankParty()});
    setCreating(true);
    setEditing(true);
    setFields({
      name_zh: "",
      material: "",
      width: "",
      height: "",
      depth: "",
      rated_load_kg: "",
      fabric_weight_gsm: "",
      capacity_l: "",
      handle_length_cm: "",
      retail_pack_count: "",
      brand: "",
      color: "",
    });
  }
  async function save() {
    setSaving(true);
    try {
      const input: Record<string, string | number | null> = { ...fields };
      for (const key of [
        "width",
        "height",
        "depth",
        "rated_load_kg",
        "fabric_weight_gsm",
        "capacity_l",
        "handle_length_cm",
        "retail_pack_count",
      ])
        input[key] = fields[key]?.trim() ? Number(fields[key]) : null;
      const saved = await post<Product>(
        creating
          ? "/api/products"
          : `/api/products/${product.product_id}/versions`,
        {
          ...(creating ? {} : { base_revision: product.revision }),
          fields: {
            ...input,
            fact_sources: factSources,
            additional_facts: extraFacts,
            manufacturer: partyFilled(parties.manufacturer) ? parties.manufacturer : null,
            eu_responsible: partyFilled(parties.eu_responsible) ? parties.eu_responsible : null,
          },
        },
      );
      onSelect(saved.product_id);
      await onSaved();
      setEditing(false);
      setCreating(false);
      notify(
        creating
          ? "新商品已保存，可用于创建和诊断。"
          : "商品新版本已保存，历史文案继续保留原快照。",
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      {!focused && <div className="page-heading">
        <div>
          <div className="eyebrow">PRODUCT FACTS</div>
          <h1>商品资料与证据</h1>
          <p>先确认事实，再组织内容。资料修改会创建新版本。</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={startNew}>
            <Plus size={16} />
            新增商品
          </button>
          <button className="primary-button" disabled={editing || saving || !product.product_id} onClick={onCreate}>
            <FilePenLine size={16} />
            使用当前商品创建
          </button>
        </div>
      </div>}
      {amazonImport}
      <div className={`products-grid ${focused ? "focused" : ""}`}>
        {!focused && <div className="product-list">
          {products.map((p) => (
            <button
              key={p.product_id}
              className={`panel product-choice ${p.product_id === product.product_id ? "selected" : ""}`}
              onClick={() => {
                onSelect(p.product_id);
                setEditing(false);
                setCreating(false);
              }}
            >
              <BagIllustration compact />
              <span>
                <strong>{p.name_zh}</strong>
                <small>
                  {p.amazon ? p.amazon.asin : measurement(p.fabric_weight_gsm.value, "g/m²")} · 资料 V{p.revision}
                </small>
                <span className="tiny-badge">
                  {p.amazon ? "Amazon 商品" : p.is_demo ? "演示规格" : "商家资料"}
                </span>
              </span>
              <ChevronRight size={16} />
            </button>
          ))}
        </div>}
        <section className="panel product-detail">
          <div className="panel-title">
            <div>
              <h2>{creating ? "新增商品资料" : product.name_zh}</h2>
              <p>
                {creating
                  ? "录入棉布袋规格，保存为商家确认资料"
                  : `${product.product_id} · V${product.revision}`}
              </p>
            </div>
            {!editing && (
              <button className="secondary-button" onClick={edit}>
                <FilePenLine size={15} />
                编辑资料
              </button>
            )}
          </div>
          {editing ? (
            <>
              <div className="product-edit-grid">
                {[
                  { key: "name_zh", label: "商品名称" },
                  { key: "material", label: "材质" },
                  { key: "width", label: "宽度 (cm)" },
                  { key: "height", label: "高度 (cm)" },
                  { key: "depth", label: "深度 (cm，可选)" },
                  { key: "rated_load_kg", label: "额定承重 (kg，未知可留空)" },
                  { key: "fabric_weight_gsm", label: "面料克重 (g/m²)" },
                  { key: "capacity_l", label: "容量 (L)" },
                  { key: "handle_length_cm", label: "提手长度 (cm)" },
                  { key: "retail_pack_count", label: "零售件数 / 包" },
                  { key: "brand", label: "品牌（未知可留空）" },
                  { key: "color", label: "颜色（未知可留空）" },
                ].map(({ key, label }) => (
                  <label key={key}>
                    {label}
                    <input
                      value={fields[key] || ""}
                      type={
                        [
                          "width",
                          "height",
                          "depth",
                          "rated_load_kg",
                          "fabric_weight_gsm",
                          "capacity_l",
                          "handle_length_cm",
                          "retail_pack_count",
                        ].includes(key)
                          ? "number"
                          : "text"
                      }
                      onChange={(e) =>
                        setFields({ ...fields, [key]: e.target.value })
                      }
                    />
                  </label>
                ))}
              </div>
              <details className="source-excerpt" open>
                <summary>GPSR 责任方（德国 / 欧盟站要求，选填；填一半也能存）</summary>
                <p className="helper">
                  GPSR 第 19 条要求报价页面上给出「制造商名称 + 邮政地址 + 电子地址」；
                  制造商在欧盟外时，还要一位欧盟责任人的同样三项。填了才会被生成侧引用，
                  缺哪一项审核清单会点出来。
                </p>
                <GpsrPartyFields
                  role="制造商（Hersteller）"
                  draft={parties.manufacturer}
                  onChange={(draft) => setParties({ ...parties, manufacturer: draft })}
                  disabled={saving}
                  hint="谁生产的就写谁；品牌方与制造商不是同一个时，写制造商。"
                />
                <GpsrPartyFields
                  role="欧盟责任人（EU-Verantwortlicher）"
                  draft={parties.eu_responsible}
                  onChange={(draft) => setParties({ ...parties, eu_responsible: draft })}
                  disabled={saving}
                  hint="制造商在欧盟境内时这一方不用填；在中国等地生产就必须有一位欧盟境内的责任人。"
                />
              </details>
              <ProductSourceEditor product={creating ? null : product} bindings={factSources} onBindings={setFactSources} extras={extraFacts} onExtras={setExtraFacts} disabled={saving} />
              <p className="helper">
                修改项标为商家确认；既有公开来源不会被伪装成新数据的依据。
              </p>
              <div className="modal-actions">
                <button
                  className="secondary-button"
                  onClick={() => {
                    setEditing(false);
                    setCreating(false);
                  }}
                >
                  取消
                </button>
                <button
                  className="primary-button"
                  disabled={saving}
                  onClick={save}
                >
                  {saving ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Check size={15} />
                  )}
                  {creating ? "保存商品" : "保存为新版本"}
                </button>
              </div>
            </>
          ) : (
            <>
              <AmazonSource product={product} />
              <ProductCompleteness product={product} onEdit={edit} />
              <GpsrPartiesView product={product} />
              {product.additional_facts?.length ? <details className="source-excerpt"><summary>补充原文资料（{product.additional_facts.length} 项）</summary><dl className="amazon-extra-facts">{product.additional_facts.map((fact, index) => <div key={index}><dt>{fact.label}</dt><dd>{fact.value}{fact.source && <p><a href={fact.source.url} target="_blank" rel="noreferrer">{fact.source.publisher} · {fact.source.applicable_model}</a><br />原文：{fact.source.excerpt}</p>}</dd></div>)}</dl></details> : null}
              <dl className="product-detail-facts">
                {[
                  {
                    label: "材质",
                    fact: product.material,
                    text: product.material.value || "未披露",
                  },
                  {
                    label: "尺寸",
                    fact: product.dimensions_cm,
                    text: dimensionsText(product),
                  },
                  {
                    label: "面料克重",
                    fact: product.fabric_weight_gsm,
                    text: measurement(product.fabric_weight_gsm.value, "g/m²"),
                  },
                  {
                    label: "容量",
                    fact: product.capacity_l,
                    text: measurement(product.capacity_l.value, "L"),
                  },
                  {
                    label: "提手长度",
                    fact: product.handle_length_cm,
                    text: measurement(product.handle_length_cm.value, "cm"),
                  },
                  {
                    label: "额定承重",
                    fact: product.rated_load_kg,
                    text: measurement(product.rated_load_kg?.value ?? null, "kg"),
                  },
                  {
                    label: "零售包装",
                    fact: product.retail_pack_count,
                    text: product.retail_pack_count.value
                      ? `${product.retail_pack_count.value} 件 / 包`
                      : "未知",
                  },
                  {
                    label: "品牌",
                    fact: product.brand,
                    text: product.brand.value || "待确认",
                  },
                  {
                    label: "颜色",
                    fact: product.color,
                    text: product.color.value || "待确认",
                  },
                ].map(({ label, fact, text }) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{text}</dd>
                    <span
                      className={`tiny-badge ${fact.status === "unknown" ? "warm" : ""}`}
                    >
                      {{
                        public_source: "官方公开资料",
                        confirmed: "已核对",
                        amazon_listing_claim: "Amazon 页面披露",
                        merchant_confirmed: "商家确认",
                        synthetic_demo: "合成演示条件",
                        unknown: "资料待补",
                      }[fact.status] || fact.status}
                    </span>
                    {fact.source_ids.length > 0 && (
                      <button
                        className="icon-button"
                        aria-label={`查看${label}来源`}
                        onClick={() => onSources(fact.source_ids)}
                      >
                        <Link2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </dl>
              <div className="evidence-note">
                <ShieldCheck size={20} />
                <div>
                  <strong>认证与性能证据待补充</strong>
                  <p>
                    当前没有关联降解、额定承重或认证证明。公开商品参数只支持相应规格描述。
                  </p>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
