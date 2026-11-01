#!/usr/bin/env node
/**
 * 「同一条规则，本批命中了好几种情况」——批量工作单（导出的 Excel「按规则处理」页）
 * 到底能让人看到几种改法（第 21 轮 · 方向 C 审核能力）。
 *
 * 背景：报告那张「改稿工作单」已经按条印「这一条的具体建议」，
 * 但批量侧那张表是**按规则**汇总的：一行一条规则，一列「标准改法」，
 * 开头还写着「先按标准改法统一改」。而 `US-01` 一个规则下分了六类，
 * `recycled`（补比例）和 `eco-friendly`（删词）不是一回事——
 * 「统一改」这三个字在这种规则上就是错的。
 *
 * 这条尺子量的是：**这批数据里，真正被印到表上的具体建议有几种。**
 * 判据是逐字包含（不是「有没有建议这一列」——那一列永远在）。
 *
 * 用法：
 *   node scripts/batch-advice-probe.mjs
 *   node scripts/batch-advice-probe.mjs --json
 *   node scripts/batch-advice-probe.mjs --strict   # 有具体建议没上表就 exit 1
 *
 * 只读：不写数据库、不发请求、不用模型、不落 xlsx 文件。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { reviewContent } from "../server/domain.mjs";
import { rulePack } from "../server/store.mjs";
import { ruleWorklist, worklistRows } from "../server/batch-summary.mjs";
import { loadSample, listingContent } from "./sample-listings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV = resolve(HERE, "..");
const CORPUS = resolve(DEV, "../qa/research/listings-20261030.json");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");

/**
 * 造一批两行的数据：一行「含再生材料」，一行「宽泛环保词」。
 * 两条都取自真实语料（`B0919143LR` / `B0DX7C3T18`），不是编的。
 */
export function probeBatch(path = CORPUS) {
  const { items } = loadSample(path);
  const picked = ["B0919143LR", "B0DX7C3T18"]
    .map((asin) => items.find((x) => x.asin === asin))
    .filter(Boolean);
  if (picked.length < 2) throw new Error(`语料里找不到这两条：${picked.map((x) => x.asin).join(",")}`);

  const records = new Map();
  picked.forEach((item, index) => {
    const review = reviewContent({ content: listingContent(item), profile: null, rulePack });
    records.set(index + 2, {
      version: 1,
      rule_pack_version: rulePack.rule_pack_version,
      content: listingContent(item),
      review: { issues: review.issues },
      asin: item.asin,
    });
  });

  const batch = { rows: [...records.keys()].map((row) => ({ row, status: "completed" })) };
  const worklist = ruleWorklist(batch, (row) => records.get(row.row) || null, rulePack);
  const rows = worklistRows(worklist);
  const sheetText = rows.map((line) => line.cells.join(" \u0001 ")).join("\n");

  const report = worklist.map((group) => {
    // 本批这条规则真正命中的、各不相同的具体建议。
    const advices = new Set();
    for (const record of records.values())
      for (const issue of record.review.issues || [])
        if (issue.rule_id === group.rule_id && String(issue.suggestion || "").trim())
          advices.add(String(issue.suggestion).trim());
    const shown = [...advices].filter((text) => sheetText.includes(text));
    return {
      rule_id: group.rule_id,
      rows_affected: group.rows_affected,
      distinct_advices: advices.size,
      shown_on_sheet: shown.length,
      repair: group.repair || "",
      advices: [...advices],
    };
  });

  const totals = report.reduce(
    (acc, x) => ({
      rules: acc.rules + 1,
      multi: acc.multi + (x.distinct_advices > 1 ? 1 : 0),
      advices: acc.advices + x.distinct_advices,
      shown: acc.shown + x.shown_on_sheet,
    }),
    { rules: 0, multi: 0, advices: 0, shown: 0 },
  );
  return { corpus: path, rows_on_batch: batch.rows.length, report, totals, sheet_text: sheetText };
}

const result = probeBatch();

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`批量工作单：「按规则处理」页能让人看到几种改法`);
  console.log(`数据：${result.rows_on_batch} 行（真实语料 ${result.corpus}）`);
  console.log("");
  console.log("规则     影响行数  本批不同建议  表上能看到  ");
  for (const x of result.report)
    console.log(
      `${x.rule_id.padEnd(8)} ${String(x.rows_affected).padStart(8)} ${String(x.distinct_advices).padStart(12)} ` +
        `${String(x.shown_on_sheet).padStart(10)}${x.distinct_advices > 1 ? "   ← 一条规则多种改法" : ""}`,
    );
  const t = result.totals;
  console.log("");
  console.log(
    `合计：${t.rules} 条规则，其中 ${t.multi} 条本批有不止一种改法；` +
      `具体建议共 ${t.advices} 种，**表上能看到 ${t.shown} 种**`,
  );
}

if (strict && result.totals.shown < result.totals.advices) {
  console.error(`\n[strict] 有 ${result.totals.advices - result.totals.shown} 种具体建议没上表。`);
  process.exit(1);
}
