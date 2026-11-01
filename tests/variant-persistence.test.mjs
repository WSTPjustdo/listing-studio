import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { variantForAdoption } from '../server/variants.mjs';

test('saved A/B sets survive database reopen and remain isolated by listing version', () => {
  const directory = mkdtempSync(join(tmpdir(), 'listing-studio-variants-'));
  const filename = join(directory, 'test.sqlite');
  let store = createStore(filename);
  try {
    const set = {
      variant_set_id: 'variant-set-a',
      listing_id: 'listing-a',
      base_version: 2,
      generated_at: '2026-10-31T00:00:00.000Z',
      variants: [
        { angle: 'spec_first', content: { title: 'Spec title' } },
        { angle: 'scenario_first', content: { title: 'Scenario title' } },
        { angle: 'concise', content: { title: 'Concise title' } },
      ],
    };
    store.saveVariantSet(set);
    store.close();
    store = createStore(filename);

    assert.deepEqual(store.latestVariantSet('listing-a', 2), set);
    assert.equal(store.latestVariantSet('listing-a', 1), null);
    assert.deepEqual(variantForAdoption(store, {
      listingId: 'listing-a', baseVersion: 2, variantSetId: 'variant-set-a', angle: 'scenario_first',
    }).variant, set.variants[1]);
    assert.throws(() => variantForAdoption(store, {
      listingId: 'listing-b', baseVersion: 2, variantSetId: 'variant-set-a', angle: 'scenario_first',
    }), { code: 'VARIANT_SET_NOT_FOUND' });
    assert.throws(() => variantForAdoption(store, {
      listingId: 'listing-a', baseVersion: 1, variantSetId: 'variant-set-a', angle: 'scenario_first',
    }), { code: 'VARIANT_SET_NOT_FOUND' });
    assert.throws(() => variantForAdoption(store, {
      listingId: 'listing-a', baseVersion: 2, variantSetId: 'variant-set-a', angle: 'unknown',
    }), { code: 'VARIANT_ANGLE_NOT_FOUND' });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
