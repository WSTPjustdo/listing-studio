2026-11-01 GitHub 交付：以当前源码快照建立私有项目 [WSTPjustdo/listing-studio](https://github.com/WSTPjustdo/listing-studio)，主分支为 `main`，发布版本为 [v2026.11.01](https://github.com/WSTPjustdo/listing-studio/releases/tag/v2026.11.01)。固定 ZIP、同名 SHA-256 校验文件、本文件与包核对报告同步作为 Release 附件。源码及分享包均排除本机配置、密钥、数据库和缓存；原有本机 Git 历史与未提交工作保留。构建及交付核对在发布前执行，本次没有新增模型调用，不将发布检查称为真实模型重新验收。详见 [GitHub 项目交付说明](docs/GitHub项目交付.md)。

2026-11-01 Bug 修复续轮交付：引导页接入终态轮询和网络恢复，结果读取失败时保留原运行并提供继续读取；A/B 生成期间阻止关闭、导航和连点重复请求。构建、21 项聚焦工程检查、真实 DeepSeek 标准验收、9 项浏览器检查和 5 项真实生成恢复检查完成。16 次实际响应、127,372 tokens，含 5 次保留的格式失败及真实重试；颜色、包装及文案待改项见[续轮报告](reports/bug-continuation-2026-11-01/README.md)。

本轮固定分享包为 `releases/listing-studio-hackathon-final.zip`，校验文件为同目录 `.zip.sha256`，快照标签 `fair-rehearsal-20261101-working-tree-snapshot`。包含 `start-fair.cmd` 和完整离线保温杯模拟商家演练材料；入口现明确使用 Microsoft Edge 新窗口打开，无需启动服务，本次入口修改没有新模型调用。本机桌面另建“游园会演示（Edge）”快捷方式，其他电脑使用包内 CMD。无真实商家数据，公开商品资料与预先真实生成的 AI 结果均明确标注。保温杯仅做文案与来源一致性复检，未核查食品接触法规或上架资格。见[材料、讲解与真实调用](reports/fair-rehearsal-2026-11-01/README.md)。包内清单记录工作区实际源文件哈希，保留已有改动；数据库、密钥、`.runtime`、`.env` 和缓存均排除，旧固定包先备份。

2026-11-01 双入口补齐：新增 `start-workbench.cmd` 和 `scripts/open-workbench.mjs`，本机桌面新增“本地工作台（Edge）”，原“游园会演示（Edge）”继续可用。工作台入口先确认原实例、首页和接口就绪，已运行时直接打开，未运行时调用原 `start-local.cmd`；支持已有 `.env` 中的地址配置并保护连续双击。9 项启动检查与 16 项真实工作台只读浏览器检查完成，含隔离数据库的真实启动验证；原本机配置、已有记录和离线资料均保留。本次没有新增模型调用，不将入口检查称为模型验收。记录见[启动检查](reports/fair-rehearsal-2026-11-01/workbench-entry-acceptance.json)和[原工作台界面检查](reports/fair-rehearsal-2026-11-01/workbench-entry-browser.json)。固定分享包与校验文件同步，继续排除密钥和数据库。

2026-10-31 DALIX 尺寸来源修复：已修复完整原文三轴尺寸无法关联来源而产生的 4 处误报，保留 `22" X 16" X 6"` 原单位与顺序，不推定宽、高、深的轴名，不修改商品字段。原文关联必须在实际来源记录中找到一致尺寸，不覆盖结构化冲突或借用包装/口袋尺寸。原 V10 正文不变复检为 V11，后续真实浏览器 V12/V13 均为 0 处已发现文案问题；用户确认颜色和每包零售件数未知，两项继续留空且显示补证说明。构建、45 项工程检查、真实标准验收和真实浏览器验收完成；14 次 DeepSeek 响应、102,378 tokens，包含 5 次保留的格式失败/重试。见[本轮来源与验收报告](reports/dalix-source-fix-2026-10-31/README.md)。0 处发现不代表可直接上架。

本轮固定分享 ZIP 与 `.zip.sha256` 同步为 `dalix-dimension-source-20261031-working-tree-snapshot` 工作区快照，包含已有 P1 修复及当前未提交改动。数据库、凭据、`.runtime` 与缓存继续排除；此前交付记录按当时状态解释。

2026-10-31 卖家 P1 修复交付：引导草稿和已选资料在浏览器本机恢复，商品参数编辑有未提交保护；A/B 结果按任务版本持久保存，重新打开不重复生成，采用版本必须经过独立复检；商品 Listing 台账按商品 × Amazon 站点分别固定 SKU、ASIN、状态和文案版本，旧单站台账迁移并保留原审核站点。德国、英国过期判断按各自规则包执行。构建、真实 DeepSeek `npm run test:live`、真实浏览器 `npm run test:live:browser`、真实记录只读台账 `npm run test:live:library` 均完成；最终真实审核仍有尺寸深度、颜色和包装资料待确认，不代表可直接上架。完整改动与 14 次响应台账见[修复验收报告](reports/merchant-fixes-2026-10-31/README.md)。

固定分享 ZIP：`releases/listing-studio-hackathon-final.zip`，同目录 `.zip.sha256` 为校验文件。本轮快照标签 `merchant-p1-fixes-20261031-working-tree-snapshot`，保留现有工作区改动；Git bundle 记录已提交基线，交付清单记录实际源文件哈希。排除 `.runtime`、`.env`、数据库、凭据和缓存。

2026-10-31 规则监测交付：队友基于旧版新增的 US / UK / DE / FR 规则概览、官方入口、变化台账已合入最新版，保留近期功能与修复。入口为「更多功能 → Amazon 规则监测」。记录存当前浏览器，人工登记，不自动抓取或同步，不直接修改审核规则。

构建、官方 W101 + 本机 DeepSeek 标准流程和浏览器复检完成；8 次真实响应、55,823 tokens，含 2 次格式失败，原始失败保留且未回退演示。实际请求 ID、耗时、用量和未知资料见[合并验收报告](reports/rule-monitor-sync-2026-10-31/README.md)，操作见[使用说明](docs/规则监测使用说明.md)。

固定分享文件：`releases/listing-studio-hackathon-final.zip`、同名 `.zip.sha256`；文件哈希、ZIP 完整性与凭据排除核对结果：`releases/rule-monitor-package-verification.json`。快照标签 `rule-monitor-sync-20261031-working-tree-snapshot`，包含用户已有未提交修改；Git bundle 仅含已提交基线。排除 `.runtime`、`.env`、数据库、凭据和缓存，旧包先备份。
# 2026-11-01 队友 Bug 修复交付

本轮逐项修复队友报告的 12 个问题，并完成构建、聚焦工程回归、真实 DeepSeek W101 标准/浏览器验收、隔离配置浏览器回归和真实模型文案台账导出。固定分享文件为 `releases/listing-studio-hackathon-final.zip`，校验文件为同目录 `.zip.sha256`；交付清单记录快照源文件哈希。排除 `.runtime`、`.env`、数据库、凭据和缓存。报告及真实请求 ID、模型、耗时、用量和未解决资料见 [reports/teammate-bugs-2026-11-01/README.md](reports/teammate-bugs-2026-11-01/README.md)。
