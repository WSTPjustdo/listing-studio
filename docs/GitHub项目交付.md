# GitHub 项目交付

日期：2026-11-01（北京时间）。

项目：[WSTPjustdo/listing-studio](https://github.com/WSTPjustdo/listing-studio)，私有仓库，默认分支 `main`。初始提交包含本次交付的实际源码、文档、公开商品材料及已有真实验收记录。发布范围是当前工作区快照；原有本机 Git 历史和未提交工作保留，不以旧基线覆盖当前改动。

## 下载完整交付

在 [v2026.11.01 Release](https://github.com/WSTPjustdo/listing-studio/releases/tag/v2026.11.01) 下载：

- `listing-studio-hackathon-final.zip`：固定完整分享包，包含构建产物、工作台与离线演练双入口。
- `listing-studio-hackathon-final.zip.sha256`：ZIP 的 SHA-256 校验文件。
- `DELIVERY.md`：交付说明和已有验收记录入口。
- `fair-rehearsal-package-verification.json`：包完整性、清单、当前关键文件及本机已配置凭据排除检查。
- `github-publication-verification.json`：发布提交、上传附件与远端下载哈希核对结果。

Windows 可执行 `Get-FileHash .\listing-studio-hackathon-final.zip -Algorithm SHA256`，与同名校验文件比较。完整解压后，`start-fair.cmd` 打开保存结果的离线演练；`start-workbench.cmd` 打开完整工作台。两者的范围及未知项继续按根目录 README 和已有报告解释。

## 从源码运行

GitHub 的 “Code → Download ZIP” 仅下载源码，构建产物在 Release 完整分享包中。从源码运行需 Node.js 24 或以上版本，在项目根目录依次执行：

```powershell
npm ci
npm run build
npm start
```

打开 `http://127.0.0.1:8787/`，在本机设置模型配置；也可参照 `.env.example` 配置本机 `.env`。真实生成与复检需要实际 API 调用。仓库和分享包不包含本机密钥、模型配置数据库、业务数据库、`.runtime`、`.env`、依赖目录或缓存。

## 检查范围

本次发布重新执行构建、交付文档核对、分享包完整性与上传内容核对，没有新增模型调用。已有真实商品来源、实际请求 ID、模型、耗时、用量、失败重试及未解决问题仍保存在对应报告中；不把本次发布检查当作真实模型重新验收。

分享包沿用 `fair-rehearsal-20261101-working-tree-snapshot` 快照标识，源文件和哈希以包内 `DELIVERY-MANIFEST.json` 为准。包内 `repository.bundle` 仅包含原项目的已提交基线，不能用它替代当前源码；GitHub 初始提交使用实际交付源码，并单独建立当前项目的版本历史。
