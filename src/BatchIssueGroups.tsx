import { createRequestId } from "./requestId";
import { useState } from "react";
import { post } from "./api";

export type IssueGroup = {
  rule_id: string;
  title: string;
  members: {
    row: number;
    sku: string;
    name: string;
    version: number;
    status: string;
    actionable: boolean;
    deferred: boolean;
    issues: { field_path: string; reason: string; suggestion: string }[];
  }[];
};
type Item = {
  row: number;
  sku: string;
  status: string;
  reason?: string;
  error?: string;
  result_version?: number;
  patches: {
    field_path: string;
    expected_before: string;
    replacement: string;
  }[];
};
export type GroupAction = {
  id: string;
  rule_id: string;
  action: string;
  items: Item[];
};
type Request = {
  rule_id: string;
  action: string;
  items: { row: number; version: number }[];
  request_id: string;
};
const labels: Record<string, string> = {
  review: "统一审查",
  repair: "应用修复",
  defer: "暂不处理",
  queued: "排队中",
  running: "处理中",
  completed: "已完成，仍需确认检查结果",
  failed: "失败",
  skipped: "已跳过",
  deferred: "暂不处理，风险保留",
};

export default function BatchIssueGroups({
  batchId,
  groups,
  actions,
  processing,
  onChanged,
}: {
  batchId: string;
  groups: IssueGroup[];
  actions: GroupAction[];
  processing: boolean;
  onChanged: () => Promise<void>;
}) {
  const [selection, setSelection] = useState<
    Record<string, Record<number, number>>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{
    request: Request;
    items: Item[];
  } | null>(null);
  async function send(request: Request, dryRun = false) {
    setBusy(true);
    setError("");
    try {
      const result = await post<{ items: Item[] }>(
        `/api/batches/${batchId}/group-action`,
        { ...request, preview: dryRun },
      );
      if (dryRun) setPreview({ request, items: result.items });
      else {
        setPreview(null);
        setSelection({});
        await onChanged();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function act(rule: string, action: string) {
    void send(
      {
        rule_id: rule,
        action,
        request_id: createRequestId(),
        items: Object.entries(selection[rule] || {}).map(([row, version]) => ({
          row: Number(row),
          version,
        })),
      },
      action === "repair",
    );
  }
  return (
    <section className="group-workspace" aria-label="同类问题集中处理">
      <h3>按问题集中处理</h3>
      <p className="helper">
        勾选存在同一问题的商品，一次提交。每件商品按自己的资料修复并保留独立版本。缺失资料请进入商品详情补充。
      </p>
      {processing && (
        <p role="status">本批仍有排队或运行中的商品，完成后即可集中处理。</p>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {!groups.length && (
        <p>
          当前已生成结果中没有已发现的问题；资料缺口和未完成检查请查看商品详情。
        </p>
      )}
      {groups.map((group) => {
        const chosen = selection[group.rule_id] || {};
        const disabled = busy || processing || !Object.keys(chosen).length;
        return (
          <details
            className="group-card"
            key={group.rule_id}
            data-rule={group.rule_id}
          >
            <summary>
              <strong>{group.title || group.rule_id}</strong> ·{" "}
              {group.members.length} 件商品{" "}
              <span className="helper">{group.rule_id}</span>
            </summary>
            <button
              className="text-button"
              disabled={busy || processing}
              onClick={() => {
                setPreview(null);
                setSelection({
                  ...selection,
                  [group.rule_id]: Object.fromEntries(
                    group.members
                      .filter((m) => m.actionable)
                      .map((m) => [m.row, m.version]),
                  ),
                });
              }}
            >
              选择本组全部可处理商品
            </button>
            <button
              className="text-button"
              onClick={() => {
                setPreview(null);
                setSelection({ ...selection, [group.rule_id]: {} });
              }}
            >
              清空选择
            </button>
            {group.members.map((member) => (
              <div className="group-member" key={member.row}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${member.sku}`}
                    checked={chosen[member.row] !== undefined}
                    disabled={busy || processing || !member.actionable}
                    onChange={(e) => {
                      const next = { ...chosen };
                      if (e.target.checked) next[member.row] = member.version;
                      else delete next[member.row];
                      setSelection({ ...selection, [group.rule_id]: next });
                      setPreview(null);
                    }}
                  />
                  <strong>{member.sku}</strong> · {member.name} · v
                  {member.version} {member.deferred && " · 已暂缓，风险保留"}
                </label>
                {chosen[member.row] !== undefined &&
                  chosen[member.row] !== member.version && (
                    <p role="alert">版本已更新，请取消后重新选择此商品。</p>
                  )}
                {member.issues.map((issue, i) => (
                  <p key={i}>
                    {issue.reason}
                    <br />
                    <span className="helper">建议：{issue.suggestion}</span>
                  </p>
                ))}
              </div>
            ))}
            <p>已选 {Object.keys(chosen).length} 件</p>
            <div className="issue-actions">
              <button
                className="primary-button"
                disabled={disabled}
                onClick={() => act(group.rule_id, "review")}
              >
                统一审查所选商品
              </button>
              <button
                className="secondary-button"
                disabled={disabled}
                onClick={() => act(group.rule_id, "repair")}
              >
                预览批量修复
              </button>
              <button
                className="secondary-button"
                disabled={disabled}
                onClick={() => act(group.rule_id, "defer")}
              >
                暂不处理（保留风险）
              </button>
            </div>
            <p className="helper">
              统一审查使用当前模型，仅修改本类问题涉及的字段，再检查完整文案。演示模式只执行本地规则。
            </p>
          </details>
        );
      })}
      {preview && (
        <section className="group-preview" aria-label="批量修复预览">
          <h4>确认各商品的修复内容</h4>
          {preview.items.map((item) => (
            <div className="group-member" key={item.row}>
              <strong>{item.sku}</strong>
              {item.reason && <p>{item.reason}（本次跳过）</p>}
              {item.patches.map((patch, i) => (
                <div key={i}>
                  <code>{patch.field_path}</code>
                  <p>修改前：{patch.expected_before}</p>
                  <p>修改后：{patch.replacement}</p>
                </div>
              ))}
            </div>
          ))}
          <div className="issue-actions">
            <button
              className="primary-button"
              disabled={
                busy ||
                processing ||
                !preview.items.some((i) => i.status === "queued")
              }
              onClick={() => void send(preview.request)}
            >
              确认应用并重新检查
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              取消
            </button>
          </div>
        </section>
      )}
      {!!actions.length && (
        <details className="group-card">
          <summary>集中处理记录（{actions.length} 次）</summary>
          {[...actions].reverse().map((action) => (
            <div key={action.id} className="group-member">
              <strong>
                {action.rule_id} · {labels[action.action]}
              </strong>
              {action.items.map((item) => (
                <p key={item.row}>
                  {item.sku}：{labels[item.status] || item.status}
                  {item.result_version ? ` · v${item.result_version}` : ""}
                  {item.reason || item.error
                    ? ` · ${item.reason || item.error}`
                    : ""}
                </p>
              ))}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
