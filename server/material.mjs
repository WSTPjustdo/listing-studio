/**
 * 材质成分：把档案里的自由文本变成**有序成分表**，再拿文案里的材质说法去对照。
 *
 * 为什么要有这一层：
 *   档案的 `material` 是一个自由文本字段（`100% cotton`、`75% Polyester, 25% Cotton`、
 *   `Cotton canvas`），而原来的做法是"文案里出现了 cotton 这个词就算对上"。
 *   于是 `polyester-cotton blend` 这种句子会被读成"两个词都出现过 → 都对上了"，
 *   可它说的其实是**混纺**——和档案的 `100% cotton` 不能同时成立。
 *   这是典型的"看起来很正常"的错结论：报告上写着"材质已对照"，实际是两个互相矛盾的声明。
 *
 * 这一层只做三件事，都不碰 IO、不碰规则包：
 *   1. `parseComposition` 把一句话/一个字段解析成成分表（纤维 + 百分比 + 是否混纺）；
 *   2. `compareFiber` 回答"这一处材质说法和档案能不能同时成立"，并给出**带具体数字**的理由；
 *   3. `claimContext` 回答"这处说法说的是袋身、内衬，还是在打比方"——
 *      内衬/缝线用涤纶不等于袋身是涤纶，把它当"材质不一致"是冤枉商家。
 *
 * 刻意不做的：不猜纤维（`canvas` 是织法不是纤维，`poly-cotton` 里的 poly 也不猜成涤纶），
 * 不把没写百分比的档案当成写了 100%（那是替商家补事实）。
 */

/** 认识的纤维。**加一种就是加一片误报面积**：每一种都要先有真实样本证明它值得认。 */
const FIBERS = ["cotton", "polyester", "nylon", "linen"];
const FIBER_LABEL = { cotton: "棉", polyester: "涤纶", nylon: "尼龙", linen: "亚麻" };

/**
 * 同一个纤维的德语写法。**只收整词、不收新纤维、不收复合词。**
 *
 * 为什么非要有：德国站按 (EU) 1007/2011 第 16 条，纤维成分必须写成
 * "100 % Baumwolle" 这种成员国语言的形式。这一层原来只认英文词，
 * 2026-10-30 真模型跑德语生成 —— 同一句 "100 % Baumwolle" 被读成
 * 「一个没有说明对象的百分比」（EVID-01 needs_review），
 * 又和档案里的 `100% cotton` 判成材质冲突（AMZ-05 blocking）。
 * 一句正确的德语文案凭空多出两条问题，等于把合规写法当成错。
 *
 * 为什么只收整词：德语可以任意拼接（`Baumwolltasche` 是"棉布袋"这个商品名，
 * 不是成分声明）。按词根猜成分就是替商家补事实，跟这一层开头的原则冲突。
 * 所以 `100 % Baumwollgewebe`、`Baumwolltasche` 都不认 —— 认不出只是"没关联"，
 * 不会变成"说错了"。
 */
/*
 * 写法表。每一条"另一个名字"都有原文撑着，不是凭印象加的：
 *
 *   - linen 收 `flachs`：(EU) 1007/2011 附件 I 表 1 第 7 条德文版写的是
 *     「Flachs bzw. Leinen」—— 同一行的两个名字，不是两种纤维。
 *     出处：Amtsblatt der EU L 272/11 (DE), 18.10.2011, S. 11（附件 I 表 1）。
 *     核验 2026-10-31。EUR-Lex 直连仍取不到正文（HTTP 202、0 字节），本条取自
 *     德国法条镜像 PDF（internetrecht-rostock.de），该 PDF 带 OJ 页码，属二手镜像。
 *   - nylon 收 `polyamide`：附件 I 表 2 第 30 条英文版原文是
 *     「polyamide or nylon」—— 两个名字都合法。
 *     出处：legislation.gov.uk 的 (EU) 1007/2011 Annex I（英文版），核验 2026-10-31。
 *   - cotton 收 `coton`、linen 收 `lin`（法语写法）：附件 I 表 1 第 5 行法文版是
 *     「coton (m.) — fibre provenant des graines du cotonnier (Gossypium)」，
 *     第 7 行是「lin (m.) — fibre provenant du liber du lin (Linum usitatissimum)」。
 *     出处：EUR-Lex CELEX 32011R1007 法文版 ANNEXE I Tableau 1（OJ L 272/1 FR），核验 2026-10-31。
 *     为什么必须收：法语是我们第四门语言。`100 % coton` 不认的话，一句**完全合规**的
 *     法语文案会落到「这个百分比没说清指什么」，凭空一条问题。
 *     法语里 polyester / polyamide 与英文同词，不用另加。
 *
 * 德文的 `Polyamid` 这条**故意没加**：附件 I 德文版表 2 第 30 条的原文本轮没取到，
 * 只凭"德语一般这么写"就加，等于替法规规定用词。
 */
const FIBER_SYNONYMS = {
  cotton: ["cotton", "baumwolle", "coton"],
  polyester: ["polyester"],
  nylon: ["nylon", "polyamide"],
  linen: ["linen", "leinen", "flachs", "lin"],
};

/**
 * **两地写法不同**的纤维：德语必须换写法，英文写法在德语文案里只能作补充。
 *
 * 只收这几个（棉、亚麻）—— `polyester`、`nylon` 在德语里就是同一个词，
 * 本地没有东西可判，硬判就是编。认不出只是"没关联"，不会变成"说错了"。
 */
const GERMAN_WORDING = {
  cotton: { english: "cotton", german: "baumwolle", label: "Baumwolle" },
  linen: { english: "linen", german: "leinen", label: "Leinen" },
};
export const germanWordingFor = (fiber) => GERMAN_WORDING[fiber] || null;

/** [写法, 标准纤维名]，长的排前面，免得短词先把长词吃掉。 */
const SYNONYMS = Object.entries(FIBER_SYNONYMS)
  .flatMap(([fiber, words]) => words.map((word) => [word, fiber]))
  .sort((a, b) => b[0].length - a[0].length);

/** 把命中的写法换回标准纤维名；认不出就原样返回（不猜）。 */
const fiberOf = (word) => {
  const hit = SYNONYMS.find(([synonym]) => synonym === String(word).toLowerCase());
  return hit ? hit[1] : String(word).toLowerCase();
};

/**
 * 给别的模块用的同一个换算：原文里认到的纤维写法 → 标准纤维名。
 * 之所以要导出：`evidence.mjs` 原来自己又写了一份 `(cotton|polyester|nylon|linen)`，
 * 于是加一种写法要改两个地方，漏一个就成了「一侧认得、另一侧认不得」——
 * 2026-10-30 德国站那句 `100 % Baumwolle` 就是这么被读成"百分比没说清指什么"的。
 */
export const canonicalFiber = (word) => CHINESE_FIBERS[word] || fiberOf(word);

const FIBER_PATTERN = SYNONYMS.map(([word]) => word).join("|");

export { FIBER_PATTERN, FIBERS };
// 中文资料只收明确、独立的纤维词；“棉布”“石棉”“棉花糖”等不能靠字根推定成分。
// 单独导出，避免把内部中文对照误加进德/法法规用词的扫描表。
export const CHINESE_FIBER_PATTERN = "棉纤维|棉";
const CHINESE_FIBERS = { 棉: "cotton", 棉纤维: "cotton" };
export const fiberLabel = (fiber) => FIBER_LABEL[fiber] || fiber;

/**
 * 百分比里的数字写法。德语、法语用**逗号**当小数点（`99,5 % Baumwolle`），英语用点（`99.5 %`）。
 *
 * 为什么必须认逗号：我们自己在德语、法语的生成指令里就写着「小数用逗号（99,5 %）」。
 * 提示词让模型这么写，解析器却只认 `\d+`，结果 `99,5 % Baumwolle` 被读成 `5 % Baumwolle`——
 * 一边是"百分比没说清指什么"，一边和档案里的 `100% cotton` 撞成「材质不一致」。
 * 这比"认不出"更糟：**把自己要求写对的格式判成错**。
 *
 * 只用在百分比语境，不去动尺寸/重量那些模式：它们的边界是照英文写法调的，
 * 一起放宽会把 `38,5` 读成两段，而德语的尺寸写法（38 × 42 cm）目前是整数。
 */
const DECIMAL = "(\\d+(?:[.,]\\d+)?)";

/** `99,5` → 99.5，`99.5` → 99.5。读不出返回 NaN，由调用方决定怎么处理（不猜）。 */
export const percentValue = (raw) => Number(String(raw).replace(",", "."));

/** 合计保留两位小数：`33,3 + 33,3 + 33,4` 在浮点里是 100.00000000000001，差一丁点就报"合计不是 100"。 */
const round2 = (value) => Math.round(value * 100) / 100;

const recordedFibers = `${FIBER_PATTERN}|${CHINESE_FIBER_PATTERN}`;
const percentPattern = new RegExp(`(?<![0-9.,])${DECIMAL}\\s*%\\s*((?:[A-Za-z-]+\\s+){0,2})(${recordedFibers})(?![\\p{L}\\p{N}])`, "giu");
const barePattern = new RegExp(`(?<![\\p{L}\\p{N}])(${recordedFibers})(?![\\p{L}\\p{N}])`, "giu");
const negatedChineseFiber = (raw, word, index) => word in CHINESE_FIBERS && /(?:不含有?|不包含|没有|并非|不是|无|非)\s*$/.test(raw.slice(0, index));

/**
 * 解析成成分表。
 *
 * 返回：
 *   ingredients  [{ fiber, percent }]，按原文出现顺序，percent 可能是 null（只写了词、没写比例）
 *   fibers       出现过的纤维（去重、保序）
 *   percents     { cotton: 25 } —— 同一个纤维写了两遍时取**第一个带百分比的**
 *   totalPercent 所有百分比之和（没有百分比时为 0）
 *   blend        是否明说混纺（写了 blend/mixed，或出现两种以上纤维）
 */
export function parseComposition(text) {
  const raw = String(text || "");
  const ingredients = [];
  const taken = [];
  for (const hit of raw.matchAll(percentPattern)) {
    if (negatedChineseFiber(raw, hit[3], hit.index)) continue;
    ingredients.push({ fiber: canonicalFiber(hit[3]), percent: percentValue(hit[1]), index: hit.index });
    taken.push([hit.index, hit.index + hit[0].length]);
  }
  for (const hit of raw.matchAll(barePattern)) {
    // 百分比对里已经算过的位置不再登记一次（`75% Polyester` 里的 Polyester 只算一条成分）。
    if (taken.some(([start, end]) => hit.index >= start && hit.index < end)) continue;
    if (negatedChineseFiber(raw, hit[1], hit.index) || /\d+(?:[.,]\d+)?\s*%\s*$/.test(raw.slice(0, hit.index))) continue;
    ingredients.push({ fiber: canonicalFiber(hit[1]), percent: null, index: hit.index });
  }
  ingredients.sort((a, b) => a.index - b.index);

  const percents = {};
  for (const item of ingredients)
    if (typeof item.percent === "number" && !(item.fiber in percents)) percents[item.fiber] = item.percent;

  const fibers = [...new Set(ingredients.map((x) => x.fiber))];
  return {
    text: raw,
    ingredients: ingredients.map(({ fiber, percent }) => ({ fiber, percent })),
    fibers,
    percents,
    totalPercent: ingredients.reduce((sum, x) => sum + (typeof x.percent === "number" ? x.percent : 0), 0),
    blend: /blend|mix/i.test(raw) || fibers.length > 1,
  };
}

/**
 * 这一处材质说法 vs 档案成分表。
 *
 * state：
 *   match            能同时成立（同一个纤维，含量一致；或都没写含量）
 *   presence         只提了纤维词、没提比例，档案里也有这个纤维 → 只算"关联到材质词"
 *   ratio_mismatch   同一个纤维，含量对不上
 *   missing_fiber    文案写了一个档案里根本没有的纤维（这条是"混纺冒充纯棉"的那类）
 *   unknown_percent  档案只写了纤维名、没写含量，而文案给了具体百分比
 *   unknown_composition  档案成分尚未识别，不能把解析失败当作确定不含某纤维
 *
 * note 是给人看的理由，**必须带具体数字**——"材质不一致"这五个字帮不了商家改稿。
 */
export function compareFiber(composition, fiber, claimedPercent = null) {
  const name = fiberLabel(fiber);
  const source = composition?.text || "";
  if (!composition?.fibers.length)
    return {
      state: "unknown_composition",
      note: `商品资料的材质「${source}」尚不能识别为明确的纤维成分；无法确认是否含${name}，请人工核对原文，不据此判为不含。`,
    };
  if (!composition.fibers.includes(fiber))
    return {
      state: "missing_fiber",
      note: `文案写的是${name}，但商品资料的材质「${source}」里没有${name}；这两句不能同时成立。`,
    };
  const known = composition.percents[fiber];
  if (claimedPercent === null || claimedPercent === undefined)
    return known === 0
      ? { state: "missing_fiber", note: `文案宣称含${name}，但商品资料是「${source}」（${name} 0%）；明确的零含量不能支持含有该纤维的表述。` }
      : { state: "presence", note: "" };
  if (typeof known === "number")
    return Math.abs(known - claimedPercent) <= 1e-9
      ? { state: "match", note: "" }
      : {
          state: "ratio_mismatch",
          note: `文案写 ${claimedPercent}% ${name}，商品资料是「${source}」（${name} ${known}%）——含量不一致。`,
        };
  return {
    state: "unknown_percent",
    note: `商品资料的材质只写了「${source}」，没有写${name}的含量；文案写 ${claimedPercent}% ${name}，请先在商品资料里补上成分比例。`,
  };
}

/**
 * 内衬/辅料：这些词后面的纤维不是袋身材质。
 * 词尾要放宽（`stitching`/`stitched`、`zippers`、`all seams`）——真实文案全是变形，
 * 只写 `\bstitch\b` 一个都匹配不上，等于这条守卫没写。
 */
const INNER_SCOPE = /\b(?:inside|inner|interior|linings?|lined|underside|bottom\s+panel|back\s+panel)\b/i;
/**
 * 缝线、拉链、手提织带这类**辅料**。刻意不含 handle/strap：真实文案里"棉织带提手"说的还是棉，
 * 而"涤纶缝线"说的不是袋身——两者的区别正是这一条要挡的东西。
 */
const AUXILIARY_SCOPE = /\b(?:stitch\w*|threads?|zippers?|zip|seams?|trims?|bindings?|pipings?|labels?|tags?|webbing)\b/i;
/** 打比方/比价：`cheaper than polyester`、`unlike nylon` 都不是成分声明。 */
const COMPARISON_SCOPE = /\b(?:than|unlike|instead\s+of|compared|similar\s+to|same\s+as|higher|lower|cheaper|dearer|better|worse)\b/i;

/**
 * 这处纤维说法说的是哪一层、是不是在打比方。
 *
 * 两层判断，**后面那层优先**（`100% polyester lining` 的 `lining` 在纤维后面，
 * 只看前面会把内衬读成袋身，凭空给一条"袋身材质不一致"）：
 *   - 往前 42 字：真实文案的常见写法 `Inside made of polyester-cotton material`、`double-stitched on all seams`；
 *   - 往后 18 字：`polyester lining` / `polyester-cotton lining` 这种"纤维在前、层在后"的写法。
 *
 * 往后看有两个守卫，都是为了避免把**别人的**层次词算到自己头上：
 *   1. 中间出现逗号/分号/句号就停——`100% cotton, fully lined with polyester` 的 `lined` 说的是另一段；
 *   2. 中间出现了**另一种纤维**也停——`cotton bag with polyester lining` 里的 `lining` 属于 polyester。
 */
const AFTER_LAYER = /^[\s-]*(?:fabric\s+|material\s+|canvas\s+|blend\s+)?(linings?|lined|interior|inside|shell|outer|exterior|stitching|stitched|threads?|trims?|pipings?|bindings?|zippers?|seams?|webbing)\b/i;
const FIBER_ANY = new RegExp(`\\b(?:${FIBERS.join("|")})\\b`, "i");

export function claimContext(claim, index, end = null) {
  const text = String(claim || "");
  const before = text.slice(Math.max(0, index - 42), index);
  const layerFromBefore = INNER_SCOPE.test(before) ? "inner" : AUXILIARY_SCOPE.test(before) ? "auxiliary" : "body";
  const comparison = COMPARISON_SCOPE.test(before);
  const fallback = { layer: layerFromBefore, comparison, layer_source: layerFromBefore === "body" ? null : "before" };
  // `end` 是**纤维词结束**的位置（调用方传 match 的右边界），从那里往后看 18 字。
  if (end === null || end === undefined) return fallback;
  const tail = text.slice(end, end + 18);
  const hit = AFTER_LAYER.exec(tail);
  if (!hit) return fallback;
  const prefix = tail.slice(0, hit.index);
  if (/[,;.]/.test(prefix) || FIBER_ANY.test(prefix)) return fallback;
  const word = hit[1].toLowerCase();
  const layer = /^lining|^lined|^interior|^inside/.test(word)
    ? "inner"
    : /^shell|^outer|^exterior/.test(word)
      ? "body"
      : "auxiliary";
  return { layer, comparison, layer_source: "after" };
}

/**
 * 同一句里**并列写着**的多个成分百分比，合计必须是 100%。
 *
 * 两个守卫都是踩出来的（真实夹具 `100% COTTON CANVAS: Made from 100% cotton canvas`：
 * 标题复述了一遍成分，两条都是 100%，一加起来就是"合计 200%"——这条假警报会让演示里的
 * "改一版 → 0 条问题"变成"还有 1 条"）：
 *   1. **同一纤维只数一次**：重复声明同一种纤维不是"加了成分"。
 *   2. **必须是并列写法**：两处之间除了 `, / & + and` 这类连接符不能再有别的词。
 *      `100% cotton shell, 100% polyester lining` 中间隔着 `shell`，说的是两个部位，
 *      不是一句成分声明，不能加在一起。
 */
export function compositionTotal(parts, claim = "") {
  const list = (parts || []).filter((x) => typeof x?.percent === "number");
  if (list.length < 2) return null;
  const ordered = [...list].sort((a, b) => a.start - b.start);
  const seen = new Set();
  const counted = [];
  for (const part of ordered) {
    if (seen.has(part.fiber)) continue;
    const previous = counted[counted.length - 1];
    if (previous) {
      const gap = String(claim).slice(previous.end, part.start);
      if (!/^[\s,;/&+·-]*(?:and|plus)?[\s,;/&+·-]*$/i.test(gap)) return null;
    }
    seen.add(part.fiber);
    counted.push(part);
  }
  if (counted.length < 2) return null;
  const total = round2(counted.reduce((sum, x) => sum + x.percent, 0));
  return { total, parts: counted };
}

/**
 * 文案里的**成分并列组**：`65 % Baumwolle, 35 % Polyester` 这种「百分比 + 纤维」连着写的句子。
 *
 * 为什么不复用 `parseComposition`：那个函数回答的是「这段文字里有哪些纤维、各占多少」，
 * 会把整段文字里**所有**百分比加起来（`compositionTotal` 还得靠调用方自己排除折扣、克重）。
 * 而 (EU) 1007/2011 要求的是**一行成分声明内部**成立——「合计 100 %」「按占比降序」「100 % 就不能再列第二种纤维」
 * 三条都只在「属于同一句」的那几个成分之间才谈得上。所以这里先按连接符切句，再在每组内部判。
 *
 * 三个刻意的取舍：
 *   1. **数字前面不许是数字或逗号/句点**：德语小数用逗号（`99,5 %`），不带这个守卫会把
 *      `99,5 % Baumwolle` 读成 `5 % Baumwolle` —— 读错比读不到严重得多。
 *   2. **中间夹了纤维词或数字就不算成分对**：`65 % Baumwolle und Polyester` 里那个 65 %
 *      说的是 Baumwolle，不能认成 Polyester 的含量（正则的「修饰词」段会吃进 `Baumwolle und`）。
 *   3. **比价句整组跳过**：`than 100 % Polyester`、`im Vergleich zu` 不是在说自己的成分。
 *
 * 返回每组的 parts（纤维 + 百分比）、合计、是否降序、是否「称 100 % 又列了别的纤维」。
 */
const RUN_JOIN = /^[\s,;/&+·\-–—]*(?:und|and|et|plus|sowie)?[\s,;/&+·\-–—]*$/i;
const COMPARISON_WORDS = /\b(?:than|unlike|instead\s+of|compared|im\s+vergleich|gegenüber|statt)\b/i;

export function compositionRuns(text) {
  const raw = String(text || "");
  /*
   * 这一层**故意不认**小数逗号（`99,5 %`）：这里算出来的"合计多少 / 有没有降序"是直接写进
   * 报告的结论，认错一个数比认不出严重。所以维持原来的负数守卫——`99,5 %` 整体不匹配，
   * 得到的是"这句不判"，不是"这句 5 %"。`tests/de-textil.test.mjs` 钉住这个行为。
   * 要升级成"认得逗号小数 → 真判合计"需要同时改那条断言，本轮没这个授权（见 qa/de-backlog.md）。
   * 决定"要不要指控商家"的证据层（`server/evidence.mjs`）用的是 `percentPattern` 那条，
   * 已经认小数逗号——所以合规的德语文案不会再被读成 5 %。
   */
  const partPattern = new RegExp(
    `(?<![0-9,.])(\\d+(?:\\.\\d+)?)\\s*%\\s*((?:[A-Za-z0-9.]+\\s+){0,3})(${FIBER_PATTERN})\\b`,
    "gi",
  );
  const parts = [];
  for (const hit of raw.matchAll(partPattern)) {
    const modifiers = hit[2] || "";
    // 见上面第 2 条：修饰词里出现纤维词或数字，说明这个百分比属于前面那个纤维，不是这一个。
    if (/\d|%/.test(modifiers) || new RegExp(`\\b(?:${FIBER_PATTERN})\\b`, "i").test(modifiers)) continue;
    const fiber = fiberOf(hit[3]);
    const word = hit[3];
    parts.push({
      fiber,
      percent: Number(hit[1]),
      start: hit.index,
      end: hit.index + hit[0].length,
      text: hit[0].trim(),
      // 原文用的哪个写法、是不是「德语必须换掉」的英文写法。判语言那一半要用。
      word,
      english_only: Boolean(GERMAN_WORDING[fiber] && GERMAN_WORDING[fiber].english === word.toLowerCase()),
    });
  }
  const runs = [];
  for (const part of parts) {
    const current = runs[runs.length - 1];
    const joined = current && RUN_JOIN.test(raw.slice(current.end, part.start));
    if (!joined) {
      runs.push({ parts: [part], start: part.start, end: part.end });
      continue;
    }
    current.parts.push(part);
    current.end = part.end;
  }
  return runs.map((run) => {
    const text = raw.slice(run.start, run.end);
    const fibers = [...new Set(run.parts.map((x) => x.fiber))];
    const total = round2(run.parts.reduce((sum, x) => sum + x.percent, 0));
    const descending = run.parts.every((part, i) => i === 0 || run.parts[i - 1].percent >= part.percent);
    return {
      text,
      start: run.start,
      end: run.end,
      parts: run.parts,
      fibers,
      total,
      descending,
      // 「100 % 又多列一种纤维」：写 100 % 就等于说单一纤维，第二行只要带百分比就自相矛盾。
      pure_conflict: fibers.length > 1 && run.parts.some((x) => x.percent === 100),
      // 比价/对比句不是成分声明（`than 100 % Polyester`）。
      comparison: COMPARISON_WORDS.test(raw.slice(Math.max(0, run.start - 42), run.start)),
    };
  });
}

/** 合计不是 100% 时给的理由；合计正常返回空串。 */
export function compositionTotalNote(result) {
  if (!result) return "";
  const shown = result.parts.map((x) => `${x.percent}% ${fiberLabel(x.fiber)}`).join(" + ");
  if (Math.abs(result.total - 100) <= 1e-9) return "";
  return `这句写的成分是 ${shown}，合计 ${result.total}%${result.total < 99 ? "，不足 100%" : "，超过 100%"}——成分比例要么补全、要么改正。`;
}
