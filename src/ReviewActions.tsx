import type { Listing, Product } from "./types";
import { issueKind } from "./merchant";
import { groupReviewIssues } from "./reviewGroups";

export default function ReviewActions({
  record,
  product,
  ruleVersion,
  disabled,
  onRepair,
  onFacts,
  onRecheck,
  onExport,
  onCopy,
}: {
  ruleVersion: string;
  record: Listing;
  product: Product | null;
  disabled: boolean;
  onRepair: () => void;
  onFacts: () => void;
  onRecheck: () => void;
  onExport: () => void;
  onCopy: () => void;
}) {
  const updated =
    product &&
    record.product_snapshot &&
    product.revision > record.product_snapshot.revision;
  const rulesUpdated = record.rule_pack_version !== ruleVersion;
  // 第 17 轮：这一版可能是「只检查文本」诊断出来的（没关联商品），现在下拉框里选了一份资料。
  // 这是"补关联"，不是"资料更新"——两者的下一步动作一样（复检），但要说的话不一样：
  // 前者是"这一版根本没跟档案对过"，后者是"档案后来又改过"。
  //
  // 没选商品时也要说：**以档案为准的检查根本没执行**。以前这里照样写着
  // "先处理文案问题，再确认交付"，读者会以为这份结论已经查全了。
  const noProduct = !record.product_snapshot;
  const unlinked = noProduct && !!product;
  const recheckNeeded = unlinked || updated || rulesUpdated;
  const groups = [...new Set(record.review.issues.map(issueKind))];
  return (
    <section className="journey-actions" aria-label="下一步处理">
      <div>
        <span className="eyebrow">下一步</span>
        <h3>
          {noProduct
            ? unlinked
              ? "这一版还没跟商品资料对照过"
              : "这一版没关联商品，以档案为准的检查未执行"
            : updated || rulesUpdated
              ? "商品资料或检查规则有更新，请先复检"
              : record.review.issues.length
                ? "先处理文案问题，再确认交付"
                : record.review.missing_data.length
                  ? "文案已检查，还有商品资料待确认"
                  : "检查已完成，可整理交付结果"}
        </h3>
        <div className="readiness-grid">
          <span>
            <strong>文案检查</strong>
            {groupReviewIssues(record).length} 组问题 ·{" "}
            {record.review.issues.length} 处发现
          </span>
          <span>
            <strong>商品资料</strong>
            {record.product_snapshot
              ? `${record.review.missing_data.length} 项待补 · 快照 V${record.product_snapshot.revision}`
              : "本版未关联 · 以档案为准的检查未执行"}
          </span>
          <span>
            <strong>上架准备</strong>未连接 Seller Central，尚未核验
          </span>
        </div>
        {record.content_brief && (
          <p>
            本版表达要求：{record.content_brief.audience} ·{" "}
            {record.content_brief.use_case} · 优先说明
            {record.content_brief.concern} · {record.content_brief.style}
            。请对照正文确认，场景选择不证明商品能力。
          </p>
        )}
        {record.review.consistency_check?.state === "changed" && (
          <p role="alert">{record.review.consistency_check.reason}</p>
        )}
        {!!groups.length && (
          <p>
            {groups.join(" · ")}。证据不足表示暂不能证实，不等于已认定违规。
          </p>
        )}
        {!!record.review.missing_data.length && (
          <div>
            <p>商品资料仍待确认；可导出内部草稿，正式上架前仍需补齐。</p>
            <ul>{record.review.missing_data.map(item => <li key={item.field}><strong>{item.label}：</strong>{item.reason}</li>)}</ul>
          </div>
        )}
        {!!record.product_snapshot?.evidence_submissions?.length && (
          <p>
            本次审核包含 {record.product_snapshot.evidence_submissions.length}{" "}
            份已提交材料，仍待核验。可在“核对 /
            补充商品资料”查看原文与关联问题。
          </p>
        )}
      </div>
      <div className="journey-buttons">
        {(recheckNeeded) && (
          <button
            className="primary-button"
            disabled={disabled || !product}
            onClick={onRecheck}
          >
            {unlinked ? "关联这份资料并复检" : "采用最新资料与规则复检"}
          </button>
        )}
        {!!record.review.issues.length && (
          <button
            className="primary-button"
            disabled={disabled || recheckNeeded}
            onClick={onRepair}
          >
            用 DeepSeek 审查并修复
          </button>
        )}
        <button
          className="secondary-button"
          disabled={disabled || !product}
          onClick={onFacts}
        >
          核对 / 补充商品资料
        </button>
        <button className="secondary-button" onClick={onCopy}>
          复制待补资料清单
        </button>
        <button className="text-button" disabled={disabled} onClick={onExport}>
          导出草稿与审核记录
        </button>
      </div>
    </section>
  );
}
