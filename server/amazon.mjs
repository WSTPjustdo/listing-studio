import { load } from "cheerio";
import { createHash, randomInt } from "node:crypto";
import { AppError } from "./domain.mjs";

export function amazonIdentity(input) {
  const text = String(input || "").trim();
  if (/^[A-Z0-9]{10}$/i.test(text)) return { asin: text.toUpperCase(), url: `https://www.amazon.com/dp/${text.toUpperCase()}` };
  let url;
  try { url = new URL(text); } catch { throw new AppError("INVALID_AMAZON_URL", "请输入 Amazon 美国站商品链接或 10 位 ASIN。"); }
  if (url.protocol !== "https:" || !["amazon.com", "www.amazon.com"].includes(url.hostname) || url.port || url.username || url.password)
    throw new AppError("INVALID_AMAZON_URL", "当前仅接受 https://www.amazon.com 的商品详情链接。");
  const asin = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i.exec(url.pathname)?.[1]?.toUpperCase();
  if (!asin) throw new AppError("INVALID_AMAZON_URL", "链接中没有有效的商品 ASIN，请使用商品详情页链接。");
  return { asin, url: `https://www.amazon.com/dp/${asin}` };
}

const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
// Prefer an explicitly selected count; ambiguous options remain unknown.
export function extractPackCount(title, evidence = '') {
  const text = String(title || '');
  const valid = value => Number.isInteger(value) && value > 0 && value <= 10000;
  const explicit = [...new Set([...text.matchAll(/\b(?:pack|set)\s+of\s+(\d{1,5})\b/gi)].map(hit => Number(hit[1])))];
  if (explicit.length > 1 || explicit.some(value => !valid(value))) return null;
  if (explicit.length === 1) return explicit[0];
  if (/\b\d+(?:\s*[\/|]\s*\d+)+\s*-?\s*(?:packs?|pcs|pieces?|sets?)\b/i.test(text)) return null;
  const counts = [...new Set([...text.matchAll(/\b(\d{1,5})\s*[- ]?\s*(?:packs?|pcs|pieces?|sets?)\b/gi)].map(hit => Number(hit[1])))];
  if (counts.length > 1 || counts.some(value => !valid(value))) return null;
  if (counts.length === 1) return counts[0];
  const detailCounts = [...new Set([...String(evidence).matchAll(/\b(\d{1,5})\s*(?:bags?|pieces?)\s+per\s+pack\b/gi)].map(hit => Number(hit[1])))];
  return detailCounts.length === 1 && valid(detailCounts[0]) ? detailCounts[0] : null;
}
export function parseAmazonPage(html, input, checkedAt = new Date().toISOString()) {
  const identity = amazonIdentity(input);
  const $ = load(html);
  $("script,style,noscript,iframe").remove();
  const title = clean($("#productTitle").first().text());
  if (!title) throw new AppError("AMAZON_ACCESS_LIMITED", "Amazon 未返回可读取的商品资料，可能需要访问验证。请在浏览器打开原页，或使用已保存快照；不会绕过验证。", 502);
  const pageAsin = $("input#ASIN").attr("value") || $("input#asin").attr("value");
  if (pageAsin && pageAsin.toUpperCase() !== identity.asin) throw new AppError("AMAZON_VARIANT_MISMATCH", "页面返回了其他 ASIN，未导入，以免混用变体资料。", 502);
  const bullets = [...$("#feature-bullets li .a-list-item, #productFactsDesktop_feature_div #topHighlight li .a-list-item")].map((el) => clean($(el).text())).filter((text) => text && !/See more product details/i.test(text)).slice(0,12);
  const details = [];
  $("#productOverview_feature_div tr, #productDetails_detailBullets_sections1 tr, #productDetails_techSpec_section_1 tr, #productFactsDesktop_feature_div .product-facts-detail").each((_, el) => {
    const row = $(el);
    const label = clean(row.find("th,td:first-child,.a-col-left").first().text());
    const value = clean(row.find("td:last-child,.a-col-right").last().text());
    if (label && value && label.length < 100 && value.length < 600) details.push({ label, value });
  });
  const field = (pattern) => details.find((item) => pattern.test(item.label))?.value || null;
  const byline = clean($("#bylineInfo").text());
  const brand = field(/^brand$/i) || /^Brand:\s*(.+)$/i.exec(byline)?.[1] || /^Visit the (.+) Store$/i.exec(byline)?.[1] || null;
  const color = clean($("#variation_color_name .selection").first().text()) || field(/^colou?r$/i);
  const evidence = [title, ...bullets, ...details.map((item) => `${item.label}: ${item.value}`)].join("\n");
  if (!/\btote\b/i.test(title) || !/\bcotton\b/i.test(evidence)) throw new AppError("AMAZON_CATEGORY_UNSUPPORTED", "当前只对棉布手提袋提供规则审核，请选择该类目商品。", 422);
  const composition = field(/^(fabric type|material composition)$/i);
  const materials = [...new Set([...evidence.matchAll(/\b\d+(?:\.\d+)?\s*%\s*(?:natural\s+)?cotton\b/gi)].map((match) => clean(match[0]).toLowerCase()))];
  const material = materials.length > 1 ? null : composition || materials[0] || field(/^material$/i) || null;
  const pack = extractPackCount(title, evidence);
  const gsm = /\b(\d+(?:\.\d+)?)\s*(?:g\s*\/\s*m[²2]|gsm)\b/i.exec(evidence)?.[1];
  const availabilityText = clean($("#availability").text()).slice(0,350);
  const unavailable = /currently unavailable|out of stock/i.test(availabilityText) || $("#outOfStock").length > 0;
  const cart = $("#add-to-cart-button:not([disabled])").length > 0;
  const stock = /\bin stock\b|\bleft in stock\b/i.test(availabilityText);
  const offer = $("#buybox-see-all-buying-choices, #aod-ingress-link, #buybox input[name=offerListingID], #desktop_buybox input[name=offerListingID]").length > 0;
  const availability = unavailable ? "unavailable" : stock && cart ? "in_stock_observed" : cart || offer ? "offer_observed" : "unknown";
  const facts = details.filter((item) => /fabric|material|dimensions|size|closure|care|color/i.test(item.label)).slice(0,12);
  for (const line of bullets) {
    // Keep measurement/care facts only. Marketing claims remain outside the fact set.
    const dimension = /\bDimensions?:\s*([\d.]+\s*[x×]\s*[\d.]+(?:\s*[x×]\s*[\d.]+)?\s*(?:inches|inch|cm))/i.exec(line)?.[1];
    if (dimension) facts.push({ label: "Dimensions (axis order not confirmed)", value: dimension });
    if (/^hand wash with cold water\.?$/i.test(line)) facts.push({ label: "Care", value: "Hand wash with cold water" });
  }
  if (materials.length > 1) facts.push({ label: "Material conflict", value: "页面出现多个不同棉含量，须商家核对；不得选取其中一个作为确认事实。" });
  return { ...identity, title, brand, color, material, pack_count: pack, fabric_weight_gsm: gsm ? Number(gsm) : null, facts, availability, availability_text: availabilityText || "页面未提供明确库存状态", checked_at: checkedAt, retrieval: "direct_http", freshness: "实时读取时的页面观察；库存随地址和时间变化" };
}

export async function fetchAmazon(input, fetcher = fetch) {
  const identity = amazonIdentity(input);
  let response;
  try {
    response = await fetcher(identity.url, { redirect: "error", signal: AbortSignal.timeout(15000), headers: { Accept: "text/html", "User-Agent": "ListingStudio/0.1 public-product-preview" } });
  } catch { throw new AppError("AMAZON_FETCH_FAILED", "无法读取 Amazon 页面。网络或重定向受限，请稍后重试或使用明确标注的来源快照。", 502); }
  if (!response.ok) throw new AppError("AMAZON_ACCESS_LIMITED", `Amazon 返回 HTTP ${response.status}，本次没有导入商品或生成内容。`, 502);
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 4_000_000) { await reader.cancel(); throw new AppError("AMAZON_PAGE_TOO_LARGE", "商品页面过大，本次读取已停止。", 502); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return parseAmazonPage(Buffer.concat(chunks).toString("utf8"), identity.asin);
}

export function importAmazonSnapshot(store, snapshot, mode = "live") {
  const { asin, url } = amazonIdentity(snapshot.asin);
  const productId = `AMAZON-US-${asin}`;
  const previous = store.product(productId);
  const sourceId = `AMZ-PAGE-${asin}-${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0,12)}`;
  const fact = (value) => ({ value: value ?? null, status: value == null ? "unknown" : "amazon_listing_claim", source_ids: value == null ? [] : [sourceId] });
  const source = { source_id: sourceId, kind: "amazon_product_page", publisher: "Amazon.com 商品详情页（卖家披露）", url, checked_at: snapshot.checked_at, description: snapshot.title, note: `${snapshot.freshness}；页面披露不等同于独立检测证明。`, snapshot };
  const product = {
    product_id: productId, revision: (previous?.revision || 0) + 1, name_zh: `${snapshot.brand || "Amazon"} · ${snapshot.title}`.slice(0,120), is_demo: false, reference_product_id: asin, application_product_type: "tote_bag_demo",
    material: fact(snapshot.material), dimensions_cm: fact(null), fabric_weight_gsm: fact(snapshot.fabric_weight_gsm), capacity_l: fact(null), handle_length_cm: fact(null), retail_pack_count: fact(snapshot.pack_count), brand: fact(snapshot.brand), color: fact(snapshot.color), rated_load_kg: fact(null),
    additional_facts: snapshot.facts.map((entry) => ({ label: entry.label, ...fact(entry.value) })),
    amazon: { ...snapshot, url, import_mode: mode, source_ids: [sourceId] },
    degradation_evidence: [], certification_evidence: [], performance_evidence: [], publication_readiness: "not_verified",
  };
  // Refresh public observations without erasing facts already checked by the merchant.
  if(previous){
    for(const key of ['material','dimensions_cm','fabric_weight_gsm','capacity_l','handle_length_cm','retail_pack_count','brand','color','rated_load_kg'])
      if(previous[key]?.status==='merchant_confirmed')product[key]=structuredClone(previous[key]);
    product.fact_sources=structuredClone(previous.fact_sources||{});
    const confirmed=(previous.additional_facts||[]).filter(f=>f.status==='merchant_confirmed');
    product.additional_facts=[...product.additional_facts.filter(f=>!confirmed.some(c=>c.label===f.label&&c.value===f.value)),...structuredClone(confirmed)];
    for(const key of ['sku','evidence_submissions','degradation_evidence','certification_evidence','performance_evidence'])
      if(previous[key]!==undefined)product[key]=structuredClone(previous[key]);
  }
  store.saveProductWithSources(product,[source]);
  return product;
}

export function pickSamples(items, count = 3) {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) { const j = randomInt(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, Math.min(count, pool.length));
}
