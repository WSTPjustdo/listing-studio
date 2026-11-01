import { BadgeCheck, Clock3, Hash } from "lucide-react";

/**
 * 首页的「真实样例」。
 *
 * 为什么要有：评委走进来第一句通常是"这东西到底产出什么"，而现场跑一次要等半分钟
 * 且要看模型脸色。放一份**带溯源信息**的真实产出，30 秒就能看懂成品长什么样。
 *
 * 来自 reports/two-path-guided-2026-10-30/guided-browser-automatic-1793354607793.json
 * 的 records[0] 原始内容与审核 trace。历史样本不作为当前输入或新站点的验收。
 */
const SAMPLE = {
  source: "Westford Mill W101 · 官方公开商品页",
  product: "长提手棉布袋（100% cotton / 140gsm / 4.1oz/yd² / 手提或肩背 / CutAway 标签）",
  generated_at: "2026-10-30 18:03（北京时间）",
  model: "deepseek-flash",
  request_id: "a5bda87e-cf0a-4c3b-897e-219b03b2a52e",
  tokens: 9001,
  title: "100% Cotton Tote Bag with Long Handles, 140gsm",
  highlights:
    "100% cotton, 140gsm (4.1oz/yd²); carry by hand or over the shoulder; cutaway label",
  bullets: [
    "100% cotton fabric at 140gsm (4.1oz/yd²)",
    "Long handles let you carry it by hand or over the shoulder",
    "CutAway label for ease of rebranding",
  ],
  description:
    "This tote bag is made of 100% cotton at 140gsm (4.1oz/yd²). The long handles let you carry it by hand or over the shoulder. A CutAway label makes it easy to rebrand.",
  missing: ["品牌：未确认，草稿中不推测", "颜色：未确认，草稿中不推测", "零售包装：未确认，草稿中不推测"],
  checks: "该历史记录在当时已执行范围内未发现内容问题",
};

export function RealSample() {
  return (
    <details className="real-sample">
      <summary>
        <span className="real-sample-badge">真实样例</span>
        先看一份成品：棉布袋历史公开商品案例（2026-10-30，美国站英语）
      </summary>
      <div className="real-sample-body">
        <p className="real-sample-meta">
          <Clock3 size={14} /> {SAMPLE.generated_at} · {SAMPLE.model} ·{" "}
          <Hash size={14} /> 独立审核请求 ID {SAMPLE.request_id} · 本次审核 {SAMPLE.tokens} tokens
        </p>
        <p className="real-sample-meta">输入：{SAMPLE.product}</p>

        <div className="real-sample-block">
          <span className="real-sample-label">标题（{Array.from(SAMPLE.title).length} 字符）</span>
          <p className="real-sample-title">{SAMPLE.title}</p>
        </div>

        <div className="real-sample-block">
          <span className="real-sample-label">亮点</span>
          <p>{SAMPLE.highlights}</p>
        </div>

        <div className="real-sample-block">
          <span className="real-sample-label">五点描述</span>
          <ol>
            {SAMPLE.bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ol>
        </div>

        <div className="real-sample-block">
          <span className="real-sample-label">商品描述</span>
          <p>{SAMPLE.description}</p>
        </div>

        <div className="real-sample-verdict">
          <p>
            <BadgeCheck size={15} /> {SAMPLE.checks}
          </p>
          <ul>
            {SAMPLE.missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <p className="real-sample-note">
          上面是历史公开商品记录的原样内容，来源为 {SAMPLE.source}，不是当前输入的生成结果，
          也不代表德国、英国或法国站已通过验收。实际处理时间、发现和缺失资料以本次运行结果为准。
        </p>
      </div>
    </details>
  );
}
