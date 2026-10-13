/* v1 task client foundation. Not wired into the reader UI; no automatic requests. */
(function(root){
 'use strict';
 const Summary=typeof module!=='undefined'&&module.exports?require('./summary.js'):root.CoconutSummary;
 const copy=value=>JSON.parse(JSON.stringify(value));
 function submission(document,{revision,provider,idempotencyKey,consent=false}={}){
  if(consent!==true)throw new Error('后台执行需要单独确认完整范围、额度与离页后继续');
  if(typeof document?.key!=='string'||!document.key||typeof revision!=='string'||!revision)throw new Error('需要文稿标识与当前 revision');
  if(!['codex','claude'].includes(provider)||typeof idempotencyKey!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(idempotencyKey))throw new Error('提供商或幂等键无效');
  return {protocolVersion:1,kind:'summary',idempotencyKey,document:{key:document.key,revision},provider,consent:true,segments:Summary.plan(document).source};
 }
 // A result is an independent receipt. Never mutate or overwrite the document.
 // Caller must use a revision including document lifetime; removing/reimporting
 // the same key is a new lifetime, even if the source text looks unchanged.
 function resultFor(task,document,revision){
  if(task?.kind!=='summary'||task.status!=='succeeded'||task.document?.key!==document?.key||task.document?.revision!==revision||task.result?.purpose!=='summary')return null;
  const snapshot=task.result.input_snapshot;
  if(snapshot?.version!==1||!Array.isArray(snapshot.segments)||!Array.isArray(document.segments)||snapshot.segments.length!==document.segments.length||snapshot.segments.some((cue,i)=>cue.id!==document.segments[i].id||cue.text!==document.segments[i].text))return null;
  return copy(task.result);
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
   findSubmission:(key,options)=>call('tasks?submissionKey='+encodeURIComponent(key),options),
   get:(id,options)=>call('tasks/'+encodeURIComponent(id),options),
   list:options=>call('tasks',options),
   cancel:(id,options={})=>call('tasks/'+encodeURIComponent(id)+'/cancel',{...options,body:{protocolVersion:1}})
  });
 }
 const api={submission,resultFor,createClient};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CoconutTasks=api;
})(typeof window!=='undefined'?window:globalThis);
