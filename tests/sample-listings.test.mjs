// 真实在售文案 → 引擎 content 的映射，必须只有一份，而且「亮点」必须是空的。
//
// 为什么值得一条测试：这段映射原来在两个探测脚本里各写一遍，两份都把五点拼成亮点，
// 于是 20 条真实文案里 20 条都报 AMZ-02（125 上限），把「贴一条真实 ASIN 有几条问题」
// 整体放大了（2026-10-29 实测：52 → 31 条）。两个脚本一起错，所以互相印证得像真的。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listingContent, loadSample } from "../scripts/sample-listings.mjs";
import { reviewContent } from "../server/domain.mjs";
import { rulePack } from "../server/store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = resolve(here, "../../qa/research/listings-20261027.json");

// 语料是采来的真实在售文案，按约定不入库（体量与版权原因），只留在本机 qa/ 下。
// 所以交付包解压出来跑 npm test 时这里没有文件——那是"没带语料"，不是"代码坏了"。
// 跳过而不是失败，并在输出里说清楚跳了几条，免得解开包的人以为测试红了就得修。
const hasSample = existsSync(samplePath);
const skipIfNoSample = (t) => {
  if (hasSample) return false;
  t.skip("qa/research/listings-20261027.json 未随包分发（真实语料不入库），本仓库内仍会跑");
  return true;
};

test("真实在售样本里没有「亮点」字段，映射也不许凭空造一个", (t) => {
  if (skipIfNoSample(t)) return;
  const { items } = loadSample(samplePath);
  assert.ok(items.length >= 20, `样本条数不对劲：${items.length}`);
  for (const item of items) {
    assert.equal(item.item_highlights, undefined, item.asin);
    assert.equal(item.highlights, undefined, item.asin);
    assert.equal(listingContent(item).item_highlights, "", item.asin);
  }
});

test("映射保留标题、五点、描述，五点 ID 是 b1..bn（报告按 ID 定位）", (t) => {
  if (skipIfNoSample(t)) return;
  const { items } = loadSample(samplePath);
  const content = listingContent(items[0]);
  assert.ok(content.title.length > 0);
  assert.ok(content.description.length > 0);
  assert.equal(content.bullet_points[0].id, "b1");
  assert.ok(content.bullet_points.length <= 8);
});

test("诊断一条真实在售文案，不该报 AMZ-02（它没有亮点字段）", (t) => {
  if (skipIfNoSample(t)) return;
  const { items } = loadSample(samplePath);
  for (const item of items) {
    const issues = reviewContent({
      content: listingContent(item),
      profile: null,
      rulePack,
      marketplace: "US",
    }).issues;
    assert.equal(
      issues.filter((x) => x.rule_id === "AMZ-02").length,
      0,
      `${item.asin}：真实文案没有亮点字段，不该按亮点上限报`,
    );
  }
});
