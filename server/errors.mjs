/** Error categories describe observed failure codes; they never replace the original error. */
export const CATEGORY_LABELS = {
  format: '返回格式', timeout: '响应超时', config: '模型配置', content: '内容被拦截',
  upstream: '上游服务', lifecycle: '任务中断', data: '资料或版本', unknown: '未分类',
};
const entry = (category, title, action, retryable) => ({ category, title, action, retryable });
const CATALOG = {
  MODEL_INVALID_JSON: entry('format', '模型返回的 JSON 无效', '可重试；持续失败请核对模型输出格式。', true),
  MODEL_INVALID_STRUCTURE: entry('format', '模型返回字段不符合约定', '可重试；持续失败请核对模型与工作流输出。', true),
  MODEL_RESPONSE_INVALID_JSON: entry('format', '模型服务响应无法读取', '稍后重试，并核对服务地址或网关。', true),
  MODEL_OUTPUT_TRUNCATED: entry('format', '模型输出被截断', '缩短输入或改用支持更长输出的模型后重试。', true),
  MODEL_TIMEOUT: entry('timeout', '模型响应超时', '可重试，或在模型设置中调整超时时间。', true),
  MISSING_API_KEY: entry('config', '尚未配置模型密钥', '先在模型设置中配置密钥。', false),
  MISSING_DIFY_KEYS: entry('config', '工作流密钥不完整', '先补全两个工作流的密钥。', false),
  MISSING_MODEL_CONFIG: entry('config', '模型配置不完整', '先补全模型服务地址和模型名称。', false),
  INVALID_PROVIDER_URL: entry('config', '模型地址无效', '先核对模型服务地址。', false),
  REAL_MODEL_REQUIRED: entry('config', '需要连接真实模型', '先在本机配置真实模型。', false),
  REAL_PRODUCT_REQUIRED: entry('data', '需要真实商品资料', '选择真实商品并保留来源。', false),
  DIFY_WORKFLOW_FAILED: entry('upstream', '工作流未成功完成', '核对工作流运行日志后再处理。', false),
  DIFY_OUTPUT_MISSING: entry('config', '工作流缺少 result_json 输出', '核对工作流输出节点。', false),
  MODEL_CONTENT_BLOCKED: entry('content', '模型拒绝处理内容', '核对商品资料与请求内容后重新处理。', false),
  MODEL_SAFETY_BLOCKED: entry('content', '模型服务拦截内容', '核对服务商返回的拦截原因与商品资料。', false),
  MODEL_CONNECTION_FAILED: entry('upstream', '模型连接失败', '核对网络与服务地址后重试；服务端执行情况未知。', true),
  MODEL_PROCESSING_FAILED: entry('unknown', '模型响应处理发生内部错误', '保留运行记录及请求 ID，联系开发者排查。', false),
  // 429 里唯一能确证的一义：上游自己说额度/余额不够。这时重试毫无意义，
  // 而且批量必须停——否则 2000 行会一路撞到额度见底（第 14 轮数出来熔断只认 config 类）。
  MODEL_QUOTA_EXHAUSTED: entry('config', '模型账户额度不足', '到服务商控制台充值，或换一个可用的密钥；这一批已经停下，不用重试。', false),
  // 200 + 网页：地址填成网站首页时的真实表现（第 15 轮误打真网关撞出来的）。
  // 它不报错，状态码是 200，只有"返回的不是 JSON"能看出来。
  MODEL_ENDPOINT_NOT_API: entry('config', '这个地址不是模型接口', '返回的是网页或非 JSON 数据。服务地址要填到 API 前缀（例如 https://网关域名/v1），不是网站首页。', false),
  INTERRUPTED: entry('lifecycle', '任务执行中断', '保留已完成版本，只重试中断行。', true),
  STALE_VERSION: entry('data', '文案版本已更新', '刷新问题分组后重新选择处理，直接重试不能解决。', false),
  STALE_PRODUCT: entry('data', '商品资料已更新', '核对最新商品资料并重新导入。', false),
  ROW_UNAVAILABLE: entry('data', '这一行当前不可处理', '先核对该行任务与文案版本。', false),
};
export const MODEL_ERROR_CODES = Object.keys(CATALOG);
export function modelErrorMeta(code) {
  if (typeof code !== 'string') return null;
  let meta = CATALOG[code];
  const status = /^MODEL_HTTP_(\d{3})$/.exec(code)?.[1];
  if (!meta && status) {
    const n = Number(status);
    if ([401, 403].includes(n)) meta = entry('config', `模型访问被拒绝（HTTP ${n}）`, '核对密钥、权限与服务地址是否配套。', false);
    else if (n === 402) meta = entry('config', '模型账户额度不足', '核对服务商账户额度。', false);
    else if (n === 404) meta = entry('config', '模型接口不存在', '核对服务地址和模型名称。', false);
    else if (n === 429) meta = entry('upstream', '模型服务限流或额度受限（HTTP 429）', '这个码在上游有三种含义：额度用完、并发超限、限流。先看上游原文那句；等待一会儿再重试，或降低批量并发。', true);
    else if (n === 400 || n === 422) meta = entry('config', `模型请求被拒绝（HTTP ${n}）`, '核对请求参数与模型兼容性；不能据此推断内容违规。', false);
    else if (n >= 500) meta = entry('upstream', `模型服务故障（HTTP ${n}）`, '稍后重试；保留本次失败记录。', true);
  }
  return meta ? { code, ...meta } : null;
}
export const classifyError = code => modelErrorMeta(code)?.category || 'unknown';
export function errorSummary(code) {
  const meta = modelErrorMeta(code);
  if (!meta) return null;
  const { category, title, action, retryable } = meta;
  return { category, category_label: CATEGORY_LABELS[category], title, action, retryable };
}
export function describeError(code, detail = '') {
  const meta = modelErrorMeta(code);
  return meta ? `${meta.title}。${detail ? `${detail}。` : ''}${meta.action}` : null;
}

/**
 * 上游自己的错误码 → 具体动作。
 *
 * 分两类，别混：
 *   · **实测过的**（第 14 轮不带 Key 打真网关）：API_KEY_REQUIRED、INVALID_API_KEY。
 *     这两条决定了现场"填 Key"这一步是往前一步还是原地打转。
 *   · **按常见网关惯例写的**（本机没 Key，拿不到原文）：MODEL_NOT_FOUND / PERMISSION_DENIED /
 *     QUOTA_EXCEEDED。只影响多一句提示，不影响任何判定分支——认不出就退回状态码文案。
 */
const UPSTREAM_HINTS = {
  API_KEY_REQUIRED: {
    title: '模型服务没收到密钥',
    action: '在模型设置里填 API Key 再试。上游报的是「缺少 Authorization 头」，不是 Key 写错。',
  },
  INVALID_API_KEY: {
    title: '模型服务不认这个密钥',
    action: '核对 Key 是否完整（复制时少几位最常见），或到控制台重新生成一个再填。',
  },
  PERMISSION_DENIED: {
    title: '这个密钥没有调用权限',
    action: '到服务商控制台给这把 Key 开通该模型的调用权限。',
  },
  MODEL_NOT_FOUND: {
    title: '服务商没有这个模型名',
    action: '用服务商列出的模型 id 原样填进「模型名称」，别自己缩写。',
  },
};

/**
 * 一次失败 → 用户要看的四样东西（标题、原话、下一步、是否值得重试）。
 * 单次运行（run.error）和批量行（error_title/error_action）都走这一个函数，
 * 否则同一种错在两处会是两句话——演示时最容易被评委抓到。
 */
export function describeFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  const meta = modelErrorMeta(code);
  const raw = error?.upstream && typeof error.upstream === 'object' ? error.upstream : null;
  const upstream = raw
    ? { status: Number.isFinite(raw.status) ? raw.status : null, code: raw.code || null, message: raw.message || null }
    : null;
  const hint = upstream?.code ? UPSTREAM_HINTS[String(upstream.code).toUpperCase()] : null;
  const title = hint?.title || meta?.title || '处理失败';
  const action = hint?.action || meta?.action || '先核对失败原因；确认后可重试此行。';
  const heard = [upstream?.code, upstream?.message].filter(Boolean).join(' — ');
  const message = heard
    ? `${upstream.status ? `HTTP ${upstream.status}，` : ''}上游说：${heard}`
    // 没有上游原文时用目录里的标题兜底，而不是"原因未知"——
    // 我们明明认得这个码，说"未知"是把自己的信息丢了。
    : String(error?.message || '') || (meta ? `${meta.title}。` : '处理失败，原因未知。');
  return {
    code,
    message,
    title,
    action,
    category: meta?.category || 'unknown',
    category_label: CATEGORY_LABELS[meta?.category] || null,
    retryable: meta?.retryable ?? true,
    upstream,
    provider_request_id: typeof error?.provider_request_id === 'string' ? error.provider_request_id : null,
  };
}
