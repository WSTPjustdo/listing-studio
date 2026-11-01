// 真实在售文案 → 引擎 content 的**唯一**一份映射。
//
// 为什么要抽出来：这段映射原来在 `claim-recall-probe.mjs` 和 `real-listing-probe.mjs`
// 里各写了一遍，两份都把五点拼成「亮点」，于是 20 条真实文案的 AMZ-02 20/20 全报。
// 两边一起错，所以互相"印证"得很像真的（引擎层和 HTTP 层给出同一个错数字）。
// 复现这件事只要两行，但发现它需要先怀疑数字本身——这正是本轮花时间的地方。
//
// 事实依据：`server/amazon.mjs` 采集回来的真实商品只有标题、五点、描述，**没有亮点字段**。
// 亮点是本产品自己的字段，真人填写才有；诊断一条抓来的 ASIN 时它就该是空的。
import { readFileSync } from "node:fs";

export function loadSample(path) {
  // 坑：顶层是 {items:[...]}，写成 d.listings 会静默拿到 0 条。
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return { items: Array.isArray(raw) ? raw : raw.items || [], raw };
}

export function listingContent(item) {
  return {
    title: (item.title || "").slice(0, 400) || "(empty)",
    item_highlights: "",
    bullet_points: (item.bullets || []).slice(0, 8).map((text, i) => ({ id: `b${i + 1}`, text })),
    description: (item.description || "").slice(0, 4000),
  };
}
