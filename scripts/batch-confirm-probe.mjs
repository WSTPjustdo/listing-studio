/**
 * 确认页那句话，浏览器里到底显示了什么。
 *
 * 用法：
 *   node scripts/batch-confirm-probe.mjs          # 人读
 *   node scripts/batch-confirm-probe.mjs --json
 *
 * 为什么要有这个：
 *   「每件 N 次模型调用，本批预计 M 次」是评委最容易当场验算的一句话——
 *   只要把行数乘以每件次数就能对。这句话以前只有 tsc 和 bootstrap 断言盖着，
 *   **没人在浏览器里点过**（第 15 轮 handoff 必须人工清单第 7 条）。
 *   更糟的是：三种操作每件次数不同（create 2 / diagnose 1 / optimize 2），
 *   如果界面上写死成 2，diagnose 那一档就会当场说错。
 *
 * 判据：界面上的数字必须等于 CALLS_PER_ROW[operation] × 已排队行数。
 *
 * 两个把行变成「需修正」的坑，量的时候踩到了（都不是 bug，是设计如此）：
 *   · 尺寸必须带单位（`38 cm`；只写 `38` 会判"宽度或单位无效"）
 *   · 品类要写「棉布手提袋」；写 `tote bag` 会判"当前只支持棉布手提袋"
 *   · 不勾「我确认未填写品类…」时整批不进队，确认页会老实说"预计 0 件"
 * 假上游只为了让页面有数据，全程不联网、不调真实模型。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ROOT } from "../server/store.mjs";
import { CALLS_PER_ROW } from "../server/batch-cost.mjs";

const asJson = process.argv.includes("--json");
const PORT = 18802;
const BASE = `http://127.0.0.1:${PORT}`;
const ROWS = 12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HEADERS = ["SKU", "商品名称", "品类", "材质", "宽度", "高度", "克重", "提手长度", "每包件数", "英文标题"];
const csv = () =>
  [
    HEADERS.join(","),
    ...Array.from({ length: ROWS }, (_, i) =>
      [
        `SKU-${String(i + 1).padStart(5, "0")}`,
        `长提手棉布袋 ${i + 1}`,
        "棉布手提袋",
        "100% cotton",
        "38 cm",
        "42 cm",
        "140",
        "67",
        "1",
        `Cotton Canvas Tote Bag ${i + 1}`,
      ].join(","),
    ),
  ].join("\n");

function startUpstream() {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const isModels = req.method === "GET" && /\/models$/.test(req.url || "");
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "probe" });
      if (isModels) return res.end(JSON.stringify({ data: [{ id: "probe-model" }] }));
      res.end(
        JSON.stringify({
          id: "probe-1",
          model: "probe-model",
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
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
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => done({ url: `http://127.0.0.1:${server.address().port}`, server })),
  );
}

function startServer(upstreamUrl) {
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATABASE_PATH: ":memory:",
      MODEL_PROVIDER: "compatible",
      MODEL_BASE_URL: upstreamUrl,
      MODEL_NAME: "probe-model",
      MODEL_API_KEY: "sk-fake-local",
      MODEL_TIMEOUT_MS: "8000",
    },
  });
  const log = [];
  child.stdout.on("data", (b) => log.push(String(b)));
  child.stderr.on("data", (b) => log.push(String(b)));
  return { child, log };
}

async function waitReady() {
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(50);
  }
  throw new Error("服务没起来");
}

const upstream = await startUpstream();
const server = startServer(upstream.url);
const dir = mkdtempSync(join(tmpdir(), "confirm-probe-"));
const csvPath = join(dir, "probe.csv");
writeFileSync(csvPath, csv(), "utf8");

const out = { rows: ROWS, calls_per_row: CALLS_PER_ROW, cases: [], error: null };
let browser;
try {
  await waitReady();
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".nav-item", { timeout: 60000 });
  // 2026-10-30 首页收敛为两条路径，旧入口折进「更多功能」，不展开就点不到
  await page.locator('.nav-item[aria-label="更多功能"]').click();
  await page.locator('.nav-item[aria-label="批量商品"]').click();
  await page.locator('input[aria-label="上传商品表"]').setInputFiles(csvPath);
  await page.locator(".batch-setup").waitFor({ timeout: 30000 });
  await sleep(800);

  // 不勾这一项，所有行都会判成「需修正」，那句子会老实说"预计 0 件"——
  // 那不是 bug，但量不到真实数字。先勾上，让 12 行真的排队。
  await page.locator('.batch-scope input[type="checkbox"]').check();
  await sleep(400);

  for (const operation of ["create", "diagnose", "optimize"]) {
    await page.locator('select[aria-label="批量任务类型"]').selectOption(operation);
    await sleep(400);
    // 映射是自动识别好的；要点「检查导入内容」才会出逐行结论与那句预计。
    await page.locator('button:has-text("检查导入内容")').click();
    await page
      .locator("p", { hasText: /次模型调用|按实际模型用量/ })
      .last()
      .waitFor({ timeout: 30000 })
      .catch(() => {});
    await sleep(500);
    const sentence = await page
      .locator("p", { hasText: /次模型调用|按实际模型用量/ })
      .last()
      .innerText()
      .catch(() => "");
    const text = sentence.replace(/\s+/g, " ").trim();
    // 「预计 N 件商品；」里的件数
    const queued = Number(/预计\s*(\d+)\s*件/.exec(text)?.[1] ?? NaN);
    const perRowShown = Number(/每件\s*(\d+)\s*次/.exec(text)?.[1] ?? NaN);
    const totalShown = Number(/本批预计\s*([\d,]+)\s*次/.exec(text)?.[1]?.replace(/,/g, "") ?? NaN);
    const expectedPer = CALLS_PER_ROW[operation];
    out.cases.push({
      operation,
      queued,
      text,
      per_row_shown: Number.isFinite(perRowShown) ? perRowShown : null,
      total_shown: Number.isFinite(totalShown) ? totalShown : null,
      expected_per_row: expectedPer ?? null,
      expected_total: expectedPer && Number.isFinite(queued) ? expectedPer * queued : null,
      matches:
        Number.isFinite(perRowShown) &&
        Number.isFinite(totalShown) &&
        Number.isFinite(queued) &&
        perRowShown === expectedPer &&
        totalShown === expectedPer * queued,
    });
    if (operation === "diagnose") {
      const shot = join(ROOT, ".runtime", "batch-confirm-probe");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(shot, { recursive: true });
      await page.screenshot({ path: join(shot, "confirm-diagnose.png") });
      out.screenshot = join(shot, "confirm-diagnose.png");
    }
  }
} catch (error) {
  out.error = String(error.message || error).split("\n")[0];
} finally {
  if (browser) await browser.close().catch(() => {});
  server.child.kill();
  upstream.server.close();
}

const allMatch = out.cases.length === 3 && out.cases.every((c) => c.matches);
out.verdict = out.error ? "probe_failed" : allMatch ? "matches" : "mismatch";

if (asJson) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`\n确认页「本批预计 N 次」核对 · ${ROWS} 行 · 假上游\n`);
  for (const c of out.cases) {
    console.log(`  ${c.operation.padEnd(9)} 排队 ${c.queued} 件 · 每件 ${c.per_row_shown ?? "—"} 次 · 合计 ${c.total_shown ?? "—"} 次` +
      `（应为 ${c.expected_per_row ?? "?"} / ${c.expected_total ?? "?"}）${c.matches ? " ✓" : " ✗"}`);
    console.log(`     界面原话：${c.text.slice(0, 110)}`);
  }
  if (out.error) console.log(`  脚本出错：${out.error}`);
  console.log(`\n  verdict: ${out.verdict}`);
}
