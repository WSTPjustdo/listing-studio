import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPatches,
  characterCount,
  contentHash,
  editProfile,
  generateLocalDraft,
  localRevision,
  proposeLocalRepairs,
  reviewContent,
  uniquePatches,
} from "../server/domain.mjs";
import { createStore, rulePack, scenarios } from "../server/store.mjs";

const product = scenarios.product_profiles[0];

test("duplicate patches coalesce but conflicting replacements cannot silently overwrite each other", () => {
  const patch = { field_path: "content.title", expected_before: "Before", replacement: "After" };
  assert.deepEqual(uniquePatches([patch, { ...patch }]), [patch]);
  assert.throws(() => uniquePatches([patch, { ...patch, replacement: "Different" }]), error => error.code === "CONFLICTING_PATCHES");
  assert.throws(() => uniquePatches([patch, { ...patch, expected_before: "Stale" }]), error => error.code === "CONFLICTING_PATCHES");
});
const fixture = (id) =>
  structuredClone(
    scenarios.listing_fixtures.find((x) => x.fixture_id === id).content,
  );
const review = (content, options = {}) =>
  reviewContent({ content, profile: product, rulePack, ...options });

test("title and highlight limits include spaces and Unicode code points", () => {
  assert.equal(characterCount("袋 A👜"), 4);
  for (const [field, ruleId, max] of [
    ["title", "AMZ-01", 75],
    ["item_highlights", "AMZ-02", 125],
  ]) {
    const content = fixture("AMZ-CLEAN-001");
    content[field] = "A".repeat(max - 1) + " ";
    // Titles are trimmed by the input contract, so use an interior space.
    content[field] = "A".repeat(max - 2) + " A";
    assert.equal(
      review(content).issues.some((x) => x.rule_id === ruleId),
      false,
    );
    content[field] += "B";
    assert.equal(
      review(content).issues.some((x) => x.rule_id === ruleId),
      true,
    );
  }
});
test("risky listing identifies the designed independent problem categories", () => {
  const result = review(fixture("AMZ-RISKY-001"));
  const rules = new Set(result.issues.map((x) => x.rule_id));
  for (const id of [
    "AMZ-01",
    "AMZ-03",
    "AMZ-04",
    "US-01",
    "US-02",
    "US-03",
    "FACT-01",
    "FACT-02",
  ])
    assert.ok(rules.has(id), id);
  assert.ok(result.issues.some((x) => x.category === "platform_rules"));
  assert.ok(
    result.issues.some((x) => x.category === "target_country_claims_review"),
  );
});
test("clean content has no false keyword/quantity findings and retains incomplete semantics", () => {
  const result = review(fixture("AMZ-CLEAN-001"));
  assert.equal(result.issues.length, 0);
  assert.equal(result.status, "needs_attention");
  assert.ok(
    result.checks.some(
      (x) => x.rule_id === "US-01" && x.state === "not_checked",
    ),
  );
});
test("negated environmental claims and ordinary measurements are not flagged by keyword alone", () => {
  const content = fixture("AMZ-CLEAN-001");
  content.description =
    "No degradation test is provided, so we make no biodegradability claim. Dimensions: 38 x 42 cm. Handle length: 67 cm.";
  const result = review(content);
  assert.equal(
    result.issues.filter((x) =>
      ["US-01", "US-02", "AMZ-03", "AMZ-04"].includes(x.rule_id),
    ).length,
    0,
  );
  content.description = "Not only eco-friendly, but also convenient.";
  assert.ok(review(content).issues.some((x) => x.rule_id === "US-01"));
});
test("missing product does not fabricate fact-comparison success", () => {
  const result = review(fixture("AMZ-CLEAN-001"), { profile: null });
  assert.equal(
    result.checks.find((x) => x.rule_id === "FACT-02").state,
    "not_checked",
  );
  assert.equal(result.missing_data[0].field, "product");
});
test("unsupported markets never produce reviewed-within-scope status", () => {
  const result = review(fixture("AMZ-CLEAN-001"), { marketplace: "UK" });
  assert.equal(result.status, "needs_attention");
  assert.ok(result.issues.some((x) => x.rule_id === "SYS-02"));
  assert.equal(
    result.checks.find((x) => x.rule_id === "AMZ-01").state,
    "not_checked",
  );
});
test("fabric weights with squared-unit Unicode cannot drift", () => {
  const content = fixture("AMZ-CLEAN-001");
  content.item_highlights = "200 g/m² cotton fabric.";
  assert.ok(review(content).issues.some((x) => x.rule_id === "AMZ-05"));
});
test("two local revisions preserve the immutable product snapshot", () => {
  const original = JSON.stringify(product);
  const first = generateLocalDraft(product);
  const second = localRevision(first, "标题简洁一些", product).content;
  const third = localRevision(second, "描述突出日常通勤", product).content;
  assert.ok(characterCount(second.title) < characterCount(first.title));
  assert.match(third.description, /commuting/);
  assert.match(third.description, /38 × 42 cm/);
  assert.equal(JSON.stringify(product), original);
});
test("unsupported fact/certification requests preserve content and explain conflict", () => {
  const content = generateLocalDraft(product);
  for (const text of ["把面料改成 200 gsm", "加入有机认证"]) {
    const result = localRevision(content, text, product);
    assert.deepEqual(result.content, content);
    assert.ok(result.conflicts.length);
  }
});
test("patches reject stale versions, changed old text and paths outside content", () => {
  const content = fixture("AMZ-CLEAN-001");
  const patch = {
    field_path: "content.title",
    expected_before: content.title,
    replacement: "Cotton Tote Bag",
  };
  assert.throws(() => applyPatches(content, [patch], 1, 2), {
    code: "STALE_VERSION",
  });
  assert.throws(
    () => applyPatches(content, [{ ...patch, expected_before: "other" }], 1, 1),
    { code: "STALE_PATCH" },
  );
  assert.throws(
    () =>
      applyPatches(
        content,
        [{ ...patch, field_path: "product.material" }],
        1,
        1,
      ),
    { code: "INVALID_PATCH" },
  );
  assert.throws(() => applyPatches(content, [patch, patch], 1, 1), {
    code: "INVALID_PATCH",
  });
});
test("local field repair preserves unrelated supported content and removes target findings", () => {
  const content = fixture("AMZ-RISKY-001");
  const snapshot = contentHash(content);
  const result = review(content);
  const patches = proposeLocalRepairs(content, product, result);
  const updated = applyPatches(content, patches, 1, 1);
  assert.equal(
    updated.bullet_points.find((x) => x.id === "b4").text,
    content.bullet_points.find((x) => x.id === "b4").text,
  );
  assert.equal(contentHash(content), snapshot);
  assert.equal(review(updated).issues.length, 0);
});
test("invalid model citations or imaginary fields cannot be reported as passing", () => {
  const content = fixture("AMZ-CLEAN-001");
  const modelReview = {
    issues: [
      {
        rule_id: "US-01",
        field_path: "content.title",
        original: "Cotton",
        reason: "x",
        suggestion: "y",
        source_ids: ["MADE-UP"],
      },
    ],
    checks: [],
  };
  assert.ok(
    review(content, { modelReview, hasRealModel: true }).issues.some(
      (x) => x.rule_id === "SYS-01",
    ),
  );
  const badPath = {
    issues: [
      {
        ...modelReview.issues[0],
        source_ids: ["FTCS-GREEN-SUMMARY"],
        field_path: "product.secret",
      },
    ],
    checks: [],
  };
  assert.ok(
    review(content, { modelReview: badPath, hasRealModel: true }).issues.some(
      (x) => x.rule_id === "SYS-01",
    ),
  );
});
test("product updates create a new merchant-confirmed revision without rewriting source history", () => {
  const input = {
    name_zh: product.name_zh,
    material: product.material.value,
    width: 38,
    height: 42,
    fabric_weight_gsm: 200,
    capacity_l: 10,
    handle_length_cm: 67,
    retail_pack_count: 1,
    brand: "",
    color: "",
  };
  const updated = editProfile(product, input);
  assert.equal(updated.revision, 2);
  assert.equal(updated.fabric_weight_gsm.status, "merchant_confirmed");
  assert.deepEqual(updated.fabric_weight_gsm.source_ids, [
    "LOCAL-MERCHANT-INPUT",
  ]);
  assert.equal(product.fabric_weight_gsm.value, 140);
});
test("SQLite refuses competing revision numbers and preserves old product versions", () => {
  const store = createStore(":memory:");
  try {
    const prior = store.product(product.product_id);
    const updated = structuredClone(prior);
    updated.revision = 2;
    store.saveProduct(updated);
    assert.equal(store.product(product.product_id, 1).revision, 1);
    assert.throws(() => store.saveProduct(updated), { code: "STALE_PRODUCT" });
  } finally {
    store.close();
  }
});

test("known material, dimensions, capacity and handle values cannot drift behind a model pass", () => {
  for (const text of [
    "Dimensions: 40 x 50 cm.",
    "Capacity: 20 L.",
    "100% polyester.",
    "Handle length: 70 cm.",
  ]) {
    const content = fixture("AMZ-CLEAN-001");
    content.description = text;
    // 方法名从 `deterministic` 变成 `deterministic_structured_facts`（结构化事实对照单独记名）。
    // 断言放宽到前缀，但把"必须是程序判的、必须是阻断级"这两点钉死——
    // 要点是"不依赖模型"，不是那个具体字符串。
    const hit = review(content).issues.find(
      (x) => x.rule_id === "AMZ-05" && String(x.method).startsWith("deterministic"),
    );
    assert.ok(hit, text);
    assert.equal(hit.severity, "blocking", text);
  }
});
