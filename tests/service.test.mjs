import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createStore, scenarios } from "../server/store.mjs";
import { createService } from "../server/service.mjs";
import { generateLocalDraft } from "../server/domain.mjs";

test("service independently reviews generated and patched content; hard facts override mock model passes", async () => {
  const store = createStore(":memory:");
  const original = globalThis.fetch;
  const operations = [];
  store.saveSettings({
    provider: "compatible",
    base_url: "http://127.0.0.1:9999/v1",
    model: "test-mock-model",
    api_key: "not-real",
    timeout_ms: 5000,
  });
  // 服务端现在拒绝演示商品（REAL_PRODUCT_REQUIRED），内存库只种了演示商品。
  // 用同一份档案数值做"真实商品"替身：这组用例验的是"生成之后必须独立复检""硬事实盖过模型结论"，
  // 与商品是不是演示无关。product_id 换成中性名，避免日志里看起来还在走演示路径。
  const product = { ...scenarios.product_profiles[0], product_id: "TEST-REAL-W101", is_demo: false };
  let drift = false;
  let unrelated = false;
  let modelPatches = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(JSON.parse(options.body).messages[1].content);
    operations.push(request);
    const content = generateLocalDraft(request.product);
    if (unrelated) content.description = "Unrequested rewrite";
    if (drift) content.item_highlights = "200 g/m² cotton fabric.";
    const checks = [
      "AMZ-03",
      "AMZ-04",
      "AMZ-05",
      "US-01",
      "US-02",
      "US-03",
      "FACT-01",
      "FACT-02",
    ].map((rule_id) => ({
      rule_id,
      state: "pass",
      reason: "Mock protocol response, not a live model judgment.",
    }));
    return new Response(
      JSON.stringify({
        id: `mock-${operations.length}`,
        model: "test-mock-model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                content,
                review: { issues: [], checks },
                claim_map: [{ field_path: "content.title", claim: request.operation === "diagnose" ? request.current_content.title : content.title, source_ids: request.operation === "diagnose" ? product.material.source_ids : product.fabric_weight_gsm.source_ids }],
                patches: modelPatches,
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  };
  const wait = async (run) => {
    for (let i = 0; i < 100; i++) {
      const value = store.run(run.run_id);
      if (value.status === "failed") throw new Error(value.error.message);
      if (value.status === "succeeded") return store.latest(value.listing_id);
      await delay(10);
    }
    throw new Error("timeout");
  };
  try {
    const service = createService(store);
    const created = await wait(
      service.enqueue({ operation: "create", product }),
    );
    assert.deepEqual(
      operations.map((x) => x.operation),
      ["create", "diagnose"],
    );
    assert.deepEqual(operations[1].current_content, created.content);
    assert.equal(created.trace.calls.length, 2);
    assert.deepEqual(created.claim_map[0].source_ids, product.material.source_ids);
    const patched = await wait(
      service.enqueue({
        operation: "patch",
        previous: created,
        product,
        base_version: 1,
        patches: [
          {
            field_path: "content.title",
            expected_before: created.content.title,
            replacement: "Cotton Tote Bag",
          },
        ],
      }),
    );
    assert.equal(operations.at(-1).operation, "diagnose");
    assert.equal(operations.at(-1).current_content.title, "Cotton Tote Bag");
    assert.equal(patched.content.title, "Cotton Tote Bag");
    drift = true;
    const changed = await wait(
      service.enqueue({
        operation: "revise",
        previous: patched,
        product,
        instruction: "test model drift",
      }),
    );
    assert.ok(changed.review.issues.some((x) => x.rule_id === "AMZ-05"));
    assert.equal(changed.product_snapshot.fabric_weight_gsm.value, 140);
    assert.equal(changed.review.status, "needs_attention");
    drift = false;
    const bulk = await wait(
      service.enqueue({
        operation: "revise",
        previous: changed,
        product,
        base_version: changed.version,
        review_issues: true,
        instruction: "Review all imported findings against supplied evidence.",
      }),
    );
    const request = operations.at(-2);
    assert.equal(request.operation, "revise");
    assert.deepEqual(request.review_context.issues, changed.review.issues);
    assert.deepEqual(
      request.review_context.missing_data,
      changed.review.missing_data,
    );
    assert.deepEqual(request.current_content, changed.content);
    assert.equal(operations.at(-1).operation, "diagnose");
    assert.equal(operations.at(-1).review_context, undefined);
    assert.equal(bulk.version, changed.version + 1);
    assert.deepEqual(bulk.review_input, request.review_context);
    assert.ok(!bulk.review.issues.some((x) => x.rule_id === "AMZ-05"));
    assert.equal(
      store
        .versions(changed.listing_id)
        .find((x) => x.version === changed.version).content.item_highlights,
      "200 g/m² cotton fabric.",
    );
    const titlePatch = {
      field_path: "content.title",
      expected_before: bulk.content.title,
      replacement: "Cotton Tote Bag",
      reason: "test",
    };
    const descriptionPatch = {
      field_path: "content.description",
      expected_before: bulk.content.description,
      replacement: "First alternative",
      reason: "test",
    };
    modelPatches = [
      titlePatch,
      { ...titlePatch },
      descriptionPatch,
      { ...descriptionPatch, replacement: "Conflicting alternative" },
      { ...titlePatch, field_path: "product.secret" },
    ];
    const diagnosed = await wait(
      service.enqueue({
        operation: "diagnose",
        product,
        content: bulk.content,
      }),
    );
    assert.equal(
      diagnosed.patches.filter((x) => x.field_path === "content.title").length,
      1,
    );
    assert.ok(
      !diagnosed.patches.some((x) =>
        ["content.description", "product.secret"].includes(x.field_path),
      ),
    );
    assert.ok(diagnosed.repair_warnings.length > 0);
    const applied = await wait(
      service.enqueue({
        operation: "patch",
        previous: diagnosed,
        product,
        patches: diagnosed.patches,
        base_version: diagnosed.version,
      }),
    );
    assert.equal(applied.content.title, "Cotton Tote Bag");
    assert.equal(applied.content.description, diagnosed.content.description);
    modelPatches = [];
    const optimized = await wait(
      service.enqueue({
        operation: "diagnose",
        batch_optimize: true,
        product,
        content: changed.content,
      }),
    );
    assert.equal(operations.at(-2).operation, "revise");
    assert.deepEqual(operations.at(-2).current_content, changed.content);
    assert.equal(operations.at(-1).operation, "diagnose");
    assert.equal(
      optimized.content.item_highlights,
      bulk.content.item_highlights,
    );
    unrelated = true;
    const isolated = await wait(
      service.enqueue({
        operation: "diagnose",
        product,
        content: changed.content,
      }),
    );
    const scoped = await wait(
      service.enqueue({
        operation: "revise",
        previous: isolated,
        product,
        base_version: isolated.version,
        review_issues: true,
        review_rule_ids: ["AMZ-05"],
        instruction: "Fix selected issues",
      }),
    );
    assert.ok(
      operations
        .at(-2)
        .review_context.issues.every((i) => i.rule_id === "AMZ-05"),
    );
    assert.equal(scoped.content.description, isolated.content.description);
    assert.notEqual(scoped.content.description, "Unrequested rewrite");
    assert.ok(!scoped.review.issues.some((i) => i.rule_id === "AMZ-05"));
  } finally {
    globalThis.fetch = original;
    store.close();
  }
});

// 第 10 轮：范围未确认的报错话术原来写死"仅支持 Amazon 美国站"。
// 德国站请求撞上这一句，商家会以为站点勾错了——站点是 DE，话术就得说 DE。
test("范围未确认时，报错按本次站点说，不写死美国站", () => {
  const store = createStore(":memory:");
  try {
    store.saveSettings({
      provider: "compatible",
      base_url: "http://127.0.0.1:9999/v1",
      model: "test-mock-model",
      api_key: "not-real",
      timeout_ms: 5000,
    });
    const product = { ...scenarios.product_profiles[0], product_id: "TEST-SCOPE", is_demo: false };
    const service = createService(store);
    for (const marketplace of ["DE", "US"]) {
      assert.throws(
        () =>
          service.enqueue({
            operation: "create",
            product,
            marketplace,
            intake_context: { role: "own_draft", scope_confirmed: false, marketplace: "US", original_content: {} },
          }),
        (error) =>
          error.code === "INTAKE_SCOPE_UNCONFIRMED" && error.message.includes(`Amazon ${marketplace} 站`),
      );
    }
  } finally {
    store.close();
  }
});
