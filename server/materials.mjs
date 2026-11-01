import { createHash } from 'node:crypto';
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { AppError, id } from './domain.mjs';
import { parseDelimited } from './flat-file.mjs';

export const MATERIAL_LIMITS = Object.freeze({ files: 12, bytes: 5 * 1024 * 1024, totalBytes: 20 * 1024 * 1024, characters: 60000, pages: 30 });
const fileSchema = z.object({ filename: z.string().trim().min(1).max(250), base64: z.string().min(1).max(7000000) }).strict();
const inputSchema = z.object({ files: z.array(fileSchema).min(1).max(MATERIAL_LIMITS.files), text: z.string().max(15000).optional() }).strict();
const materialSelectionSchema = z.object({ preview_id: z.string().min(1).max(100), document_ids: z.array(z.string().min(1).max(100)).min(1).max(MATERIAL_LIMITS.files) }).strict();
export const materialContextSchema = materialSelectionSchema.extend({
  corrected_text: z.string().max(MATERIAL_LIMITS.characters).optional(),
  additional_contexts: z.array(materialSelectionSchema).max(MATERIAL_LIMITS.files - 1).optional(),
}).strict();
let extracting = false;
const fail = (code, message) => { throw new AppError(code, message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clean = value => String(value || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();

export function decodeMaterialText(bytes) {
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
  if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('MATERIAL_ENCODING', '文字文件请另存为 UTF-8 或带 BOM 的 UTF-16 后重试。'); }
}

async function checkOfficeZip(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  if (entries.length > 5000 || entries.reduce((sum, item) => sum + (item._data?.uncompressedSize || 0), 0) > 80 * 1024 * 1024)
    fail('MATERIAL_ARCHIVE_LIMIT', 'Office 文件解压内容过大，请拆分或另存为精简文件。');
  return zip;
}

async function makeOcr() {
  const { createWorker } = await import('tesseract.js');
  const cachePath = resolve('.runtime/ocr-cache');
  const langPath = resolve('.runtime/ocr-languages');
  await mkdir(cachePath, { recursive: true });
  await mkdir(langPath, { recursive: true });
  // Install language resources with npm ci; runtime OCR needs no CDN or model API.
  const require = createRequire(import.meta.url);
  await Promise.all(['chi_sim', 'eng'].map(async code => {
    const info = require(`@tesseract.js-data/${code}`);
    await copyFile(resolve(info.langPath, '..', '4.0.0_best_int', `${code}.traineddata.gz`), resolve(langPath, `${code}.traineddata.gz`));
  }));
  let expired = false, timer;
  const pending = createWorker('chi_sim+eng', 1, { cachePath, langPath, errorHandler: () => {} });
  void pending.then(worker => { if (expired) void worker.terminate(); }).catch(() => {});
  let worker;
  try {
    worker = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('OCR language initialization timed out')); }, 60000); })]);
  } finally { clearTimeout(timer); }
  await worker.setParameters({ preserve_interword_spaces: '1' });
  return worker;
}

async function imageText(bytes, getWorker) {
  const { loadImage, createCanvas } = await import('@napi-rs/canvas');
  let img;
  try { img = await loadImage(bytes); } catch { fail('MATERIAL_IMAGE', '图片无法解码，请重新导出为 PNG、JPEG 或 WebP。'); }
  if (img.width * img.height > 24000000) fail('MATERIAL_IMAGE_LIMIT', '图片像素超过 2400 万，请缩小后重试。');
  // Small chat captures often contain thin UI text. Enlarge pixels before OCR,
  // preserving the original upload/hash and exposing only the recognized text.
  let ocrBytes = bytes;
  if (img.width < 1800 && img.height < 1800) {
    const scale = Math.min(3, 1800 / Math.max(img.width, img.height));
    const canvas = createCanvas(Math.ceil(img.width * scale), Math.ceil(img.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    ocrBytes = canvas.toBuffer('image/png');
  }
  const worker = await getWorker();
  let timer;
  try {
    const result = await Promise.race([
      worker.recognize(ocrBytes),
      new Promise((_, reject) => { timer = setTimeout(() => { void worker.terminate(); reject(new AppError('MATERIAL_OCR_TIMEOUT', '图片文字识别超过 90 秒，请裁切文字区域后重试。')); }, 90000); }),
    ]);
    return { text: clean(result.data.text), confidence: result.data.confidence };
  } finally { clearTimeout(timer); }
}

async function extractPdf(bytes, getWorker) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true });
  let pdf;
  try {
    pdf = await task.promise;
    if (pdf.numPages > MATERIAL_LIMITS.pages) fail('MATERIAL_PAGES', 'PDF 超过 30 页，请按商品拆分后导入。');
    const segments = [], warnings = [];
    let length = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = clean(content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join(''));
      let method = 'pdf_text';
      if (text.replace(/\s/g, '').length < 15) {
        const view = page.getViewport({ scale: 1.8 });
        if (view.width * view.height > 16000000) fail('MATERIAL_PAGE_SIZE', `PDF 第 ${n} 页过大，请缩小页面后重试。`);
        const canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height));
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
        const result = await imageText(canvas.toBuffer('image/png'), getWorker);
        text = result.text; method = 'local_ocr';
        warnings.push(`第 ${n} 页使用本机 OCR，数值、单位和中文需对照原页确认。`);
      }
      if (text) segments.push({ locator: `第 ${n} 页`, text, method });
      else warnings.push(`第 ${n} 页未识别到文字，图片外观不作为商品参数。`);
      length += text.length;
      if (length > MATERIAL_LIMITS.characters) fail('MATERIAL_TEXT_LIMIT', 'PDF 提取文字超过 6 万字，请拆分后重试。');
      page.cleanup();
    }
    return { segments, warnings };
  } catch (error) {
    if (error.name === 'PasswordException') fail('MATERIAL_PASSWORD', 'PDF 已加密，请提供无需密码的文件。');
    throw error;
  } finally { await task.destroy(); }
}

const cellText = cell => {
  if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Error) return '[公式或错误值未采用]';
  if (cell.value instanceof Date) return cell.value.toISOString().slice(0, 10);
  return clean(cell.text);
};
async function extractDocument(kind, bytes, getWorker) {
  if (kind === 'docx') {
    await checkOfficeZip(bytes);
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer: bytes });
    return { segments: clean(result.value).split(/\n\s*\n/).filter(Boolean).map((text, i) => ({ locator: `段落 ${i + 1}`, text })), warnings: ['Word 中的嵌入图片不在正文提取范围；图片内备注请另行上传。', ...result.messages.map(item => clean(item.message)).slice(0, 5)] };
  }
  if (kind === 'pdf') return extractPdf(bytes, getWorker);
  if (['png', 'jpg', 'jpeg', 'webp'].includes(kind)) {
    const result = await imageText(bytes, getWorker);
    return { segments: result.text ? [{ locator: '图片文字', text: result.text, method: 'local_ocr', confidence: result.confidence }] : [], warnings: ['本机中英文 OCR；仅识别可见文字，外观、尺寸和材质不能凭照片推断。', ...(result.confidence < 70 ? ['识别置信度较低，请核对截图中的姓名、数字和单位。'] : [])] };
  }
  if (kind === 'xlsx') {
    await checkOfficeZip(bytes);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes);
    const segments = [], warnings = []; let length = 0;
    for (const sheet of workbook.worksheets) {
      if (sheet.state !== 'visible') { warnings.push(`工作表「${sheet.name}」已隐藏，未采用。`); continue; }
      if (sheet.rowCount > 2000 || sheet.columnCount > 1000) fail('MATERIAL_TABLE_LIMIT', '素材表格超过 2000 行或 1000 列，请按商品拆分。');
      sheet.eachRow((row, n) => {
        const values = []; row.eachCell({ includeEmpty: true }, cell => values.push(cellText(cell)));
        const text = values.join('\t').trim();
        if (text) segments.push({ locator: `${sheet.name} · 第 ${n} 行`, text });
        length += text.length;
        if (length > MATERIAL_LIMITS.characters) fail('MATERIAL_TEXT_LIMIT', '素材表格文字超过 6 万字，请拆分。');
      });
    }
    warnings.push('多个 SKU 请使用亚马逊模板批量导入；此处仅整理同一商品的补充素材。公式及错误值不会作为事实采用。');
    return { segments, warnings };
  }
  if (['txt', 'csv', 'tsv'].includes(kind)) {
    const text = decodeMaterialText(bytes).replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
    const rows = kind === 'txt' ? text.split('\n') : parseDelimited(text, kind === 'tsv' ? '\t' : ',').map(row => row.join('\t'));
    return { segments: rows.map((text, i) => ({ locator: `第 ${i + 1} ${kind === 'txt' ? '行' : '条记录'}`, text: clean(text) })).filter(segment => segment.text), warnings: kind === 'txt' ? [] : ['多个 SKU 的库存模板请使用批量导入；此处材料将归入同一商品。'] };
  }
  fail('MATERIAL_FORMAT', kind === 'doc' ? '旧版 .doc 请另存为 .docx 或 PDF 后上传。' : kind === 'xls' ? '旧版 .xls 请另存为 .xlsx 后上传。' : '支持 DOCX、PDF、XLSX、CSV、TSV、TXT、PNG、JPEG 和 WebP。');
}

export const materialDocumentText = doc => doc.segments.map(segment => `【${doc.filename} / ${segment.locator}】\n${segment.text}`).join('\n');

export async function previewMaterials(store, raw) {
  const input = inputSchema.parse(raw);
  if (extracting) throw new AppError('MATERIAL_BUSY', '正在识别另一组材料，请稍后重试。', 409);
  const files = input.files.map(file => {
    if (file.base64.length % 4 || /[^A-Za-z0-9+/=]/.test(file.base64)) fail('MATERIAL_BASE64', '上传内容不是有效的文件编码。');
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.toString('base64') !== file.base64) fail('MATERIAL_BASE64', '上传内容不是有效的文件编码。');
    if (!bytes.length || bytes.length > MATERIAL_LIMITS.bytes) fail('MATERIAL_FILE_SIZE', '单个文件须大于 0 且不超过 5 MB。');
    return { ...file, bytes };
  });
  if (files.reduce((sum, file) => sum + file.bytes.length, 0) > MATERIAL_LIMITS.totalBytes) fail('MATERIAL_TOTAL_SIZE', '本组材料总大小不能超过 20 MB。');
  extracting = true; let worker = null;
  const getWorker = async () => {
    try { worker ||= await makeOcr(); return worker; }
    catch { fail('MATERIAL_OCR_UNAVAILABLE', '本机 OCR 初始化失败，请先运行 npm ci 安装中英文识别资源，或粘贴截图中的原文后继续。'); }
  };
  try {
    const documents = [], seen = new Set();
    for (const file of files) {
      const kind = extname(file.filename).slice(1).toLowerCase();
      const doc = { id: id('material'), filename: file.filename, kind, sha256: hash(file.bytes), bytes: file.bytes.length, status: 'failed', text: '', segments: [], warnings: [] };
      try {
        if (seen.has(doc.sha256)) fail('MATERIAL_DUPLICATE', '同一文件重复上传，请保留一份。');
        seen.add(doc.sha256);
        Object.assign(doc, await extractDocument(kind, file.bytes, getWorker));
        doc.text = doc.segments.map(s => s.text).join('\n');
        if (doc.text.length > MATERIAL_LIMITS.characters) fail('MATERIAL_TEXT_LIMIT', '单份材料超过 6 万字，请拆分后导入。');
        doc.status = doc.text.trim() ? 'ready' : 'needs_input';
        if (doc.status === 'needs_input') doc.warnings.push('未取得可用文字，请补充图片备注或直接粘贴原文。');
      } catch (error) {
        if (worker && ['MATERIAL_OCR_TIMEOUT', 'MATERIAL_OCR_UNAVAILABLE'].includes(error.code)) { try { await worker.terminate(); } catch {} worker = null; }
        doc.status = 'failed'; doc.text = ''; doc.segments = [];
        doc.error = { code: error.code || 'MATERIAL_PARSE', message: error instanceof AppError ? error.message : '文件读取失败；请确认格式、未加密且文件完整后重试。' };
      }
      documents.push(doc);
    }
    if (input.text?.trim()) {
      const text = clean(input.text);
      documents.push({ id: id('material'), filename: '随附文字备注', kind: 'merchant_text', sha256: hash(Buffer.from(text)), bytes: Buffer.byteLength(text), status: 'ready', text, segments: [{ locator: '商家补充', text }], warnings: ['商家输入文字，尚未独立核实。'] });
    }
    const preview = { id: id('materials'), kind: 'factory_material_preview', received_at: new Date().toISOString(), documents, text: documents.filter(doc => doc.status === 'ready').map(materialDocumentText).join('\n\n'), warnings: ['材料识别不创建商品。确认属于同一商品后，再由真实模型整理；冲突和未知参数须人工核对。'] };
    if (preview.text.length > MATERIAL_LIMITS.characters) preview.warnings.push('本组提取文字超过 6 万字，请取消勾选部分文件，按商品分组整理后再使用。');
    // Preserve original bytes only in the private database; never send them back or package them.
    store.saveImport({ ...preview, original_files: files.map(file => ({ filename: file.filename, base64: file.base64 })) });
    return preview;
  } finally { if (worker) { try { await worker.terminate(); } catch {} } extracting = false; }
}

export function resolveMaterialContext(store, raw) {
  const context = materialContextSchema.parse(raw);
  const selections = [context, ...(context.additional_contexts || [])];
  if (new Set(selections.map(selection => selection.preview_id)).size !== selections.length)
    fail('MATERIAL_SELECTION', '同一材料批次不能重复采用，请重新确认。');
  if (selections.reduce((count, selection) => count + selection.document_ids.length, 0) > MATERIAL_LIMITS.files)
    fail('MATERIAL_SELECTION', '累计采用的材料最多 12 份，请减少文件后重试。');
  const groups = selections.map(selection => {
    const preview = store.getImport(selection.preview_id);
    if (!preview || preview.kind !== 'factory_material_preview') fail('MATERIAL_NOT_FOUND', '找不到材料识别记录，请重新上传。');
    const documents = selection.document_ids.map(key => preview.documents.find(doc => doc.id === key));
    if (new Set(selection.document_ids).size !== documents.length || documents.some(doc => !doc || doc.status !== 'ready'))
      fail('MATERIAL_SELECTION', '选中的材料不存在、重复或未成功识别，请重新确认。');
    return { preview, documents };
  });
  const documents = groups.flatMap(({ preview, documents }) => documents.map(doc => ({ ...doc, received_at: preview.received_at })));
  if (new Set(documents.map(doc => doc.id)).size !== documents.length)
    fail('MATERIAL_SELECTION', '选中的材料来源重复，请重新确认。');
  if (documents.reduce((bytes, doc) => bytes + doc.bytes, 0) > MATERIAL_LIMITS.totalBytes)
    fail('MATERIAL_TOTAL_SIZE', '累计采用的材料总大小不能超过 20 MB，请减少文件后重试。');
  const originalText = documents.map(materialDocumentText).join('\n\n');
  const text = context.corrected_text === undefined ? originalText : clean(context.corrected_text);
  if (!text || text.length > MATERIAL_LIMITS.characters) fail('MATERIAL_TEXT_LIMIT', '选中材料须有可用文字且不超过 6 万字，请减少文件或拆分商品。');
  return { text, context: {
    preview_id: context.preview_id,
    document_ids: documents.map(doc => doc.id),
    received_at: groups[0].preview.received_at,
    documents, original_text: originalText,
    ...(context.additional_contexts?.length ? { selections: selections.map(({ preview_id, document_ids }) => ({ preview_id, document_ids })) } : {}),
    ...(context.corrected_text !== undefined ? { corrected_text: text, correction_source: 'merchant_edit' } : {}),
  } };
}
