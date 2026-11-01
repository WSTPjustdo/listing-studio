import { useEffect, useRef, useState } from "react";
import {
  Upload,
  ArrowRight,
  Download,
  RefreshCw,
  Pause,
  Play,
  FileSpreadsheet,
} from "lucide-react";
import { api, ApiError, post } from "./api";
import BatchIssueGroups, {
  type IssueGroup,
  type GroupAction,
} from "./BatchIssueGroups";
import type { Listing, Settings } from "./types";
import FlatFileDelivery, { type ProcessingReport } from "./FlatFileDelivery";
import BatchSummary, { type BatchSummaryData, type BatchRuleWork } from "./BatchSummary";

/*
 * 批量页的「站点 + 语言」选项。与服务端 store.mjs 的 SITE_LANGUAGES 一一对应：
 *   美国站 3 种（英 / 西 / 中文内部）、德国站 3 种（德 / 英 / 中文内部）、
 *   英国站 2 种（英 / 中文内部）、法国站 2 种（法 / 英语对照）。
 * internal 那一档只作内部核对，不能直接上架 —— 界面上要说出来，不能让商家拿中文稿上架。
 */
const BATCH_SITES = [
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

type BatchSite = (typeof BATCH_SITES)[number];

type Column = { key: string; label: string };
type Preview = {
  id: string;
  filename: string;
  sheets: string[];
  sheet: string;
  headers: string[];
  rows: { number: number; cells: string[] }[];
  mapping: Record<string, number>;
  columns: Column[];
  header_row?: number;
  selection_required?: boolean;
  warnings?: string[];
  profile?: string;
};
type Row = {
  row: number;
  sku: string;
  name: string;
  status: string;
  errors: string[];
  warnings: string[];
  error?: string;
  error_code?: string | null;
  error_category?: string;
  error_title?: string;
  error_action?: string;
  retryable?: boolean;
  record?: Listing | null;
  values: Record<string, string>;
};
type Batch = {
  groups?: IssueGroup[];
  group_actions?: GroupAction[];
  id: string;
  name: string;
  status: string;
  operation: string;
  provider: string;
  model: string;
  rows: Row[];
  summary?: BatchSummaryData;
  worklist?: BatchRuleWork[];
  retry?: {
    requested: number;
    requeued: number;
    skipped_non_failed: number;
    skipped_non_retryable: number;
    skipped_rows: { row: number; reason: string }[];
  };
  concurrency?: { mode: string; current: number; concurrency: number; backoff_ms?: number };
  file_revision?: number;
  file_edits?: Record<string, Record<string, string>>;
  processing_reports?: ProcessingReport[];
  mapping?: Record<string, number>;
  exports?: { id: string; filename: string; exported_at: string }[];
  template?: {
    filename: string;
    sheet: string;
    format: string;
    headers: string[];
    header_row: number;
    data_start_row: number;
  } | null;
};
type Summary = {
  id: string;
  name: string;
  status: string;
  total: number;
  completed: number;
};
/**
 * 这一批花了多少次模型调用、多少 token（GET /api/batches/:id/cost）。
 * price 只有在服务端配了单价时才非空——本项目不内置任何厂商价目表，
 * 没配就只报用量，界面上也必须如实说「未配置单价」，不许自己乘一个数出来。
 */
type BatchCost = {
  batch_id: string;
  rows: { total: number; with_calls: number; without_calls: number };
  calls: { total: number; ok: number; failed: number; retried: number; per_row: number | null; rows_max: number | null };
  tokens: { total: number | null; prompt: number | null; completion: number | null; unknown_calls: number; per_row: number | null };
  price: { currency: string; total: number; per_row: number | null; source: string } | null;
  /** 每行次数的实测基准（服务端 CALLS_PER_ROW）；没有基准时是 null，界面不许自己补一个数。 */
  expected?: { operation: string | null; calls_per_row: number | null; calls: number | null; delta: number | null };
  notes: string[];
};
const statusLabel: Record<string, string> = {
  queued: "排队中",
  running: "处理中",
  completed: "已完成 · 待确认",
  failed: "处理失败",
  skipped: "已跳过",
  preserved: "父体保留 · 不调用模型",
  blocked: "需修正",
  paused: "已暂停",
  finished: "本批处理结束",
};

/**
 * 确认页那句「每件几次模型调用」。
 *
 * 次数**只**从 bootstrap 下发的实测值读（`server/batch-cost.mjs` 的 `CALLS_PER_ROW`，
 * 出处 `scripts/batch-cost-probe.mjs --operation … --rows 12`：create 2 / diagnose 1 / optimize 2）。
 * 原来这里写的是 `operation === "diagnose" ? 1 : 2` —— 一个没量过的魔法数字，
 * 而 `/cost` 的说明文字又写「2 次/行」，两处口径各自维护，改一处就会打架。
 * 拿不到基准时明说"按实际用量"，不猜一个数出来。
 */
function estimateSentence(queued: number, perRow?: number) {
  if (!perRow) return "按实际模型用量计费。";
  return `每件 ${perRow} 次模型调用，本批预计 ${(queued * perRow).toLocaleString()} 次；格式异常可能重试，按实际模型用量计费。`;
}

export default function BatchWorkspace({
  settings,
  callsPerRow,
  onOpen,
  onRefresh,
}: {
  settings: Settings;
  /** 每行会调几次模型（服务端实测值，bootstrap 下发）。缺省时不编数字。 */
  callsPerRow?: Record<string, number>;
  onOpen: (listing: Listing) => void;
  onRefresh: () => Promise<unknown>;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<number[]>([]);
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>(
    {},
  );
  const [operation, setOperation] = useState("create");
  /*
   * 站点与语言：一个下拉选一对，提交时拆成 marketplace + language 两个字段。
   *
   * 以前批量页只有语言、没有站点 —— 结果是一批"德语"文案拿美国包审，
   * 而且界面上根本发不出 DE/UK/FR 的批次（后端支持了，界面没露出来）。
   * 这张表跟引导页、跟服务端 store.mjs 的 SITE_LANGUAGES 对齐：每站 2–3 种，
   * internal 那一档只作内部核对，不能直接上架。
   */
  const [siteKey, setSiteKey] = useState<string>(BATCH_SITES[0].key);
  const site: BatchSite = BATCH_SITES.find((item) => item.key === siteKey) ?? BATCH_SITES[0];
  const [duplicate, setDuplicate] = useState("skip");
  const [scope, setScope] = useState(false);
  const [checked, setChecked] = useState<Row[] | null>(null);
  const [activeId, setActiveId] = useState(
    () => { try { return localStorage.getItem("listing-batch-id") || ""; } catch { return ""; } },
  );
  const [batch, setBatch] = useState<Batch | null>(null);
  const [history, setHistory] = useState<Summary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [filter, setFilter] = useState("all");
  const [editRow, setEditRow] = useState<number | null>(null);
  const [headerRow, setHeaderRow] = useState("");
  const [retryResult, setRetryResult] = useState<Batch["retry"]>(undefined);
  const [cost, setCost] = useState<BatchCost | null>(null);
  const lastCostAt = useRef(0);
  useEffect(() => {
    setChecked(null);
  }, [mapping, selected, edits, operation, duplicate, scope]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    lastCostAt.current = 0;
    const refresh = async () => {
      try {
        const items = await api<Summary[]>("/api/batches");
        if (stopped) return;
        // Keep history selectable when the saved selection no longer exists.
        setHistory(items);
        let detail: Batch | null = null;
        if (activeId) {
          try {
            detail = await api<Batch>(`/api/batches/${encodeURIComponent(activeId)}`);
          } catch (cause) {
            if (stopped) return;
            setBatch(null);
            setCost(null);
            if (cause instanceof ApiError && cause.status === 404) {
              try { localStorage.removeItem("listing-batch-id"); } catch { /* This session can still recover. */ }
              setActiveId("");
              setError("上次打开的批次已不存在，请从批次列表选择其他批次或导入文件。");
              return;
            }
            throw cause;
          }
        }
        if (stopped) return;
        setBatch(detail);
        if (activeId && Date.now() - lastCostAt.current > 5000) {
          lastCostAt.current = Date.now();
          const usage = await api<BatchCost>(`/api/batches/${encodeURIComponent(activeId)}/cost`);
          if (!stopped) setCost(usage);
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        if (!stopped) timer = setTimeout(() => { void refresh(); }, 1500);
      }
    };
    void refresh();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeId]);
  function choose(id: string) {
    setRetryResult(undefined);
    setCost(null);
    lastCostAt.current = 0;
    setActiveId(id);
    try { localStorage.setItem("listing-batch-id", id); } catch { /* Keep this session usable. */ }
    setPreview(null);
    setError("");
    setFilter("all");
  }
  async function upload(uploaded: File, sheet?: string, header_row?: number) {
    setBusy(true);
    setError("");
    setChecked(null);
    try {
      if (uploaded.size > 5 * 1024 * 1024)
        throw new Error("文件最多 5 MB，请拆分后上传。");
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("文件读取失败。"));
        reader.readAsDataURL(uploaded);
      });
      const value = await post<Preview>("/api/batches/preview", {
        filename: uploaded.name,
        base64,
        sheet,
        header_row,
      });
      setPreview(value);
      setMapping(value.mapping);
      setHeaderRow(String(value.header_row || ""));
      setSelected(value.rows.map((r) => r.number));
      setEdits({});
      setFile(uploaded);
      setScope(false);
      setEditRow(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(dry_run: boolean) {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const result = await post<Batch>("/api/batches", {
        import_id: preview.id,
        mapping,
        selected,
        edits,
        operation,
        marketplace: site.market,
        language: site.language,
        duplicate,
        confirm_scope: scope,
        dry_run,
      });
      if (dry_run) setChecked(result.rows);
      else {
        choose(result.id);
        setBatch(result);
        await onRefresh();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function action(name: string, rows?: number[]) {
    if (!batch) return;
    setBusy(true);
    setError("");
    try {
      const result = await post<Batch>(`/api/batches/${batch.id}/${name}`, rows ? { rows } : {});
      setRetryResult(name === "retry" ? result.retry : undefined);
      setBatch(await api<Batch>(`/api/batches/${batch.id}`));
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const visibleRows =
    batch?.rows.filter((r) => filter === "all" || r.status === filter) || [];
  return (
    <div className="batch-workspace">
      <div className="page-heading">
        <div>
          <div className="eyebrow">BATCH WORKSPACE</div>
          <h1>批量商品工作台</h1>
          <p>导入正在使用的库存模板，按真实 SKU 处理文案，再回填原表。</p>
        </div>
        <a
          className="secondary-button"
          href="https://sellercentral.amazon.com/gp/help/external/581?locale=en-US"
          target="_blank"
          rel="noreferrer"
        >
          获取 Amazon 官方库存模板
        </a>
      </div>
      {error && (
        <div className="batch-error" role="alert">
          {error}
        </div>
      )}
      <section className="panel batch-upload">
        <FileSpreadsheet size={30} />
        <div>
          <h2>导入你的商品表</h2>
          <p>
            亚马逊 Excel .xlsx / CSV / TSV、TXT（UTF-8 或带 BOM 的 UTF-16）· 自动查找商品工作表与表头
            · 最多 2000 行、1000 列、5 MB。支持美国、德国、英国和法国站的棉布手提袋，按所选站点与语言处理。
          </p>
          <label className="primary-button">
            <Upload size={16} />
            {busy ? "处理中…" : "选择商品表"}
            <input
              aria-label="上传商品表"
              type="file"
              accept=".xlsx,.csv,.tsv,.txt"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </section>
      {preview && (
        <section className="panel batch-setup">
          <h2>1. 确认识别结果</h2>
          <p>
            {preview.filename} · {preview.rows.length} 行商品 · 表头第{" "}
            {preview.header_row || "待选择"}{" "}
            行。原文件与未映射列保存在本机，用于原表回填。
          </p>
          {preview.warnings?.map((warning, index) => (
            <p className="warm-text" key={index}>
              {warning}
            </p>
          ))}
          {preview.sheets.length > 1 && (
            <label>
              工作表
              <select
                value={preview.sheet}
                disabled={busy}
                onChange={(e) => file && void upload(file, e.target.value)}
              >
                {preview.sheets.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          )}
          <div className="journey-buttons">
            <label>
              表头行号
              <input
                aria-label="库存模板表头行号"
                type="number"
                min="1"
                max="10000"
                value={headerRow}
                onChange={(e) => setHeaderRow(e.target.value)}
              />
            </label>
            <button
              className="secondary-button"
              disabled={busy || !file || !headerRow}
              onClick={() =>
                file && void upload(file, preview.sheet, Number(headerRow))
              }
            >
              按此表头重新识别
            </button>
          </div>
          {preview.selection_required && (
            <p role="alert">
              尚未识别商品数据，请选择数据工作表或指定表头行，再继续。
            </p>
          )}
          <details className="batch-columns">
            <summary>
              已自动识别 {Object.values(mapping).filter((i) => i >= 0).length}{" "}
              列 · 查看或调整列对应关系
            </summary>
            <div className="batch-mapping">
              {preview.columns.map((c) => (
                <label key={c.key}>
                  {c.label}
                  <select
                    aria-label={`映射${c.label}`}
                    value={mapping[c.key] ?? -1}
                    onChange={(e) =>
                      setMapping({
                        ...mapping,
                        [c.key]: Number(e.target.value),
                      })
                    }
                  >
                    <option value={-1}>未提供 / 不使用</option>
                    {preview.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {i + 1}. {h || "空表头"}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </details>
          <details>
            <summary>查看原始表格（不丢弃未映射资料）</summary>
            <div className="batch-table-wrap">
              <table>
                <thead>
                  <tr>
                    {preview.headers.map((h, i) => (
                      <th key={i}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.number}>
                      {r.cells.map((c, i) => (
                        <td key={i}>{c}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <h2>2. 选择任务和商品</h2>
          <div className="batch-options">
            <label>
              这批商品要做什么
              <select
                aria-label="批量任务类型"
                value={operation}
                onChange={(e) => {
                  setOperation(e.target.value);
                  setScope(false);
                  setChecked(null);
                }}
              >
                <option value="create">生成新品文案</option>
                <option value="diagnose">检查已有文案（保留原文）</option>
                <option value="optimize">优化并检查已有文案</option>
              </select>
            </label>
            <label className="batch-language">
              这批商品的站点与文案语言
              <select
                aria-label="批量站点与语言"
                value={siteKey}
                onChange={(e) => {
                  setSiteKey(e.target.value);
                  setScope(false);
                  setChecked(null);
                }}
              >
                {BATCH_SITES.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
              <span className="helper">
                {site.tier === "internal"
                  ? "这一档只作内部核对，不能直接上架。"
                  : "规则按所选站点审，生成或优化按所选语言写；诊断保留原文。"}
              </span>
            </label>
            <label>
              遇到重复 SKU
              <select
                aria-label="重复SKU处理"
                value={duplicate}
                onChange={(e) => setDuplicate(e.target.value)}
              >
                <option value="skip">跳过重复商品</option>
                <option value="update">更新已有商品（空值保留）</option>
              </select>
            </label>
          </div>
          <label className="batch-scope">
            <input
              type="checkbox"
              checked={scope}
              onChange={(e) => setScope(e.target.checked)}
            />
            我确认未填写品类的商品均为棉布手提袋，本批使用{site.label}，按对应站点规则检查。
          </label>
          <p className="helper">
            SKU
            必须来自商家真实货号，缺失时阻止处理。父体行保留在原表，不调用模型；子体按各自资料处理。
          </p>
          <div className="batch-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      aria-label="选择全部商品"
                      type="checkbox"
                      checked={selected.length === preview.rows.length}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? preview.rows.map((r) => r.number)
                            : [],
                        )
                      }
                    />
                  </th>
                  <th>原表行</th>
                  {["sku", "name", "category", "material"].map((k) => (
                    <th key={k}>
                      {preview.columns.find((c) => c.key === k)?.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.number}>
                    <td>
                      <input
                        aria-label={`选择第${r.number}行`}
                        type="checkbox"
                        checked={selected.includes(r.number)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, r.number]
                              : selected.filter((n) => n !== r.number),
                          )
                        }
                      />
                    </td>
                    <td>{r.number}</td>
                    {["sku", "name", "category", "material"].map((k) => (
                      <td key={k}>
                        <input
                          aria-label={`第${r.number}行${k}`}
                          value={
                            edits[r.number]?.[k] ?? r.cells[mapping[k]] ?? ""
                          }
                          onChange={(e) =>
                            setEdits({
                              ...edits,
                              [r.number]: {
                                ...edits[r.number],
                                [k]: e.target.value,
                              },
                            })
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="batch-row-editor">
            修正某一行的完整资料
            <select
              aria-label="选择要修正的商品行"
              value={editRow ?? ""}
              onChange={(e) =>
                setEditRow(e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">选择原表行号</option>
              {preview.rows.map((r) => (
                <option key={r.number} value={r.number}>
                  第 {r.number} 行
                </option>
              ))}
            </select>
          </label>
          {editRow !== null && (
            <div className="batch-mapping">
              {preview.columns.map((c) => (
                <label key={c.key}>
                  {c.label}
                  <input
                    aria-label={`修正第${editRow}行${c.label}`}
                    value={
                      edits[editRow]?.[c.key] ??
                      preview.rows.find((r) => r.number === editRow)?.cells[
                        mapping[c.key]
                      ] ??
                      ""
                    }
                    onChange={(e) =>
                      setEdits({
                        ...edits,
                        [editRow]: {
                          ...edits[editRow],
                          [c.key]: e.target.value,
                        },
                      })
                    }
                  />
                </label>
              ))}
            </div>
          )}
          <button
            className="secondary-button"
            disabled={busy || !selected.length || preview.selection_required}
            onClick={() => void submit(true)}
          >
            检查导入内容
          </button>
          {checked && (
            <div className="batch-check">
              <h3>
                导入检查：{checked.filter((r) => r.status === "queued").length}{" "}
                件可处理 ·{" "}
                {checked.filter((r) => r.status === "skipped").length} 件跳过 ·{" "}
                {checked.filter((r) => r.status === "blocked").length} 件需修正
              </h3>
              {checked
                .filter(
                  (r) =>
                    r.errors.length ||
                    r.warnings.length ||
                    r.status === "skipped",
                )
                .map((r) => (
                  <div key={r.row}>
                    <strong>
                      第 {r.row} 行 · {r.sku || "缺少真实 SKU"}
                    </strong>
                    <span>
                      {r.status === "skipped"
                        ? "已存在，将跳过。"
                        : [...r.errors, ...r.warnings].join(" ")}
                    </span>
                    {r.errors.length > 0 && (
                      <button
                        className="text-button"
                        onClick={() =>
                          setSelected(selected.filter((n) => n !== r.row))
                        }
                      >
                        排除此行
                      </button>
                    )}
                  </div>
                ))}
              <p>
                预计 {checked.filter((r) => r.status === "queued").length}{" "}
                件商品；
                {settings.provider === "demo"
                  ? "请先配置本机真实模型，当前配置不能开始批量任务。"
                  : estimateSentence(
                      checked.filter((r) => r.status === "queued").length,
                      callsPerRow?.[operation],
                    )}
              </p>
              <button
                className="primary-button"
                disabled={
                  busy ||
                  settings.provider === "demo" ||
                  checked.some((r) => r.status === "blocked") ||
                  !checked.some((r) => r.status === "queued")
                }
                onClick={() => void submit(false)}
              >
                确认并开始批量处理 <ArrowRight size={16} />
              </button>
            </div>
          )}
        </section>
      )}
      {!preview && batch && (
        <section className="panel batch-results">
          <div className="section-heading">
            <h2>{batch.name}</h2>
            <span className="tiny-badge">{statusLabel[batch.status]}</span>
          </div>
          <FlatFileDelivery
            key={batch.id}
            batch={batch}
            onChanged={async () => {
              setBatch(await api<Batch>(`/api/batches/${batch.id}`));
              await onRefresh();
            }}
          />
          <p>
            {batch.rows.filter((r) => r.status === "completed").length} /{" "}
            {batch.rows.length} 件已处理 ·{" "}
            {batch.provider === "demo" ? "本地规则演示" : `配置模型 ${batch.model || "未记录"}`} ·
            已完成不代表平台审核通过
          </p>
          {batch.concurrency && (
            <p className="helper" aria-label="同时处理状态">
              当前最多同时处理 {batch.concurrency.current} 行
              {batch.concurrency.mode === "auto" ? " · 根据实际响应调整" : " · 固定处理数量"}
              {!!batch.concurrency.backoff_ms && " · 已触发限流，等待后继续派发"}
              。不重复提交已成功的行。
            </p>
          )}
          {cost && (
            <p className="helper" aria-label="模型调用与用量">
              {cost.calls.total === 0
                ? "本批还没有模型调用记录。"
                : `已调用模型 ${cost.calls.total.toLocaleString()} 次（成功 ${cost.calls.ok.toLocaleString()} · 失败 ${cost.calls.failed.toLocaleString()}${
                    cost.calls.retried ? ` · 格式重试 ${cost.calls.retried} 次` : ""
                  }），平均每件 ${cost.calls.per_row ?? "?"} 次`}
              {cost.calls.total > 0 &&
                `，用量 ${
                  cost.tokens.total === null ? "未知" : `${cost.tokens.total.toLocaleString()} token`
                }${cost.tokens.unknown_calls ? `（其中 ${cost.tokens.unknown_calls} 次没回报用量）` : ""}`}
              {cost.calls.total > 0 &&
                (cost.price
                  ? `，按已配置单价折算 ${cost.price.currency} ${cost.price.total}`
                  : "。未配置模型单价，只报用量，不折算金额")}
              {!!cost.expected?.delta && cost.expected.delta > 0 &&
                `。比按 ${cost.expected.calls_per_row} 次/件预计的 ${cost.expected.calls?.toLocaleString()} 次多 ${cost.expected.delta.toLocaleString()} 次（重试）`}
              {cost.rows.without_calls > 0 &&
                `。另有 ${cost.rows.without_calls} 件没有任何调用记录（尚未开始或失败在调用之前）`}
              。
            </p>
          )}
          {batch.summary && <BatchSummary summary={batch.summary} worklist={batch.worklist} />}
          <div className="issue-actions">
            {batch.status === "running" ? (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void action("pause")}
              >
                <Pause size={16} />
                暂停后续商品
              </button>
            ) : (
              batch.rows.some((r) => r.status === "queued") && (
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void action("resume")}
                >
                  <Play size={16} />
                  继续处理（使用当前模型）
                </button>
              )
            )}
            <button
              className="secondary-button"
              disabled={busy || !batch.rows.some((r) => r.status === "failed")}
              onClick={() => void action("retry")}
            >
              <RefreshCw size={16} />
              只重试失败商品
            </button>
            <a
              className="secondary-button"
              href={`/api/batches/${batch.id}/export`}
            >
              <Download size={16} />
              导出商品文案 Excel
            </a>
            <a
              className="secondary-button"
              href={`/api/batches/${batch.id}/export?type=issues`}
            >
              <Download size={16} />
              导出待处理事项 Excel
            </a>
            {batch.rows.some((r) => r.status === "failed") && (
              <a className="secondary-button" href={`/api/batches/${batch.id}/failed-rows/export`}>
                <Download size={16} />
                导出失败原行与原因
              </a>
            )}
          </div>
          {retryResult && (
            <div className={retryResult.requeued ? "batch-retry-note" : "batch-retry-note warn"} role="status">
              <p>
                本次请求 {retryResult.requested} 行，已重新排队 {retryResult.requeued} 行；
                跳过 {retryResult.skipped_non_failed} 行未失败任务、{retryResult.skipped_non_retryable} 行需先处理资料或配置的任务。
              </p>
              {!!retryResult.skipped_rows.length && (
                <ul>{retryResult.skipped_rows.map((item) => <li key={item.row}>第 {item.row} 行：{item.reason}</li>)}</ul>
              )}
            </div>
          )}
          {batch.status === "paused" && (
            <p className="helper">
              已暂停后续任务，正在运行的商品会先完成。模型设置变更也会暂停，确认后可继续。
            </p>
          )}
          <BatchIssueGroups
            key={batch.id}
            batchId={batch.id}
            groups={batch.groups || []}
            actions={batch.group_actions || []}
            processing={batch.rows.some((r) =>
              ["queued", "running"].includes(r.status),
            )}
            onChanged={async () => {
              setBatch(await api<Batch>(`/api/batches/${batch.id}`));
              await onRefresh();
            }}
          />
          <div className="review-filters">
            {[
              ["all", "全部"],
              ["completed", "已处理"],
              ["failed", "失败"],
              ["queued", "排队"],
              ["skipped", "跳过"],
              ["preserved", "父体保留"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={filter === key ? "selected" : ""}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="batch-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU / 商品</th>
                  <th>状态</th>
                  <th>结果 / 需要关注</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => (
                  <tr key={r.row}>
                    <td>
                      <strong>{r.sku}</strong>
                      <br />
                      {r.name}
                    </td>
                    <td>{statusLabel[r.status]}</td>
                    <td>
                      {r.error ? <>
                        <p>{r.error_title ? `${r.error_title}：` : ""}{r.error}</p>
                        {r.error_action && <p className="helper">下一步：{r.error_action}</p>}
                        <p className="helper">
                          {r.retryable === false ? "先处理上述问题，再重新提交或复检。" : "可仅重试这一行，已成功的行保留。"}
                          {r.error_code && `（${r.error_code}）`}
                        </p>
                      </> : (r.record
                          ? `${r.record.review.issues.length} 条问题 · ${r.record.review.missing_data.length} 项资料缺口 · ${r.record.review.coverage.pending} 项未完成检查`
                          : r.warnings.join(" "))}
                    </td>
                    <td>
                      {r.record && (
                        <button
                          className="text-button"
                          onClick={() => onOpen(r.record!)}
                        >
                          查看文案与问题
                        </button>
                      )}
                      {r.status === "failed" && r.retryable !== false && (
                        <button className="text-button" disabled={busy} onClick={() => void action("retry", [r.row])}>
                          <RefreshCw size={14} />
                          重试这一行
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="panel batch-history">
        <h2>批量任务记录</h2>
        <p className="helper">
          进度保存在本机。刷新或关闭页面不会清空；电脑和本地服务需要保持运行。
        </p>
        {!history.length ? (
          <p>上传第一份商品表开始。</p>
        ) : (
          history.map((h) => (
            <button key={h.id} onClick={() => choose(h.id)}>
              <span>{h.name}</span>
              <small>
                {h.completed}/{h.total} · {statusLabel[h.status]}
              </small>
              <ArrowRight size={16} />
            </button>
          ))
        )}
      </section>
    </div>
  );
}
