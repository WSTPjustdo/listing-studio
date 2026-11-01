import test from "node:test";
import assert from "node:assert/strict";
import { FACT_STATUSES, NON_EVIDENCE_STATUSES, inspectEvidence } from "../server/evidence.mjs";
import { rulePack, scenarios, sourceCatalog } from "../server/store.mjs";

// 这组用例保护的是一个**静默失效**：
// 引擎把"能不能引用这条事实"绑在状态词上（FACT_STATUSES）。数据里如果留着一个引擎不认识的
// 状态词（历史上真发生过：`source_supported`），后果不是报错，而是——
// 每条参数都被读成"该字段尚未确认"，整篇干净文案变成 9 条待核对，AMZ-05 一次都不开。
// 测试因此不检查"某个具体状态词"，而是检查"数据用的词都在词表里"+"干净夹具真的能被对照上"。

const declared = new Set([...FACT_STATUSES, ...NON_EVIDENCE_STATUSES]);
const factEntries = (profile) =>
  Object.entries(profile).filter(
    ([, value]) =>
      value && typeof value === "object" && !Array.isArray(value) && typeof value.status === "string",
  );

test("every fact status in the demo fixtures is a declared status word", () => {
  const unknown = [];
  for (const profile of scenarios.product_profiles)
    for (const [field, fact] of factEntries(profile))
      if (!declared.has(fact.status))
        unknown.push(`${profile.product_id}.${field}=${fact.status}`);
  assert.deepEqual(unknown, [], "夹具里出现了引擎不认识的状态词，这些参数会静默变成‘尚未确认’");
});

test("every source id referenced by a demo fact is registered in the source catalog", () => {
  const known = new Set(sourceCatalog.map((x) => x.source_id));
  const missing = [];
  for (const profile of scenarios.product_profiles)
    for (const [field, fact] of factEntries(profile))
      for (const id of fact.source_ids || [])
        if (!known.has(id)) missing.push(`${profile.product_id}.${field} -> ${id}`);
  assert.deepEqual(missing, [], "来源没登记，checklist 里就查不到它，参数也无法关联");
});

test("the clean fixture's facts are actually usable, not silently downgraded to unconfirmed", () => {
  const profile = scenarios.product_profiles[0];
  const clean = scenarios.listing_fixtures.find((x) => x.fixture_id === "AMZ-CLEAN-001").content;
  const evidence = inspectEvidence(clean, profile, [], sourceCatalog);
  const links = evidence.flatMap((x) => x.parameter_links);
  const unmatched = links.filter((x) => x.status !== "matched");
  // 只断"至少对照上 5 处"和"没有一处被判成冲突"：夹具是干净的，
  // 一处都没对上才说明词表/来源目录又断了（这正是本轮修的那个 bug）。
  assert.ok(
    links.length >= 5,
    `干净夹具只认出 ${links.length} 处参数，词表或来源目录可能又不匹配了`,
  );
  assert.deepEqual(
    unmatched.map((x) => `${x.original}@${x.field_path}:${x.status}`),
    [],
    "干净夹具的已知参数不应被判成冲突或待核对",
  );
});

test("the active rule pack's own source ids resolve, so rule citations can be shown", () => {
  const known = new Set(sourceCatalog.map((x) => x.source_id));
  const missing = rulePack.rules
    .flatMap((rule) => rule.source_ids || [])
    .filter((id) => !known.has(id));
  assert.deepEqual(missing, []);
});
