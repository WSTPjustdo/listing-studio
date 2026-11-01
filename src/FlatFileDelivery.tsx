import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { post } from "./api";

export type ReportIssue = {
  sku: string;
  source_row: number;
  reported_row?: number;
  row?: number;
  code: string;
  type: string;
  message: string;
  match_state: string;
};
export type ProcessingReport = {
  id?: string;
  filename: string;
  imported_at?: string;
  issues: ReportIssue[];
  summary: {
    total: number;
    matched: number;
    unmatched: number;
    ambiguous: number;
    errors: number;
    warnings: number;
  };
};
type BatchFile = {
  id: string;
  rows: {
    row: number;
    sku: string;
    status: string;
    source?: { cells: string[] };
  }[];
  mapping?: Record<string, number>;
  template?: {
    filename: string;
    sheet: string;
    headers: string[];
    header_row: number;
    data_start_row: number;
    format: string;
  } | null;
  processing_reports?: ProcessingReport[];
  file_revision?: number;
  file_edits?: Record<string, Record<string, string>>;
  exports?: { id: string; filename: string; exported_at: string }[];
};
type Validation = {
  modified_rows?: number | number[];
  warnings?: (string | { message: string })[];
  issues?: { message: string; row?: number }[];
  upload_readiness?: string;
};
const base64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("文件读取失败。"));
    reader.readAsDataURL(file);
  });

export default function FlatFileDelivery({
  batch,
  onChanged,
}: {
  batch: BatchFile;
  onChanged: () => Promise<void>;
}) {
  const [format, setFormat] = useState("original");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [validation, setValidation] = useState<Validation | null>(null);
  const [editRow, setEditRow] = useState("");
  const [column, setColumn] = useState("");
  const [value, setValue] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [exportId, setExportId] = useState("");
  const [rowMode, setRowMode] = useState("auto");
  const report = batch.processing_reports?.at(-1);
  const failedRows = [
    ...new Set(
      report?.issues
        .filter(
          (issue) =>
            issue.match_state === "matched" &&
            issue.row &&
            /error|错误/i.test(issue.type),
        )
        .map((issue) => issue.row!) || [],
    ),
  ];
  const editableColumns =
    batch.template?.headers
      .map((header, index) => ({ header, index }))
      .filter(
        (item) =>
          ![
            "sku",
            "parent_sku",
            "parentage",
            "variation_theme",
            "relationship_type",
          ].some((key) => batch.mapping?.[key] === item.index),
      ) || [];

  async function download(validateOnly = false, onlyErrors = false) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const query = new URLSearchParams({
        format,
        ...(validateOnly ? { validate: "true" } : {}),
        ...(onlyErrors
          ? {
              rows: failedRows.join(","),
              only_rows: "true",
              allow_manual_content: "true",
            }
          : {}),
      });
      const response = await fetch(
        `/api/batches/${batch.id}/flat-file?${query}`,
      );
      if (!response.ok) {
        const result = await response.json();
        setValidation(result.error?.details?.validation || null);
        throw new Error(result.error?.message || "原表导出失败。");
      }
      if (validateOnly) {
        setValidation(await response.json());
        setNotice("文件回填检查完成，平台接收状态仍待 Amazon 处理报告确认。");
        return;
      }
      const disposition = response.headers.get("content-disposition") || "";
      const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
      const filename = encoded
        ? decodeURIComponent(encoded)
        : `inventory-result.${format === "original" ? batch.template?.format || "xlsx" : format}`;
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const deliveryId = response.headers.get("x-inventory-export-id");
      await onChanged();
      if (deliveryId) setExportId(deliveryId);
      setNotice(
        onlyErrors
          ? "已导出未复检的错误行修正稿，保留此前文案并应用手动修改。请核对后提交 Amazon，再回传新的处理报告。"
          : "已回填文案并导出原表副本，请按原模板要求提交。文件导出不代表平台接收或上架成功。",
      );
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function uploadReport(file: File) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("处理报告最多 5 MB。");
      await post(`/api/batches/${batch.id}/processing-report`, {
        filename: file.name,
        base64: await base64(file),
        ...(exportId ? { export_id: exportId } : {}),
        row_number_mode: rowMode,
      });
      await onChanged();
      setNotice("处理报告已保存在本机；无法确定对应商品的记录保持未关联。");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function selectCell(row: string, col: string) {
    setEditRow(row);
    setColumn(col);
    setConfirmed(false);
    setValue(
      batch.file_edits?.[row]?.[col] ??
        batch.rows.find((item) => item.row === Number(row))?.source?.cells[
          Number(col)
        ] ??
        "",
    );
  }
  async function saveEdit() {
    setBusy(true);
    setError("");
    try {
      await post(`/api/batches/${batch.id}/file-edits`, {
        base_revision: batch.file_revision || 0,
        confirmed,
        edits: [{ row: Number(editRow), column: Number(column), value }],
      });
      await onChanged();
      setConfirmed(false);
      setNotice("已保存手动修正。该值未经过模型复检，也不表示平台错误已解决。");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flat-file-delivery" aria-label="库存模板交付">
      <h3>回填库存模板</h3>
      {batch.template ? (
        <p>
          {batch.template.filename} · {batch.template.sheet} · 表头第{" "}
          {batch.template.header_row} 行。按原 SKU
          回填文案，保留其他列与父体行。
        </p>
      ) : (
        <p>此旧批次未保留原库存文件，请重新导入后使用原表回填。</p>
      )}
      <div className="issue-actions">
        <label>
          交付格式
          <select
            aria-label="库存模板交付格式"
            value={format}
            onChange={(event) => setFormat(event.target.value)}
          >
            <option value="original">保持原文件格式</option>
            <option value="xlsx">Excel XLSX</option>
            <option value="tsv">制表符 TSV</option>
            <option value="txt">制表符 TXT</option>
          </select>
        </label>
        <button
          className="secondary-button"
          disabled={busy || !batch.template}
          onClick={() => void download(true)}
        >
          检查回填条件
        </button>
        <button
          className="primary-button"
          disabled={busy || !batch.template}
          onClick={() => void download()}
        >
          <Download size={16} />
          回填并导出库存模板
        </button>
      </div>
      <div className="issue-actions">
        <label>
          报告对应文件
          <select
            aria-label="处理报告对应文件版本"
            value={exportId}
            onChange={(event) => setExportId(event.target.value)}
          >
            <option value="">最初导入的库存文件</option>
            {batch.exports?.map((item) => (
              <option key={item.id} value={item.id}>
                {new Date(item.exported_at).toLocaleString("zh-CN")} ·{" "}
                {item.filename}
              </option>
            ))}
          </select>
        </label>
        <label>
          报告记录号含义
          <select
            aria-label="处理报告记录号含义"
            value={rowMode}
            onChange={(event) => setRowMode(event.target.value)}
          >
            <option value="auto">不确定，保留歧义</option>
            <option value="data">商品记录序号（不含表头）</option>
            <option value="file">文件实际行号（含表头）</option>
          </select>
        </label>
        <label className="secondary-button">
          <Upload size={16} />
          导入 Amazon 处理报告
          <input
            aria-label="上传 Amazon 处理报告"
            type="file"
            accept=".xlsx,.csv,.tsv,.txt"
            disabled={busy || !batch.template}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadReport(file);
              event.target.value = "";
            }}
          />
        </label>
      </div>
      <p className="helper">
        XLSX 保留工作表及未修改单元格；转换为 TSV/TXT
        仅导出数据工作表。模板字段规则和实际平台接收结果仍需核对。
      </p>
      {error && (
        <p role="alert" className="batch-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {validation && (
        <div className="batch-check">
          {validation.issues?.map((issue, index) => (
            <p key={index}>
              {issue.row ? `第 ${issue.row} 行：` : ""}
              {issue.message}
            </p>
          ))}
          {validation.warnings?.map((warning, index) => (
            <p className="warm-text" key={index}>
              {typeof warning === "string" ? warning : warning.message}
            </p>
          ))}
        </div>
      )}
      {report && (
        <details open>
          <summary>
            平台处理报告：{report.filename} · 已关联 {report.summary.matched}/
            {report.summary.total} 条
          </summary>
          <p>
            保留平台原始错误，不将本地修正自动标为通过。历史报告保存在本批次。
          </p>
          <div className="batch-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU / 原表行</th>
                  <th>平台错误码</th>
                  <th>类型 / 关联</th>
                  <th>原始原因</th>
                </tr>
              </thead>
              <tbody>
                {report.issues.map((issue, index) => (
                  <tr key={index}>
                    <td>
                      {issue.sku || "未提供 SKU"}
                      <br />
                      {issue.row
                        ? `原表第 ${issue.row} 行`
                        : `报告第 ${issue.source_row} 行`}
                    </td>
                    <td>{issue.code}</td>
                    <td>
                      {issue.type} ·{" "}
                      {(
                        {
                          matched: "已关联",
                          unmatched: "未关联",
                          ambiguous: "有歧义",
                          conflict: "SKU 与行号冲突",
                        } as Record<string, string>
                      )[issue.match_state] || issue.match_state}
                    </td>
                    <td>{issue.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="batch-mapping">
            <label>
              修正原表行
              <select
                aria-label="平台错误修正行"
                value={editRow}
                onChange={(event) => selectCell(event.target.value, column)}
              >
                <option value="">选择原表行</option>
                {[
                  ...new Set(
                    report.issues
                      .filter(
                        (issue) => issue.match_state === "matched" && issue.row,
                      )
                      .map((issue) => issue.row!),
                  ),
                ].map((row) => (
                  <option key={row} value={row}>
                    第 {row} 行 ·{" "}
                    {batch.rows.find((item) => item.row === row)?.sku}
                  </option>
                ))}
              </select>
            </label>
            <label>
              修正字段
              <select
                aria-label="平台错误修正字段"
                value={column}
                onChange={(event) => selectCell(editRow, event.target.value)}
              >
                <option value="">选择列</option>
                {editableColumns.map((item) => (
                  <option key={item.index} value={item.index}>
                    {item.index + 1}. {item.header || "空表头"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            修正后的完整单元格内容
            <textarea
              aria-label="平台错误修正值"
              maxLength={10000}
              rows={3}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已核对该值与真实商品资料一致，保存后仍需平台重新处理。
          </label>
          <div className="issue-actions">
            <button
              className="secondary-button"
              disabled={busy || !editRow || column === "" || !confirmed}
              onClick={() => void saveEdit()}
            >
              保存此单元格修正
            </button>
            <button
              className="secondary-button"
              disabled={busy || !failedRows.length}
              onClick={() => void download(false, true)}
            >
              导出错误行修正稿（未复检）
            </button>
          </div>
        </details>
      )}
    </section>
  );
}
