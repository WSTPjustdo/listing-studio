import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppError } from './domain.mjs';

export function collectLocal(kind, value, postal_code) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const python = process.env.AMAZON_PYTHON || fileURLToPath(new URL(process.platform === 'win32' ? '../.runtime/omkar-venv/Scripts/python.exe' : '../.runtime/omkar-venv/bin/python', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['scripts/amazon-local-api.py', '--collect'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', failed = false;
    const fail = (message, code = 'LOCAL_AMAZON') => { if (failed) return; failed = true; clearTimeout(timer); child.kill(); reject(new AppError(code, message, 502)); };
    const timer = setTimeout(() => fail('本地商品抓取超时，请重试或缩小检索范围。'), 120000);
    child.on('error', () => fail('本地爬虫未安装，请先运行 scripts/setup-amazon.ps1。'));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 5000000) fail('商品数据过大。'); });
    child.stderr.resume();
    child.on('close', code => {
      clearTimeout(timer); if (failed) return;
      if (code !== 0) {
        let detail;
        try { detail = JSON.parse(output)?.error; } catch { /* no safe structured collector detail */ }
        if (detail?.code === 'AMAZON_BLOCKED') return fail('亚马逊返回访问限制或验证页面，本次未取得竞品资料；未绕过验证或生成替代数据。', 'LOCAL_AMAZON_BLOCKED');
        return fail(detail?.type ? `亚马逊页面暂时不可读取（${String(detail.type).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 80)}），未生成替代数据，请稍后重试。` : '亚马逊页面暂时不可读取，未生成替代数据，请稍后重试。');
      }
      try { resolve(JSON.parse(output)); } catch { fail('本地爬虫响应格式异常。'); }
    });
    child.stdin.end(JSON.stringify({ kind, value, postal_code }));
  });
}

export function localItem(response, asin) {
  const p = response.data || {};
  const specs = Object.entries(p.details || {}).map(([name, value]) => ({ name, value: String(value) }));
  const warnings = [];
  const titlePack = /pack of\s+(\d+)/i.exec(p.title || '')?.[1];
  if (titlePack && p.details?.number_of_packs && Number(titlePack) !== Number(p.details.number_of_packs)) warnings.push(`套装数量冲突：标题 ${titlePack}，规格表 ${p.details.number_of_packs}，暂不计算单件价。`);
  if (/cotton/i.test(p.details?.fabric_type || '') && /plastic|polyester/i.test(p.details?.material_fabric || '')) warnings.push('材质字段存在冲突，请核对变体和原页。');
  return { ...p, asin: p.asin || asin, feature_bullets: p.bullets || [], specifications: specs,
    fetched_at: response.fetched_at || null, source_url: response.source_url || null,
    price: { value: p.price?.amount, currency: p.price?.currency }, rating: p.rating?.average,
    delivery: response.delivery, missing_fields: response.missing_fields || [], warnings,
    detail_status: p.title && p.bullets?.length ? 'available' : 'incomplete' };
}
