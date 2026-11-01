# 英国站骨架：英国 / 美国 / 德国 差异与出处清单

> 2026-10-30 ｜ 分支 `uk-market`（从 `de-market` 切出）｜ 只交两样：`amazon-focus/rules-uk.json` 骨架 + 本清单。
> **没有接界面、没有注册进引擎的规则包表、没有进任何默认市场。** 这个包现在不能用来出审阅结论。
>
> r2（同日补）：把平台层核了一遍 —— 英国和德国是**同一个帮助页**（同 reference id `GYTR6SYGFA5E3EQC`，只换 locale），
> 所以标题 75 字符 / item highlights 125 / 禁用特殊字符 / 同词两次这四条在两地同值。包从 6 条变 10 条。

## 1. 为什么值得做第三个法域

德国站证明的是「能按市场取规则包」；英国站证明的是「**能对不同法域建模**」——脱欧之后英国不是欧盟的复刻：

- 环保宣称：欧盟有 EmpCo (EU) 2024/825 那种点名禁词 + 直接禁「抵消式中性」的明文；英国靠 2008 年不公平交易条例 + CMA 的六项原则，**判断更依赖上下文**，同一句德语里违规的表述，英文里未必用同一条理由判。
- 认证标志：德国站的经验是「棉布袋不在 CE 范围，乱标 CE 记反向风险」；英国还要多一层——**脱欧不等于 UKCA 强制**，GOV.UK 明确写 CE 在 GB 继续被认可。
- 标签：英国用 SI 2012/1102 在国内执行同一部 (EU) 1007/2011，**依据同源、法律载体不同**。
- 安全义务：英国仍是 GPSR 2005，没有德国站那套「欧盟责任人」要件。

## 2. 三地对照（同一件事，三套依据）

| 事项 | 美国 | 德国 | 英国（骨架） |
|---|---|---|---|
| 泛化环保词 | FTC Green Guides 汇总；US-01 候选检测 | EmpCo + UBA + UWG §5，**点名禁词表**（klimaneutral / umweltfreundlich / nachhaltig…） | CMA Green Claims Code **六项原则**，无点名禁词表，按原则逐条比对 |
| 「碳中和 / 净零」 | 需实证（US-02/03） | **抵消式中性直接禁**（EU 2024/825） | 原则 (c)(e)(f)：须覆盖全生命周期、不得只讲一个方面；英国无「一律禁」的明文 |
| 认证标志 | 不得作无依据宣称（US-03） | CE / TÜV / GS：只写确实持有的；棉布袋不在 CE 范围 | **GB 仍认可 CE**（2024 年修法）；UKCA 只在部门法规要求时才需要；棉布袋未被列入 |
| 纤维成分标注 | 16 CFR Part 303（本包未做） | (EU) 1007/2011 + TextilkennzG，**德语**标注 | SI 2012/1102 执行 (EU) 1007/2011，**英语**标注 |
| 一般安全义务 | CPSA / FTC | GPSR (EU) 2023/988 第 19 条：四要素（含欧盟责任人） | GPSR 2005 reg 5：一般安全义务，**无欧盟责任人要件** |
| 塑料袋收费语境 | 各州不同（本包未做） | 无对应（德国走包装法 LUCID） | 英格兰 2015 年 5p；**2021-05-21 起 10p 且覆盖所有零售商** |

## 3. 出处清单（每条都给了原文引文与核验日期）

| source_id | 发布方 | 原文引文（节选） | URL | 核验 |
|---|---|---|---|---|
| UK-CMA-GCC | CMA《Green Claims Code》 | "The principles are: claims must be truthful and accurate … claims must be substantiated"；"Claims must not mislead consumers by giving them an inaccurate impression, even if those claims are factually correct." | gov.uk/government/publications/green-claims-code-making-environmental-claims/environmental-claims-on-goods-and-services | 2026-10-30 |
| UK-CMA-FASHION-LETTER | CMA 消费者保护总监公开信（2024-03-27） | "The Code sets out 6 key principles … are truthful and accurate … are substantiated" | gov.uk/government/publications/open-letter-to-fashion-retail-sector-about-environmental-claims/… | 2026-10-30 |
| UK-DEFRA-BAG | Defra / GOV.UK 收费数据页 | "large retailers were required to charge a minimum of 5 pence (before 21 May 2021) or 10 pence (after 21 May 2021) per bag"；"These requirements were extended to all retailers on 21 May 2021" | gov.uk/government/publications/carrier-bag-charge-summary-of-data-in-england/… | 2026-10-30 |
| UK-GPSR-2005 | legislation.gov.uk，SI 2005/1803 reg 5 | "5.—(1) No producer shall place a product on the market unless the product is a safe product." | legislation.gov.uk/uksi/2005/1803/regulation/5 | 2026-10-30 |
| UK-UKCA-GUIDE | GOV.UK《Using the UKCA marking》 | "Conformity marking is only necessary if required under sector-specific regulations. Not all products must bear a conformity marking."；"the UK continues to recognise the CE marking … under The Product Safety and Metrology (Amendment) Regulations 2024" | gov.uk/guidance/using-the-ukca-marking | 2026-10-30 |
| UK-TEXTIL-SI2012 | legislation.gov.uk，SI 2012/1102 | 目录页：「Market surveillance of the EU Regulation」+ Schedule 2「Provisions of EU Regulation」 | legislation.gov.uk/uksi/2012/1102/contents | 2026-10-30 |
| EU-TEXTIL-1007 | (EU) No 1007/2011（复用德国站已核来源） | 纤维名称取自 Annex I、百分比降序、纯纺写法 | legislation.gov.uk/eur/2011/1007/chapter/2/adopted | 2026-10-30 |
| UK-TITLE-2026 | Amazon Seller Central UK《Product title requirements and guidelines》(en-GB) | "Titles must not exceed 75 characters, including spaces."；"Titles must not use the following special characters: !, $, ?, _, {, }, ^, ¬ and ¦."；"Titles must not contain the same word more than twice. … brand names are also subject to the two-instance limit."；"Item highlights provide an additional 125 characters…" | sellercentral.amazon.co.uk/help/hub/reference/external/GYTR6SYGFA5E3EQC?locale=en-GB | 2026-10-30 |

## 4. 平台层：英国与德国同源（r2 补）

这一节是这轮唯一新增的实质内容，结论一句话：**平台层不用重做，法域层才要重做。**

抓取方式：`sellercentral.amazon.co.uk` 在本机直连 curl 超时（30s 无响应），改用网页读取器取到 en-GB 全文。
两个站点是**同一份帮助文档的两种语言版本**，reference id 完全一样（`GYTR6SYGFA5E3EQC`），只是 `?locale=` 不同。

| 平台层要求 | 英国（en-GB 页原文） | 德国（de-DE 页，已进 rules-de） | 结论 |
|---|---|---|---|
| 标题长度 | 75 字符（含空格） | 75 字符（含空格） | 同值 |
| item highlights | 额外 125 字符 | 125 字符 | 同值 |
| 禁用字符 | `! $ ? _ { } ^ ¬ ¦`（`~ # < > *` 仅特定语境可用） | 同一组 | 同值 |
| 同词上限 | 2 次（介词/冠词/连词豁免；品牌名也受 2 次限制） | 同一规则 | 同值 |
| 适用范围 | 除 media 类目外所有类目；排除沙特、埃及、土耳其、阿联酋 | 同句 | 同句 |

**对演示的口径意义**（这是评委可能追问的那一层）：如果有人问「换个国家，平台规则是不是全都要重新查」，
答案是——**平台层是同一套，换国家换的是法域层**（环保宣称的依据、认证标志、标签法规、安全义务、包装法）。
德国站的 19 条里有 13 条是平台层/事实层（AMZ/FACT/EVID/SYS），6 条是德国法域特有；英国站的骨架里
6 条全是法域层，4 条平台层照抄同一套数字。这正是「按市场取规则包」和「对不同法域建模」两件事的分界。

平台层**仍未核**的（不写进规则结论）：联系方式/站外链接、促销语禁例的英式措辞、描述准确性口径、包装件数、
类目专属 style guide（帮助页指向 `G1641`，未取）。所以这四条进去的是「数值能核、口径待补」。

## 5. 未核实（不写进规则结论，只留待查）

1. **SI 2012/1102 条文原文**：只抓到目录页与 Schedule 2 的存在，没取到「纤维成分须标注」的具体条号。要查：SI 2012/1102 正文 + Schedule 2 所列 (EU) 1007/2011 条款。
2. **GPSR 2005 是否仍现行**：抓到的是 "Latest available (Revised)" 版本，未核对 2026 年是否有新法替代（英国近年有产品安全与计量立法动作）。要查：legislation.gov.uk 的改动时间线 + DBTA 公告。
3. **CMA 的处罚权限**：2024 年公开信只说「Bill 审议中，若成法最高可罚全球营业额 10%」，DMCC Act 2024 的生效状态与额度未核。要查：DMCC Act 2024 相关条款生效令。
4. **英国标签实务写法**：英文 `100% cotton` 与 `100 % cotton` 在英标签上是否都接受，未取得实务来源。

## 6. 与任务简报不一致的两处（以抓到的一手页面为准）

1. 简报写「carrier bag charge：2015 英格兰 5p、2021 升 10p、**2022 扩到所有商家**」。GOV.UK 数据页的实际表述是：**提价与扩围同日，2021-05-21**（"extended to all retailers on 21 May 2021"）。骨架按一手页面写。
2. 简报写「脱欧后有 UKCA」。GOV.UK 现行指引是：**GB 继续认可 CE**（2024 年修法），且符合性标志只在部门法规要求时才需要。所以英国站的规则不是「必须 UKCA」，而是「不能乱标、也不能因为脱欧就以为必须换标」。

## 7. 边界

> **2026-10-31 更新：本文件所在的 `uk-engine` 分支已经把英国包接进引擎了**（见下面 §8）。
> 原文的「未注册进 store.mjs」只对旧分支 `uk-market` 成立。**界面仍然没接，main 仍然没进，
> 生成与批量链路仍然只开 US / DE** —— 所以「不对外声称支持英国站」这条一个字没松。

- ~~未接界面、未注册进 `store.mjs` 的 `rulePacks`、不在任何默认市场里；`normalizeMarketplace("UK")` 仍返回 `null`（既有测试锁着这一点）。~~
  现状：已注册进 `rulePacks`（`uk-engine` 分支），`normalizeMarketplace("UK")` 返回 `UK`；**界面没接、默认市场仍是 US、生成链路没开**。
- 10 条规则里 4 条平台层已由引擎执行，6 条法域规则记 `not_checked`，**不得**计为 pass。
- 平台层只核了标题长度 / item highlights 长度 / 禁用字符 / 同词两次四条；联系方式、促销语、描述准确性、包装件数、类目专属 style guide 仍未核，所以**这个包不能单独出审阅结论**。
- 不对外声称支持英国站。
- 还有一条容易漏的：德国站的标题上限是从包里读的（`constraint.max_characters`），所以注册英国包后数字会自动跟着走；
  特殊字符 / 同词两条在 `fd560e0` 之后已经改成**按 constraint 找规则**（不再写死 `DE-TITLE-02/03`），
  所以英国站换 id 也照样跑。

## 8. 接通引擎这一步做了什么（`uk-engine` 分支，2026-10-31）

**为什么新开一条分支**：`uk-market` 停在骨架（`4d04211`），而它之后 `de-market` 又走了 8 个提交
（规则 id 泛化、成分检查两半等）。要让英国包接到**最新的引擎**上，只能从 `de-market` 新切一条 ——
于是有了 `uk-engine`（从 `de-market` 切出，把 `rules-uk.json` 与本文档从 `uk-market` 拿过来）。
`uk-market` 从此冻结，不再前进；合并判断看 `uk-engine`。

改动四处（都不碰 main、不碰 `de-market`、不碰界面）：

1. `store.mjs`：`rulePacks` 加 `UK`，并新增 `WORKFLOW_MARKETPLACES = ["US","DE"]` ——
   「引擎取不取得到包」和「敢不敢拿它出文案」是两件事，英国站属于前者已通、后者未通。
2. `domain.mjs`：`IMPLEMENTED_RULE_IDS` 加 `UK-TITLE-01/02`（**同一段代码**、按 constraint 找规则，
   只是登记 id；不登记的话检查跑了也会被「引擎没有本地检查」的守卫改写成 `not_checked`）。
3. `domain.mjs`：同词两次的**豁免词表按语言选**（德语包 → 德语虚词表，英国包 → 英语虚词表）。
   这是接通时**实测抓到的真问题**：`Tote bag for work, for school, for travel` 在德语表下会被报成
   「`for` 出现 3 次」——官方豁免的是词类（介词/冠词/连词），不是德语词。
4. `rules-uk.json`：`implementation_status` 改 `wired_platform_layer_only`、版本 `r3`，说明与覆盖边界重写；
   `tests/uk-rules.test.mjs` 新增 11 条（含「不串包」「6 条法域全 not_checked」「引导流程仍不收 UK」）。

**接通后的事实（可复现）**：英国包 10 条里 4 条出结论（`AMZ-01` 75 字符 / `AMZ-02` 125 / `UK-TITLE-01` 禁用字符 /
`UK-TITLE-02` 同词两次），6 条法域一律 `not_checked`；美国包 15 条、德国包 19 条一个数字没变。
**没有跑真模型**：英国站没核过语料与 en-GB locale，跑一次生成只能证明「模型会写英文」，证明不了英国站，所以不花这次钱。

**还差什么才算「支持英国站」**（三件，一件都不能省）：① 剩余平台层（联系方式、促销语、描述准确性、包装件数、`G1641` 类目 style guide）按 amazon.co.uk 核；② 英国站真实在售语料采样（像德国站那 17 条）；③ 至少一次真实调用 + 报告里按英国包出结论。界面下拉放在这三件之后。
