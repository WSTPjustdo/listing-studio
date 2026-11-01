/**
 * 「这份 HTML 发给别人，双击能不能打开」实测。
 *
 * 为什么要有这个尺子：报告/工作单是**评委和商家带走的东西**——它离开这台机器、离开浏览器、
 * 进别人的微信和邮箱。以前所有关于导出的结论都是"我写了内联样式，应该没问题"，
 * 一次都没真的从文件系统打开过。断网、换电脑、目录里没有 dist/ 的时候它还是不是那份东西，
 * 只能量。
 *
 * 量三件事：
 *   1. **字节层**：HTML 里有几处外部资源引用（link/script/img/@import/url()）。
 *      不是 0 就意味着"发出去以后要联网才完整"，而对方未必有网。
 *   2. **file:// 打开**：用 Edge 从磁盘打开，数它向**非 file:// 地址**发了几次请求、
 *      控制台报了几次错、正文渲染出多少字、有没有横向溢出。
 *   3. **打印媒体**：切到 print 媒体，看 `.print-only` 这类"只给纸看"的元素到底显示不显示。
 *      （纸面是报告唯一的最终形态，纸上没有的东西等于不存在。）
 *
 * 一律离线：样本取 `reports/` 下的归档真实记录，不联网、不调模型、不碰 .runtime 以外的写路径。
 *
 * 用法：
 *   node scripts/offline-report-probe.mjs
 *   node scripts/offline-report-probe.mjs --json
 *   node scripts/offline-report-probe.mjs --strict   # 有"离线打不开/会去网上要东西"的项时 exit 1
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { ROOT } from "../server/store.mjs";
import { exportListingReport, exportListingWorklist } from "../server/listing-report.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");
const OUT = resolve(ROOT, ".runtime/offline-probe");

const read = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));

/* ---------- 样本：归档的真实记录（v1 有 5 条问题，v2 是改完的 0 条） ---------- */
const v1 = read("reports/merchant-experience-2026-10-23/listing-v1.json");
const v2 = read("reports/merchant-experience-2026-10-23/listing-v2.json");

const DOCS = [
  { name: "report-v1.html", label: "审阅报告 V1（5 条问题）", html: exportListingReport(v1) },
  { name: "report-v2.html", label: "审阅报告 V2（含趋势，0 条问题）", html: exportListingReport(v2, [v1, v2]) },
  { name: "worklist-v1.html", label: "改稿工作单 V1", html: exportListingWorklist(v1) },
];

/* ---------- 1. 字节层：外部资源引用 ---------- */
const RESOURCE_PATTERNS = [
  { kind: "link", re: /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi },
  { kind: "script-src", re: /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi },
  { kind: "img-src", re: /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi },
  { kind: "iframe-src", re: /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi },
  { kind: "css-import", re: /@import\s+(?:url\()?["']?([^"')\s;]+)/gi },
  { kind: "css-url", re: /url\(\s*["']?([^"')]+)["']?\s*\)/gi },
];

function scanBytes(html) {
  const resources = [];
  for (const { kind, re } of RESOURCE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html))) resources.push({ kind, ref: m[1] });
  }
  const external = resources.filter((r) => /^(https?:)?\/\//i.test(r.ref));
  // data: 是内嵌的，算"自带"；相对路径算"缺文件"（发出去就 404）
  const relative = resources.filter((r) => !/^(https?:)?\/\//i.test(r.ref) && !/^data:/i.test(r.ref));

  const anchors = [];
  const anchorRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["']/gi;
  let a;
  while ((a = anchorRe.exec(html))) anchors.push(a[1]);
  const http = anchors.filter((h) => /^https?:\/\//i.test(h));
  const other = anchors.filter((h) => !/^https?:\/\//i.test(h));

  return {
    bytes: Buffer.byteLength(html, "utf8"),
    externalResources: external,
    relativeResources: relative,
    inlineStyles: (html.match(/<style\b/gi) || []).length,
    inlineScripts: (html.match(/<script\b/gi) || []).length,
    anchors: { total: anchors.length, http: http.length, other },
    hasDoctype: /^<!doctype html>/i.test(html.trimStart()),
    charsetDeclared: /<meta\s+charset=["']?utf-8/i.test(html),
    langDeclared: /<html[^>]*\blang=/i.test(html),
  };
}

/* ---------- 2/3. 浏览器层 ---------- */
async function browserPhase(docPaths) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ channel: "msedge" });
  const results = {};
  try {
    for (const doc of docPaths) {
      const context = await browser.newContext({ viewport: { width: 1180, height: 900 }, offline: false });
      const page = await context.newPage();
      const offsite = [];
      const consoleErrors = [];
      page.on("request", (req) => {
        const url = req.url();
        if (!url.startsWith("file://")) offsite.push(url);
      });
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => consoleErrors.push("pageerror: " + err.message));

      await page.goto(pathToFileURL(doc.path).href, { waitUntil: "load" });
      const screen = await page.evaluate(() => ({
        textLength: (document.body.innerText || "").trim().length,
        headings: document.querySelectorAll("h2").length,
        tables: document.querySelectorAll("table").length,
        paragraphs: document.querySelectorAll("p,li,td,blockquote,pre").length,
        scrollHeight: document.documentElement.scrollHeight,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        title: document.title,
        // 有没有样式真的生效：h1 的字号不会是浏览器默认的 2em/32px 且色值不是纯黑
        h1FontSize: getComputedStyle(document.querySelector("h1") || document.body).fontSize,
        bodyColor: getComputedStyle(document.body).color,
        fontFamily: getComputedStyle(document.body).fontFamily,
      }));

      await page.emulateMedia({ media: "print" });
      const print = await page.evaluate(() => {
        const probe = document.querySelector(".print-only");
        const footerText = probe ? (probe.textContent || "").trim() : null;
        return {
          printOnlyExists: Boolean(probe),
          printOnlyDisplay: probe ? getComputedStyle(probe).display : null,
          printOnlyVisibility: probe ? getComputedStyle(probe).visibility : null,
          printOnlyTextLength: footerText ? footerText.length : 0,
          // 页面里有没有别的地方印着这份报告的身份（版本/时间），用来判断"纸上认不认得出这是哪份"
          bodyHeadText: (document.querySelector("h1")?.innerText || "").slice(0, 60),
        };
      });
      await page.emulateMedia({ media: "screen" });

      mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: join(OUT, doc.name.replace(".html", ".png")), fullPage: false });
      results[doc.name] = { offsiteRequests: offsite, consoleErrors, screen, print };
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return results;
}

/* ---------- 汇总 ---------- */
const findings = [];
const report = { generatedAt: new Date().toISOString(), docs: [] };

const paths = [];
mkdirSync(OUT, { recursive: true });
for (const doc of DOCS) {
  const path = join(OUT, doc.name);
  writeFileSync(path, doc.html, "utf8");
  paths.push({ ...doc, path });
}

const bytes = Object.fromEntries(paths.map((d) => [d.name, scanBytes(d.html)]));
let browser = {};
try {
  browser = await browserPhase(paths);
} catch (error) {
  browser = { __error: String(error && error.message ? error.message : error) };
}

for (const doc of paths) {
  const b = bytes[doc.name];
  const r = browser[doc.name] || {};
  const row = {
    name: doc.name,
    label: doc.label,
    bytes: b.bytes,
    externalResources: b.externalResources.length,
    relativeResources: b.relativeResources.length,
    anchors: b.anchors,
    inlineStyles: b.inlineStyles,
    inlineScripts: b.inlineScripts,
    offsiteRequests: r.offsiteRequests ? r.offsiteRequests.length : null,
    consoleErrors: r.consoleErrors ? r.consoleErrors.length : null,
    textLength: r.screen ? r.screen.textLength : null,
    overflowX: r.screen ? r.screen.overflowX : null,
    h1FontSize: r.screen ? r.screen.h1FontSize : null,
    printOnlyDisplay: r.print ? r.print.printOnlyDisplay : null,
    printOnlyText: r.print ? r.print.printOnlyTextLength : null,
  };
  report.docs.push(row);
  if (b.externalResources.length) findings.push(`${doc.name} 引用了 ${b.externalResources.length} 处外部资源（离线会缺）`);
  if (b.relativeResources.length) findings.push(`${doc.name} 引用了 ${b.relativeResources.length} 处相对路径资源（发出去 404）`);
  if (r.offsiteRequests && r.offsiteRequests.length) findings.push(`${doc.name} 从 file:// 打开时向网上发了 ${r.offsiteRequests.length} 次请求`);
  if (r.screen && r.screen.textLength < 200) findings.push(`${doc.name} 离线打开只渲染出 ${r.screen.textLength} 字（疑似空白）`);
  if (r.screen && r.screen.overflowX > 0) findings.push(`${doc.name} 离线打开横向溢出 ${r.screen.overflowX}px`);
}

if (asJson) {
  console.log(JSON.stringify({ ...report, findings, raw: browser }, null, 2));
} else {
  console.log("离线打开实测（file:// + Edge，样本来自 reports/ 归档真实记录）\n");
  console.log("文件".padEnd(20), "字节", "外部资源", "相对资源", "外链", "离线请求", "控制台错", "正文字数", "横向溢出", "print-only");
  for (const row of report.docs) {
    console.log(
      String(row.name).padEnd(20),
      String(row.bytes),
      String(row.externalResources),
      String(row.relativeResources),
      String(row.anchors.http),
      String(row.offsiteRequests),
      String(row.consoleErrors),
      String(row.textLength),
      String(row.overflowX),
      String(row.printOnlyDisplay),
    );
  }
  console.log("\n结论：");
  if (!findings.length) console.log("  三份文件离线打开全部通过（0 处外部资源、0 次联网请求、正文非空、无横向溢出）。");
  else for (const f of findings) console.log("  ✗ " + f);
  console.log(`\n截图与产物：${OUT}`);
}

if (strict && findings.length) process.exit(1);
