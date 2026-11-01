# 规则监测合并与真实验收（2026-10-31）

用户要求将队友基于旧版开发的规则监测功能套用到本机最新版。来源为 `Listing-Guardian-规则监测-四站点版-20261031.zip`，67,139,882 字节，SHA-256 `a3cc914bbfa8a4dcda7fdddb3cabefaffb4032d5f84911d85a7c1ca21db9e3c4`。附带说明仅作为待审阅版本资料，不改变用户要求和项目验收约定，未据其中“已有定时任务”的描述创建或宣称已接通自动化。

## 合并范围

- 新增 `RuleMonitor.tsx`、`rule-monitor.css`、依赖组件 `SiteRuleProfiles.tsx`；在现有 App 和 View 类型中接入入口、页面及面包屑，进入手机规则监测页后收起功能菜单，避免挡住台账。从「更多功能 → Amazon 规则监测」打开。
- 支持四站点当前规则包概览、官方信息源、人工变化登记、站点/状态筛选、来源跳转与删除；记录兼容队友 `listing-guardian-rule-monitor-v1` 本地存储键。
- 保留最新版素材导入、质量检查弹窗、上架检查、台账、侧栏、移动端及模型错误处理。没有用队友旧版的 App、后端或测试脚本整体覆盖当前文件，没有移入无关的 `QualityView.tsx` 或旧 dist。
- 修正“每周监测计划已建立／计划启用”的未核实表述，明确团队人工核验。站点卡片标明当前规则包范围，法域清单不表示已完成合规检查，普通棉布袋不默认要求 UKCA。
- 补充记录格式验证、损坏数据原样保留、读写失败提示与 HTTPS 来源校验；保存失败不清表单、不显示成功。修正长版本号与窄屏换行，筛选有可访问标签。

台账不更新商品、历史文案或审核规则库，不调用模型。记录仅属于当前浏览器及当前站点地址，跨浏览器/端口/电脑不会同步，清理浏览器存储会丢失记录。没有后台爬虫、Seller Central 授权或已接通的定时任务；未知外部任务状态保持未知。完整操作见[使用说明](../../docs/规则监测使用说明.md)。

## 真实模型回归

在独立数据库中使用实时 [Westford Mill W101 官方商品页](https://westfordmill.com/products/w101) 与本机已有 DeepSeek 配置。公开商品不等于商家库存；未打印或分发凭据，未伪造 SKU、包装或上架状态。主数据库各表内容哈希前后一致，见[主库保护记录](main-data-preservation.json)。

| 验证 | 实际结果 |
| --- | --- |
| `npm run build` | TypeScript/Vite 通过，Vite 保留大于 500 kB 的主包体积提醒 |
| `npm run test:live` | 官方来源实时读取，生成与独立审核 V1、问题改稿与复检 V2、补充官方规格后同任务复检 V3 完成；V1 有 4 项提示，V2/V3 为 0 项 |
| `npm run test:live:browser -- --base-url http://127.0.0.1:8793` | 真实复检保存 V4；过期商品版本拦截、历史版本不变、证据展开与 HTML/TXT/JSON/纯文案导出通过；V4 为 0 项问题，颜色和零售包装仍未知 |
| `npm run test:live:rule-monitor:browser -- --base-url http://127.0.0.1:8793` | 17 项真实来源/界面检查、3 项存储与 URL 工程边界通过；1440/768/390 像素共 9 次布局检查无横向溢出、无页面错误；0 次新增模型调用 |
| `npm run audit:delivery` | 文档命令/链接、融合用例数字和第三方许可对账通过；此为工程对账，不代替上列真实验收 |

本轮共 **8 次真实模型响应、55,823 tokens**，模型为 `deepseek-flash`；其中 **2 次 `MODEL_INVALID_JSON`** 在已有一次格式重试后成功，失败请求及真实用量保留。费用账单金额未知，未用 tokens 推算。标准与浏览器请求 ID、耗时、用量见[模型台账](model-call-ledger.json)、[标准 V1–V3](standard-live.json)和[浏览器 V4](browser-live.json)，另见[保留的格式失败](retained-failures.json)。未将失败响应当作成功结果，未回退模拟模型。

## 规则台账浏览器验收

真实浏览器验收在同一隔离服务完成，使用隔离浏览器，不改用户日常浏览器记录。登记内容来自实时 [FTC Green Guides 官方指南](https://www.ftc.gov/business-guidance/resources/environmental-claims-summary-green-guides)，原文摘录、读取时间及页面哈希保留；登记为“官方指南来源核对，政策变化待核实”，发布日期和生效日期留空，未把既有指南编造成新政策。

实际结果见[台账验收记录](rule-monitor-browser.json)、[桌面概览](monitor-empty-1440.png)、[手机登记结果](monitor-registered-390.png)。故障注入只验证浏览器存储边界，与真实政策来源和模型验收分别记录；不模拟商品或模型返回。台账操作前后服务端商品、文案、来源、规则哈希和模型调用记录一致，无新增模型请求。

前三次浏览器专项未完成的定位失败分别保留于 `browser-first-attempt-failure.json`、`browser-second-attempt-failure.json`、`browser-third-attempt-failure.json`：首次在站点下拉框定位超时，第二次删除按钮定位名称与实际可访问名称不一致，第三次重开带草稿的表单后正文标签定位超时。已为表单补齐明确的可访问名称并修正删除定位；最终完整流程与后续手机菜单修正复验均通过。未将中途已通过的检查冒充整轮成功，也未新增付费调用。

Seller Central 信息源仍可能需要登录或出现 Server Busy；本轮未授权卖家账号，也未声称核验其政策正文。FTC、欧盟和英国政府入口在只读检查中返回 200，不代表相关法规对每个商品都适用。未知颜色、零售包装、其他法域未完成项和法国生成历史限制继续保留；本轮没有重做四站点全部模型验收，不代表完整上架批准。

## 分享交付

固定 ZIP `releases/listing-studio-hackathon-final.zip` 与同名 `.zip.sha256` 按当前工作区重新生成，标签 `rule-monitor-sync-20261031-working-tree-snapshot`。文件与清单哈希、ZIP CRC、校验和及本机凭据排除核对见 `releases/rule-monitor-package-verification.json`；旧固定包先备份。

源码以 ZIP 文件和清单定义的工作区快照为准；Git bundle 仅含已提交基线，本轮未提交已有修改、未移动 Git 标签。`.runtime`、`.env`、数据库、凭据和缓存不随包分发。
