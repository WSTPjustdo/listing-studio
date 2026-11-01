// Real official source + existing real DeepSeek text. No paid call is made here.
// No merchant template/report has been supplied: those acceptance items stay pending.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { load } from "cheerio";
import { readTable } from "../server/flat-file.mjs";
import { prepareRows } from "../server/batch.mjs";
import { exportFlatFile } from "../server/flat-file-export.mjs";

const valueFor = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const directory = resolve(
  valueFor("--report-dir", "reports/flat-file-live-2026-10-28"),
);
const database = resolve(
  valueFor(
    "--database",
    process.env.DATABASE_PATH || ".runtime/listing-studio.sqlite",
  ),
);
mkdirSync(directory, { recursive: true });
const report = {
  started_at: new Date().toISOString(),
  evidence_type: "live_official_source_and_persisted_real_model_text",
  model_calls_performed: 0,
  model_calls_this_run: [],
  checks: [],
  merchant_acceptance: "pending",
  merchant_original_template: {
    status: "pending",
    source: null,
    reason: "商家原始库存模板尚未提供。",
  },
  merchant_seller_sku: { status: "unknown", value: null },
  merchant_roundtrip: {
    status: "pending",
    reason: "没有商家原文件及已确认真实卖家 SKU，不能用厂家产品代码替代。",
  },
  platform_processing_report: {
    status: "pending",
    source: null,
    reason: "尚未取得真实 Seller Central 处理报告。",
  },
  amazon_upload: { status: "not_performed", result: null },
  notice:
    "本轮仅验证实时官方公开商品数据、已有真实模型文案及缺 SKU 拦截；不是商家库存、Amazon 模板兼容或上架验收。结构测试另见 unit_fixture 报告。",
};
const save = () =>
  writeFileSync(
    resolve(directory, "acceptance.json"),
    JSON.stringify(report, null, 2),
  );
const quote = (value) =>
  /[\t\r\n"]/.test(String(value))
    ? `"${String(value).replaceAll('"', '""')}"`
    : String(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
save();
let connection;
try {
  assert.ok(
    existsSync(database),
    "Existing local real-model database is required. Run the real workflow first; there is no demo fallback.",
  );
  connection = new DatabaseSync(database, { readOnly: true });
  const records = connection
    .prepare(
      `SELECT data FROM versions
    WHERE json_extract(data, '$.trace.actual_model_call') = 1
      AND json_extract(data, '$.is_demo') = 0
      AND json_extract(data, '$.product_snapshot.reference_product_id') = 'W101'
    ORDER BY rowid DESC LIMIT 1`,
    )
    .all();
  assert.equal(
    records.length,
    1,
    "An existing real W101 model record is required; no content is generated or simulated by this script.",
  );
  const record = JSON.parse(records[0].data);
  connection.close();
  connection = null;
  assert.ok(
    record.trace.provider_request_id && /^deepseek/i.test(record.trace.model),
    "The saved record must contain an actual DeepSeek request ID and model.",
  );
  assert.ok(
    record.review &&
      record.content.title &&
      record.content.description &&
      record.content.bullet_points.length > 0,
  );
  const immutableRecord = JSON.stringify(record);
  report.reused_model_record = {
    listing_id: record.listing_id,
    version: record.version,
    created_at: record.created_at || null,
    product_id: record.product_snapshot.product_id,
    request_id: record.trace.provider_request_id ?? null,
    model: record.trace.model ?? null,
    elapsed_ms: record.trace.elapsed_ms ?? null,
    usage: record.trace.usage ?? null,
    actual_model_call: true,
    reused_record_not_new_call: true,
    content_sha256: hash(JSON.stringify(record.content)),
  };
  report.unresolved = {
    review_issues: record.review.issues ?? null,
    missing_data: record.review.missing_data ?? null,
    unchecked:
      record.review.checks?.filter((check) =>
        ["not_checked", "error", "needs_evidence"].includes(check.state),
      ) ?? null,
  };
  save();

  const officialUrl = "https://westfordmill.com/products/w101";
  const response = await fetch(officialUrl, {
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(
    response.status,
    200,
    `Official source HTTP ${response.status}; live acceptance cannot fall back to a snapshot.`,
  );
  assert.equal(new URL(response.url).hostname, "westfordmill.com");
  const $ = load(await response.text());
  $("script,style,nav,footer").remove();
  const pageText = $("body").text().replace(/\s+/g, " ").trim();
  for (const text of ["100% Cotton", "140gsm", "38 x 42"])
    assert.ok(
      pageText.includes(text),
      `Official source fact changed or unavailable: ${text}`,
    );
  assert.ok(
    /\bW101\b/i.test(pageText),
    "The live official page must identify W101.",
  );
  report.official_source = {
    url: response.url,
    checked_at: new Date().toISOString(),
    status: response.status,
    publisher: "Westford Mill",
    manufacturer_product_code: "W101",
    verified_facts: {
      material: "100% Cotton",
      fabric_weight_gsm: 140,
      dimensions_cm: { width: 38, height: 42 },
    },
    merchant_sku: null,
    merchant_inventory: null,
    selected_colour: null,
    retail_pack_count: null,
  };
  report.checks.push(
    "live_official_w101_product_and_material_weight_dimensions_verified",
  );
  save();

  const headers = [
    "manufacturer_product_code",
    "item_sku",
    "item_name",
    "brand_name",
    "material",
    ...Array.from({ length: 5 }, (_, index) => `bullet_point${index + 1}`),
    "product_description",
    "source_url",
  ];
  assert.ok(
    record.content.bullet_points.length <= 5,
    "Existing real content exceeds the public-derived five-column test file; content must not be truncated.",
  );
  const values = [
    "W101",
    "",
    record.content.title,
    "Westford Mill",
    "100% Cotton",
    ...Array.from(
      { length: 5 },
      (_, index) => record.content.bullet_points[index]?.text || "",
    ),
    record.content.description,
    response.url,
  ];
  const buffer = Buffer.from(
    [headers, values].map((row) => row.map(quote).join("\t")).join("\r\n") +
      "\r\n",
  );
  const filename = "public-derived-w101-without-seller-sku.tsv";
  writeFileSync(resolve(directory, filename), buffer);
  report.file_provenance = {
    filename,
    sha256: hash(buffer),
    source_kind: "public_source_and_existing_model_text_derived_file",
    merchant_original: false,
    official_amazon_template: false,
    manufacturer_product_code: "W101",
    seller_sku: null,
  };
  const source = await readTable(filename, buffer);
  assert.equal(source.mapping.sku, 1);
  assert.equal(source.rows.length, 1);
  assert.equal(source.rows[0].cells[0], "W101");
  assert.equal(source.rows[0].cells[source.mapping.sku], "");
  assert.equal(
    source.rows[0].cells[source.mapping.title],
    record.content.title,
  );
  assert.equal(
    source.rows[0].cells[source.mapping.description],
    record.content.description,
  );
  for (let index = 0; index < 5; index++)
    assert.equal(
      source.rows[0].cells[source.mapping[`bullet_point${index + 1}`]],
      record.content.bullet_points[index]?.text || "",
    );
  assert.equal(source.schema.official_compatibility, "not_verified");
  report.checks.push(
    "real_persisted_content_maps_to_distinct_bullets_without_loss_or_model_substitution",
  );

  const store = {
    products: () => [],
    libraryEntry: () => null,
    latest: (listingId) => (listingId === record.listing_id ? record : null),
  };
  const prepared = prepareRows(store, source, {
    import_id: "public-derived-w101",
    mapping: source.mapping,
    operation: "diagnose",
    duplicate: "skip",
    confirm_scope: true,
    selected: [source.rows[0].number],
    edits: {},
    dry_run: true,
  });
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].status, "blocked");
  assert.equal(prepared[0].sku, "");
  assert.equal(prepared[0].product.sku, "");
  assert.ok(prepared[0].errors.some((error) => /SKU/.test(error)));
  report.import_validation = {
    status: prepared[0].status,
    sku: null,
    errors: prepared[0].errors,
    persisted: false,
  };
  report.checks.push(
    "missing_real_seller_sku_blocks_processing_without_auto_identifier",
  );
  const batch = {
    id: "public-derived-w101-sku-block-check",
    mapping: source.mapping,
    rows: [
      {
        row: source.rows[0].number,
        sku: "",
        status: "blocked",
        listing_id: record.listing_id,
      },
    ],
  };
  try {
    await exportFlatFile(store, batch, source);
    assert.fail("Missing seller SKU must block export.");
  } catch (error) {
    assert.equal(error.code, "FLAT_FILE_EXPORT_UNSAFE");
    assert.equal(error.details?.validation?.safe_to_export, false);
    assert.ok(
      error.details.validation.issues.some(
        (issue) => issue.code === "SKU_REQUIRED",
      ),
    );
    report.export_validation = error.details.validation;
  }
  report.checks.push(
    "manufacturer_code_is_not_used_as_seller_sku_and_export_is_blocked",
  );
  assert.equal(JSON.stringify(record), immutableRecord);
  assert.equal(source.rows[0].cells[source.mapping.sku], "");
  report.checks.push("original_model_record_and_unknown_sku_remain_unchanged");
  report.status = "passed_available_scope_merchant_validation_pending";
  report.completed_at = new Date().toISOString();
  save();
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks,
      model_calls_performed: 0,
      reused_request_id: report.reused_model_record.request_id,
      merchant_acceptance: report.merchant_acceptance,
      report: resolve(directory, "acceptance.json"),
    }),
  );
} catch (error) {
  report.status = "failed";
  report.failure = { code: error.code || null, message: error.message };
  save();
  throw error;
} finally {
  connection?.close();
}
