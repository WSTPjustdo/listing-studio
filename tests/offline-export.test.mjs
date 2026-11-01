// 导出的 HTML 必须"自己带着全部东西"：发给别人、断网、换电脑，双击就能看。
// 这条以前只是"我写了内联样式，应该没问题"，从没被任何用例盯过。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../server/store.mjs";
import { exportListingReport, exportListingWorklist } from "../server/listing-report.mjs";

const read = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));
const v1 = read("reports/merchant-experience-2026-10-23/listing-v1.json");
const v2 = read("reports/merchant-experience-2026-10-23/listing-v2.json");

const docs = {
  "审阅报告": exportListingReport(v1, [v1, v2]),
  "改稿工作单": exportListingWorklist(v1),
};

/** 只认"会被浏览器主动去取"的位置：link/script/img/iframe/@import/url()。 */
function externalResources(html) {
  const patterns = [
    /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi,
    /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /@import\s+(?:url\()?["']?([^"')\s;]+)/gi,
    /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
  ];
  const found = [];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html))) found.push(m[1]);
  }
  return found;
}

for (const [label, html] of Object.entries(docs)) {
  test(`${label}：不引用任何外部资源（离线打开不会缺东西）`, () => {
    assert.deepEqual(externalResources(html), []);
  });

  test(`${label}：所有链接都是绝对 http(s)，不存在点开就 404 的相对路径`, () => {
    const hrefs = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]);
    const bad = hrefs.filter((h) => h && !/^https?:\/\//i.test(h));
    assert.deepEqual(bad, []);
  });

  test(`${label}：自带编码声明与语言标记（换台电脑中文不乱码）`, () => {
    assert.match(html, /^\s*<!doctype html>/i);
    assert.match(html, /<meta\s+charset=["']?utf-8/i);
    assert.match(html, /<html[^>]*\blang=/i);
  });

  test(`${label}：纸上认得出来这是哪一份（页脚文字进得了打印）`, () => {
    // printFooter 同时写 @page margin box 与一个 .print-only 兜底块，两者缺一不可：
    // margin box 是真正印在每页底部的那条，兜底块供不支持 margin box 的引擎使用。
    assert.match(html, /@bottom-center/);
    assert.match(html, /class="print-only"/);
    assert.match(html, /不表示平台审核通过/);
  });
}
