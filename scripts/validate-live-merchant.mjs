// Real Amazon import, actual browser editing, paid DeepSeek generation/revision. No mocks.
import { chromium } from "playwright";
import fs from "node:fs";
import assert from "node:assert/strict";
if (!process.argv.includes("--real-api"))
  throw Error("Use --real-api to authorize paid inference.");
const directory = "reports/merchant-improvements-2026-10-24";
fs.mkdirSync(directory, { recursive: true });
const base = "http://127.0.0.1:8787";
const browser = await chromium.launch({
  channel: process.platform === "win32" ? "msedge" : undefined,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const report = {
  started_at: new Date().toISOString(),
  checks: [],
  source: {
    url: "https://www.dalix.com/products/heavy-duty-cotton-canvas-tote-bag",
    access:
      "Direct HTTP returned 429; web page reader accessed the official page on 2026-10-24. Excerpts manually checked before this run.",
    applicability:
      "DALIX 22 inch zippered tote family; selected ASIN color and retail pack remain unknown.",
  },
  runs: [],
};
const write = () =>
  fs.writeFileSync(
    `${directory}/live-merchant.json`,
    JSON.stringify(report, null, 2),
  );
async function shot(name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
}
async function sourceFields(container, excerpt) {
  await container
    .getByLabel("来源链接", { exact: true })
    .fill(report.source.url);
  await container.getByLabel("发布方", { exact: true }).fill("DALIX");
  await container
    .getByLabel("适用型号 / 变体", { exact: true })
    .fill("DALIX 22 inch zippered tote; color and retail pack not verified");
  await container
    .getByLabel("支持该参数的原文摘录", { exact: true })
    .fill(excerpt);
}
async function finishRun(response, label) {
  assert.equal(response.status(), 202);
  const queued = await response.json();
  for (let i = 0; i < 360; i++) {
    const run = await (
      await page.request.get(`${base}/api/runs/${queued.run_id}`)
    ).json();
    if (run.status === "failed") {
      report.runs.push({ label, run });
      write();
      throw Error(run.error?.message || "Model failed");
    }
    if (run.status === "succeeded") {
      const versions = await (
        await page.request.get(
          `${base}/api/listings/${run.listing_id}/versions`,
        )
      ).json();
      const record = versions.find((r) => r.version === run.version);
      assert.ok(
        record.trace.actual_model_call && record.trace.provider_request_id,
      );
      report.runs.push({ label, run, record });
      write();
      await page.waitForTimeout(1500);
      return record;
    }
    await page.waitForTimeout(1000);
  }
  throw Error("Real call timed out");
}
try {
  await page.goto(base);
  await page
    .getByLabel("Amazon 商品链接或 ASIN")
    .fill("https://www.amazon.com/dp/B0732NPDRB");
  const importedResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/amazon/import") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "导入商品", exact: true }).click();
  const imported = await (await importedResponse).json();
  report.import = imported;
  write();
  assert.equal(imported.failures.length, 0);
  assert.equal(imported.imported[0].product.amazon.import_mode, "live");
  await page
    .getByRole("button", { name: "查看商品资料", exact: false })
    .click();
  await page.getByRole("button", { name: "编辑资料", exact: true }).click();
  const editor = page.locator(".fact-source-editor");
  await editor.locator("summary").click();
  const material = editor.locator("details article").first();
  await material.getByRole("button").click();
  await sourceFields(material, "12. Oz, 100% Cotton Canvas");
  const originalFacts = [
    ["Original dimensions", '22" X 16" X 6"'],
    ["Closure", "Top Zipper Closure"],
    ["Pocket", "Outer Pocket"],
  ];
  for (const [label, value] of originalFacts) {
    await editor
      .getByRole("button", { name: "添加原文资料", exact: true })
      .click();
    const row = editor.locator(":scope > article").last();
    await row.getByLabel("参数名称", { exact: true }).fill(label);
    await row.getByLabel("原文事实 / 原始单位", { exact: true }).fill(value);
    await row
      .getByRole("button", { name: "填写 / 更新此条来源", exact: true })
      .click();
    await sourceFields(row, '22" X 16" X 6"; Outer Pocket; Top Zipper Closure');
  }
  await editor.locator("summary").click();
  await shot("01-source-edit");
  const saveResponse = page.waitForResponse(
    (r) =>
      r.url().includes("/api/products/") &&
      r.url().endsWith("/versions") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存为新版本", exact: true }).click();
  const savedResponse = await saveResponse;
  assert.equal(savedResponse.status(), 201);
  const product = await savedResponse.json();
  report.product = product;
  assert.equal(product.color.value, null);
  assert.equal(product.capacity_l.value, null);
  assert.equal(product.retail_pack_count.value, null);
  assert.ok(product.fact_sources.material);
  assert.ok(
    product.additional_facts.some(
      (f) => f.value === '22" X 16" X 6"' && f.source,
    ),
  );
  report.checks.push(
    "real_amazon_import",
    "browser_source_binding",
    "original_inches_preserved",
    "unknown_color_pack_capacity_preserved",
  );
  write();
  await page.getByLabel("商品资料完整度").waitFor();
  await shot("02-saved-facts");
  await page
    .getByRole("button", { name: "使用当前商品创建", exact: true })
    .click();
  const instruction =
    'Write concise US English listing copy using the confirmed product facts. Preserve the exact original dimension string 22" X 16" X 6" in a useful specification bullet. Mention the top zipper closure and outer pocket as separate useful features. Use at most four distinct bullets. Do not infer color, pack count, capacity, handle size, load rating or certifications. Do not claim heavy-duty performance. Avoid repeating material and brand across every bullet.';
  await page.getByLabel("用途与表达要求").fill(instruction);
  const createResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/listings/create") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "生成英文草稿", exact: false })
    .click();
  let record = await finishRun(await createResponse, "source_bound_generation");
  await page.getByLabel("对话修改指令").waitFor();
  await shot("03-generated-copy");
  const prompt =
    "Rewrite in natural US English.\nPreserve the exact confirmed original-unit dimensions and distinct closure and pocket features.\nUse no more than four useful bullets and remove repetition. Do not infer missing color, retail pack, handle size or performance. Keep the title within the character limit stated in your system instructions.";
  const composer = page.getByLabel("对话修改指令");
  await composer.fill(prompt);
  assert.equal(await composer.evaluate((el) => el.tagName), "TEXTAREA");
  await composer.press("End");
  await composer.press("Enter");
  assert.ok((await composer.inputValue()).includes("\n"));
  await composer.fill(prompt);
  await page.getByRole("button", { name: "预览完整指令", exact: true }).click();
  assert.equal(
    await page.getByLabel("完整指令预览").locator("pre").innerText(),
    prompt,
  );
  await shot("04-prompt-preview");
  const revisionResponse = page.waitForResponse(
    (r) => r.url().endsWith("/revisions") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "提交修改指令", exact: true }).click();
  record = await finishRun(await revisionResponse, "multiline_prompt_revision");
  assert.equal(record.instruction, prompt);
  report.checks.push(
    "multiline_enter_does_not_submit",
    "full_instruction_preview",
    "real_revision_with_exact_instruction",
  );
  await shot("05-reviewed-copy");
  for (const format of ["txt", "html", "json", "copy"]) {
    const response = await page.request.get(
      `${base}/api/listings/${record.listing_id}/export?version=${record.version}&format=${format}`,
    );
    assert.equal(response.status(), 200);
    const body = await response.text();
    fs.writeFileSync(
      `${directory}/listing.${format === "copy" ? "customer.txt" : format}`,
      body,
    );
    if (format === "txt" || format === "html")
      assert.ok(body.includes(product.fact_sources.material.url));
    if (format === "copy")
      assert.ok(!body.includes("内部审阅说明") && !body.includes("商家关联"));
  }
  report.checks.push("source_provenance_exports", "customer_copy_separated");
  assert.deepEqual(errors, []);
  report.completed_at = new Date().toISOString();
  write();
  console.log(
    JSON.stringify({
      report: `${directory}/live-merchant.json`,
      checks: report.checks,
      listing_id: record.listing_id,
      version: record.version,
      issues: record.review.issues.length,
      bullets: record.content.bullet_points.length,
    }),
  );
} catch (error) {
  report.failure = { message: error.message, at: new Date().toISOString() };
  await shot("failure").catch(() => {});
  write();
  throw error;
} finally {
  await browser.close();
}
