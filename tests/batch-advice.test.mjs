// 批量工作单（导出 Excel 的「按规则处理」页）：同一条规则命中多种情况时，
// 表上必须能看到不同的改法，而不是一句「统一改」。
//
// 第 21 轮 · 方向 C。为什么值得测：这张表按**规则**汇总，此前只带规则包的 `repair`，
// 而 `US-01` 一条规则下分了六类宣称（`recycled` 补比例 / `eco-friendly` 删词）。
// 用真实语料实测：2 行批次里出现 3 种具体改法，表上原来能看到 0 种。
import test from "node:test";
import assert from "node:assert/strict";
import { adviceCell, ruleWorklist, worklistRows } from "../server/batch-summary.mjs";

/** 两个假设记录：同一规则（US-01）两种情况 + 另一条规则一条。 */
function fixture() {
  const records = new Map([
    [
      2,
      {
        version: 1,
        rule_pack_version: "v-test",
        review: {
          issues: [
            {
              rule_id: "US-01",
              severity: "needs_review",
              field_path: "content.bullet_points.b1",
              title: "环保宣称",
              original: "recycled cotton",
              suggestion: "补上再生成分比例，比例拿不到就先别写这个词。",
            },
            {
              rule_id: "AMZ-01",
              severity: "blocking",
              field_path: "content.title",
              title: "标题长度",
              original: "a very long title",
              suggestion: "缩到 75 字符以内再提交。",
            },
          ],
        },
      },
    ],
    [
      3,
      {
        version: 1,
        rule_pack_version: "v-test",
        review: {
          issues: [
            {
              rule_id: "US-01",
              severity: "needs_review",
              field_path: "content.bullet_points.b1",
              title: "环保宣称",
              original: "eco-friendly",
              suggestion: "移除这个泛用词，换成能拿出证据的表述。",
            },
          ],
        },
      },
    ],
  ]);
  const batch = { rows: [{ row: 2, status: "completed" }, { row: 3, status: "completed" }] };
  const pack = {
    rule_pack_version: "v-test",
    rules: [
      { rule_id: "US-01", title_zh: "环保宣称", repair: "建议移除宽泛宣称，或确认支持证据。" },
      { rule_id: "AMZ-01", title_zh: "标题长度", repair: "提出更短的标题，不加入新事实。" },
    ],
    sources: [],
  };
  return ruleWorklist(batch, (row) => records.get(row.row) || null, pack);
}

const sheetText = (worklist) =>
  worklistRows(worklist)
    .map((line) => line.cells.join(" \u0001 "))
    .join("\n");

test("同一条规则本批两种情况：两种改法都出现在表上", () => {
  const text = sheetText(fixture());
  assert.ok(text.includes("补上再生成分比例"), "含再生材料那条的具体改法没上表");
  assert.ok(text.includes("移除这个泛用词"), "宽泛环保那条的具体改法没上表");
  assert.match(text, /本批 2 种情况，改法不同/);
});

test("标准改法不丢：规则包那句话仍在同一格里", () => {
  const text = sheetText(fixture());
  assert.ok(text.includes("建议移除宽泛宣称，或确认支持证据。"));
});

test("表头那句「统一改」不许留着——它在这类规则上是错的", () => {
  const text = sheetText(fixture());
  assert.doesNotMatch(text, /再按「标准改法」统一改/);
  assert.match(text, /不能一句话统一改/);
});

test("advices 按规则分开收，不许串到别的规则上", () => {
  const worklist = fixture();
  const us01 = worklist.find((x) => x.rule_id === "US-01");
  const amz01 = worklist.find((x) => x.rule_id === "AMZ-01");
  assert.equal(us01.advices.length, 2);
  assert.equal(amz01.advices.length, 1);
  assert.ok(!amz01.advices.some((x) => x.includes("再生")));
});

test("建议与标准改法是同一句时只印一遍", () => {
  const cell = adviceCell({
    in_rule_pack: true,
    repair: "删掉促销语，放进后台促销工具。",
    advices: ["删掉促销语，放进后台促销工具"],
  });
  assert.equal(cell.split("删掉促销语").length - 1, 1, "同一句话被印了两遍");
  assert.doesNotMatch(cell, /本批/);
});

test("规则包外：不套用当前规则，也不编具体改法", () => {
  const cell = adviceCell({ in_rule_pack: false, repair: "", advices: ["随便一句"] });
  assert.match(cell, /依据未知/);
  assert.ok(!cell.includes("随便一句"));
});

test("表结构没动：表头与数据行仍是 9 列（说明文字行不算）", () => {
  const lines = worklistRows(fixture()).filter((line) => ["header", "text"].includes(line.style));
  assert.ok(lines.length >= 3, "没有数据行");
  for (const line of lines)
    assert.equal(line.cells.length, 9, `列数变了：${line.cells.slice(0, 2).join(" / ")}`);
});
