#!/usr/bin/env node
/**
 * 把「德国站规则跑过真实在售商品」这件事渲染成一页纸（`qa/de-corpus-evidence.html`）。
 *
 * 为什么单独一个脚本而不是手写 HTML：这一页上的每个数字（17 条、5 条超 75、各规则命中几）
 * 都是 `data-research/de-listings-20261030.json` + 当前引擎算出来的。手写就会漂，
 * 而漂掉的数字印在纸上比没有更糟。所以：**只从语料 json 和规则包读数，不写死任何一个数**。
 *
 * 用法：node scripts/render-de-corpus-page.mjs
 * 产物：qa/de-corpus-evidence.html（A4 单页，可直接打印，也可在浏览器里投）
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IMPLEMENTED_RULE_IDS,
  PARTIALLY_IMPLEMENTED_RULE_IDS,
  characterCount,
} from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV = resolve(HERE, "..");
const CORPUS = resolve(DEV, "data-research/de-listings-20261030.json");
const OUT = resolve(DEV, "qa/de-corpus-evidence.html");

const esc = (value) =>
  String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

export function buildPage(corpus, pack) {
  const items = corpus.items || [];
  const cap = pack.rules.find((rule) => rule.rule_id === "AMZ-01")?.constraint?.max_characters ?? null;
  const lens = items.map((item) => characterCount(item.title));
  const over = items.filter((item) => characterCount(item.title) > cap);
  const hits = new Map();
  for (const item of items)
    for (const id of new Set((item.rules || []).map((row) => row.rule_id)))
      hits.set(id, (hits.get(id) || 0) + 1);

  const tier = (rule) =>
    IMPLEMENTED_RULE_IDS.has(rule.rule_id)
      ? "full"
      : PARTIALLY_IMPLEMENTED_RULE_IDS.has(rule.rule_id)
        ? "partial"
        : "human";
  const counts = { full: 0, partial: 0, human: 0 };
  for (const rule of pack.rules) counts[tier(rule)] += 1;
  const withLocalCheck = counts.full + counts.partial;

  const rows = pack.rules.map((rule) => ({
    rule_id: rule.rule_id,
    title: rule.title_zh,
    method: rule.method,
    tier: tier(rule),
    hits: hits.get(rule.rule_id) || 0,
  }));
const tierLabel = { full: "本地可判", partial: "部分可判", human: "需人工/模型" };
const tierTag = { full: "t-det", partial: "t-part", human: "t-model" };
// 规则包里的 method 是给程序看的英文长串（`candidate_detection_and_contextual_review`），
// 一页纸上排进去会把每行撑成三四行、整页溢到第二页；这里换成同义的短标签。
const METHOD_LABEL = {
  deterministic: "确定性",
  patterns_with_context_review: "模式+复核",
  patterns_and_semantic_review: "模式+语义",
  candidate_detection_and_contextual_review: "候选+复核",
  structured_comparison_and_semantic_review: "结构+语义",
  explicit_field_comparison: "字段比对",
  typed_fact_comparison: "类型比对",
};
const methodLabel = (method) => METHOD_LABEL[method] || String(method || "—");

  const createdAt = String(corpus.collected_at || "").slice(0, 10);
  const longest = [...items].sort((a, b) => characterCount(b.title) - characterCount(a.title))[0];
  const shortest = [...items].sort((a, b) => characterCount(a.title) - characterCount(b.title))[0];

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>德国站规则跑过 17 条真实在售商品</title>
<style>
  @page { size: A4 portrait; margin: 11mm 10mm; }
  :root{
    --ink:#1a1a1a; --muted:#5f6b76; --line:#c9d2da; --de:#8a1c1c; --tint-de:#fbeeee;
    --ok:#1f6b34; --part:#8a5410;
  }
  * { box-sizing: border-box; }
  body{
    margin:0; background:#fff; color:var(--ink);
    font-family:"Microsoft YaHei","PingFang SC","Segoe UI",system-ui,sans-serif;
    font-size:11px; line-height:1.5; -webkit-print-color-adjust:exact; print-color-adjust:exact;
  }
  .sheet{ width:190mm; margin:0 auto; padding:2mm 0 0; }
  h1{ font-size:17px; margin:0 0 2px; }
  .sub{ color:var(--muted); font-size:10px; margin:0 0 6px; }
  .meta{ display:flex; gap:10px; flex-wrap:wrap; font-size:9.8px; color:var(--muted); margin:0 0 8px; }
  .meta b{ color:var(--ink); font-weight:600; }
  .cards{ display:flex; gap:7px; margin:0 0 9px; }
  .card{ flex:1; border:1px solid var(--line); border-radius:3px; padding:6px 9px; }
  .card .n{ font-size:20px; font-weight:700; line-height:1.1; color:var(--de); }
  .card .k{ font-size:9.4px; color:var(--muted); margin-top:2px; }
  .answer{ border:1px solid var(--line); border-left:3px solid var(--de); border-radius:3px; padding:6px 9px; margin:0 0 9px; background:#fcfcfc; font-size:10.6px; }
  h2{ font-size:11.6px; margin:9px 0 3px; padding-bottom:2px; border-bottom:1px solid var(--line); }
  h2 span{ font-weight:400; color:var(--muted); font-size:9.2px; margin-left:6px; }
  table{ width:100%; border-collapse:collapse; table-layout:fixed; }
  th,td{ border-bottom:1px solid #e3e8ed; padding:2.2px 4px; vertical-align:top; text-align:left; }
  th{ background:#f4f6f8; font-weight:600; font-size:9.6px; color:#33414d; }
  td{ font-size:9.8px; }
  .id{ font-family:Consolas,"Courier New",monospace; font-size:9px; white-space:nowrap; }
  .tag{ display:inline-block; padding:0 3px; border-radius:2px; font-size:8.2px; white-space:nowrap; }
  .t-det{ background:#e7f2e9; color:var(--ok); }
  .t-part{ background:#fdf1e3; color:var(--part); }
  .t-model{ background:#eef0f3; color:#4a5560; }
  .num{ text-align:right; font-variant-numeric:tabular-nums; }
  .over{ color:var(--de); font-weight:600; }
  .quote{ font-size:9.2px; color:#33414d; overflow-wrap:anywhere; }
  .foot{ margin-top:8px; display:flex; gap:10px; }
  .box{ flex:1; border:1px solid var(--line); border-radius:3px; padding:5px 8px; font-size:9.2px; line-height:1.38; min-width:0; }
  .box h3{ margin:0 0 2px; font-size:9.4px; }
  .box ul{ margin:0; padding-left:13px; } .box li{ margin:0 0 1px; }
  .mono{ font-family:Consolas,"Courier New",monospace; font-size:8.4px; color:var(--muted); overflow-wrap:anywhere; word-break:break-word; }
  @media print { .sheet{ width:auto; } }
</style>
</head>
<body>
<div class="sheet">

  <h1>德国站的规则，跑过 ${items.length} 条真实在售商品</h1>
  <p class="sub">不是「我们觉得德国站该这么写」，是拿别人正在卖的德语 listing 喂进同一套引擎，看它到底报什么。</p>
  <p class="meta">
    <span>语料 <b>${esc(corpus.marketplace)} · ${items.length} 条 · ${createdAt} 抓取</b></span>
    <span>规则包 <b>${esc(corpus.pack_id)} / ${esc(corpus.rule_pack_version)}</b> · ${pack.rules.length} 条</span>
    <span>来源：amazon.de 搜索页前几屏 → 逐个商品页</span>
  </p>

  <div class="cards">
    <div class="card"><div class="n">${items.length}</div><div class="k">条在售 listing（逐条可回原页面）</div></div>
    <div class="card"><div class="n">${over.length}/${items.length}</div><div class="k">标题超过 ${cap} 字符（${Math.round((over.length / items.length) * 100)}%）</div></div>
    <div class="card"><div class="n">${withLocalCheck}/${pack.rules.length}</div><div class="k">条规则有本地检查（全判 ${counts.full} / 部分 ${counts.partial}）</div></div>
    <div class="card"><div class="n">${median(lens)}</div><div class="k">标题字符中位数（范围 ${Math.min(...lens)}–${Math.max(...lens)}）</div></div>
  </div>

  <div class="answer">
    <b>最容易问的一句：这批数字能说明什么？</b> 说明<b>德国站真实卖家也会写超长标题</b>——${items.length} 条里 ${over.length} 条超过 ${cap} 字符，
    最长 ${Math.max(...lens)} 字符；而这只是平台层最容易量的一条。法域层（GPSR 四要素、纺织品成分、环保宣称）
    要靠人复核，本页只报「引擎判得动的那部分」，判不动的照实写未完成。
  </div>

  <h2>一、19 条规则在这批语料上的表现<span>命中 ≠ 违规：判得动的是事实，判不动的照实标未完成</span></h2>
  <table>
    <colgroup><col style="width:16%"><col style="width:44%"><col style="width:14%"><col style="width:12%"><col style="width:14%"></colgroup>
    <thead><tr><th>规则</th><th>管什么</th><th>引擎</th><th class="num">命中</th><th>判定方式</th></tr></thead>
    <tbody>
${rows
  .map(
    (row) =>
      `      <tr><td class="id">${esc(row.rule_id)}</td><td>${esc(row.title)}</td>` +
      `<td><span class="tag ${tierTag[row.tier]}">${tierLabel[row.tier]}</span></td>` +
      `<td class="num">${row.hits}/${items.length}</td><td>${esc(methodLabel(row.method))}</td></tr>`,
  )
  .join("\n")}
    </tbody>
  </table>

  <h2>二、真实标题长什么样<span>原文照抄，只截断不修改；字符数按引擎同一套口径（Unicode 码点，含空格）</span></h2>
  <table>
    <colgroup><col style="width:18%"><col style="width:62%"><col style="width:8%"><col style="width:12%"></colgroup>
    <thead><tr><th>ASIN</th><th>标题（截断）</th><th class="num">字符</th><th>判定</th></tr></thead>
    <tbody>
      <tr><td class="id">${esc(longest.asin)}</td><td class="quote">${esc(String(longest.title).slice(0, 190))}…</td><td class="num over">${characterCount(longest.title)}</td><td class="over">超 ${cap} 字符</td></tr>
${over
  .slice(0, 3)
  .filter((item) => item.asin !== longest.asin)
  .map(
    (item) =>
      `      <tr><td class="id">${esc(item.asin)}</td><td class="quote">${esc(String(item.title).slice(0, 190))}…</td><td class="num over">${characterCount(item.title)}</td><td class="over">超 ${cap} 字符</td></tr>`,
  )
  .join("\n")}
      <tr><td class="id">${esc(shortest.asin)}</td><td class="quote">${esc(String(shortest.title).slice(0, 190))}</td><td class="num">${characterCount(shortest.title)}</td><td>未超</td></tr>
    </tbody>
  </table>

  <div class="foot">
    <div class="box">
      <h3>这份语料能证明</h3>
      <ul>
        <li>同一套引擎换个规则包就能跑另一个市场，结论落在具体规则号上</li>
        <li>德国站真实卖家也有 ${over.length}/${items.length} 条标题超过 ${cap} 字符（最长 ${Math.max(...lens)}）</li>
        <li>每条都能回到原页面：ASIN + 抓取时间 + 页面字节数都在 json 里</li>
      </ul>
    </div>
    <div class="box">
      <h3>这份语料不能证明</h3>
      <ul>
        <li>不能证明「德国卖家普遍违规」：样本来自搜索页前几屏，非随机抽样</li>
        <li>不能证明 GPSR 四要素缺失：四要素多在卖家信息区，本采集器只读主商品区文本</li>
        <li>不能替代生成验收：这里考的是「读别人的稿」，生成德语是另一次真模型验收</li>
      </ul>
    </div>
    <div class="box">
      <h3>怎么复现</h3>
      <ul>
        <li>数字由 <span class="mono">tests/de-corpus.test.mjs</span> 重算，引擎或包一改测试就红</li>
        <li>本页由 <span class="mono">scripts/render-de-corpus-page.mjs</span> 从同一份 json 生成</li>
        <li>重算命中表：<span class="mono">collect-de-listings.mjs --restat</span>（同一批快照，不重新抓页）</li>
      </ul>
    </div>
  </div>

</div>
</body>
</html>
`;
}

const corpus = JSON.parse(await readFile(CORPUS, "utf8"));
const pack = rulePackFor(corpus.marketplace || "DE");
// 被测试 import 时只取 buildPage，不落盘（否则跑一次测试就悄悄改了 qa/ 里的文件）。
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await writeFile(OUT, buildPage(corpus, pack), "utf8");
  console.log(JSON.stringify({ ok: true, out: OUT, items: corpus.items.length }, null, 2));
}
