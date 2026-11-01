/**
 * 「按 Ctrl+P 存成 PDF，纸面上是什么样」实测。
 *
 * 为什么要有这个尺子：报告的最终形态之一是**一张纸**——打印店打出来、或者评委按下"存为 PDF"
 * 塞进电脑。屏幕上好看不等于纸上好看，而这台机器上以前**没有任何一行代码量过打印产物**：
 * 页数是多少、每页底部有没有那句"不表示平台审核通过"、长表跨到第二页还有没有列名，
 * 全靠"我在 CSS 里写了"。
 *
 * 量四件事：
 *   1. **打印引擎支持不支持页脚**：同一份文档印两遍（有/无 `@page{@bottom-center}`），
 *      比 PDF 字节数。差值为 0 就说明那条页脚根本没进 PDF —— 纸面上没有任何标识。
 *   2. **页数**：每份文档实际印出几页（PDF 里数 `/Type /Page`）。
 *   3. **跨页表头的前提**：长表有没有 `<thead>`（没有的话 `thead{display:table-header-group}`
 *      是空转，第二页起就没有列名了）。
 *   4. **首末页截图**：给人眼看一眼（机器判不了"这句字印得对不对"）。
 *
 * 用法：
 *   node scripts/print-probe.mjs
 *   node scripts/print-probe.mjs --json
 *   node scripts/print-probe.mjs --strict   # 页脚进不了 PDF / 长表缺 thead 时 exit 1
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { ROOT } from "../server/store.mjs";
import { exportListingReport, exportListingWorklist } from "../server/listing-report.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");
const OUT = resolve(ROOT, ".runtime/print-probe");
mkdirSync(OUT, { recursive: true });

const read = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));
const v1 = read("reports/merchant-experience-2026-10-23/listing-v1.json");
const v2 = read("reports/merchant-experience-2026-10-23/listing-v2.json");

const DOCS = [
  { name: "report-v1", label: "审阅报告 V1（5 条问题）", html: exportListingReport(v1) },
  { name: "report-v2", label: "审阅报告 V2（含趋势）", html: exportListingReport(v2, [v1, v2]) },
  { name: "worklist-v1", label: "改稿工作单 V1", html: exportListingWorklist(v1) },
];

/** 数 PDF 里几页。PDF 的页面对象是未压缩的 `/Type /Page`（注意排除 `/Pages`）。 */
const countPages = (buffer) => (buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;

/** 长表有没有表头行组：`<thead>` 是 `display:table-header-group` 唯一能生效的前提。 */
function tableAudit(html) {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((m) => m[1]);
  const rowsOf = (body) => (body.match(/<tr\b/gi) || []).length;
  return tables.map((body) => ({
    rows: rowsOf(body),
    // 键值表（身份卡：左边 `<th>` 是行名"规则"，右边 `<td>` 是值）本来就没有列名，
    // 拿"缺 thead"去要求它是错的。真正的列名行 = 某一 <tr> 里 ≥2 个 <th> 且 0 个 <td>。
    hasHeaderCells: [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].some(
      (m) => (m[1].match(/<th\b/gi) || []).length >= 2 && !/<td\b/i.test(m[1]),
    ),
    hasThead: /<thead\b/i.test(body),
  }));
}

const { chromium } = await import("@playwright/test");
const browser = await chromium.launch({ channel: "msedge" });
const results = [];
const findings = [];
let marginBoxSupported = false;

try {
  const page = await browser.newPage();
  /** 把 HTML 印成 PDF（A4，与报告自己的 @page 一致）。 */
  const print = async (html) => {
    await page.setContent(html, { waitUntil: "load" });
    return page.pdf({ format: "A4", printBackground: true });
  };

  /* ---------- 1. 打印引擎认不认 @page margin box ---------- */
  const probeBody = "<p>正文一行。</p>".repeat(45);
  const shell = (extraCss) =>
    `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:16mm 14mm 24mm 14mm}${extraCss}` +
    `body{font:10.5pt/1.55 system-ui,sans-serif}p{margin:0 0 8pt}</style></head><body>${probeBody}</body></html>`;
  const withoutBox = (await print(shell(""))).length;
  const withBox = (await print(shell('@page{@bottom-center{content:"PROBE-MARGIN-BOX"}}'))).length;
  marginBoxSupported = withBox !== withoutBox;
  if (!marginBoxSupported)
    findings.push(
      `打印引擎不认 @page margin box（有页脚 ${withBox}B / 无页脚 ${withoutBox}B，差值 0）：` +
        "报告页脚（版本/时间/免责声明）印不到纸上",
    );

  /* ---------- 2/3. 真文档 ---------- */
  for (const doc of DOCS) {
    const buffer = await print(doc.html);
    const pdfPath = join(OUT, `${doc.name}.pdf`);
    writeFileSync(pdfPath, buffer);
    const pages = countPages(buffer);
    const tables = tableAudit(doc.html);
    // 只挑"有列名的长表"：键值表没有列名可丢，跨页重复它反而错。
    const longTables = tables.filter((t) => t.rows >= 8 && t.hasHeaderCells);
    const longWithoutThead = longTables.filter((t) => !t.hasThead).length;
    if (longWithoutThead)
      findings.push(`${doc.label}：${longWithoutThead} 张 8 行以上、带列名的表没有 <thead>，跨页后第二页没有列名`);

    results.push({
      name: doc.name,
      label: doc.label,
      pages,
      bytes: buffer.length,
      tables: tables.length,
      longTables: longTables.length,
      longWithoutThead,
      hasFooterBlock: /@bottom-center/.test(doc.html),
      pdfPath,
    });
  }

  /* ---------- 4. 首末页截图（给人眼） ---------- */
  for (const doc of results) {
    try {
      const viewer = await browser.newPage({ viewport: { width: 1000, height: 1320 } });
      await viewer.goto(pathToFileURL(doc.pdfPath).href);
      await viewer.waitForTimeout(2500);
      await viewer.screenshot({ path: join(OUT, `${doc.name}-p1.png`) });
      if (doc.pages > 1) {
        for (let i = 1; i < doc.pages; i += 1) await viewer.keyboard.press("PageDown");
        await viewer.waitForTimeout(1200);
        await viewer.screenshot({ path: join(OUT, `${doc.name}-last.png`) });
      }
      await viewer.close();
    } catch {
      // 截图只是给人眼看的，失败不影响数字。不静默：在报告里标出来。
      findings.push(`${doc.label}：末页截图没截成（PDF 查看器没响应），最后一页长什么样没人看过`);
    }
  }
} finally {
  await browser.close();
}

if (!results.length) findings.push("一份都没印出来，下面的数字全部无效");

if (asJson) {
  console.log(JSON.stringify({ marginBoxSupported, results, findings }, null, 2));
} else {
  console.log("打印实测（Edge 存 PDF，A4，与报告自带 @page 一致）\n");
  console.log("打印引擎支持 @page margin box（页脚进 PDF 的前提）：", marginBoxSupported ? "是" : "否");
  console.log("\n文件".padEnd(16), "页数", "字节", "表格", "8行以上", "其中缺 thead", "自带页脚");
  for (const r of results) {
    console.log(
      String(r.label).padEnd(16),
      String(r.pages),
      String(r.bytes),
      String(r.tables),
      String(r.longTables),
      String(r.longWithoutThead),
      r.hasFooterBlock ? "有" : "无",
    );
  }
  console.log("\n结论：");
  if (!findings.length) console.log("  三份都印得出来：页脚进得了 PDF，长表都带 <thead>（跨页会重复列名）。");
  else for (const f of findings) console.log("  ✗ " + f);
  console.log(`\nPDF 与首末页截图：${OUT}`);
}

if (strict && findings.length) process.exit(1);
