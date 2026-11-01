#!/usr/bin/env node
/**
 * 量「把一条真实在售文案贴进来做诊断」时，问题列表长什么样。
 *
 * 为什么需要这个量具：上一轮量到 20 条真实文案共产出 122 条 issue，其中 90 条（74%）
 * 是 EVID-01「尚未确认」——演示时评委贴一条真实 ASIN，看到的是满屏同一种话。
 * 改展示之前必须先能复现这组数字，否则「改好了」没有对照。
 *
 * 它跑的是**真实审核引擎**（reviewContent），不是另写一套规则；
 * 只做输入适配：把采集到的 listing 转成 content schema。
 *
 * 用法：
 *   node scripts/probe-issue-shape.mjs                  # 无商品档案（不关联）
 *   node scripts/probe-issue-shape.mjs --profile        # 关联商品档案（走参数对照那条路径）
 *   node scripts/probe-issue-shape.mjs --list           # 连每条文案的问题逐条印出来
 *   node scripts/probe-issue-shape.mjs --file <样本.json>
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewContent } from "../server/domain.mjs";
import { rulePack, scenarios } from "../server/store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SAMPLE = resolve(here, "../../qa/research/listings-20261027.json");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const raw = JSON.parse(readFileSync(value("--file", DEFAULT_SAMPLE), "utf8"));
const items = Array.isArray(raw) ? raw : raw.items || [];
const profile = has("--profile") ? scenarios.product_profiles[0] : null;

/** 采集到的 listing → content schema。字段一一对应，不做任何美化。 */
function toContent(item) {
  const bullets = (item.bullets || []).slice(0, 8).map((text, i) => ({
    id: `b${i + 1}`,
    text,
  }));
  return {
    title: (item.title || "").slice(0, 400) || "(empty)",
    item_highlights: (item.bullets || []).join(" ").slice(0, 400),
    bullet_points: bullets,
    description: (item.description || "").slice(0, 4000),
  };
}

const perListing = [];
for (const item of items) {
  const review = reviewContent({
    content: toContent(item),
    profile,
    rulePack,
    claimMap: [],
    conflicts: [],
  });
  const byRule = new Map();
  for (const issue of review.issues)
    byRule.set(issue.rule_id, (byRule.get(issue.rule_id) || 0) + 1);
  perListing.push({
    asin: item.asin,
    issues: review.issues,
    byRule,
    total: review.issues.length,
  });
}

const total = perListing.reduce((sum, x) => sum + x.total, 0);
const counts = new Map();
for (const row of perListing)
  for (const [rule, n] of row.byRule) counts.set(rule, (counts.get(rule) || 0) + n);

const sorted = [...perListing].map((x) => x.total).sort((a, b) => a - b);
const median = sorted.length
  ? sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  : 0;

const severity = new Map();
for (const row of perListing)
  for (const issue of row.issues)
    severity.set(issue.severity, (severity.get(issue.severity) || 0) + 1);

console.log(`样本：${value("--file", DEFAULT_SAMPLE)}　${items.length} 条真实在售文案`);
console.log(`模式：${profile ? "关联商品档案" : "不关联商品档案"}（reviewContent，无模型）`);
console.log(`issue 总数：${total}　中位每条：${median}　最多：${sorted.at(-1) ?? 0}　最少：${sorted[0] ?? 0}`);
console.log(`严重度：${[...severity].map(([k, v]) => `${k} ${v}`).join(" · ") || "（无）"}\n`);

console.log("| 规则 | 条数 | 占总数 | 每条文案平均 |");
console.log("|---|---|---|---|");
for (const [rule, n] of [...counts].sort((a, b) => b[1] - a[1]))
  console.log(`| ${rule} | ${n} | ${((n / Math.max(total, 1)) * 100).toFixed(0)}% | ${(n / Math.max(items.length, 1)).toFixed(1)} |`);

if (has("--list")) {
  for (const row of perListing) {
    console.log(`\n## ${row.asin}（${row.total} 条）`);
    for (const issue of row.issues)
      console.log(`- [${issue.severity}] ${issue.rule_id} · ${issue.field_path} · ${issue.original.slice(0, 60)}`);
  }
}
