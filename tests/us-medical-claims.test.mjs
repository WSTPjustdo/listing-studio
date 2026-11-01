// 医疗、健康与抗菌宣称（`US-04`）。
//
// 以前引擎对这类词**零覆盖**：中国纺织品文案里「抗菌 / 防霉 / 除螨 / 缓解酸痛」是常规卖点，
// 而在美国它们属于需要可依据科学证据的客观宣称（`FTCS-AD-SUBSTANTIATION`）。
// 审核侧一个字不查的后果是：商家自己写了这类词，报告会说"没问题"。
//
// 这条规则的难点在**不收误报**：裸 `treat` / `reduce` / `protect` 在正常卖点里到处都是
// （`treat yourself`、`reduce waste`、`protect from scratches`），所以动词一支必须挂到
// 身体或病菌对象才算。下面第二、三组用例就是钉这件事的。
import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent, MEDICAL_CLAIM_PATTERN } from "../server/domain.mjs";
import { rulePack } from "../server/store.mjs";

const bullet = (text) => ({
  title: "Cotton canvas tote bag",
  item_highlights: "",
  bullet_points: [{ id: "b1", text }],
  description: "",
});
const issuesOf = (text) =>
  reviewContent({ content: bullet(text), profile: null, rulePack, marketplace: "US" }).issues;
const medicalHit = (text) => issuesOf(text).find((issue) => issue.rule_id === "US-04");

test("规则包里登记了 US-04，且来源能解析", () => {
  const rule = rulePack.rules.find((x) => x.rule_id === "US-04");
  assert.ok(rule, "US-04 必须写在 amazon-focus/rules.json 里");
  assert.equal(rule.category, "target_country_claims_review");
  assert.equal(rule.severity_on_failure, "needs_review");
  const known = new Set(rulePack.sources.map((s) => s.source_id));
  for (const id of rule.source_ids) assert.ok(known.has(id), `来源 ${id} 不在来源目录里`);
});

test("抗菌、防霉类成品词要能拦住", () => {
  for (const text of [
    "Antibacterial lining keeps the bag fresh",
    "Anti-microbial finish resists mildew",
    "Treated with antifungal coating",
    "Hypoallergenic cotton for sensitive skin",
    "Clinically proven to reduce odor",
    "Made from medical grade canvas",
    "Dermatologist recommended fabric",
  ])
    assert.ok(medicalHit(text), `${text} 应当按 US-04 报出来`);
});

test("动词指向身体或病菌时要能拦住", () => {
  for (const text of [
    "Kills 99% of bacteria on contact",
    "Helps relieve back pain on long commutes",
    "Soothes soreness after a day out",
    "Prevents mold and mildew in humid weather",
    "Fights germs between washes",
  ])
    assert.ok(medicalHit(text), `${text} 应当按 US-04 报出来`);
});

test("正常卖点不能误报（treat yourself / reduce waste / protect from scratches）", () => {
  for (const text of [
    "Treat yourself to a new tote this season",
    "Reduce waste with a reusable bag",
    "Protects your phone from scratches",
    "Water resistant and easy to clean",
    "Holds up to 15 kg of groceries",
    "Machine washable, dries fast",
    "Perfect gift bag for friends",
  ])
    assert.equal(medicalHit(text), undefined, `${text} 不该报 US-04`);
});

test("否定句不算宣称", () => {
  for (const text of [
    "Not antibacterial, just plain cotton",
    "We do not use antimicrobial treatments",
    "Without any medical claims",
  ])
    assert.equal(medicalHit(text), undefined, `${text} 是否定，不该报 US-04`);
});

test("同一条句子同时踩防水和抗菌时，两条都要报", () => {
  const issues = issuesOf("Waterproof and antibacterial canvas for rainy days");
  const ids = issues.map((issue) => issue.rule_id);
  assert.ok(ids.includes("US-03"), "防水属于 US-03");
  assert.ok(ids.includes("US-04"), "抗菌属于 US-04，不该被合并掉");
});

test("正则本身：`99%` 这类数字不能把动词和宾语断开", () => {
  assert.ok(MEDICAL_CLAIM_PATTERN.test("Kills 99.9% of germs in 24 hours"));
});

/**
 * 下面两组是第 16 轮补的。数字出处：`node scripts/claim-recall-probe.mjs` 第三栏，
 * 改前 US-04 召回 **12/28**，其中「名词形式」16 句**全漏**；改后 28/28、不该收的 0/7。
 *
 * 为什么上面那几个用例没抓到：它们全是**成品词**（antibacterial）和**动词+宾语**（kills germs）。
 * 而中国供应商最常见的英文写法是名词式的 `-proof / -resistant / -free`：
 * `mildew proof`、`dust mite resistant`、`germ-free`、`pain relief`。
 * 单测只覆盖了自己想得到的那两种，所以一直是绿的。
 */
test("名词式作用宣称要能拦住（-proof / -resistant / -free / anti- 前缀）", () => {
  for (const text of [
    "Mildew proof coating for humid climates",
    "Mold-resistant inner layer",
    "Dust mite resistant cotton",
    "Anti-mite treated fabric",
    "Germ-free storage for gym clothes",
    "Anti-odor technology built into the fabric",
    "Pain relief for sore shoulders after a long day",
    "Anti-inflammatory bamboo charcoal lining",
  ])
    assert.ok(medicalHit(text), `${text} 应当按 US-04 报出来`);
});

test("医疗场景与过敏类写法要能拦住（sterile / sanitized / allergy tested / FDA registered）", () => {
  for (const text of [
    "Sterile packaging for hospitals",
    "Sanitized lining after every wash",
    "Allergy tested and safe for kids",
    "Non-allergenic cotton lining",
    "Medical use approved fabric",
    "FDA registered facility",
  ])
    assert.ok(medicalHit(text), `${text} 应当按 US-04 报出来`);
});

/**
 * 反方向同样是守卫：这几句**看着沾医疗，其实不归这条管**。
 * 它们进 must 会把成绩做低，进召回则会让商家收到"你这句抗菌要证据"的冤枉提示。
 * `odor-free` 是气味状态（性能宣称），`skin-friendly` 是舒适度，`anti-fatigue` 是人体工学，
 * `food safe` 是食品接触——四条各归各的，本包一律不做（写进 rules.json 的 note）。
 */
test("不归这条管的写法一句都不许报（气味状态 / 舒适度 / 防静电 / 食品接触）", () => {
  for (const text of [
    "Odor-free lining keeps clothes fresh",
    "Skin-friendly soft cotton",
    "Anti-fatigue shoulder strap",
    "Food safe for packed lunches",
    "Anti-static lining",
    "Moisture-wicking mesh pocket",
    "Breathable cotton keeps you cool",
  ])
    assert.equal(medicalHit(text), undefined, `${text} 不归 US-04，不该报`);
});

/**
 * `strain` 这一条是**故意收窄**的：只认「肩/背/颈/关节/肌肉 + 劳损」。
 * 裸 `strain` 会打到 `reduces strain on the seams`——那是耐用性宣称，报成医疗宣称等于教商家改错地方。
 */
test("耐用性语境里的 strain 不能当成医疗宣称", () => {
  for (const text of [
    "Reinforced stitching reduces strain on the seams",
    "Wide straps reduce strain on the fabric",
  ])
    assert.equal(medicalHit(text), undefined, `${text} 是耐用性宣称，不该报 US-04`);
});

/**
 * 分流：命中之后商家要做的事**不是同一件事**。
 *
 * 第 16 轮之前 28 条命中共用一句话：「补充对应检测报告或临床依据」。
 * 对「抗菌」是对的，对「FDA 注册」和「缓解肩背酸痛」都是错的动作——
 * 前者不是证据问题（注册本来就不表示批准），后者补报告也留不住。
 * 数字出处：`node scripts/claim-recall-probe.mjs`，去重后 1 种 → **5 种**。
 */
test("五类宣称给五套不同的下一步，且各自说对动作", () => {
  const suggestion = (text) => medicalHit(text)?.suggestion || "";
  const samples = {
    微生物: "Mildew proof coating for humid climates",
    疗效: "Pain relief for sore shoulders after a long day",
    过敏: "Hypoallergenic cotton for sensitive skin",
    监管: "FDA registered facility",
    背书: "Dermatologist recommended fabric",
  };
  for (const [label, text] of Object.entries(samples))
    assert.ok(suggestion(text), `${label} 类应当给出下一步`);

  const distinct = new Set(Object.values(samples).map(suggestion));
  assert.equal(distinct.size, 5, "五类必须给五套不同的下一步，合并成一句话就退回改前了");

  // 每类的动作要对得上，不能只是换了措辞：
  assert.match(suggestion(samples.微生物), /检测报告/, "抗菌类要的是检测报告");
  assert.match(suggestion(samples.疗效), /删/, "疗效类只能删，不是补材料");
  assert.match(suggestion(samples.过敏), /报告|测试/, "过敏类要的是人体测试");
  assert.match(suggestion(samples.监管), /不代表 FDA 批准/, "监管类要说清注册≠批准");
  assert.match(suggestion(samples.背书), /谁做的|出处|留档/, "背书类要出处");
});
