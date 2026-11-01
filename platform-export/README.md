# 平台配置导出

实际平台为本地 Node.js + React + SQLite，使用代码编排工作流。本目录导出可迁移的默认配置，不含原电脑 SQLite 中的账号设置、密钥或业务记录。

- `runtime.env.example`：复制为工程根目录 `.env`，默认真实兼容接口，必须在本机配置有效密钥；缺失时阻止调用。
- `platform.json`：平台配置、入口与恢复命令索引。**里面的数字不是手抄的**，由 `npm run export:platform` 从代码常量生成：
  上传上限来自 `server/flat-file.mjs` 的 `TABLE_LIMITS`，接受的格式来自 `TABLE_FORMATS`，
  每行调用次数来自 `server/batch-cost.mjs` 的 `CALLS_PER_ROW`。手改会被 `tests/delivery.test.mjs` 判过期。
- `../workflows/manifest.json`：工作流阶段、提供商和模型参数。
- `../workflows/system-prompt.txt`：提示词约定；实际实现以 `../server/providers.mjs` 为准。
- `../amazon-focus/`、`../data-research/`：规则、场景、来源和初始化样本。

恢复：安装 Node.js 24+，工程根目录执行 `npm ci`、`npm run build`、`npm start`，访问 http://127.0.0.1:8787/。首次启动自动建库。真实模型凭据由组员自行配置。

批量能力现状（2026-10-30 由代码生成，不是声明）：XLSX / UTF-8 CSV / TSV / TXT，最多 2000 行 × 1000 列、单格 10,000 字符、文件 5 MB。每行调用模型次数按操作类型分：`create` 2 次、`diagnose` 1 次、`optimize` 2 次 —— 这组次数只在假上游与本地假网关上量过，真实 token 与单价仍未知，所以「一批多少钱」目前答不出。

改过代码里的数字后：`npm run export:platform` 重写，`npm run export:platform:check` 只比对不写（过期 exit 1）。

没有连接 Dify 实例，本包不含 Dify 原生 DSL。若赛事强制指定平台原生导出，仍需在该平台配置、验证并导出。可选接入步骤见 `../workflows/README.md`。
