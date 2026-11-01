import { useEffect, useState } from "react";
import { api } from "./api";
import type { RolesContent } from "./types";

export default function RolesPanel({
  listingId,
  version,
}: {
  listingId: string;
  version: number;
}) {
  const [data, setData] = useState<RolesContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<RolesContent>(`/api/listings/${listingId}/roles?version=${version}`)
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
  if (!data) return <p className="helper">正在生成协同看板…</p>;

  const roleColors: Record<string, string> = {
    合规: "#1d4ed8",
    美工: "#7c3aed",
    采购: "#0f766e",
    运营: "#b45309",
  };

  return (
    <div style={{ display: "grid", gap: "14px" }}>
      <p className="helper">{data.notice}</p>
      {data.counts && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "8px",
          }}
        >
          {[
            { label: "阻断问题", value: data.counts.blocking, color: "#b91c1c" },
            { label: "待核实", value: data.counts.needs_review, color: "#a16207" },
            { label: "优化建议", value: data.counts.suggestion, color: "#4b5563" },
          ].map((c) => (
            <div
              key={c.label}
              style={{
                background: "#f7f8f5",
                border: "1px solid #e3e3e8",
                borderRadius: "8px",
                padding: "10px 12px",
              }}
            >
              <strong style={{ fontSize: "20px", color: c.color }}>{c.value}</strong>
              <p style={{ margin: 0, fontSize: "12px", color: "#6b7280" }}>{c.label}</p>
            </div>
          ))}
        </div>
      )}
      {data.counts && (data.counts.evidence_unverified || data.counts.evidence_expired) ? (
        <p style={{ fontSize: "12px", color: "#6b7280", margin: 0 }}>
          证据待核验 {data.counts.evidence_unverified} 份、已过期 {data.counts.evidence_expired} 份（详见「证据台账」）。
        </p>
      ) : null}
      <p style={{ fontSize: "13px" }}>
        共 <strong>{data.total}</strong> 项待补资料。</p>
      {data.board.map((col) => (
        <div
          key={col.role}
          style={{
            border: "1px solid #e3e3e8",
            borderLeft: `4px solid ${roleColors[col.role] || "#9ca3af"}`,
            borderRadius: "8px",
            padding: "10px 12px",
          }}
        >
          <strong style={{ fontSize: "13px", color: roleColors[col.role] }}>
            {col.role}（{col.items.length}）
          </strong>
          {col.items.length ? (
            <ul style={{ margin: "8px 0 0", paddingLeft: "18px", fontSize: "13px" }}>
              {col.items.map((it, i) => (
                <li key={i} style={{ marginBottom: "5px" }}>
                  <strong>{it.label}</strong>
                  {it.reason ? `：${it.reason}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="helper" style={{ margin: "6px 0 0" }}>无</p>
          )}
        </div>
      ))}
    </div>
  );
}
