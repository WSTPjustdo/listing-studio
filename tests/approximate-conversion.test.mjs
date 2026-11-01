import test from "node:test";
import assert from "node:assert/strict";
import { inspectEvidence, evidenceText } from "../server/evidence.mjs";
import { reviewContent, proposeLocalRepairs, applyPatches } from "../server/domain.mjs";
import { rulePack, scenarios } from "../server/store.mjs";

// 这一组保护的是"按约数精度比对"的门禁。放宽一条规则很容易顺手放宽一片，
// 所以正例、反例、以及"同单位不许沾光"三条都要有。
const product = scenarios.product_profiles[0]; // 38 x 42 cm, 67 cm handles, 140 gsm, 10 L
const content = (description) => ({
  title: "Cotton Tote Bag",
  item_highlights: "100% cotton.",
  bullet_points: [],
  description,
});
const dims = (description) =>
  inspectEvidence(content(description), product)
    .flatMap((entry) => entry.parameter_links.concat(entry.unresolved_parameters))
    .filter((x) => x.field === "dimensions_cm");
// 一句话里可以有两串尺寸（cm 和 in 各一串），要挑的是那串英寸的。
const inches = (description) => dims(description).find((x) => /in(ch|ches|\b)/i.test(x.original));

// Controlled boundary strings below are engineering probes, never real model acceptance.
test("each converted axis keeps its own precision instead of borrowing the widest tolerance", () => {
  const matching = inches("Dimensions: approximately 15.0 x 16.54 inches.");
  assert.equal(matching.status, "matched");
  assert.deepEqual(matching.approximation.axis_tolerances_cm, { width: 0.127, height: 0.0127 });
  assert.match(evidenceText({ claim: "x", parameter_links: [matching] }), /宽±0\.127 cm、高±0\.0127 cm/);
  // 16.55 in = 42.037 cm; the height's own 0.0127 cm tolerance cannot cover 0.037 cm.
  const mismatching = inches("Dimensions: approximately 15.0 x 16.55 inches.");
  assert.equal(mismatching.status, "conflict");
  assert.equal(mismatching.approximation, undefined);
});

test("named axes carry their precision when their written order changes", () => {
  assert.equal(inches("Dimensions: approximately 16.54H x 15.0W inches.").status, "matched");
  assert.equal(inches("Dimensions: approximately 16.55H x 15.0W inches.").status, "conflict");
});

test("a same-unit axis stays exact beside a converted approximate axis", () => {
  assert.equal(inches("Dimensions: approximately 38.0 cm x 16.5 inches.").status, "matched");
  assert.equal(inches("Dimensions: approximately 38.01 cm x 16.5 inches.").status, "conflict");
});

test("the depth axis also uses its own precision after axis reordering", () => {
  const withDepth = structuredClone(product);
  withDepth.dimensions_cm.value.depth = 10;
  const find = description => inspectEvidence(content(description), withDepth)
    .flatMap(entry => [...entry.parameter_links, ...entry.unresolved_parameters])
    .find(link => link.field === "dimensions_cm");
  const matched = find("Dimensions: approximately 3.94D x 16.54H x 15.0W inches.");
  assert.equal(matched.status, "matched");
  assert.equal(matched.approximation.axis_tolerances_cm.depth, 0.0127);
  assert.equal(find("Dimensions: approximately 3.95D x 16.54H x 15.0W inches.").status, "conflict");
});

test("a self-declared approximate unit conversion matches within its own stated precision", () => {
  // 38 x 42 cm = 14.96 x 16.54 in；原文写 approximately 15.0 x 16.5，差 0.04 in 是四舍五入。
  const link = inches("Dimensions: 38 x 42 cm, approximately 15.0 x 16.5 inches.");
  assert.ok(link, "这句里的英寸换算应当被认出来");
  assert.equal(link.status, "matched");
  assert.ok(link.approximation, "按精度比对过就必须留下痕迹，不能和精确对上长得一样");
  assert.ok(link.approximation.tolerance_cm > 0.1 && link.approximation.tolerance_cm < 0.2);
  assert.match(evidenceText({ claim: "x", parameter_links: [link] }), /按原文标注的最后一位精度比对/);
});

test("without the approximate marker a converted restatement still has to be exact", () => {
  // 同一句话去掉 approximately：仍是换算，但原文没自标约数，不做精度推定。
  const link = inches("Dimensions: 38 x 42 cm, 15.0 x 16.5 inches.");
  assert.equal(link.status, "conflict");
  assert.equal(link.approximation, undefined);
});

test("the tolerance never covers a real mismatch, only rounding at the stated precision", () => {
  // 写成 approximately 也不许把 20 x 25 in（50.8 x 63.5 cm）算成 38 x 42 cm。
  const link = inches("Dimensions: 38 x 42 cm, approximately 20.0 x 25.0 inches.");
  assert.equal(link.status, "conflict");
});

test("the tolerance is only for unit conversion; same-unit numbers stay exact", () => {
  // 同是 cm，写 38.2 就是不一致——"approximately"不能给同单位数值发免死金牌。
  const [link] = dims("Dimensions: approximately 38.2 x 42 cm.");
  assert.equal(link.status, "conflict");
});

test("an approximate conversion is reported as matched, not as a blocking AMZ-05 conflict", () => {
  const review = reviewContent({
    content: content("Dimensions: 38 x 42 cm, approximately 15.0 x 16.5 inches."),
    profile: product,
    rulePack,
  });
  assert.deepEqual(
    review.issues.filter((x) => x.rule_id === "AMZ-05").map((x) => x.reason),
    [],
  );
});

test("the automatic repair no longer writes copy that its own rule then blocks", () => {
  // 以前 proposeLocalRepairs 会把尺寸改写成"38 × 42 cm (approximately 15.0 × 16.5 in)"，
  // 那句话随后被 AMZ-05 判阻断——自己修出来的东西自己判死。
  const risky = structuredClone(
    scenarios.listing_fixtures.find((x) => x.fixture_id === "AMZ-RISKY-001").content,
  );
  const repaired = applyPatches(
    risky,
    proposeLocalRepairs(risky, product, reviewContent({ content: risky, profile: product, rulePack })),
    1,
    1,
  );
  assert.deepEqual(reviewContent({ content: repaired, profile: product, rulePack }).issues, []);
});
