# 商家体验反馈改进与真实验收

日期：2026-10-24，Asia/Shanghai。承接 [真实商家体验报告](../merchant-experience-2026-10-23/README.md)。本轮修改工作台代码，未向 Amazon 发布、未连接 Seller Central。

## 交付变化

| 原体验中的问题 | 已实现的变化 | 本轮证据 |
|---|---|---|
| 导入信息稀疏，不清楚下一步 | 首页前置导入；导入结果和商品页列出已填字段、未知字段及原文资料数 | live-merchant.json、02-saved-facts.png |
| 手填参数没有来源 | 关联链接、发布方、适用型号和摘录；原文资料编辑；参数修改解除旧来源，版本和来源原子保存 | live-merchant.json、01-source-edit.png |
| 三维英寸尺寸无处录入 | 保留 `22" X 16" X 6"`，不猜轴顺序、不推算容量；生成和导出可追溯 | final-record.json、final.customer.txt |
| 同一尺寸重复报五次 | 相同快照、参数、单位和状态的 EVID-01 合并展示；每处原句、定位、资料与修复入口保留 | 历史真实 V1 的 5 处发现合成 1 组；06-historical-grouped-findings.png |
| 长指令只有单行输入 | 多行、完整预览、字符数、Ctrl/⌘+Enter、英文模板追加与修改范围 | 04-prompt-preview.png、08-mobile-composer.png |
| 删掉卖点后五点重复 | 允许 1–5 条有效要点，保留有依据的规格。最终 4 条分别说明材质、拉链、外袋、完整尺寸 | final.customer.txt、followup.json |
| 检查结果和上架准备混淆 | 分开呈现文案检查、资料缺失、上架准备；后者仍标明未连接、未核验 | 09-final-browser.png |
| 模型格式失败中断审阅 | 格式重试只请求完整 review，省去可选 claim_map/patches；仍做真实审核及程序参数关联；失败前已完成调用也保存 | 最终标题审核实际恢复；此前失败保留 |

重复导入同一 ASIN 会刷新公开观察并保留商家确认参数、原文来源和已提交材料；新页面与商家记录的差异仍需人工核对，不声称自动解决冲突。

## 真实商品与来源

Amazon ASIN：[B0732NPDRB](https://www.amazon.com/dp/B0732NPDRB)。浏览器发起实时导入，得到标题、品牌与库存提示，未自动取得材质、颜色、零售包装等。没有切换快照或演示数据。

辅助来源：[DALIX 官方商品页](https://www.dalix.com/products/heavy-duty-cotton-canvas-tote-bag)。本机直接请求返回 HTTP 429；当天通过网页读取工具读取官方页，人工核对材质、完整尺寸、拉链与外袋，再在真实界面绑定原文。该流程验证商家补录，**不表示工作台已自动抓取官方页或独立核验完成**。适用对象写为该款袋型；官方默认 Pink 不写入当前变体。颜色、零售包装、提手长度、容量、承重与认证不推测。

资料版本 `AMAZON-US-B0732NPDRB@4`。最终任务 `listing-06ebe642-4bf9-4dc7-8316-b6da881a12a0`，V4 为标题修改，V5 为独立复检，正文相同。

最终标题：`DALIX Cotton Canvas Tote Bag with Zipper`。专项指令只改变标题，四条要点、亮点和描述逐字段保持不变，完整尺寸没有被删除。V5 在已执行范围内 0 项发现；颜色、零售包装两项待确认，publication_readiness 仍为 not_verified。

## 验收结果与失败保留

- `npm run build`：通过。
- `npm run test:merchant-facts`：通过。部分字段绑定、非法链接、未知参数、过期版本原子回滚、旧来源解除、重复导入及历史发现分组。属于确定性回归，不替代真实模型验收。
- `npm run test:parameters`：18 项边界检查及 36 个历史真实版本重放通过，另存 parameter-regression.json，未覆盖旧报告。
- `npm run test:live`：首次失败，补资料复检两次 JSON 错误；后两次完整流程通过。最终代码结果 live-workflow-3.json，真实 W101 来源、生成、修改及补资料复检完成。
- `npm run test:live:merchant`：实时导入、界面来源编辑、DeepSeek 生成和多行改写、四种导出通过。首次生成 4 条不同要点，标题单独尺寸仍有 1 项发现。
- `npm run test:live:merchant:followup`：历史问题展开、模板真实修改、范围外字段保留、390px 无横向溢出通过。此前发生脚本选择器错误、两次模型格式失败、一次调用成功但正文未改，分别保存，未记为通过。
- `npm run test:live:browser`：最终通过，实际复检、旧版本完整保留、证据区与 HTML/TXT/JSON/仅英文导出通过。

最终复检 ID `de432edb-91b6-4ea4-bd95-cd0ca570e3f0`，模型 deepseek-flash，4,998ms，8,158 tokens。标题审核重试 ID `2f355325-9945-4602-9e71-2cc1afbe9a9b`，失败 ID 及用量也保留。

全轮已取得 **32 个实际请求 ID、206,667 tokens**，包含失败响应和重试。早期两次标题任务生成成功、审核失败后未保存生成阶段台账，其两次生成的 ID、耗时和用量未知，不计入合计；本轮已补上 completed_calls 保存。部分旧失败请求耗时也未知。见 model-call-ledger.json，没有补造数据。

## 未解决问题

1. Amazon 抓取仍可能信息稀疏、限流或有地区差异；本轮补上透明缺项和人工来源闭环，未宣称抓取成功率提升。
2. DeepSeek 仍可能返回无效 JSON 或不改正文。精简格式重试本轮恢复成功，但不保证后续稳定；失败不保存成功版本、不回退演示。
3. 来源由商家关联，型号、变体、日期和适用性仍需核对。原文按精确内容关联，任意改写、单独抽轴长或单位变形尚不能保证识别。
4. 仅验证公开品牌参考商品，未验证商家自有库存、转化率或时间节省。无 Seller Central 发布、多人权限或跨品类完整覆盖。

固定分享包 `releases/listing-studio-hackathon-final.zip` 及同名 `.sha256`，含本报告、截图、脱敏证据及原体验 PDF，排除数据库、配置、密钥与缓存。
