// 促销语（promotional language）：以前**只有生成侧禁**（providers.mjs 的 prompt 里写了
// discounts / limited time），审核侧一个字不查。于是模型没照做、或商家自己手改，
// 文案带着促销语进报告，而报告说"没问题"。
//
// 依据 `AMZS-DETAIL-PROMO`（Detail Page 公告原文，与价格、库存同一句禁令）：
// `do not include … promotional language such as "sale" or "free shipping"`。
// 数字出处：`node scripts/claim-recall-probe.mjs`，改前平台层 1/9、改后 7/9。
import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent, PROMO_LANGUAGE_PATTERN } from "../server/domain.mjs";
import { rulePack } from "../server/store.mjs";

const bullet = (text) => ({
  title: "Cotton canvas tote bag",
  item_highlights: "",
  bullet_points: [{ id: "b1", text }],
  description: "",
});
const issuesOf = (text) =>
  reviewContent({ content: bullet(text), profile: null, rulePack, marketplace: "US" }).issues;

test("Detail Page 公告里的促销语，本地层要能拦住", () => {
  for (const text of [
    "On sale now for a limited time",
    "Buy 2 get 1 free this week",
    "Best deal of the season",
    "Save 20% off today",
    "Amazon best seller in tote bags",
    "Free shipping on orders over 50",
  ]) {
    const hit = issuesOf(text).find((issue) => issue.rule_id === "AMZ-04");
    assert.ok(hit, `${text} 应当按 AMZ-04 报出来`);
  }
});

test("导流句（visit our store / shop now）也算这一类", () => {
  for (const text of ["Visit our store for more colors", "Shop now and get yours"]) {
    assert.ok(
      issuesOf(text).some((issue) => issue.rule_id === "AMZ-04"),
      text,
    );
  }
});

test("正常卖点不许瞎报：gift bag / perfect for / best 单用都是真卖家在写的", () => {
  // 20 条真实在售文案里 gift 命中 14/20、perfect 8/20 —— 全是正常卖点。
  for (const text of [
    "Perfect for carrying groceries and other products.",
    "Can be used as shopping bag, gift bag, grocery bag and more.",
    "The best everyday tote for commuters.",
    "Hand wash with cold water.",
  ]) {
    assert.equal(
      issuesOf(text).filter((issue) => issue.rule_id === "AMZ-04").length,
      0,
      text,
    );
  }
});

test("促销语与价格是同一规则下的两种原因，不能共用一句话", () => {
  const promo = issuesOf("On sale now for a limited time").find((x) => x.rule_id === "AMZ-04");
  const price = issuesOf("Price: $19.99 for one bag").find((x) => x.rule_id === "AMZ-04");
  assert.ok(promo && price);
  assert.notEqual(promo.reason, price.reason);
  // 证据要落在短语上，不能把整句当证据（报告里要能点到那句话）。
  assert.equal(promo.original.toLowerCase(), "on sale");
  assert.ok(promo.original.length < "On sale now for a limited time".length);
});

test("引用的来源里有那条公告帖，不是只有 G200390640", () => {
  const hit = issuesOf("Amazon best seller in tote bags").find((x) => x.rule_id === "AMZ-04");
  assert.ok(hit);
  assert.ok(hit.source_ids.includes("AMZS-DETAIL-PROMO"), JSON.stringify(hit.source_ids));
  assert.ok(rulePack.sources.some((source) => source.source_id === "AMZS-DETAIL-PROMO"));
});

test("规则包的候选清单要跟实现一致：写着促销语，就得真查得到", () => {
  const rule = rulePack.rules.find((x) => x.rule_id === "AMZ-04");
  assert.ok(rule.constraint.candidates.includes("promotional_language"));
  assert.ok(PROMO_LANGUAGE_PATTERN.test("limited time offer"));
});
