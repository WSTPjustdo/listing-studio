import { flattenContent, ECO_CLAIM_PATTERN, PERFORMANCE_CLAIM_PATTERN, normalizeForMatch } from './domain.mjs';
import { canonicalFiber, CHINESE_FIBER_PATTERN, FIBER_PATTERN, claimContext, compareFiber, compositionTotal, compositionTotalNote, fiberLabel, parseComposition, percentValue } from './material.mjs';

// Associates atomic parameters with recorded facts. Never proves an entire sentence.
export const PARAMETER_LINK_VERSION = 'structured-parameters-v2.6-original-dimension-tuples';
// 能被当作"证据"引用的状态。这张表是**词表本身**，不是提示：
// 任何一个不在表里的状态（历史上出现过 `source_supported`），对应参数就会被当成"尚未确认"，
// 于是整篇文案逐句变成"待核对"，而 AMZ-05 一次都不开枪——不会有人报错，只是结果全错。
// 所以 tests/fact-vocabulary.test.mjs 会拿数据文件里的状态词与这张表对账。
export const FACT_STATUSES = new Set(['confirmed', 'merchant_confirmed', 'public_source', 'amazon_listing_claim']);
// 数据里可以合法出现、但**不能**当证据用的状态（演示条件、未知、互相矛盾）。
// 单列出来是为了让"数据用了个我们不认识的词"和"数据明确说了这是演示"能分开。
export const NON_EVIDENCE_STATUSES = new Set(['unknown', 'synthetic_demo', 'conflicting']);
const allowedStatuses = FACT_STATUSES;
const sensitive = /\b(?:organic|certif\w*|biodegrad\w*|compost\w*|waterproof|leakproof|recycl\w*|non[- ]?toxic|eco[- ]?friendly|indestructible|antibacterial|hypoallergenic|guarantee\w*)\b|承重|认证|有机|降解|防水/i;
const escape = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const number = '(\\d+(?:\\.\\d+)?)';
/*
 * 百分比里的数字，允许德语/法语的小数逗号（`99,5 % Baumwolle`）。
 *
 * 为什么不直接放宽上面的 `number`：尺寸、克重、容量那些模式的边界是照英文写法调的，
 * 一起改会把 `38,5 × 42 cm` 之类的写法读成两段。这里只给**百分比**用。
 *
 * 原来的后果是具体的：我们自己给德语/法语生成指令写着「小数用逗号（99,5 %）」，
 * 一句 `99,5 % Baumwolle, 0,5 % Elasthan` 被读成 `5 %` 与 `0 %`，
 * 于是同一句话同时报「含量 5% 与档案 100% 不一致」和「这个百分比没说清指什么」——
 * 把**自己要求写对的格式**判成错。2026-10-31 复现，修前一条合规德语句报 4 个假数值。
 */
const percentNumber = '(\\d+(?:[.,]\\d+)?)';
const close = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9;
const equal = (a, b) => typeof a === 'number' ? close(a, b) : a && typeof a === 'object' ? close(a.width, b?.width) && close(a.height, b?.height) && (a.depth === undefined || a.depth === null ? true : close(a.depth, b?.depth)) : a === b;
// Numerical epsilon only absorbs floating-point arithmetic; it never permits rounded restatements.
//
// 唯一的例外是**换算了单位、并且原文自己标了约数**的那一处，见 conversionTolerance()：
// 2.54 是精确的，但原文只写到某一位小数时，那一位本身就是精度边界，
// `approximately 15.0 x 16.5 inches` 与 `38 x 42 cm` 相差 0.04 英寸不是错误，是四舍五入。
// 同单位、或没写约数的，仍然一律精确比对（下面 closeWithin 只在 tolerance > 0 时才被调用）。
const closeWithin = (a, b, tolerance) =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tolerance + 1e-9;
const equalWithin = (a, b, tolerance) =>
  typeof a === 'number'
    ? closeWithin(a, b, tolerance)
    : a && typeof a === 'object'
      ? closeWithin(a.width, b?.width, tolerance.width || 0) && closeWithin(a.height, b?.height, tolerance.height || 0) &&
        (a.depth === undefined || a.depth === null ? true : closeWithin(a.depth, b?.depth, tolerance.depth || 0))
      : a === b;

// 原文在数字前写了约数。这是**唯一**允许按精度比对的入口。
const APPROX_BEFORE = /(?:approximately|approx\.?|about|around|roughly)\s*$|(?:≈|~)\s*$/i;
/**
 * 单位换算 + 原文自标约数时，每一轴按自己的最后一位取半个单位容差（返回 cm）。
 *
 * 为什么不是"随便给个 1% 容差"：容差必须由**原文自己写出来的精度**决定。
 * `15.0 in` 的最后一位是 0.1 英寸 → ±0.05 in = ±0.127 cm。
 *
 * 两个门禁，缺一不可：
 *   1. 原文自标约数（approximately / approx / about / around / ≈）；
 *   2. **每一个轴都写到小数点**。`15 x 16.5 in` 这种混着整数的写法不算按精度表达——
 *      整数末位的半个单位是 0.5 in = 1.27 cm，那个容差宽到能把 1 cm 的真误差也放过去，
 *      等于把"精确比对"偷偷改成"差不多就行"。作者只想写粗值，就仍按精确比对。
 * 没有约数标记、或没有发生单位换算（同为 cm）时返回空映射，调用方走精确比对。
 */
function conversionTolerance(claim, run) {
  const before = claim.slice(Math.max(0, run.start - 30), run.start);
  if (!APPROX_BEFORE.test(before)) return new Map();
  if (!run.axes.some(axis => axis.unit && axis.unit !== 'cm')) return new Map();
  const decimals = run.axes.map(axis => (String(axis.raw).split('.')[1] || '').length);
  if (decimals.some(count => count === 0)) return new Map();
  // 不能拿低精度轴的容差放行高精度轴；轴名调整顺序时，容差与原轴一起映射。
  // 混合单位中的 cm 轴没有换算，仍须精确一致。
  return new Map(run.axes.map((axis, index) => [axis,
    axis.unit && axis.unit !== 'cm' ? 0.5 * 10 ** -decimals[index] * factorOf(axis.unit) : 0]));
}

const axisTolerances = (tolerances, axes) => Object.fromEntries(
  Object.entries(axes).map(([name, axis]) => [name, tolerances.get(axis) || 0]),
);
const toleranceText = tolerances => Object.entries(tolerances).map(([axis, value]) =>
  `${({ width: '宽', height: '高', depth: '深' })[axis] || axis}±${Number(value.toPrecision(6))} cm`).join('、');

// Parse complete dimension tuples and preserve axis identity; unsupported axes remain unverified.
const axisUnit = raw => {
  if (!raw) return null;
  if (/^["'′″]{1,2}$/.test(raw)) return 'in';
  const unit = raw.toLowerCase();
  return unit === 'cm' ? 'cm' : unit === 'mm' ? 'mm' : 'in';
};
const factorOf = unit => (unit === 'mm' ? 0.1 : unit === 'in' ? 2.54 : 1);

function scanDimensionRuns(claim) {
  const runs = [];
  // 轴名可以紧跟单位、连空格都没有（`17.7''Lx4.7''W`）。单个字母后面必须不是别的字母，
  // **但 x 要放过**——那是分隔符本身，`Lx` 里 L 是轴名、x 是乘号。
  const startPattern = /(\d+(?:\.\d+)?)\s*(cm|mm|inches|inch|in|["'′″]{1,2})?\s*(?:\(([^)]{0,16})\))?\s*(?:(?:length|width|wide|height|high|depth|deep)(?![a-z])|[lwhd](?![a-wyz]))?\s*(?:[x×]|\bby\b)\s*(?=\d)/gi;
  for (const hit of claim.matchAll(startPattern)) {
    const start = hit.index;
    if (runs.some(run => start < run.end)) continue; // 同一个尺寸串不重复起头
    const axes = [];
    let wordSeparator = false;
    let at = start;
    while (axes.length < 4) {
      // 括号里的内容是"单位换算说明"（`13.4-inch (34 cm)`）还是"轴名"（`(W x L)`）？
      // 后者不能当说明吞掉：吞掉之后 at 就跳过了括号，整串后面那层轴名再也认不出来，
      // 提手的两轴只能按"袋身宽×高"去比。所以轴名形状的括号在这里**不吃**。
      const axis = /^(\d+(?:\.\d+)?)\s*(cm|mm|inches|inch|in|["'′″]{1,2})?\s*(?!\(\s*(?:length|width|wide|height|high|depth|deep|[lwhd])\s*[x×])(?:\(([^)]{0,16})\))?\s*(?:(length|width|wide|height|high|depth|deep)(?![a-z])|([lwhd])(?![a-wyz]))?/i.exec(claim.slice(at));
      if (!axis) break;
      axes.push({ raw: axis[1], unit: axisUnit(axis[2]), label: (/^(?:length|width|wide|height|high|depth|deep|[lwhd])$/i.test(axis[3] || '') ? axis[3] : axis[4] || axis[5] || '').charAt(0).toLowerCase() || null,
        // 每一轴自己的位置也记下来：提手的 `1"W x 25"L` 要拆成"宽度一处、长度一处"分别登记，
        // 整串一起登记的话，长度那条永远只能当"袋身尺寸对不上"处理。
        annotation: axis[3]?.trim() || '', start: at, end: at + axis[0].length });
      at += axis[0].length;
      const separator = /^\s*(?:[x×]|\bby\b)\s*(?=\d)/i.exec(claim.slice(at));
      if (!separator) break;
      if (/\bby\b/i.test(separator[0])) wordSeparator = true;
      at += separator[0].length;
    }
    const tail = /^\s*(cm|mm|inches|inch|in)\b/i.exec(claim.slice(at));
    const shared = tail ? axisUnit(tail[1]) : null;
    let end = at + (tail ? tail[0].length : 0);
    if (axes.length < 2) continue;
    // Real intake request 58c5c202-9bce-4327-9f5a-58f3a24e2e34 wrote
    // `38 cm wide by 42 cm high`. Only accept word-separated tuples when every
    // axis is explicitly named width/height/depth; bare `38 by 42 cm` or length
    // still cannot borrow the width/height order used for x-separated tuples.
    if (wordSeparator && (axes.some(axis => !['w', 'h', 'd'].includes(axis.label)) ||
        new Set(axes.map(axis => axis.label)).size !== axes.length)) continue;
    // 轴名也可能写在**整串后面**的括号里：`the size of the handle strap is about 1.4 x 23.6 inches/
    // 3.55 x 60 cm (W x L)`（真实样本 B0GWQ1XDKR 就是这么写的）。
    // 不认这层括号，就不知道哪轴是宽、哪轴是长，只能整串当"袋身尺寸待核对"——
    // 而提手长度我们是有字段的，白白放过一次真对照。
    //
    // **只在两轴时采用**：三轴的 `(L x W x H)` 跟档案的宽/高/深不是一套轴名（袋子的 L 到底是宽还是深，
    // 原文没说清），硬套会给出方向错误的对照，那比"待核对"更糟。
    let trailing = null;
    if (axes.length === 2) {
      // 中间可能隔着另一种单位的同一串（`1.4 x 23.6 inches/ 3.55 x 60 cm (W x L)`），
      // 轴名括号挂在后半串后面。所以只往后**看**，不把这段吞进 end——
      // 吞进去的话后半串就落在本串范围内，被"同一个尺寸串不重复起头"挡掉，
      // 那 3.55 和 60 两个数字就变成没人认领了（覆盖率会从 0 个读不懂涨回去）。
      const named =
        /^\s*(?:\/\s*\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*(?:cm|mm|inches|inch|in)\s*)?\(\s*(length|width|wide|height|high|depth|deep|[lwhd])\s*[x×]\s*(length|width|wide|height|high|depth|deep|[lwhd])\s*\)/i.exec(
          claim.slice(end),
        );
      if (named) trailing = [named[1], named[2]].map((x) => x.charAt(0).toLowerCase());
    }
    // 单位常只写一次：`38 x 42 cm` 的单位其实贴在"42"后面，前一个数没有自己的单位。
    // 所以缺单位的轴统一沿用"最后出现过的那个单位"；一个单位都没有就不猜——不知道是厘米还是英寸，换了也是编的。
    const fallback = shared || [...axes].reverse().find(axis => axis.unit)?.unit || null;
    if (!fallback) continue;
    const annotationIssue = axes.find(axis => {
      const annotation = axis.annotation || '';
      if (!/\d/.test(annotation)) return false;
      const alternate = /^(?:about\s+|approximately\s+|approx\.?\s*)?(\d+(?:\.\d+)?)\s*(cm|mm|inches|inch|in|["'′″]{1,2})$/i.exec(annotation);
      return !alternate || !close(Number(axis.raw) * factorOf(axis.unit || fallback), Number(alternate[1]) * factorOf(axisUnit(alternate[2])));
    });
    runs.push({
      start,
      end,
      annotation_issue: annotationIssue ? '轴后括号含另一数值或单位说明，但它与主值不能精确对应，或语义不明；请核对括号内外的完整原文。' : '',
      axes: axes.map((axis, index) => ({
        ...axis,
        unit: axis.unit || fallback,
        // 写在轴后面的名字优先（`17.7''Lx4.7''W`），其次是整串后面括号里的（`(W x L)`）。
        label: axis.label || trailing?.[index] || null,
      })),
    });
  }
  return runs;
}

/**
 * 列表序号不是商品参数。
 *
 * 真实文案里 `Canvas Tote Bags Widely Used: 1.`、`... holds all your purchases 2.` 这种编号很常见，
 * 断句之后序号孤零零留在句尾。以前它会被当成"读不懂的数字"，让覆盖率看起来比实际差，
 * 界面上也会冒出一条"数值尚不能明确关联"——对商家是噪音，对我们是自欺。
 *
 * 只认三种位置，别的数字一律不当序号（宁可漏认，不要把真参数吞掉）：
 *   1. 句子开头（列表项被断句切开）；2. 冒号/分号之后；3. 句子结尾、后面只有 `.)`。
 */
export function ordinalSpans(claim) {
  const text = String(claim || '');
  const spans = [];
  for (const hit of text.matchAll(/(?:^|[:;]\s*|\s)(\d{1,2})[.)](?=\s|$)/g)) {
    const start = hit.index + hit[0].lastIndexOf(hit[1]);
    const head = text.slice(0, start);
    const tail = text.slice(start + hit[1].length);
    // 括号里的 `(Pack of 1)` 是参数，不是编号——这条守卫是真踩到的：`(Pack of 1)` 曾被当成序号吞掉。
    if ((head.match(/\(/g) || []).length > (head.match(/\)/g) || []).length) continue;
    // 前面是 of / per / x 这类词，说明这个数是"量"，不是"编号"。
    if (/(?:\bof|\bper|[x×])\s*$/i.test(head)) continue;
    if (!head.trim() || /[:;]\s*$/.test(head)) spans.push({ start, end: start + hit[1].length });
  }
  return spans;
}

export function inspectEvidence(content, profile, claimMap = [], sourceCatalog = null) {
  const knownSources = sourceCatalog && new Map(sourceCatalog.map(source => [source.source_id, source]));
  const productSource = source => source && !/policy|regulatory|project_check|merchant_submission|synthetic/i.test(source.kind || '');
  const allFacts = new Map([...Object.entries(profile || {}), ...(profile?.additional_facts || []).map((fact, index) => [`additional_facts.${index}`, fact])]);
  const usable = field => {
    const fact = allFacts.get(field);
    return fact && allowedStatuses.has(fact.status) && fact.value !== null && fact.value !== undefined && Array.isArray(fact.source_ids) && fact.source_ids.length && (!knownSources || fact.source_ids.every(id => productSource(knownSources.get(id)))) ? fact : null;
  };
  // A verbatim, sourced body-dimension tuple can be kept in its original unit
  // without inventing which axis is width/height/depth. This is deliberately
  // unavailable when structured dimensions exist: a raw excerpt must never
  // override a structured value or hide a conflicting axis assignment.
  const rawBodyDimensions = knownSources && profile?.dimensions_cm?.value == null
    ? [...allFacts].flatMap(([field]) => {
      if (!field.startsWith('additional_facts.')) return [];
      const fact = usable(field);
      if (!fact || typeof fact.value !== 'string' || !/(?:dimensions?|size|尺寸)/i.test(fact.label || '')) return [];
      if (/packag|carton|shipping|pocket|handle|strap|print|embroid|包装|外箱|物流|口袋|提手|印花/i.test(fact.label || '')) return [];
      const runs = scanDimensionRuns(fact.value);
      if (runs.length !== 1) return [];
      const run = runs[0];
      if (run.axes.length !== 3 || run.annotation_issue || run.axes.some(axis => axis.label || axis.annotation)) return [];
      // Only one complete raw tuple, with no alternatives, product options,
      // descriptive scope or named-axis suffix, is eligible for this channel.
      if (fact.value.slice(0, run.start).trim() || fact.value.slice(run.end).trim()) return [];
      const sameAxes = sourceRun => sourceRun.axes.length === 3 && !sourceRun.annotation_issue &&
        sourceRun.axes.every((axis, index) => !axis.label && !axis.annotation && axis.unit === run.axes[index].unit && close(Number(axis.raw), Number(run.axes[index].raw)));
      const sourcesSupportRaw = fact.source_ids.every(sourceId => {
        const source = knownSources.get(sourceId);
        const excerpt = String(source.snapshot?.excerpt ?? source.excerpt ?? '');
        const sourceRuns = scanDimensionRuns(excerpt);
        if (sourceRuns.length !== 1 || !sameAxes(sourceRuns[0])) return false;
        const before = excerpt.slice(Math.max(0, sourceRuns[0].start - 65), sourceRuns[0].start).split(/[;；\n]/).at(-1) || '';
        const after = excerpt.slice(sourceRuns[0].end, sourceRuns[0].end + 80).split(/[;；\n]/)[0];
        const namedAxes = /\b(?:width|height|depth|length|wide|high|deep|long|lwh|whd)\s*(?::|=|is|of)?\s*$/i.test(before) ||
          /\b[lwhd]\s*[x×]\s*[lwhd]\s*[x×]\s*[lwhd]\s*[:=]?\s*$/i.test(before) ||
          /^\s*(?:\([^)]*\b(?:[lwhd]|length|width|height|depth)\b|(?:width|height|depth|length|wide|high|deep|long)\b)/i.test(after);
        return !namedAxes && !/packag|carton|shipping|pocket|handle|strap|print|embroid|包装|外箱|物流|口袋|提手|印花/i.test(`${before} ${after}`) &&
          !/\b(?:options?|variants?|available sizes?|either|or)\b|任选|或|可选|多种尺寸/i.test(excerpt);
      });
      if (!sourcesSupportRaw) return [];
      return [{ field, fact, run }];
    })
    : [];
  const productRef = profile ? `${profile.product_id}@${profile.revision}` : null;
  return flattenContent(content).flatMap(({ path, text }) => text.split(/(?<!\bapprox\.)(?<=[.!?])\s+|\n+/i).filter(Boolean).flatMap(claim => {
    const candidates = [];
    const overlaps = (start, end) => candidates.some(item => start < item.end && end > item.start);
    function add(start, end, field, value, method, contextReason = '', options = {}) {
      if (overlaps(start, end)) return;
      const fact = usable(field);
      const before = claim.slice(Math.max(0, start - 28), start);
      // `up to` 一般是限定条件（"less than 5 kg"），但对承重来说 `holds up to 22 lbs`
      // 就是"额定载荷 22 磅"的标准写法——按限定处理等于永远比不了。所以只对承重放开这一个词。
      const qualifier = options.allowUpTo
        ? /\b(?:not|no|without|free of|more than|less than|at least|at most)\s*(?:(?:made|entirely|pure|of|any|a|an)\s+){0,4}$/i
        : /\b(?:not|no|without|free of|more than|less than|at least|at most|up to)\s*(?:(?:made|entirely|pure|of|any|a|an)\s+){0,4}$/i;
      const negated = qualifier.test(before) || /(?:不含有?|不包含|没有|并非|不是|无|非)\s*$/.test(before) || /^[- ]free\b/i.test(claim.slice(end));
      const negative = /(?:^|[\s(=:])[-−]\s*$/.test(before);
      // `options.conflictReason` 是给"确定冲突、但通用理由说不清"的情况留的：
      // 材质冲突需要写出具体数字（文案 25% 棉 / 档案 100% 棉），只说"材质不一致"商家没法改稿。
      // 只影响**理由文案**，不改判定：能不能对上仍然由 equal() 说了算。
      let reason = contextReason || (negative ? '负数不能按正值商品参数自动关联。' : negated ? '含否定或限定条件，不能按肯定的等值参数自动关联。' : '');
      const tolerance = options.tolerance || {};
      const maxTolerance = Math.max(0, ...Object.values(tolerance));
      const exact = !reason && fact && equal(value, fact.value);
      const approximate = !exact && !reason && fact && maxTolerance > 0 && equalWithin(value, fact.value, tolerance);
      const matches = exact || approximate;
      if (!reason && !fact) reason = '该字段尚未确认，或来源记录不可用；不从其他字段或待核验材料推定。';
      if (!reason && !matches) reason = options.conflictReason || '该字段的数值、单位、材质或轴顺序与商品快照不一致。';
      candidates.push({ start, end, original: claim.slice(start, end), field, parsed_value: value, method,
        status: matches ? 'matched' : fact && !negated && !contextReason ? 'conflict' : 'needs_review',
        // 按精度对上时把话说全：这不是"差不多就算对"，而是"原文自己写了约数，差在它自己标注的精度之内"。
        reason: matches
          ? approximate
            ? `原文自标约数并按单位换算，每轴落在它自己标注的精度内（${toleranceText(tolerance)}）；仅支持该参数。`
            : '已按字段、单位和商品版本关联记录来源；仅支持该参数。'
          : reason,
        source_ids: matches ? [...fact.source_ids] : [], product_ref: productRef, expected_value: fact?.value ?? null,
        ...(matches ? { value: fact.value, fact_status: fact.status } : {}),
        ...(approximate ? { approximation: { tolerance_cm: Number(maxTolerance.toPrecision(6)), axis_tolerances_cm: Object.fromEntries(Object.entries(tolerance).map(([axis, value]) => [axis, Number(value.toPrecision(12))])), basis: '原文自标约数 + 单位换算，每轴按自己的最后一位的半个单位取容差' } } : {}) });
    }
    function match(regex, fn) { for (const item of claim.matchAll(regex)) fn(item); }
    /** 认得出、但档案里没有这个字段的参数：只登记，不判定对错，也不要求商家补证据。 */
    const uncovered = (start, end, field, field_label, parsed_value, method, reason) => {
      if (overlaps(start, end)) return;
      candidates.push({ start, end, original: claim.slice(start, end), field, field_label, parsed_value,
        method, status: 'not_covered', reason, source_ids: [], product_ref: productRef, expected_value: null });
    };
    // Tuples precede single lengths. Width/height order is preserved.
    for (const run of scanDimensionRuns(claim)) {
      // 两轴、三轴均按每轴自己的精度；not_covered 的参数不参与比对。
      const tolerance = conversionTolerance(claim, run);
      if (run.annotation_issue) {
        add(run.start, run.end, 'dimensions_cm',
          run.axes.map(axis => ({ value: Number(axis.raw), unit: axis.unit })),
          'dimension_annotation_requires_review', run.annotation_issue);
        continue;
      }
      const context = claim.slice(Math.max(0, run.start - 55), run.start).split(/[;；]/).at(-1) || '';
      const following = claim.slice(run.end, run.end + 25).split(/[;；]/)[0];
      const pocketBefore = /(?:pockets?|pouches|compartments?)\s*(?:size|dimensions?)?\s*(?::|=|is|are|measures?|approx\.?)?\s*$/i.test(context);
      const pocketAfter = /^\s*(?:(?:outside|inside|outer|inner|front|back|side|zippered|external|internal)\s+){0,3}(?:pockets?|pouches|compartments?)\b/i.test(following);
      // 印刷面积、纸箱、提手/肩带/口袋的尺寸都不是袋身尺寸。
      // 分两档看：handle/strap/print 这类词在前面 55 字内就算（"Handle: 1.4 x 23.6 in"）；
      // pocket/zipper 这类词在包描述里到处都是，只在紧邻处（前后）出现才算，否则整篇文案的尺寸全被吃掉。
      const other =
        (/print|embroid|carton|packag|shipping box|handle|strap|drop/i.test(context) ||
          pocketBefore || pocketAfter) &&
        !/(?:bag|tote|product)\s+(?:size|dimensions|measures)/i.test(context);
      if (run.axes.length > 2) {
        if (other || overlaps(run.start, run.end)) continue;
        const before = claim.slice(Math.max(0, run.start - 55), run.start);
        const after = claim.slice(run.end, run.end + 65);
        const namedAxisContext = /\b(?:width|height|depth|length|wide|high|deep|long|lwh|whd)\s*(?::|=|is|of)?\s*$/i.test(before) ||
          /\b[lwhd]\s*[x×]\s*[lwhd]\s*[x×]\s*[lwhd]\s*[:=]?\s*$/i.test(before) ||
          /^\s*(?:\([^)]*\b(?:[lwhd]|length|width|height|depth)\b|(?:width|height|depth|length|wide|high|deep|long)\b)/i.test(after);
        const nonBodyAfter = /^\s*(?:\(\s*)?(?:(?:(?:for|of)\s+(?:the\s+)?)?(?:package|packaging|carton|shipping|pocket|handle|strap|print|embroidery)\b|(?:包装|外箱|口袋|提手|印花))/i.test(after);
        const ambiguousOptions = /\b(?:options?|variants?|available sizes?|either|or)\b|任选|或|可选|多种尺寸/i.test(claim);
        const rawMatch = run.axes.length === 3 && !namedAxisContext && !nonBodyAfter && !ambiguousOptions && !run.axes.some(axis => axis.label || axis.annotation)
          ? rawBodyDimensions.find(saved => saved.run.axes.every((axis, index) =>
            axis.unit === run.axes[index].unit && close(Number(axis.raw), Number(run.axes[index].raw))))
          : null;
        if (rawMatch) {
          add(run.start, run.end, rawMatch.field, rawMatch.fact.value, 'recorded_original_dimension_tuple');
          const associated = candidates.at(-1);
          if (associated?.status === 'matched')
            associated.reason = '与已记录商品尺寸原文的三轴数值、原单位和顺序一致；仅关联原文尺寸，不推定哪一轴是宽、高或深。';
          continue;
        }
        const profileDepth = usable('dimensions_cm')?.value?.depth;
        const hasDepth = typeof profileDepth === 'number';
        const labels = run.axes.map(axis => axis.label);
        const fullyNamed = labels.every(Boolean) && new Set(labels).size === labels.length;
        // 轴名正好是 宽/高/深 时按轴名对（顺序无关）；轴名缺一个也不按顺序猜。
        const byLabel = fullyNamed && labels.every(label => ['w', 'h', 'd'].includes(label));
        if (run.axes.length === 3 && hasDepth && (byLabel || !labels.some(Boolean))) {
          const pick = byLabel
            ? { width: run.axes[labels.indexOf('w')], height: run.axes[labels.indexOf('h')], depth: run.axes[labels.indexOf('d')] }
            : { width: run.axes[0], height: run.axes[1], depth: run.axes[2] };
          add(run.start, run.end, 'dimensions_cm',
            { width: Number(pick.width.raw) * factorOf(pick.width.unit),
              height: Number(pick.height.raw) * factorOf(pick.height.unit),
              depth: Number(pick.depth.raw) * factorOf(pick.depth.unit) },
            byLabel ? 'dimension_triple_by_axis_label' : 'dimension_triple_in_written_order', '',
            { tolerance: axisTolerances(tolerance, pick) });
          continue;
        }
        const gap = run.axes.length > 3
          ? `这串写了 ${run.axes.length} 轴，超过袋身的三轴（宽、高、深），无法逐轴对照。`
          : !hasDepth
            ? profile?.dimensions_cm?.value == null
              ? '商品档案未确认结构化尺寸；这串写了 3 轴，且没有可关联的同单位、同顺序商品尺寸原文，不推定宽、高或深。'
              : '商品档案只有宽、高两轴，缺深度（depth 未确认）；这串写了 3 轴，不硬取前两个数当宽×高，等深度确认后再逐轴对照。'
            : `这串的轴名是「${labels.filter(Boolean).join('/')}」，和档案的宽/高/深不是一套轴名，不猜对应关系。`;
        if (run.axes.length === 3 && !hasDepth) {
          add(run.start, run.end, 'dimensions_cm',
            { width: Number(run.axes[0].raw) * factorOf(run.axes[0].unit),
              height: Number(run.axes[1].raw) * factorOf(run.axes[1].unit),
              depth: Number(run.axes[2].raw) * factorOf(run.axes[2].unit) },
            'dimension_triple_missing_confirmed_depth', gap + '请在商品资料中确认完整三轴及其来源。');
          continue;
        }
        candidates.push({ start: run.start, end: run.end, original: claim.slice(run.start, run.end),
          field: 'dimensions_3d', field_label: '三维尺寸（长×宽×高）',
          parsed_value: run.axes.map(axis => ({ value: Number(axis.raw), unit: axis.unit })),
          method: 'dimension_axes_without_profile_field', status: 'not_covered',
          reason: `${gap}请确认哪两轴是袋身正面尺寸，或在商品资料里补上深度。`,
          source_ids: [], product_ref: productRef, expected_value: null });
        continue;
      }
      const [first, second] = run.axes;
      // 提手写 `1"W x 25"L` 的两轴写法在真实样本里出现 5 次（B083DHKJS5 / B085CC9FDL / B085M6GWJZ /
      // B088H12FKX / B0DX7C3T18）。以前整串当"袋身尺寸"，只能给一条"提手尺寸不算袋身尺寸"的待核对——
      // 但那份数据我们**有**：宽度进 handle_width_cm（档案没这项，走 not_covered），
      // 长度进 handle_length_cm 真对照。轴名必须是 W 和 L 都写明才拆，否则不知道哪个是宽哪个是长，
      // 那还是老实说"这是提手尺寸，但没说哪轴是哪轴"。
      const labels = run.axes.map(axis => axis.label);
      const named = labels.every(Boolean) && new Set(labels).size === labels.length;
      if (other && /handle|strap/i.test(context) && named && labels.includes('w') && labels.includes('l')) {
        const widthAxis = run.axes[labels.indexOf('w')];
        const lengthAxis = run.axes[labels.indexOf('l')];
        uncovered(widthAxis.start, widthAxis.end, 'handle_width_cm', '提手宽度',
          { value: Number(widthAxis.raw), unit: widthAxis.unit },
          'handle_width_without_profile_field',
          '这是提手的宽度（带子有多宽），不是提手长度，也不是袋身尺寸；商品资料里只有提手长度、没有宽度这一项，无法对照，也不计入证据待补。');
        add(lengthAxis.start, lengthAxis.end, 'handle_length_cm',
          Number(lengthAxis.raw) * factorOf(lengthAxis.unit), 'handle_length_from_width_by_length', '');
        continue;
      }
      // 口袋尺寸：`8" x 8" outside pocket`、`Outside pocket measures 8 x 8 in`。
      // 以前这类落到 dimensions_cm 的"待核对"，理由写的是"印刷、刺绣、提手或物流包装尺寸不能关联"——
      // 三样都不是口袋，商家读完不知道我们到底在说什么，而且它被算进了"证据待补"（商家补不了这一项）。
      // 判据只有一条：口袋词紧贴在数字前面（同一句里紧邻）或紧跟在后（25 字内）。
      // 口袋词在包里到处都是，窗口放宽会把整句话的袋身尺寸一起吃掉。
      if (pocketBefore || (pocketAfter && !/handle|strap/i.test(following))) {
        uncovered(run.start, run.end, 'pocket_size', '口袋尺寸',
          { width: Number(first.raw) * factorOf(first.unit), height: Number(second.raw) * factorOf(second.unit) },
          'pocket_size_without_profile_field',
          '这是口袋的尺寸，不是袋身尺寸；商品资料里只有袋身宽/高/深，没有口袋尺寸这一项，无法对照，也不计入证据待补。');
        continue;
      }
      const axisLabelUnclear = labels.some(Boolean) && !(named && labels.includes('w') && labels.includes('h'));
      const widthAxis = named && labels.includes('w') && labels.includes('h') ? run.axes[labels.indexOf('w')] : first;
      const heightAxis = named && labels.includes('w') && labels.includes('h') ? run.axes[labels.indexOf('h')] : second;
      add(run.start, run.end, 'dimensions_cm',
        { width: Number(widthAxis.raw) * factorOf(widthAxis.unit), height: Number(heightAxis.raw) * factorOf(heightAxis.unit) },
        named && !axisLabelUnclear ? 'dimension_pair_by_axis_label' : 'dimension_tuple_to_cm',
        other ? '印刷、刺绣、提手或物流包装尺寸不能关联为商品袋身尺寸。' : axisLabelUnclear ? '轴名不能明确对应商品资料的宽、高；请确认各轴含义，不按书写顺序推测。' : '',
        { tolerance: axisTolerances(tolerance, { width: widthAxis, height: heightAxis }) });
    }
    /*
     * 地址里的门牌号与邮编不是商品参数。
     *
     * 德国站 GPSR 要求在报价页面上写制造商与欧盟责任人的邮政地址
     * （`Hersteller: Beispiel GmbH, Hauptstraße 2, 20095 Hamburg`）。这一段是**法规要的**，
     * 但解析器会把「2」「20095」当成"读不懂的数值" —— 第 9 轮真模型跑德语时，
     * 一条合规文案的 7 条 EVID-01 里有 4 条就是这么来的（两家公司各两处）。
     *
     * 只认两种形态，宁可漏认也别把商品参数吃掉：
     *   a. 街道词 + 门牌号（Hauptstraße 2 / Baogang Road 18）；
     *   b. 4–6 位数字 + 首字母大写的城市（20095 Hamburg / 518000 Shenzhen）。
     * b 要排除 `1000 Stück` 这类数量写法，否则零售件数会被误判成邮编。
     */
    const addressNote = '这是地址里的门牌号或邮编，不是商品参数；不对应任何档案字段，也不计入证据待补。';
    match(/(?:\p{Lu}[\p{L}-]*?(?:stra(?:ß|ss)e|str\.?|weg|allee|platz|ring|gasse|damm|ufer)|Road|Street|Avenue|Lane|Drive|Boulevard|Blvd)\s+\d{1,4}[a-zA-Z]?\b/gu,
      item => uncovered(item.index, item.index + item[0].length, 'postal_address', '地址（街道与门牌号）', item[0], 'address_line_not_product_parameter', addressNote));
    match(/(?<![\d.,])\d{4,6}\s+(?!(?:Stück|Stueck|Stk|Pack|Paar|Sets?|Gramm|Liter|Stunden)\b)\p{Lu}[\p{L}-]{2,}(?![\p{L}])/gu,
      item => uncovered(item.index, item.index + item[0].length, 'postal_address', '地址（邮编与城市）', item[0], 'address_line_not_product_parameter', addressNote));
    match(new RegExp(`\\b${number}[ -]*(?:g\\s*\\/\\s*m[²2]|gsm|grams?\\s+per\\s+square\\s+met(?:er|re))(?=$|[\\s,.;:)])`, 'gi'), item => add(item.index, item.index + item[0].length, 'fabric_weight_gsm', Number(item[1]), 'fabric_mass_per_area'));
    match(new RegExp(`\\b${number}\\s*(ml|millilit(?:er|re)s?|l|lit(?:er|re)s?)\\b`, 'gi'), item => add(item.index, item.index + item[0].length, 'capacity_l', Number(item[1]) * (/^m/i.test(item[2]) ? 0.001 : 1), 'volume_to_litres'));
    // 提手垂高（drop）和提手总长是两个参数：垂高是肩背时提手从袋口垂下来的长度，
    // 总长是沿提手量一圈的长度。混成一个字段会造成"提手 67 cm 被 4 英寸判冲突"这种假结论。
    // 商品档案目前只有总长、没有垂高，所以认出来之后走 not_covered；**绝不许落进 handle_length_cm**。
    const drop = (start, end, value, note) => {
      if (overlaps(start, end)) return;
      candidates.push({ start, end, original: claim.slice(start, end),
        field: 'handle_drop_cm', field_label: '提手垂高（drop）', parsed_value: value,
        method: 'handle_drop_without_profile_field', status: 'not_covered',
        reason: `商品资料目前只有提手总长，没有垂高（drop）这一项，无法对照；这不是读不懂，是档案没有该字段，也不计入证据待补。${note}`,
        source_ids: [], product_ref: productRef, expected_value: null });
    };
    const dropUnit = '(cm|mm|inches|inch|in|["\u2033]{1,2})';
    // 先认区间：`9 to 14.25 inch drop` 的两个数都属于垂高，不能只认后一个。
    match(new RegExp(`\\b${number}\\s*(?:to|-|\u2013|\u2014|~)\\s*${number}\\s*${dropUnit}\\s*(?:-\\s*)?(?:handle\\s*)?drop\\b`, 'gi'),
      item => drop(item.index, item.index + item[0].length,
        { min: Number(item[1]), max: Number(item[2]), unit: item[3].toLowerCase() }, '这是区间写的。'));
    // `Drop is 4 inches` / `handle drop: 12 cm` / `drop of 9"`
    match(new RegExp(`\\bdrop\\s*(?:is|of|:|measures?|length)?\\s*${number}\\s*${dropUnit}`, 'gi'),
      item => drop(item.index, item.index + item[0].length,
        { value: Number(item[1]), unit: item[2].toLowerCase() }, ''));
    // `12 inch drop` / `4-inch drop`
    match(new RegExp(`\\b${number}\\s*${dropUnit}\\s*(?:-\\s*)?(?:handle\\s*)?drop\\b`, 'gi'),
      item => drop(item.index, item.index + item[0].length,
        { value: Number(item[1]), unit: item[2].toLowerCase() }, ''));
    // 按尺码逐条写：`4 inches on Mini`、`9 inches on Medium`。
    // 只有整句在讲 drop 才这么理解，否则"12 on Medium"这种写法在别的品类里是数量。
    if (/\bdrop\b/i.test(claim)) {
      match(new RegExp(`\\b${number}\\s*${dropUnit}\\s+on\\s+(?:the\\s+)?(?:size\\s+)?(?:mini|small|medium|large|x-?large|xl|s|m|l)\\b`, 'gi'),
        item => drop(item.index, item.index + item[0].length,
          { value: Number(item[1]), unit: item[2].toLowerCase() }, ''));
      // `4.5 on Small`：没写单位，沿用本句前面 drop 用过的单位——**并在结果里标出来是沿用的**，
      // 不能让它看起来像商家原文写了英寸。
      const inherited = /(\d+(?:\.\d+)?)\s*(cm|mm|inches|inch|in|")\s*[^.;]{0,20}\bdrop\b/i.exec(claim)?.[2];
      if (inherited)
        match(new RegExp(`\\b${number}\\s+on\\s+(?:the\\s+)?(?:size\\s+)?(?:mini|small|medium|large|x-?large|xl)\\b`, 'gi'),
          item => drop(item.index, item.index + item[0].length,
            { value: Number(item[1]), unit: inherited.toLowerCase(), unit_inherited: true },
            `单位沿用本句前面出现的 ${inherited}，原文这个数没写单位。`));
    }
    // 数量写在 `shoulder strap` **后面**的写法，上面那几条"数在前"的规则一条都够不着：
    //   `a shoulder strap approximately 30cm hight`（商家把 height 拼成了 hight）
    //   `shoulder strap is 70 cm long`
    // 这两种说的不是一回事：hight/height/drop 是垂高（肩背时提手从袋口垂下来多长），
    // long/length 才是肩带总长。混成一个字段，就会拿 30 cm 去撞档案里的 67 cm。
    match(/\bshoulder\s+straps?\b[^.;]{0,40}?(\d+(?:\.\d+)?)\s*(cm|mm|inches|inch|in|["\u2033]{1,2})\s*(?:hight|height|high|drop|deep)\b/gi,
      item => drop(item.index, item.index + item[0].length,
        { value: Number(item[1]), unit: item[2].toLowerCase() },
        '这个数写在 shoulder strap 后面，说的是肩带垂下来的高度（垂高），不是肩带总长。'));
    match(/\bshoulder\s+straps?\b[^.;]{0,40}?(\d+(?:\.\d+)?)\s*(cm|mm|inches|inch|in|["\u2033]{1,2})\s*(?:long|length)\b/gi,
      item => uncovered(item.index, item.index + item[0].length, 'strap_length_cm', '肩带长度',
        { value: Number(item[1]), unit: item[2].toLowerCase() },
        'strap_length_without_profile_field',
        '商品资料里没有肩带长度这一项（提手总长不等于肩带长度），无法对照；这不是读不懂，是档案没有该字段，也不计入证据待补。'));
    // 肩带长度不是提手总长。真实文案写"两条提手选项"时会把肩带和短提手并列：
    // `a 27.6-inch (70 cm) long shoulder strap and a 13.4-inch (34 cm) short handle`。
    // 拿肩带去比提手，会拿 70 cm 去撞档案的 67 cm，凭空出一条"提手长度不一致"。
    // 括号里那个数是换算值，整串一起认走，别让它单独流进"读不懂"。
    match(/\b(\d+(?:\.\d+)?)\s*-?\s*(cm|mm|inches|inch|in|["'′″]{1,2})\s*(?:\(\s*(\d+(?:\.\d+)?)\s*(cm|mm|inches|inch|in)\s*\))?\s*(?:long|short|adjustable)?\s*(?:shoulder\s+)?straps?\b/gi,
      item => uncovered(item.index, item.index + item[0].length, 'strap_length_cm', '肩带长度',
        { value: Number(item[1]), unit: item[2].toLowerCase(), ...(item[3] ? { converted: Number(item[3]) } : {}) },
        'strap_length_without_profile_field',
        '商品资料里没有肩带长度这一项（提手总长不等于肩带长度），无法对照；这不是读不懂，是档案没有该字段，也不计入证据待补。'));
    // `60cm/23.6'' long handles`：同一个长度用两种单位并列写（英寸用引号）。
    // 斜杠在这里是"换算"，不是两个参数——只取第一个单位的值去对照，第二个不单独成一条。
    match(/\b(\d+(?:\.\d+)?)\s*(cm|mm|inches|inch|in)\s*\/\s*(\d+(?:\.\d+)?)\s*(["'′″]{1,2}|cm|mm|inches|inch|in)\s*-?\s*(?:long\s+)?(handles?|straps?)\b/gi, item => {
      const unit = item[2].toLowerCase(), factor = unit === 'mm' ? 0.1 : unit.startsWith('in') ? 2.54 : 1;
      const end = item.index + item[0].length;
      const secondFactor = /[\"'′″]/.test(item[4]) ? 2.54 : factorOf(axisUnit(item[4]));
      const dualUnitConflict = !close(Number(item[1]) * factor, Number(item[3]) * secondFactor);
      if (/strap/i.test(item[5]))
        return uncovered(item.index, end, 'strap_length_cm', '肩带长度',
          { value: Number(item[1]), unit, converted: Number(item[3]) * (item[4].toLowerCase().startsWith('in') || /["'′″]/.test(item[4]) ? 2.54 : 1) },
          'strap_length_without_profile_field',
          '商品资料里没有肩带长度这一项（提手总长不等于肩带长度），无法对照；这不是读不懂，是档案没有该字段，也不计入证据待补。');
      add(item.index, end, 'handle_length_cm', Number(item[1]) * factor, 'handle_length_dual_unit', dualUnitConflict ? '原文两种单位的提手长度不精确等值；不能只采用其中一个数，需核对完整原文。' : '');
    });
    // 提手宽度不是提手长度：`Both handles are 1.1 inches (2.8 cm) wide` 说的是带子有多宽。
    // 当成长度会拿 2.8 cm 去撞档案的 60 cm，凭空一条"提手长度不一致"。
    // **必须排在下面"写提手长度"那几条之前**——`handles are 1.1 inches` 会被那条通用规则先吃掉。
    match(/\bhandles?\s*(?:are|is|each)?\s*(?::)?\s*(\d+(?:\.\d+)?)\s*-?\s*(cm|mm|inches|inch|in|["'′″]{1,2})\s*(?:\(\s*(\d+(?:\.\d+)?)\s*(cm|mm|inches|inch|in)\s*\))?\s*(?:wide|in\s+width)\b/gi,
      item => uncovered(item.index, item.index + item[0].length, 'handle_width_cm', '提手宽度',
        { value: Number(item[1]), unit: item[2].toLowerCase(), ...(item[3] ? { converted: Number(item[3]) } : {}) },
        'handle_width_without_profile_field',
        '这是提手的宽度（带子有多宽），不是提手长度；商品资料里只有长度，没有宽度这一项，无法对照，也不计入证据待补。'));
    /*
     * 本地语言的提手长度。德语没有 `handle length: 67 cm` 这种冒号句式，实际写法是
     * 「Henkellänge beträgt 67 cm」「Henkel sind 67 cm lang」「lange Henkel mit 67 cm」。
     * 这几种都认不出来时，「67」会落到"读不懂的数值" —— 第 9 轮真模型跑德语，
     * 一条合规文案的 7 条 EVID-01 里有 3 条是同一个 67（提手长度，档案里明明有 67）。
     *
     * 法语同理：`anses de 60 cm`、`poignées de 60 cm`、`60 cm de long`（后面必须跟 anse/poignée，
     * 否则不知道在说哪个部位）。不认的话同一个 60 会以同一种方式落进"读不懂"。
     *
     * 两层保护：中间那段窗口里**不许出现别的数字**（`[^\d]{0,24}?`），
     * 否则 "Henkel: 2 Stück, Länge 67 cm" 会把 2 当成提手长度；
     * 小数逗号按当地写法读（67,5 cm / 60,5 cm）。
     */
    const localCm = (raw, unit) =>
      Number(String(raw).replace(',', '.')) * (/mm/i.test(unit) ? 0.1 : 1);
    match(/\b(?:Henkell(?:ä|ae)nge|Henkel|Tragehenkel|Tragegriffe?|Griffe?)\b[^\d]{0,24}?(\d+(?:[.,]\d+)?)\s*(cm|mm)\b/giu,
      item => add(item.index, item.index + item[0].length, 'handle_length_cm', localCm(item[1], item[2]), 'handle_length_de_wording', ''));
    match(/\b(\d+(?:[.,]\d+)?)\s*(cm|mm)\s*(?:lange[n]?|lang)\s+(?:Henkel|Tragehenkel|Griffe?)\b/giu,
      item => add(item.index, item.index + item[0].length, 'handle_length_cm', localCm(item[1], item[2]), 'handle_length_de_wording', ''));
    match(/\b(?:anses?|poignées?)\b[^\d]{0,24}?(\d+(?:[.,]\d+)?)\s*(cm|mm)\b/giu,
      item => add(item.index, item.index + item[0].length, 'handle_length_cm', localCm(item[1], item[2]), 'handle_length_fr_wording', ''));
    match(/\b(\d+(?:[.,]\d+)?)\s*(cm|mm)\s*(?:de\s+long|longues?)\s+(?:anses?|poignées?)\b/giu,
      item => add(item.index, item.index + item[0].length, 'handle_length_cm', localCm(item[1], item[2]), 'handle_length_fr_wording', ''));
    // 商家写提手长度的句式和写正文的句式不是一回事：`handles are 67 cm long` 这种"主系表"写法
    // 以前整句认不出来，被当成"未识别的数字"，看起来像商家缺资料，其实是解析器窄。
    // 三种写法都要认：`handle length: 67 cm`（冒号/直接跟数）、`handles are 67 cm`（系动词）、`67 cm long handles`（前置定语）。
    match(new RegExp(`\\bhandles?(?:\\s+length)?\\s*(?::|measures?|is|are|comes?\\s+in|of)?\\s*${number}[ -]*(cm|mm|inches|inch|in)\\b|\\b${number}[ -]*(cm|mm|inches|inch|in)[ -]*(?:long[ -]*)?handles?\\b`, 'gi'), item => {
      const unit = (item[2] || item[4]).toLowerCase(), factor = unit === 'mm' ? 0.1 : unit.startsWith('in') ? 2.54 : 1;
      const raw = item[1] || item[3], value = Number(raw) * factor;
      add(item.index, item.index + item[0].length, 'handle_length_cm', value, 'handle_length_to_cm', '');
    });
    // `13.4-inch (34 cm) short handle`：括号里是换算值，整串一起认走。
    // 不整串认的话，`13.4-inch` 与 `34 cm` 会各留一处"读不懂"，还可能被别处当成另一个参数。
    match(/\b(\d+(?:\.\d+)?)\s*-?\s*(cm|mm|inches|inch|in|["'′″]{1,2})\s*(?:\(\s*(\d+(?:\.\d+)?)\s*(cm|mm|inches|inch|in)\s*\))?\s*(?:long|short|adjustable)\s*-?\s*handles?\b/gi, item => {
      const unit = axisUnit(item[2]), factor = factorOf(unit);
      const raw = item[1];
      add(item.index, item.index + item[0].length, 'handle_length_cm', Number(raw) * factor,
        item[3] ? 'handle_length_dual_unit' : 'handle_length_to_cm',
        item[3] && !close(Number(raw) * factor, Number(item[3]) * factorOf(axisUnit(item[4]))) ? '原文括号内外的提手长度不精确等值；需核对两个数及单位。' : '');
    });
    // `13 inch wide and 17 inch length`：用单词代替乘号写的两个尺寸。wide 能对上宽度，
    // 但 length 说的是袋身高还是前后厚度，原文没说；只登记这一处，不猜轴的含义。
    match(/\b(\d+(?:\.\d+)?)\s*-?\s*(cm|mm|inches|inch|in|["'′″]{1,2})\s+wide\b/gi, item => {
      const headEnd = item.index + item[0].length;
      const second = /^\s*(?:and|,)?\s*(\d+(?:\.\d+)?)\s*-?\s*(?:cm|mm|inches|inch|in|["'′″]{1,2})?\s*(?:long|length|tall|high|deep)\b/i
        .exec(claim.slice(headEnd, headEnd + 50));
      // 档案里**有**尺寸字段，缺的是原文没说清哪一轴——这属于"商家能补"，所以走 needs_review，
      // 不走 not_covered（not_covered 的定义是"档案没有这个字段，商家补不了"）。
      add(item.index, second ? headEnd + second[0].length : headEnd, 'dimensions_cm',
        { first: { value: Number(item[1]), unit: item[2].toLowerCase() }, ...(second ? { second: Number(second[1]) } : {}) },
        'dimensions_written_as_words',
        '原文用 wide / length 这类字描述尺寸、没写乘号：length 指的是袋身高还是前后厚度无法确定。档案按宽 / 高 / 深三轴，硬套会把长边当高度；请商家确认轴的含义后再逐轴对照。');
    });
    // 口袋个数：`6 Inner Pockets`。它既不是容量也不是尺寸，档案里没有这一项。
    match(new RegExp(`\\b${number}\\s*(?:[A-Za-z]+\\s+){0,2}(?:pockets?|pouches)\\b`, 'gi'),
      item => uncovered(item.index, item.index + item[0].length, 'pocket_count', '口袋个数',
        { value: Number(item[1]), unit: 'count' }, 'pocket_count_without_profile_field',
        '这是口袋的个数，不是容量、也不是尺寸；商品资料里没有口袋数量这一项，无法对照，也不计入证据待补。'));
    // `Small a 13 inch laptop`：设备屏幕尺寸，不是袋子尺寸。当成袋身尺寸会把长度判错。
    match(/\b(\d+(?:\.\d+)?)\s*-?\s*(?:inch(?:es)?|in|"|″)\s+(?:laptop|tablet|notebook|ipad|macbook)\b/gi,
      item => uncovered(item.index, item.index + item[0].length, 'device_size_in', '能装下的设备尺寸',
        { value: Number(item[1]), unit: 'in' }, 'device_size_without_profile_field',
        '这是能装下的设备屏幕尺寸（多少英寸的笔记本 / 平板），不是袋子的尺寸；商品资料按袋身尺寸记录，无法对照，也不计入证据待补。'));
    // 适用年龄：`NOT INTENDED FOR USE BY CHILDREN 12 AND UNDER`、`Ages 3 and up`。
    match(/\bchildren\s+(\d+)\s+and\s+under\b|\bages?\s+(\d+)\s*(?:\+|and\s+(?:up|over|above))\b|\bnot\s+(?:intended|suitable)\s+for\s+(?:children\s+)?(?:under|below)\s+(\d+)/gi,
      item => uncovered(item.index, item.index + item[0].length, 'age_limit', '适用年龄',
        { value: Number(item[1] || item[2] || item[3]), unit: 'years' }, 'age_limit_without_profile_field',
        '这是适用年龄限制，不是商品参数（尺寸、材质这些）；商品资料里没有这一项，无法对照，也不计入证据待补。'));
    // 两个数用 x 连起来、却一个单位都没写（`15x16`）：不猜是厘米还是英寸——猜错就是给商家
    // 一条凭空的"尺寸不一致"。但字段是有的、商家也补得了，所以走 needs_review 而不是 not_covered。
    match(new RegExp(`\\b${number}\\s*[x×]\\s*${number}\\b(?!\\s*(?:cm|mm|inches|inch|in|["'′″]))`, 'gi'), item =>
      add(item.index, item.index + item[0].length, 'dimensions_cm',
        { first: Number(item[1]), second: Number(item[2]) }, 'dimension_pair_without_unit',
        '这串写了两个数、没写单位，不知道是厘米还是英寸；换成任何一个都是编的。请商家确认单位后再逐轴对照。'));
    // 只写了一个带英寸符号的数（`DALIX 20"`、`3.9'' flat bottom`）：是哪一轴不知道。
    match(new RegExp(`\\b${number}\\s*["'′″]{1,2}(?!\\s*[x×]?\\s*\\d)`, 'g'), item =>
      add(item.index, item.index + item[0].length, 'dimensions_cm',
        { value: Number(item[1]), unit: 'in' }, 'dimension_single_axis',
        '原文只写了一个长度，没说这是宽、高还是深；档案按宽 / 高 / 深记录，硬套会把宽当高，所以不猜，请商家确认这是哪一轴。'));
    // 洗后缩水率：`5%-10% shrinkage may be expected after first wash` 是护理说明里的数值，档案没有这一项。
    if (/shrink/i.test(claim)) {
      match(/\b(\d+(?:\.\d+)?)\s*%\s*(?:-|–|~|to)\s*(\d+(?:\.\d+)?)\s*%/gi,
        item => uncovered(item.index, item.index + item[0].length, 'shrinkage_percent', '洗后缩水率',
          { min: Number(item[1]), max: Number(item[2]), unit: 'percent' }, 'shrinkage_without_profile_field',
          '商品资料里没有"洗后缩水率"这一项，无法对照；这是护理说明里的数值，不在当前检查范围，也不计入证据待补。'));
      match(/\b(\d+(?:\.\d+)?)\s*%\s*shrink\w*/gi,
        item => uncovered(item.index, item.index + item[0].length, 'shrinkage_percent', '洗后缩水率',
          { value: Number(item[1]), unit: 'percent' }, 'shrinkage_without_profile_field',
          '商品资料里没有"洗后缩水率"这一项，无法对照；这是护理说明里的数值，不在当前检查范围，也不计入证据待补。'));
      // `The washing shrinkage rate exceeds 10%`：数字写在"缩水"后面，隔了几个词。
      // 只把那个百分数登记走，别把整句话吞进来。
      match(/shrink\w*[^.;]{0,30}?(\d+(?:\.\d+)?)\s*%/gi, item => {
        const tail = String(item[0]);
        const at = item.index + tail.lastIndexOf(item[1]);
        uncovered(at, at + item[1].length + 1, 'shrinkage_percent', '洗后缩水率',
          { value: Number(item[1]), unit: 'percent', qualifier: tail.slice(0, tail.lastIndexOf(item[1])).trim() },
          'shrinkage_without_profile_field',
          '商品资料里没有"洗后缩水率"这一项，无法对照；这是护理说明里的数值，不在当前检查范围，也不计入证据待补。');
      });
    }
    // 保修期不是商品参数。`within 1 year, we will provide free replacement` 里的 1 属于售后条款：
    // 档案里没有这一项，但也不该说成"读不懂这个数"——它是我们认得、只是不归我们管的数值。
    // 只在整句有售后语义词时才这么认，免得把"12 month supply"这种真实参数也登记走。
    if (/warrant|guarantee|replacement|replace|returns?\b|refunds?|保修|售后|退换/i.test(claim)) {
      match(new RegExp(`\\b${number}\\s*[- ]?(years?|yrs?|months?|mos?)\\b`, 'gi'), item =>
        uncovered(item.index, item.index + item[0].length, 'warranty_period_months', '保修 / 更换期',
          { value: Number(item[1]), unit: /^y/i.test(item[2]) ? 'years' : 'months' },
          'warranty_period_without_profile_field',
          '这是售后条款里的期限（保修或免费更换），不是商品参数；商品资料里没有这一项，无法对照，也不计入证据待补。'));
    }
    // 先认完整的面料单位，不能把真实 W101 的 `4.1oz/yd²` 截成 `4.1oz` 单件重量或承重。
    // 保留官方原单位，不用常见的约数换算去证明结构化 gsm；仅当 additional_facts 存有
    // 同一原文时由下方原文关联规则接管，没有对应原文就明确列为未覆盖的克重单位。
    match(new RegExp(`\\b${number}\\s*(oz|ounces?)\\s*(?:/|per\\s+)\\s*(?:yds?(?:²|\\^?2)|yards?(?:²|\\^?2)|(?:sq\\.?|square)\\s+(?:yds?|yards?))(?=$|[\\s,.;:)])`, 'gi'),
      item => uncovered(item.index, item.index + item[0].length, 'fabric_weight_oz_per_yd2', '面料克重（oz/yd² 原单位）',
        { value: Number(item[1]), unit: 'oz/yd²' }, 'fabric_mass_per_area_original_unit',
        '这是每平方码的面料克重，不是单件重量或承重；仅按已记录的同单位原文关联，不从 g/m² 推导约数等价。'));
    // 单件重量：认得出这是重量，但商品资料里没有"重量"这一项（fabric_weight_gsm 是每平方米克重，
    // 不是单件重量）。这里既不能硬塞进克重字段，也不能说成"读不懂这个数"——要说清"档案没有这个字段"。
    // 只认不可能与克重混用的单位；裸 `g` 只在有明确过秤动词时才当重量（"140 g" 多半指克重）。
    const weigh = (item, raw, unit) => {
      if (overlaps(item.index, item.index + item[0].length)) return;
      // `10 kg carrying capacity` 说的是承重（能装多重），不是单件重量。
      // 以前它被当成"商品没有重量字段"——理由是错的：我们其实是没有承重这一项。
      const end = item.index + item[0].length;
      const before = claim.slice(Math.max(0, item.index - 48), item.index).split(/[;；,，]/).at(-1) || '';
      const after = claim.slice(end, end + 40).split(/[;；,，]/)[0];
      // `weighs 10 oz; holds 22 lbs` 的两个数属于不同属性。也不把下一分号中的
      // carried 当作承重词：旧 /carries?/ 会匹配 carried 的前缀 carrie。
      const explicitProductWeight = /^(?:weighs?|weighing|weight\s+of)\b/i.test(item[0]) ||
        /\b(?:weighs?|weighing|weight(?:\s+of)?|(?:item|product|net|bag|tote)\s+weight)\s*(?::|=|is)?\s*(?:about|approximately|approx\.?|around)?\s*$/i.test(before);
      const around = before + item[0] + after;
      if (!explicitProductWeight && /\b(?:(?:carrying|weight)\s+capacity|load|holds?|supports?|carry|carries|bears?)\b|承重|载重/i.test(around)) {
        // 承重现在是档案里有的字段：填了就按 kg 对照（lb 按定义换算），没填就只说"还没填"，
        // 由 FACT-01 去报"承重尚未确认"——两个地方不要各说一套。
        const pounds = /^(?:lb|pound)/i.test(unit);
        const factor = pounds ? 0.45359237 : /^(?:oz|ounce)/i.test(unit) ? 0.028349523125 : /^(?:g|gram)/i.test(unit) ? 0.001 : 1;
        const kg = Number(raw) * factor;
        if (usable('rated_load_kg')) {
              return add(item.index, item.index + item[0].length, 'rated_load_kg', kg, 'rated_load_to_kg', '', { allowUpTo: true });
        }
        return add(item.index, item.index + item[0].length, 'rated_load_kg', kg,
          'rated_load_to_kg', '', { allowUpTo: true });
      }
      candidates.push({ start: item.index, end: item.index + item[0].length, original: item[0],
        field: 'product_weight', field_label: '单件重量', parsed_value: { value: Number(raw), unit },
        method: 'weight_unit_without_profile_field', status: 'not_covered',
        reason: '商品资料目前没有单件重量这一项（只有面料克重 g/m²），无法对照；这不是读不懂，是档案没有该字段，也不计入证据待补。',
        source_ids: [], product_ref: productRef, expected_value: null });
    };
    match(new RegExp(`(?:strength\\s+tested\\s+to|tested\\s+to|breaking\\s+(?:strength|load)(?:\\s+of)?)\\s*(?:about|approx\\.?|up\\s+to)?\\s*${number}\\s*(lbs?|pounds?|kg|kilograms?)\\b`, 'gi'),
      item => uncovered(item.index, item.index + item[0].length, 'breaking_strength', '破坏强度（拉到多少才断）',
        { value: Number(item[1]), unit: /^(?:lb|pound)/i.test(item[2]) ? 'lb' : 'kg' },
        'breaking_strength_without_profile_field',
        '这是"拉到多少才断"的测试值，不是额定承重（能装多重），也不是单件重量；当成承重等于替商家宣称一个它没承诺的载重。商品资料里没有这一项，也不计入证据待补。'));
    match(new RegExp(`\\b${number}\\s*(oz|ounce(?:s)?|lb|lbs|pound(?:s)?|kg|kilograms?|gram(?:s)?)\\b`, 'gi'),
      item => weigh(item, item[1], item[2]));
    match(new RegExp(`\\b(?:weighs?|weighing|weight\\s+of)\\s*(?:about|approx\\.?|around)?\\s*${number}\\s*g(?![\\/\\w])`, 'gi'),
      item => weigh(item, item[1], 'g'));
    // 多个包装规格并列（`2 | 6 | 12 Pack`、`6/12/24/48/ 96 Pack`）：真实 Listing 里很常见——
    // 一个页面卖多种件数，标题把可选规格写一排。这里有两个坑，都得躲开：
    //   1. **不许把最后一个数当成零售件数**：`12 Pack` 会被下面那条单值正则认成"每包 12 件"，
    //      与档案的 4 件一撞，就给商家一条凭空的"包装件数与档案冲突"（真实样本里确实发生了）；
    //   2. 也不许说"读不懂"：我们认得出这是多个可选规格，只是档案里没有"并列规格"这一项。
    match(new RegExp(`\\b(\\d+(?:\\.\\d+)?)(?:\\s*[/|]\\s*\\d+(?:\\.\\d+)?)+\\s*-?\\s*(?:packs?|pcs|count)\\b`, 'gi'), item => {
      const start = item.index, end = start + item[0].length;
      if (overlaps(start, end)) return;
      const options = [...item[0].matchAll(/\d+(?:\.\d+)?/g)].map(part => Number(part[0]));
      candidates.push({ start, end, original: item[0],
        field: 'retail_pack_count_options', field_label: '并列的包装规格',
        parsed_value: { options },
        method: 'multi_pack_options_without_profile_field', status: 'not_covered',
        reason: `这句把多个包装规格并列写在一起（${options.join(' / ')}），不是单一的每包件数；商品档案只有一个零售件数，判断不了买家实际买几个。这不是读不懂，是档案没有"并列规格"这一项，也不计入证据待补。`,
        source_ids: [], product_ref: productRef, expected_value: null });
    });
    match(/\b(?:pack of|pack contains|pack contents:\s*|set of)\s*(\d+)\b|\b(\d+)\s*(?:bags?|pcs|pieces?)\s+per\s+(?:pack|set)\b|\b(\d+)[ -](?:pack|count)\b/gi, item => {
      const context = claim.slice(Math.max(0, item.index - 35), item.index);
      add(item.index, item.index + item[0].length, 'retail_pack_count', Number(item[1] || item[2] || item[3]), 'retail_count', /carton|wholesale|poly\s*bag|pricelist/i.test(context) ? '物流或批发包装数量不是零售每包件数。' : '');
    });
    // 德语的零售件数写法：`Lieferumfang: 1 Tasche`、`1 Stück`、`10er-Pack`。
    // 不加这三条，德语生成的 `Lieferumfang: 1 Tasche` 里的 `1` 会落到"数值尚不能明确关联"，
    // 2026-10-31 那次真实德语生成就多出两条这样的假警报（同一条描述在五点里复述一遍又一条）。
    // 档案里有 retail_pack_count 时能直接对上；写错件数也照样会成为冲突——这里只是把"读不懂"变成"读得懂"。
    match(/(?:Lieferumfang|Packungsinhalt|Inhalt|Verpackungseinheit)\s*:?\s*(\d{1,3})\b/gi,
      item => add(item.index, item.index + item[0].length, 'retail_pack_count', Number(item[1]), 'retail_count_de_contents'));
    match(/(?<![0-9.,])(\d{1,3})\s*(?:Stück|Stk\.?|Taschen?|Beutel|Tragetaschen?)\b/gi,
      item => add(item.index, item.index + item[0].length, 'retail_pack_count', Number(item[1]), 'retail_count_de_unit'));
    match(/(?<![0-9.,])(\d{1,3})\s*er[-\s]?Pack\b/gi,
      item => add(item.index, item.index + item[0].length, 'retail_pack_count', Number(item[1]), 'retail_count_de_pack'));
    // "包里包含什么"和"每包几件"是两个概念。真实文案有两种写法：
    //   `you will get 20 pieces of plain canvas tote bags and 20 pieces of cosmetic bag`
    //   `Package includes: 10 x Canvas bags ... 10 x Makeup bags`
    // 说的是"这一单里有几种东西、各几件"，不是单一品类的零售件数。硬塞进 retail_pack_count
    // 会拿 20 或 10 去撞档案的 4 件，凭空给出一条"包装件数与档案冲突"。
    const contents = (start, end, value) => uncovered(start, end, 'pack_contents_count', '包内清单件数',
      { value, unit: 'pieces' }, 'pack_contents_without_profile_field',
      '这是"包内包含什么"的件数（一单里有几种东西、各几件），不是单一品类的零售件数；商品资料只有一个零售件数，判断不了组合装各是什么，也不计入证据待补。');
    match(new RegExp(`\\b${number}\\s*(?:pieces?|pcs)\\s+of\\b`, 'gi'),
      item => contents(item.index, item.index + item[0].length, Number(item[1])));
    // `10 x Canvas bags`：`N x` 没写单位，只因紧跟着商品名词才当件数；不是尺寸（尺寸后面跟的是数字）。
    // 这里的左边界不能用 `\b`：真实文案会把两段拼在一起（`Canvas bags with zipper10 x Makeup bags`），
    // `zipper` 和 `10` 都是词字符、中间没有词边界，`\b` 一上去整段就失效了。
    // 只管住"前面不是数字或小数点"——那才会把 `1.5 x 2` 这种尺寸的数拆出一个来。
    match(new RegExp(`(?<![0-9.])${number}\\s*x\\s+[A-Z][A-Za-z]*\\s+(?:bags?|pouches?|totes?|cases?)`, 'g'),
      item => {
        // 结尾**不能**用 `\b`：真实文案是 `...Canvas bags with zipper10 x Makeup bagsNotes: ...`，
        // `bagsNotes` 中间没有词边界，`\b` 会让整条失效（这就是原来那 1 个读不懂的数字）。
        // 改成事后看一个字符：后一个字符是小写字母，说明停在了半个单词里（`baggage`），那不算。
        if (/[a-z]/.test(claim.charAt(item.index + item[0].length))) return;
        contents(item.index, item.index + item[0].length, Number(item[1]));
      });
    // `2 Pcs Canvas Tote Bags`：`Pcs/pieces` 后面紧跟商品名词时，说的就是这一单有几件——
    // 这是真正的零售件数，可以和档案的 retail_pack_count 对照，不该留在"读不懂"里。
    // 必须限定"后面跟着商品名词"：光写 `20 Pcs` 可能指包内某一种东西，猜成零售件数就是给一条假冲突。
    // 排在 `N pieces of` 之后：那种是包内清单，先认走，这条就自动跳过（overlaps）。
    match(new RegExp(`(?<![0-9.])${number}\\s*(?:pcs|pieces?)\\b[\\s.,-]*(?:[A-Za-z][A-Za-z-]*\\s+){0,3}?(?:bags?|pouches?|totes?|cases?|sets?)`, 'gi'),
      item => {
        if (/[a-z]/.test(claim.charAt(item.index + item[0].length))) return;
        add(item.index, item.index + item[0].length, 'retail_pack_count', Number(item[1]), 'retail_count_with_pieces');
      });
    // 含量百分比：`100% 10oz cotton canvas`、`100% recycled natural cotton` 里的 100% 说的是材质含量，
    // 中间隔几个修饰词也得认——中间那个 `10oz` 是克重，已经被上面那条认走了。
    const percentParts = [];
    // 纤维写法只认 material.mjs 那一份表（英文 + 德语整词）。这里原来自己列了一遍
    // `cotton|polyester|nylon|linen`，于是加德语写法时只改了一处，德语文案照样认不出来。
    match(new RegExp(`(?<![0-9.,])${percentNumber}\\s*%\\s*((?:[A-Za-z0-9.]+\\s+){0,3})(${FIBER_PATTERN}|${CHINESE_FIBER_PATTERN})(?![\\p{L}\\p{N}])`, 'giu'), item => {
      // 中间那 0–3 个修饰词本来是为了放过 `100% 10oz cotton`、`100% recycled natural cotton`，
      // 却把**比较句**也放进来了：真实文案 `the price is about 60% higher than the polyester cotton
      // fabric with same weight` 会被读成"含 60% 涤纶"，与档案的 100% 棉一撞，
      // 凭空一条「材质不一致」——拿一句比价的话当成分，比漏认严重得多。带比较词的一律不按含量算。
      if (/\b(?:than|higher|lower|more|less|cheaper|dearer|heavier|lighter|off|save|saving|discount)\b/i.test(item[2])) return;
      const fiber = canonicalFiber(item[3]);
      // 内衬/缝线用涤纶不等于袋身是涤纶。这类说法先按"档案没有内衬这一项"登记，不当成分冲突。
      // 传 end 是为了让 `100% polyester lining` 这种"层名在纤维后面"的写法也能认出来。
      const context = claimContext(claim, item.index, item.index + item[0].length);
      if (context.comparison) return;
      const percent = percentValue(item[1]);
      const fact = usable('material');
      // `100% polyester lining`（层名在纤维后面）和 `Inside made of polyester-cotton`（层名在前面）
      // 是同一件事：内衬的百分比不是袋身成分，既不进成分合计，也不该报成袋身材质不一致。
      if (context.layer !== 'body') {
        const inner = context.layer === 'inner';
        uncovered(item.index, item.index + item[0].length,
          inner ? 'lining_material' : 'auxiliary_material',
          inner ? '内衬材质' : '辅料材质（缝线/拉链布）',
          { value: `${percent}% ${fiberLabel(fiber)}`, unit: 'percent_fiber' },
          inner ? 'lining_composition_without_profile_field' : 'auxiliary_composition_without_profile_field',
          `这句说的是${inner ? '内衬' : '辅料'}的成分为 ${percent}% ${fiberLabel(fiber)}，商品资料只有袋身材质（${fact?.value ?? '未知'}），没有${inner ? '内衬' : '辅料'}这一项；既不算核对通过，也不算商家缺证据。`);
        return;
      }
      percentParts.push({ fiber, percent, start: item.index, end: item.index + item[0].length });
      const verdict = fact ? compareFiber(parseComposition(fact.value), fiber, percent) : null;
      const supported = verdict?.state === 'match';
      // 只登记百分数本身（`100%`）：整串一起登记会压到中间已经认走的克重（`10oz`）上，
      // `overlaps()` 会让这条整段失效——上一版就是这么写的，看着加了规则其实一条没生效。
      add(item.index, item.index + String(item[0]).indexOf('%') + 1, 'material', supported ? fact.value : item[0], 'material_percentage',
        verdict?.state === 'unknown_composition' ? verdict.note : '', { conflictReason: verdict ? verdict.note : '' });
    });
    match(new RegExp(`(?<![\\p{L}\\p{N}])(${FIBER_PATTERN}|${CHINESE_FIBER_PATTERN})(?![\\p{L}\\p{N}])`, 'giu'), item => {
      // 含量百分比那条已经认过这个材质词了，别再登记一次——否则同一句会出现两行一模一样的关联。
      if (/\d+(?:[.,]\d+)?\s*%\s*(?:[A-Za-z0-9.]+\s+){0,3}$/i.test(claim.slice(Math.max(0, item.index - 28), item.index))) return;
      const fiber = canonicalFiber(item[1]);
      const context = claimContext(claim, item.index, item.index + item[0].length);
      // `cheaper than polyester`、`same weight as nylon` 是打比方，不是成分声明。
      if (context.comparison) return;
      const fact = usable('material');
      // 内衬、缝线、拉链布用的纤维：档案里**没有**"内衬材质"这个字段，
      // 拿它去撞袋身材质会凭空给出一条"材质不一致"（真实样本 `Inside made of polyester-cotton`
      // 就是这个情况）。按"认得出、但档案没有对应字段"登记，报告里会单列成一节。
      if (context.layer !== 'body') {
        const inner = context.layer === 'inner';
        uncovered(item.index, item.index + item[0].length,
          inner ? 'lining_material' : 'auxiliary_material',
          inner ? '内衬材质' : '辅料材质（缝线/拉链布）',
          { value: item[1], unit: 'fiber' }, inner ? 'lining_fiber_without_profile_field' : 'auxiliary_fiber_without_profile_field',
          `这句说的是${inner ? '内衬' : '辅料'}用的是${fiberLabel(fiber)}，商品资料只有袋身材质（${fact?.value ?? '未知'}），没有${inner ? '内衬' : '辅料'}这一项；既不算核对通过，也不算商家缺证据。`);
        return;
      }
      const verdict = fact ? compareFiber(parseComposition(fact.value), fiber, null) : null;
      const supported = verdict?.state === 'match' || verdict?.state === 'presence';
      add(item.index, item.index + item[0].length, 'material', supported ? fact.value : item[0], 'material_presence_only', verdict?.state === 'unknown_composition' ? verdict.note : '',
        { conflictReason: verdict ? verdict.note : '' });
    });
    const blend = /\b(?:blends?|mixed\s+fib(?:er|re)s?)\b/i.exec(claim);
    const bodyComposition = usable('material');
    if (blend && bodyComposition && claimContext(claim, blend.index, blend.index + blend[0].length).layer === 'body') {
      const composition = parseComposition(bodyComposition.value);
      if (!composition.blend && composition.fibers.length === 1 && close(composition.percents[composition.fibers[0]], 100))
        add(blend.index, blend.index + blend[0].length, 'material', blend[0], 'material_blend_vs_pure', '',
          { conflictReason: '文案宣称混纺，但商品资料确认的是纯成分「' + bodyComposition.value + '」；需核对袋身材质。' });
    }
    // 一句里写了两个以上成分百分比时，合计必须是 100%。只数**已经认成成分**的那几处，
    // 不去文本里自己再找一遍——否则 `save 20%` 会被算进成分合计，凭空报一条"合计 120%"。
    const total = compositionTotal(percentParts, claim);
    const totalNote = compositionTotalNote(total);
    if (totalNote) {
      const from = percentParts[0].start;
      const to = percentParts.reduce((max, x) => Math.max(max, x.end), from);
      candidates.push({ start: from, end: to, original: claim.slice(from, to), field: 'material',
        parsed_value: total.total, method: 'material_total_percent', status: 'needs_review',
        reason: `${totalNote}（这句里一共 ${total.parts.length} 个成分百分比。）`,
        source_ids: [], product_ref: productRef, expected_value: null });
    }
    // 认得出这是百分比、却不知道是"什么的百分比"：`HIGH QUALITY CANVAS - 100% Premium 18 oz.`
    // 这里的 100% 后面没有纤维名（CANVAS 是织法，不是纤维），所以它既不能拿去比材质，
    // 也不该说成"读不懂这个数"——它就是一句没说清指向的百分比。
    // 标签刻意写得中性：除了成分含量，真实文案里还有 `the price is about 60% higher than ...` 这种比价，
    // 一律叫"含量百分比"会把比价说成成分，所以这里只说"百分比（没说清指什么）"。
    // 判据还是那一条：**商家补得了**（说清这个百分比是什么）→ needs_review，不是 not_covered。
    // 排在材质百分比之后：`100% cotton` 已经被认走的，这里靠 overlaps 自动跳过。
    match(new RegExp(`(?<![0-9.,])${percentNumber}\\s*%(?![0-9])`, 'g'), item => {
      const start = item.index, end = start + item[0].length;
      if (overlaps(start, end)) return;
      // `50% off`、`save 20%` 说的是折扣，不是成分。折扣词可能写在百分数**前面**（save 20%）
      // 也可能写在**后面**（50% off），两边都得看——只挡前面是挡不住的（这条测试第一次就红了）。
      const before = claim.slice(Math.max(0, start - 14), start);
      const after = claim.slice(end, end + 12);
      if (/(?:\b(?:off|save|saving|savings|discount|less|coupon)\s*)$/i.test(before) || /^\s*(?:off|discount|savings)\b/i.test(after)) return;
      /*
       * 「百分比后面紧跟一个德语名词」= 这是配方里的一个成分，只是纤维名**不在认得的那几种里**。
       * 例：`99,5 % Baumwolle, 0,5 % Elasthan` —— Elasthan 不在 FIBERS（只认棉/涤纶/尼龙/亚麻）。
       * 报成"没说清指什么"是错的：原文说得很清楚，是**我们**认不出这个词。
       * 按这一层的总原则处理（认不出只是没关联，不会变成说错了），落到 not_covered：
       * 既不算核对通过，也不算商家缺证据。
       *
       * 只在**同一句里已经有一个认得出的「百分比 + 纤维」对**时才这么判 ——
       * 那说明这句正在列配方；`100 % Premium 18 oz.` 这种没有配方语境的，仍按"没说清"报。
       * 边界（写在这里，不假装没有）：德语名词首字母必大写，所以 `50 % Rabatt` 这种促销写法
       * 在配方句里会被当成"认不出的纤维"。宁可这样，也不要把一句合规的配方判成商家没说清——
       * 促销语本身另有规则拦。
       */
      const namedFiber = /^\s+(\p{Lu}\p{Ll}{2,})(?![\p{Lu}\p{Ll}])/u.exec(claim.slice(end, end + 24));
      if (percentParts.length && namedFiber) {
        candidates.push({ start, end, original: item[0], field: 'composition_percent_unrecognized_fiber',
          field_label: '成分百分比（纤维名认不出）',
          parsed_value: { value: percentValue(item[1]), unit: 'percent', fiber_word: namedFiber[1] },
          method: 'composition_fiber_outside_known_fibers',
          status: 'not_covered',
          reason: `这是配方里的一个成分百分比，后面写的是「${namedFiber[1]}」，但这个纤维名不在本地认得的那几种里（只认棉、涤纶、尼龙、亚麻及它们的德文写法），认不出它是什么纤维；既不按核对通过，也不算商家缺证据，需人工确认。`,
          source_ids: [], product_ref: productRef, expected_value: null });
        return;
      }
      candidates.push({ start, end, original: item[0], field: 'percentage_without_referent',
        field_label: '百分比（原文没说清指什么）',
        parsed_value: { value: percentValue(item[1]), unit: 'percent' }, method: 'percentage_without_referent',
        status: 'needs_review',
        reason: '这句里有一个百分比，但原文没说清它是"什么的百分比"——是成分含量、价格高低、还是合格率，光看这一句判断不了，所以没有可以对照的字段。请商家说明这个百分比指的是什么。',
        source_ids: [], product_ref: productRef, expected_value: null });
    });
    for (const field of ['brand', 'color']) {
      const fact = usable(field);
      if (!fact || typeof fact.value !== 'string' || fact.value.length < 2) continue;
      match(new RegExp(`(?<![A-Za-z0-9_])${escape(fact.value)}(?![A-Za-z0-9_])`, 'gi'), item => add(item.index, item.index + item[0].length, field, fact.value, 'exact_fact_text'));
    }
    // A public model identifier is identity metadata, not a numerical specification.
    const model = profile?.reference_product_id;
    const identitySpans = typeof model === 'string' && model ? [...claim.matchAll(new RegExp(`(?<![A-Za-z0-9_])${escape(model)}(?![A-Za-z0-9_])`, 'gi'))].map(item => ({ start: item.index, end: item.index + item[0].length })) : [];
    for (const [field] of allFacts) {
      if (!field.startsWith('additional_facts.')) continue;
      const fact = usable(field); if (!fact || typeof fact.value !== 'string' || fact.value.length < 5) continue;
      const pattern = escape(fact.value).replace(/\s+/g, '\\s*').replace(/(?<=\d)(?=[a-zA-Z])/g, '\\s*').replace(/\//g, '\\s*/\\s*');
      match(new RegExp(pattern, 'gi'), item => {
        // An exact recorded excerpt can supply an otherwise unmodeled raw parameter.
        // Preserve its original unit; never override a conflict with a structured fact.
        const recorded = candidates.filter(candidate => candidate.status === 'not_covered' && candidate.start >= item.index && candidate.end <= item.index + item[0].length);
        for (const candidate of recorded) {
          candidates.splice(candidates.indexOf(candidate), 1);
          add(candidate.start, candidate.end, field, fact.value, 'recorded_original_parameter');
        }
        add(item.index, item.index + item[0].length, field, fact.value, 'recorded_excerpt_spacing_only');
      });
    }
    // Unparsed numbers cannot borrow support from a different attribute.
    const ordinals = ordinalSpans(claim);
    match(/\d+(?:\.\d+)?/g, item => {
      const start = item.index, end = start + item[0].length;
      if (overlaps(start, end) || identitySpans.some(span => start >= span.start && end <= span.end)) return;
      // 列表序号不是参数，不当"读不懂"，也不该进覆盖率分母。
      if (ordinals.some(span => start >= span.start && end <= span.end)) return;
      add(start, end, 'unclassified_parameter', item[0], 'unclassified_number', '数值尚不能明确关联到具体商品字段和单位，需进一步核对。');
    });
    // 归一化再判：从 Word 粘过来的 `eco‑friendly`（U+2011）不该被当成"不是宣称"。
    const claimForMatch = normalizeForMatch(claim);
    const isSensitive = sensitive.test(claimForMatch) || ECO_CLAIM_PATTERN.test(claimForMatch) || PERFORMANCE_CLAIM_PATTERN.test(claimForMatch);
    if (!candidates.length && !isSensitive) return [];
    candidates.sort((a, b) => a.start - b.start);
    const parameterLinks = candidates.filter(item => item.status === 'matched');
    // 认得出、但商品档案里没有对应字段的参数：既不算核对通过，也不算证据缺失。
    // 商家没法"补"一个我们数据模型里不存在的字段，所以不能把它塞进待补资料。
    const notCovered = candidates.filter(item => item.status === 'not_covered');
    const unresolved = candidates.filter(item => item.status !== 'matched' && item.status !== 'not_covered');
    const facts = [...new Map(parameterLinks.map(link => [link.field, { field: link.field, value: link.value, source_ids: link.source_ids }])).values()];
    const mappings = claimMap.filter(mapping => mapping.field_path === path && mapping.claim && (claim.includes(mapping.claim) || mapping.claim.includes(claim)));
    const modelMapped = mappings.some(mapping => facts.some(fact => mapping.source_ids?.some(id => fact.source_ids.includes(id))));
    const allParametersLinked = !unresolved.length && !notCovered.length && parameterLinks.length > 0;
    const aligned = allParametersLinked && !isSensitive;
    const notCoveredNote = notCovered.length ? `另有 ${notCovered.length} 处参数不在当前检查范围（商品资料没有对应字段，未判定对错）：${notCovered.map(item => `${item.original} → ${item.field_label || item.field}`).join('；')}。` : '';
    const notCoveredOnly = notCovered.length && !parameterLinks.length
      ? `这句话里的 ${notCovered.length} 处参数${notCovered.length > 1 ? '都' : ''}不在当前检查范围（商品资料没有对应字段，未判定对错）：${notCovered.map(item => `${item.original} → ${item.field_label || item.field}`).join('；')}；整句语义及宣称另行审阅。`
      : null;
    const reason = isSensitive ? '含认证、环保或性能等宣称；参数关联不能证明适用条件或宣称成立，仍需语义审阅及相应证据。'
      : unresolved.length ? unresolved.map(item => `${item.original}：${item.reason}`).join('；')
      : notCoveredOnly || `已由程序逐项关联商品参数和记录来源，不依赖模型返回引用；${notCoveredNote}整句语义及宣称另行审阅。`;
    // mapped 表示"这句既已逐项关联参数，引用本身也落在这些参数的记录来源上"。
    // 只引用平台政策/规则来源不能把商品参数标记为已映射；没有引用时映射交由 state 表达。
    const mapped = allParametersLinked && (!mappings.length || modelMapped);
    return [{ field_path: path, claim, state: unresolved.length || isSensitive ? 'needs_evidence' : notCovered.length ? (parameterLinks.length ? 'partially_covered' : 'not_covered') : aligned ? 'parameters_aligned' : 'needs_evidence', facts,
      mapped, model_mapped: modelMapped,
      association_method: PARAMETER_LINK_VERSION, product_ref: productRef, parameter_links: parameterLinks,
      unresolved_parameters: unresolved, not_covered_parameters: notCovered,
      parameter_coverage: { recognized: candidates.length, matched: parameterLinks.length, unresolved: unresolved.length, not_covered: notCovered.length, whole_sentence_proven: false },
      semantic_status: 'separate_review_required',
      reason }];
  }));
}

// 报告里跟在参数后面的那句说明。**只在真按精度比对过时才说话**——
// 以前这里恒返回空串，于是"按约数精度对上"和"精确对上"在纸上一模一样。
export function approximateNote(link) {
  const approximation = link?.approximation;
  if (!approximation) return '';
  const precision = approximation.axis_tolerances_cm
    ? toleranceText(approximation.axis_tolerances_cm) : `±${approximation.tolerance_cm} cm`;
  return `；核对方式：原文自标约数并按单位换算，按原文标注的最后一位精度比对（${precision}），不是"差不多就算对"`;
}

export function evidenceText(entry) {
  return [entry.claim, `${({ parameters_aligned: '参数已关联', not_covered: '参数未在核对范围', partially_covered: '部分参数已关联，仍有未覆盖项', needs_evidence: '参数或宣称待核对' })[entry.state] || '参数或宣称待核对'}；${entry.reason}`,
    ...(entry.association_method ? [`参数关联方法：${entry.association_method}；商品快照：${entry.product_ref}；整句语义另行审阅。`] : []),
    ...(entry.parameter_links || []).map(link => `参数原文：${link.original} → ${link.field}=${JSON.stringify(link.parsed_value)}；方法：${link.method}；来源：${link.source_ids.join(', ')}；${link.product_ref}${approximateNote(link)}`),
    ...(entry.unresolved_parameters || []).map(item => `待核对参数：${item.original}；字段：${item.field}；${item.reason}`),
    ...(entry.not_covered_parameters || []).map(item => `未纳入检查的参数：${item.original}；对应：${item.field}；${item.reason}`),
    ...(entry.facts || []).map(fact => `${fact.field}=${JSON.stringify(fact.value)}；来源：${fact.source_ids.join(', ')}`)].join('\n');
}
