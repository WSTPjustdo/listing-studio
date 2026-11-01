import { useState } from "react";
import { post } from "./api";
import type { VocContent } from "./types";

export default function VocPanel({
  listingId,
  version,
}: {
  listingId: string;
  version: number;
}) {
  const [reviews, setReviews] = useState("");
  const [data, setData] = useState<VocContent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analyze() {
    if (!reviews.trim()) {
      setError("请先粘贴竞品差评（每行一条）。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await post<VocContent>(`/api/listings/${listingId}/voc?version=${version}`, {
        reviews,
      });
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "分析失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "14px" }}>
      <label style={{ display: "grid", gap: "6px", fontSize: "13px" }}>
        <strong>粘贴竞品 1–3 星差评（每行一条）</strong>
        <textarea
          value={reviews}
          onChange={(e) => setReviews(e.target.value)}
          rows={6}
          placeholder={"Broke after a week.\nHandles are too short.\nColor faded after washing."}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 10px",
            border: "1px solid #d9d9e3",
            borderRadius: "8px",
            fontSize: "13px",
            fontFamily: "inherit",
            resize: "vertical",
          }}
        />
      </label>
      <button
        className="primary-button"
        onClick={analyze}
        disabled={busy}
        style={{ justifySelf: "start" }}
      >
        {busy ? "分析中…" : "分析差评"}
      </button>
      {error && <p className="helper">{error}</p>}

      {data && (
        <>
          {data.notice && <p className="helper">{data.notice}</p>}

          <div>
            <strong style={{ fontSize: "13px" }}>
              确定性痛点词召回（{data.total_reviews} 条差评）
            </strong>
            {data.signals.length ? (
              <ul style={{ margin: "8px 0 0", paddingLeft: "18px", fontSize: "13px" }}>
                {data.signals.map((s) => (
                  <li key={s.term} style={{ marginBottom: "4px" }}>
                    {s.zh}（{s.term}）× {s.count}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="helper">未命中常见痛点词，可能需要模型语义分析。</p>
            )}
          </div>

          {data.model_used && (
            <>
              {data.pain_points.length > 0 && (
                <div>
                  <strong style={{ fontSize: "13px" }}>语义痛点（模型）</strong>
                  <ul style={{ margin: "8px 0 0", paddingLeft: "18px", fontSize: "13px" }}>
                    {data.pain_points.map((p, i) => (
                      <li key={i} style={{ marginBottom: "4px" }}>
                        <strong>{p.zh}</strong>（{p.theme}）— {p.evidence}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {data.grounded_bullets.length > 0 && (
                <div>
                  <strong style={{ fontSize: "13px" }}>打痛点卖点（仅用已登记事实）</strong>
                  <ul style={{ margin: "8px 0 0", paddingLeft: "18px", fontSize: "13px" }}>
                    {data.grounded_bullets.map((b, i) => (
                      <li key={i} style={{ marginBottom: "6px" }}>
                        <span style={{ color: "#6b7280" }}>[{b.theme}]</span> {b.bullet}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {data.unsupported.length > 0 && (
                <div style={{ color: "#b45309", fontSize: "13px" }}>
                  <strong>资料不支持、未生成卖点的痛点：</strong>
                  {data.unsupported.join("、")}
                </div>
              )}
            </>
          )}

          {data.gap_analysis && (
            <div
              style={{
                display: "grid",
                gap: "10px",
                borderTop: "1px solid #e3e3e8",
                paddingTop: "12px",
              }}
            >
              <strong style={{ fontSize: "13px" }}>竞品差异分析（VOC → 商品事实）</strong>
              <p className="helper" style={{ margin: 0 }}>{data.gap_analysis.notice}</p>
              {data.gap_analysis.strengthen.length > 0 && (
                <div>
                  <strong style={{ fontSize: "12px", color: "#047857" }}>可强化卖点</strong>
                  <ul style={{ margin: "6px 0 0", paddingLeft: "18px", fontSize: "13px" }}>
                    {data.gap_analysis.strengthen.map((s, i) => (
                      <li key={i} style={{ marginBottom: "4px" }}>
                        <span style={{ color: "#6b7280" }}>[{s.theme}]</span> {s.field}：{s.value}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {data.gap_analysis.needData.length > 0 && (
                <div>
                  <strong style={{ fontSize: "12px", color: "#c2410c" }}>需补资料</strong>
                  <ul style={{ margin: "6px 0 0", paddingLeft: "18px", fontSize: "13px" }}>
                    {data.gap_analysis.needData.map((n, i) => (
                      <li key={i} style={{ marginBottom: "4px" }}>
                        <span style={{ color: "#6b7280" }}>[{n.theme}]</span> 缺：{n.missing.join("、")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {data.gap_analysis.cannotProve.length > 0 && (
                <div>
                  <strong style={{ fontSize: "12px", color: "#6b7280" }}>无法证明</strong>
                  <ul style={{ margin: "6px 0 0", paddingLeft: "18px", fontSize: "13px" }}>
                    {data.gap_analysis.cannotProve.map((c, i) => (
                      <li key={i} style={{ marginBottom: "4px" }}>
                        <span style={{ color: "#6b7280" }}>[{c.theme}]</span> {c.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {data.gap_analysis.avoidClaims.length > 0 && (
                <div>
                  <strong style={{ fontSize: "12px", color: "#b91c1c" }}>不建议使用的表述</strong>
                  <ul style={{ margin: "6px 0 0", paddingLeft: "18px", fontSize: "13px" }}>
                    {data.gap_analysis.avoidClaims.map((a, i) => (
                      <li key={i} style={{ marginBottom: "4px" }}>
                        {a.claim}：{a.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
