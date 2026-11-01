// Parser boundary checks only. These fixtures are not real merchant or model acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { createStore } from '../server/store.mjs';
import { previewMaterials, resolveMaterialContext, decodeMaterialText } from '../server/materials.mjs';
import { createResearchProduct } from '../server/research.mjs';
import { sourceIdsForProfile } from '../server/domain.mjs';
import { factSourceExport } from '../server/listing-report.mjs';

const file = (filename, value) => ({ filename, base64: Buffer.from(value).toString('base64') });
test('mixed materials preserve good files and per-file failures without creating products', async () => {
  const store = createStore(':memory:');
  try {
    const before = store.products();
    const preview = await previewMaterials(store, { files: [file('工厂备注.txt', '材质：棉布\n尺寸待确认'), file('旧版.doc', 'not docx'), file('重复.txt', '材质：棉布\n尺寸待确认')] });
    assert.deepEqual(preview.documents.map(doc => doc.status), ['ready', 'failed', 'failed']);
    assert.equal(preview.documents[1].error.code, 'MATERIAL_FORMAT');
    assert.equal(preview.documents[2].error.code, 'MATERIAL_DUPLICATE');
    assert.deepEqual(store.products(), before);
    assert.ok(!JSON.stringify(preview).includes('base64'));
    const resolved = resolveMaterialContext(store, { preview_id: preview.id, document_ids: [preview.documents[0].id] });
    assert.match(resolved.text, /工厂备注.txt \/ 第 1 行/);
    assert.throws(() => resolveMaterialContext(store, { preview_id: preview.id, document_ids: [preview.documents[1].id] }), /未成功识别/);
    const corrected = resolveMaterialContext(store, { preview_id: preview.id, document_ids: [preview.documents[0].id], corrected_text: '商家更正：材质待确认' });
    assert.equal(corrected.text, '商家更正：材质待确认');
    assert.match(corrected.context.original_text, /棉布/);
    assert.equal(corrected.context.correction_source, 'merchant_edit');
    store.saveImport({id:'analysis-material-test', facts:[{label:'材质',value:'棉布',source_refs:[{document_id:preview.documents[0].id,filename:'工厂备注.txt',locator:'第 1 行'}]}], material_context:resolved.context});
    const product = createResearchProduct(store, {name:'工程边界测试',material:'棉布',facts:'材质：棉布',category_confirmed:true,analysis_id:'analysis-material-test'});
    assert.ok(sourceIdsForProfile(product).includes(preview.documents[0].id));
    assert.equal(product.additional_facts[0].source_refs[0].locator, '第 1 行');
    assert.match(factSourceExport({product_snapshot:product}).join('\n'), /工厂备注.txt \/ 第 1 行/);
  } finally { store.close(); }
});
test('DOCX paragraphs and Chinese workbook rows retain locators; formulas are excluded', async () => {
  const store = createStore(':memory:');
  try {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>材质：棉布</w:t></w:r></w:p><w:p><w:r><w:t>颜色待确认</w:t></w:r></w:p></w:body></w:document>');
    const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('工厂参数');
    sheet.addRow(['参数', '数值']); sheet.addRow(['宽度', { formula: '1+1', result: 2 }]); sheet.addRow(['货号', '00001']);
    const preview = await previewMaterials(store, { files: [file('中文说明.docx', await zip.generateAsync({ type: 'nodebuffer' })), file('零散参数.xlsx', await book.xlsx.writeBuffer())] });
    assert.deepEqual(preview.documents.map(doc => doc.status), ['ready', 'ready']);
    assert.match(preview.documents[0].segments[0].text, /材质：棉布/);
    assert.equal(preview.documents[1].segments[2].locator, '工厂参数 · 第 3 行');
    assert.match(preview.documents[1].text, /00001/);
    assert.match(preview.documents[1].text, /公式或错误值未采用/);
  } finally { store.close(); }
});
test('UTF-16 source decoding preserves Chinese and limits reject before storage', async () => {
  assert.equal(decodeMaterialText(Buffer.concat([Buffer.from([255, 254]), Buffer.from('中文说明', 'utf16le')])), '中文说明');
  const store = createStore(':memory:');
  try {
    await assert.rejects(previewMaterials(store, { files: [{ filename: 'wrong.txt', base64: '!!' }] }), /文件编码/);
    await assert.rejects(previewMaterials(store, { files: [file('大文件.txt', Buffer.alloc(5 * 1024 * 1024 + 1))] }), /5 MB/);
    const result = await previewMaterials(store, { files: [file('空白.txt', '   ')] });
    assert.equal(result.documents[0].status, 'needs_input');
    const positions = await previewMaterials(store, { files: [file('位置.txt', '\n\n材质：棉布\n\n备注待确认')], text:'随附说明' });
    assert.equal(positions.documents[0].segments[0].locator, '第 3 行');
    assert.equal(positions.documents[0].segments[1].locator, '第 5 行');
    assert.equal(positions.documents[1].text, '随附说明');
  } finally { store.close(); }
});

test('materials from multiple persisted previews retain original locators and reject forged cross-preview references', async () => {
  const store = createStore(':memory:');
  try {
    const first = await previewMaterials(store, {files:[file('第一批.txt','工程来源甲原文')]});
    const second = await previewMaterials(store, {files:[file('第二批.txt','工程来源乙原文')]});
    const raw = { preview_id:second.id, document_ids:[second.documents[0].id], additional_contexts:[{preview_id:first.id,document_ids:[first.documents[0].id]}], corrected_text:'手工核对与补充说明' };
    const result = resolveMaterialContext(store, raw);
    assert.equal(result.text, raw.corrected_text);
    assert.deepEqual(result.context.document_ids, [second.documents[0].id,first.documents[0].id]);
    assert.match(result.context.original_text, /第一批.txt \/ 第 1 行/);
    assert.match(result.context.original_text, /第二批.txt \/ 第 1 行/);
    assert.equal(result.context.documents[1].received_at, first.received_at);
    assert.ok(!JSON.stringify(result).includes('base64'));
    assert.throws(() => resolveMaterialContext(store,{...raw,additional_contexts:[{preview_id:first.id,document_ids:[second.documents[0].id]}]}), /不存在/);
    assert.throws(() => resolveMaterialContext(store,{...raw,additional_contexts:[{preview_id:second.id,document_ids:[second.documents[0].id]}]}), /重复采用/);
    assert.throws(() => resolveMaterialContext(store,{...raw,additional_contexts:[{preview_id:'not-persisted',document_ids:[first.documents[0].id]}]}), /找不到/);
  } finally {store.close();}
});
