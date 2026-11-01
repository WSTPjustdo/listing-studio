import type { Fact, Party } from "./types";
import "./merchant-improvements.css";

/**
 * GPSR 第 19 条要的两方：制造商（Hersteller）与欧盟责任人（EU-Verantwortlicher）。
 *
 * 为什么单独做成一块，而不是塞进「补充事实」：补充事实是自由文本，填了「Beispiel GmbH」
 * 也算有记录，看不出邮编、门牌号、电子地址缺哪一项。这里六个字段拆开，审核侧的清单
 * 才能逐项说「缺电子地址」而不是「资料不全」。
 *
 * 界面只提示「哪几项还空着」，格式判断（邮箱像不像邮箱、德国邮编是不是 5 位）留给
 * 服务端 —— 两边各写一套判据，早晚会打架。
 */

export const partyFieldList = [
  ["name", "名称（法定名称）"],
  ["street", "街道与门牌"],
  ["postal_code", "邮编"],
  ["city", "城市"],
  ["country", "国家（如 DE / Deutschland）"],
  ["electronic_address", "电子地址（邮箱或网址）"],
] as const;

export type PartyDraft = Record<string, string>;

export const blankParty = (): PartyDraft =>
  Object.fromEntries(partyFieldList.map(([key]) => [key, ""]));

export function partyDraftFrom(fact?: Fact<Party | null>): PartyDraft {
  const value = (fact?.value || {}) as Partial<Party>;
  return Object.fromEntries(
    partyFieldList.map(([key]) => [key, String(value[key] ?? "")]),
  );
}

/** 六个子字段全空即视为「没填」，保存时按 null 存，不留空对象进档案。 */
export const partyFilled = (draft: PartyDraft) =>
  Object.values(draft).some((value) => value.trim());

const emptyLabels = (draft: PartyDraft) =>
  partyFieldList
    .filter(([key]) => !(draft[key] || "").trim())
    .map(([, label]) => label);

export function GpsrPartyFields({
  role,
  draft,
  onChange,
  disabled,
  hint,
}: {
  role: string;
  draft: PartyDraft;
  onChange: (draft: PartyDraft) => void;
  disabled: boolean;
  hint: string;
}) {
  const missing = emptyLabels(draft);
  return (
    <article className="gpsr-party">
      <div className="source-row-heading">
        <strong>{role}</strong>
        <span className="helper">{missing.length === 0 ? "六项已填" : `还空着 ${missing.length} 项`}</span>
      </div>
      <p className="helper">{hint}</p>
      <div className="product-edit-grid">
        {partyFieldList.map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              value={draft[key] || ""}
              maxLength={key === "electronic_address" ? 300 : 200}
              disabled={disabled}
              onChange={(e) => onChange({ ...draft, [key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {missing.length > 0 && missing.length < partyFieldList.length && (
        <p className="helper">
          未填：{missing.join("、")}。GPSR 要的是「名称 + 邮政地址 + 电子地址」三项齐全，
          填一半可以存，但审核清单会一直点这几项。
        </p>
      )}
    </article>
  );
}

export function GpsrPartiesView({ product }: { product: {
  manufacturer?: Fact<Party | null>;
  eu_responsible?: Fact<Party | null>;
} }) {
  const roles: [string, Fact<Party | null> | undefined][] = [
    ["制造商（Hersteller）", product.manufacturer],
    ["欧盟责任人（EU-Verantwortlicher）", product.eu_responsible],
  ];
  const filled = roles.filter(([, fact]) => fact?.value);
  if (!filled.length)
    return (
      <p className="helper">
        GPSR 责任方：制造商与欧盟责任人都没填。德国/欧盟站要求报价页面上给出这两方的
        名称与邮政地址；可在「编辑资料」里补，本地只认档案里填了没有，页面是否展示仍需人工确认。
      </p>
    );
  return (
    <details className="source-excerpt" open>
      <summary>GPSR 责任方（{filled.length} 方）</summary>
      <dl className="amazon-extra-facts">
        {filled.map(([label, fact]) => {
          const value = (fact?.value || {}) as Partial<Party>;
          return (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                {[value.name, value.street, [value.postal_code, value.city].filter(Boolean).join(" "), value.country]
                  .filter(Boolean)
                  .join(", ") || "未填"}
                {value.electronic_address ? ` · ${value.electronic_address}` : ""}
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="helper">
        电子地址只作档案记录：Amazon 详情页禁止出现邮箱（本工具按阻断处理），写进文案会被拦下。
      </p>
    </details>
  );
}
