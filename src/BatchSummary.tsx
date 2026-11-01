export type BatchSummaryData = {
  rows_total: number;
  rows_preserved: number;
  rows_without_record: number;
  rows_concluded: number;
  rows_clean: number;
  rows_with_issues: number;
  rows_incomplete_checks: number;
  issues_total: number;
  attention: { row: number; sku: string; name: string; why: string; next: string }[];
  incomplete_rows: { row: number; sku: string; completed?: number; total?: number; issues: number }[];
};

export type BatchRuleWork = {
  rule_id: string;
  rule_pack_version?: string | null;
  title: string;
  rows_affected: number;
  count: number;
  repair: string;
  basis_label: string;
  in_rule_pack: boolean;
  historical_basis_known?: boolean;
  /** 这条规则在本批命中的、各不相同的具体建议（服务端 `ruleWorklist` 给）。 */
  advices?: string[];
};

export default function BatchSummary({
  summary,
  worklist = [],
}: {
  summary: BatchSummaryData;
  worklist?: BatchRuleWork[];
}) {
  return (
    <section className="batch-summary" aria-label="批次汇总">
      <div className="batch-kpis">
        <div className="batch-kpi">
          <strong>{summary.rows_concluded}</strong>
          <span>有审阅结论（共 {summary.rows_total} 行）</span>
        </div>
        <div className="batch-kpi ok">
          <strong>{summary.rows_clean}</strong>
          <span>范围内未发现问题且检查完成</span>
        </div>
        <div className="batch-kpi warn">
          <strong>{summary.rows_with_issues}</strong>
          <span>有问题（共 {summary.issues_total} 处）</span>
        </div>
        <div className="batch-kpi muted">
          <strong>{summary.rows_incomplete_checks}</strong>
          <span>检查未全或仍需核对</span>
        </div>
      </div>
      <p className="helper">
        父体保留 {summary.rows_preserved} 行，未送审；失败、排队、跳过及资料阻断行不计入有结论的行。
        有问题与检查未全的行可能重叠。已完成不代表平台审核通过。
      </p>
      {!!summary.rows_without_record && (
        <p className="warm-text" role="alert">
          有 {summary.rows_without_record} 行标为完成但未取得审阅记录，暂不计入结果统计。
        </p>
      )}
      {!!worklist.length && (
        <div className="batch-summary-block">
          <h3>按规则集中处理</h3>
          <ul>
            {worklist.slice(0, 3).map((rule) => (
              <li key={`${rule.rule_pack_version}-${rule.rule_id}`}>
                <code>{rule.rule_id}</code> {rule.title}
                <span className="batch-summary-meta">
                  影响 {rule.rows_affected} 行 · {rule.count} 处 ·{" "}
                  {rule.in_rule_pack ? rule.basis_label || "依据未记录" : "本版规则依据未记录"}
                </span>
                <p>{rule.in_rule_pack ? rule.repair : "请按这一版的实际结论人工核对，不套用当前规则。"}</p>
                {rule.in_rule_pack && (rule.advices?.length || 0) > 1 && (
                  <p className="warm-text">
                    这条规则本批命中了 {rule.advices?.length} 种情况，改法不同（不是一句话能统一改的）——
                    每种情况的具体改法见导出的 Excel 工作单。
                  </p>
                )}
              </li>
            ))}
          </ul>
          {worklist.length > 3 && <p className="helper">其余规则及完整行号见导出的 Excel 工作单。</p>}
        </div>
      )}
      {!!summary.attention.length && (
        <div className="batch-summary-block">
          <h3>先处理这些行</h3>
          <ul>
            {summary.attention.slice(0, 5).map((item) => (
              <li key={`${item.row}-${item.sku}`}>
                第 {item.row} 行 · {item.sku || "SKU 未提供"} · {item.name}
                <span className="batch-summary-meta">{item.why}</span>
                <p>{item.next}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!summary.incomplete_rows.length && (
        <div className="batch-summary-block">
          <h3>检查未全或仍需核对的行</h3>
          <ul>
            {summary.incomplete_rows.slice(0, 5).map((item) => (
              <li key={item.row}>
                第 {item.row} 行 · {item.sku || "SKU 未提供"}
                <span className="batch-summary-meta">
                  完成 {item.completed ?? "未知"}/{item.total ?? "未知"} 项检查
                </span>
                <p>{item.issues ? `已发现 ${item.issues} 条问题，未完成或仍需人工核对的部分继续保留。` : "已执行范围未发现问题，未查全或仍需核对的部分不能当作通过。"}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
