/**
 * 一批花了多少次模型调用、多少 token、折算多少钱。
 *
 * 为什么要有这个文件（第 12 轮实测的三条，都是启动前量的）：
 *   1. 300 行批次 = 600 次上游调用，但全站唯一的口径 `GET /api/telemetry?limit=500` 只回 500 条，
 *      token 合计 510,000，而真实是 612,000 —— **看起来便宜了 16.7%**；2000 行批次是 4000 次调用，
 *      覆盖率只有 12.5%。
 *   2. `GET /api/batches/:id` 里任何成本类字段 0 个，`/api/batches/:id/cost` 是 404。
 *   3. 台账原本**无法归因**：`request_id` 存的是上游返回的 id（`fake-24` 这种），
 *      不是我们的 `${batch.id}-${row}-${attempt}`，所以「按前缀聚合」这条路走不通（实测 24 条对上 0 条）。
 *      现在 `invokeModel` 多了一个 attribution 参数，落库成 `batch_id` 列。
 *
 * 三条口径纪律：
 *   - **没有单价就不报钱**。本项目不内置任何厂商单价（各家随时改），只认
 *     `MODEL_PRICE_INPUT_PER_1M` / `MODEL_PRICE_OUTPUT_PER_1M`（+ 可选 `MODEL_PRICE_CURRENCY`）。
 *     没配就返回 `price: null`，并在 note 里说清"只报 token"。
 *   - **有一次调用没回 usage，就不折算钱**（部分单价 × 部分未知 = 编出来的数）。
 *   - **归属不明的调用不摊到任何一批头上**，另外单独报一个数。
 */

/** 单价只从环境变量读：不写死、不猜、不内置价目表。 */
export function priceConfig(env = process.env) {
  const input = Number(env.MODEL_PRICE_INPUT_PER_1M);
  const output = Number(env.MODEL_PRICE_OUTPUT_PER_1M);
  if (!(Number.isFinite(input) && input > 0) || !(Number.isFinite(output) && output > 0)) return null;
  const currency = String(env.MODEL_PRICE_CURRENCY || "USD").trim().slice(0, 8) || "USD";
  return { input_per_1m: input, output_per_1m: output, currency };
}

const sum = (values) => values.reduce((total, value) => total + value, 0);
const round = (value, digits = 4) => Number(value.toFixed(digits));

/**
 * 每行会调几次模型——**实测值，不是估计**。
 *
 * 出处：`node scripts/batch-cost-probe.mjs --operation <op> --rows 12`（2026-10-30，假上游 + 真 HTTP + 真 sqlite）
 *   create   12 行 → 上游 24 次 = 2.00 次/行（第 11 轮另外在 300 / 2000 行上量过，也是 2.00）
 *   diagnose 12 行 → 上游 12 次 = 1.00 次/行（不生成正文，就不发第二次「独立审阅」）
 *   optimize 12 行 → 上游 24 次 = 2.00 次/行
 *
 * 适用范围（别当万能公式）：**全部成功、没有重试**的行。重试与失败会多算，
 * 真实数字以 `calls.total` 为准，这里只用来回答「这一批该调几次」。
 * 也**不含** token：真模型每次多少 token 谁都没量过（本机无 Key）。
 */
export const CALLS_PER_ROW = { create: 2, diagnose: 1, optimize: 2 };
export function expectedCallsPerRow(operation) {
  const value = CALLS_PER_ROW[operation];
  return Number.isInteger(value) ? value : null;
}

/**
 * @param store 需要有 callTelemetryForBatch()
 * @param batch store.batch() 出来的整批对象
 * @param env   只为测试替换单价用
 */
export function batchCost(store, batch, env = process.env) {
  const calls = store.callTelemetryForBatch(batch.id);
  const rows = batch.rows || [];
  const statusCount = {};
  for (const row of rows) statusCount[row.status] = (statusCount[row.status] || 0) + 1;

  const failedCalls = calls.filter((call) => call.outcome === "failed");
  const withTokens = calls.filter((call) => Number.isFinite(call.total_tokens));
  const promptTokens = sum(calls.map((call) => call.prompt_tokens).filter(Number.isFinite));
  const completionTokens = sum(calls.map((call) => call.completion_tokens).filter(Number.isFinite));
  const totalTokens = sum(withTokens.map((call) => call.total_tokens));

  const byOperation = {};
  for (const call of calls) {
    const bucket = (byOperation[call.operation || "unknown"] ||= { calls: 0, failed: 0, tokens: 0, unknown_tokens: 0 });
    bucket.calls += 1;
    if (call.outcome === "failed") bucket.failed += 1;
    if (Number.isFinite(call.total_tokens)) bucket.tokens += call.total_tokens;
    else bucket.unknown_tokens += 1;
  }

  // 每行实际花了几次调用：批量里"某一行重试了 5 次"是会被问到的。
  const perRow = new Map();
  for (const call of calls) {
    if (call.batch_row === null || call.batch_row === undefined) continue;
    perRow.set(call.batch_row, (perRow.get(call.batch_row) || 0) + 1);
  }
  const rowCallCounts = [...perRow.values()];

  const price = priceConfig(env);
  const hasUnknownUsage = calls.length > 0 && withTokens.length !== calls.length;
  let priced = null;
  if (price && !hasUnknownUsage && calls.length > 0) {
    const inputCost = (promptTokens / 1e6) * price.input_per_1m;
    const outputCost = (completionTokens / 1e6) * price.output_per_1m;
    priced = {
      currency: price.currency,
      input_per_1m: price.input_per_1m,
      output_per_1m: price.output_per_1m,
      input_cost: round(inputCost),
      output_cost: round(outputCost),
      total: round(inputCost + outputCost),
      per_row: rows.length ? round((inputCost + outputCost) / rows.length) : null,
      source: "环境变量 MODEL_PRICE_INPUT_PER_1M / MODEL_PRICE_OUTPUT_PER_1M",
    };
  }

  const notes = [];
  const perRowExpected = expectedCallsPerRow(batch.operation);
  const expectedCalls = rows.length && perRowExpected ? rows.length * perRowExpected : null;
  if (!calls.length) notes.push("这一批还没有任何模型调用记录（可能尚未开始，或是升级前的旧批次）。");
  if (hasUnknownUsage) notes.push(`${calls.length - withTokens.length} 次调用没有回报 token 用量，因此不折算金额。`);
  if (!price) notes.push("没有配置模型单价，只报 token 用量，不折算金额（本项目不内置任何厂商价目表）。");
  if (rows.length && perRow.size < rows.length)
    notes.push(`${rows.length - perRow.size} 行没有任何模型调用记录（未开始、失败在调用之前，或来自升级前的旧批次）。`);
  if (expectedCalls !== null && calls.length > expectedCalls)
    notes.push(`比按「${perRowExpected} 次/行」预计的多 ${calls.length - expectedCalls} 次调用（重试、或失败后重派）。`);

  return {
    batch_id: batch.id,
    batch_status: batch.status,
    rows: {
      total: rows.length,
      by_status: statusCount,
      with_calls: perRow.size,
      without_calls: Math.max(0, rows.length - perRow.size),
    },
    calls: {
      total: calls.length,
      ok: calls.length - failedCalls.length,
      failed: failedCalls.length,
      retried: calls.filter((call) => call.attempts > 1).length,
      per_row: rows.length ? round(calls.length / rows.length, 2) : null,
      rows_max: rowCallCounts.length ? Math.max(...rowCallCounts) : null,
    },
    tokens: {
      total: withTokens.length ? totalTokens : null,
      prompt: withTokens.length ? promptTokens : null,
      completion: withTokens.length ? completionTokens : null,
      unknown_calls: calls.length - withTokens.length,
      per_row: rows.length && withTokens.length ? Math.round(totalTokens / rows.length) : null,
    },
    by_operation: byOperation,
    expected: {
      operation: batch.operation || null,
      calls_per_row: perRowExpected,
      calls: expectedCalls,
      // 实际 - 预计：0 表示与实测基准一致；正数是重试/重派；null 表示这个操作没有实测基准。
      delta: expectedCalls === null ? null : calls.length - expectedCalls,
      basis: "每行次数是实测值（scripts/batch-cost-probe.mjs --operation …），只对无重试的成功行成立。",
    },
    price: priced,
    attribution: {
      rule:
        perRowExpected === null
          ? "按 call_telemetry.batch_id 归属；这个操作类型没有实测的「每次/行」基准，重试另计。"
          : `按 call_telemetry.batch_id 归属；${batch.operation} 实测 ${perRowExpected} 次调用/行（generate 类再发一次独立审阅；diagnose 不生成正文，只调一次），重试另计。`,
      unattributed_calls_global: typeof store.callTelemetryUnattributed === "function" ? store.callTelemetryUnattributed() : null,
    },
    notes,
  };
}
