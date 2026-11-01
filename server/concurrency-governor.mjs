/** Auto is opt-in. It adjusts row slots only and never retries or changes a conclusion. */
export const AUTO_DEFAULTS = Object.freeze({ min: 1, max: 4, start: 1, growAfter: 3, cooldownMs: 4000, historyLimit: 20 });
export const isRateLimitCode = code => typeof code === 'string' && (code === 'MODEL_HTTP_429' || /RATE_LIMIT/.test(code));
export function createGovernor(options = {}) {
  const positive = (value, fallback) => Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
  const min = positive(options.min, AUTO_DEFAULTS.min);
  const max = Math.max(min, Math.min(4, positive(options.max, AUTO_DEFAULTS.max)));
  const growAfter = positive(options.growAfter, AUTO_DEFAULTS.growAfter);
  const cooldownMs = Number.isFinite(options.cooldownMs) && options.cooldownMs >= 0 ? options.cooldownMs : AUTO_DEFAULTS.cooldownMs;
  const historyLimit = positive(options.historyLimit, AUTO_DEFAULTS.historyLimit);
  const now = options.now || Date.now;
  let current = Math.min(max, Math.max(min, positive(options.start, AUTO_DEFAULTS.start)));
  let streak = 0, pausedUntil = 0, backoffUntil = 0, grown = 0, shrunk = 0;
  const history = [];
  const record = (from, to, reason) => {
    history.push({ at: new Date(now()).toISOString(), from, to, reason });
    if (history.length > historyLimit) history.shift();
  };
  return {
    slots: () => current,
    backoffMs: () => Math.max(0, backoffUntil - now()),
    success() {
      streak += 1;
      if (streak < growAfter || current >= max || now() < pausedUntil) return current;
      const from = current;
      current += 1; streak = 0; pausedUntil = now() + cooldownMs; grown += 1;
      record(from, current, `连续 ${growAfter} 行成功`);
      return current;
    },
    failure(code) {
      streak = 0;
      if (!isRateLimitCode(code)) return current;
      const from = current;
      current = Math.max(min, Math.floor(current / 2));
      pausedUntil = backoffUntil = now() + cooldownMs;
      if (current < from) shrunk += 1;
      record(from, current, `限流 ${code}，暂停派发 ${cooldownMs} ms`);
      return current;
    },
    snapshot: () => ({ mode: 'auto', current, min, max, grow_after: growAfter, cooldown_ms: cooldownMs,
      cooling_down_ms: Math.max(0, pausedUntil - now()), backoff_ms: Math.max(0, backoffUntil - now()),
      grown, shrunk, history: history.slice(-6) }),
  };
}
