import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * 「这几版怎么变的」（第 15 轮自提 86）
 *
 * 为什么放在版本页：这一页现在只能一版一版点开看，商家改到 V5 之后，想知道的是
 * "我这几轮改的是不是有用"——一版一版看不出趋势，只能靠记。
 *
 * 判断全部在服务端（`server/version-trend.mjs`），这里只负责画：
 * 导出报告和界面读同一份结论，两处数字不一致比没有这个功能更糟（第 12 轮定下的规矩）。
 *
 * 画法上有两条刻意的选择：
 *   1. **条形旁边永远有数字**：条形只用来比长短，读数还是靠数字。
 *   2. **「已查/应查」单独一列**：问题数变少有两种原因，一种是改好了，一种是查少了。
 *      少查的时候这一列会变短，那才是解读上面所有数字的前提。
 */

type TrendPoint = {
  version: number;
  issues: number;
  blocking: number;
  needs_review: number;
  suggestion: number;
  checks_total: number;
  checks_completed: number;
  checks_missing: number;
  uncovered_parameters?: number;
  rule_ids: string[];
  new_rule_ids: string[];
  closed_rule_ids: string[];
  linked: boolean;
};

type Trend = {
  algorithm_version?: string;
  direction:
    | "no_data"
    | "insufficient"
    | "incomparable"
    | "scope_changed"
    | "improving"
    | "worsening"
    | "flat";
  headline: string;
  caveat: string;
  /** 整条线跨过"关不关联商品"的边界时，边界之后那一段单独给的结论（第 17 轮）。 */
  segment?: {
    from_version: number;
    direction: string;
    headline: string;
    caveat: string;
    linked: boolean;
  } | null;
  series: TrendPoint[];
};

const TONE: Record<string, string> = {
  improving: "#1d7a4f",
  worsening: "var(--red)",
  incomparable: "var(--orange)",
  scope_changed: "var(--orange)",
  flat: "var(--secondary)",
};

const LABEL: Record<string, string> = {
  improving: "在变好",
  worsening: "在变差",
  incomparable: "不可比",
  // 「范围变了」和「不可比」分开显示：前者是可修的（把商品档案关联回来），
  // 后者往往只能等下一版。混成一个词，商家不知道该做什么。
  scope_changed: "范围变了",
  flat: "没有变化",
};

export function VersionTrend({
  listingId,
  versionCount,
}: {
  listingId: string;
  versionCount: number;
}) {
  const [trend, setTrend] = useState<Trend | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTrend(null);
    setFailed(false);
    api<Trend>(`/api/listings/${listingId}/trend`)
      .then((next) => {
        if (!cancelled) {
          setTrend(next);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // versionCount 变化说明又多了一版，必须重算 —— 少这一项，改完一版趋势还停在旧数字上。
  }, [listingId, versionCount]);

  if (failed) return <p className="helper" role="status">版本趋势暂时无法读取，可继续查看各版记录。</p>;
  if (!trend || !trend.series.length) return null;

  const color = TONE[trend.direction] || "var(--secondary)";

  // 只有一版时也给一个稳定的卡位，但只放一句预期——不放"趋势"，也不放一个空的条形图。
  // 卡位固定下来，界面每次进来都在同一个地方，不用先找"这次有没有这一段"。
  if (trend.series.length < 2)
    return (
      <section
        className="panel"
        aria-label="多版本趋势"
        style={{ padding: "12px 14px", marginBottom: 12 }}
      >
        <p className="helper" style={{ margin: 0 }}>
          现在只有 V{trend.series[0].version} 一版。再改一版，这里会出现「问题数在怎么动」的对比——
          改稿到底有没有用，看的是这个。
        </p>
      </section>
    );

  const maxIssues = Math.max(...trend.series.map((point) => point.issues), 1);

  return (
    <section
      className="panel"
      aria-label="多版本趋势"
      style={{ padding: "12px 14px", marginBottom: 12 }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 13 }}>这几版怎么变的</strong>
        <span
          className="tiny-badge"
          style={{ color, borderColor: color }}
          data-trend-direction={trend.direction}
        >
          {LABEL[trend.direction] || trend.direction}
        </span>
        <span className="helper" style={{ margin: 0 }}>
          V{trend.series[0].version} → V{trend.series[trend.series.length - 1].version}
        </span>
      </header>

      <p style={{ margin: "0 0 4px", color, fontSize: 13, lineHeight: 1.5 }}>
        {trend.headline}
      </p>
      {trend.caveat && (
        <p className="helper" style={{ margin: "0 0 10px" }}>
          {trend.caveat}
        </p>
      )}
      {/* 整条线跨过"关不关联商品"的边界时，边界之后那一段单独比一次（第 17 轮）：
          没有这一句，补完档案的商家会看到一张永久红牌，而真正想知道的是"补上之后有没有变好"。 */}
      {trend.segment && (
        <p data-trend-segment={trend.segment.from_version} style={{ margin: "0 0 10px", fontSize: 13, lineHeight: 1.5 }}>
          从 <strong>V{trend.segment.from_version}</strong> 起
          （那之后每一版{trend.segment.linked ? "都挂着商品档案" : "都没有关联商品"}）可以单独比：
          {trend.segment.headline}
        </p>
      )}

      <div style={{ display: "grid", gap: 6 }}>
        {trend.series.map((point) => {
          const width = Math.max(3, Math.round((point.issues / maxIssues) * 100));
          const blockingWidth = point.issues
            ? Math.round((point.blocking / point.issues) * width)
            : 0;
          return (
            <div
              key={point.version}
              data-trend-point={point.version}
              className="version-trend-row"
              style={{
                alignItems: "center",
                gap: 8,
                fontSize: 12,
              }}
            >
              <span style={{ width: 30, color: "var(--secondary)" }}>V{point.version}</span>
              <span
                title={`共 ${point.issues} 条，其中阻断 ${point.blocking} 条`}
                style={{
                  position: "relative",
                  flex: 1,
                  minWidth: 32,
                  maxWidth: 200,
                  height: 8,
                  background: "var(--line)",
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    height: 8,
                    width: `${width}%`,
                    background: "#b9c4bd",
                    borderRadius: 4,
                  }}
                />
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    height: 8,
                    width: `${blockingWidth}%`,
                    background: "var(--red)",
                    borderRadius: 4,
                  }}
                />
              </span>
              <span style={{ minWidth: 54 }}>{point.issues} 条</span>
              <span style={{ minWidth: 48, color: "var(--secondary)" }}>
                阻断 {point.blocking}
              </span>
              <span
                style={{
                  minWidth: 74,
                  color: point.checks_missing ? "var(--orange)" : "var(--secondary)",
                }}
              >
                查 {point.checks_completed}/{point.checks_total}
              </span>
              {typeof point.uncovered_parameters === "number" && (
                <span style={{ color: point.uncovered_parameters ? "var(--orange)" : "var(--secondary)" }}>
                  未覆盖 {point.uncovered_parameters}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <p className="helper" style={{ margin: "8px 0 0" }}>
        条形长度按问题总数算，红色段是阻断项；「查」是这一版真正执行完的检查项。
        <strong>
          检查范围变小时，问题数也可能减少，不能据此判断文案改进。未覆盖的参数仍需人工核验。
        </strong>
      </p>
    </section>
  );
}
