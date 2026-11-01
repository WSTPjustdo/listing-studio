import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server/store.mjs";
import { createBatchManager } from "../server/batch.mjs";

/*
 * 守卫「一行要落盘几次」。
 *
 * 背景（第 11 轮实测，scripts/batch-scale-probe.mjs）：批次的每一行状态变化都会把整批 blob
 * 完整重写一次。2000 行时 blob 4.66 MB，每行写 3 次 = 13.6 MB/行，整批 26 GB，
 * 光存储与调度就要 8 分钟。把 dispatchRow 里那次多余的 saveBatch 去掉后是 2 次/行。
 *
 * 这两个用例不调模型：service.enqueue 换成立刻成功的桩，只驱动真实管理器与真实 store。
 */

const HEADERS = ["SKU", "商品名称", "品类", "材质", "宽度", "高度", "克重", "提手长度", "每包件数"];
const MAPPING = { sku: 0, name: 1, category: 2, material: 3, width: 4, height: 5, fabric_weight_gsm: 6, handle_length_cm: 7, retail_pack_count: 8 };

function harness(rowCount) {
  const store = createStore(":memory:");
  const realSaveBatch = store.saveBatch;
  const writes = { calls: 0, bytes: 0 };
  store.saveBatch = (value) => {
    writes.calls += 1;
    writes.bytes += Buffer.byteLength(JSON.stringify(value));
    return realSaveBatch(value);
  };
  let seq = 0;
  const service = {
    enqueue() {
      seq += 1;
      const listingId = `listing-guard-${seq}`;
      const run = store.createRun({ listing_id: listingId, operation: "create", provider: "compatible" });
      store.updateRun(run.run_id, { status: "succeeded", listing_id: listingId, version: 1 });
      return run;
    },
  };
  store.saveSettings({ provider: "compatible", model: "guard-model" });
  const manager = createBatchManager(store, service);
  store.saveImport({
    id: "guard-import",
    filename: "guard.csv",
    sheet: "Sheet1",
    headers: HEADERS,
    selection_required: false,
    rows: Array.from({ length: rowCount }, (_, i) => ({
      number: i + 2,
      cells: [`GUARD-${i + 1}`, `棉布袋 ${i + 1}`, "棉布袋", "100% cotton", "38", "42", "140", "67", "1"],
    })),
  });
  const start = () =>
    manager.start({
      import_id: "guard-import",
      mapping: MAPPING,
      operation: "create",
      duplicate: "skip",
      confirm_scope: true,
      selected: Array.from({ length: rowCount }, (_, i) => i + 2),
    });
  const runToEnd = () => {
    for (let i = 0; i < rowCount * 8 + 20; i++) {
      manager.tick();
      if (store.batch(batch.id).status === "finished") return true;
    }
    return false;
  };
  const batch = start();
  writes.calls = 0;
  writes.bytes = 0;
  return { store, manager, writes, batch, runToEnd };
}

test("每完成一行只把整批落盘两次（派发一次、完成一次）", () => {
  const rowCount = 12;
  const h = harness(rowCount);
  try {
    assert.ok(h.runToEnd(), "批次应跑完");
    const finished = h.store.batch(h.batch.id);
    assert.equal(finished.rows.filter((r) => r.status === "completed").length, rowCount);
    // 多出来的一次就是「商品落盘后紧接着又整批写一遍」——2026-10-29 实测那是每行 4.6 MB 的浪费。
    assert.equal(h.writes.calls, rowCount * 2, `期望 ${rowCount * 2} 次整批落盘（2 次/行），实际 ${h.writes.calls} 次`);
  } finally {
    h.manager.close();
    h.store.close();
  }
});

test("商品已落盘但批次没落盘时，重新派发不会撞 STALE_PRODUCT", () => {
  const h = harness(1);
  try {
    assert.ok(h.runToEnd());
    const finished = h.store.batch(h.batch.id);
    // 复现「进程停在两次写之间」：商品在库里已经是 revision=N，批次里 product_saved 却是空的。
    finished.rows[0].product_saved = false;
    finished.rows[0].status = "queued";
    delete finished.rows[0].run_id;
    delete finished.rows[0].listing_id;
    delete finished.rows[0].version;
    finished.rows[0].attempt = 1;
    finished.status = "running";
    h.store.saveBatch(finished);
    assert.ok(h.runToEnd(), "重跑应能完成");
    const after = h.store.batch(h.batch.id).rows[0];
    assert.equal(after.status, "completed", `不应因重复保存商品而失败：${after.error || ""}`);
    assert.notEqual(after.error_code, "STALE_PRODUCT");
  } finally {
    h.manager.close();
    h.store.close();
  }
});
