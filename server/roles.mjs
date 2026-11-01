// 补资料协同看板：把 review.missing_data 按岗位（合规/美工/采购/运营）确定性分组。
// 分组是只读的经验默认；不改变待补项本身，也不表示已完成核验。
const ROLE_RULES = [
  { role: "合规", test: /cert|认证|合规|gpsr|responsible|label|标签|\bce\b|ukca|fda|epa|triman|epr/i },
  { role: "美工", test: /image|图|a\+|visual|视觉|视频|photo|设计|banner/i },
  { role: "采购", test: /brand|color|material|材质|supplier|供应商|spec|规格|load|承重|weight|克重|dimension|尺寸|capacity|容量|handle|提手|pack|count|件数/i },
];

export function classifyRoles(missingData) {
  const order = ["合规", "美工", "采购", "运营"];
  const board = { 合规: [], 美工: [], 采购: [], 运营: [] };
  for (const item of missingData || []) {
    const hay = `${item.field || ""} ${item.label || ""} ${item.reason || ""}`.toLowerCase();
    let role = "运营";
    for (const rule of ROLE_RULES) {
      if (rule.test.test(hay)) {
        role = rule.role;
        break;
      }
    }
    board[role].push({ field: item.field, label: item.label, reason: item.reason });
  }
  return {
    total: (missingData || []).length,
    board: order.map((role) => ({ role, items: board[role] })),
    notice:
      "按岗位经验默认分组（只读）；待补项来自当次审核，分组不代表已完成核验。",
  };
}
