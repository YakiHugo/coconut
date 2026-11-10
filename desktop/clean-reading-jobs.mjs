/** Durable reading-plan jobs. A failed optional fallback preserves local output. */
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {createCleanReadingPlanner,readingSource} from './clean-reading.mjs';
const require=createRequire(import.meta.url),D=require('../reader/disfluency.js'),Core=require('../reader/core.js');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export async function createCleanReadingJobs({directory,libraryStore,sourceMediaStore=null,planner=createCleanReadingPlanner()}={}){
 if(!path.isAbsolute(directory||'')||!libraryStore)throw fail('阅读整理需要已保存的项目',503);
 await mkdir(directory,{recursive:true,mode:0o700});
 const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(path.join(directory,'reading.sqlite'));
 db.exec("PRAGMA busy_timeout=1000;CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,document_key TEXT NOT NULL,binding TEXT NOT NULL,digest TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,phase TEXT NOT NULL,error TEXT,created INTEGER NOT NULL);CREATE UNIQUE INDEX IF NOT EXISTS live_reading ON jobs(binding) WHERE state IN ('queued','running');UPDATE jobs SET state='interrupted',phase='interrupted' WHERE state='running';");
 let closing=false,running=null,controller=null,runningId=null,shutdownPromise;
 const binding=r=>hash({epoch:r.token.epoch,key:r.key,lifetime:r.identity.lifetime});
 const record=key=>{const r=libraryStore.get(key);if(!r||r.deleted)throw fail('整理项目已不存在',409);return r;};
 const row=id=>{if(!uuid(id))throw fail('整理任务标识无效');const r=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);if(!r)throw fail('整理任务不存在',404);return r;};
 const owned=r=>{if(binding(record(r.document_key))!==r.binding)throw fail('原项目已删除或替换，旧整理结果不能接入',409);return r;};
 const describe=r=>{const input=JSON.parse(r.request);return {id:r.id,documentKey:r.document_key,state:r.state,phase:r.phase,error:r.error,provider:input.provider,model:input.model,created:r.created};};
 const update=(id,state,phase=state,error=null)=>db.prepare('UPDATE jobs SET state=?,phase=?,error=? WHERE id=?').run(state,phase,error,id);
 const work=id=>path.join(directory,id);
 async function perform(value){
  if(closing||row(value.id).state!=='queued')return;
  controller=new AbortController();runningId=value.id;update(value.id,'running','rules');
  try{
   owned(value);const request=JSON.parse(value.request);
   await mkdir(work(value.id),{recursive:true,mode:0o700});
   if(request.plannerIdentity!==await planner.identity())throw fail('整理策略已变化，请创建新任务',409);
   let audioPath=null;
   if(request.audio){if(!sourceMediaStore)throw fail('任务原声当前不可用',409);audioPath=(await sourceMediaStore.localInput(value.document_key,request.audio.binding,request.audio.sha256)).path;}
   const result=await planner.prepare(request.document,{directory:work(value.id),provider:request.provider,model:request.model,audioPath,signal:controller.signal,
    onProgress:p=>{if(!closing&&!controller.signal.aborted)update(value.id,'running',String(p.phase||'processing'));}});
   if(closing||controller.signal.aborted)return;owned(value);
   if(request.audio)await sourceMediaStore.localInput(value.document_key,request.audio.binding,request.audio.sha256);
   result.reading_cleanup.jobId=value.id;
   await writeFile(path.join(work(value.id),'job-result.tmp'),JSON.stringify({reading_cleanup:result.reading_cleanup,sourceSignature:request.sourceSignature,identity:result.identity}),{mode:0o600});
   await rename(path.join(work(value.id),'job-result.tmp'),path.join(work(value.id),'job-result.json'));
   if(!closing&&!controller.signal.aborted)update(value.id,'ready');
  }catch(error){if(!closing&&!controller.signal.aborted)update(value.id,'failed','failed',String(error.message||'整理未完成').slice(0,300));}
  finally{controller=null;runningId=null;}
 }
 function pump(){if(closing||running)return;const value=db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created LIMIT 1").get();if(!value)return;
  running=new Promise(resolve=>setImmediate(resolve)).then(()=>perform(value)).finally(()=>{running=null;pump();});}
 async function create(data){
  if(closing)throw fail('整理服务正在停止',503);
  if(data?.protocolVersion!==1||!uuid(data.operation_id)||typeof data.key!=='string')throw fail('整理请求无效');
  const current=record(data.key),provider=data.fallback===true?'codex':'',model=data.model||'';
  if(provider&&data.consent!==true)throw fail('请确认仅发送疑难片段到 Codex CLI');
  if(typeof model!=='string'||model&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(model))throw fail('模型名称无效');
  const document=readingSource(current.document),sourceSignature=D.signature(document);
  if(!document.segments.length||data.source_signature!==sourceSignature)throw fail('文字稿已变化，请重新发起整理',409);
  const audio=sourceMediaStore?await sourceMediaStore.read(data.key):null,plannerIdentity=await planner.identity();
  const request={document,sourceSignature,provider,model:provider?model:'',plannerIdentity,audio:audio?{binding:audio.binding,sha256:audio.sha256}:null};
  const owner=binding(current),digest=hash({request,owner}),previous=db.prepare('SELECT * FROM jobs WHERE id=?').get(data.operation_id);
  if(previous){if(previous.digest!==digest)throw fail('此操作标识已用于另一份整理请求',409);return describe(owned(previous));}
  if(db.prepare("SELECT id FROM jobs WHERE binding=? AND state IN ('queued','running')").get(owner))throw fail('这份稿件已有进行中的整理任务',409);
  if(db.prepare('SELECT count(*) AS n,coalesce(sum(length(request)),0) AS bytes FROM jobs').get().n>=64||db.prepare('SELECT coalesce(sum(length(request)),0) AS bytes FROM jobs').get().bytes+JSON.stringify(request).length>64*1024*1024)throw fail('整理任务记录已满，请先备份任务',409);
  db.prepare('INSERT INTO jobs(id,document_key,binding,digest,request,state,phase,created) VALUES(?,?,?,?,?,?,?,?)').run(data.operation_id,data.key,owner,digest,JSON.stringify(request),'queued','queued',Date.now());
  pump();return describe(row(data.operation_id));
 }
 async function result(id){const value=owned(row(id));if(!['ready','applied'].includes(value.state))throw fail('整理尚未完成',409);return {...describe(value),...JSON.parse(await readFile(path.join(work(id),'job-result.json'),'utf8'))};}
 async function action(id,action){
  const value=owned(row(id));if(closing)throw fail('整理服务正在停止',503);
  if(action==='cancel'){if(!['queued','running'].includes(value.state))throw fail('此任务不能取消',409);update(id,'cancelled');if(runningId===id)controller?.abort();}
  else if(action==='retry'){
   if(!['failed','interrupted','cancelled'].includes(value.state))throw fail('此任务无需继续',409);
   const request=JSON.parse(value.request);if(D.signature(record(value.document_key).document)!==request.sourceSignature||request.plannerIdentity!==await planner.identity())throw fail('原稿或整理策略已变化，请创建新任务',409);
   if(db.prepare("SELECT id FROM jobs WHERE binding=? AND state IN ('queued','running')").get(value.binding))throw fail('已有整理任务进行中',409);update(id,'queued');pump();
  }else if(action==='apply'){
   const output=await result(id),current=record(value.document_key),request=JSON.parse(value.request);
   if(D.signature(current.document)!==output.sourceSignature)throw fail('原文、时间或说话人已变化，未应用旧整理结果',409);
   if(request.audio)await sourceMediaStore.localInput(value.document_key,request.audio.binding,request.audio.sha256);
   const p=output.reading_cleanup;D.createProjection(current.document,{decisions:p.decisions,marks:p.marks||[],breaks:p.breaks||[],policyVersion:p.policyVersion,sourceSignature:p.sourceSignature});
   if(JSON.stringify(current.document.reading_cleanup)!==JSON.stringify(p)){
    const document={...current.document,reading_cleanup:p};Core.validate(document);
    libraryStore.commit({protocolVersion:1,epoch:current.token.epoch,key:current.key,receiptKey:id,action:'put',expected:current.token,document});}
   update(id,'applied');
  }else throw fail('整理操作无效');
  return describe(row(id));
 }
 const list=key=>{const owner=binding(record(key));return db.prepare('SELECT * FROM jobs WHERE binding=? ORDER BY created DESC LIMIT 20').all(owner).map(describe);};
 function shutdown(){return shutdownPromise??=(async()=>{closing=true;if(controller){update(runningId,'interrupted');controller.abort();}await running;db.close();})();}
 pump();return {create,list,get:id=>describe(owned(row(id))),result,action,shutdown,capabilities:()=>({protocolVersion:1,persistent:true,defaultProvider:'',providers:['codex'],automatic:false,maxSourceFraction:.1,maxWindows:12,maxRequests:3,audioUpload:false})};
}
