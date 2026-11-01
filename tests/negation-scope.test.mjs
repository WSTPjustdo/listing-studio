// 否定判断的作用域（第 19 轮）。
//
// 老规矩是「命中位置前 110 字符里出现 no/not/never/without 就整句跳过」。
// 于是 `No plastic, antibacterial lining` 里的抗菌宣称被一个只管塑料的 no 吃掉了；
// `holds up to 80 lbs of items without breaking a sweat` 里的承重宣称也被后面的 without 牵连。
// 这一步改成「否定词直接管着这个宣称才算否定」，用下面 6 条钉住方向：
// 该吞的还吞，不该吞的别吞。
import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent } from "../server/domain.mjs";
import { rulePack } from "../server/store.mjs";

const review = (bullets, title = "Cotton Canvas Tote Bag") =>
  reviewContent({
    content: { title, item_highlights: "", bullet_points: bullets.map((text, i) => ({ id: `b${i + 1}`, text })), description: "" },
    profile: null,
    rulePack,
  }).issues.map((x) => x.rule_id);

test("否定词直接管着宣称时仍然吞掉：not waterproof 不报 US-03", () => {
  assert.equal(review(["This bag is not waterproof."]).includes("US-03"), false);
});

test("否定词管的是别的东西时不再牵连：No plastic, antibacterial lining 要报 US-04", () => {
  assert.equal(review(["No plastic, antibacterial lining keeps the bag fresh."]).includes("US-04"), true);
});

test("逗号不是边界：Not waterproof, so bring a cover 仍然算否定", () => {
  // 逗号后面的内容也在否定的作用域里——把逗号当硬边界会立刻在这里误报。
  assert.equal(review(["Not waterproof, so please bring a cover."]).includes("US-03"), false);
});

test("not only … but also 是肯定句：不该被当否定吞掉", () => {
  assert.equal(review(["Not only waterproof but also easy to clean."]).includes("US-03"), true);
});

test("跨句不牵连：上一句的否定不影响下一句的宣称", () => {
  assert.equal(review(["Bags are not made of polyester. This tote is waterproof."]).includes("US-03"), true);
});

test("副词夹在中间仍算否定：not really waterproof", () => {
  assert.equal(review(["This bag is not really waterproof."]).includes("US-03"), false);
});
