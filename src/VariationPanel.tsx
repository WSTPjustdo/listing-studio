import { useEffect, useState } from "react";
import { api } from "./api";
import type { VariationCheckContent } from "./types";

const SEVERITY: Record<string, { color: string; bg: string; label: string }> = {
  blocking: { color: "#b91c1c", bg: "#fef2f2", label: "阻断" },
  warning: { color: "#a16207", bg: "#fefce8", label: "待核实" },
};

export default function VariationPanel({
  listingId,
  version,
}: {
  listingId: string;
  version: number;
}) {
  const [data, setData] = useState<VariationCheckContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<VariationCheckContent>(
      `/api/listings/${listingId}/variation-check?version=${version}`,
    )
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
  if (!data) return <p className="helper">正在核对变体一致性…</p>;

  return (
    <div style={{ display: "grid", gap: "14px" }}>
      <p className="helper">{data.notice}</p>
      <div style={{ fontSize: "13px", color: "#4b5563" }}>
        {data.variation ? (
          <>
            父 SKU：<strong>{data.variation.parent_sku || "未填"}</strong>
            <span style={{ margin: "0 10px", color: "#d1d5db" }}>·</span>
            主题：<strong>{data.variation.theme || "未填"}</strong>
            <span style={{ margin: "0 10px", color: "#d1d5db" }}>·</span>
            关系：<strong>{data.variation.relationship_type || "未填"}</strong>
          </>
        ) : (
          "该商品未登记父子变体（按单件商品处理）。"
        )}
      </div>
      {data.issues.length === 0 ? (
        <p className="helper" style={{ color: "#047857" }}>
          未发现可确定的变体一致性问题。
        </p>
      ) : (
        <div style={{ display: "grid", gap: "8px" }}>
          {data.issues.map((it) => {
            const s = SEVERITY[it.severity] || SEVERITY.warning;
            return (
              <div
                key={it.key}
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
                  <strong style={{ fontSize: "13px" }}>{it.label}</strong>
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
                    {s.label}
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: "12px", color: "#4b5563" }}>{it.reason}</p>
                <p style={{ margin: 0, fontSize: "12px", color: "#6b7280" }}>下一步：{it.action}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
