// 商品证据生命周期：把已提交的材料按核验状态、有效期、支持的宣称整理成台账。
// 只读、确定性；文件存在不等于报告真实，也不等于某个宣称已获得充分支持。
const STATUS_LABEL = {
  unverified: "未核验",
  source_verified: "已核验文件来源",
  scope_verified: "已核验适用范围",
  not_applicable: "不适用",
  expired: "已过期",
  conflict: "存在冲突",
};

export function buildEvidenceBoard(product, { now = Date.now() } = {}) {
  const subs = product?.evidence_submissions || [];
  const items = subs.map((s) => {
    let status = s.verification_status || "unverified";
    const expiryMs = s.expiry_date ? new Date(s.expiry_date).getTime() : NaN;
    const expired = Number.isFinite(expiryMs) && expiryMs < now;
    if (expired) status = "expired";
    const claims =
      Array.isArray(s.supported_claims) && s.supported_claims.length
        ? s.supported_claims
        : s.target_label
          ? [s.target_label]
          : [];
    return {
      source_id: s.source_id,
      title: s.title || "未命名材料",
      target: s.target || "",
      target_label: s.target_label || "",
      applicable_model: s.applicable_model || "",
      publisher: s.publisher || "",
      submitted_at: s.submitted_at || "",
      status,
      status_label: STATUS_LABEL[status] || status,
      expired,
      expiry_date: s.expiry_date || null,
      issuing_organization: s.issuing_organization || null,
      test_standard: s.test_standard || null,
      supported_claims: claims,
      reviewer: s.reviewer || null,
      history: Array.isArray(s.verification_history) ? s.verification_history : [],
    };
  });
  const count = (st) => items.filter((i) => i.status === st).length;
  return {
    total: items.length,
    verified: items.filter((i) => ["source_verified", "scope_verified"].includes(i.status)).length,
    unverified: count("unverified"),
    expired: count("expired"),
    conflict: count("conflict"),
    items,
    notice:
      "证据状态按商品档案记录展示；文件存在不等于报告真实，也不等于某个宣称已获得充分支持，最终需人工核验。",
  };
}
