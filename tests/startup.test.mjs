/**
 * 「服务起不来」这条路的话术与判据。
 *
 * 为什么值得单测：
 *   这段代码只在「端口被占」时跑，而那是演示当天最容易出现、也最难复现的一种状态。
 *   等真撞上了才发现说错了话，就来不及改。所以把四类探针结果都钉死。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  describeListenFailure,
  frontendStaleness,
  probeHost,
  probeOccupant,
  stalenessWarning,
} from "../server/startup.mjs";

const eaddrinuse = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:8787"), {
  code: "EADDRINUSE",
});

function joined(lines) {
  return lines.join("\n");
}

test("自己已经在跑：说「已在运行」+ 给现成地址 + 退出码 3（不是失败）", () => {
  const out = describeListenFailure({
    error: eaddrinuse,
    port: 8787,
    probe: { kind: "ours", version: "0.1.0" },
  });
  assert.equal(out.exitCode, 3);
  const text = joined(out.lines);
  assert.match(text, /8787/);
  assert.match(text, /已经有一个 Listing Studio 在运行/);
  assert.match(text, /0\.1\.0/);
  assert.match(text, /http:\/\/127\.0\.0\.1:8787\//);
  assert.doesNotMatch(text, /Unhandled|setupListenHandle/);
});

test("别的程序占着：不许说成「我们的实例」，要给换端口的命令", () => {
  const out = describeListenFailure({
    error: eaddrinuse,
    port: 8787,
    probe: { kind: "other", status: 200, contentType: "text/html" },
  });
  assert.equal(out.exitCode, 4);
  const text = joined(out.lines);
  assert.match(text, /被别的程序占着/);
  assert.match(text, /text\/html/);
  assert.match(text, /set PORT=8788/);
  assert.doesNotMatch(text, /已经有一个 Listing Studio 在运行/);
});

test("占着但连不上：给「等两秒 / 换端口」，不猜是谁", () => {
  const out = describeListenFailure({
    error: eaddrinuse,
    port: 8787,
    probe: { kind: "unreachable", reason: "ECONNREFUSED" },
  });
  assert.equal(out.exitCode, 4);
  const text = joined(out.lines);
  assert.match(text, /连不上/);
  assert.match(text, /ECONNREFUSED/);
  assert.match(text, /set PORT=8788/);
});

test("探针没跑（probe 为 null）也不能编一个结论", () => {
  const out = describeListenFailure({ error: eaddrinuse, port: 8787 });
  assert.equal(out.exitCode, 4);
  assert.match(joined(out.lines), /连不上/);
});

test("不是端口错误时保持原本的失败语义（退出码 1，带上 Node 原文）", () => {
  const error = Object.assign(new Error("listen EACCES: permission denied"), { code: "EACCES" });
  const out = describeListenFailure({ error, port: 80 });
  assert.equal(out.exitCode, 1);
  const text = joined(out.lines);
  assert.match(text, /EACCES/);
  assert.match(text, /permission denied/);
});

test("通配地址要探 127.0.0.1", () => {
  assert.equal(probeHost("0.0.0.0"), "127.0.0.1");
  assert.equal(probeHost("::"), "127.0.0.1");
  assert.equal(probeHost("127.0.0.1"), "127.0.0.1");
  assert.equal(probeHost("localhost"), "localhost");
});

test("探针认得我们自己的 /api/health", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "0.1.0", provider: "compatible" }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const probe = await probeOccupant({ hostname: "127.0.0.1", port: server.address().port });
    assert.equal(probe.kind, "ours");
    assert.equal(probe.version, "0.1.0");
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test("探针把「200 + HTML」判成别的程序，不判成连上了", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>some other app</title>");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const probe = await probeOccupant({ hostname: "127.0.0.1", port: server.address().port });
    assert.equal(probe.kind, "other");
    assert.equal(probe.contentType, "text/html");
    assert.match(probe.sample, /some other app/);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test("探针把「ok:false 的 JSON」也判成别的程序", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, status: "degraded" }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const probe = await probeOccupant({ hostname: "127.0.0.1", port: server.address().port });
    assert.equal(probe.kind, "other");
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test("端口没人听：probe 返回 unreachable，不抛异常", async () => {
  const server = createServer(() => {});
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  const probe = await probeOccupant({ hostname: "127.0.0.1", port, timeoutMs: 800 });
  assert.equal(probe.kind, "unreachable");
});

// ---------- 前端产物过期 ----------
//
// 背景：服务端发 dist/，改完 src/ 直接 npm start 会看不到改动，以前窗口里一句话都没有。
// 这一组钉住三件事：刚构建完不许乱报、真过期必须报、dev（--watch）模式不吵。

function makeTree({ srcAge, distAge, slack = 0 }) {
  const root = mkdtempSync(join(tmpdir(), "ls-stale-"));
  mkdirSync(join(root, "src", "components"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.html"), "<!doctype html>");
  writeFileSync(join(root, "src", "App.tsx"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "components", "Batch.tsx"), "export const b = 2;\n");
  writeFileSync(join(root, "index.html"), "<div id=root></div>");
  const now = Date.now();
  const distTime = new Date(now - distAge);
  utimesSync(join(root, "dist", "index.html"), distTime, distTime);
  const srcTime = new Date(now - srcAge + slack);
  for (const rel of ["src/App.tsx", "src/components/Batch.tsx", "index.html"])
    utimesSync(join(root, rel), srcTime, srcTime);
  return root;
}

test("dist 比源码新：不报（刚构建完就说「过期」是最烦人的那种假红）", () => {
  const root = makeTree({ srcAge: 60_000, distAge: 1_000 });
  try {
    const info = frontendStaleness({ root, distDir: join(root, "dist") });
    assert.equal(info.stale, false);
    assert.deepEqual(stalenessWarning(info), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("源码比 dist 新：报，并指出是哪个文件、差多久", () => {
  const root = makeTree({ srcAge: 1_000, distAge: 120_000 });
  try {
    const info = frontendStaleness({ root, distDir: join(root, "dist") });
    assert.equal(info.stale, true);
    assert.match(info.newest_source, /^src\//);
    assert.ok(info.newer_count >= 1);
    assert.ok(info.seconds_behind >= 60);
    const lines = stalenessWarning(info);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /前端产物比源码旧/);
    assert.match(lines[1], /npm run build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("同一秒内写完的不算过期（1 秒余量）", () => {
  const root = makeTree({ srcAge: 5_000, distAge: 5_500 });
  try {
    const info = frontendStaleness({ root, distDir: join(root, "dist") });
    assert.equal(info.stale, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dev（--watch）模式不吵：过期也不打印", () => {
  const root = makeTree({ srcAge: 1_000, distAge: 120_000 });
  try {
    const info = frontendStaleness({ root, distDir: join(root, "dist") });
    assert.equal(info.stale, true);
    assert.deepEqual(stalenessWarning(info, { watching: true }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("没构建过时不抢 BUILD_REQUIRED 的话（这里不说话）", () => {
  const root = mkdtempSync(join(tmpdir(), "ls-stale-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "App.tsx"), "export const a = 1;\n");
    const info = frontendStaleness({ root, distDir: join(root, "dist") });
    assert.equal(info.missing, true);
    assert.equal(info.stale, false);
    assert.deepEqual(stalenessWarning(info), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
