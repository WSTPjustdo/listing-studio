# 项目验收约定

- 用户要求后续功能演示和验收使用真实商品来源和本机已有的 DeepSeek API。不得使用合成商品、模拟模型返回或本地演示结果替代真实验收。
- 不得把旧自动测试通过当作真实模型验收通过。真实调用失败时保留失败原因，不回退演示模式，不伪造通过结果。
- 使用本机已有配置，不打印或打包密钥。记录实际请求 ID、模型、耗时、用量及未解决问题；未取得的资料保持未知。
- 功能交付同步固定分享 ZIP、校验文件与交付文档；排除 .runtime、.env、数据库、凭据和缓存。
- 当前验收命令为 npm run test:live 和（启动真实工作台后）npm run test:live:browser。npm test / npm run test:e2e 需要 -- --real-api 显式授权付费；legacy-mocked 命令仅为历史保留，不作为当前验收依据。
- 补证验收 npm run test:live:evidence 会使用已有真实 W101 文案、实时官方来源和一次付费复检；台账验收 npm run test:live:library 使用已有真实模型文案导出，不额外调用模型，不伪造 SKU 或已上架状态。未连接 Seller Central，已上架仅商家手动登记。
