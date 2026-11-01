import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IMPLEMENTED_RULE_IDS,
  PARTIALLY_IMPLEMENTED_RULE_IDS,
} from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";

/**
 * `qa/de-vs-us-rules.html` 是评委问「换个国家你怎么保证还有依据」时递上去的那张纸。
 *
 * 这张纸最容易撒的谎是「判定方式」那一栏：规则包一升级、引擎一接新检查，
 * 纸上还写着老的「候选检测 + 复核」或「字段比对」，看着没问题，其实是过期的说法。
 * 所以这里不检查措辞好不好，只把每一档对着引擎的三张名单核一遍：
 *   IMPLEMENTED_RULE_IDS        → 程序能判完
 *   PARTIALLY_IMPLEMENTED_…     → 本地判一半（判定性那半跑，判不干净不给通过）
 *   两张名单都没有              → 只列清单（本地没有可判依据）
 */

const DEV = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(resolve(DEV, "qa/de-vs-us-rules.html"), "utf8");
const de = rulePackFor("DE");
const rows = page.split("\n").filter((line) => line.includes('<td class="id">'));
const rowFor = (ruleId) =>
  rows.find((line) => line.includes(`<td class="id">${ruleId}</td>`)) || null;

const deRules = de.rules.filter((rule) => rule.rule_id.startsWith("DE-"));

test("德国站自有规则一条不落，都在这一页上", () => {
  for (const rule of deRules) assert.ok(rowFor(rule.rule_id), `${rule.rule_id} 没出现在对照页上`);
  assert.equal(deRules.length, 8);
});

test("判定方式那一栏与引擎的名单一致（三档，写错就红）", () => {
  for (const rule of deRules) {
    const row = rowFor(rule.rule_id);
    if (IMPLEMENTED_RULE_IDS.has(rule.rule_id)) {
      assert.equal(/只列清单|本地判一半/.test(row), false, `${rule.rule_id} 已能判完，纸上却写着只判一半`);
      assert.match(row, /程序检查|结构比对|类型化比对/, `${rule.rule_id} 是本地可判，纸上却没写清是用程序判`);
    } else if (PARTIALLY_IMPLEMENTED_RULE_IDS.has(rule.rule_id)) {
      assert.match(row, /本地判一半/, `${rule.rule_id} 只实现了确定性一半，纸上却没说`);
      assert.equal(/只列清单/.test(row), false, `${rule.rule_id} 已经有本地检查了，不该还写「只列清单」`);
    } else {
      assert.match(row, /只列清单/, `${rule.rule_id} 本地判不了，纸上不该写成能判`);
    }
  }
});

test("档位说法在页面上有定义，别让读的人自己猜", () => {
  assert.match(page, /<b>本地判一半<\/b>——/, "页面缺「本地判一半」这一档的解释");
  assert.match(page, /<b>只列清单<\/b>——/, "页面缺「只列清单」这一档的解释");
});

test("页脚那句「2 条判完 / 5 条判一半 / 1 条只列清单」是现算的，不是抄的", () => {
  const implemented = deRules.filter((rule) => IMPLEMENTED_RULE_IDS.has(rule.rule_id)).length;
  const partial = deRules.filter((rule) => PARTIALLY_IMPLEMENTED_RULE_IDS.has(rule.rule_id)).length;
  const checklist = deRules.length - implemented - partial;
  assert.equal(implemented, 2);
  assert.equal(partial, 5);
  assert.equal(checklist, 1);
  assert.ok(
    page.includes(`2 条程序判完、${partial} 条只判一半、${checklist} 条只列清单`),
    "页脚的统计与引擎名单对不上，页面过期了",
  );
});

test("页面自己声明了它是被测试核过的（不是随手写的纸）", () => {
  assert.match(page, /tests\/de-vs-us-page\.test\.mjs/);
});
