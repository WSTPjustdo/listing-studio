import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../server/store.mjs";
import { recordCall, normalizeCall } from "../server/telemetry.mjs";
import { batchCost, priceConfig, expectedCallsPerRow, CALLS_PER_ROW } from "../server/batch-cost.mjs";

/*
 * 守卫「这一批花了多少」。
 *
 * 第 12 轮实测（scripts/batch-cost-probe.mjs）：
 *   300 行 = 600 次上游调用，但全站唯一口径 GET /api/telemetry?limit=500 只回 500 条、
 *   token 合计 510,000（真实 612,000，少 16.7%）；2000 行是 4000 次调用，覆盖率 12.5%。
 *   而且台账原本压根归于不了批次：request_id 存的是上游 id（fake-24），按前缀聚合实测 0/24。
 * 这里钉住三件事：归属能落库、不串批、没单价/有未知用量时不许编钱。
 */

const fakeBatch = (id, rows) => ({ id, status: "finished", rows });

const call = (batchId, row, extra = {}) => ({
  provider: "compatible", model: "fake-1", operation: "create", outcome: "ok",
  prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020, duration_ms: 1000,
  batch_id: batchId, batch_row: row, batch_attempt: 0, ...extra,
});

test("台账能把调用归到批次：两批互不串，未归属的单列", () => {
  const store = createStore(":memory:");
  try {
    recordCall(store, call("batch-a", 2));
    recordCall(store, call("batch-a", 2));
    recordCall(store, call("batch-a", 3));
    recordCall(store, call("batch-b", 2));
    recordCall(store, call("batch-b", 2, { outcome: "failed", total_tokens: null, prompt_tokens: null, completion_tokens: null }));
    recordCall(store, { provider: "compatible", model: "fake-1", operation: "create", total_tokens: 500 }); // 单点调用，无批次

    const a = batchCost(store, fakeBatch("batch-a", [{ row: 2, status: "completed" }, { row: 3, status: "completed" }]), {});
    const b = batchCost(store, fakeBatch("batch-b", [{ row: 2, status: "failed" }]), {});

    assert.equal(a.calls.total, 3, "A 批只数自己的 3 次");
    assert.equal(a.calls.per_row, 1.5);
    assert.equal(a.calls.rows_max, 2, "同一行两次调用要被看见");
    assert.equal(a.tokens.total, 3060);
    assert.equal(b.calls.total, 2);
    assert.equal(b.calls.failed, 1);
    assert.equal(b.tokens.total, 1020);
    assert.equal(b.tokens.unknown_calls, 1, "失败且没回 usage 的那次必须算未知");
    assert.equal(a.attribution.unattributed_calls_global, 1, "全局未归属调用单独报，不摊给任何一批");
  } finally { store.close(); }
});

test("没配单价就只报 token；配了才折算，且有一次未知用量就整体不折算", () => {
  assert.equal(priceConfig({}), null);
  assert.equal(priceConfig({ MODEL_PRICE_INPUT_PER_1M: "0" }), null, "缺一项不算配置");
  assert.deepEqual(priceConfig({ MODEL_PRICE_INPUT_PER_1M: "2", MODEL_PRICE_OUTPUT_PER_1M: "8" }),
    { input_per_1m: 2, output_per_1m: 8, currency: "USD" });

  const store = createStore(":memory:");
  try {
    recordCall(store, call("batch-p", 2));
    const bare = batchCost(store, fakeBatch("batch-p", [{ row: 2, status: "completed" }]), {});
    assert.equal(bare.price, null);
    assert.ok(bare.notes.some((note) => note.includes("没有配置模型单价")), "要明说没单价，不许静默返回 0 元");

    const env = { MODEL_PRICE_INPUT_PER_1M: "2", MODEL_PRICE_OUTPUT_PER_1M: "8" };
    const priced = batchCost(store, fakeBatch("batch-p", [{ row: 2, status: "completed" }]), env);
    // 900 prompt * 2/1e6 + 120 completion * 8/1e6 = 0.0018 + 0.00096
    assert.equal(priced.price.total, 0.0028);
    assert.equal(priced.price.per_row, 0.0028);

    recordCall(store, call("batch-p", 3, { total_tokens: null, prompt_tokens: null, completion_tokens: null }));
    const partial = batchCost(store, fakeBatch("batch-p", [{ row: 2, status: "completed" }, { row: 3, status: "failed" }]), env);
    assert.equal(partial.price, null, "部分调用不知道用了多少 token，折算出来的钱是编的");
    assert.equal(partial.tokens.unknown_calls, 1);
  } finally { store.close(); }
});

test("旧库升级：没有 batch_id 列的 call_telemetry 会被补上，老记录不丢", () => {
  const temp = mkdtempSync(join(tmpdir(), "ls-cost-migrate-"));
  const file = join(temp, "legacy.sqlite");
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec("CREATE TABLE call_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)");
    legacy.prepare("INSERT INTO call_telemetry (data) VALUES (?)").run(JSON.stringify({ operation: "create", total_tokens: 111 }));
    legacy.close();

    const store = createStore(file);
    try {
      // 老记录还在，只是没有归属
      assert.equal(store.callTelemetry(10).length, 1);
      assert.equal(store.callTelemetryUnattributed(), 1);
      // 新记录能带归属
      store.saveCallTelemetry(normalizeCall(call("batch-new", 5)));
      assert.equal(store.callTelemetryForBatch("batch-new").length, 1);
      assert.equal(store.callTelemetryUnattributed(), 1);
    } finally { store.close(); }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("空批次：不算钱、不除零、要说清为什么没有记录", () => {
  const store = createStore(":memory:");
  try {
    const cost = batchCost(store, fakeBatch("batch-empty", [{ row: 2, status: "queued" }]), {
      MODEL_PRICE_INPUT_PER_1M: "2", MODEL_PRICE_OUTPUT_PER_1M: "8",
    });
    assert.equal(cost.calls.total, 0);
    assert.equal(cost.calls.per_row, 0);
    assert.equal(cost.tokens.total, null, "没调用就没有 token，不能是 0（0 会被读成「免费」）");
    assert.equal(cost.price, null);
    assert.equal(cost.rows.without_calls, 1);
    assert.ok(cost.notes.some((note) => note.includes("还没有任何模型调用记录")));
  } finally { store.close(); }
});

test("批量成本查询不套全局台账的 500 条上限", () => {
  const store = createStore(":memory:");
  try {
    for (let i = 1; i <= 700; i++) recordCall(store, call("batch-big", i));
    assert.equal(store.callTelemetry(500).length, 500, "全局台账仍按 500 截断（这是它的既有行为）");
    assert.equal(store.callTelemetryForBatch("batch-big").length, 700, "按批查必须一条不少");
    const cost = batchCost(store, fakeBatch("batch-big", Array.from({ length: 700 }, (_, i) => ({ row: i + 1, status: "completed" }))), {});
    assert.equal(cost.calls.total, 700);
    assert.equal(cost.tokens.total, 700 * 1020);
  } finally { store.close(); }
});

/*
 * 「每行几次调用」的分叉：diagnose 是 1 次，生成类 2 次。
 * 实测出处：scripts/batch-cost-probe.mjs --operation <op> --rows 12（2026-10-30）
 *   create 24/12、diagnose 12/12、optimize 24/12。
 * 为什么值得钉：界面上那句「每件通常 diagnose 1 次、其他 2 次」原来是写死的魔法数字，
 * 而 /cost 的说明文字写的是「一批的行数 = 2 次调用/行」——对 diagnose 批次直接错了。
 */
test("每行调用次数的基准按操作类型分：diagnose 1 次，生成类 2 次", () => {
  assert.deepEqual(CALLS_PER_ROW, { create: 2, diagnose: 1, optimize: 2 }, "这三个数是量出来的，改动必须重新量");
  assert.equal(expectedCallsPerRow("diagnose"), 1);
  assert.equal(expectedCallsPerRow("create"), 2);
  assert.equal(expectedCallsPerRow("retranslate"), null, "没有实测基准的类型不许编一个数");

  const store = createStore(":memory:");
  try {
    // 12 行 diagnose：12 次调用，与基准完全一致
    for (let row = 2; row <= 13; row++) recordCall(store, call("batch-d", row, { operation: "diagnose" }));
    const rows = Array.from({ length: 12 }, (_, i) => ({ row: i + 2, status: "completed" }));
    const diagnose = batchCost(store, { id: "batch-d", status: "finished", operation: "diagnose", rows }, {});
    assert.equal(diagnose.expected.calls_per_row, 1);
    assert.equal(diagnose.expected.calls, 12);
    assert.equal(diagnose.expected.delta, 0, "12 行 12 次，不该报警");
    assert.ok(!diagnose.notes.some((note) => note.includes("预计")), "与基准一致时不要多嘴");
    assert.ok(diagnose.attribution.rule.includes("diagnose 实测 1 次调用/行"), diagnose.attribution.rule);

    // 同一批 12 行如果调了 14 次（两次重试），要说「比预计多 2 次」，不许静默
    recordCall(store, call("batch-d", 2, { operation: "diagnose", outcome: "failed", total_tokens: null }));
    recordCall(store, call("batch-d", 3, { operation: "diagnose", outcome: "failed", total_tokens: null }));
    const retried = batchCost(store, { id: "batch-d", status: "finished", operation: "diagnose", rows }, {});
    assert.equal(retried.expected.delta, 2);
    assert.ok(retried.notes.some((note) => note.includes("多 2 次调用")), "多打的调用必须写在备注里");

    // 没有基准的操作：expected 里不许出现数字
    const unknown = batchCost(store, { id: "batch-d", status: "finished", operation: "translate", rows }, {});
    assert.equal(unknown.expected.calls, null);
    assert.equal(unknown.expected.delta, null);
  } finally { store.close(); }
});
