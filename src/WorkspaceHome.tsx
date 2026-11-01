import { useState } from "react";
import type { ReactNode } from "react";
import { RealSample } from "./RealSample";
import {
  ArrowRight,
  BookOpen,
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  FolderOpen,
  Search,
  SearchCheck,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { Bootstrap, Listing, View } from "./types";
import { listingScope } from "./listingScope";

export const incompleteChecks = (record: Listing) =>
  Math.max(0, record.review.coverage.total - record.review.coverage.completed);

/**
 * 这条结果是不是在旧规则下审的。
 *
 * 比较对象必须是**这条记录自己站点**的包版本：只看当前下拉站点的版本，
 * 打开一条德国站结果时会被拿去和美国包版本比，每条都显示「审核需更新」——
 * 这是"界面在报一个不存在的陈旧"。
 */
export function reviewState(record: Listing, packVersions?: Record<string, string>) {
  const expected = packVersions?.[listingScope(record).marketplace];
  if (expected && record.rule_pack_version !== expected)
    return { label: "审核需更新", tone: "purple" };
  if (record.review.issues.length) return { label: "待修复", tone: "orange" };
  if (
    incompleteChecks(record) ||
    record.review.missing_data.length ||
    record.review.status !== "reviewed_within_scope"
  )
    return { label: "待补充核验", tone: "purple" };
  return { label: "范围内已检查", tone: "green" };
}

export default function WorkspaceHome({
  amazonImport,
  data,
  onNavigate,
  onStart,
  onOpen,
  onGuided,
}: {
  amazonImport?: ReactNode;
  data: Bootstrap;
  onNavigate: (view: View) => void;
  onStart: (view: View) => void;
  onOpen: (record: Listing, tab: "editor" | "review") => void;
  onGuided: (mode: "improve" | "automatic") => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const attention = data.listings.filter(
    (record) =>
      reviewState(record, data.rule_pack_versions).tone === "orange",
  );
  const pending = data.listings.filter(
    (record) =>
      reviewState(record, data.rule_pack_versions).tone === "purple",
  );
  const records = data.listings
    .filter((record) => {
      const text =
        `${record.content.title} ${record.product_snapshot?.name_zh || ""}`.toLowerCase();
      return (
        text.includes(query.toLowerCase()) &&
        (filter === "all" ||
          (filter === "attention"
            ? reviewState(record, data.rule_pack_versions).tone ===
              "orange"
            : reviewState(record, data.rule_pack_versions).tone ===
              "purple"))
      );
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <div className="home-page guided-home" data-testid="two-path-home">
      <div className="guided-home-heading">
        <div className="eyebrow">LISTING STUDIO</div>
        <h1>从你手里的材料开始。</h1>
        <p>选一条适合你的路径，剩下的我们一步步完成。</p>
      </div>
      <div className="guided-choice-grid">
        <section className="guided-choice">
          <span className="app-icon blue">
            <FileText size={24} />
          </span>
          <h2>
            我有提示词，
            <br />
            帮我改进
          </h2>
          <p>
            带上你正在用的模板。结合真实商品资料，改进写法，再生成并检查文案。
          </p>
          <button
            className="primary-button"
            data-testid="choose-improve"
            onClick={() => onGuided("improve")}
          >
            改进我的提示词
            <ArrowRight size={16} />
          </button>
        </section>
        <section className="guided-choice">
          <span className="app-icon purple">
            <Sparkles size={24} />
          </span>
          <h2>
            我没有提示词，
            <br />
            帮我完成
          </h2>
          <p>
            上传工厂 Word、PDF、零散表格、微信截图或实拍备注，确认商品资料后整理写作要求和文案。
          </p>
          <button
            className="secondary-button"
            data-testid="choose-automatic"
            onClick={() => onGuided("automatic")}
          >
            从商品资料开始
            <ArrowRight size={16} />
          </button>
        </section>
      </div>
      <div className="guided-home-import">
        <FileText size={20} aria-hidden="true" />
        <div><strong>已有亚马逊标准模板？</strong><p>Excel / TSV 批量导入，核对字段、SKU 和父子变体，再逐行处理。</p></div>
        <button className="secondary-button" onClick={() => onNavigate("batch")}>批量导入模板 <ArrowRight size={16} /></button>
      </div>
      <p className="guided-home-caption">
        确认商品信息后再生成；支持美国、德国、英国、法国站棉布手提袋，语言与内部核对档位在下一步选择。
      </p>
      <RealSample />
      <details className="guided-home-more">
        <summary>更多功能与最近任务</summary>
        <div className="page-heading home-heading">
          <div>
            <div className="eyebrow">LISTING STUDIO / AMAZON</div>
            <h1>内容工作台</h1>
            <p>让商品表达更地道，让每一句都有依据。</p>
          </div>
          <span className="workspace-label">
            <span className="status-dot" />
            企业内部 · 运营工作空间
          </span>
        </div>

        <div className="home-stats">
          <button className="stat-card" onClick={() => onNavigate("products")}>
            <span className="app-icon blue">
              <Box size={21} />
            </span>
            <span>
              <small>商品资料</small>
              <strong>
                {data.products.length}
                <em>份</em>
              </strong>
            </span>
            <ChevronRight size={17} />
          </button>
          <button
            className={`stat-card ${filter === "attention" ? "selected" : ""}`}
            onClick={() =>
              setFilter(filter === "attention" ? "all" : "attention")
            }
          >
            <span className="app-icon orange">
              <CircleAlert size={21} />
            </span>
            <span>
              <small>待修复内容</small>
              <strong>
                {attention.length}
                <em>份</em>
              </strong>
            </span>
            <ChevronRight size={17} />
          </button>
          <button
            className={`stat-card ${filter === "pending" ? "selected" : ""}`}
            onClick={() => setFilter(filter === "pending" ? "all" : "pending")}
          >
            <span className="app-icon purple">
              <ShieldCheck size={21} />
            </span>
            <span>
              <small>待补充核验</small>
              <strong>
                {pending.length}
                <em>份</em>
              </strong>
            </span>
            <ChevronRight size={17} />
          </button>
        </div>

        {amazonImport}
        <div className="home-actions">
          <section className="create-card">
            <div className="feature-caption">
              <span className="app-icon blue">
                <Sparkles size={22} />
              </span>
              <span>新品内容制作</span>
              <span className="feature-tag">资料驱动</span>
            </div>
            <h2>
              从商品资料，
              <br />
              到商品 Listing。
            </h2>
            <p>
              保留真实规格，按所选站点和语言组织文案。
              <br />
              生成草稿的同时，检查内容风险。
            </p>
            <button
              className="primary-button"
              onClick={() => onStart("create")}
            >
              创建 Listing <ArrowRight size={17} />
            </button>
            <div className="feature-footer">
              <Check size={14} /> 标题与五点描述 <span /> 商品事实对照 <span />{" "}
              修改可追溯
            </div>
          </section>
          <section className="audit-card">
            <div className="feature-caption">
              <span className="app-icon purple">
                <SearchCheck size={22} />
              </span>
              <span>已有内容审核</span>
            </div>
            <h2>接着已有文案，继续处理。</h2>
            <p>
              区分自家初稿与竞品参考，带入关键词，核对有依据的表达后局部修改。
            </p>
            <div className="audit-checklist">
              <span>
                <ShieldCheck size={17} /> 平台文本规则
              </span>
              <span>
                <BookOpen size={17} /> 宣称与证据核对
              </span>
              <span>
                <Box size={17} /> 商品事实一致性
              </span>
            </div>
            <div className="audit-card-actions">
              <button
                className="secondary-button"
                onClick={() => onStart("diagnose")}
              >
                导入并审改 Listing <ArrowRight size={17} />
              </button>
            </div>
          </section>
        </div>

        <section className="task-section" aria-label="最近内容任务">
          <div className="section-title">
            <h2>
              最近任务 <span>{data.listings.length}</span>
            </h2>
            <button
              className="text-button"
              onClick={() => onNavigate("history")}
            >
              全部版本 <ChevronRight size={15} />
            </button>
          </div>
          <div className="task-toolbar">
            <div className="segmented-control" aria-label="任务筛选">
              {[
                { id: "all", label: "全部" },
                { id: "attention", label: "待修复" },
                { id: "pending", label: "待核验" },
              ].map((item) => (
                <button
                  key={item.id}
                  aria-pressed={filter === item.id}
                  className={filter === item.id ? "selected" : ""}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <label className="search-field">
              <Search size={17} />
              <input
                aria-label="搜索内容任务"
                placeholder="搜索商品或标题"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          <div className="task-list">
            {records.length ? (
              records.slice(0, 6).map((record) => (
                <button
                  className="task-row"
                  data-listing-id={record.listing_id}
                  key={record.listing_id}
                  onClick={() => onOpen(record, "review")}
                >
                  <span
                    className={`app-icon ${record.workflow === "listing_create" ? "blue" : "purple"}`}
                  >
                    <FileText size={21} />
                  </span>
                  <span className="task-name">
                    <strong>
                      {record.product_snapshot?.name_zh ||
                        "未关联商品的 Listing"}
                    </strong>
                    <small>{record.content.title}</small>
                  </span>
                  <span className="task-version">V{record.version}</span>
                  <span
                    className={`state-pill ${reviewState(record, data.rule_pack_versions).tone}`}
                  >
                    {reviewState(record, data.rule_pack_versions).label}
                  </span>
                  <ChevronRight size={17} />
                </button>
              ))
            ) : (
              <div className="task-empty">
                <FolderOpen size={30} />
                <strong>
                  {query || filter !== "all"
                    ? "没有符合条件的任务"
                    : "下一份好文案，从这里开始"}
                </strong>
                <p>
                  {query || filter !== "all"
                    ? "试试其他关键词，或切换到全部任务。"
                    : "创建或审核 Listing 后，文案、依据和版本都会保存在这里。"}
                </p>
                <button
                  className="text-button"
                  onClick={() => {
                    if (query || filter !== "all") {
                      setQuery("");
                      setFilter("all");
                    } else onNavigate("products");
                  }}
                >
                  {query || filter !== "all" ? "清除筛选" : "准备真实商品资料"}
                  <ArrowRight size={15} />
                </button>
              </div>
            )}
          </div>
        </section>

        <div className="workflow-note">
          <ShieldCheck size={19} />
          <div>
            <strong>为 Amazon 上架内容而设计</strong>
            <p>
              面向中国制造商与跨境电商运营团队。当前支持美国、德国、英国、法国站的
              棉布手提袋；审核范围以所选规则包及未完成检查为准，结果由运营确认。
            </p>
          </div>
          <button className="text-button" onClick={() => onNavigate("rules")}>
            查看审核范围 <ChevronRight size={15} />
          </button>
        </div>
      </details>
    </div>
  );
}
