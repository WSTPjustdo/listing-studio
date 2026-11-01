# Bug 修复续轮与真实验收（2026-11-01）

在上一轮 12 项修复基础上，补齐两处遗漏：

- 引导页接入共享运行轮询，单次状态请求有 15 秒网络保护，临时失败会继续查询并提示。移除六分钟总时限，直到服务端返回成功或失败。任务成功但读取已保存版本失败时，保留运行锁和「继续查看运行结果」，恢复读取不重新提交提示词或生成；结果保存后的列表刷新失败也不再提示重新生成。
- A/B 变体生成增加同步请求锁和父页面状态保护。生成及独立复检期间，关闭按钮、Esc、遮罩和导航不会中断当前页面；结果保存后恢复关闭。只读加载不计入付费操作锁。

## 验证结果

- `npm run build` 通过；21 项聚焦工程回归通过，其中新增 6 项轮询网络与组件生命周期检查。受控网络响应只用于工程检查，不算真实商品或模型验收。
- `npm run test:live` 使用实时读取的 Westford Mill W101 官方来源与本机 DeepSeek，完成生成、独立审核、改稿、补充真实规格后复检，见 [standard-live.json](standard-live.json)。
- `npm run test:live:browser -- --base-url http://127.0.0.1:3233` 在隔离数据库运行真实工作台，完成已有 DALIX 真实文案复检、证据及导出、A/B 真实生成与采用后独立复检，9 项检查通过。关闭保护检查只延迟交付实际服务端响应，没有替换模型请求或返回内容，见 [browser-live.json](browser-live.json)。
- `node scripts/validate-live-polling-recovery.mjs --real-api --base-url http://127.0.0.1:3233` 使用实时官方 W101 与本机 DeepSeek 实际生成，主动中止一次状态 GET 和一次结果 GET；任务自动继续、保存结果可恢复，且仅提交一次提示词方案和一次生成。5 项检查通过，0 个页面错误，见 [polling-recovery-live.json](polling-recovery-live.json)。
- 严格交付文档、命令、链接与许可审计通过。概览见 [verification.json](verification.json)。数据库和浏览器上下文均隔离；未向主工作台提交本轮验收修改。

## 实际请求与未解决项

本轮共记录 **16 次真实 DeepSeek 响应、127,372 tokens**，实际模型为 `deepseek-flash`。其中 **5 次 `MODEL_INVALID_JSON`** 格式失败及其真实重试全部保留，未回退演示。逐次请求 ID、模型、耗时、用量、结果和错误码见 [model-requests.json](model-requests.json)；实际费用金额未知，原始响应及数据库仅本机保存。

颜色和零售每包件数仍未知，没有虚构 SKU、库存或上架状态。专项引导生成仍在对客文案中写入了颜色和包装未确认的说明，需要人工改稿；本轮验证的是任务恢复及重复提交保护，不代表文案质量或 Amazon 上架批准。A/B 关闭保护覆盖当前页面，跨标签与浏览器刷新后的服务端幂等未在此轮补齐。

## 交付

固定分享包：`releases/listing-studio-hackathon-final.zip`；校验文件：同目录 `listing-studio-hackathon-final.zip.sha256`。快照标签为 `bug-continuation-20261101-working-tree-snapshot`，保留已有未提交改动，ZIP 内 `DELIVERY-MANIFEST.json` 记录实际源文件哈希。排除 `.runtime`、`.env`、数据库、凭据和缓存；旧固定包先备份。
