/**
 * Only pinned bytes, two fixed operations, no inherited credentials or shell.
 * The authored-fixture operation is an internal CI seam, never a bridge route.
 * This is process hygiene, not an OS sandbox or a public-network policy.
 */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open, readFile, mkdir, mkdtemp, writeFile, rm, lstat, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const lock = JSON.parse(await readFile(new URL('./caption-helper-lock.json',import.meta.url),'utf8'));
export const HELPER_LIMITS = Object.freeze({timeoutMs:130000, outputBytes:1500000, captionBytes:1024*1024, concurrency:1});
let active = false;

export class CaptionHelperError extends Error {
  constructor(code,message) { super(message); this.name='CaptionHelperError'; this.code=code; }
}
const fail = (code,message) => new CaptionHelperError(code,message);
function cancelled(signal) { if (signal?.aborted) throw fail('CAPTION_CANCELLED','字幕请求已取消'); }
export function helperEnvironment(directory) {
  // Intentionally do not read process.env. No PATH lookup, proxy, netrc, Python,
  // TLS override, loader injection, Electron or authentication variables pass.
  return {HOME:path.join(directory,'home'), XDG_CONFIG_HOME:path.join(directory,'config'),
    XDG_CACHE_HOME:path.join(directory,'cache'), XDG_DATA_HOME:path.join(directory,'data'),
    TMPDIR:path.join(directory,'tmp'), TMP:path.join(directory,'tmp'), TEMP:path.join(directory,'tmp'),
    PATH:path.join(directory,'empty-bin'), LANG:'en_US.UTF-8', LC_ALL:'en_US.UTF-8',
    PYTHONNOUSERSITE:'1', PYTHONSAFEPATH:'1'};
}
export async function verifiedHelperBytes(resourcesPath, artifact) {
  if (typeof resourcesPath!=='string' || !path.isAbsolute(resourcesPath) || !artifact || artifact.name!=='coconut-caption' ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes<1 || artifact.bytes>80*1024*1024 ||
      artifact.protocol!==1 || artifact.ytDlpVersion!==lock.ytDlpVersion || artifact.platform!==process.platform || artifact.arch!==process.arch) {
    throw fail('CAPTION_UNAVAILABLE','缺少已固定的应用字幕资源');
  }
  const directory=path.join(resourcesPath,'caption-helper');let handle;
  try {
    const parent=await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw fail('CAPTION_INTEGRITY','字幕助手资源不是普通目录');
    handle=await open(path.join(directory,artifact.name),constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat=await handle.stat();
    if (!stat.isFile() || stat.size!==artifact.bytes) throw fail('CAPTION_INTEGRITY','字幕助手大小校验失败');
    const bytes=await handle.readFile();
    if (bytes.length!==artifact.bytes || createHash('sha256').update(bytes).digest('hex')!==artifact.sha256) throw fail('CAPTION_INTEGRITY','字幕助手完整性校验失败');
    return bytes;
  } catch(error) {
    if(error instanceof CaptionHelperError)throw error;
    throw fail(error.code==='ENOENT'?'CAPTION_UNAVAILABLE':'CAPTION_INTEGRITY','字幕助手不可用或完整性校验失败');
  } finally {await handle?.close();}
}

function fixtureEndpoint(value) {
  let url;try{url=new URL(value);}catch{throw fail('CAPTION_FIXTURE','无效的本地证明夹具');}
  if (url.protocol!=='http:' || url.hostname!=='127.0.0.1' || !/^\d+$/.test(url.port) || url.username || url.password ||
      url.search || url.hash || !['/authored.vtt','/slow.vtt','/oversized.vtt'].includes(url.pathname))throw fail('CAPTION_FIXTURE','证明夹具仅可使用固定回环字幕路径');
  return url.href;
}

function runProcess(executable,input,{directory,signal,timeoutMs,maxOutputBytes,onSpawn,spawnProcess=spawn}) {
  return new Promise((resolve,reject)=>{
    let child, timer, monitor, reading=false, firstError, closed=false, outputBytes=0;
    const chunks=[];
    const stop=error=>{
      firstError ||= error;
      if (!child || closed) return;
      try {if(process.platform!=='win32' && child.pid)process.kill(-child.pid,'SIGKILL'); else child.kill('SIGKILL');}
      catch {try{child.kill('SIGKILL');}catch{}}
    };
    const abort=()=>stop(fail('CAPTION_CANCELLED','字幕请求已取消'));
    const finish=(error,result)=>{
      if(closed)return;closed=true;clearTimeout(timer);clearInterval(monitor);signal?.removeEventListener('abort',abort);
      error?reject(error):resolve(result);
    };
    try {
      cancelled(signal);
      child=spawnProcess(executable,['--protocol=1'],{cwd:directory,env:helperEnvironment(directory),shell:false,
        stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
    } catch(error) {finish(error instanceof CaptionHelperError?error:fail('CAPTION_START','无法启动字幕助手'));return;}
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>stop(fail('CAPTION_TIMEOUT','字幕助手超时，未保存不完整结果')),timeoutMs);
    // Avoid holding the concurrency slot or deleting its extraction directory
    // until the process group was killed and Node observed child close.
    child.once('error',()=>{firstError ||= fail('CAPTION_START','无法启动字幕助手');});
    child.once('close',code=>finish(firstError || (code!==0?fail('CAPTION_EXIT','字幕助手未完成，未保存不完整结果'):null),Buffer.concat(chunks).toString('utf8')));
    for(const [stream,capture] of [[child.stdout,true],[child.stderr,false]]) {
      stream.on('data',chunk=>{
        outputBytes+=chunk.length;
        if(outputBytes>maxOutputBytes){stop(fail('CAPTION_OUTPUT_LIMIT','字幕助手输出超过安全限制'));return;}
        if(capture)chunks.push(chunk);
      });
    }
    monitor=setInterval(async()=>{
      if(reading||closed)return;reading=true;
      try {
        const entries=await readdir(directory,{withFileTypes:true});
        for(const entry of entries) {
          if(entry.name==='caption.en.vtt' || entry.name==='caption.en.vtt.part') {
            const stat=await lstat(path.join(directory,entry.name));
            if(!stat.isFile() || stat.size>HELPER_LIMITS.captionBytes)stop(fail('CAPTION_FILE_LIMIT','字幕文件超过安全限制'));
          }
        }
      } catch(error) {if(!closed)stop(fail('CAPTION_OUTPUT','无法验证字幕临时文件'));}
      finally {reading=false;}
    },25);
    if(signal?.aborted)abort();
    try{onSpawn?.({pid:child.pid,directory,env:helperEnvironment(directory)});}catch{stop(fail('CAPTION_START','字幕助手证明回调失败'));}
  });
}

/** Internal-only test hooks cannot be supplied through the bridge or renderer. */
export async function runPinnedCaptionHelper({resourcesPath,artifact,operation,fixtureUrl,url,language=null,signal,
  timeoutMs=HELPER_LIMITS.timeoutMs,maxOutputBytes=HELPER_LIMITS.outputBytes,onSpawn,
  tempRoot=tmpdir(),spawnProcess=spawn}={}) {
  if(!['version','authored-fixture','extract'].includes(operation))throw fail('CAPTION_OPERATION','不支持的字幕助手操作');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>HELPER_LIMITS.timeoutMs ||
      !Number.isInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>HELPER_LIMITS.outputBytes)throw fail('CAPTION_LIMIT','无效的字幕助手限制');
  let input={operation};
  if(operation==='authored-fixture')input.endpoint=fixtureEndpoint(fixtureUrl);
  if(operation==='extract') {
    if(typeof url!=='string' || !/^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/(?:[A-Za-z0-9_]{1,30}|i)\/status\/\d{1,20}$/.test(url) ||
        (language!==null && (typeof language!=='string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(language))))throw fail('CAPTION_INPUT','仅支持公开 X 单条视频链接和有效原语');
    input={operation,url,language};
  }
  cancelled(signal);
  if(active)throw fail('CAPTION_BUSY','已有字幕请求正在运行');
  active=true;let directory;
  try {
    const bytes=await verifiedHelperBytes(resourcesPath,artifact);cancelled(signal);
    directory=await mkdtemp(path.join(tempRoot,'coconut-caption-'));
    for(const name of ['home','tmp','config','cache','data','empty-bin','bin'])await mkdir(path.join(directory,name),{mode:0o700});
    // Execute a private verified snapshot, closing the resource hash-to-exec race.
    const executable=path.join(directory,'bin','coconut-caption');
    await writeFile(executable,bytes,{mode:0o500,flag:'wx'});
    const stdout=await runProcess(executable,input,{directory,signal,timeoutMs,maxOutputBytes,onSpawn,spawnProcess});
    cancelled(signal);let result;
    try{result=JSON.parse(stdout);}catch{throw fail('CAPTION_OUTPUT','字幕助手没有返回完整元数据');}
    if(operation==='extract' && ['unavailable','access_restricted','language_required'].includes(result.status))return {status:result.status};
    if(result.status!=='ok')throw fail('CAPTION_UNAVAILABLE','字幕助手未返回完整原语字幕');
    if(operation==='version') {
      if(result.protocol!==1 || result.version!==lock.ytDlpVersion || result.python!==artifact.python || result.publicExtraction!==true)throw fail('CAPTION_VERSION','字幕助手版本不匹配');
      return {version:result.version,python:result.python,protocol:1};
    }
    if(!result.source || typeof result.source.title!=='string' || result.source.title.length>1000 ||
       typeof result.source.url!=='string' || typeof result.source.id!=='string' || result.source.id.length>100 ||
       typeof result.source.language!=='string' || typeof result.source.automatic!=='boolean' ||
       result.source.translated!==false || result.source.live!==false ||
       !Number.isFinite(result.source.duration) || result.source.duration<=0 || result.source.duration>21600 ||
       result.track?.language!==result.source.language || result.format!=='vtt' ||
       typeof result.captionBase64!=='string' || result.captionBase64.length>Math.ceil(HELPER_LIMITS.captionBytes/3)*4 ||
       !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.captionBase64))throw fail('CAPTION_OUTPUT','字幕助手没有返回预期原语字幕');
    if(operation==='authored-fixture' && (result.source.id!=='coconut-authored-proof' || result.source.language!=='en'))throw fail('CAPTION_OUTPUT','字幕助手没有返回预期证明字幕');
    if(operation==='extract' && (result.source.url!==url || !/^\d{1,20}$/.test(result.source.id)))throw fail('CAPTION_OUTPUT','字幕助手返回来源不匹配');
    const body=Buffer.from(result.captionBase64,'base64');
    if(!body.length || body.length>HELPER_LIMITS.captionBytes || !/^\uFEFF?WEBVTT(?:[ \t].*)?\r?\n/.test(body.toString('utf8')))throw fail('CAPTION_OUTPUT','字幕文件无效');
    const allowed=new Set(['home','tmp','config','cache','data','empty-bin','bin','caption.en.vtt']);
    if((await readdir(directory)).some(name=>!allowed.has(name)))throw fail('CAPTION_OUTPUT','字幕助手写入了未允许的文件');
    return {source:result.source,track:result.track,bytes:body,format:'vtt'};
  } finally {try{if(directory)await rm(directory,{recursive:true,force:true});}finally{active=false;}}
}
