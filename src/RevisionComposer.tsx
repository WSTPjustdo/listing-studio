import { useState } from "react";
import "./merchant-improvements.css";
const templates = [
  [
    "保留卖点并核对依据",
    "Rewrite in natural US English. Preserve supported product features and measurements using the current product facts and sources, including confirmed original-unit facts. Explain a simple practical benefit for each distinct feature without inventing performance. Omit disputed or missing facts. If the facts support fewer than five distinct points, return fewer useful points instead of repetition.",
  ],
  [
    "精简重复表达",
    "Remove repeated ideas and empty filler from the selected fields. Keep distinct, supported features and exact measurements. Do not remove useful specifications merely to shorten the copy or clear a warning. Use concise sentence case. Return fewer bullets when facts do not support five distinct points.",
  ],
  [
    "缩短标题",
    "Rewrite the title using only the confirmed brand, material, product type and closure. Remove all numbers and measurement units from the title. Keep the title within the character limit stated in your system instructions. Preserve the complete original-unit measurements in the existing specification bullets unchanged. Do not introduce new facts or unsupported performance claims.",
  ],
] as const;
export default function RevisionComposer({
  value,
  onChange,
  scope,
  onScope,
  disabled,
  readOnly,
  busy,
  onSubmit,
  onVersions,
  bullets = [],
}: {
  value: string;
  onChange: (v: string) => void;
  scope: string;
  onScope: (v: string) => void;
  disabled: boolean;
  readOnly: boolean;
  busy: boolean;
  onSubmit: () => void;
  onVersions: () => void;
  bullets?: { id: string; text: string }[];
}) {
  const [preview, setPreview] = useState(false);
  return (
    <section
      className="revision-panel merchant-composer"
      aria-label="英文修改指令"
    >
      <div className="revision-title">
        <strong>继续调整这份文案</strong>
        <small>修改后重新检查 · 保留原版本</small>
      </div>
      <label>
        修改范围
        <select
          aria-label="对话修改范围"
          value={scope}
          onChange={(e) => onScope(e.target.value)}
          disabled={readOnly || busy}
        >
          <option value="all">整份文案</option>
          <option value="content.title">只改标题</option>
          <option value="content.item_highlights">只改亮点</option>
          <option value="content.description">只改描述</option>
          {bullets.map((bullet, index) => <option key={bullet.id} value={`content.bullet_points.${bullet.id}`}>只改要点 {index + 1}</option>)}
        </select>
      </label>
      <div className="suggestion-chips">
        {templates.map(([label, text]) => (
          <button
            key={label}
            disabled={
              readOnly || busy || value.length + text.length + 2 > 10000
            }
            onClick={() =>
              onChange(value.trim() ? `${value.trim()}\n\n${text}` : text)
            }
          >
            {label}
          </button>
        ))}
      </div>
      <label>
        修改要求
        <textarea
          aria-label="对话修改指令"
          rows={6}
          maxLength={10000}
          value={value}
          disabled={readOnly || busy}
          placeholder="说明希望保留的卖点、需要调整的表达和不能推测的信息。可用中文或英文。"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              (e.ctrlKey || e.metaKey) &&
              !disabled &&
              value.trim()
            ) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </label>
      <div className="composer-meta">
        <span>
          {value.length.toLocaleString()} / 10,000 字符 · Ctrl / ⌘ + Enter 提交
        </span>
        <button
          className="text-button"
          disabled={!value.trim()}
          aria-expanded={preview}
          onClick={() => setPreview(!preview)}
        >
          {preview ? "收起指令预览" : "预览完整指令"}
        </button>
      </div>
      {preview && (
        <div className="instruction-preview" aria-label="完整指令预览">
          <strong>将提交的完整指令</strong>
          <pre>{value}</pre>
        </div>
      )}
      <p className="helper">
        模板会追加到现有要求。请先核对缺失或冲突资料；提示词不能证明商品事实。资料不足时允许保留更少的有效要点。
      </p>
      <div className="journey-buttons">
        <button
          className="primary-button"
          aria-label="提交修改指令"
          disabled={disabled || !value.trim()}
          onClick={onSubmit}
        >
          {busy ? "修改与复检中…" : "按此指令修改并复检"}
        </button>
        <button className="secondary-button" onClick={onVersions}>
          查看版本变化
        </button>
      </div>
      {readOnly && (
        <p className="helper">这是历史版本，请切换到最新版本后修改。</p>
      )}
    </section>
  );
}
