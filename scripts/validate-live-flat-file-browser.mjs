// Real running app, public-source-derived file, and existing real model text only.
// This checks import/dry-run UI. It never starts a batch or calls a model.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const valueFor = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const base = valueFor("--base-url", "http://127.0.0.1:8787");
const local = new URL(base);
assert.equal(local.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost'].includes(local.hostname), 'This acceptance script targets a real loopback workspace only.');
assert.equal(local.pathname, '/');
assert.equal(local.username + local.password + local.search + local.hash, '');
const directory = resolve(
  valueFor("--report-dir", "reports/flat-file-live-2026-10-28"),
);
mkdirSync(directory, { recursive: true });
const sourceAcceptance = JSON.parse(
  readFileSync(resolve(directory, "acceptance.json"), "utf8"),
);
assert.equal(
  sourceAcceptance.status,
  "passed_available_scope_merchant_validation_pending",
);
const sourceBuffer = readFileSync(
  resolve(directory, "public-derived-w101-without-seller-sku.tsv"),
);
assert.equal(
  createHash("sha256").update(sourceBuffer).digest("hex"),
  sourceAcceptance.file_provenance.sha256,
);
assert.equal(sourceAcceptance.file_provenance.merchant_original, false);
assert.equal(sourceAcceptance.file_provenance.seller_sku, null);
const report = {
  started_at: new Date().toISOString(),
  base_url: base,
  evidence_type: "real_running_browser_public_source_no_merchant_template",
  merchant_acceptance: "pending",
  merchant_original_template: "unknown",
  merchant_seller_sku: null,
  platform_processing_report: "unknown",
  model_calls_performed: 0,
  model_calls_this_run: [],
  reused_model_record: sourceAcceptance.reused_model_record,
  official_source: sourceAcceptance.official_source,
  source_sha256: sourceAcceptance.file_provenance.sha256,
  notice:
    "仅验收真实运行工作台导入公开派生 TSV/TXT、五点识别与缺 SKU 拦截。没有商家模板、真实卖家 SKU 或 Seller Central 报告；未启动批量处理或上传 Amazon。",
  checks: [],
  screenshots: [],
  imports: [],
  page_errors: [],
  mutation_requests: [],
  overflow_checks: [],
};
const save = () =>
  writeFileSync(
    resolve(directory, "browser-acceptance.json"),
    JSON.stringify(report, null, 2),
  );
save();
const browser = await chromium.launch({
  channel: process.platform === "win32" ? "msedge" : undefined,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (error) => {
  report.page_errors.push(error.message);
  save();
});
page.on("request", (request) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) return;
  const url = new URL(request.url());
  if (url.origin !== new URL(base).origin) return;
  let payload;
  try {
    payload = request.postDataJSON();
  } catch {
    payload = null;
  }
  // Keep no file bodies, credentials, or model prompts in this request log.
  report.mutation_requests.push({
    method: request.method(),
    path: url.pathname,
    dry_run: payload?.dry_run ?? null,
    filename: payload?.filename ?? null,
  });
});
async function screenshot(name) {
  await page.evaluate(() => document.fonts.ready.then(() => true));
  const path = resolve(directory, name);
  await page.screenshot({ path, animations: "disabled", fullPage: false });
  report.screenshots.push({
    filename: name,
    width: page.viewportSize().width,
    height: page.viewportSize().height,
  });
  save();
}
async function checkOverflow(label) {
  const size = await page.evaluate(() => ({
    viewport: innerWidth,
    scroll: document.documentElement.scrollWidth,
    overflowing_elements: [...document.querySelectorAll("body *")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          style.position !== "fixed" &&
          (rect.right > innerWidth + 1 || rect.left < -1) &&
          style.visibility !== "hidden"
        );
      })
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName,
        class: element.className,
        right: Math.round(element.getBoundingClientRect().right),
      })),
  }));
  report.overflow_checks.push({ label, ...size });
  save();
  assert.ok(
    size.scroll <= size.viewport,
    `${label}: document is ${size.scroll}px wide at ${size.viewport}px viewport.`,
  );
}
async function uploadAndCheck(extension) {
  const filename = `public-derived-w101-without-seller-sku.${extension}`;
  const previewResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/batches/preview" &&
      response.request().method() === "POST",
  );
  await page
    .getByLabel("上传商品表", { exact: true })
    .setInputFiles({
      name: filename,
      mimeType:
        extension === "tsv" ? "text/tab-separated-values" : "text/plain",
      buffer: sourceBuffer,
    });
  const response = await previewResponse;
  assert.ok(response.ok(), `${extension} preview HTTP ${response.status()}`);
  const preview = await response.json();
  assert.equal(preview.filename, filename);
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].cells[0], "W101");
  assert.equal(preview.rows[0].cells[preview.mapping.sku], "");
  assert.equal(preview.mapping.sku, 1);
  for (let index = 1; index <= 5; index++) {
    assert.equal(preview.mapping[`bullet_point${index}`], index + 4);
    assert.equal(
      await page
        .getByLabel(`映射英文卖点 ${index}`, { exact: true })
        .inputValue(),
      String(index + 4),
    );
  }
  assert.equal(
    await page.getByLabel("映射SKU / 货号", { exact: true }).inputValue(),
    "1",
  );
  assert.equal(
    await page.getByLabel("第2行sku", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await page.getByLabel("库存模板表头行号", { exact: true }).inputValue(),
    "1",
  );
  if (extension === "tsv") {
    await page.locator(".batch-columns > summary").click();
    await page.locator(".batch-mapping").first().scrollIntoViewIfNeeded();
    await screenshot("flat-file-desktop-five-bullet-mapping.png");
    await page.locator(".batch-columns > summary").click();
  }
  await page
    .getByLabel("批量任务类型", { exact: true })
    .selectOption("diagnose");
  await page
    .getByText(
      "我确认未填写品类的商品均为棉布手提袋，使用 Amazon 美国站英文规则。",
      { exact: true },
    )
    .check();
  const dryResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/batches" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "检查导入内容", exact: true }).click();
  const checkedResponse = await dryResponse;
  assert.ok(
    checkedResponse.ok(),
    `${extension} dry-run HTTP ${checkedResponse.status()}`,
  );
  const result = await checkedResponse.json();
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].status, "blocked");
  assert.equal(result.rows[0].sku, "");
  assert.equal(result.rows[0].product.sku, "");
  assert.ok(result.rows[0].errors.some((error) => /缺少真实 SKU/.test(error)));
  assert.equal(checkedResponse.request().postDataJSON().dry_run, true);
  const box = page.locator(".batch-check");
  await box.waitFor();
  assert.ok((await box.innerText()).includes("缺少真实 SKU"));
  assert.equal(
    await page
      .getByRole("button", { name: "确认并开始批量处理", exact: false })
      .isDisabled(),
    true,
  );
  report.imports.push({
    format: extension,
    same_source_bytes: true,
    import_id: preview.id,
    original_merchant_file: false,
    manufacturer_product_code: "W101",
    seller_sku: null,
    dry_run: true,
    status: result.rows[0].status,
    errors: result.rows[0].errors,
    five_bullet_mapping: Array.from(
      { length: 5 },
      (_, index) => preview.mapping[`bullet_point${index + 1}`],
    ),
  });
  save();
}

try {
  const health = await page.request.get(`${base}/api/health`);
  assert.ok(health.ok());
  assert.equal((await health.json()).ok, true);
  await page.goto(base);
  await page.getByRole("button", { name: "批量商品", exact: true }).click();
  await page
    .getByRole("heading", { name: "批量商品工作台", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("上传商品表").getAttribute("accept"),
    ".xlsx,.csv,.tsv,.txt",
  );
  await uploadAndCheck("tsv");
  await page.locator(".batch-check").scrollIntoViewIfNeeded();
  await checkOverflow("1440px_tsv_missing_sku");
  await screenshot("flat-file-desktop-missing-sku.png");
  await uploadAndCheck("txt");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".batch-check").scrollIntoViewIfNeeded();
  await checkOverflow("390px_txt_missing_sku");
  await screenshot("flat-file-mobile-missing-sku.png");
  assert.deepEqual(report.page_errors, []);
  assert.equal(
    report.mutation_requests.filter(
      (request) => request.path === "/api/batches",
    ).length,
    2,
  );
  assert.deepEqual(
    report.mutation_requests.filter(
      (request) =>
        request.path !== "/api/batches/preview" &&
        !(request.path === "/api/batches" && request.dry_run === true),
    ),
    [],
  );
  report.checks = [
    "real_app_file_input_accepts_tsv_and_txt",
    "same_real_public_derived_bytes_imported_for_both_extensions",
    "all_five_bullet_columns_mapped_distinctly_in_ui",
    "manufacturer_code_not_treated_as_seller_sku",
    "dry_run_returns_missing_sku_block_and_start_button_is_disabled",
    "no_paid_batch_or_model_revision_requested",
    "desktop_and_mobile_have_no_document_horizontal_overflow",
    "no_page_javascript_errors",
  ];
  report.status = "passed_browser_available_scope_merchant_validation_pending";
  report.completed_at = new Date().toISOString();
  save();
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks,
      screenshots: report.screenshots,
      model_calls_performed: 0,
      merchant_acceptance: "pending",
      report: resolve(directory, "browser-acceptance.json"),
    }),
  );
} catch (error) {
  report.status = "failed";
  report.failure = { code: error.code || null, message: error.message };
  try {
    await screenshot("flat-file-browser-failure.png");
  } catch {
    /* Keep the original failure. */
  }
  save();
  throw error;
} finally {
  await browser.close();
}
