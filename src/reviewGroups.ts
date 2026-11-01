import type { Issue, Listing } from "./types";
export function groupReviewIssues(
  record: Listing,
  issues: Issue[] = record.review.issues,
): { key: string; label: string; issues: Issue[] }[] {
  const groups = new Map<
    string,
    { key: string; label: string; issues: Issue[] }
  >();
  for (const issue of issues) {
    let key = issue.issue_id,
      label = issue.title;
    const evidence = record.review.evidence?.find(
      (e) => e.field_path === issue.field_path && e.claim === issue.original,
    );
    const parameters = evidence?.unresolved_parameters || [];
    const signatures = [
      ...new Set(
        parameters.map((p) =>
          JSON.stringify([
            p.field,
            p.original.trim().toLowerCase(),
            p.status,
            p.reason,
          ]),
        ),
      ),
    ];
    if (issue.rule_id === "EVID-01" && signatures.length === 1) {
      const p = parameters[0];
      // Bare numbers may describe different properties. Only group them with an explicit shared unit.
      const units = [
        ...issue.original.matchAll(
          /\b\d+(?:\.\d+)?\s*(-?inch(?:es)?\b|["″]|cm\b|kg\b|lbs?\b|liters?\b|gsm\b)/gi,
        ),
      ].map((m) => m[1].replace(/^-?inch(?:es)?$|["″]/i, "inch").toLowerCase());
      const unit =
        p.field === "unclassified_parameter"
          ? [...new Set(units)].join("|")
          : p.field;
      if (unit && !unit.includes("|")) {
        key = JSON.stringify([
          issue.rule_id,
          issue.severity,
          evidence?.product_ref,
          signatures[0],
          unit,
        ]);
        label = `核对参数 ${p.original}${unit === "inch" ? " 英寸" : ""} 的来源`;
      }
    }
    const group = groups.get(key) || { key, label, issues: [] };
    group.issues.push(issue);
    groups.set(key, group);
  }
  return [...groups.values()];
}
