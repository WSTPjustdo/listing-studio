> scenarios.json 中的合成资料仅为历史兼容，不可用于当前演示或真实验收。新任务拒绝 demo 商品；当前证据见根目录 CURRENT-STATUS.md。

# Amazon 单平台方案资料包

当前主方案：[Amazon Listing 精细化落地方案](../Amazon-Listing精细化落地方案.md)。

范围：Amazon US、棉布手提袋；新品 Listing 创建与已有 Listing 诊断修复。两类验收检查为平台规则、美国广告宣称证据预审。

## 文件

- `rules.json`：13 条检查规格，含项目内部 EVID-01；由 server/domain.mjs 执行，平台规则与内部约定分别标示。
- `scenarios.json`：演示商品、干净稿、有问题稿、两轮修改和预期行为。文本均为合成示例，不是已抓取的真实 Amazon Listing，也不是模型实测输出。
- `../data-research/public-product-facts.json`：沿用两个品牌官方参考商品的参数与出处。

## 使用约定

1. 合并 rules.json 的 sources、公开商品文件的 sources 以及 scenarios.json 的 sources，形成统一来源表。
2. 演示商品只显式引用指定事实；不继承公开商品的库存、销售授权、供应商装箱数或真实品牌身份。
3. `retail_pack_count=1` 是合成演示条件，界面与导出保留 is_demo 标记。
4. 商品的未知认证、降解性能或承重为空，不能用模型补全。
5. 用规则包选择适用检查；硬规则无需通过向量召回决定是否执行。语义判断必须保留依据与不确定性。
6. 预期命中 ID 用来核对实现，不得直接拼成诊断返回冒充模型调用。
7. 当前应用已接入这组资料，见根目录 README；前端、服务端与自动验证已实现。Dify 实例尚未配置，真实 DeepSeek 验收记录见根目录 CURRENT-STATUS.md；其他电脑须自行配置有效密钥。

旧 `data-research/demo-business-fixtures.json` 和 `data-research/rule-register.json` 包含 RFQ 范围，不属于当前 Amazon 方案的输入。旧详细方案和 GitHub 调研保留为历史参考。
