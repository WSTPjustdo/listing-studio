import test from "node:test";
import assert from "node:assert/strict";
import { editProfile, reviewContent } from "../server/domain.mjs";
import { rulePackFor } from "../server/store.mjs";
import { gpsrPartiesSection } from "../server/listing-report.mjs";
import {
  checkParty,
  isEuCountry,
  normalizeParty,
  partySchema,
  summarizeParty,
} from "../server/gpsr-parties.mjs";

/**
 * 第 9 轮：GPSR 四要素从「只能塞进补充事实」升级成「有专门字段 + 字段级校验」。
 *
 * 要证明三件事：
 *   1. 六个子字段能存下来，填一半也能存（商家常常先拿到公司名、过两天才拿到门牌号）；
 *   2. 缺哪一项能逐项点出来（不是笼统说「资料不全」）；
 *   3. 「欧盟责任人」这一项要看制造商国家：欧盟内 → 不适用；欧盟外 → 必须有；认不出 → 别猜。
 *
 * 不允许出现的东西：给 pass。字段填了不等于报价页面上展示了，这条永远只到 not_checked。
 */

const de = rulePackFor("DE");
const gpsrCheck = (profile) =>
  reviewContent({
    content: {
      title: "Baumwolltasche 38 x 42 cm",
      item_highlights: "",
      bullet_points: [],
      description: "100 % Baumwolle.",
    },
    profile,
    rulePack: de,
    marketplace: "DE",
  }).checks.find((check) => check.rule_id === "DE-GPSR-19");

const completeManufacturer = {
  name: "Beispiel GmbH",
  street: "Musterstraße 1",
  postal_code: "10115",
  city: "Berlin",
  country: "Deutschland",
  electronic_address: "service@beispiel.de",
};

const profileWithParties = (manufacturer, euResponsible = null) => ({
  product_id: "P-1",
  revision: 1,
  name_zh: "棉布袋",
  additional_facts: [],
  manufacturer: manufacturer
    ? { value: manufacturer, status: "merchant_confirmed", source_ids: [] }
    : { value: null, status: "unknown", source_ids: [] },
  eu_responsible: euResponsible
    ? { value: euResponsible, status: "merchant_confirmed", source_ids: [] }
    : { value: null, status: "unknown", source_ids: [] },
});

test("六个字段全空按「没填」存成 null，不留空对象进档案", () => {
  assert.equal(
    normalizeParty({ name: "", street: " ", postal_code: "", city: "", country: "", electronic_address: "" }),
    null,
  );
  assert.equal(normalizeParty(null), null);
  assert.equal(normalizeParty(undefined), null);
});

test("字段会去掉首尾空格；不认识的子字段报错，不能悄悄吞掉", () => {
  const saved = normalizeParty({ ...completeManufacturer, name: "  Beispiel GmbH  " });
  assert.equal(saved.name, "Beispiel GmbH");
  assert.equal(saved.city, "Berlin");
  assert.throws(() => partySchema.parse({ ...completeManufacturer, phone: "030 123456" }));
});

test("国家在不在欧盟：欧盟 27 国认得出，常见非欧盟认得出，剩下的不许猜", () => {
  for (const value of ["DE", "de", "Deutschland", "Germany", "德国"])
    assert.equal(isEuCountry(value), true, value);
  for (const value of ["CN", "China", "中国", "US", "United States", "美国"])
    assert.equal(isEuCountry(value), false, value);
  // 瑞士不在欧盟、挪威是 EEA 成员 —— GPSR 在这两地怎么落地本项目没核过，所以一律 null。
  for (const value of ["Schweiz", "Norwegen", "Atlantis", ""])
    assert.equal(isEuCountry(value), null, value);
});

test("缺哪一项逐项点：没门牌号、没电子地址、德国邮编不是 5 位，各报各的", () => {
  const partial = checkParty({
    name: "Beispiel GmbH",
    street: "Musterstraße",
    postal_code: "1011",
    city: "Berlin",
    country: "DE",
    electronic_address: "030 123456",
  });
  const fields = partial.missing.map((item) => item.field);
  assert.ok(fields.includes("street_number"), "街道没门牌号要单独点出来");
  assert.ok(fields.includes("postal_code"), "德国邮编必须 5 位");
  assert.ok(fields.includes("electronic_address"), "电话号码不是电子地址");
  assert.equal(partial.complete, false);
  assert.match(summarizeParty({ ...completeManufacturer, street: "Musterstraße" }), /缺：门牌号/);
});

test("六项齐全时摘要说「6 项齐全」，不说「已填 6 / 6」那种半句", () => {
  assert.match(summarizeParty(completeManufacturer), /^6 项齐全/);
  assert.equal(checkParty(completeManufacturer).complete, true);
});

test("档案能存制造商：状态是商家确认，revision 加一，填一半也允许存", () => {
  const base = profileWithParties(null);
  const saved = editProfile(base, {
    name_zh: base.name_zh,
    material: "",
    width: null,
    height: null,
    fabric_weight_gsm: null,
    capacity_l: null,
    handle_length_cm: null,
    retail_pack_count: null,
    brand: "",
    color: "",
    manufacturer: { ...completeManufacturer, postal_code: "" },
  });
  assert.equal(saved.revision, base.revision + 1);
  assert.equal(saved.manufacturer.status, "merchant_confirmed");
  assert.equal(saved.manufacturer.value.name, "Beispiel GmbH");
  assert.equal(saved.manufacturer.value.postal_code, "", "填一半照样存下来，缺项由清单点");
  assert.deepEqual(saved.eu_responsible, base.eu_responsible, "没传的字段不许被顺手清空/新建");
});

test("不传这两个字段＝本次不动；传 null＝清空", () => {
  const base = profileWithParties(completeManufacturer);
  const untouched = editProfile(base, {
    name_zh: base.name_zh,
    material: "",
    width: null,
    height: null,
    fabric_weight_gsm: null,
    capacity_l: null,
    handle_length_cm: null,
    retail_pack_count: null,
    brand: "",
    color: "",
  });
  assert.equal(untouched.manufacturer.value.name, "Beispiel GmbH");
  const cleared = editProfile(base, {
    name_zh: base.name_zh,
    material: "",
    width: null,
    height: null,
    fabric_weight_gsm: null,
    capacity_l: null,
    handle_length_cm: null,
    retail_pack_count: null,
    brand: "",
    color: "",
    manufacturer: null,
  });
  assert.equal(cleared.manufacturer.value, null);
  assert.equal(cleared.manufacturer.status, "unknown");
});

test("制造商在欧盟内：欧盟责任人这一项写「不适用」，不是「没填」", () => {
  const check = gpsrCheck(profileWithParties(completeManufacturer));
  assert.match(check.reason, /① 制造商名称 \+ 邮政地址 \+ 电子地址：6 项齐全/);
  assert.match(check.reason, /② .*不适用 —— 制造商在欧盟内（Deutschland）/);
  assert.equal(/② .*没填/.test(check.reason), false, "欧盟内的制造商不该被要求填欧盟责任人");
});

test("制造商在中国：欧盟责任人必须有，没填就点出来", () => {
  const check = gpsrCheck(profileWithParties({ ...completeManufacturer, country: "China" }));
  assert.match(check.reason, /② .*没填 —— 制造商国家是「China」，不在欧盟，这一项必须有/);
});

test("制造商在中国且欧盟责任人填齐：这一项改成报齐全", () => {
  const check = gpsrCheck(
    profileWithParties(
      { ...completeManufacturer, country: "CN", postal_code: "518000", city: "Shenzhen" },
      { ...completeManufacturer, name: "Beispiel EU GmbH", postal_code: "20095", city: "Hamburg" },
    ),
  );
  assert.match(check.reason, /② .*6 项齐全/);
  assert.equal(/不在欧盟，这一项必须有/.test(check.reason), false);
});

test("制造商国家认不出：说「认不出、先填上更稳」，不替商家判定在不在欧盟", () => {
  const check = gpsrCheck(profileWithParties({ ...completeManufacturer, country: "Schweiz" }));
  assert.match(check.reason, /② .*认不出在不在欧盟，先填上更稳/);
});

test("专门字段填了也不给 pass：页面是否展示本地判不了", () => {
  const check = gpsrCheck(
    profileWithParties(completeManufacturer, completeManufacturer),
  );
  assert.equal(check.state, "not_checked");
  assert.equal(check.method, "checklist_only");
});

test("专门字段填了以后，不再说「生成侧写不出来」", () => {
  const check = gpsrCheck(profileWithParties(completeManufacturer));
  assert.equal(/生成侧写不出来/.test(check.reason), false);
  assert.match(check.reason, /专门字段已经填了/);
});

test("专门字段空着但补充事实里有：仍然点出「补充事实」那几条（两条通道都算数）", () => {
  const profile = profileWithParties(null);
  profile.additional_facts = [
    { id: "AF-1", label: "Hersteller", value: "Beispiel GmbH, Musterstraße 1, 10115 Berlin", status: "merchant_confirmed", source_ids: [] },
  ];
  const check = gpsrCheck(profile);
  assert.match(check.reason, /「补充事实」里有 1 条相关记录（Hersteller）/);
  assert.match(check.reason, /① .*档案里没填/, "专门字段那一段照样要说没填");
});

test("美国站不受影响：美国包里没有 GPSR 这条，不会凭空多出一项", () => {
  const us = rulePackFor("US");
  const result = reviewContent({
    content: { title: "Cotton tote bag", item_highlights: "", bullet_points: [], description: "" },
    profile: profileWithParties(completeManufacturer),
    rulePack: us,
    marketplace: "US",
  });
  assert.equal(
    result.checks.some((check) => check.rule_id === "DE-GPSR-19"),
    false,
  );
});

test("导出报告单列一屏：责任方地址 + 齐全度 + 「仍需人工确认」的边界", () => {
  const html = gpsrPartiesSection({
    product_snapshot: {
      manufacturer: { value: { ...completeManufacturer, electronic_address: "" }, status: "merchant_confirmed", source_ids: [] },
      eu_responsible: { value: null, status: "unknown", source_ids: [] },
    },
  });
  assert.match(html, /Musterstraße 1/);
  assert.match(html, /10115 Berlin/);
  assert.match(html, /已填 5 \/ 6 项，缺：电子地址/);
  assert.match(html, /仍需人工确认/);
  assert.match(html, /禁止出现邮箱/);
});

test("责任方没填就不出这一段（别在纸上占一块空白）", () => {
  assert.equal(gpsrPartiesSection({ product_snapshot: {} }), "");
  assert.equal(gpsrPartiesSection({}), "");
});
