import * as Editions from '../../reader/editions.js';
import type {EditionJob} from '../../reader/editions.js';
import type {AppStore} from './store';
type Value=Record<string,any>;
/** Uses the existing durable executor. Project jobs are write-ahead submission receipts. */
export function createInterviewController({store,access,client,engine,uuid}:{store:AppStore;access:Value;client:Value;engine:Value;uuid:()=>string}){
 let state:{busy:boolean;connected:boolean;message:string;tasks:Record<string,Value>;capability:Value|null}={busy:false,connected:false,message:'',tasks:{},capability:null},closed=false;
 const listeners=new Set<()=>void>();
 const emit=()=>{state={...state};listeners.forEach(f=>f());};
 const binding=()=>access.identity();
 const identity=(t:Value)=>({taskId:t.taskId,attemptId:t.attemptId,inputDigest:t.inputDigest});
 const stamp=()=>new Date().toISOString();
 function owned(key:string){const doc=store.getDocument(key);if(!doc||store.getSnapshot().dirty||store.getSnapshot().save.status!=='saved')throw Error('请先确认当前文稿与编辑已经保存');return doc;}
 function jobFor(doc:Value,id:string):EditionJob{const job=Editions.state(doc as any).jobs?.find(j=>j.id===id);if(!job||job.binding!==binding())throw Error('任务属于其他连接，请切回原执行器');return job;}
 function payload(doc:Value,j:EditionJob){const source=Editions.state(doc as any).snapshots.find(s=>s.id===j.source_snapshot_id)?.source;if(!source)throw Error('缺少冻结来源');return {protocolVersion:1,kind:'interview',idempotencyKey:j.id,document:{key:doc.key,revision:j.id},provider:j.provider,...(j.model?{model:j.model}:{}),consent:true,segments:engine.plan({segments:source.cues}).source};}
 function verify(doc:Value,j:EditionJob,t:Value){if(!t||t.kind!=='interview'||t.document?.key!==doc.key||t.document?.revision!==j.id||t.provider!==j.provider||(t.model||'')!==(j.model||'')||typeof t.taskId!=='string'||typeof t.attemptId!=='string'||typeof t.inputDigest!=='string')throw Error('任务回执与提交身份不一致');return t;}
 async function action(key:string,work:(context:{current:()=>ReturnType<typeof owned>;check:()=>void})=>Promise<void>){if(state.busy||closed)return;state.busy=true;state.message='';emit();const connection=binding(),generation=access.generation;try{await access.refresh();const check=()=>{if(closed||binding()!==connection||access.generation!==generation||!access.allows('backgroundTasks')||!access.allows('aiActions'))throw Error('连接已变化，请重新检查任务');};check();await work({current:()=>{check();return owned(key);},check});}catch(e){if(!closed)state.message=e instanceof Error?e.message:String(e);}finally{state.busy=false;if(!closed)emit();}}
 async function save(doc:ReturnType<typeof owned>,next:typeof doc){if(!await store.commitDocument(next,{key:doc.key,revision:store.getRevision(doc.key)}))throw Error('任务关联尚未确认保存；未继续发送。请重试项目保存后查询原任务');}
 async function lookup(doc:Value,j:EditionJob){const r=await client.findSubmission(j.id);if(r.protocolVersion!==1)throw Error('任务协议不匹配');if(!r.task)return null;return verify(doc,j,r.task);}
 return {
  subscribe(f:()=>void){listeners.add(f);return()=>{listeners.delete(f);};},getSnapshot:()=>state,
  refresh(key:string){return action(key,async({current,check})=>{const cap=await client.describe();check();if(cap.protocolVersion!==1||!cap.enabled||cap.executor?.type!=='local-node'||cap.executor?.online!==true||!cap.supportedTaskKinds?.includes('interview')||cap.execution?.disconnect!=='continue'||cap.execution?.restart!=='interrupt_without_retry'||cap.execution?.cancel!=='request_then_settle')throw Error('当前服务尚未支持后台编辑访谈，请更新本地服务');state.capability=cap;state.connected=true;const doc=current(),tasks:Record<string,Value>={};for(const j of Editions.state(doc).jobs||[]){if(j.binding!==binding())continue;const t=await lookup(doc,j);check();if(t)tasks[j.id]=t;}state.tasks=tasks;state.message='已查询编辑任务；不会自动提交或续跑。';});},
  submit(key:string,provider:'codex'|'claude',model:string,consent:boolean){const reviewed=store.getDocument(key),reviewedSource=reviewed?JSON.stringify(Editions.snapshot(reviewed)):'';return action(key,async({current,check})=>{
   if(!consent||!state.connected)throw Error('请先检查执行器并确认完整范围与额度');const chosen=engine.model(model),cap=state.capability;
   if(!cap?.providers?.[provider]?.supported||chosen&&!cap.providers[provider].model_selection?.supported)throw Error('此执行器不支持所选提供商或指定模型');
   let doc=current();if(JSON.stringify(Editions.snapshot(doc))!==reviewedSource)throw Error('确认后的原稿范围已变化，请重新核对并确认');if((Editions.state(doc).jobs||[]).some(j=>j.binding===binding()&&!Editions.state(doc).editions.some(e=>e.id===j.id)&&(['queued','running','cancel_requested'].includes(state.tasks[j.id]?.status)||!j.cancel_requested&&(!state.tasks[j.id]||['interrupted','failed'].includes(state.tasks[j.id].status)))))throw Error('已有未收尾的编辑任务，请查询并接收、续跑或取消');
   engine.plan(doc);const id=uuid();const next=Editions.job(doc,{id,snapshotId:uuid(),createdAt:stamp(),provider,model:chosen,binding:binding(),mediaIdentity:store.getMedia(key)?.identity});await save(doc,next);doc=current();const j=jobFor(doc,id),r=await client.submit(payload(doc,j));check();if(r.protocolVersion!==1)throw Error('提交结果待确认，请查询原任务');state.tasks={...state.tasks,[id]:verify(doc,j,r.task)};state.message='编辑任务已落盘。离页后继续，完成后可接收为新版本。';
  });},
  retry(key:string,id:string,consent:boolean){return action(key,async({current,check})=>{if(!consent)throw Error('请重新确认范围与额度');let doc=current();const j=jobFor(doc,id);if(j.cancel_requested)throw Error('此任务已请求取消');const existing=await lookup(doc,j);check();if(existing){state.tasks={...state.tasks,[id]:existing};state.message='已找回原任务，没有重复提交';return;}const r=await client.submit(payload(doc,j));check();state.tasks={...state.tasks,[id]:verify(doc,j,r.task)};});},
  resume(key:string,id:string,consent:boolean){return action(key,async({current,check})=>{if(!consent)throw Error('续跑需重新确认范围与额度');let doc=current(),j=jobFor(doc,id),t=await lookup(doc,j);check();if(!t||j.cancel_requested)throw Error('任务不存在或已请求取消');
   // An unresolved resume intent is queried, never silently replaced.
   if(j.resume){const found=await client.findResume(t.taskId,j.resume.key);check();if(found.receipt){state.tasks={...state.tasks,[id]:verify(doc,j,found.task)};if(found.task.status==='queued'||found.task.status==='running'){state.message='原续跑已确认';return;}if(found.task.attemptId!==j.resume.attempt_id){doc=current();await save(doc,Editions.jobUpdate(doc,id,{resume:undefined}));doc=current();j=jobFor(doc,id);t=verify(doc,j,found.task);}}}
   if(!t.resume?.eligible)throw Error('此任务当前不可续跑，请查询状态');
   if(!j.resume){const resume={key:uuid(),attempt_id:t.attemptId,input_digest:t.inputDigest};doc=current();await save(doc,Editions.jobUpdate(doc,id,{resume}));doc=current();j=jobFor(doc,id);}
   const r=await client.resume(t.taskId,{protocolVersion:1,consent:true,resumeKey:j.resume!.key,attemptId:j.resume!.attempt_id,inputDigest:j.resume!.input_digest});check();if(r.protocolVersion!==1||r.receipt?.key!==j.resume!.key||r.receipt?.fromAttemptId!==j.resume!.attempt_id||r.receipt?.attemptId!==r.task?.attemptId||r.task?.taskId!==t.taskId)throw Error('续跑回执身份不一致，请查询原任务');state.tasks={...state.tasks,[id]:verify(doc,j,r.task)};state.message='已明确续跑原任务，仅复用已落盘的批次。';
  });},
  cancel(key:string,id:string){return action(key,async({current,check})=>{let doc=current();const j=jobFor(doc,id);await save(doc,Editions.jobUpdate(doc,id,{cancel_requested:true}));doc=current();const t=await lookup(doc,j);check();if(!t){state.message='未找到已提交任务；取消意图已保存，禁止重试提交';return;}const r=await client.cancel(t.taskId,{expected:identity(t)});check();state.tasks={...state.tasks,[id]:verify(doc,j,r.task)};state.message='取消已请求，等待执行收尾。';});},
  receive(key:string,id:string){return action(key,async({current,check})=>{let doc=current();const j=jobFor(doc,id),t=await lookup(doc,j);check();doc=current();if(j.cancel_requested)throw Error('此任务已请求取消，未接收结果');const next=Editions.receive(doc,id,t,{createdAt:stamp()});await save(doc,next);state.message='编辑访谈稿已保存，可在阅读版本中打开；请核对来源。';});},
  changed(){state.connected=false;state.capability=null;state.tasks={};state.message='连接已变化，请检查原执行器';emit();},
  dispose(){closed=true;listeners.clear();}
 };
}
