import test from "node:test";
import assert from "node:assert/strict";
import { invokeModel, parseResult, publicConfig, buildSystemPrompt, characterLimits, styleGuidance } from "../server/providers.mjs";

const config = {
  provider: "compatible",
  base_url: "https://api.deepseek.com",
  model: "deepseek-flash",
  api_key: "test-secret-not-real",
  timeout_ms: 5000,
};
const request = {
  operation: "diagnose",
  product: null,
  current_content: null,
  rules: [],
  sources: [],
};

test("malformed model JSON retries once with the same business input and records the failed attempt", async () => {
  const original = globalThis.fetch;
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: `attempt-${payloads.length}`, usage: { total_tokens: 12 }, choices: [{ message: { content: payloads.length === 1 ? '{"review":' : JSON.stringify({ review: { issues: [], checks: [] } }) } }] }));
  };
  try {
    const value = await invokeModel(config, request);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].messages[1].content, payloads[1].messages[1].content);
    assert.match(payloads[1].messages[0].content, /FORMAT RETRY/);
    assert.equal(value.trace.provider_request_id, "attempt-2");
    assert.equal(value.trace.format_retry.failed_attempt.trace.provider_request_id, "attempt-1");
    assert.equal(value.trace.format_retry.recovered, true);
  } finally { globalThis.fetch = original; }
});

test("invalid service JSON is a format failure and retries are bounded; HTTP auth errors are not retried", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("not-json"); };
  try {
    await assert.rejects(() => invokeModel(config, request), error => {
      assert.equal(error.code, "MODEL_RESPONSE_INVALID_JSON");
      assert.match(error.message, /原文和历史版本未改动/);
      return true;
    });
    assert.equal(calls, 2);
    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("denied", { status: 401 }); };
    await assert.rejects(() => invokeModel(config, request), { code: "MODEL_HTTP_401" });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test("DeepSeek adapter sends JSON mode and reads the actual provider response id", async () => {
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = { url, body: JSON.parse(options.body), headers: options.headers };
    return new Response(
      JSON.stringify({
        id: "mock-provider-id",
        model: "deepseek-flash",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({ review: { issues: [], checks: [] } }),
            },
          },
        ],
        usage: { total_tokens: 123 },
      }),
      { status: 200 },
    );
  };
  try {
    const result = await invokeModel(config, request);
    assert.equal(sent.url, "https://api.deepseek.com/chat/completions");
    assert.deepEqual(sent.body.response_format, { type: "json_object" });
    assert.equal(sent.body.thinking.type, "disabled");
    assert.equal(result.trace.provider_request_id, "mock-provider-id");
    assert.equal(result.trace.usage.total_tokens, 123);
  } finally {
    globalThis.fetch = original;
  }
});
test("non-DeepSeek compatible endpoints do not receive provider-specific thinking options", async () => {
  const original = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return new Response(
      JSON.stringify({
        choices: [
          { message: { content: '{"review":{"issues":[],"checks":[]}}' } },
        ],
      }),
      { status: 200 },
    );
  };
  try {
    // 配上非 DeepSeek 的模型名，才真的是"别人的端点"：这类端点不该收到 DeepSeek 私有参数。
    // （同端点 + deepseek 模型名的情形见下一条测试——那是中转站转发到 DeepSeek，要带。）
    await invokeModel(
      { ...config, base_url: "http://127.0.0.1:9999/v1", model: "gpt-4o-mini" },
      request,
    );
    assert.equal(payload.thinking, undefined);
    assert.equal(payload.response_format, undefined);
  } finally {
    globalThis.fetch = original;
  }
});
test("provider errors, malformed JSON and output truncation are explicit failures, not demo fallback", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response("secret backend text", { status: 401 });
    await assert.rejects(() => invokeModel(config, request), {
      code: "MODEL_HTTP_401",
    });
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "not JSON" } }] }),
        { status: 200 },
      );
    await assert.rejects(() => invokeModel(config, request), {
      code: "MODEL_INVALID_JSON",
    });
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "length", message: { content: "{}" } }],
        }),
        { status: 200 },
      );
    await assert.rejects(() => invokeModel(config, request), {
      code: "MODEL_OUTPUT_TRUNCATED",
    });
  } finally {
    globalThis.fetch = original;
  }
});
test("public settings never contain credentials", () => {
  const result = publicConfig({
    ...config,
    dify_create_api_key: "secret-2",
    dify_diagnose_api_key: "secret-3",
  });
  assert.equal(result.api_key, undefined);
  assert.equal(result.dify_create_api_key, undefined);
  assert.equal(result.has_api_key, true);
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
});

test("unsupported model check states remain unresolved instead of failing or passing review", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                review: {
                  issues: [],
                  checks: [
                    "fail",
                    "not_applicable",
                    "needs_review",
                    "pass",
                  ].map((state, index) => ({
                    rule_id: `rule-${index}`,
                    state,
                    reason: "Review result",
                  })),
                },
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  try {
    const result = await invokeModel(config, request);
    assert.deepEqual(
      result.result.review.checks.map((check) => check.state),
      ["not_checked", "not_checked", "not_checked", "pass"],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("invalid review enums report the field without exposing model output", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                review: {
                  issues: [
                    {
                      rule_id: "US-02",
                      field_path: "content.title",
                      original: "private-product-text",
                      reason: "private-reason",
                      suggestion: "revise",
                      severity: "high",
                      source_ids: [],
                    },
                  ],
                  checks: [],
                },
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  try {
    await assert.rejects(
      () => invokeModel(config, request),
      (error) => {
        assert.equal(error.code, "MODEL_INVALID_STRUCTURE");
        assert.match(error.validation_detail, /review\.issues\.0\.severity/);
        assert.match(error.message, /连续两次/);
        assert.deepEqual(error.model_trace.validation_issues, [{ path: 'review.issues.0.severity', code: 'invalid_value' }]);
        assert.deepEqual(error.format_retry.failed_attempt.trace.validation_issues, error.model_trace.validation_issues);
        assert.doesNotMatch(JSON.stringify(error.model_trace), /private-product-text|private-reason|test-secret/);
        assert.doesNotMatch(
          error.message,
          /private-product-text|private-reason|test-secret/,
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('schema retries receive only safe field diagnostics and the precise enum contract, retaining the complete business input', async () => {
  const original = globalThis.fetch; const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    const value = payloads.length === 1
      ? { review: { issues: [{ rule_id: 'US-02', field_path: 'content.title', original: 'private-product-text', reason: 'private-reason', suggestion: 'revise', severity: 'high', source_ids: [] }], checks: [] } }
      : { review: { issues: [], checks: [] } };
    return new Response(JSON.stringify({ id: `schema-${payloads.length}`, choices: [{ message: { content: JSON.stringify(value) } }] }));
  };
  try {
    const value = await invokeModel(config, request);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].messages[1].content, payloads[1].messages[1].content);
    assert.match(payloads[1].messages[0].content, /review\.issues\.0\.severity/);
    assert.match(payloads[1].messages[0].content, /invalid_value/);
    assert.match(payloads[1].messages[0].content, /severity:exactly blocking\|needs_review\|suggestion/);
    assert.match(payloads[1].messages[0].content, /Do not delete real findings/);
    assert.doesNotMatch(payloads[1].messages[0].content, /private-product-text|private-reason/);
    assert.deepEqual(value.trace.format_retry.failed_attempt.trace.validation_issues, [{ path: 'review.issues.0.severity', code: 'invalid_value' }]);
  } finally { globalThis.fetch = original; }
});

test('missing required audit arrays and content record safe schema diagnostics before failing', () => {
  for (const [operation, value, path] of [['diagnose', { review: { issues: [] } }, 'review.checks'], ['create', {}, 'content']]) {
    const trace = {};
    assert.throws(() => parseResult(value, trace, operation), error => error.code === 'MODEL_INVALID_STRUCTURE');
    assert.deepEqual(trace.validation_issues, [{ path, code: 'invalid_type' }]);
  }
});

/* ------------------------------------------------------------------ 生成侧契约（第 6 轮） */

// 为什么要这组用例：审核侧改一版有 100 条回归盯着，生成侧改一版一条都没有。
// 第 6 轮量到三件事都没人管：上限写死在 prompt 里、六类禁止语一条没禁、三种风格只传了 4 个汉字。
// 下面每条都对应其中一个数字，删掉哪句都得红。

const packWith = (limits) => ({
  rule_pack_version: "test-pack",
  rules: limits.map(([rule_id, field_paths, max]) => ({
    rule_id,
    field_paths,
    constraint: { max_characters: max },
  })),
});

test("character limits come from the rule pack, not from a literal in the prompt", () => {
  const prompt = buildSystemPrompt({ rules: packWith([["TEST-01", ["content.title"], 80], ["TEST-02", ["content.item_highlights"], 140]]).rules });
  assert.match(prompt, /Title <= 80/);
  assert.match(prompt, /Item highlights <= 140/);
  // 写死过一次 75/125，这里把它钉死：换包之后旧数字不许再出现在任何一份 prompt 里。
  assert.doesNotMatch(prompt, /<= 75\b/);
  assert.doesNotMatch(prompt, /<= 125\b/);
  assert.deepEqual(
    characterLimits(packWith([["TEST-01", ["content.title"], 80]]).rules).map((row) => [row.label, row.max]),
    [["Title", 80]],
  );
});

test("a pack that declares no limit gets no invented number", () => {
  const prompt = buildSystemPrompt({ rules: [{ rule_id: "X", field_paths: ["content.title"], constraint: {} }] });
  assert.match(prompt, /declares no character limit/);
  // 任何 `<= 数字` 都不许出现：没核对过就不给数字，也不拿后台经验值充数。
  assert.doesNotMatch(prompt, /<=\s*\d+/);
});

test("three writing styles produce three different instructions, and an unknown one falls back", () => {
  const rules = packWith([["AMZ-01", ["content.title"], 75]]).rules;
  const brief = (style) => ({ audience: "日常购物用户", use_case: "日常携带", concern: "尺寸与使用便利", style });
  const texts = ["简洁自然", "参数清晰", "场景导向"].map((style) => buildSystemPrompt({ rules, brief: brief(style) }));
  assert.equal(new Set(texts).size, 3, "三种风格必须真的写出三份不同的 system 消息");
  assert.match(texts[1], /specification first/);
  assert.match(texts[2], /situation first/);
  // 四栏 brief 的字段名必须在模型看得到的那段话里被解释过（原来 0/4）。
  for (const field of ["audience", "use_case", "concern", "style"]) assert.match(texts[0], new RegExp(field));
  // 没选风格 / 选了词表之外的值：给通用写法，不许自己猜一个风格。
  assert.equal(styleGuidance(null).style, null);
  assert.equal(styleGuidance({ style: "热血" }).guidance, styleGuidance(null).guidance);
  assert.match(buildSystemPrompt({ rules, brief: { style: "热血" } }), /no style selected|热血/);
});

test("the six generation-side prohibitions are actually in the prompt", () => {
  const prompt = buildSystemPrompt({ rules: [] });
  for (const phrase of [
    /customer reviews/i,
    /leave a review/i,
    /coupons/i,
    /limited time/i,
    /contact information/i,
    /offensive/i,
  ])
    assert.match(prompt, phrase);
  // 而且是要在"禁止句"里出现。JSON 契约里那句 `never null` 不算（instrument 自己在第 6 轮踩过）。
  assert.match(prompt, /Never write any of the following[\s\S]*customer reviews/);
});

test("the prompt the adapter sends really carries this request's limits and style", async () => {
  const original = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ id: "x", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ content: { title: "T", item_highlights: "H", bullet_points: [{ id: "b1", text: "x" }], description: "D" } }) } }] }),
      { status: 200 },
    );
  };
  try {
    await invokeModel(
      { provider: "compatible", base_url: "http://127.0.0.1:9", model: "m", api_key: "", timeout_ms: 5000 },
      {
        operation: "create",
        product: null,
        current_content: null,
        sources: [],
        rules: packWith([["TEST-01", ["content.title"], 90]]).rules,
        content_brief: { audience: "企业采购人员", use_case: "活动赠品", concern: "定制适用性", style: "场景导向" },
      },
    );
  } finally {
    globalThis.fetch = original;
  }
  const system = sent.messages[0].content;
  assert.match(system, /Title <= 90/, "上限必须是这一次请求带的规则给的");
  assert.match(system, /situation first/, "风格必须是这一次 brief 选的");
  // 用户消息里的 brief 仍然原样透传（服务端没在这里替模型翻译）。
  assert.match(sent.messages[1].content, /场景导向/);
});

test("relay gateways still get thinking:disabled when the model is a deepseek one", async () => {
  const original = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"review":{"issues":[],"checks":[]}}' } }] }),
      { status: 200 },
    );
  };
  try {
    // 2026-10-30 实测：发往非 deepseek.com 域名、且不带 thinking:disabled 时，
    // 80 个 token 全记进 reasoning_tokens，choices[0].message.content 是空字符串。
    // 模型名还是 deepseek-*，说明对端大概率就是 DeepSeek（中转站），该带这个参数。
    await invokeModel({ ...config, base_url: "https://api.tokenhubcloud.net/v1" }, request);
    assert.deepEqual(payload.thinking, { type: "disabled" });
    assert.equal(payload.model, "deepseek-flash");
  } finally {
    globalThis.fetch = original;
  }
});

test("客户可见文案的语言按 language 切换，但上限那句话不随语言放宽", () => {
  const en = buildSystemPrompt({ language: "en" });
  assert.match(en, /Listing content is natural US English\./);
  assert.doesNotMatch(en, /do NOT relax/);

  const es = buildSystemPrompt({ language: "es" });
  assert.match(es, /Listing content is Spanish/);
  assert.match(es, /do NOT relax for this language/);

  const zh = buildSystemPrompt({ language: "zh" });
  assert.match(zh, /Listing content is Simplified Chinese/);
  assert.match(zh, /do NOT relax for this language/);
  // 单位与型号不许换算、改名，这条三种语言都要有（中英西的写法不同，这里只查中文那条）
  assert.match(zh, /do not convert cm to/);
  assert.match(zh, /do not rename SKU/);
  // 不传 language 时与老行为一致
  assert.match(buildSystemPrompt({}), /natural US English/);
});
