import type { FactSourceInput, Product } from "./types";
import { productFields } from "./ProductCompleteness";
import "./merchant-improvements.css";
export type ExtraFactInput = {
  id?: string;
  label: string;
  value: string;
  source?: FactSourceInput | null;
};
export type FactBindings = Record<string, FactSourceInput | null>;
const blankSource = (): FactSourceInput => ({
  url: "",
  publisher: "",
  applicable_model: "",
  excerpt: "",
});
export function editableExtras(product: Product): ExtraFactInput[] {
  return (product.additional_facts || []).map((fact, i) => ({
    id: fact.id || `legacy-${i}`,
    label: fact.label,
    value: fact.value,
  }));
}
function SourceFields({
  source,
  onChange,
}: {
  source: FactSourceInput;
  onChange: (source: FactSourceInput) => void;
}) {
  return (
    <div>
      <div className="source-pair">
        {(
          [
            ["url", "来源链接"],
            ["publisher", "发布方"],
            ["applicable_model", "适用型号 / 变体"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              value={source[key]}
              maxLength={key === "url" ? 2000 : 200}
              onChange={(e) => onChange({ ...source, [key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <label>
        支持该参数的原文摘录
        <textarea
          rows={3}
          maxLength={12000}
          value={source.excerpt}
          onChange={(e) => onChange({ ...source, excerpt: e.target.value })}
        />
      </label>
    </div>
  );
}
export default function ProductSourceEditor({
  product,
  bindings,
  onBindings,
  extras,
  onExtras,
  disabled,
}: {
  product: Product | null;
  bindings: FactBindings;
  onBindings: (v: FactBindings) => void;
  extras: ExtraFactInput[];
  onExtras: (v: ExtraFactInput[]) => void;
  disabled: boolean;
}) {
  const update = (index: number, patch: Partial<ExtraFactInput>) =>
    onExtras(
      extras.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );
  return (
    <fieldset className="fact-source-editor" disabled={disabled}>
      <h3>关联参数来源与原文资料</h3>
      <p className="helper">
        填写你已核对的链接、原文和适用型号。保留原始单位与轴顺序；未知资料留空。商家关联来源不等于独立核验。
      </p>
      <details>
        <summary>为基础参数绑定来源</summary>
        {productFields.map(([key, label]) => {
          const saved = product?.fact_sources?.[key];
          const pending = bindings[key];
          return (
            <article key={key}>
              <div className="source-row-heading">
                <strong>{label}</strong>
                <button
                  className="text-button"
                  onClick={() =>
                    onBindings({
                      ...bindings,
                      [key]: pending
                        ? null
                        : saved
                          ? {
                              url: saved.url,
                              publisher: saved.publisher,
                              applicable_model: saved.applicable_model,
                              excerpt: saved.excerpt,
                            }
                          : blankSource(),
                    })
                  }
                >
                  {pending ? "取消本次来源" : saved ? "更新来源" : "添加来源"}
                </button>
              </div>
              {saved && (
                <p className="saved-source-note">
                  已关联：{saved.publisher} · {saved.applicable_model}
                  。参数值变化时，旧来源会解除；请重新核对后关联。
                </p>
              )}
              {pending === null && (
                <p className="helper">保存时解除此参数的来源关联。</p>
              )}
              {pending && (
                <SourceFields
                  source={pending}
                  onChange={(source) =>
                    onBindings({ ...bindings, [key]: source })
                  }
                />
              )}
            </article>
          );
        })}
      </details>
      <h3>补充原文资料</h3>
      <p className="helper">
        可录入三维英寸尺寸、面料盎司数、拉链或口袋等。每条填写一个明确事实，避免把面料重量当成容量。
      </p>
      {extras.map((entry, index) => (
        <article key={entry.id || `new-${index}`}>
          <div className="source-row-heading">
            <strong>原文资料 {index + 1}</strong>
            <button
              className="text-button"
              onClick={() => onExtras(extras.filter((_, i) => i !== index))}
            >
              移除此条
            </button>
          </div>
          <label>
            参数名称
            <input
              value={entry.label}
              maxLength={100}
              onChange={(e) => update(index, { label: e.target.value })}
            />
          </label>
          <label>
            原文事实 / 原始单位
            <textarea
              value={entry.value}
              rows={2}
              maxLength={2000}
              onChange={(e) => update(index, { value: e.target.value })}
            />
          </label>
          <button
            className="text-button"
            onClick={() =>
              update(index, { source: entry.source ? null : blankSource() })
            }
          >
            {entry.source ? "解除本次来源" : "填写 / 更新此条来源"}
          </button>
          {entry.id && entry.source === undefined && (
            <p className="saved-source-note">
              原文不变时保留已有来源；改写原文后须重新关联，否则仅标记为商家输入。
            </p>
          )}
          {entry.source && (
            <SourceFields
              source={entry.source}
              onChange={(source) => update(index, { source })}
            />
          )}
        </article>
      ))}
      <button
        className="secondary-button"
        disabled={extras.length >= 30}
        onClick={() => onExtras([...extras, { label: "", value: "" }])}
      >
        添加原文资料
      </button>
    </fieldset>
  );
}
