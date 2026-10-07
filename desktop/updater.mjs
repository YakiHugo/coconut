/** Verified unsigned developer ZIP updates. No Squirrel, credentials, or security overrides. */
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,open} from 'node:fs/promises';
import path from 'node:path';
import {updateText,updateResponse} from './update-http.mjs';
export const REPOSITORY='https://github.com/YakiHugo/coconut';
const API='https://api.github.com/repos/YakiHugo/coconut/releases?per_page=100';
const INTERVAL=6*60*60*1000,MAX_ZIP=600*1024*1024;
export function versionParts(value){
  if(typeof value!=='string'||!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))return null;
  const parts=value.replace(/^v/,'').split('.').map(Number);
  return parts.every(Number.isSafeInteger)?parts:null;
}
export function compareVersions(left,right){
  const a=versionParts(left),b=versionParts(right);
  if(!a||!b)throw new Error('不支持的版本号');
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i]?1:-1;
  return 0;
}
function officialAsset(asset,tag,name){
  return asset?.name===name&&asset.browser_download_url===`${REPOSITORY}/releases/download/${tag}/${name}`&&
    Number.isSafeInteger(asset.size)&&asset.size>0&&/^sha256:[a-f0-9]{64}$/.test(asset.digest||'');
}
export function selectRelease(releases,{version,arch,developer=false}){
  if(!['arm64','x64'].includes(arch)||!Array.isArray(releases)||!versionParts(version))throw new Error('当前架构或发布信息不受支持');
  const candidates=releases.filter(r=>r&&!r.draft&&(!r.prerelease||developer)&&versionParts(r.tag_name)&&
    r.tag_name.startsWith('v')&&r.html_url===`${REPOSITORY}/releases/tag/${r.tag_name}`&&compareVersions(r.tag_name,version)>0)
    .sort((a,b)=>compareVersions(b.tag_name,a.tag_name));
  const release=candidates[0];if(!release)return null;
  const next=release.tag_name.slice(1),name=`Coconut-${next}-${arch}-unsigned.zip`;
  const assets=release.assets||[],zip=assets.filter(a=>a.name===name),sums=assets.filter(a=>a.name==='SHA256SUMS.txt');
  if(zip.length!==1||sums.length!==1||!officialAsset(zip[0],release.tag_name,name)||!officialAsset(sums[0],release.tag_name,'SHA256SUMS.txt')||zip[0].size>MAX_ZIP||sums[0].size>16384)throw new Error('新版本缺少匹配架构或可信校验文件，请稍后重试');
  return {version:next,arch,prerelease:!!release.prerelease,url:release.html_url,zip:zip[0],sums:sums[0]};
}
export function checksumFor(text,name){
  const lines=text.trim().split(/\r?\n/),matches=lines.map(line=>line.match(/^([a-f0-9]{64})  (Coconut-\d+\.\d+\.\d+-(?:arm64|x64)-unsigned\.zip)$/)).filter(m=>m?.[2]===name);
  if(matches.length!==1)throw new Error('SHA256SUMS 不含唯一匹配的安装包');return matches[0][1];
}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function verifyFile(file,asset){
  const handle=await open(file,'r');let size=0;const hash=createHash('sha256');
  try{for await(const chunk of handle.createReadStream({autoClose:false})){size+=chunk.length;hash.update(chunk);}}
  finally{await handle.close();}
  if(size!==asset.size||hash.digest('hex')!==asset.digest.slice(7))throw new Error('安装包完整性验证失败，已停止安装');
}
export class Updater extends EventEmitter{
  constructor({directory,version,arch=process.arch,platform=process.platform,text=updateText,response=updateResponse,now=Date.now}){
    super();Object.assign(this,{directory,version,arch,platform,text,response,now});
    this.settings={developer:false,lastCheck:0};this.state={status:'idle',version,arch,developer:false,message:'启动后自动检查，每 6 小时最多一次。开发版需单独启用。'};
  }
  snapshot(){return {...this.state};}
  change(state){this.state={...this.state,...state};this.emit('state',this.snapshot());return this.snapshot();}
  async persist(){await mkdir(this.directory,{recursive:true,mode:0o700});const file=path.join(this.directory,'settings.json');await writeFile(file+'.tmp',JSON.stringify(this.settings),{mode:0o600});await rename(file+'.tmp',file);}
  async initialize(){
    await mkdir(this.directory,{recursive:true,mode:0o700});
    try{const s=JSON.parse(await readFile(path.join(this.directory,'settings.json'),'utf8'));this.settings={developer:s.developer===true,lastCheck:Number.isFinite(s.lastCheck)&&s.lastCheck<=this.now()?s.lastCheck:0};}catch{}
    this.change({developer:this.settings.developer});
    try{
      const pending=JSON.parse(await readFile(path.join(this.directory,'pending.json'),'utf8'));
      // Treat persisted metadata as untrusted. URLs and architecture must pass the same release validation.
      const candidate=selectRelease([{tag_name:'v'+pending.version,html_url:pending.url,prerelease:pending.prerelease,assets:[pending.zip,pending.sums]}],{version:this.version,arch:this.arch,developer:this.settings.developer});
      if(candidate){await verifyFile(path.join(this.directory,'update.zip'),candidate.zip);this.release=candidate;this.change({status:'ready',nextVersion:candidate.version,message:'下载已恢复并重新校验，可以安装并重启。'});}
      else await rm(path.join(this.directory,'pending.json'),{force:true});
    }catch(error){if(error.code!=='ENOENT'){await rm(path.join(this.directory,'pending.json'),{force:true});this.change({status:'error',message:'上次下载未通过校验，请重新检查并下载。'});}}
    try{const result=await readFile(path.join(this.directory,'install-result'),'utf8');if(result.trim()==='failed')this.change({status:'error',message:'上次替换失败，旧应用已保留；请重新下载重试。'});else if(result.trim()==='launch-needs-attention')this.change({message:'应用已替换；macOS 可能仍需你完成安全确认，旧版本已保留。'});}catch{}
    return this.snapshot();
  }
  async setDeveloper(enabled){
    if(typeof enabled!=='boolean')throw new Error('无效更新频道');
    if(this.operation||this.state.status==='installing')throw new Error('请先取消或完成当前更新');
    this.operation=new AbortController();
    try{
      this.settings.developer=enabled;this.settings.lastCheck=0;this.release=null;
      await rm(path.join(this.directory,'pending.json'),{force:true});await this.persist();
      return this.change({developer:enabled,status:'idle',nextVersion:null,message:enabled?'已启用未签名开发版；仍需下载校验和重启确认。':'只检查正式版本。'});
    }finally{this.operation=null;}
  }
  async check({manual=false}={}){
    if(this.operation||['ready','installing'].includes(this.state.status))return this.snapshot();
    if(this.platform!=='darwin')return this.change({status:'error',message:'当前自动安装仅支持 macOS。'});
    if(!manual&&this.settings.lastCheck&&this.now()-this.settings.lastCheck<INTERVAL)return this.snapshot();
    this.operation=new AbortController();const signal=AbortSignal.any([this.operation.signal,AbortSignal.timeout(30000)]);
    this.change({status:'checking',message:'正在检查官方 GitHub 发布…',nextVersion:null});
    try{
      this.settings.lastCheck=this.now();await this.persist();
      this.release=selectRelease(JSON.parse(await this.text(API,{signal})),{version:this.version,arch:this.arch,developer:this.settings.developer});
      return this.release?this.change({status:'available',nextVersion:this.release.version,message:`发现 ${this.release.version}，下载后会验证完整性。`}):this.change({status:'current',message:this.settings.developer?'当前已是最新可用版本。':'没有更新的正式版本；未签名开发版需要启用开发版频道。'});
    }catch(error){return this.change({status:this.operation.signal.aborted?'cancelled':'error',message:this.operation.signal.aborted?'已取消检查，可以重试。':'检查失败：'+error.message+'。可以重试。'});}
    finally{this.operation=null;}
  }
  async download(){
    if(this.operation||!this.release||!['available','error','cancelled'].includes(this.state.status))return this.snapshot();
    const release=this.release;this.operation=new AbortController();const signal=AbortSignal.any([this.operation.signal,AbortSignal.timeout(15*60*1000)]);
    const file=path.join(this.directory,'update.zip'),partial=file+'.part';let stream;
    this.change({status:'downloading',progress:0,message:'正在下载官方安装包…'});
    try{
      const sums=await this.text(release.sums.browser_download_url,{signal,maxBytes:16384});
      if(Buffer.byteLength(sums)!==release.sums.size||digest(sums)!==release.sums.digest.slice(7)||checksumFor(sums,release.zip.name)!==release.zip.digest.slice(7))throw new Error('官方 checksum 与 GitHub asset digest 不一致');
      stream=await this.response(release.zip.browser_download_url,{signal});let received=0;const hash=createHash('sha256');
      const handle=await open(partial,'w',0o600);
      try{for await(const chunk of stream){signal.throwIfAborted();received+=chunk.length;if(received>release.zip.size||received>MAX_ZIP)throw new Error('安装包大小超过发布声明');hash.update(chunk);await handle.writeFile(chunk);const progress=Math.floor(received/release.zip.size*100);if(progress!==this.state.progress)this.change({progress});}}
      finally{await handle.close();}
      signal.throwIfAborted();
      if(received!==release.zip.size||hash.digest('hex')!==release.zip.digest.slice(7))throw new Error('安装包完整性验证失败');
      await rename(partial,file);await writeFile(path.join(this.directory,'pending.json.tmp'),JSON.stringify(release),{mode:0o600});await rename(path.join(this.directory,'pending.json.tmp'),path.join(this.directory,'pending.json'));
      return this.change({status:'ready',progress:100,message:'下载与双重 SHA256 校验通过。安装前会保存书架并确认重启。'});
    }catch(error){await rm(partial,{force:true});return this.change({status:this.operation.signal.aborted?'cancelled':'error',message:this.operation.signal.aborted?'已取消下载，可以重新下载。':'下载失败：'+error.message+'。可以重试。'});}
    finally{stream?.destroy();this.operation=null;}
  }
  cancel(){this.operation?.abort();return this.snapshot();}
}
