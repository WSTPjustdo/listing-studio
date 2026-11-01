// Engineering transport/size checks using archived W101 facts. Added archives
// and intercepted HTTP responses are protocol fixtures, not live acceptance.
// These checks do not dispatch a network request or spend model credits.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  contentForAudit,
  productForModel,
  sourcesForModel,
  resolveGuidedPlaceholders,
} from "../server/model-context.mjs";
import {
  prepareGuidedPlan,
  createGuidedPlan,
  prepareGuidedGeneration,
} from "../server/guided.mjs";
import { createService } from "../server/service.mjs";
import { createStore } from "../server/store.mjs";
import { reviewContent } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";

const archived = JSON.parse(
  readFileSync(
    new URL(
      "../reports/secondary-processing-2026-10-30/final-reference-record.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const config = {
  provider: "compatible",
  base_url: "http://127.0.0.1:9/v1",
  model: "engineering-transport-only",
  api_key: "engineering-not-a-real-key",
  timeout_ms: 5000,
};
const marker = "ARCHIVE_ONLY_ENGINEERING_TEXT_";
const template =
  "Read {{PRODUCT_FACTS}} and {{KEYWORDS}}. Compare {{PRODUCT_FACTS}} again, then use {{PRODUCT_FACTS}} with {{KEYWORDS}}. Keep unknown facts unknown and consult the current rule pack.";

function fixture() {
  const doc = {
    id: "engineering-material-context",
    filename: "engineering-material.txt",
    kind: "txt",
    sha256: "engineering-digest",
    bytes: 60000,
    status: "ready",
    text: marker.repeat(2000),
    segments: [{ locator: "第1行", text: marker.repeat(2000) }],
    warnings: [],
  };
  const fact = structuredClone(archived.product_snapshot.additional_facts[0]);
  const analysis = {
    id: "analysis-engineering-context",
    name: "archived public product",
    category: "棉布手提袋",
    facts: [
      {
        label: fact.label,
        value: fact.value,
        evidence: fact.value,
        source_refs: [
          { document_id: doc.id, filename: doc.filename, locator: "第1行" },
        ],
      },
    ],
    checked_at: "2026-10-31T00:00:00.000Z",
    missing: [],
    trace: { actual_model_call: false, raw: marker.repeat(2000) },
    material_context: {
      documents: [doc],
      document_ids: [doc.id],
      original_text: doc.text,
    },
  };
  const product = {
    ...structuredClone(archived.product_snapshot),
    revision: 1,
    research_analysis: analysis,
    material_context: { ...analysis.material_context, source_ids: [doc.id] },
  };
  product.additional_facts[0].source_ids.push(analysis.id, doc.id);
  product.additional_facts[0].source_refs = analysis.facts[0].source_refs;
  const sources = [
    ...structuredClone(archived.source_snapshot),
    {
      source_id: analysis.id,
      kind: "merchant_product_extraction",
      checked_at: analysis.checked_at,
      snapshot: analysis,
    },
    {
      source_id: doc.id,
      kind: "merchant_material",
      description: "Engineering provenance only; not independently verified.",
      snapshot: doc,
    },
  ];
  return { product, sources, doc, analysis };
}

function workspace() {
  const data = fixture(),
    store = createStore(":memory:");
  store.saveSettings(config);
  store.saveProduct(data.product);
  for (const source of data.sources) store.saveSource(source);
  return { ...data, store };
}
const planInput = (product) => ({
  mode: "automatic",
  product_id: product.product_id,
  product_revision: product.revision,
  scope_confirmed: true,
});
const response = (value) =>
  new Response(
    JSON.stringify({
      id: "engineering-protocol-only",
      model: config.model,
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify(value) } },
      ],
    }),
  );

test("product projection preserves all substantive facts and references while dropping duplicate archives", () => {
  const { product } = fixture();
  product.imported_table = true;
  product.manufacturer = {
    value: { name: "engineering shape only" },
    status: "merchant_confirmed",
    source_ids: [],
  };
  product.future_supported_attribute = {
    value: "retained exactly",
    status: "unknown",
    source_ids: [],
  };
  const before = structuredClone(product);
  const projected = productForModel(product);
  const { research_analysis, material_context, ...substantive } = before;
  assert.deepEqual(projected, substantive);
  assert.deepEqual(product, before);
  assert.ok(!JSON.stringify(projected).includes(marker));
  projected.additional_facts[0].value = "mutated transport copy";
  assert.equal(
    product.additional_facts[0].value,
    before.additional_facts[0].value,
  );
  assert.equal(productForModel(null), null);
});

test("source projection retains source catalog IDs, official text, extraction evidence and material identity", () => {
  const { sources, doc, analysis } = fixture();
  const before = structuredClone(sources),
    projected = sourcesForModel(sources);
  assert.deepEqual(
    projected.map((source) => source.source_id),
    sources.map((source) => source.source_id),
  );
  assert.deepEqual(projected.slice(0, -2), sources.slice(0, -2));
  assert.deepEqual(projected.at(-2).snapshot.facts, analysis.facts);
  assert.equal(projected.at(-2).snapshot.trace, undefined);
  assert.equal(projected.at(-2).snapshot.material_context, undefined);
  assert.equal(projected.at(-1).snapshot.sha256, doc.sha256);
  assert.equal(projected.at(-1).snapshot.filename, doc.filename);
  assert.equal(projected.at(-1).snapshot.text, undefined);
  assert.equal(projected.at(-1).snapshot.segments, undefined);
  assert.ok(!JSON.stringify(projected).includes(marker));
  assert.deepEqual(sources, before);
});

test("repeated reusable placeholders expand compact product facts only once", () => {
  const { product } = fixture();
  const resolved = resolveGuidedPlaceholders(template, product, ["cotton"]);
  assert.equal(
    resolved.split(JSON.stringify(productForModel(product))).length - 1,
    1,
  );
  assert.equal(resolved.split('["cotton"]').length - 1, 1);
  assert.ok(!resolved.includes("{{PRODUCT_FACTS}}"));
  assert.ok(!resolved.includes(marker));
  assert.ok(resolved.includes("140"));
  assert.ok(resolved.length < 15000, "archives must not scale prompt size");
});

test("guided transport uses projections and the saved plan keeps the complete product snapshot", async () => {
  const { store, product, doc } = workspace();
  try {
    let sent;
    const prepared = prepareGuidedPlan(store, planInput(product));
    const plan = await createGuidedPlan(
      store,
      planInput(product),
      async (_url, options) => {
        sent = JSON.parse(JSON.parse(options.body).messages[1].content);
        return response({
          optimized_prompt: template,
          changes: [],
          missing: [],
        });
      },
    );
    assert.deepEqual(sent.product, productForModel(product));
    assert.deepEqual(sent.sources, sourcesForModel(prepared.sources));
    assert.ok(!JSON.stringify(sent).includes(marker));
    assert.equal(
      plan.product_snapshot.material_context.documents[0].text,
      doc.text,
    );
    assert.deepEqual(plan.product_snapshot, product);
    const generation = prepareGuidedGeneration(store, {
      plan_id: plan.id,
      product_id: product.product_id,
      product_revision: product.revision,
      scope_confirmed: true,
    });
    assert.deepEqual(generation.product, product);
    assert.ok(!generation.instruction.includes(marker));
    assert.equal(
      generation.instruction.split(JSON.stringify(productForModel(product)))
        .length - 1,
      1,
    );
  } finally {
    store.close();
  }
});

test("generation and independent audit use compact requests while saved version retains full provenance", async () => {
  const { store, product, sources, doc } = workspace();
  const originalFetch = globalThis.fetch,
    requests = [];
  try {
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(JSON.parse(options.body).messages[1].content);
      requests.push(request);
      return response({
        ...(request.operation === "create"
          ? { content: archived.content }
          : {}),
        review: { issues: [], checks: [] },
        claim_map: [],
        patches: [],
      });
    };
    const run = createService(store).enqueue({
      operation: "create",
      product,
      instruction: resolveGuidedPlaceholders(template, product),
    });
    let saved;
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = store.run(run.run_id);
      if (current.status === "failed") assert.fail(current.error.message);
      if (current.status === "succeeded") {
        saved = store.latest(current.listing_id);
        break;
      }
      await delay(10);
    }
    assert.ok(saved, "intercepted protocol run should complete");
    assert.deepEqual(
      requests.map((request) => request.operation),
      ["create", "diagnose"],
    );
    for (const request of requests) {
      assert.deepEqual(request.product, productForModel(product));
      assert.ok(!JSON.stringify(request).includes(marker));
      assert.deepEqual(
        request.sources.map((source) => source.source_id),
        saved.source_snapshot.map((source) => source.source_id),
      );
    }
    assert.deepEqual(saved.product_snapshot, product);
    assert.deepEqual(
      saved.source_snapshot.find((source) => source.source_id === doc.id)
        .snapshot,
      doc,
    );
    assert.deepEqual(
      saved.source_snapshot.find(
        (source) => source.source_id === "analysis-engineering-context",
      ),
      sources.find(
        (source) => source.source_id === "analysis-engineering-context",
      ),
    );
    assert.deepEqual(store.product(product.product_id), product);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});

test("audit content removes only blank bullet slots and preserves verbatim text, IDs and the original archive", () => {
  const original = structuredClone(archived.content);
  original.bullet_points = [
    { id: "b1", text: "" },
    { id: "b3", text: " \t\n " },
    { id: "b5", text: `  ${archived.content.bullet_points[0].text}  ` },
  ];
  const before = structuredClone(original);
  const projected = contentForAudit(original);
  assert.deepEqual(projected.bullet_points, [before.bullet_points[2]]);
  assert.equal(projected.title, before.title);
  assert.equal(projected.item_highlights, before.item_highlights);
  assert.equal(projected.description, before.description);
  assert.deepEqual(original, before);
  projected.bullet_points[0].text = "mutated transport only";
  assert.deepEqual(original, before);
  assert.equal(contentForAudit(null), null);
});

test("patch and diagnose omit deleted slots from audit while writing requests, versions and substantive findings retain them", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const operation of ["patch", "diagnose", "revise", "create"]) {
      const { store, product } = workspace();
      try {
        const initialContent = structuredClone(archived.content);
        initialContent.bullet_points = [
          { id: "b1", text: "" },
          { id: "b2", text: archived.content.bullet_points[0].text },
          { id: "b3", text: " \t " },
          // Controlled adversarial parameter, never represented as real product/model output.
          { id: "b5", text: "  999% cotton  " },
        ];
        const finalContent = structuredClone(initialContent);
        finalContent.bullet_points[1].text = "";
        const previous = {
          ...structuredClone(archived),
          listing_id: `engineering-empty-bullets-${operation}`,
          version: 1,
          content: initialContent,
          product_snapshot: product,
        };
        if (operation !== "create") store.saveVersion(previous);
        const requests = [];
        globalThis.fetch = async (_url, options) => {
          const request = JSON.parse(JSON.parse(options.body).messages[1].content);
          requests.push(request);
          return response({
            ...(["create", "revise"].includes(request.operation) ? { content: finalContent } : {}),
            review: { issues: [{
              rule_id: "AMZ-05", field_path: "content.bullet_points.b5", original: "999% cotton",
              reason: "工程构造的含量冲突仍应完整保留", suggestion: "按已确认材质核对含量。",
              severity: "blocking", source_ids: product.material.source_ids,
            }], checks: [] },
            claim_map: [], patches: [],
          });
        };
        const run = createService(store).enqueue({
          operation, product,
          ...(operation === "create" ? { content: initialContent } : { previous, base_version: 1 }),
          ...(operation === "diagnose" ? { content: finalContent } : {}),
          ...(operation === "patch" ? { patches: [{
            field_path: "content.bullet_points.b2", expected_before: initialContent.bullet_points[1].text,
            replacement: "", reason: "工程验证删除后保留原槽位",
          }] } : {}),
        });
        let saved;
        for (let attempt = 0; attempt < 200; attempt++) {
          const current = store.run(run.run_id);
          if (current.status === "failed") assert.fail(`${operation}: ${current.error.message}`);
          if (current.status === "succeeded") { saved = store.latest(current.listing_id); break; }
          await delay(10);
        }
        assert.ok(saved, `${operation}: intercepted protocol run should complete`);
        const audits = requests.filter(request => request.operation === "diagnose");
        assert.equal(audits.length, 1, operation);
        assert.deepEqual(audits[0].current_content, contentForAudit(finalContent), operation);
        for (const writing of requests.filter(request => ["create", "revise"].includes(request.operation)))
          assert.deepEqual(writing.current_content, initialContent, operation);
        assert.deepEqual(saved.content, finalContent, operation);
        if (operation !== "create") assert.deepEqual(store.version(previous.listing_id, 1).content, initialContent, operation);
        assert.ok(saved.review.issues.some(issue => issue.method === "model_assisted" && issue.original === "999% cotton"), operation);
        const deterministic = reviewContent({ content: finalContent, profile: product, rulePack: rulePackFor("US") });
        for (const issue of deterministic.issues.filter(issue => issue.field_path === "content.bullet_points.b5"))
          assert.ok(saved.review.issues.some(savedIssue => savedIssue.rule_id === issue.rule_id && savedIssue.original === issue.original), operation);
      } finally { store.close(); }
    }
  } finally { globalThis.fetch = originalFetch; }
});
