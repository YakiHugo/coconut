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
import {createIngestionService} from './ingestion-service.mjs';
import {packagedCaptionGuidance,captionDiagnostic} from './caption-service.mjs';
import {createIngestionExecutor} from './ingestion-executor.mjs';
import {createReadabilityJobs} from './readability-jobs.mjs';
import {createTaskStore,TASK_BODY_BYTES} from './tasks.mjs';
import {createLibraryStore} from './library-store.mjs';
import {handleLibraryRequest} from './library-api.mjs';
import {libraryLocation,libraryStartupMessage} from './library-location.mjs';
import {privateProxyProfile,privateProxyFromEnvironment,authorizeClient,describeClient,localOnlyRoute,remoteDiagnostic,remoteResponseDiagnostics} from './client-access.mjs';

export const CAPABILITIES = Object.freeze({reader:true,local_agents:true,subscription_ask:true,subscription_translation:true,media_import:false,local_translation:false,podcast_import:true,caption_import:false});
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = new Map([['/','index.html'],...['index.html','summary.js','interview.js','editions.js','task-client.js','core.js','client-capabilities.js','passages.js','passage-playback.js','library-store.js','indexeddb-document-adapter.js','canonical-library.js','storage-provider.js','react-app.js','react-app.css','coconut-mark.png'].map(name=>['/'+name,name])]);
const MIME = {'.png':'image/png','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const MAX_BODY = 1024 * 1024;
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

export function createBridge({readerDirectory = path.resolve(ROOT,'../reader'), providers = createProviders(), podcastSources = createPodcastSources(), captionService = null, captionStatus = null, captionShortLinkResolver = undefined, bilibiliSession = null, localMediaService = null, videoAudioService = null, taskStore = null, taskUnavailable = null, libraryStore = null, libraryUnavailable = null, libraryLocation = null, privateProxy = null, ingestionExecutor = createIngestionExecutor(),readabilityJobs = null} = {}) {
  const profile=privateProxyProfile(privateProxy);
  const translate = createTranslator(providers);
  const capabilities=Object.freeze({...CAPABILITIES,caption_import:captionService?.available===true,persistent_tasks:!!taskStore,canonical_library:!!libraryStore});
  const captionSources=Object.freeze({available:capabilities.caption_import,mode:captionStatus?.mode||(capabilities.caption_import?'bundled-helper':'disabled'),
    code:capabilities.caption_import?'ready':captionStatus?.code||'CAPTION_UNAVAILABLE',
    providers:[['x','X / Twitter'],['youtube','YouTube'],['bilibili','Bilibili']].map(([id,label])=>({id,label,available:capabilities.caption_import&&(captionService.providers||['x']).includes(id)})),
    ...(captionStatus?.mode==='development-python'&&['trusted_local_proxy','direct_public'].includes(captionStatus.networkMode)?{networkMode:captionStatus.networkMode==='trusted_local_proxy'?'trusted_local_proxy':'direct_public',proxyProviders:captionStatus.networkMode==='trusted_local_proxy'?['youtube','bilibili']:[]}:{}),
    automatic_asr:false,fallback:'import_transcript',
    message:capabilities.caption_import?'可尝试获取已启用来源的公开原语言字幕；平台访问限制仍可能阻止获取。':captionStatus?.mode==='bundled-helper'?packagedCaptionGuidance(captionStatus.code):'字幕助手未就绪。可导入或粘贴已有字幕；开发环境可用 COCONUT_CAPTION_PYTHON 指定已安装的兼容 Python。不会自动安装依赖或启动识别。'});
  const ingestionService = createIngestionService({podcastSources,captionService,captionStatus:captionSources,captionShortLinkResolver,videoAudioProviders:videoAudioService?.available===true?videoAudioService.providers||[]:[]});
  const active = new Set();
  const server = http.createServer(async (req,res) => {
    for (const [key,value] of Object.entries({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store',
      'Content-Security-Policy':CSP,'X-Frame-Options':'DENY','Cross-Origin-Resource-Policy':'same-origin'})) res.setHeader(key,value);
    let access=null,pathname="";
    const json = (status,data) => {
      if(access?.mode==='private-owner')data=remoteResponseDiagnostics(data,pathname);
      if (res.destroyed) return;
      const body = JSON.stringify(data); res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body)}); res.end(req.method === 'HEAD' ? undefined : body);
    };
    const port = server.address()?.port;
    access=authorizeClient(req,{port,profile});
    if(!access)return json(403,{code:'client_forbidden',error:'此请求未通过本机或私有本人访问验证'});
    const origin=access.origin,remote=access.mode==='private-owner';
    try { pathname = new URL(req.url, origin).pathname; } catch { return json(400,{error:'无效路径'}); }
    if(remote&&localOnlyRoute(pathname))return json(403,{code:'local_only',error:'此操作需要在所连接的电脑上完成'});
    const client=()=>describeClient(access,{profile,libraryStore,taskStore,localMediaService});
    const controller = new AbortController(); active.add(controller);
    res.on('close',()=>{ if (!res.writableEnded) controller.abort(); active.delete(controller); });
    try {
      if(await handleLibraryRequest({req,pathname,origin,json,store:libraryStore,unavailable:libraryUnavailable}))return;
      if (localMediaService && await localMediaService.handle(req,res,pathname)) return;
      if(pathname.startsWith('/api/v1/readability')){
        if(remote)return json(403,{error:'请在本机阅读器中整理原声与文字稿'});
        if(!readabilityJobs)return json(503,{error:'本地整理服务未配置',code:'readability_unavailable'});
        const match=pathname.match(/^\/api\/v1\/readability\/jobs\/([a-f0-9-]+)(?:\/(result|media|cancel|retry))?$/);
        if(req.method==='GET'||req.method==='HEAD'){
          if(pathname==='/api/v1/readability/capabilities')return json(200,{...await readabilityJobs.capabilities(),sourceMedia:videoAudioService?.sourceAvailable===true});
          if(pathname==='/api/v1/readability/jobs')return json(200,{jobs:readabilityJobs.list(new URL(req.url,origin).searchParams.get('key'))});
          if(match?.[2]==='media')return await readabilityJobs.streamMedia(match[1],req,res);
          if(match&&!['media','cancel','retry'].includes(match[2]))return json(200,{job:await readabilityJobs[match[2]==='result'?'result':'get'](match[1])});
          return json(404,{error:'整理请求不存在'});
        }
        if(req.method!=='POST')return json(405,{error:'Method not allowed'});
        if(req.headers.origin!==origin)return json(403,{error:'整理请求必须来自本机阅读器'});
        if(match?.[2]==='media')return json(200,{job:await readabilityJobs.upload(match[1],req,{signal:controller.signal})});
        if(match&&['cancel','retry'].includes(match[2]))return json(200,{job:await readabilityJobs.action(match[1],match[2])});
        if(pathname!=='/api/v1/readability/jobs')return json(404,{error:'整理请求不存在'});
        if(req.headers['content-type']?.split(';')[0]!=='application/json')return json(400,{error:'Use application/json'});
        let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024)return json(413,{error:'文字稿过大'});chunks.push(chunk);}
        return json(201,{job:await readabilityJobs.create(JSON.parse(Buffer.concat(chunks).toString('utf8')))});
      }
      const ingestionJob=pathname.match(/^\/api\/v1\/ingestions\/jobs\/([a-f0-9]{32})(?:\/(result|media|cancel|retry))?$/);
      if (req.method === 'GET' || req.method === 'HEAD') {
        const operationMatch=pathname.match(/^\/api\/v1\/ingestions\/operations\/([a-f0-9-]+)$/);
        if(operationMatch){const params=new URL(req.url,origin).searchParams;const decimal=key=>/^\d+$/.test(params.get(key)||'')?Number(params.get(key)):NaN;return json(200,{protocolVersion:1,ingestion:await ingestionExecutor.recover({operation_id:operationMatch[1],filename:params.get('filename'),size:decimal('size'),fingerprint:params.get('fingerprint'),last_modified:decimal('last_modified'),language:params.get('language')||''},{signal:controller.signal})});}
        if(pathname==='/api/v1/ingestions/jobs') return json(200,{protocolVersion:1,ingestions:await ingestionExecutor.list({signal:controller.signal})});
        if(ingestionJob){
          const [,id,action]=ingestionJob;
          if(action==='media')return await ingestionExecutor.media(id,req,res,{signal:controller.signal});
          if(action==='cancel'||action==='retry')return json(405,{error:'Method not allowed'});
          return json(200,{protocolVersion:1,ingestion:await ingestionExecutor[action==='result'?'result':'get'](id,{signal:controller.signal})});
        }
        if (pathname === '/api/v1/executor') return json(200,{...(taskStore?.describe()||{protocolVersion:1,executor:{type:'local-node',online:true},supportedTaskKinds:['summary'],enabled:false,...(taskUnavailable?{unavailable:taskUnavailable}:{}),providers:{codex:{supported:true,availability:'not_checked'},claude:{supported:true,availability:'not_checked'}},remoteSubmission:false}),remoteSubmission:remote,client:client()});
        if (pathname === '/api/v1/tasks' || /^\/api\/v1\/tasks\/[a-f0-9-]+(?:\/export)?$/.test(pathname)) {
          if(!taskStore)return json(503,{error:taskUnavailable?.message||'此执行器尚未配置持久任务目录',code:taskUnavailable?.code||'tasks_disabled'});
          if(req.method!=='GET')return json(405,{error:'Method not allowed'});
          if(pathname==='/api/v1/tasks'){
            const params=new URL(req.url,origin).searchParams,key=params.get('submissionKey');
            if(key===null&&params.get('archived')==='true')return json(200,{protocolVersion:1,...await taskStore.listArchived({limit:params.has('limit')?Number(params.get('limit')):20,after:params.get('after')||''})});
            return json(200,{protocolVersion:1,...(key!==null?{task:await taskStore.findSubmission(key)}:{tasks:await taskStore.list()})});
          }
          if(pathname.endsWith('/export'))return json(200,{protocolVersion:1,record:await taskStore.exportTask(pathname.split('/').at(-2))});
          const resumeKey=new URL(req.url,origin).searchParams.get('resumeKey');
          if(resumeKey!==null)return json(200,{protocolVersion:1,...await taskStore.findResume(pathname.split('/').at(-1),resumeKey)});
          return json(200,{protocolVersion:1,task:await taskStore.get(pathname.split('/').at(-1))});
        }
        if (pathname === '/api/v1/ingestions/capabilities') return json(200,{...ingestionService.capabilities(),transcription:await ingestionExecutor.status({signal:controller.signal})});
        if (pathname === '/api/captions/status') return json(200,captionSources);
        if (pathname === '/api/captions/session') return json(200,bilibiliSession&&capabilities.caption_import?await bilibiliSession.status():{supported:false,browser:'edge',connected:false,profile:null,profiles:[]});
        if (pathname === '/api/health') return json(200,{local_worker:false,runtime:'desktop-bridge',paid_processing:false,max_upload_bytes:0,capabilities,client:client(),caption_sources:captionSources,...(libraryLocation&&!remote?{library_storage:{...libraryLocation,enabled:!!libraryStore,unavailable:libraryUnavailable}}:{})});
        if (pathname === '/api/language-tools' && req.method === 'GET') return json(200,{translation_models:[],local_translation:false,ask_exact_selection:1,ask_edited_selection:1,capabilities,
          ai:{codex:await providers.status('codex',{signal:controller.signal}),claude:await providers.status('claude',{signal:controller.signal})}});
        if (pathname === '/api/jobs') return json(501,{error:'轻量版不提供处理队列，请重新检查本地服务能力'});
        if (!ASSETS.has(pathname)) return json(404,{error:'Not found'});
        const file = ASSETS.get(pathname), body = await readFile(path.join(readerDirectory,file));
        res.writeHead(200,{'Content-Type':MIME[path.extname(file)],'Content-Length':body.length}); res.end(req.method === 'HEAD' ? undefined : body); return;
      }
      if (req.method !== 'POST') return json(405,{error:'Method not allowed'});
      // Cross-site HTML forms and opaque-origin pages must never start a local CLI.
      if (req.headers.origin !== origin) return json(403,{error:'发送请求必须来自此本机阅读器'});
      if(pathname==='/api/v1/ingestions/upload'){
        const params=new URL(req.url,origin).searchParams;
        return json(201,{protocolVersion:1,ingestion:await ingestionExecutor.upload(req,{filename:params.get('filename'),language:params.get('language')||'',operation_id:params.get('operation_id'),fingerprint:params.get('fingerprint'),last_modified:/^\d+$/.test(params.get('last_modified')||'')?Number(params.get('last_modified')):NaN,signal:controller.signal})});
      }
      const ingestionAction=ingestionJob&&['cancel','retry'].includes(ingestionJob[2]);
      const taskRoute=pathname==='/api/v1/tasks'||/^\/api\/v1\/tasks\/[a-f0-9-]+\/(?:cancel|archive|restore|resume)$/.test(pathname);
      if (taskRoute&&!taskStore)return json(503,{error:taskUnavailable?.message||'此执行器尚未配置持久任务目录',code:taskUnavailable?.code||'tasks_disabled'});
      if (!taskRoute&&!ingestionAction&&!['/api/v1/ingestions','/api/ask','/api/translate-subscription','/api/podcasts/discover','/api/podcasts/import','/api/podcasts/media','/api/videos/media','/api/videos/source-media','/api/captions/import','/api/captions/session'].includes(pathname)) return json(501,{error:'轻量版未启用视频站下载、ASR 或离线翻译。可使用公开播客源、字幕或本地音视频；完整本地处理服务为可选高级功能。'});
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
      if(pathname==='/api/captions/session'){
        if(!bilibiliSession||!capabilities.caption_import)return json(503,{error:'当前服务未提供浏览器连接。'});
        const keys=Object.keys(data).sort().join(',');
        if(data.action==='connect'&&keys==='action,browser,profile'&&data.browser==='edge')return json(200,await bilibiliSession.connect(data.profile,{signal:controller.signal}));
        if(data.action==='disconnect'&&keys==='action')return json(200,await bilibiliSession.disconnect());
        return json(400,{error:'浏览器连接请求无效。'});
      }
      if(ingestionAction){if(data.protocolVersion!==1)return json(400,{error:'导入协议版本无效'});return json(200,{protocolVersion:1,ingestion:await ingestionExecutor.action(ingestionJob[1],ingestionJob[2],{signal:controller.signal})});}
      if(taskRoute){
        const action=pathname.split('/').at(-1),guardedMutation=['archive','cancel'].includes(action)&&data.protocolVersion===2;
        if(action==='resume'){const receipt=await taskStore.resume(pathname.split('/').at(-2),data);return json(receipt.created?202:200,{protocolVersion:1,...receipt});}
        // v2 is the guarded archive/cancel request envelope. Old servers reject
        // it instead of silently ignoring a caller's identity precondition.
        if((data.protocolVersion!==1&&!guardedMutation)||(guardedMutation&&!Object.hasOwn(data,'expected'))||(!guardedMutation&&Object.hasOwn(data,'expected')))return json(400,{error:'任务协议版本或身份条件无效',code:'invalid_request'});
        if(['cancel','archive','restore'].includes(action))return json(200,{protocolVersion:1,task:await taskStore[action](pathname.split('/').at(-2),guardedMutation?data.expected:undefined)});
        const receipt=await taskStore.submit(data);return json(receipt.created?202:200,{protocolVersion:1,...receipt});
      }
      if(pathname === '/api/v1/ingestions'){const receipt=await ingestionService.ingest(data,{signal:controller.signal});if(receipt.ingestion.state==='needs_transcription')receipt.ingestion.transcription=await ingestionExecutor.status({signal:controller.signal});return json(200,receipt);}
      if(pathname === '/api/captions/import'){
        if(!capabilities.caption_import)return json(501,{code:captionSources.code,error:captionSources.message});
        return json(200,await captionService.importCaption(data,{signal:controller.signal}));
      }
      if(pathname === '/api/podcasts/discover') return json(200,await podcastSources.discover(data,{signal:controller.signal}));
      if(pathname === '/api/podcasts/import') return json(200,await podcastSources.importEpisode(data,{signal:controller.signal}));
      if(['/api/videos/media','/api/videos/source-media'].includes(pathname)) {
        if(!videoAudioService?.available)return json(503,{code:'video_media_unavailable',error:'此开发服务未配置公开媒体助手；不会自动安装依赖。'});
        const media=await videoAudioService.download(data,{signal:controller.signal,...(pathname==='/api/videos/source-media'?{purpose:'source'}:{})});
        res.writeHead(200,{'Content-Type':media.type,'Content-Length':media.body.length,'Content-Disposition':'attachment; filename="'+media.filename+'"','X-Coconut-Media-Source':Buffer.from(JSON.stringify(media.source)).toString('base64url')});
        res.end(media.body);return;
      }
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
      if(res.headersSent){res.destroy();return;}
      if(['/api/videos/media','/api/videos/source-media'].includes(pathname)){
        const diagnostic=captionDiagnostic(error.diagnostic);
        return json(error.status||400,{...(typeof error.code==='string'?{code:error.code}:{}),
          error:remote?remoteDiagnostic(error.message):String(error.message||'媒体读取未完成').slice(0,300),
          ...(diagnostic?{diagnostic}:{})});
      }
      return json(error.status|| (error.code === 'ENOENT' ? 404 : 400),{...(remote?{code:error.taskCode||error.code||'request_failed'}:{}),...(pathname==='/api/videos/media'&&typeof error.code==='string'?{code:error.code}:{}),...(error.taskCode?{code:error.taskCode}:(pathname==='/api/captions/import'||pathname==='/api/v1/ingestions'&&['CAPTION_OUTPUT','CAPTION_PARSE_FAILED','CAPTION_TIMEOUT','CAPTION_UNAVAILABLE','CAPTION_INTEGRITY','CAPTION_VERSION','CAPTION_START','CAPTION_EXIT'].includes(error.code))&&error.code?{code:error.code}:{}),...(!remote&&error.localProviderDetails?{localProviderDetails:error.localProviderDetails}:{}),...(error.providerDiagnostics?{code:'provider_failed',localHttpStatus:400,providerDiagnostics:error.providerDiagnostics}:{}),error:error.code === 'ENOENT' ? 'File not found' : remote?remoteDiagnostic(error.message):String(error.message || '请求未完成').slice(0,300)});
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.on('close',()=>{ libraryStore?.close(); for (const controller of active) controller.abort(); active.clear();void taskStore?.shutdown().catch(()=>{});void readabilityJobs?.shutdown().catch(()=>{}); });
  // Abort synchronously before Electron exits: detached CLI process groups must
  // not outlive the app while waiting for a later HTTP close event.
  let shutdown;
  server.shutdown = callback => {
    if(!shutdown){
      for (const controller of active) controller.abort();
      active.clear(); const stopping=Promise.all([taskStore?.shutdown(),readabilityJobs?.shutdown()]);
      shutdown=new Promise((resolve,reject)=>{
        server.close(error=>void stopping.then(()=>error?reject(error):resolve(),reject));
        server.closeAllConnections();
      });
    }
    if(callback)void shutdown.then(()=>callback(),error=>callback(error));
    return shutdown;
  };
  return server;
}
export async function startBridge({port = 8080, taskDirectory = null, libraryDirectory = null, ...options} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  if(taskDirectory){
    options.providers??=createProviders();
    try{options.taskStore=await createTaskStore({directory:taskDirectory,providers:options.providers,readerDirectory:options.readerDirectory});}
    catch(error){options.taskStore=null;options.taskUnavailable={code:error.taskCode||'store_unavailable',message:'持久任务存储不可用，请检查本机任务目录；阅读与现有前台功能仍可使用。'};}
  }
  if(libraryDirectory){
    options.libraryLocation={mode:options.startupMode||'embedded',directory:libraryDirectory};
    try{options.libraryStore=await createLibraryStore({directory:libraryDirectory,exclusiveWriter:true});}
    catch(error){options.libraryStore=null;options.libraryUnavailable={code:error.libraryCode||'library_unavailable',message:'Canonical library could not open; browser storage remains unchanged.'};}
  }
  if(!options.readabilityJobs&&options.libraryStore&&libraryDirectory&&(options.readingPython||process.env.COCONUT_READING_PYTHON)){
    try{options.readabilityJobs=await createReadabilityJobs({directory:path.join(libraryDirectory,'readability'),python:options.readingPython||process.env.COCONUT_READING_PYTHON,punctuationModel:options.punctuationModel,segmentationModel:options.segmentationModel,embeddingModel:options.embeddingModel});}
    catch(error){options.libraryStore?.close();await options.taskStore?.shutdown();throw error;}
  }
  const server = createBridge(options);
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}
  catch(error){options.libraryStore?.close();await options.taskStore?.shutdown();await options.readabilityJobs?.shutdown();throw error;}
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--port')) { console.error('Usage: node desktop/server.mjs [--port 8080]'); process.exit(1); }
  const library=libraryLocation({mode:'cli'});
  const server = await startBridge({port:args.length ? Number(args[1]) : 8080,taskDirectory:path.join(homedir(),'.coconut','tasks'),libraryDirectory:library.directory,startupMode:'cli',privateProxy:privateProxyFromEnvironment()});
  console.log(`Coconut 轻量阅读器：http://127.0.0.1:${server.address().port}（不需要 Python；未发起模型请求）`);
  console.log(libraryStartupMessage(library,await fetch(`http://127.0.0.1:${server.address().port}/api/v1/library`).then(response=>response.json())));
  const stop = () => server.shutdown();
  process.on('SIGINT',stop); process.on('SIGTERM',stop);
}
