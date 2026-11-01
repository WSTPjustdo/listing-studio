# 规则说明书（由 rules.json 生成，不要手改）

> 规则包版本：`amazon-us-tote-2026-10-30.integration-v9`
> 生成方式：`node scripts/explain-rules.mjs --write`；`--check` 会在文档与规则不一致时报错。
> 共 15 条：平台规则 5、目标国宣称审查 4、商品事实质量 4、系统完整性 2。其中引用官方文件的 9 条，纯项目内部约定 6 条。
> 这里写的是「我们查什么、依据什么、不查什么」，不表示 Amazon 审核通过，也不构成法律意见。

## 一览

| 规则 | 名称 | 类别 | 严重度 | 判定方式 | 依据类型 |
|---|---|---|---|---|---|
| AMZ-01 | 标题长度 | 平台规则 | blocking | 确定性代码检查，可复现 | 官方文件 |
| AMZ-02 | 亮点长度 | 平台规则 | blocking | 确定性代码检查，可复现 | 官方文件 |
| AMZ-03 | 文案中的联系信息或链接 | 平台规则 | blocking | 模式匹配 + 上下文复核 | 官方文件 |
| AMZ-04 | 文案中的交易与促销信息 | 平台规则 | blocking | 模式匹配 + 语义复核 | 官方文件 |
| AMZ-05 | 商品描述准确性 | 平台规则 | blocking | 结构化参数对照 + 语义复核 | 官方文件 |
| AMZ-06 | 标题含多个包装规格 | 商品事实质量 | suggestion | 确定性代码检查，可复现 | 项目内部约定 |
| US-01 | 宽泛环保宣称 | 目标国宣称审查 | needs_review | 候选召回 + 上下文复核 | 官方文件 |
| US-02 | 降解宣称的证据与条件 | 目标国宣称审查 | needs_review | 宣称抽取 + 证据审查 | 官方文件 |
| US-03 | 客观性能或认证宣称依据 | 目标国宣称审查 | needs_review | 宣称抽取 + 证据审查 | 官方文件 |
| US-04 | 医疗、健康与抗菌宣称 | 目标国宣称审查 | needs_review | 候选召回 + 上下文复核 | 官方文件 |
| FACT-01 | 数量单位与属性混淆 | 商品事实质量 | blocking | 按字段类型对照商品事实 | 项目内部约定 |
| FACT-02 | 零售包装数量 | 商品事实质量 | blocking | 按明确字段对照 | 项目内部约定 |
| EVID-01 | 商品参数与来源对照 | 商品事实质量 | needs_review | 确定性代码检查，可复现 | 项目内部约定 |
| SYS-01 | 引用可追溯 | 系统完整性 | blocking | 确定性代码检查，可复现 | 项目内部约定 |
| SYS-02 | 范围与检查完成状态 | 系统完整性 | needs_review | 确定性代码检查，可复现 | 项目内部约定 |

## 逐条说明

### AMZ-01 · 标题长度

- 类别：平台规则
- 查哪些字段：`content.title`
- 判定条件：上限 75 字符（含空格）
- 怎么判：确定性代码检查，可复现
- 命中后：阻断（blocking）
- 建议怎么改：提出更短的标题，不加入新事实，重新计数。

依据：
- **Amazon / News_Amazon**（平台官方）`AMZS-TITLE-2026` https://sellercentral.amazon.com/seller-forums/discussions/t/145b6d0f-999c-4555-896c-c694bda2e470 — 生效 2026-07-27 · 更新 2026-06-10 · 核对于 2026-10-21

### AMZ-02 · 亮点长度

- 类别：平台规则
- 查哪些字段：`content.item_highlights`
- 判定条件：上限 125 字符（含空格）
- 怎么判：确定性代码检查，可复现
- 命中后：阻断（blocking）
- 建议怎么改：提炼信息，必要时移到其他适用字段，重新计数。

依据：
- **Amazon / News_Amazon**（平台官方）`AMZS-TITLE-2026` https://sellercentral.amazon.com/seller-forums/discussions/t/145b6d0f-999c-4555-896c-c694bda2e470 — 生效 2026-07-27 · 更新 2026-06-10 · 核对于 2026-10-21

### AMZ-03 · 文案中的联系信息或链接

- 类别：平台规则
- 查哪些字段：`content.title`、`content.item_highlights`、`content.bullet_points[].text`、`content.description`
- 字段例外：`content.item_highlights` 使用项目内部约定，不能称为官方规定；本应用保守沿用文案限制，待亮点字段具体规则核实；不作为独立官方规则计数。
- 判定条件：检查项：email_address / phone_number / seller_address / website_url
- 怎么判：模式匹配 + 上下文复核
- 命中后：阻断（blocking）
- 建议怎么改：删除受限文案中的联系信息；内部证据链接不属于检查对象。
- 边界与说明：尺寸数字不因形状相似而自动判为电话号码。

依据：
- **Amazon Seller Central**（平台官方）`AMZS-DETAIL-US` https://sellercentral.amazon.com/gp/help/external/G200390640?locale=en-US — 核对于 2026-10-21；官方正文通过搜索索引核验；直接打开可能需要 JavaScript 或登录。

### AMZ-04 · 文案中的交易与促销信息

- 类别：平台规则
- 查哪些字段：`content.title`、`content.item_highlights`、`content.bullet_points[].text`、`content.description`
- 字段例外：`content.item_highlights` 使用项目内部约定，不能称为官方规定；本应用保守沿用文案限制，待亮点字段具体规则核实；不作为独立官方规则计数。
- 判定条件：检查项：price / availability / condition / alternative_shipping_offer / promotional_language
- 怎么判：模式匹配 + 语义复核
- 命中后：阻断（blocking）
- 建议怎么改：移除文案中的交易与促销信息，专门的售价或库存字段不适用此规则。
- 边界与说明：促销语这一类只收整短语，不收裸 best / sale / free（20 条真实在售文案里 gift bag 14/20、perfect for 8/20 都是正常卖点）。同义词没有穷举；漏掉的写法由模型语义层兜底，本机无 Key，模型层是否兜得住属于未验证。

依据：
- **Amazon Seller Central**（平台官方）`AMZS-DETAIL-US` https://sellercentral.amazon.com/gp/help/external/G200390640?locale=en-US — 核对于 2026-10-21；官方正文通过搜索索引核验；直接打开可能需要 JavaScript 或登录。
- **Amazon Seller Forums（官方公告帖）**（平台官方）`AMZS-DETAIL-PROMO` https://sellercentral.amazon.com/seller-forums/discussions/t/dc74e76e78bf4f31df890702d631e6bd — 核对于 2026-10-29；公告帖原文：Product Descriptions 与 bullets 里不要写自家公司名、邮箱、网址、公司专属信息、另一个商品的信息，以及 sale / free shipping 一类促销语。直接 WebFetch 可读。

### AMZ-05 · 商品描述准确性

- 类别：平台规则
- 查哪些字段：`content`
- 判定条件：所有数值必须与已确认的商品档案一致
- 怎么判：结构化参数对照 + 语义复核
- 命中后：阻断（blocking）
- 建议怎么改：有确定事实则建议按事实修复；无资料则标记 needs_evidence。

依据：
- **Amazon Seller Central**（平台官方）`AMZS-DETAIL-US` https://sellercentral.amazon.com/gp/help/external/G200390640?locale=en-US — 核对于 2026-10-21；官方正文通过搜索索引核验；直接打开可能需要 JavaScript 或登录。

### AMZ-06 · 标题含多个包装规格

- 类别：商品事实质量
- 查哪些字段：`content.title`
- 判定条件：标题里不同包装件数不得超过 1 种（认 pack / pcs / pieces / count / set）
- 怎么判：确定性代码检查，可复现
- 命中后：表达建议（suggestion）
- 建议怎么改：标题只保留本变体的件数，其余规格放到变体选项里。
- 边界与说明：标题并列多种包装规格时提醒确认当前变体的零售件数。项目内部表达建议，不是平台强制规则；不将并列选项自动登记为实际件数。

依据（项目内部约定，不是平台规定）：
- **PROJECT-AMAZON-QUALITY**（项目内部约定）`PROJECT-AMAZON-QUALITY` ../Amazon-Listing精细化落地方案.md

### US-01 · 宽泛环保宣称

- 类别：目标国宣称审查
- 查哪些字段：`content`
- 判定条件：review_unqualified_general_environmental_benefit_claims = true
- 怎么判：候选召回 + 上下文复核
- 命中后：待人工核（needs_review）
- 建议怎么改：建议移除宽泛宣称，或由人工确认支持具体限定表述的证据。
- 边界与说明：关键词仅用于召回；否定、引用、限定条件和上下文影响判断。

依据：
- **Federal Trade Commission**（监管机构指南）`FTCS-GREEN-SUMMARY` https://www.ftc.gov/business-guidance/resources/environmental-claims-summary-green-guides — 文件日期 2012-10 · 核对于 2026-10-21

### US-02 · 降解宣称的证据与条件

- 类别：目标国宣称审查
- 查哪些字段：`content`
- 判定条件：require_evidence_for_claimed_degradation_conditions_and_timing = true
- 怎么判：宣称抽取 + 证据审查
- 命中后：待人工核（needs_review）
- 建议怎么改：缺证据时建议移除，或补充适用商品、测试条件和范围后人工审阅。
- 边界与说明：不从棉质推导降解条件；不将风险提示当作最终法律结论。召回词表含 compostable 与 bio/photo/hydro/oxo 前缀的 degradable（260.7、260.8）；报告里定位到命中的那个词，不是整句。

依据：
- **Federal Trade Commission**（监管机构指南）`FTCS-GREEN-SUMMARY` https://www.ftc.gov/business-guidance/resources/environmental-claims-summary-green-guides — 文件日期 2012-10 · 核对于 2026-10-21

### US-03 · 客观性能或认证宣称依据

- 类别：目标国宣称审查
- 查哪些字段：`content`
- 判定条件：match_claim_to_appropriate_reviewed_evidence = true
- 怎么判：宣称抽取 + 证据审查
- 命中后：待人工核（needs_review）
- 建议怎么改：指出缺少何种证据，不补造认证，不把一般商品页当性能测试。
- 边界与说明：证据标准取决于宣称；本规则不实现特定认证体系的官方核验。认证印章（260.6）按名称召回：GREENGUARD / OEKO-TEX / GOTS / bluesign / FSC / Cradle to Cradle / certified —— 召回不等于证书有问题，交给人看证书。

依据：
- **Federal Trade Commission**（监管机构指南）`FTCS-AD-SUBSTANTIATION` https://www.ftc.gov/business-guidance/resources/advertising-faqs-guide-small-business — 核对于 2026-10-21

### US-04 · 医疗、健康与抗菌宣称

- 类别：目标国宣称审查
- 查哪些字段：`content`
- 判定条件：require_substantiation_for_health_and_antimicrobial_claims = true
- 怎么判：候选召回 + 上下文复核
- 命中后：待人工核（needs_review）
- 建议怎么改：补充该宣称所需的科学证据并人工复核，或删除该宣称；不要用「抗菌」「防霉」「缓解疼痛」这类词当卖点。
- 边界与说明：召回三支：① 成品写法（antibacterial / antimicrobial / antifungal / antiseptic / sterile / sanitized / hypoallergenic / non-allergenic / allergy tested / medical grade / medical use / clinical proven / dermatologist recommended / FDA approved|registered|cleared / EPA registered）；② 名词式作用宣称，只认微生物对象 + proof|resistant|free|repellent|control（mildew proof / mold-resistant / dust mite resistant / germ-free …）；③ 疗效动词 + 身体或病菌宾语（relieve … pain、kills … bacteria、prevents … mold），中间允许 3 个词，`strains` 只认「肩/背/颈/关节/肌肉 + 劳损」。**不收**气味状态（odor-free / odor-resistant）、舒适度（skin-friendly / anti-fatigue）、防静电、食品接触——它们不是医疗宣称，本包也还没实现对应的性能宣称条目。本规则**不判断宣称真伪**，只提示这类词在美国属于需要实证支持的客观宣称；抗菌与抗霉在成品上还可能被当作农药类宣称管理（本包未收录该来源，故不做定性）。否定句按上下文排除。召回数字：`npm run probe:claims` 第三栏，第 16 轮 12/28 → 28/28。

依据：
- **Federal Trade Commission**（监管机构指南）`FTCS-AD-SUBSTANTIATION` https://www.ftc.gov/business-guidance/resources/advertising-faqs-guide-small-business — 核对于 2026-10-21

### FACT-01 · 数量单位与属性混淆

- 类别：商品事实质量
- 查哪些字段：`content`
- 判定条件：不能互相替代：capacity_l ↔ rated_load_kg；fabric_weight_gsm ↔ unit_weight_g
- 怎么判：按字段类型对照商品事实
- 命中后：阻断（blocking）
- 建议怎么改：使用正确的属性和单位；缺失的性能值保持未知。

依据（项目内部约定，不是平台规定）：
- **PROJECT-AMAZON-QUALITY**（项目内部约定）`PROJECT-AMAZON-QUALITY` ../Amazon-Listing精细化落地方案.md

### FACT-02 · 零售包装数量

- 类别：商品事实质量
- 查哪些字段：`content`
- 判定条件：件数声明必须等于 product.retail_pack_count
- 怎么判：按明确字段对照
- 命中后：阻断（blocking）
- 建议怎么改：采用明确确认的零售件数，不沿用供应商装箱数量。

依据（项目内部约定，不是平台规定）：
- **PROJECT-AMAZON-QUALITY**（项目内部约定）`PROJECT-AMAZON-QUALITY` ../Amazon-Listing精细化落地方案.md

### EVID-01 · 商品参数与来源对照

- 类别：商品事实质量
- 查哪些字段：`content`
- 判定条件：typed_parameter_links_from_recorded_product_facts = true
- 怎么判：确定性代码检查，可复现
- 命中后：待人工核（needs_review）
- 建议怎么改：按字段、单位、商品版本关联记录来源；参数未知或冲突时补充对应资料或修改表述。模型漏引用不影响已关联参数；整句语义与复杂宣称仍需单独审阅。

依据（项目内部约定，不是平台规定）：
- **PROJECT-AMAZON-QUALITY**（项目内部约定）`PROJECT-AMAZON-QUALITY` ../Amazon-Listing精细化落地方案.md

### SYS-01 · 引用可追溯

- 类别：系统完整性
- 查哪些字段：`issues[].source_ids`、`claim_map[].source_ids`
- 判定条件：引用必须存在于本轮输入中
- 怎么判：确定性代码检查，可复现
- 命中后：阻断（blocking）
- 建议怎么改：拒绝假引用；重新检查，无法支持的结论标为待核。

依据（项目内部约定，不是平台规定）：
- **PROJECT-AMAZON-QUALITY**（项目内部约定）`PROJECT-AMAZON-QUALITY` ../Amazon-Listing精细化落地方案.md

### SYS-02 · 范围与检查完成状态

- 类别：系统完整性
- 查哪些字段：`marketplace`、`rule_pack_version`、`review_status`、`check_results`
- 判定条件：未执行的检查不能算通过
- 怎么判：确定性代码检查，可复现
- 命中后：待人工核（needs_review）
- 建议怎么改：列出未覆盖或失败项目，保留部分完成状态。

依据（项目内部约定，不是平台规定）：
- **PROJECT-AMAZON-QUALITY**（项目内部约定）`PROJECT-AMAZON-QUALITY` ../Amazon-Listing精细化落地方案.md

## 这套规则明确不覆盖什么

- 未取得正式商品类型 Schema；不检查完整商品属性、品牌资格、变体或商品准入。
- 未覆盖图片、A+、Search Terms、进口、税务、纺织品标签及各州全部要求。
- Green Guides 的引用用于宣传风险预审，不宣称模型能完成法律认定。
- 商品事实和系统检查是补充，不单独用来计数赛题的两类校验。
- 本地英文长度边界已定义；尚未对接 Amazon 验证 Unicode 计数和字段提交行为。
- 促销语词表只收整短语、不穷举；Detail Page 公告里的「公司专属信息」与「另一个商品的细节」两类需要语义判断，本地层不做。
- 认证印章只按名称召回，不核验证书真伪或有效期。

## 补充参考来源（未直接绑定到某条规则）

这些来源支撑的是规则边界的说明，不构成某条规则的判定依据：

- **Federal Trade Commission**（监管机构指南）`FTCS-GUIDE-STATUS` https://www.ftc.gov/news-events/news/press-releases/2012/10/ftc-issues-revised-green-guides — 文件日期 2012-10 · 核对于 2026-10-21
- **Federal Trade Commission**（监管机构指南）`FTCS-GUIDE-REGISTER` https://www.ftc.gov/legal-library/browse/rules/green-guides — 核对于 2026-10-21
