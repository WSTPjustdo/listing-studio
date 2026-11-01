#!/usr/bin/env node
/**
 * 「引擎按词分流出来的那句话，到底有没有到纸上」——纸面覆盖率量具（第 21 轮 · 方向 C 审核能力）。
 *
 * 上一轮（第 20 轮）翻出一个缺陷：`worklist.mjs` 的渲染是
 * `action ? 只印 action（规则包的标准改法） : 才印 suggestion（这一条的具体建议）`。
 * 后果是 `US-01` 明明按词分了六类（`ECO_ADVISORIES`），
 * 但纸面上 `recycled` 和 `eco-friendly` 拿到的是**同一句「移除」**。
 *
 * 屏幕上看不出来：界面上那句话是对的。**这个缺陷只能在纸上量。**
 *
 * 这条尺子量的就是这件事：拿真实语料跑一遍引擎 → 折成工作单 → 数
 * 「每条问题自带的那句 suggestion，有几个字真的印在了 HTML 上」。
 *
 * 为什么不用「HTML 里有没有『建议』两个字」这种判据：
 * 那种判据在缺陷存在时也是绿的（`怎么改：` 那行永远在）。必须**逐条比对原文**。
 *
 * 用法：
 *   node scripts/worklist-advice-probe.mjs            # 打表
 *   node scripts/worklist-advice-probe.mjs --json
 *   node scripts/worklist-advice-probe.mjs --strict   # 有「自带建议没印上」就 exit 1
 *
 * 只读：不写数据库、不发请求、不用模型。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { reviewContent } from "../server/domain.mjs";
import { rulePack } from "../server/store.mjs";
import { escapeHtml } from "../server/report.mjs";
import { buildWorklist, worklistSection } from "../server/worklist.mjs";
import { loadSample, listingContent } from "./sample-listings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV = resolve(HERE, "..");
const CORPUS = resolve(DEV, "../qa/research/listings-20261030.json");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");
const corpusArg = args.find((x) => x.startsWith("--corpus="));

/** 真实语料 → 每条跑一遍引擎 → 折成工作单 HTML。 */
export function probeCorpus(path = corpusArg ? resolve(corpusArg.slice(9)) : CORPUS) {
  const { items } = loadSample(path);
  const rows = [];
  for (const item of items) {
    const content = listingContent(item);
    const review = reviewContent({ content, profile: null, rulePack });
    const issues = review.issues || [];
    if (!issues.length) continue;
    const worklist = buildWorklist(issues, rulePack.rules, new Map());
    const html = worklistSection(worklist, escapeHtml);
    for (const issue of issues) {
      const advice = String(issue.suggestion || "");
      // 判据是「这一条自带的那句话，逐字出现在纸上」。
      // 注意空白：suggestion 里没有换行，escapeHtml 也不改空白，所以可以直接包含判定。
      const printed = advice.length > 0 && html.includes(escapeHtml(advice));
      rows.push({
        asin: item.asin || "",
        rule_id: issue.rule_id,
        field_path: issue.field_path || "",
        severity: issue.severity || "",
        original: String(issue.original || "").slice(0, 120),
        advice_chars: [...advice].length,
        printed,
      });
    }
  }
  return rows;
}

/** 按规则汇总：几条问题、几条自带建议、几条印上了。 */
export function summarize(rows) {
  const byRule = new Map();
  for (const row of rows) {
    const key = row.rule_id;
    const slot = byRule.get(key) || { rule_id: key, issues: 0, with_advice: 0, printed: 0, dropped_samples: [] };
    slot.issues += 1;
    if (row.advice_chars > 0) {
      slot.with_advice += 1;
      if (row.printed) slot.printed += 1;
      else if (slot.dropped_samples.length < 2) slot.dropped_samples.push(`${row.asin} ${row.original}`);
    }
    byRule.set(key, slot);
  }
  const list = [...byRule.values()].sort((a, b) => b.issues - a.issues);
  const totals = list.reduce(
    (acc, x) => ({
      issues: acc.issues + x.issues,
      with_advice: acc.with_advice + x.with_advice,
      printed: acc.printed + x.printed,
    }),
    { issues: 0, with_advice: 0, printed: 0 },
  );
  return { by_rule: list, totals };
}

const rows = probeCorpus();
const summary = summarize(rows);

if (asJson) {
  console.log(JSON.stringify({ corpus: CORPUS, summary, rows }, null, 2));
} else {
  console.log(`语料：${CORPUS}（${new Set(rows.map((x) => x.asin)).size} 条有问题的商品）`);
  console.log("");
  console.log("规则      问题数  自带建议  印到纸上  未印上");
  for (const x of summary.by_rule) {
    console.log(
      `${x.rule_id.padEnd(9)} ${String(x.issues).padStart(6)} ${String(x.with_advice).padStart(8)} ` +
        `${String(x.printed).padStart(8)} ${String(x.with_advice - x.printed).padStart(7)}`,
    );
    for (const sample of x.dropped_samples) console.log(`          · 例：${sample}`);
  }
  const t = summary.totals;
  console.log("");
  console.log(
    `合计：${t.issues} 条问题，其中 ${t.with_advice} 条自带「这一条的具体建议」，` +
      `**纸上能看到 ${t.printed} 条，丢了 ${t.with_advice - t.printed} 条**`,
  );
}

if (strict && summary.totals.printed < summary.totals.with_advice) {
  console.error(`\n[strict] 有 ${summary.totals.with_advice - summary.totals.printed} 条建议没印到纸上。`);
  process.exit(1);
}
