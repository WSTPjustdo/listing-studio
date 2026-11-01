// 风险中心：在现有「补资料协同看板」基础上补充风险分级统计。
// 计数来自当次审核的问题与待补资料；责任岗位为经验建议，最终由商家确认。
import { classifyRoles } from "./roles.mjs";

export function buildRiskCenter(record) {
  const review = record?.review || {};
  const issues = Array.isArray(review.issues) ? review.issues : [];
  const missing = Array.isArray(review.missing_data) ? review.missing_data : [];
  const evidence = Array.isArray(record?.product_snapshot?.evidence_submissions)
    ? record.product_snapshot.evidence_submissions
    : [];
  const sev = (s) => issues.filter((i) => i.severity === s).length;
  const now = Date.now();
  const evUnverified = evidence.filter(
    (e) => !e.verification_status || e.verification_status === "unverified",
  ).length;
  const evExpired = evidence.filter((e) => {
    const ms = e.expiry_date ? new Date(e.expiry_date).getTime() : NaN;
    return Number.isFinite(ms) && ms < now;
  }).length;
  const roles = classifyRoles(missing);
  return {
    total: roles.total,
    board: roles.board,
    counts: {
      blocking: sev("blocking"),
      needs_review: sev("needs_review"),
      suggestion: sev("suggestion"),
      missing_data: missing.length,
      evidence_unverified: evUnverified,
      evidence_expired: evExpired,
    },
    notice:
      "风险分级按当次审核的问题与待补资料统计；责任岗位为经验建议，最终由商家确认，处理完成不等于风险已消除。",
  };
}
