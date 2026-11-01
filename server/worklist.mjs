/**
 * 改稿工作单：把问题按「改哪一段」排成一张能照着做的单子（第 15 轮自提 87）。
 *
 * 为什么报告里已经有「风险分布（按位置）」和「逐条说明」，还要再来一张单子：
 *
 *   - 风险分布回答的是"压力在哪一段"，给的是**条数**（标题 4 条、五点 12 条），不是动作；
 *   - 逐条说明回答的是"每一条为什么"，但顺序是**规则/严重度**，不是文案的先后。
 *
 *   商家真正改稿的动作顺序是**从上往下读自己的文案**：标题 → 亮点 → 五点 1..5 → 描述。
 *   拿着按严重度排的一份清单去改，等于在文章里来回跳。
 *
 * 三条口径：
 *   1. **位置精确到第几条卖点**（`五点 3`），不像风险分布那样把五条合成一组——
 *      合成一组是为了看压力，做单子必须能直接定位。
 *   2. 每条都带「标准改法」：来自规则包的 `repair`。这是报告里第一次出现它
 *      （此前只在规则页和界面按钮上）。**规则包里没有 repair 就明说没有**，不拿
 *      `suggestion` 冒充——那是针对这一句的措辞，不是这条规则的标准改法。
 *   3. 依据分「官方文件 / 项目内部约定」两类，跟报告其他节一致：内部约定不许说成平台规定。
 *
 * 第 21 轮修掉的一条（`advicePair`）：上面第 2 条只说了"标准改法要印"，
 * 实现却写成了 `action ? 只印 action : 才印 suggestion` —— 于是**每条问题的具体建议
 * 一个字都到不了纸面**（45 条真实语料实测 42/42 丢）。
 * 两句话回答的不是同一个问题：
 *   - `suggestion` 是「这一条怎么改」：命中哪个词、属于哪一类情况（`US-01` 的
 *     `recycled` 要补比例、`eco-friendly` 要删词，是两件事）；
 *   - `repair` 是「这条规则统一怎么做」：一条规则一句话，装不下按词分流。
 * 所以两句都要印，但**互相包含就只印一遍**——同一件事说两遍会让人以为要改两处。
 */

import { charBudgetSection } from "./char-budget.mjs";
import { originLine } from "./report.mjs";
import { printFooter } from "./report-style.mjs";
import { citationForField } from './rules-doc.mjs';

const SEVERITY_RANK = { blocking: 0, needs_review: 1, suggestion: 2 };
const SEVERITY_LABEL = { blocking: "阻断", needs_review: "待核对", suggestion: "建议" };

/** 文案里各段的先后顺序。未知字段排在最后，不能因为不认识就丢掉。 */
function fieldSortKey(path) {
  const raw = String(path || "");
  if (raw === "content.title") return [0, 0];
  if (raw === "content.item_highlights") return [1, 0];
  const bullet = /^content\.bullet_points\.(?:b)?(\d+)$/.exec(raw);
  if (bullet) return [2, Number(bullet[1])];
  if (raw.startsWith("content.bullet_points.")) return [2, 900];
  if (raw === "content.description") return [3, 0];
  return [4, raw];
}

/** 人话位置：`五点 3`。写不出来就原样给字段路径 —— 宁可露出内部名，也不许留空。 */
export function worklistLabel(path) {
  const raw = String(path || "");
  if (!raw) return "未标位置";
  if (raw === "content.title") return "标题";
  if (raw === "content.item_highlights") return "亮点";
  // 卖点字段的真身是 `content.bullet_points.b3`（id 就是 b+序号，见 domain.flattenContent）。
  // 一开始这里只认纯数字，结果全部回落到原始路径，界面上显示成一串 `content.bullet_points.b5`。
  if (raw.startsWith("content.bullet_points.")) {
    const tail = raw.slice("content.bullet_points.".length);
    const numbered = /^(?:b)?(\d+)$/.exec(tail);
    return numbered ? `五点 ${Number(numbered[1])}` : `五点（${tail}）`;
  }
  if (raw === "content.description") return "描述";
  return raw;
}

// 去空白与标点再比：规则包写「删掉这个词。」、引擎写「删掉这个词，或换成具体证据。」，
// 差一个逗号就判成两件事，那是拿标点在说话，不是拿内容在说话。
const norm = (text) => String(text || "").replace(/[\s，。、；：！？（）「」【】,.;:!?()\[\]]/g, "");

/**
 * 一条问题该印哪几句「怎么改」。
 *
 * 两种来源、两个层级，缺一不可：
 *   - `suggestion`（这一条的具体建议）：命中了什么词、属于哪一类情况。
 *     `US-01` 一个规则下有六类（`ECO_ADVISORIES`），`recycled` 与 `eco-friendly`
 *     的处置完全是两件事（补比例 / 删词）。
 *   - `action`（规则包里的 `repair`，标准改法）：这条规则统一怎么说。
 *
 * 第 21 轮之前渲染层是 `action ? 只印 action : 才印 suggestion`，
 * 45 条真实语料实测：42 条问题全都自带具体建议，**42 条一条都没印上纸**。
 *
 * 去重只认「互相包含」，不搞相似度阈值：阈值需要一个说不清出处的数字，
 * 而包含关系是能逐条核对的。实测 45 条语料里 0 条会被这条规则吞掉
 * （`scripts/worklist-advice-probe.mjs`）。
 */
export function advicePair(item) {
  const action = String(item?.action || "").trim();
  const advice = String(item?.suggestion || "").trim();
  if (!action && !advice)
    return { lines: [], missing: true };
  if (!action)
    return {
      lines: [{ label: "怎么改（这一条）", text: advice }],
      note: "这条规则没有写标准改法。",
    };
  if (!advice) return { lines: [{ label: "怎么改", text: action }] };
  const a = norm(action);
  const b = norm(advice);
  if (a === b || b.includes(a) || a.includes(b))
    return { lines: [{ label: "怎么改", text: advice.length > action.length ? advice : action }], deduped: true };
  return {
    lines: [
      { label: "怎么改（这一条）", text: advice },
      { label: "这条规则的标准改法", text: action },
    ],
  };
}

function basisOf(citation) {
  if (!citation) return { kind: 'unknown', label: '依据未知', detail: '该历史版本未登记对应来源，不推定为官方或内部约定', link: null };
  const sources = (citation?.sources || []).filter((x) => x && x.publisher);
  const official = sources.filter((x) => x.is_official);
  if (!official.length)
    return {
      kind: "internal",
      label: "项目内部约定",
      detail: "不是 Amazon 或监管机构的规定",
      link: null,
    };
  const first = official[0];
  return {
    kind: "official",
    label: "官方文件",
    detail: [first.publisher, first.document_date ? `文件日期 ${first.document_date}` : ""]
      .filter(Boolean)
      .join(" · "),
    link: first.url || null,
  };
}

/**
 * 把 issues 折成按段落排的工作单。
 *
 * `citations` 是 `Map(rule_id → citation)`（由 `ruleCitations(rulePack)` 建），
 * 没有就按"未登记来源"处理——和 `issueBasis` 同一套兜底。
 */
export function buildWorklist(issues = [], rules = [], citations = new Map()) {
  const ruleById = new Map((rules || []).map((rule) => [rule.rule_id, rule]));
  const groups = new Map();

  for (const issue of (issues || []).filter(Boolean)) {
    const path = String(issue.field_path || "");
    if (!groups.has(path))
      groups.set(path, {
        field_path: path,
        label: worklistLabel(path),
        items: [],
        blocking: 0,
        needs_review: 0,
        suggestion: 0,
      });
    const group = groups.get(path);
    const rule = ruleById.get(issue.rule_id);
    const severity = SEVERITY_RANK[issue.severity] !== undefined ? issue.severity : "needs_review";
    group[severity] += 1;
    group.items.push({
      issue_id: issue.issue_id || null,
      rule_id: issue.rule_id,
      title: issue.title || rule?.title_zh || issue.rule_id,
      severity,
      severity_label: SEVERITY_LABEL[severity],
      original: issue.original || "",
      reason: issue.reason || "",
      // 标准改法只认规则包里的 repair。没有就留空，让渲染层明说"这条规则没写标准改法"。
      action: rule?.repair || "",
      suggestion: issue.suggestion || "",
      in_rule_pack: Boolean(rule),
      basis: basisOf(citationForField(citations instanceof Map ? citations.get(issue.rule_id) : citations?.[issue.rule_id], issue.field_path)),
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: group.items.sort(
        (a, b) =>
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
          String(a.rule_id).localeCompare(String(b.rule_id)),
      ),
    }))
    .sort((a, b) => {
      const [aRank, aIndex] = fieldSortKey(a.field_path);
      const [bRank, bIndex] = fieldSortKey(b.field_path);
      if (aRank !== bRank) return aRank - bRank;
      if (typeof aIndex === "number" && typeof bIndex === "number") return aIndex - bIndex;
      return String(aIndex).localeCompare(String(bIndex));
    });
}

/**
 * 报告里的「改稿工作单」一节。
 *
 * 位置：逐条说明**之前**。读到这一节的人是要动手改稿的；逐条说明是给要追问依据的人看的。
 * 没有问题时返回空串（"0 条"的工作单没有意义，报告里已经有结论说没发现问题）。
 */
import { safeHref } from "./report.mjs";

export function worklistSection(worklist = [], escape = (x) => String(x ?? "")) {
  const groups = (worklist || []).filter((group) => group.items?.length);
  if (!groups.length) return "";
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const blocking = groups.reduce((sum, group) => sum + group.blocking, 0);

  const blocks = groups
    .map((group) => {
      const counts = [
        group.blocking ? `阻断 ${group.blocking}` : "",
        group.needs_review ? `待核对 ${group.needs_review}` : "",
        group.suggestion ? `建议 ${group.suggestion}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const rows = group.items
        .map((item, index) => {
          const tone =
            item.severity === "blocking"
              ? "#b95245"
              : item.severity === "needs_review"
                ? "#b36c32"
                : "#236b55";
          const pair = advicePair(item);
          const action = pair.missing
            ? `<p style="margin:4px 0"><strong>怎么改：</strong><span class="muted">` +
              `这条规则没有写标准改法，也没有针对这一条的建议，按规则说明人工判断。</span></p>`
            : pair.lines
                .map(
                  (line, i) =>
                    `<p style="margin:4px 0${i ? ";color:#5b5b66" : ""}"><strong>${escape(line.label)}：</strong>` +
                    `${escape(line.text)}</p>`,
                )
                .join("") +
              (pair.note ? `<p class="muted" style="margin:2px 0">${escape(pair.note)}</p>` : "");
          return (
            `<div data-worklist-issue="${escape(item.rule_id)}" data-worklist-severity="${escape(item.severity)}" ` +
            `style="border-left:3px solid ${tone};padding:6px 0 6px 10px;margin:8px 0">` +
            `<p style="margin:0 0 4px"><strong>${index + 1}. ${escape(item.rule_id)} · ${escape(item.title)}</strong>` +
            ` <span style="color:${tone}">［${escape(item.severity_label)}］</span>` +
            (item.in_rule_pack ? "" : ' <span class="muted">（不在当前规则包里）</span>') +
            `</p>` +
            (item.original
              ? `<blockquote style="margin:4px 0">${escape(item.original)}</blockquote>`
              : "") +
            `<p style="margin:4px 0"><strong>为什么：</strong>${escape(item.reason)}</p>` +
            action +
            `<p class="muted" style="margin:4px 0">依据：${escape(item.basis.label)}` +
            `${item.basis.detail ? ` · ${escape(item.basis.detail)}` : ""}` +
            `${item.basis.link ? (safeHref(item.basis.link) ? ` · <a href="${escape(safeHref(item.basis.link))}" rel="noreferrer">原文</a>` : ` · 来源地址不是 http(s)：${escape(item.basis.link)}`) : ""}</p>` +
            `</div>`
          );
        })
        .join("");
      return (
        `<div data-worklist-field="${escape(group.field_path)}" ` +
        `style="border:1px solid #e5e5ea;border-radius:10px;padding:10px 14px;margin:12px 0">` +
        `<p style="margin:0 0 4px;font-size:15px"><strong>${escape(group.label)}</strong>` +
        ` <span class="muted">${group.items.length} 条（${escape(counts)}）</span></p>` +
        `${rows}</div>`
      );
    })
    .join("");

  return (
    `<h2>改稿工作单（${groups.length} 段 · ${total} 条${blocking ? ` · 其中阻断 ${blocking} 条` : ""}）</h2>` +
    `<p>顺序就是文案的顺序：标题 → 亮点 → 五点（按第几条）→ 描述。每一条都给了「怎么改」，` +
    `改完回到「诊断与修复」重新检查一次——<strong>这张单子不是上架许可</strong>，它只是把这一版要动的地方排好了。</p>` +
    `<p class="muted">出现两行时先照<strong>「怎么改（这一条）」</strong>改：它针对命中的那个词` +
    `（同一规则下不同情况改法不同，例如「含再生材料」要补比例、「宽泛环保」要删词）；` +
    `下面那行是<strong>「这条规则的标准改法」</strong>，一句话概括这类问题怎么处理。` +
    `只出现一行，说明两者是同一件事，不是漏了一句。</p>` +
    `${blocks}` +
    `<p class="muted">依据一栏里写「项目内部约定」的，是本项目自定的检查项，不是 Amazon 或监管机构的规定；` +
    `同一段里有多条问题时按严重度排序（阻断在前），不是按原文出现的先后。</p>`
  );
}


/**
 * 工作单抬头那句"这张单子只覆盖查过的那部分"。
 *
 * 两种情况要分开说，因为下一步动作不同：
 *   - 没关联商品 → 以档案为准的检查根本没执行，关联回来再查一次才有意义；
 *   - 关联了但没查完 → 剩下几项没有结论，补跑一次。
 * 都齐了就返回空串（干净的版本不该多一句噪音）。
 */
function coverageCaveat(record, escape) {
  const coverage = record?.review?.coverage || {};
  const total = Number(coverage.total) || 0;
  const completed = Number(coverage.completed) || 0;
  const parts = [];
  if (!record?.product_ref)
    parts.push(
      "这一版没有关联商品档案，所以尺寸、材质、承重这些以档案为准的对照没有执行" +
        "——单子上不会有它们，不等于它们没问题。",
    );
  if (total > completed)
    parts.push(
      `这一版只查了 ${completed}/${total} 项检查：剩下的 ${total - completed} 项没有结论，` +
        "既不算通过也不算失败。",
    );
  const uncovered = record?.review?.unmodeled_parameters?.length || 0;
  if (uncovered) parts.push(`另有 ${uncovered} 处参数不在当前核对范围，须人工核对原始资料。`);
  if (!parts.length) return "";
  return (
    `<p style="border-left:3px solid #b36c32;background:#fdf6ef;padding:8px 12px;margin:10px 0">` +
    `${escape(parts.join(""))}</p>`
  );
}

/**
 * 单独导出一张工作单（`?format=worklist`）。
 *
 * 为什么单独成一张：给改稿的人时，"要改这几处"比一份 17KB 的完整报告好用得多。
 * 完整报告仍然保留——它回答"凭什么"，这张纸只回答"改哪里"。
 *
 * **别叫它"一页"**（第 19 轮自提 106 实测）：0 条问题时确实是 1 页，演示坏文案 21 条时
 * 打到 6 页。页数随条数长，说死"一页"就是在纸上写一个没量过的数。数字由
 * `scripts/print-check.mjs` 量，写在 README 的一张表里。
 */
export function worklistDocument(record, worklist, escape = (x) => String(x ?? ""), budget = null) {
  const issues = record?.review?.issues || [];
  return (
    `<h1>改稿工作单 · V${Number(record?.version) || 1}</h1>` +
    `<p class="muted">${escape(record?.content?.title || "（无标题）")}<br>` +
    `这一版共 ${issues.length} 条问题。改完回到「诊断与修复」重新检查一次——` +
    `单子清空不等于可以上架。</p>` +
    // 这张纸最容易被问住的一句：「这份文案是谁、按什么要求写出来的」（第 17 轮自提 103）。
    // 完整报告里有「与上一版的差异」，差异段头上有这句话；单页工作单原来只有"共 N 条问题"，
    // 拿给别人改稿时，对方看不出这一版是"生成的首版"还是"照某条要求改的"。
    // 传 `referToDiff:false`：这张纸上没有差异段，不能让它指向一张不存在的表。
    (record ? originLine(record, { referToDiff: false }) : "") +
    // 单独一张纸最容易漏掉的一句：**这张单子只列了查过的那部分**。
    // 完整报告里有「检查清单」能看出差几项，这张纸出去之后就没有了——
    // 拿着它改完，人会以为"单子空了 = 干净了"，而实际上有几项压根没查。
    coverageCaveat(record, escape) +
    (worklistSection(worklist, escape) ||
      "<p>这一版在已检查范围内没有发现问题，没有需要改的地方。</p>") +
    // 字符数放在最后：改稿的人从上往下改，改到某一段想知道"还能加几个字"时正好在眼前。
    // 传不进来（老调用方）就整节省略，不报错——这张纸的主体是待办，不是统计。
    (budget ? charBudgetSection(budget, escape) : "") +
    // 免责句从"正文末尾的一段"改成**页脚**（第 20 轮自提 114）：这一段只在最后一页出现，
    // 而一张 7 页的单子被复印中间几页时，那几页上没有任何一句话说"这不表示平台审核通过"。
    // 现在是打印时 `position:fixed` 的页脚，每页都有（逐页读 PDF 验过）。
    printFooter(record)
  );
}
