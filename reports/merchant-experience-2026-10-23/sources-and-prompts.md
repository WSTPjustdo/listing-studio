# 真实商品来源与英文提示词

核验记录时间：2026-10-23 21:25:56，Asia/Shanghai（UTC+08:00）。这是本次联网核验的记录时间，不是源网页的更新时间。

本资料是本次体验的前期调研底稿。以下第5、6节是备选提示词方案，并非最终实际提交的版本。实际提示词以 prompt-v1.txt、prompt-v2.txt 及两版 JSON 的 instruction 为准，完整体验结果见 PDF。

后续实测补充：工作台已于 2026-10-23 21:25:29（Asia/Shanghai）通过 direct_http 实时导入 B0732NPDRB，模式 live，页面库存观察文字为 In Stock，证据见 import-responses.json。这与下文网页调研工具的约四周前快照是不同通道。实时导入未取得颜色、材质、尺寸等字段；本次只人工补录官网材质，颜色仍未知。库存文字不代表用户库存或可售权限。后续完成4次真实 DeepSeek 调用及V1/V2导出，未发布或上架。

## 1. 选用商品与来源

主测商品：DALIX 22-inch 棉帆布拉链手提袋，Natural 颜色。选择理由：真实 Amazon US 商品页面与品牌官网均能查到，属性较清晰，符合工作台当前 cotton tote 范围，也不同于旧 W101 验收商品。

| 来源 | 链接 | 本次实际获取情况 | 时效限制 |
|---|---|---|---|
| Amazon US 商品页面 | https://www.amazon.com/dp/B0732NPDRB | 浏览工具返回商品 HTML，可读到标题、颜色、ASIN、商品属性和描述 | 工具标注抓取快照约四周前；不等于本次直接验证当天库存、价格或报价 |
| DALIX 品牌官网 | https://www.dalix.com/products/heavy-duty-cotton-canvas-tote-bag | 浏览工具返回产品页和规格区域 | 工具标注当天抓取；页面本身未提供可确认的最后更新时间 |

本次独立来源调研未遇到上述两个链接的浏览工具访问阻断。此结论仅描述来源调研通道，不保证工作台导入器或本机浏览器也能成功抓取；导入结果以主流程另行记录为准。

## 2. 可用事实与未知项

| 字段 | 核验结果 | 使用方式 |
|---|---|---|
| 品牌 | DALIX，两处一致 | 可使用 |
| 商品类型 | 棉帆布手提袋，顶部拉链 | 可使用 |
| Amazon ASIN | B0732NPDRB；商品页面 currentAsin、landingAsin 和规格表一致 | 可作为外部来源标识，不当作商家 SKU |
| 颜色 | Amazon 页面明确为 Natural；官网列出该颜色选项 | 使用 Natural，不把官网默认选中的 Pink 变体混入 |
| 材质 | 官网明确 100% cotton canvas；Amazon 写 cotton canvas | 可使用 |
| 面料规格 | 两处均标 12 oz | 仅作为网站给出的面料规格，不当作容量或整包重量 |
| 尺寸 | 两处均为 22 × 16 × 6 inches | 保留原顺序；不额外推定不同页面含混的 L/W/H 轴向 |
| 开合方式 | 顶部拉链 | 可使用，不推导为防盗 |
| 口袋 | 外置开口袋 | 可使用，不自行补充内袋 |
| 缝制 | 官网说明底部和两侧双线缝合 | 可转述为构造，不推导承重数值或终身耐用 |
| 型号参考 | Amazon Style Number 为 ST-042-Natural | 明确它是来源型号，不是用户已有 Seller SKU |
| 用户 Seller SKU | 未取得 | 保持空缺或未知；不得伪造 |
| 容量、承重、认证、产地 | 未取得足够一致可靠证据 | 不写入消费者文案 |
| 今日售价、库存、商家销售权限 | 未验证 | 保持未知 |
| 上架状态 | 本次只进行研究和体验，未连接 Seller Central | 不得标成已上架 |

官网的简短原文依据包括 “100% Cotton Canvas” 和 “9\" Drop Handles”。Amazon 描述中则出现 “drop strap length of 11\"”。引用仅用于说明材质与数据冲突，其余内容使用事实转述。

## 3. 数据冲突与质量观察

1. **提手落差不一致。** 官网为 9 inches，Amazon 商品描述为 11 inches。暂不选取任何一个值写入文案，列为待商家确认。
2. **容量字段可疑。** Amazon 规格表把 Capacity 写为 12 ounces，与面料的 12 oz 数值相同。不能据此确认为容量，也不应自行修正成某个升数。
3. **A+ 内容可能跨变体混入。** Amazon A+ 可见 California 刺绣相关描述，但所选商品为 Natural 空白棉帆布款。不能据此宣称美国制造、已刺绣或可个性化。
4. **官网默认变体不同。** 本次返回官网页面的默认型号字符串为 ST-042-Pink；其通用规格可与 Amazon 核对，但本次选择的 Natural 颜色及 ASIN 应以 Amazon 对应变体为准。
5. **页面存在不等于当天可购买。** Amazon 数据来自浏览工具提供的既有抓取快照；价格、评价量、库存及销售排名未纳入事实底稿。

曾考察 DALIX 23-inch 棉帆布袋（链接 https://www.amazon.com/dp/B01IJJQ50C ，官网 https://www.dalix.com/products/heavy-duty-24-oz-cotton-canvas-shopping-tote-bag ）。该 Amazon 返回内容存在链接 ASIN 与部分隐藏字段 ASIN 不一致，未选为本次主测对象，也未把它的规格合并到 22-inch 商品。

## 4. 可用于导入核对的英文事实底稿

以下为人工整理的来源摘要，不是模型生成结果。

```text
Product: DALIX 22-inch Cotton Canvas Zippered Tote, Natural.
Verified attributes: 100% cotton canvas; 12 oz fabric; dimensions
22 x 16 x 6 inches; top zipper closure; exterior open pocket.
The manufacturer's page also describes double stitching along
the bottom and sides. ASIN: B0732NPDRB.
Seller SKU, load capacity, volume capacity, country of origin,
certifications and current inventory are unknown.
Handle drop is disputed: manufacturer 9 inches, Amazon 11 inches.
Do not use either handle measurement until verified.
```

## 5. 初版英文提示词

设计目的：代表新商家较常见的简要要求，用于真实模型调用后的对照观察。是否实际使用及输出结果以主流程记录为准。

```text
Write an English Amazon US product title, five bullet points
and a short description for this DALIX cotton tote using the
provided product information. Make the copy clear and appealing
for everyday shopping and carrying.
```

## 6. 改进版英文提示词

设计目的：补充受众、结构、表达方式、事实边界和冲突处理。字符、字数限制是本次编辑目标，不表示本文件已核验 Amazon 各类目最新政策。

```text
Rewrite the listing in concise, natural US English for shoppers
comparing everyday cotton totes. Use only the verified product
facts supplied. Lead with the zipper closure, exterior pocket,
cotton canvas and dimensions. Connect each feature to a simple
practical benefit without promising theft protection, load
capacity or guaranteed durability.

Create one title under 160 characters, five distinct bullet
points and one description under 120 words. Avoid emojis,
keyword repetition, exaggerated claims and promotional language.

Do not invent a seller SKU, price, inventory, certifications,
country of origin, warranty or environmental claims. Do not
call the fabric organic, recycled, waterproof or machine washable.
Treat 12 oz as the stated fabric specification, not capacity or
item weight. Omit handle-drop measurements because sources
disagree. Keep disputed and missing facts in a separate review
note, outside the customer-facing copy.
```

## 7. 后续体验应检查的结果

- 导入器是否真实取得商品事实；来源失败时是否保留失败原因。
- 是否混入官网默认 Pink 颜色、其他尺寸或其他变体。
- 初版与改进版是否真实调用本机配置的模型，并记录请求 ID、模型、耗时、用量。
- 改进后文案是否保留必要规格，避免擅自补全未知项，删除有争议的提手长度。
- 英文提示词编辑入口、保存方式、版本比较和导出是否清楚。
- 没有 Seller SKU 时能否完成研究草稿，且不虚构已上架状态。
