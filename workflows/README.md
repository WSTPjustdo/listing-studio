# 工作流与模型接入

当前主线路线是本地 Node 应用编排、直接调用 DeepSeek 兼容接口。`manifest.json`、`system-prompt.txt` 和规则包是可审查的配置材料，不包含密钥。运行记录另外保留当次商品、规则、提示词版本和服务响应 ID。

## 输入约定

批量审查使用 `operation: revise`，由服务端从已保存版本附加 `review_context: { base_version, issues, missing_data, checks }`。客户端无需粘贴问题，也不能替换服务端的问题清单。模型以完整 `current_content`、商品快照和来源处理所有问题；随后独立 diagnose 不再携带旧 review_context。新版本保存 `review_input` 便于追溯。当前只接受真实模型；修复建议来自最终模型审核，并校验字段、原文和版本。

服务发出的 request 对象包含：

```json
{
  "operation": "create",
  "product": "当前不可变商品快照或 null",
  "current_content": "现有四类内容字段或 null",
  "instruction": "用户修改或用途说明",
  "marketplace": "US",
  "rules": [],
  "sources": [],
  "rule_pack_version": "amazon-us-tote-2026-10-21.v2"
}
```

`operation` 可以是 create、revise、diagnose。局部补丁先在服务端验证并应用，再按 diagnose 审阅新文本。

## 输出约定

```json
{
  "content": {
    "title": "英文标题",
    "item_highlights": "英文亮点",
    "bullet_points": [{"id":"b1","text":"英文要点"}],
    "description": "英文描述"
  },
  "review": {
    "issues": [{
      "rule_id":"US-02",
      "field_path":"content.bullet_points.b1",
      "original":"必须实际出现在字段中的原句",
      "reason":"中文依据与缺口说明",
      "suggestion":"中文处理建议",
      "severity":"needs_review",
      "source_ids":["FTCS-GREEN-SUMMARY"]
    }],
    "checks":[{"rule_id":"US-01","state":"not_checked","reason":"说明实际完成程度"}]
  },
  "claim_map":[{"field_path":"content.title","claim":"字段里的事实原文","source_ids":["实际传入的来源 ID"]}],
  "patches":[{"field_path":"content.title","expected_before":"原字段全文","replacement":"替换全文","reason":"修复原因"}]
}
```

诊断不必返回 content。各数组可为空。不要把示意字符串当成真实源 ID。源 ID 必须存在且实际传给本次调用；风险原句要能在对应字段定位。程序检查不接受模型自行更改阈值或通过状态。

## 可选 Dify 适配

尚未连接或导出实际 Dify 实例，因此不提供声称“导入即能运行”的手写 DSL。用户已有 Dify 时：

1. 新建“创建”与“诊断”两个 Workflow，各定义一个段落输入 `request_json`。
2. 模型节点系统提示使用 `system-prompt.txt`，用户消息使用输入 `request_json`。实际规则与商品证据由应用随请求传入。
3. 模型节点返回 JSON 字符串；结束节点输出命名为 `result_json`。
4. 发布并为两个工作流创建 API Key，填入本地设置页对应输入框。
5. 完成一次真实运行后再从 Dify 导出 DSL，保留模型绑定、插件版本及导入说明。

创建／修改走创建工作流，之后独立审阅走诊断工作流；旧稿诊断和补丁重检走诊断工作流。API 使用 `/workflows/run`、blocking 响应，读取 `data.outputs.result_json`。本地程序仍执行硬规则与引用核验。
