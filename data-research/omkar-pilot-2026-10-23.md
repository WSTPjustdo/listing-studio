# omkarcloud/amazon-scraper 本地试验

## 续测：配送地区与详情修复

新增 `scripts/amazon-local-api.py`，使用本机已安装的上游与虚拟环境。修复地区切换失败仍缓存目标邮编的问题；请求隔离会话；读取页面顶部邮编验证实际地区；不通过时最多重建一次会话并通过 ensure_location 再设置地区。详情使用干净 /dp/ASIN 链接，不强制 th/psc 参数，尚未证明原参数是失败原因。返回 delivery.verified、visible_delivery_location、missing_fields，缺失不等于下架。

实测同一会话从纽约 10001 切到洛杉矶 90001，页面顶部正确更新。独立会话首轮四次详情有两次不完整；加入有界恢复后，最终 B0819W9CSW/10001 和 B083DHKJS5/90001 都拿到五条卖点及规格，显示 USD 8.99 和 USD 12.74；两邮编搜索均返回 60 条且页面地区匹配。这是小样本，不保证长期成功率。原始证据 `.runtime/amazon-local-v2-retest.json`。

三个回归检查通过：失败切换恢复原缓存、页面邮编严格匹配、非法邮编联网前拒绝。执行：`.runtime/omkar-venv/Scripts/python.exe scripts/test-amazon-local-api.py`。

启动：`.runtime/omkar-venv/Scripts/python.exe scripts/amazon-local-api.py`，默认本机 8792。示例路径 `/products/details?product=B0819W9CSW&postal_code=10001`，搜索路径 `/search?query=cotton%20canvas%20tote%20bag&postal_code=90001`。当前 8792 服务运行的是加入最终恢复逻辑之前的版本：自动审批拒绝了停止并重启该服务的命令，未执行。最新代码通过独立 Python 进程完成联网复测；用户需关闭旧服务后再启动才能更新常驻服务。

Amazon 网页对应页头 Deliver to 入口，填写邮编并应用。浏览器与爬虫会话独立；网页手动切换不会自动影响爬虫。尚未接入正式工作台的地区选择页面，也未更新分享包。

数据冲突仍保留：B083DHKJS5 标题 Pack of 1，但规格 number_of_packs=30；B0819W9CSW 有 100% Cotton 和 material_fabric=Plastic 并存。适配器保留字段和核验提醒，不能自动决定哪个准确。验证邮编不等于验证含税到手价。没有购买代理或付费 API。

日期：2026-10-23。这是实际联网试验记录，不是生产可用性承诺。

- 上游：https://github.com/omkarcloud/amazon-scraper
- 固定提交：6697201f4a577a904a1a4836240901d7394e0ac4
- 隔离代码：`.runtime/omkar-amazon-scraper`；环境：`.runtime/omkar-venv`（Python 3.14）。
- 本地试验 API：`http://127.0.0.1:8791`，只绑定回环地址，两个工作线程。
- 单次请求超时 15 秒，关闭传输重试，限制商品评论及缺标题重试；没有购买代理或 API。

## 实测结果

关键词 `cotton canvas tote bag` 的一页搜索成功，耗时约 3.8 秒，返回 60 条结果；排除广告并按 ASIN 去重后有 48 个候选。这只是候选召回，不是 48 个真正竞品。

四个不同商品详情中，B0D8VBLRW9 成功；B014XXJQ1I、B0819W9CSW、B083DHKJS5 返回 AmazonNotFound。不能仅凭该异常认定商品确实下架，也可能是地区页面或解析问题。这是小样本，不能推算长期成功率。

B0D8VBLRW9 返回标题、USD 6.99、5 条卖点、100% Cotton 材质字段、护理信息与制造商。卖点声明为两件装，15 × 16 英寸，8 oz 棉帆布。上述均为商品页面声明；8 oz 未明确面积单位，不应自动换算为 g/m²。随后通过本地 HTTP API 再次获取同一商品，也成功返回上述字段。

搜索页配送文字为 Ships to China；详情调用传入 postal_code=10001，但尚未验证配送地址实际切换成功。因此 USD 6.99 仅为本次页面显示价格，不应保证为美国指定邮编最终售价，也不含已确认的运费、优惠与税费。套装总价不可直接与单件商品比较。

## 当前交付边界

已安装依赖、运行实际搜索与详情请求，并启动本地 HTTP 服务。尚未替换工作台现有 Rainforest 适配器，也未把失败详情伪装成成功。优先解决详情缺失、配送地区验证和套装单价，再接入正式竞品研究流程。品牌价值仍需结合品牌定位与商家判断。

本次未产生付费 API/代理费用，使用现有电脑和网络。持续运行会产生电力、服务器及维护成本；是否需要代理、其费用和稳定性，目前没有实测依据，不能报固定生产月费。

## 本机复现

在项目根目录的 PowerShell 中运行：

```powershell
& .runtime/omkar-venv/Scripts/python.exe .runtime/omkar-pilot.py
& .runtime/omkar-venv/Scripts/python.exe .runtime/omkar-details-pilot.py
Invoke-RestMethod 'http://127.0.0.1:8791/health'
Invoke-RestMethod 'http://127.0.0.1:8791/products/details?product=B0D8VBLRW9&country=US&postal_code=10001'
```

服务停止后可运行 `.runtime/omkar-venv/Scripts/python.exe .runtime/omkar-local-api.py` 启动；端口已有服务时不要重复启动。

原始试验数据：`.runtime/omkar-pilot-results.json`；HTTP 复测：`.runtime/omkar-http-product.json`。这些本机试验文件处于 git 忽略目录，没有放入现有分享压缩包。本次未更新应用版本、发布标签或分享包。
