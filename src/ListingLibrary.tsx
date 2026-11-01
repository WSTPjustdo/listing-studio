import { useEffect, useState } from 'react';
import { api, post } from './api';
import type { Listing, Product } from './types';
type Entry = { product_id: string; marketplace: string; revision: number; sku: string; state: 'draft' | 'ready' | 'published'; asin: string; published_on: string; notes: string; updated_at: string | null; status_source: string };
type Row = { key: string; marketplace: string; product: Product; entry: Entry; record: Listing | null; newer_available: boolean; review_stale: boolean; candidates: { listing_id: string; version: number; title: string; created_at: string; marketplace: string; language: string }[] };
const labels = { draft: '草稿', ready: '待上架', published: '已上架（商家登记）' };
const marketLabels: Record<string, string> = { US: 'Amazon 美国站', DE: 'Amazon 德国站', UK: 'Amazon 英国站', FR: 'Amazon 法国站' };
const marketDomains: Record<string, string> = { US: 'www.amazon.com', DE: 'www.amazon.de', UK: 'www.amazon.co.uk', FR: 'www.amazon.fr' };
export default function ListingLibrary({ onOpen, notify, embedded = false }: { onOpen: (record: Listing) => void; notify: (message: string, error?: boolean) => void; embedded?: boolean }) {
  const [rows, setRows] = useState<Row[]>([]), [loading, setLoading] = useState(true), [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<string[]>([]), [editing, setEditing] = useState<Row | null>(null), [draft, setDraft] = useState<Entry | null>(null);
  const [chosen, setChosen] = useState(''), [versions, setVersions] = useState<Listing[]>([]), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false);
  async function refresh() { setLoading(true); try { setRows(await api<Row[]>('/api/library')); } catch (error) { notify((error as Error).message, true); } finally { setLoading(false); } }
  useEffect(() => { void refresh(); }, []);
  const visible = rows.filter(row => `${row.product.name_zh} ${marketLabels[row.marketplace] || row.marketplace} ${row.entry.sku} ${row.entry.asin} ${row.record?.content.title || ''}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || row.entry.state === filter));
  async function edit(row: Row) {
    if (!row.record) return;
    setEditing(row); setDraft({ ...row.entry }); setChosen(`${row.record.listing_id}@${row.record.version}`); setConfirmed(false); setVersions([]);
    try {
      const records = await Promise.all(row.candidates.map(candidate => api<Listing[]>(`/api/listings/${candidate.listing_id}/versions`)));
      setVersions(records.flat().filter(item => item.trace.actual_model_call && !item.is_demo).sort((a,b) => b.created_at.localeCompare(a.created_at)));
    } catch (error) { notify((error as Error).message, true); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!editing || !draft || !chosen) return;
    const [listing_id, version] = chosen.split('@'); setBusy(true);
    try {
      await post(`/api/library/${editing.product.product_id}`, { ...draft, marketplace: editing.marketplace, base_revision: editing.entry.revision, listing_id, listing_version: Number(version), published_confirmation: confirmed });
      await refresh(); setEditing(null); setDraft(null); notify('台账已保存，所选文案版本已固定。上架状态为商家登记。');
    } catch (error) { notify((error as Error).message, true); } finally { setBusy(false); }
  }
  async function download() {
    setBusy(true);
    try {
      const selection = rows.filter(row => selected.includes(row.key) && row.record).map(row => ({ product_id: row.product.product_id, marketplace: row.marketplace }));
      const response = await fetch('/api/library/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product_ids: selection }) });
      if (!response.ok) throw new Error((await response.json()).error?.message || '导出失败');
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a'); link.href = url; link.download = 'listing-library.xlsx'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(`已导出 ${selection.length} 个商品站点的原语言文案及审核记录。`);
    } catch (error) { notify((error as Error).message, true); } finally { setBusy(false); }
  }
  return <div className={`listing-library${embedded ? " listing-library-embedded" : ""}`}>
    {embedded
      ? <div className="library-embedded-head"><div><h2 className="results-section-title">批量台账</h2><p>按商品登记上架信息，导出选定版本的 Excel。和上面那份列表是两批东西：上面按任务留版本，这里按商品管上架。</p></div><button className="primary-button" disabled={!selected.length || busy} onClick={download}>导出所选 Excel（{selected.length}）</button></div>
      : <div className="page-heading"><div><div className="eyebrow">LISTING LIBRARY</div><h1>商品 Listing 台账</h1><p>按商品管理文案，登记上架信息，导出选定版本。</p></div><button className="primary-button" disabled={!selected.length || busy} onClick={download}>导出所选 Excel（{selected.length}）</button></div>}
    <p className="evidence-note">“已上架”为商家手动登记，尚未连接 Seller Central 核验。Excel 保留所选版本的原语言内容；“英文文案”为旧版工作表名，不会自动翻译。</p>
    <div className="library-toolbar"><label>搜索商品 / SKU / ASIN<input value={query} onChange={event => setQuery(event.target.value)} /></label><label>管理状态<select aria-label="筛选管理状态" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部</option>{Object.entries(labels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button className="secondary-button" disabled={busy} onClick={() => setSelected([...new Set([...selected, ...visible.filter(row => row.record).map(row => row.key)])])}>选择当前结果</button><button className="text-button" onClick={() => setSelected([])}>清空选择</button><span>已选 {selected.length} 个商品站点</span></div>
    {loading && <p role="status">正在读取台账…</p>}
    {!loading && !visible.length && <p>暂无符合条件的商品。先导入商品资料并生成文案，即可在这里管理。</p>}
    <div className="library-list">{visible.map(row => <article className="panel library-card" key={row.key}>
      <div className="library-card-head"><label><input type="checkbox" aria-label={`选择 ${row.product.name_zh} ${marketLabels[row.marketplace] || row.marketplace}`} checked={selected.includes(row.key)} disabled={!row.record || busy} onChange={event => setSelected(items => event.target.checked ? [...items, row.key] : items.filter(id => id !== row.key))} />{row.product.name_zh} · {marketLabels[row.marketplace] || row.marketplace}</label><span className="tiny-badge">{labels[row.entry.state]}</span></div>
      <p>SKU：{row.entry.sku || '未填写'} · ASIN：{row.entry.asin || '未登记'}</p>
      {row.record ? <><h3>{row.record.content.title}</h3><p>文案 V{row.record.version} · 审核资料 V{row.record.product_snapshot?.revision} · {row.entry.revision ? `台账 V${row.entry.revision} 已固定此版本` : '未保存台账，当前显示最新草稿'}</p>
        <p>{row.record.review.issues.length} 项发现 · {row.record.review.missing_data.length} 项资料待补{row.newer_available ? ' · 有更新文案可选，当前登记版本未替换' : ''}</p>
        {row.review_stale && <p className="warm-text">此版采用的资料或规则已有更新，审核需复检；台账仍保留所选原文。</p>}
        {row.entry.state === 'published' && <p>商家登记日期：{row.entry.published_on} · {marketDomains[row.marketplace] && row.entry.asin && <a href={`https://${marketDomains[row.marketplace]}/dp/${row.entry.asin}`} target="_blank" rel="noreferrer">查看登记的 Amazon 链接</a>}</p>}
        <div className="journey-buttons"><button className="secondary-button" disabled={busy || !!editing} onClick={() => edit(row)}>管理文案与上架信息</button><button className="text-button" disabled={!!editing} onClick={() => onOpen(row.record!)}>查看此版文案与审核</button></div></> : <p>尚无文案，请先创建或诊断。</p>}
      {editing?.key === row.key && draft && <form className="library-editor" onSubmit={save}>
        <h3>登记 {marketLabels[row.marketplace] || row.marketplace} 商品</h3><div className="product-edit-grid">
          <label>SKU / 货号<input maxLength={100} value={draft.sku} onChange={event => setDraft({ ...draft, sku: event.target.value })} /></label>
          <label>管理状态<select aria-label="管理状态" value={draft.state} onChange={event => { setDraft({ ...draft, state: event.target.value as Entry['state'] }); setConfirmed(false); }}>{Object.entries(labels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>ASIN（10 位）<input maxLength={10} required={draft.state === 'published'} pattern="[A-Za-z0-9]{10}" value={draft.asin} onChange={event => setDraft({ ...draft, asin: event.target.value.toUpperCase() })} /></label>
          <label>实际上架日期<input type="date" required={draft.state === 'published'} value={draft.published_on} onChange={event => setDraft({ ...draft, published_on: event.target.value })} /></label>
        </div>
        <label>管理文案版本<select aria-label="管理文案版本" value={chosen} onChange={event => setChosen(event.target.value)}>{!versions.length && row.record && <option value={chosen}>正在读取版本…</option>}{versions.map(item => <option key={`${item.listing_id}@${item.version}`} value={`${item.listing_id}@${item.version}`}>V{item.version} · {item.content.title} · {new Date(item.created_at).toLocaleString()}</option>)}</select></label>
        <p>保存后固定这个版本；后续生成或复检不会自动替换。登记状态不代表检查通过。</p>
        <label>管理备注<textarea aria-label="管理备注" rows={3} maxLength={2000} value={draft.notes} onChange={event => setDraft({ ...draft, notes: event.target.value })} /></label>
        {draft.state === 'published' && <label className="library-confirm"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我确认商品已实际上架，以上为我手动登记的信息，工作台尚未向 Amazon 核验。</label>}
        <div className="journey-buttons"><button className="primary-button" disabled={busy || !versions.length} type="submit">保存台账</button><button className="secondary-button" disabled={busy} type="button" onClick={() => { setEditing(null); setDraft(null); }}>取消登记</button></div>
      </form>}
    </article>)}</div>
  </div>;
}
