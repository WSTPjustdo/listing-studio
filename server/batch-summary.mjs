
import { fieldGroupKey } from "./report.mjs";
import { ruleCitations, citationForField } from "./rules-doc.mjs";
import { auditContext } from './audit-context.mjs';

const SEVERITY_ORDER = ["blocking", "needs_review", "suggestion"];
const SEVERITY_LABELS = {
  blocking: "阻断项（需处理）",
  needs_review: "待人工核对",
  suggestion: "表达建议",
};
const STATUS_LABELS = {
  completed: "已完成",
  failed: "失败",
  queued: "排队中",
  running: "处理中",
  skipped: "已跳过",
  preserved: "父体保留（未送审）",
  blocked: "校验未通过（没送审）",
};
const STATUS_ORDER = ["completed", "failed", "blocked", "queued", "running", "skipped", "preserved"];

export function summarizeBatch(batch, recordOf = () => null) {
  const rows = batch?.rows || [];
  const byStatus = new Map();
  const severity = new Map();
  const rules = new Map();
  const fields = new Map();
  const concluded = [];
  const attention = [];
  const incompleteList = [];

  for (const row of rows) {
    const status = row.status || "queued";
    byStatus.set(status, (byStatus.get(status) || 0) + 1);
    if (status !== "completed") {

      if (status === "failed" || status === "blocked")
        attention.push({
          row: row.row,
          sku: row.sku || "",
          name: row.name || "",
          why:
            status === "failed"
              ? row.error || "处理失败（没有记录原因）"
              : `资料校验未通过：${(row.errors || []).join("；") || "未写明原因"}`,
          next:
            row.error_action || row.next_step ||
            (status === "blocked" ? "先按提示修正这一行的商品资料，再重新提交。" : "重试这一行。"),
          weight: 1000,
        });
      continue;
    }
    const record = recordOf(row);
    if (!record || !record.review) continue; // 标了完成却找不到版本记录：不进任何"有结论"的分母，免得把没结论的行算成干净
    const issues = record.review?.issues || [];
    const coverage = record.review?.coverage || {};
    const unfinishedChecks = (record.review.checks || []).filter(check => check.state !== 'pass');
    const incomplete = !Number.isInteger(coverage.completed) || !Number.isInteger(coverage.total) || coverage.total <= 0 || coverage.completed !== coverage.total || coverage.failed > 0 || coverage.pending > 0 || unfinishedChecks.length > 0 || (record.review.missing_data || []).length > 0 || record.review.consistency_check?.state === 'changed';
    concluded.push({ row, record, incomplete });
    if (incomplete)

      incompleteList.push({
        row: row.row,
        sku: row.sku || "",
        name: row.name || "",
        missing: Number.isFinite(coverage.total) && Number.isFinite(coverage.completed) ? Math.max(0, coverage.total - coverage.completed) : null,
        completed: coverage.completed,
        total: coverage.total,

        issues: issues.length,
      });
    const blocking = issues.filter((issue) => issue.severity === "blocking").length;
    if (blocking)
      attention.push({
        row: row.row,
        sku: row.sku || "",
        name: row.name || "",
        why: `${blocking} 条阻断项`,
        next: "按「商品文案」改这几处，改完重新审阅这一行。",
        weight: 100 + blocking,
      });
    for (const issue of issues) {
      const key = SEVERITY_ORDER.includes(issue.severity) ? issue.severity : "needs_review";
      severity.set(key, (severity.get(key) || 0) + 1);
      const rule = rules.get(issue.rule_id) || {
        rule_id: issue.rule_id || "（无规则 ID）",
        title: issue.title || "",
        severity: issue.severity || "",
        count: 0,
      };
      rule.count++;
      rules.set(issue.rule_id, rule);
      const field = fieldGroupKey(issue.field_path);
      fields.set(field, (fields.get(field) || 0) + 1);
    }

  }

  const issueTotal = [...severity.values()].reduce((a, b) => a + b, 0);

  const clean = concluded.filter((x) => !(x.record.review?.issues || []).length && !x.incomplete).length;
  const incompleteRows = concluded.filter((x) => x.incomplete).length;
  const withIssues = concluded.filter((x) => (x.record.review?.issues || []).length).length;

  return {
    batch_id: batch?.id || "",
    batch_name: batch?.name || "",
    rows_total: rows.length,
    rows_preserved: byStatus.get("preserved") || 0,
    rows_without_record: rows.filter(row => row.status === "completed" && !recordOf(row)?.review).length,
    rows_by_status: STATUS_ORDER.map((key) => ({ status: key, label: STATUS_LABELS[key], count: byStatus.get(key) || 0 })).filter(
      (x) => x.count,
    ),
    unexpected_status: [...byStatus.keys()].filter((key) => !STATUS_ORDER.includes(key)).map((key) => ({ status: key, count: byStatus.get(key) })),
    rows_concluded: concluded.length,
    rows_clean: clean,
    rows_with_issues: withIssues,
    rows_incomplete_checks: incompleteRows,
    incomplete_rows: incompleteList.sort((a, b) => (a.row || 0) - (b.row || 0)),
    issues_total: issueTotal,
    issues_by_severity: SEVERITY_ORDER.filter((key) => severity.get(key)).map((key) => ({
      severity: key,
      label: SEVERITY_LABELS[key],
      count: severity.get(key),
    })),
    top_rules: [...rules.values()].sort((a, b) => b.count - a.count || a.rule_id.localeCompare(b.rule_id)),
    fields: [...fields.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh")).map(([field, count]) => ({ field, count })),
    attention: attention.sort((a, b) => b.weight - a.weight || (a.row || 0) - (b.row || 0)),
  };
}

export function overviewRows(summary, options = {}) {
  const topRules = summary.top_rules.slice(0, options.ruleLimit ?? 10);
  const attention = summary.attention.slice(0, options.attentionLimit ?? 20);
  const lines = [];
  const push = (cells, style = "text") => lines.push({ cells, style });

  push(["批次总览"], "title");
  push(["批次", summary.batch_name || summary.batch_id || "（未命名批次）"], "text");
  push(["总行数", summary.rows_total], "text");
  push([], "blank");

  push(["行状态", "行数"], "header");
  for (const item of summary.rows_by_status) push([item.label, item.count]);
  for (const item of summary.unexpected_status) push([`未登记状态：${item.status}`, item.count], "note");
  push([], "blank");

  push(
    [
      "口径",
      `下面所有问题条数只统计「有结论的行」= ${summary.rows_concluded} 行；` +
        `失败、排队中、处理中、已跳过、校验未通过的行没有审阅结论，不参与统计。`,
    ],
    "note",
  );
  push([], "blank");

  push(["已完成行的结果", "行数"], "header");
  push([`干净（范围内没有发现问题，且检查做全了）`, summary.rows_clean]);
  push([`有问题（${summary.issues_total} 条问题，见下）`, summary.rows_with_issues]);
  push(
    [
      "跑完了但检查没做全",
      summary.rows_incomplete_checks,
    ],
    "note",
  );
  push([], "blank");

  push(["严重度", "条数"], "header");
  if (!summary.issues_by_severity.length) push(["（已完成的行里没有问题）", 0], "note");
  for (const item of summary.issues_by_severity) push([item.label, item.count]);
  push([], "blank");

  push(["命中最多的规则", "名称", "严重度", "条数"], "header");
  if (!topRules.length) push(["（没有命中任何规则）", "", "", 0], "note");
  for (const rule of topRules)
    push([rule.rule_id, rule.title, SEVERITY_LABELS[rule.severity] || rule.severity || "", rule.count]);
  if (summary.top_rules.length > topRules.length)
    push([`还有 ${summary.top_rules.length - topRules.length} 条规则各有命中，未在此列出`, "", "", ""], "note");
  push([], "blank");

  const incompleteShown = (summary.incomplete_rows || []).slice(0, options.incompleteLimit ?? 20);
  push(["跑完了但检查没做全的行", "SKU", "商品名称", "还差几项", "现在能说明什么"], "header");
  if (!incompleteShown.length) push(["（没有：有结论的行都跑完了全部检查）", "", "", "", ""], "note");
  for (const item of incompleteShown)
    push([
      item.row ?? "",
      item.sku,
      item.name,
      `${item.missing} 项（${item.completed}/${item.total}）`,
      item.issues
        ? `已发现 ${item.issues} 条问题；没查完的部分仍可能有问题`
        : "已查范围内没问题，但没查完的部分不能当作已通过",
    ]);
  const incompleteTotal = (summary.incomplete_rows || []).length;
  if (incompleteTotal > incompleteShown.length)
    push([`还有 ${incompleteTotal - incompleteShown.length} 行检查没做全，未在此列出`, "", "", "", ""], "note");
  push([], "blank");

  push(["问题出现在哪一段", "条数"], "header");
  if (!summary.fields.length) push(["（没有）", 0], "note");
  for (const item of summary.fields) push([item.field, item.count]);
  push([], "blank");

  push(["需要先处理的行", "SKU", "商品名称", "为什么", "下一步"], "header");
  if (!attention.length) push(["（没有失败行，也没有阻断项）", "", "", "", ""], "note");
  for (const item of attention)
    push([item.row ?? "", item.sku, item.name, item.why, item.next]);
  if (summary.attention.length > attention.length)
    push([`还有 ${summary.attention.length - attention.length} 行需要处理，见第二张表`, "", "", "", ""], "note");
  return lines;
}

export function writeOverviewSheet(book, summary, options = {}) {
  const sheet = book.addWorksheet("批次总览");
  const lines = overviewRows(summary, options);
  for (const line of lines) {
    if (line.style === "blank") {
      sheet.addRow([]);
      continue;
    }
    const row = sheet.addRow(line.cells);
    if (line.style === "title") row.font = { bold: true, size: 14 };
    else if (line.style === "header") row.font = { bold: true };
    else if (line.style === "note") row.font = { italic: true, color: { argb: "FF6B6B6B" } };
    row.alignment = { vertical: "top", wrapText: true };
  }
  sheet.columns = [
    { width: 26 },
    { width: 30 },
    { width: 24 },
    { width: 14 },
    { width: 52 },
  ];
  return sheet;
}

export function ruleWorklist(batch, recordOf = () => null, citations = []) {
  const current = Array.isArray(citations) ? citations : ruleCitations(citations);
  const currentVersion = !Array.isArray(citations) ? citations.rule_pack_version : null;
  const groups = new Map();

  for (const row of batch?.rows || []) {
    if ((row.status || "queued") !== "completed") continue;
    const record = recordOf(row);
    if (!record) continue; // 标了完成却没有记录：没有结论，不进任何分母
    const context = auditContext(record);
    const saved = record.rule_citations || (context.known ? context.citations : null);
    const versionKnown = saved !== null || (!!currentVersion && record.rule_pack_version === currentVersion);
    const known = new Map((saved || (versionKnown ? current : [])).map(item => [item.rule_id, item]));
    const issues = record.review?.issues || [];
    for (const issue of issues) {
      const ruleId = issue.rule_id || "（无规则 ID）";
      const groupKey = `${record.rule_pack_version || "unknown"}:${ruleId}`;
      const group =
        groups.get(groupKey) ||
        (() => {
          const cited = known.get(ruleId) || null;
          const created = {
            rule_id: ruleId,
            rule_pack_version: record.rule_pack_version || null,
            historical_basis_known: versionKnown,
            title: cited?.title_zh || issue.title || "",

            severity: issue.severity || "",
            category_label: cited?.category_label || "",

            basis_label: cited ? cited.basis_label : "",
            repair: cited?.repair || "",
            in_rule_pack: Boolean(cited),
            rows: new Set(),
            count: 0,
            fields: new Map(),
            examples: [],
            // 这条规则在本批里命中的**各不相同的具体建议**（第 21 轮）。
            // 为什么要有：这张表是按规则汇总的，一行一条规则一列「标准改法」，
            // 表头还写着「统一改」。而 US-01 一条规则下有六类宣称，
            // 「含再生材料」要补比例、「宽泛环保」要删词——一句 repair 装不下。
            // 只存 repair 等于让批量用户按同一句话改 15 处不同的问题。
            advices: new Set(),
          };
          groups.set(groupKey, created);
          return created;
        })();
      group.rows.add(row.row ?? row.sku ?? "?");
      const fieldCitation = citationForField(known.get(ruleId), issue.field_path);
      group.basis_types ||= new Set();
      group.basis_types.add(fieldCitation?.basis_label || '依据未知');
      group.basis_label = [...group.basis_types].join(' / ') + (group.basis_types.size > 1 ? '（按字段区分）' : '');
      group.count += 1;
      const field = fieldGroupKey(issue.field_path);
      group.fields.set(field, (group.fields.get(field) || 0) + 1);

      if (group.examples.length < 1 && issue.original) group.examples.push(String(issue.original));
      const advice = String(issue.suggestion || "").trim();
      if (advice) group.advices.add(advice);
    }
  }

  const severityWeight = (key) => {
    const index = SEVERITY_ORDER.indexOf(key);
    return index === -1 ? SEVERITY_ORDER.length : index;
  };
  return [...groups.values()]
    .map((group) => ({
      ...group,
      basis_types: [...group.basis_types],
      advices: [...group.advices],
      rows: [...group.rows].sort((a, b) => (Number(a) || 0) - (Number(b) || 0)),
      rows_affected: group.rows.size,
      fields: [...group.fields.entries()]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "zh"))
        .map(([field, count]) => ({ field, count })),
    }))
    .sort(
      (a, b) =>
        severityWeight(a.severity) - severityWeight(b.severity) ||
        b.rows_affected - a.rows_affected ||
        b.count - a.count ||
        String(a.rule_id).localeCompare(String(b.rule_id)),
    );
}

// 去空白与标点再比（与 `worklist.mjs` 的 `norm` 同口径）：差一个逗号不是两件事。
const normText = (text) => String(text || "").replace(/[\s，。、；：！？（）「」【】,.;:!?()\[\]]/g, "");

/**
 * 「标准改法」这一格：规则包那句话 + **本批真正命中的几种具体改法**。
 *
 * 只有 repair 时，`US-01` 那一行对 15 处不同的问题给的是同一句「建议移除宽泛宣称」，
 * 而其中「含再生材料」那两条的正确处置是补比例（16 CFR 260.13 允许无限定宣称的条件）。
 */
export function adviceCell(group) {
  if (!group.in_rule_pack) return "（对应版本的规则依据未知，须人工核对）";
  const pieces = [group.repair || "（规则包里没写标准改法）"];
  const advices = (group.advices || []).filter(
    (text) => text && normText(text) !== normText(group.repair),
  );
  if (advices.length === 1) pieces.push(`本批的具体改法：${advices[0]}`);
  else if (advices.length > 1)
    pieces.push(
      `本批 ${advices.length} 种情况，改法不同：` +
        advices.map((text, index) => `\n${index + 1}) ${text}`).join(""),
    );
  return pieces.join("\n");
}

export function worklistRows(worklist, options = {}) {
  const rowLimit = options.rowLimit ?? 40;
  const lines = [];
  const push = (cells, style = "text") => lines.push({ cells, style });

  const totalRows = new Set(worklist.flatMap((group) => group.rows)).size;
  push(["按规则处理清单"], "title");
  push([
    "怎么用",
    "一条规则一段：先看「严重度」决定先后，再照「标准改法」改，改完重新审阅受影响的行（不是整批重跑）。",
  ], "note");
  push([
    "注意",
    "标了「本批 N 种情况」的规则不能一句话统一改：同一条规则在本批命中了不止一种情况，" +
      "处置不一样（例如环保宣称里「含再生材料」要补比例、「宽泛环保」要删词）。按列里列出的几种分别改。",
  ], "note");
  push([
    "口径",
    `只统计有结论的行；同一行可能被多条规则命中，所以下面各行「影响行数」相加会大于涉及的总行数 ${totalRows}。`,
  ], "note");
  push([], "blank");

  push(["规则", "名称", "严重度", "影响行数", "问题条数", "出现在哪一段", "标准改法", "依据", "涉及行号"], "header");
  if (!worklist.length) push(["（已完成的行里没有命中任何规则）", "", "", 0, 0, "", "", "", ""], "note");

  for (const group of worklist) {
    const rowsText = group.rows.length > rowLimit
      ? `${group.rows.slice(0, rowLimit).join("、")} …（还有 ${group.rows.length - rowLimit} 行）`
      : group.rows.join("、");
    const fieldsText = group.fields.map((item) => `${item.field} ${item.count}`).join("；");
    push([
      group.rule_id,
      group.title,
      SEVERITY_LABELS[group.severity] || group.severity || "",
      group.rows_affected,
      group.count,
      fieldsText,
      adviceCell(group),
      group.in_rule_pack ? group.basis_label || "（规则包没标依据）" : "（规则包外）",
      rowsText,
    ]);
  }
  return lines;
}

export function writeWorklistSheet(book, worklist, options = {}) {
  const sheet = book.addWorksheet("按规则处理");
  for (const line of worklistRows(worklist, options)) {
    if (line.style === "blank") {
      sheet.addRow([]);
      continue;
    }
    const row = sheet.addRow(line.cells);
    if (line.style === "title") row.font = { bold: true, size: 14 };
    else if (line.style === "header") row.font = { bold: true };
    else if (line.style === "note") row.font = { italic: true, color: { argb: "FF6B6B6B" } };
    row.alignment = { vertical: "top", wrapText: true };
  }
  sheet.columns = [
    { width: 14 },
    { width: 24 },
    { width: 20 },
    { width: 10 },
    { width: 10 },
    { width: 22 },
    // 46 → 58：这一格现在可能装「一句标准改法 + 本批 N 种情况」，
    // 46 列宽会把两种改法挤成六七行（第 21 轮实测内容是 2 句共 100 余字）。
    { width: 58 },
    { width: 16 },
    { width: 40 },
  ];
  return sheet;
}
