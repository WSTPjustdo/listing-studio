export type MaterialSelection = {
  preview_id: string;
  document_ids: string[];
};
export type MaterialContext = MaterialSelection & {
  corrected_text?: string;
  additional_contexts?: MaterialSelection[];
};
export type AppliedMaterial = { previewId: string; text: string };

export function adoptMaterialText(
  merchantText: string,
  text: string,
  context: MaterialContext,
  previousContext: MaterialContext | null,
  previousApplied: AppliedMaterial | null,
) {
  const samePreview = previousApplied?.previewId === context.preview_id;
  const candidateAt = samePreview && previousApplied.text ? merchantText.indexOf(previousApplied.text) : -1;
  // Ambiguous copies may include user edits; preserve them and ask for reconciliation.
  const replaceAt = candidateAt >= 0 && previousApplied && merchantText.lastIndexOf(previousApplied.text) === candidateAt ? candidateAt : -1;
  const unchanged = samePreview && previousApplied.text === text;
  const combined = unchanged
    ? merchantText
    : replaceAt >= 0 && previousApplied
      ? `${merchantText.slice(0, replaceAt)}${text}${merchantText.slice(replaceAt + previousApplied.text.length)}`
      : merchantText.trim()
        ? previousContext ? `${merchantText}\n\n${text}` : `${text}\n\n【补充说明】\n${merchantText}`
        : text;
  const selections = new Map<string, Set<string>>();
  for (const source of previousContext ? [previousContext, ...(previousContext.additional_contexts || [])] : []) {
    // Replacing an intact adopted block also replaces that block's selected sources.
    if (replaceAt >= 0 && source.preview_id === context.preview_id) continue;
    selections.set(source.preview_id, new Set(source.document_ids));
  }
  for (const source of [context, ...(context.additional_contexts || [])]) {
    const documents = selections.get(source.preview_id) || new Set<string>();
    source.document_ids.forEach((id) => documents.add(id));
    selections.set(source.preview_id, documents);
  }
  if (combined.length > 60000) throw new Error("合并后商品资料超过 60,000 字符，请先精简商品资料再采用；当前内容已保留。");
  if ([...selections.values()].reduce((count, documents) => count + documents.size, 0) > 12)
    throw new Error("累计采用的资料最多 12 份，请将同一商品资料整理为较少文件；当前内容已保留。");
  const additional = [...selections.entries()].filter(([id]) => id !== context.preview_id)
    .map(([preview_id, documents]) => ({ preview_id, document_ids: [...documents] }));
  return {
    text: combined,
    context: {
      preview_id: context.preview_id,
      document_ids: [...selections.get(context.preview_id)!],
      corrected_text: combined,
      ...(additional.length ? { additional_contexts: additional } : {}),
    } satisfies MaterialContext,
    applied: { previewId: context.preview_id, text },
    preservedEditedBlock: Boolean(samePreview && replaceAt < 0 && !unchanged),
  };
}

export function guidedAnalysisFingerprint(input: {
  product?: { product_id: string; revision?: number };
  merchantText: string;
  reference: string;
  image: string;
  materialContext: MaterialContext | null;
}) {
  return input.product
    ? JSON.stringify({ productId: input.product.product_id, revision: input.product.revision })
    : JSON.stringify({ text: input.merchantText, reference: input.reference, image: input.image, materialContext: input.materialContext });
}

export function guidedSelectionError(hasResearch: boolean, selected: string[], terms: string[]) {
  if (hasResearch && !selected.length) return "至少选择一个已核对的参考商品，或明确选择只按自家资料继续。";
  if (selected.length > 5) return "最多选择 5 个参考商品。";
  if (terms.length > 60 || terms.some((term) => !term.trim() || term.length > 100)) return "关键词最多 60 个，每个最多 100 字符。";
  return "";
}
