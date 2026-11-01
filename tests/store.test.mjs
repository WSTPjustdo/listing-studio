import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
import { createStore } from "../server/store.mjs";

test("SQLite data survives reopening and seed import does not overwrite later product versions", () => {
  const temp = mkdtempSync(join(tmpdir(), "listing-studio-test-"));
  const file = join(temp, "persistence.sqlite");
  let store;
  try {
    store = createStore(file);
    const original = store.products()[0];
    const next = structuredClone(original);
    next.revision = 2;
    next.name_zh = "持久化验证商品";
    store.saveProduct(next);
    const run = store.createRun({ operation: "diagnose" });
    store.updateRun(run.run_id, { status: "running" });
    store.close();
    store = null;
    store = createStore(file);
    assert.equal(store.product(original.product_id).name_zh, "持久化验证商品");
    assert.equal(
      store.product(original.product_id, 1).name_zh,
      original.name_zh,
    );
    store.interruptRuns();
    assert.equal(store.run(run.run_id).status, "failed");
    assert.equal(store.run(run.run_id).error.code, "INTERRUPTED");
  } finally {
    store?.close();
    const target = resolve(temp),
      parent = resolve(tmpdir());
    if (
      !target.startsWith(parent + sep) ||
      !basename(target).startsWith("listing-studio-test-")
    )
      throw new Error("unsafe temporary cleanup target");
    rmSync(target, { recursive: true, force: true });
  }
});
