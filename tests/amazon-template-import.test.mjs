// Engineering parser fixtures only. These are not seller inventory, official
// Amazon templates, or real model acceptance. No model is invoked here.
import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
  decodeTableText,
  readTable,
  suggestMapping,
} from "../server/flat-file.mjs";
import { exportFlatFile } from "../server/flat-file-export.mjs";

const tsv = (rows) =>
  Buffer.from(rows.map((row) => row.join("\t")).join("\r\n"));
const attribute = (name, locale = "en_US", market = "ATVPDKIKX0DER") =>
  `${name}[marketplace_id=${market}][language_tag=${locale}]#1.value`;

test("modern nested inventory attribute paths map physical dimensions and preserve family identities", async () => {
  const headers = [
    "seller_sku",
    attribute("item_name"),
    "item_dimensions#1.width.value",
    "item_dimensions#1.width.unit",
    "item_dimensions#1.height.value",
    "item_dimensions#1.height.unit",
    "item_dimensions#1.depth.value",
    "item_dimensions#1.depth.unit",
    "item_package_dimensions#1.width.value",
    "child_parent_sku_relationship#1.parent_sku",
    "child_parent_sku_relationship#1.child_relationship_type",
    "variation_theme#1.name",
    "parentage_level#1.value",
  ];
  const child = [
    "000071",
    "ENGINEERING FIXTURE",
    "38",
    "centimeters",
    "42",
    "centimeters",
    "5",
    "centimeters",
    "50",
    "000070",
    "variation",
    "COLOR",
    "child",
  ];
  const source = await readTable("engineering-only.tsv", tsv([headers, child]));
  assert.equal(source.profile, "amazon_flat_file_candidate");
  for (const [key, index] of Object.entries({
    sku: 0,
    name: 1,
    title: 1,
    width: 2,
    width_unit: 3,
    height: 4,
    height_unit: 5,
    depth: 6,
    depth_unit: 7,
    parent_sku: 9,
    relationship_type: 10,
    variation_theme: 11,
    parentage: 12,
  }))
    assert.equal(source.mapping[key], index, key);
  assert.equal(source.rows[0].cells[0], "000071");
  assert.equal(source.rows[0].cells[9], "000070");
  assert.equal(source.schema.official_compatibility, "not_verified");
  assert.equal(
    suggestMapping(["item_package_dimensions#1.width.value"]).width,
    -1,
  );

  const output = await exportFlatFile(
    {},
    {
      rows: [{ row: 2, sku: "000071", status: "preserved" }],
      mapping: source.mapping,
    },
    source,
    { applyContent: false },
  );
  const reread = await readTable(output.filename, output.buffer);
  assert.deepEqual(reread.headers, headers);
  assert.deepEqual(reread.rows[0].cells, child);
});

test("repeated unnumbered bullet columns map in original column order without reusing numbered bullets", async () => {
  const headers = ["item_sku", "item_name", ...Array(5).fill("bullet_point")];
  const original = [
    "000081",
    "ENGINEERING FIXTURE",
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
  ];
  const source = await readTable(
    "engineering-repeated.tsv",
    tsv([headers, original]),
  );
  for (let number = 1; number <= 5; number++)
    assert.equal(source.mapping[`bullet_point${number}`], number + 1);
  assert.equal(source.mapping.bullet_points, -1);
  assert.deepEqual(source.rows[0].cells, original);

  const mixed = await readTable(
    "engineering-mixed.tsv",
    tsv([
      [
        "item_sku",
        "item_name",
        "bullet_point1",
        "bullet_point",
        "bullet_point",
      ],
      [
        "000082",
        "ENGINEERING FIXTURE",
        "first",
        "unconfirmed order A",
        "unconfirmed order B",
      ],
    ]),
  );
  assert.equal(mixed.mapping.bullet_point1, 2);
  assert.equal(mixed.mapping.bullet_point2, -1);
  assert.match(mixed.warnings.join("\n"), /同时含编号和无编号/);
});

test("multiple marketplace or language columns require an explicit mapping and retain all text", async () => {
  const headers = [
    "seller_sku",
    attribute("item_name", "es_US"),
    attribute("item_name"),
    attribute("product_description", "es_US"),
    attribute("product_description"),
  ];
  const original = [
    "000091",
    "ENGINEERING SPANISH",
    "ENGINEERING ENGLISH",
    "description es",
    "description en",
  ];
  const source = await readTable(
    "engineering-locales.tsv",
    tsv([headers, original]),
  );
  assert.equal(source.selection_required, false);
  assert.equal(source.mapping.sku, 0);
  assert.equal(source.mapping.title, -1);
  assert.equal(source.mapping.name, -1);
  assert.equal(source.mapping.description, -1);
  assert.deepEqual(
    source.mapping_ambiguities.find((item) => item.key === "title").indexes,
    [1, 2],
  );
  assert.match(source.warnings.join("\n"), /多个语言或站点/);
  assert.deepEqual(source.rows[0].cells, original);

  const mapping = suggestMapping([
    "seller_sku",
    attribute("item_name"),
    ...["en_US", "es_US"].flatMap((locale) =>
      Array.from(
        { length: 5 },
        (_, index) => `bullet_point[language_tag=${locale}]#${index + 1}.value`,
      ),
    ),
  ]);
  for (let number = 1; number <= 5; number++)
    assert.equal(mapping[`bullet_point${number}`], -1);
});

test("Chinese factory column aliases and machine headers in a workbook preserve sheet and source row", async () => {
  const factory = await readTable(
    "engineering-factory.tsv",
    tsv([
      ["卖家SKU", "产品名称", "面料"],
      ["000101", "ENGINEERING FIXTURE", "cotton"],
    ]),
  );
  assert.equal(factory.mapping.sku, 0);
  assert.equal(factory.mapping.name, 1);
  assert.equal(factory.rows[0].cells[0], "000101");

  const book = new ExcelJS.Workbook();
  book.addWorksheet("Instructions").addRow(["ENGINEERING ONLY"]);
  const sheet = book.addWorksheet("Template");
  sheet.addRow(["ENGINEERING ONLY - no official compatibility claimed"]);
  sheet.addRow(["Seller SKU", "Item Name", "Parent SKU"]);
  sheet.addRow([
    "seller_sku",
    attribute("item_name"),
    "child_parent_sku_relationship#1.parent_sku",
  ]);
  sheet.addRow(["000111", "ENGINEERING CHILD", "000110"]);
  const source = await readTable(
    "engineering-workbook.xlsx",
    Buffer.from(await book.xlsx.writeBuffer()),
  );
  assert.equal(source.sheet, "Template");
  assert.equal(source.header_row, 3);
  assert.equal(source.rows[0].number, 4);
  assert.equal(source.mapping.parent_sku, 2);
  assert.equal(source.rows[0].cells[0], "000111");
  assert.equal(source.rows[0].cells[2], "000110");
});

for (const encoding of ["utf-16le", "utf-16be"]) {
  test(`BOM-detected ${encoding} inventory text round-trips identifiers and quoted Chinese notes`, async () => {
    const text =
      '\uFEFFseller_sku\titem_name\tparent_sku\tmerchant_note\r\n000201\tENGINEERING FIXTURE\t000200\t"中文备注\t含制表符\n以及""引号"""\r\n';
    const original = Buffer.from(text, "utf16le");
    if (encoding === "utf-16be") original.swap16();
    const source = await readTable("engineering-unicode.tsv", original);
    assert.equal(source.encoding, encoding);
    assert.equal(source.has_bom, true);
    assert.equal(source.newline, "\r\n");
    assert.deepEqual(source.rows[0].cells, [
      "000201",
      "ENGINEERING FIXTURE",
      "000200",
      '中文备注\t含制表符\n以及"引号"',
    ]);
    const batch = {
      rows: [{ row: 2, sku: "000201", status: "preserved" }],
      mapping: source.mapping,
    };
    const output = await exportFlatFile({}, batch, source, {
      applyContent: false,
    });
    assert.equal(
      output.contentType,
      `text/tab-separated-values; charset=${encoding}`,
    );
    assert.deepEqual(
      [...output.buffer.subarray(0, 2)],
      encoding === "utf-16le" ? [255, 254] : [254, 255],
    );
    const reread = await readTable(output.filename, output.buffer);
    assert.equal(reread.encoding, encoding);
    assert.deepEqual(reread.rows, source.rows);
    assert.deepEqual(reread.headers, source.headers);
    assert.equal(source.original_base64, original.toString("base64"));

    const converted = await exportFlatFile({}, batch, source, {
      applyContent: false,
      format: "tsv",
    });
    assert.equal(
      converted.contentType,
      "text/tab-separated-values; charset=utf-8",
    );
    assert.equal(decodeTableText(converted.buffer).encoding, "utf-8");
    assert.deepEqual(
      (await readTable(converted.filename, converted.buffer)).rows,
      source.rows,
    );
    assert.match(converted.validation.warnings.join("\n"), /文字编码已从/);

    const excel = await exportFlatFile({}, batch, source, {
      applyContent: false,
      format: "xlsx",
    });
    assert.deepEqual(
      (await readTable(excel.filename, excel.buffer)).rows,
      source.rows,
    );
  });
}

test("text decoding rejects invalid/truncated and unmarked UTF-16 without inventing an encoding", async () => {
  for (const bytes of [
    Buffer.from([0xc3, 0x28]),
    Buffer.from([0xff, 0xfe, 0x61]),
    Buffer.from(
      "seller_sku\titem_name\n000301\tENGINEERING FIXTURE",
      "utf16le",
    ),
    Buffer.from([0xff, 0xfe, 0, 0, 0x61, 0, 0, 0]),
  ])
    assert.throws(() => decodeTableText(bytes), { code: "TEXT_ENCODING" });
});
