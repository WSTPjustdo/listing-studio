import { z } from "zod";

/**
 * GPSR 第 19 条里「制造商」与「欧盟责任人」这两块的结构化档案字段。
 *
 * 之前这两项只能塞进 `additional_facts`（界面上叫「补充事实」）—— 能用，但它是自由文本：
 * 填了「Beispiel GmbH」也算有记录，看不出邮编、门牌号、电子地址到底缺哪一项。
 * 这里把两方各自拆成六个字段，就是为了让「四要素齐不齐」这件事能被程序逐项说清，
 * 而不是把一段话丢给人自己对。
 *
 * 边界（写死在代码里，别在别处放宽）：
 *   - 本模块只判「档案里这一项填了没有、长得像不像」。它**不判**地址是否真实、
 *     公司是否存在、电子地址是否可达 —— 那要人核。
 *   - 所以 GPSR 这条规则永远不给 pass，只到 not_checked（见 domain.mjs 的清单）。
 *   - 国家在不在欧盟：只认得出「明确的欧盟 27 国」和几个常见非欧盟国家，
 *     其余一律返回 null（认不出），由调用方按「需要填」保守处理，不猜。
 */

const text = (max) => z.string().trim().max(max);

export const partySchema = z
  .object({
    name: text(200),
    street: text(200),
    postal_code: text(20),
    city: text(120),
    country: text(120),
    electronic_address: text(300),
  })
  .strict();

/** 字段顺序就是界面与报告的展示顺序，别随便调。 */
export const PARTY_FIELDS = [
  ["name", "名称"],
  ["street", "街道与门牌"],
  ["postal_code", "邮编"],
  ["city", "城市"],
  ["country", "国家"],
  ["electronic_address", "电子地址"],
];

export const PARTY_LABELS = {
  manufacturer: "制造商",
  eu_responsible: "欧盟责任人",
};

/** 把任意输入收成「六个字符串」或 null（全空即视为没填，不留空对象进档案）。 */
export function normalizeParty(input) {
  if (input == null) return null;
  const parsed = partySchema.parse(input);
  const out = {};
  for (const [key] of PARTY_FIELDS) out[key] = (parsed[key] || "").trim();
  return Object.values(out).some(Boolean) ? out : null;
}

/* 欧盟 27 国。别名只收实际会填进来的写法：代码、德语名、英语名、中文名、常见旧称。 */
const EU = {
  AT: ["österreich", "austria", "奥地利"],
  BE: ["belgien", "belgium", "比利时"],
  BG: ["bulgarien", "bulgaria", "保加利亚"],
  HR: ["kroatien", "croatia", "克罗地亚"],
  CY: ["zypern", "cyprus", "塞浦路斯"],
  CZ: ["tschechien", "czech republic", "czechia", "捷克"],
  DK: ["dänemark", "daenemark", "denmark", "丹麦"],
  EE: ["estland", "estonia", "爱沙尼亚"],
  FI: ["finnland", "finland", "芬兰"],
  FR: ["frankreich", "france", "法国"],
  DE: ["deutschland", "germany", "德国"],
  GR: ["griechenland", "greece", "希腊"],
  HU: ["ungarn", "hungary", "匈牙利"],
  IE: ["irland", "ireland", "爱尔兰"],
  IT: ["italien", "italy", "意大利"],
  LV: ["lettland", "latvia", "拉脱维亚"],
  LT: ["litauen", "lithuania", "立陶宛"],
  LU: ["luxemburg", "luxembourg", "卢森堡"],
  MT: ["malta", "马耳他"],
  NL: ["niederlande", "netherlands", "holland", "荷兰"],
  PL: ["polen", "poland", "波兰"],
  PT: ["portugal", "葡萄牙"],
  RO: ["rumänien", "rumaenien", "romania", "罗马尼亚"],
  SK: ["slowakei", "slovakia", "斯洛伐克"],
  SI: ["slowenien", "slovenia", "斯洛文尼亚"],
  ES: ["spanien", "spain", "西班牙"],
  SE: ["schweden", "sweden", "瑞典"],
};

/*
 * 只收「明确不在欧盟」的常见写法。瑞士、挪威、冰岛、列支敦士登**故意不收**：
 * 瑞士不在欧盟但在欧洲单一市场边上，挪威/冰岛/列支敦士登是 EEA 成员，
 * GPSR 在 EEA 怎么落地本项目没核过 —— 认不出就返回 null，别替商家拍板。
 */
const NON_EU = [
  ["cn", "china", "volksrepublik china", "prc", "中国"],
  ["us", "usa", "united states", "united states of america", "vereinigte staaten", "美国"],
  ["gb", "uk", "united kingdom", "großbritannien", "grossbritannien", "england", "英国"],
  ["jp", "japan", "日本"],
  ["kr", "south korea", "südkorea", "suedkorea", "韩国", "韓國"],
  ["in", "india", "indien", "印度"],
  ["vn", "vietnam", "viet nam", "越南"],
  ["tr", "türkei", "tuerkei", "turkey", "土耳其"],
  ["tw", "taiwan", "中国台湾"],
  ["hk", "hong kong", "中国香港"],
];

const fold = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

/** true = 欧盟内，false = 明确的非欧盟，null = 认不出（别猜）。 */
export function isEuCountry(value) {
  const key = fold(value);
  if (!key) return null;
  for (const [code, aliases] of Object.entries(EU))
    if (key === fold(code) || aliases.some((alias) => fold(alias) === key)) return true;
  for (const aliases of NON_EU)
    if (aliases.some((alias) => fold(alias) === key)) return false;
  return null;
}

const EMAIL = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/u;
const URL_LIKE = /^https?:\/\/[^\s]+$/iu;

/** GPSR 的「电子地址」是邮箱或网址；电话不算。 */
const isElectronicAddress = (value) =>
  EMAIL.test(value) || URL_LIKE.test(value);

/**
 * 逐项判「填了没有、长得像不像」。
 *
 * 只返回问题项（missing），不看整体；调用方拿它拼人话。
 * 每一项都带 field，界面可以按 field 定位到具体输入框。
 */
export function checkParty(party) {
  const value = party || {};
  const missing = [];
  const has = (key) => Boolean(String(value[key] || "").trim());

  if (!has("name"))
    missing.push({
      field: "name",
      label: "名称",
      hint: "写法定名称（公司名或个体经营者姓名），不要只写品牌",
    });
  if (!has("street"))
    missing.push({
      field: "street",
      label: "街道与门牌",
      hint: "GPSR 要的是能寄信的邮政地址，只写城市不算",
    });
  else if (!/\d/.test(String(value.street)))
    missing.push({
      field: "street_number",
      label: "门牌号",
      hint: "街道名后面补门牌号（例如 Musterstraße 1）",
    });
  if (!has("postal_code"))
    missing.push({ field: "postal_code", label: "邮编", hint: "缺邮编，地址不完整" });
  else if (!/\d/.test(String(value.postal_code)))
    missing.push({
      field: "postal_code",
      label: "邮编",
      hint: "邮编里没有数字，看起来不像邮编",
    });
  // Germany's format must not be imposed on a responsible person elsewhere in
  // the EU. Other countries keep the generic presence/shape check above.
  else if (["de", ...EU.DE].some(alias => fold(alias) === fold(value.country)) && !/^\d{5}$/.test(String(value.postal_code).trim()))
    missing.push({
      field: "postal_code",
      label: "邮编位数",
      hint: "德国的邮编是 5 位数字（如 10115）",
    });
  if (!has("city"))
    missing.push({ field: "city", label: "城市", hint: "缺城市，地址不完整" });
  if (!has("country"))
    missing.push({ field: "country", label: "国家", hint: "写国家名或两位国家代码" });
  if (!has("electronic_address"))
    missing.push({
      field: "electronic_address",
      label: "电子地址",
      hint: "GPSR 要电子联系方式：邮箱或网址；电话不算电子地址",
    });
  else if (!isElectronicAddress(String(value.electronic_address).trim()))
    missing.push({
      field: "electronic_address",
      label: "电子地址",
      hint: "看起来既不是邮箱也不是网址（电话不算电子地址）",
    });
  return { missing, complete: missing.length === 0 };
}

/** 给报告用的一句话摘要：`6 项齐全` / `已填 4 / 6 项，缺：邮编、电子地址`。 */
export function summarizeParty(party) {
  if (!party) return "没填";
  const { missing, complete } = checkParty(party);
  if (complete) return "6 项齐全（名称 / 街道门牌 / 邮编 / 城市 / 国家 / 电子地址）";
  const filled = PARTY_FIELDS.filter(([key]) =>
    Boolean(String(party[key] || "").trim()),
  ).length;
  const labels = [...new Set(missing.map((item) => item.label))];
  return `已填 ${filled} / ${PARTY_FIELDS.length} 项，缺：${labels.join("、")}`;
}
