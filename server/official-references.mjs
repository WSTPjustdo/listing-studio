import { load } from 'cheerio';
import { z } from 'zod';
import { id, AppError } from './domain.mjs';

const catalog = [
  { reference_id: 'official-wm-w101', url: 'https://westfordmill.com/products/w101' },
  { reference_id: 'official-wm-w201', url: 'https://westfordmill.com/products/w201-premium-cotton-tote' },
];
const notice = '仅当前登记的两款Westford Mill官方公开商品，不是Amazon竞品/全市场检索';
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

function relevant(query) {
  const text = query.toLowerCase();
  if (/\b(?:nylon|polyester|leather|jute|backpacks?|shoes?|medical)\b|尼龙|涤纶|皮革|黄麻|背包|鞋|医疗/.test(text)) return false;
  return /\bw(?:101|201)\b/.test(text)
    || ((/\b(?:cotton|canvas)\b|棉/.test(text)) && /\b(?:totes?|bags?)\b|袋|包/.test(text));
}

async function readCurrentPage(entry, fetcher) {
  const started = Date.now();
  const metadata = { reference_id: entry.reference_id, url: entry.url, publisher: 'Westford Mill', http_status: null, provider_request_id: null };
  try {
    const response = await fetcher(entry.url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(25000), headers: { Accept: 'text/html' } });
    metadata.http_status = response.status;
    metadata.provider_request_id = response.headers.get('x-request-id') || response.headers.get('request-id') || null;
    if (!response.ok) throw new AppError('OFFICIAL_HTTP', `官方公开来源返回 HTTP ${response.status}，未生成替代正文。`, 502);
    if (response.url && response.url !== entry.url) throw new AppError('OFFICIAL_SOURCE_CHANGED', '官方来源地址发生变化，本次未采用页面正文。', 502);
    const contentType = response.headers.get('content-type') || '';
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new AppError('OFFICIAL_CONTENT_TYPE', '官方来源未返回HTML商品页。', 502);
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 5000000) { await reader.cancel(); throw new AppError('OFFICIAL_RESPONSE_SIZE', '官方页面超过读取大小限制。', 502); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const $ = load(Buffer.concat(chunks).toString('utf8'));
    const product = $('.node--product--full').first();
    const title = clean(product.find('h1').first().text()).slice(0, 1000);
    if (!title) throw new AppError('OFFICIAL_PAGE_SHAPE', '未在官方商品区域找到商品标题；页面可能已变更，未生成替代正文。', 502);
    // Restrict extraction to the real product feature block, excluding navigation/footer lists.
    const featureList = product.find('.container-product .content > ul').filter((_, list) => $(list).children('li').toArray().some(item => /\b100%\s+cotton\b/i.test($(item).text()))).first();
    const bullets = featureList.children('li').map((_, item) => clean($(item).text()).slice(0, 2000)).get().filter(Boolean).slice(0, 12);
    const specifications = product.find('table tr').map((_, row) => {
      const cells = $(row).children('th,td');
      if (cells.length < 2) return null;
      const name = clean(cells.first().text()).slice(0, 200);
      const value = clean(cells.slice(1).text()).slice(0, 2000);
      return name && value ? { name, value } : null;
    }).get().slice(0, 30);
    const missing = ['price', 'description', ...(!bullets.length ? ['bullets'] : []), ...(!specifications.length ? ['specifications'] : [])];
    return { item: { ...metadata, asin: null, title, bullets, specifications, description: '', brand: '',
      price: null, currency: '', rating: null, checked_at: new Date().toISOString(), elapsed_ms: Date.now() - started,
      detail_status: bullets.length && specifications.length ? 'available' : 'incomplete', missing_fields: missing,
      source_type: 'official_public_reference', warnings: ['官方公开商品资料；不是Amazon Listing、平台成交价格或商家的供货参数。'] } };
  } catch (error) {
    return { failure: { ...metadata, checked_at: new Date().toISOString(), elapsed_ms: Date.now() - started,
      code: error instanceof AppError ? error.code : 'OFFICIAL_NETWORK',
      message: error instanceof AppError ? error.message : '官方公开来源连接失败或超时；未采用缓存、快照或替代正文。' } };
  }
}

function referenceTerms(items) {
  const stop = new Set('the a an and or for with to of in on by from is are your you this that as at it pack can'.split(' '));
  const references = new Map();
  for (const item of items) {
    const text = [item.title, ...item.bullets].join('\n').toLowerCase();
    const words = [...text.matchAll(/[a-z]+/g)];
    const own = new Set();
    for (let i = 0; i < words.length; i++) {
      const word = words[i][0], next = words[i + 1];
      if (word.length < 3 || stop.has(word)) continue;
      own.add(word);
      // Preserve actual phrase adjacency; never join across removed words, values or fields.
      if (next && next[0].length >= 3 && !stop.has(next[0])
        && /^[^\S\r\n]+$/.test(text.slice(words[i].index + word.length, next.index))) own.add(`${word} ${next[0]}`);
    }
    for (const term of own) { const ids = references.get(term) || []; ids.push(item.reference_id); references.set(term, ids); }
  }
  return [...references].map(([term, reference_ids]) => ({ term, count: reference_ids.length, asins: [], reference_ids }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term)).slice(0, 60);
}

export async function searchOfficialReferences(query, fetcher = fetch) {
  const term = z.string().trim().min(2).max(250).parse(query);
  const results = relevant(term) ? await Promise.all(catalog.map(entry => readCurrentPage(entry, fetcher))) : [];
  const items = results.flatMap(result => result.item ? [result.item] : []);
  const failures = results.flatMap(result => result.failure ? [result.failure] : []);
  const incomplete = items.some(item => item.detail_status !== 'available');
  return { id: id('research'), provider: 'official-public', query: term, checked_at: new Date().toISOString(), notice,
    status: failures.length ? (items.length ? 'partial' : 'failed') : items.length ? (incomplete ? 'partial' : 'available') : 'empty',
    items, failures, terms: referenceTerms(items),
    warnings: [...(!items.length ? ['本次未取得当前登记范围内的可用官方公开参考。'] : []), ...(failures.length ? ['部分官方来源读取失败，原因已保留；未取得的资料保持未知。'] : []), ...(incomplete ? ['部分官方页面字段未取得，未生成替代内容。'] : [])] };
}
