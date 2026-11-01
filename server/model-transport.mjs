import { AppError } from './domain.mjs';

// Persist only known transport codes. Error messages can contain URLs, headers or credentials.
const PRECONNECT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const TRANSPORT_CODES = new Set([...PRECONNECT_CODES, ...TIMEOUT_CODES, 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);

export function transportDetails(error, phase = 'request') {
  const codes = new Set();
  const seen = new Set();
  let timedOut = false;
  let ambiguous = false;
  let explicitlyAborted = false;
  function visit(value, depth = 0, aggregateBranch = false) {
    if (!value || typeof value !== 'object') { if (aggregateBranch) ambiguous = true; return; }
    if (seen.has(value)) return;
    if (depth > 8) { ambiguous = true; return; }
    seen.add(value);
    if (value.name === 'TimeoutError' || value.name === 'AbortError') { timedOut = true; explicitlyAborted = true; }
    if (TRANSPORT_CODES.has(value.code)) codes.add(value.code);
    else if (value.code) ambiguous = true;
    const children = Array.isArray(value.errors) ? value.errors : [];
    if (aggregateBranch && !value.code && !value.cause && !children.length) ambiguous = true;
    visit(value.cause, depth + 1);
    if (children.length > 8) ambiguous = true;
    children.slice(0, 8).forEach(item => visit(item, depth + 1, true));
  }
  visit(error);
  const list = [...codes];
  timedOut ||= list.some(code => TIMEOUT_CODES.has(code));
  const preconnect = phase === 'request' && !ambiguous && !explicitlyAborted && list.length > 0 && list.every(code => PRECONNECT_CODES.has(code));
  return { phase: preconnect ? 'connect' : phase, kind: timedOut ? 'timeout' : 'connection', codes: list };
}

function transportFailure(error, phase, trace) {
  const detail = transportDetails(error, phase);
  const code = detail.kind === 'timeout' ? 'MODEL_TIMEOUT' : 'MODEL_CONNECTION_FAILED';
  const suffix = detail.codes.length ? `（${detail.codes.join(' / ')}）` : '';
  const message = phase === 'response_body'
    ? `读取模型响应${detail.kind === 'timeout' ? '超时' : '中断'}${suffix}；服务端执行情况未知，本次未保存，请查看运行记录后重试。`
    : `模型${detail.kind === 'timeout' ? '连接或响应超时' : '连接失败'}${suffix}，请检查地址与网络；本次未保存。`;
  const failure = new AppError(code, message, code === 'MODEL_TIMEOUT' ? 504 : 502);
  failure.transport_error = detail;
  if (trace) trace.transport_error = detail;
  return failure;
}

/** Retry once only when a connection provably could not be established, within one deadline. */
export async function fetchModelResponse(endpoint, options, { timeoutMs, trace, fetcher = fetch, retryConnection = true } = {}) {
  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  let firstFailure;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetcher(endpoint, { ...options, signal });
      if (firstFailure && trace) {
        trace.connection_retry = { attempts: attempt, recovered: true, failed_attempt: firstFailure };
        delete trace.transport_error;
      }
      return response;
    } catch (error) {
      const failure = transportFailure(error, 'request', trace);
      const elapsed = Date.now() - started;
      if (attempt === 1 && retryConnection && failure.transport_error.phase === 'connect' && !signal.aborted && timeoutMs - elapsed >= 1000) {
        firstFailure = { elapsed_ms: elapsed, transport_error: failure.transport_error };
        continue;
      }
      if (firstFailure && trace) trace.connection_retry = { attempts: attempt, recovered: false, failed_attempt: firstFailure };
      throw failure;
    }
  }
}

/** A broken/aborted body is a transport failure, never a malformed-JSON inference retry. */
export async function readModelJson(response, trace) {
  try { return await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) throw error;
    throw transportFailure(error, 'response_body', trace);
  }
}

export function modelProcessingFailure(error) {
  return error instanceof AppError ? error : new AppError('MODEL_PROCESSING_FAILED', '处理模型响应时发生内部错误，本次未保存；请保留运行记录联系开发者。', 500);
}

/** Allowlisted transport metadata for the public call ledger. */
export function transportMetadata(entry = {}) {
  const details = value => value && ['connect', 'request', 'response_body'].includes(value.phase) && ['timeout', 'connection'].includes(value.kind)
    ? { phase: value.phase, kind: value.kind, codes: Array.isArray(value.codes) ? value.codes.filter(code => TRANSPORT_CODES.has(code)).slice(0, 8) : [] }
    : null;
  const error = details(entry.transport_error);
  const retry = entry.connection_retry;
  const failed = details(retry?.failed_attempt?.transport_error);
  return {
    ...(error ? { transport_error: error } : {}),
    ...(retry?.attempts === 2 && failed ? { connection_retry: { attempts: 2, recovered: retry.recovered === true, failed_attempt: {
      elapsed_ms: Number.isFinite(retry.failed_attempt.elapsed_ms) && retry.failed_attempt.elapsed_ms >= 0 ? retry.failed_attempt.elapsed_ms : null,
      transport_error: failed,
    } } } : {}),
  };
}
