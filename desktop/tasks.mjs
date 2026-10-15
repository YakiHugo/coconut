/** Local, single-writer task ledger. This module never retries a model request. */
import {normalizeModel} from './providers.mjs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const ROOT=path.dirname(fileURLToPath(import.meta.url));
export const TASK_PROTOCOL_VERSION=1;
export const TASK_BODY_BYTES=8*1024*1024;
const MAX_LEDGER_BYTES=32*1024*1024,MAX_TASKS=128,MAX_ARCHIVED_TASKS=2048,MAX_PENDING=8;
// Covers worst-case JSON escapes for 8,000 answer characters, up to
// 64 * 8 source citations of 200 characters, and bounded terminal metadata.
const TERMINAL_RESERVE_BYTES=1024*1024;
const STATES=new Set(['queued','running','cancel_requested','cancelled','succeeded','failed','interrupted']);
const ACTIVE=new Set(['queued','running','cancel_requested']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const clone=value=>structuredClone(value);
async function readBounded(handle,limit){
 const buffer=Buffer.alloc(limit+1);let length=0;
 while(length<buffer.length){const read=await handle.read(buffer,length,buffer.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}
 if(length>limit)throw new Error('File exceeds limit');return buffer.subarray(0,length).toString('utf8');
}
const fail=(message,status=400,code='invalid_request')=>Object.assign(new Error(message),{status,taskCode:code});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now=()=>new Date().toISOString();
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};

// Dead-owner recovery is serialized separately. A crashed recovery guard fails
// closed and needs inspection; it can never steal a new live writer's lease.
async function acquire(directory){
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const filename=path.join(directory,'writer.lock'),recovery=path.join(directory,'recovery.lock'),token=randomUUID();
 const read=async()=>{
  const handle=await fs.open(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size>1024)throw fail('任务写入锁无效，需要人工检查',503,'store_locked');
   const value=JSON.parse(await readBounded(handle,1024));if(!Number.isSafeInteger(value.pid)||value.pid<=0||typeof value.token!=='string')throw fail('任务写入锁无效，需要人工检查',503,'store_locked');return value;
  }finally{await handle.close();}
 };
 const claim=async()=>{const handle=await fs.open(filename,'wx',0o600);try{await handle.writeFile(JSON.stringify({pid:process.pid,token}));await handle.sync();}finally{await handle.close();}};
 try{await claim();}catch(error){
  if(error.code!=='EEXIST')throw error;
  const previous=await read();if(alive(previous.pid))throw fail('此任务目录已有在线执行器',503,'store_locked');
  try{await fs.mkdir(recovery);}catch{throw fail('任务目录正在恢复或需要人工检查',503,'store_locked');}
  try{
   const current=await read();if(alive(current.pid))throw fail('此任务目录已有在线执行器',503,'store_locked');
   await fs.unlink(filename);await claim();
  }finally{await fs.rmdir(recovery);}
 }
 return async()=>{const current=await read();if(current.token===token)await fs.unlink(filename);};
}

export async function createTaskStore({directory,providers,readerDirectory=path.resolve(ROOT,'../reader'),maxLedgerBytes=MAX_LEDGER_BYTES}={}){
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw new Error('An absolute task directory is required');
 if(!Number.isSafeInteger(maxLedgerBytes)||maxLedgerBytes<1||maxLedgerBytes>MAX_LEDGER_BYTES)throw new Error('Invalid ledger byte limit');
 if(typeof providers?.ask!=='function')throw new Error('A summary provider is required');
 const Summary=require(path.join(readerDirectory,'summary.js'));
 const release=await acquire(directory),filename=path.join(directory,'tasks.json');
 let tasks=new Map(),ledgerFields={},queue=Promise.resolve(),closed=false,broken=false,draining=false;
 const controllers=new Map();
 function normalize(value){
  if(!value||value.protocolVersion!==1||value.kind!=='summary'||value.consent!==true)throw fail('仅支持明确同意的 v1 整篇摘要任务');
  if(typeof value.idempotencyKey!=='string'||! /^[a-zA-Z0-9_-]{1,128}$/.test(value.idempotencyKey))throw fail('提交幂等键无效');
  if(!value.document||typeof value.document.key!=='string'||!value.document.key||value.document.key.length>1000||typeof value.document.revision!=='string'||!value.document.revision||value.document.revision.length>200)throw fail('文稿标识或 revision 无效');
  if(!['codex','claude'].includes(value.provider))throw fail('请选择支持的本地 AI 工具');
  let model;try{model=normalizeModel(value.model);}catch(error){throw fail(error.message);}
  const plan=Summary.plan({segments:value.segments});
  const input={kind:'summary',document:{key:value.document.key,revision:value.document.revision},provider:value.provider,snapshot:plan.source,...(model?{model}:{})};
  return {input,plan,inputDigest:hash(input),idempotencyKey:value.idempotencyKey};
 }
 function publicTask(task,{result=true}={}){
  const value=clone(task);delete value.snapshot;delete value.idempotencyKey;delete value.resumeReceipts;
  if(value.checkpoint)value.checkpoint={version:1,completed:task.checkpoint.notes.length,inFlight:task.checkpoint.inFlight};
  if(value.result&&result)value.result.input_snapshot={version:1,segments:clone(task.snapshot)};
  else delete value.result;
  value.resume={eligible:['interrupted','failed'].includes(task.status)&&!archived(task)&&(task.resumeReceipts?.length||0)<64,completedBatches:task.checkpoint?.notes.length||0,remainingRequests:task.status==='succeeded'?0:task.progress.total-(task.checkpoint?.notes.length||0),outcomeUnknown:task.checkpoint?task.checkpoint.inFlight!==null:['interrupted','failed'].includes(task.status),notice:'只复用已校验且已落盘的分批摘要；上次在途请求的结果及额度可能未知，明确续跑可能再次消耗额度。'};
  return value;
 }
 function serial(action){const work=queue.then(action);queue=work.catch(()=>{});return work;}
 function archived(task){return typeof task.archivedAt==='string';}
 function archivable(task){return ['succeeded','failed'].includes(task.status)||(task.status==='cancelled'&&task.cancellation?.executionSettled===true);}
 function available(){if(closed||broken)throw fail('本机任务存储不可用，请先检查执行器；不要用新提交键盲目重试',503,'store_unavailable');}
 async function persist(next){
  const data=JSON.stringify({...ledgerFields,version:3,tasks:[...next.values()]});
  let budget=Buffer.byteLength(data);
  for(const task of next.values())if(ACTIVE.has(task.status)){
   const {taskId,attemptId,idempotencyKey,inputDigest,kind,document,provider,snapshot,model}=task;
   const fixed=JSON.stringify({taskId,attemptId,idempotencyKey,inputDigest,kind,document,provider,snapshot,model});
   budget+=Math.max(0,Buffer.byteLength(fixed)+TERMINAL_RESERVE_BYTES+(task.progress.total>1?512*1024:0)-Buffer.byteLength(JSON.stringify(task)));
  }
  const archivedCount=[...next.values()].filter(archived).length;
  if(next.size-archivedCount>MAX_TASKS)throw fail('未归档任务已达 128 条，请显式归档已收尾任务后继续；未发起新的模型请求',507,'active_tasks_full');
  if(archivedCount>MAX_ARCHIVED_TASKS)throw fail('归档已达 2048 条上限；所有记录均已保留，未自动删除',507,'archive_full');
  if(budget>maxLedgerBytes)throw fail('本机任务总存储预算已满，归档不会释放字节；请导出救援记录并检查存储，未发起新的模型请求',507,'store_full');
  const temporary=filename+'.'+randomUUID()+'.tmp';let handle;
  try{
   handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(data);await handle.sync();await handle.close();handle=null;
   await fs.rename(temporary,filename);
   const folder=await fs.open(directory,'r');try{await folder.sync();}finally{await folder.close();}
   tasks=next;
  }catch(error){broken=true;for(const controller of controllers.values())controller.abort();throw fail('任务写入失败，执行已停止；结果可能未知，请重新查询原 taskId',503,'store_unavailable');}
  finally{await handle?.close().catch(()=>{});await fs.unlink(temporary).catch(()=>{});}
 }
 async function change(id,update){
  const prior=tasks.get(id);if(!prior)throw fail('任务不存在',404,'not_found');
  const task={...prior,...update,updatedAt:now()},next=new Map(tasks);next.set(id,task);await persist(next);return task;
 }
 async function recover(){
  let handle;
  try{
   handle=await fs.open(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
   const stat=await handle.stat();if(!stat.isFile()||stat.size>maxLedgerBytes)throw new Error('Invalid ledger');
   const ledger=JSON.parse(await readBounded(handle,maxLedgerBytes));if(![1,2,3].includes(ledger.version)||!Array.isArray(ledger.tasks)||ledger.tasks.length>(ledger.version===1?MAX_TASKS:MAX_TASKS+MAX_ARCHIVED_TASKS))throw new Error('Invalid ledger');
   const archivedCount=ledger.tasks.filter(archived).length;
   if(archivedCount>MAX_ARCHIVED_TASKS||ledger.tasks.length-archivedCount>MAX_TASKS)throw new Error('Invalid ledger limits');
   ledgerFields={...ledger};delete ledgerFields.version;delete ledgerFields.tasks;
   const keys=new Set();let changed=false;
   for(const raw of ledger.tasks){
    const checked=normalize({...raw,protocolVersion:1,consent:true,segments:raw.snapshot});
    if(!UUID.test(raw.taskId)||!UUID.test(raw.attemptId)||tasks.has(raw.taskId)||keys.has(raw.idempotencyKey)||raw.inputDigest!==checked.inputDigest||!STATES.has(raw.status)||typeof raw.createdAt!=='string'||typeof raw.updatedAt!=='string'||!Number.isInteger(raw.progress?.completed)||raw.progress.completed<0||raw.progress.completed>checked.plan.requests||raw.progress.total!==checked.plan.requests)throw new Error('Invalid task record');
    if(Object.hasOwn(raw,'archivedAt')&&(ledger.version<2||typeof raw.archivedAt!=='string'||!Number.isFinite(Date.parse(raw.archivedAt))||!archivable(raw)))throw new Error('Invalid archive record');
    const task=clone(raw);keys.add(task.idempotencyKey);
    if(task.checkpoint!==undefined){
     const cp=task.checkpoint;
     if(ledger.version<3||!cp||cp.version!==1||cp.planDigest!==hash(checked.plan)||!Array.isArray(cp.notes)||!(cp.inFlight===null||Number.isInteger(cp.inFlight)&&cp.inFlight===cp.notes.length&&cp.inFlight<checked.plan.requests))throw new Error('Invalid checkpoint');
     const restored=Summary.clean({version:1,provider:task.provider,model:task.model,snapshot:task.snapshot,status:'paused',results:cp.notes,in_flight:cp.inFlight});
     if(task.status==='succeeded'&&(cp.inFlight!==null||cp.notes.length!==(checked.plan.chunks.length>1?checked.plan.chunks.length:0)))throw new Error('Invalid completed checkpoint');
     if(!restored||JSON.stringify(restored.results)!==JSON.stringify(cp.notes)||task.progress.completed!==(task.status==='succeeded'?checked.plan.requests:cp.notes.length))throw new Error('Invalid checkpoint notes');
    }
    if(task.resumeReceipts!==undefined){
     if(!Array.isArray(task.resumeReceipts)||task.resumeReceipts.length>64)throw new Error('Invalid resume receipts');
     const seen=new Set(),attempts=new Set();let previous;for(const receipt of task.resumeReceipts){if(!receipt||typeof receipt.key!=='string'||! /^[a-zA-Z0-9_-]{1,128}$/.test(receipt.key)||seen.has(receipt.key)||!UUID.test(receipt.fromAttemptId)||!UUID.test(receipt.attemptId)||typeof receipt.outcomeUnknown!=='boolean'||!Number.isInteger(receipt.completedBatches)||receipt.completedBatches<0||receipt.completedBatches>=checked.plan.requests||receipt.fromAttemptId===receipt.attemptId||attempts.has(receipt.attemptId)||(previous&&receipt.fromAttemptId!==previous))throw new Error('Invalid resume receipt');seen.add(receipt.key);attempts.add(receipt.fromAttemptId);attempts.add(receipt.attemptId);previous=receipt.attemptId;}
     if(task.resumeReceipts.length&&task.resumeReceipts.at(-1).attemptId!==task.attemptId)throw new Error('Invalid resume identity');
    }
    if(ACTIVE.has(task.status)){
     const cancelled=task.status==='cancel_requested';task.status=cancelled?'cancelled':'interrupted';task.updatedAt=now();
     task.error={code:cancelled?'cancelled_outcome_unknown':'executor_interrupted',message:cancelled?'取消已保留；上次执行是否已消耗额度未知。':'执行器曾退出；已发送请求的结果及额度可能未知。不会自动重新执行。'};
     delete task.result;changed=true;
    }
    if(task.status==='succeeded'){
     if(!Summary.cleanFinal(checked.plan,task.result,task.provider,task.model,{legacy:task.checkpoint===undefined}))throw new Error('Invalid task result');
     if(task.checkpoint&&checked.plan.chunks.length>1){const acceptedIds=new Set(task.checkpoint.notes.flatMap(note=>note.citations));if(task.result.citations.some(id=>!acceptedIds.has(id)))throw new Error('Invalid aggregate sources');}
    }else if(task.result)throw new Error('Unexpected result');
    tasks.set(task.taskId,task);
   }
   if(changed)await persist(tasks);
  }catch(error){if(error.code!=='ENOENT')throw fail('任务记录无法安全读取；未启动模型，请检查本机任务目录',503,'store_unavailable');}
  finally{await handle?.close();}
 }
 async function run(task,controller){
  const plan=Summary.plan({segments:task.snapshot}),job=Summary.create(plan,task.provider,task.model);
  job.results=clone(task.checkpoint?.notes||[]);let first=true;
  try{
   while(!closed&&!broken&&!controller.signal.aborted){
    const data={...Summary.request(plan,job),...(task.model?{model:task.model}:{})};
    const ready=first||await serial(async()=>{
     if(closed||broken||controller.signal.aborted||tasks.get(task.taskId)?.status!=='running')return false;
     await change(task.taskId,{checkpoint:{version:1,planDigest:hash(plan),notes:clone(job.results),inFlight:job.results.length}});return true;
    });
    first=false;if(!ready)break;
    const response=await providers.ask(data,{signal:controller.signal});
    if(closed||broken||controller.signal.aborted)break;
    const result=Summary.accept(plan,job,response);
    const continued=await serial(async()=>{
     if(closed||broken||tasks.get(task.taskId)?.status!=='running')return false;
     const update={progress:{completed:result?plan.requests:job.results.length,total:plan.requests},checkpoint:{version:1,planDigest:hash(plan),notes:plan.chunks.length>1?clone(job.results):[],inFlight:null}};
     if(result){const {input_snapshot,...small}=result;update.status='succeeded';update.result={...small,...(task.model?{requested_model:task.model}:{})};}
     await change(task.taskId,update);return !result;
    });
    if(!continued)break;
   }
  }catch(error){
   if(!closed&&!broken)await serial(async()=>{
    if(tasks.get(task.taskId)?.status==='running')await change(task.taskId,{status:'failed',error:{code:'provider_failed',message:String(error.message||'摘要未完成').slice(0,300),...(error.providerDiagnostics?{providerDiagnostics:error.providerDiagnostics}:{})}});
   }).catch(()=>{});
  }finally{
   if(!closed&&!broken)await serial(async()=>{
    if(tasks.get(task.taskId)?.status==='cancel_requested')await change(task.taskId,{status:'cancelled',cancellation:{...tasks.get(task.taskId).cancellation,executionSettled:true}});
   }).catch(()=>{});
   controllers.delete(task.taskId);
  }
 }
 async function drain(){
  if(draining||closed||broken)return;draining=true;
  try{
   while(!closed&&!broken){
    let controller;
    const task=await serial(async()=>{
     if(closed||broken)return null;
     const task=[...tasks.values()].find(value=>value.status==='queued');if(!task)return null;
     controller=new AbortController();controllers.set(task.taskId,controller);
     const plan=Summary.plan({segments:task.snapshot}),notes=task.checkpoint?.notes||[];
     return change(task.taskId,{status:'running',checkpoint:{version:1,planDigest:hash(plan),notes,inFlight:notes.length},progress:{completed:notes.length,total:plan.requests}});
    });
    if(!task)break;
    if(!closed&&!broken)await run(task,controller);
   }
  }catch{/* Persistence failures already fail closed. */}finally{draining=false;}
 }
 try{await recover();}catch(error){await release();throw error;}
 return Object.freeze({
  describe(){return {protocolVersion:1,executor:{type:'local-node',online:!closed&&!broken},supportedTaskKinds:['summary'],enabled:!closed&&!broken,execution:{concurrency:1,disconnect:'continue',restart:'interrupt_without_retry',resume:'explicit_checkpoint_with_identity',cancel:'request_then_settle'},providers:{codex:{supported:true,availability:'not_checked',model_selection:{supported:true}},claude:{supported:true,availability:'not_checked',model_selection:{supported:true}}},archive:{supported:true,identityPrecondition:true,restore:'original_identity_without_execution',automaticDeletion:false},limits:{tasks:MAX_TASKS,archivedTasks:MAX_ARCHIVED_TASKS,archivePage:50,pending:MAX_PENDING,bodyBytes:TASK_BODY_BYTES,ledgerBytes:maxLedgerBytes},remoteSubmission:false};},
  submit(value){
   let normalized;try{normalized=normalize(value);}catch(error){return Promise.reject(error);}
   return serial(async()=>{
    available();const prior=[...tasks.values()].find(task=>task.idempotencyKey===normalized.idempotencyKey);
    if(prior){if(prior.inputDigest!==normalized.inputDigest)throw fail('幂等键已用于不同输入；请查询原任务，不要重复消费额度',409,'idempotency_conflict');return {created:false,task:publicTask(prior)};}
    if([...tasks.values()].filter(task=>ACTIVE.has(task.status)).length>=MAX_PENDING)throw fail('本机待处理任务已满',429,'queue_full');
    const stamp=now(),task={taskId:randomUUID(),attemptId:randomUUID(),idempotencyKey:normalized.idempotencyKey,inputDigest:normalized.inputDigest,...normalized.input,status:'queued',progress:{completed:0,total:normalized.plan.requests},createdAt:stamp,updatedAt:stamp};
    const next=new Map(tasks);next.set(task.taskId,task);await persist(next);
    // No request/response AbortSignal owns this work after the durable receipt.
    setImmediate(()=>void drain());return {created:true,task:publicTask(task)};
   });
  },
  resume(id,value){return serial(async()=>{
   available();const task=tasks.get(id);if(!task)throw fail('任务不存在',404,'not_found');
   if(!value||Object.keys(value).some(key=>!['protocolVersion','consent','resumeKey','attemptId','inputDigest'].includes(key))||value.protocolVersion!==1||value.consent!==true||typeof value.resumeKey!=='string'||! /^[a-zA-Z0-9_-]{1,128}$/.test(value.resumeKey)||!UUID.test(value.attemptId)||value.inputDigest!==task.inputDigest)throw fail('续跑需明确同意、原任务身份与独立幂等键',409,'task_identity_conflict');
   const receipt=task.resumeReceipts?.find(item=>item.key===value.resumeKey);
   if(receipt){if(receipt.fromAttemptId!==value.attemptId)throw fail('续跑键已用于不同执行',409,'idempotency_conflict');return {created:false,receipt:clone(receipt),task:publicTask(task)};}
   if(value.attemptId!==task.attemptId)throw fail('执行身份已变化，请重新核查',409,'task_identity_conflict');
   if(!['interrupted','failed'].includes(task.status)||archived(task))throw fail('仅可明确续跑未归档的中断或失败任务',409,'task_not_resumable');
   if((task.resumeReceipts?.length||0)>=64)throw fail('此任务已达 64 次显式续跑上限，请保留记录',409,'resume_limit');
   if([...tasks.values()].filter(item=>ACTIVE.has(item.status)).length>=MAX_PENDING)throw fail('本机待处理任务已满',429,'queue_full');
   const plan=Summary.plan({segments:task.snapshot}),attemptId=randomUUID();
   const checkpoint=task.checkpoint||{version:1,planDigest:hash(plan),notes:[],inFlight:null};
   const resumeReceipt={key:value.resumeKey,fromAttemptId:task.attemptId,attemptId,completedBatches:checkpoint.notes.length,outcomeUnknown:task.checkpoint?task.checkpoint.inFlight!==null:true};
   const resumed=await change(id,{attemptId,status:'queued',error:null,cancellation:null,checkpoint,progress:{completed:checkpoint.notes.length,total:plan.requests},resumeReceipts:[...(task.resumeReceipts||[]),resumeReceipt]});
   setImmediate(()=>void drain());return {created:true,receipt:clone(resumeReceipt),task:publicTask(resumed)};
  });},
  findResume(id,key){return serial(()=>{available();const task=tasks.get(id);if(!task)throw fail('任务不存在',404,'not_found');const receipt=task.resumeReceipts?.find(item=>item.key===key);return {receipt:receipt?clone(receipt):null,task:publicTask(task)};});},
  findSubmission(key){return serial(()=>{available();const task=[...tasks.values()].find(task=>task.idempotencyKey===key);return task?publicTask(task):null;});},
  get(id){return serial(()=>{available();const task=tasks.get(id);if(!task)throw fail('任务不存在',404,'not_found');return publicTask(task);});},
  list(){return serial(()=>{available();return [...tasks.values()].filter(task=>!archived(task)).map(task=>publicTask(task,{result:false}));});},
  listArchived({limit=20,after=''}={}){return serial(()=>{
   available();if(!Number.isInteger(limit)||limit<1||limit>50||typeof after!=='string'||(after&&!UUID.test(after)))throw fail('归档分页参数无效');
   const all=[...tasks.values()].filter(archived).sort((a,b)=>a.taskId.localeCompare(b.taskId));
   const remaining=all.filter(task=>!after||task.taskId>after),page=remaining.slice(0,limit);
   return {tasks:page.map(task=>publicTask(task,{result:false})),total:all.length,nextCursor:remaining.length>limit?page.at(-1).taskId:null};
  });},
  archive(id,expected){return serial(async()=>{
   available();const task=tasks.get(id);if(!task)throw fail('任务不存在',404,'not_found');
   // Compare immutable identity inside the same queue as the durable mutation.
   // Even an already archived replacement must not acknowledge another task.
   if(expected!==undefined){
    if(!expected||typeof expected!=='object'||Array.isArray(expected)||!UUID.test(expected.taskId)||!UUID.test(expected.attemptId)||typeof expected.inputDigest!=='string'||!/^[a-f0-9]{64}$/.test(expected.inputDigest))throw fail('归档身份条件无效');
    if(['taskId','attemptId','inputDigest'].some(key=>expected[key]!==task[key]))throw fail('任务身份已变化；未归档，请返回原执行器核查',409,'task_identity_conflict');
   }
   if(archived(task))return publicTask(task);
   if(!archivable(task))throw fail('只能归档已完成、失败或已确认取消收尾的任务；执行中、中断及未知结果必须保留在当前列表',409,'task_not_archivable');
   return publicTask(await change(id,{archivedAt:now()}));
  });},
  restore(id){return serial(async()=>{
   available();const task=tasks.get(id);if(!task)throw fail('任务不存在',404,'not_found');
   if(!archived(task))return publicTask(task);
   const restored={...task,updatedAt:now()};delete restored.archivedAt;
   const next=new Map(tasks);next.set(id,restored);await persist(next);return publicTask(restored);
  });},
  exportTask(id){return serial(()=>{available();const task=tasks.get(id);if(!task)throw fail('任务不存在',404,'not_found');return {format:'coconut-background-task-record',version:1,task:clone(task)};});},
  cancel(id,expected){return serial(async()=>{
   available();const task=tasks.get(id);if(!task)throw fail('任务不存在',404,'not_found');
   if(task.resumeReceipts?.length&&!expected)throw fail('任务已有明确续跑；请刷新并使用支持执行身份校验的客户端取消当前执行',409,'cancel_identity_required');
   if((expected!==undefined&&(!expected||expected.taskId!==id||expected.attemptId!==task.attemptId||expected.inputDigest!==task.inputDigest)))throw fail('执行身份已变化，未取消新的执行',409,'task_identity_conflict');
   if(!['queued','running'].includes(task.status))return publicTask(task);
   const running=task.status==='running';
   const cancelled=await change(id,{status:running?'cancel_requested':'cancelled',cancellation:{requestedAt:now(),executionSettled:!running}});
   controllers.get(id)?.abort();return publicTask(cancelled);
  });},
  shutdown(){
   if(closed)return queue;closed=true;for(const controller of controllers.values())controller.abort();
   return serial(async()=>{
    try{if(!broken){const next=new Map(tasks);for(const [id,task] of next)if(ACTIVE.has(task.status))next.set(id,{...task,status:task.status==='cancel_requested'?'cancelled':'interrupted',updatedAt:now(),error:{code:'executor_interrupted',message:'执行器已退出，已发送请求的结果及额度可能未知；不会自动重新执行。'}});await persist(next);}}
    finally{await release();}
   });
  }
 });
}
