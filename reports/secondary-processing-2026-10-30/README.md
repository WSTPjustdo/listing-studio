# 导入后二次加工首版：开发与真实验收

日期：2026-10-30，Asia/Shanghai。基线 d2c309b。本轮实现用户确认的“插件/人工已有材料 → 工作台二次加工”，不重建竞品采集插件，不宣称已连接第三方账户。

## 使用方式

首页点“导入已有文案”，选择材料角色，粘贴正文或读取 UTF-8 TXT（最多100KB）。识别后逐项核对标题、亮点、五点与描述，勾选字段确认；关键词和来源可选。明确确认本次是 Amazon 美国站棉布手提袋后才可提交，未知范围可以整理输入，但不进入这一范围的审核或付费队列。

- 我的初稿：保留正文并真实诊断，可不关联商品；未关联时不执行以商品档案为准的核对。
- 竞品参考：必须选已有真实自家商品，参考只用于表达方向，按自家事实生成后独立审核，不把竞品参数写入商品档案。
- 结果页显示来源角色、原始文件和词条变化。每条问题沿用现有建议、修改预览与确认入口；对话修改可只选某条五点，服务端保留其余字段、ID和顺序，再独立审核并另存版本。
- JSON/TXT/HTML和工作单携带导入来源及词条说明；纯英文复制不携带内部说明。

本版不适配第三方 CSV/XLSX 列结构。来源工具名称由用户记录，不表示平台授权或接口连接。未知 ASIN、SKU 保持未知，纯文案不获得库存回填资格。

## 实现与程序保护

| 范围 | 改动 |
|---|---|
| 入口与预览 | IntakePanel/intake.ts 支持角色、TXT、建议分段及人工确认；原文变化后须重新解析，编辑字段后须重新确认 |
| 服务端 | POST /api/listings/intake 严格校验角色、范围、来源链接和可选真实 ASIN；竞品必须关联真实商品，拒绝在模型入队前完成 |
| 上下文 | 请求与记录共用有效研究词表，修复后续改稿记录有词但模型没收到的问题；保存原始文本、确认分段、来源与本机接收时间 |
| 定向修改 | 支持 content.bullet_points.<stable_id>，范围外原文由服务端保留；越界 patch 或模型丢失所选 ID 时失败，不默默删原文 |
| 关键词 | 比较输入/前版与本版的字面出现次数；不是搜索量、排名、事实支持或合规结论，不为保词补造性能或认证 |
| 追溯 | 提示词升至 2026-10-30.intake-keywords-v10；参数算法最终为 structured-parameters-v2.4，当前规则仍为 integration-v9 |

## 两处真实误报与修正

1. 原 W101 真实稿中的 4.1oz/yd² 曾被截取成4.1oz并匹配到跨分号的携带语境。现在先识别完整克重单位，仅凭已记录的原文关联，不从gsm推算；承重语境不跨分号，不把carried前缀当carry。原句保留，真实复检不再报承重。
2. 首轮竞品参考生成稿中的“38 cm wide by 42 cm high”被报轴不明。算法v2.4允许by分隔，但要求每轴明确、唯一的宽高深标签；裸数字、length/long及不明轴继续待核。保留同一正文和旧版本，真实复检后该误报消失，不以删掉尺寸清空问题。

原v2.3结果保留于[intake-acceptance.json](intake-acceptance.json)与[standard_v2.3.json](standard_v2.3.json)。[同稿复检](reference-followup.json)及[最终V4记录](final-reference-record.json)记录v2.4结果；不把算法切换直接归为文案质量趋势改善。

## 本轮真实流程结果

来源为实时 Westford Mill 官方 W101 与 W201 页面、已有真实 DeepSeek W101 文案。两份官方页面本轮均HTTP200，必要原文与规格见[公开输入](prepared-public-inputs.json)，没有合成商品、模拟模型返回或演示回退。这是公开案例，不是商家库存或供应授权证明。

- [导入API流程](intake-acceptance.json)：自家稿原文保留、词表/来源保存、单条五点修改、竞品参考与自家事实分离、各类导出。范围未确认、竞品无自家商品、非法来源URL被拒绝；比对入队和调用台账，未新增模型请求。
- [真实请求上下文](actual-provider-context.json)：直接观察实际发往DeepSeek的operation、selected_terms、allowed_fields与实际响应ID/用量，没有替换请求结果。真实修订请求确实携带选词，不能仅凭结果记录宣称传词成功。
- W201官方原文包含200gsm；自家W101档案仍为140gsm，生成稿未继承200gsm、6oz/yd²或W201型号。
- [新入口真实浏览器流程](intake-browser-acceptance.json)：实际TXT读取、字段预览/确认、范围及商品门槛、付费诊断、来源与词条展示、单条五点修改和独立审核、历史与范围外正文保留；1440/390px无横向溢出或页面错误。
- 最终代码的 npm run test:live 完成真实生成、独立审核、修复和补规格复检，见[标准最终流程](standard_final_v2.4.json)。
- 最终 npm run test:live:browser 完成真实复检、历史保留和HTML/TXT/JSON/英文复制导出，见[标准最终浏览器记录](final-browser-acceptance.json)。最终参考稿V4在执行范围内0项发现，颜色与零售包装仍未知。
- 本轮合计 **33个实际请求ID、224,926 tokens**，包括 **12次JSON格式失败及真实重试**。具体请求、模型、用量、耗时与错误码见[台账](model-acceptance.json)。某些标准脚本只留下合并重试耗时，单次成功请求耗时未取得的保持未知。原始私有模型响应在.runtime，不分发。流程恢复不代表格式稳定性已解决。

## 工程与界面检查

- npm run build、npm run rules:check、npm run export:platform:check 通过。
- [25项导入/解析/参数边界](engineering-intake.txt)与[31项融合检查](engineering-integration.txt)通过。控制字符串和结构fixture仅为程序边界，不替代真实商品或模型验收。
- [界面只读检查](ui-qa.json)使用已有真实W101稿，覆盖字段回读、编辑/原文变化后的确认门槛、竞品必选资料、1440/390px布局；该检查没有模型调用。
- 修复了开发审查发现的TXT导出逐字展开、标签截断Titleist/Bulletproof词前缀问题，真实TXT字段逐项回读一致。

截图：[桌面导入预览](desktop-own-preview.png)、[手机竞品参考预览](mobile-competitor-preview.png)、[真实操作后桌面](intake-live-1440.png)、[真实操作后手机](intake-live-390.png)、[最终参考稿](final-reference-browser.png)。

## 可复跑步骤

现有标准命令仍为 npm run test:live 和运行真实工作台后的 npm run test:live:browser。

新增导入验收使用隔离工作区。先在项目根目录执行：

```powershell
node scripts/validate-live-intake.mjs --prepare
```

它实时读取官方公开商品，并把已有真实稿及不变商品事实重新导入新隔离库。本地版本从1起，原档案版本另存，不覆盖用户工作台。模型配置仅写入被排除的.runtime数据库。

另一个终端启动该隔离库的真实服务，保留实际请求审计：

```powershell
$intakeState = Get-Content -LiteralPath '.runtime/live-intake-current.json' -Raw | ConvertFrom-Json
$env:DATABASE_PATH = $intakeState.database
$env:PORT = '8788'
node --import ./scripts/live-intake-provider-audit.mjs --env-file-if-exists=.env server/index.mjs
```

在未设置上述环境变量的原终端运行：

```powershell
npm run test:live:intake -- --base-url http://127.0.0.1:8788
npm run test:live:intake:browser -- --base-url http://127.0.0.1:8788
```

两者会调用付费模型。失败保留，不回退演示。新输出默认仍在.runtime，不能把未来重跑当作此报告已验证。纯程序检查为 npm run test:intake，不替代真实验收。

## 未完成与交付边界

尚未取得商家真实插件导出样表、真实待上架稿、实际库存模板、卖家SKU和Seller Central报告；无法完成列适配、商家效果对照、平台接收或上架验收。站点/品类未知时不套本范围规则。其他站点/品类、真实大批量性能与多人账号未开放。

原缺失qa语料、批量累计配置失败却称连续、已存Dify后临时切兼容接口测试等原待办仍保留；不借用旧225项或假上游速度背书本轮。

本机原products/versions/runs/batches/settings逐表对比未变。开发前备份为.runtime/intake-development-20261030/before.sqlite。验收均使用隔离数据库。

固定分享ZIP和同名SHA256位于releases，交付标签secondary-processing-2026-10-30。包含源码、dist、公开脱敏证据及Git历史，排除.runtime、.env、数据库、密钥、凭据、node_modules、缓存和原始私有模型响应。
