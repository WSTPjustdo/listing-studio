import test from "node:test";
import assert from "node:assert/strict";
import { rulePack } from "../server/store.mjs";
import { loadEvalSet, runCase, judge, summarize } from "../scripts/eval-set-probe.mjs";

// 这组用例守的是**数据集本身**，不是某条规则的实现。
// 数据集可以随便加，但不许变成一张「全是自己人会做的题」：如果哪天有人把难的用例删掉，
// 或者把语义层的规则写进 must_not_fire 骗绿，这里会先红。

let evalSet = null;
try {
  evalSet = await loadEvalSet();
} catch {
  // 评测集和真实语料一样按约定不入库：交付包解压后没有这个文件。
  // 那是「没带数据」，不是「代码坏了」——跳过并写明原因，别让解开包的人去修不存在的问题。
  evalSet = null;
}
const skipIfNoSet = (t) => {
  if (evalSet) return false;
  t.skip("qa/research/eval-set-*.json 未随包分发（真实语料不入库），本仓库内仍会跑");
  return true;
};
const known = new Set(rulePack.rules.map((r) => r.rule_id));
const det = new Set(evalSet?.layers?.deterministic?.rules ?? []);

test("评测集每条都有依据、id 唯一、只引用规则包里存在的规则", (t) => {
  if (skipIfNoSet(t)) return;
  const ids = evalSet.cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "用例 id 必须唯一");
  for (const entry of evalSet.cases) {
    assert.ok(entry.why && entry.why.length > 20, `${entry.id} 缺一句依据`);
    assert.ok(entry.origin, `${entry.id} 缺出处`);
    assert.ok(["violation", "compliant"].includes(entry.kind), `${entry.id} 的 kind 不合法`);
    for (const id of [...(entry.must_fire || []), ...(entry.must_not_fire || [])])
      assert.ok(known.has(id), `${entry.id} 引用了规则包里没有的 ${id}`);
    assert.equal(typeof entry.content.item_highlights, "string", `${entry.id} 的 item_highlights 必须是字符串`);
  }
});

test("must_not_fire 只允许写确定层规则", (t) => {
  if (skipIfNoSet(t)) return;
  // 语义层的结论在模型那边，本地启发式没报 ≠ 不该报。
  // 把它写进 must_not_fire，等于用「本地没报」冒充「产品判定正确」。
  for (const entry of evalSet.cases)
    for (const id of entry.must_not_fire || [])
      assert.ok(det.has(id), `${entry.id} 把语义层规则 ${id} 写进了 must_not_fire`);
});

test("确定性层：0 漏报、0 误报（这是硬门槛）", (t) => {
  if (skipIfNoSet(t)) return;
  const results = evalSet.cases.map((entry) => judge(entry, runCase(entry), evalSet.layers));
  const stats = summarize(results, evalSet.cases, evalSet.layers);
  const broken = results.filter((r) => !r.pass);
  assert.equal(
    broken.length,
    0,
    `确定层有问题的用例：${broken.map((r) => `${r.id}(漏 ${r.detMissing.join("/") || "-"}，多 ${r.detUnexpected.join("/") || "-"})`).join("；")}`,
  );
  // 分母也不能被做空：确认集子里真有足够多的「该报」与「不该报」。
  assert.ok(stats.detMust >= 7, `确定层该报的用例只剩 ${stats.detMust} 条，门槛被做空了`);
  assert.ok(stats.detMustNot >= 20, `确定层不该报的断言只剩 ${stats.detMustNot} 处`);
});

test("边界值成对出现：长度阈值上下各有一条", (t) => {
  if (skipIfNoSet(t)) return;
  // 只有「超很多」的用例是测不出差一错误的：75 过 / 76 红这一对才是。
  const ids = new Set(evalSet.cases.map((c) => c.id));
  for (const id of ["EB-001", "EB-002", "EB-004", "EB-005"]) assert.ok(ids.has(id), `缺边界用例 ${id}`);
  const t75 = evalSet.cases.find((c) => c.id === "EB-001");
  const t76 = evalSet.cases.find((c) => c.id === "EB-002");
  assert.equal([...t75.content.title].length, 75);
  assert.equal([...t76.content.title].length, 76);
});

test("已知缺陷用例必须标 known_issue（不许悄悄删掉）", (t) => {
  if (skipIfNoSet(t)) return;
  const flagged = evalSet.cases.filter((c) => c.known_issue);
  assert.ok(flagged.length >= 1, "把已知缺陷标出来，下一轮才知道该修什么");
  for (const entry of flagged) assert.ok(entry.known_issue.length > 10, `${entry.id} 的 known_issue 要写清是什么缺陷`);
});
