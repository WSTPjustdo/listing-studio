import { useEffect, useRef, useState } from "react";
import { api, post } from "./api";
import { createRequestId } from "./requestId";
import { waitForRun } from "./runPolling";
import type { Content, Listing, Run, VariantContent } from "./types";

const ANGLE_ZH: Record<string, string> = {
  spec_first: "参数清晰",
  scenario_first: "场景导向",
  concise: "简洁自然",
};

function copyContent(c: Content) {
  return [c.title, c.item_highlights, ...c.bullet_points.map((b) => b.text), c.description]
    .filter(Boolean)
    .join("\n\n");
}

export default function VariantsPanel({
  listingId,
  version,
  onAdopted,
  onAdoptingChange,
  onGeneratingChange,
}: {
  listingId: string;
  version: number;
  onAdopted: (record: Listing) => void;
  onAdoptingChange: (adopting: boolean) => void;
  onGeneratingChange: (generating: boolean) => void;
}) {
  const [data, setData] = useState<VariantContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adopting, setAdopting] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const adoptingRef = useRef(false);
  const generatingRef = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const endpoint = `/api/listings/${listingId}/variants?version=${version}`;
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setData(null);
    setError(null);
    api<VariantContent | null>(endpoint)
      .then((saved) => { if (alive) setData(saved); })
      .catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : "读取已保存变体失败"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [endpoint]);

  async function generate() {
    if (generatingRef.current || adoptingRef.current || loading) return;
    generatingRef.current = true;
    setBusy(true);
    onGeneratingChange(true);
    setError(null);
    try {
      const generated = await post<VariantContent>(endpoint, {});
      if (mounted.current) setData(generated);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "生成失败");
    } finally {
      generatingRef.current = false;
      if (mounted.current) setBusy(false);
      onGeneratingChange(false);
    }
  }

  async function adopt(angle: string) {
    if (!data || adoptingRef.current || generatingRef.current || loading) return;
    adoptingRef.current = true;
    setAdopting(angle);
    onAdoptingChange(true);
    setError(null);
    setStatusNotice(null);
    try {
      const run = await post<Run>(`/api/listings/${listingId}/revisions`, {
        base_version: version,
        kind: "adopt_variant",
        variant_set_id: data.variant_set_id,
        variant_angle: angle,
        request_id: createRequestId(),
      });
      const status = await waitForRun(run.run_id, {
        isActive: () => mounted.current,
        onUnavailable: setStatusNotice,
      });
      if (!status) return;
      if (status.status === "failed") throw new Error(status.error?.message || "独立复检失败，备选文案仍保留且未采用。");
      const versions = await api<Listing[]>(`/api/listings/${listingId}/versions`);
      const record = versions.find((item) => item.version === status.version);
      if (!record) throw new Error("复检已完成，但未读到新版本。请从运行记录查看，不要重复点击。");
      if (mounted.current) onAdopted(record);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "采用并复检失败");
    } finally {
      adoptingRef.current = false;
      if (mounted.current) { setAdopting(""); setStatusNotice(null); }
      onAdoptingChange(false);
    }
  }

  const tokens = data?.trace.usage?.total_tokens;
  return (
    <div style={{ display: "grid", gap: "14px" }}>
      <p className="helper">
        用同一商品事实生成三版不同卖点角度的文案。备选稿尚未经过独立审核；只有采用并完成复检后，才会成为可核对的新版本。
      </p>
      {loading && <p role="status">正在读取已保存的 A/B 结果…</p>}
      <button
        className="primary-button"
        onClick={() => void generate()}
        disabled={busy || loading || Boolean(adopting)}
        style={{ justifySelf: "start" }}
      >
        {busy ? "生成中…" : data ? "重新生成三版" : "生成三版变体"}
      </button>
      {data && (
        <div className="evidence-note" role="status">
          已保存 {new Date(data.generated_at).toLocaleString()} · {data.trace.model || data.trace.requested_model || "模型未返回名称"}
          {data.trace.elapsed_ms != null ? ` · ${data.trace.elapsed_ms} ms` : ""}
          {tokens != null ? ` · ${tokens.toLocaleString()} tokens` : " · 用量未知"}
          {data.trace.provider_request_id ? <><br />请求 ID：<code>{data.trace.provider_request_id}</code></> : <><br />上游未返回请求 ID</>}
          <br />此结果属于 A/B 备选，不代表已审核。
        </div>
      )}
      {statusNotice && <p className="helper" role="status">{statusNotice}</p>}
      {error && <p className="helper" role="alert">{error}</p>}
      {data?.variants.map((v) => {
        const zh = ANGLE_ZH[v.angle] || v.angle;
        const c = v.content;
        return (
          <div
            key={v.angle}
            style={{ border: "1px solid #e3e3e8", borderRadius: "8px", padding: "12px", display: "grid", gap: "8px" }}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: "13px" }}>变体 · {zh}</strong>
              <div style={{ display: "flex", gap: "8px" }}>
                <button className="secondary-button" onClick={async () => {
                  try { await navigator.clipboard.writeText(copyContent(c)); }
                  catch { setError("剪贴板不可用，请选择文本复制或导出。"); }
                }}>复制</button>
                <button className="primary-button" disabled={Boolean(adopting) || busy || loading} onClick={() => void adopt(v.angle)}>
                  {adopting === v.angle ? "独立复检中…" : "采用为新版并复检"}
                </button>
              </div>
            </div>
            <p style={{ margin: 0, fontWeight: 600, fontSize: "14px" }}>{c.title}</p>
            <p style={{ margin: 0, fontSize: "13px" }}>{c.item_highlights}</p>
            <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px" }}>
              {c.bullet_points.map((b) => <li key={b.id} style={{ marginBottom: "3px" }}>{b.text}</li>)}
            </ul>
            <p style={{ margin: 0, fontSize: "13px", color: "#4b5563" }}>{c.description}</p>
          </div>
        );
      })}
    </div>
  );
}
