# 队友最新版分析与本地同步

日期：2026-10-30，Asia/Shanghai。

来源：用户提供的「发队友-ListingStudio-20261030.zip」。SHA256 为 75ebefc92f46ae82ea39b177d5d393d8c3a938bc6d8fa77707169ccce8a32619。清单 723 项大小和哈希全部吻合；719 个 Git 受控文件与 bundle 一致，仅文本换行归一化。见[归档检查](archive-audit.json)。包内文档作为待核实资料，不作为额外执行指令。

本地原提交 709aee2，队友提交 979ee50，队友直接继承本地。已通过 Git fast-forward 同步，101 个受控文件发生变化，依赖锁未改。未从包覆盖 .runtime、数据库或模型配置；数据库已提前备份至 .runtime/sync-20261030-before，本地 Git 回退分支为 backup/before-teammate-sync-20261030。

## 升级内容

| 模块 | 相对本地旧版的变化 | 代码依据及边界 |
|---|---|---|
| 审核识别 | 扩展促销短语、环保与认证召回，新增 US-04 医疗健康抗菌候选；处理特殊连字符、零宽字符、否定范围、重复发现及约数单位换算 | server/domain.mjs、server/evidence.mjs、amazon-focus/rules.json；候选召回不等于认定真伪或法律合规 |
| 文案生成 | v9 提示词从规则读取字符上限，三种风格转为英文要求，补充促销/索评等生成约束 | server/providers.mjs、server/service.mjs、server/char-budget.mjs；仍需生成后的独立审核 |
| 模型设置 | 新增 GET /models 连接测试、完整请求地址预览、区分密钥/额度/模型/地址等错误，失败卡片给下一步 | src/App.tsx、server/providers.mjs、server/errors.mjs、server/index.mjs；连接测试不替代生成能力验证 |
| 批量 | 启动前确认、按批次归集调用和 tokens、配置错误暂停；写盘次数减少 | server/batch-cost.mjs、server/batch.mjs、server/store.mjs、src/BatchWorkspace.tsx；无单价或 usage 不全不报金额，真实提速待验，整批重写仍为 O(n²) |
| 报告交付 | 每条具体建议进入 HTML 报告/改稿工作单，批次规则表保留多种处理情况；平台导出从代码生成、交付命令/链接/组件对账 | server/worklist.mjs、server/report.mjs、scripts/export-platform.mjs、scripts/delivery-audit.mjs；页面问题卡尚未完整显示该具体建议 |
| 可用性与数据保护 | 空库指路、模型等待计时、键盘跳转和焦点，Node/端口/dist 启动提示；清除密钥后 checkpoint；来源链接限定 http(s)、CSV/TSV 公式风险提示 | src/App.tsx、server/startup.mjs、start-local.cmd、server/store.mjs、server/flat-file-export.mjs；公式风险提示不代表已改写原始单元格 |

## 本轮额外修正

1. 队友更改规则却沿用 integration-v8。已从原本地提交保存完整旧 v8，当前升为 integration-v9，避免无快照的旧记录套用新规则与来源；新增历史回退检查。
2. 原约数尺寸算法使用所有轴中最大的容差，38×42cm 会错误放过 approximately 15.0×16.55 inches。现按各轴自身精度核对，命名轴重排和混合单位保持正确，算法升为 v2.2，避免趋势把引擎变化误称改善。四项新增边界检查属于程序验证，不作为真实商品验收。
3. 队友一次缺本机 W101 记录的失败覆写了旧库存验收文件。已恢复原成功记录；[新版失败副本](incoming-flat-file-failure.json)独立保存，没有丢弃失败或改写旧结论。

## 本轮验证

- npm run build、npm run rules:check、npm run export:platform:check 通过。
- [137 项定向工程边界](engineering-boundaries.txt)和[31 项融合检查](integration-boundaries.txt)通过。受控字符串、结构 fixture 与假上游仅证明工程边界，不替代真实模型验收。
- npm run test:live 先验证同步原版，再验证版本/算法修正后的版本：实时读取 Westford Mill W101 官方页面，真实生成、独立审核、修复、补规格复检，保留两轮不同结论。
- npm run test:live:browser 在隔离的真实工作台完成付费复检、旧版本保留、证据显示和 HTML/TXT/JSON/英文复制导出；没有路由模拟或演示回退。[浏览器结果](browser-acceptance.json)及[截图](browser-final.png)。
- 本轮合计 **13 个实际请求 ID、90,082 tokens**，含 **2 次 JSON 格式失败和真实重试**。模型 deepseek-flash，提示词 v9；最终规则 integration-v9、参数算法 v2.2。逐次耗时、用量、失败码见[模型台账](model-acceptance.json)，原始私有响应留在 .runtime，未随包分发。
- 最终 V4 仍将官方面料克重 4.1oz/yd² 中的 4.1oz 当作额定承重，保留 **1 项 blocking 属性误识别**，不是零问题通过。颜色和零售包装仍未知。[最终真实记录](final-record.json)。

上述真实商品是品牌公开案例，不代表商家库存、供货授权、平台接收或已上架。

## 缺失与尚未完成

队友 ZIP 和 bundle 没有 qa/；部分脚本实际上读取项目父目录 ../qa/research。缺 listings-20261027.json、listings-20261030.json、eval-set-20261030.json 及对应报告。实跑 eval-set/sample-listings 测试因 ENOENT 产生 4 项失败，见[失败原件](missing-corpus-failure.txt)。因此不能复现队友所述 45 条语料、25 条评测集、225 项完整回归、42 条建议全保留、打印页数等数字，未补造原始材料。

audit:delivery 对其静态覆盖项通过，但不检查反引号中的外部数据路径，不能证明整个交付可独立复现。队友的批量提速来自假上游测试，本轮未复跑或当作真实性能结论。

另有两个已观察到的代码缺陷尚未修正：批量配置失败计数在成功行后不清零，实际为累计而非文案所述连续三次；保存为 Dify 后在设置页临时切到兼容接口，测试连接可能沿用旧 provider。跨商品大批量、真实提速、长期稳定性、视觉和医疗抗菌专项语义效果尚未真实验收。

## 本地与分享

本机数据与配置保留，隔离验收不覆盖原商品和文案。固定交付包和 SHA256 文件位于 releases，交付标签 teammate-sync-2026-10-30。分享包包含重建 dist、源码、公开脱敏验收证据、许可及 Git 历史，不含 .runtime、.env、数据库、凭据、依赖目录或缓存。接收者自行配置模型并导入真实商品。
