import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AppError, id } from './domain.mjs';
import { rulePack } from './store.mjs';
import { sameEvidence } from './submissions.mjs';

const columns = ['交接单ID', '任务ID', '商品ID', '商品名称', '资料版本', '文案任务ID', '文案版本', '对应问题', '问题原句 / 缺失说明', '需提供的资料', '负责人（填写）', '截止日期（填写 YYYY-MM-DD）', '材料名称（填写）', '适用型号（填写）', '出具方（填写）', '来源链接（可空）', '来源原文（填写）'];
const replySchema = z.object({ owner: z.string().trim().max(100), due_on: z.union([z.literal(''), z.iso.date()]), title: z.string().trim().min(1).max(200), applicable_model: z.string().trim().min(1).max(200), publisher: z.string().trim().min(1).max(200), url: z.union([z.literal(''), z.url().refine(v => /^https?:\/\//i.test(v))]), excerpt: z.string().trim().min(10).max(20000) });
function ensureCurrent(store, handoff) {
  if (!handoff?.product_id) throw new AppError('HANDOFF_NOT_FOUND', '找不到交接单或关联商品。');
  const product = store.product(handoff.product_id), record = store.latest(handoff.listing_id);
  if (!product || product.is_demo || !record?.trace.actual_model_call || record.is_demo) throw new AppError('REAL_RECORD_REQUIRED', '交接需要真实商品和真实审核记录。');
  if (product.revision !== handoff.product_revision || record.version !== handoff.listing_version || handoff.rule_version !== rulePack.rule_pack_version)
    throw new AppError('STALE_HANDOFF', '商品资料、文案或规则已更新，请重新导出交接表；旧文件保留用于追溯。', 409);
  return { product, record };
}
export async function exportHandoff(store, raw) {
  const input = z.object({ listing_id: z.string(), listing_version: z.number().int().positive(), product_revision: z.number().int().positive() }).parse(raw);
  const record = store.latest(input.listing_id);
  const handoff = { id: id('handoff'), product_id: record?.product_snapshot?.product_id, product_revision: input.product_revision, listing_id: input.listing_id, listing_version: input.listing_version, rule_version: rulePack.rule_pack_version, created_at: new Date().toISOString() };
  const { product } = ensureCurrent(store, handoff);
  if (record.rule_pack_version !== rulePack.rule_pack_version) throw new AppError('STALE_REVIEW', '审核规则已更新，请先用当前规则复检后导出交接表。', 409);
  handoff.tasks = [...record.review.issues.filter(item => item.category !== 'system_integrity').map(item => ({ target: item.issue_id, label: item.title, original: item.original, request: `${item.reason}\n${item.suggestion}`, field_path: item.field_path })),
    ...record.review.missing_data.map(item => ({ target: item.field, label: item.label, original: item.reason, request: item.field === 'retail_pack_count' ? '确认本零售 SKU 每包件数，不能以工厂装箱数代替。提供适用型号及来源原文。' : '提供适用本商品型号的来源原文，保留单位、条件与出具方。', field_path: item.field }))]
    .map(item => ({ ...item, task_id: id('task') }));
  if (!handoff.tasks.length) throw new AppError('NO_HANDOFF_TASKS', '当前没有需交接的问题或缺失资料。');
  if (handoff.tasks.length > 200) throw new AppError('HANDOFF_LIMIT', '当前问题超过 200 项，请先处理部分问题。');
  const book = new ExcelJS.Workbook(); book.creator = 'Listing Studio';
  const sheet = book.addWorksheet('补资料回传', { views: [{ state: 'frozen', ySplit: 1, xSplit: 4 }] });
  sheet.columns = columns.map((header, index) => ({ header, width: index >= 8 ? 42 : 24 }));
  for (const task of handoff.tasks) {
    task.fixed = [handoff.id, task.task_id, product.product_id, product.name_zh, product.revision, record.listing_id, record.version, task.label, task.original, task.request].map(String);
    // Keep authoritative metadata server-side; returned spreadsheets are untrusted.
    if (task.fixed.some(value => value.length > 30000)) throw new AppError('HANDOFF_CELL_LIMIT', '问题原文过长，请在页面逐项补证。');
    sheet.addRow([...task.fixed, '', '', '', '', '', '', '']);
  }
  sheet.autoFilter = `A1:Q${sheet.rowCount}`;
  sheet.eachRow((row, index) => { row.height = index === 1 ? 40 : 90; row.eachCell({ includeEmpty: true }, (cell, column) => { cell.alignment = { vertical: 'top', wrapText: true }; if (index === 1) { cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF24567A' } }; } else if (column >= 11) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF5D6' } }; }); });
  const guide = book.addWorksheet('填写说明');
  guide.getColumn(1).width = 110;
  ['仅填写“填写 / 可空”列。其他列用于核对任务，不可修改；可删除暂不回传的行。', '负责人和截止日期可空。日期填写文本 YYYY-MM-DD；没有材料的行留空，不会导入。', '材料名称、适用型号、出具方、原文必须填写；不得用其他型号或竞品参数代替。', '只接受纯文本，不接受公式、超链接对象或合并单元格。超过 5 MB 请拆分。', '回传先预览，再由运营选择确认。材料均为待核验，不更新商品参数，不自动消除风险；保存后使用真实模型复检。', '本交接单只在导出它的本机工作台有效。商品、文案或规则更新后须重新导出。'].forEach(text => { const row = guide.addRow([text]); row.height = 45; row.alignment = { wrapText: true, vertical: 'top' }; });
  const buffer = await book.xlsx.writeBuffer();
  store.saveImport(handoff);
  return buffer;
}
export async function previewHandoff(store, raw) {
  const input = z.object({ filename: z.string().max(250).regex(/\.xlsx$/i), base64: z.string().max(7000000), product_id: z.string(), listing_id: z.string() }).parse(raw);
  const buffer = Buffer.from(input.base64, 'base64');
  if (buffer.length > 5 * 1024 * 1024) throw new AppError('FILE_TOO_LARGE', '回传文件最多 5 MB。');
  const book = new ExcelJS.Workbook();
  try { await book.xlsx.load(buffer); } catch { throw new AppError('FILE_PARSE', '无法读取回传表，请使用未加密的 XLSX 文件。'); }
  const sheet = book.getWorksheet('补资料回传');
  if (!sheet || sheet.rowCount < 2 || sheet.rowCount > 201 || sheet.columnCount !== columns.length || sheet.model.merges?.length) throw new AppError('HANDOFF_FORMAT', '请使用工作台导出的交接表，最多 200 行且不要合并单元格。');
  const read = (row, column) => { const value = row.getCell(column).value; if (value === null) return ''; if (!['string', 'number'].includes(typeof value)) throw new AppError('HANDOFF_CELL', `第 ${row.number} 行含非纯文本，请粘贴为值；日期使用文本。`); const text = String(value); if (text.length > 30000) throw new AppError('HANDOFF_CELL', '单元格过长。'); return text; };
  if (columns.some((header, index) => read(sheet.getRow(1), index + 1) !== header)) throw new AppError('HANDOFF_HEADERS', '回传表头已改变，请使用原交接表。');
  const rows = [], seen = new Set(); let handoff;
  sheet.eachRow((row, number) => {
    if (number === 1) return;
    const values = columns.map((_, index) => read(row, index + 1));
    if (values.every(value => !value.trim())) return;
    const current = store.getImport(values[0]);
    if (!current?.tasks || !current.id.startsWith('handoff-') || (handoff && handoff.id !== current.id)) throw new AppError('HANDOFF_NOT_FOUND', '交接单不存在或混入了其他交接单。');
    handoff = current; ensureCurrent(store, handoff);
    if (handoff.product_id !== input.product_id || handoff.listing_id !== input.listing_id) throw new AppError('PRODUCT_MISMATCH', '回传表不属于当前商品和审核任务，请打开对应任务后上传。');
    const task = handoff.tasks.find(task => task.task_id === values[1]);
    if (!task || task.fixed.some((value, index) => value !== values[index]) || seen.has(task.task_id)) throw new AppError('HANDOFF_TAMPERED', '任务信息被修改或重复，请使用原表。');
    seen.add(task.task_id);
    const [owner, due_on, title, applicable_model, publisher, url, excerpt] = values.slice(10).map(value => value.trim());
    if (![title, applicable_model, publisher, url, excerpt].some(Boolean)) return;
    const parsed = replySchema.safeParse({ owner, due_on, title, applicable_model, publisher, url, excerpt });
    rows.push({ row_id: task.task_id, row_number: number, target_label: task.label, original: task.original, request: task.request, reply: parsed.success ? parsed.data : { owner, due_on, title, applicable_model, publisher, url, excerpt }, error: parsed.success ? null : '材料名称、适用型号、出具方和至少 10 字符原文必填；请检查链接与日期。' });
  });
  if (!rows.length) throw new AppError('NO_HANDOFF_REPLIES', '没有已填写的材料，请先填写黄色列。');
  const preview = { id: id('handoff-preview'), handoff_id: handoff.id, product_id: handoff.product_id, product_revision: handoff.product_revision, rows, created_at: new Date().toISOString() };
  store.saveImport(preview);
  return preview;
}
export function confirmHandoff(store, raw) {
  const input = z.object({ preview_id: z.string(), row_ids: z.array(z.string()).min(1).max(200) }).parse(raw);
  const preview = store.getImport(input.preview_id);
  if (!preview?.handoff_id || preview.confirmed_at) throw new AppError('HANDOFF_PREVIEW_USED', '预览不存在或已经确认，请重新上传。', 409);
  const handoff = store.getImport(preview.handoff_id);
  const { product } = ensureCurrent(store, handoff);
  if (new Set(input.row_ids).size !== input.row_ids.length) throw new AppError('HANDOFF_SELECTION', '所选材料重复。');
  const sources = [], submissions = [];
  for (const rowId of input.row_ids) {
    const row = preview.rows.find(row => row.row_id === rowId), task = handoff.tasks.find(task => task.task_id === rowId);
    if (!row || row.error || !task) throw new AppError('HANDOFF_SELECTION', '请选择预览中有效的材料。');
    const reply = replySchema.parse(row.reply);
    if ([...(product.evidence_submissions || []), ...submissions].some(item => sameEvidence(item, { ...reply, target: task.target }))) throw new AppError('DUPLICATE_EVIDENCE', '所选原文已提交，请取消该行或补充不同材料。', 409);
    const source_id = id('evidence'), submitted_at = new Date().toISOString();
    submissions.push({ ...reply, source_id, submitted_at, status: 'submitted_unverified', target: task.target, target_label: task.label, original: task.original, field_path: task.field_path, listing_id: handoff.listing_id, listing_version: handoff.listing_version, base_revision: product.revision, handoff_id: handoff.id, handoff_task_id: task.task_id });
    sources.push({ source_id, kind: 'merchant_submission', publisher: reply.publisher, url: reply.url || null, description: `${reply.title} · 适用型号：${reply.applicable_model}`, checked_at: submitted_at, note: '交接表回传材料，尚未核验真实性、适用性或有效期，不自动确认参数。', snapshot: reply.excerpt });
  }
  const next = { ...structuredClone(product), revision: product.revision + 1, evidence_submissions: [...(product.evidence_submissions || []), ...submissions] };
  store.saveHandoffEvidence(next, sources, { ...preview, confirmed_at: new Date().toISOString(), selected: input.row_ids }, handoff);
  return { product: next, submitted_count: submissions.length, status: 'submitted_unverified' };
}
