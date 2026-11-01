import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import {
  readTable,
  prepareRows,
  createBatchManager,
  exportBatch,
  issueGroups,
} from "../server/batch.mjs";
import { createStore } from "../server/store.mjs";
import { createService } from "../server/service.mjs";
import { generateLocalDraft } from "../server/domain.mjs";

// 批量任务现在拒绝演示返回（REAL_MODEL_REQUIRED）。本机没有 API Key，也不能花真钱，
// 所以喂一个本地假上游：请求仍走完整的真实路径（拼 prompt、发 HTTP、解析、独立复检），
// 只有最后那一跳是假的，而且假上游在 trace 里报的模型名就是 fake-1，一眼可辨。
// 这组用例验的是批次状态机（暂停/续跑/只重试失败行/导出字符串单元格），
// 与"模型真的说了什么"无关。
function useFakeModel(store) {
  const original = globalThis.fetch;
  store.saveSettings({
    provider: "compatible",
    base_url: "http://127.0.0.1:9/v1",
    model: "fake-1",
    api_key: "local-fake",
    timeout_ms: 10000,
  });
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(JSON.parse(options.body).messages[1].content);
    const content =
      request.operation === "diagnose" && request.current_content
        ? request.current_content
        : generateLocalDraft(request.product);
    // 组内批量修复（AMZ-01 标题超长）依赖 record.patches，而补丁只可能来自模型返回。
    // 假上游因此要真的给一条可应用的补丁：把标题截到 75 码点。
    const patches =
      [...content.title].length > 75
        ? [{
            field_path: "content.title",
            expected_before: content.title,
            replacement: [...content.title].slice(0, 75).join(""),
            reason: "标题超过 75 个字符。",
          }]
        : [];
    return new Response(
      JSON.stringify({
        id: `fake-${Math.random().toString(16).slice(2)}`,
        model: "fake-1",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                content,
                review: { issues: [], checks: [] },
                claim_map: [],
                patches,
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  };
  return () => {
    globalThis.fetch = original;
  };
}

const csv =
  'SKU,商品名称,品类,材质,宽度,高度,克重,英文标题,英文描述\r\n001,棉布袋,棉布手提袋,100% cotton,38,42,140,Cotton Tote Bag,"Cotton bag, for daily use."\r\n002,棉布袋2,棉布手提袋,,,,,Cotton Tote Bag,Simple tote bag\r\n';
const inputFor = (source) => ({
  import_id: source.id,
  mapping: source.mapping,
  operation: "create",
  duplicate: "skip",
  confirm_scope: false,
  selected: source.rows.map((r) => r.number),
  edits: {},
});

// 批量按市场跑：站点决定用哪份规则包。
// 以前批次只有语言、没有站点，德语批次会拿美国包出结论——语言对了、依据错了。
test("批量批次带站点：德语必须配德国站，站点跟着进每一行的入队参数", async () => {
  const store = createStore(":memory:");
  const restore = useFakeModel(store);
  const enqueued = [];
  const manager = createBatchManager(store, {
    // 只验证入队参数，不跑模型：把入队记下来就够
    enqueue: (input) => {
      enqueued.push(input);
      return { run_id: `run-${enqueued.length}`, listing_id: `listing-${enqueued.length}`, status: "running" };
    },
  });
  try {
    const source = { id: "import-market", ...(await readTable("test.csv", Buffer.from(csv))) };
    store.saveImport(source);
    // 德语 + 默认美国站：拒绝，而不是静默按美国包跑
    assert.throws(() => manager.start({ ...inputFor(source), language: "de" }), { code: "LANGUAGE_MARKETPLACE_MISMATCH" });

    const batch = manager.start({ ...inputFor(source), language: "de", marketplace: "DE" });
    assert.equal(batch.marketplace, "DE");
    assert.equal(batch.language, "de");
    assert.equal(store.batch(batch.id).marketplace, "DE");
    manager.tick();
    assert.ok(enqueued.length > 0);
    assert.equal(enqueued[0].marketplace, "DE");
    assert.equal(enqueued[0].language, "de");
    // 语言名写进指令时不能是 undefined
    assert.match(enqueued[0].instruction, /德语/);

    // 不传站点仍是美国站，老批次行为不变（同一份导入只能建一批，所以换一份来源）
    const other = { id: "import-market-2", ...(await readTable("test.csv", Buffer.from(csv))) };
    store.saveImport(other);
    assert.equal(manager.start(inputFor(other)).marketplace, "US");
  } finally {
    manager.close();
    restore();
    store.close();
  }
});

test("batch optimize repairs existing copy in demo without discarding original imported text", async () => {
  const store = createStore(":memory:");
  const restore = useFakeModel(store);
  const manager = createBatchManager(store, createService(store));
  try {
    const originalTitle = "Cotton Tote Bag ".repeat(10).trim();
    const source = {
      id: "optimize",
      ...(await readTable(
        "optimize.csv",
        Buffer.from(
          `SKU,商品名称,品类,材质,英文标题,英文描述\nOPT-1,棉布袋,棉布手提袋,100% cotton,${originalTitle},Simple cotton bag.`,
        ),
      )),
    };
    store.saveImport(source);
    const batch = manager.start({ ...inputFor(source), operation: "optimize" });
    for (
      let i = 0;
      i < 100 && store.batch(batch.id).status !== "finished";
      i++
    ) {
      manager.tick();
      await delay(15);
    }
    const row = store.batch(batch.id).rows[0];
    assert.equal(row.status, "completed");
    const result = store.latest(row.listing_id);
    assert.ok(result.content.title.length <= 75);
    assert.equal(result.trace.actual_model_call, true);
    assert.equal(result.trace.model, "fake-1");
    assert.equal(row.content.title, originalTitle);
  } finally {
    manager.close();
    store.close();
    restore();
  }
});
test("CSV and XLSX import preserve SKU, unknown fields and reject formulas or unsupported categories", async () => {
  const store = createStore(":memory:");
  try {
    const source = {
      id: "import",
      ...(await readTable("test.csv", Buffer.from(csv))),
    };
    assert.equal(source.rows[0].cells[0], "001");
    assert.equal(source.rows[0].cells[8], "Cotton bag, for daily use.");
    const rows = prepareRows(store, source, inputFor(source));
    assert.equal(rows[0].product.dimensions_cm.value.width, 38);
    assert.equal(rows[1].product.material.value, null);
    assert.equal(rows[1].status, "queued");
    assert.ok(rows[1].warnings.length);
    const invalid = prepareRows(store, source, {
      ...inputFor(source),
      edits: { 2: { category: "露营灯" } },
    });
    assert.equal(invalid[0].status, "blocked");
    // 单位写法本身是被支持的：`15 inches` 会被明确换算成 38.1 cm（原文写了单位，不是猜的）。
    // 这条用例要守的是"不认识/没写清的单位不许悄悄当成数字"，所以举一个真非法的单位。
    const units = prepareRows(store, source, {
      ...inputFor(source),
      edits: { 2: { width: "15 furlong" } },
    });
    assert.equal(units[0].status, "blocked");
    assert.match(units[0].errors.join(" "), /单位无效/);
    const converted = prepareRows(store, source, {
      ...inputFor(source),
      edits: { 2: { width: "15 inches" } },
    });
    assert.equal(converted[0].product.dimensions_cm.value.width, 38.1);
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet("资料");
    sheet.addRow(["SKU", "商品名称"]);
    sheet.addRow(["0004", "棉布袋"]);
    const parsed = await readTable(
      "test.xlsx",
      Buffer.from(await book.xlsx.writeBuffer()),
    );
    assert.equal(parsed.rows[0].cells[0], "0004");
    sheet.getCell("B2").value = { formula: "1+1", result: 2 };
    await assert.rejects(
      () =>
        book.xlsx
          .writeBuffer()
          .then((data) => readTable("test.xlsx", Buffer.from(data))),
      { code: "FORMULA_INPUT" },
    );
  } finally {
    store.close();
  }
});

test("batch persists, isolates failures, pauses, retries only failed rows and exports string cells", async () => {
  const folder = mkdtempSync(join(tmpdir(), "listing-batch-")),
    filename = join(folder, "db.sqlite");
  let store = createStore(filename),
    manager;
  const restore = useFakeModel(store);
  try {
    const source = {
      id: "import-batch",
      ...(await readTable("test.csv", Buffer.from(csv))),
    };
    store.saveImport(source);
    const real = createService(store);
    let fail = true;
    manager = createBatchManager(store, {
      enqueue(input) {
        if (fail && input.product.sku === "001")
          throw new Error("test failure");
        return real.enqueue(input);
      },
    });
    const batch = manager.start(inputFor(source));
    assert.equal(manager.start(inputFor(source)).id, batch.id);
    manager.action(batch.id, "pause");
    manager.tick();
    assert.equal(store.batch(batch.id).rows[0].status, "queued");
    manager.action(batch.id, "resume");
    for (
      let i = 0;
      i < 100 && store.batch(batch.id).status !== "finished";
      i++
    ) {
      manager.tick();
      await delay(15);
    }
    let done = store.batch(batch.id);
    assert.deepEqual(
      done.rows.map((r) => r.status),
      ["failed", "completed"],
    );
    const kept = done.rows[1].listing_id;
    fail = false;
    manager.action(batch.id, "retry");
    for (
      let i = 0;
      i < 100 && store.batch(batch.id).status !== "finished";
      i++
    ) {
      manager.tick();
      await delay(15);
    }
    done = store.batch(batch.id);
    assert.deepEqual(
      done.rows.map((r) => r.status),
      ["completed", "completed"],
    );
    assert.equal(done.rows[1].listing_id, kept);
    // 导出已经不是"第一张表就是明细"了：批次总览插到了最前面。
    // 按下标取表会让这条断言在版式调整后指向总览页（实测拿到的是"批次"这个表头），
    // 所以改成按表名取，版式再变也不会指错表。
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.load(await exportBatch(store, done));
    assert.equal(exported.worksheets[0].name, "批次总览");
    const detail = () => exported.getWorksheet("商品文案");
    assert.equal(detail().getCell("A2").text, "001");
    done.rows[0].sku = '=HYPERLINK("test")';
    await exported.xlsx.load(await exportBatch(store, done));
    assert.equal(typeof detail().getCell("A2").value, "string");
    const duplicate = prepareRows(store, source, inputFor(source));
    assert.ok(duplicate.every((r) => r.status === "skipped"));
    const update = prepareRows(store, source, {
      ...inputFor(source),
      duplicate: "update",
      edits: { 2: { material: "" } },
    });
    assert.equal(update[0].product.material.value, "100% cotton");
    manager.close();
    store.close();
    store = createStore(filename);
    assert.equal(store.batch(batch.id).rows[1].listing_id, kept);
  } finally {
    manager?.close();
    store.close();
    restore();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("group actions preview safely, isolate failures, retry and preserve deferred risks", async () => {
  const store = createStore(":memory:");
  const restore = useFakeModel(store);
  const real = createService(store);
  let fail = false;
  const manager = createBatchManager(store, {
    enqueue(input) {
      if (fail && input.previous && input.product.sku === "GR-2")
        throw new Error("simulated failure");
      return real.enqueue(input);
    },
  });
  const settle = async (id) => {
    for (let i = 0; i < 200 && store.batch(id).status !== "finished"; i++) {
      manager.tick();
      await delay(10);
    }
    assert.equal(store.batch(id).status, "finished");
  };
  try {
    const title = "Cotton Tote Bag ".repeat(10).trim();
    const source = {
      id: "group-import",
      ...(await readTable(
        "group.csv",
        Buffer.from(
          "SKU,商品名称,品类,材质,英文标题,英文描述\n" +
            [1, 2, 3]
              .map(
                (n) =>
                  "GR-" +
                  n +
                  ",棉布袋,棉布手提袋,100% cotton," +
                  title +
                  ",Keep this description.",
              )
              .join("\n"),
        ),
      )),
    };
    store.saveImport(source);
    const batch = manager.start({ ...inputFor(source), operation: "diagnose" });
    await settle(batch.id);
    const group = issueGroups(store, store.batch(batch.id)).find(
      (g) => g.rule_id === "AMZ-01",
    );
    assert.equal(group.members.length, 3);
    const request = {
      rule_id: group.rule_id,
      action: "repair",
      request_id: "repair-group",
      items: group.members
        .slice(0, 2)
        .map((m) => ({ row: m.row, version: m.version })),
    };
    const preview = manager.groupAction(batch.id, {
      ...request,
      preview: true,
    });
    assert.ok(preview.items.every((i) => i.patches.length));
    assert.equal(store.batch(batch.id).group_actions, undefined);
    assert.throws(
      () =>
        manager.groupAction(batch.id, {
          ...request,
          items: [request.items[0], { ...request.items[1], version: 99 }],
        }),
      { code: "STALE_VERSION" },
    );
    assert.equal(store.batch(batch.id).group_actions, undefined);
    fail = true;
    manager.groupAction(batch.id, request);
    await settle(batch.id);
    let rows = store.batch(batch.id).rows;
    assert.deepEqual(
      rows.map((r) => r.status),
      ["completed", "failed", "completed"],
    );
    assert.deepEqual(
      rows.map((r) => store.latest(r.listing_id).version),
      [2, 1, 1],
    );
    manager.groupAction(batch.id, request);
    assert.equal(store.batch(batch.id).group_actions.length, 1);
    fail = false;
    manager.action(batch.id, "retry");
    await settle(batch.id);
    rows = store.batch(batch.id).rows;
    assert.deepEqual(
      rows.map((r) => store.latest(r.listing_id).version),
      [2, 2, 1],
    );
    assert.equal(
      store.latest(rows[0].listing_id).content.description,
      "Keep this description.",
    );
    const remaining = issueGroups(store, store.batch(batch.id)).find(
      (g) => g.rule_id === "AMZ-01",
    );
    assert.equal(remaining.members.length, 1);
    const third = remaining.members[0];
    manager.groupAction(batch.id, {
      rule_id: remaining.rule_id,
      action: "defer",
      request_id: "defer-group",
      items: [{ row: third.row, version: third.version }],
    });
    assert.equal(
      issueGroups(store, store.batch(batch.id)).find(
        (g) => g.rule_id === "AMZ-01",
      ).members[0].deferred,
      true,
    );
    assert.equal(store.latest(rows[2].listing_id).version, 1);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      await exportBatch(store, store.batch(batch.id), true),
    );
    assert.ok(workbook.getWorksheet("集中处理记录"));
    assert.ok(workbook.worksheets[0].rowCount > 1);
    manager.groupAction(batch.id, {
      rule_id: remaining.rule_id,
      action: "review",
      request_id: "review-group",
      items: [{ row: third.row, version: third.version }],
    });
    await settle(batch.id);
    const reviewed = store.latest(rows[2].listing_id);
    assert.equal(reviewed.version, 2);
    assert.ok(
      reviewed.review_input.issues.every((i) => i.rule_id === "AMZ-01"),
    );
    assert.equal(reviewed.content.description, "Keep this description.");
  } finally {
    manager.close();
    store.close();
    restore();
  }
});
