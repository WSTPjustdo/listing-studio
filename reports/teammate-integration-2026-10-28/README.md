# 队友成果融合与真实验收

汇总日期：2026-10-29，Asia/Shanghai。以库存闭环提交 `0c58924` 为基线，共同祖先为 `c0f87bf`，队友提交为 `81a4091`。队友 ZIP 清单 656 项大小和 SHA256 均吻合；依赖锁未改变。

本轮按模块迁移参数/材质识别、明确轴名/深度/承重、规则依据与字段例外、补关联真实复检、报告/改稿工作单、版本趋势、批次汇总/指定失败行重试/失败原行导出、逐请求台账和保守 JSON 语法恢复。保留 TSV/TXT、多表和表头、2000 行/1000 列、五点分列、真实 SKU、父体保留、原行回填及平台报告关联。未引入 MOCK 服务、假失败注入或服装品类入口。

## 真实结果

- 标准 `test:live` 完成真实 W101 生成、独立审核、修复及补规格复检，见[模型台账](model-acceptance.json)。
- 标准 `test:live:browser` 完成真实复检、版本保留与导出，见[浏览器记录](browser-acceptance.json)。DALIX 深度等待核事项保留，没有补造参数。
- [补关联验收](integration-acceptance.json)使用已有真实 W101 英文与实时官方页面：先不关联诊断，再关联已有商品真实复检，正文及历史不变，检查范围变化不称为改善。
- [最终复检](followup-acceptance.json)：实际请求 `689eea7e-613c-4e9b-b926-4a73c98fc536`，算法 v2.1，同一正文 V4 在已执行范围内 0 项发现；颜色、零售包装仍待确认。
- 合计 **12 个实际请求 ID、79,210 tokens**，含 **2 次 JSON 格式失败**及真实重试。每次模型、耗时、用量和失败码均保留；重试恢复不保证长期稳定。
- [库存公开来源验收](flat-file/acceptance.json)、[8 项浏览器检查](flat-file/browser-acceptance.json)、[台账真实文案导出](library/acceptance.json)通过，没有额外模型调用，没有把厂家代码当卖家 SKU。
- [12 项界面检查](ui/ui-qa.json)使用实际记录覆盖 1440/390/360px，无模拟路由、模型请求、横向溢出或页面异常。最终打印页数与检查见 `final-print-qa.json`，不承诺工作单一页。

## 保留的失败和修复过程

真实原文 `38 cm wide x 42 cm high` 最初被误判成轴不明，旧 V2 原文和发现保留在 `real-associated-record.json`。修复明确轴名后，早期 V3 仍沿用 v2 标签而出现一致性待核，原结果保留在 `prior-followup-v2/`。最终算法升为 v2.1 并纳入指纹，V4 单独建立基线，不把引擎变化说成模型波动，不改历史记录。

尺寸仅做精确受控换算，不自动给约数舍入容差。备用数值、双单位、轴顺序及袋身/口袋/里料语境单独核对。参数关联不证明整句、认证、性能或实际库存；未覆盖参数单列且不算通过。

报告使用版本规则和来源快照；五个已用历史规则包从已审查 Git 提交恢复。未知规则版本明确显示依据未知，不套用新上限或擅自归为内部约定。

## 工程检查与边界

[29 项融合检查](program-boundaries.txt)、[20 项库存结构检查](flat-file/program-boundaries.json)、[18 项参数边界](parameter-boundaries.json)与商家事实检查通过。控制文本和结构 fixture 仅证明程序边界，不是商品或模型验收。

商家原始库存模板、真实卖家 SKU 和 Seller Central 处理报告尚未提供；原件回填、平台接收及上架结果仍未知。并发默认 1，自动并发和长时间批量未做真实性能验收。服装、多人账号和其他平台未开放。

验收使用隔离工作区的本机数据库快照与已有 DeepSeek 配置；验收数据库不覆盖原工作台。密钥、数据库、原始私有模型响应均不随包分发。

## 后续复核

标准命令仍为 `npm run test:live` 和启动真实工作台后的 `npm run test:live:browser`。`npm run test:live:integration` 要求同源工作台已有真实 W101 文案，之后可执行 `npm run test:live:integration:followup`；两者调用付费模型，默认写入 `.runtime/live-integration`，不覆盖本报告。隔离端口可追加 `-- --base-url http://127.0.0.1:8788`。

`npm run rules:doc` 生成规则说明，`npm run rules:check` 校验说明。`npm run test:integration` 不调用模型，不替代真实验收。
