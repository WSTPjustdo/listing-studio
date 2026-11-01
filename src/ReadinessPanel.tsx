import { useEffect, useState } from "react";
import { api } from "./api";
import type { ReadinessContent, ReadinessItem } from "./types";

const STATUS_STYLE: Record<string, { color: string; bg: string }> = {
  complete: { color: "#047857", bg: "#ecfdf5" },
  blocking: { color: "#b91c1c", bg: "#fef2f2" },
  todo: { color: "#c2410c", bg: "#fff7ed" },
  warning: { color: "#a16207", bg: "#fefce8" },
  na: { color: "#6b7280", bg: "#f9fafb" },
};

export default function ReadinessPanel({
  listingId,
  version,
}: {
  listingId: string;
  version: number;
}) {
  const [data, setData] = useState<ReadinessContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<ReadinessContent>(`/api/listings/${listingId}/readiness?version=${version}`)
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
  if (!data) return <p className="helper">正在检查上架前完整度…</p>;

  const bar = (item: ReadinessItem) => {
    const s = STATUS_STYLE[item.status] || STATUS_STYLE.na;
    return (
      <div
        key={item.key}
        style={{
          border: "1px solid #e3e3e8",
          borderLeft: `4px solid ${s.color}`,
          borderRadius: "8px",
          padding: "10px 12px",
          display: "grid",
          gap: "4px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: "10px" }}>
          <strong style={{ fontSize: "13px" }}>{item.label}</strong>
          <span
            style={{
              fontSize: "11px",
              color: s.color,
              background: s.bg,
              borderRadius: "999px",
              padding: "2px 8px",
              whiteSpace: "nowrap",
            }}
          >
            {item.status_label}
          </span>
        </div>
        <p style={{ margin: 0, fontSize: "12px", color: "#4b5563" }}>{item.reason}</p>
        {item.action && (
          <p style={{ margin: 0, fontSize: "12px", color: "#6b7280" }}>下一步：{item.action}</p>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: "grid", gap: "14px" }}>
      <p className="helper">{data.notice}</p>
      <div
        style={{
          display: "grid",
          gap: "8px",
          background: "#f7f8f5",
          border: "1px solid #e3e3e8",
          borderRadius: "10px",
          padding: "14px 16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: "10px" }}>
          <strong style={{ fontSize: "26px" }}>{data.score}%</strong>
          <span style={{ fontSize: "12px", color: "#6b7280" }}>上架前完整度（按当前商品档案）</span>
        </div>
        <div style={{ height: "9px", background: "#e5e7eb", borderRadius: "999px", overflow: "hidden" }}>
          <div
            style={{
              height: "9px",
              width: `${data.score}%`,
              background: data.blocking ? "#dc2626" : "#16a34a",
              borderRadius: "999px",
            }}
          />
        </div>
        <div style={{ display: "flex", gap: "16px", fontSize: "12px", color: "#4b5563" }}>
          <span>已完成 <strong>{data.complete}</strong></span>
          <span style={{ color: "#b91c1c" }}>阻断 <strong>{data.blocking}</strong></span>
          <span style={{ color: "#c2410c" }}>待补充 <strong>{data.todo}</strong></span>
          <span style={{ color: "#a16207" }}>待核实 <strong>{data.warning}</strong></span>
        </div>
      </div>
      <div style={{ display: "grid", gap: "8px" }}>{data.items.map(bar)}</div>
    </div>
  );
}
