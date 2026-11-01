// Persistence keeps the full uploaded-material and extraction archives. Model
// requests use adopted product facts and compact provenance, so those archives
// are not serialized again through product, sources and prompt placeholders.
const productArchives = new Set([
  "research_analysis",
  "material_context",
  "original_files",
  "original_base64",
  "source_snapshot",
  "product_snapshot",
]);

// A deleted bullet retains its stable slot in saved/writing content. Audit only
// actual text: an empty slot has no nonempty original substring an issue can cite.
export function contentForAudit(content) {
  if (content == null) return null;
  const projected = structuredClone(content);
  if (Array.isArray(projected.bullet_points))
    projected.bullet_points = projected.bullet_points.filter(
      (bullet) => typeof bullet.text !== "string" || bullet.text.trim().length > 0,
    );
  return projected;
}

export function productForModel(product) {
  if (product == null) return null;
  return structuredClone(
    Object.fromEntries(
      Object.entries(product).filter(
        ([key, value]) =>
          !productArchives.has(key) &&
          !(key === "imported_table" && value && typeof value === "object"),
      ),
    ),
  );
}

const pick = (value, keys) =>
  Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
  );

export function sourcesForModel(sources = []) {
  return sources.map((source) => {
    if (!source.snapshot || typeof source.snapshot !== "object")
      return structuredClone(source);
    let snapshot;
    if (source.kind === "merchant_material") {
      snapshot = pick(source.snapshot, [
        "id",
        "filename",
        "kind",
        "sha256",
        "bytes",
        "status",
        "warnings",
      ]);
    } else if (source.kind === "merchant_product_extraction") {
      // Extraction facts retain verbatim evidence and source_refs. They remain
      // context only; only the product's adopted facts authorize listing copy.
      snapshot = pick(source.snapshot, [
        "id",
        "name",
        "category",
        "search_query",
        "observations",
        "facts",
        "missing",
        "suggested_fields",
        "own_link",
        "checked_at",
      ]);
    } else return structuredClone(source);
    return structuredClone({ ...source, snapshot });
  });
}

export function resolveGuidedPlaceholders(template, product, keywords = []) {
  const replacements = {
    PRODUCT_FACTS: JSON.stringify(productForModel(product)),
    KEYWORDS: JSON.stringify(keywords),
  };
  const seen = new Set();
  return template.replace(
    /\{\{(PRODUCT_FACTS|KEYWORDS)\}\}/g,
    (_match, name) => {
      if (seen.has(name))
        return name === "PRODUCT_FACTS"
          ? "(the same structured product facts supplied above and in request.product)"
          : "(the same keyword candidates supplied above)";
      seen.add(name);
      return replacements[name];
    },
  );
}
