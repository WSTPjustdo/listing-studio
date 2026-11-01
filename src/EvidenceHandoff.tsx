import { useEffect, useState } from 'react';
import type { Listing, Product } from './types';
type Row = { row_id: string; row_number: number; target_label: string; original: string; request: string; reply: { owner: string; due_on: string; title: string; applicable_model: string; publisher: string; url: string; excerpt: string }; error: string | null };
type Preview = { id: string; rows: Row[] };
export default function EvidenceHandoff({ record, product, disabled, onSaved, onPending, notify }: { record: Listing; product: Product; disabled: boolean; onSaved: () => Promise<void>; onPending: (value: boolean) => void; notify: (message: string, error?: boolean) => void }) {
  const [preview, setPreview] = useState<Preview | null>(null), [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false);
  useEffect(() => { onPending(!!preview || busy); return () => onPending(false); }, [preview, busy, onPending]);
  async function post(path: string, body: unknown) {
    const response = await fetch(`/api/evidence-handoffs/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error((await response.json()).error?.message || '交接未完成');
    return response;
  }
  async function download() {
    setBusy(true);
    try { const response = await post('export', { listing_id: record.listing_id, listing_version: record.version, product_revision: product.revision }); const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href = url; a.download = 'evidence-handoff.xlsx'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notify('已导出补资料交接表，请采购或供应商填写黄色列。'); }
    catch (error) { notify((error as Error).message, true); } finally { setBusy(false); }
  }
  async function upload(file?: File) {
    if (!file) return; setBusy(true);
    try {
      if (!/\.xlsx$/i.test(file.name) || file.size > 5 * 1024 * 1024) throw new Error('请选择 5 MB 内的 XLSX 回传表。');
      const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsDataURL(file); });
      const result: Preview = await (await post('preview', { filename: file.name, base64, product_id: product.product_id, listing_id: record.listing_id })).json(); setPreview(result); setSelected(result.rows.filter(row => !row.error).map(row => row.row_id));
    } catch (error) { notify((error as Error).message, true); } finally { setBusy(false); }
  }
  async function confirm() {
    setBusy(true);
    try { await (await post('confirm', { preview_id: preview?.id, row_ids: selected })).json(); setPreview(null); setSelected([]); await onSaved(); notify('所选材料已保存为待核验，商品参数未改动。请采用当前资料复检。'); }
    catch (error) { notify((error as Error).message, true); } finally { setBusy(false); }
  }
  return <section className="evidence-handoff" aria-label="采购补资料交接">
    <h3>交给采购 / 供应商补资料</h3><p>导出问题与版本，填写原文后回传；运营确认材料，再使用真实模型复检。</p>
    <div className="journey-buttons"><button className="secondary-button" disabled={disabled || busy || !!preview || !record.review.issues.length && !record.review.missing_data.length} onClick={download}>导出补资料交接 Excel</button>
      <label className="handoff-upload">上传已填写回传表<input aria-label="上传补资料回传表" type="file" accept=".xlsx" disabled={disabled || busy || !!preview} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} /></label></div>
    {preview && <section aria-label="回传材料预览"><p>逐项核对原问题、适用型号和来源。确认仅保存材料，均保持待核验。</p>{preview.rows.map(row => <article className="source-card" key={row.row_id}>
      <label><input type="checkbox" checked={selected.includes(row.row_id)} disabled={!!row.error || busy || disabled} onChange={event => setSelected(event.target.checked ? [...selected, row.row_id] : selected.filter(id => id !== row.row_id))} /> 第 {row.row_number} 行 · {row.target_label}</label>
      <blockquote>{row.original}</blockquote><p>{row.request}</p><strong>{row.reply.title}</strong><p>适用型号：{row.reply.applicable_model} · 出具方：{row.reply.publisher}</p><p>负责人：{row.reply.owner || '未填'} · 截止日期：{row.reply.due_on || '未填'}</p><p>来源链接：{row.reply.url || '未提供'}</p><pre>{row.reply.excerpt}</pre>{row.error && <p role="alert">{row.error}</p>}
    </article>)}<div className="journey-buttons"><button className="primary-button" disabled={disabled || busy || !selected.length} onClick={confirm}>{busy ? '保存中…' : `确认接收 ${selected.length} 份材料（待核验）`}</button><button className="secondary-button" disabled={busy} onClick={() => { setPreview(null); setSelected([]); }}>取消回传预览</button></div></section>}
  </section>;
}
