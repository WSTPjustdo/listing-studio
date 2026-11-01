import { createRequestId } from "./requestId";
import { useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  BellRing,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  CircleHelp,
  ExternalLink,
  FileCheck2,
  Filter,
  Globe2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import "./rule-monitor.css";
import SiteRuleProfiles from "./SiteRuleProfiles";

type Market = "US" | "UK" | "DE" | "FR" | "ALL";
type Status = "已生效" | "即将生效" | "政策澄清" | "待核实";
type Entry = {
  id: string;
  title: string;
  market: Exclude<Market, "ALL">;
  category: string;
  status: Status;
  publishedAt: string;
  effectiveAt: string;
  summary: string;
  impact: string;
  source: string;
  createdAt: string;
};
const STORAGE_KEY = "listing-guardian-rule-monitor-v1";
const sources = [
  {
    name: "Amazon Seller Central · US",
    detail: "美国站官方帮助与政策",
    market: "US",
    url: "https://sellercentral.amazon.com/help/hub",
  },
  {
    name: "Amazon Seller Central · Europe",
    detail: "英国、德国、法国等欧洲站帮助入口",
    market: "EU",
    url: "https://sellercentral-europe.amazon.com/help/hub",
  },
  {
    name: "Amazon Services · Product Compliance",
    detail: "商品安全与合规信息入口",
    market: "ALL",
    url: "https://sellercentral.amazon.com/help/hub/reference/G200164330",
  },
  {
    name: "US FTC · Environmental Claims",
    detail: "美国环保宣称相关监管指引",
    market: "US",
    url: "https://www.ftc.gov/business-guidance/resources/environmental-claims-summary-green-guides",
  },
  {
    name: "European Commission",
    detail: "欧盟消费者保护与产品法规信息",
    market: "EU",
    url: "https://commission.europa.eu/law_en",
  },
  {
    name: "UK Government · Product Safety",
    detail: "英国商品安全监管信息",
    market: "UK",
    url: "https://www.gov.uk/guidance/product-safety-advice-for-businesses",
  },
];
const categories = [
  "Listing 内容",
  "标题与五点描述",
  "图片要求",
  "受限商品/类目",
  "Product Type / 属性",
  "变体关系",
  "商品安全/合规文件",
  "环保/性能/认证宣称",
  "其他",
];
const markets: { key: Market; label: string }[] = [
  { key: "ALL", label: "全部站点" },
  { key: "US", label: "美国 US" },
  { key: "UK", label: "英国 UK" },
  { key: "DE", label: "德国 DE" },
  { key: "FR", label: "法国 FR" },
];
const emptyDraft = {
  title: "",
  market: "US" as Exclude<Market, "ALL">,
  category: categories[0],
  status: "待核实" as Status,
  publishedAt: "",
  effectiveAt: "",
  summary: "",
  impact: "",
  source: "",
};
function safeSource(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const fields = [
    "id",
    "title",
    "market",
    "category",
    "status",
    "publishedAt",
    "effectiveAt",
    "summary",
    "impact",
    "source",
    "createdAt",
  ];
  return (
    fields.every((field) => typeof entry[field] === "string") &&
    Boolean(entry.id && entry.title && entry.summary) &&
    ["US", "UK", "DE", "FR"].includes(entry.market as string) &&
    ["已生效", "即将生效", "政策澄清", "待核实"].includes(
      entry.status as string,
    ) &&
    safeSource(entry.source as string) &&
    Number.isFinite(Date.parse(entry.createdAt as string))
  );
}
function loadEntries(): { entries: Entry[]; error: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      !parsed.every(isEntry) ||
      new Set(parsed.map((entry) => entry.id)).size !== parsed.length
    ) {
      throw new Error("Invalid saved entries");
    }
    return { entries: parsed, error: "" };
  } catch {
    return {
      entries: [],
      error:
        "无法读取本浏览器的规则记录，可能是存储受限或记录格式损坏。已保留原数据，暂不能新增或删除；请先备份并恢复浏览器存储后重试。",
    };
  }
}
export default function RuleMonitor({
  rulePackVersions = {},
}: {
  rulePackVersions?: Record<string, string>;
}) {
  const [initial] = useState(loadEntries);
  const [entries, setEntries] = useState<Entry[]>(initial.entries);
  const [storageError, setStorageError] = useState(initial.error);
  const [market, setMarket] = useState<Market>("ALL");
  const [status, setStatus] = useState("全部状态");
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [savedAt, setSavedAt] = useState("");
  const storageReadOnly = Boolean(initial.error);
  const validSource = safeSource(draft.source.trim());
  function persistEntries(next: Entry[]) {
    if (storageReadOnly) return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setEntries(next);
      setStorageError("");
      return true;
    } catch {
      setSavedAt("");
      setStorageError(
        "保存失败：浏览器存储不可用或空间不足。本次修改尚未保存，请保留表单内容，恢复存储后重试。",
      );
      return false;
    }
  }
  const filtered = useMemo(
    () =>
      entries
        .filter(
          (x) =>
            (market === "ALL" || x.market === market) &&
            (status === "全部状态" || x.status === status),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [entries, market, status],
  );
  const counts = useMemo(
    () => ({
      total: entries.length,
      live: entries.filter((x) => x.status === "已生效").length,
      upcoming: entries.filter((x) => x.status === "即将生效").length,
      verify: entries.filter((x) => x.status === "待核实").length,
    }),
    [entries],
  );
  function saveEntry() {
    if (!draft.title.trim() || !draft.summary.trim() || !validSource) return;
    const saved = persistEntries([
      {
        ...draft,
        id: createRequestId(),
        title: draft.title.trim(),
        summary: draft.summary.trim(),
        impact: draft.impact.trim(),
        source: draft.source.trim(),
        createdAt: new Date().toISOString(),
      },
      ...entries,
    ]);
    if (!saved) return;
    setDraft(emptyDraft);
    setShowForm(false);
    setSavedAt(
      new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    );
  }
  return (
    <div className="rule-monitor-page">
      <div className="page-heading rule-monitor-heading">
        <div>
          <div className="eyebrow">POLICY INTELLIGENCE</div>
          <h1>Amazon 规则监测</h1>
          <p>
            跟踪官方政策变化，评估对商品资料、证据链和 Listing 审核逻辑的影响。
          </p>
        </div>
        <button
          className="primary-button"
          onClick={() => setShowForm((v) => !v)}
        >
          <Plus size={16} />
          {showForm ? "收起记录表" : "登记规则变化"}
        </button>
      </div>
      <section className="rm-plan">
        <div className="rm-plan-icon">
          <BellRing size={21} />
        </div>
        <div className="rm-plan-copy">
          <strong>每周人工核验建议</strong>
          <p>
            建议团队每周检查 Amazon US、UK、DE、FR
            官方政策与监管一手来源；重点记录新增规则、生效日期、适用范围及产品影响。
          </p>
          <div className="rm-plan-meta">
            <span>
              <CalendarClock size={14} /> 由团队安排检查时间
            </span>
            <span>
              <Globe2 size={14} /> US / UK / DE / FR
            </span>
            <span>
              <ShieldCheck size={14} /> 官方来源优先
            </span>
          </div>
        </div>
        <span className="rm-plan-state">人工登记</span>
      </section>
      <SiteRuleProfiles rulePackVersions={rulePackVersions} />
      <div className="rm-stats">
        <article>
          <span>已登记变化</span>
          <strong>{counts.total}</strong>
          <small>当前浏览器手工记录</small>
        </article>
        <article>
          <span>已生效</span>
          <strong>{counts.live}</strong>
          <small>手工状态，需评估适用范围</small>
        </article>
        <article>
          <span>即将生效</span>
          <strong>{counts.upcoming}</strong>
          <small>需要提前准备</small>
        </article>
        <article>
          <span>待核实</span>
          <strong>{counts.verify}</strong>
          <small>不能直接作为规则结论</small>
        </article>
      </div>
      {storageError && (
        <div className="rm-storage-error" role="alert">
          <AlertCircle size={16} />
          <span>{storageError}</span>
        </div>
      )}
      {showForm && (
        <section className="panel rm-form">
          <div className="rm-section-title">
            <div>
              <h2>登记一条规则变化</h2>
              <p>只录入已找到来源的变化；无法核实的内容标记为「待核实」。</p>
            </div>
            <button
              className="icon-button"
              onClick={() => setShowForm(false)}
              aria-label="关闭"
            >
              ×
            </button>
          </div>
          <div className="rm-form-grid">
            <label>
              规则标题
              <input
                value={draft.title}
                maxLength={200}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="例如：某类商品新增合规文件要求"
              />
            </label>
            <label>
              适用站点
              <select
                aria-label="适用站点"
                value={draft.market}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    market: e.target.value as Exclude<Market, "ALL">,
                  })
                }
              >
                {markets
                  .filter((x) => x.key !== "ALL")
                  .map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.label}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              规则类别
              <select
                aria-label="规则类别"
                value={draft.category}
                onChange={(e) =>
                  setDraft({ ...draft, category: e.target.value })
                }
              >
                {categories.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              状态
              <select
                aria-label="状态"
                value={draft.status}
                onChange={(e) =>
                  setDraft({ ...draft, status: e.target.value as Status })
                }
              >
                {(["已生效", "即将生效", "政策澄清", "待核实"] as Status[]).map(
                  (x) => (
                    <option key={x}>{x}</option>
                  ),
                )}
              </select>
            </label>
            <label>
              发布日期
              <input
                type="date"
                value={draft.publishedAt}
                onChange={(e) =>
                  setDraft({ ...draft, publishedAt: e.target.value })
                }
              />
            </label>
            <label>
              生效日期
              <input
                type="date"
                value={draft.effectiveAt}
                onChange={(e) =>
                  setDraft({ ...draft, effectiveAt: e.target.value })
                }
              />
            </label>
            <label className="rm-wide">
              变化内容
              <textarea
                aria-label="变化内容"
                rows={3}
                maxLength={5000}
                value={draft.summary}
                onChange={(e) =>
                  setDraft({ ...draft, summary: e.target.value })
                }
                placeholder="说明官方发布了什么变化；如有旧要求与新要求，请分别写明。"
              />
            </label>
            <label className="rm-wide">
              对 Listing Guardian 的影响
              <textarea
                aria-label="对 Listing Guardian 的影响"
                rows={2}
                maxLength={3000}
                value={draft.impact}
                onChange={(e) => setDraft({ ...draft, impact: e.target.value })}
                placeholder="影响哪些商品资料、证据字段、审核规则或上架流程？"
              />
            </label>
            <label className="rm-wide">
              官方来源链接
              <input
                type="url"
                aria-label="官方来源链接"
                maxLength={4096}
                aria-invalid={Boolean(draft.source.trim()) && !validSource}
                aria-describedby="rm-source-help"
                value={draft.source}
                onChange={(e) => setDraft({ ...draft, source: e.target.value })}
                placeholder="https://..."
              />
              <small id="rm-source-help">
                填写完整的 HTTPS
                官方页面链接；链接格式校验不代表已核实政策内容。
              </small>
            </label>
          </div>
          <div className="rm-form-actions">
            <span>保存后记录仅保存在当前浏览器。</span>
            <button
              className="primary-button"
              disabled={
                !draft.title.trim() ||
                !draft.summary.trim() ||
                !validSource ||
                storageReadOnly
              }
              onClick={saveEntry}
            >
              <FileCheck2 size={16} />
              保存记录
            </button>
          </div>
        </section>
      )}
      {savedAt && (
        <div className="rm-saved" role="status">
          <CheckCircle2 size={15} /> 已保存记录 · {savedAt}
        </div>
      )}
      <section className="rm-content-grid">
        <div className="panel rm-log">
          <div className="rm-section-title">
            <div>
              <h2>规则变化台账</h2>
              <p>
                仅展示当前浏览器手工登记的记录；状态由登记人填写，不自动更新规则库或审核结论。空白台账不代表本周没有政策变化。
              </p>
            </div>
            <span className="rm-count">{filtered.length} 条</span>
          </div>
          <div className="rm-filters">
            <div className="rm-tabs">
              {markets.map((x) => (
                <button
                  key={x.key}
                  className={market === x.key ? "active" : ""}
                  aria-pressed={market === x.key}
                  onClick={() => setMarket(x.key)}
                >
                  {x.label}
                </button>
              ))}
            </div>
            <label className="rm-status-filter">
              <Filter size={14} />
              <select
                aria-label="按规则状态筛选"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option>全部状态</option>
                {(["已生效", "即将生效", "政策澄清", "待核实"] as Status[]).map(
                  (x) => (
                    <option key={x}>{x}</option>
                  ),
                )}
              </select>
            </label>
          </div>
          {filtered.length === 0 ? (
            <div className="rm-empty">
              <div>
                <Activity size={25} />
              </div>
              <strong>
                {entries.length
                  ? "当前筛选没有匹配记录"
                  : "暂时没有登记的规则变化"}
              </strong>
              <p>
                监测报告或团队核验到新变化后，可在这里登记。当前页面不会自动抓取
                Amazon 政策。
              </p>
              <button
                className="secondary-button"
                onClick={() => setShowForm(true)}
              >
                <Plus size={15} />
                {entries.length ? "登记规则变化" : "登记第一条变化"}
              </button>
            </div>
          ) : (
            <div className="rm-entry-list">
              {filtered.map((item) => (
                <article className="rm-entry" key={item.id}>
                  <div className="rm-entry-top">
                    <div>
                      <span className="rm-market-tag">
                        Amazon {item.market}
                      </span>
                      <span className="rm-category">{item.category}</span>
                    </div>
                    <span
                      className={`rm-status status-${item.status === "已生效" ? "live" : item.status === "即将生效" ? "upcoming" : item.status === "政策澄清" ? "clarify" : "verify"}`}
                    >
                      {item.status}
                    </span>
                  </div>
                  <h3>{item.title}</h3>
                  <p>{item.summary}</p>
                  {item.impact && (
                    <div className="rm-impact">
                      <strong>产品影响</strong>
                      {item.impact}
                    </div>
                  )}
                  <div className="rm-entry-foot">
                    <span>
                      发布日期：{item.publishedAt || "未注明"} · 生效日期：
                      {item.effectiveAt || "未注明"}
                    </span>
                    <div>
                      <a href={item.source} target="_blank" rel="noreferrer">
                        查看来源 <ExternalLink size={12} />
                      </a>
                      <button
                        title="删除记录"
                        aria-label={`删除记录：${item.title}`}
                        disabled={storageReadOnly}
                        onClick={() => {
                          if (
                            persistEntries(
                              entries.filter((x) => x.id !== item.id),
                            )
                          )
                            setSavedAt("");
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
        <aside className="rm-side">
          <section className="panel rm-sources">
            <div className="rm-side-heading">
              <BookOpen size={18} />
              <h2>官方信息源</h2>
            </div>
            <p>
              优先从官方政策页面核验，不以论坛、卖家群或搜索摘要作为最终依据。
              部分 Seller Central 页面需要登录；列出入口不代表已读取或核验正文。
            </p>
            {sources.map((s) => (
              <a
                className="rm-source"
                key={s.name}
                href={s.url}
                target="_blank"
                rel="noreferrer"
              >
                <span>
                  <strong>{s.name}</strong>
                  <small>{s.detail}</small>
                </span>
                <ArrowUpRight size={15} />
              </a>
            ))}
          </section>
          <section className="panel rm-checklist">
            <div className="rm-side-heading">
              <RefreshCw size={17} />
              <h2>每周检查范围</h2>
            </div>
            {[
              "Listing 内容、标题与五点描述",
              "主图及附图要求",
              "受限商品与类目合规",
              "Product Type 与必填属性",
              "父子变体关系",
              "商品安全与合规文件",
              "环保、性能及认证宣称",
              "US / UK / DE / FR 站点差异",
            ].map((x) => (
              <div className="rm-check" key={x}>
                <CheckCircle2 size={14} />
                {x}
              </div>
            ))}
            <div className="rm-note">
              <AlertCircle size={15} />
              <span>
                注意：Amazon
                政策具有站点、类目和商品范围差异。每条记录都应保留适用范围及核验日期。
              </span>
            </div>
          </section>
        </aside>
      </section>
      <div className="rm-disclaimer">
        <CircleHelp size={15} />
        <span>
          本模块是规则变化登记与追踪工作台。当前版本不具备后台自动爬取、Amazon
          账号授权或自动同步 ChatGPT
          定时任务的能力；请通过官方来源核验后登记，避免将未经证实的信息写入规则库。
        </span>
      </div>
    </div>
  );
}
