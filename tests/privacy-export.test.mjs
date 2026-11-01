// 隐私与安全边界的工程守卫（离线，不碰真模型、不写真实库）。
// 这些用例守的是「第 7 轮量到的东西别悄悄退回去」，不是商家验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { readTable } from '../server/flat-file.mjs';
import { exportFlatFile } from '../server/flat-file-export.mjs';
import { exportListingReport, exportListingWorklist } from '../server/listing-report.mjs';
import { ROOT } from '../server/store.mjs';

const archived = JSON.parse(
  readFileSync(resolve(ROOT, 'reports/merchant-improvements-2026-10-24/final-record.json'), 'utf8'),
);

const FORMULA_TITLE = '=HYPERLINK("https://example.com/leak","Click me")';

async function exportWith(title) {
  const csv = [
    'sku,item_name,product_description,bullet_point1,bullet_point2,bullet_point3,bullet_point4,bullet_point5,generic_keywords',
    'SKU-1,plain,plain,plain,plain,plain,plain,plain,@SUM(A1:A2)',
  ].join('\r\n');
  const source = await readTable('guard.csv', Buffer.from(csv, 'utf8'));
  const record = structuredClone(archived);
  record.content.title = title;
  const store = { latest: () => record };
  const batch = { rows: [{ row: source.data_start_row, sku: 'SKU-1', status: 'completed', listing_id: 'guard-listing' }], mapping: source.mapping };
  return { source, store, batch };
}

test('CSV 回填把公式前缀的格子报出来，但不改它的字节', async () => {
  const { source, store, batch } = await exportWith(FORMULA_TITLE);
  const result = await exportFlatFile(store, batch, source, { format: 'csv' });
  // 商家原表的 @SUM 一格 + 我们写进去的标题一格 = 2
  assert.equal(result.validation.formula_cells, 2);
  assert.equal(result.validation.formula_risk.certain, 2);
  assert.ok(result.validation.warnings.some((line) => /公式/.test(line)), '警告里必须有一句人话');
  assert.equal(result.validation.safe_to_export, true, '只报警不改字节：不许因此拒绝导出');
  const text = result.buffer.toString('utf8').replace(/^\uFEFF/, '');
  // 核心：文案原样，前面没有偷偷加单引号或空格。
  assert.ok(text.includes('"=HYPERLINK(""https://example.com/leak"",""Click me"")"'), '写进去的标题被改过字节');
  assert.ok(text.includes('@SUM(A1:A2)'), '商家原表的格子被改过字节');
});

test('干净数据不会因为公式检查而多出警告', async () => {
  const { source, store, batch } = await exportWith('DALIX Cotton Canvas Tote Bag');
  const result = await exportFlatFile(store, batch, source, { format: 'csv' });
  // 原表里那格 @SUM 还在，所以只有它一个。
  assert.equal(result.validation.formula_cells, 1);
  assert.ok(result.validation.warnings.some((line) => /1 个单元格/.test(line)), '警告里的数量必须是 1');
});

test('同一批数据导成 xlsx 时，这类格子按文本存，不是公式对象', async () => {
  const { source, store, batch } = await exportWith(FORMULA_TITLE);
  const result = await exportFlatFile(store, batch, source, { format: 'xlsx' });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(result.buffer);
  const found = [];
  book.worksheets[0].eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.value && typeof cell.value === 'object' && 'formula' in cell.value) found.push(cell.value.formula);
    });
  });
  assert.deepEqual(found, [], '单元格被写成了公式对象，Excel 打开会执行');
});

test('来源地址不是 http(s) 时，导出页面不生成可点链接', () => {
  const record = structuredClone(archived);
  record.rule_pack_snapshot = {
    rule_pack_version: archived.rule_pack_version,
    rules: [],
    sources: [{
      source_id: 'PROBE-SRC', publisher: 'probe', url: 'javascript:alert(1)',
      is_official: true, document_date: null, checked_at: null,
    }],
  };
  record.review = {
    ...record.review,
    issues: [{
      rule_id: 'AMZ-01', field_path: 'content.title', title: 't', original: 'o',
      reason: 'r', suggestion: 's', method: 'hard_rule', severity: 'blocking',
      source_ids: ['PROBE-SRC'],
    }],
  };
  const report = exportListingReport(record, [record]);
  const worklist = exportListingWorklist(record, [record]);
  for (const html of [report, worklist]) {
    assert.equal((html.match(/href="javascript:/gi) || []).length, 0);
    assert.equal((html.match(/href="data:/gi) || []).length, 0);
  }
  // 报告里那一段「依据」退回成纯文本：让人看得见它写的是什么，不是把来源整段吞掉。
  assert.ok(report.includes('来源地址不是 http(s)：javascript:alert(1)'));
  // 正常的 http(s) 仍然要能点。
  record.rule_pack_snapshot.sources[0].url = 'https://sellercentral.amazon.com/help/hub/reference/G200390640';
  assert.ok(exportListingReport(record, [record]).includes('href="https://sellercentral.amazon.com'));
});

test('商家文案里的 HTML 载荷不会原样进导出页面', () => {  const record = structuredClone(archived);
  record.content.title = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';
  record.content.description = '</style><script>alert(1)</script>';
  record.review = {
    ...record.review,
    issues: [{
      rule_id: 'AMZ-01', field_path: 'content.title', title: '<svg onload=alert(1)>',
      original: '<script>alert(1)</script>', reason: 'r', suggestion: 's',
      method: 'hard_rule', severity: 'blocking', source_ids: [],
    }],
  };
  for (const html of [exportListingReport(record, [record]), exportListingWorklist(record, [record])]) {
    assert.equal((html.match(/<script/gi) || []).length, 0);
    assert.equal((html.match(/<img src=x/gi) || []).length, 0);
    assert.equal((html.match(/<svg onload/gi) || []).length, 0);
    assert.ok(html.includes('&lt;script&gt;'), '转义后的文本应当还在，不能整段吞掉');
  }
});