/** Opt-in source helper. The helper process does not search PATH; owner startup may resolve a local Deno binary. Never installs dependencies or invokes ASR. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {access,constants} from 'node:fs/promises';
import {readFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {readHelperMedia} from './caption-helper-media.mjs';
import {validateSourceNetwork} from './source-network.mjs';
import {tmpdir} from 'node:os';
import {captionSource,captionLanguages,CAPTION_FAILURE_STATUSES,captionDiagnostic} from './caption-service.mjs';
import {runCaptionProcess,HELPER_LIMITS,CaptionHelperError} from './caption-helper-process.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const lock=JSON.parse(await readFile(new URL('./caption-helper-lock.json',import.meta.url),'utf8'));
// -I excludes user site, PYTHONPATH and cwd; only this repository is added back.
const launcher=`import json,sys
if sys.version_info < (3,10):
 print(json.dumps({'status':'python_unsupported'}))
 sys.exit(0)
import importlib.util,importlib.metadata,runpy
# Check only module presence in the explicitly selected isolated interpreter.
# No package install, platform request, credentials, or dependency error text.
missing=[name for name in ('yt_dlp','certifi') if importlib.util.find_spec(name) is None]
if missing:
 print(json.dumps({'status':'dependencies_missing','missing':missing}))
 sys.exit(0)
# Read distribution metadata before importing possibly incompatible package APIs.
try:
 installed=importlib.metadata.version('yt-dlp')
except importlib.metadata.PackageNotFoundError:
 installed=None
if installed is not None and installed.split('.') not in (${JSON.stringify(lock.packages.find(pkg=>pkg.name==='yt-dlp').version.split('.'))},${JSON.stringify(lock.ytDlpVersion.split('.'))}):
 print(json.dumps({'status':'version_mismatch','version':installed}))
 sys.exit(0)
sys.path.insert(0,${JSON.stringify(root)})
sys.argv=[${JSON.stringify(path.join(root,'desktop/helper/caption_helper_launcher.py'))},'--protocol=1']
runpy.run_path(sys.argv[0],run_name='__main__')`;
const fail=(code,message)=>new CaptionHelperError(code,message);
// Owner startup only; never parse this setting from an HTTP/import request.
export function validateCaptionProxy(value){
 if(value===null||value===undefined)return null;
 if(typeof value!=='string')throw fail('CAPTION_PROXY_CONFIGURATION','无效的字幕代理配置');
 const match=/^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?$/.exec(value);
 if(!match||Number(match[2])>65535)throw fail('CAPTION_PROXY_CONFIGURATION','字幕代理仅支持显式本机 HTTP 端口，不能包含凭据');
 return `http://${match[1]}:${match[2]}`;
}
/** Owner startup only. Request JSON cannot name this executable. */
export async function resolvePlayerJsRuntime(env=process.env){
 const explicit=env.COCONUT_DENO;
 const candidates=explicit?[explicit]:typeof env.PATH==='string'?env.PATH.split(':').filter(Boolean).map(dir=>path.join(dir,'deno')):[];
 for(const candidate of candidates){
  if(typeof candidate!=='string'||!path.isAbsolute(candidate)||path.basename(candidate)!=='deno')continue;
  try{await access(candidate,constants.X_OK);return candidate;}catch{/* try the next owner PATH entry */}
 }
 return null;
}
export function createDevelopmentCaptionHelper({python,proxy=null,network=null,bilibiliSession=null,playerRuntime=null,timeoutMs=HELPER_LIMITS.timeoutMs,mediaTimeoutMs=910000,tempRoot=tmpdir(),onSpawn,detached=process.platform!=='win32'}={}){
 if(typeof detached!=='boolean')throw fail('CAPTION_CONFIGURATION','无效的字幕进程组配置');
 if(typeof python!=='string'||!path.isAbsolute(python))throw fail('CAPTION_CONFIGURATION','字幕 Python 必须是已安装解释器的绝对路径');
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>HELPER_LIMITS.timeoutMs)throw fail('CAPTION_LIMIT','无效的字幕助手限制');
 if(!Number.isInteger(mediaTimeoutMs)||mediaTimeoutMs<1||mediaTimeoutMs>910000)throw fail('CAPTION_LIMIT','无效的媒体助手限制');
 const trustedProxy=validateCaptionProxy(proxy);
 const sourceNetwork=validateSourceNetwork(network??(trustedProxy?{mode:'custom',proxy:trustedProxy}:{mode:'direct'}));
 const active=new Set();let closing=false;
 async function execute(input,{signal}={}){
  if(closing||signal?.aborted)throw fail('CAPTION_CANCELLED','字幕请求已取消');
  if(active.size)throw fail('CAPTION_BUSY','已有字幕请求正在运行');
  const controller=new AbortController();let directory;
  const operation=(async()=>{
   try{
    directory=await mkdtemp(path.join(tempRoot,'coconut-dev-caption-'));
    for(const name of ['home','tmp','config','cache','data','empty-bin'])await mkdir(path.join(directory,name),{mode:0o700});
    const output=await runCaptionProcess(python,input,{directory,playerRuntime,signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal,
     timeoutMs:input.operation==='version'?Math.min(timeoutMs,10000):input.operation==='extract-development-audio'?mediaTimeoutMs:timeoutMs,maxOutputBytes:HELPER_LIMITS.outputBytes,onSpawn,detached,args:['-I','-B','-c',launcher]});
    let result;try{result=JSON.parse(output);}catch{throw fail('CAPTION_OUTPUT','字幕助手没有返回完整元数据');}
    if(!result||typeof result!=='object'||Array.isArray(result))throw fail('CAPTION_OUTPUT','字幕助手没有返回完整元数据');
    if(input.operation==='extract-development-audio'&&result.status==='media_ready')result=await readHelperMedia(directory,result);
    return result;
   }finally{if(directory)await rm(directory,{recursive:true,force:true});}
  })();
  active.add(controller);controller.operation=operation;
  try{return await operation;}finally{active.delete(controller);}
 }
 let ready=false,audioReady=false,sourceMediaReady=false;
 return Object.freeze({ownerLocalOnly:true,
  async status({signal}={}){
   ready=false;audioReady=false;sourceMediaReady=false;
   try{
    const r=await execute({operation:'version'},{signal});
    if(r.status==='python_unsupported')return {ready:false,code:'CAPTION_PYTHON_VERSION'};
    if(r.status==='dependencies_missing'){
     const missing=r.missing;
     if(!Array.isArray(missing)||!missing.length||missing.length>2||new Set(missing).size!==missing.length||missing.some(name=>!['yt_dlp','certifi'].includes(name)))throw fail('CAPTION_OUTPUT','字幕依赖诊断无效');
     return {ready:false,code:missing.length===2?'CAPTION_MISSING_DEPENDENCIES':missing[0]==='yt_dlp'?'CAPTION_MISSING_YT_DLP':'CAPTION_MISSING_CERTIFI'};
    }
    if(r.status==='version_mismatch'||r.status==='ok'&&r.version!==lock.ytDlpVersion)return {ready:false,code:'CAPTION_VERSION',expectedVersion:lock.ytDlpVersion,actualVersion:typeof r.version==='string'&&/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(r.version)?r.version:'unknown'};
    if(r.status!=='ok'||r.protocol!==1||r.version!==lock.ytDlpVersion||r.publicExtraction!==true||r.guardProtocol!==1||r.tlsRootsVerified!==true||r.ownerLocalVideoProtocol!==1||JSON.stringify(r.developmentProviders)!==JSON.stringify(['x','youtube','bilibili']))throw fail('CAPTION_VERSION','字幕依赖版本或协议不匹配');
    if(sourceNetwork.mode!=='direct'&&r.developmentProxyProtocol!==1)throw fail('CAPTION_VERSION','字幕代理协议不匹配');
    ready=true;audioReady=r.developmentAudioProtocol===1&&(sourceNetwork.mode==='direct'||r.developmentProxyAudioProtocol===1);sourceMediaReady=audioReady&&r.developmentSourceMediaProtocol===1;return {ready:true,sourceMedia:sourceMediaReady,audioFallback:audioReady,audioProviders:audioReady?['youtube','bilibili']:[],code:'ready',version:r.version,providers:r.developmentProviders,networkMode:sourceNetwork.mode==='direct'?'direct_public':sourceNetwork.mode==='custom'?'trusted_local_proxy':'environment_proxy',ownerLocalOnly:true};
   }catch(error){if(error.code==='CAPTION_CANCELLED')throw error;return {ready:false,code:error.code||'CAPTION_UNAVAILABLE'};}
  },
  async extractCaptions({url,language=null,signal}={}){
   if(!ready)throw fail('CAPTION_UNAVAILABLE','开发字幕助手尚未通过检查');
   const source=captionSource(url);
   if(language!==null&&(typeof language!=='string'||!/^([a-z]{2,3})(-[A-Za-z0-9]{2,8}){0,2}$/.test(language)))throw fail('CAPTION_INPUT','原语言标记无效');
   const cookies=source.provider==='bilibili'?await bilibiliSession?.cookies({signal}):null;
   const r=await execute({operation:'extract-development',url:source.url,language,...(cookies?{bilibiliCookies:cookies}:{}),...(['youtube','bilibili'].includes(source.provider)?{network:sourceNetwork}:{})},{signal});
   if(CAPTION_FAILURE_STATUSES.includes(r.status)){const diagnostic=captionDiagnostic(r.diagnostic);return {status:r.status,...(r.status==='language_required'?{languages:captionLanguages(r.languages)}:{}),...(diagnostic?{diagnostic}:{})};}
   if(r.status!=='ok'||!['vtt','srt'].includes(r.format)||typeof r.captionBase64!=='string'||r.captionBase64.length>Math.ceil(HELPER_LIMITS.captionBytes/3)*4||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.captionBase64))throw fail('CAPTION_OUTPUT','字幕助手输出格式无效');
   const bytes=Buffer.from(r.captionBase64,'base64');
   if(!bytes.length||bytes.length>HELPER_LIMITS.captionBytes||r.format==='vtt'&&!/^\uFEFF?WEBVTT(?:[ \t].*)?\r?\n/.test(bytes.toString('utf8')))throw fail('CAPTION_OUTPUT','字幕文件无效');
   return {source:r.source,track:r.track,format:r.format,bytes};
  },
  async extractAudio({url,language=null,purpose=null,signal}={}){
   if(!ready||!audioReady)throw fail('CAPTION_UNAVAILABLE','开发原声助手尚未通过检查');
   const source=captionSource(url);
   if(!['youtube','bilibili'].includes(source.provider))throw fail('CAPTION_INPUT','此来源不支持公开媒体回退');
   if(language!==null&&(typeof language!=='string'||!/^([a-z]{2,3})(-[A-Za-z0-9]{2,8}){0,2}$/.test(language)))throw fail('CAPTION_INPUT','原语言标记无效');
   if(purpose!==null&&(purpose!=='source'||!sourceMediaReady))throw fail('CAPTION_UNAVAILABLE','当前助手不支持为已有字幕载入原声');
   const cookies=source.provider==='bilibili'?await bilibiliSession?.cookies({signal}):null;
   return execute({operation:'extract-development-audio',url:source.url,language,...(purpose?{purpose}:{}),...(cookies?{bilibiliCookies:cookies}:{}),network:sourceNetwork},{signal});
  },
  shutdown(){closing=true;for(const controller of active)controller.abort();return Promise.allSettled([...active].map(controller=>controller.operation));},
 });
}
