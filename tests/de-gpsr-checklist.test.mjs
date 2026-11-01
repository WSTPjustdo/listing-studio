import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reviewContent } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";

/**
 * DE-GPSR-19（第 6 轮）：本地不给结论，只把四要素摊开列清单。
 *
 * 为什么不做检测：商品档案里没有制造商 / 欧盟责任人字段，生成侧写不出来；文案里没写
 * 也不等于违规（Amazon 的 Herstellerinformationen 是另一个渲染位置，抓不到）。
 * 所以这里钉住三件事：不改状态、不产生 issue、清单里四项都要在。
 */

const de = rulePackFor("DE");
const us = rulePackFor("US");
const gpsr = (r) => r.checks.find((check) => check.rule_id === "DE-GPSR-19");

const review = (content, { pack = de, marketplace = "DE" } = {}) =>
  reviewContent({
    content: { title: "Baumwolltasche 38 x 42 cm", item_highlights: "", bullet_points: [], description: "", ...content },
    profile: null,
    rulePack: pack,
    marketplace,
  });

test("四要素逐项列出，且照样是 not_checked（不给 pass 也不判违规）", () => {
  const r = review({ description: "Hergestellt aus 100 % Baumwolle." });
  const check = gpsr(r);
  assert.ok(check, "没有这条的检查记录");
  assert.equal(check.state, "not_checked");
  assert.equal(check.method, "checklist_only");
  assert.equal(r.issues.filter((issue) => issue.rule_id === "DE-GPSR-19").length, 0, "不该产生 issue");
  for (const keyword of ["制造商名称", "欧盟责任人", "型号 / 批次 / EAN", "德语警告"])
    assert.match(check.reason, new RegExp(keyword.replace(/[/]/g, "\\/")), `清单里缺「${keyword}」`);
});

test("说清为什么判不了：档案缺字段，不能用「文案里没写」判违规", () => {
  const check = gpsr(review({ description: "Baumwolle." }));
  assert.match(check.reason, /商品档案里没有制造商与欧盟责任人字段/);
  assert.match(check.reason, /不能根据「文案里没写」判定违规/);
  assert.match(check.reason, /Herstellerinformationen/);
});

test("文案里认得出线索时点名，并说明认得出不等于合规", () => {
  const check = gpsr(
    review({ description: "Kontakt: service@beispiel.de｜Modell: BT-38-42" }),
  );
  assert.match(check.reason, /电子地址/);
  assert.match(check.reason, /型号\/EAN/);
  assert.match(check.reason, /认得出不等于合规/);
});

test("什么线索都没有时也明说，不留空白", () => {
  const check = gpsr(review({ description: "Baumwolle, 140 g/m²." }));
  assert.match(check.reason, /没有认出任何一种相关线索/);
});

test("美国包没有这条规则，不冒出来", () => {
  const r = review({ description: "Cotton tote bag." }, { pack: us, marketplace: "US" });
  assert.equal(gpsr(r), undefined);
});

test("真实语料 17 条里，可读文本能认出制造商线索的是 0 条（这条要有数，不能凭印象说）", () => {
  const corpus = JSON.parse(
    readFileSync(new URL("../data-research/de-listings-20261030.json", import.meta.url), "utf8"),
  );
  let withClue = 0;
  for (const item of corpus.items) {
    const check = gpsr(
      review({
        title: item.title,
        bullet_points: (item.bullets || []).map((text, index) => ({ id: `b${index + 1}`, text })),
        description: item.description || "",
      }),
    );
    if (/能认出的相关线索/.test(check.reason)) withClue += 1;
  }
  // 抓到的是标题/五点/描述；Amazon 的 Hersteller 栏位不在其中（见交接的边界说明）。
  assert.equal(withClue, 0);
});
