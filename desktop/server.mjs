#!/usr/bin/env node
/** Zero-Python loopback reader. Starting this service never starts an agent or a model. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProviders } from './providers.mjs';
import { createTranslator } from './translation.mjs';
import { createPodcastSources } from './podcast-sources.mjs';
import {createTaskStore,TASK_BODY_BYTES} from './tasks.mjs';

export const CAPABILITIES = Object.freeze({reader:true,local_agents:true,subscription_ask:true,subscription_translation:true,media_import:false,local_translation:false,podcast_import:true,caption_import:false});
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = new Map([['/','index.html'],...['index.html','app.js','summary.js','task-client.js','core.js','background-summary.js','passages.js','passage-playback.js','quotation.js','library-store.js','appearance.js','indexeddb-document-adapter.js','storage-provider.js','storage-bootstrap.js','transcript-navigator.js','jobs.js','language.js','translation-review.js','podcasts.js','updates.js','style.css','coconut-mark.png'].map(name=>['/'+name,name])]);
const MIME = {'.png':'image/png','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const MAX_BODY = 1024 * 1024;
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

export function createBridge({readerDirectory = path.resolve(ROOT,'../reader'), providers = createProviders(), podcastSources = createPodcastSources(), captionService = null, captionStatus = null, localMediaService = null, taskStore = null, taskUnavailable = null} = {}) {
  const translate = createTranslator(providers);
  const capabilities=Object.freeze({...CAPABILITIES,caption_import:captionService?.available===true,persistent_tasks:!!taskStore});
  const captionSources=Object.freeze({available:capabilities.caption_import,mode:captionStatus?.mode||(capabilities.caption_import?'bundled-helper':'disabled'),
    code:capabilities.caption_import?'ready':captionStatus?.code||'CAPTION_UNAVAILABLE',
    providers:[{id:'x',label:'X / Twitter',available:capabilities.caption_import},{id:'youtube',label:'YouTube',available:false},{id:'bilibili',label:'Bilibili',available:false}],
    automatic_asr:false,fallback:'import_transcript',
    message:capabilities.caption_import?'可获取公开 X 原语言字幕；YouTube / Bilibili 尚未接入此服务。':'字幕助手未就绪。可导入或粘贴已有字幕；开发环境可用 COCONUT_CAPTION_PYTHON 指定已安装的兼容 Python。不会自动安装依赖或启动识别。'});
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
      if (localMediaService && await localMediaService.handle(req,res,pathname)) return;
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (pathname === '/api/v1/executor') return json(200,taskStore?.describe()||{protocolVersion:1,executor:{type:'local-node',online:true},supportedTaskKinds:['summary'],enabled:false,...(taskUnavailable?{unavailable:taskUnavailable}:{}),providers:{codex:{supported:true,availability:'not_checked'},claude:{supported:true,availability:'not_checked'}},remoteSubmission:false});
        if (pathname === '/api/v1/tasks' || /^\/api\/v1\/tasks\/[a-f0-9-]+(?:\/export)?$/.test(pathname)) {
          if(!taskStore)return json(503,{error:taskUnavailable?.message||'此执行器尚未配置持久任务目录',code:taskUnavailable?.code||'tasks_disabled'});
          if(req.method!=='GET')return json(405,{error:'Method not allowed'});
          if(pathname==='/api/v1/tasks'){
            const params=new URL(req.url,origin).searchParams,key=params.get('submissionKey');
            if(key===null&&params.get('archived')==='true')return json(200,{protocolVersion:1,...await taskStore.listArchived({limit:params.has('limit')?Number(params.get('limit')):20,after:params.get('after')||''})});
            return json(200,{protocolVersion:1,...(key!==null?{task:await taskStore.findSubmission(key)}:{tasks:await taskStore.list()})});
          }
          if(pathname.endsWith('/export'))return json(200,{protocolVersion:1,record:await taskStore.exportTask(pathname.split('/').at(-2))});
          return json(200,{protocolVersion:1,task:await taskStore.get(pathname.split('/').at(-1))});
        }
        if (pathname === '/api/captions/status') return json(200,captionSources);
        if (pathname === '/api/health') return json(200,{local_worker:false,runtime:'desktop-bridge',paid_processing:false,max_upload_bytes:0,capabilities,caption_sources:captionSources});
        if (pathname === '/api/language-tools' && req.method === 'GET') return json(200,{translation_models:[],local_translation:false,capabilities,
          ai:{codex:await providers.status('codex',{signal:controller.signal}),claude:await providers.status('claude',{signal:controller.signal})}});
        if (pathname === '/api/jobs') return json(501,{error:'轻量版不提供处理队列，请重新检查本地服务能力'});
        if (!ASSETS.has(pathname)) return json(404,{error:'Not found'});
        const file = ASSETS.get(pathname), body = await readFile(path.join(readerDirectory,file));
        res.writeHead(200,{'Content-Type':MIME[path.extname(file)],'Content-Length':body.length}); res.end(req.method === 'HEAD' ? undefined : body); return;
      }
      if (req.method !== 'POST') return json(405,{error:'Method not allowed'});
      // Cross-site HTML forms and opaque-origin pages must never start a local CLI.
      if (req.headers.origin !== origin) return json(403,{error:'发送请求必须来自此本机阅读器'});
      const taskRoute=pathname==='/api/v1/tasks'||/^\/api\/v1\/tasks\/[a-f0-9-]+\/(?:cancel|archive|restore)$/.test(pathname);
      if (taskRoute&&!taskStore)return json(503,{error:taskUnavailable?.message||'此执行器尚未配置持久任务目录',code:taskUnavailable?.code||'tasks_disabled'});
      if (!taskRoute&&!['/api/ask','/api/translate-subscription','/api/podcasts/discover','/api/podcasts/import','/api/podcasts/media','/api/captions/import'].includes(pathname)) return json(501,{error:'轻量版未启用视频站下载、ASR 或离线翻译。可使用公开播客源、字幕或本地音视频；完整本地处理服务为可选高级功能。'});
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(400,{error:'Use application/json'});
      const limit=taskRoute?TASK_BODY_BYTES:MAX_BODY;
      const declared = req.headers['content-length'];
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) { req.resume(); return json(413,{error:'请求过大'}); }
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > limit) { json(413,{error:'请求过大'}); return; }
        chunks.push(chunk);
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400,{error:'请求 JSON 无效'}); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return json(400,{error:'请求 JSON 无效'});
      if(taskRoute){
        const action=pathname.split('/').at(-1),guardedArchive=action==='archive'&&data.protocolVersion===2;
        // v2 is only the guarded archive request envelope. Old servers reject
        // it instead of silently ignoring a caller's identity precondition.
        if((data.protocolVersion!==1&&!guardedArchive)||(guardedArchive&&!Object.hasOwn(data,'expected'))||(!guardedArchive&&Object.hasOwn(data,'expected')))return json(400,{error:'任务协议版本或身份条件无效',code:'invalid_request'});
        if(['cancel','archive','restore'].includes(action))return json(200,{protocolVersion:1,task:await taskStore[action](pathname.split('/').at(-2),guardedArchive?data.expected:undefined)});
        const receipt=await taskStore.submit(data);return json(receipt.created?202:200,{protocolVersion:1,...receipt});
      }
      if(pathname === '/api/captions/import'){
        if(!capabilities.caption_import)return json(501,{code:captionSources.code,error:captionSources.message});
        return json(200,await captionService.importCaption(data,{signal:controller.signal}));
      }
      if(pathname === '/api/podcasts/discover') return json(200,await podcastSources.discover(data,{signal:controller.signal}));
      if(pathname === '/api/podcasts/import') return json(200,await podcastSources.importEpisode(data,{signal:controller.signal}));
      if(pathname === '/api/podcasts/media') {
        const media=await podcastSources.downloadMedia(data,{signal:controller.signal});
        if(res.destroyed)return;
        res.writeHead(200,{'Content-Type':media.type,'Content-Length':media.body.length,'X-Coconut-Media-Kind':media.kind,
          'Content-Disposition':'inline; filename="'+media.filename+'"'});res.end(media.body);return;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.consent !== true) return json(400,{error:'请先确认发送范围和订阅额度'});
      if (pathname === '/api/ask') return json(200,await providers.ask(data,{signal:controller.signal}));
      return json(200,{translations:await translate(data,{signal:controller.signal})});
    } catch (error) {
      return json(error.status|| (error.code === 'ENOENT' ? 404 : 400),{...(error.taskCode?{code:error.taskCode}:pathname==='/api/captions/import'&&error.code?{code:error.code}:{}),error:error.code === 'ENOENT' ? 'File not found' : String(error.message || '请求未完成').slice(0,300)});
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.on('close',()=>{ for (const controller of active) controller.abort(); active.clear();void taskStore?.shutdown().catch(()=>{}); });
  // Abort synchronously before Electron exits: detached CLI process groups must
  // not outlive the app while waiting for a later HTTP close event.
  server.shutdown = callback => {
    for (const controller of active) controller.abort();
    active.clear(); const stopping=taskStore?.shutdown()||Promise.resolve();
    server.close(error=>void stopping.then(()=>callback?.(error),failure=>callback?.(failure))); server.closeAllConnections();
    return stopping;
  };
  return server;
}
export async function startBridge({port = 8080, taskDirectory = null, ...options} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  if(taskDirectory){
    options.providers??=createProviders();
    try{options.taskStore=await createTaskStore({directory:taskDirectory,providers:options.providers,readerDirectory:options.readerDirectory});}
    catch(error){options.taskStore=null;options.taskUnavailable={code:error.taskCode||'store_unavailable',message:'持久任务存储不可用，请检查本机任务目录；阅读与现有前台功能仍可使用。'};}
  }
  const server = createBridge(options);
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}
  catch(error){await options.taskStore?.shutdown();throw error;}
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--port')) { console.error('Usage: node desktop/server.mjs [--port 8080]'); process.exit(1); }
  const server = await startBridge({port:args.length ? Number(args[1]) : 8080,taskDirectory:path.join(homedir(),'.coconut','tasks')});
  console.log(`Coconut 轻量阅读器：http://127.0.0.1:${server.address().port}（不需要 Python；未发起模型请求）`);
  const stop = () => server.shutdown();
  process.on('SIGINT',stop); process.on('SIGTERM',stop);
}
