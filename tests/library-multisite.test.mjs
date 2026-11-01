import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore, rulePackFor } from '../server/store.mjs';
import { amazonProductUrl, libraryRows } from '../server/library.mjs';

const archived = JSON.parse(fs.readFileSync(new URL('../reports/secondary-processing-2026-10-30/final-reference-record.json', import.meta.url), 'utf8'));

test('library revisions are isolated by product and marketplace', () => {
  const store = createStore(':memory:');
  try {
    const productId = archived.product_snapshot.product_id;
    for (const [marketplace, sku] of [['US', ''], ['DE', ''], ['UK', '']]) {
      store.saveLibraryEntry({ product_id: productId, marketplace, revision: 1, sku, state: 'draft', asin: '', published_on: '', notes: '', status_source: 'merchant_manual', updated_at: null });
    }
    assert.equal(store.libraryEntry(productId, 'US').marketplace, 'US');
    assert.equal(store.libraryEntry(productId, 'DE').marketplace, 'DE');
    assert.equal(store.libraryEntry(productId, 'UK').marketplace, 'UK');
    assert.equal(store.libraryEntry(productId).marketplace, 'US');
    assert.equal(store.libraryEntries().filter(entry => entry.product_id === productId).length, 3);
    store.saveLibraryEntry({ product_id: productId, marketplace: 'DE', revision: 2, sku: '', state: 'ready', asin: '', published_on: '', notes: '', status_source: 'merchant_manual', updated_at: null });
    assert.equal(store.libraryEntry(productId, 'DE').revision, 2);
    assert.equal(store.libraryEntry(productId, 'US').revision, 1);
    assert.equal(store.libraryEntry(productId, 'UK').revision, 1);
  } finally {
    store.close();
  }
});

test('legacy registrations migrate to their fixed listing market and keep their revision', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-library-migration-'));
  const filename = path.join(directory, 'legacy.sqlite');
  const db = new DatabaseSync(filename);
  const record = structuredClone(archived);
  record.marketplace = 'US';
  db.exec('CREATE TABLE listings (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE versions (listing_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(listing_id,version)); CREATE TABLE library_entries (product_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(product_id,revision));');
  db.prepare('INSERT INTO listings VALUES (?,?,?)').run(record.listing_id, record.workflow, record.created_at);
  db.prepare('INSERT INTO versions VALUES (?,?,?)').run(record.listing_id, record.version, JSON.stringify(record));
  const entry = { product_id: record.product_snapshot.product_id, revision: 4, listing_id: record.listing_id, listing_version: record.version, sku: '', state: 'draft', asin: '', published_on: '', notes: '', status_source: 'merchant_manual', updated_at: '2026-10-30T00:00:00.000Z' };
  db.prepare('INSERT INTO library_entries VALUES (?,?,?)').run(entry.product_id, entry.revision, JSON.stringify(entry));
  db.close();

  let store;
  try {
    store = createStore(filename);
    assert.deepEqual(store.libraryEntry(entry.product_id, 'US'), { ...entry, marketplace: 'US' });
    assert.equal(store.libraryEntry(entry.product_id, 'DE'), null);
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Amazon links follow the selected marketplace domain', () => {
  const asin = 'B00EXAMPLE';
  assert.equal(amazonProductUrl('US', asin), `https://www.amazon.com/dp/${asin}`);
  assert.equal(amazonProductUrl('DE', asin), `https://www.amazon.de/dp/${asin}`);
  assert.equal(amazonProductUrl('UK', asin), `https://www.amazon.co.uk/dp/${asin}`);
  assert.equal(amazonProductUrl('FR', asin), `https://www.amazon.fr/dp/${asin}`);
  assert.equal(amazonProductUrl('DE', ''), '');
});

test('a record reviewed against the current DE or UK rule pack is not marked stale', () => {
  const product = structuredClone(archived.product_snapshot);
  for (const marketplace of ['DE', 'UK']) {
    const record = { ...structuredClone(archived), marketplace,
      rule_pack_version: rulePackFor(marketplace).rule_pack_version,
      product_snapshot: product };
    const store = {
      products: () => [product],
      allLatestListings: () => [record],
      libraryEntries: () => [],
      libraryEntry: () => null,
      version: () => null,
    };
    const row = libraryRows(store).find(item => item.marketplace === marketplace);
    assert.equal(row.review_stale, false, `${marketplace} must compare against its own current rules`);
  }
});
