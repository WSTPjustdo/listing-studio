import type { Listing } from "./types";

export default function ParameterCoverage({
  review,
  onLocate,
}: {
  review: Listing["review"];
  onLocate: (field: string) => void;
}) {
  const coverage = review.parameter_coverage;
  const unmodeled = review.unmodeled_parameters || [];
  if (!coverage && !unmodeled.length) return null;

  return (
    <section className="parameter-coverage" aria-label="参数核对范围">
      <h3>参数核对范围</h3>
      {coverage && (
        <p>
          已识别 {coverage.recognized} 项 · 已关联 {coverage.matched} 项 · 待核对{" "}
          {coverage.unresolved} 项 · 未覆盖 {coverage.not_covered} 项
        </p>
      )}
      <p className="helper">
        参数已关联不代表整句、认证或性能成立。未覆盖的参数没有执行对照，不能算作已通过；请保留原文并人工核验。
      </p>
      {!!unmodeled.length && (
        <details>
          <summary>查看未覆盖参数 · {unmodeled.length} 处原文</summary>
          {unmodeled.map((item, index) => (
            <div className="parameter-coverage-item" key={`${item.field_path}-${index}`}>
              <p>
                <code>{item.original}</code> · {item.field_label || item.field}
              </p>
              <p className="helper">{item.reason}</p>
              <button className="text-button" onClick={() => onLocate(item.field_path)}>
                定位原文
              </button>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
