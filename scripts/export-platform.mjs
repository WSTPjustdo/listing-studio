// 生成 platform-export/platform.json：里面的数字全部从代码常量读出来，不手抄。
//
// 为什么要有这个脚本：这份文件是「平台配置导出」交付物，别人照着它判断
// 「这个工作台能吃多大文件、支持几种格式、每行调几次模型」。手抄版本曾经
// 写着 max_rows 200 / max_columns 60 / 两种格式，而代码早就支持 2000 / 1000 / 四种
// —— 交付物与产品对不上，比写错一个文案更严重。
//
// 用法：
//   node scripts/export-platform.mjs           写文件
//   node scripts/export-platform.mjs --check   只比对，不写；过期则 exit 1
//   --target <路径>   改写到别处（测试用它验「不一致时真的会红」，不动仓库里的文件）

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TABLE_FORMATS, TABLE_LIMITS } from "../server/flat-file.mjs";
import { batchConcurrency } from "../server/batch.mjs";
import { CALLS_PER_ROW } from "../server/batch-cost.mjs";

const root = resolve(import.meta.dirname, "..");
const targetIndex = process.argv.indexOf("--target");
const target = targetIndex >= 0
  ? resolve(process.argv[targetIndex + 1])
  : resolve(root, "platform-export/platform.json");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

// 并发只有一个数字说不清：默认固定档 + 上限 + auto 档。三个都写进去。
const fixed = batchConcurrency({});

const document = {
  format: "listing-studio-local-platform-export-v1",
  generated: {
    by: "npm run export:platform（scripts/export-platform.mjs）",
    note: "batch 段的数字来自 server/flat-file.mjs 的 TABLE_LIMITS / TABLE_FORMATS 与 server/batch-cost.mjs 的 CALLS_PER_ROW；手改会被 tests/delivery.test.mjs 判定过期。",
    numerical_fields_generated: true,
  },
  platform: "Node.js + React + SQLite",
  node: pkg.engines?.node ?? null,
  default_url: "http://127.0.0.1:8787/",
  environment_template: "runtime.env.example",
  dependency_lock: "../package-lock.json",
  workflow_manifest: "../workflows/manifest.json",
  runtime_implementation: ["../server/service.mjs", "../server/providers.mjs"],
  configuration_directories: ["../amazon-focus", "../data-research"],
  restore_commands: ["npm ci", "npm run build", "npm start"],
  delivery_tag_policy:
    "打包用 npm run package:share --tag <名称>；脚本会校验该标签指向当前已审查提交。本文件不代表已存在同名标签。",
  credentials_included: false,
  user_database_included: false,
  dify_native_export_included: false,
  batch: {
    implementation: "../server/batch.mjs",
    formats: [...TABLE_FORMATS],
    limits: {
      max_rows: TABLE_LIMITS.rows,
      max_columns: TABLE_LIMITS.columns,
      max_file_bytes: TABLE_LIMITS.bytes,
      max_cell_chars: TABLE_LIMITS.cell,
    },
    concurrency: {
      default: fixed,
      max: 8,
      auto: "BATCH_CONCURRENCY=auto：按上游 429 自行降档，不预设数字",
    },
    calls_per_row: { ...CALLS_PER_ROW },
    calls_per_row_note:
      "行数 × 调用次数才是钱。这组数字只在假上游与本地假网关上量过，单价与真实 token 数仍未知。",
    persistence: "SQLite imports + batches tables",
    operations: ["create", "diagnose", "optimize"],
  },
  grouped_issue_processing: {
    implementation: "server/batch.mjs",
    group_by: "rule_id within batch",
    actions: ["review", "repair_preview_and_apply", "defer"],
    version_guards: ["submit", "queue_execution", "immutable_store"],
    field_scope: "selected issue fields only",
    history: "SQLite batches.group_actions; XLSX audit sheet",
    missing_facts: "per product only",
    risk_deferral: "retains findings; expires on new version",
  },
};

const next = `${JSON.stringify(document, null, 2)}\n`;
const checkOnly = process.argv.includes("--check");

let current = null;
try {
  // 工作区里这份文件可能被 core.autocrlf 换成 CRLF（仓库里存的是 LF）。
  // 不归一化的话，全新 checkout 上 --check 必红——2026-10-30 重置工作区后真的红了一次。
  current = readFileSync(target, "utf8").replaceAll("\r\n", "\n");
} catch {
  current = null;
}

if (current === next) {
  console.log("platform.json 已是最新（与代码常量一致）。");
  process.exit(0);
}

const diffLines = [];
const before = (current ?? "").split("\n");
const after = next.split("\n");
for (let i = 0; i < Math.max(before.length, after.length); i += 1) {
  if (before[i] !== after[i]) {
    diffLines.push(`  行 ${i + 1}\n    - ${before[i] ?? "(缺少这一行)"}\n    + ${after[i]}`);
  }
  if (diffLines.length >= 12) break;
}

if (checkOnly) {
  console.log(`platform.json 与代码常量不一致（${diffLines.length}${diffLines.length >= 12 ? "+" : ""} 处行差异）：`);
  for (const line of diffLines) console.log(line);
  console.log("修复：npm run export:platform");
  process.exit(1);
}

writeFileSync(target, next);
console.log(`已重写 platform.json：rows=${TABLE_LIMITS.rows} columns=${TABLE_LIMITS.columns} bytes=${TABLE_LIMITS.bytes} formats=${TABLE_FORMATS.join("/")}`);
for (const line of diffLines) console.log(line);
