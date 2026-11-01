import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { generateLocalDraft } from "../server/domain.mjs";

// 这条用例验的是 HTTP 层的整条链路：建商品 → 生成 → 改两版 → 拒旧版本 → 诊断 → 导出转义 → 换商品复检。
// 服务端现在拒绝演示返回和演示商品，所以起一个本地假上游，让它把"模型那一跳"接住；
// 其余每一跳都是真的（真 HTTP、真 sqlite、真渲染报告）。假上游自报 model=fake-1，日志里一眼可辨。
async function startFakeUpstream() {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(JSON.parse(body).messages[1].content);
      calls.push(request.operation);
      const content =
        request.operation === "diagnose" && request.current_content
          ? request.current_content
          : generateLocalDraft(request.product);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `fake-${calls.length}`,
          model: "fake-1",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  content,
                  review: { issues: [], checks: [] },
                  claim_map: [],
                  patches: [],
                }),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("API persists the two workflows, rejects stale revisions, and exports escaped reports", async () => {
  const port = 18798;
  const upstream = await startFakeUpstream();
  const processHandle = spawn(process.execPath, ["server/index.mjs"], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_PATH: ":memory:",
      MODEL_PROVIDER: "compatible",
      MODEL_BASE_URL: upstream.url,
      MODEL_NAME: "fake-1",
      MODEL_API_KEY: "local-fake",
      MODEL_TIMEOUT_MS: "10000",
    },
    stdio: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  const get = async (path) => (await fetch(base + path)).json();
  const post = async (path, data) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  const wait = async (run) => {
    for (let i = 0; i < 200; i++) {
      const status = await get(`/api/runs/${run.run_id}`);
      if (status.status === "failed") throw new Error(status.error.message);
      if (status.status === "succeeded") return status;
      await delay(30);
    }
    throw new Error("test run timeout");
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await get("/api/health")).ok) {
          ready = true;
          break;
        }
      } catch {}
      await delay(50);
    }
    assert.ok(ready, "server startup");
    // 演示商品已被 bootstrap 过滤（store 里只剩演示商品，所以这里是空的）。
    // 改成按真实录入路径建一条商品：这正是商家在表单里填完资料后的形状。
    const bootstrap = await get("/api/bootstrap");
    assert.deepEqual(bootstrap.products, [], "演示商品不应出现在 bootstrap 里");
    // 界面上的「本批预计 N 次调用」读这里，不再自己写 1 或 2。
    // 数值来自实测（scripts/batch-cost-probe.mjs --operation … --rows 12）：create 2 / diagnose 1 / optimize 2。
    assert.deepEqual(bootstrap.batch_calls_per_row, { create: 2, diagnose: 1, optimize: 2 },
      "每行调用次数的基准必须由服务端下发，界面不许各写一份");
    const product = await (
      await post("/api/products", {
        fields: {
          name_zh: "长提手棉布袋",
          material: "100% cotton",
          width: 38,
          height: 42,
          fabric_weight_gsm: 140,
          capacity_l: 10,
          handle_length_cm: 67,
          retail_pack_count: 1,
          brand: "",
          color: "",
        },
      })
    ).json();
    assert.equal(product.revision, 1);
    assert.equal(product.is_demo, false);
    const firstResponse = await post("/api/listings/create", {
      product_id: product.product_id,
      product_revision: 1,
      request_id: "test-create",
    });
    assert.equal(firstResponse.status, 202);
    const first = await firstResponse.json();
    await wait(first);
    const duplicate = await (
      await post("/api/listings/create", {
        product_id: product.product_id,
        request_id: "test-create",
      })
    ).json();
    assert.equal(duplicate.run_id, first.run_id);
    for (const [version, instruction] of [
      [1, "标题简洁一些"],
      [2, "描述突出日常通勤"],
    ]) {
      const response = await post(
        `/api/listings/${first.listing_id}/revisions`,
        { base_version: version, kind: "instruction", instruction },
      );
      assert.equal(response.status, 202);
      await wait(await response.json());
    }
    const versions = await get(`/api/listings/${first.listing_id}/versions`);
    assert.equal(versions.length, 3);
    assert.equal(versions[2].product_snapshot.fabric_weight_gsm.value, 140);
    assert.equal(versions[2].trace.actual_model_call, true);
    assert.equal(versions[2].trace.model, "fake-1");
    const stale = await post(`/api/listings/${first.listing_id}/revisions`, {
      base_version: 1,
      kind: "instruction",
      instruction: "标题简洁",
    });
    assert.equal(stale.status, 409);
    // 以前从 bootstrap.fixtures 里取一条坏文案；那个端点现在固定返回空数组。
    // 坏文案直接在这里写：要验的是"商家文案里塞 <script>，导出的报告必须转义"。
    const bad = {
      title: "Cotton Tote Bag<script>alert(1)</script>",
      item_highlights: "Waterproof and 100% organic cotton.",
      bullet_points: [{ id: "b1", text: "Handle length: 70 cm." }],
      description: "Contact us at seller@example.com for a discount. Price: $9.99.",
    };
    const diagnosed = await (
      await post("/api/listings/diagnose", {
        product_id: product.product_id,
        content: bad,
      })
    ).json();
    await wait(diagnosed);
    const report = await fetch(
      `${base}/api/listings/${diagnosed.listing_id}/export?version=1&format=html`,
    );
    const html = await report.text();
    assert.equal(report.status, 200);
    assert.ok(html.includes("&lt;script&gt;"));
    assert.equal(html.includes("<script>alert(1)</script>"), false);
    const records = await get("/api/listings");
    assert.equal(records.length, 2);
    const malformed = await post("/api/listings/diagnose", {
      content: { title: "x" },
    });
    assert.equal(malformed.status, 400);
    const untrusted = await fetch(base + "/api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://untrusted.example",
      },
      body: "{}",
    });
    assert.equal(untrusted.status, 403);
    const fields = { name_zh: product.name_zh, material: product.material.value, width: 38, height: 42,
      fabric_weight_gsm: 999, capacity_l: 10, handle_length_cm: 67, retail_pack_count: 1, brand: '', color: '' };
    const savedProduct = await (await post(`/api/products/${product.product_id}/versions`, { base_revision: product.revision, fields })).json();
    assert.equal(savedProduct.revision, 2);
    const recheckPath = `/api/listings/${first.listing_id}/revisions`;
    const oldProduct = await post(recheckPath, { base_version: 3, kind: 'recheck_product', product_revision: 1 });
    assert.equal(oldProduct.status, 409);
    const rechecked = await post(recheckPath, { base_version: 3, kind: 'recheck_product', product_revision: 2 });
    assert.equal(rechecked.status, 202);
    await wait(await rechecked.json());
    const updated = await get(`/api/listings/${first.listing_id}/versions`);
    assert.equal(updated.length, 4);
    assert.deepEqual(updated[3].content, versions[2].content);
    assert.equal(updated[3].product_snapshot.fabric_weight_gsm.value, 999);
    assert.equal(updated[0].product_snapshot.fabric_weight_gsm.value, 140);
    assert.deepEqual(updated[3].product_change, { before: `${product.product_id}@1`, after: `${product.product_id}@2` });
    assert.ok(upstream.calls.length >= 6, `假上游至少该被调用 6 次，实际 ${upstream.calls.length} 次`);
  } finally {
    processHandle.kill();
    await new Promise((resolve) => processHandle.once("exit", resolve));
    await upstream.close();
  }
});
