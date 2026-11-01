import type { Listing } from "./types";

export default function IntakeRecordContext({ record }: { record: Listing }) {
  const context = record.intake_context;
  if (!context) return null;
  const labels = {
    retained: "保留",
    removed: "本轮移除",
    added: "本轮加入",
    absent: "尚未使用",
  };
  return (
    <section
      className="intake-record-context"
      aria-label="导入来源与关键词变化"
      data-testid="intake-record-context"
    >
      <h3>
        {context.role === "competitor_reference"
          ? "由竞品参考形成的自家草稿"
          : "由自家初稿继续审改"}
      </h3>
      <p>
        材料来源：{context.source_tool || "未提供工具名称"}
        {context.source_filename && ` · ${context.source_filename}`} · ASIN：
        {context.source_asin || "未知"}
      </p>
      {context.source_url && <p>来源链接：{context.source_url}</p>}
      <p>
        本次明确范围：Amazon 美国站棉布手提袋 ·
        原始输入随版本保留。参考文案和关键词不证明自家商品事实。
      </p>
      {!!record.keyword_usage?.length ? (
        <>
          <div className="intake-keyword-list" data-testid="keyword-usage">
            {record.keyword_usage.map((item) => (
              <span key={item.term} data-state={item.status}>
                {item.term}
                <small>
                  {labels[item.status]} · {item.before_count} →{" "}
                  {item.after_count}
                </small>
              </span>
            ))}
          </div>
          <p>
            数字表示正文中的出现次数，不是搜索量。删改词条需结合问题和修改依据核对，未使用不代表该词被认定违规。
          </p>
        </>
      ) : (
        <p>未提供关键词，不生成覆盖率或流量结论。</p>
      )}
    </section>
  );
}
