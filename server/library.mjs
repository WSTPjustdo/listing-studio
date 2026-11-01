import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AppError, sourceIdsForProfile } from './domain.mjs';
import { normalizeMarketplace, rulePackFor } from './store.mjs';
import { evidenceText } from './evidence.mjs';

export const stateLabels = { draft: '草稿', ready: '待上架', published: '已上架（商家登记）' };
const schema = z.object({
  marketplace: z.enum(['US', 'DE', 'UK', 'FR']).optional(),
  base_revision: z.number().int().nonnegative(), listing_id: z.string().min(1), listing_version: z.number().int().positive(),
  sku: z.string().trim().max(100).default(''), state: z.enum(['draft', 'ready', 'published']),
  asin: z.string().trim().toUpperCase().regex(/^(?:[A-Z0-9]{10})?$/).default(''),
  published_on: z.union([z.literal(''), z.iso.date()]).default(''),
  published_confirmation: z.boolean().default(false),
  notes: z.string().trim().max(2000).default(''),
});

const MARKETPLACES = ['US', 'DE', 'UK', 'FR'];
const MARKET_DOMAINS = { US: 'www.amazon.com', DE: 'www.amazon.de', UK: 'www.amazon.co.uk', FR: 'www.amazon.fr' };
const marketOf = record => normalizeMarketplace(record?.marketplace);
export const libraryRowKey = (productId, marketplace) => `${productId}::${marketplace}`;
export function amazonProductUrl(marketplace, asin) {
  const domain = MARKET_DOMAINS[marketplace];
  return domain && /^[A-Z0-9]{10}$/i.test(asin || '') ? `https://${domain}/dp/${asin}` : '';
}
function sourceMarketplace(product) {
  try {
    const host = new URL(product.amazon?.url).hostname.replace(/^www\./, '');
    return { 'amazon.com': 'US', 'amazon.de': 'DE', 'amazon.co.uk': 'UK', 'amazon.fr': 'FR' }[host] || null;
  } catch { return normalizeMarketplace(product.marketplace); }
}
export function libraryRows(store) {
  const listings = store.allLatestListings().filter(record => !record.is_demo && record.trace?.actual_model_call);
  const savedEntries = typeof store.libraryEntries === 'function' ? store.libraryEntries() : [];
  return store.products().filter(product => !product.is_demo).flatMap(product => {
    const productListings = listings.filter(record => record.product_snapshot?.product_id === product.product_id);
    const markets = new Set(productListings.map(marketOf).filter(Boolean));
    for (const saved of savedEntries.filter(item => item.product_id === product.product_id)) {
      const savedRecord = store.version(saved.listing_id, saved.listing_version);
      const marketplace = normalizeMarketplace(saved.marketplace || savedRecord?.marketplace);
      if (marketplace) markets.add(marketplace);
    }
    if (!markets.size) markets.add(sourceMarketplace(product) || 'US');
    return MARKETPLACES.filter(marketplace => markets.has(marketplace)).map(marketplace => {
      const candidates = productListings.filter(record => marketOf(record) === marketplace)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      const saved = store.libraryEntry(product.product_id, marketplace);
      const fixed = saved ? store.version(saved.listing_id, saved.listing_version) : null;
      const entry = saved && normalizeMarketplace(saved.marketplace || fixed?.marketplace) === marketplace ? saved : null;
      const record = entry ? fixed : candidates[0] || null;
      return { key: libraryRowKey(product.product_id, marketplace), marketplace, product,
        entry: entry ? { ...entry, marketplace } : { product_id: product.product_id, marketplace, revision: 0,
          sku: product.sku || '', state: 'draft', asin: sourceMarketplace(product) === marketplace ? product.amazon?.asin || '' : '',
          published_on: '', notes: '', status_source: 'not_registered', updated_at: null },
        record, candidates: candidates.map(item => ({ listing_id: item.listing_id, version: item.version, title: item.content.title,
          created_at: item.created_at, marketplace, language: item.language || 'en' })),
        review_stale: !!record && (record.rule_pack_version !== rulePackFor(marketplace).rule_pack_version || record.product_snapshot?.revision !== product.revision),
        newer_available: !!entry && candidates.some(item => item.created_at > (record?.created_at || '')) };
    });
  });
}

export function saveLibraryEntry(store, productId, input) {
  const data = schema.parse(input);
  const product = store.product(productId);
  if (!product || product.is_demo) throw new AppError('REAL_PRODUCT_REQUIRED', '请选择真实商品。', 400);
  if (product.imported_table && product.sku && data.sku !== product.sku)
    throw new AppError('SKU_IDENTITY_MISMATCH', '表格导入商品须保留原始 SKU。请在原库存文件确认货号后重新导入，不能只修改台账中的 SKU。', 400);
  const record = store.version(data.listing_id, data.listing_version);
  if (!record || record.is_demo || !record.trace.actual_model_call || record.product_snapshot?.product_id !== productId)
    throw new AppError('INVALID_LIBRARY_LISTING', '请选择本商品通过真实模型生成或审核的文案版本。', 400);
  const marketplace = data.marketplace || marketOf(record);
  if (!marketplace || marketplace !== marketOf(record))
    throw new AppError('LIBRARY_MARKETPLACE_MISMATCH', '所选文案与台账站点不一致，请选择本站点文案。', 400);
  const previous = store.libraryEntry(productId, marketplace);
  if ((previous?.revision || 0) !== data.base_revision) throw new AppError('STALE_LIBRARY_ENTRY', '本站点台账已更新，请刷新后重试。', 409);
  if (data.state === 'published' && (!data.published_confirmation || !data.asin || !data.published_on))
    throw new AppError('PUBLICATION_CONFIRMATION_REQUIRED', '登记已上架需要 ASIN、上架日期，并确认这是商家手动记录。', 400);
  if (data.state === 'published' && data.published_on > new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }))
    throw new AppError('INVALID_PUBLICATION_DATE', '已上架日期不能晚于今天。', 400);
  const { base_revision, published_confirmation, ...values } = data;
  return store.saveLibraryEntry({ ...values, marketplace, product_id: productId, revision: base_revision + 1, status_source: 'merchant_manual', updated_at: new Date().toISOString() });
}

export async function exportLibrary(store, selection) {
  const itemSchema = z.object({ product_id: z.string().min(1), marketplace: z.enum(['US', 'DE', 'UK', 'FR']) });
  const items = z.array(z.union([z.string().min(1), itemSchema])).min(1).max(1000).parse(selection);
  const rows = libraryRows(store);
  const selected = items.map(item => typeof item === 'string'
    ? rows.find(row => row.product.product_id === item && row.marketplace === 'US') || rows.find(row => row.product.product_id === item)
    : rows.find(row => row.product.product_id === item.product_id && row.marketplace === item.marketplace));
  if (selected.some(row => !row || !row.record)) throw new AppError('LISTING_REQUIRED', '所选商品站点尚无文案，请先生成或取消选择。', 400);
  if (new Set(selected.map(row => row.key)).size !== selected.length) throw new AppError('DUPLICATE_PRODUCT', '请勿重复选择同一商品站点。', 400);
  const workbook = new ExcelJS.Workbook(); workbook.creator = 'Listing Studio';
  const bulletCount = Math.max(5, ...selected.map(row => row.record.content.bullet_points.length));
  const copy = workbook.addWorksheet('Listing 文案', { views: [{ state: 'frozen', ySplit: 1, xSplit: 4 }] });
  const audit = workbook.addWorksheet('审核与来源', { views: [{ state: 'frozen', ySplit: 1, xSplit: 2 }] });
  copy.columns = [
    ['product_id', '商品ID', 30], ['sku', 'SKU / 货号（未填则空）', 24], ['name', '商品名称', 32], ['state', '管理状态', 25],
    ['asin', 'ASIN（商家登记）', 20], ['published_on', '上架日期（商家登记）', 22], ['url', '商品链接', 35],
    ['title', 'Title', 65], ['highlights', 'Item Highlights', 55], ...Array.from({ length: bulletCount }, (_, index) => [`bullet${index+1}`, `Bullet ${index+1}`, 65]),
    ['description', 'Description', 85], ['listing_id', '文案任务ID', 35], ['version', '文案版本', 12], ['product_revision', '审核商品资料版本', 20], ['registration', '台账保存状态', 24], ['notes', '管理备注', 45], ['marketplace', 'Amazon 站点', 16], ['language', '文案语言', 16],
  ].map(([key, header, width]) => ({ key, header, width }));
  audit.columns = [['product_id','商品ID',30], ['sku','SKU / 货号',24], ['listing_id','文案任务ID',35], ['version','文案版本',12], ['review','审核状态',26],
    ['issues','发现与原句',85], ['missing','待补资料',45], ['submissions','已提交材料（均待核验）',75], ['sources','来源链接',65],
    ['rules','规则版本',40], ['model','实际模型',24], ['request','实际请求ID',40], ['updated','审核时间',28], ['status_source','上架状态来源',35], ['boundary','使用说明',65], ['parameter_links','参数关联与待核对项',85], ['marketplace','Amazon 站点',16], ['language','文案语言',16],
  ].map(([key, header, width]) => ({ key, header, width }));
  for (const { product, marketplace, entry, record, review_stale } of selected) {
    const content = record.content;
    const id = product.product_id, sku = entry.sku || '';
    copy.addRow({ product_id: id, sku, name: product.name_zh, state: stateLabels[entry.state], asin: entry.asin, published_on: entry.published_on,
      url: amazonProductUrl(marketplace, entry.asin), marketplace, language: record.language || 'en', title: content.title, highlights: content.item_highlights,
      ...Object.fromEntries(Array.from({ length: bulletCount }, (_, index) => [`bullet${index+1}`, content.bullet_points[index]?.text || ''])), description: content.description,
      listing_id: record.listing_id, version: record.version, product_revision: record.product_snapshot.revision,
      registration: entry.revision ? `已保存台账 V${entry.revision}` : '尚未登记，导出最新草稿', notes: entry.notes });
    const sourceIds = new Set(sourceIdsForProfile(record.product_snapshot));
    audit.addRow({ product_id: id, marketplace, language: record.language || 'en', sku, listing_id: record.listing_id, version: record.version, review: `${record.review.issues.length} 项发现；${record.review.missing_data.length} 项资料待补${review_stale ? '；资料或规则已更新，需复检' : ''}`,
      issues: [...record.review.issues.map(item => `${item.rule_id}｜${item.title}\n${item.original}\n${item.reason}`), ...(record.review.consistency_check?.state === 'changed' ? [record.review.consistency_check.reason] : [])].join('\n\n'),
      missing: record.review.missing_data.map(item => `${item.label}：${item.reason}`).join('\n'),
      submissions: (record.product_snapshot.evidence_submissions || []).map(item => `${item.title}｜待核验｜${item.source_id}\n${item.excerpt}`).join('\n\n'),
      sources: store.sources().filter(source => sourceIds.has(source.source_id)).map(source => `${source.source_id}｜${source.url || '未提供链接'}`).join('\n'),
      rules: record.rule_pack_version, model: record.trace.model, request: record.trace.provider_request_id, updated: record.created_at,
      parameter_links: (record.review.evidence || []).map(evidenceText).join('\n\n'),
      status_source: entry.revision ? '商家手动登记，未向 Amazon 核验' : '未登记', boundary: '用于商品文案管理；不是 Amazon 批量上传模板，不表示平台审核通过。' });
  }
  let continuation;
  for (const sheet of [copy, audit]) sheet.eachRow((row, index) => {
    if (index === 1) return;
    row.eachCell(cell => {
      if (cell.value === '') { cell.value = null; return; }
      if (typeof cell.value !== 'string' || cell.value.length <= 32000) return;
      if (!continuation) {
        continuation = workbook.addWorksheet('长文本续页');
        continuation.columns = [{ header: '商品ID', key: 'product', width: 35 }, { header: '原工作表 / 列', key: 'field', width: 40 }, { header: '片段序号', key: 'part', width: 12 }, { header: '完整原文片段（按序拼接）', key: 'text', width: 100 }];
      }
      const value = cell.value;
      for (let offset = 0; offset < value.length; offset += 32000) continuation.addRow({ product: row.getCell(1).value, field: `${sheet.name} / ${sheet.getRow(1).getCell(cell.col).value}`, part: offset / 32000 + 1, text: value.slice(offset, offset + 32000) });
      cell.value = '完整内容见“长文本续页”，按相同商品和列名的片段序号拼接。';
    });
  });
  for (const sheet of [copy, audit, ...(continuation ? [continuation] : [])]) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: sheet.columnCount } };
    sheet.getRow(1).height = 32;
    sheet.getRow(1).eachCell(cell => { cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF245B8E' } }; });
    sheet.eachRow((row, index) => { if (index > 1) { row.height = 150; row.eachCell(cell => { cell.alignment = { vertical: 'top', wrapText: true }; cell.font = { size: 11 }; if (index % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F6FA' } }; }); } });
  }
  return workbook.xlsx.writeBuffer();
}
