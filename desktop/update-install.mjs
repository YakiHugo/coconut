/** Validate before extraction, stage beside the app, and replace only after its PID exits. */
import {open,mkdtemp,lstat,readdir,realpath,writeFile,rm,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {inflateRawSync} from 'node:zlib';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {verifyFile} from './updater.mjs';
const execute=promisify(execFile);
const inside=(root,item)=>item===root||item.startsWith(root+path.sep);
export async function inspectZip(file){
  const handle=await open(file,'r');
  async function bytes(offset,length){const b=Buffer.alloc(length),r=await handle.read(b,0,length,offset);if(r.bytesRead!==length)throw new Error('ZIP 数据不完整');return b;}
  try{
    const size=(await handle.stat()).size,tail=await bytes(Math.max(0,size-65557),Math.min(size,65557));let end=-1;
    for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
    if(end<0||tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6))throw new Error('不支持的 ZIP 结构');
    const count=tail.readUInt16LE(end+10),length=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
    if(count!==tail.readUInt16LE(end+8)||!count||count>20000||length>8*1024*1024||offset+length!==size-tail.length+end)throw new Error('ZIP 目录超出限制');
    const directory=await bytes(offset,length),entries=[],names=new Set(),foldedNames=new Set();let cursor=0,expanded=0;
    for(let i=0;i<count;i++){
      if(cursor+46>length||directory.readUInt32LE(cursor)!==0x02014b50)throw new Error('ZIP 目录损坏');
      const flags=directory.readUInt16LE(cursor+8),method=directory.readUInt16LE(cursor+10),compressed=directory.readUInt32LE(cursor+20),size=directory.readUInt32LE(cursor+24),n=directory.readUInt16LE(cursor+28),extra=directory.readUInt16LE(cursor+30),comment=directory.readUInt16LE(cursor+32),mode=directory.readUInt32LE(cursor+38)>>>16,local=directory.readUInt32LE(cursor+42);
      if(cursor+46+n+extra+comment>length||flags&1||![0,8].includes(method)||directory.readUInt16LE(cursor+34)!==0||local>=offset)throw new Error('不支持的 ZIP 条目');
      const name=directory.subarray(cursor+46,cursor+46+n).toString('utf8'),normalized=name.replace(/\/$/,'');
      const folded=normalized.normalize('NFC').toLowerCase();
      if(!/^Coconut\.app(?:\/|$)/.test(name)||/[\x00-\x1f\x7f\\]/.test(name)||name.includes('\ufffd')||name.split('/').some(part=>part==='..'||part==='.')||name.includes('//')||foldedNames.has(folded))throw new Error('ZIP 含非法路径或重复条目');
      const kind=mode&0xf000;if(![0,0x4000,0x8000,0xa000].includes(kind))throw new Error('ZIP 含特殊文件');
      expanded+=size;if(expanded>2*1024*1024*1024)throw new Error('ZIP 解压大小超出限制');names.add(normalized);foldedNames.add(folded);
      entries.push({name:normalized,link:kind===0xa000,method,compressed,size,local,rawName:name});cursor+=46+n+extra+comment;
    }
    if(cursor!==length||!names.has('Coconut.app/Contents/Info.plist')||!names.has('Coconut.app/Contents/MacOS/Coconut')||!names.has('Coconut.app/Contents/Resources/app.asar'))throw new Error('ZIP 缺少完整 Coconut 应用');
    for(const entry of entries){
      const header=await bytes(entry.local,30);
      if(header.readUInt32LE(0)!==0x04034b50||header.readUInt16LE(8)!==entry.method||(header.readUInt16LE(6)&1))throw new Error('ZIP 本地条目不一致');
      const n=header.readUInt16LE(26),extra=header.readUInt16LE(28),start=entry.local+30+n+extra;
      if(start+entry.compressed>offset||(await bytes(entry.local+30,n)).toString('utf8')!==entry.rawName)throw new Error('ZIP 本地路径不一致');
      if(!entry.link)continue;
      if(entry.size>4096||entry.compressed>8192)throw new Error('ZIP 符号链接过长');
      const packed=await bytes(start,entry.compressed),target=(entry.method===0?packed:inflateRawSync(packed,{maxOutputLength:4096})).toString('utf8');
      const resolved=path.posix.resolve('/',path.posix.dirname(entry.name),target);
      if(!target||target.startsWith('/')||/[\x00-\x1f\x7f\\]/.test(target)||!inside('/Coconut.app',resolved)||entries.some(other=>other.name.normalize('NFC').toLowerCase().startsWith(entry.name.normalize('NFC').toLowerCase()+'/')))throw new Error('ZIP 符号链接逃逸或覆盖目录');
    }
    return entries.length;
  }finally{await handle.close();}
}
async function checkTree(root,current=root){
  for(const name of await readdir(current)){
    const item=path.join(current,name),s=await lstat(item);
    if(s.isSymbolicLink()){if(!inside(root,await realpath(item)))throw new Error('应用符号链接指向安装目录之外');}
    else if(s.isDirectory())await checkTree(root,item);
    else if(!s.isFile())throw new Error('应用含特殊文件');
  }
}
export function shellQuote(value){if(typeof value!=='string'||value.includes('\0'))throw new Error('无效路径');return "'"+value.replaceAll("'","'\\''")+"'";}
export function recoveryScript({pid,target,backup,lock,launcher='/usr/bin/open'}){
  if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('无效进程');
  const helper=path.join(path.dirname(lock),'helper.pid');
  return `#!/bin/sh\nset -eu\nif /bin/kill -0 ${pid} 2>/dev/null; then printf '%s\\n' 'Coconut 仍在运行，请先完成工作并正常退出。'; exit 1; fi\nhelper=''\nif [ -f ${shellQuote(helper)} ]; then helper=$(/bin/cat ${shellQuote(helper)}); fi\ncase "$helper" in ''|*[!0-9]*) ;; *) if /bin/kill -0 "$helper" 2>/dev/null; then printf '%s\\n' '更新安装仍在进行，请等待助手退出后再恢复。'; exit 1; fi ;; esac\nif [ ! -e ${shellQuote(target)} ] && [ -d ${shellQuote(backup)} ]; then /bin/mv ${shellQuote(backup)} ${shellQuote(target)}; fi\n/bin/rm -f ${shellQuote(lock)} ${shellQuote(helper)}\n${shellQuote(launcher)} ${shellQuote(target)}\n`;
}
export function installerScript({pid,target,staged,backup,result,lock=path.join(path.dirname(result),'install-lock.json'),launcher='/usr/bin/open'}){
  if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('无效进程');
  const q=shellQuote;
  return `#!/bin/sh
set -eu
target=${q(target)}
staged=${q(staged)}
backup=${q(backup)}
result=${q(result)}
lock=${q(lock)}
helper=${q(path.join(path.dirname(lock),'helper.pid'))}
trap '/bin/rm -f "$lock" "$helper"' EXIT
write_result() { printf '%s\\n' "$1" > "$result.tmp"; /bin/mv -f "$result.tmp" "$result"; }
# Never kill the application. If it has not quit, leave both versions intact.
count=0
while /bin/kill -0 ${pid} 2>/dev/null; do
  count=$((count + 1))
  if [ "$count" -ge 60 ]; then write_result failed; exit 1; fi
  /bin/sleep 1
done
restore() {
  if [ ! -e "$target" ] && [ -d "$backup" ]; then /bin/mv "$backup" "$target" || true; fi
  write_result failed
}
trap 'restore; exit 1' HUP INT TERM
if [ ! -d "$target" ] || [ ! -d "$staged" ] || [ -e "$backup" ]; then write_result failed; exit 1; fi
write_result replacing
if ! /bin/mv "$target" "$backup"; then write_result failed; exit 1; fi
if ! /bin/mv "$staged" "$target"; then restore; exit 1; fi
write_result installed
# Launch Services/Gatekeeper decides whether the downloaded app may run.
if ! ${q(launcher)} "$target"; then write_result launch-needs-attention; exit 1; fi
`;
}
export async function startInstaller({directory,version,script,write=writeFile,launch=spawn}){
  const lock=path.join(directory,'install-lock.json'),helper=path.join(directory,'helper.pid');let child;
  await write(lock,JSON.stringify({version,expires:Date.now()+5*60*1000}),{mode:0o600});
  try{
    await new Promise((resolve,reject)=>{
      child=launch('/bin/sh',[script],{detached:true,stdio:'ignore'});child.once('error',reject);
      child.once('spawn',async()=>{
        try{await write(helper,String(child.pid),{mode:0o600});await write(lock,JSON.stringify({version,helperPid:child.pid,expires:Date.now()+5*60*1000}),{mode:0o600});child.unref();resolve();}catch(error){reject(error);}
      });
    });
  }catch(error){
    // The app is still running here. Stop only our failed helper and wait for
    // its exit before unlocking, so an orphan cannot install after a retry.
    if(child?.pid&&child.exitCode===null&&child.signalCode===null){
      await new Promise(resolve=>{child.once('close',resolve);child.kill('SIGTERM');});
    }
    await rm(lock,{force:true});await rm(helper,{force:true});throw error;
  }
}
export async function prepareInstall({directory,release,appPath,version,arch,pid=process.pid}){
  const target=path.resolve(appPath);
  const parent=path.dirname(target);
  if(path.basename(target)!=='Coconut.app'||![path.join(os.homedir(),'Applications'),'/Applications'].includes(parent))throw new Error('请先把 Coconut 移到个人 Applications 文件夹后再安装更新');
  const current=await lstat(target);if(!current.isDirectory()||current.isSymbolicLink()||current.uid!==process.getuid())throw new Error('当前应用不是可安全替换的个人安装');
  await access(parent,constants.W_OK);
  const archive=path.join(directory,'update.zip');await verifyFile(archive,release.zip);await inspectZip(archive);
  const stage=await mkdtemp(path.join(parent,'.Coconut-update-')),staged=path.join(stage,'Coconut.app');
  try{
    await execute('/usr/bin/ditto',['-x','-k',archive,stage],{timeout:120000});await checkTree(staged);
    const plist=path.join(staged,'Contents/Info.plist');
    const field=async key=>(await execute('/usr/libexec/PlistBuddy',['-c','Print :'+key,plist])).stdout.trim();
    if(await field('CFBundleIdentifier')!=='io.github.yakihugo.coconut'||await field('CFBundleShortVersionString')!==release.version||await field('CFBundleExecutable')!=='Coconut')throw new Error('安装包身份或版本不匹配');
    const architectures=(await execute('/usr/bin/lipo',['-archs',path.join(staged,'Contents/MacOS/Coconut')])).stdout.trim().split(/\s+/);
    if(architectures.length!==1||architectures[0]!==({arm64:'arm64',x64:'x86_64'})[arch])throw new Error('安装包实际架构不匹配');
    // Node HTTPS is not a browser download. Explicitly retain quarantine so
    // the custom installer cannot turn an unsigned download into trusted code.
    await execute('/usr/bin/xattr',['-w','com.apple.quarantine',`0083;${Math.floor(Date.now()/1000).toString(16)};Coconut;`,staged]);
    const backup=path.join(parent,`Coconut.previous-${version}-${Date.now()}.app`),result=path.join(directory,'install-result');
    const transaction={target,staged,backup,version:release.version};
    await writeFile(path.join(directory,'transaction.json'),JSON.stringify(transaction),{mode:0o600});
    const script=path.join(directory,'install.sh');await writeFile(script,installerScript({pid,target,staged,backup,result}),{mode:0o700});
    const recovery=path.join(directory,'recover.command');
    await writeFile(recovery,recoveryScript({pid,target,backup,lock:path.join(directory,'install-lock.json')}),{mode:0o700});
    return {backup,async discard(){await rm(stage,{recursive:true,force:true});},start:()=>startInstaller({directory,version:release.version,script})};
  }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
}
