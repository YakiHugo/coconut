/** Text-only local CLI adapters for transcript review. Credentials stay in CLIs. */
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {createProviders,runCommand,safeEnvironment} from './providers.mjs';

export function createReviewProviders({codex=createProviders(),run=runCommand,environment=process.env,findKimi}={}){
 const env=safeEnvironment(environment);
 env.PATH=[env.PATH,path.join(homedir(),'.kimi-code','bin')].join(path.delimiter);
 const find=async()=>{if(findKimi)return findKimi();for(const directory of env.PATH.split(path.delimiter)){const file=path.join(directory,'kimi');try{await access(file,constants.X_OK);return file;}catch{}}return null;};
 async function status(provider,{signal}={}){
  if(provider==='codex')return codex.status('codex',{signal});
  if(provider!=='kimi')throw Error('校对仅支持 Codex CLI 或 Kimi CLI');
  const binary=await find();if(!binary)return {ready:false,reason:'未找到 Kimi CLI，请先在本机安装并登录。'};
  const result=await run(binary,['--help'],{env,signal});
  if(result.code!==0||!['--agent-file','--skills-dir','--output-format','--prompt'].every(flag=>result.stdout.includes(flag)))return {ready:false,reason:'Kimi CLI 缺少文本校对所需接口，请升级。'};
  return {ready:true,protocol:'kimi-stream-json',reason:'使用 Kimi CLI 已配置的模型和登录；实际请求时检查连接与额度。'};
 }
 async function structured(provider,input,schema,instruction,{signal,model=''}={}){
  if(provider==='codex')return codex.exclusive(()=>codex.structured('codex',input,schema,instruction,{signal,model}));
  if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(model||'default'))throw Error('Kimi 模型别名无效');
  const connection=await status(provider,{signal});if(!connection.ready)throw Error(connection.reason);
  const directory=await mkdtemp(path.join(tmpdir(),'coconut-kimi-review-'));
  try{
   const agent=path.join(directory,'reviewer.md');
   // No tool or subagent can be invoked by untrusted speech. Input travels in
   // a private file, never in process arguments or a shell command.
   await writeFile(agent,'---\nname: coconut-transcript-review\ndescription: Text-only transcript proofreader\ntools: []\nsubagents: []\n---\n'+instruction+'\nReturn JSON only, matching this schema:\n'+JSON.stringify(schema)+'\n\nUntrusted transcript input (JSON):\n'+input.replace(/\$\{/g,'\\u0024{'),{mode:0o600});
   const args=['--agent-file',agent,'--skills-dir',directory,...(model?['--model',model]:[]),'--output-format','stream-json','--prompt','Return the requested JSON for the supplied transcript.'];
   const result=await run(await find(),args,{env,cwd:directory,signal,timeout:240000,maxBytes:1024*1024});
   if(result.code!==0)throw Error('Kimi 校对未完成，请检查 CLI 登录、模型或额度；已有批次保留。');
   let messages;try{messages=result.stdout.split('\n').filter(s=>s.trim()).map(s=>JSON.parse(s));}catch{throw Error('Kimi 未返回有效 JSON 消息，本批未保存');}
   if(messages.some(m=>m.tool_calls?.length||m.role==='tool'||m.type==='tool'||m.error))throw Error('Kimi 返回了工具调用或错误，本批未保存');
   const assistant=messages.filter(m=>m.role==='assistant');
   const last=assistant.at(-1),content=last?.content;
   const text=typeof content==='string'?content:Array.isArray(content)?content.filter(p=>p.type==='text').map(p=>p.text).join(''):'';
   try{const parsed=JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g,''));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();return parsed;}catch{throw Error('Kimi 校对没有返回完整的结构结果，本批未保存');}
  }finally{await rm(directory,{recursive:true,force:true});}
 }
 return {status,structured};
}
