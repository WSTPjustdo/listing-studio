#!/usr/bin/env node
/**
 * 小评测集跑分器（第 19 轮 · 方向 F 数据与素材）
 *
 * 数据集：`qa/research/eval-set-20261030.json`（15 条：违规 11、合规/反例 4）。
 * 每条都带「已知正确答案」（该报哪条规则）与一句依据。
 *
 * 为什么要分两层看结果：
 *   15 条规则里只有 6 条（AMZ-01/02/06、EVID-01、SYS-01/02）的 method 是 `deterministic`，
 *   它们的结论就是产品的结论 —— 这一层可以当硬门槛，漏报/误报都是缺陷。
 *   另外 9 条（AMZ-03/04/05、US-01~04、FACT-01/02）的结论由模型给，本地只有召回用的启发式。
 *   把两层的数字混成一个「准确率」会说谎：本地跑出来 100% 并不代表产品能审。
 *
 * 用法：
 *   node scripts/eval-set-probe.mjs                 # 全量跑一遍，打印逐条结果
 *   node scripts/eval-set-probe.mjs --strict        # 确定层有漏报/误报时 exit 1
 *   node scripts/eval-set-probe.mjs --case EV-012    # 只看一条（改规则时用）
 *   node scripts/eval-set-probe.mjs --json           # 只输出 JSON（给别的脚本吃）
 *
 * 只读：不写数据库、不发请求、不用模型。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import { reviewContent } from "../server/domain.mjs";
import { rulePack } from "../server/store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEV = resolve(HERE, "..");
export const EVAL_PATH = resolve(DEV, "../qa/research/eval-set-20261030.json");

export async function loadEvalSet(path = EVAL_PATH) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** 跑一条用例，返回引擎实际报了什么。 */
export function runCase(entry) {
  const content = {
    title: String(entry.content.title ?? ""),
    item_highlights: String(entry.content.item_highlights ?? ""),
    bullet_points: (entry.content.bullet_points || []).map((b, i) => ({ id: b.id || `b${i + 1}`, text: String(b.text ?? "") })),
    description: String(entry.content.description ?? ""),
  };
  const review = reviewContent({ content, profile: null, rulePack });
  const issues = review.issues || [];
  return {
    fired: [...new Set(issues.map((x) => x.rule_id))].sort(),
    issues,
    title_chars: [...content.title].length,
    highlight_chars: [...content.item_highlights].length,
  };
}

/**
 * 把「期望 vs 实际」判成三类：
 *   detMiss   —— 确定层该报没报（硬缺陷）
 *   detFalse  —— 确定层不该报却报了（硬缺陷）
 *   semMiss   —— 语义层本地启发式没召回（不是产品缺陷，只是本地量具的现状）
 *   其他语义层命中/未命中只做记录，不判定。
 */
export function judge(entry, actual, layers) {
  const det = new Set(layers.deterministic.rules);
  const must = new Set(entry.must_fire || []);
  const mustNot = new Set(entry.must_not_fire || []);
  const fired = new Set(actual.fired);

  const detMissing = [...must].filter((id) => det.has(id) && !fired.has(id));
  const detUnexpected = [...fired].filter((id) => det.has(id) && !must.has(id));
  const semMissing = [...must].filter((id) => !det.has(id) && !fired.has(id));
  const semExtra = [...fired].filter((id) => !det.has(id) && !must.has(id));
  const forbiddenFired = [...mustNot].filter((id) => fired.has(id));

  return {
    id: entry.id,
    kind: entry.kind,
    detMissing,
    detUnexpected,
    semMissing,
    semExtra,
    forbiddenFired,
    pass: detMissing.length === 0 && detUnexpected.length === 0 && forbiddenFired.length === 0,
  };
}

export function summarize(results, cases, layers) {
  const det = new Set(layers.deterministic.rules);
  const detMust = cases.flatMap((c) => (c.must_fire || []).filter((id) => det.has(id)).map((id) => ({ id, case: c.id })));
  const semMust = cases.flatMap((c) => (c.must_fire || []).filter((id) => !det.has(id)).map((id) => ({ id, case: c.id })));
  const detMustNot = cases.flatMap((c) => (c.must_not_fire || []).filter((id) => det.has(id)).map((id) => ({ id, case: c.id })));

  const hitOf = (rows) => rows.filter((row) => results.find((r) => r.id === row.case)?.fired?.includes(row.id));

  const perRule = new Map();
  for (const rule of rulePack.rules) perRule.set(rule.rule_id, { rule_id: rule.rule_id, expected: 0, hit: 0, layer: det.has(rule.rule_id) ? "det" : "sem" });
  for (const row of [...detMust, ...semMust]) {
    const stat = perRule.get(row.id);
    if (!stat) continue;
    stat.expected += 1;
    if (results.find((r) => r.id === row.case)?.fired?.includes(row.id)) stat.hit += 1;
  }

  return {
    cases: cases.length,
    detMust: detMust.length,
    detHit: hitOf(detMust).length,
    detMustNot: detMustNot.length,
    detFalse: results.reduce((n, r) => n + r.detUnexpected.length + r.forbiddenFired.filter((id) => det.has(id)).length, 0),
    semMust: semMust.length,
    semHit: hitOf(semMust).length,
    casesPassed: results.filter((r) => r.pass).length,
    perRule: [...perRule.values()],
  };
}

function renderReport(evalSet, results, stats) {
  const lines = [];
  lines.push("# 小评测集跑分");
  lines.push("");
  lines.push(`- 数据集：\`qa/research/eval-set-20261030.json\`（${stats.cases} 条，规则包 ${evalSet.rule_pack}）`);
  lines.push(`- 跑的是本地引擎（\`reviewContent\`，profile = null，无模型）。**语义层的数字只代表本地启发式，不代表产品能审。**`);
  lines.push("");
  lines.push(`## 确定层（6 条 deterministic，可当门槛）`);
  lines.push("");
  lines.push(`- 该报的 ${stats.detMust} 处，报到 **${stats.detHit}/${stats.detMust}**`);
  lines.push(`- 不该报的 ${stats.detMustNot} 处，误报 **${stats.detFalse}** 处`);
  lines.push("");
  lines.push(`## 语义层（9 条，本地启发式召回率，不当门槛）`);
  lines.push("");
  lines.push(`- 该报的 ${stats.semMust} 处，本地召回 **${stats.semHit}/${stats.semMust}**`);
  lines.push("");
  lines.push("## 逐条");
  lines.push("");
  lines.push("| 用例 | 类型 | 标题字符 | 期望 | 实际 | 判定 |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of results) {
    const entry = evalSet.cases.find((c) => c.id === r.id);
    // 「过」不等于「答对了」：确定层过关只说明本地引擎没错；
    // 语义层没召回时必须写出来，否则这张表会被读成「25 条全对」。
    const verdict = r.pass
      ? r.semMissing.length
        ? `过（语义层未召回 ${r.semMissing.join(" ")}）`
        : "过"
      : `**红**（漏 ${[...r.detMissing].join(" ") || "-"}；多 ${[...r.detUnexpected, ...r.forbiddenFired].join(" ") || "-"}）`;
    lines.push(
      `| ${r.id} | ${entry.kind} | ${r.title_chars} | ${(entry.must_fire || []).join(" ") || "—"} | ${r.fired.join(" ") || "—"} | ${verdict} |`,
    );
  }
  lines.push("");
  lines.push("## 每条规则的覆盖");
  lines.push("");
  lines.push("| 规则 | 层 | 该报次数 | 本地命中 |");
  lines.push("|---|---|---|---|");
  for (const row of stats.perRule) {
    if (row.expected === 0) continue;
    lines.push(`| ${row.rule_id} | ${row.layer === "det" ? "确定" : "语义"} | ${row.expected} | ${row.hit} |`);
  }
  const uncovered = stats.perRule.filter((x) => x.expected === 0).map((x) => x.rule_id);
  lines.push("");
  lines.push(`未覆盖（本集没有该报它的用例）：${uncovered.join("、") || "无"}`);
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (flag) => argv.includes(flag);
  const value = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };

  const evalSet = await loadEvalSet();
  const only = value("--case");
  const cases = only ? evalSet.cases.filter((c) => c.id === only) : evalSet.cases;
  if (!cases.length) throw new Error(`没有这条用例：${only}`);

  const results = [];
  for (const entry of cases) {
    const actual = runCase(entry);
    results.push({ ...judge(entry, actual, evalSet.layers), fired: actual.fired, title_chars: actual.title_chars, highlight_chars: actual.highlight_chars });
  }
  const stats = summarize(results, cases, evalSet.layers);

  if (has("--json")) {
    console.log(JSON.stringify({ stats, results }, null, 2));
  } else {
    const report = renderReport(evalSet, results, stats);
    console.log(report);
    if (!only) {
      // 报告落盘，便于 handoff 里引用一个具体文件而不是「我跑过了」。
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/(\d{8})(\d{4})/, "$1-$2");
      const out = resolve(DEV, `../qa/reports/eval-set-${stamp}.md`);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, `${report}\n`, "utf8");
      console.log(`报告：${out}`);
    }
  }

  const detBroken = results.filter((r) => !r.pass);
  if (has("--strict") && detBroken.length) {
    console.error(`\n确定层有 ${detBroken.length} 条不通过：${detBroken.map((r) => r.id).join(" ")}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
