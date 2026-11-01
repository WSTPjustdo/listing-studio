// Archived real content verifies field preservation. Control strings below only
// verify parser boundaries; they are not products or live model acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseIntakeText, intakeKeywords } from "../src/intake.ts";

const record = JSON.parse(
  readFileSync(
    new URL(
      "../reports/teammate-sync-2026-10-30/final-record.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const content = record.content;
const original = `Title: ${content.title}\n\nItem Highlights:\n${content.item_highlights}\n\nBullet Points:\n${content.bullet_points.map((bullet) => `- ${bullet.text}`).join("\n")}\n\nDescription:\n${content.description}`;

test("pasted real W101 copy retains title, highlights, every bullet and description", () => {
  assert.deepEqual(parseIntakeText(original).content, content);
  assert.equal(record.trace.actual_model_call, true);
});

test("UTF-8 BOM and Windows line endings do not alter real content", () => {
  assert.deepEqual(
    parseIntakeText(`\uFEFF${original.replaceAll("\n", "\r\n")}`).content,
    content,
  );
});

test("ordinary word prefixes are never treated as section labels", () => {
  for (const title of [
    "Titleist Golf Tote Bag",
    "Bulletproof fabric tote bag",
    "Descriptional text",
    "Highlightsome textile",
  ]) {
    assert.equal(
      parseIntakeText(`${title}\n\nDescription:\n${content.description}`)
        .content.title,
      title,
    );
  }
});

test("missing fields remain empty rather than copying bullets into highlights", () => {
  const parsed = parseIntakeText(content.title);
  assert.deepEqual(parsed.content, {
    title: content.title,
    item_highlights: "",
    bullet_points: [],
    description: "",
  });
  assert.ok(parsed.warnings.some((warning) => warning.includes("未补造")));
});

test("recognized metric tables and keyword-only inputs are rejected as full copy", () => {
  for (const table of [
    "ASIN,BSR,Search Volume\n",
    '"title","bullet1","description"\n',
    "keyword\ncotton tote bag",
    "关键词\n棉布袋",
  ]) {
    assert.throws(() => parseIntakeText(table), /CSV|词表/);
  }
});

test("numbered lines inside a labelled description remain in the description", () => {
  const description = `1. ${content.description}\n2. ${content.description}`;
  assert.equal(
    parseIntakeText(`Title: ${content.title}\nDescription:\n${description}`)
      .content.description,
    description,
  );
});

test("keyword input keeps phrases, deduplicates case and preserves measurement terms", () => {
  assert.deepEqual(
    intakeKeywords(
      "cotton tote bag\nCOTTON TOTE BAG,100% cotton;140gsm\tWestford Mill",
    ),
    ["cotton tote bag", "100% cotton", "140gsm", "Westford Mill"],
  );
  assert.deepEqual(intakeKeywords(" \n,;\t"), []);
});

test("empty and non-text content are not parsed", () => {
  assert.throws(() => parseIntakeText(" \n\t"), /粘贴文案/);
  assert.throws(() => parseIntakeText(`${content.title}\0`), /非文本/);
});
