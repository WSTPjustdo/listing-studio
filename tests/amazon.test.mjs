import test from "node:test";
import assert from "node:assert/strict";
import { amazonIdentity, parseAmazonPage, fetchAmazon, importAmazonSnapshot, pickSamples } from "../server/amazon.mjs";
import { createStore } from "../server/store.mjs";
import { generateLocalDraft } from "../server/domain.mjs";

const asin = "B014XXJQ1I";
const html = `<span id="productTitle">Example Cotton Tote Bag 4-pack</span><input id="ASIN" value="${asin}"><a id="bylineInfo">Brand: Example</a><div id="availability">Only 3 left in stock</div><input id="add-to-cart-button"><div id="feature-bullets"><ul><li><span class="a-list-item">Made from 50% cotton.</span></li><li><span class="a-list-item">Dimensions: 17.5 x 16.5 x 5 inches</span></li><li><span class="a-list-item">7oz fabric</span></li></ul></div><aside>Recommended: 100% cotton, capacity 20 L, handles 70 cm</aside>`;

test("Amazon URL allowlist rejects alternate hosts, userinfo, ports and malformed ASINs", () => {
  assert.equal(amazonIdentity(`https://www.amazon.com/name/dp/${asin}?tag=untrusted`).url, `https://www.amazon.com/dp/${asin}`);
  for (const value of ["http://127.0.0.1/dp/B014XXJQ1I", "https://amazon.com.evil.test/dp/B014XXJQ1I", "https://user:secret@amazon.com/dp/B014XXJQ1I", "https://amazon.com:8443/dp/B014XXJQ1I", "https://amazon.com/dp/B014XXJQ1Iextra", "https://amazon.co.uk/dp/B014XXJQ1I"]) assert.throws(() => amazonIdentity(value), { code: "INVALID_AMAZON_URL" });
});

test("product extraction isolates selected-item facts and does not invent measurements", () => {
  const snapshot = parseAmazonPage(html, asin, "2026-10-21");
  assert.equal(snapshot.material, "50% cotton");
  assert.equal(snapshot.pack_count, 4);
  assert.equal(snapshot.fabric_weight_gsm, null);
  assert.equal(snapshot.availability, "in_stock_observed");
  assert.ok(snapshot.facts.some((fact) => fact.value === "17.5 x 16.5 x 5 inches"));
  const store = createStore(":memory:");
  try {
    const product = importAmazonSnapshot(store, snapshot);
    assert.equal(product.capacity_l.value, null);
    assert.equal(product.dimensions_cm.value, null);
    assert.equal(product.handle_length_cm.value, null);
    const draft = generateLocalDraft(product);
    assert.doesNotMatch(draft.title, /Long Handles/);
    assert.doesNotMatch(JSON.stringify(draft), /20 L|70 cm|100% cotton/);
  } finally { store.close(); }
});

test("verification gates, wrong variants and unrelated categories never become product imports", () => {
  assert.throws(() => parseAmazonPage("<h1>Continue shopping</h1>", asin), { code: "AMAZON_ACCESS_LIMITED" });
  assert.throws(() => parseAmazonPage(html.replace(`value="${asin}"`, 'value="B000000000"'), asin), { code: "AMAZON_VARIANT_MISMATCH" });
  assert.throws(() => parseAmazonPage(html.replace("Example Cotton Tote Bag 4-pack", "Kindle Paperwhite"), asin), { code: "AMAZON_CATEGORY_UNSUPPORTED" });
  assert.equal(parseAmazonPage(html.replace("Only 3 left in stock", "Currently unavailable. Back in stock later."), asin).availability, "unavailable");
  assert.equal(parseAmazonPage(html.replace("Only 3 left in stock", "").replace('<input id="add-to-cart-button">', ""), asin).availability, "unknown");
});

test("conflicting composition stays unknown and imported evidence is immutable across revisions", () => {
  const store = createStore(":memory:");
  try {
    const first = importAmazonSnapshot(store, parseAmazonPage(html, asin, "2026-10-20"), "snapshot");
    const second = importAmazonSnapshot(store, parseAmazonPage(html.replace("Made from 50% cotton.", "50% cotton; 100% cotton"), asin, "2026-10-21"));
    assert.equal(second.material.value, null);
    assert.equal(second.revision, 2);
    assert.equal(store.product(first.product_id, 1).material.value, "50% cotton");
    assert.notDeepEqual(first.amazon.source_ids, second.amazon.source_ids);
    assert.ok(store.sources().some((source) => source.source_id === first.amazon.source_ids[0] && source.checked_at === "2026-10-20"));
  } finally { store.close(); }
});

test("live reader uses a canonical URL, refuses failed requests and limits response size", async () => {
  const snapshot = await fetchAmazon(asin, async (url, options) => {
    assert.equal(url, `https://www.amazon.com/dp/${asin}`);
    assert.equal(options.redirect, "error");
    return new Response(html);
  });
  assert.equal(snapshot.retrieval, "direct_http");
  await assert.rejects(() => fetchAmazon(asin, async () => new Response("unavailable", { status: 503 })), { code: "AMAZON_ACCESS_LIMITED" });
  await assert.rejects(() => fetchAmazon(asin, async () => new Response("x".repeat(4_000_001))), { code: "AMAZON_PAGE_TOO_LARGE" });
  assert.equal(new Set(pickSamples([1,2,3,4,5], 3)).size, 3);
});
