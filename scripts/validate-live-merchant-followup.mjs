import { chromium } from "playwright";
import fs from "node:fs";
import assert from "node:assert/strict";
if (!process.argv.includes("--real-api"))
  throw Error("Use --real-api to authorize real title rewrite and review.");
const dir = "reports/merchant-improvements-2026-10-24",
  base = "http://127.0.0.1:8787";
const previous = JSON.parse(fs.readFileSync(`${dir}/live-merchant.json`));
const listingId = previous.runs.at(-1).record.listing_id;
const before = (await (await fetch(`${base}/api/listings/${listingId}/versions`)).json()).at(-1);
const browser = await chromium.launch({
  channel: process.platform === "win32" ? "msedge" : undefined,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const report = { started_at: new Date().toISOString(), checks: [] };
const shot = async (name) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
};
try {
  await page.goto(base);
  await page
    .locator('[data-listing-id="listing-55f336f5-f8b6-435c-b240-ad75986aa8bc"]')
    .click();
  await page.getByRole("button", { name: /^版本对比/ }).click();
  await page
    .locator(".version-selector button")
    .filter({ hasText: "V1" })
    .click();
  await page.getByRole("button", { name: /^检查与依据/ }).click();
  const grouped = page.locator(".review-group");
  assert.equal(await grouped.count(), 1);
  await grouped.locator("summary").click();
  assert.equal(await grouped.locator(".issue-card").count(), 5);
  await shot("06-historical-grouped-findings");
  report.checks.push("original_v1_five_findings_grouped_and_expandable");
  await page.goto(base);
  await page.locator(`[data-listing-id="${before.listing_id}"]`).click();
  await page.getByLabel("对话修改范围").selectOption("content.title");
  await page.getByRole("button", { name: "缩短标题", exact: true }).click();
  const instruction = await page.getByLabel("对话修改指令").inputValue();
  const queuedResponse = page.waitForResponse(
    (r) => r.url().endsWith("/revisions") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "提交修改指令", exact: true }).click();
  const response = await queuedResponse;
  assert.equal(response.status(), 202);
  const queued = await response.json();
  for (let i = 0; i < 360; i++) {
    const run = await (
      await page.request.get(`${base}/api/runs/${queued.run_id}`)
    ).json();
    if (run.status === "failed") {
      report.run = run;
      throw Error(run.error.message);
    }
    if (run.status === "succeeded") {
      report.run = run;
      break;
    }
    await page.waitForTimeout(1000);
  }
  assert.ok(report.run);
  const versions = await (
    await page.request.get(`${base}/api/listings/${before.listing_id}/versions`)
  ).json();
  const record = versions.at(-1);
  report.record = record;
  report.instruction = instruction;
  assert.equal(record.version, before.version + 1);
  assert.ok(record.trace.actual_model_call);
  assert.notEqual(record.content.title, before.content.title);
  for (const field of ["item_highlights", "bullet_points", "description"])
    assert.deepEqual(record.content[field], before.content[field]);
  assert.ok(
    record.content.bullet_points.some((b) => b.text.includes('22" X 16" X 6"')),
  );
  report.checks.push(
    "template_used_via_browser",
    "title_only_changed",
    "full_dimensions_and_other_bullets_preserved",
  );
  await page.waitForTimeout(1500);
  await shot("07-title-revision");
  for (const format of ["txt", "html", "json", "copy"]) {
    const response = await page.request.get(
      `${base}/api/listings/${record.listing_id}/export?version=${record.version}&format=${format}`,
    );
    assert.equal(response.status(), 200);
    fs.writeFileSync(
      `${dir}/final.${format === "copy" ? "customer.txt" : format}`,
      await response.text(),
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator(`[data-listing-id="${before.listing_id}"]`).click();
  await page.getByLabel("对话修改指令").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  report.mobile_horizontal_overflow = overflow;
  await page.screenshot({ path: `${dir}/08-mobile-composer.png` });
  assert.equal(overflow, false);
  report.checks.push("mobile_no_horizontal_overflow");
  report.completed_at = new Date().toISOString();
} catch (e) {
  report.failure = e.message;
  throw e;
} finally {
  fs.writeFileSync(`${dir}/followup.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(
  JSON.stringify({
    checks: report.checks,
    title: report.record.content.title,
    issues: report.record.review.issues.length,
    request_id: report.record.trace.provider_request_id,
  }),
);
