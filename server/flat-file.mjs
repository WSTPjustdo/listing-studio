import ExcelJS from "exceljs";
import { AppError } from "./domain.mjs";

export const TABLE_LIMITS = Object.freeze({
  bytes: 5 * 1024 * 1024,
  rows: 2000,
  columns: 1000,
  cell: 10000,
});

// 唯一来源：接受的上传扩展名。platform-export/platform.json 由这个数组生成。
export const TABLE_FORMATS = Object.freeze(["xlsx", "csv", "tsv", "txt"]);

export const columns = [
  [
    "sku",
    "SKU / 货号",
    [
      "sku",
      "seller_sku",
      "item_sku",
      "merchant_sku",
      "卖家SKU",
      "商品SKU",
      "货号",
      "商品编码",
      "产品编码",
    ],
  ],
  [
    "name",
    "商品名称",
    [
      "商品名称",
      "产品名称",
      "品名",
      "名称",
      "name",
      "product_name",
      "item_name",
    ],
  ],
  [
    "category",
    "品类",
    ["品类", "类别", "category", "product_type", "feed_product_type"],
  ],
  ["material", "材质", ["材质", "面料", "material", "material_type"]],
  ["width", "宽度", ["宽度", "宽度cm", "width", "item_width"]],
  [
    "width_unit",
    "宽度单位",
    ["宽度单位", "width_unit", "item_width_unit_of_measure", "item_width_unit"],
  ],
  ["height", "高度", ["高度", "高度cm", "height", "item_height"]],
  ["depth", "深度", ["深度", "厚度", "depth", "item_depth"]],
  [
    "depth_unit",
    "深度单位",
    ["深度单位", "depth_unit", "item_depth_unit_of_measure", "item_depth_unit"],
  ],
  [
    "height_unit",
    "高度单位",
    [
      "高度单位",
      "height_unit",
      "item_height_unit_of_measure",
      "item_height_unit",
    ],
  ],
  [
    "fabric_weight_gsm",
    "克重 g/m²",
    ["克重", "面料克重", "gsm", "fabric_weight_gsm"],
  ],
  ["capacity_l", "容量 L", ["容量", "容量l", "capacity", "capacity_l"]],
  ["rated_load_kg", "额定承重 kg", ["额定承重", "承重kg", "rated_load_kg"]],
  [
    "handle_length_cm",
    "提手长度 cm",
    ["提手长度", "handlelength", "handle_length_cm"],
  ],
  [
    "retail_pack_count",
    "每包件数",
    [
      "每包件数",
      "包装数量",
      "零售件数",
      "packcount",
      "retail_pack_count",
      "item_package_quantity",
    ],
  ],
  ["brand", "品牌", ["品牌", "brand", "brand_name"]],
  ["color", "颜色", ["颜色", "color", "color_name"]],
  ["size", "尺码", ["尺码", "尺寸名称", "size", "size_name"]],
  ["parent_sku", "父 SKU", ["父sku", "父级sku", "parent_sku", "parent-sku"]],
  [
    "parentage",
    "父子关系",
    ["父子关系", "父子级别", "parentage", "parent_child", "parentage_level"],
  ],
  [
    "relationship_type",
    "关系类型",
    ["关系类型", "relationship_type", "relationship-type"],
  ],
  [
    "variation_theme",
    "变体主题",
    ["变体主题", "variation_theme", "variation-theme"],
  ],
  ["title", "现有英文标题", ["英文标题", "标题", "title", "item_name"]],
  [
    "item_highlights",
    "现有英文亮点",
    ["英文亮点", "亮点", "highlights", "item_highlights"],
  ],
  [
    "bullet_points",
    "现有英文卖点（单列换行）",
    ["卖点", "五点描述", "bulletpoints", "bullet_points"],
  ],
  ...Array.from({ length: 5 }, (_, index) => {
    const number = index + 1;
    return [
      `bullet_point${number}`,
      `英文卖点 ${number}`,
      [
        `bullet_point${number}`,
        `bullet_point_${number}`,
        `bullet${number}`,
        `bullet ${number}`,
        `卖点${number}`,
        `五点描述${number}`,
      ],
    ];
  }),
  [
    "description",
    "现有英文描述",
    ["英文描述", "描述", "description", "product_description"],
  ],
].map(([key, label, aliases]) => ({ key, label, aliases }));

const clean = (value) => String(value ?? "").trim();

// Keep repeated bullet indexes, but remove marketplace/language qualifiers and
// the singleton indexes used by Amazon's attribute-path column names.
const normalize = (value) => {
  let field = clean(value)
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\.value$/i, "");
  // Newer inventory templates put related values inside attribute objects.
  // Only named product dimensions are mapped; package dimensions stay separate.
  field = field
    .replace(
      /^item_dimensions#1\.(width|height|depth)(?:\.unit)?$/,
      (path, axis) => `item_${axis}${path.endsWith(".unit") ? "_unit" : ""}`,
    )
    .replace(/^child_parent_sku_relationship#1\.parent_sku$/, "parent_sku")
    .replace(
      /^child_parent_sku_relationship#1\.child_relationship_type$/,
      "relationship_type",
    )
    .replace(/^variation_theme#1\.name$/, "variation_theme");
  field = field.replace(/bullet[_\s-]*point(?:#|\.)?(\d+)/g, "bullet_point$1");
  if (!/^bullet[_\s-]*point#?\d+$/i.test(field))
    field = field.replace(/#1$/, "");
  return field.replace(/[\s_()（）/²-]/g, "");
};

function mappingAnalysis(headers) {
  const ambiguities = [];
  const mapping = Object.fromEntries(
    columns.map((column) => [
      column.key,
      headers.findIndex((header) =>
        column.aliases.some((alias) => normalize(alias) === normalize(header)),
      ),
    ]),
  );
  // A literal repeated bullet_point column is ordered by its position in the
  // original file. Locale-qualified repetitions must still have one locale.
  const unnumberedBullets = headers.flatMap((header, index) =>
    normalize(header) === "bulletpoint" ? [index] : [],
  );
  const qualifiers = (header) =>
    [
      ...clean(header)
        .toLowerCase()
        .matchAll(/\[(?:language_tag|marketplace_id)=([^\]]+)\]/g),
    ]
      .map((match) => match[0])
      .sort()
      .join("");
  const bulletLocales = new Set(
    unnumberedBullets.map((index) => qualifiers(headers[index])),
  );
  const hasNumberedBullets = Array.from(
    { length: 5 },
    (_, index) => mapping[`bullet_point${index + 1}`],
  ).some((index) => index >= 0);
  if (
    unnumberedBullets.length &&
    bulletLocales.size === 1 &&
    !hasNumberedBullets
  ) {
    for (
      let index = 0;
      index < Math.min(5, unnumberedBullets.length);
      index++
    ) {
      const key = `bullet_point${index + 1}`;
      if (mapping[key] < 0) mapping[key] = unnumberedBullets[index];
    }
  }
  for (const column of columns) {
    const index = mapping[column.key];
    const matches =
      index < 0
        ? []
        : headers.flatMap((header, candidate) =>
            normalize(header) === normalize(headers[index]) ? [candidate] : [],
          );
    if (
      matches.length > 1 &&
      new Set(matches.map((candidate) => qualifiers(headers[candidate]))).size >
        1
    ) {
      mapping[column.key] = -1;
      ambiguities.push({
        key: column.key,
        label: column.label,
        indexes: matches,
        reason: "multiple_locales",
      });
    }
  }
  if (unnumberedBullets.length && bulletLocales.size > 1)
    ambiguities.push({
      key: "bullet_point",
      label: "分列卖点",
      indexes: unnumberedBullets,
      reason: "multiple_locales",
    });
  if (unnumberedBullets.length && hasNumberedBullets)
    ambiguities.push({
      key: "bullet_point",
      label: "分列卖点",
      indexes: unnumberedBullets,
      reason: "mixed_bullet_numbering",
    });
  return { mapping, ambiguities };
}

export function suggestMapping(headers) {
  return mappingAnalysis(headers).mapping;
}

/** Decode text exports from Excel without guessing a legacy code page. */
export function decodeTableText(inputBuffer) {
  const bytes = Buffer.from(inputBuffer);
  let encoding = "utf-8",
    has_bom = false;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    has_bom = true;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    has_bom = true;
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    has_bom = true;
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    // UTF-16 without a BOM and binary/UTF-32 input must not silently become
    // apparently valid ASCII headers with embedded NUL characters.
    if (text.includes("\u0000")) throw new Error("NUL in table text");
    return { text, encoding, has_bom };
  } catch {
    throw new AppError(
      "TEXT_ENCODING",
      "请将 CSV / TSV / TXT 另存为 UTF-8 或带 BOM 的 UTF-16 编码后导入。",
    );
  }
}

/** Parse UTF-8-decoded CSV or tab-separated text without changing identifiers. */
export function parseDelimited(text, delimiter = ",") {
  if (![",", "\t"].includes(delimiter))
    throw new AppError("FILE_PARSE", "不支持的分隔符。");
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    closed = false,
    started = false;
  const finishField = () => {
    row.push(field);
    field = "";
    closed = false;
    started = false;
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
  };
  const source = String(text).replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += character;
      continue;
    }
    if (character === delimiter) {
      finishField();
      continue;
    }
    if (character === "\r" || character === "\n") {
      if (character === "\r" && source[index + 1] === "\n") index++;
      finishRow();
      continue;
    }
    if (closed)
      throw new AppError(
        "FILE_PARSE",
        `第 ${rows.length + 1} 条记录的引号后有非分隔字符，请检查文本转义。`,
      );
    if (character === '"') {
      if (started || field)
        throw new AppError(
          "FILE_PARSE",
          `第 ${rows.length + 1} 条记录包含未转义引号。`,
        );
      quoted = true;
      started = true;
    } else {
      field += character;
      started = true;
    }
  }
  if (quoted)
    throw new AppError(
      "FILE_PARSE",
      "文本包含未闭合的引号，请检查 CSV / TSV 的转义。",
    );
  if (started || closed || field || row.length) finishRow();
  return rows;
}

const isAuxiliary = (name) =>
  /instructions?|definitions?|valid[ _-]*values?|data[ _-]*definitions?|examples?|samples?|read[ _-]*me|说明|定义|有效值|示例|帮助|使用指南/i.test(
    name,
  );
const preferredSheet = (name) =>
  /^(?:template|模板|商品模板|商品表|inventory|inventory[ _-]*template)$/i.test(
    name.trim(),
  )
    ? 100
    : /template|模板|商品|inventory/i.test(name)
      ? 35
      : 0;
const isMachineHeader = (header) =>
  /^[a-z][a-z0-9_.#\[\]=:-]*$/i.test(clean(header));
const amazonHeader = (header) =>
  /^(?:item_name|seller_sku|item_sku|feed_product_type|product_description|bullet_point[\d_#\[]|parent_sku|parentage|relationship_type|variation_theme)/i.test(
    clean(header),
  );

function inspectHeader(headers, number) {
  const { mapping, ambiguities } = mappingAnalysis(headers);
  const recognizedIndexes = new Set([
    ...Object.values(mapping).filter((index) => index >= 0),
    ...ambiguities.flatMap((item) => item.indexes),
  ]);
  const contentKeys = [
    "name",
    "title",
    "description",
    "bullet_points",
    ...Array.from({ length: 5 }, (_, index) => `bullet_point${index + 1}`),
  ];
  const hasContent = contentKeys.some(
    (key) => mapping[key] >= 0 || ambiguities.some((item) => item.key === key),
  );
  const recognized =
    hasContent &&
    ((mapping.sku >= 0 && recognizedIndexes.size >= 2) ||
      (mapping.name >= 0 && recognizedIndexes.size >= 2));
  const machineCount = [...recognizedIndexes].filter((index) =>
    isMachineHeader(headers[index]),
  ).length;
  const amazonCount = headers.filter(amazonHeader).length;
  return {
    number,
    headers,
    mapping,
    recognized,
    machine: amazonCount > 0,
    amazonCount,
    score:
      (mapping.sku >= 0 ? 100 : 0) +
      (hasContent ? 40 : 0) +
      recognizedIndexes.size * 5 +
      machineCount * 3 +
      amazonCount * 15 -
      number / 100,
  };
}

function candidatesFor(sheet, explicitHeader) {
  const headerCandidates = [];
  if (explicitHeader !== undefined) {
    const headers = sheet.readRow(explicitHeader, true);
    if (headers.some((value) => clean(value)))
      headerCandidates.push({
        ...inspectHeader(headers, explicitHeader),
        recognized: true,
      });
  } else {
    for (let number = 1; number <= Math.min(50, sheet.rowCount); number++) {
      const candidate = inspectHeader(sheet.readRow(number, true), number);
      if (candidate.recognized) headerCandidates.push(candidate);
    }
  }
  return (
    headerCandidates.sort((left, right) => right.score - left.score)[0] || null
  );
}

export async function readTable(filename, inputBuffer, sheetName, headerRow) {
  const buffer = Buffer.from(inputBuffer);
  if (buffer.length > TABLE_LIMITS.bytes)
    throw new AppError("FILE_TOO_LARGE", "文件最多 5 MB。");
  if (
    headerRow !== undefined &&
    (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 10000)
  )
    throw new AppError("HEADER_ROW", "表头行应为 1 至 10000 的整数。");
  const extension = String(filename)
    .match(/\.([^.]+)$/)?.[1]
    ?.toLowerCase();
  if (!TABLE_FORMATS.includes(extension))
    throw new AppError(
      "FILE_TYPE",
      "支持 .xlsx、.csv、制表符分隔 .tsv / .txt；文字文件支持 UTF-8 或带 BOM 的 UTF-16，.xls / .xlsm 请另存为 .xlsx。",
    );

  let book,
    sheets,
    text = "",
    textEncoding = null,
    textHasBom = false;
  const delimiter =
    extension === "csv" ? "," : extension === "xlsx" ? null : "\t";
  try {
    if (extension === "xlsx") {
      book = new ExcelJS.Workbook();
      await book.xlsx.load(buffer);
      sheets = book.worksheets.map((worksheet) => ({
        name: worksheet.name,
        state: worksheet.state,
        rowCount: worksheet.rowCount,
        columnCount: worksheet.columnCount,
        readRow(number, preview = false) {
          const row = worksheet.getRow(number);
          const count = preview
            ? Math.min(worksheet.columnCount, TABLE_LIMITS.columns)
            : worksheet.columnCount;
          return Array.from(
            { length: count },
            (_, index) => row.getCell(index + 1).text,
          );
        },
        eachRow(callback) {
          worksheet.eachRow((row, number) =>
            callback(this.readRow(number), number, row),
          );
        },
      }));
    } else {
      const decoded = decodeTableText(buffer);
      text = decoded.text;
      textEncoding = decoded.encoding;
      textHasBom = decoded.has_bom;
      const records = parseDelimited(text, delimiter);
      const columnCount = records.reduce(
        (maximum, row) => Math.max(maximum, row.length),
        0,
      );
      sheets = [
        {
          name: "商品数据",
          state: "visible",
          rowCount: records.length,
          columnCount,
          readRow(number, preview = false) {
            const row = records[number - 1] || [];
            const count = preview
              ? Math.min(columnCount, TABLE_LIMITS.columns)
              : columnCount;
            return Array.from(
              { length: count },
              (_, index) => row[index] ?? "",
            );
          },
          eachRow(callback) {
            records.forEach((row, index) => {
              if (row.some((value) => clean(value)))
                callback(this.readRow(index + 1), index + 1);
            });
          },
        },
      ];
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "FILE_PARSE",
      "文件无法读取，请确认未加密，且为有效的 Excel / CSV / TSV 文件。",
    );
  }

  const warnings = [];
  const analyzed = sheets.map((sheet) => {
    const auxiliary =
      isAuxiliary(sheet.name) ||
      sheet.state === "veryHidden" ||
      sheet.state === "hidden";
    const candidate = auxiliary
      ? null
      : candidatesFor(
          sheet,
          sheetName === sheet.name || !sheetName ? headerRow : undefined,
        );
    return { sheet, candidate, auxiliary };
  });
  let selected;
  if (sheetName)
    selected = analyzed.find((item) => item.sheet.name === sheetName);
  else
    selected = analyzed
      .filter((item) => item.candidate?.recognized)
      .sort(
        (left, right) =>
          preferredSheet(right.sheet.name) * 1000 +
          right.candidate.score -
          (preferredSheet(left.sheet.name) * 1000 + left.candidate.score),
      )[0];
  if (!selected)
    selected = analyzed.find((item) => !item.auxiliary) || analyzed[0];
  const sheet = selected?.sheet;
  const candidate =
    sheetName && sheetName !== sheet?.name ? null : selected?.candidate;
  const metadata = {
    filename,
    sheets: sheets.map((item) => item.name),
    sheet: sheet?.name || "",
    columns,
    original_base64: buffer.toString("base64"),
    format: extension,
    delimiter,
    encoding: textEncoding,
    newline: /\r\n/.test(text) ? "\r\n" : "\n",
    has_bom: textHasBom,
    header_row: candidate?.number || headerRow || null,
    data_start_row: candidate ? candidate.number + 1 : null,
    column_count: sheet?.columnCount || 0,
    profile: candidate?.amazonCount
      ? "amazon_flat_file_candidate"
      : candidate
        ? "generic_table"
        : "unrecognized",
    schema: {
      header_style: candidate
        ? candidate.machine
          ? "machine"
          : "human"
        : "unknown",
      official_compatibility: "not_verified",
      template_version: null,
      marketplace: null,
      category: null,
    },
    sheet_candidates: analyzed.map((item) => ({
      name: item.sheet.name,
      header_row: item.candidate?.number || null,
      recognized: !!item.candidate?.recognized,
      auxiliary: item.auxiliary,
    })),
    warnings,
  };
  if (sheetName && sheetName !== sheet?.name)
    warnings.push(`未找到工作表“${sheetName}”，请重新选择。`);
  if (!candidate || selected?.auxiliary) {
    warnings.push(
      selected?.auxiliary
        ? "当前为说明、定义或隐藏的辅助工作表，请选择商品数据工作表。"
        : "未能确定商品表头，请选择数据工作表，或手动指定表头行。自动识别会检查前 50 行中的 SKU 和商品内容字段。",
    );
    return {
      ...metadata,
      selection_required: true,
      headers: [],
      rows: [],
      mapping: suggestMapping([]),
    };
  }
  if (sheet.columnCount > TABLE_LIMITS.columns)
    throw new AppError(
      "TABLE_LIMIT",
      `商品数据工作表最多 ${TABLE_LIMITS.columns} 列，请减少不需要的列后重试。`,
    );
  const headers = sheet.readRow(candidate.number);
  const analysis = mappingAnalysis(headers);
  if (analysis.ambiguities.some((item) => item.reason === "multiple_locales"))
    warnings.push(
      `检测到多个语言或站点的同名字段，已取消自动映射：${[...new Set(analysis.ambiguities.map((item) => item.label))].join("、")}。请按本批次站点和语言手动选择原表列，其他列会保留。`,
    );
  if (
    analysis.ambiguities.some(
      (item) => item.reason === "mixed_bullet_numbering",
    )
  )
    warnings.push(
      "卖点同时含编号和无编号列，仅自动映射编号列；请核对五点顺序，手动选择需要使用的无编号列。",
    );
  if (headers.some((value) => value.length > TABLE_LIMITS.cell))
    throw new AppError("CELL_LIMIT", "表头单元格最多 10000 个字符。");
  const rows = [];
  sheet.eachRow((cells, number, row) => {
    if (number <= candidate.number) return;
    if (row)
      row.eachCell((cell) => {
        if (
          cell.value &&
          typeof cell.value === "object" &&
          ("formula" in cell.value || "sharedFormula" in cell.value)
        )
          throw new AppError(
            "FORMULA_INPUT",
            `第 ${number} 行商品数据包含公式，请仅将商品数据区域粘贴为值后导入。`,
          );
      });
    if (!cells.some((value) => clean(value))) return;
    if (cells.some((value) => value.length > TABLE_LIMITS.cell))
      throw new AppError(
        "CELL_LIMIT",
        `第 ${number} 行单元格最多 10000 个字符。`,
      );
    rows.push({ number, cells });
    if (rows.length > TABLE_LIMITS.rows)
      throw new AppError(
        "TABLE_LIMIT",
        `每次最多 ${TABLE_LIMITS.rows} 行商品数据，请拆分文件。`,
      );
  });
  if (candidate.number !== 1)
    warnings.push(
      `已识别第 ${candidate.number} 行表头；之前的说明和标签行保留在原文件中。请核对预览。`,
    );
  if (metadata.profile === "amazon_flat_file_candidate")
    warnings.push(
      "检测到库存模板式字段；尚未核验站点、类目和模板版本，不能据此认定符合 Amazon 上传要求。",
    );
  if (!rows.length)
    warnings.push(
      "当前工作表已识别表头，但没有商品数据行。请切换工作表或补入商家真实商品资料。",
    );
  return {
    ...metadata,
    headers,
    rows,
    mapping: analysis.mapping,
    mapping_ambiguities: analysis.ambiguities,
    selection_required: !rows.length,
  };
}
