# 德国站真实在售语料：棉质手提袋（2026-10-30）

> 数字全部来自 amazon.de 商品详情页的原样读取；页面上没写的字段记「未知」，不推断、不补全。
> 这不是全站随机抽样：样本来自 amazon.de 搜索页前几屏，只代表这一批页面。

## 这批是怎么来的

- 语料 **17 条**，累计 31 次请求，跳过 14 个页面。
- 发现路径：amazon.de 搜索页（`Baumwolltasche`）取 ASIN，再逐个打开商品页。
- 未登录、未绕验证、未解验证码；每页间隔 3–5 秒。撞空壳页/英文变体换 UA 重试一次，仍失败记进 skipped。
- 每条带 `retrieved_at` / `http_status` / `page_bytes`，可逐条回原页面核对。

## 规则命中（用本项目的德国规则包实跑，不是人工判断）

规则包 `amazon-de-tote` / amazon-de-tote-2026-10-30.r1，共 19 条。

包的 19 条规则里，**本引擎能自己判完的只有 13 条**（AMZ-01、AMZ-02、AMZ-03、AMZ-04、AMZ-05、AMZ-06、DE-TITLE-02、DE-TITLE-03、FACT-01、FACT-02、EVID-01、SYS-01、SYS-02）；另外 6 条要真实模型或人工（DE-GPSR-19、DE-TEXTIL-01、DE-ENV-01、DE-VERPACK-01、DE-CERT-01、DE-GARANTIE-01），其中 DE-TEXTIL-01、DE-ENV-01、DE-VERPACK-01、DE-CERT-01、DE-GARANTIE-01 只有确定性那一半在本地跑了。所以下面「0 命中」对第一类意味着「查了、没问题」，对其余两类只意味着「本地能查的那部分没犯」。

其中 DE-TEXTIL-01 本地跑的是：成分百分比合计、降序、100 % 与多纤维矛盾、纤维名是否用德语、成分是否写进文案，五项；棉/亚麻之外的纤维名（Wolle、Viskose）、只写在图文页里的成分标注仍然判不了，所以它照样列在「需模型/人工」里——这条的命中与否都只覆盖上面那几项，不构成整条规则的结论。

其中 DE-ENV-01 本地跑的是：泛化环保词候选检测（按包里的词表：klimaneutral / umweltfreundlich / nachhaltig / öko 等）；「同媒介上有没有清晰醒目的具体说明」「宣称是否覆盖整个产品」「补偿型说法有没有写所依据的排放量」仍然判不了，所以它照样列在「需模型/人工」里——这条的命中与否都只覆盖上面那几项，不构成整条规则的结论。

其中 DE-VERPACK-01 本地跑的是：文案里有没有写包装注册号（LUCID / Verpackungsregister 字样，或裸的 DE + 8 位以上数字）+ 提到包装时同段有没有材料与比例写法；商家到底有没有在 Zentrale Stelle Verpackungsregister 注册、系统参与是否完成（都在商家后台）、以及注册号真伪 —— 这几件本地永远读不到仍然判不了，所以它照样列在「需模型/人工」里——这条的命中与否都只覆盖上面那几项，不构成整条规则的结论。

其中 DE-CERT-01 本地跑的是：认证标志候选检测（按包里的词表：OEKO-TEX / TÜV / GS / CE）+ 全篇有没有可核对的证书编号 + 在不适用 CE 的品类上标 CE；证书是否真的持有、编号与发证机构是否对得上、检测项是否覆盖本产品仍然判不了，所以它照样列在「需模型/人工」里——这条的命中与否都只覆盖上面那几项，不构成整条规则的结论。

其中 DE-GARANTIE-01 本地跑的是：Garantie 类质保宣称的候选检测 + 四项法定内容（法定权利提示 / 保证人名称与地址 / 行使方式 / 期限与地域）；质保是否真的兑付、地域是否覆盖买家所在地、以及「必须点名商品」这一项仍然判不了，所以它照样列在「需模型/人工」里——这条的命中与否都只覆盖上面那几项，不构成整条规则的结论。

| 规则 | 名称 | 方法 | 引擎 | 命中 | 命中率 |
|---|---|---|---|---|---|
| AMZ-01 | 标题长度（德国站） | deterministic | 本地可判 | 5/17 | 0.29 |
| AMZ-02 | 亮点长度 | deterministic | 本地可判 | 0/17 | 0 |
| AMZ-03 | 文案中的联系信息或链接 | patterns_with_context_review | 本地可判 | 0/17 | 0 |
| AMZ-04 | 文案中的交易与促销信息 | patterns_and_semantic_review | 本地可判 | 0/17 | 0 |
| AMZ-05 | 商品描述准确性 | structured_comparison_and_semantic_review | 本地可判 | 0/17 | 0 |
| AMZ-06 | 标题含多个包装规格 | deterministic | 本地可判 | 0/17 | 0 |
| DE-TITLE-02 | 标题同一个词不得超过两次（德国站） | deterministic | 本地可判 | 0/17 | 0 |
| DE-TITLE-03 | 标题禁用特殊字符（德国站） | deterministic | 本地可判 | 0/17 | 0 |
| DE-GPSR-19 | GPSR 第 19 条的线上报价四要素 | candidate_detection_and_contextual_review | 需模型/人工 | 0/17 | 0 |
| DE-TEXTIL-01 | 纺织品纤维成分的德文标注与百分比写法 | patterns_with_context_review | 部分本地判（成分五项） | 0/17 | 0 |
| DE-ENV-01 | 泛化环保与气候中性宣称（德国站，比美国站严） | candidate_detection_and_contextual_review | 部分本地判（环保词候选） | 9/17 | 0.53 |
| DE-VERPACK-01 | 包装法注册号是上架前提，且不能拿包装说环保 | explicit_field_comparison | 部分本地判（包装注册号写法） | 0/17 | 0 |
| DE-CERT-01 | 认证、检测标志与 CE：什么不能写 | candidate_detection_and_contextual_review | 部分本地判（认证宣称） | 12/17 | 0.71 |
| DE-GARANTIE-01 | Garantie（质保）宣称的法定内容 | candidate_detection_and_contextual_review | 部分本地判（质保宣称） | 1/17 | 0.06 |
| FACT-01 | 数量单位与属性混淆 | typed_fact_comparison | 本地可判 | 0/17 | 0 |
| FACT-02 | 零售包装数量 | explicit_field_comparison | 本地可判 | 0/17 | 0 |
| EVID-01 | 商品参数与来源对照 | deterministic | 本地可判 | 0/17 | 0 |
| SYS-01 | 引用可追溯 | deterministic | 本地可判 | 0/17 | 0 |
| SYS-02 | 范围与检查完成状态 | deterministic | 本地可判 | 0/17 | 0 |

命中 ≠ 违规：`candidate_detection_and_contextual_review` 一类只说明「这段文字需要人工看一眼」，
`deterministic` 一类（标题长度、重复词、特殊字符）才是机器可以直接判定的。表里把方法列一起放着，
就是为了不让「提示」被读成「违规」。

## 标题长度（德国站上限 75 字符，读自规则包）

最小 33 / 中位 73 / 最大 189 字符；超过 75 字符的有 **5/17** 条。

## 字段缺失（口径：标题 + 五点 + 描述 + 参数表里都找不到）

| 字段 | 缺失 | 缺失率 |
|---|---|---|
| 材质 | 1 | 0.06 |
| 尺寸 | 0 | 0.00 |
| 颜色 | 0 | 0.00 |
| 包装数 | 4 | 0.24 |
| 克重 | 17 | 1.00 |

## 逐条记录

| # | ASIN | 标题字符 | 五点 | 材质写法 | 命中规则 |
|---|---|---|---|---|---|
| 1 | [B0D2GJZXQJ](https://www.amazon.de/dp/B0D2GJZXQJ) | 132 | 5 | 100 % Baumwolle / 100% Baumwolle | AMZ-01 DE-ENV-01 DE-CERT-01 DE-GARANTIE-01 |
| 2 | [B075NB2Z5N](https://www.amazon.de/dp/B075NB2Z5N) | 64 | 5 | Baumwolle | DE-CERT-01 |
| 3 | [B0BDF8VVLM](https://www.amazon.de/dp/B0BDF8VVLM) | 58 | 5 | Jute Baumwolle | DE-CERT-01 |
| 4 | [B0924BTR4P](https://www.amazon.de/dp/B0924BTR4P) | 74 | 5 | — | DE-ENV-01 DE-CERT-01 |
| 5 | [B08FHKJP47](https://www.amazon.de/dp/B08FHKJP47) | 72 | 5 | Baumwolle | DE-ENV-01 DE-CERT-01 |
| 6 | [B07F5Y19N8](https://www.amazon.de/dp/B07F5Y19N8) | 72 | 5 | Baumwolle | DE-ENV-01 DE-CERT-01 |
| 7 | [B0HCZH8TRB](https://www.amazon.de/dp/B0HCZH8TRB) | 63 | 5 | Leinwand | — |
| 8 | [B0D9QWKDRZ](https://www.amazon.de/dp/B0D9QWKDRZ) | 176 | 6 | Baumwolle | AMZ-01 DE-ENV-01 DE-CERT-01 |
| 9 | [B09541HH6P](https://www.amazon.de/dp/B09541HH6P) | 73 | 5 | Stoff | DE-ENV-01 DE-CERT-01 |
| 10 | [B0CGJ16JV2](https://www.amazon.de/dp/B0CGJ16JV2) | 84 | 5 | Baumwolle | AMZ-01 DE-ENV-01 |
| 11 | [B0BCQYJLJR](https://www.amazon.de/dp/B0BCQYJLJR) | 33 | 5 | 100% Baumwolle | DE-CERT-01 |
| 12 | [B07FF5JW96](https://www.amazon.de/dp/B07FF5JW96) | 75 | 4 | Baumwolle | DE-CERT-01 |
| 13 | [B078NT94SH](https://www.amazon.de/dp/B078NT94SH) | 65 | 5 | Stoff | DE-CERT-01 |
| 14 | [B0D97XSBRZ](https://www.amazon.de/dp/B0D97XSBRZ) | 75 | 5 | Baumwolle | DE-ENV-01 DE-CERT-01 |
| 15 | [B08JJLMSHZ](https://www.amazon.de/dp/B08JJLMSHZ) | 145 | 5 | Baumwolle | AMZ-01 |
| 16 | [B0BNNV51YN](https://www.amazon.de/dp/B0BNNV51YN) | 45 | 5 | Baumwolle | — |
| 17 | [B0FWQPDNXV](https://www.amazon.de/dp/B0FWQPDNXV) | 189 | 5 | Leinwand | AMZ-01 DE-ENV-01 |

## 抓不到 / 被跳过的页面

| ASIN | 原因 | HTTP | 字节 |
|---|---|---|---|
| B0055TDPV2 | 材质不符（含非棉纤维或非棉，如黄麻/涤纶/棉麻混纺） | 200 | 2562943 |
| B07FF69CJ5 | 材质不符（含非棉纤维或非棉，如黄麻/涤纶/棉麻混纺） | 200 | 2806329 |
| B07FTVTTD1 | 材质不符（含非棉纤维或非棉，如黄麻/涤纶/棉麻混纺） | 200 | 2183847 |
| B0DJPMWCYN | 材质不符（含非棉纤维或非棉，如黄麻/涤纶/棉麻混纺） | 200 | 2565443 |
| B0H81VGBWR | 材质不符（含非棉纤维或非棉，如黄麻/涤纶/棉麻混纺） | 200 | 1939250 |
| B09FHMB93G | 未见棉成分披露 | 200 | 2904403 |
| B0B59MTS6N | 材质不符（含非棉纤维或非棉，如黄麻/涤纶/棉麻混纺） | 200 | 2545377 |
| B0BCR1MNSQ | 材质不符（含非棉纤维或非棉，如黄麻/涤纶/棉麻混纺） | 200 | 1607597 |
| B0F8PYNSGH | 材质不符（含非棉纤维或非棉，如黄麻/涤纶/棉麻混纺） | 200 | 2137121 |
| B0H7JLWPXZ | 材质不符（含非棉纤维或非棉，如黄麻/涤纶/棉麻混纺） | 200 | 1684647 |
| B07FTJQMR2 | 材质不符（含非棉纤维或非棉，如黄麻/涤纶/棉麻混纺） | 200 | 2562553 |
| B07F5XJKK1 | 材质不符（含非棉纤维或非棉，如黄麻/涤纶/棉麻混纺） | 200 | 2605043 |
| B0GHCN366X | 材质不符（含非棉纤维或非棉，如黄麻/涤纶/棉麻混纺） | 200 | 1701264 |
| B0D9QY1MG7 | 同款重复 | 200 | 2229018 |

## 这份语料不能证明什么

- 不能证明「德国站卖家普遍违规」：样本来自搜索页前几屏，同类高价/推广位商品会被放大。
- 不能证明 GPSR 四要素缺失：四要素大多落在**页面上的卖家信息区 / 产品标识区**，本采集器只读主商品区文本。
- 不能替代生成验收：这里跑的是规则引擎对**别人写的文案**的召回，不是本产品生成德语的能力（那是 C2 真模型那次）。