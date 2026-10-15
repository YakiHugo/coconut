/** Opt-in source helper. Never searches PATH, installs dependencies or invokes ASR. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {captionSource} from './caption-service.mjs';
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
export function createDevelopmentCaptionHelper({python,timeoutMs=HELPER_LIMITS.timeoutMs,tempRoot=tmpdir(),onSpawn,detached=process.platform!=='win32'}={}){
 if(typeof detached!=='boolean')throw fail('CAPTION_CONFIGURATION','无效的字幕进程组配置');
 if(typeof python!=='string'||!path.isAbsolute(python))throw fail('CAPTION_CONFIGURATION','字幕 Python 必须是已安装解释器的绝对路径');
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>HELPER_LIMITS.timeoutMs)throw fail('CAPTION_LIMIT','无效的字幕助手限制');
 const active=new Set();let closing=false;
 async function execute(input,{signal}={}){
  if(closing||signal?.aborted)throw fail('CAPTION_CANCELLED','字幕请求已取消');
  if(active.size)throw fail('CAPTION_BUSY','已有字幕请求正在运行');
  const controller=new AbortController();let directory;
  const operation=(async()=>{
   try{
    directory=await mkdtemp(path.join(tempRoot,'coconut-dev-caption-'));
    for(const name of ['home','tmp','config','cache','data','empty-bin'])await mkdir(path.join(directory,name),{mode:0o700});
    const output=await runCaptionProcess(python,input,{directory,signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal,
     timeoutMs:input.operation==='version'?Math.min(timeoutMs,10000):timeoutMs,maxOutputBytes:HELPER_LIMITS.outputBytes,onSpawn,detached,args:['-I','-B','-c',launcher]});
    let result;try{result=JSON.parse(output);}catch{throw fail('CAPTION_OUTPUT','字幕助手没有返回完整元数据');}
    if(!result||typeof result!=='object'||Array.isArray(result))throw fail('CAPTION_OUTPUT','字幕助手没有返回完整元数据');
    return result;
   }finally{if(directory)await rm(directory,{recursive:true,force:true});}
  })();
  active.add(controller);controller.operation=operation;
  try{return await operation;}finally{active.delete(controller);}
 }
 let ready=false;
 return Object.freeze({
  async status({signal}={}){
   ready=false;
   try{
    const r=await execute({operation:'version'},{signal});
    if(r.status==='python_unsupported')return {ready:false,code:'CAPTION_PYTHON_VERSION'};
    if(r.status==='dependencies_missing'){
     const missing=r.missing;
     if(!Array.isArray(missing)||!missing.length||missing.length>2||new Set(missing).size!==missing.length||missing.some(name=>!['yt_dlp','certifi'].includes(name)))throw fail('CAPTION_OUTPUT','字幕依赖诊断无效');
     return {ready:false,code:missing.length===2?'CAPTION_MISSING_DEPENDENCIES':missing[0]==='yt_dlp'?'CAPTION_MISSING_YT_DLP':'CAPTION_MISSING_CERTIFI'};
    }
    if(r.status==='version_mismatch'||r.status==='ok'&&r.version!==lock.ytDlpVersion)return {ready:false,code:'CAPTION_VERSION',expectedVersion:lock.ytDlpVersion,actualVersion:typeof r.version==='string'&&/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(r.version)?r.version:'unknown'};
    if(r.status!=='ok'||r.protocol!==1||r.version!==lock.ytDlpVersion||r.publicExtraction!==true||r.guardProtocol!==1||r.tlsRootsVerified!==true||JSON.stringify(r.developmentProviders)!==JSON.stringify(['x','youtube','bilibili']))throw fail('CAPTION_VERSION','字幕依赖版本或协议不匹配');
    ready=true;return {ready:true,code:'ready',version:r.version,providers:r.developmentProviders};
   }catch(error){if(error.code==='CAPTION_CANCELLED')throw error;return {ready:false,code:error.code||'CAPTION_UNAVAILABLE'};}
  },
  async extractCaptions({url,language=null,signal}={}){
   if(!ready)throw fail('CAPTION_UNAVAILABLE','开发字幕助手尚未通过检查');
   const source=captionSource(url);
   if(language!==null&&(typeof language!=='string'||!/^([a-z]{2,3})(-[A-Za-z0-9]{2,8}){0,2}$/.test(language)))throw fail('CAPTION_INPUT','原语言标记无效');
   const r=await execute({operation:'extract-development',url:source.url,language},{signal});
   if(['unavailable','access_restricted','language_required','network_unavailable','metadata_incomplete'].includes(r.status))return {status:r.status};
   if(r.status!=='ok'||!['vtt','srt'].includes(r.format)||typeof r.captionBase64!=='string'||r.captionBase64.length>Math.ceil(HELPER_LIMITS.captionBytes/3)*4||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.captionBase64))throw fail('CAPTION_OUTPUT','字幕助手输出格式无效');
   const bytes=Buffer.from(r.captionBase64,'base64');
   if(!bytes.length||bytes.length>HELPER_LIMITS.captionBytes||r.format==='vtt'&&!/^\uFEFF?WEBVTT(?:[ \t].*)?\r?\n/.test(bytes.toString('utf8')))throw fail('CAPTION_OUTPUT','字幕文件无效');
   return {source:r.source,track:r.track,format:r.format,bytes};
  },
  shutdown(){closing=true;for(const controller of active)controller.abort();return Promise.allSettled([...active].map(controller=>controller.operation));},
 });
}
