import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CircleAlert, Globe2, LoaderCircle, Sparkles } from "lucide-react";
import { api, post } from "./api";
import ProductCompleteness from './ProductCompleteness';
import type { Listing, Product, Run } from "./types";

type Result = { imported: { product: Product; run?: Run }[]; failures: { asin: string; message: string }[]; mode: string };
export function AmazonSource({ product }: { product: Product }) {
  const source = product.amazon;
  if (!source) return null;
  return <div className="amazon-source"><div><span className="tiny-badge">{source.import_mode === "live" ? "实时页面读取" : "已保存来源快照"}</span><a href={source.url} target="_blank" rel="noreferrer">ASIN {source.asin} <ArrowUpRight size={13} /></a></div><p>{source.freshness}</p><p>销售状态：{source.availability_text}。页面信息为卖家披露，待商家核实。</p></div>;
}

export default function AmazonImport({ onRefresh, onProduct, onOpen }: { onRefresh: () => Promise<unknown>; onProduct: (id: string) => void; onOpen: (record: Listing) => void }) {
  const [reference, setReference] = useState("");
  const mode = "live";
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function start(sample: boolean) {
    if (loading) return;
    setLoading(true); setError(""); setResult(null); setRuns({});
    try {
      const response = await post<Result>("/api/amazon/import", { ...(sample ? { sample: true, count: 3 } : { reference }), mode, generate: sample });
      if (!alive.current) return;
      setResult(response); await onRefresh();
      let pending = response.imported.flatMap((item) => item.run ? [item.run] : []);
      const started = Date.now();
      while (pending.length && alive.current && Date.now() - started < 360000) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const updates = await Promise.all(pending.map((run) => api<Run>(`/api/runs/${run.run_id}`)));
        if (!alive.current) return;
        setRuns((previous) => ({ ...previous, ...Object.fromEntries(updates.map((run) => [run.run_id, run])) }));
        pending = updates.filter((run) => !["failed", "succeeded"].includes(run.status));
      }
      if (pending.length) setError("生成仍在后台运行，可在运行记录中继续查看。");
      await onRefresh();
    } catch (err) { if (alive.current) setError((err as Error).message); }
    finally { if (alive.current) setLoading(false); }
  }
  async function open(run: Run) {
    try { const records = await api<Listing[]>(`/api/listings/${run.listing_id}/versions`); const record = records.find((item) => item.version === run.version); if (record) onOpen(record); }
    catch (err) { setError((err as Error).message); }
  }
  return <section className="panel amazon-import" aria-label="Amazon 商品接入">
    <div className="amazon-import-heading"><span className="app-icon orange"><Globe2 size={23} /></span><div><h2>从 Amazon 真实商品开始</h2><p>读取美国站棉布袋资料，保留来源，再生成英文 Listing。</p></div><span className="tiny-badge">公开页面接入</span></div>
    <div className="amazon-import-form"><input aria-label="Amazon 商品链接或 ASIN" placeholder="粘贴 Amazon.com 商品链接或 ASIN" value={reference} onChange={(event) => setReference(event.target.value)} disabled={loading} /><button className="primary-button" disabled={loading || !reference.trim()} onClick={() => start(false)}>{loading ? <LoaderCircle size={16} className="spin" /> : null}{loading ? "读取真实页面中…" : "导入商品"}</button></div>
    <p className="helper">仅实时读取你指定的商品页。遇到访问限制会明确报错，不自动切换快照。也可以从“商品资料”录入带来源的真实供应商规格。再次导入会刷新公开页面观察，保留已由商家确认的资料；有差异时请核对新页面。</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {result && <div className="amazon-import-results">{result.imported.map(({ product, run }) => { const status = run ? runs[run.run_id] || run : null; return <article key={product.product_id}><div className="amazon-result-title"><strong>{product.brand.value || "Amazon"} · {product.amazon?.asin}</strong><span className="tiny-badge">{status ? ({ succeeded: "生成与审阅已完成", failed: "生成失败", queued: "等待模型", running: status.stage }[status.status] || status.status) : "资料已导入"}</span></div><p>{product.amazon?.title}</p><AmazonSource product={product} /><ProductCompleteness product={product} compact />{status?.error && <p className="error-text">{status.error.message}</p>}<div className="amazon-result-actions"><button className="text-button" onClick={() => onProduct(product.product_id)}>查看商品资料 <ArrowUpRight size={13} /></button>{status?.status === "succeeded" && <button className="text-button" onClick={() => open(status)}><Sparkles size={14} /> 查看英文 Listing</button>}</div></article>; })}{result.failures.map((failure) => <div className="amazon-import-failure" key={failure.asin}><CircleAlert size={17} /><p><strong>{failure.asin}</strong> · {failure.message}</p></div>)}</div>}
  </section>;
}
