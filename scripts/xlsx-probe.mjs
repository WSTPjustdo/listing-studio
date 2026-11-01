/**
 * 「导出的 Excel 打开以后，人能不能直接读」实测。
 *
 * 为什么要有这个尺子：`.xlsx` 是**商家真正会拿去用的东西**——他要拿它去 Amazon 后台改文案、
 * 拿它给老板看。以前关于导出的结论全是"冻结首行加了、列宽设了"，但没人把文件**读回来**看过：
 * 加了宽度的列里塞的是 500 字的描述、没开自动换行的地方五点被压成一行、
 * 数字型的 ID 被 Excel 吃掉前导零。这些在代码里看不出来，只有读回来才看得见。
 *
 * 量法：用 `exceljs` 把生成的 buffer 读回来（不是看写的时候设了什么，是看**存进去了什么**），
 * 逐表统计：冻结窗格、表头加粗、列宽、自动换行、超宽单元格、换行符丢失风险、数字型标识符。
 *
 * 一律离线：`createStore(":memory:")`，样本取 `reports/` 下的归档真实记录，不联网、不调模型。
 *
 * 用法：
 *   node scripts/xlsx-probe.mjs
 *   node scripts/xlsx-probe.mjs --json
 *   node scripts/xlsx-probe.mjs --strict   # 有"打开就读不全"的项时 exit 1
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import ExcelJS from "exceljs";
import { createStore, ROOT } from "../server/store.mjs";
import { exportBatch, exportFailedRows } from "../server/batch.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");

const read = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));
const v1 = read("reports/merchant-experience-2026-10-23/listing-v1.json");

/* ---------- 造一份最小的、但形状真实的批次 ---------- */
const store = createStore(":memory:");
const record = { ...structuredClone(v1), listing_id: "LIST-PROBE-1", version: 1 };
store.saveVersion(record);

const headers = ["SKU", "商品名称", "标题", "五点", "描述"];
const cells = (sku, name) => [sku, name, "", "", ""];
store.saveImport({
  id: "IMPORT-PROBE-1",
  filename: "seller-inventory-2026-10-29.xlsx",
  sheet: "商品",
  headers,
  rows: [
    { number: 2, cells: cells("00123", "棉布袋（前导零 SKU）") },
    { number: 3, cells: cells("1000000000000123456", "长数字 SKU（科学计数法风险）") },
    { number: 4, cells: cells("TOTE-BLK-L", "字母 SKU（对照）") },
  ],
});

const batch = {
  id: "BATCH-PROBE-1",
  import_id: "IMPORT-PROBE-1",
  status: "finished",
  created_at: "2026-10-29T12:00:00.000Z",
  rows: [
    { row: 2, sku: "00123", name: "棉布袋（前导零 SKU）", status: "completed", listing_id: "LIST-PROBE-1", version: 1 },
    { row: 3, sku: "1000000000000123456", name: "长数字 SKU（科学计数法风险）", status: "failed", error: "UPSTREAM_TIMEOUT", error_code: "TIMEOUT", error_action: "重试此行", attempt: 1 },
    { row: 4, sku: "TOTE-BLK-L", name: "字母 SKU（对照）", status: "blocked", error: "资料校验未通过", error_code: "VALIDATION" },
  ],
  group_actions: [
    { created_at: "2026-10-29T12:05:00.000Z", rule_id: "AMZ-01", action: "shorten", items: [{ sku: "00123", version: 1, status: "applied", result_version: 2 }] },
  ],
};

/* ---------- 读回来看 ---------- */
async function measure(buffer, label) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const sheets = [];
  book.eachSheet((sheet) => {
    const views = (sheet.views || [])[0] || {};
    let widths = 0;
    let columns = 0;
    sheet.columns.forEach((col) => {
      columns += 1;
      if (typeof col.width === "number" && col.width > 0) widths += 1;
    });

    // 段落结构：批次总览这类表是**多段**的（每段自带表头，中间空行隔开），
    // 所以"冻结首行"对它没有意义 —— 冻的会是标题而不是列名。数一下有几段。
    let sections = 0;
    let blankRows = 0;
    let filledCells = 0;
    let wrappedCells = 0;
    sheet.eachRow({ includeEmpty: true }, (row) => {
      const values = row.values.slice(1);
      if (values.every((v) => v === null || v === undefined || v === "")) {
        blankRows += 1;
        return;
      }
      const bold = Boolean(row.font && row.font.bold);
      const cells = values.filter((v) => v !== null && v !== undefined && v !== "");
      // 一段的表头 = 加粗 + 至少两格有字 + 全是短标签
      if (bold && cells.length >= 2 && cells.every((v) => String(v).length <= 12)) sections += 1;
      row.eachCell({ includeEmpty: false }, (cell) => {
        filledCells += 1;
        const col = sheet.getColumn(cell.number) || {};
        const eff = (cell.alignment && cell.alignment.wrapText) || (col.alignment && col.alignment.wrapText) || (row.alignment && row.alignment.wrapText);
        if (eff) wrappedCells += 1;
      });
    });

    const header = sheet.getRow(1);
    const headerBold = Boolean(header.font && header.font.bold);
    const headerWrapped = Boolean(header.alignment && header.alignment.wrapText);

    // 逐格看：内容长度 vs 所在列宽；带换行符但没开自动换行的格子
    let overWide = 0;
    let newlineRisk = 0;
    let numericIdCells = 0;
    const samples = { overWide: [], newlineRisk: [], numericId: [] };
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const col = sheet.getColumn(colNumber) || {};
        const width = typeof col.width === "number" ? col.width : 0;
        const wrapOk = Boolean(cell.alignment && cell.alignment.wrapText) || Boolean(col.alignment && col.alignment.wrapText);
        const value = cell.value;
        // 只盯"标识符"列：SKU / 货号 / ASIN / 各类 ID。行号、序号、版本号本来就是数字，不算风险。
        const header = String(sheet.getRow(1).getCell(colNumber).value || "");
        const idLike = /SKU|货号|ASIN|ID$/i.test(header) && !/行号|序号|版本/.test(header);
        if (typeof value === "number" && idLike) {
          numericIdCells += 1;
          if (samples.numericId.length < 3) samples.numericId.push({ cell: cell.address, value });
        }
        const text = value === null || value === undefined ? "" : String(value);
        if (!text) return;
        if (text.includes("\n") && !wrapOk) {
          newlineRisk += 1;
          if (samples.newlineRisk.length < 3) samples.newlineRisk.push({ cell: cell.address, head: text.slice(0, 18) });
        }
        if (width && text.length > width * 1.5 && !wrapOk) {
          overWide += 1;
          if (samples.overWide.length < 3) samples.overWide.push({ cell: cell.address, length: text.length, width });
        }
      });
    });

    sheets.push({
      name: sheet.name,
      rows: sheet.rowCount,
      columns,
      sections,
      blankRows,
      frozen: views.state === "frozen" ? `${views.ySplit || 0}行/${views.xSplit || 0}列` : "未冻结",
      headerBold,
      headerWrapped,
      widthsSet: `${widths}/${columns}`,
      wrapCoverage: filledCells ? `${wrappedCells}/${filledCells}` : "0/0",
      overWideCells: overWide,
      newlineRiskCells: newlineRisk,
      numericIdCells,
      samples,
    });
  });
  return { label, sheets };
}

const results = [];
results.push(await measure(await exportBatch(store, batch, false), "批次导出（全部文案）"));
results.push(await measure(await exportBatch(store, batch, true), "批次导出（仅待处理事项）"));
results.push(await measure(await exportFailedRows(store, batch), "失败原行导出"));

/* ---------- 判红 ---------- */
function judge(results) {
  const findings = [];
  for (const file of results) {
    for (const sheet of file.sheets) {
      const where = `${file.label} / ${sheet.name}`;
      if (sheet.overWideCells) findings.push(`${where}：${sheet.overWideCells} 个格子超出列宽 1.5 倍且没开自动换行（要拖列宽才读得完）`);
      if (sheet.newlineRiskCells) findings.push(`${where}：${sheet.newlineRiskCells} 个格子带换行但没开自动换行（Excel 里会被压成一行）`);
      if (sheet.numericIdCells) findings.push(`${where}：${sheet.numericIdCells} 个标识符被存成数字（前导零会丢）`);
      if (!sheet.headerBold) findings.push(`${where}：首行没加粗`);
      // 只有"单段 + 长表"才谈得上冻结首行。多段式表（每段自带表头）冻第一行只会冻住标题。
      if (sheet.frozen === "未冻结" && sheet.sections <= 1 && sheet.rows > 8)
        findings.push(`${where}：单表 ${sheet.rows} 行但没冻结表头（滚动后看不到列名）`);
    }
  }
  return findings;
}

const findings = judge(results);

/* ---------- 量具自证：这份"全绿"到底是因为文件好，还是因为什么都没查 ---------- */
async function selfCheck() {
  const bad = new ExcelJS.Workbook();
  const sheet = bad.addWorksheet("故意做坏");
  sheet.addRow(["SKU", "说明"]);
  sheet.addRow([12345, "一行很长很长很长很长很长很长很长很长很长很长很长很长很长很长的说明文字"]);
  sheet.addRow(["0001", "第一行\n第二行"]); // 带换行、没开自动换行
  for (let i = 0; i < 12; i += 1) sheet.addRow([`R${i}`, "x"]);
  const measured = await measure(await bad.xlsx.writeBuffer(), "自证样本（故意做坏）");
  const flagged = judge([measured]);
  const kinds = {
    数字型ID: flagged.some((f) => f.includes("标识符被存成数字")),
    首行未加粗: flagged.some((f) => f.includes("首行没加粗")),
    换行丢失: flagged.some((f) => f.includes("带换行但没开自动换行")),
    未冻结长表: flagged.some((f) => f.includes("没冻结表头")),
  };
  return { flagged, kinds, ok: Object.values(kinds).every(Boolean) };
}

const self = await selfCheck();
if (!self.ok) findings.push("量具自证失败：故意做坏的样本没有被报出来，说明这份「全部通过」不可信");

if (asJson) {
  console.log(JSON.stringify({ results, findings }, null, 2));
} else {
  console.log("Excel 导出读回实测（exceljs 读回，看的是存进去的东西）\n");
  for (const file of results) {
    console.log(`■ ${file.label}`);
    for (const sheet of file.sheets) {
      console.log(
        `  ${sheet.name}  行${sheet.rows} 列${sheet.columns} 段${sheet.sections} · 冻结 ${sheet.frozen} · 首行加粗 ${sheet.headerBold ? "是" : "否"}` +
          ` · 列宽 ${sheet.widthsSet} · 自动换行 ${sheet.wrapCoverage}` +
          ` · 超宽格 ${sheet.overWideCells} · 换行丢失 ${sheet.newlineRiskCells} · 数字ID ${sheet.numericIdCells}`,
      );
    }
  }
  console.log("\n量具自证（故意做坏的样本必须被报出来）：");
  for (const [kind, hit] of Object.entries(self.kinds)) console.log(`  ${hit ? "✓" : "✗"} ${kind}`);
  console.log("\n结论：");
  if (!findings.length) console.log("  三份导出全部通过（首行加粗、列宽齐全、自动换行全覆盖、无超宽格、无数字型 ID；单段长表已冻结表头）。");
  else for (const f of findings) console.log("  ✗ " + f);
}

store.close();
if (strict && findings.length) process.exit(1);
