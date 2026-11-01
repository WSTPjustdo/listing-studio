import ExcelJS from "exceljs";
import { extname, basename } from "node:path";
import { createHash } from "node:crypto";
import { AppError } from "./domain.mjs";
import { decodeTableText, parseDelimited } from "./flat-file.mjs";

const trim = (value) => String(value ?? "").trim();
const mime = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};
const indexOf = (mapping, key, width) =>
  Number.isInteger(mapping[key]) && mapping[key] >= 0 && mapping[key] < width
    ? mapping[key]
    : -1;
const delimitedCell = (value, delimiter) => {
  const text = String(value ?? "");
  return text.includes(delimiter) || /["\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
};

/** Backfill reviewed content into the merchant's original file, preserving other columns. */
export async function exportFlatFile(store, batch, source, options = {}) {
  const {
    format = "original",
    rowNumbers,
    onlyRows = false,
    applyContent = true,
    allowManualContent = false,
  } = options;
  if (allowManualContent && !applyContent)
    throw new AppError(
      "CORRECTION_CONTENT_REQUIRED",
      "未复检修正稿须先回填已保存的真实审阅文案，不能回退到最初原表文案。",
    );
  const originalFormat =
    source?.format ||
    extname(source?.filename || "")
      .slice(1)
      .toLowerCase();
  const outputFormat = format === "original" ? originalFormat : format;
  if (!mime[outputFormat])
    throw new AppError(
      "FLAT_FILE_EXPORT_FORMAT",
      "导出格式应为原格式、xlsx、csv、tsv 或 txt。",
    );
  if (!source?.original_base64)
    throw new AppError(
      "FLAT_FILE_SOURCE_REQUIRED",
      "缺少原始库存文件，请重新导入真实文件后导出。",
    );
  if (source.selection_required)
    throw new AppError(
      "FLAT_FILE_SOURCE_SELECTION",
      "请先确认库存工作表、机器表头及数据行，再导出原表。",
    );
  const validation = {
    safe_to_export: false,
    issues: [],
    warnings: [],
    modified_rows: [],
    modified_cells: 0,
    format: outputFormat,
    source_format: originalFormat,
    only_rows: onlyRows,
    operation: allowManualContent
      ? "manual_correction_unreviewed"
      : applyContent
        ? "content_backfill"
        : "source_rows_only",
    upload_readiness: "not_verified",
  };
  const issue = (code, message, row, field = "", severity = "error") => {
    const item = {
      row: row?.row ?? null,
      sku: row?.sku || "",
      field,
      code,
      severity,
      message,
    };
    validation.issues.push(item);
    if (severity === "warning") validation.warnings.push(message);
  };
  const refuse = () => {
    const errors = validation.issues.filter(
      (item) => item.severity === "error",
    );
    if (!errors.length) return;
    const error = new AppError(
      "FLAT_FILE_EXPORT_UNSAFE",
      errors[0].message +
        (errors.length > 1 ? `（共 ${errors.length} 项需处理）` : ""),
    );
    error.details = { validation };
    error.validation = validation;
    throw error;
  };
  const allRows = batch?.rows || [];
  const sourceRows = source.rows || [];
  const sourceByNumber = new Map(sourceRows.map((row) => [row.number, row]));
  let chosen;
  if (rowNumbers !== undefined) {
    if (
      !Array.isArray(rowNumbers) ||
      !rowNumbers.length ||
      rowNumbers.some((number) => !Number.isInteger(number)) ||
      new Set(rowNumbers).size !== rowNumbers.length
    )
      throw new AppError("FLAT_FILE_EXPORT_ROWS", "请选择不重复的原商品行号。");
    const numbers = new Set(rowNumbers);
    chosen = allRows.filter((row) => numbers.has(row.row));
    if (chosen.length !== numbers.size)
      throw new AppError(
        "FLAT_FILE_EXPORT_ROWS",
        "导出行号不属于当前批次，请刷新后重试。",
      );
  } else chosen = allRows;
  if (!chosen.length)
    throw new AppError("FLAT_FILE_EXPORT_ROWS", "没有可导出的商品行。");
  const chosenNumbers = new Set(chosen.map((row) => row.row));
  const mapping = batch.mapping || source.mapping || {};
  const width = source.column_count || source.headers?.length || 0;
  const skuIndex = indexOf(mapping, "sku", width);
  const protectedSkuColumns = new Set(
    (source.headers || []).flatMap((header, column) =>
      /^(sku|sellersku|itemsku|merchantsku|卖家sku|商品sku|货号|商品编码)$/i.test(
        trim(header).replace(/[\s_\-]/g, ""),
      )
        ? [column]
        : [],
    ),
  );
  if (skuIndex >= 0) protectedSkuColumns.add(skuIndex);
  const changes = new Map();
  const skuCounts = new Map();
  if (skuIndex >= 0)
    for (const row of sourceRows) {
      const sku = trim(row.cells?.[skuIndex]);
      if (sku) skuCounts.set(sku, (skuCounts.get(sku) || 0) + 1);
    }
  const put = (row, column, value, field) => {
    const text = String(value ?? "");
    if (outputFormat === "xlsx" && text.length > 32767) {
      issue(
        "CELL_TOO_LONG",
        `原表第 ${row.row} 行的 ${field} 超过 Excel 单元格长度，不能完整回填。`,
        row,
        field,
      );
      return;
    }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
      issue(
        "INVALID_CELL_TEXT",
        `原表第 ${row.row} 行的 ${field} 含无效控制字符。`,
        row,
        field,
      );
      return;
    }
    if (protectedSkuColumns.has(column)) {
      issue(
        "SKU_EDIT_FORBIDDEN",
        `原表第 ${row.row} 行 SKU 列不能被文案或字段修正覆盖。`,
        row,
        field,
      );
      return;
    }
    if (!changes.has(row.row)) changes.set(row.row, new Map());
    changes.get(row.row).set(column, text);
  };
  const applyEdits = (row, edits, kind) => {
    for (const [key, value] of Object.entries(edits)) {
      const column = Number(key);
      if (
        !/^\d+$/.test(key) ||
        !Number.isInteger(column) ||
        column < 0 ||
        column >= width ||
        typeof value !== "string"
      ) {
        issue(
          "INVALID_FILE_EDIT",
          `原表第 ${row.row} 行的${kind}字段修正无效。`,
          row,
        );
        continue;
      }
      put(
        row,
        column,
        value,
        source.headers?.[column] || `第 ${column + 1} 列`,
      );
    }
  };
  const contentColumns = new Set(
    [
      "title",
      "item_highlights",
      "description",
      "bullet_points",
      ...Array.from({ length: 5 }, (_, index) => `bullet_point${index + 1}`),
    ]
      .map((key) => indexOf(mapping, key, width))
      .filter((column) => column >= 0),
  );
  for (const row of chosen) {
    const original = sourceByNumber.get(row.row);
    if (!original) {
      issue(
        "SOURCE_ROW_MISSING",
        `找不到原表第 ${row.row} 行，无法安全回填。`,
        row,
      );
      continue;
    }
    const importEdits = batch.import_edits?.[String(row.row)] || {};
    if (!applyContent) applyEdits(row, importEdits, "导入前");
    // Structural parents and explicitly skipped rows are retained without model changes.
    if (applyContent && !["preserved", "skipped"].includes(row.status)) {
      const originalSku = skuIndex >= 0 ? trim(original.cells?.[skuIndex]) : "";
      if (!originalSku || !trim(row.sku)) {
        issue(
          "SKU_REQUIRED",
          `原表第 ${row.row} 行没有真实 SKU，不能回填或推测货号。`,
          row,
          "sku",
        );
        continue;
      }
      if (originalSku !== trim(row.sku)) {
        issue(
          "SKU_MISMATCH",
          `原表第 ${row.row} 行 SKU 与批次记录不一致，不能回填。`,
          row,
          "sku",
        );
        continue;
      }
      if (skuCounts.get(originalSku) > 1) {
        issue(
          "DUPLICATE_SKU",
          `原表 SKU ${originalSku} 出现多次，请先确认重复行，避免写错商品。`,
          row,
          "sku",
        );
        continue;
      }
      if (row.status !== "completed") {
        issue(
          "ROW_NOT_COMPLETED",
          `原表第 ${row.row} 行尚未完成真实处理（${row.status || "未知状态"}），请先处理或仅选择已完成行。`,
          row,
        );
        continue;
      }
      const record = row.listing_id ? store.latest(row.listing_id) : null;
      if (
        !record ||
        record.is_demo ||
        !record.trace?.actual_model_call ||
        !record.review ||
        !record.content
      ) {
        issue(
          "REAL_REVIEW_REQUIRED",
          `原表第 ${row.row} 行没有已保存的真实模型审阅文案，不能回填。`,
          row,
        );
        continue;
      }
      if (
        row.product?.product_id &&
        record.product_snapshot?.product_id !== row.product.product_id
      ) {
        issue(
          "PRODUCT_MISMATCH",
          `原表第 ${row.row} 行的文案与商品记录不一致。`,
          row,
        );
        continue;
      }
      // These edits were present when the real model reviewed this row.
      applyEdits(row, importEdits, "导入前");
      const targets = new Set();
      const writeField = (key, value, optional = false) => {
        const column = indexOf(mapping, key, width);
        if (column < 0) {
          if (trim(value))
            issue(
              "UNMAPPED_CONTENT",
              `原表第 ${row.row} 行 ${key} 没有对应列，${optional ? "额外亮点未回填，请人工确认。" : "请补充列映射后导出。"}`,
              row,
              key,
              optional ? "warning" : "error",
            );
          return;
        }
        if (targets.has(column)) {
          issue(
            "DUPLICATE_CONTENT_COLUMN",
            `原表第 ${row.row} 行多个文案字段对应同一列，请调整映射。`,
            row,
            key,
          );
          return;
        }
        targets.add(column);
        put(row, column, value, key);
      };
      const content = record.content;
      writeField("title", content.title);
      writeField("item_highlights", content.item_highlights, true);
      writeField("description", content.description);
      const bullets = (content.bullet_points || []).map((item) =>
        String(item.text ?? ""),
      );
      const separate = Array.from({ length: 5 }, (_, index) =>
        indexOf(mapping, `bullet_point${index + 1}`, width),
      );
      const combined = indexOf(mapping, "bullet_points", width);
      if (separate.some((column) => column >= 0)) {
        if (combined >= 0)
          issue(
            "AMBIGUOUS_BULLET_MAPPING",
            `原表第 ${row.row} 行同时映射了合并卖点与分列卖点，请保留一种映射。`,
            row,
            "bullet_points",
          );
        if (
          bullets.length > 5 ||
          bullets.some(
            (text, index) => trim(text) && (index >= 5 || separate[index] < 0),
          )
        )
          issue(
            "BULLET_CAPACITY",
            `原表第 ${row.row} 行卖点数量超过原表已映射卖点列容量，不能遗漏内容。`,
            row,
            "bullet_points",
          );
        separate.forEach((column, index) => {
          if (column >= 0)
            writeField(`bullet_point${index + 1}`, bullets[index] || "");
        });
      } else if (combined >= 0) writeField("bullet_points", bullets.join("\n"));
      else if (bullets.some(trim))
        issue(
          "UNMAPPED_CONTENT",
          `原表第 ${row.row} 行卖点没有对应列，请补充列映射后导出。`,
          row,
          "bullet_points",
        );
      const unresolved =
        (record.review.issues?.length || 0) +
        (record.review.missing_data?.length || 0) +
        (record.review.checks || []).filter((check) =>
          ["not_checked", "error", "needs_evidence"].includes(check.state),
        ).length;
      if (unresolved)
        issue(
          "REVIEW_UNRESOLVED",
          `原表第 ${row.row} 行仍有 ${unresolved} 项审阅发现或资料待核对；导出不表示平台审核通过。`,
          row,
          "",
          "warning",
        );
    }
    const edits = batch.file_edits?.[String(row.row)] || {};
    for (const [key, value] of Object.entries(edits)) {
      const column = Number(key);
      if (
        !/^\d+$/.test(key) ||
        !Number.isInteger(column) ||
        column < 0 ||
        column >= width ||
        typeof value !== "string"
      ) {
        issue(
          "INVALID_FILE_EDIT",
          `原表第 ${row.row} 行的手动字段修正无效。`,
          row,
        );
        continue;
      }
      if (applyContent && !allowManualContent && contentColumns.has(column)) {
        issue(
          "MANUAL_CONTENT_UNREVIEWED",
          `原表第 ${row.row} 行含审核后手动修改的文案。请仅导出未复检修正行，或重新导入并完成真实复检后回填。`,
          row,
          source.headers?.[column] || key,
        );
        continue;
      }
      put(
        row,
        column,
        value,
        source.headers?.[column] || `第 ${column + 1} 列`,
      );
    }
    if (Object.keys(edits).length)
      issue(
        "MANUAL_EDIT_UNREVIEWED",
        `原表第 ${row.row} 行含商家手动修正，修正内容尚未复检。`,
        row,
        "",
        "warning",
      );
  }
  refuse();
  const originalBuffer = Buffer.from(source.original_base64, "base64");
  let workbook, sheet, grid;
  try {
    if (originalFormat === "xlsx") {
      workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(originalBuffer);
      sheet = workbook.getWorksheet(source.sheet);
      if (!sheet)
        throw new AppError(
          "FLAT_FILE_SOURCE_SHEET",
          "原库存工作表不存在，请重新导入。",
        );
    } else {
      const text = decodeTableText(originalBuffer).text;
      grid = parseDelimited(
        text,
        source.delimiter || (originalFormat === "csv" ? "," : "\t"),
      );
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "FLAT_FILE_SOURCE_INVALID",
      "原始库存文件无法读取，请重新导入原文件。",
    );
  }
  if (outputFormat === "xlsx") {
    if (!workbook) {
      workbook = new ExcelJS.Workbook();
      sheet = workbook.addWorksheet(
        (source.sheet || "库存模板")
          .replace(/[\\/*?:\[\]]/g, "")
          .slice(0, 31) || "库存模板",
      );
      for (const row of grid) sheet.addRow(row);
    }
    for (const [number, cells] of changes)
      for (const [column, value] of cells)
        sheet.getCell(number, column + 1).value = value;
    if (onlyRows) {
      const dataStart = source.data_start_row || (source.header_row || 1) + 1;
      for (let number = sheet.rowCount; number >= dataStart; number--)
        if (!chosenNumbers.has(number)) sheet.spliceRows(number, 1);
    }
  } else {
    if (!grid) {
      grid = Array.from({ length: sheet.rowCount }, (_, index) =>
        Array.from(
          { length: Math.max(width, sheet.columnCount) },
          (_, column) => sheet.getCell(index + 1, column + 1).text,
        ),
      );
      issue(
        "TEXT_CONVERSION",
        "Excel 转为文本时仅输出当前库存工作表的显示值，其他工作表、公式和格式不会写入文本；请核对平台要求。",
        null,
        "",
        "warning",
      );
    }
    for (const [number, cells] of changes) {
      if (!grid[number - 1]) grid[number - 1] = [];
      for (const [column, value] of cells) grid[number - 1][column] = value;
    }
    if (onlyRows) {
      const dataStart = source.data_start_row || (source.header_row || 1) + 1;
      grid = grid.filter(
        (_, index) => index + 1 < dataStart || chosenNumbers.has(index + 1),
      );
    }
  }
  if (onlyRows)
    issue(
      "SUBSET_EXPORT",
      "此文件仅保留所选商品数据行，其他工作表和表头保留；数据行号已变化，请按本次文件重新核对平台报告。",
      null,
      "",
      "warning",
    );
  if (outputFormat !== originalFormat)
    issue(
      "FORMAT_CONVERSION",
      `已从 ${originalFormat} 转为 ${outputFormat}，格式转换不证明符合 Amazon 上传要求。`,
      null,
      "",
      "warning",
    );
  validation.modified_rows = [...changes.keys()].sort((a, b) => a - b);
  validation.modified_cells = [...changes.values()].reduce(
    (total, cells) => total + cells.size,
    0,
  );
  /* -------- 公式注入（CWE-1236）：点出来，但不改字节 --------
   *
   * 回填进表格的文案有两个来源：商家原表（我们原样透传）和我们自己写进去的
   * （模型生成 / 人工修正）。只要某一格以 `=`、`@`、制表符或回车开头，Excel 与
   * WPS 打开 CSV/TSV 时就会把它当公式执行 —— `=HYPERLINK(...)` 能把数据带出机器。
   *
   * **为什么不自动加前缀单引号**：那会改掉要上传给平台的文案字节。
   * 让商家按警告自己决定，比我们悄悄改内容安全。
   */
  const formulaCells = [];
  const considerCell = (rowNumber, column, raw) => {
    const text = String(raw ?? "").trim();
    if (text.length < 2) return;
    const certain = /^[=@\t\r]/.test(text);
    const possible = !certain && /^[+-]\s*[\d(]/.test(text);
    if (!certain && !possible) return;
    formulaCells.push({
      row: rowNumber,
      column,
      certainty: certain ? "certain" : "possible",
      preview: text.slice(0, 60),
    });
  };
  if (outputFormat === "xlsx" && sheet) {
    sheet.eachRow({ includeEmpty: false }, (row, number) => {
      row.eachCell({ includeEmpty: false }, (cell, column) =>
        considerCell(number, column, cell.text),
      );
    });
  } else if (Array.isArray(grid)) {
    grid.forEach((row, index) =>
      (row || []).forEach((value, column) =>
        considerCell(index + 1, column, value),
      ),
    );
  }
  validation.formula_cells = formulaCells.length;
  if (formulaCells.length) {
    const certain = formulaCells.filter((cell) => cell.certainty === "certain");
    validation.formula_risk = {
      total: formulaCells.length,
      certain: certain.length,
      possible: formulaCells.length - certain.length,
      cells: formulaCells.slice(0, 20),
    };
    const spreadsheet = ["csv", "tsv", "txt"].includes(outputFormat);
    issue(
      "FORMULA_INJECTION",
      `导出文件里有 ${formulaCells.length} 个单元格以 =、@、+ 或 - 开头（其中 ${certain.length} 个是以 = 或 @ 开头）。` +
        (spreadsheet
          ? "用 Excel / WPS 打开这种 CSV/TSV 时，这类内容会被当成公式执行，例如 =HYPERLINK 会把数据发到外部地址。"
          : "xlsx 里这些格子按文本写入，不会变成公式；但原表自带的公式会被保留。") +
        "本次**没有改动这些字符**，因为它们也会原样上传给平台，改字比报警更危险。请人工确认这几格是不是商家真想写的字。",
      null,
      "",
      "warning",
    );
  }
  validation.safe_to_export = true;
  validation.warnings.push(
    "文案审阅和文件导出均不代表 Amazon 上传校验、平台审批或实际上架成功。",
  );
  if (allowManualContent)
    validation.warnings.push(
      "此文件为未复检修正稿：先保留真实审阅文案，再覆盖商家手动修正；手动修正尚未经过模型复检或平台验证。",
    );
  let buffer;
  const outputEncoding =
    outputFormat === "xlsx"
      ? null
      : format === "original" &&
          ["utf-16le", "utf-16be"].includes(source.encoding)
        ? source.encoding
        : "utf-8";
  validation.encoding = outputEncoding;
  if (outputFormat === "xlsx")
    buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  else {
    const delimiter = outputFormat === "csv" ? "," : "\t";
    const newline = source.newline === "\n" ? "\n" : "\r\n";
    const bom = source.has_bom || originalFormat === "xlsx" ? "\uFEFF" : "";
    buffer = Buffer.from(
      bom +
        grid
          .map((row) =>
            row.map((value) => delimitedCell(value, delimiter)).join(delimiter),
          )
          .join(newline),
      outputEncoding === "utf-8" ? "utf-8" : "utf16le",
    );
    if (outputEncoding === "utf-16be") buffer.swap16();
    if (source.encoding && source.encoding !== outputEncoding)
      validation.warnings.push(
        `文字编码已从 ${source.encoding} 转为 ${outputEncoding}，请按实际站点的库存文件要求核对。`,
      );
  }
  const stem = basename(
    source.filename || "inventory",
    extname(source.filename || ""),
  )
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .slice(0, 120);
  const dataStart = source.data_start_row || (source.header_row || 1) + 1;
  const exportedRows = sourceRows
    .filter(
      (row) =>
        row.number >= dataStart &&
        row.cells?.some((value) => trim(value)) &&
        (!onlyRows || chosenNumbers.has(row.number)),
    )
    .sort((left, right) => left.number - right.number);
  const exportManifest = exportedRows.map((row, index) => ({
    original_row: row.number,
    file_row: onlyRows ? dataStart + index : row.number,
    record_number: index + 1,
    sku: skuIndex >= 0 ? trim(row.cells?.[skuIndex]) : "",
  }));
  return {
    buffer,
    filename: `${stem}-${allowManualContent ? "correction-unreviewed-" : ""}${onlyRows ? "selected-rows" : "reviewed"}.${outputFormat}`,
    contentType: outputEncoding
      ? mime[outputFormat].replace("charset=utf-8", `charset=${outputEncoding}`)
      : mime[outputFormat],
    validation,
    export_manifest: exportManifest,
    source_sha256: createHash("sha256").update(originalBuffer).digest("hex"),
    artifact_sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}
