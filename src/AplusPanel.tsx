import { useEffect, useState } from "react";
import { api } from "./api";
import type { AplusContent } from "./types";

const STATUS_ZH: Record<string, string> = {
  merchant_confirmed: "商家确认",
  public_source: "公开来源",
  unknown: "未知",
  synthetic_demo: "演示",
};

export default function AplusPanel({
  listingId,
  version,
}: {
  listingId: string;
  version: number;
}) {
  const [data, setData] = useState<AplusContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<AplusContent>(`/api/listings/${listingId}/aplus?version=${version}`)
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
  if (!data) return <p className="helper">正在生成 A+ 对比表…</p>;

  const rows = data.comparison_chart;
  const th: React.CSSProperties = {
    textAlign: "left",
    padding: "8px 10px",
    borderBottom: "1px solid #e3e3e8",
    fontSize: "12px",
    color: "#6b7280",
    fontWeight: 600,
  };
  const td: React.CSSProperties = {
    padding: "8px 10px",
    borderBottom: "1px solid #f0f0f4",
    fontSize: "13px",
    verticalAlign: "top",
  };

  return (
    <div style={{ display: "grid", gap: "14px" }}>
      <p className="helper">{data.module_copy.note}</p>

      {rows.length ? (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            border: "1px solid #e3e3e8",
            borderRadius: "8px",
            overflow: "hidden",
          }}
        >
          <thead>
            <tr>
              <th style={th}>参数</th>
              <th style={th}>值</th>
              <th style={th}>登记状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.field}>
                <td style={td}>
                  {r.label_zh}
                  <span style={{ display: "block", color: "#9ca3af", fontSize: "11px" }}>
                    {r.label_en}
                  </span>
                </td>
                <td style={{ ...td, fontWeight: 500 }}>{r.value}</td>
                <td style={td}>{STATUS_ZH[r.status] || r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="helper">商品尚未登记任何可入表的参数。</p>
      )}

      {data.missing_parameters.length > 0 && (
        <div
          style={{
            background: "#fff7ed",
            border: "1px solid #fed7aa",
            borderRadius: "8px",
            padding: "10px 12px",
            fontSize: "13px",
          }}
        >
          <strong>未登记参数（可继续补充后刷新）：</strong>{" "}
          {data.missing_parameters.map((m) => m.label_zh).join("、")}
        </div>
      )}

      <div>
        <strong style={{ fontSize: "13px" }}>A+ 图片配文候选（纯事实，非营销文案）</strong>
        <ul style={{ margin: "8px 0 0", paddingLeft: "18px", fontSize: "13px" }}>
          {data.module_copy.feature_bullets.map((b, i) => (
            <li key={i} style={{ marginBottom: "4px" }}>{b}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
