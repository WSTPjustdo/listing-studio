// Excel 导出读回来的守卫：不是"写的时候设了什么"，是"存进去以后是什么"。
// 商家会拿这份文件直接去 Amazon 后台改文案，丢了前导零、五点被压成一行，他当场就卡住。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
import { createStore, ROOT } from "../server/store.mjs";
import { exportBatch } from "../server/batch.mjs";

const v1 = JSON.parse(readFileSync(resolve(ROOT, "reports/merchant-experience-2026-10-23/listing-v1.json"), "utf8"));

function fixture() {
  const store = createStore(":memory:");
  store.saveVersion({ ...structuredClone(v1), listing_id: "LIST-X", version: 1 });
  const batch = {
    id: "BATCH-X",
    import_id: "IMPORT-X",
    rows: [
      { row: 2, sku: "00123", name: "前导零 SKU", status: "completed", listing_id: "LIST-X", version: 1 },
      { row: 3, sku: "TOTE-L", name: "失败行", status: "failed", error: "TIMEOUT", error_action: "重试" },
    ],
  };
  return { store, batch };
}

async function load(buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  return book;
}

test("导出的每个工作表都设了列宽与加粗首行（打开就是一张能读的表）", async () => {
  const { store, batch } = fixture();
  const book = await load(await exportBatch(store, batch, false));
  assert.ok(book.worksheets.length >= 3);
  for (const sheet of book.worksheets) {
    const widths = sheet.columns.filter((c) => typeof c.width === "number" && c.width > 0).length;
    assert.equal(widths, sheet.columns.length, `${sheet.name} 有列没设宽度`);
    assert.ok(sheet.getRow(1).font?.bold, `${sheet.name} 首行没加粗`);
  }
  store.close();
});

test("SKU 存成文本：前导零不许被 Excel 吃掉", async () => {
  const { store, batch } = fixture();
  const book = await load(await exportBatch(store, batch, false));
  const sheet = book.getWorksheet("商品文案");
  const sku = sheet.getRow(2).getCell(1).value;
  assert.equal(typeof sku, "string");
  assert.equal(sku, "00123");
  store.close();
});

test("五点用换行拼接，且那一列开着自动换行（否则在 Excel 里被压成一行）", async () => {
  const { store, batch } = fixture();
  const book = await load(await exportBatch(store, batch, false));
  const sheet = book.getWorksheet("商品文案");
  const bullets = sheet.getRow(2).getCell(6).value;
  assert.equal(typeof bullets, "string");
  assert.ok(bullets.includes("\n"), "五点没有用换行分隔");
  const cell = sheet.getRow(2).getCell(6);
  const wrap = cell.alignment?.wrapText || sheet.getColumn(6).alignment?.wrapText || sheet.getRow(2).alignment?.wrapText;
  assert.ok(wrap, "五点列没开自动换行");
  store.close();
});

test("文案表冻结首行（滚到第 20 行还看得见列名）", async () => {
  const { store, batch } = fixture();
  const book = await load(await exportBatch(store, batch, false));
  const sheet = book.getWorksheet("商品文案");
  const view = (sheet.views || [])[0] || {};
  assert.equal(view.state, "frozen");
  assert.equal(view.ySplit, 1);
  store.close();
});
