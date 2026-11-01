// 搜索词覆盖核对：解析用户粘贴的真实搜索词（每行一个，或 ABA 报告的第一列），
// 核对哪些已经出现在文案里、哪些缺失。不编造搜索量/流量词；词频与排名不是搜索量。
const HEADER_HINT = /search\s*term|search\s*frequency|关键词|搜索词|query|keyword|rank/i;

export function parseSearchTerms(text) {
  if (!text || typeof text !== "string") return [];
  const out = [];
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    // 表头行（带分隔符且含关键词）跳过；其余取第一列作为词。
    if (HEADER_HINT.test(line) && /[\t,]/.test(line)) continue;
    const term = line
      .split(/[\t,]/)[0]
      .trim()
      .replace(/^"+|"+$/g, "");
    if (term && !HEADER_HINT.test(term)) out.push(term);
  }
  return [...new Set(out)];
}

export function keywordCoverage(terms, content) {
  const title = (content?.title || "").toLowerCase();
  const highlights = (content?.item_highlights || "").toLowerCase();
  const bullets = (content?.bullet_points || []).map((b) => (b.text || "").toLowerCase());
  const description = (content?.description || "").toLowerCase();
  const all = [title, highlights, ...bullets, description].join(" ");
  return terms.map((term) => {
    const t = term.toLowerCase();
    return {
      term,
      present: all.includes(t),
      in_title: title.includes(t),
    };
  });
}

export function buildKeywordReport(terms, content) {
  const rows = keywordCoverage(terms, content);
  return {
    total_terms: terms.length,
    covered: rows.filter((r) => r.present).length,
    missing: rows.filter((r) => !r.present).map((r) => r.term),
    in_title: rows.filter((r) => r.in_title).map((r) => r.term),
    rows,
    notice:
      "搜索词来自你粘贴的真实报告；词频/排名不代表搜索量，这里只做「是否已写进文案」的核对，不编造流量数据，也不自动生成营销文案。",
  };
}
