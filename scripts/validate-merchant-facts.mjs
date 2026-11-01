// Deterministic regression on a saved real-product record. Does not replace live acceptance.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createStore } from "../server/store.mjs";
import { saveProductFacts } from "../server/product-facts.mjs";
import { editProfile } from "../server/domain.mjs";
import { groupReviewIssues } from "../src/reviewGroups.ts";
import { importAmazonSnapshot } from "../server/amazon.mjs";
const record = JSON.parse(
  fs.readFileSync(
    "reports/merchant-experience-2026-10-23/listing-v1.json",
    "utf8",
  ),
);
const product = structuredClone(record.product_snapshot);
product.revision = 1;
const store = createStore(":memory:");
store.saveProduct(product);
const fields = (p) => ({
  name_zh: p.name_zh,
  material: p.material.value || "",
  width: p.dimensions_cm.value?.width ?? null,
  height: p.dimensions_cm.value?.height ?? null,
  fabric_weight_gsm: p.fabric_weight_gsm.value,
  capacity_l: p.capacity_l.value,
  handle_length_cm: p.handle_length_cm.value,
  retail_pack_count: p.retail_pack_count.value,
  brand: p.brand.value || "",
  color: p.color.value || "",
});
const source = {
  url: "https://www.dalix.com/products/heavy-duty-cotton-canvas-tote-bag",
  publisher: "DALIX",
  applicable_model: "DALIX 22 inch zippered tote; color not verified",
  excerpt: "12. Oz, 100% Cotton Canvas",
};
let saved = saveProductFacts(store, product, {
  ...fields(product),
  fact_sources: { material: source },
  additional_facts: [
    {
      label: "Original dimensions",
      value: '22" X 16" X 6"',
      source: { ...source, excerpt: '22" X 16" X 6"' },
    },
  ],
});
assert.equal(saved.material.status, "merchant_confirmed");
assert.ok(saved.material.source_ids[0].startsWith("MERCHANT-FACT-"));
assert.equal(saved.additional_facts[0].value, '22" X 16" X 6"');
assert.equal(
  editProfile(saved, { ...fields(saved), material: "" }).fact_sources.material,
  undefined,
);
assert.equal(saved.dimensions_cm.value, null);
assert.equal(saved.capacity_l.value, null);
const sourcesBefore = store.sources().length;
assert.throws(
  () =>
    saveProductFacts(store, product, {
      ...fields(product),
      fact_sources: { material: source },
    }),
  (e) => e.code === "STALE_PRODUCT",
);
assert.equal(store.sources().length, sourcesBefore);
assert.throws(
  () =>
    saveProductFacts(store, saved, {
      ...fields(saved),
      fact_sources: { color: source },
    }),
  (e) => e.code === "SOURCE_WITHOUT_FACT",
);
assert.throws(() =>
  saveProductFacts(store, saved, {
    ...fields(saved),
    fact_sources: { material: { ...source, url: "javascript:alert(1)" } },
  }),
);
const same = saveProductFacts(store, saved, {
  ...fields(saved),
  additional_facts: saved.additional_facts.map((f) => ({
    id: f.id,
    label: f.label,
    value: f.value,
  })),
});
assert.deepEqual(same.additional_facts, saved.additional_facts);
saved = saveProductFacts(store, same, {
  ...fields(same),
  material: "",
  additional_facts: [
    {
      id: same.additional_facts[0].id,
      label: "Dimensions pending confirmation",
      value: "Unknown",
    },
  ],
});
assert.equal(saved.material.value, null);
assert.equal(saved.material.status, "unknown");
assert.equal(saved.fact_sources.material, undefined);
assert.equal(saved.additional_facts[0].source, undefined);
assert.deepEqual(saved.additional_facts[0].source_ids, [
  "LOCAL-MERCHANT-INPUT",
]);
const refreshed = importAmazonSnapshot(store, {
  ...product.amazon,
  facts: [],
  material: null,
  brand: product.brand.value,
  color: null,
  pack_count: null,
  fabric_weight_gsm: null,
  checked_at: new Date().toISOString(),
});
assert.deepEqual(refreshed.additional_facts, saved.additional_facts);
const repeated = importAmazonSnapshot(store, refreshed.amazon);
assert.equal(repeated.revision, refreshed.revision + 1);
assert.equal(groupReviewIssues(record).length, 1);
assert.equal(groupReviewIssues(record)[0].issues.length, 5);
const different = structuredClone(record);
different.review.evidence[0].unresolved_parameters[0].original = "16";
assert.equal(groupReviewIssues(different).length, 2);
store.close();
console.log(
  JSON.stringify({
    result: "passed",
    type: "deterministic_regression_not_live_acceptance",
    checks: [
      "partial_source_binding",
      "original_units",
      "stale_transaction_no_orphans",
      "unknown_fact_rejected",
      "unsafe_url_rejected",
      "unchanged_source_preserved",
      "changed_value_unlinked",
      "reimport_preserves_merchant_facts",
      "real_v1_five_findings_one_group",
      "distinct_values_not_merged",
    ],
  }),
);
