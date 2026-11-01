// Open the existing local workbench, starting the original launcher only when its port is free.
// Does not read settings, connect to the database, or call a model.
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { probeOccupant, probeHost } from '../server/startup.mjs';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT || 8787);
const hostname = probeHost(process.env.HOST || '127.0.0.1');
const noBrowser = process.argv.includes('--no-browser');
const timeoutMs = 300000;
const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
  .filter(Boolean).map(base => join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(existsSync);
if (process.platform !== 'win32') throw new Error('Use npm start to run the workbench on this operating system.');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
if (!/^(?:localhost|[\w.-]+|\[?[\da-f:]+\]?)$/i.test(hostname)) throw new Error('HOST must be a plain hostname or IP address.');
const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
const url = `http://${host}:${port}/`;
const runtime = resolve(root, '.runtime');
const lockPath = join(runtime, `workbench-launch-${port}.lock`);
const logPath = join(runtime, `workbench-launch-${port}.log`);
const token = randomUUID();
let ownsLock = false;
let startup;
let startedServer = false;
function releaseLock() {
  if (!ownsLock) return;
  try { if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath); } catch { /* Another launcher may already have cleared it. */ }
  ownsLock = false;
}
process.on('exit', releaseLock);
function occupied() {
  return new Promise(resolveSocket => {
    const socket = connect({ host: hostname.replace(/^\[|\]$/g, ''), port });
    let settled = false;
    const finish = value => { if (settled) return; settled = true; socket.destroy(); resolveSocket(value); };
    socket.setTimeout(1200, () => finish(true));
    socket.on('connect', () => finish(true));
    socket.on('error', error => finish(error.code !== 'ECONNREFUSED'));
  });
}
async function homepageReady() {
  const response = await fetch(url, { signal: AbortSignal.timeout(2500), redirect: 'error' });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return false;
  if (!(await response.text()).includes('id="root"')) return false;
  const bootstrap = await fetch(new URL('api/bootstrap', url), { signal: AbortSignal.timeout(2500), redirect: 'error' });
  if (!bootstrap.ok) return false;
  const data = await bootstrap.json();
  return Array.isArray(data.products) && Array.isArray(data.listings);
}
async function openEdge(reused) {
  if (!(await homepageReady())) throw new Error('工作台首页尚未就绪。请查看 start-local.cmd 的启动信息，或先运行 npm run build。');
  if (!noBrowser) {
    if (!edge) throw new Error('未找到 Microsoft Edge。请安装 Edge 后重试。');
    const child = spawn(edge, ['--new-window', url], { detached: true, windowsHide: false, stdio: 'ignore' });
    await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
    child.unref();
  }
  console.log(JSON.stringify({ status: 'ready', url, reused_existing_server: reused, started_server: startedServer, startup_pid: startup?.pid || null, browser: noBrowser ? 'not_opened' : 'Microsoft Edge', model_calls: 0 }));
}

try {
  if (!noBrowser && !edge) throw new Error('未找到 Microsoft Edge。请安装 Edge 后重试。');
  const first = await probeOccupant({ hostname, port });
  if (first.kind === 'ours' && first.status === 200) {
    await openEdge(true);
  } else {
    if (first.kind === 'other' || await occupied())
      throw new Error(`端口 ${port} 已被占用或未返回正常工作台状态。请确认原服务，或设置 PORT 后重试；未启动新服务。`);
    mkdirSync(runtime, { recursive: true });
    try {
      const lock = openSync(lockPath, 'wx');
      writeFileSync(lock, token); closeSync(lock); ownsLock = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - statSync(lockPath).mtimeMs > timeoutMs + 30000)
        throw new Error(`上次启动未完成。请检查 ${logPath}，确认没有安装或启动进程后移除 ${lockPath} 再试。`);
      console.log('另一入口正在启动工作台，等待同一服务就绪…');
    }
    if (ownsLock) {
      // Recheck after acquiring the lock: never start another process against a live database.
      const second = await probeOccupant({ hostname, port, timeoutMs: 600 });
      if (second.kind === 'ours' && second.status === 200) {
        await openEdge(true);
        releaseLock();
        process.exit(0);
      }
      if (second.kind === 'other' || await occupied()) throw new Error(`端口 ${port} 的状态已变化，请重试；未启动新服务。`);
      console.log('正在启动原本地工作台；首次安装需要联网。准备好后会自动打开 Edge。');
      console.log(`启动日志：${logPath}`);
      const log = openSync(logPath, 'w');
      try {
        startup = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start-local.cmd'], {
          cwd: root, env: process.env, detached: true, windowsHide: true, stdio: ['ignore', log, log],
        });
        await new Promise((resolveSpawn, reject) => { startup.once('spawn', resolveSpawn); startup.once('error', reject); });
        startedServer = true;
        startup.unref();
      } finally { closeSync(log); }
    }
    const deadline = Date.now() + timeoutMs;
    let lastNotice = Date.now();
    for (;;) {
      const probe = await probeOccupant({ hostname, port, timeoutMs: 1200 });
      if (probe.kind === 'ours' && probe.status === 200 && await homepageReady()) { await openEdge(false); break; }
      if (probe.kind === 'other') throw new Error(`端口 ${port} 被其它程序占用。启动详情见 ${logPath}。`);
      if (startup && startup.exitCode !== null && startup.exitCode !== 0) throw new Error(`工作台启动失败，详情见 ${logPath}。`);
      if (Date.now() >= deadline) throw new Error(`等待工作台就绪超时，详情见 ${logPath}；依赖安装可能仍在运行。`);
      if (Date.now() - lastNotice >= 10000) { console.log('仍在安装、构建或启动，日志会保留进度…'); lastNotice = Date.now(); }
      await delay(500);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { releaseLock(); }
