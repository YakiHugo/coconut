/** Durable owner-bound review queue. Completed model batches survive retries. */
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createTranscriptReviewer} from './transcript-review.mjs';
const require=createRequire(import.meta.url),R=require('../shared/transcript-review.js'),Core=require('../reader/core.js');
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const uuid=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function createTranscriptReviewJobs({directory,libraryStore,reviewer=createTranscriptReviewer(),defaultProvider='codex'}={}){
 if(!path.isAbsolute(directory||'')||!libraryStore)throw fail('校对需要已保存的项目',503);
 if(!['codex','kimi'].includes(defaultProvider))throw fail('默认校对提供商无效');
 await mkdir(directory,{recursive:true,mode:0o700});
 const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(path.join(directory,'review.sqlite'));
 try{db.exec("PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, document_key TEXT NOT NULL, binding TEXT NOT NULL, digest TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL, error TEXT, created INTEGER NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS active_review ON jobs(binding) WHERE state IN ('queued','running'); UPDATE jobs SET state='interrupted',phase='interrupted' WHERE state='running';");}catch(error){db.close();throw error;}
 let closing=false,running=null,controller=null,runningId=null,shutdownPromise;
 const binding=record=>hash({epoch:record.token.epoch,lifetime:record.identity.lifetime,key:record.key});
 const record=key=>{const r=libraryStore.get(key);if(!r||r.deleted)throw fail('校对项目已不存在',409);return r;};
 const row=id=>{if(!uuid(id))throw fail('校对任务标识无效');const r=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);if(!r)throw fail('校对任务不存在',404);return r;};
 function owned(value){if(binding(record(value.document_key))!==value.binding)throw fail('原项目已删除或替换，旧校对任务不能接入',409);return value;}
 const work=id=>path.join(directory,id);
 const describe=value=>{const request=JSON.parse(value.request);return {id:value.id,documentKey:value.document_key,state:value.state,phase:value.phase,error:value.error,provider:request.provider,model:request.model,created:value.created};};
 const update=(id,state,phase=state,error=null)=>db.prepare('UPDATE jobs SET state=?,phase=?,error=? WHERE id=?').run(state,phase,error,id);
 async function perform(value){
  // The queue dispatches in a microtask. Cancellation can happen before this
  // callback starts, when there is no controller to abort yet.
  if(closing||row(value.id).state!=='queued')return;
  controller=new AbortController();runningId=value.id;update(value.id,'running','review');
  try{
   owned(value);const request=JSON.parse(value.request);
   const output=await reviewer.review(request.document,{directory:work(value.id),provider:request.provider,model:request.model,jobId:value.id,signal:controller.signal,onProgress:p=>{if(!closing&&!controller.signal.aborted)update(value.id,'running',`review:${p.chunk}/${p.chunks}`);}});
   if(closing||controller.signal.aborted)return;
   owned(value);await writeFile(path.join(work(value.id),'result.tmp'),JSON.stringify(output),{mode:0o600});await rename(path.join(work(value.id),'result.tmp'),path.join(work(value.id),'result.json'));
   if(!closing&&!controller.signal.aborted)update(value.id,'ready');
  }catch(error){if(!closing&&!controller.signal.aborted)update(value.id,'failed','failed',String(error.message||'校对失败').slice(0,300));}
  finally{controller=null;runningId=null;}
 }
 function pump(){if(closing||running)return;const next=db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created LIMIT 1").get();if(!next)return;running=Promise.resolve().then(()=>perform(next)).finally(()=>{running=null;pump();});}
 function create(data){
  if(closing)throw fail('校对服务正在停止',503);
  if(data?.protocolVersion!==1||data.consent!==true||!uuid(data.operation_id)||typeof data.key!=='string')throw fail('请确认使用所选 CLI 校对文字稿');
  const current=record(data.key),provider=data.provider||defaultProvider,model=data.model||'';
  if(!['codex','kimi'].includes(provider)||typeof model!=='string'||model&&!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(model))throw fail('校对提供商或模型无效');
  if(data.source_signature!==R.signature(current.document))throw fail('文字稿或节目资料已变化，请重新发起校对',409);
  const c=R.context(current.document),document={key:data.key,title:c.title,source_url:c.source_url,podcast_source:{description:c.description},speaker_identity_evidence:{source_url:current.document.speaker_identity_evidence?.source_url||'',speakers:c.participants},transcription_glossary:c.terms,segments:R.snapshot(current.document).segments};
  R.plan(document);const request={document,provider,model},owner=binding(current),digest=hash({request,owner}),previous=db.prepare('SELECT * FROM jobs WHERE id=?').get(data.operation_id);
  if(previous){if(previous.digest!==digest)throw fail('此操作标识已用于另一份校对请求',409);return describe(owned(previous));}
  if(db.prepare("SELECT id FROM jobs WHERE binding=? AND state IN ('queued','running')").get(owner))throw fail('这份稿件已有进行中的校对任务',409);
  if(db.prepare('SELECT count(*) AS n FROM jobs').get().n>=256)throw fail('校对任务记录已满，请先备份并清理',409);
  db.prepare('INSERT INTO jobs(id,document_key,binding,digest,request,state,phase,created) VALUES(?,?,?,?,?,?,?,?)').run(data.operation_id,data.key,owner,digest,JSON.stringify(request),'queued','queued',Date.now());
  pump();return describe(row(data.operation_id));
 }
 async function result(id){const value=owned(row(id));if(!['ready','applied'].includes(value.state))throw fail('校对尚未完成',409);return {...describe(value),...JSON.parse(await readFile(path.join(work(id),'result.json'),'utf8'))};}
 async function action(id,action){
  const value=owned(row(id));if(closing)throw fail('校对服务正在停止',503);
  if(action==='cancel'){
   if(!['queued','running'].includes(value.state))throw fail('此校对任务不能取消',409);update(id,'cancelled');if(runningId===id)controller?.abort();
  }else if(action==='retry'){
   if(!['failed','interrupted','cancelled'].includes(value.state))throw fail('此校对任务无需重试',409);
   const request=JSON.parse(value.request);if(R.signature(record(value.document_key).document)!==R.signature(request.document))throw fail('原稿已变化，请为新稿创建校对任务',409);
   if(db.prepare("SELECT id FROM jobs WHERE binding=? AND state IN ('queued','running')").get(value.binding))throw fail('已有校对任务正在进行',409);update(id,'queued');pump();
  }else if(action==='apply'){
   if(!['ready','applied'].includes(value.state))throw fail('校对结果尚未完成',409);
   const output=await result(id),current=record(value.document_key);owned(value);
   if(current.document.transcript_review?.job_id!==id){
    const request=JSON.parse(value.request),document=R.merge(current.document,output.input,output.results,{provider:request.provider,model:request.model,jobId:id});Core.validate(document);
    libraryStore.commit({protocolVersion:1,epoch:current.token.epoch,key:current.key,receiptKey:id,action:'put',expected:current.token,document});
   }
   update(id,'applied');
  }else throw fail('校对操作无效');
  return describe(row(id));
 }
 function list(key){const owner=binding(record(key));return db.prepare('SELECT * FROM jobs WHERE binding=? ORDER BY created DESC LIMIT 20').all(owner).map(describe);}
 function shutdown(){return shutdownPromise??=(async()=>{closing=true;if(controller){update(runningId,'interrupted');controller.abort();}await running;db.close();})();}
 pump();return {create,list,get:id=>describe(owned(row(id))),result,action,shutdown,capabilities:()=>({protocolVersion:1,providers:['codex','kimi'],defaultProvider,persistent:true,automatic:false,audio_upload:false}),providerStatus:reviewer.status};
}
