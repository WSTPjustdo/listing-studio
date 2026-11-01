import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { z } from "zod";
import { createHash } from "node:crypto";
import { ruleCitations } from "./rules-doc.mjs";
import { citationsByVersion } from "./audit-context.mjs";
import { exportListingReport, exportListingWorklist, factSourceExport, intakeSourceText, guidedSourceText } from "./listing-report.mjs";
import { trendVerdict } from "./version-trend.mjs";
import { attachStore, listCalls, summarize } from "./telemetry.mjs";
import { ruleWorklist, summarizeBatch } from "./batch-summary.mjs";
import { batchCost, CALLS_PER_ROW } from "./batch-cost.mjs";
import {
  AppError,
  contentSchema,
  diffContent,
  id,
  uniquePatches,
} from "./domain.mjs";
import { createStore, ROOT, rulePack, rulePacks, rulePackFor, normalizeMarketplace, DEFAULT_MARKETPLACE, scenarios, loadJson } from "./store.mjs";
import {
  fetchAmazon,
  importAmazonSnapshot,
  pickSamples,
  amazonIdentity,
} from "./amazon.mjs";
import { createService } from "./service.mjs";
import { listingRunInputSchema as runInput } from './listing-input.mjs';
import { editableFieldSchema, prepareIntakeRun, validateAllowedFields } from './intake.mjs';
import { createGuidedPlan, prepareGuidedGeneration } from './guided.mjs';
import { searchOfficialReferences } from './official-references.mjs';
import { researchConfig, publicResearchConfig, saveResearchConfig, analyzeProduct, searchCompetitors, createResearchProduct, comparisonSchema } from './research.mjs';
import { getConfig, publicConfig, saveConfig, describeEndpoint, probeModels } from "./providers.mjs";
import { describeFailure } from './errors.mjs';
import { describeListenFailure, probeOccupant, frontendStaleness, stalenessWarning } from "./startup.mjs";
import { submitEvidence } from './submissions.mjs';
import { saveProductFacts } from './product-facts.mjs';
import { evidenceText } from './evidence.mjs';
import { exportHandoff, previewHandoff, confirmHandoff } from './handoffs.mjs';
import { libraryRows, saveLibraryEntry, exportLibrary } from './library.mjs';
import { exportFlatFile } from './flat-file-export.mjs';
import { benchmarkForRecord } from './benchmark-section.mjs';
import { parseProcessingReport } from './processing-report.mjs';
import { previewMaterials, resolveMaterialContext } from './materials.mjs';
import { buildAplus } from './aplus.mjs';
import { analyzeReviews, parseReviews } from './voc.mjs';
import { parseSearchTerms, buildKeywordReport } from './keywords.mjs';
import { generateVariants, variantForAdoption } from './variants.mjs';
import { classifyRoles } from './roles.mjs';
import { buildReadiness } from './readiness.mjs';
import { checkVariation } from './variant-consistency.mjs';
import { buildEvidenceBoard } from './evidence-lifecycle.mjs';
import { buildRiskCenter } from './risk-center.mjs';
import {
  readTable,
  createBatchManager,
  exportBatch,
  issueGroups,
  exportFailedRows,
  batchConcurrencyInfo,
} from "./batch.mjs";

const store = createStore();
attachStore(store);
store.interruptRuns();
const service = createService(store);
const batchManager = createBatchManager(store, service);
const hostname = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT) || 8787;
const dist = resolve(ROOT, "dist");
const amazonSamples = loadJson("data-research/amazon-samples.json");
let importingAmazon = false;

function json(res, value, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > (req.url === '/api/materials/preview' ? 29000000 : ["/api/batches/preview", "/api/evidence-handoffs/preview"].includes(req.url) || /^\/api\/batches\/[^/]+\/processing-report$/.test(req.url) ? 7500000 : req.url === '/api/research/analyze' ? 4500000 : /^\/api\/batches(?:\?|$)/.test(req.url) ? 2500000 : 512000))
      throw new AppError(
        "BODY_TOO_LARGE",
        req.url === "/api/batches/preview"
          ? "上传请求过大，请将文件控制在 5 MB 内。"
          : req.url === '/api/materials/preview' ? '本组上传请求超过 20 MB 文件容量，请拆分材料。' : "输入内容超过接口容量，请缩短内容或拆分文件。",
        413,
      );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new AppError("INVALID_JSON", "请求不是有效 JSON。");
  }
}
const assert = (value, code, message, status = 404) => {
  if (!value) throw new AppError(code, message, status);
  return value;
};
function originGuard(req) {
  if (!req.headers.origin) return;
  let origin;
  try {
    origin = new URL(req.headers.origin);
  } catch {
    throw new AppError("INVALID_ORIGIN", "来源无效。", 403);
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
    throw new AppError(
      "INVALID_ORIGIN",
      "本地服务不接受此来源的修改请求。",
      403,
    );
}

function selectedProduct(input, required = false) {
  if (!input.product_id) {
    if (required) throw new AppError("PRODUCT_REQUIRED", "请选择一个商品。");
    return null;
  }
  return assert(
    store.product(input.product_id, input.product_revision),
    "PRODUCT_NOT_FOUND",
    "找不到指定商品版本。",
  );
}
function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function submissionExport(record) {
  return (record.product_snapshot?.evidence_submissions || []).map(item =>
    `提交材料（待核验）：${item.title}\n对应：${item.target_label}；${item.field_path}\n原句：${item.original || '待补商品资料'}\n适用型号：${item.applicable_model}\n来源：${item.publisher}；${item.url || '未提供链接'}\n记录：${item.source_id}；${item.submitted_at}\n原文：${item.excerpt}\n尚未独立核验，不代表问题已解决。`);
}
function textExport(record) {
  const c = record.content;
  const marketplace = record.guided_plan?.marketplace || record.rule_pack_snapshot?.scope?.marketplace || record.marketplace || DEFAULT_MARKETPLACE;
  return [
    `Listing Studio · ${record.is_demo ? "演示商品" : "商品"} · V${record.version}`,
    `Title\n${c.title}`,
    ...(record.product_snapshot?.amazon
      ? [
          `Amazon 来源：${record.product_snapshot.amazon.url}\n读取日期：${record.product_snapshot.amazon.checked_at}\n${record.product_snapshot.amazon.freshness}\n销售状态：${record.product_snapshot.amazon.availability_text}\n资料方式：${record.product_snapshot.amazon.import_mode === "live" ? "实时读取" : "已保存快照，非实时库存"}`,
        ]
      : []),
    `Item Highlights\n${c.item_highlights}`,
    `Bullet Points\n${c.bullet_points.map((b) => `• ${b.text}`).join("\n")}`,
    `Description\n${c.description}`,
    "—— 内部审阅说明（与对客文案分开使用）——",
    `检查范围：Amazon ${marketplace} 文本与宣称证据预审；正式上架准备状态未验证。`,
    `执行方式：${record.trace.actual_model_call ? "实际模型调用" : "本地规则演示，非 AI 调用"}`,
    `运行：${record.run_id}`,
    `商品资料版本：${record.product_ref || "未关联"}`,
    intakeSourceText(record),
    guidedSourceText(record),
    ...(record.review.consistency_check ? [`审核一致性：${record.review.consistency_check.reason}`] : []),
    ...(record.product_change ? [`本轮资料变化：${record.product_change.before} → ${record.product_change.after}`] : []),
    ...submissionExport(record),
    ...factSourceExport(record),
    ...(record.review.evidence || []).map(x => `卖点对照：${evidenceText(x)}`),
    `未覆盖参数：${record.review.unmodeled_parameters?.length ?? 0} 处；参数关联不证明整句，未覆盖项未核对。`,
    ...(record.review.unmodeled_parameters || []).map(x => `未覆盖：${x.original}；${x.reason}`),
    ...record.review.issues.map(
      (x) =>
        `[${x.rule_id}] ${x.title}\n${x.original}\n${x.reason}\n建议：${x.suggestion}`,
    ),
    ...record.review.missing_data.map((x) => `待补：${x.label}；${x.reason}`),
    `未完成检查：${
      record.review.checks
        .filter((x) => ["not_checked", "error"].includes(x.state))
        .map((x) => x.rule_id)
        .join(", ") || "无"
    }`,
  ].join("\n\n");
}

async function api(req, res, url) {
  const path = url.pathname;
  if (req.method !== "GET") originGuard(req);
  if (path === "/api/telemetry" && req.method === "GET") {
    const calls = listCalls(url.searchParams.get("limit"));
    return json(res, { calls, summary: summarize(calls) });
  }
  if (path === '/api/evidence-handoffs/export' && req.method === 'POST') {
    const data = await exportHandoff(store, await body(req));
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="evidence-handoff.xlsx"', 'Cache-Control': 'no-store' });
    return res.end(Buffer.from(data));
  }
  if (path === '/api/evidence-handoffs/preview' && req.method === 'POST') return json(res, await previewHandoff(store, await body(req)));
  if (path === '/api/evidence-handoffs/confirm' && req.method === 'POST') return json(res, confirmHandoff(store, await body(req)), 201);
  if (path === "/api/batches/preview" && req.method === "POST") {
    const input = z
      .object({
        filename: z.string().max(250),
        base64: z.string().max(7000000),
        sheet: z.string().max(100).optional(),
        header_row: z.number().int().min(1).max(10000).optional(),
      })
      .parse(await body(req));
    const preview = {
      id: id("import"),
      ...(await readTable(
        input.filename,
        Buffer.from(input.base64, "base64"),
        input.sheet,
        input.header_row,
      )),
    };
    store.saveImport(preview);
    const { original_base64, ...publicPreview } = preview;
    return json(res, publicPreview);
  }
  if (path === "/api/batches" && req.method === "POST")
    return json(res, batchManager.start(await body(req)), 201);
  if (path === "/api/batches" && req.method === "GET")
    return json(
      res,
      store
        .batches()
        .map(({ id, name, status, created_at, operation, rows }) => ({
          id,
          name,
          status,
          created_at,
          operation,
          total: rows.length,
          completed: rows.filter((r) => r.status === "completed").length,
        })),
    );
  const batchMatch =
    /^\/api\/batches\/([^/]+)(?:\/(export|flat-file|processing-report|file-edits|pause|resume|retry|summary|cost|failed-rows\/export|group-action))?$/.exec(
      path,
    );
  if (batchMatch) {
    const batch = store.batch(batchMatch[1]);
    if (!batch) throw new AppError("NOT_FOUND", "找不到批量任务。", 404);
    const source = batch.import_id ? store.getImport(batch.import_id) : null;
    if (req.method === "GET" && batchMatch[2] === "flat-file") {
      const rowText = url.searchParams.get("rows");
      const rowNumbers = rowText ? rowText.split(",").map(Number) : undefined;
      if (rowNumbers && (rowNumbers.length > 2000 || rowNumbers.some(n => !Number.isInteger(n) || !batch.rows.some(row => row.row === n))))
        throw new AppError("INVALID_ROWS", "请选择本批次中已关联的原表行。");
      const format = z.enum(["original", "xlsx", "tsv", "txt"]).parse(url.searchParams.get("format") || "original");
      const output = await exportFlatFile(store, batch, source, { format, rowNumbers, onlyRows: url.searchParams.get("only_rows") === "true", allowManualContent: url.searchParams.get("allow_manual_content") === "true" });
      if (url.searchParams.get("validate") === "true") return json(res, output.validation);
      const fresh = store.batch(batch.id);
      const exported = { id: id("inventory-export"), filename: output.filename, exported_at: new Date().toISOString(), file_revision: batch.file_revision || 0, export_manifest: output.export_manifest, source_sha256: output.source_sha256, artifact_sha256: output.artifact_sha256, validation: output.validation };
      fresh.exports = [...(fresh.exports || []), exported].slice(-50);
      store.saveBatch(fresh);
      res.writeHead(200, { "Content-Type": output.contentType, "Content-Disposition": `attachment; filename="batch-template.${output.filename.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(output.filename)}`, "X-Inventory-Export-Id": exported.id, "Cache-Control": "no-store" });
      return res.end(Buffer.from(output.buffer));
    }
    if (req.method === "POST" && batchMatch[2] === "processing-report") {
      const input = z.object({ filename: z.string().max(250), base64: z.string().max(7000000), export_id: z.string().max(100).optional(), row_number_mode: z.enum(["auto", "file", "data"]).default("auto") }).parse(await body(req));
      if (!source) throw new AppError("SOURCE_FILE_REQUIRED", "旧批次没有原文件，请重新导入库存模板。");
      const exported = input.export_id ? batch.exports?.find(item => item.id === input.export_id) : null;
      if (input.export_id && !exported) throw new AppError("EXPORT_NOT_FOUND", "找不到所选交付文件版本，请刷新后重试。");
      const report = await parseProcessingReport(input.filename, Buffer.from(input.base64, "base64"), batch, source, { export_manifest: exported?.export_manifest, row_number_mode: input.row_number_mode });
      const rawReportId = id("platform-report-file");
      const reportHash = createHash("sha256").update(Buffer.from(input.base64, "base64")).digest("hex");
      store.saveImport({ id: rawReportId, batch_id: batch.id, filename: input.filename, original_base64: input.base64, sha256: reportHash, received_at: new Date().toISOString(), kind: "merchant_uploaded_processing_report" });
      const fresh = store.batch(batch.id);
      fresh.processing_reports = [...(fresh.processing_reports || []), { ...report, source_file_id: rawReportId, source_file_sha256: reportHash, export_id: input.export_id || null, artifact_sha256: exported?.artifact_sha256 || null, row_number_mode: input.row_number_mode, id: id("processing-report"), imported_at: new Date().toISOString() }].slice(-20);
      store.saveBatch(fresh);
      return json(res, fresh.processing_reports.at(-1), 201);
    }
    if (req.method === "POST" && batchMatch[2] === "file-edits") {
      const input = z.object({ base_revision: z.number().int().nonnegative(), confirmed: z.literal(true), edits: z.array(z.object({ row: z.number().int(), column: z.number().int().min(0).max(999), value: z.string().max(10000) })).min(1).max(2000) }).parse(await body(req));
      const fresh = store.batch(batch.id);
      if (!source || !source.original_base64) throw new AppError("SOURCE_FILE_REQUIRED", "没有可回填的原库存文件，请重新导入。");
      if ((fresh.file_revision || 0) !== input.base_revision) throw new AppError("STALE_FILE_EDIT", "文件修正已更新，请刷新后重试。", 409);
      for (const edit of input.edits) {
        if (!fresh.rows.some(row => row.row === edit.row) || edit.column >= source.headers.length)
          throw new AppError("INVALID_FILE_EDIT", "修正位置不在本批次原表中。");
        if (["sku", "parent_sku", "parentage", "variation_theme", "relationship_type"].some(key => fresh.mapping?.[key] === edit.column))
          throw new AppError("IDENTITY_EDIT_BLOCKED", "SKU 和变体关系须在原文件确认后重新导入，不能通过错误修正改变商品身份。");
      }
      fresh.file_edits ||= {};
      for (const edit of input.edits) {
        fresh.file_edits[edit.row] ||= {};
        fresh.file_edits[edit.row][edit.column] = edit.value;
      }
      fresh.file_revision = (fresh.file_revision || 0) + 1;
      fresh.file_edit_history = [...(fresh.file_edit_history || []), { revision: fresh.file_revision, saved_at: new Date().toISOString(), edits: input.edits, review_state: "merchant_manual_unreviewed" }];
      store.saveBatch(fresh);
      return json(res, { revision: fresh.file_revision, edits: fresh.file_edits, review_state: "merchant_manual_unreviewed" });
    }
    if (req.method === "POST" && batchMatch[2] === "group-action")
      return json(res, batchManager.groupAction(batch.id, await body(req)));
    if (
      req.method === "POST" &&
      ["pause", "resume", "retry"].includes(batchMatch[2])
    )
      return json(res, batchManager.action(batch.id, batchMatch[2], await body(req)));
    const recordOf = row => row.listing_id ? (row.version ? store.version(row.listing_id, row.version) : store.latest(row.listing_id)) : null;
    if (req.method === 'GET' && batchMatch[2] === 'summary')
      return json(res, { summary: summarizeBatch(batch, recordOf), worklist: ruleWorklist(batch, recordOf, rulePack), concurrency: batchConcurrencyInfo() });
    // 这一批花了多少次调用、多少 token、折算多少钱（没配单价就只报 token）。
    if (req.method === 'GET' && batchMatch[2] === 'cost') return json(res, batchCost(store, batch));
    if (req.method === 'GET' && batchMatch[2] === 'failed-rows/export') {
      const data = await exportFailedRows(store, batch);
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="failed-rows.xlsx"', 'Cache-Control': 'no-store' });
      return res.end(Buffer.from(data));
    }
    if (req.method === "GET" && batchMatch[2] === "export") {
      const data = await exportBatch(
        store,
        batch,
        url.searchParams.get("type") === "issues",
      );
      res.writeHead(200, {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${batch.id}-${url.searchParams.get("type") === "issues" ? "issues" : "listings"}.xlsx"`,
        "Cache-Control": "no-store",
      });
      return res.end(Buffer.from(data));
    }
    if (req.method === "GET" && !batchMatch[2])
      return json(res, {
        ...batch,
        summary: summarizeBatch(batch, recordOf),
        worklist: ruleWorklist(batch, recordOf, rulePack),
        concurrency: batchConcurrencyInfo(),
        template: source ? { filename: source.filename, sheet: source.sheet, format: source.format, headers: source.headers, header_row: source.header_row, data_start_row: source.data_start_row, profile: source.profile, schema: source.schema } : null,
        groups: issueGroups(store, batch),
        rows: batch.rows.map((row) => ({
          ...row,
          record: recordOf(row),
        })),
      });
  }
  if (path === '/api/library' && req.method === 'GET') return json(res, libraryRows(store));
  if (path === '/api/library/export' && req.method === 'POST') {
    const input = await body(req);
    const data = await exportLibrary(store, input.product_ids);
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="listing-library.xlsx"', 'Cache-Control': 'no-store' });
    return res.end(Buffer.from(data));
  }
  const libraryMatch = /^\/api\/library\/([^/]+)$/.exec(path);
  if (libraryMatch && req.method === 'POST') return json(res, saveLibraryEntry(store, libraryMatch[1], await body(req)), 201);
  if (path === "/api/health")
    return json(res, {
      ok: true,
      version: "0.1.0",
      provider: getConfig(store).provider,
      batch_concurrency: batchConcurrencyInfo(),
    });
  if (req.method === "GET" && path === "/api/bootstrap") {
    const bootstrapPack = rulePackFor(
      normalizeMarketplace(url.searchParams.get("marketplace")) || DEFAULT_MARKETPLACE,
    );
    return json(res, {
      products: store.products().filter(x => !x.is_demo),
      listings: store.list().filter(x => !x.is_demo),
      runs: store.runs().filter(x => !x.product_ref?.startsWith("AMZ-DEMO-")),
      sources: store.sources().filter(x => x.kind !== "synthetic_demo"),
      // 规则页按站点取包：?marketplace=DE 看德国包，不传就是美国站（与改造前一致）。
      rules: bootstrapPack,
      rule_citations: ruleCitations(bootstrapPack),
      rule_citations_by_version: citationsByVersion(),
      // 每个站当前的规则包版本。界面判断「这条结果是不是在旧规则下审的」时按**该结果自己的站点**取，
      // 不能拿当前下拉站点的版本比 —— 拿德国包版本比美国站记录，每条都会显示「审核需更新」。
      rule_pack_versions: Object.fromEntries(
        Object.entries(rulePacks).map(([market, pack]) => [market, pack.rule_pack_version]),
      ),
      fixtures: [],
      settings: publicConfig(getConfig(store)),
      // 每行调几次模型是实测值（server/batch-cost.mjs），界面上的「预计 N 次」从这里读，不各写一份。
      batch_calls_per_row: CALLS_PER_ROW,
    });
  }
  if (path === "/api/settings" && req.method === "GET") {
    const config = getConfig(store);
    return json(res, {
      ...publicConfig(config),
      // 拼完的完整地址：设置页照这个显示，人就不用自己在脑子里拼 /chat/completions。
      endpoint: config.provider === "compatible" ? describeEndpoint(config.base_url) : null,
    });
  }
  if (path === '/api/research/config' && req.method === 'GET') return json(res, publicResearchConfig(researchConfig(store)));
  if (path === '/api/research/history' && req.method === 'GET') return json(res, store.researchHistory());
  if (path === '/api/research/config' && req.method === 'POST') return json(res, saveResearchConfig(store, await body(req)));
  if (path === '/api/materials/preview' && req.method === 'POST') return json(res, await previewMaterials(store, await body(req)), 201);
  if (path === '/api/research/analyze' && req.method === 'POST') {
    const input = await body(req);
    const material = input.material_context ? resolveMaterialContext(store, input.material_context) : null;
    const { material_context, ...analysisInput } = input;
    if (material) analysisInput.text = material.text;
    const result = { ...await analyzeProduct(researchConfig(store), analysisInput), id: id('analysis'), ...(material ? { material_context: material.context } : {}) };
    if (material) for (const fact of result.facts) {
      fact.source_refs = material.context.documents.flatMap(doc => doc.segments.filter(segment => segment.text.includes(fact.evidence)).map(segment => ({ document_id: doc.id, filename: doc.filename, sha256: doc.sha256, locator: segment.locator })));
      if (!fact.source_refs.length) fact.correction_source = material.context.corrected_text !== undefined ? 'merchant_edit' : 'unlocated';
    }
    store.saveImport(result);
    return json(res, result);
  }
  if (path === '/api/research/search' && req.method === 'POST') {
    const input = z.object({ query: z.string().trim().min(2).max(250), comparison: comparisonSchema.optional(), source: z.enum(['amazon', 'official_public']).default('amazon') }).strict().parse(await body(req));
    const result = input.source === 'official_public'
      ? await searchOfficialReferences(input.query)
      : await searchCompetitors(researchConfig(store), input.query, fetch, input.comparison);
    store.saveImport(result);
    return json(res, result);
  }
  if (path === '/api/research/product' && req.method === 'POST') return json(res, createResearchProduct(store, await body(req)), 201);
  if (path === '/api/guided/plan' && req.method === 'POST')
    return json(res, await createGuidedPlan(store, await body(req)), 201);
  if (path === '/api/guided/generate' && req.method === 'POST')
    return json(res, service.enqueue(prepareGuidedGeneration(store, await body(req))), 202);
  if (path === '/api/research/generate' && req.method === 'POST') {
    const input = z.object({ product_id: z.string(), product_revision: z.number().int().positive(), research_id: z.string().optional(), selected_asins: z.array(z.string()).max(5).default([]), terms: z.array(z.string().max(100)).max(60).default([]), style: z.string().trim().min(1).max(2000) }).strict().parse(await body(req));
    const product = selectedProduct(input, true);
    if (store.product(input.product_id)?.revision !== input.product_revision) throw new AppError('STALE_PRODUCT', '商品资料已更新，请重新选择商品。', 409);
    if (getConfig(store).provider === 'demo') throw new AppError('MODEL_REQUIRED', '请先在模型设置中连接真实文案模型，演示模板不支持竞品与风格优化。');
    const research = input.research_id ? store.research(input.research_id) : null;
    if (input.research_id && (!research || !['rainforest', 'omkar-local'].includes(research.provider))) throw new AppError('RESEARCH_NOT_FOUND', '竞品研究记录不存在，请重新搜索。', 404);
    const selected = research?.items.filter(x => input.selected_asins.includes(x.asin)) || [];
    if (input.research_id && (!selected.length || input.selected_asins.some(asin => !selected.some(x => x.asin === asin)))) throw new AppError('SELECT_COMPETITORS', '请先核对并选择竞品。');
    const allowed = new Set((research?.terms || []).filter(x => x.asins.some(asin => input.selected_asins.includes(asin))).map(x => x.term));
    if (input.terms.some(x => !allowed.has(x))) throw new AppError('INVALID_TERMS', '词条不属于本次检索结果。');
    return json(res, service.enqueue({ operation: 'create', product, instruction: `根据本商品参数生成优化后的英文标题、亮点、五点与描述。风格偏好：${input.style}。只使用适合本商品且有资料支持的候选词，不照抄竞品句子，不使用竞品品牌，不把竞品参数作为本商品事实。`, research_context: research ? { research_id: research.id, query: research.query, checked_at: research.checked_at, positioning: research.comparison.positioning, items: selected, selected_terms: input.terms } : null }), 202);
  }
  if (path === "/api/settings/probe" && req.method === "POST") {
    // 测试连接：只打一次 GET /models。失败也回 200，让界面照常渲染"哪一步错了"，
    // 不用为"预期之内的失败"套一层异常。
    // 用**输入框里的值**测（不是已保存的）：人总是先在表单里改完就想知道对不对。
    // 但绝不落盘——这一步不许有副作用，测错了不该把好配置覆盖掉。
    const input = await body(req).catch(() => ({}));
    const saved = getConfig(store);
    const candidate = { ...saved };
    for (const key of ["base_url", "model", "api_key"]) {
      const value = input?.[key];
      if (typeof value === "string" && value.trim()) candidate[key] = value.trim();
    }
    if (!describeEndpoint(candidate.base_url).valid)
      return json(res, {
        ok: false,
        endpoint: null,
        status: null,
        models: [],
        error: describeFailure({ code: "INVALID_PROVIDER_URL" }),
      });
    return json(res, await probeModels(candidate));
  }
  if (path === "/api/settings" && req.method === "POST")
    return json(res, saveConfig(store, await body(req)));
  if (path === "/api/amazon/samples" && req.method === "GET")
    return json(res, amazonSamples);
  if (path === "/api/amazon/import" && req.method === "POST") {
    if (importingAmazon)
      throw new AppError(
        "IMPORT_BUSY",
        "另一次商品读取正在进行，请稍后重试。",
        409,
      );
    const input = z
      .object({
        reference: z.string().max(2000).optional(),
        sample: z.boolean().default(false),
        count: z.number().int().min(1).max(3).default(3),
        mode: z.enum(["live", "snapshot"]).default("live"),
        generate: z.boolean().default(false),
      })
      .strict()
      .parse(await body(req));
    const candidates = input.sample
      ? pickSamples(amazonSamples.items, input.count)
      : [{ asin: amazonIdentity(input.reference).asin }];
    importingAmazon = true;
    const imported = [],
      failures = [];
    try {
      for (const candidate of candidates) {
        try {
          const snapshot =
            input.mode === "live"
              ? await fetchAmazon(candidate.asin)
              : amazonSamples.items.find(
                  (item) => item.asin === candidate.asin,
                );
          if (!snapshot)
            throw new AppError(
              "NO_AMAZON_SNAPSHOT",
              "此 ASIN 没有已保存快照，请选择实时读取。",
              404,
            );
          if (input.sample && snapshot.availability === "unavailable")
            throw new AppError(
              "AMAZON_UNAVAILABLE",
              "页面显示暂不可用，已排除本次随机样本。",
              422,
            );
          const product = importAmazonSnapshot(store, snapshot, input.mode);
          imported.push({ product });
        } catch (error) {
          failures.push({
            asin: candidate.asin,
            message:
              error instanceof AppError
                ? error.message
                : "商品导入失败，请稍后重试。",
          });
        }
      }
      // Start generation only after imports finish; each job retains its own source snapshot.
      if (input.generate)
        for (const item of imported)
          item.run = service.enqueue({
            operation: "create",
            product: item.product,
            instruction:
              "基于这件真实 Amazon 商品的已披露事实重新组织英文 Listing，用于内部内容审核试验。保留真实品牌和已选变体，不把卖家营销宣称或未知参数写成事实。",
            request_id: id("amazon-trial"),
          });
      return json(res, {
        imported,
        failures,
        mode: input.mode,
        sampling: "有限样本池随机抽取，不代表 Amazon 全站随机抽样",
      });
    } finally {
      importingAmazon = false;
    }
  }
  if (path === "/api/products" && req.method === "GET")
    return json(res, store.products());
  if (path === "/api/products" && req.method === "POST") {
    const input = await body(req);
    const profile = saveProductFacts(store,
      {
        product_id: id("product"),
        revision: 0,
        is_demo: false,
        reference_product_id: null,
        application_product_type: "tote_bag_demo",
        rated_load_kg: { value: null, status: "unknown", source_ids: [] },
        degradation_evidence: [],
        certification_evidence: [],
        performance_evidence: [],
        publication_readiness: "not_verified",
      },
      input.fields,
    );
    return json(res, profile, 201);
  }
  const evidenceMatch = /^\/api\/products\/([^/]+)\/evidence$/.exec(path);
  if (evidenceMatch && req.method === 'POST') return json(res, submitEvidence(store, evidenceMatch[1], await body(req)), 201);
  const productMatch = /^\/api\/products\/([^/]+)\/versions$/.exec(path);
  if (productMatch && req.method === "POST") {
    const input = await body(req);
    const previous = assert(
      store.product(productMatch[1]),
      "PRODUCT_NOT_FOUND",
      "找不到商品。",
    );
    if (input.base_revision !== previous.revision)
      throw new AppError("STALE_PRODUCT", "商品已更新，请刷新后再保存。", 409);
    const next = saveProductFacts(store, previous, input.fields);
    return json(res, next, 201);
  }
  if (path === "/api/listings" && req.method === "GET")
    return json(res, store.list());
  if (path === '/api/listings/intake' && req.method === 'POST') {
    const prepared = prepareIntakeRun(await body(req), (productId, revision) => store.product(productId, revision));
    return json(res, service.enqueue(prepared), 202);
  }
  if (path === "/api/listings/create" && req.method === "POST") {
    const input = runInput.parse(await body(req));
    return json(
      res,
      service.enqueue({
        ...input,
        operation: "create",
        product: selectedProduct(input, true),
      }),
      202,
    );
  }
  if (path === "/api/listings/diagnose" && req.method === "POST") {
    const input = runInput
      .safeExtend({ content: contentSchema })
      .parse(await body(req));
    return json(
      res,
      service.enqueue({
        ...input,
        operation: "diagnose",
        product: selectedProduct(input),
      }),
      202,
    );
  }
  const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
  if (runMatch && req.method === "GET")
    return json(
      res,
      assert(store.run(runMatch[1]), "RUN_NOT_FOUND", "找不到运行记录。"),
    );
  const trendMatch = /^\/api\/listings\/([^/]+)\/trend$/.exec(path);
  if (trendMatch && req.method === "GET") {
    assert(store.latest(trendMatch[1]), "LISTING_NOT_FOUND", "找不到文案。");
    return json(res, trendVerdict(store.versions(trendMatch[1])));
  }
  const versionMatch = /^\/api\/listings\/([^/]+)\/versions$/.exec(path);
  if (versionMatch && req.method === "GET")
    return json(res, store.versions(versionMatch[1]));
  const revisionMatch = /^\/api\/listings\/([^/]+)\/revisions$/.exec(path);
  if (revisionMatch && req.method === "POST") {
    const input = z
      .object({
        base_version: z.number().int().positive(),
        kind: z.enum(["instruction", "patch", "manual", "review_issues", "recheck_product", "adopt_variant"]),
        product_id: z.string().max(100).optional(),
        product_revision: z.number().int().positive().optional(),
        instruction: z.string().max(10000).default(""),
        allowed_fields: z.array(editableFieldSchema).min(1).max(23).optional(),
        patch_ids: z.array(z.string()).max(30).optional(),
        content: contentSchema.optional(),
        variant_set_id: z.string().max(120).optional(),
        variant_angle: z.enum(["spec_first", "scenario_first", "concise"]).optional(),
        request_id: z.string().max(120).optional(),
      })
      .parse(await body(req));
    const previous = assert(
      store.latest(revisionMatch[1]),
      "LISTING_NOT_FOUND",
      "找不到文案。",
    );
    if (input.base_version !== previous.version)
      throw new AppError(
        "STALE_VERSION",
        "此文案已有新版本，请刷新后修改。",
        409,
      );
    if (input.allowed_fields) validateAllowedFields(previous.content, input.allowed_fields);
    let patches;
    let revisionProduct = previous.product_snapshot;
    let variantAdoption;
    let adoptedVariant;
    if (input.kind === "recheck_product") {
      if (!input.product_revision) throw new AppError("PRODUCT_REVISION_REQUIRED", "请选择要采用的商品资料版本。");
      if (revisionProduct && input.product_id && revisionProduct.product_id !== input.product_id)
        throw new AppError("PRODUCT_IDENTITY_MISMATCH", "已关联的文案须沿用同一商品；请另建任务处理其他商品。");
      revisionProduct = selectedProduct({ product_id: input.product_id || revisionProduct?.product_id, product_revision: input.product_revision }, true);
      if (store.product(revisionProduct.product_id).revision !== input.product_revision)
        throw new AppError("STALE_PRODUCT", "商品资料已更新，请刷新后采用最新版本。", 409);
      patches = [];
    }
    if (input.kind === "adopt_variant") {
      const selected = variantForAdoption(store, { listingId: revisionMatch[1], baseVersion: input.base_version, variantSetId: input.variant_set_id, angle: input.variant_angle });
      adoptedVariant = selected.variant;
      patches = [];
      variantAdoption = { variant_set_id: selected.variantSet.variant_set_id, angle: adoptedVariant.angle, base_version: selected.variantSet.base_version };
    }
    if (input.kind === "patch") {
      if (!input.patch_ids?.length)
        throw new AppError("NO_PATCHES", "请先选择一条修改建议。");
      patches = input.patch_ids.map((patchId) =>
        assert(
          previous.patches.find((x) => x.patch_id === patchId),
          "PATCH_NOT_FOUND",
          "修改建议无效，请刷新。",
          400,
        ),
      );
      patches = uniquePatches(patches);
      if (patches.some(patch => patch.method === "local_template")) throw new AppError("REAL_REPAIR_REQUIRED", "旧模板建议不能用于当前工作流，请使用真实模型重新审查。");
    } else if (input.kind === "manual") {
      if (!input.content)
        throw new AppError("CONTENT_REQUIRED", "缺少待保存文案。");
      patches = diffContent(previous.content, input.content).map((x) => ({
        field_path: x.field_path,
        expected_before: x.before,
        replacement: x.after,
      }));
      if (!patches.length) throw new AppError("NO_CHANGES", "文案还没有变化。");
      if (
        input.content.bullet_points.map((x) => x.id).join("|") !==
        previous.content.bullet_points.map((x) => x.id).join("|")
      )
        throw new AppError(
          "BULLET_STRUCTURE_CHANGED",
          "首版手动编辑保留要点结构；请只修改文本。",
        );
    } else if (input.kind === "review_issues") {
      input.instruction =
        "逐项审查 review_context 中的全部问题与资料缺口，结合完整文案、商品快照及来源，修正有依据的问题；无证据的宣称请删除或保留为待核验，不得编造参数或证据。保留无问题字段和要点 ID，返回完整修订文案，无法解决的项目继续报告。";
    } else if (!["recheck_product", "adopt_variant"].includes(input.kind) && !input.instruction.trim())
      throw new AppError("INSTRUCTION_REQUIRED", "请填写修改指令。");
    return json(
      res,
      service.enqueue({
        ...input,
        operation: input.kind === "adopt_variant" ? "diagnose" : ["instruction", "review_issues"].includes(input.kind) ? "revise" : "patch",
        review_issues: input.kind === "review_issues",
        previous,
        product: revisionProduct,
        patches,
        ...(adoptedVariant ? { content: adoptedVariant.content, variant_adoption: variantAdoption } : {}),
      }),
      202,
    );
  }
  // 同类对照：结果页直接看，不用先导出报告。基线读不到就整块不出现，不拿半截数据糊结论。
  const benchmarkMatch = /^\/api\/listings\/([^/]+)\/benchmark$/.exec(path);
  if (benchmarkMatch && req.method === "GET") {
    const selectedVersion = url.searchParams.get("version");
    const record = assert(
      selectedVersion
        ? store.version(benchmarkMatch[1], Number(selectedVersion))
        : store.latest(benchmarkMatch[1]),
      "VERSION_NOT_FOUND",
      "找不到要对照的版本。",
    );
    const requestedScope = z.object({
      marketplace: z.enum(["US", "DE", "UK", "FR"]).optional(),
      language: z.enum(["en", "es", "zh", "de", "fr"]).optional(),
    }).parse({
      marketplace: url.searchParams.get("marketplace") ?? undefined,
      language: url.searchParams.get("language") ?? undefined,
    });
    try {
      return json(res, benchmarkForRecord(record, requestedScope));
    } catch (error) {
      if (error?.code === "BENCHMARK_SCOPE_MISMATCH") throw error;
      return json(res, { unavailable: "基线数据未随包提供，本节不显示。" });
    }
  }
  const exportMatch = /^\/api\/listings\/([^/]+)\/export$/.exec(path);
  if (exportMatch && req.method === "GET") {
    const selected = url.searchParams.get("version");
    const record = assert(
      selected
        ? store.version(exportMatch[1], Number(selected))
        : store.latest(exportMatch[1]),
      "VERSION_NOT_FOUND",
      "找不到要导出的版本。",
    );
    const format = url.searchParams.get("format") || "json";
    if (!["json", "txt", "html", "worklist", "copy"].includes(format))
      throw new AppError("INVALID_FORMAT", "不支持该导出格式。");
    const type = {
      json: "application/json",
      txt: "text/plain",
      html: "text/html",
      worklist: "text/html",
      copy: "text/plain",
    }[format];
    res.writeHead(200, {
      "Content-Type": `${type}; charset=utf-8`,
      "Content-Disposition": `${["html", "worklist"].includes(format) && url.searchParams.get("disposition") === "inline" ? "inline" : "attachment"}; filename="listing-v${record.version}${format === "copy" ? "-copy.txt" : format === "worklist" ? "-worklist.html" : "." + format}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    return res.end(
      format === "copy"
        ? [record.content.title, record.content.item_highlights, ...record.content.bullet_points.map(b => b.text), record.content.description].filter(Boolean).join('\n\n')
        : format === "json"
        ? JSON.stringify(record, null, 2)
        : format === "txt"
          ? textExport(record)
          : format === "worklist"
            ? exportListingWorklist(record, store.sources())
            : exportListingReport(record, store.versions(record.listing_id), store.sources()),
    );
  }
  // A+ 对比表：由该版本关联的商品参数确定性生成，不调用模型、不编造事实。
  const aplusMatch = /^\/api\/listings\/([^/]+)\/aplus$/.exec(path);
  if (aplusMatch && req.method === "GET") {
    const selected = url.searchParams.get("version");
    const record = assert(
      selected
        ? store.version(aplusMatch[1], Number(selected))
        : store.latest(aplusMatch[1]),
      "VERSION_NOT_FOUND",
      "找不到要生成 A+ 内容的版本。",
    );
    if (!record.product_snapshot)
      throw new AppError(
        "PRODUCT_REQUIRED",
        "这条文案没有关联商品，无法生成 A+ 对比表。",
      );
    return json(
      res,
      buildAplus(record.product_snapshot, {
        marketplace: record.marketplace || "US",
        language: record.language || "en",
      }),
    );
  }
  // 竞品差评 VOC：确定性痛点召回 + （配置了模型时）语义痛点与打痛点卖点。模型未配置不报错，保留确定性结果并标注。
  const vocMatch = /^\/api\/listings\/([^/]+)\/voc$/.exec(path);
  if (vocMatch && req.method === "POST") {
    const selected = url.searchParams.get("version");
    const record = assert(
      selected
        ? store.version(vocMatch[1], Number(selected))
        : store.latest(vocMatch[1]),
      "VERSION_NOT_FOUND",
      "找不到要分析差评的文案版本。",
    );
    if (!record.product_snapshot)
      throw new AppError(
        "PRODUCT_REQUIRED",
        "这条文案没有关联商品，无法按商品事实生成打痛点卖点。",
      );
    const input = z
      .object({ reviews: z.string().max(200000) })
      .parse(await body(req));
    const reviews = parseReviews(input.reviews);
    if (!reviews.length)
      throw new AppError("REVIEWS_REQUIRED", "请粘贴至少一条竞品差评。");
    return json(
      res,
      await analyzeReviews({
        reviews,
        product: record.product_snapshot,
        config: getConfig(store),
        language: record.language || "en",
      }),
    );
  }
  // 搜索词覆盖核对：解析真实搜索词，核对是否已写进文案。确定性，不编造流量词。
  const keywordMatch = /^\/api\/listings\/([^/]+)\/keywords$/.exec(path);
  if (keywordMatch && req.method === "POST") {
    const selected = url.searchParams.get("version");
    const record = assert(
      selected
        ? store.version(keywordMatch[1], Number(selected))
        : store.latest(keywordMatch[1]),
      "VERSION_NOT_FOUND",
      "找不到要核对搜索词的文案版本。",
    );
    const input = z
      .object({ aba_text: z.string().max(200000) })
      .parse(await body(req));
    const terms = parseSearchTerms(input.aba_text);
    if (!terms.length)
      throw new AppError(
        "TERMS_REQUIRED",
        "没有识别到搜索词，请粘贴每行一个搜索词或 ABA 报告。",
      );
    return json(res, buildKeywordReport(terms, record.content));
  }
  // A/B 变体：同一商品事实生成三版卖点角度文案，需要真实模型。
  const variantsMatch = /^\/api\/listings\/([^/]+)\/variants$/.exec(path);
  if (variantsMatch && req.method === "GET") {
    const selected = Number(url.searchParams.get("version"));
    return json(res, selected ? store.latestVariantSet(variantsMatch[1], selected) : null);
  }
  if (variantsMatch && req.method === "POST") {
    const selected = url.searchParams.get("version");
    const record = assert(
      selected
        ? store.version(variantsMatch[1], Number(selected))
        : store.latest(variantsMatch[1]),
      "VERSION_NOT_FOUND",
      "找不到要生成变体的文案版本。",
    );
    if (!record.product_snapshot)
      throw new AppError(
        "PRODUCT_REQUIRED",
        "这条文案没有关联商品，无法生成 A/B 变体。",
      );
    const pack = rulePackFor(record.marketplace || DEFAULT_MARKETPLACE);
    const generated = await generateVariants({
        product: record.product_snapshot,
        config: getConfig(store),
        language: record.language || "en",
        marketplace: record.marketplace || "US",
        rules: pack.rules,
      });
    const result = {
      ...generated,
      variant_set_id: id("variant-set"),
      listing_id: record.listing_id,
      base_version: record.version,
      generated_at: new Date().toISOString(),
    };
    store.saveVariantSet(result);
    return json(res, result, 201);
  }
  // 补资料协同看板：按岗位分组待补资料，确定性、只读。
  const rolesMatch = /^\/api\/listings\/([^/]+)\/roles$/.exec(path);
  if (rolesMatch && req.method === "GET") {
    const selected = url.searchParams.get("version");
    const record = assert(
      selected
        ? store.version(rolesMatch[1], Number(selected))
        : store.latest(rolesMatch[1]),
      "VERSION_NOT_FOUND",
      "找不到要生成协同看板的文案版本。",
    );
    return json(res, buildRiskCenter(record));
  }
  // 上架前完整度检查：按该版本关联商品档案确定性生成，不冒充官方完整要求。
  const readinessMatch = /^\/api\/listings\/([^/]+)\/readiness$/.exec(path);
  if (readinessMatch && req.method === "GET") {
    const selected = url.searchParams.get("version");
    const record = assert(
      selected
        ? store.version(readinessMatch[1], Number(selected))
        : store.latest(readinessMatch[1]),
      "VERSION_NOT_FOUND",
      "找不到要检查的文案版本。",
    );
    if (!record.product_snapshot)
      throw new AppError("PRODUCT_REQUIRED", "这条文案没有关联商品，无法做上架前检查。");
    return json(
      res,
      buildReadiness(record.product_snapshot, {
        marketplace: record.marketplace || "US",
      }),
    );
  }
  // 变体与父子 SKU 一致性审核：确定性检查商品档案与文案中的变体字段。
  const variationMatch = /^\/api\/listings\/([^/]+)\/variation-check$/.exec(path);
  if (variationMatch && req.method === "GET") {
    const selected = url.searchParams.get("version");
    const record = assert(
      selected
        ? store.version(variationMatch[1], Number(selected))
        : store.latest(variationMatch[1]),
      "VERSION_NOT_FOUND",
      "找不到要核对变体的文案版本。",
    );
    return json(res, checkVariation(record.product_snapshot, record.content));
  }
  // 证据生命周期台账：只读、确定性，按商品档案里的材料记录整理。
  const evidenceBoardMatch = /^\/api\/listings\/([^/]+)\/evidence$/.exec(path);
  if (evidenceBoardMatch && req.method === "GET") {
    const selected = url.searchParams.get("version");
    const record = assert(
      selected
        ? store.version(evidenceBoardMatch[1], Number(selected))
        : store.latest(evidenceBoardMatch[1]),
      "VERSION_NOT_FOUND",
      "找不到要查看证据的文案版本。",
    );
    return json(res, buildEvidenceBoard(record.product_snapshot));
  }
  throw new AppError("NOT_FOUND", "接口不存在。", 404);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${hostname}:${port}`);
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD")
      throw new AppError("METHOD_NOT_ALLOWED", "不支持该请求方式。", 405);
    let file = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (file !== dist && !file.startsWith(dist + sep))
      throw new AppError("NOT_FOUND", "文件不存在。", 404);
    try {
      if (!(await stat(file)).isFile()) file = resolve(dist, "index.html");
    } catch {
      file = resolve(dist, "index.html");
    }
    let contents;
    try {
      contents = await readFile(file);
    } catch {
      throw new AppError(
        "BUILD_REQUIRED",
        "前端尚未构建。开发时请打开 http://127.0.0.1:5173，或先运行 npm run build。",
        503,
      );
    }
    const mime =
      {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
      }[extname(file)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": `${mime}; charset=utf-8`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": file.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=3600",
    });
    res.end(req.method === "HEAD" ? undefined : contents);
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof z.ZodError)
      return json(
        res,
        {
          error: {
            code: "VALIDATION_ERROR",
            message: error.issues
              .map((x) => `${x.path.join(".")}: ${x.message}`)
              .join("；"),
          },
        },
        400,
      );
    const safe =
      error instanceof AppError
        ? error
        : new AppError("INTERNAL_ERROR", "服务处理失败，请重试。", 500);
    // 标题 / 下一步一起下发：前端 toast 只显示 message，现场看到的就是这一句。
    const detail = describeFailure(safe);
    json(
      res,
      {
        error: {
          code: safe.code,
          message: safe.message,
          ...(detail.title && detail.title !== "处理失败" ? { title: detail.title } : {}),
          ...(detail.action ? { action: detail.action } : {}),
          ...(detail.upstream ? { upstream: detail.upstream } : {}),
          ...(safe.details ? { details: safe.details } : {}),
        },
      },
      safe.status,
    );
  }
});
server.listen(port, hostname, () => {
  console.log(`Listing Studio API: http://${hostname}:${port}`);
  // 服务端发的是 dist/：源码比产物新时，界面上看不到改动，而窗口以前一声不响。
  const warning = stalenessWarning(frontendStaleness(), {
    watching: process.execArgv.includes("--watch"),
  });
  for (const line of warning) console.warn(line);
});
// 端口被占时不再甩 Node 的裸堆栈：先问一句端口上那个进程是谁，再说下一步。
// 退出码 3 = 自己已经在跑（不算失败）／4 = 端口被别的程序占着，start-local.cmd 靠它分岔。
server.on("error", async (error) => {
  let probe = null;
  if (error?.code === "EADDRINUSE") probe = await probeOccupant({ hostname, port });
  const { exitCode, lines } = describeListenFailure({ error, hostname, port, probe });
  for (const line of lines) console.error(line);
  try {
    batchManager.close();
    store.close();
  } catch {
    /* 关闭失败不该盖住真正的原因 */
  }
  process.exit(exitCode);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      batchManager.close();
      store.close();
      process.exit(0);
    }),
  );
