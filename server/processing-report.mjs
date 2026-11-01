import ExcelJS from "exceljs";
import { extname } from "node:path";
import { AppError } from "./domain.mjs";
import { parseDelimited } from "./flat-file.mjs";

const trim = (value) => String(value ?? "").trim();
const normalized = (value) =>
  trim(value)
    .toLowerCase()
    .replace(/[\s_\-\[\]()（）:：/\\.]/g, "");
const aliases = {
  sku: [
    "sku",
    "sellersku",
    "merchantsku",
    "卖家sku",
    "商品sku",
    "货号",
    "商品编码",
  ],
  reported_row: [
    "originalrecordnumber",
    "originalrownumber",
    "recordnumber",
    "rownumber",
    "原始记录编号",
    "原记录编号",
    "原始记录号",
    "原始行号",
    "记录编号",
    "行号",
  ],
  code: ["errorcode", "code", "错误代码", "错误码", "问题代码"],
  type: ["errortype", "severity", "type", "错误类型", "问题类型", "严重性"],
  message: [
    "errormessage",
    "message",
    "errordescription",
    "错误消息",
    "错误信息",
    "错误描述",
    "问题描述",
  ],
};
function locateHeader(grid) {
  let best = null;
  for (let number = 0; number < Math.min(grid.length, 100); number++) {
    const cells = grid[number];
    const mapping = Object.fromEntries(
      Object.entries(aliases).map(([key, names]) => [
        key,
        cells.findIndex((value) => names.includes(normalized(value))),
      ]),
    );
    const score = Object.values(mapping).filter((column) => column >= 0).length;
    if (
      score >= 2 &&
      (mapping.code >= 0 || mapping.message >= 0) &&
      (mapping.sku >= 0 || mapping.reported_row >= 0) &&
      (!best || score > best.score)
    )
      best = { score, number, mapping };
  }
  return best;
}

/** Parse the uploaded platform report. This records platform feedback without inventing results. */
export async function parseProcessingReport(
  filename,
  buffer,
  batch,
  source,
  options = {},
) {
  const rowNumberMode = options.row_number_mode || "auto";
  if (!["auto", "file", "data"].includes(rowNumberMode))
    throw new AppError(
      "REPORT_ROW_MODE",
      "报告行号模式应为自动、文件行号或数据记录号。",
    );
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array))
    throw new AppError("REPORT_FILE_REQUIRED", "请上传真实平台处理报告文件。");
  if (buffer.length > 10 * 1024 * 1024)
    throw new AppError(
      "REPORT_FILE_TOO_LARGE",
      "处理报告最多 10 MB，请按原文件拆分后导入。",
    );
  const format = extname(filename || "")
    .slice(1)
    .toLowerCase();
  if (!["xlsx", "csv", "tsv", "txt"].includes(format))
    throw new AppError(
      "REPORT_FILE_TYPE",
      "平台处理报告支持 xlsx、UTF-8 CSV、TSV 和 TXT。",
    );
  let candidates;
  try {
    if (format === "xlsx") {
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(buffer);
      candidates = book.worksheets.map((sheet) => {
        if (sheet.rowCount > 50000 || sheet.columnCount > 1000)
          throw new AppError(
            "REPORT_TABLE_LIMIT",
            "处理报告超过 50000 行或 1000 列。",
          );
        const grid = Array.from({ length: sheet.rowCount }, (_, index) =>
          Array.from(
            { length: sheet.columnCount },
            (_, column) => sheet.getCell(index + 1, column + 1).text,
          ),
        );
        return { sheet: sheet.name, grid, header: locateHeader(grid) };
      });
    } else {
      const text = new TextDecoder("utf-8", { fatal: true })
        .decode(buffer)
        .replace(/^\uFEFF/, "");
      const grid = parseDelimited(text, format === "csv" ? "," : "\t");
      if (grid.length > 50000 || grid.some((row) => row.length > 1000))
        throw new AppError(
          "REPORT_TABLE_LIMIT",
          "处理报告超过 50000 行或 1000 列。",
        );
      candidates = [{ sheet: null, grid, header: locateHeader(grid) }];
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "REPORT_PARSE",
      "处理报告无法读取；请确认文件有效、未加密，文本文件须为 UTF-8 编码。",
    );
  }
  const available = candidates.filter((candidate) => candidate.header);
  if (!available.length)
    throw new AppError(
      "REPORT_HEADERS",
      "未识别报告表头：至少需要 SKU 或原始记录编号，以及错误码或错误信息。请保留平台原始表头。",
    );
  const bestScore = Math.max(
    ...available.map((candidate) => candidate.header.score),
  );
  const best = available.filter(
    (candidate) => candidate.header.score === bestScore,
  );
  if (best.length > 1)
    throw new AppError(
      "REPORT_SHEET_AMBIGUOUS",
      "多个工作表都有处理报告表头，请仅保留需要导入的报告工作表后重试。",
    );
  const { grid, header, sheet } = best[0];
  const mapping = batch.mapping || source?.mapping || {};
  const skuColumn =
    Number.isInteger(mapping.sku) && mapping.sku >= 0 ? mapping.sku : -1;
  const batchByRow = new Map((batch.rows || []).map((row) => [row.row, row]));
  const sourceRows = source?.rows || [];
  const sourceByRow = new Map(sourceRows.map((row) => [row.number, row]));
  let manifest = null;
  if (options.export_manifest !== undefined) {
    manifest = options.export_manifest;
    if (
      !Array.isArray(manifest) ||
      !manifest.length ||
      manifest.some(
        (item) =>
          !Number.isSafeInteger(item.original_row) ||
          !sourceByRow.has(item.original_row) ||
          !Number.isSafeInteger(item.file_row) ||
          item.file_row < 1 ||
          !Number.isSafeInteger(item.record_number) ||
          item.record_number < 1 ||
          typeof item.sku !== "string" ||
          (skuColumn >= 0 &&
            trim(item.sku) !==
              trim(sourceByRow.get(item.original_row).cells?.[skuColumn])),
      ) ||
      ["original_row", "file_row", "record_number"].some(
        (key) =>
          new Set(manifest.map((item) => item[key])).size !== manifest.length,
      )
    )
      throw new AppError(
        "REPORT_EXPORT_MANIFEST",
        "报告对应的导出版本行号映射无效，请选择正确的导出文件版本。",
      );
  }
  const manifestByOriginal = manifest
    ? new Map(manifest.map((item) => [item.original_row, item]))
    : null;
  const fileRows = manifest
    ? new Map(manifest.map((item) => [item.file_row, item.original_row]))
    : new Map(sourceRows.map((row) => [row.number, row.number]));
  const recordRows = manifest
    ? new Map(manifest.map((item) => [item.record_number, item.original_row]))
    : null;
  const bySku = new Map();
  for (const original of sourceRows) {
    const sku = skuColumn >= 0 ? trim(original.cells?.[skuColumn]) : "";
    if (!sku) continue;
    if (!bySku.has(sku)) bySku.set(sku, []);
    bySku.get(sku).push(original.number);
  }
  const dataStart = source?.data_start_row || (source?.header_row || 1) + 1;
  const issues = [];
  for (let index = header.number + 1; index < grid.length; index++) {
    const cells = grid[index];
    if (!cells.some(trim)) continue;
    const get = (key) =>
      header.mapping[key] >= 0 ? trim(cells[header.mapping[key]]) : "";
    const sku = get("sku"),
      code = get("code"),
      message = get("message"),
      originalType = get("type"),
      numberText = get("reported_row");
    if (!code && !message && !originalType) continue;
    const reportedRow =
      /^\d+$/.test(numberText) &&
      Number(numberText) > 0 &&
      Number.isSafeInteger(Number(numberText))
        ? Number(numberText)
        : null;
    // Decide ambiguity against the complete original file/export, never against
    // only selected batch rows: excluding unselected rows can produce a false match.
    const absolute =
      reportedRow && rowNumberMode !== "data"
        ? fileRows.get(reportedRow) || null
        : null;
    const relativeNumber = reportedRow ? dataStart + reportedRow - 1 : null;
    const relative =
      reportedRow && rowNumberMode !== "file"
        ? recordRows
          ? recordRows.get(reportedRow) || null
          : sourceByRow.has(relativeNumber)
            ? relativeNumber
            : null
        : null;
    const possibleRows = [...new Set([absolute, relative].filter(Boolean))];
    const type = /warning|警告/i.test(originalType)
      ? "warning"
      : /error|错误|fatal/i.test(originalType)
        ? "error"
        : "unknown";
    const item = {
      sku,
      source_row: index + 1,
      reported_row: reportedRow,
      code,
      type,
      original_type: originalType,
      message,
      match_state: "unmatched",
      row_match: null,
    };
    if (sku) {
      const matches = bySku.get(sku) || [];
      if (matches.length > 1) {
        item.match_state = "ambiguous";
        item.match_reason = "原库存文件中 SKU 重复，未自动关联。";
      } else if (
        matches.length === 1 &&
        batchByRow.has(matches[0]) &&
        (!manifestByOriginal || manifestByOriginal.has(matches[0]))
      ) {
        const number = matches[0];
        if (numberText && (!reportedRow || !possibleRows.includes(number))) {
          item.match_state = "conflict";
          item.match_reason =
            "报告 SKU 与原始记录编号不能同时对应同一商品，未自动关联。";
        } else {
          item.match_state = "matched";
          item.row = number;
          item.row_match = reportedRow
            ? absolute === number && relative === number
              ? "sku"
              : absolute === number
                ? "sku_absolute"
                : "sku_data_relative"
            : "sku";
        }
      } else
        item.match_reason = matches.length
          ? "SKU 属于原表，但不在当前批次或所选导出版本中。"
          : "报告 SKU 不在原库存文件中；未按行号猜测。";
    } else if (possibleRows.length === 1) {
      if (batchByRow.has(possibleRows[0])) {
        item.match_state = "matched";
        item.row = possibleRows[0];
        item.row_match = absolute === item.row ? "absolute" : "data_relative";
        item.match_reason =
          "报告未给 SKU，依据唯一可对应的原始记录编号关联，请人工核对。";
      } else
        item.match_reason =
          "记录编号属于原文件，但不在当前批次中，未自动关联。";
    } else if (possibleRows.length > 1) {
      item.match_state = "ambiguous";
      item.match_reason =
        "原始记录编号可能是文件绝对行号或数据相对行号，未自动猜测。";
    } else item.match_reason = "没有可确认的 SKU 或原始记录编号，未自动关联。";
    issues.push(item);
  }
  if (!issues.length)
    throw new AppError(
      "REPORT_NO_ISSUES",
      "未识别到逐条处理报告记录；汇总数字不能替代商品上传结果。",
    );
  return {
    filename,
    format,
    sheet,
    header_row: header.number + 1,
    imported_at: new Date().toISOString(),
    status_source: "merchant_uploaded_platform_report",
    verified_with_amazon: false,
    row_number_mode: rowNumberMode,
    export_manifest_used: !!manifest,
    issues,
    summary: {
      total: issues.length,
      matched: issues.filter((item) => item.match_state === "matched").length,
      unmatched: issues.filter((item) => item.match_state === "unmatched")
        .length,
      ambiguous: issues.filter((item) => item.match_state === "ambiguous")
        .length,
      conflicts: issues.filter((item) => item.match_state === "conflict")
        .length,
      errors: issues.filter((item) => item.type === "error").length,
      warnings: issues.filter((item) => item.type === "warning").length,
    },
    warnings: [
      "报告来自商家上传文件，尚未向 Seller Central 在线核验；匹配报告不表示已修复或已上架。",
    ],
  };
}
