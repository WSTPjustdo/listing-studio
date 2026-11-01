import { useState } from "react";
import { post } from "./api";
import type { KeywordContent } from "./types";

export default function KeywordsPanel({
  listingId,
  version,
}: {
  listingId: string;
  version: number;
}) {
  const [text, setText] = useState("");
  const [data, setData] = useState<KeywordContent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analyze() {
    if (!text.trim()) {
      setError("请先粘贴搜索词（每行一个，或 ABA 报告）。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await post<KeywordContent>(
        `/api/listings/${listingId}/keywords?version=${version}`,
        { aba_text: text },
      );
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "核对失败");
    } finally {
      setBusy(false);
    }
  }

  const chip = (present: boolean) => ({
    display: "inline-block",
    margin: "0 6px 6px 0",
    padding: "3px 8px",
    borderRadius: "999px",
    fontSize: "12px",
    border: "1px solid",
    ...(present
      ? { background: "#ecfdf5", borderColor: "#a7f3d0", color: "#047857" }
      : { background: "#fff7ed", borderColor: "#fed7aa", color: "#c2410c" }),
  });

  return (
    <div style={{ display: "grid", gap: "14px" }}>
      <label style={{ display: "grid", gap: "6px", fontSize: "13px" }}>
        <strong>粘贴搜索词（每行一个，或 ABA 报告）</strong>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder={"cotton tote bag\nreusable grocery bags\ncanvas tote bag with long handles"}
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
        {busy ? "核对中…" : "核对覆盖"}
      </button>
      {error && <p className="helper">{error}</p>}

      {data && (
        <>
          <p className="helper">{data.notice}</p>
          <p style={{ fontSize: "13px" }}>
            共 <strong>{data.total_terms}</strong> 个词，
            已覆盖 <strong style={{ color: "#047857" }}>{data.covered}</strong> 个，
            缺失 <strong style={{ color: "#c2410c" }}>{data.missing.length}</strong> 个。
          </p>
          {data.missing.length > 0 && (
            <div>
              <strong style={{ fontSize: "13px", color: "#c2410c" }}>未写进文案：</strong>
              <div style={{ marginTop: "6px" }}>
                {data.missing.map((m) => (
                  <span key={m} style={chip(false)}>{m}</span>
                ))}
              </div>
            </div>
          )}
          <div>
            <strong style={{ fontSize: "13px" }}>已写进标题：</strong>
            <div style={{ marginTop: "6px" }}>
              {data.in_title.length ? (
                data.in_title.map((m) => (
                  <span key={m} style={chip(true)}>{m}</span>
                ))
              ) : (
                <span className="helper">无</span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
