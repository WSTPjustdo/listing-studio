import test from 'node:test';
import assert from 'node:assert/strict';
import { searchOfficialReferences } from '../server/official-references.mjs';

// Engineering tests only: HTML excerpts reproduce the real official W101/W201
// product structure. Live source validation is recorded separately, never replaced by these responses.
const page = (weight = 140) => `<html><body><nav><ul><li>Unrelated navigation</li></ul></nav><div class="node--product--full"><h1>${weight === 140 ? 'Bag for Life - Long Handles' : 'Premium Cotton Tote'}</h1><div class="container-product"><div class="content"><ul><li>100% Cotton - ${weight}gsm</li><li>Can be carried by hand or over the shoulder</li><li>CutAway label for ease of rebranding</li></ul></div></div><table><tr><th>Dimensions ( cm ) - width x height x depth</th><td><p>38 x 42</p></td></tr><tr><th>Capacity ( litres )</th><td>10</td></tr></table></div><footer><ul><li>Unrelated footer</li></ul></footer></body></html>`;

test('only registered official URLs are read and extracted data never gets an invented ASIN', async () => {
  const calls = [];
  const result = await searchOfficialReferences('cotton tote bag', async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    return new Response(page(url.includes('w201') ? 200 : 140), { headers: { 'content-type': 'text/html' } });
  });
  assert.deepEqual(calls, ['https://westfordmill.com/products/w101', 'https://westfordmill.com/products/w201-premium-cotton-tote']);
  assert.equal(result.provider, 'official-public');
  assert.equal(result.status, 'available');
  assert.equal(result.items.length, 2);
  assert.match(result.notice, /不是Amazon/);
  for (const item of result.items) {
    assert.equal(item.asin, null);
    assert.equal(item.price, null);
    assert.equal(item.publisher, 'Westford Mill');
    assert.equal(item.source_type, 'official_public_reference');
    assert.equal(item.bullets.length, 3);
    assert.ok(!item.bullets.some(value => value.includes('Unrelated')));
    assert.equal(item.specifications[0].value, '38 x 42');
    assert.ok(item.checked_at);
  }
  const cotton = result.terms.find(item => item.term === 'cotton');
  assert.equal(cotton.count, 2);
  assert.deepEqual(cotton.asins, []);
  assert.deepEqual(cotton.reference_ids, ['official-wm-w101', 'official-wm-w201']);
  assert.ok(!result.terms.some(item => ['cotton gsm', 'carried hand', 'shoulder cutaway'].includes(item.term)), 'phrases cannot bridge values, short words or separate features');
});

test('unrelated queries return empty without fetching pages or substituting registered products', async () => {
  for (const query of ['leather handbag', 'medical cotton pads', 'electric kettle', 'nylon tote bag']) {
    const result = await searchOfficialReferences(query, async () => { throw new Error('must not fetch'); });
    assert.equal(result.status, 'empty');
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.failures, []);
  }
});

test('each lookup reads again and HTTP failures preserve provenance without invented page content', async () => {
  let calls = 0;
  const fetcher = async url => {
    calls++;
    return url.includes('w201') ? new Response('', { status: 503 }) : new Response(page(), { headers: { 'content-type': 'text/html' } });
  };
  for (let i = 0; i < 2; i++) {
    const result = await searchOfficialReferences('棉布手提袋', fetcher);
    assert.equal(result.status, 'partial');
    assert.equal(result.items.length, 1);
    assert.equal(result.failures[0].http_status, 503);
    assert.equal(result.failures[0].code, 'OFFICIAL_HTTP');
    assert.equal(result.failures[0].reference_id, 'official-wm-w201');
    assert.equal('title' in result.failures[0], false);
  }
  assert.equal(calls, 4, 'no cached source is reused');
});

test('layout and network failures stay explicit and do not manufacture features', async () => {
  const result = await searchOfficialReferences('cotton tote bag', async url => {
    if (url.includes('w201')) throw new Error('untrusted network details');
    return new Response('<h1>Access denied</h1><ul><li>100% Cotton - 140gsm</li></ul>', { headers: { 'content-type': 'text/html' } });
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.terms, []);
  assert.deepEqual(result.failures.map(item => item.code), ['OFFICIAL_PAGE_SHAPE', 'OFFICIAL_NETWORK']);
  assert.equal(JSON.stringify(result).includes('untrusted network details'), false);
});
