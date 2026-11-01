# AI＋外贸黑客松：GitHub 复用项目筛选

核验日期：2026-10-21。团队为两名开发、一名外贸、一名海报成员；10 月 24 日完成功能开发，10 月 25 日 12:00 截止。

本次检查了 GitHub 官方仓库元数据、实际许可证、文件树、README、部分源码、测试与 CI 信息。没有在本机安装和启动这些项目；“有测试/CI”不表示本次已执行测试。

## 选型结论

优先选择 **Dify＋官方多平台内容生成教程＋简单双平台业务界面**。若两位开发已熟悉 React/TypeScript，可改用 **Vercel Chatbot** 做完整代码实现。这两条路线二选一，不叠加两套 AI 编排。

为明确展示赛题要求的平台适配，建议同一份商品资料分别进入：

1. 阿里国际站 RFQ 工作流：询盘解析、商品匹配、确定性报价、商务回复、平台规则和报价条款校验。
2. Amazon Listing 工作流：按指定站点和品类生成结构化商品内容、校验平台规则与文化表达、给出风险批注和修改对比。

TikTok 种草脚本可作为扩展，但其风格与规则需要单独配置。不同平台需要不同输出结构、业务目的和校验规则；仅改语言不能证明完成平台适配。两个平台的规则检查仍属于“平台规则”一类，还须加入合同条款或文化敏感等第二类校验。

## 1. Dify：优先采用的工作流底座

- 仓库：https://github.com/langgenius/dify
- 核验快照：159,067 stars，未归档；最近 push 2026-10-20 UTC；最新发布 1.17.1（2026-09-10）。
- 已有能力：工作流、Chatflow、知识检索、代码节点、条件分支、模型调用、API、DSL 导入导出及跨轮会话变量。
- 质量证据：[API 测试](https://github.com/langgenius/dify/tree/main/api/tests)、[CI](https://github.com/langgenius/dify/tree/main/.github/workflows)、[稳定版 DSL 服务](https://github.com/langgenius/dify/blob/1.17.1/api/services/app_dsl_service.py)。
- 最贴题起点：[官方多平台内容生成教程](https://docs.dify.ai/en/quick-start)。支持资料输入、平台与语言选择、按平台生成、结构化输出。它是搭建教程，不能描述成已验证的一键导入外贸成品。
- 仍须开发：商品事实表、RFQ 与 Listing 的独立输出结构、平台规则资料、确定性检查、风险界面、对话修改逻辑。
- 教程中的平台风格由模型分析；比赛版应改为检索经外贸成员审核的规则与写作指南，附来源、站点、品类和版本日期。
- 部署：README 最低 2 核、4 GiB；Docker Compose 涉及多个服务。建议使用稳定发布版本并冻结配置，避免深改 Dify 本体。
- [实际许可证](https://github.com/langgenius/dify/blob/main/LICENSE)：基于 Apache 2.0 的修改版，含多租户和前端标识附加条件，不能标成纯 Apache 2.0。第三方声明中保留准确许可信息。

## 2. Vercel Chatbot：React/TypeScript 代码路线

- 仓库：https://github.com/vercel/chatbot （原 vercel/ai-chatbot 已迁移）
- 核验快照：20,999 stars，未归档，最近 push 2026-07-08。
- [许可证](https://github.com/vercel/chatbot/blob/main/LICENSE)：Apache-2.0，以实际文件为准。
- 已有能力：完整聊天界面、会话历史、工具调用、文档侧栏、版本差异、建议批注。
- 具体复用位置：
  - [文档侧栏与 edit/diff 模式](https://github.com/vercel/chatbot/blob/main/components/chat/artifact.tsx)
  - [建议批注工具](https://github.com/vercel/chatbot/blob/main/lib/ai/tools/request-suggestions.ts)
  - [Playwright CI](https://github.com/vercel/chatbot/blob/main/.github/workflows/playwright.yml)
  - [E2E 测试](https://github.com/vercel/chatbot/tree/main/tests/e2e)
- 依赖：[环境配置](https://github.com/vercel/chatbot/blob/main/.env.example)涉及模型、Postgres，以及按功能需要配置的 Blob、Redis 等。不是只填写模型 key 就能启用所有功能。
- 仍须开发：知识检索、双平台业务流程、规则判断、报价计算与业务卡片。原有写作建议不等于平台合规校验。
- 适用条件：两位开发已熟悉 React/TypeScript，愿意自己维护后端逻辑。否则 Dify 更适合作为短周期起点。

## 3. Amazon 官方 SP-API 示例：平台字段与校验参考

- 仓库：https://github.com/amzn/selling-partner-api-samples
- 核验快照：212 stars，未归档，2026-10-20 UTC 仍有 push。
- [许可证](https://github.com/amzn/selling-partner-api-samples/blob/main/LICENSE)：MIT-0。
- 优先查看：[Listings 示例目录](https://github.com/amzn/selling-partner-api-samples/tree/main/use-cases/listings)。
- 具体复用位置：
  - [schema 校验与字段清理](https://github.com/amzn/selling-partner-api-samples/blob/main/use-cases/listings/app/utils/schema.ts)
  - [字段校验错误展示](https://github.com/amzn/selling-partner-api-samples/blob/main/use-cases/listings/app/components/schema-validation-errors-dialog.tsx)
  - [测试目录](https://github.com/amzn/selling-partner-api-samples/tree/main/use-cases/listings/app/__tests__)
- 作用：借鉴结构化字段、JSON Schema 校验及错误反馈方式；它不是 AI 文案生成器，也不是完整的最新平台内容规则库。
- 完整示例依赖 AWS、卖家或供应商账户、SP-API 应用及授权。比赛优先复用组件和校验思路，真实接入按已有权限决定。
- 注意：[local-ai-sandbox](https://github.com/amzn/selling-partner-api-samples/tree/main/local-ai-sandbox)也不是全部离线；Product Type Definitions 等接口会访问生产服务，Listing 数据生成默认未开启，不能误当作免授权的完整商品规则数据包。

## 4. Distill AI：仅建议复用报价组件

- 仓库：https://github.com/Distill-AI/distill-ai ，默认分支 dev。
- MIT；核验时 1 star、无正式 release。默认分支最新提交日期为 2026-07-21，不能把其他分支的较新 push 时间当作默认代码更新时间。
- 有 119 个 *.spec.ts(x) 文件；核验到默认分支对应的 [成功 CI](https://github.com/Distill-AI/distill-ai/actions/runs/29809033755)。这些是正面证据，但不能据此视为成熟生产系统。
- 可复用：
  - [确定性报价计算](https://github.com/Distill-AI/distill-ai/blob/dev/src/modules/pricing/quote-pricing.service.ts)：价阶折扣、金额汇总、交期。
  - [报价计算对应测试](https://github.com/Distill-AI/distill-ai/blob/dev/src/modules/pricing/tests/quote-pricing.service.spec.ts)。
  - [报价政策检查](https://github.com/Distill-AI/distill-ai/blob/dev/src/modules/policy/quote-policy.service.ts)：折扣和毛利门槛、待复核状态。
- 完整应用涉及 NestJS、React、Postgres/pgvector、Redis/Bull 等，移植业务组件通常比整体改造更适合本次工期。
- DEMO_MODE=true 会使用 fixture，不能把此模式当作真实模型调用。
- 这些是商家报价规则，不自动满足“阿里平台规则”“Amazon 内容规则”或全部合同条款校验。

## 5. Awesome Dify Workflow：可取用的工作流样例

- 仓库：https://github.com/svcvit/Awesome-Dify-Workflow
- 10,793 stars，未归档，最近 push 2026-03-25；[MIT](https://github.com/svcvit/Awesome-Dify-Workflow/blob/main/LICENSE)。
- 可查看：
  - [translation_workflow.yml](https://github.com/svcvit/Awesome-Dify-Workflow/blob/main/DSL/translation_workflow.yml)：目标语言与国家输入、翻译与改进。
  - [json_translate.yml](https://github.com/svcvit/Awesome-Dify-Workflow/blob/main/DSL/json_translate.yml)：保留 JSON 结构的翻译及迭代模式。
  - [Document_chat_template.yml](https://github.com/svcvit/Awesome-Dify-Workflow/blob/main/DSL/Document_chat_template.yml)：知识检索模式。
- 定位：局部节点与配置参考，不是成熟外贸应用。实读样例的 DSL 版本包含 0.1.0/0.1.3，导入当前 Dify 前需要检查版本兼容、模型供应商、工具插件和知识库绑定。
- README 已注明部分旧“运营一条龙”工作流不可正常使用，不能将整个合集统称为开箱即用。

## 备选与排除

- [Langflow](https://github.com/langflow-ai/langflow)：155,870 stars，MIT，未归档，最新发布 v1.12.6（2026-10-13）。Python 熟悉时可替代 Dify。[官方 starter_projects](https://github.com/langflow-ai/langflow/tree/main/src/backend/base/langflow/initial_setup/starter_projects)有记忆聊天、知识检索、社媒等 JSON 模板，但外贸平台规则仍须自建。
- [Flowise](https://github.com/FlowiseAI/Flowise)：已归档，官方 README 和仓库 archived 状态均确认，因此不列为本次新项目首选。
- [langgenius/webapp-conversation](https://github.com/langgenius/webapp-conversation)：已归档，不作为新前端默认起点。
- [RAGFlow](https://github.com/infiniflow/ragflow)：项目本身有质量，但本次资料规模尚不支持引入其较重的文档处理基础设施；除非团队已有运行环境，否则不优先。
- [MultiChannelListing](https://github.com/aravikishan/MultiChannelListing)：有 MIT 和真实代码，但生成引擎主要是模板，Amazon 标题限制仍硬编码 200，核验到 [CI 失败](https://github.com/aravikishan/MultiChannelListing/actions/runs/23598491068)。可看平台适配结构，不推荐直接作为合规成品。
- [SalesGPT](https://github.com/filip-michalsky/SalesGPT)：2,787 stars、MIT，但默认分支最后提交为 2024-09-17，依赖锁定较旧；仅作为销售阶段设计参考，不列为本次快速开发底座。
- [rfq-quote-agent](https://github.com/gourav-shokeen/rfq-quote-agent)：MIT、1 star，无自动测试，完整工作流外部依赖较多；其中 [HTML 转 PDF 脚本](https://github.com/gourav-shokeen/rfq-quote-agent/blob/main/pdf/make-pdf.js)可独立参考，但 Windows 路径处理需要适配，GST/INR 等报价规则不可直接套用。
- smilexiaobao1992/amazon-listing-generator-skill 与 gzx47123547-spec/dashcam-amazon-listing-ai-demo：初筛未确认清晰的复用许可证，不列为直接复制候选。

## 平台规则的当前证据与实现边界

- [Amazon 美国站官方标题更新公告](https://sellercentral.amazon.com/seller-forums/discussions/t/145b6d0f-999c-4555-896c-c694bda2e470)：公告自 2026-07-27 起非媒体类标题不超过 75 字符，并引入最多 125 字符的 Item Highlights。实现时应按选定站点和品类继续核对，避免复用旧 200 字符通用规则。
- [Amazon 商品详情页规则](https://sellercentral.amazon.com/help/hub/reference/external/G200390640)：商品描述准确性、内容排除项及相关指南可作为规则库来源。
- [TikTok Shop 美国站 Content Policy](https://seller-us.tiktok.com/university/essay?course_type=1&knowledge_id=6837891779151617)：可作为夸大宣传、商品事实一致性等检查的来源，不能自动套用到所有地区、普通内容和广告场景。
- [阿里国际站 RFQ 说明](https://supplier.alibaba.com/supplier/rfq.html)：确认采购需求、供应商报价及后续沟通的业务结构；具体规则继续使用组织方提供资料和可核验的官方规则。

每条规则建议保存 platform、market、category、source_url、effective_date、checked_at 和判定依据。程序检查长度、必填项、金额一致性；模型根据来源资料辅助检查语义与文化适配。校验通过应表述为“通过当前已覆盖规则”，不能等同于平台审核通过。

## 适合本次比赛的复用组合

**默认路线：Dify 稳定版 + 官方多平台教程 + 自研 RFQ/Amazon 两个工作流 + 简单业务前端。**

按需取用 Amazon 示例的校验/错误反馈方式、Distill 的报价逻辑、Dify 合集的少量语言处理节点。两名开发分别负责业务前端与工作流/规则，外贸成员提供商品事实和审核后的平台资料，海报成员并行制作展示。先跑通一条输入到校验反馈的完整流程，再扩展第二平台，并在最终交付中列出全部实际使用的第三方组件、版本和许可证。
