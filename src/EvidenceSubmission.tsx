import { useEffect, useState } from 'react';
import type { Issue, Listing, Product } from './types';
import EvidenceHandoff from './EvidenceHandoff';

export default function EvidenceSubmission({ record, product, issue, onSaved, onEditingChange, onSources, notify, disabled }: {
  record: Listing; product: Product; issue: Issue | null; onSaved: () => Promise<void>;
  onEditingChange: (value: boolean) => void; onSources: (ids: string[]) => void;
  notify: (message: string, error?: boolean) => void; disabled: boolean;
}) {
  const targets = [...record.review.issues.filter(item => item.category !== 'system_integrity').map(item => ({ id: item.issue_id, label: item.title, original: item.original })),
    ...record.review.missing_data.map(item => ({ id: item.field, label: item.label, original: item.reason }))];
  const [target, setTarget] = useState(targets.find(item => item.id === issue?.issue_id)?.id || targets[0]?.id || '');
  const [fields, setFields] = useState({ title: '', applicable_model: '', publisher: '', url: '', excerpt: '' });
  const [saving, setSaving] = useState(false);
  const [handoffPending, setHandoffPending] = useState(false);
  const editing = Object.values(fields).some(value => value.trim()) || saving || handoffPending;
  useEffect(() => { onEditingChange(editing); return () => onEditingChange(false); }, [editing, onEditingChange]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true);
    try {
      const response = await fetch(`/api/products/${product.product_id}/evidence`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...fields, target, base_revision: product.revision, listing_id: record.listing_id, listing_version: record.version }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || '提交材料失败');
      await onSaved();
      setFields({ title: '', applicable_model: '', publisher: '', url: '', excerpt: '' });
      notify('材料已随商品新版本保存，尚未核验。请采用当前资料复检。');
    } catch (error) { notify((error as Error).message, true); }
    finally { setSaving(false); }
  }
  return <section className="evidence-submission" aria-label="按问题补充原文材料">
    <h3>按问题补充原文材料</h3>
    <p>记录来源及适用型号，便于复检和交接。提交原文不会自动确认参数、认证或性能。</p>
    <EvidenceHandoff record={record} product={product} disabled={disabled || saving || Object.values(fields).some(value => value.trim())} onSaved={onSaved} onPending={setHandoffPending} notify={notify} />
    {targets.length > 0 && <form onSubmit={save}>
      <fieldset disabled={disabled || saving || handoffPending}>
        <label>对应问题 / 待补资料<select value={target} onChange={event => setTarget(event.target.value)}>{targets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <blockquote>{targets.find(item => item.id === target)?.original}</blockquote>
        <div className="product-edit-grid">{[
          ['title', '材料名称'], ['applicable_model', '适用商品型号 / SKU'], ['publisher', '来源 / 出具方'], ['url', '来源链接（没有可留空）'],
        ].map(([key, label]) => <label key={key}>{label}<input required={key !== 'url'} maxLength={key === 'url' ? 2000 : 200} type={key === 'url' ? 'url' : 'text'} value={fields[key as keyof typeof fields]} onChange={event => setFields({ ...fields, [key]: event.target.value })} /></label>)}</div>
        <label>来源原文（至少 10 字符）<textarea required minLength={10} maxLength={20000} rows={5} value={fields.excerpt} onChange={event => setFields({ ...fields, excerpt: event.target.value })} /></label>
        <p className="helper">保留原文、单位和适用条件；未知的变体颜色或每包零售件数请勿推测。需要更新确认后的参数时，在下方编辑资料。</p>
        <div className="modal-actions"><button type="button" className="secondary-button" disabled={!editing} onClick={() => setFields({ title: '', applicable_model: '', publisher: '', url: '', excerpt: '' })}>清空未提交材料</button><button className="primary-button" type="submit">{saving ? '保存中…' : '保存材料到商品新版本'}</button></div>
      </fieldset>
    </form>}
    {!!product.evidence_submissions?.length && <div aria-label="已提交材料">{[...product.evidence_submissions].reverse().map(item => <article className="source-card" key={item.source_id} data-source-id={item.source_id}>
      <strong>{item.title}</strong> <span className="tiny-badge warm">已提交 · 待核验</span>
      <p>对应：{item.target_label} · {item.applicable_model} · 审核 V{item.listing_version}</p>
      <p>{item.publisher} · {new Date(item.submitted_at).toLocaleString()}</p>
      {item.handoff_id && <p>交接单：{item.handoff_id} · 负责人：{item.owner || '未填'} · 截止日期：{item.due_on || '未填'}</p>}
      <button className="text-button" onClick={() => onSources([item.source_id])}>查看保存的原文与来源</button>
    </article>)}</div>}
  </section>;
}
