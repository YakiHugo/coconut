import {spawn} from 'node:child_process';
import {readFile,readdir,lstat,realpath,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const profileId=value=>typeof value==='string'&&/^(Default|Profile [0-9]{1,4})$/.test(value);
const reader=fileURLToPath(new URL('../scripts/bilibili_browser_session.py',import.meta.url));
const messages={not_logged_in:'这个 Edge 配置中没有有效的 B 站登录态。请先在该配置中登录 B 站，再连接。',unsupported:'当前仅支持 macOS 上的 Edge。',unavailable:'无法读取 Edge 登录态。请检查 Edge 配置及系统钥匙串授权后重试。'};
const fail=(code)=>Object.assign(new Error(messages[code]||messages.unavailable),{code:'BILIBILI_SESSION_UNAVAILABLE'});

export function readEdgeSession(python,database,{signal}={}){
 return new Promise((resolve,reject)=>{
  let settled=false,size=0;const chunks=[];
  const child=spawn(python,['-I','-B',reader],{shell:false,detached:process.platform!=='win32',env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',PYTHONNOUSERSITE:'1'},stdio:['pipe','pipe','pipe']});
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const abort=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}finish(fail('unavailable'));};
  const timer=setTimeout(abort,40000);
  child.stdout.on('data',bytes=>{size+=bytes.length;if(size>16384)abort();else chunks.push(bytes);});
  child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
  child.once('error',()=>finish(fail('unavailable')));
  child.once('close',code=>{
   if(settled)return;
   try{
    if(code!==0)throw fail('unavailable');
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(result.status!=='ready')throw fail(result.status);
    const cookies=result.cookies;
    if(!cookies||typeof cookies.SESSDATA!=='string'||!cookies.SESSDATA||Object.entries(cookies).some(([name,value])=>!['SESSDATA','bili_jct','DedeUserID'].includes(name)||typeof value!=='string'||!value||value.length>4096||!/^[\x21-\x7e]+$/.test(value)||/[;,"\\]/.test(value))||Object.values(cookies).reduce((sum,value)=>sum+value.length,0)>6000)throw fail('unavailable');
    finish(null,cookies);
   }catch(error){finish(error.code==='BILIBILI_SESSION_UNAVAILABLE'?error:fail('unavailable'));}
  });
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();else child.stdin.end(JSON.stringify({database}));
 });
}

export async function createBilibiliBrowserSession({python,configuration,edgeDirectory=path.join(homedir(),'Library/Application Support/Microsoft Edge'),platform=process.platform,readSession=readEdgeSession}={}){
 let selected=null,generation=0,busy=false,saving=Promise.resolve();
 const supported=platform==='darwin'&&typeof python==='string'&&path.isAbsolute(python);
 async function profiles(){
  if(!supported)return [];
  try{return (await readdir(edgeDirectory,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&profileId(entry.name)).map(entry=>({id:entry.name,label:entry.name==='Default'?'Edge 默认配置':`Edge ${entry.name}`})).sort((a,b)=>a.id.localeCompare(b.id));}catch{return [];}
 }
 async function database(id){
  if(!profileId(id)||!(await profiles()).some(profile=>profile.id===id))throw fail('unavailable');
  const base=await realpath(edgeDirectory),directory=path.join(base,id);
  if((await lstat(directory)).isSymbolicLink())throw fail('unavailable');
  for(const name of ['Cookies','Network/Cookies']){
   const candidate=path.join(directory,name);
   try{const resolved=await realpath(candidate);if(!resolved.startsWith(directory+path.sep)||(await lstat(candidate)).isSymbolicLink()||!(await lstat(candidate)).isFile())continue;return resolved;}catch{}
  }
  throw fail('unavailable');
 }
 if(supported&&configuration){try{const saved=JSON.parse(await readFile(configuration,'utf8'));if(saved.browser==='edge'&&profileId(saved.profile))selected=saved.profile;}catch{}}
 function save(profile){
  const operation=saving.catch(()=>{}).then(async()=>{
  if(!configuration)return;
  if(!profile){await rm(configuration,{force:true});return;}
  await mkdir(path.dirname(configuration),{recursive:true,mode:0o700});
  const temporary=configuration+'.tmp';
  await writeFile(temporary,JSON.stringify({browser:'edge',profile}),{mode:0o600});await rename(temporary,configuration);
  });saving=operation;return operation;
 }
 return {
  async status(){return {supported,browser:'edge',connected:!!selected,profile:selected,profiles:await profiles()};},
  async connect(id,{signal}={}){
   if(!supported)throw fail('unsupported');if(busy)throw Object.assign(new Error('正在连接 Edge，请稍候。'),{status:409});
   busy=true;const version=++generation;
   try{await readSession(python,await database(id),{signal});if(version!==generation)throw fail('unavailable');await save(id);if(version!==generation)throw fail('unavailable');selected=id;return await this.status();}catch(error){throw error.code==='BILIBILI_SESSION_UNAVAILABLE'?error:fail('unavailable');}finally{busy=false;}
  },
  async disconnect(){generation++;selected=null;await save(null);return await this.status();},
  async cookies({signal}={}){
   const id=selected,version=generation;if(!id)return null;
   let cookies;try{cookies=await readSession(python,await database(id),{signal});}catch(error){throw error.code==='BILIBILI_SESSION_UNAVAILABLE'?error:fail('unavailable');}
   if(version!==generation||selected!==id)throw fail('unavailable');return cookies;
  },
 };
}
