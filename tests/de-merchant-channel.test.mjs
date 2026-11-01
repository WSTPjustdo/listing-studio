import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";

/**
 * 第 8 轮：GPSR 四要素的数据通道到底是「没有」还是「有但没填」。
 *
 * 第 6 轮写的是「档案里根本没有制造商/欧盟责任人字段」。这句话只对了一半：
 * 专门字段确实没有，但商品档案里有一种通用通道 —— `additional_facts`（界面上的「补充事实」），
 * 它会原样进生成上下文。所以清单里必须分清两种状态：
 *   ① 补充事实里已经有 → 说清有几条、点名 label，但页面上有没有展示仍然判不了；
 *   ② 一条都没有 → 告诉商家往哪填（label 写什么），而不是只说「判不了」。
 * 两种状态都不给 pass —— 这一条永远只到「未完成」。
 */

const de = rulePackFor("DE");
const gpsr = (r) => r.checks.find((check) => check.rule_id === "DE-GPSR-19");
const review = (profile) =>
  reviewContent({
    content: { title: "Baumwolltasche 38 x 42 cm", item_highlights: "", bullet_points: [], description: "100 % Baumwolle." },
    profile,
    rulePack: de,
    marketplace: "DE",
  });
const profileWith = (facts) => ({
  product_id: "P-1",
  revision: 1,
  name_zh: "棉布袋",
  additional_facts: facts.map(([label, value], index) => ({
    id: `AF-${index}`,
    label,
    value,
    status: "merchant_confirmed",
    source_ids: [],
  })),
});

test("补充事实是空的：明说「也没有这类记录」，并给出该填什么 label", () => {
  const check = gpsr(review(profileWith([])));
  assert.match(check.reason, /补充事实」里也没有这类记录/);
  assert.match(check.reason, /Hersteller \/ EU-Verantwortlicher \/ Modell und EAN/);
  assert.equal(check.state, "not_checked");
});

test("档案里没有关联商品（profile 为空）时，旧口径仍然成立", () => {
  const check = gpsr(review(null));
  assert.match(check.reason, /商品档案里没有制造商与欧盟责任人字段/);
  assert.match(check.reason, /不能根据「文案里没写」判定违规/);
});

test("补充事实里填了 Hersteller：说清有几条、点名 label，并且不再说「写不出来」", () => {
  const check = gpsr(
    review(
      profileWith([
        ["Hersteller", "Beispiel GmbH, Musterstraße 1, 10115 Berlin, service@beispiel.de"],
        ["Farbe", "natur"],
      ]),
    ),
  );
  assert.match(check.reason, /「补充事实」里有 1 条相关记录（Hersteller）/);
  assert.match(check.reason, /档案里有不等于报价页面上有/);
  assert.equal(/生成侧写不出来/.test(check.reason), false, "填了还说写不出来，就是自相矛盾");
  assert.equal(check.state, "not_checked", "填了也不给 pass：页面展示与否本地判不了");
});

test("value 里出现欧盟责任人（label 是中文）也算填了", () => {
  const check = gpsr(
    review(profileWith([["欧盟责任人", "Beispiel Vertrieb GmbH, Hauptstr. 2, 20095 Hamburg"]])),
  );
  assert.match(check.reason, /1 条相关记录/);
});

test("塞满无关补充事实不算填了（不能靠噪声冒充数据通道）", () => {
  const check = gpsr(
    review(
      profileWith([
        ["Farbe", "natur"],
        ["Material", "Baumwolle"],
        ["Verpackung", "Polybeutel"],
      ]),
    ),
  );
  assert.match(check.reason, /也没有这类记录/);
});

test("清单里必须点破「GPSR 要电子地址 / AMZ-03 禁止邮箱」这对矛盾", () => {
  const check = gpsr(review(profileWith([])));
  assert.match(check.reason, /AMZ-03/);
  assert.match(check.reason, /邮箱只填后台栏位/);
});

test("把档案里的邮箱照抄进文案，会被 AMZ-03 按阻断拦下（这就是上一条要提醒的原因）", () => {
  const profile = profileWith([["Hersteller", "Beispiel GmbH, Musterstraße 1, 10115 Berlin, service@beispiel.de"]]);
  const clean = reviewContent({
    content: { title: "Baumwolltasche", item_highlights: "", bullet_points: [], description: "Hersteller: Beispiel GmbH, Musterstraße 1, 10115 Berlin." },
    profile,
    rulePack: de,
    marketplace: "DE",
  });
  assert.equal(
    clean.issues.filter((issue) => issue.rule_id === "AMZ-03").length,
    0,
    "文案里没有电子地址就不该报 AMZ-03",
  );
  const withEmail = reviewContent({
    content: { title: "Baumwolltasche", item_highlights: "", bullet_points: [], description: "Hersteller: Beispiel GmbH, service@beispiel.de" },
    profile,
    rulePack: de,
    marketplace: "DE",
  });
  const hit = withEmail.issues.find((issue) => issue.rule_id === "AMZ-03");
  assert.ok(hit, "文案里写了邮箱，AMZ-03 必须报");
  assert.equal(hit.severity, "blocking");
});
