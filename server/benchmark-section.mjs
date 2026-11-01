// 历史聚合样本对照。只匹配美国站英文，不把缺原始样本的统计当作当前市场证据。
//
// 为什么单独一个文件：`server/report.mjs` 与 `server/listing-report.mjs` 是队友正在动的地方，
// 这里只新增模块、在组装处加一次调用，冲突面最小。
//
// 印刷约束：报告是要打印的，所以**不能只靠颜色**区分三档，必须有字符标记（▲ ✓ ·），
// 黑白打印出来也读得懂。

import { compareToListing, loadBaseline } from "./market-benchmark.mjs";
import { escapeHtml as esc } from "./report.mjs";
import { AppError } from "./domain.mjs";

const MARK = { attention: "▲", ok: "✓", info: "·" };
const VERDICT = { attention: "与历史样本不同", ok: "与历史样本相近", info: "样本对照" };
export const BENCHMARK_PROVENANCE_NOTICE = "队友提供历史聚合快照，原始样本待补。该统计未经本机原始样本核对，不代表当前在售市场。";
export const BENCHMARK_UNSUPPORTED_NOTICE = "当前站点及文案语言暂无匹配的历史聚合基线，暂不提供写法对照建议。";

export function recordedBenchmarkScope(record) {
  return {
    marketplace: String(record?.guided_plan?.marketplace ?? record?.rule_pack_snapshot?.scope?.marketplace ?? record?.marketplace ?? "US").toUpperCase(),
    language: String(record?.language ?? record?.guided_plan?.language ?? "en").toLowerCase(),
  };
}

export function benchmarkData(content, { marketplace = "US", language = "en", baseline } = {}) {
  const scope = { marketplace: String(marketplace).toUpperCase(), language: String(language).toLowerCase() };
  if (scope.marketplace !== "US" || scope.language !== "en")
    return { supported: false, ...scope, baseline: null, attention: 0, facts: [], notice: BENCHMARK_UNSUPPORTED_NOTICE };
  const historical = baseline ?? loadBaseline();
  if (historical.schema !== "market-baseline/1") throw new Error("历史聚合基线格式无效。");
  if (historical.scope?.marketplace !== "amazon.com")
    return { supported: false, ...scope, baseline: null, attention: 0, facts: [], notice: BENCHMARK_UNSUPPORTED_NOTICE };
  const result = compareToListing(content, historical);
  return {
    supported: true, ...scope, baseline: result.baseline.scope,
    attention: result.attention,
    facts: result.facts.map(fact => ({
      ...fact,
      sentence: fact.sentence.replaceAll("同类在售商品", "历史样本中的商品").replaceAll("同类", "历史样本").replaceAll("平台的新要求是", "所用规则包要求"),
    })),
    notice: BENCHMARK_PROVENANCE_NOTICE,
  };
}

// Query parameters can confirm the saved scope, never relabel a stored foreign-market version.
export function benchmarkForRecord(record, requestedScope = {}) {
  const actual = recordedBenchmarkScope(record);
  if ((requestedScope.marketplace != null && String(requestedScope.marketplace).toUpperCase() !== actual.marketplace)
    || (requestedScope.language != null && String(requestedScope.language).toLowerCase() !== actual.language))
    throw new AppError("BENCHMARK_SCOPE_MISMATCH", "请求的站点或语言与已保存文案不一致，请按该版本原范围读取。", 409);
  return benchmarkData(record.content, actual);
}

export function benchmarkSection(content, options = {}) {
  if (!content || (!content.title && !(content.bullet_points || []).length)) return "";
  let result;
  try {
    result = benchmarkData(content, options);
  } catch {
    // 基线读不到时，宁可这一节不出现，也不许拿半截数据糊一份结论。
    return "";
  }
  if (!result.supported)
    return `<h2>历史样本写法对照</h2><p class="muted">${esc(result.notice)}</p>`;
  const scope = result.baseline;
  const rows = result.facts
    .map(
      (fact) =>
        `<li><strong>${MARK[fact.level]} ${esc(VERDICT[fact.level])}：${esc(fact.sentence)}</strong></li>`,
    )
    .join("");
  return (
    `<h2>历史样本写法对照（${scope.n} 条 · ${esc(scope.sample_date)} 快照）</h2>` +
    `<p class="muted">${esc(result.notice)}</p>` +
    `<p>${esc(result.attention === 0 ? "在已对照的几项上，没有明显区别于该历史样本的写法。" : `有 ${result.attention} 处写法与该历史样本不同，下面逐条列出。`)}</p>` +
    `<ul>${rows}</ul>` +
    `<p class="muted">口径：${esc(scope.category)} / ${esc(scope.marketplace)}，${esc(scope.method)}（${esc(scope.excludes)}）。` +
    `样本只有 ${scope.n} 条，说的是「这一批历史统计中的写法」，不是整个市场的结论；` +
    `同类这么写也不等于这么做就对，最终以平台规则和商品真实情况为准。</p>`
  );
}

export { compareToListing, loadBaseline };
