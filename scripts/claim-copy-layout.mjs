#!/usr/bin/env node
/**
 * 「理由和建议写长了，纸面/界面还装得下吗」实测。
 *
 * 为什么要有这个尺子：第 16 轮把 US-04 的一句话拆成五句（监管状态 / 疗效 / 过敏 /
 * 专家背书 / 微生物），句子从 40 字变成 60–105 字。这个仓库为此栽过三次：
 *   · 第 10 轮 `@page` 页脚——以为浏览器不支持，差点把**正在工作的**页脚改坏；
 *   · 第 15 轮运行失败卡片——「只改文案」，结果 `.run-card > div` 是 flex，三行挤成一行；
 *   · 第 18 轮 markdown 星号——数字全绿，纸面上印着 `**`。
 * 所以改完文案必须**从磁盘打开看一眼**，不许只过 tsc。
 *
 * 量四件事（每一件都要能变红，不然等于没量）：
 *   1. 五类宣称**都**被召回（少于 5 类就是量具失效，不是产品没问题）；
 *   2. 每条理由与建议的**文字完整印出来**（渲染出的字数 == 源字数，防 ellipsis / 截断）；
 *   3. 没有容器把文字裁掉（`scrollHeight > clientHeight` 或 `scrollWidth > clientWidth`）；
 *   4. 1280 与 390 两个宽度下**横向溢出 0**。
 *
 * 只用归档的真实记录当底稿（`reports/merchant-experience-2026-10-23/listing-v1.json`），
 * 不联网、不调模型、不写库。产物在 `.runtime/claim-copy-layout/`，截图另存一份到 `qa/reports/`。
 *
 * 用法：
 *   node scripts/claim-copy-layout.mjs
 *   node scripts/claim-copy-layout.mjs --json
 *   node scripts/claim-copy-layout.mjs --strict   # 任何一项不达标就 exit 1
 */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, rulePack } from "../server/store.mjs";
import { reviewContent } from "../server/domain.mjs";
import { exportListingReport } from "../server/listing-report.mjs";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const strict = argv.includes("--strict");
const OUT = resolve(ROOT, ".runtime/claim-copy-layout");
const QA_REPORTS = resolve(ROOT, "../qa/reports");

/** 六句话覆盖五类（微生物类放两句：一句成品词、一句名词式）。 */
const SENTENCES = [
  "Antibacterial lining keeps the bag fresh",
  "Mildew proof coating for humid climates",
  "Hypoallergenic cotton for sensitive skin",
  "FDA registered facility",
  "Dermatologist recommended fabric",
  "Pain relief for sore shoulders after a long day",
];

const base = JSON.parse(
  readFileSync(resolve(ROOT, "reports/merchant-experience-2026-10-23/listing-v1.json"), "utf8"),
);
const record = {
  ...base,
  content: {
    ...base.content,
    item_highlights: "",
    bullet_points: SENTENCES.map((text, i) => ({ id: `b${i + 1}`, text })),
    description: "",
  },
};
const review = reviewContent({
  content: record.content,
  profile: base.product_snapshot,
  rulePack,
  marketplace: "US",
});
record.review = review;

const medical = review.issues.filter((issue) => issue.rule_id === "US-04");
const reasons = [...new Set(medical.map((issue) => issue.reason).filter(Boolean))];
const suggestions = [...new Set(medical.map((issue) => issue.suggestion).filter(Boolean))];

mkdirSync(OUT, { recursive: true });
const html = exportListingReport(record);
const htmlPath = resolve(OUT, "medical-report.html");
writeFileSync(htmlPath, html, "utf8");
const shotPath = resolve(OUT, "report-1280.png");

/**
 * 自证：五类都得在、理由与建议各至少 5 句。
 * 「0 处裁切」和「一个都没查」在输出上一模一样（第 18 轮的教训），所以先证明尺子拿到了东西。
 */
const selfCheck = [];
if (new Set(medical.map((i) => i.reason)).size < 5)
  selfCheck.push(`只召回 ${new Set(medical.map((i) => i.reason)).size} 类理由（应为 5），量具失效`);
if (medical.length < 5) selfCheck.push(`US-04 只召回 ${medical.length} 条（应 ≥5）`);
for (const text of [...reasons, ...suggestions])
  if (!html.includes(text)) selfCheck.push(`报告 HTML 里找不到这段文字：${text.slice(0, 24)}…`);

const widths = [1280, 390];
const rows = [];
let browserError = null;
try {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ channel: "msedge" });
  try {
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
      const measured = await page.evaluate(
        (list) => {
          // 只挑叶子元素：理由/建议是纯文本块；带子元素的容器会重复计数。
          const leaves = [...document.querySelectorAll("td,p,li,span,div,strong")].filter(
            (el) => el.children.length === 0,
          );
          const text = list.map((source) => {
            // 判据是「这个叶子块的文字**完整包含**这段原文」，不是「字数相等」。
            // 第一次写成「字数相等」时，匹配到的是带前缀的块（例如「US-04 · 理由」），
            // 于是印出 104 字 / 源 83 字被判成「截断」——量具自己错，差点去改没坏的排版。
            const el = leaves.find((node) => (node.textContent || "").includes(source));
            if (!el) return { found: false, source: source.length };
            const box = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return {
              found: true,
              source: source.length,
              blockLength: (el.textContent || "").trim().length,
              width: Math.round(box.width),
              lines: Math.max(1, Math.round(box.height / parseFloat(style.lineHeight || "20"))),
              clipped: el.scrollHeight > el.clientHeight + 1,
              innerOverflow: el.scrollWidth > el.clientWidth + 1,
              whiteSpace: style.whiteSpace,
            };
          });
          return {
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            textLength: (document.body.innerText || "").trim().length,
            text,
          };
        },
        [...reasons, ...suggestions],
      );
      if (width === widths[0]) await page.screenshot({ path: shotPath, fullPage: false });
      rows.push({ width, ...measured });
      await context.close();
    }
  } finally {
    await browser.close();
  }
} catch (error) {
  browserError = String(error && error.message ? error.message : error);
}

const findings = [...selfCheck];
for (const row of rows) {
  if (row.overflowX > 0) findings.push(`${row.width}px 下报告横向溢出 ${row.overflowX}px`);
  for (const item of row.text) {
    if (!item.found) findings.push(`${row.width}px 下有一段文字没渲染出来（${item.source} 字）`);
    else if (item.clipped) findings.push(`${row.width}px 下容器把文字裁掉（scrollHeight > clientHeight）`);
    else if (item.innerOverflow) findings.push(`${row.width}px 下文字内部横向溢出`);
  }
}
if (browserError) findings.push(`浏览器阶段失败：${browserError}`);

let mirrored = null;
if (rows.length) {
  try {
    mkdirSync(QA_REPORTS, { recursive: true });
    mirrored = resolve(QA_REPORTS, "medical-copy-20261030.png");
    copyFileSync(shotPath, mirrored);
  } catch {
    mirrored = null;
  }
}

const payload = {
  generatedAt: new Date().toISOString(),
  us04_issues: medical.length,
  distinct_reasons: reasons.length,
  distinct_suggestions: suggestions.length,
  widths: rows.map((row) => ({ width: row.width, overflowX: row.overflowX, textLength: row.textLength })),
  findings,
};
if (asJson) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log("报告文案排版实测（Edge，file:// 打开，底稿为归档真实记录）\n");
  console.log(`US-04 命中 ${medical.length} 条，理由去重 ${reasons.length} 类，建议去重 ${suggestions.length} 类`);
  console.log("");
  console.log("宽度".padEnd(8), "横向溢出", "正文字数", "文字块", "最窄宽度", "最多行数");
  for (const row of rows)
    console.log(
      String(`${row.width}px`).padEnd(8),
      String(row.overflowX),
      String(row.textLength),
      String(row.text.filter((x) => x.found).length),
      String(Math.min(...row.text.filter((x) => x.found).map((x) => x.width))),
      String(Math.max(...row.text.filter((x) => x.found).map((x) => x.lines))),
    );
  console.log("\n结论：");
  if (!findings.length) console.log("  五类理由与建议全部完整印出，两个宽度下横向溢出 0，无裁切。");
  else for (const finding of findings) console.log("  ✗ " + finding);
  console.log(`\n产物：${htmlPath}`);
  if (mirrored) console.log(`截图：${mirrored}`);
}
if (strict && findings.length) process.exit(1);
