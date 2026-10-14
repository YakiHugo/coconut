/* v1 task transport and source-bound receipt validation. */
(function(root){
 'use strict';
 const Summary=typeof module!=='undefined'&&module.exports?require('./summary.js'):root.CoconutSummary;
 const copy=value=>JSON.parse(JSON.stringify(value));
 function submission(document,{revision,provider,model,idempotencyKey,consent=false}={}){
  if(consent!==true)throw new Error('后台执行需要单独确认完整范围、额度与离页后继续');
  if(typeof document?.key!=='string'||!document.key||typeof revision!=='string'||!revision)throw new Error('需要文稿标识与当前 revision');
  if(!['codex','claude'].includes(provider)||typeof idempotencyKey!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(idempotencyKey))throw new Error('提供商或幂等键无效');
  const chosen=Summary.model(model);
  return {protocolVersion:1,...(chosen?{model:chosen}:{}),kind:'summary',idempotencyKey,document:{key:document.key,revision},provider,consent:true,segments:Summary.plan(document).source};
 }
 // A result is an independent receipt. Never mutate or overwrite the document.
 // Caller must use a revision including document lifetime; removing/reimporting
 // the same key is a new lifetime, even if the source text looks unchanged.
 function matchesResult(task,document,revision){
  if(task?.kind!=='summary'||task.status!=='succeeded'||task.document?.key!==document?.key||task.document?.revision!==revision||task.result?.purpose!=='summary')return false;
  try{if(Summary.model(task.model)!==Summary.model(task.result.requested_model))return false;}catch{return false;}
  const snapshot=task.result.input_snapshot;
  if(snapshot?.version!==1||!Array.isArray(snapshot.segments)||!Array.isArray(document.segments)||snapshot.segments.length!==document.segments.length||snapshot.segments.some((cue,i)=>!cue||!document.segments[i]||cue.id!==document.segments[i].id||cue.text!==document.segments[i].text))return false;
  const ids=new Set(snapshot.segments.map(cue=>cue.id)),result=task.result;
  if(typeof result.answer!=='string'||!result.answer.trim()||result.answer.length>Summary.LIMITS.answerCharacters||!Array.isArray(result.citations)||!result.citations.length||result.citations.length>Summary.LIMITS.chunks*Summary.LIMITS.noteCitations||result.citations.some(id=>!ids.has(id)))return false;
  return true;
 }
 function resultFor(task,document,revision){return matchesResult(task,document,revision)?copy(task.result):null;}
 // A standalone receipt can rescue an executor result after browser ownership
 // was lost. It is deliberately not a manuscript/library import and never
 // grants a document lifetime or supplies invented subtitle timestamps.
 function recoveryFor(task){
  try{
   if(task?.kind!=='summary'||task.status!=='succeeded'||typeof task.taskId!=='string'||!task.taskId||task.taskId.length>128||!['codex','claude'].includes(task.provider)||typeof task.document?.key!=='string'||!task.document.key||task.document.key.length>1000||typeof task.document.revision!=='string'||!task.document.revision||task.document.revision.length>200)return null;
   const model=Summary.model(task.model),result=task.result;if(model!==Summary.model(result?.requested_model))return null;if(result?.purpose!=='summary'||result.input_snapshot?.version!==1||typeof result.answer!=='string'||!result.answer.trim()||result.answer.length>Summary.LIMITS.answerCharacters)return null;
   const source=Summary.plan({segments:result.input_snapshot.segments}).source,ids=new Set(source.map(cue=>cue.id));
   if(!Array.isArray(result.citations)||!result.citations.length||result.citations.length>Summary.LIMITS.chunks*Summary.LIMITS.noteCitations||result.citations.some(id=>!ids.has(id)))return null;
   const identity={taskId:task.taskId,kind:task.kind,status:task.status,document:{key:task.document.key,revision:task.document.revision},provider:task.provider,...(model?{model}:{})};
   for(const key of ['attemptId','createdAt','updatedAt'])if(typeof task[key]==='string'&&task[key].length<=128)identity[key]=task[key];
   return {format:'coconut-background-summary-result',version:1,task:identity,result:{purpose:'summary',...(model?{requested_model:model}:{}),answer:result.answer,citations:[...new Set(result.citations)],input_snapshot:{version:1,segments:source}}};
  }catch{return null;}
 }
 function createClient({fetch:request=root.fetch.bind(root)}={}){
  async function call(endpoint,{body,signal}={}){
   const response=await request('api/v1/'+endpoint,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal});
   const value=await response.json();if(!response.ok){const error=new Error(value.error||'任务请求失败');error.status=response.status;error.code=value.code;throw error;}return value;
  }
  return Object.freeze({
   describe:options=>call('executor',options),
   async submit(value,{signal}={}){
    try{return await call('tasks',{body:value,signal});}
    catch(error){
     // Transport, parsing, or server write failures may occur after durable
     // acceptance. Query the original key; never generate a new key or retry.
     if(!error.status||error.status>=500){error.outcomeUnknown=true;error.idempotencyKey=value.idempotencyKey;}
     throw error;
    }
   },
   async resume(id,value,{signal}={}){
    try{return await call('tasks/'+encodeURIComponent(id)+'/resume',{body:value,signal});}
    catch(error){if(!error.status||error.status>=500){error.outcomeUnknown=true;error.resumeKey=value.resumeKey;}throw error;}
   },
   findResume:(id,key,options)=>call('tasks/'+encodeURIComponent(id)+'?resumeKey='+encodeURIComponent(key),options),
   findSubmission:(key,options)=>call('tasks?submissionKey='+encodeURIComponent(key),options),
   get:(id,options)=>call('tasks/'+encodeURIComponent(id),options),
   list:options=>call('tasks',options),
   listArchived:({after='',limit=20,...options}={})=>call('tasks?archived=true&limit='+encodeURIComponent(limit)+'&after='+encodeURIComponent(after),options),
   exportTask:(id,options)=>call('tasks/'+encodeURIComponent(id)+'/export',options),
   archive:(id,{expected,...options}={})=>call('tasks/'+encodeURIComponent(id)+'/archive',{...options,body:expected===undefined?{protocolVersion:1}:{protocolVersion:2,expected}}),
   restore:(id,options={})=>call('tasks/'+encodeURIComponent(id)+'/restore',{...options,body:{protocolVersion:1}}),
   cancel:(id,{expected,...options}={})=>call('tasks/'+encodeURIComponent(id)+'/cancel',{...options,body:expected===undefined?{protocolVersion:1}:{protocolVersion:2,expected}})
  });
 }
 const api={submission,matchesResult,resultFor,recoveryFor,createClient};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CoconutTasks=api;
})(typeof window!=='undefined'?window:globalThis);
