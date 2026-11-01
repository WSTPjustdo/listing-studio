import ExcelJS from "exceljs";
import { z } from "zod";
import {
  AppError,
  id,
  contentSchema,
  uniquePatches,
  applyPatches,
} from "./domain.mjs";
import { getConfig } from "./providers.mjs";
import { classifyError } from "./errors.mjs";
import { columns, readTable, suggestMapping } from "./flat-file.mjs";
import { ALL_LANGUAGES, DEFAULT_MARKETPLACE, languagesFor, languageTier, rulePackFor, WORKFLOW_MARKETPLACES } from './store.mjs';
import { errorSummary, describeFailure } from './errors.mjs';
import { createGovernor, AUTO_DEFAULTS } from './concurrency-governor.mjs';
import { summarizeBatch, ruleWorklist, writeOverviewSheet, writeWorklistSheet } from './batch-summary.mjs';
export { columns, readTable, suggestMapping };

const clean = (text) => String(text ?? "").trim();
// 语言名收成一张表：漏一种语言，写进提示词的就是 "undefined"。
const LANGUAGE_ZH = { en: "英文", es: "西班牙语", zh: "中文", de: "德语", fr: "法文" };

/** 连续多少行「配置类」失败就暂停整批。3 行足够排掉偶发，又不至于让用户以为程序卡住。 */
const CONFIG_FAILURE_BREAKER = 3;

export function describeRowFailure(error) {
  // 与单次运行（service.mjs 的 run.error）共用 describeFailure：
  // 同一种错在批量表和运行卡片上必须是同一句话，否则现场两处对不上。
  const detail = describeFailure(error);
  const action = detail.action;
  return { error: detail.message, error_code: detail.code,
    error_category: detail.category, error_title: detail.title,
    error_action: action, next_step: action, retryable: detail.retryable,
    ...(detail.upstream ? { error_upstream: detail.upstream } : {}) };
}
function clearFailure(row) {
  for (const key of ['error', 'error_code', 'error_category', 'error_title', 'error_action', 'next_step', 'retryable', 'error_upstream']) delete row[key];
}
function failRow(row, error) {
  Object.assign(row, describeRowFailure(error));
  (row.failure_history ||= []).push({ at: new Date().toISOString(), attempt: row.attempt || 0,
    run_id: row.run_id || null, error_code: row.error_code, error: row.error });
}
let governor = null, governorKey = null;
function activeGovernor(env = process.env) {
  if (String(env.BATCH_CONCURRENCY || '').trim().toLowerCase() !== 'auto') return null;
  const raw = Number(env.BATCH_CONCURRENCY_MAX);
  const cap = Number.isFinite(raw) && raw >= 1 ? Math.min(4, Math.floor(raw)) : AUTO_DEFAULTS.max;
  if (!governor || governorKey !== cap) { governor = createGovernor({ max: cap }); governorKey = cap; }
  return governor;
}
export function batchConcurrency(env = process.env) {
  const raw = Number(env.BATCH_CONCURRENCY || 1);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(8, Math.floor(raw)) : 1;
}
export function batchConcurrencyInfo(env = process.env) {
  const active = activeGovernor(env);
  return active ? { ...active.snapshot(), concurrency: active.slots(), source: 'BATCH_CONCURRENCY=auto' }
    : { mode: 'fixed', current: batchConcurrency(env), concurrency: batchConcurrency(env), max: 8, source: 'BATCH_CONCURRENCY' };
}

const inputSchema = z.object({
  import_id: z.string(),
  mapping: z.record(z.string(), z.number().int().min(-1).max(999)),
  operation: z.enum(["create", "diagnose", "optimize"]),
  // 这一批写哪种语言。只对 create 有意义；规则上限不随语言变。
  // 枚举收的是「所有站点所有档位里出现过的语言」，具体这批能不能用这门语言，
  // 由 SITE_LANGUAGES 按站点判（在 start() 里，报错会指出这个站能写哪几种）。
  language: z.enum(ALL_LANGUAGES).default("en"),
  // 这一批按哪个站点的规则包审。默认仍是美国站：老批次不带这个字段，行为一个字不变。
  // 以前没有这个字段，德语批次也会拿美国包出结论——那种"语言对了、依据错了"最难看出来。
  marketplace: z.enum(WORKFLOW_MARKETPLACES).default(DEFAULT_MARKETPLACE),
  duplicate: z.enum(["skip", "update", "new"]),
  confirm_scope: z.boolean(),
  selected: z.array(z.number().int()).max(2000),
  edits: z
    .record(z.string(), z.record(z.string(), z.string().max(10000)))
    .default({}),
  dry_run: z.boolean().default(false),
});
const fact = (value) => ({
  value,
  status: value === null ? "unknown" : "merchant_confirmed",
  source_ids: value === null ? [] : ["LOCAL-MERCHANT-INPUT"],
});
export function prepareRows(store, source, rawInput) {
  const input = inputSchema.parse(rawInput);
  if (source.selection_required || !source.headers.length)
    throw new AppError(
      "TABLE_SELECTION_REQUIRED",
      "请先选择商品数据工作表和正确的表头行。",
    );
  if (!input.selected.length)
    throw new AppError("NO_ROWS", "请至少选择一行商品。");
  if (
    new Set(input.selected).size !== input.selected.length ||
    input.selected.some((n) => !source.rows.some((r) => r.number === n))
  )
    throw new AppError("INVALID_ROWS", "所选行无效。");
  const assigned = Object.values(input.mapping).filter((i) => i >= 0);
  if (assigned.some((i) => i >= source.headers.length))
    throw new AppError("MAPPING", "列映射超出原表范围，请重新选择。");
  const contentColumns = [
    "title",
    "item_highlights",
    "bullet_points",
    ...Array.from({ length: 5 }, (_, i) => `bullet_point${i + 1}`),
    "description",
  ]
    .map((key) => input.mapping[key])
    .filter((index) => index >= 0);
  if (new Set(contentColumns).size !== contentColumns.length)
    throw new AppError(
      "MAPPING",
      "标题、卖点和描述不能写入同一列，请检查列映射。",
    );
  if (
    input.mapping.bullet_points >= 0 &&
    Array.from(
      { length: 5 },
      (_, i) => input.mapping[`bullet_point${i + 1}`],
    ).some((index) => index >= 0)
  )
    throw new AppError(
      "MAPPING",
      "请选择分列五点或单列换行卖点，不能同时使用。",
    );
  const products = store.products();
  const registeredSku = (product) =>
    store.libraryEntry?.(product.product_id, input.marketplace)?.sku || product.sku || "";
  const sourceValue = (row, key) =>
    clean(
      input.edits[String(row.number)]?.[key] ??
        row.cells[input.mapping[key] ?? -1],
    );
  const familyRows = source.rows.map((row) => ({
    sku: sourceValue(row, "sku"),
    parentage: sourceValue(row, "parentage").toLowerCase(),
    theme: sourceValue(row, "variation_theme"),
  }));
  const seen = new Set();
  return source.rows
    .filter((r) => input.selected.includes(r.number))
    .map((row) => {
      const values = Object.fromEntries(
        columns.map((c) => [
          c.key,
          clean(
            input.edits[String(row.number)]?.[c.key] ??
              row.cells[input.mapping[c.key] ?? -1],
          ),
        ]),
      );
      const errors = [],
        warnings = [];
      const existing = values.sku
        ? products.filter((p) => registeredSku(p) === values.sku)
        : [];
      const repeated = !!values.sku && seen.has(values.sku);
      if (values.sku) seen.add(values.sku);
      const duplicate = existing.length > 0 || repeated;
      if (duplicate && input.duplicate === "new")
        errors.push(
          "已有或重复 SKU 不能另建商品，请选择更新或跳过，避免一号对应多份商品。",
        );
      if (!values.sku)
        errors.push(
          "缺少真实 SKU：请映射 SKU 列或填写商家实际货号，不会自动生成 SKU。",
        );
      if (
        values.sku &&
        (!Number.isInteger(input.mapping.sku) || input.mapping.sku < 0)
      )
        errors.push("请把真实 SKU 对应到原表列，保证结果可以准确回填。");
      const originalSku = clean(row.cells[input.mapping.sku ?? -1]);
      if (!originalSku)
        errors.push(
          "原表 SKU 单元格为空，请在原文件填入真实货号后重新上传，避免处理后无法回填。",
        );
      if (originalSku && values.sku !== originalSku)
        errors.push("SKU 与原表不一致。请先在原文件确认货号，再重新上传。");
      if (
        originalSku &&
        familyRows.filter((item) => item.sku === originalSku).length > 1
      )
        errors.push(
          "原文件内 SKU 重复，请先确认并修正原表，不能只选择其中一行处理。",
        );
      for (const key of [
        "parent_sku",
        "parentage",
        "variation_theme",
        "relationship_type",
      ])
        if (
          input.edits[String(row.number)]?.[key] !== undefined &&
          values[key] !== clean(row.cells[input.mapping[key] ?? -1])
        )
          errors.push(
            "变体关系须在原文件确认后重新导入，不能只改变处理资料中的关系。",
          );
      const parentage = values.parentage.toLowerCase();
      const isParent = ["parent", "父", "父体"].includes(parentage);
      const isChild = ["child", "子", "子体"].includes(parentage);
      if (parentage && !isParent && !isChild)
        errors.push("父子角色请使用 parent 或 child。");
      if (values.parent_sku && !isChild)
        errors.push("填写父 SKU 时须明确子体角色 child。");
      if (isChild) {
        if (!values.parent_sku || values.parent_sku === values.sku)
          errors.push("子体须填写不同于自身的父 SKU。");
        if (!values.variation_theme) errors.push("子体须填写变体主题。");
        const parent = familyRows.find(
          (item) =>
            item.sku === values.parent_sku &&
            ["parent", "父", "父体"].includes(item.parentage),
        );
        const storedParent = products.find(
          (item) =>
            registeredSku(item) === values.parent_sku &&
            item.variation?.parentage === "parent",
        );
        if (!parent && !storedParent)
          errors.push("未找到对应父体，请在本表保留父体行或先导入父体资料。");
        const parentTheme = parent?.theme || storedParent?.variation?.theme;
        if (parent && !parent.theme)
          errors.push("对应父体未填写变体主题，请先修正父体资料。");
        if (parentTheme && parentTheme !== values.variation_theme)
          errors.push("父子体的变体主题不一致。");
        if (
          input.mapping.relationship_type >= 0 &&
          values.relationship_type.toLowerCase() !== "variation"
        )
          errors.push("子体关系类型须为 variation，请核对原模板。");
        const theme = values.variation_theme
          .toLowerCase()
          .replace(/[^a-z]/g, "");
        if (theme.includes("color") && !values.color)
          errors.push("颜色变体须填写当前子体的颜色。");
        if (theme.includes("size") && !values.size)
          errors.push("尺寸变体须填写当前子体的尺码。");
      }
      if (isParent && !values.variation_theme)
        errors.push("父体须填写变体主题。");
      if (repeated && input.duplicate === "update")
        errors.push(
          "同一文件内 SKU 重复；请选择跳过重复项、另存新商品，或先修正 SKU。",
        );
      if (existing.length > 1 && input.duplicate === "update")
        errors.push("已有多个同 SKU 商品，无法确定更新对象，请使用新 SKU。");
      const old = input.duplicate === "update" ? existing[0] : null;
      if (!values.name && !old && !isParent) errors.push("请填写商品名称。");
      if (
        !isParent &&
        (values.category
          ? ![
              "棉布袋",
              "棉布手提袋",
              "棉质手提袋",
              "cotton tote bag",
              "tote_bag",
            ].includes(values.category.toLowerCase())
          : !input.confirm_scope)
      )
        errors.push("当前只支持棉布手提袋；请确认品类或排除此行。");
      const number = (key, max, unit = "") => {
        if (!values[key]) return null;
        const match = values[key].match(
          new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:${unit || "(?!)"})?$`, "i"),
        );
        const value = match ? Number(match[1]) : NaN;
        if (
          !Number.isFinite(value) ||
          value <= 0 ||
          value > max ||
          (key === "retail_pack_count" && !Number.isInteger(value))
        ) {
          errors.push(
            `${columns.find((c) => c.key === key).label}格式无效，请按标注单位填写正数。`,
          );
          return null;
        }
        return value;
      };
      function dimension(key) {
        const raw = values[key];
        if (!raw) return null;
        const match = raw.match(
          /^(\d+(?:\.\d+)?)\s*(mm|cm|inches|inch|in|毫米|厘米|英寸)?$/i,
        );
        const sharedUnit = () => {
          const from = axis => values[`${axis}_unit`] || values[axis]?.match(/(mm|cm|inches|inch|in|毫米|厘米|英寸)\s*$/i)?.[1];
          const left = from('width')?.toLowerCase(), right = from('height')?.toLowerCase();
          const header = source.headers[input.mapping.depth] || '';
          return header.match(/(?:^|[^a-z])(mm|cm|inches|inch|in|毫米|厘米|英寸)(?:$|[^a-z])/i)?.[1] || (left && left === right ? left : '');
        };
        const unit = (
          match?.[2] ||
          values[`${key}_unit`] ||
          (key === 'depth' ? sharedUnit() : "cm")
        ).toLowerCase();
        const factor = {
          mm: 0.1,
          毫米: 0.1,
          cm: 1,
          厘米: 1,
          in: 2.54,
          inch: 2.54,
          inches: 2.54,
          英寸: 2.54,
        }[unit];
        const value = match && factor ? Number(match[1]) * factor : NaN;
        if (!Number.isFinite(value) || value <= 0 || value > 1000) {
          errors.push(
            `${({ width: '宽度', height: '高度', depth: '深度' })[key]}或单位无效，请明确使用 mm、cm 或 inch。`,
          );
          return null;
        }
        return Number(value.toFixed(6));
      }
      const width = dimension("width"), height = dimension("height");
      let depth = dimension('depth');
      const depthProvided = input.mapping.depth >= 0
        || Object.prototype.hasOwnProperty.call(input.edits[String(row.number)] || {}, 'depth');
      // A file without a depth column does not revoke a previously confirmed third axis.
      // When depth is mapped or explicitly edited, a blank remains unknown as in the source file.
      if (width !== null && height !== null && !depthProvided && depth === null
        && Number.isFinite(old?.dimensions_cm?.value?.depth))
        depth = old.dimensions_cm.value.depth;
      if (depth !== null && (width === null || height === null)) errors.push('三维尺寸须同时提供宽度、高度和明确单位，未采用不完整尺寸。');
      if ((width === null) !== (height === null))
        warnings.push("尺寸不完整，不生成尺寸描述。");
      const product = old
        ? structuredClone(old)
        : {
            product_id: id("product"),
            revision: 0,
            is_demo: false,
            reference_product_id: null,
            application_product_type: "tote_bag_demo",
            rated_load_kg: fact(null),
            degradation_evidence: [],
            certification_evidence: [],
            performance_evidence: [],
            publication_readiness: "not_verified",
          };
      product.revision++;
      product.name_zh = values.name || old?.name_zh;
      product.sku = values.sku;
      product.variation = {
        parent_sku: values.parent_sku,
        parentage: isParent ? "parent" : isChild ? "child" : "",
        theme: values.variation_theme,
        relationship_type: values.relationship_type,
        size: values.size,
      };
      product.imported_table = true;
      const attrs = {
        material: values.material || null,
        dimensions_cm:
          width !== null && height !== null ? { width, height, ...(depth !== null ? { depth } : {}) } : null,
        fabric_weight_gsm: number("fabric_weight_gsm", 3000, "g/m[²2]|gsm"),
        capacity_l: number("capacity_l", 1000, "l"),
        handle_length_cm: number("handle_length_cm", 1000, "cm"),
        retail_pack_count: number("retail_pack_count", 10000),
        rated_load_kg: number('rated_load_kg', 1000, 'kg'),
        brand: values.brand || null,
        color: values.color || null,
      };
      for (const [key, value] of Object.entries(attrs))
        if ((!old || value !== null) && JSON.stringify(old?.[key]?.value) !== JSON.stringify(value)) {
          product[key] = fact(value);
          if (product.fact_sources) delete product.fact_sources[key];
        }
      if (!product.material?.value) warnings.push("材质未确认，不推测材质。");
      if (!product.dimensions_cm?.value)
        warnings.push("尺寸未确认，不生成尺寸描述。");
      const content = {
        title: values.title,
        item_highlights: values.item_highlights,
        bullet_points: (Array.from(
          { length: 5 },
          (_, i) => values[`bullet_point${i + 1}`],
        ).some(Boolean)
          ? Array.from({ length: 5 }, (_, i) => values[`bullet_point${i + 1}`])
          : values.bullet_points.split(/\r?\n/)
        )
          .filter(Boolean)
          .map((text, i) => ({ id: `b${i + 1}`, text })),
        description: values.description,
      };
      if (
        !isParent &&
        input.operation !== "create" &&
        !contentSchema.safeParse(content).success
      )
        errors.push("检查或优化已有文案时需要有效的英文标题，卖点最多 20 条。");
      return {
        row: row.number,
        sku: product.sku,
        name: product.name_zh || "",
        values,
        errors,
        warnings,
        action: duplicate ? input.duplicate : "new",
        product,
        content,
        status: errors.length
          ? "blocked"
          : isParent
            ? "preserved"
            : duplicate && input.duplicate === "skip"
              ? "skipped"
              : "queued",
        source: {
          filename: source.filename,
          sheet: source.sheet,
          headers: source.headers,
          cells: row.cells,
        },
      };
    });
}

export function issueGroups(store, batch) {
  const groups = new Map();
  for (const row of batch.rows) {
    const record = row.listing_id ? store.latest(row.listing_id) : null;
    if (!record) continue;
    for (const issue of record.review.issues) {
      if (!groups.has(issue.rule_id))
        groups.set(issue.rule_id, {
          rule_id: issue.rule_id,
          title: issue.title,
          members: [],
        });
      const group = groups.get(issue.rule_id);
      let member = group.members.find((m) => m.row === row.row);
      if (!member) {
        member = {
          row: row.row,
          sku: row.sku,
          name: row.name,
          version: record.version,
          status: row.status,
          actionable:
            row.status === "completed" ||
            (row.status === "failed" && !!row.pending_group),
          issues: [],
          deferred: row.deferred?.[issue.rule_id] === record.version,
        };
        group.members.push(member);
      }
      member.issues.push(issue);
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.members.length - a.members.length,
  );
}

export function createBatchManager(store, service) {
  function groupAction(key, raw) {
    const input = z
      .object({
        rule_id: z.string().max(100),
        action: z.enum(["review", "repair", "defer"]),
        items: z
          .array(
            z.object({
              row: z.number().int(),
              version: z.number().int().positive(),
            }),
          )
          .min(1)
          .max(200),
        request_id: z.string().min(1).max(120),
        preview: z.boolean().default(false),
      })
      .parse(raw);
    const batch = store.batch(key);
    if (!batch) throw new AppError("NOT_FOUND", "找不到批量任务。", 404);
    if (batch.group_actions?.some((a) => a.id === input.request_id))
      return { queued: true };
    if (batch.rows.some((r) => ["queued", "running"].includes(r.status)))
      throw new AppError(
        "BATCH_BUSY",
        "请等待本批正在排队和运行的商品处理完成，再集中处理。",
        409,
      );
    if (new Set(input.items.map((i) => i.row)).size !== input.items.length)
      throw new AppError("DUPLICATE_ROWS", "同一商品不能重复选择。");
    const items = input.items.map((item) => {
      const row = batch.rows.find((r) => r.row === item.row);
      const record = row?.listing_id ? store.latest(row.listing_id) : null;
      if (
        !record ||
        !(
          row.status === "completed" ||
          (row.status === "failed" && row.pending_group)
        )
      )
        throw new AppError(
          "ROW_UNAVAILABLE",
          "所选商品尚未处理完成，请先完成或重试失败任务。",
          409,
        );
      if (record.version !== item.version)
        throw new AppError(
          "STALE_VERSION",
          "商品文案已更新，请刷新问题分组后重新选择。",
          409,
        );
      const issues = record.review.issues.filter(
        (i) => i.rule_id === input.rule_id,
      );
      if (!issues.length)
        throw new AppError(
          "ISSUE_CHANGED",
          "该问题已经变化，请刷新后再处理。",
          409,
        );
      let patches = [],
        reason = "";
      if (input.action === "repair") {
        const fields = new Set(issues.map((i) => i.field_path));
        try {
          patches = uniquePatches(
            record.patches.filter((p) => fields.has(p.field_path)),
          );
          applyPatches(record.content, patches, record.version, record.version);
        } catch {
          patches = [];
          reason = "现有修复建议存在冲突或已失效，请使用统一审查。";
        }
        if (!patches.length)
          reason ||= "没有可直接应用的修复建议，请统一审查或补充资料。";
      }
      return {
        row: item.row,
        sku: row.sku,
        version: item.version,
        patches,
        reason,
        status: reason
          ? "skipped"
          : input.action === "defer"
            ? "deferred"
            : "queued",
      };
    });
    if (input.preview) return { items };
    if (items.every((i) => i.status === "skipped"))
      throw new AppError(
        "NO_REPAIRS",
        "所选商品没有可应用的修复建议，请使用统一审查。",
      );
    const action = {
      id: input.request_id,
      rule_id: input.rule_id,
      action: input.action,
      created_at: new Date().toISOString(),
      items,
    };
    (batch.group_actions ||= []).push(action);
    for (const item of items) {
      const row = batch.rows.find((r) => r.row === item.row);
      if (item.status === "skipped") continue;
      if (input.action === "defer") {
        (row.deferred ||= {})[input.rule_id] = item.version;
        if (row.pending_group) {
          delete row.pending_group;
          row.status = "completed";
          clearFailure(row);
        }
        continue;
      }
      row.pending_group = {
        id: action.id,
        rule_id: input.rule_id,
        action: input.action,
        base_version: item.version,
        patches: item.patches,
      };
      row.status = "queued";
      row.attempt = (row.attempt || 0) + 1;
      clearFailure(row);
    }
    if (input.action !== "defer") {
      const config = getConfig(store);
      batch.status = "running";
      batch.provider = config.provider;
      batch.model = config.model;
    }
    store.saveBatch(batch);
    return { queued: true, items };
  }
  function markGroup(batch, row, status, run) {
    if (!row.pending_group) return;
    const item = batch.group_actions
      ?.find((a) => a.id === row.pending_group.id)
      ?.items.find((i) => i.row === row.row);
    if (item) {
      item.status = status;
      if (status !== "failed") delete item.error;
      if (run?.version) item.result_version = run.version;
      if (row.error) item.error = row.error;
    }
    if (status === "completed") delete row.pending_group;
  }
  function start(rawInput) {
    const input = inputSchema.parse(rawInput),
      source = store.getImport(input.import_id);
    if (!source)
      throw new AppError("IMPORT_NOT_FOUND", "导入预览已失效，请重新上传。");
    if (source.batch_id && !input.dry_run) return store.batch(source.batch_id);
    /*
     * 站点与语言的组合查表（与引导流程同一张表）。
     * 以前这里是「德语只在德国站」一条 if；加英国站、法国站时每站要再补一条，
     * 补漏一条就静默拿错包出结论 —— 这种"看着对、依据错"最难在台上看出来。
     * 现在只判"在不在表里"，报错时把可选项列出来。
     */
    if (!languageTier(input.marketplace, input.language))
      throw new AppError(
        "LANGUAGE_MARKETPLACE_MISMATCH",
        `Amazon ${input.marketplace} 站的批次不能用「${LANGUAGE_ZH[input.language] || input.language}」写文案，这个站可写：${languagesFor(input.marketplace).map((code) => LANGUAGE_ZH[code] || code).join(" / ")}。`,
        400,
      );
    const rows = prepareRows(store, source, input);
    if (input.dry_run) return { rows };
    if (rows.some((r) => r.status === "blocked"))
      throw new AppError(
        "IMPORT_ERRORS",
        "请修正有问题的行，或取消选择这些行，再开始。",
      );
    if (!rows.some((r) => r.status === "queued"))
      throw new AppError("NO_NEW_ROWS", "所选商品全部跳过，没有待处理商品。");
    const config = getConfig(store);
    if (config.provider === "demo")
      throw new AppError(
        "REAL_MODEL_REQUIRED",
        "请先配置真实模型，批量任务不使用演示返回。",
      );
    // Product revisions are saved immediately before each row is processed.
    const batch = {
      id: id("batch"),
      name: source.filename,
      created_at: new Date().toISOString(),
      operation: input.operation,
      language: input.language,
      import_id: source.id,
      mapping: input.mapping,
      file_revision: 0,
      file_edits: {},
      import_edits: Object.fromEntries(
        rows.flatMap((row) => {
          const changes = {};
          for (const key of [
            "category",
            "material",
            "width",
            "width_unit",
            "height",
            "height_unit",
            'depth',
            'depth_unit',
            "fabric_weight_gsm",
            "capacity_l",
            "handle_length_cm",
            "retail_pack_count",
            'rated_load_kg',
            "brand",
            "color",
            "size",
          ]) {
            const column = input.mapping[key];
            if (
              column >= 0 &&
              input.edits[String(row.row)]?.[key] !== undefined &&
              row.values[key] !== clean(row.source.cells[column])
            )
              changes[column] = row.values[key];
          }
          return Object.keys(changes).length
            ? [[String(row.row), changes]]
            : [];
        }),
      ),
      provider: config.provider,
      model: config.model,
      marketplace: input.marketplace,
      status: "running",
      rows,
    };
    store.saveBatch(batch);
    // The import ID is an idempotency key, including browser double clicks.
    store.markImportBatch(source.id, batch.id);
    return batch;
  }
  function dispatchRow(batch, row) {
    try {
      const config = getConfig(store);
      if (config.provider !== batch.provider || config.model !== batch.model) {
        batch.status = "paused";
        store.saveBatch(batch);
        return false;
      }
      if (!row.product_saved) {
        // 幂等：进程可能停在「商品已落盘、批次还没落盘」之间，重启后这里会再走一次。
        // saveProduct 要求 revision 恰好 +1，重复写会抛 STALE_PRODUCT 而不是覆盖，所以先探一下。
        if (!store.product(row.product.product_id, row.product.revision))
          store.saveProduct(row.product);
        row.product_saved = true;
        // 不在这里单独落盘：同一个 tick 里函数末尾那次 saveBatch 会把 product_saved 一起写进去。
        // 量过（scripts/batch-scale-probe.mjs）：每行的整批 blob 全量重写次数 3 -> 2。
      }
      let groupInput = null;
      if (row.pending_group) {
        const previous = store.latest(row.listing_id),
          group = row.pending_group;
        if (previous.version !== group.base_version)
          throw new AppError(
            "STALE_VERSION",
            "排队期间文案已更新，请重新查看问题并选择处理，原文未改动。",
            409,
          );
        groupInput = {
          operation: group.action === "repair" ? "patch" : "revise",
          previous,
          product: previous.product_snapshot,
          base_version: previous.version,
          patches: group.patches,
          review_issues: group.action === "review",
          review_rule_ids: [group.rule_id],
          instruction:
            "只处理 review_context 中的同类问题。依据各自商品资料修正文案，不推测未知信息；其他字段保留。",
        };
      }
      const run = service.enqueue(
        groupInput
          ? {
              ...groupInput,
              request_id: `${batch.id}-${row.row}-${row.attempt || 0}`,
              // 台账归因：上游调用记在自己名下，这批花了几次调用才算得出来。
              batch_ref: { batch_id: batch.id, row: row.row, attempt: row.attempt || 0 },
            }
          : {
              operation: batch.operation === "create" ? "create" : "diagnose",
              product: row.product,
              content: batch.operation === "create" ? undefined : row.content,
              batch_optimize: batch.operation === "optimize",
              language: batch.language || "en",
              marketplace: batch.marketplace || DEFAULT_MARKETPLACE,
              instruction:
                batch.operation === "create"
                  ? `使用已确认资料生成简洁清晰的${LANGUAGE_ZH[batch.language || "en"]}商品文案。未知信息不推测。`
                  : "",
              request_id: `${batch.id}-${row.row}-${row.attempt || 0}`,
              batch_ref: { batch_id: batch.id, row: row.row, attempt: row.attempt || 0 },
            },
      );
      row.run_id = run.run_id;
      row.status = "running";
      clearFailure(row);
      markGroup(batch, row, "running");
    } catch (error) {
      row.status = "failed";
      failRow(row, error);
      activeGovernor()?.failure(row.error_code);
      markGroup(batch, row, "failed");
    }

    store.saveBatch(batch);
    return row.status === 'running';
  }
  function tick() {
    const batches = store.batches().reverse();
    let active = 0;
    for (const batch of batches) {
      let changed = false;
      for (const row of batch.rows.filter(item => item.status === 'running')) {
        const run = store.run(row.run_id);
        if (run?.status === 'succeeded') {
          row.status = 'completed'; row.listing_id = run.listing_id; row.version = run.version;
          clearFailure(row); markGroup(batch, row, 'completed', run);
          activeGovernor()?.success(); changed = true;
        } else if (!run || run.status === 'failed') {
          row.status = 'failed';
          failRow(row, run?.error || { code: 'INTERRUPTED', message: '任务执行中断，服务端执行结果未知。' });
          markGroup(batch, row, 'failed', run); activeGovernor()?.failure(row.error_code); changed = true;
          // 熔断（第 7 轮）：连续几行都栽在「配置」类错误上，就停手。
          // 量到的现状是 8 行配错 → 上游被调 8 次，一次都不收手；2000 行就是 2000 次。
          // 401/403/402/404 这类错误换一行不会自己好，继续打只是把失败攒多、把额度撞满。
          if (classifyError(row.error_code) === 'config') {
            batch.config_failures = (batch.config_failures || 0) + 1;
            if (batch.config_failures >= CONFIG_FAILURE_BREAKER && batch.status === 'running') {
              batch.status = 'paused';
              batch.pause_reason = {
                code: 'CONFIG_BREAKER',
                consecutive: batch.config_failures,
                last_error_code: row.error_code || null,
                message: `连续 ${batch.config_failures} 行都因为模型配置失败（Key、地址或额度）。换一行不会好，已暂停本批：先修好模型设置，再点继续。`,
              };
            }
          } else batch.config_failures = 0;
        } else active += 1;
      }
      if (batch.status === 'running' && !batch.rows.some(row => ['queued', 'running'].includes(row.status))) {
        batch.status = 'finished'; changed = true;
      }
      if (changed) store.saveBatch(batch);
    }
    const control = activeGovernor();
    if (control?.backoffMs() > 0) return;
    const cap = batchConcurrencyInfo().concurrency;
    for (const batch of batches) {
      if (batch.status !== 'running') continue;
      for (const row of batch.rows.filter(item => item.status === 'queued')) {
        if (active >= cap || control?.backoffMs() > 0 || batch.status !== 'running') break;
        if (dispatchRow(batch, row)) active += 1;
      }
      if (active >= cap || control?.backoffMs() > 0) break;
    }
  }
  const timer = setInterval(tick, 250);
  timer.unref();
  return {
    start,
    groupAction,
    tick,
    close: () => clearInterval(timer),
    action(key, action, rawOptions = {}) {
      const options = z.object({ rows: z.array(z.number().int().positive()).min(1).max(2000).optional() }).parse(rawOptions);
      const batch = store.batch(key);
      if (!batch) throw new AppError('NOT_FOUND', '找不到批量任务。', 404);
      if (!['pause', 'resume', 'retry'].includes(action)) throw new AppError('INVALID_ACTION', '无效的批次操作。');
      if (action === 'pause') { batch.status = 'paused'; store.saveBatch(batch); return batch; }
      const config = getConfig(store);
      if (config.provider === 'demo') throw new AppError('REAL_MODEL_REQUIRED', '批量任务只使用真实模型。');
      let retry = null;
      if (action === 'retry') {
        if (options.rows && new Set(options.rows).size !== options.rows.length) throw new AppError('INVALID_ROWS', '重试行不能重复。');
        const named = options.rows ? new Set(options.rows) : null;
        if (named && [...named].some(number => !batch.rows.some(row => row.row === number))) throw new AppError('INVALID_ROWS', '指定的重试行不在本批中。');
        const candidates = batch.rows.filter(row => named ? named.has(row.row) : row.status === 'failed');
        retry = { requested: candidates.length, requeued: 0, skipped_non_failed: 0, skipped_non_retryable: 0, skipped_rows: [] };
        for (const row of candidates) {
          if (row.status !== 'failed') {
            retry.skipped_non_failed += 1;
            retry.skipped_rows.push({ row: row.row, reason: '此行没有执行失败，保留现有任务或结果。' });
          } else if (row.retryable === false) {
            retry.skipped_non_retryable += 1;
            retry.skipped_rows.push({ row: row.row, reason: row.error_action || row.next_step || '先处理资料、配置或版本问题。' });
          } else {
            row.status = 'queued'; row.attempt = (row.attempt || 0) + 1;
            clearFailure(row); retry.requeued += 1;
          }
        }
      }
      if (action === 'resume' || retry.requeued > 0) {
        // 用户已经动过配置（或至少按了继续），熔断计数重新开始。
        delete batch.config_failures;
        delete batch.pause_reason;
        batch.status = batch.rows.some(row => ['queued', 'running'].includes(row.status)) ? 'running' : 'finished';
        batch.provider = config.provider; batch.model = config.model;
      }
      store.saveBatch(batch);
      return retry ? { ...batch, retry } : batch;
    },
  };
}

export async function exportBatch(store, batch, issuesOnly = false) {
  const book = new ExcelJS.Workbook();
  const recordOf = row => row.listing_id ? (row.version && store.version ? store.version(row.listing_id, row.version) : store.latest(row.listing_id)) : null;
  writeOverviewSheet(book, summarizeBatch(batch, recordOf));
  // 工作单里的「依据」要按这一批自己的站点取包，否则德国批次会贴出美国规则的原文
  writeWorklistSheet(book, ruleWorklist(batch, recordOf, rulePackFor(batch.marketplace)));
  const sheet = book.addWorksheet(issuesOnly ? "待处理事项" : "商品文案");
  sheet.addRow(
    issuesOnly
      ? ["SKU", "商品名称", "状态", "问题", "建议"]
      : [
          "SKU",
          "商品名称",
          "状态",
          `${LANGUAGE_ZH[batch.language || "en"]}标题`,
          `${LANGUAGE_ZH[batch.language || "en"]}亮点`,
          `${LANGUAGE_ZH[batch.language || "en"]}卖点`,
          `${LANGUAGE_ZH[batch.language || "en"]}描述`,
          "版本",
          "未解决事项",
        ],
  );
  for (const row of batch.rows) {
    const record = recordOf(row);
    const issues = [
      ...(record?.review.issues || []).map((i) => ({
        reason: i.reason,
        suggestion: i.suggestion,
      })),
      ...(record?.review.missing_data || []).map((i) => ({
        reason: i.label + "：" + i.reason,
        suggestion: "核对并补充资料",
      })),
      ...(record?.review.checks || [])
        .filter((c) =>
          ["not_checked", "error", "needs_evidence"].includes(c.state),
        )
        .map((c) => ({
          reason: c.rule_id + "：" + c.reason,
          suggestion: "补充资料或执行完整模型审查",
        })),
    ];
    if (row.error)
      issues.push({ reason: row.error, suggestion: row.error_action || "核对失败原因后重试此行" });
    const status =
      row.status === "completed"
        ? issues.length
          ? "待确认"
          : "已完成范围内检查"
        : {
            queued: "排队中",
            running: "处理中",
            failed: "失败",
            skipped: "已跳过",
            preserved: "父体保留（未送审）",
            blocked: "资料校验未通过",
          }[row.status] || row.status;
    if (issuesOnly)
      for (const issue of issues)
        sheet.addRow([
          row.sku,
          row.name,
          status,
          issue.reason,
          issue.suggestion,
        ]);
    else
      sheet.addRow([
        row.sku,
        row.name,
        status,
        record?.content.title || "",
        record?.content.item_highlights || "",
        record?.content.bullet_points.map((b) => b.text).join("\n") || "",
        record?.content.description || "",
        record?.version || "",
        issues.map((i) => i.reason).join("\n"),
      ]);
  }
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.columns.forEach((col, i) => {
    col.width = i < 3 ? 22 : 55;
    col.alignment = { vertical: "top", wrapText: true };
  });
  if (batch.group_actions?.length) {
    const log = book.addWorksheet("集中处理记录");
    log.addRow([
      "时间",
      "问题规则",
      "操作",
      "SKU",
      "原版本",
      "状态",
      "结果版本",
      "备注",
    ]);
    for (const action of batch.group_actions)
      for (const item of action.items)
        log.addRow([
          action.created_at,
          action.rule_id,
          action.action,
          item.sku,
          item.version,
          item.status,
          item.result_version || "",
          item.reason || item.error || "",
        ]);
    log.getRow(1).font = { bold: true };
    log.columns.forEach((c) => {
      c.width = 25;
      c.alignment = { wrapText: true, vertical: "top" };
    });
  }
  return book.xlsx.writeBuffer();
}

/** Recovery export preserves original failed cells; it is not an Amazon upload template. */
export async function exportFailedRows(store, batch) {
  const source = store.getImport(batch.import_id);
  if (!source) throw new AppError('IMPORT_NOT_FOUND', '原始导入文件不存在，无法导出失败原行。', 404);
  const failed = (batch.rows || []).filter(row => row.status === 'failed');
  if (!failed.length) throw new AppError('NO_FAILED_ROWS', '本批没有执行失败的行。');
  const originals = new Map((source.rows || []).map(row => [row.number, row]));
  if (failed.some(row => !originals.has(row.row))) throw new AppError('ORIGINAL_ROW_MISSING', '失败行与原始文件无法对应，未生成恢复文件。');
  const book = new ExcelJS.Workbook();
  const data = book.addWorksheet('失败原行');
  data.addRow(source.headers.map(value => String(value ?? '')));
  for (const row of failed) data.addRow(originals.get(row.row).cells.map(value => String(value ?? '')));
  data.getRow(1).font = { bold: true };
  data.views = [{ state: 'frozen', ySplit: 1 }];
  data.columns.forEach(column => { column.width = 24; column.alignment = { wrapText: true, vertical: 'top' }; });
  const notes = book.addWorksheet('失败说明');
  notes.addRow(['批次ID', '原文件', '原工作表', '原行号', '原SKU', '错误码', '失败原因', '下一步', '尝试序号']);
  for (const row of failed) notes.addRow([batch.id, source.filename, source.sheet || '', row.row, row.sku || '', row.error_code || '', row.error || '未知', row.error_action || row.next_step || '核对后重试', row.attempt || 0]);
  notes.addRow(['使用边界', '这是原始失败行的恢复副本，不是 Amazon 上传模板；不包含成功模型结果。父体或其他关联行可能不在本文件中，须回到原文件核对关系。原文件中的未保存修改不在此副本。']);
  notes.getRow(1).font = { bold: true };
  notes.columns.forEach(column => { column.width = 26; column.alignment = { wrapText: true, vertical: 'top' }; });
  return book.xlsx.writeBuffer();
}
