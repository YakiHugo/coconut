#!/usr/bin/env node
/** Zero-Python loopback reader. Starting this service never starts an agent or a model. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviders } from './providers.mjs';
import { createTranslator } from './translation.mjs';

export const CAPABILITIES = Object.freeze({reader:true,local_agents:true,subscription_ask:true,subscription_translation:true,media_import:false,local_translation:false});
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = new Map([['/','index.html'],...['index.html','app.js','core.js','jobs.js','language.js','style.css'].map(name=>['/'+name,name])]);
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const MAX_BODY = 1024 * 1024;
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

export function createBridge({readerDirectory = path.resolve(ROOT,'../reader'), providers = createProviders()} = {}) {
  const translate = createTranslator(providers);
  const active = new Set();
  const server = http.createServer(async (req,res) => {
    for (const [key,value] of Object.entries({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store',
      'Content-Security-Policy':CSP,'X-Frame-Options':'DENY','Cross-Origin-Resource-Policy':'same-origin'})) res.setHeader(key,value);
    const json = (status,data) => {
      if (res.destroyed) return;
      const body = JSON.stringify(data); res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body)}); res.end(req.method === 'HEAD' ? undefined : body);
    };
    const port = server.address()?.port;
    const hosts = new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
    const origin = `http://${req.headers.host}`;
    if (!hosts.has(req.headers.host) || (req.headers.origin && req.headers.origin !== origin) ||
      (req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site']))) return json(403,{error:'仅允许本机同源请求'});
    let pathname;
    try { pathname = new URL(req.url, origin).pathname; } catch { return json(400,{error:'无效路径'}); }
    const controller = new AbortController(); active.add(controller);
    res.on('close',()=>{ if (!res.writableEnded) controller.abort(); active.delete(controller); });
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (pathname === '/api/health') return json(200,{local_worker:false,runtime:'desktop-bridge',paid_processing:false,max_upload_bytes:0,capabilities:CAPABILITIES});
        if (pathname === '/api/language-tools' && req.method === 'GET') return json(200,{translation_models:[],local_translation:false,capabilities:CAPABILITIES,
          ai:{codex:await providers.status('codex',{signal:controller.signal}),claude:await providers.status('claude',{signal:controller.signal})}});
        if (pathname === '/api/jobs') return json(501,{error:'轻量版不提供处理队列，请重新检查本地服务能力'});
        if (!ASSETS.has(pathname)) return json(404,{error:'Not found'});
        const file = ASSETS.get(pathname), body = await readFile(path.join(readerDirectory,file));
        res.writeHead(200,{'Content-Type':MIME[path.extname(file)],'Content-Length':body.length}); res.end(req.method === 'HEAD' ? undefined : body); return;
      }
      if (req.method !== 'POST') return json(405,{error:'Method not allowed'});
      // Cross-site HTML forms and opaque-origin pages must never start a local CLI.
      if (req.headers.origin !== origin) return json(403,{error:'发送请求必须来自此本机阅读器'});
      if (!['/api/ask','/api/translate-subscription'].includes(pathname)) return json(501,{error:'轻量版未启用下载、ASR 或离线翻译。请直接导入字幕/文字稿；完整本地处理服务为可选高级功能。'});
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(400,{error:'Use application/json'});
      const declared = req.headers['content-length'];
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) { req.resume(); return json(413,{error:'请求过大'}); }
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY) { json(413,{error:'请求过大'}); return; }
        chunks.push(chunk);
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400,{error:'请求 JSON 无效'}); }
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.consent !== true) return json(400,{error:'请先确认发送范围和订阅额度'});
      if (pathname === '/api/ask') return json(200,await providers.ask(data,{signal:controller.signal}));
      return json(200,{translations:await translate(data,{signal:controller.signal})});
    } catch (error) {
      return json(error.code === 'ENOENT' ? 404 : 400,{error:error.code === 'ENOENT' ? 'File not found' : String(error.message || '请求未完成').slice(0,300)});
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.on('close',()=>{ for (const controller of active) controller.abort(); active.clear(); });
  // Abort synchronously before Electron exits: detached CLI process groups must
  // not outlive the app while waiting for a later HTTP close event.
  server.shutdown = callback => {
    for (const controller of active) controller.abort();
    active.clear(); server.close(callback); server.closeAllConnections();
  };
  return server;
}
export async function startBridge({port = 8080, ...options} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const server = createBridge(options);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--port')) { console.error('Usage: node desktop/server.mjs [--port 8080]'); process.exit(1); }
  const server = await startBridge({port:args.length ? Number(args[1]) : 8080});
  console.log(`Coconut 轻量阅读器：http://127.0.0.1:${server.address().port}（不需要 Python；未发起模型请求）`);
  const stop = () => server.shutdown();
  process.on('SIGINT',stop); process.on('SIGTERM',stop);
}
