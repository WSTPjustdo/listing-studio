import { useEffect, useState } from "react";
import { api } from "./api";
import type { EvidenceBoardContent, EvidenceBoardItem } from "./types";

const STATUS_COLOR: Record<string, string> = {
  unverified: "#c2410c",
  source_verified: "#047857",
  scope_verified: "#047857",
  not_applicable: "#6b7280",
  expired: "#b91c1c",
  conflict: "#7c3aed",
};

export default function EvidenceLifecyclePanel({
  listingId,
  version,
}: {
  listingId: string;
  version: number;
}) {
  const [data, setData] = useState<EvidenceBoardContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<EvidenceBoardContent>(`/api/listings/${listingId}/evidence?version=${version}`)
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : "加载失败");
      });
    return () => {
      live = false;
    };
  }, [listingId, version]);

  if (error) return <p className="helper">{error}</p>;
  if (!data) return <p className="helper">正在整理证据台账…</p>;

  const card = (item: EvidenceBoardItem) => {
    const color = STATUS_COLOR[item.status] || "#6b7280";
    return (
      <div
        key={item.source_id}
        style={{
          border: "1px solid #e3e3e8",
          borderLeft: `4px solid ${color}`,
          borderRadius: "8px",
          padding: "10px 12px",
          display: "grid",
          gap: "4px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: "10px" }}>
          <strong style={{ fontSize: "13px" }}>{item.title}</strong>
          <span style={{ fontSize: "11px", color, whiteSpace: "nowrap" }}>
            {item.status_label}
          </span>
        </div>
        <p style={{ margin: 0, fontSize: "12px", color: "#4b5563" }}>
          支持：{item.supported_claims.join("、") || "未标注"}
          {item.applicable_model ? ` · 适用型号：${item.applicable_model}` : ""}
        </p>
        {item.issuing_organization && (
          <p style={{ margin: 0, fontSize: "12px", color: "#6b7280" }}>
            出具方：{item.issuing_organization}
            {item.test_standard ? ` · 标准：${item.test_standard}` : ""}
          </p>
        )}
        {item.expiry_date && (
          <p style={{ margin: 0, fontSize: "12px", color: item.expired ? "#b91c1c" : "#6b7280" }}>
            有效期：{item.expiry_date}
          </p>
        )}
        {item.reviewer && (
          <p style={{ margin: 0, fontSize: "12px", color: "#6b7280" }}>核验人：{item.reviewer}</p>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: "grid", gap: "14px" }}>
      <p className="helper">{data.notice}</p>
      <div
        style={{
          display: "flex",
          gap: "16px",
          fontSize: "13px",
          background: "#f7f8f5",
          border: "1px solid #e3e3e8",
          borderRadius: "10px",
          padding: "12px 16px",
        }}
      >
        <span>共 <strong>{data.total}</strong> 份</span>
        <span style={{ color: "#047857" }}>已核验 <strong>{data.verified}</strong></span>
        <span style={{ color: "#c2410c" }}>未核验 <strong>{data.unverified}</strong></span>
        <span style={{ color: "#b91c1c" }}>已过期 <strong>{data.expired}</strong></span>
        <span style={{ color: "#7c3aed" }}>冲突 <strong>{data.conflict}</strong></span>
      </div>
      {data.items.length === 0 ? (
        <p className="helper">尚未提交任何证据材料。可在「编辑资料」或补资料交接中提交。</p>
      ) : (
        <div style={{ display: "grid", gap: "8px" }}>{data.items.map(card)}</div>
      )}
    </div>
  );
}
