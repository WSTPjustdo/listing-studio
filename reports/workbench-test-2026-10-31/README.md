# 工作台真实功能复测（2026-10-31）

本轮测试的是本机当前工作区：Git 基线 `8cf72a45f72cc2c928eb588556c84b9f718e70d5`，包含用户已有未提交改动及本轮小范围修正。工作台地址为 `http://127.0.0.1:8787/`，本机 Node.js 24.14.0、Edge。测试从实时 Westford Mill W101/W201 官方来源和本机已有 DeepSeek 配置开始；没有使用模拟模型返回、合成商品或伪造 SKU。

## 结果

| 项目 | 结果与边界 |
| --- | --- |
| TypeScript / Vite 构建 | 通过，最终前端资源 `index-AXdz0Pno.js` |
| `npm run test:live` | 通过：真实 W101 生成与独立审核、问题审查修复与复检、补充官方规格后原任务复检，保存 V1–V3；最终 0 项问题，颜色、零售包装仍未知 |
| `npm run test:live:browser` | 通过：实际模型复检、过期商品版本拦截、旧版本不变、证据展开、HTML/TXT/JSON/纯文案导出；在隔离服务 8788 上执行 |
| 德国站引导链路 | 真实方案、德语生成、独立审核成功；初次 TXT 导出误标 US，已修正并使用同一真实记录复核四种导出，无额外模型调用 |
| 英国站引导链路 | 真实方案、英式英语生成、独立审核、JSON/TXT/HTML 导出及站点范围核对通过；6 条英国法域规则仍为 `not_checked` |
| 法国站引导链路 | 未通过：两次执行均在方案阶段失败。首次两次模型响应均 `MODEL_INVALID_STRUCTURE`；再次执行的两次响应含固定百分比 `5 %` / `100 %`，均 `GUIDED_TEMPLATE_INVALID`。未保存成功方案、未执行法国站生成，不回退演示模式 |
| 桌面 / 390px 手机交互 | 84 项只读检查通过，无 JS 错误、无横向溢出、无写请求；两条引导入口、10 组站点语言、内部档提示、更多功能入口、四站规则切换、真实历史结果与商品页 |
| 批量 | 只验证页面及上传入口，没有上传商家表格、启动批次或做平台上传验收 |

“10 组”是站点与语言的组合，共涉及英文、西班牙文、中文、德文和法文 5 种语言。中文及法国站英语仅作内部对照。站点可选、模型生成成功或问题数为零，均不能证明完整法域合规或允许直接上架。

## 实际模型记录

本轮共记录 **23 次真实响应、213,640 tokens**，包含失败、格式重试和浏览器初次失败后的真实复检；8 次响应在格式或结构校验阶段失败。每次请求 ID、模型、耗时和用量见 [model-call-ledger.json](model-call-ledger.json)，没有未知耗时或未知用量。金额未知，tokens 不等于账单金额。

| 流程 | 实际请求 ID（节选） | 状态 |
| --- | --- | --- |
| US 生成与独立审核的审核请求 | `f7fd0455-e8b6-45c4-9d49-4e83d05ebb7a` | 成功，完整调用链见标准报告 |
| US 修复与复检 | `a34d5b7d-840b-40a7-84ee-7dd496076e19` | 成功 |
| US 补规格复检 | `e12a84ba-b751-4c12-8543-16fefbb132ec` | 成功 |
| 浏览器最终复检 | `b0821ae6-9eb5-4636-8216-3cce1018ea50` | 成功，0 项问题 |
| DE 方案 / 独立审核 | `909d9758-997c-4912-867e-904734fe0fa7` / `5a2ede5a-b3c0-40e3-b097-9ed46e028f6b` | 成功，方案首响应格式失败后恢复 |
| UK 方案 / 独立审核 | `d90ae120-e684-4d60-ada1-c0d7dbea543c` / `c1f603ae-9696-4982-be7d-a5b7348a7ac0` | 成功，审核首响应格式失败后恢复 |
| FR 首次方案执行 | `1fc2efaf-6f9f-4abb-845a-11148c578f21` / `5150eaa1-411c-4a19-b0fa-c95ce2532564` | 两次响应结构校验失败 |
| FR 第二次方案执行 | `a8b1d9b8-0858-4735-a390-20ddd7fe76ab` / `7763d4e6-70f1-4fdc-8f96-f21b0baf3458` | 两次响应固化百分比，模板校验拒绝 |

标准测试使用独立验收库；浏览器测试只给这个隔离库追加真实版本，四站测试使用另一个独立库。本机模型配置由已有配置提供；密钥、数据库和原始模型响应仅留在 `.runtime`，不随分享包分发。主工作台现有商品和 Listing 未被这些模型测试替换；只读 UI 核对的商品、Listing 版本前后相同。

## 修正与保留失败

- TXT 导出检查范围改为读取已保存版本的站点，避免德国等记录被写成 US。
- 浏览器验收脚本在展开证据前先进入“检查与依据”页签；新增 `--browser-executable`，支持本机实际 Edge 安装路径。首轮已经完成真实复检但因旧导航定位超时失败，该失败记录继续保留。
- 批量上传页说明改为四站点；英国引导说明去掉过时的“10 条”，继续明确法域规则未完成。
- 法国两次执行失败均保留，没有放宽模板校验、没有重写为成功，也没有继续无上限付费重试。

## 复核入口与证据

```powershell
npm run build
npm run test:live
npm run test:live:browser -- --base-url http://127.0.0.1:8788 --browser-executable 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node scripts/validate-live-teammate-e.mjs --real-api --base-url http://127.0.0.1:8789 --markets DE,UK,FR
```

8788/8789 仅为本轮隔离测试服务，复跑前需准备真实资料和现有模型配置；命令会产生新的付费调用，最后一条本轮总体未通过，不能仅凭 UK 成功输出改记为全通过。

- [标准真实流程](standard-live.json)、[浏览器流程](browser-live.json)、[跨站点流程与失败详情](market-live.json)。
- [德国导出修正后复核](de-export-recheck.json)、[保留的失败](retained-failures.json)、[只读 UI 84 项](checks.json)、[两处说明最终复核](final-copy-checks.json)。
- [浏览器真实证据页截图](live-acceptance-browser.png)、[桌面首页](desktop-home.png)、[手机首页](mobile-home.png)、[最终英国说明](final-uk-note.png)、[最终批量说明](final-batch-scope.png)。

## 交付版本

固定分享路径：`releases/listing-studio-hackathon-final.zip` 与同名 `.zip.sha256`。包是当前未提交工作区快照，不是新 Git 提交；`DELIVERY-MANIFEST.json` 明确 `working_tree_snapshot=true`、基线提交及文件哈希。`repository.bundle` 只含基线已提交历史，不含未提交改动；恢复本轮结果应使用 ZIP 文件快照。旧固定包先备份，再经逐文件 SHA-256 验证后更新。没有替用户提交现有改动或移动标签。

未完成项：法国真实方案与生成、各站法域检查和真实商家批量表；视觉模型、Seller Central 上架、真实库存/SKU 和商家效果验收仍未完成。
