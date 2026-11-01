import type { Content } from "./types";

export type IntakeRole = "own_draft" | "competitor_reference";
export type IntakeDraft = {
  role: IntakeRole;
  raw_text: string;
  source_tool: string;
  source_url: string;
  source_asin: string;
  source_filename: string;
  product_id: string;
  keyword_text: string;
  content: Content | null;
  parsed_from: string;
  warnings: string[];
  error: string;
  preview_confirmed: boolean;
  scope_confirmed: boolean;
};

export const emptyIntakeDraft = (): IntakeDraft => ({
  role: "own_draft",
  raw_text: "",
  source_tool: "",
  source_url: "",
  source_asin: "",
  source_filename: "",
  product_id: "",
  keyword_text: "",
  content: null,
  parsed_from: "",
  warnings: [],
  error: "",
  preview_confirmed: false,
  scope_confirmed: false,
});

export type IntakePayload = {
  role: IntakeRole;
  content: Content;
  product_id?: string;
  product_revision?: number;
  source_tool?: string;
  source_url?: string;
  source_asin?: string;
  raw_text?: string;
  source_filename?: string;
  selected_terms: string[];
  scope_confirmed: boolean;
};

export function intakeKeywords(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/[\r\n,，;；\t]+/)
    .map((term) => term.trim())
    .filter((term) => {
      const key = term.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// This is a suggested segmentation for operator confirmation, never a product-data extractor.
export function parseIntakeText(raw: string): {
  content: Content;
  warnings: string[];
} {
  const lines = raw
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  if (!lines.some((line) => line.trim()))
    throw new Error("请先粘贴文案，或读取一份 UTF-8 TXT 文件。");
  const first = lines.find((line) => line.trim()) || "";
  const headerCells = first
    .split(/[,\t;]+/)
    .map((cell) => cell.trim().replace(/^[\"']|[\"']$/g, ""));
  const headers = headerCells.filter((cell) =>
    /^(?:asin|bsr|keyword|search volume|revenue|monthly sales|title|description|bullet(?:_?point)?[ _]?\d*|关键词|搜索量|销量|销售额|标题|描述)$/i.test(
      cell,
    ),
  );
  if (
    (headers.length >= 2 && headerCells.length >= 2) ||
    (/^(?:keywords?|关键词|词表|search terms)$/i.test(first.trim()) &&
      lines.filter((line) => line.trim()).length > 1)
  )
    throw new Error(
      "这段内容看起来是 CSV／商品指标或词表。请将文案正文单独粘贴，关键词放到下方词表；本入口尚未适配这些文件的列结构。",
    );
  if (raw.includes("\0"))
    throw new Error("内容含非文本数据，请使用 UTF-8 TXT 或直接粘贴文案正文。");
  const content: Content = {
    title: "",
    item_highlights: "",
    bullet_points: [],
    description: "",
  };
  const values: Record<"title" | "item_highlights" | "description", string[]> =
    { title: [], item_highlights: [], description: [] };
  const warnings: string[] = [];
  let section: "title" | "item_highlights" | "bullets" | "description" | null =
    null;
  let inferredTitle = false;
  const appendBullet = (text: string) => {
    if (text.trim())
      content.bullet_points.push({
        id: `b${content.bullet_points.length + 1}`,
        text: text.trim(),
      });
  };
  for (const original of lines) {
    const line = original.trim();
    const heading = line.match(
      /^(?:#{1,4}\s*)?(标题|商品标题|产品标题|product title|title|商品亮点|亮点|item highlights?|highlights?|五点描述|五点|商品要点|产品要点|bullet points?|bullets?|商品描述|产品描述|描述|product description|description)\s*(?:[:：]\s*(.*)|$)/i,
    );
    if (heading) {
      const label = heading[1].toLowerCase();
      section = /标题|title/.test(label)
        ? "title"
        : /亮点|highlight/.test(label)
          ? "item_highlights"
          : /五点|要点|bullet/.test(label)
            ? "bullets"
            : "description";
      const inline = (heading[2] || "").trim();
      if (inline) {
        if (section === "bullets") appendBullet(inline);
        else values[section].push(inline);
      }
      continue;
    }
    if (!line) {
      if (section === "description") values.description.push("");
      continue;
    }
    const numbered = line.match(
      /^(?:[-•●▪]\s+|\d{1,2}[.)、]\s+|(?:要点|bullet(?: point)?)\s*\d{1,2}\s*[:：]\s*)(.+)$/i,
    );
    if (numbered && section !== "description") {
      section = "bullets";
      appendBullet(numbered[1]);
    } else if (section === "bullets") {
      // Unnumbered lines inside an explicit bullet section remain separate editable points.
      appendBullet(line);
    } else if (section) values[section].push(original.trim());
    else if (!values.title.length) {
      values.title.push(line);
      inferredTitle = true;
    } else {
      section = "description";
      values.description.push(original.trim());
    }
  }
  content.title = values.title.join("\n").trim();
  content.item_highlights = values.item_highlights.join("\n").trim();
  content.description = values.description.join("\n").trim();
  if (inferredTitle)
    warnings.push(
      "首个非空行暂作标题。未明确标记的后续段落保留在描述中，请核对并调整字段。",
    );
  if (!content.bullet_points.length)
    warnings.push("未识别到明确的五点分段；未补造要点，可在预览中逐条添加。");
  if (content.bullet_points.length > 20)
    warnings.push("识别到超过 20 条要点，请在预览中合并或删除多余分段后提交。");
  if (!content.item_highlights)
    warnings.push("原文未标明商品亮点，保持为空，不用五点拼接填充。");
  return { content, warnings };
}
