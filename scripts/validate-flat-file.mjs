// Program boundary checks only. Structural fixtures are NOT merchant acceptance.
// The content used for export is an unchanged, persisted real DeepSeek record.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
import { readTable, suggestMapping } from "../server/flat-file.mjs";
import { exportFlatFile } from "../server/flat-file-export.mjs";
import { parseProcessingReport } from "../server/processing-report.mjs";
import { prepareRows } from "../server/batch.mjs";

const flag = process.argv.indexOf("--report-dir");
const directory = resolve(
  flag >= 0 ? process.argv[flag + 1] : ".runtime/flat-file-unit",
);
mkdirSync(directory, { recursive: true });
const report = {
  started_at: new Date().toISOString(),
  evidence_type: "unit_fixture",
  merchant_acceptance: false,
  model_calls_performed: 0,
  notice:
    "Synthetic identifiers and file structures below test program boundaries only; they are not merchant data or official Amazon templates. No model response is simulated.",
  checks: [],
  merchant_template: "unknown",
  platform_processing_report: "unknown",
};
const save = () =>
  writeFileSync(
    resolve(directory, "boundary-checks.json"),
    JSON.stringify(report, null, 2),
  );
async function check(name, action) {
  try {
    await action();
    report.checks.push({
      name,
      status: "passed",
      evidence_type: "unit_fixture",
    });
  } catch (error) {
    report.checks.push({
      name,
      status: "failed",
      error: { code: error.code || null, message: error.message },
    });
    save();
    throw error;
  }
  save();
}
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const quote = (value) =>
  /[\t\r\n"]/.test(String(value))
    ? `"${String(value).replaceAll('"', '""')}"`
    : String(value);
const encodeTsv = (rows) =>
  Buffer.from(
    "\uFEFF" +
      rows.map((row) => row.map(quote).join("\t")).join("\r\n") +
      "\r\n",
  );
const unsafe = async (action) => {
  try {
    await action();
    assert.fail("Unsafe export unexpectedly succeeded");
  } catch (error) {
    assert.equal(error.code, "FLAT_FILE_EXPORT_UNSAFE");
    assert.equal(error.details?.validation?.safe_to_export, false);
    return error.details.validation;
  }
};

try {
  const recordPath = resolve(
    "reports/merchant-improvements-2026-10-24/final-record.json",
  );
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.ok(
    record.trace?.actual_model_call &&
      record.trace.provider_request_id &&
      record.review &&
      !record.is_demo,
    "An actual saved model record is required; there is no mock fallback.",
  );
  report.content_provenance = {
    file: recordPath,
    listing_id: record.listing_id,
    version: record.version,
    request_id: record.trace.provider_request_id,
    model: record.trace.model,
    elapsed_ms: record.trace.elapsed_ms,
    usage: record.trace.usage,
  };
  const originalRecord = JSON.stringify(record);
  const store = {
    latest: (listingId) => (listingId === record.listing_id ? record : null),
  };
  const headers = [
    "item_sku",
    "item_name",
    "bullet_point1",
    "bullet_point2",
    "bullet_point3",
    "bullet_point4",
    "bullet_point5",
    "product_description",
    "unrecognized_merchant_column",
    "parentage",
    "parent_sku",
    "variation_theme",
    "feed_product_type",
  ];
  const childSku = "UNIT-FIXTURE-CHILD-001",
    parentSku = "UNIT-FIXTURE-PARENT-001";
  const passthrough = '  单元边界值\t含制表符\n和 "双引号"  ';
  const workbook = new ExcelJS.Workbook();
  workbook
    .addWorksheet("Instructions")
    .addRow(["UNIT FIXTURE ONLY — not a merchant file"]);
  const template = workbook.addWorksheet("Template");
  template.addRow([
    "TemplateType=unit_fixture;not_an_official_amazon_template",
  ]);
  template.addRow([
    "Seller SKU",
    "Product Name",
    "Bullet 1",
    "Bullet 2",
    "Bullet 3",
    "Bullet 4",
    "Bullet 5",
    "Description",
    "Unknown column",
  ]);
  template.addRow(headers);
  template.addRow([
    childSku,
    "unit fixture original title",
    "old 1",
    "old 2",
    "old 3",
    "old 4",
    "old 5",
    "unit fixture original description",
    passthrough,
    "child",
    parentSku,
    "Color",
    "tote_bag",
  ]);
  template.addRow([
    parentSku,
    "unit fixture parent row",
    "",
    "",
    "",
    "",
    "",
    "",
    "preserve parent",
    "parent",
    "",
    "Color",
    "tote_bag",
  ]);
  workbook.addWorksheet("Valid Values").addRow(["UNIT FIXTURE ONLY"]);
  const original = Buffer.from(await workbook.xlsx.writeBuffer());
  let source;
  await check(
    "select_template_and_machine_header_without_reading_instructions_as_products",
    async () => {
      source = await readTable("unit_fixture.xlsx", original);
      assert.equal(source.sheet, "Template");
      assert.equal(source.header_row, 3);
      assert.equal(source.data_start_row, 4);
      assert.deepEqual(
        source.rows.map((row) => row.number),
        [4, 5],
      );
      assert.equal(source.mapping.sku, 0);
      for (let index = 1; index <= 5; index++)
        assert.equal(source.mapping[`bullet_point${index}`], index + 1);
      assert.equal(source.schema.official_compatibility, "not_verified");
      const explicit = await readTable(
        "unit_fixture.xlsx",
        original,
        "Template",
        3,
      );
      assert.deepEqual(explicit.headers, headers);
    },
  );
  await check("auxiliary_or_missing_sheet_requires_selection", async () => {
    for (const sheet of ["Instructions", "missing-unit-fixture-sheet"]) {
      const result = await readTable("unit_fixture.xlsx", original, sheet);
      assert.equal(result.selection_required, true);
      assert.equal(result.rows.length, 0);
    }
  });
  await check(
    "marketplace_attribute_paths_keep_all_five_distinct_bullet_indexes",
    async () => {
      const mapping = suggestMapping(
        Array.from(
          { length: 5 },
          (_, index) =>
            `bullet_point[marketplace_id=ATVPDKIKX0DER][language_tag=en_US]#${index + 1}.value`,
        ),
      );
      for (let index = 1; index <= 5; index++)
        assert.equal(mapping[`bullet_point${index}`], index - 1);
    },
  );
  const tsvHeaders = headers.slice(0, 9);
  const tsv = encodeTsv([
    tsvHeaders,
    [
      "000001",
      "unit fixture title",
      "old 1",
      "old 2",
      "old 3",
      "old 4",
      "old 5",
      "unit fixture description",
      passthrough,
    ],
  ]);
  let textSource;
  await check(
    "tsv_and_txt_preserve_identifier_quotes_bom_and_multiline_cells",
    async () => {
      for (const extension of ["tsv", "txt"]) {
        const result = await readTable(`unit_fixture.${extension}`, tsv);
        assert.equal(result.rows[0].cells[0], "000001");
        assert.equal(result.rows[0].cells[8], passthrough);
        assert.equal(result.has_bom, true);
        assert.equal(result.newline, "\r\n");
        assert.equal(result.delimiter, "\t");
        if (extension === "tsv") textSource = result;
      }
    },
  );
  await check(
    "invalid_utf8_and_unclosed_quotes_fail_without_repairing_input",
    async () => {
      await assert.rejects(
        () => readTable("unit_fixture.tsv", Buffer.from([0xc3, 0x28])),
        (error) => error.code === "TEXT_ENCODING",
      );
      await assert.rejects(
        () =>
          readTable(
            "unit_fixture.txt",
            Buffer.from('item_sku\titem_name\nfixture\t"unclosed'),
          ),
        (error) => error.code === "FILE_PARSE",
      );
    },
  );
  await check(
    "data_formulas_require_values_instead_of_using_cached_results",
    async () => {
      const book = new ExcelJS.Workbook();
      const sheet = book.addWorksheet("Template");
      sheet.addRow(["item_sku", "item_name"]);
      sheet.addRow([
        "UNIT-FIXTURE-FORMULA",
        { formula: '"old cached title"', result: "old cached title" },
      ]);
      const formulaBuffer = Buffer.from(await book.xlsx.writeBuffer());
      await assert.rejects(
        () => readTable("unit_fixture.xlsx", formulaBuffer),
        (error) => error.code === "FORMULA_INPUT",
      );
    },
  );
  const batch = {
    id: "unit_fixture_batch",
    import_id: "unit_fixture_import",
    mapping: source.mapping,
    rows: [
      {
        row: 4,
        sku: childSku,
        status: "completed",
        listing_id: record.listing_id,
      },
      { row: 5, sku: parentSku, status: "preserved" },
    ],
  };
  await check(
    "xlsx_roundtrip_changes_only_mapped_copy_and_keeps_parent_unknown_columns_and_headers",
    async () => {
      const result = await exportFlatFile(store, batch, source);
      assert.equal(result.validation.safe_to_export, true);
      assert.equal(result.validation.upload_readiness, "not_verified");
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(result.buffer);
      assert.deepEqual(
        book.worksheets.map((sheet) => sheet.name),
        workbook.worksheets.map((sheet) => sheet.name),
      );
      const sheet = book.getWorksheet("Template");
      for (const row of [1, 2, 3, 5])
        assert.deepEqual(sheet.getRow(row).values, template.getRow(row).values);
      assert.equal(sheet.getCell(4, 1).text, childSku);
      assert.equal(sheet.getCell(4, 2).text, record.content.title);
      for (let index = 0; index < 5; index++)
        assert.equal(
          sheet.getCell(4, index + 3).text,
          record.content.bullet_points[index]?.text || "",
        );
      assert.equal(sheet.getCell(4, 8).text, record.content.description);
      assert.equal(sheet.getCell(4, 9).text, passthrough);
      for (let column = 10; column <= headers.length; column++)
        assert.equal(
          sheet.getCell(4, column).text,
          template.getCell(4, column).text,
        );
      writeFileSync(
        resolve(directory, "unit-fixture-roundtrip.xlsx"),
        result.buffer,
      );
    },
  );
  const textBatch = {
    id: "unit_fixture_tsv_batch",
    mapping: textSource.mapping,
    rows: [
      {
        row: 2,
        sku: "000001",
        status: "completed",
        listing_id: record.listing_id,
      },
    ],
  };
  await check(
    "tsv_roundtrip_preserves_bom_newline_unknown_data_and_exact_real_copy",
    async () => {
      const exported = await exportFlatFile(store, textBatch, textSource);
      const reread = await readTable(exported.filename, exported.buffer);
      assert.equal(reread.has_bom, true);
      assert.equal(reread.newline, "\r\n");
      assert.deepEqual(reread.headers, tsvHeaders);
      assert.equal(reread.rows[0].cells[0], "000001");
      assert.equal(reread.rows[0].cells[1], record.content.title);
      assert.equal(reread.rows[0].cells[8], passthrough);
      assert.equal(reread.rows[0].cells[7], record.content.description);
      writeFileSync(
        resolve(directory, "unit-fixture-roundtrip.tsv"),
        exported.buffer,
      );
    },
  );
  await check(
    "missing_seller_sku_blocks_export_without_generating_an_identifier",
    async () => {
      const emptySource = await readTable(
        "unit_fixture_missing_sku.tsv",
        encodeTsv([
          tsvHeaders,
          [
            "",
            "unit fixture title",
            "",
            "",
            "",
            "",
            "",
            "",
            "unknown SKU remains blank",
          ],
        ]),
      );
      const validation = await unsafe(() =>
        exportFlatFile(
          store,
          {
            ...textBatch,
            mapping: emptySource.mapping,
            rows: [
              {
                row: 2,
                sku: "",
                status: "completed",
                listing_id: record.listing_id,
              },
            ],
          },
          emptySource,
        ),
      );
      assert.ok(
        validation.issues.some(
          (issue) => issue.field === "sku" || /SKU/.test(issue.code),
        ),
      );
      assert.equal(emptySource.rows[0].cells[0], "");
    },
  );
  const emptyCatalog = { products: () => [], libraryEntry: () => null };
  const dryInput = (table, selected, edits = {}) => ({
    import_id: "unit_fixture_dry_run",
    mapping: table.mapping,
    operation: "diagnose",
    duplicate: "skip",
    confirm_scope: true,
    selected,
    edits,
    dry_run: true,
  });
  await check(
    "sku_entered_only_in_preview_cannot_bypass_an_empty_original_sku_cell",
    async () => {
      const table = await readTable(
        "unit_fixture_missing_sku.tsv",
        encodeTsv([
          tsvHeaders,
          [
            "",
            "unit fixture title",
            "",
            "",
            "",
            "",
            "",
            "",
            "unknown seller SKU",
          ],
        ]),
      );
      const rows = prepareRows(
        emptyCatalog,
        table,
        dryInput(table, [2], { 2: { sku: "UNIT-FIXTURE-PREVIEW-ONLY" } }),
      );
      assert.equal(rows[0].status, "blocked");
      assert.ok(
        rows[0].errors.some((error) => /原表 SKU 单元格为空/.test(error)),
      );
      assert.equal(table.rows[0].cells[0], "");
    },
  );
  await check(
    "duplicate_original_skus_block_processing_even_when_only_one_row_is_selected",
    async () => {
      const table = await readTable(
        "unit_fixture_duplicates.tsv",
        encodeTsv([
          tsvHeaders,
          ["UNIT-FIXTURE-DUPLICATE", "unit fixture first row"],
          ["UNIT-FIXTURE-DUPLICATE", "unit fixture second row"],
        ]),
      );
      const rows = prepareRows(emptyCatalog, table, dryInput(table, [3]));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "blocked");
      assert.ok(
        rows[0].errors.some((error) => /原文件内 SKU 重复/.test(error)),
      );
    },
  );
  await check(
    "parent_structure_is_preserved_and_child_input_keeps_five_distinct_bullets",
    async () => {
      const headers = [
        "item_sku",
        "item_name",
        "product_description",
        ...Array.from({ length: 5 }, (_, index) => `bullet_point${index + 1}`),
        "parentage",
        "parent_sku",
        "variation_theme",
        "color_name",
        "relationship_type",
        "material",
      ];
      const parent = [
        "UNIT-FIXTURE-FAMILY-PARENT",
        "unit fixture parent",
        "",
        "",
        "",
        "",
        "",
        "",
        "parent",
        "",
        "Color",
        "",
        "",
        "",
      ];
      const child = [
        "UNIT-FIXTURE-FAMILY-CHILD",
        "unit fixture child",
        "unit fixture description",
        ...Array.from(
          { length: 5 },
          (_, index) => `unit fixture input bullet ${index + 1}`,
        ),
        "child",
        "UNIT-FIXTURE-FAMILY-PARENT",
        "Color",
        "unit fixture color",
        "variation",
        "unit fixture material",
      ];
      const table = await readTable(
        "unit_fixture_family.tsv",
        encodeTsv([headers, parent, child]),
      );
      const rows = prepareRows(emptyCatalog, table, dryInput(table, [2, 3]));
      assert.equal(rows[0].status, "preserved");
      assert.equal(rows[1].status, "queued");
      assert.deepEqual(rows[1].errors, []);
      assert.deepEqual(
        rows[1].content.bullet_points.map((bullet) => bullet.text),
        child.slice(3, 8),
      );
      assert.equal(rows[1].product.variation.parent_sku, parent[0]);
      assert.equal(rows[1].product.variation.theme, "Color");
      const changed = prepareRows(
        emptyCatalog,
        table,
        dryInput(table, [3], {
          3: { parent_sku: "UNIT-FIXTURE-OTHER-PARENT" },
        }),
      );
      assert.equal(changed[0].status, "blocked");
      assert.ok(
        changed[0].errors.some((error) => /变体关系须在原文件确认/.test(error)),
      );
    },
  );
  await check(
    "uncompleted_copy_cannot_be_exported_as_finished_model_content",
    async () => {
      await unsafe(() =>
        exportFlatFile(
          store,
          { ...textBatch, rows: [{ ...textBatch.rows[0], status: "failed" }] },
          textSource,
        ),
      );
    },
  );
  await check(
    "processing_report_matches_by_sku_and_never_guesses_unknown_or_conflicting_rows",
    async () => {
      const reportBuffer = encodeTsv([
        [
          "sku",
          "original-record-number",
          "error-code",
          "error-type",
          "error-message",
        ],
        [childSku, "1", "UNIT-ERROR", "Error", "unit fixture message"],
        [
          "UNIT-FIXTURE-NOT-IN-SOURCE",
          "1",
          "UNIT-UNKNOWN",
          "Error",
          "must remain unmatched",
        ],
        [parentSku, "1", "UNIT-CONFLICT", "Error", "SKU and row disagree"],
      ]);
      const parsed = await parseProcessingReport(
        "unit_fixture_report.tsv",
        reportBuffer,
        batch,
        source,
      );
      const found = parsed.issues.find((issue) => issue.code === "UNIT-ERROR");
      assert.equal(found?.match_state, "matched");
      assert.equal(found?.row, 4);
      assert.equal(found?.source_row, 2);
      assert.notEqual(
        parsed.issues.find((issue) => issue.code === "UNIT-UNKNOWN")
          ?.match_state,
        "matched",
      );
      assert.notEqual(
        parsed.issues.find((issue) => issue.code === "UNIT-CONFLICT")
          ?.match_state,
        "matched",
      );
      report.processing_report_boundary = parsed.summary;
    },
  );
  await check(
    "error_row_export_with_no_content_application_keeps_original_values",
    async () => {
      const result = await exportFlatFile(
        store,
        { ...textBatch, rows: [{ ...textBatch.rows[0], status: "failed" }] },
        textSource,
        { rowNumbers: [2], onlyRows: true, applyContent: false },
      );
      const reread = await readTable(result.filename, result.buffer);
      assert.equal(reread.rows.length, 1);
      assert.deepEqual(reread.rows[0].cells, textSource.rows[0].cells);
    },
  );
  await check(
    "unselected_source_rows_still_prevent_ambiguous_report_number_matching",
    async () => {
      const sparseBook = new ExcelJS.Workbook();
      const sheet = sparseBook.addWorksheet("Template");
      sheet.getCell(1, 1).value = "UNIT FIXTURE ONLY";
      sheet.getCell(2, 1).value = "unit fixture labels";
      sheet.getRow(3).values = tsvHeaders;
      sheet.getRow(4).values = ["UNIT-FIXTURE-SPARSE-A", "unit fixture A"];
      sheet.getRow(7).values = ["UNIT-FIXTURE-SPARSE-B", "unit fixture B"];
      const sparseSource = await readTable(
        "unit_fixture_sparse.xlsx",
        Buffer.from(await sparseBook.xlsx.writeBuffer()),
      );
      const sparseBatch = {
        id: "unit_fixture_sparse",
        mapping: sparseSource.mapping,
        rows: [{ row: 7, sku: "UNIT-FIXTURE-SPARSE-B", status: "failed" }],
      };
      const headers = ["original-record-number", "error-code", "error-message"];
      const ambiguous = await parseProcessingReport(
        "unit_fixture_report.tsv",
        encodeTsv([
          headers,
          ["4", "UNIT-AMBIGUOUS", "fixture row numbering is ambiguous"],
        ]),
        sparseBatch,
        sparseSource,
      );
      assert.equal(ambiguous.issues[0].match_state, "ambiguous");
      assert.equal(ambiguous.issues[0].row, undefined);
      const exported = await exportFlatFile(store, sparseBatch, sparseSource, {
        rowNumbers: [7],
        onlyRows: true,
        applyContent: false,
      });
      assert.deepEqual(exported.export_manifest, [
        {
          original_row: 7,
          file_row: 4,
          record_number: 1,
          sku: "UNIT-FIXTURE-SPARSE-B",
        },
      ]);
      assert.equal(
        exported.source_sha256,
        hash(Buffer.from(sparseSource.original_base64, "base64")),
      );
      assert.equal(exported.artifact_sha256, hash(exported.buffer));
      const matched = await parseProcessingReport(
        "unit_fixture_report.tsv",
        encodeTsv([
          headers,
          ["1", "UNIT-SUBSET", "fixture exported subset record"],
        ]),
        sparseBatch,
        sparseSource,
        { export_manifest: exported.export_manifest },
      );
      assert.equal(matched.issues[0].match_state, "matched");
      assert.equal(matched.issues[0].row, 7);
      assert.equal(matched.export_manifest_used, true);
    },
  );
  await check(
    "real_reviewed_copy_takes_precedence_over_pre_review_import_edits",
    async () => {
      const factSource = await readTable(
        "unit_fixture_fact_edit.tsv",
        encodeTsv([
          [...tsvHeaders, "material"],
          [...textSource.rows[0].cells, "unit fixture original material"],
        ]),
      );
      const edited = {
        ...textBatch,
        mapping: factSource.mapping,
        import_edits: {
          2: {
            1: "unit fixture pre-review title",
            8: "unit fixture pre-review extra column",
            9: "unit fixture corrected material",
          },
        },
      };
      const exported = await exportFlatFile(store, edited, factSource);
      const reread = await readTable(exported.filename, exported.buffer);
      assert.equal(reread.rows[0].cells[1], record.content.title);
      assert.equal(
        reread.rows[0].cells[8],
        "unit fixture pre-review extra column",
      );
      assert.equal(reread.rows[0].cells[9], "unit fixture corrected material");
    },
  );
  await check(
    "post_review_manual_copy_requires_unreviewed_export_instead_of_bypassing_real_review",
    async () => {
      const edited = {
        ...textBatch,
        file_edits: { 2: { 1: "unit fixture manually changed copy" } },
      };
      const validation = await unsafe(() =>
        exportFlatFile(store, edited, textSource),
      );
      assert.ok(
        validation.issues.some(
          (issue) => issue.code === "MANUAL_CONTENT_UNREVIEWED",
        ),
      );
      const unreviewed = await exportFlatFile(store, edited, textSource, {
        rowNumbers: [2],
        onlyRows: true,
        applyContent: true,
        allowManualContent: true,
      });
      assert.equal(
        unreviewed.validation.operation,
        "manual_correction_unreviewed",
      );
      assert.ok(unreviewed.filename.includes("correction-unreviewed"));
      assert.ok(
        unreviewed.validation.issues.some(
          (issue) => issue.code === "MANUAL_EDIT_UNREVIEWED",
        ),
      );
      const reread = await readTable(unreviewed.filename, unreviewed.buffer);
      assert.equal(
        reread.rows[0].cells[1],
        "unit fixture manually changed copy",
      );
      assert.equal(reread.rows[0].cells[7], record.content.description);
      for (let index = 0; index < 5; index++)
        assert.equal(
          reread.rows[0].cells[index + 2],
          record.content.bullet_points[index]?.text || "",
        );
      await assert.rejects(
        () =>
          exportFlatFile(store, edited, textSource, {
            rowNumbers: [2],
            onlyRows: true,
            applyContent: false,
            allowManualContent: true,
          }),
        (error) => error.code === "CORRECTION_CONTENT_REQUIRED",
      );
    },
  );
  await check(
    "manual_file_corrections_cannot_overwrite_seller_sku_even_for_unreviewed_export",
    async () => {
      const validation = await unsafe(() =>
        exportFlatFile(
          store,
          {
            ...textBatch,
            file_edits: { 2: { 0: "UNIT-FIXTURE-REPLACEMENT-SKU" } },
          },
          textSource,
          { rowNumbers: [2], onlyRows: true, applyContent: false },
        ),
      );
      assert.ok(
        validation.issues.some((issue) => issue.code === "SKU_EDIT_FORBIDDEN"),
      );
    },
  );
  await check(
    "exports_leave_source_file_and_real_model_record_immutable",
    async () => {
      assert.equal(
        hash(Buffer.from(source.original_base64, "base64")),
        hash(original),
      );
      assert.equal(JSON.stringify(record), originalRecord);
    },
  );
  report.status = "passed_program_boundaries_only";
  report.completed_at = new Date().toISOString();
  save();
  console.log(
    JSON.stringify({
      status: report.status,
      evidence_type: report.evidence_type,
      checks: report.checks.length,
      merchant_acceptance: false,
      report: resolve(directory, "boundary-checks.json"),
    }),
  );
} catch (error) {
  report.status = "failed";
  report.failure = { code: error.code || null, message: error.message };
  save();
  throw error;
}
