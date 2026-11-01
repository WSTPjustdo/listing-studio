/**
 * 「只配错一个东西」时说人话。
 *
 * 这一组用例守的是第 15 轮量出来的那条基线：8 种配置错误原本塌成 4 句话
 * （抹掉状态码后 1 句），改完是 7 种原因 7 句话。
 * 断言故意落在"两种不同的原因不许说同一句话"上，而不是落在某句具体文案——
 * 文案可以改，塌掉不行。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  invokeModel,
  readUpstreamFailure,
  chatUrl,
  describeEndpoint,
  modelsUrl,
  probeModels,
} from "../server/providers.mjs";
import { describeFailure, classifyError, modelErrorMeta } from "../server/errors.mjs";
import { describeRowFailure } from "../server/batch.mjs";

const config = {
  provider: "compatible",
  base_url: "https://api.deepseek.com",
  model: "deepseek-flash",
  api_key: "test-secret-not-real",
  timeout_ms: 5000,
};
const request = { operation: "diagnose", product: null, current_content: null, rules: [], sources: [] };

const withFetch = async (response, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};

/* ---------- 上游错误体的两种形状 ---------- */

test("上游错误体：这个网关的扁平 {code,message} 和 OpenAI 的 error 对象都认得，纯文本不认", () => {
  const flat = readUpstreamFailure({ code: "INVALID_API_KEY", message: "Invalid API key" });
  assert.deepEqual(
    { shape: flat.shape, code: flat.code, message: flat.message, quota: flat.quota },
    { shape: "flat", code: "INVALID_API_KEY", message: "Invalid API key", quota: false },
  );
  const nested = readUpstreamFailure({
    error: { message: "You exceeded your current quota", type: "insufficient_quota" },
  });
  assert.equal(nested.shape, "nested");
  assert.equal(nested.code, "insufficient_quota");
  assert.equal(nested.quota, true, "认出额度这一义靠的是原文，不是状态码");
  // 纯文本 / HTML / 空体：不转发。上游没给"给客户端看"的字段时，我们自己也不编。
  assert.equal(readUpstreamFailure("404 page not found"), null);
  assert.equal(readUpstreamFailure("<html>502 Bad Gateway</html>"), null);
  assert.equal(readUpstreamFailure(null), null);
  assert.equal(readUpstreamFailure({}), null);
});

test("上游原文有长度上限，且控制字符会被抹平——它要显示在界面上", () => {
  const long = "x".repeat(400);
  const parsed = readUpstreamFailure({ code: "TOO_LONG", message: `${long}\n\ttab\u0007bell` });
  assert.ok(parsed.message.length <= 241, `实际 ${parsed.message.length} 字符`);
  assert.ok(parsed.message.endsWith("…"));
  assert.doesNotMatch(parsed.message, /[\n\t\u0007]/);
});

/* ---------- 401：没填 Key 和 Key 错了必须分开 ---------- */

test("401 带上游 code：没填 Key 与 Key 无效是两句不同的话，且各有各的下一步", async () => {
  const noKey = await withFetch(
    new Response(JSON.stringify({ code: "API_KEY_REQUIRED", message: "API key is required in Authorization header." }), { status: 401 }),
    () => invokeModel(config, request).catch((error) => error),
  );
  const badKey = await withFetch(
    new Response(JSON.stringify({ code: "INVALID_API_KEY", message: "Invalid API key" }), { status: 401 }),
    () => invokeModel(config, request).catch((error) => error),
  );
  assert.equal(noKey.code, "MODEL_HTTP_401");
  assert.equal(noKey.upstream.status, 401);
  assert.equal(noKey.upstream.code, "API_KEY_REQUIRED");

  const a = describeFailure(noKey);
  const b = describeFailure(badKey);
  assert.notEqual(a.message, b.message, "两种原因不许说同一句话");
  assert.notEqual(a.title, b.title);
  assert.notEqual(a.action, b.action);
  assert.match(a.message, /API_KEY_REQUIRED/);
  assert.match(b.message, /INVALID_API_KEY/);
  // 两种都是配置类、都不值得重试：重试 100 次还是 401。
  assert.equal(a.category, "config");
  assert.equal(a.retryable, false);
  assert.equal(b.category, "config");
});

test("上游没给可读字段时，话还是原来那句话——不许为了好看编内容", async () => {
  const plain = await withFetch(
    new Response("404 page not found", { status: 404 }),
    () => invokeModel(config, request).catch((error) => error),
  );
  assert.equal(plain.upstream, undefined);
  const detail = describeFailure(plain);
  assert.equal(detail.message, "模型服务返回 HTTP 404。请检查服务地址、权限、额度或模型名称。");
  assert.equal(detail.upstream, null);
  assert.equal(detail.title, "模型接口不存在");
});

/* ---------- 429：一个码三种含义，只有"额度"能确证 ---------- */

test("429 只有上游自己说额度时才改判为额度不足，其余保持上游抖动、可重试", async () => {
  const quota = await withFetch(
    new Response(JSON.stringify({ error: { message: "insufficient balance on this account", type: "insufficient_quota" } }), { status: 429 }),
    () => invokeModel(config, request).catch((error) => error),
  );
  assert.equal(quota.code, "MODEL_QUOTA_EXHAUSTED");
  assert.equal(classifyError(quota.code), "config", "额度用完必须进配置类，否则 2000 行不会熔断");
  assert.equal(modelErrorMeta(quota.code).retryable, false);

  const limited = await withFetch(
    new Response(JSON.stringify({ code: "RATE_LIMIT_EXCEEDED", message: "Too many requests" }), { status: 429 }),
    () => invokeModel(config, request).catch((error) => error),
  );
  assert.equal(limited.code, "MODEL_HTTP_429", "认不出额度就是普通限流，不许猜");
  assert.equal(classifyError(limited.code), "upstream");
  const wording = describeFailure(limited);
  assert.match(wording.action, /三种含义/, "429 说不清是哪一义时，要把三种都摆出来");
  assert.notEqual(wording.message, describeFailure(quota).message);
});

test("额度不足与限流都叫 429，但用户看到的两句话不一样", async () => {
  const quota = describeFailure({
    code: "MODEL_QUOTA_EXHAUSTED",
    upstream: { status: 429, code: "insufficient_quota", message: "quota exceeded" },
  });
  const limited = describeFailure({
    code: "MODEL_HTTP_429",
    upstream: { status: 429, code: "RATE_LIMIT_EXCEEDED", message: "slow down" },
  });
  assert.match(quota.action, /充值/);
  assert.match(limited.action, /并发|重试/);
});

/* ---------- 单次运行与批量行必须是同一句话 ---------- */

test("批量行与单次运行共用 describeFailure：标题、下一步、上游原文一致", () => {
  const error = Object.assign(new Error("模型服务返回 HTTP 401。请检查服务地址、权限、额度或模型名称。"), {
    code: "MODEL_HTTP_401",
    upstream: { status: 401, code: "INVALID_API_KEY", message: "Invalid API key" },
  });
  const run = describeFailure(error);
  const row = describeRowFailure(error);
  assert.equal(row.error, run.message);
  assert.equal(row.error_title, run.title);
  assert.equal(row.error_action, run.action);
  assert.equal(row.error_category, run.category);
  assert.deepEqual(row.error_upstream, { status: 401, code: "INVALID_API_KEY", message: "Invalid API key" });
});

test("上游没给 code 时不留残缺字段：error_upstream 不出现", () => {
  const row = describeRowFailure(Object.assign(new Error("模型响应超时。"), { code: "MODEL_TIMEOUT" }));
  assert.equal(row.error_upstream, undefined);
  assert.equal(row.error_title, "模型响应超时");
  assert.equal(row.error, "模型响应超时。", "没有上游原文时，原话不改写");
});

/* ---------- 设置页要显示的完整地址 ---------- */

test("完整请求地址只有一条规则：去尾斜杠、没写到 /chat/completions 就补上", () => {  assert.equal(chatUrl("https://api.tokenhubcloud.net/v1"), "https://api.tokenhubcloud.net/v1/chat/completions");
  assert.equal(chatUrl("https://api.tokenhubcloud.net/v1/"), "https://api.tokenhubcloud.net/v1/chat/completions");
  assert.equal(chatUrl("https://api.tokenhubcloud.net"), "https://api.tokenhubcloud.net/chat/completions");
  assert.equal(
    chatUrl("https://x.example/v1/chat/completions"),
    "https://x.example/v1/chat/completions",
    "已经写全的不许再补一段",
  );
  assert.equal(chatUrl(""), null);
  assert.deepEqual(describeEndpoint("https://api.tokenhubcloud.net/v1"), {
    url: "https://api.tokenhubcloud.net/v1/chat/completions",
    valid: true,
    reason: null,
  });
  const bad = describeEndpoint("not a url");
  assert.equal(bad.valid, false);
  assert.equal(bad.url, null);
  assert.match(bad.reason, /有效的模型服务地址/);
});

/* ---------- 测试连接：一次 GET /models 回答三个问题 ---------- */

test("模型列表地址：/chat/completions 要去掉再挂 /models，别拼成两段", () => {
  assert.equal(modelsUrl("https://api.tokenhubcloud.net/v1"), "https://api.tokenhubcloud.net/v1/models");
  assert.equal(
    modelsUrl("https://api.tokenhubcloud.net/v1/chat/completions"),
    "https://api.tokenhubcloud.net/v1/models",
  );
  assert.equal(
    modelsUrl("https://api.tokenhubcloud.net/v1/chat/completions/"),
    "https://api.tokenhubcloud.net/v1/models",
  );
  assert.equal(modelsUrl(""), null);
});

test("测试连接成功：列出模型，并在配的模型名不在名单里时说出来", async () => {
  const ok = await probeModels({ ...config, model: "deepseek-v4-flash" }, {
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }, { id: "deepseek-flash" }] }), { status: 200 }),
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.models, ["deepseek-flash", "deepseek-v4-pro"], "重复的 id 只留一个");
  assert.equal(ok.model_known, false, "填的模型不在名单里，必须提示——这是现场第二常见的手误");
  assert.equal(ok.endpoint, "https://api.deepseek.com/models");

  const known = await probeModels({ ...config, model: "deepseek-flash" }, {
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }), { status: 200 }),
  });
  assert.equal(known.model_known, true);
});

test("测试连接失败：四种原因的标题各不相同，且都带下一步", async () => {
  const cases = [
    ["401 没填 Key", { status: 401, body: { code: "API_KEY_REQUIRED", message: "API key is required in Authorization header." } }, "模型服务没收到密钥"],
    ["401 Key 无效", { status: 401, body: { code: "INVALID_API_KEY", message: "Invalid API key" } }, "模型服务不认这个密钥"],
    ["429 额度", { status: 429, body: { error: { message: "insufficient quota", type: "insufficient_quota" } } }, "模型账户额度不足"],
    ["429 限流", { status: 429, body: { code: "RATE_LIMIT_EXCEEDED", message: "slow down" } }, "模型服务限流或额度受限（HTTP 429）"],
  ];
  const titles = [];
  for (const [label, response, expected] of cases) {
    const result = await probeModels(config, {
      fetchImpl: async () => new Response(JSON.stringify(response.body), { status: response.status }),
    });
    assert.equal(result.ok, false, label);
    assert.equal(result.error.title, expected, label);
    assert.ok(result.error.action && result.error.action.length > 5, `${label} 缺下一步`);
    titles.push(result.error.title);
  }
  assert.equal(new Set(titles).size, cases.length, "四种原因不许共用标题");
});

test("测试连接遇到超时 / 连不上：说清是哪一种，不并成一句", async () => {
  const timeout = await probeModels(config, {
    fetchImpl: async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    },
  });
  const refused = await probeModels(config, {
    fetchImpl: async () => {
      throw Object.assign(new Error("fetch failed"), { name: "TypeError" });
    },
  });
  assert.equal(timeout.error.title, "模型响应超时");
  assert.equal(refused.error.title, "模型连接失败");
  assert.notEqual(timeout.error.title, refused.error.title);
});
