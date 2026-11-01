// Engineering protocol checks only. Archived public product facts are reused;
// controlled responses here are never counted as real model acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createStore, rulePackFor, SITE_LANGUAGES } from '../server/store.mjs';
import { contentSchema, reviewContent } from '../server/domain.mjs';
import { prepareGuidedPlan } from '../server/guided.mjs';
import { createService } from '../server/service.mjs';
import { checkParty } from '../server/gpsr-parties.mjs';
import { listingRunInputSchema } from '../server/listing-input.mjs';
import { sourcesForRun } from '../server/run-sources.mjs';

const archived = JSON.parse(fs.readFileSync(new URL('../reports/secondary-processing-2026-10-30/final-reference-record.json', import.meta.url), 'utf8'));
const config = { provider: 'compatible', base_url: 'http://127.0.0.1:9999/v1', model: 'engineering-protocol-only', api_key: 'not-a-real-api-key', timeout_ms: 5000 };

test('advanced create and diagnose accept the ten configured market-language pairs and reject unsupported pairs', () => {
  const diagnose = listingRunInputSchema.safeExtend({ content: contentSchema });
  assert.equal(listingRunInputSchema.parse({}).marketplace, 'US');
  assert.equal(listingRunInputSchema.parse({}).language, 'en');
  for (const [marketplace, choices] of Object.entries(SITE_LANGUAGES))
    for (const { language } of choices) {
      assert.equal(listingRunInputSchema.safeParse({ marketplace, language }).success, true, `${marketplace}/${language}`);
      assert.equal(diagnose.safeParse({ marketplace, language, content: archived.content }).success, true);
    }
  for (const [marketplace, language] of [['US', 'fr'], ['UK', 'de'], ['DE', 'fr'], ['FR', 'zh'], ['FR', 'es'], ['JP', 'en']]) {
    assert.equal(listingRunInputSchema.safeParse({ marketplace, language }).success, false);
    assert.equal(diagnose.safeParse({ marketplace, language, content: archived.content }).success, false);
  }
});

test('each request uses all current pack sources plus its product sources, without unrelated market sources', () => {
  const store = createStore(':memory:');
  try {
    for (const marketplace of Object.keys(SITE_LANGUAGES)) {
      const pack = rulePackFor(marketplace);
      const sources = sourcesForRun(pack, store.sources(), archived.product_snapshot);
      const ids = new Set(sources.map(source => source.source_id));
      for (const source of pack.sources) assert.ok(ids.has(source.source_id), `${marketplace}: ${source.source_id}`);
      for (const foreign of rulePackFor('US').sources)
        if (!pack.sources.some(source => source.source_id === foreign.source_id) && marketplace !== 'US')
          assert.ok(!ids.has(foreign.source_id), `${marketplace} included unrelated US source ${foreign.source_id}`);
      assert.equal(ids.size, sources.length);
    }
    const pack = rulePackFor('FR');
    const original = structuredClone(pack.sources);
    const duplicate = { ...pack.sources[0], publisher: 'Old stored text must not replace the current pack' };
    const scoped = sourcesForRun(pack, [duplicate]);
    assert.deepEqual(scoped, pack.sources);
    scoped[0].publisher = 'Mutated new request';
    assert.deepEqual(pack.sources, original, 'request mutation must not alter pack or old snapshots');
    assert.equal(duplicate.publisher, 'Old stored text must not replace the current pack');
  } finally { store.close(); }
});

test('guided plans receive the selected market original sources before inference', () => {
  const store = createStore(':memory:');
  store.saveProduct({ ...structuredClone(archived.product_snapshot), revision: 1 });
  try {
    for (const [marketplace, language] of [['DE', 'de'], ['UK', 'en'], ['FR', 'fr']]) {
      const prepared = prepareGuidedPlan(store, { mode: 'automatic', product_id: archived.product_snapshot.product_id, product_revision: 1, marketplace, language, scope_confirmed: true });
      for (const source of rulePackFor(marketplace).sources)
        assert.ok(prepared.sources.some(item => item.source_id === source.source_id), source.source_id);
    }
  } finally { store.close(); }
});

test('service rejects invalid market-language pairs before creating runs, then snapshots complete scoped sources', async () => {
  const store = createStore(':memory:');
  store.saveSettings(config);
  const product = structuredClone(archived.product_snapshot);
  const actualFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(JSON.parse(options.body).messages[1].content);
    requests.push(request);
    return new Response(JSON.stringify({ id: `engineering-only-${requests.length}`, model: config.model,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...(request.operation === 'create' ? { content: archived.content } : {}), review: { issues: [], checks: [] }, claim_map: [], patches: [] }) } }] }));
  };
  try {
    const service = createService(store);
    assert.throws(() => service.enqueue({ operation: 'create', product, marketplace: 'FR', language: 'zh' }), { code: 'LANGUAGE_MARKETPLACE_MISMATCH' });
    assert.equal(store.runs().length, 0);
    assert.equal(requests.length, 0);
    for (const [marketplace, language] of [['DE', 'de'], ['UK', 'en'], ['FR', 'fr']]) {
      const run = service.enqueue({ operation: 'create', product, marketplace, language });
      let record;
      for (let attempt = 0; attempt < 200; attempt++) {
        const current = store.run(run.run_id);
        if (current.status === 'failed') throw new Error(JSON.stringify(current.error));
        if (current.status === 'succeeded') { record = store.latest(run.listing_id); break; }
        await delay(10);
      }
      assert.ok(record, 'controlled protocol dispatch timed out');
      assert.equal(record.marketplace, marketplace);
      for (const source of rulePackFor(marketplace).sources) {
        assert.ok(record.source_snapshot.some(item => item.source_id === source.source_id));
        for (const request of requests.filter(item => item.marketplace === marketplace))
          assert.ok(request.sources.some(item => item.source_id === source.source_id));
      }
    }
    assert.deepEqual(requests.map(request => request.operation), ['create', 'diagnose', 'create', 'diagnose', 'create', 'diagnose']);
  } finally { globalThis.fetch = actualFetch; store.close(); }
});

test('GPSR postal shape applies the known five-digit rule to Germany only', () => {
  const party = { name: 'Protocol name', street: 'Protocol street 1', postal_code: '1010', city: 'Protocol city', country: 'AT', electronic_address: 'protocol@example.com' };
  assert.deepEqual(checkParty(party).missing, []);
  for (const [country, postal_code] of [['BE', '1000'], ['NL', '1012 AB'], ['PL', '00-001'], ['IE', 'D02 X285']])
    assert.deepEqual(checkParty({ ...party, country, postal_code }).missing, [], country);
  for (const country of ['DE', 'de', 'Germany', 'Deutschland', '德国']) {
    assert.ok(checkParty({ ...party, country }).missing.some(item => item.field === 'postal_code'));
    assert.deepEqual(checkParty({ ...party, country, postal_code: '10115' }).missing, []);
  }
  assert.ok(checkParty({ ...party, postal_code: '' }).missing.some(item => item.field === 'postal_code'));
  assert.ok(checkParty({ ...party, postal_code: 'letters' }).missing.some(item => item.field === 'postal_code'));
});

test('UK/FR keep parameter findings under explicit project checks rather than crashing or implying law coverage', () => {
  for (const marketplace of ['UK', 'FR']) {
    const pack = rulePackFor(marketplace);
    assert.match(pack.rule_pack_version, /project-integrity-v1$/);
    const content = { ...structuredClone(archived.content), item_highlights: 'Fabric weight: 200gsm.' };
    const review = reviewContent({ content, profile: archived.product_snapshot, rulePack: pack, marketplace });
    const conflict = review.issues.find(issue => issue.rule_id === 'AMZ-05' && issue.original.includes('200'));
    assert.ok(conflict, 'confirmed 140gsm must not allow a 200gsm claim');
    assert.deepEqual(conflict.source_ids, ['PROJECT-AMAZON-QUALITY']);
    assert.equal(pack.sources.find(source => source.source_id === conflict.source_ids[0]).kind, 'project_check');
    const notImplemented = pack.rules.filter(rule => rule.rule_id.startsWith(`${marketplace}-`) && !/TITLE/.test(rule.rule_id));
    for (const rule of notImplemented)
      assert.notEqual(review.checks.find(check => check.rule_id === rule.rule_id)?.state, 'pass', rule.rule_id);
    assert.ok(review.issues.every(issue => pack.rules.some(rule => rule.rule_id === issue.rule_id)));
  }
});

test('an incomplete custom pack fails explicitly instead of throwing TypeError or discarding a finding', () => {
  const complete = rulePackFor('UK');
  const pack = { ...complete, rules: complete.rules.filter(rule => !rule.source_ids.every(sourceId => sourceId === 'PROJECT-AMAZON-QUALITY')) };
  const content = { ...structuredClone(archived.content), item_highlights: 'Fabric weight: 200gsm.' };
  assert.throws(() => reviewContent({ content, profile: archived.product_snapshot, rulePack: pack, marketplace: 'UK' }), { code: 'RULE_PACK_INCOMPLETE' });
});
