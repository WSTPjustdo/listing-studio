import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";

test("grouped issues repair selected SKUs and retain deferred risks", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "导入商品表", exact: true }).click();
  await page
    .getByLabel("上传商品表")
    .setInputFiles({
      name: "集中处理.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "SKU,商品名称,品类,材质,英文标题,英文描述\n" +
          [1, 2, 3]
            .map(
              (n) =>
                `GROUP-${n},棉布袋,棉布手提袋,100% cotton,${"Cotton Tote Bag ".repeat(10).trim()},Original description.`,
            )
            .join("\n"),
      ),
    });
  await page.getByLabel("批量任务类型").selectOption("diagnose");
  await page.getByRole("button", { name: "检查导入内容", exact: true }).click();
  await page.getByRole("button", { name: "确认并开始批量处理" }).click();
  await expect(page.locator(".batch-results")).toContainText("3 / 3 件已处理");
  const group = page.locator('[data-rule="AMZ-01"]');
  await group.locator("summary").click();
  await group.getByLabel("选择 GROUP-1", { exact: true }).check();
  await group.getByLabel("选择 GROUP-2", { exact: true }).check();
  await group.getByRole("button", { name: "预览批量修复" }).click();
  const preview = page.getByRole("region", { name: "批量修复预览" });
  await expect(preview).toContainText("GROUP-1");
  await expect(preview).not.toContainText("GROUP-3");
  await page.screenshot({
    path: ".runtime/groups-desktop.png",
    fullPage: true,
  });
  await preview.getByRole("button", { name: "确认应用并重新检查" }).click();
  await expect(group.locator("summary")).toContainText("1 件商品");
  await group.getByLabel("选择 GROUP-3", { exact: true }).check();
  await group.getByRole("button", { name: "暂不处理（保留风险）" }).click();
  await expect(group).toContainText("已暂缓，风险保留");
  await page.reload();
  await page
    .locator("nav")
    .getByRole("button", { name: "批量商品", exact: true })
    .click();
  await group.locator("summary").click();
  await expect(group).toContainText("已暂缓，风险保留");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".runtime/groups-mobile.png", fullPage: true });
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "导出待处理事项 Excel" }).click();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile((await (await download).path())!);
  expect(workbook.getWorksheet("集中处理记录")?.rowCount).toBe(4);
  expect(workbook.worksheets[0].rowCount).toBeGreaterThan(1);
});

test("20 SKU spreadsheet to batch output, refresh recovery, Excel export and duplicate skip", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "导入商品表", exact: true }).click();
  const rows = Array.from(
    { length: 20 },
    (_, i) =>
      `BATCH-${String(i).padStart(3, "0")},商品${i},棉布手提袋,${i % 4 ? "100% cotton" : ""},38,42,140`,
  );
  await page.getByLabel("上传商品表").setInputFiles({
    name: "20件商品.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "SKU,商品名称,品类,材质,宽度,高度,克重\n" + rows.join("\n"),
    ),
  });
  await expect(page.getByText("1. 确认识别结果")).toBeVisible();
  await page.getByRole("button", { name: "检查导入内容", exact: true }).click();
  await expect(page.locator(".batch-check")).toContainText("20 件可处理");
  await page.getByRole("button", { name: "确认并开始批量处理" }).click();
  await expect(page.locator(".batch-results")).toBeVisible();
  await page.reload();
  await page
    .locator("nav")
    .getByRole("button", { name: "批量商品", exact: true })
    .click();
  await expect(page.locator(".batch-results")).toContainText(
    "20 / 20 件已处理",
    { timeout: 45000 },
  );
  await expect(page.locator(".batch-results")).toContainText("本批处理结束");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "导出商品文案 Excel" }).click();
  const download = await downloadPromise;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile((await download.path())!);
  expect(workbook.worksheets[0].rowCount).toBe(21);
  expect(workbook.worksheets[0].getCell("A2").text).toBe("BATCH-000");
  expect(workbook.worksheets[0].getCell("D2").text).toContain("Tote Bag");
  await page.getByLabel("上传商品表").setInputFiles({
    name: "重复.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("SKU,商品名称,品类\nBATCH-000,重复商品,棉布手提袋"),
  });
  await page.getByRole("button", { name: "检查导入内容", exact: true }).click();
  await expect(page.locator(".batch-check")).toContainText("1 件跳过");
  await expect(
    page.getByRole("button", { name: "确认并开始批量处理" }),
  ).toBeDisabled();
});

test("XLSX invalid data can be corrected, unsupported categories excluded and existing copy diagnosed", async ({
  page,
}) => {
  const workbook = new ExcelJS.Workbook(),
    sheet = workbook.addWorksheet("商品");
  sheet.addRow([
    "SKU",
    "商品名称",
    "品类",
    "材质",
    "宽度",
    "高度",
    "英文标题",
    "英文描述",
  ]);
  sheet.addRow([
    "XLSX-001",
    "可修正商品",
    "棉布手提袋",
    "100% cotton",
    "15 inches",
    "40",
    "Cotton Tote Bag",
    "Cotton bag.",
  ]);
  sheet.addRow([
    "XLSX-002",
    "露营灯",
    "灯具",
    "",
    "",
    "",
    "Camping Light",
    "A light.",
  ]);
  await page.goto("/");
  await page.getByRole("button", { name: "导入商品表", exact: true }).click();
  await page.getByLabel("上传商品表").setInputFiles({
    name: "资料.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
  });
  await expect(page.getByText("1. 确认识别结果")).toBeVisible();
  await page.getByLabel("批量任务类型").selectOption("diagnose");
  await page.getByRole("button", { name: "检查导入内容", exact: true }).click();
  await expect(page.locator(".batch-check")).toContainText("2 件需修正");
  await page.getByLabel("选择要修正的商品行").selectOption("2");
  await page.getByLabel("修正第2行宽度 cm", { exact: true }).fill("38");
  await page.getByLabel("选择第3行", { exact: true }).uncheck();
  await page.getByRole("button", { name: "检查导入内容", exact: true }).click();
  await expect(page.locator(".batch-check")).toContainText("1 件可处理");
  await page.getByRole("button", { name: "确认并开始批量处理" }).click();
  await expect(page.locator(".batch-results")).toContainText("1 / 1 件已处理");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".runtime/batch-mobile.png", fullPage: true });
  await page
    .getByRole("button", { name: "查看文案与问题", exact: true })
    .click();
  await expect(page.locator(".review-summary")).toBeVisible();
});
