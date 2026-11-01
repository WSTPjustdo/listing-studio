import { test, expect } from "@playwright/test";

test("one click imports all findings across filters, repairs and keeps the previous version", async ({ page }) => {
  await page.goto("/");
  await page.locator("nav").getByRole("button", { name: "诊断与修复", exact: true }).click();
  await page.getByRole("button", { name: "载入问题样例" }).click();
  await page.getByRole("button", { name: "检查这份文案" }).click();
  await expect(page.locator(".version-badge")).toHaveText("V1");
  const before = await (await page.request.get("/api/bootstrap")).json();
  const original = before.listings[0];
  expect(original.review.issues.length).toBeGreaterThan(1);
  await page.locator(".review-filters").getByRole("button", { name: "事实一致性" }).click();
  await page.getByRole("button", { name: "一键导入全部问题并审查" }).click();
  await expect(page.locator(".version-badge")).toHaveText("V2");
  const versions = await (await page.request.get(`/api/listings/${original.listing_id}/versions`)).json();
  expect(versions).toHaveLength(2);
  expect(versions[1].review_input.issues).toEqual(original.review.issues);
  expect(versions[1].review.issues.length).toBeLessThan(original.review.issues.length);
  expect(versions[0].content).toEqual(original.content);
  expect(versions[1].trace.actual_model_call).toBe(false);
  await expect(page.locator(".delivery-status")).toContainText("待补充核验");
  const stale = await page.request.post(`/api/listings/${original.listing_id}/revisions`, { data: { base_version: 1, kind: "review_issues" } });
  expect(stale.status()).toBe(409);
});

for (const route of ["copy", "facts"] as const) {
  test(`accuracy issue can be resolved through ${route} without overwriting history`, async ({ page }) => {
    const response = await page.request.post("/api/products", { data: { fields: {
      name_zh: `准确性处理-${route}`, material: "100% cotton", width: 38, height: 42,
      fabric_weight_gsm: 140, capacity_l: 10, handle_length_cm: 67, retail_pack_count: 1,
      brand: "", color: "",
    } } });
    expect(response.ok()).toBe(true);
    const product = await response.json();
    await page.goto("/");
    await page.locator("nav").getByRole("button", { name: "诊断与修复", exact: true }).click();
    await page.getByLabel("关联商品").selectOption(product.product_id);
    await page.locator('[id="content.title"]').fill("Cotton Tote Bag");
    await page.locator('[id="content.item_highlights"]').fill("999 g/m² cotton fabric.");
    await page.locator('[id="content.description"]').fill("Cotton tote bag for everyday use.");
    await page.getByRole("button", { name: "检查这份文案" }).click();
    const issue = page.locator(".issue-card").filter({ hasText: "商品描述准确性" });
    await expect(issue).toHaveCount(1);
    const before = await (await page.request.get("/api/bootstrap")).json();
    const original = before.listings.find((item: { product_ref: string }) => item.product_ref === `${product.product_id}@${product.revision}`);
    if (route === "copy") {
      await issue.getByRole("button", { name: "修改这段文案" }).click();
      await expect(page.locator('[id="content.item_highlights"]')).toBeFocused();
      await page.locator('[id="content.item_highlights"]').fill("140 g/m² cotton fabric.");
      await page.getByRole("button", { name: "保存并重新检查" }).click();
      await expect(page.locator(".version-badge")).toHaveText("V2");
    } else {
      await issue.getByRole("button", { name: "核对 / 补充商品资料" }).click();
      const dialog = page.getByRole("dialog", { name: "核对商品资料并重新诊断" });
      await dialog.getByRole("button", { name: "编辑资料" }).click();
      await expect(dialog.getByRole("button", { name: "采用当前资料并复检（保存新版本）" })).toBeDisabled();
      await dialog.getByLabel("面料克重 (g/m²)", { exact: true }).fill("999");
      await dialog.getByRole("button", { name: "保存为新版本" }).click();
      await expect(dialog.getByRole("button", { name: "采用当前资料并复检（保存新版本）" })).toBeEnabled();
      await dialog.getByRole("button", { name: "采用当前资料并复检（保存新版本）" }).click();
      await expect(page.locator(".busy-overlay")).toBeHidden();
    }
    await page.locator(".editor-tabs").getByRole("button", { name: /检查与依据/ }).click();
    await expect(issue).toHaveCount(0);
    const versions = await (await page.request.get(`/api/listings/${original.listing_id}/versions`)).json();
    expect(versions[0].content.item_highlights).toBe("999 g/m² cotton fabric.");
    expect(versions[0].product_snapshot.fabric_weight_gsm.value).toBe(140);
    if (route === "facts") {
      const after = await (await page.request.get("/api/bootstrap")).json();
      expect(versions).toHaveLength(2);
      expect(versions[1].product_snapshot.fabric_weight_gsm.value).toBe(999);
      expect(versions[1].content).toEqual(original.content);
      expect(versions[1].product_change).toEqual({ before: product.product_id + '@1', after: product.product_id + '@2' });
      expect(after.listings.filter((item: { product_snapshot: { product_id: string } }) => item.product_snapshot?.product_id === product.product_id)).toHaveLength(1);
    }
  });
}

test("create, revise twice, compare immutable versions and export", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "创建英文 Listing", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "新品 Listing 创建" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "开始创建", exact: true }).click();
  await expect(page.locator(".version-badge")).toHaveText("V1");
  await expect(page.locator('[id="content.title"]')).toHaveValue(
    /Cotton Tote Bag/,
  );
  await page
    .getByRole("textbox", { name: "对话修改指令" })
    .fill("标题简洁一些，把材质信息移到亮点。");
  await page.getByRole("button", { name: "提交修改指令" }).click();
  await expect(page.locator(".version-badge")).toHaveText("V2");
  await page
    .getByRole("textbox", { name: "对话修改指令" })
    .fill("描述突出日常通勤，保留尺寸和每包一件的信息。");
  await page.getByRole("button", { name: "提交修改指令" }).click();
  await expect(page.locator(".version-badge")).toHaveText("V3");
  await expect(page.locator('[id="content.description"]')).toHaveValue(
    /commuting/,
  );
  await page
    .locator(".editor-tabs")
    .getByRole("button", { name: /版本对比/ })
    .click();
  await expect(page.locator(".version-selector button")).toHaveCount(3);
  await expect(page.locator(".diff-after")).toContainText("38 × 42 cm");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: /完整结构化结果/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("listing-v3.json");
  const boot = await page.request.get("/api/bootstrap");
  const data = await boot.json();
  const created = data.listings.find(
    (x: { workflow: string }) => x.workflow === "listing_create",
  );
  expect(created.version).toBe(3);
  expect(created.product_snapshot.fabric_weight_gsm.value).toBe(140);
  expect(created.trace.actual_model_call).toBe(false);
  expect(errors).toEqual([]);
});

test("independent diagnosis, source feedback, selected repair and review update", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator("nav")
    .getByRole("button", { name: "诊断与修复", exact: true })
    .click();
  await page.getByRole("button", { name: "载入问题样例" }).click();
  await page.getByRole("button", { name: "检查这份文案" }).click();
  await expect(page.locator(".version-badge")).toHaveText("V1");
  await expect(page.locator(".review-summary")).toContainText(
    "发现需要处理的内容",
  );
  await expect(
    page.locator(".issue-card").filter({ hasText: "US-02" }),
  ).toHaveCount(1);
  await expect(
    page.locator(".issue-card").filter({ hasText: "AMZ-03" }),
  ).toHaveCount(1);
  await page
    .locator(".issue-card")
    .filter({ hasText: "US-02" })
    .getByRole("button", { name: "查看依据" })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Federal Trade Commission",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  for (const checkbox of await page.locator(".patch-choice input").all())
    await checkbox.check();
  await page.getByRole("button", { name: /预览 \d+ 处修改/ }).click();
  await expect(
    page.getByRole("dialog", { name: "确认局部修改" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "应用并重新检查" }).click();
  await expect(page.locator(".version-badge")).toHaveText("V2");
  await expect(page.locator(".issue-card")).toHaveCount(0);
  await expect(page.locator(".checks-table")).toContainText("未完成");
  const data = await (await page.request.get("/api/bootstrap")).json();
  const fixed = data.listings.find(
    (x: { workflow: string }) => x.workflow === "listing_diagnose",
  );
  expect(
    fixed.content.bullet_points.find((x: { id: string }) => x.id === "b4").text,
  ).toBe("100% cotton with 67 cm handles.");
  expect(fixed.review.status).toBe("needs_attention");
  await expect(page.locator(".delivery-status")).toContainText(
    `${fixed.review.coverage.total - fixed.review.coverage.completed} 项检查未完成`,
  );
  await expect(page.locator(".delivery-status")).toContainText("待补充核验");
});

test("manual product entry stores merchant provenance and works in create flow", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator("nav")
    .getByRole("button", { name: "商品资料", exact: true })
    .click();
  await page.getByRole("button", { name: "新增商品", exact: true }).click();
  await page.getByLabel("商品名称", { exact: true }).fill("我的棉布袋");
  await page.getByLabel("宽度 (cm)", { exact: true }).fill("35");
  await page.getByLabel("高度 (cm)", { exact: true }).fill("40");
  await page.getByLabel("面料克重 (g/m²)", { exact: true }).fill("180");
  await page.getByLabel("容量 (L)", { exact: true }).fill("9");
  await page.getByLabel("提手长度 (cm)", { exact: true }).fill("60");
  await page.getByRole("button", { name: "保存商品", exact: true }).click();
  await expect(page.locator(".product-detail")).toContainText("商家确认");
  await expect(page.locator(".product-detail")).toContainText("180 g/m²");
  await page.getByRole("button", { name: "使用当前商品创建" }).click();
  await page.getByRole("button", { name: "开始创建", exact: true }).click();
  await expect(page.locator(".version-badge")).toHaveText("V1");
  await expect(page.locator('[id="content.item_highlights"]')).toHaveValue(
    /180 g\/m²/,
  );
});

test("DeepSeek settings are prefilled and saving never returns API secrets", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page.getByRole("button", { name: /DeepSeek \/ 兼容接口/ }).click();
  await page.getByRole("button", { name: "填入 DeepSeek 预设" }).click();
  await expect(page.getByLabel("服务地址（含 API 前缀）")).toHaveValue(
    "https://api.deepseek.com",
  );
  await expect(page.getByLabel("模型名称", { exact: true })).toHaveValue(
    "deepseek-flash",
  );
  await page
    .getByLabel("API Key", { exact: true })
    .fill("e2e-only-not-a-real-key");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const response = await page.request.get("/api/settings");
  const settings = await response.json();
  expect(settings.has_api_key).toBe(true);
  expect(settings.api_key).toBeUndefined();
  expect(JSON.stringify(settings)).not.toContain("e2e-only");
  await page.request.post("/api/settings", {
    data: {
      provider: "demo",
      base_url: "https://api.deepseek.com",
      model: "deepseek-flash",
      dify_base_url: "https://api.dify.ai/v1",
      timeout_ms: 60000,
      clear_secrets: true,
    },
  });
});

test("mobile layout has no horizontal overflow and can open settings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "内容工作台" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("workspace dashboard filters real tasks and shows delivery limitations", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "内容工作台" })).toBeVisible();
  await expect(page.locator(".home-stats")).toContainText("待补充核验");
  await page
    .getByRole("textbox", { name: "搜索内容任务" })
    .fill("a-name-that-does-not-exist");
  await expect(page.locator(".task-empty")).toContainText("没有符合条件的任务");
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page.getByRole("textbox", { name: "搜索内容任务" })).toHaveValue(
    "",
  );
  await page.getByRole("button", { name: /试试问题样例/ }).click();
  await page.getByRole("button", { name: "检查这份文案" }).click();
  await expect(page.locator(".delivery-status")).toContainText("待修复");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.locator(".export-readiness")).toContainText(
    "导出不代表已通过 Amazon 上架审核",
  );
  await expect(page.locator(".export-readiness")).toContainText(
    "未执行完整模型语义审阅",
  );
});

test("iOS layouts stay within desktop and phone viewports across the workspace", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "内容工作台" }),
    ).toBeVisible();
    await page.screenshot({
      path: `.runtime/ios-home-${width}.png`,
      fullPage: true,
    });
    for (const label of [
      "新品 Listing",
      "诊断与修复",
      "商品资料",
      "版本记录",
      "规则与来源",
      "工作台",
    ]) {
      await page
        .locator(".sidebar")
        .getByRole("button", { name: label, exact: true })
        .click();
      await expect(page.locator(".page-heading h1")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${label} overflows at ${width}px`,
      ).toBe(true);
      if (label === "新品 Listing")
        await page.screenshot({
          path: `.runtime/ios-create-${width}.png`,
          fullPage: true,
        });
    }
  }
  expect(errors).toEqual([]);
});

test("Amazon snapshot trial preserves provenance, unknown specs and generated listings", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("商品读取方式").selectOption("snapshot");
  await page.getByRole("button", { name: "随机抽取 3 件并生成", exact: true }).click();
  await expect(page.locator(".amazon-import-results article")).toHaveCount(3);
  await expect(page.locator(".amazon-import-results article .amazon-result-title").filter({ hasText: "生成与审阅已完成" })).toHaveCount(3);
  const rain = page.locator(".amazon-import-results article").filter({ hasText: "B0F7HF7KDZ" });
  await expect(rain).toContainText("已保存来源快照");
  await page.screenshot({ path: ".runtime/amazon-trial-desktop.png", fullPage: true });
  await rain.getByRole("button", { name: "查看商品资料" }).click();
  await expect(page.locator(".product-detail")).toContainText("50% cotton");
  await expect(page.locator(".product-detail")).toContainText("未披露");
  await expect(page.locator(".product-detail")).not.toContainText("null");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".runtime/amazon-product-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "查看材质来源", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Amazon.com 商品详情页");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const listing = boot.listings.find((item: { product_snapshot?: { amazon?: { asin: string } } }) => item.product_snapshot?.amazon?.asin === "B0F7HF7KDZ");
  expect(listing.trace.source_ids.some((id: string) => id.startsWith("AMZ-PAGE-"))).toBe(true);
  const report = await page.request.get(`/api/listings/${listing.listing_id}/export?version=1&format=html`);
  expect(await report.text()).toContain("https://www.amazon.com/dp/B0F7HF7KDZ");
  const invalid = await page.request.post("/api/amazon/import", { data: { reference: "https://127.0.0.1/secret", mode: "live" } });
  expect(invalid.status()).toBe(400);
});
