import { useEffect, useState } from 'react';
import { api, post } from './api';
import type { Listing, Product, Run } from './types';
import './research.css';

type Config = { amazon_provider?: string; postal_code?: string; vision_base_url: string; vision_model: string; has_vision_key: boolean; has_rainforest_key: boolean };
type Analysis = { id: string; name: string; category: string; search_query: string; observations: string[]; facts: { label: string; value: string; source: string; evidence: string }[]; missing: string[]; own_link: { url: string } | null; suggested_fields?: Record<string, string | number | null> };
type Candidate = { delivery?: { verified: boolean; visible_delivery_location: string }; missing_fields?: string[]; detail_status?: string; asin: string; url: string; title: string; brand: string; bullets: string[]; specifications: { name: string; value: string }[]; price: number | null; currency: string; rating: number | null; comparison: { status: string; matched: string[]; missing: string[]; notes: string[] } };
type Research = { id: string; query: string; checked_at: string; items: Candidate[]; terms: { term: string; count: number; asins: string[] }[] };
export default function ResearchWorkspace({ products, onRefresh, onOpen }: { products: Product[]; onRefresh: () => Promise<unknown>; onOpen: (record: Listing) => void }) {
  const [config, setConfig] = useState<Config>({ amazon_provider: 'local', postal_code: '10001', vision_base_url: '', vision_model: '', has_vision_key: false, has_rainforest_key: false });
  const [visionKey, setVisionKey] = useState(''), [amazonKey, setAmazonKey] = useState('');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [image, setImage] = useState(''), [text, setText] = useState(''), [reference, setReference] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [name, setName] = useState(''), [material, setMaterial] = useState(''), [facts, setFacts] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [specFields, setSpecFields] = useState<Record<string, string>>({});
  const [productId, setProductId] = useState('');
  const [query, setQuery] = useState(''), [price, setPrice] = useState(''), [specs, setSpecs] = useState(''), [positioning, setPositioning] = useState(''), [tolerance, setTolerance] = useState('0.3');
  const [research, setResearch] = useState<Research | null>(null), [selected, setSelected] = useState<string[]>([]), [terms, setTerms] = useState<string[]>([]);
  const [style, setStyle] = useState('自然简洁，突出实际用途和已确认规格，避免堆砌关键词。');
  const [run, setRun] = useState<Run | null>(null);
  const [history, setHistory] = useState<Research[]>([]);
  useEffect(() => { void api<Config>('/api/research/config').then(setConfig).catch(e => setError(e.message)); }, []);
  useEffect(() => { void api<Research[]>('/api/research/history').then(setHistory).catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (!run || ['succeeded', 'failed'].includes(run.status)) return;
    const timer = window.setTimeout(() => { void api<Run>(`/api/runs/${run.run_id}`).then(setRun).catch(e => setError(e.message)); }, 1500);
    return () => window.clearTimeout(timer);
  }, [run]);
  async function action(label: string, work: () => Promise<void>) {
    setBusy(label); setError(''); setMessage('');
    try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  const product = products.find(x => x.product_id === productId);
  const availableTerms = research?.terms.filter(x => x.asins.some(asin => selected.includes(asin))) || [];
  function toggleCandidate(asin: string) { setSelected(old => old.includes(asin) ? old.filter(x => x !== asin) : [...old, asin]); setTerms([]); }
  async function upload(file?: File) {
    if (!file) return;
    setError(''); setImage(''); setAnalysis(null); setConfirmed(false);
    if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 3000000) { setError('请选择不超过 3 MB 的 PNG、JPEG 或 WebP 图片。'); return; }
    const reader = new FileReader();
    reader.onload = () => setImage(String(reader.result)); reader.onerror = () => setError('无法读取图片，请重新选择。'); reader.readAsDataURL(file);
  }
  return <div className="research-workspace">
    <div className="page-heading"><div><div className="eyebrow">PRODUCT RESEARCH</div><h1>图片与竞品研究</h1><p>文字参数提取使用工作台已配置的真实 DeepSeek；图片需要单独配置视觉模型。竞品研究可跳过。</p></div></div>
    {error && <div role="alert" className="research-error">{error}</div>}
    {message && <p role="status">{message}</p>}
    {busy && <p role="status">{busy}，请稍候…</p>}
    <details className="panel research-panel"><summary>接口连接 · {config.amazon_provider === 'local' ? '本地爬虫' : config.has_rainforest_key ? '商品数据已配置' : '商品数据待配置'} · {config.vision_model ? '识别模型已填写' : '识别模型待配置'}</summary>
      <p>Amazon US 数据可通过本地爬虫获取，无需商品 API 密钥；也可选择已开通的 Rainforest。配送邮编会用于本地检索和商品详情，并核验页面实际地区。图片与文字交给支持图片输入的兼容模型；英文生成沿用工作台的“模型设置”。配置状态不代表连接测试通过。</p>
      <fieldset disabled={Boolean(busy)} className="research-grid">
        <label>商品数据来源<select value={config.amazon_provider || 'local'} onChange={e => setConfig({ ...config, amazon_provider: e.target.value })}><option value="local">本地爬虫（无需商品 API 密钥）</option><option value="rainforest">Rainforest（自备账号）</option></select></label>
        <label>美国配送邮编（本地爬虫）<input inputMode="numeric" maxLength={5} value={config.postal_code || '10001'} onChange={e => setConfig({ ...config, postal_code: e.target.value })}/></label>
        <label>Rainforest API Key<input type="password" autoComplete="new-password" value={amazonKey} onChange={e => setAmazonKey(e.target.value)} placeholder={config.has_rainforest_key ? '已保存，留空保留' : '填写商品数据服务密钥'}/></label>
        <label>识别模型 API 地址<input value={config.vision_base_url} placeholder="https://你的服务地址/v1" onChange={e => setConfig({ ...config, vision_base_url: e.target.value })}/></label>
        <label>识别模型名称<input value={config.vision_model} onChange={e => setConfig({ ...config, vision_model: e.target.value })}/></label>
        <label>识别模型 API Key<input type="password" autoComplete="new-password" value={visionKey} placeholder={config.has_vision_key ? '已保存，留空保留' : '填写识别模型密钥'} onChange={e => setVisionKey(e.target.value)}/></label>
      </fieldset>
      <button className="primary-button" disabled={Boolean(busy)} onClick={() => void action('保存接口配置', async () => { setConfig(await post<Config>('/api/research/config', { amazon_provider: config.amazon_provider || 'local', postal_code: config.postal_code || '10001', vision_base_url: config.vision_base_url, vision_model: config.vision_model, vision_key: visionKey, rainforest_key: amazonKey })); setVisionKey(''); setAmazonKey(''); setMessage('配置已保存在本机。'); })}>保存接口配置</button>
      <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void action('清除密钥', async () => { setConfig(await post<Config>('/api/research/config', { amazon_provider: config.amazon_provider || 'local', postal_code: config.postal_code || '10001', vision_base_url: config.vision_base_url, vision_model: config.vision_model, clear_secrets: true })); setVisionKey(''); setAmazonKey(''); })}>清除两项密钥</button>
    </details>
    <section className="panel research-panel"><h2>1 · 整合自己的商品资料</h2>
      <p>图片帮助识别外观；具体规格来自商品文字与自己的商品链接。已有商品档案可直接在下一步选择。</p>
      <fieldset disabled={Boolean(busy)} className="research-grid">
        <label>商品图片（可选，最大 3 MB）<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => void upload(e.target.files?.[0])}/>{image && <img className="research-preview" src={image} alt="待识别的商品"/>}</label>
        <label>自己的 Amazon US 商品链接或 ASIN（可选）<input value={reference} onChange={e => { setReference(e.target.value); setConfirmed(false); }} placeholder="https://www.amazon.com/dp/…"/></label>
        <label className="research-wide">商品文字说明与参数<textarea rows={5} value={text} onChange={e => { setText(e.target.value); setConfirmed(false); }} placeholder="粘贴商家资料：材质、尺寸、克重、颜色、套装数量、适用场景等。保留原始单位。"/></label>
        <label className="research-wide">或上传 UTF-8 商品说明文本<input type="file" accept=".txt,text/plain" onChange={e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 45000) { setError('文字说明文件不能超过 45 KB。'); return; } void file.text().then(value => { if (value.length > 15000) { setError('文字说明不能超过 15000 字符。'); return; } setText(value); setConfirmed(false); }).catch(() => setError('文本读取失败。')); }}/></label>
      </fieldset>
      <button className="primary-button" disabled={Boolean(busy) || !(image || text.trim() || reference.trim())} onClick={() => void action('识别并提取商品资料', async () => {
        const result = await post<Analysis>('/api/research/analyze', { ...(image ? { image } : {}), text, reference });
        setAnalysis(result); setName(result.name); setQuery(result.search_query); setFacts(result.facts.map(f => `${f.label}: ${f.value}`).join('\n')); setConfirmed(false); setProductId('');
        setMaterial(result.facts.find(f => /材质|材料|material|fabric/i.test(f.label))?.value || '');
        setSpecFields(Object.fromEntries(Object.entries(result.suggested_fields || {}).map(([key, value]) => [key, value == null ? '' : String(value)])));
      })}>{image ? '识别图片与提取参数' : '用 DeepSeek 提取文字参数'}</button>
      {analysis && <div className="research-analysis"><p><strong>识别类别：</strong>{analysis.category}</p><p>外观观察：{analysis.observations.join('；') || '无'}</p>
        {analysis.own_link && <a href={analysis.own_link.url} target="_blank" rel="noreferrer">自己的商品来源页</a>}
        <details><summary>查看参数原文依据（{analysis.facts.length} 项）</summary>{analysis.facts.map((f,i) => <p key={i}><strong>{f.label}：{f.value}</strong><br/>{f.source === 'merchant_text' ? '商家说明' : '自己的商品链接'} · {f.evidence}</p>)}</details>
        {analysis.missing.length > 0 && <p>待补充或核对：{analysis.missing.join('；')}</p>}
      </div>}
      <details open={Boolean(analysis)}><summary>保存为自己的商品档案</summary>
        <p>请对照上方原文核对以下规格，确认后用于后续参数审核。未知留空，不用供应商装箱数替代零售件数。</p>
        <fieldset disabled={Boolean(busy)} className="research-grid"><label>商品名称<input value={name} onChange={e => { setName(e.target.value); setConfirmed(false); }}/></label><label>文字资料中的材质<input value={material} onChange={e => { setMaterial(e.target.value); setConfirmed(false); }}/></label><label className="research-wide">提取的参数（可直接修改，保留单位）<textarea rows={5} value={facts} onChange={e => { setFacts(e.target.value); setConfirmed(false); }}/></label></fieldset>
        <fieldset disabled={Boolean(busy)} className="research-grid">{[{ key: 'width', label: '宽度 (cm)' }, { key: 'height', label: '高度 (cm)' }, { key: 'depth', label: '深度 (cm，可选)' }, { key: 'fabric_weight_gsm', label: '面料克重 (g/m²)' }, { key: 'capacity_l', label: '容量 (L)' }, { key: 'handle_length_cm', label: '提手长度 (cm)' }, { key: 'retail_pack_count', label: '零售件数 / 包（未知留空）' }, { key: 'brand', label: '品牌（未知留空）' }, { key: 'color', label: '颜色（未知留空）' }].map(field => <label key={field.key}>{field.label}<input type={['brand', 'color'].includes(field.key) ? 'text' : 'number'} value={specFields[field.key] || ''} onChange={e => { setSpecFields({ ...specFields, [field.key]: e.target.value }); setConfirmed(false); }}/></label>)}</fieldset>
        <label className="research-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>已核对这是棉布手提袋，采用以上资料生成内容；不把公开参考商品当作库存确认</label>
        <button className="secondary-button" disabled={Boolean(busy) || !confirmed || !name.trim() || !material.trim()} onClick={() => void action('保存商品', async () => { const confirmed_fields = Object.fromEntries(['width', 'height', 'depth', 'fabric_weight_gsm', 'capacity_l', 'handle_length_cm', 'retail_pack_count', 'brand', 'color'].map(key => [key, ['brand', 'color'].includes(key) ? specFields[key] || '' : specFields[key]?.trim() ? Number(specFields[key]) : null])); const p = await post<Product>('/api/research/product', { name, material, facts, confirmed_fields, category_confirmed: confirmed, ...(analysis ? { analysis_id: analysis.id } : {}) }); await onRefresh(); setProductId(p.product_id); setConfirmed(false); setMessage('商品已保存并选中，可以检索竞品或生成英文文案。'); })}>保存并选用此商品</button>
      </details>
    </section>
    <section className="panel research-panel"><h2>2 · 竞品研究（可选）</h2><p>已有商品资料即可生成文案，无需先搜索或选择竞品。</p><button className="text-button" disabled={Boolean(busy) || !product} onClick={() => { setResearch(null); setSelected([]); setTerms([]); document.getElementById('research-generate')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>跳过竞品研究，直接生成文案</button>
      <fieldset disabled={Boolean(busy)} className="research-grid">
        <label>自己的商品<select value={productId} onChange={e => { setProductId(e.target.value); setResearch(null); setSelected([]); setTerms([]); }}><option value="">请选择已保存的商品</option>{products.map(p => <option key={p.product_id} value={p.product_id}>{p.name_zh}</option>)}</select></label>
        <label>英文搜索词<input value={query} onChange={e => setQuery(e.target.value)} placeholder="cotton tote bag"/></label>
        <label>自己的销售总价（USD，可选）<input type="number" min="0.01" step="0.01" value={price} onChange={e => setPrice(e.target.value)}/></label>
        <label>可比价格区间<select value={tolerance} onChange={e => setTolerance(e.target.value)}><option value="0.2">上下 20%</option><option value="0.3">上下 30%</option><option value="0.5">上下 50%</option></select></label>
        <label>必须比较的英文规格词（逗号分隔）<input value={specs} placeholder="cotton, zipper, 15 x 16" onChange={e => setSpecs(e.target.value)}/></label>
        <label>品牌与目标客群定位<input value={positioning} placeholder="例如：无品牌实用款，面向日常购物，不对标设计师品牌" onChange={e => setPositioning(e.target.value)}/></label>
      </fieldset>
      <p>每次最多展示 5 个候选，并读取前 3 个详情（本地爬虫会额外抓取页面，付费服务可能消耗额度）。价格与规格文字用于初筛；品牌价值、客群、套装单价与品质仍需结合原页判断。</p>
      <button className="primary-button" disabled={Boolean(busy) || query.trim().length < 2} onClick={() => void action('检索 Amazon 候选商品', async () => { setResearch(null); setSelected([]); setTerms([]); const result = await post<Research>('/api/research/search', { query, comparison: { target_price: price ? Number(price) : null, tolerance: Number(tolerance), required_terms: specs.split(/[,，]/).map(x => x.trim()).filter(Boolean), positioning } }); setResearch(result); setHistory(old => [result, ...old].slice(0,20)); })}>搜索候选商品</button>
      {history.length > 0 && <label>恢复已保存的检索（最近 20 次）<select disabled={Boolean(busy)} value={research?.id || ''} onChange={e => { setResearch(history.find(x => x.id === e.target.value) || null); setSelected([]); setTerms([]); }}><option value="">选择检索记录</option>{history.map(h => <option key={h.id} value={h.id}>{h.query} · {new Date(h.checked_at).toLocaleString()}</option>)}</select></label>}
      {research && <><p>搜索：{research.query} · 获取于 {new Date(research.checked_at).toLocaleString()} · 仅代表当时页面数据</p>
        {!research.items.length && <p>未找到候选商品。请调整搜索词。</p>}
        <div className="research-candidates">{research.items.map(item => <article key={item.asin} className="research-candidate">
          <span className="tiny-badge">{item.comparison.status === 'outside_price' ? '超出价格范围' : item.comparison.status === 'potential' ? '价格与文字初筛匹配 · 待核实' : '信息不足 · 待核实'}</span>
          <h3><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a></h3><p>{item.asin} · 品牌：{item.brand || '未披露'} · {item.price === null ? '价格未披露' : `${item.currency} ${item.price}`} · 评分：{item.rating ?? '未披露'}</p>
          <p>规格文字匹配：{item.comparison.matched.join('、') || '无'}；待核对：{item.comparison.missing.join('、') || '查看实际规格与变体'}</p>
          {item.delivery && <p>实际配送地区：{item.delivery.visible_delivery_location || '未返回'} · {item.delivery.verified ? '邮编已验证' : '邮编未验证，价格不可直接比较'}</p>}
          {Boolean(item.missing_fields?.length) && <p>缺失字段：{item.missing_fields!.join('、')}</p>}
          <p>{item.comparison.notes.join('；')}</p>
          <details><summary>商品词条与参数</summary>{item.bullets.map((b,i) => <p key={i}>{b}</p>)}{!item.bullets.length && <p>此候选未返回五点描述，词条仅来自标题。</p>}{item.specifications.map((s,i) => <p key={i}>{s.name}：{s.value}</p>)}</details>
          <label className="research-check"><input type="checkbox" disabled={Boolean(busy)} checked={selected.includes(item.asin)} onChange={() => toggleCandidate(item.asin)}/>已核对价格、规格与品牌定位，纳入竞品池</label>
        </article>)}</div>
        <h3>竞品池词条 · {selected.length} 个商品</h3><p>出现次数是所选商品中的覆盖数，不代表搜索量或转化率。品牌词、规格词及宣称需自行取舍。</p>
        <div className="research-terms">{availableTerms.map(t => <label key={t.term} title={`来源 ASIN：${t.asins.filter(x => selected.includes(x)).join(', ')}`}><input type="checkbox" checked={terms.includes(t.term)} disabled={Boolean(busy)} onChange={() => setTerms(old => old.includes(t.term) ? old.filter(x => x !== t.term) : [...old, t.term])}/>{t.term} <small>{t.asins.filter(x => selected.includes(x)).length}</small></label>)}</div>
        <button className="secondary-button" onClick={() => { const blob = new Blob([JSON.stringify({ ...research, selected_asins: selected, selected_terms: terms }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'competitor-research.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>导出竞品研究与词条</button>
      </>}
    </section>
    <section className="panel research-panel" id="research-generate"><h2>3 · 按商品参数优化英文文案</h2><p>生成新的英文草稿，保留现有文案。生成后可以逐项手动编辑，并沿用版本保存与审核流程。</p>
      <label>英文词条风格<select disabled={Boolean(busy)} onChange={e => setStyle(e.target.value)} defaultValue="自然简洁，突出实际用途和已确认规格，避免堆砌关键词。"><option>自然简洁，突出实际用途和已确认规格，避免堆砌关键词。</option><option>专业参数型，优先清晰描述材质、尺寸、数量与用途。</option><option>温暖生活方式风格，描绘使用场景，避免夸大性能。</option></select></label>
      <label>自定义风格（可修改）<textarea disabled={Boolean(busy)} rows={3} maxLength={2000} value={style} onChange={e => setStyle(e.target.value)}/></label>
      <button className="primary-button" disabled={Boolean(busy) || !product || !style.trim() || Boolean(research && !selected.length) || Boolean(run && !['succeeded','failed'].includes(run.status))} onClick={() => void action('提交英文优化任务', async () => { setRun(await post<Run>('/api/research/generate', { product_id: product!.product_id, product_revision: product!.revision, ...(research ? { research_id: research.id } : {}), selected_asins: selected, terms, style })); })}>生成优化后的英文草稿</button>
      {run && <p role="status">任务：{run.status === 'failed' ? run.error?.message : run.status === 'succeeded' ? '英文草稿已保存' : run.stage}</p>}
      {run?.status === 'succeeded' && <button className="secondary-button" onClick={() => void action('打开英文草稿', async () => { const versions = await api<Listing[]>(`/api/listings/${run.listing_id}/versions`); const record = versions.find(x => x.version === run.version); if (record) { await onRefresh(); onOpen(record); } })}>打开草稿并手动编辑</button>}
    </section>
  </div>;
}
