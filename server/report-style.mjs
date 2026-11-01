/**
 * 审阅报告的样式（屏幕 + 打印）与文档外壳（自提任务 66）
 *
 * 为什么单独一个文件：这份报告是要**交到商家手上**的——演示时多半是"打开导出文件给人看"或者
 * 直接打印/另存 PDF。原来样式是一行内联字符串塞在 `index.mjs` 的模板里，
 * 打印只有两句（`body{margin:0}` + `.issue{break-inside:avoid}`），结果是：
 *   - 长表格（参数对照 40 多行）跨页时表头不重复，第二页开始不知道那两列是什么；
 *   - 一条问题的卡片被页缝劈成两半；
 *   - `h2` 孤零零留在页面最底下，正文翻到下一页（孤行标题）；
 *   - 屏幕上那行"查看原文"链接，打印出来是一行绿字，纸上点不动、也没有地址。
 *
 * 做法：规则写成 `[选择器, 声明]` 的数组，一处定义两处消费——
 *   - `REPORT_CSS` 把同一批规则包进 `@media print{}`，导出的 HTML 直接用；
 *   - `printPreviewCss()` 把同一批规则加上作用域前缀，供 `scripts/print-check.mjs`
 *     在**屏幕上**模拟打印版式（这样能用一张截图人眼验，而不只是"我写了 CSS"）。
 * 两处共用一份规则，避免"预览看着好、打印又是另一回事"。
 *
 * 边界：这里只管版式，不改任何判断逻辑与文案。页面尺寸写 A4，因为现场最可能是 A4 打印/PDF。
 */

/** 屏幕上用的基础样式（与第 11 轮之前的视觉保持一致，只是搬了家）。 */
export const SCREEN_CSS = [
  "body{font:15px/1.7 system-ui,sans-serif;color:#243b35;max-width:900px;margin:48px auto;padding:24px}",
  "h1{font-size:28px}",
  "h2{font-size:20px;margin-top:32px}",
  ".muted{color:#64756d}",
  ".issue{border:1px solid #dce4df;padding:18px;margin:12px 0;border-radius:10px}",
  "blockquote{margin:12px 0;padding:12px;background:#f4f6f2;white-space:pre-wrap}",
  "table{width:100%;border-collapse:collapse;font-size:14px}",
  "th,td{border:1px solid #dce4df;padding:6px 8px;text-align:left;vertical-align:top}",
  "th{background:#f4f6f2}",
  "pre{white-space:pre-wrap;font:inherit}",
  "a{color:#236b55}",
  // 版本趋势的条形。长度（width）由生成器内联给出，这里只管"怎么显示"——
  // 拆成类是为了让窄屏媒体查询能把它关掉（内联 display 会压过媒体查询）。
  ".trend-bar{display:inline-block;position:relative;height:9px;max-width:100%;vertical-align:middle;background:#dfe5e1;border-radius:5px}",
  ".trend-bar-fill{position:absolute;left:0;top:0;height:9px;max-width:100%;background:#b95245;border-radius:5px}",
  // 只在纸上出现的那一句（纸张离开浏览器之后，"详见链接"就失效了，所以必须自己把话说全）。
  ".print-only{display:none}",
  // ── 窄屏（第 16 轮自提 91）────────────────────────────────────────────
  // 上面那行 `max-width:900px;margin:48px auto;padding:24px` 是桌面口径：手机上左右各 24px 的留白
  // 吃掉 12% 屏宽，再叠上 7 列的版本趋势表，右侧 32px 直接被裁掉（实测）。
  // 这里只改**屏幕**口径，`@media print` 一个字不动 —— 打印版式已被 print:check 按五档缩放钉住。
  "@media screen and (max-width:720px){" +
    "body{margin:16px auto;padding:14px;font-size:15px}" +
    "h1{font-size:22px;line-height:1.3}" +
    "h2{font-size:17px;margin-top:24px}" +
    // 表格是主要溢出源：字号降一档、内边距收窄，并允许在任意位置折行
    // （规则号、长英文单词不折行会把整列顶宽）。
    "table{font-size:12.5px}" +
    "th,td{padding:5px;overflow-wrap:anywhere}" +
    // 中文表头可以在任意两字之间折行，于是浏览器把「阻断」「建议」压成一字一行（实测 31px 列）。
    // 给表头一个两字半的下限，宁可整行高一点，也不要竖排单字。
    "th{min-width:2.8em}" +
    // 版本趋势那一列条形是"6 条"的可视化重复，手机上没有它照样能读；
    // 留着它要占 110px，7 列分不下来（实测最窄列被压到 31px，表头竖排）。
    ".trend-bar{display:none}" +
    "blockquote{padding:8px 10px}" +
    ".issue{padding:12px}" +
    "}" +
    // ── 更窄一档（第 19 轮补 320px 视口时实测：报告里的版本趋势表右溢出 17px）────────
    // 320 是 iPhone SE 一代 / 老安卓的 CSS 宽度。720px 那一段把字号和内边距降过一次，
    // 到 320 还是差 17px——7 列的表每列再省 2–3px 就够了，不用动结构（结构一动，打印版式跟着变）。
    "@media screen and (max-width:340px){" +
    "body{padding:10px}" +
    "table{font-size:11.5px}" +
    "th,td{padding:4px}" +
    "th{min-width:2.4em}" +
    "}",
].join("");

/**
 * 打印专用规则。选择器一律是元素或类，便于加前缀模拟。
 * 排列顺序有意义：先页面与文字，再布局，最后"别在页缝里劈开"。
 */
export const PRINT_RULES = [
  // 纸面比屏幕窄，字号按 pt 给：10.5pt 在 A4 上大约是"能读、但塞得下 5 页"的折中。
  ["body", "max-width:none;margin:0;padding:0;font:10.5pt/1.55 system-ui,sans-serif;color:#000"],
  ["h1", "font-size:19pt;margin:0 0 6px"],
  // break-after:avoid = 标题后面不许断页，否则出现"标题在页底、内容在下一页"的孤行。
  ["h2", "font-size:13pt;margin:14px 0 6px;break-after:avoid;page-break-after:avoid"],
  // 灰色在纸上会淡到看不清，打印时加深。
  [".muted", "color:#333"],
  [".issue", "break-inside:avoid;page-break-inside:avoid;padding:10px;margin:8px 0;border-radius:0"],
  ["blockquote", "break-inside:avoid;page-break-inside:avoid;background:#f4f6f2"],
  ["table", "break-inside:auto;font-size:9.5pt"],
  // 表格跨页时，每一页都重复表头——没有这句，第二页起的数字没有列名。
  ["thead", "display:table-header-group"],
  // 单行不许被页缝劈开；表格本身允许跨页（否则 40 行的参数表会被整体推到下一页，前面留一片白）。
  ["tr", "break-inside:avoid;page-break-inside:avoid"],
  ["th", "break-inside:avoid;page-break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact"],
  // 条形在纸上要保住颜色，否则 A4 打印出来是一段空白（浏览器默认不印背景色）。
  [".trend-bar", "-webkit-print-color-adjust:exact;print-color-adjust:exact"],
  [".trend-bar-fill", "-webkit-print-color-adjust:exact;print-color-adjust:exact"],
  ["pre", "break-inside:auto"],
  ["a", "color:inherit;text-decoration:none"],
  // 纸上看不到超链接，把地址印出来（只印 http 开头的，"查看原文"这种锚点不用）。
  ["a[href^=\"http\"]::after", "content:\" (\" attr(href) \")\";font-size:8.5pt;word-break:break-all"],
  // Page-margin content is provided by printFooter(record).
  [".print-only", "display:none"],
  // 只在最后一页真的有用：`body` 的 padding-bottom 加在**流末尾**，只影响最后一页。
  // 其它页的正文能一直写到内容框底边（见下面 `@page` 那条注释）。
  ["body", "padding-bottom:12mm"],
  // 工作单的每一个条目都不许被页缝劈开：标题留在上一页、正文翻到下一页读的人会当成两条。
  // 第 20 轮实测（逐页读 PDF）：21 条那条纸上第 1、3 页各有一条劈开；加这条之后重量。
  ["[data-worklist-issue]", "break-inside:avoid;page-break-inside:avoid"],
  ["[data-worklist-field]", "break-inside:avoid;page-break-inside:avoid"],
];

/** `@page` 里的声明不能加前缀，单独放。 */
// The bottom page margin reserves space for the repeated footer.
export const PAGE_RULES = ["size:A4", "margin:16mm 14mm 24mm 14mm"];

const toCss = (rules) => rules.map(([selector, body]) => `${selector}{${body}}`).join("");

/** 导出报告里真正生效的那段样式。 */
export const REPORT_CSS = `${SCREEN_CSS}@media print{@page{${PAGE_RULES.join(";")}}${toCss(PRINT_RULES)}}`;

/**
 * 给预览用：把打印规则套到屏幕上的某个作用域里（`printPreviewCss("body")` → `body h2{…}`）。
 * 只用于 `scripts/print-check.mjs`，不进生产 HTML。
 */
export function printPreviewCss(scope = "body") {
  return PRINT_RULES.map(([selector, body]) => `${scope} ${selector}{${body}}`).join("");
}

/**
 * 文档外壳。`inner` 是报告正文（各段拼接结果）。
 * 有 `<body>` 是因为打印时需要一个明确的根元素承载 pt 字号；浏览器容错照旧能开。
 */
export function reportShell(inner, { title = "Listing 审阅报告" } = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeText(title)}</title><style>${REPORT_CSS}</style></head><body>${inner}</body></html>`;
}

/** 标题里只会出现版本号之类，仍然转义：这个函数的入参以后可能来自商品名。 */
function escapeText(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/**
 * 报告里的时间怎么显示。
 *
 * 原来报告直接把 `created_at` 原样印出来，那是 ISO/UTC 串：`2026-10-28T02:09:00.924Z`。
 * 三个问题，纸面上全都会咬人：
 *   1. 比用户在自己界面上看到的时间**早 8 小时**（本机在东八区），商家一对就会怀疑报告过期；
 *   2. `T` 和 `.924Z` 是给机器看的，印在纸上像没做完；
 *   3. 只写"02:09"不写时区，跨地区协作时没法判断。
 * 所以：转成本机时间，并**把时区明写出来**（`（UTC+8）`）。认不出的原样返回，不编一个时间。
 */
export function formatStamp(value) {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const timezone = `UTC${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}（${timezone}）`;
}

/**
 * 纸张页脚：只打印时可见。
 * 为什么要有：一份打印件离开浏览器后会单独流传，上面必须有"这是哪份、什么时候查的、
 * 以及它**不是**什么"。结论里那句"不表示平台审核通过"在打印件第一页就有，这里再说一次是为了
 * 万一有人只拿到中间几页。
 */
export function printFooter(record) {
  const when = formatStamp(record?.created_at);
  const basis = record?.trace?.actual_model_call ? '实际模型调用及规则检查' : '未调用模型';
  const label = '打印件 · V' + String(record?.version ?? '?') + (when ? ' · ' + when : '') + ' · ' + basis;
  const footer = label + '\n不表示平台审核通过，不构成法律意见';
  const css = JSON.stringify(footer).replace(/\\n/g, '\\a ').replaceAll('<', '\\3c ').replaceAll('>', '\\3e ');
  // A page margin box occupies the reserved page margin, never overlays flowing rows.
  // Verified with the installed Chromium print engine; other print engines remain unverified.
  return '<style>@media print{@page{@bottom-center{content:' + css
    + ';white-space:pre-line;text-align:center;vertical-align:middle;font:8pt/1.4 system-ui,sans-serif;color:#333}}}</style>'
    + '<div class="print-only">' + escapeText(footer) + '</div>';
}
