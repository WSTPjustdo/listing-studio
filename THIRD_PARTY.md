# 第三方组件与资料声明

交付补充：`THIRD_PARTY_INVENTORY.json` 按锁文件列出全部直接与传递依赖、版本、许可证及来源完整性值；`third-party-licenses/` 保留本机已安装依赖的 LICENSE/NOTICE 正文。其他操作系统的可选二进制未安装，清单明确标记 `installed: false`，其许可文件随目标平台 `npm ci` 下载的包分发。更新依赖后运行 `node scripts/export-licenses.mjs` 刷新清单。本工程不把第三方许可证改为自有许可。

当前工程自行实现业务界面、SQLite 存储、规则候选与工作流，未复制 Amazon 完整应用、Dify 内核或报价项目。已安装依赖版本固定在 package-lock.json，许可信息核对于对应包的 package.json；许可正文随各 npm 包分发。

| 组件 | 当前版本 | 许可证 | 用途 |
|---|---|---|---|
| React / React DOM | 19.3.1 | MIT | 界面 |
| Cheerio | 1.2.0 | MIT | Amazon 商品 HTML 解析 |
| ExcelJS | 4.4.0 | MIT | XLSX / CSV 导入、Excel 结果导出 |
| @napi-rs/canvas | 1.1.0 | MIT | PDF 页面渲染与小图放大 |
| @tesseract.js-data/chi_sim | 1.0.0 | MIT | 本地简体中文 OCR 语言资源 |
| @tesseract.js-data/eng | 1.0.0 | MIT | 本地英文 OCR 语言资源 |
| JSZip | 3.10.2 | MIT OR GPL-3.0-or-later | Office 压缩结构与容量核对 |
| Mammoth | 1.13.0 | BSD-2-Clause | Word DOCX 原文提取 |
| pdfjs-dist | 6.4.299 | Apache-2.0 | PDF 文字提取与页面渲染 |
| tesseract.js | 7.0.0 | Apache-2.0 | 本机中英文图片及扫描页 OCR |
| lucide-react | 1.61.0 | ISC | 图标 |
| Zod | 4.6.7 | MIT | 运行时数据结构验证 |
| Vite | 8.3.5 | MIT | 开发与构建 |
| @vitejs/plugin-react | 6.1.2 | MIT | React 构建插件 |
| TypeScript | 7.0.2 | Apache-2.0 | 类型检查 |
| concurrently | 10.0.6 | MIT | 同时启动前后端 |
| @playwright/test | 1.64.1 | Apache-2.0 | 浏览器测试 |
| @types/node | 26.6.5 | MIT | 类型定义 |
| @types/react | 19.3.0 | MIT | 类型定义 |
| @types/react-dom | 19.3.0 | MIT | 类型定义 |
| Prettier | 3.9.10 | MIT | 代码格式化 |

SQLite 使用 Node.js 内置 `node:sqlite`，未增加原生 npm 数据库编译依赖。棉布袋示意图由本工程 SVG 绘制，不是第三方商品照片。界面使用系统字体，无远程字体依赖。

## 可选服务与设计参考

ExcelJS 的传递依赖 uuid 固定覆盖为 11.1.1，兼容其 v4 调用。锁文件、全量清单与许可正文一同更新；2026-10-31 `npm audit` 报告既有 ExcelJS 归档依赖链 8 项 moderate、0 项 high/critical，未为消除告警强行降级 ExcelJS。导入时不执行公式，导出使用字符串单元格。

- DeepSeek：通过用户自己的密钥调用服务，遵守服务商条款；未将模型权重打包。[官方接口文档](https://api-docs.deepseek.com/)。
- Dify：可选 API 适配，未打包其源代码。若后续部署或复制其源码，使用其[含附加条件的 Apache 2.0 修改版许可证](https://github.com/langgenius/dify/blob/main/LICENSE)。
- Amazon [Listings 示例](https://github.com/amzn/selling-partner-api-samples/tree/main/use-cases/listings)：参考结构化校验和错误定位方式，没有直接复制组件。该仓库许可证为 MIT-0；后续实际复制时需记录文件与提交。

## 业务资料

公开商品参数及规则仅以必要事实、摘要和源链接保存，出处见 `data-research/public-product-facts.json` 与 `amazon-focus/rules.json`。不包含整页营销文案、第三方商品图片、真实商家库存或买家资料。

合成演示 SKU、包装条件及错误 Listing 均明确标记；它们不代表 Westford Mill 或其他真实商家的供货与认证承诺。

## 可选本地 Amazon 爬虫

分享包 vendor/amazon-scraper-6697201.zip 附带 https://github.com/omkarcloud/amazon-scraper 的运行源码，提交 6697201f4a577a904a1a4836240901d7394e0ac4（MIT，Copyright 2026 Chetan Jain），包含上游原始运行源码、README、requirements 和 LICENSE，不含测试网页与宣传图片；安装时解压至 .runtime。运行依赖 bottle、cheroot、curl_cffi、beautifulsoup4、lxml、marshmallow 及传递依赖，安装于独立虚拟环境；具体许可随其安装分发包提供。上游许可副本见 third-party-licenses/omkar-amazon-scraper.txt。
