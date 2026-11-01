/**
 * 文案字符数：每个字段现在多长、离上限还差多少（第 16 轮自提 93）。
 *
 * 为什么报告里要写这个：商家改稿时最常问的一句是"标题还能不能加两个字"。
 * 报告里有 21 条问题、有逐条说明、有工作单，**唯独没有"现在多少字符"**——
 * 于是一条「标题 78 字符超限」的问题读完之后，商家还得自己把标题复制到别处数一遍。
 *
 * 三条口径，都是为了不把"我没查"说成"没问题"：
 *
 *   1. **上限只能来自规则包**。`AMZ-01` / `AMZ-02` 的 `constraint.max_characters` 是唯一出处，
 *      代码里不许再写一遍 75 / 125——写两处迟早对不上（一处改了另一处不改，报告就会自相矛盾）。
 *   2. **规则包没规定上限的字段，就写"没规定"**，不拿 Amazon 后台的经验值充数。
 *      五点、描述目前都没有进规则包，编一个 500/2000 出来等于给了个我们没核对过的承诺。
 *   3. **按 Unicode 码点数，不按 `String.length`**。JavaScript 的 `.length` 数的是 UTF-16 码元，
 *      一个 emoji 算 2；规则包里 `application_counting` 写的是 `unicode_code_points`。
 *      差一位就可能出现"我们说过线了、商家在后台看没过线"。
 */
import { characterCount } from "./domain.mjs";

/** 报告的字段顺序 = 文案的顺序（和改稿工作单同一套）。 */
const FIELDS = [
  { key: "title", label: "标题", ruleId: "AMZ-01" },
  { key: "item_highlights", label: "亮点", ruleId: "AMZ-02" },
];

/** 从规则包里取这个字段的上限。取不到就返回 null——不猜。 */
function limitOf(rules, ruleId, fieldPath) {
  if (!ruleId) return null;
  const rule = (rules || []).find((item) => item.rule_id === ruleId);
  if (!rule) return null;
  if (!(rule.field_paths || []).includes(fieldPath)) return null;
  const max = rule.constraint?.max_characters;
  return typeof max === "number" ? max : null;
}

function row(label, text, limit) {
  const chars = characterCount(String(text ?? ""));
  return {
    label,
    chars,
    limit,
    remaining: typeof limit === "number" ? limit - chars : null,
    over: typeof limit === "number" ? chars > limit : false,
  };
}

/**
 * 每个字段的字符数。
 *
 * 返回值里 `over_limit` 只数"规则包给了上限且超了"的字段——
 * 没有上限的字段不进这一列，否则"没规定"会被读成"没问题"。
 */
export function charBudget(content = {}, rules = []) {
  const rows = FIELDS.map((field) =>
    row(field.label, content[field.key], limitOf(rules, field.ruleId, `content.${field.key}`)),
  );

  // 五点逐条报：只报一个总数，商家不知道该改第几条。
  const bullets = Array.isArray(content.bullet_points) ? content.bullet_points : [];
  bullets.forEach((bullet, index) => {
    rows.push(row(`五点 ${index + 1}`, bullet?.text, limitOf(rules, null, "content.bullet_points")));
  });

  rows.push(row("描述", content.description, limitOf(rules, null, "content.description")));

  return {
    rows,
    limited: rows.filter((item) => item.limit !== null).length,
    over_limit: rows.filter((item) => item.over).length,
  };
}

/**
 * 报告里的「字符数」小节。
 *
 * 位置在英文文案**下面**：先读文案，再看它多长。反过来会让读者先看一堆数字。
 * 一行都没有时返回空串（空文案的报告不该多一张空表）。
 */
export function charBudgetSection(budget, escape = (x) => String(x ?? "")) {
  const rows = (budget?.rows || []).filter(Boolean);
  if (!rows.length) return "";

  const body = rows
    .map((item) => {
      const limit = item.limit === null ? '<span class="muted">本规则包未规定上限</span>' : `${item.limit}`;
      const remaining =
        item.limit === null
          ? '<span class="muted">—</span>'
          : item.over
            ? `<span style="color:#b95245">超 ${item.chars - item.limit}</span>`
            : `${item.remaining}`;
      return (
        `<tr data-char-field="${escape(item.label)}">` +
        `<td>${escape(item.label)}</td>` +
        `<td>${item.chars}</td>` +
        `<td>${limit}</td>` +
        `<td>${remaining}</td>` +
        `</tr>`
      );
    })
    .join("");

  // 这一段原来把「标题 75、亮点 125」写死在句子里——就在本文件第 11 行写着"代码里不许再写一遍 75 / 125"的正下方。
  // 第 6 轮量到 prompt 里那处写死会跟着规则包失配，报告里这处同理：换成上限 80 的包，纸上会印 75。
  // 现在只从 budget 自己带的数里拼；一个都没给上限时，这句话干脆不提数字。
  const limited = rows.filter((item) => item.limit !== null);
  const which = limited.length
    ? `（本次：${limited.map((item) => `${item.label} ${item.limit}`).join("、")}）`
    : "";
  return (
    `<h3 style="font-size:15px;margin:14px 0 6px">字符数（按 Unicode 码点，含空格）</h3>` +
    `<table><thead><tr><th>字段</th><th>当前</th><th>上限</th><th>余量</th></tr></thead>` +
    `<tbody>${body}</tbody></table>` +
    // 这里是 HTML 模板：`**加粗**` 不会被渲染成粗体，只会把星号印到纸上（第 18 轮看截图才发现，
    // 那句话从第 15 轮起就一直这么印着）。要粗就用 <strong>。
    `<p class="muted">上限一列只填<strong>规则包里写明</strong>的数${which}。` +
    `写「本规则包未规定上限」的字段，本项目没有核对过平台限制，` +
    `因此这里既不说它合格，也不说它超限——要改这些字段，请按平台后台的实时提示为准。</p>`
  );
}
