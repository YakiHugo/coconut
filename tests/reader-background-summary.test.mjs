/** DOM contract with authored text and a fake local executor. Never calls a model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {installSavePipeline,settle} from './helpers/save-pipeline.mjs';
const root=new URL('../',import.meta.url),journalKey='coconut-background-summary-v1';
const fixture=(title='Background source')=>({title,language:'en',segments:[{id:'one',start:0,end:3,text:'Authored first sentence.'},{id:'two',start:3,end:6,text:'Authored second sentence.'}]});
const descriptor={protocolVersion:1,executor:{type:'local-node',online:true},enabled:true,supportedTaskKinds:['summary'],remoteSubmission:false,archive:{supported:true,identityPrecondition:true},execution:{disconnect:'continue',restart:'interrupt_without_retry',cancel:'request_then_settle'},providers:{codex:{supported:true},claude:{supported:true}}};
function backend(){
 const tasks=new Map(),keys=new Map(),calls=[];let next=1;
 return {tasks,keys,calls,descriptor:structuredClone(descriptor),lost:false,hold:null,
  async fetch(url,options={}){
   const body=options.body&&JSON.parse(options.body);calls.push({url,body});
   const ok=value=>({ok:true,json:async()=>structuredClone(value)});
   if(url.endsWith('language-tools'))return ok({local_translation:true,ai:{codex:{ready:true},claude:{ready:true}}});
   if(url==='api/v1/executor')return ok(this.descriptor);
   if(url==='api/v1/tasks'&&body){
    const id=keys.get(body.idempotencyKey)||'task-'+next++;keys.set(body.idempotencyKey,id);
    if(!tasks.has(id))tasks.set(id,{taskId:id,attemptId:'attempt-'+id,inputDigest:'digest-'+id,idempotencyKey:body.idempotencyKey,kind:'summary',document:body.document,provider:body.provider,status:'running',progress:{completed:0,total:1},input:body.segments});
    if(this.hold)await this.hold;
    if(this.lost){this.lost=false;throw new Error('Lost receipt');}return ok({protocolVersion:1,task:tasks.get(id)});
   }
   if(url.startsWith('api/v1/tasks?submissionKey='))return ok({protocolVersion:1,task:tasks.get(keys.get(decodeURIComponent(url.split('=')[1])))||null});
   if(url==='api/v1/tasks')return ok({protocolVersion:1,tasks:[...tasks.values()].filter(task=>!task.archivedAt)});
   if(url.startsWith('api/v1/tasks?archived=true')){const params=new URL(url,'http://localhost').searchParams,all=[...tasks.values()].filter(task=>task.archivedAt).sort((a,b)=>a.taskId.localeCompare(b.taskId)),after=params.get('after'),limit=Number(params.get('limit')),remaining=all.filter(task=>!after||task.taskId>after),page=remaining.slice(0,limit);return ok({protocolVersion:1,tasks:page,total:all.length,nextCursor:remaining.length>limit?page.at(-1).taskId:null});}
   const archive=url.match(/^api\/v1\/tasks\/([^/]+)\/(archive|restore|export)$/);
   if(archive){const task=tasks.get(archive[1]);if(body?.protocolVersion===2&&['taskId','attemptId','inputDigest'].some(key=>body.expected?.[key]!==task?.[key]))return {ok:false,status:409,json:async()=>({code:'task_identity_conflict',error:'Authored identity conflict'})};if(archive[2]==='export')return ok({protocolVersion:1,record:{format:'coconut-background-task-record',version:1,task:{...task,snapshot:task.input}}});if(archive[2]==='archive')task.archivedAt='2026-10-14T00:00:00.000Z';else delete task.archivedAt;if(this.archiveLost){this.archiveLost=false;throw new Error('Lost archive response');}return ok({protocolVersion:1,task});}

   const match=url.match(/^api\/v1\/tasks\/([^/]+)(\/cancel)?$/);
   if(match){const task=tasks.get(match[1]);if(!task)return {ok:false,status:404,json:async()=>({code:'not_found',error:'Authored missing task'})};if(match[2])task.status='cancelled';return ok({protocolVersion:1,task});}
   throw new Error('Unexpected endpoint '+url);
  },
  succeed(id=[...tasks.keys()][0]){const task=tasks.get(id);task.status='succeeded';task.result={question:'Summary',purpose:'summary',answer:'Fake background summary.',provider:task.provider,citations:['one'],input_snapshot:{version:1,segments:task.input},summary_process:{version:1,batches:1,requests:1}};}
 };
}
function setup(api=backend(),storage={},options={}){
 const w=new Window({url:'http://127.0.0.1:8080/'});Object.defineProperty(w,'crypto',{value:webcrypto});
 if(options.mobile){const original=w.matchMedia.bind(w);w.matchMedia=query=>query==='(max-width: 650px)'?{matches:true,addEventListener(){}}:original(query);}
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 for(const [key,value] of Object.entries(storage))w.localStorage.setItem(key,value);
 if(options.phase)w.CoconutStorageBootstrap={phase:options.phase};
 w.fetch=api.fetch.bind(api);
 const pipeline=installSavePipeline(w);
 w.eval(['summary','core','passages','passage-playback','app','language','task-client','background-summary'].filter(name=>!options.omitTasks||name!=='task-client').map(name=>new URL('reader/'+name+'.js',root)).filter(file=>fs.existsSync(file)).map(file=>fs.readFileSync(file,'utf8')).join('\n')+'\nwindow.__test={doc:()=>active(),select:key=>{selectActiveDocument(key);render();}};');
 const $=id=>w.document.getElementById(id);
 return {w,$,api,pipeline,doc:()=>w.__test.doc(),snapshot:()=>Object.fromEntries(Array.from({length:w.localStorage.length},(_,i)=>{const k=w.localStorage.key(i);return [k,w.localStorage.getItem(k)];})),async import(doc=fixture()){
  const text=JSON.stringify(doc);Object.defineProperty($('file'),'files',{configurable:true,value:[{name:'authored.json',size:text.length,text:async()=>text}]});await $('file').onchange();
 },async choose(){
  $('prepare-summary').click();assert.ok($('summary-execution'),'explicit execution mode must exist');assert.equal($('summary-execution').value,'foreground');
  $('summary-execution').value='background';await $('summary-execution').onchange();await $('background-refresh').onclick();
 },async submit(){ $('ai-consent').checked=true;await $('ask-ai').onclick(); },async refresh(){await $('background-refresh').onclick();}};
}
const posted=api=>api.calls.filter(c=>c.url==='api/v1/tasks'&&c.body);

test('compact tasks expose current activity and summary shortcut opens the real ancestors without resubmitting',async()=>{
 const h=setup(backend(),{},{mobile:true});try{
  await h.import();assert.equal(h.$('background-tasks').parentElement.id,'library-tools-content');
  assert.equal(h.$('library-background-task-status').hidden,true);
  await h.choose();await h.submit();assert.match(h.$('library-background-task-status').textContent,/进行中 1/);
  h.$('library-tools').open=false;h.$('background-tasks').open=false;
  h.$('summary-open-background-tasks').click();await h.refresh();
  assert.equal(h.$('library-tools').open,true);assert.equal(h.$('background-tasks').open,true);
  assert.equal(h.w.document.activeElement,h.$('background-tasks').querySelector('summary'));assert.equal(posted(h.api).length,1);
  h.api.succeed();await h.refresh();assert.match(h.$('library-background-task-status').textContent,/待接收 1/);
 }finally{await h.w.happyDOM.close();}
});

test('background is an explicit whole-source mode with one consent; panel closure does not cancel',async()=>{
 const h=setup();try{await h.import();await h.choose();assert.match(h.$('ai-consent-copy').textContent,/后台.*收起|收起.*后台/);assert.match(h.$('ai-send-description').textContent,/重启.*自动/);
 h.$('ai-consent').checked=false;await h.$('ask-ai').onclick();assert.equal(posted(h.api).length,0);
 await h.submit();assert.equal(posted(h.api).length,1);assert.equal(posted(h.api)[0].body.segments.length,2);assert.ok(h.w.localStorage.getItem(journalKey));
 h.$('close-summary-request').click();assert.equal(h.api.calls.filter(c=>c.url.endsWith('/cancel')).length,0);assert.match(h.$('background-task-list').textContent,/执行中/);
 }finally{await h.w.happyDOM.close();}
});
test('reload finds task and completed result requires explicit acceptance, exactly once',async()=>{
 let h=setup();const api=h.api;let storage;try{await h.import();await h.choose();await h.submit();storage=h.snapshot();}finally{await h.w.happyDOM.close();}
 api.succeed();h=setup(api,storage);try{await h.refresh();assert.equal(posted(api).length,1);assert.equal(h.doc().ai_answers.length,0);assert.match(h.$('background-task-list').textContent,/Fake background summary/);
 const accept=h.$('background-task-list').querySelector('[data-action="accept"]');assert.ok(accept&&!accept.disabled);await accept.onclick();assert.equal(h.doc().ai_answers.length,1);await accept.onclick();assert.equal(h.doc().ai_answers.length,1);
 storage=h.snapshot();}finally{await h.w.happyDOM.close();}
 h=setup(api,storage);try{await h.refresh();assert.equal(h.doc().ai_answers.length,1);assert.match(h.$('background-task-list').textContent,/已接收/);}finally{await h.w.happyDOM.close();}
});
test('lost receipt, repeated clicks and refresh recover same submission key without model retry',async()=>{
 const h=setup();try{await h.import();await h.choose();let release;h.api.hold=new Promise(r=>release=r);h.api.lost=true;const first=h.submit();await new Promise(r=>setTimeout(r,30));const second=h.submit();release();await Promise.all([first,second]);
 await h.refresh();assert.equal(posted(h.api).length,1);assert.equal(h.api.tasks.size,1);assert.match(h.$('background-task-list').textContent,/task-1/);
 }finally{await h.w.happyDOM.close();}
});
test('source change or document switch blocks acceptance; no result is written to another document',async()=>{
 const h=setup();try{await h.import();await h.choose();await h.submit();const original=h.doc();await h.import(fixture('Other'));h.api.succeed();await h.refresh();assert.equal(h.$('background-task-list').querySelector('[data-action="accept"]').disabled,true);assert.equal(h.doc().ai_answers.length,0);
 h.w.__test.select(original.key);original.segments[0].text+=' changed';await h.refresh();assert.equal(h.$('background-task-list').querySelector('[data-action="accept"]').disabled,true);assert.equal(original.ai_answers.length,0);
 }finally{await h.w.happyDOM.close();}
});
test('explicit cancellation remains cancellation when a stale success response arrives',async()=>{
 const h=setup();try{await h.import();await h.choose();await h.submit();await h.$('background-task-list').querySelector('[data-action="cancel"]').onclick();h.api.succeed();await h.refresh();assert.equal(h.doc().ai_answers.length,0);assert.ok(!h.$('background-task-list').querySelector('[data-action="accept"]'));assert.match(h.$('background-task-list').textContent,/取消/);
 }finally{await h.w.happyDOM.close();}
});
test('restart interrupted is visible with no automatic resume or new intent',async()=>{
 const h=setup();try{await h.import();await h.choose();await h.submit();h.api.tasks.get('task-1').status='interrupted';await h.refresh();assert.match(h.$('background-task-list').textContent,/中断.*不会自动/);assert.equal(posted(h.api).length,1);
 }finally{await h.w.happyDOM.close();}
});
test('incompatible or unavailable executor blocks background only; reading and foreground remain usable',async()=>{
 const h=setup();try{await h.import();h.api.descriptor.protocolVersion=2;await h.choose();assert.equal(h.$('ask-ai').disabled,true);assert.match(h.$('background-executor-status').textContent,/版本/);assert.equal(h.doc().segments.length,2);assert.equal(posted(h.api).length,0);
 h.$('summary-execution').value='foreground';await h.$('summary-execution').onchange();assert.match(h.$('ai-send-description').textContent,/停止/);
 }finally{await h.w.happyDOM.close();}
});

test('scope/provider changes revoke consent and an already running equivalent intent is not duplicated',async()=>{
 const h=setup();try{await h.import();await h.choose();h.$('ai-consent').checked=true;h.$('ai-provider').value='claude';h.$('ai-provider').onchange();assert.equal(h.$('ai-consent').checked,false);await h.$('ask-ai').onclick();assert.equal(posted(h.api).length,0);
 await h.submit();await h.submit();assert.equal(posted(h.api).length,1);assert.equal(posted(h.api)[0].body.provider,'claude');
 }finally{await h.w.happyDOM.close();}
});
test('a source edit after rendering a success still blocks the old accept handler',async()=>{
 const h=setup();try{await h.import();await h.choose();await h.submit();h.api.succeed();await h.refresh();const accept=h.$('background-task-list').querySelector('[data-action="accept"]');h.doc().segments[0].text='Changed after preview';await accept.onclick();assert.equal(h.doc().ai_answers.length,0);
 }finally{await h.w.happyDOM.close();}
});
test('remove/reimport and library backup cannot inherit old task ownership',async()=>{
 const h=setup();try{await h.import();await h.choose();await h.submit();const old=structuredClone(h.doc());h.$('library-options').open=true;h.$('library-options').dispatchEvent(new h.w.Event('toggle'));h.$('library').querySelector('.library-remove').click();await h.$('confirm-removal').onclick();await h.import(old);assert.equal(h.doc().background_summary_lifetime,undefined);h.api.succeed();await h.refresh();assert.equal(h.$('background-task-list').querySelector('[data-action="accept"]').disabled,true);assert.equal(h.doc().ai_answers.length,0);
 const restored=h.w.Coconut.mergeLibraryBackup({documents:[],active:null},{format:'coconut-library',version:1,documents:[old],active:old.key});assert.equal(restored.documents[0].background_summary_lifetime,undefined);
 }finally{await h.w.happyDOM.close();}
});
test('identity save failure and journal quota failure prevent submission',async()=>{
 const h=setup();try{await h.import();await h.choose();h.pipeline.hold();const pending=h.submit();await settle();assert.equal(h.pipeline.writes.length,1);h.pipeline.writes.shift().fail('quota');await pending;assert.equal(posted(h.api).length,0);assert.match(h.$('background-task-message').textContent,/身份未保存/);
 }finally{await h.w.happyDOM.close();}
 const j=setup();try{await j.import();await j.choose();const backing=j.w.localStorage;Object.defineProperty(j.w,'localStorage',{configurable:true,value:{getItem:key=>backing.getItem(key),setItem(key,value){if(key===journalKey)throw new j.w.DOMException('Journal quota','QuotaExceededError');backing.setItem(key,value);}}});await j.submit();assert.equal(posted(j.api).length,0);assert.match(j.$('background-task-message').textContent,/关联未保存/);
 }finally{await j.w.happyDOM.close();}
});
test('navigation or source changes during identity persistence do not submit a stale confirmation',async()=>{
 const h=setup();try{await h.import();await h.choose();h.pipeline.hold();const pending=h.submit();await settle();h.doc().segments[0].text='Edited during save';h.pipeline.hold(false);h.pipeline.writes.shift().commit();await pending;assert.equal(posted(h.api).length,0);assert.match(h.$('background-task-message').textContent,/已变化/);
 }finally{await h.w.happyDOM.close();}
});
test('acceptance persistence failure is visible and retrying accept cannot duplicate history',async()=>{
 const h=setup();try{await h.import();await h.choose();await h.submit();h.api.succeed();await h.refresh();h.doc().notes.one='New personal note';h.pipeline.hold();const node=h.$('background-task-list').querySelector('[data-action="accept"]'),pending=node.onclick();await settle();h.pipeline.writes.shift().fail('quota');await pending;await node.onclick();assert.equal(h.doc().ai_answers.length,1);assert.equal(h.doc().notes.one,'New personal note');assert.match(h.$('background-task-message').textContent,/尚未保存/);
 }finally{await h.w.happyDOM.close();}
});
test('missing receipt may resend only its exact saved key and payload after explicit action',async()=>{
 let h=setup();const api=h.api;let storage;try{await h.import();await h.choose();api.lost=true;await h.submit();storage=h.snapshot();api.tasks.clear();api.keys.clear();}finally{await h.w.happyDOM.close();}
 h=setup(api,storage);try{await h.refresh();assert.equal(posted(api).length,1);const retry=h.$('background-task-list').querySelector('[data-action="resubmit"]');assert.ok(retry);await retry.onclick();assert.equal(posted(api).length,2);assert.deepEqual(posted(api)[0].body,posted(api)[1].body);
 }finally{await h.w.happyDOM.close();}
});
test('cancel fences an earlier in-flight success lookup and survives reload',async()=>{
 const h=setup();let storage;try{await h.import();await h.choose();await h.submit();h.api.succeed();let release,started;const ready=new Promise(r=>started=r),original=h.api.fetch.bind(h.api);
 // Replace get result with a delayed response at the API object's task clone.
 const gate=new Promise(r=>release=r);let once=true; // A refreshed client captures the delayed read.
 storage=h.snapshot();await h.w.happyDOM.close();
 const api=h.api;api.fetch=async(url,options)=>{if(url==='api/v1/tasks/task-1'&&!options?.body&&once){once=false;const result=await original(url,options);started();await gate;return result;}return original(url,options);};
 const next=setup(api,storage);try{await ready;const cancel=next.$('background-task-list').querySelector('[data-action="cancel"]');assert.ok(cancel);await cancel.onclick();release();await next.refresh();assert.match(next.$('background-task-list').textContent,/取消/);assert.equal(next.doc().ai_answers.length,0);assert.ok(!next.$('background-task-list').querySelector('[data-action="accept"]'));}finally{release();await next.w.happyDOM.close();}
 }finally{await h.w.happyDOM.close();}
});
test('corrupt journal is preserved; read-only connection checks do not launch a task',async()=>{
 const h=setup(backend(),{[journalKey]:'{"version":99}'});try{await h.import();await h.choose();assert.equal(h.$('ask-ai').disabled,true);assert.equal(h.w.localStorage.getItem(journalKey),'{"version":99}');assert.equal(posted(h.api).length,0);assert.equal(h.doc().segments.length,2);
 }finally{await h.w.happyDOM.close();}
});

test('DOM to real local bridge: close/reload during fake-provider batches, then accept persisted result',async t=>{
 const {startBridge}=await import('../desktop/server.mjs'),os=await import('node:os'),path=await import('node:path');
 const directory=await fs.promises.mkdtemp(path.join(os.tmpdir(),'coconut-background-ui-'));let release;const gate=new Promise(r=>release=r),calls=[];
 const providers={ask:async(data,options)=>{calls.push({data,options});if(calls.length===1)await gate;return {answer:'Fake provider summary only.',citations:[data.segments[0].id]};},status:()=>{throw new Error('Must not probe CLI');}};
 const server=await startBridge({port:0,taskDirectory:directory,providers}),origin=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{release();await new Promise(resolve=>server.shutdown(resolve));await fs.promises.rm(directory,{recursive:true,force:true});});
 const api={fetch:(url,options={})=>fetch(origin+'/'+url,{...options,headers:{...options.headers,Origin:origin}})};
 let h=setup(api),storage,id;try{const doc=fixture();doc.segments=Array.from({length:401},(_,i)=>({id:'source-'+i,start:i,end:i+1,text:'Authored source sentence '+i}));await h.import(doc);await h.choose();await h.submit();storage=h.snapshot();id=JSON.parse(storage[journalKey]).entries[0].task.taskId;h.$('close-summary-request').click();
 for(let i=0;i<100&&!calls.length;i++)await new Promise(r=>setTimeout(r,5));assert.equal(calls.length,1);assert.equal(calls[0].options.signal.aborted,false);
 }finally{await h.w.happyDOM.close();}
 release();let task;for(let i=0;i<100;i++){task=(await(await api.fetch('api/v1/tasks/'+id)).json()).task;if(task.status==='succeeded')break;await new Promise(r=>setTimeout(r,10));}assert.equal(task.status,'succeeded');assert.equal(calls.length,3);
 h=setup(api,storage);try{await h.refresh();assert.equal(h.doc().ai_answers.length,0);await h.$('background-task-list').querySelector('[data-action="accept"]').onclick();assert.equal(h.doc().ai_answers.length,1);assert.equal(h.doc().ai_answers[0].input_snapshot.segments.length,401);assert.equal(calls.length,3);assert.equal(JSON.parse(h.w.localStorage.getItem(journalKey)).entries[0].task.result,undefined);
 }finally{await h.w.happyDOM.close();}
});

test('lost receipt can be cancelled by original key without resubmitting',async()=>{
 const h=setup();try{await h.import();await h.choose();h.api.lost=true;await h.submit();const cancel=h.$('background-task-list').querySelector('[data-action="cancel"]');assert.ok(cancel);await cancel.onclick();assert.equal(h.api.tasks.get('task-1').status,'cancelled');assert.equal(posted(h.api).length,1);assert.match(h.$('background-task-list').textContent,/已取消/);
 }finally{await h.w.happyDOM.close();}
});
test('a missing intent with changed source cannot be resent',async()=>{
 const h=setup();try{await h.import();await h.choose();h.api.lost=true;await h.submit();h.api.tasks.clear();h.api.keys.clear();await h.refresh();const retry=h.$('background-task-list').querySelector('[data-action="resubmit"]');h.doc().segments[0].text='New source';await retry.onclick();assert.equal(posted(h.api).length,1);
 }finally{await h.w.happyDOM.close();}
});
test('malformed stored source cannot break ordinary reading or overwrite its journal',async()=>{
 const raw=JSON.stringify({version:1,entries:[{key:'same',lifetime:'00000000-0000-0000-0000-000000000000',payload:{protocolVersion:1,kind:'summary',consent:true,provider:'codex',idempotencyKey:'same',document:{key:'x',revision:'r'},segments:[null]}}]});const h=setup(backend(),{[journalKey]:raw});try{await h.import();assert.equal(h.doc().segments.length,2);await h.choose();assert.equal(h.$('ask-ai').disabled,true);assert.equal(h.w.localStorage.getItem(journalKey),raw);}finally{await h.w.happyDOM.close();}
});

test('real bridge restart interrupts a pending fake provider and changed source cannot restart it',async t=>{
 const {startBridge}=await import('../desktop/server.mjs'),os=await import('node:os'),path=await import('node:path');
 const directory=await fs.promises.mkdtemp(path.join(os.tmpdir(),'coconut-background-restart-'));let calls=0,server,origin;
 const providers={ask:async(data,{signal})=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Executor stopped')),{once:true}));},status:()=>{throw new Error('No CLI');}};
 server=await startBridge({port:0,taskDirectory:directory,providers});origin=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{if(server)await new Promise(resolve=>server.shutdown(resolve));await fs.promises.rm(directory,{recursive:true,force:true});});
 const api={fetch:(url,options={})=>fetch(origin+'/'+url,{...options,headers:{...options.headers,Origin:origin}})};
 let h=setup(api),storage;try{await h.import();await h.choose();await h.submit();for(let i=0;i<100&&!calls;i++)await new Promise(r=>setTimeout(r,5));assert.equal(calls,1);storage=h.snapshot();}finally{await h.w.happyDOM.close();}
 await new Promise(resolve=>server.shutdown(resolve));server=null;const docState=JSON.parse(storage['coconut-reader-v1']);docState.documents[0].segments[0].text='Changed source before restart';storage['coconut-reader-v1']=JSON.stringify(docState);
 server=await startBridge({port:0,taskDirectory:directory,providers});origin=`http://127.0.0.1:${server.address().port}`;
 h=setup(api,storage);try{await h.refresh();assert.match(h.$('background-task-list').textContent,/中断.*不会自动/);assert.equal(calls,1);assert.equal(h.doc().ai_answers.length,0);assert.ok(!h.$('background-task-list').querySelector('[data-action="resubmit"]'));}finally{await h.w.happyDOM.close();}
});

test('storage bootstrap readiness enables a refreshed result only after the ingress barrier opens',async()=>{
 let h=setup();const api=h.api;let storage;try{await h.import();await h.choose();await h.submit();storage=h.snapshot();}finally{await h.w.happyDOM.close();}
 api.succeed();h=setup(api,storage,{phase:'loading'});try{await h.refresh();assert.equal(h.$('background-task-list').querySelector('[data-action="accept"]').disabled,true);h.w.CoconutStorageBootstrap.phase='ready';h.w.dispatchEvent(new h.w.Event('coconut-storage-ready'));assert.equal(h.$('background-task-list').querySelector('[data-action="accept"]').disabled,false);assert.equal(h.doc().ai_answers.length,0);
 }finally{await h.w.happyDOM.close();}
});
test('returning through pageshow refreshes task state without resending or cancelling',async()=>{
 const h=setup();try{await h.import();await h.choose();await h.submit();h.w.dispatchEvent(new h.w.Event('pagehide'));h.api.succeed();h.w.dispatchEvent(new h.w.Event('pageshow'));await h.refresh();assert.match(h.$('background-task-list').textContent,/已完成/);assert.equal(posted(h.api).length,1);assert.equal(h.api.calls.filter(c=>c.url.endsWith('/cancel')).length,0);
 }finally{await h.w.happyDOM.close();}
});

for(const change of ['cancel','source','remove','storage','ingress'])test(change+' during missing-key lookup must prevent resubmission',async()=>{
 const api=backend(),original=api.fetch.bind(api);let hold=false,release,started;
 const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 api.fetch=async(url,options)=>{const result=await original(url,options);if(hold&&url.startsWith('api/v1/tasks?submissionKey=')){hold=false;started();await gate;}return result;};
 const h=setup(api);try{
  await h.import();await h.choose();h.api.lost=true;await h.submit();h.api.tasks.clear();h.api.keys.clear();await h.refresh();
  const retry=h.$('background-task-list').querySelector('[data-action="resubmit"]');assert.ok(retry);hold=true;
  const pending=retry.onclick();await ready;
  if(change==='cancel')await h.$('background-task-list').querySelector('[data-action="cancel"]').onclick();
  if(change==='source')h.doc().segments[0].text='Edited while resend lookup pending';
  if(change==='remove'){h.$('library-options').open=true;h.$('library-options').dispatchEvent(new h.w.Event('toggle'));h.$('library').querySelector('.library-remove').click();await h.$('confirm-removal').onclick();}
  if(change==='storage')h.w.dispatchEvent(new h.w.StorageEvent('storage',{key:journalKey,newValue:'changed elsewhere'}));
  if(change==='ingress')h.w.CoconutStorageBootstrap={phase:'loading'};
  release();await pending;
  assert.equal(posted(api).length,1,'Should not POST after '+change+' invalidated resubmit');
 }finally{release();await h.w.happyDOM.close();}
});

for(const terminal of ['succeeded','failed','interrupted'])test('late cancel reports settled '+terminal+' without waiting forever',async()=>{
 const h=setup();try{await h.import();await h.choose();await h.submit();const cancel=h.$('background-task-list').querySelector('[data-action="cancel"]'),task=h.api.tasks.get('task-1');h.api.succeed();Object.defineProperty(task,'status',{get:()=>terminal,set:()=>{},enumerable:true});await cancel.onclick();assert.ok(!h.$('background-task-list').querySelector('[data-action="accept"]'));assert.ok(!h.$('background-task-list').querySelector('[data-action="cancel"]'));assert.doesNotMatch(h.$('background-task-list').textContent,/未确认执行收尾/);assert.match(h.$('background-task-list').textContent,/已结束.*放弃接收/);
 }finally{await h.w.happyDOM.close();}
});
test('an older list response cannot replace a newer cancellation receipt',async()=>{
 const api=backend(),original=api.fetch.bind(api);let hold=false,release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 api.fetch=async(url,options)=>{const result=await original(url,options);if(hold&&url==='api/v1/tasks'&&!options?.body){hold=false;const snapshot=await result.json();started();await gate;return {ok:true,json:async()=>snapshot};}return result;};
 const h=setup(api);try{await h.import();await h.choose();await h.submit();hold=true;const pending=h.refresh();await ready;await h.$('background-task-list').querySelector('[data-action="cancel"]').onclick();release();await pending;assert.equal(JSON.parse(h.w.localStorage.getItem(journalKey)).entries[0].task.status,'cancelled');assert.match(h.$('background-task-list').textContent,/已取消/);
 }finally{release();await h.w.happyDOM.close();}
});
test('an older cancel response cannot regress a newer settled cancellation',async()=>{
 const api=backend(),original=api.fetch.bind(api);let release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 api.fetch=async(url,options)=>{const result=await original(url,options);if(url.endsWith('/cancel')){const snapshot=await result.json();snapshot.task.status='cancel_requested';started();await gate;return {ok:true,json:async()=>snapshot};}return result;};
 const h=setup(api);try{await h.import();await h.choose();await h.submit();const pending=h.$('background-task-list').querySelector('[data-action="cancel"]').onclick();await ready;await h.refresh();release();await pending;assert.equal(JSON.parse(h.w.localStorage.getItem(journalKey)).entries[0].task.status,'cancelled');assert.match(h.$('background-task-list').textContent,/已取消/);
 }finally{release();await h.w.happyDOM.close();}
});

for(const withJournal of [false,true])test('missing task client preserves reading and journal: '+withJournal,async()=>{
 const api=backend();let storage={};
 if(withJournal){const original=setup(api);try{await original.import();await original.choose();await original.submit();storage=original.snapshot();}finally{await original.w.happyDOM.close();}}
 const h=setup(api,storage,{omitTasks:true});try{if(!withJournal)await h.import();const before=api.calls.length,journal=h.w.localStorage.getItem(journalKey);assert.equal(h.doc().segments.length,2);await h.choose();assert.equal(h.$('ask-ai').disabled,true);assert.match(h.$('summary-background-status').textContent,/缺少后台任务模块/);await h.submit();assert.equal(api.calls.length,before);assert.equal(h.w.localStorage.getItem(journalKey),journal);assert.equal(h.doc().segments.length,2);assert.equal(h.doc().ai_answers.length,0);
 }finally{await h.w.happyDOM.close();}
});

test('production HTML dependency graph enables one explicit background submission',async()=>{
 const w=new Window({url:'http://127.0.0.1:8080/'}),api=backend(),context=vm.createContext(w),run=source=>vm.runInContext(source,context),$=id=>w.document.getElementById(id);
 try{
  const html=fs.readFileSync(new URL('reader/index.html',root),'utf8');w.document.body.innerHTML=html.split('<body>')[1].split('</body>')[0];Object.defineProperty(w,'crypto',{value:webcrypto});
  w.fetch=async(url,options)=>url==='api/health'?{ok:true,json:async()=>({})}:api.fetch(url,options);
  w.document.head.innerHTML=[...html.matchAll(/<script\b[^>]*data-reader-script[^>]*>[\s\S]*?<\/script>/g)].map(match=>match[0]).join('');
  const admitted=[];w.document.head.append=script=>{const name=new URL(script.src).pathname.slice(1);admitted.push(name);try{run(fs.readFileSync(new URL('reader/'+name,root),'utf8'));queueMicrotask(()=>script.onload());}catch(error){script.onerror(error);}};
  const ordinary=[...html.matchAll(/<script\b([^>]*)>[\s\S]*?<\/script>/g)].filter(match=>!match[1].includes('data-reader-script')).map(match=>match[1].match(/\bsrc="([^"]+)"/)?.[1]).filter(Boolean);
  for(const src of ordinary)run(fs.readFileSync(new URL('reader/'+src.split('?')[0],root),'utf8'));
  for(let i=0;i<100&&w.CoconutStorageBootstrap.phase==='loading';i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(w.CoconutStorageBootstrap.phase,'ready',$('storage-startup-message').textContent);assert.ok(admitted.includes('background-summary.js'));assert.equal(api.calls.length,0);
  const value=JSON.stringify(fixture());Object.defineProperty($('file'),'files',{configurable:true,value:[{name:'production.json',size:value.length,text:async()=>value}]});await $('file').onchange();
  $('mode-summary').click();$('prepare-summary').click();$('summary-execution').value='background';await $('summary-execution').onchange();assert.equal($('ask-ai').disabled,false);assert.equal(posted(api).length,0);
  $('ai-consent').checked=true;await $('ask-ai').onclick();assert.equal(posted(api).length,1);assert.equal(posted(api)[0].body.segments.length,2);assert.match($('background-task-list').textContent,/task-1/);assert.equal(run('active().ai_answers.length'),0);
 }finally{w.dispatchEvent(new w.Event('pagehide'));await w.happyDOM.close();}
});

test('cleared browser association can inspect and export a completed task without adopting it',async()=>{
 const api=backend();let original=setup(api);try{await original.import();await original.choose();await original.submit();api.succeed();}finally{await original.w.happyDOM.close();}
 const h=setup(api),downloads=[];try{
  await h.import(fixture('Unrelated current manuscript'));const before=JSON.stringify(h.doc());await h.refresh();
  assert.equal(h.$('background-task-list').querySelector('[data-action="accept"]'),null);
  const view=h.$('background-task-list').querySelector('[data-action="view-result"]');assert.ok(view,'unassociated completed results must remain retrievable');
  assert.equal(api.calls.filter(call=>call.url==='api/v1/tasks/task-1').length,0,'list reads must not eagerly fetch full source snapshots');
  await view.onclick();assert.match(h.$('background-task-list').textContent,/Fake background summary/);assert.match(h.$('background-task-list').textContent,/Authored first sentence/);
  h.w.URL.createObjectURL=blob=>{downloads.push(blob);return 'blob:summary-recovery';};h.w.URL.revokeObjectURL=()=>{};
  const clicks=[];h.w.HTMLAnchorElement.prototype.click=function(){clicks.push({download:this.download,href:this.href});};
  await h.$('background-task-list').querySelector('[data-action="export-result"]').onclick();
  assert.equal(downloads.length,1);assert.match(clicks[0].download,/\.json$/);const saved=JSON.parse(await downloads[0].text());
  assert.equal(saved.format,'coconut-background-summary-result');assert.equal(saved.version,1);assert.equal(saved.task.taskId,'task-1');assert.equal(saved.result.answer,'Fake background summary.');assert.equal(saved.result.input_snapshot.segments.length,2);
  assert.equal(saved.background_summary_lifetime,undefined);assert.equal(saved.documents,undefined);assert.equal(saved.segments,undefined,'standalone result is not a manuscript import');
  assert.equal(JSON.stringify(h.doc()),before);assert.equal(JSON.parse(h.w.localStorage.getItem(journalKey)).entries.length,0);assert.equal(posted(api).length,1);assert.equal(api.calls.filter(call=>call.url.endsWith('/cancel')).length,0);
  assert.match(h.$('background-task-message').textContent,/已发起.*下载.*确认/);
 }finally{await h.w.happyDOM.close();}
});

test('unassociated result load is deduplicated and a failed read stays explicitly retryable',async()=>{
 const api=backend();const original=setup(api);try{await original.import();await original.choose();await original.submit();api.succeed();}finally{await original.w.happyDOM.close();}
 const request=api.fetch.bind(api);let release,started,fail=true;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 api.fetch=async(url,options)=>{if(url==='api/v1/tasks/task-1'&&fail){started();await gate;throw new Error('Temporary disconnect');}return request(url,options);};
 const h=setup(api);try{
  await h.refresh();const view=h.$('background-task-list').querySelector('[data-action="view-result"]');assert.ok(view);const pending=view.onclick();await ready;await view.onclick();
  assert.equal(h.$('background-task-list').querySelector('[data-action="view-result"]').getAttribute('aria-disabled'),'true');release();await pending;assert.match(h.$('background-task-list').textContent,/Temporary disconnect/);assert.equal(h.$('background-task-list').querySelector('[data-action="export-result"]'),null);
  fail=false;await h.$('background-task-list').querySelector('[data-action="view-result"]').onclick();assert.match(h.$('background-task-list').textContent,/Fake background summary/);assert.equal(posted(api).length,1);
 }finally{release();await h.w.happyDOM.close();}
});

for(const corruption of ['identity','citation','source','answer'])test('unassociated result rejects mismatched or incomplete '+corruption,async()=>{
 const api=backend(),original=setup(api);try{await original.import();await original.choose();await original.submit();api.succeed();}finally{await original.w.happyDOM.close();}
 const request=api.fetch.bind(api);api.fetch=async(url,options)=>{const response=await request(url,options);if(url!=='api/v1/tasks/task-1')return response;const value=await response.json();if(corruption==='identity')value.task.document.revision='different-revision';if(corruption==='citation')value.task.result.citations=['nonexistent'];if(corruption==='source')value.task.result.input_snapshot.segments[1].id='one';if(corruption==='answer')value.task.result.answer='';return {ok:true,json:async()=>value};};
 const h=setup(api);try{await h.refresh();const view=h.$('background-task-list').querySelector('[data-action="view-result"]');assert.ok(view);await view.onclick();assert.match(h.$('background-task-list').textContent,/无法读取/);assert.equal(h.$('background-task-list').querySelector('[data-action="export-result"]'),null);assert.equal(posted(api).length,1);}finally{await h.w.happyDOM.close();}
});

test('a removed source still permits standalone rescue, and a failed download changes no document',async()=>{
 const h=setup();try{
  await h.import();await h.choose();await h.submit();h.api.succeed();await h.refresh();h.$('library-options').open=true;h.$('library-options').dispatchEvent(new h.w.Event('toggle'));h.$('library').querySelector('.library-remove').click();await h.$('confirm-removal').onclick();await h.refresh();
  assert.equal(h.$('background-task-list').querySelector('[data-action="accept"]').disabled,true);const download=h.$('background-task-list').querySelector('[data-action="export-result"]');assert.ok(download);
  const before=h.snapshot();h.w.URL.createObjectURL=()=>{throw new Error('Download not available');};await download.onclick();assert.match(h.$('background-task-message').textContent,/下载失败/);assert.deepEqual(h.snapshot(),before);assert.match(h.$('background-task-list').textContent,/Fake background summary/);
  const files=[];h.w.URL.createObjectURL=blob=>{files.push(blob);return 'blob:rescue';};h.w.HTMLAnchorElement.prototype.click=function(){};await download.onclick();assert.equal(files.length,1);assert.equal(JSON.parse(await files[0].text()).result.input_snapshot.segments[0].text,fixture().segments[0].text);assert.equal(posted(h.api).length,1);
 }finally{await h.w.happyDOM.close();}
});

test('damaged association journal stays untouched while independent results are rescued',async()=>{
 const api=backend(),original=setup(api);try{await original.import();await original.choose();await original.submit();api.succeed();}finally{await original.w.happyDOM.close();}
 const raw='{"version":1,"entries": [broken',h=setup(api,{[journalKey]:raw});try{await h.refresh();await h.$('background-task-list').querySelector('[data-action="view-result"]').onclick();assert.match(h.$('background-task-list').textContent,/Fake background summary/);assert.ok(h.$('background-task-list').querySelector('[data-action="export-result"]'));assert.equal(h.w.localStorage.getItem(journalKey),raw);assert.equal(h.$('background-task-list').querySelector('[data-action="accept"]'),null);assert.equal(posted(api).length,1);}finally{await h.w.happyDOM.close();}
});

for(const change of ['removed','failed','identity'])test('late independent result cannot survive a changed task listing: '+change,async()=>{
 const api=backend(),original=setup(api);try{await original.import();await original.choose();await original.submit();api.succeed();}finally{await original.w.happyDOM.close();}
 const request=api.fetch.bind(api);let release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);api.fetch=async(url,options)=>{const response=await request(url,options);if(url==='api/v1/tasks/task-1'){const value=await response.json();started();await gate;return {ok:true,json:async()=>value};}return response;};
 const h=setup(api);try{await h.refresh();const pending=h.$('background-task-list').querySelector('[data-action="view-result"]').onclick();await ready;if(change==='removed')api.tasks.clear();if(change==='failed')api.tasks.get('task-1').status='failed';if(change==='identity')api.tasks.get('task-1').document.revision='new-revision';await h.refresh();release();await pending;assert.doesNotMatch(h.$('background-task-list').textContent,/Fake background summary/);assert.equal(h.$('background-task-list').querySelector('[data-action="export-result"]'),null);assert.equal(posted(api).length,1);}finally{release();await h.w.happyDOM.close();}
});

for(const moveFocus of [false,true])test('independent result opens immediately and respects newer focus: '+moveFocus,async()=>{
 const api=backend(),original=setup(api);try{await original.import();await original.choose();await original.submit();api.succeed();}finally{await original.w.happyDOM.close();}
 const request=api.fetch.bind(api);let release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);api.fetch=async(url,options)=>{if(url==='api/v1/tasks/task-1'){started();await gate;}return request(url,options);};
 const h=setup(api);try{await h.refresh();const view=h.$('background-task-list').querySelector('[data-action="view-result"]');view.focus();const pending=view.onclick();await ready;if(moveFocus)h.$('background-refresh').focus();release();await pending;const details=h.$('background-task-list').querySelector('details');assert.equal(details.open,true);assert.equal(h.w.document.activeElement,moveFocus?h.$('background-refresh'):details.querySelector('summary'));details.open=false;await h.refresh();assert.equal(h.$('background-task-list').querySelector('details').open,false);}finally{release();await h.w.happyDOM.close();}
});

test('unassociated running tasks keep polling read-only until their results become available',async()=>{
 const api=backend(),original=setup(api);try{await original.import();await original.choose();await original.submit();}finally{await original.w.happyDOM.close();}
 const h=setup(api),pending=new Map();let next=-1;const set=h.w.setTimeout.bind(h.w),clear=h.w.clearTimeout.bind(h.w);h.w.setTimeout=(fn,ms,...args)=>{if(ms!==4000)return set(fn,ms,...args);const id=next--;pending.set(id,fn);return id;};h.w.clearTimeout=id=>{if(pending.has(id))pending.delete(id);else clear(id);};
 try{await h.refresh();assert.equal(pending.size,1);assert.equal(h.$('background-task-list').querySelector('[data-action="view-result"]'),null);api.succeed();[...pending.values()][0]();await h.refresh();assert.ok(h.$('background-task-list').querySelector('[data-action="view-result"]'));assert.equal(pending.size,0);assert.equal(posted(api).length,1);assert.equal(api.calls.filter(call=>call.url.endsWith('/cancel')).length,0);}finally{await h.w.happyDOM.close();}
});

test('associated malformed result is visible, cannot be accepted, and refresh can recover it',async()=>{
 const h=setup();try{await h.import();await h.choose();await h.submit();h.api.succeed();h.api.tasks.get('task-1').result.citations=['missing'];await h.refresh();assert.match(h.$('background-task-list').textContent,/结果不完整|引用无法核对/);assert.equal(h.$('background-task-list').querySelector('[data-action="accept"]').disabled,true);assert.equal(h.$('background-task-list').querySelector('[data-action="export-result"]'),null);h.api.succeed();await h.refresh();assert.ok(h.$('background-task-list').querySelector('[data-action="export-result"]'));assert.equal(h.$('background-task-list').querySelector('[data-action="accept"]').disabled,false);assert.equal(posted(h.api).length,1);}finally{await h.w.happyDOM.close();}
});

test('large standalone snapshots have bounded visible citation previews and complete JSON',async()=>{
 const api=backend(),original=setup(api);try{await original.import();await original.choose();await original.submit();api.succeed();}finally{await original.w.happyDOM.close();}
 const task=api.tasks.get('task-1');task.result.input_snapshot.segments=Array.from({length:12},(_,i)=>({id:'large-'+i,text:'Full authored source '.repeat(100)}));task.result.citations=task.result.input_snapshot.segments.map(cue=>cue.id);
 const h=setup(api),files=[];try{await h.refresh();await h.$('background-task-list').querySelector('[data-action="view-result"]').onclick();const excerpts=h.$('background-task-list').querySelectorAll('.background-source');assert.equal(excerpts.length,8);assert.ok([...excerpts].every(node=>node.textContent.length<1300));assert.match(h.$('background-task-list').textContent,/预览已截短/);h.w.URL.createObjectURL=blob=>{files.push(blob);return 'blob:complete';};h.w.HTMLAnchorElement.prototype.click=function(){};await h.$('background-task-list').querySelector('[data-action="export-result"]').onclick();const saved=JSON.parse(await files[0].text());assert.deepEqual(saved.result.input_snapshot,task.result.input_snapshot);assert.deepEqual(saved.result.citations,task.result.citations);assert.equal(saved.result.answer,task.result.answer);assert.equal(posted(api).length,1);}finally{await h.w.happyDOM.close();}
});

function missingTaskResponse(){return {ok:false,status:404,json:async()=>({code:'not_found',error:'任务不存在'})};}
test('one missing associated task preserves the healthy executor, other tasks and explicit new submissions',async()=>{
 const api=backend(),request=api.fetch.bind(api);let missing=false;
 api.fetch=(url,options)=>missing&&url==='api/v1/tasks/task-1'?missingTaskResponse():request(url,options);
 const h=setup(api);try{
  await h.import();await h.choose();await h.submit();const original=structuredClone(api.tasks.get('task-1')),payload=structuredClone(posted(api)[0].body),cancel=h.$('background-task-list').querySelector('[data-action="cancel"]');
  api.tasks.delete('task-1');missing=true;
  api.tasks.set('elsewhere-ready',{...structuredClone(original),taskId:'elsewhere-ready'});api.succeed('elsewhere-ready');
  api.tasks.set('elsewhere-running',{...structuredClone(original),taskId:'elsewhere-running'});
  await h.refresh();
  assert.match(h.$('background-executor-status').textContent,/已连接/);assert.equal(h.$('ask-ai').disabled,false);
  const old=h.$('background-task-list').querySelector(`[data-submission-key="${payload.idempotencyKey}"]`);
  assert.match(old.textContent,/此执行器找不到此任务/);assert.match(old.textContent,/不会自动重提交/);assert.equal(old.querySelector('[data-action="resubmit"]'),null);assert.equal(old.querySelector('[data-action="cancel"]'),null);
  await cancel.onclick();assert.equal(api.calls.filter(call=>call.url.endsWith('/cancel')).length,0,'stale cancel handler must not target an absent task');
  const view=h.$('background-task-list').querySelector('[data-submission-key="external:elsewhere-ready"] [data-action="view-result"]');await view.onclick();
  assert.equal(h.doc().ai_answers.length,0);assert.equal(h.$('background-task-list').querySelector('[data-action="accept"]'),null,'same source/key/revision never adopts a different taskId');
  await h.$('background-task-list').querySelector('[data-submission-key="external:elsewhere-running"] [data-action="cancel"]').onclick();assert.equal(api.tasks.get('elsewhere-running').status,'cancelled');
  h.$('ai-consent').checked=false;await h.$('ask-ai').onclick();assert.equal(posted(api).length,1);
  await h.submit();assert.equal(posted(api).length,2);assert.notEqual(posted(api)[1].body.idempotencyKey,payload.idempotencyKey);
  const saved=JSON.parse(h.w.localStorage.getItem(journalKey)).entries;assert.equal(saved[0].task.taskId,'task-1');assert.deepEqual(saved[0].payload,payload);assert.equal(saved[0].missing,true);assert.equal(saved[0].cancelRequested,undefined);assert.equal(saved.length,2);
 }finally{await h.w.happyDOM.close();}
});

test('a cached success cannot be accepted after its executor reports not found, and returning restores its exact receipt',async()=>{
 const api=backend(),request=api.fetch.bind(api);let missing=false;
 api.fetch=(url,options)=>missing&&url==='api/v1/tasks/task-1'?missingTaskResponse():request(url,options);
 const h=setup(api);try{
  await h.import();await h.choose();await h.submit();api.succeed();await h.refresh();const original=structuredClone(api.tasks.get('task-1')),accept=h.$('background-task-list').querySelector('[data-action="accept"]');
  api.tasks.clear();missing=true;await h.refresh();await accept.onclick();assert.equal(h.doc().ai_answers.length,0);assert.equal(h.$('background-task-list').querySelector('[data-action="accept"]'),null);
  assert.match(h.$('library-background-task-status').textContent,/待确认 1/);assert.equal(posted(api).length,1);
  api.tasks.set('task-1',original);missing=false;await h.refresh();assert.doesNotMatch(h.$('background-task-list').textContent,/此执行器找不到/);
  const restored=h.$('background-task-list').querySelector('[data-action="accept"]');assert.equal(restored.disabled,false);await restored.onclick();await restored.onclick();assert.equal(h.doc().ai_answers.length,1);assert.equal(posted(api).length,1);
  assert.equal(JSON.parse(h.w.localStorage.getItem(journalKey)).entries[0].missing,false);
 }finally{await h.w.happyDOM.close();}
});

for(const failure of ['offline','500','unrecognized-404'])test('task '+failure+' remains an executor failure rather than a confirmed missing association',async()=>{
 const api=backend(),request=api.fetch.bind(api);let fail=false;
 api.fetch=async(url,options)=>{
  if(fail&&url==='api/v1/tasks'&&!options?.body)return {ok:true,json:async()=>({protocolVersion:1,tasks:[]})};
  if(fail&&url==='api/v1/tasks/task-1'){
   if(failure==='offline')throw new Error('Network offline');
   return {ok:false,status:failure==='500'?500:404,json:async()=>({error:'Service failure',...(failure==='500'?{code:'not_found'}:{})})};
  }
  return request(url,options);
 };
 const h=setup(api);try{await h.import();await h.choose();await h.submit();fail=true;await h.refresh();assert.match(h.$('background-executor-status').textContent,/暂时不可用/);assert.equal(h.$('ask-ai').disabled,true);assert.doesNotMatch(h.$('background-task-list').textContent,/此执行器找不到/);assert.notEqual(JSON.parse(h.w.localStorage.getItem(journalKey)).entries[0].missing,true);assert.equal(posted(api).length,1);}finally{await h.w.happyDOM.close();}
});

test('an older not-found lookup cannot overwrite a newer cancellation receipt',async()=>{
 const api=backend(),request=api.fetch.bind(api);let missing=false,release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 api.fetch=async(url,options)=>{
  if(missing&&url==='api/v1/tasks'&&!options?.body)return {ok:true,json:async()=>({protocolVersion:1,tasks:[]})};
  if(missing&&url==='api/v1/tasks/task-1'){started();await gate;return missingTaskResponse();}
  return request(url,options);
 };
 const h=setup(api);try{await h.import();await h.choose();await h.submit();missing=true;const pending=h.refresh();await ready;await h.$('background-task-list').querySelector('[data-action="cancel"]').onclick();release();await pending;const saved=JSON.parse(h.w.localStorage.getItem(journalKey)).entries[0];assert.equal(saved.task.status,'cancelled');assert.equal(saved.missing,false);assert.doesNotMatch(h.$('background-task-list').textContent,/此执行器找不到/);assert.equal(posted(api).length,1);}finally{release();await h.w.happyDOM.close();}
});

test('real same-origin executor-directory switch isolates old 404 and restores the original result on return',async t=>{
 const {startBridge}=await import('../desktop/server.mjs'),{startDevelopmentBridge}=await import('../desktop/dev.mjs'),os=await import('node:os'),path=await import('node:path');
 const directory=await fs.promises.mkdtemp(path.join(os.tmpdir(),'coconut-executor-switch-'));let server,h,calls=0;
 const providers={ask:async data=>{calls++;return {answer:'Authored fake-provider result.',citations:[data.segments[0].id]};},status:async()=>({ready:true})};
 const close=async()=>{if(server){await new Promise(resolve=>server.shutdown(resolve));server=null;}};
 t.after(async()=>{await h?.w.happyDOM.close();await close();await fs.promises.rm(directory,{recursive:true,force:true});});
 server=await startBridge({port:0,taskDirectory:path.join(directory,'source-cli'),providers});const port=server.address().port,origin=`http://127.0.0.1:${port}`;
 const api={fetch:(url,options={})=>fetch(origin+'/'+url,{...options,headers:{...options.headers,Origin:origin}})};
 const complete=async id=>{let task;for(let i=0;i<100;i++){task=(await(await api.fetch('api/v1/tasks/'+id)).json()).task;if(task.status==='succeeded')return task;await new Promise(r=>setTimeout(r,5));}assert.equal(task?.status,'succeeded');};
 h=setup(api);await h.import();await h.choose();await h.submit();const first=JSON.parse(h.w.localStorage.getItem(journalKey)).entries[0];await complete(first.task.taskId);await h.refresh();let storage=h.snapshot();await h.w.happyDOM.close();h=null;await close();
 ({server}=await startDevelopmentBridge({port,taskDirectory:path.join(directory,'dev'),providers}));
 const created=await(await api.fetch('api/v1/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...first.payload,idempotencyKey:'independent-new-executor-intent'})})).json();await complete(created.task.taskId);
 const absent=await api.fetch('api/v1/tasks/'+first.task.taskId);assert.equal(absent.status,404);assert.equal((await absent.json()).code,'not_found');
 h=setup(api,storage);await h.refresh();await h.choose();assert.match(h.$('background-executor-status').textContent,/已连接/);assert.equal(h.$('ask-ai').disabled,false);assert.match(h.$('background-task-list').textContent,/此执行器找不到/);
 await h.$('background-task-list').querySelector('[data-action="view-result"]').onclick();assert.match(h.$('background-task-list').textContent,/Authored fake-provider result/);assert.equal(h.$('background-task-list').querySelector('[data-action="accept"]'),null);assert.equal(h.doc().ai_answers.length,0);assert.equal(calls,2);
 storage=h.snapshot();await h.w.happyDOM.close();h=null;await close();server=await startBridge({port,taskDirectory:path.join(directory,'source-cli'),providers});
 h=setup(api,storage);await h.refresh();assert.doesNotMatch(h.$('background-task-list').textContent,/此执行器找不到/);const accept=h.$('background-task-list').querySelector('[data-action="accept"]');assert.equal(accept.disabled,false);await accept.onclick();await accept.onclick();assert.equal(h.doc().ai_answers.length,1);assert.deepEqual([...h.doc().background_summary_receipts],[first.task.taskId]);assert.equal(calls,2,'switching services never reruns either model intent');assert.equal(JSON.parse(h.w.localStorage.getItem(journalKey)).entries[0].task.taskId,first.task.taskId);
});

async function openArchive(h){h.$('background-archive').open=true;await h.refresh();await h.$('background-archive-first').onclick();}
const archiveEntry=h=>JSON.parse(h.w.localStorage.getItem(journalKey)).entries[0];

test('explicit archive survives reload, exports full identity and original ownership, then restores without rerunning',async()=>{
 let h=setup();const api=h.api;let storage,original;
 try{
  await h.import();await h.choose();await h.submit();api.succeed();await h.refresh();original=archiveEntry(h);
  const staleAccept=h.$('background-task-list').querySelector('[data-action=accept]').onclick;
  const archive=h.$('background-task-list').querySelector('[data-action=archive]');assert.ok(archive);archive.focus();await archive.onclick();await staleAccept();assert.equal(h.doc().ai_answers.length,0);
  assert.equal(h.$('background-task-list').querySelector('section'),null);assert.ok(archiveEntry(h).task.archivedAt);assert.equal(h.w.document.activeElement,h.$('background-archive').querySelector('summary'));
  for(const key of ['key','lifetime','payload'])assert.deepEqual(archiveEntry(h)[key],original[key]);storage=h.snapshot();
 }finally{await h.w.happyDOM.close();}
 h=setup(api,storage);try{
  await openArchive(h);assert.match(h.$('background-archive-list').textContent,/Fake background summary/);assert.equal(h.$('background-archive-list').querySelector('[data-action=accept]').disabled,true);
  const files=[];h.w.URL.createObjectURL=blob=>{files.push(blob);return 'blob:archive';};h.w.URL.revokeObjectURL=()=>{};h.w.HTMLAnchorElement.prototype.click=function(){};
  await h.$('background-archive-list').querySelector('[data-action=export-archive]').onclick();assert.equal(files.length,1);
  const saved=JSON.parse(await files[0].text());assert.equal(saved.format,'coconut-background-task-recovery');assert.equal(saved.record.task.idempotencyKey,original.key);assert.equal(saved.record.task.attemptId,original.task.attemptId);assert.deepEqual(saved.record.task.snapshot,original.payload.segments);assert.equal(saved.record.task.result.answer,'Fake background summary.');assert.equal(saved.association.lifetime,original.lifetime);assert.deepEqual(saved.association.payload,original.payload);
  await h.$('background-archive-list').querySelector('[data-action=restore]').onclick();assert.equal(archiveEntry(h).task.archivedAt,undefined);assert.equal(archiveEntry(h).task.taskId,original.task.taskId);
  await h.$('background-task-list').querySelector('[data-action=accept]').onclick();assert.equal(h.doc().ai_answers.length,1);assert.equal(posted(api).length,1);
 }finally{await h.w.happyDOM.close();}
});

for(const action of ['archive','restore'])test('lost '+action+' response converges from server truth without a new submission',async()=>{
 const h=setup();try{
  await h.import();await h.choose();await h.submit();h.api.succeed();await h.refresh();
  if(action==='restore'){await h.$('background-task-list').querySelector('[data-action=archive]').onclick();await openArchive(h);}
  h.api.archiveLost=true;await h.$(action==='archive'?'background-task-list':'background-archive-list').querySelector('[data-action='+action+']').onclick();
  assert.equal(!!archiveEntry(h).task.archivedAt,action==='archive');assert.equal(posted(h.api).length,1);assert.equal(archiveEntry(h).task.taskId,'task-1');
 }finally{await h.w.happyDOM.close();}
});

test('archive stored only on server after browser quota failure retains the old association and recovers on reload',async()=>{
 let h=setup();const api=h.api;let storage,original;
 try{
  await h.import();await h.choose();await h.submit();api.succeed();await h.refresh();original=archiveEntry(h);const backing=h.w.localStorage;
  Object.defineProperty(h.w,'localStorage',{configurable:true,value:{get length(){return backing.length;},key:i=>backing.key(i),getItem:key=>backing.getItem(key),setItem(key,value){if(key===journalKey)throw new h.w.DOMException('Authored quota failure','QuotaExceededError');backing.setItem(key,value);}}});
  await h.$('background-task-list').querySelector('[data-action=archive]').onclick();assert.ok(api.tasks.get('task-1').archivedAt);assert.equal(archiveEntry(h).task.archivedAt,undefined);assert.deepEqual(archiveEntry(h).payload,original.payload);assert.match(h.$('background-task-message').textContent,/关联未保存/);storage=h.snapshot();
 }finally{await h.w.happyDOM.close();}
 h=setup(api,storage);try{await h.refresh();assert.ok(archiveEntry(h).task.archivedAt);assert.deepEqual(archiveEntry(h).payload,original.payload);assert.equal(archiveEntry(h).lifetime,original.lifetime);await openArchive(h);assert.ok(h.$('background-archive-list').querySelector('[data-action=restore]'));assert.equal(posted(api).length,1);}finally{await h.w.happyDOM.close();}
});

test('archived entries stop consuming browser active slots so the 129th explicit intent is possible',async()=>{
 let h=setup();const api=h.api;let storage,seed;
 try{await h.import();await h.choose();await h.submit();api.succeed();await h.refresh();seed=archiveEntry(h);storage=h.snapshot();}finally{await h.w.happyDOM.close();}
 api.tasks.clear();api.keys.clear();const entries=Array.from({length:128},(_,i)=>{const entry=structuredClone(seed),key=webcrypto.randomUUID(),id='seed-'+i;entry.key=key;entry.payload.idempotencyKey=key;entry.task.taskId=id;entry.task.idempotencyKey=key;api.tasks.set(id,{...structuredClone(entry.task),input:entry.payload.segments,result:{purpose:'summary',answer:'Authored stored result',citations:['one'],input_snapshot:{version:1,segments:entry.payload.segments}}});api.keys.set(key,id);return entry;});storage[journalKey]=JSON.stringify({version:2,entries});
 h=setup(api,storage);try{
  await h.choose();await h.submit();assert.equal(posted(api).length,1);assert.match(h.$('background-task-message').textContent,/128/);
  await h.$('background-task-list').querySelector('[data-action=archive]').onclick();await h.submit();assert.equal(posted(api).length,2);const saved=JSON.parse(h.w.localStorage.getItem(journalKey));assert.equal(saved.entries.length,129);assert.equal(saved.entries.filter(entry=>entry.task?.archivedAt).length,1);
 }finally{await h.w.happyDOM.close();}
});

test('archived result retains revision and lifetime restrictions after the manuscript was changed',async()=>{
 const h=setup();try{await h.import();await h.choose();await h.submit();h.api.succeed();await h.refresh();await h.$('background-task-list').querySelector('[data-action=archive]').onclick();h.doc().segments[0].text+=' changed';await openArchive(h);await h.$('background-archive-list').querySelector('[data-action=restore]').onclick();assert.equal(h.$('background-task-list').querySelector('[data-action=accept]').disabled,true);assert.equal(h.doc().ai_answers.length,0);assert.equal(posted(h.api).length,1);}finally{await h.w.happyDOM.close();}
});

for(const status of ['running','queued','cancel_requested','interrupted','cancelled'])test('archive is absent for unresolved state '+status,async()=>{
 const h=setup();try{await h.import();await h.choose();await h.submit();h.api.tasks.get('task-1').status=status;await h.refresh();assert.equal(h.$('background-task-list').querySelector('[data-action=archive]'),null);}finally{await h.w.happyDOM.close();}
});

test('archive pages render at most 20 records and stale page replies cannot re-archive a restored task',async()=>{
 const api=backend(),originalFetch=api.fetch.bind(api);let hold=false,release,started;
 const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 api.fetch=async(url,options)=>{const response=await originalFetch(url,options);if(hold&&url.startsWith('api/v1/tasks?archived=true')){hold=false;const value=await response.json();started();await gate;return {ok:true,json:async()=>value};}return response;};
 const h=setup(api);try{
  await h.import();await h.choose();await h.submit();api.succeed();await h.refresh();await h.$('background-task-list').querySelector('[data-action=archive]').onclick();await openArchive(h);
  const restore=h.$('background-archive-list').querySelector('[data-action=restore]').onclick;hold=true;const loading=h.$('background-archive-first').onclick();await ready;const restoring=restore();await new Promise(r=>setTimeout(r,10));release();await Promise.all([loading,restoring]);await h.refresh();assert.equal(archiveEntry(h).task.archivedAt,undefined);
  const seed=api.tasks.get('task-1');for(let i=0;i<25;i++)api.tasks.set('archive-'+String(i).padStart(2,'0'),{...structuredClone(seed),taskId:'archive-'+String(i).padStart(2,'0'),archivedAt:'2026-10-14T00:00:00.000Z'});
  await openArchive(h);assert.equal(h.$('background-archive-list').querySelectorAll('section').length,20);await h.$('background-archive-next').onclick();assert.equal(h.$('background-archive-list').querySelectorAll('section').length,5);assert.equal(h.$('background-archive-next').disabled,true);assert.equal(posted(api).length,1);
 }finally{release();await h.w.happyDOM.close();}
});

test('archive taskId lookup reaches a later-page record without transferring manuscript ownership',async()=>{
 const api=backend();let h=setup(api);try{await h.import();await h.choose();await h.submit();api.succeed();await h.refresh();await h.$('background-task-list').querySelector('[data-action=archive]').onclick();}finally{await h.w.happyDOM.close();}
 h=setup(api);try{await openArchive(h);h.$('background-archive-id').value='task-1';await h.$('background-archive-find').onclick();assert.equal(h.$('background-archive-list').querySelectorAll('section').length,1);assert.match(h.$('background-archive-status').textContent,/精确查找/);assert.equal(h.$('background-archive-list').querySelector('[data-action=accept]'),null);assert.equal(archiveEntry(h),undefined);assert.equal(posted(api).length,1);
  await h.$('background-archive-list').querySelector('[data-action=restore]').onclick();h.$('background-archive-id').value='task-1';await h.$('background-archive-find').onclick();assert.match(h.$('background-archive-status').textContent,/未归档/);assert.equal(posted(api).length,1);
 }finally{await h.w.happyDOM.close();}
});

test('an archive reply does not steal focus after the user moves to another control',async()=>{
 const api=backend(),original=api.fetch.bind(api);let release,started,hold=false;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 api.fetch=async(url,options)=>{const response=await original(url,options);if(hold&&url.endsWith('/archive')){hold=false;started();await gate;}return response;};
 const h=setup(api);try{await h.import();await h.choose();await h.submit();api.succeed();await h.refresh();hold=true;const operation=h.$('background-task-list').querySelector('[data-action=archive]').onclick();await ready;h.$('background-refresh').focus();release();await operation;assert.equal(h.w.document.activeElement,h.$('background-refresh'));assert.equal(posted(api).length,1);}finally{release();await h.w.happyDOM.close();}
});

test('archive ACK fences a newer-started stale refresh and reconciles after that refresh finishes',async()=>{
 const api=backend(),original=api.fetch.bind(api);let armed=false,releaseArchive,archiveStarted,releaseMissing,missingStarted,archiveDone;
 const archiveGate=new Promise(r=>releaseArchive=r),archiveReady=new Promise(r=>archiveStarted=r),missingGate=new Promise(r=>releaseMissing=r),missingReady=new Promise(r=>missingStarted=r),archiveReturned=new Promise(r=>archiveDone=r);
 api.fetch=async(url,options)=>{
  if(armed&&url==='api/v1/tasks/task-1/archive'){archiveStarted();await archiveGate;const response=await original(url,options);archiveDone();return response;}
  if(armed&&url==='api/v1/tasks/task-2'){missingStarted();await missingGate;}
  return original(url,options);
 };
 const h=setup(api);try{
  await h.import();await h.choose();await h.submit();api.succeed('task-1');await h.refresh();await h.submit();api.succeed('task-2');await h.refresh();api.tasks.delete('task-2');armed=true;
  const row=[...h.$('background-task-list').querySelectorAll('section')].find(node=>node.textContent.includes('task-1'));
  const moving=row.querySelector('[data-action=archive]').onclick();await archiveReady;const refreshing=h.refresh();await missingReady;
  releaseArchive();await archiveReturned;await new Promise(r=>setTimeout(r,10));releaseMissing();await Promise.all([moving,refreshing]);
  assert.ok(api.tasks.get('task-1').archivedAt);assert.ok(archiveEntry(h).task.archivedAt);assert.equal(h.$('background-task-list').textContent.includes('task-1'),false);assert.equal(posted(api).length,2);
 }finally{releaseArchive();releaseMissing();await h.w.happyDOM.close();}
});

test('same-origin directory change keeps bounded local archived associations visible and recovers exact owner on return',async()=>{
 const h=setup();try{
  await h.import();await h.choose();await h.submit();h.api.succeed();await h.refresh();await h.$('background-task-list').querySelector('[data-action=archive]').onclick();const original=structuredClone(h.api.tasks.get('task-1')),association=archiveEntry(h);
  h.api.tasks.clear();h.api.keys.clear();await openArchive(h);
  assert.equal(h.$('background-archive-list').querySelectorAll('section').length,1);assert.match(h.$('background-archive-list').textContent,/task-1/);assert.match(h.$('background-archive-list').textContent,/此执行器找不到此任务/);assert.equal(h.$('background-archive-list').querySelector('[data-action=restore]'),null);assert.equal(h.$('background-archive-list').querySelector('[data-action=accept]'),null);assert.equal(archiveEntry(h).lifetime,association.lifetime);assert.deepEqual(archiveEntry(h).payload,association.payload);
  h.api.tasks.set('task-1',original);await h.refresh();assert.ok(h.$('background-archive-list').querySelector('[data-action=restore]'));assert.equal(archiveEntry(h).missing,false);await h.$('background-archive-list').querySelector('[data-action=restore]').onclick();assert.equal(h.$('background-task-list').querySelector('[data-action=accept]').disabled,false);assert.equal(posted(h.api).length,1);
 }finally{await h.w.happyDOM.close();}
});

test('archiving one task preserves newer keyboard focus on another task archive button',async()=>{
 const api=backend(),original=api.fetch.bind(api);let release,started,hold=false;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 api.fetch=async(url,options)=>{const response=await original(url,options);if(hold&&url==='api/v1/tasks/task-1/archive'){hold=false;started();await gate;}return response;};
 const h=setup(api);try{
  await h.import();await h.choose();await h.submit();api.succeed('task-1');await h.refresh();await h.submit();api.succeed('task-2');await h.refresh();
  const row=id=>[...h.$('background-task-list').querySelectorAll('section')].find(node=>node.textContent.includes(id));hold=true;const moving=row('task-1').querySelector('[data-action=archive]').onclick();await ready;row('task-2').querySelector('[data-action=archive]').focus();release();await moving;
  assert.equal(h.w.document.activeElement.closest('section')?.dataset.submissionKey,row('task-2').dataset.submissionKey);assert.equal(h.w.document.activeElement.dataset.action,'archive');assert.equal(posted(api).length,2);
 }finally{release();await h.w.happyDOM.close();}
});

// Bulk archive uses only authored tasks and a fake executor; never a model.
const archivePosts=api=>api.calls.filter(call=>call.url.endsWith('/archive'));
const bulkRow=(h,id)=>[...h.$('background-task-list').querySelectorAll('section')].find(row=>row.textContent.includes(id));
async function bulkFixture(h,count=3){await h.import(fixture('Selected archive source'));await h.choose();for(let i=0;i<count;i++){await h.submit();h.api.succeed('task-'+(i+1));await h.refresh();}}
function reviewCurrent(h){h.$('background-bulk-select').click();h.$('background-bulk-review').click();}

test('bulk archive requires selection and a separate exact review; only confirmed terminal tasks are selectable',async()=>{
 const h=setup();try{
  await bulkFixture(h,2);for(const [id,status,cancellation] of [['live','running'],['interrupted','interrupted'],['unsettled','cancelled'],['settled','cancelled',{executionSettled:true}]])h.api.tasks.set(id,{...structuredClone(h.api.tasks.get('task-1')),taskId:id,attemptId:'attempt-'+id,status,cancellation});await h.refresh();
  assert.equal(h.$('background-bulk-review').disabled,true);assert.equal(h.$('background-bulk-panel').hidden,true);
  assert.equal(h.$('background-task-list').querySelectorAll('[data-action=select-archive]').length,3);
  for(const id of ['live','interrupted','unsettled'])assert.equal(bulkRow(h,id).querySelector('[data-action=select-archive]'),null);
  reviewCurrent(h);assert.equal(h.$('background-bulk-items').children.length,3);assert.match(h.$('background-bulk-items').textContent,/Selected archive source/);assert.match(h.$('background-bulk-confirm').textContent,/3/);assert.equal(archivePosts(h.api).length,0);
  h.$('background-bulk-cancel').click();assert.equal(h.$('background-bulk-panel').hidden,true);assert.equal(archivePosts(h.api).length,0);h.$('background-bulk-clear').click();assert.equal(h.$('background-bulk-review').disabled,true);
 }finally{await h.w.happyDOM.close();}
});

test('bulk archive serially archives the reviewed identities, reports each success and restores original tasks without inference',async()=>{
 const h=setup();try{
  await bulkFixture(h);const original=structuredClone([...h.api.tasks.values()]);reviewCurrent(h);const first=h.$('background-bulk-confirm').onclick();await h.$('background-bulk-confirm').onclick();await first;
  assert.equal(archivePosts(h.api).length,3);assert.ok(archivePosts(h.api).every(call=>call.body.protocolVersion===2&&call.body.expected.attemptId));assert.match(h.$('background-bulk-status').textContent,/已确认归档 3 条，失败或未确认 0 条，未处理 0 条/);assert.equal(h.$('background-task-list').querySelectorAll('section').length,0);
  const saved=JSON.parse(h.w.localStorage.getItem(journalKey));assert.equal(saved.entries.filter(entry=>entry.task.archivedAt).length,3);
  await openArchive(h);await h.$('background-archive-list').querySelector('[data-action=restore]').onclick();assert.equal(posted(h.api).length,3);
  for(const task of original){const current=h.api.tasks.get(task.taskId);for(const key of ['taskId','attemptId','inputDigest','input','result'])assert.deepEqual(current[key],task[key]);}
 }finally{await h.w.happyDOM.close();}
});

test('partial bulk failure remains itemized; explicit retry only reviews failed original tasks',async()=>{
 const api=backend(),original=api.fetch.bind(api);let fail=true;
 api.fetch=async(url,options)=>{if(fail&&url==='api/v1/tasks/task-2/archive'){api.calls.push({url,body:JSON.parse(options.body)});return {ok:false,status:507,json:async()=>({code:'archive_full',error:'Authored archive capacity'})};}return original(url,options);};
 const h=setup(api);try{
  await bulkFixture(h);reviewCurrent(h);await h.$('background-bulk-confirm').onclick();assert.match(h.$('background-bulk-status').textContent,/已确认归档 2 条，失败或未确认 1 条，未处理 0 条/);assert.match(h.$('background-bulk-items').textContent,/Authored archive capacity/);assert.equal(api.tasks.get('task-2').archivedAt,undefined);
  await h.submit();api.succeed('task-4');await h.refresh();fail=false;h.$('background-bulk-retry').click();assert.equal(h.$('background-bulk-items').children.length,1);assert.match(h.$('background-bulk-items').textContent,/task-2/);assert.doesNotMatch(h.$('background-bulk-items').textContent,/task-4/);assert.equal(archivePosts(api).length,3);
  await h.$('background-bulk-confirm').onclick();assert.match(h.$('background-bulk-status').textContent,/已确认归档 1 条，失败或未确认 0 条/);assert.equal(archivePosts(api).filter(call=>call.url.includes('task-1/')).length,1);assert.equal(api.tasks.get('task-4').archivedAt,undefined);assert.equal(posted(api).length,4);
 }finally{await h.w.happyDOM.close();}
});

test('lost bulk ACK is reconciled by reading the exact archived task, without a second archive or model request',async()=>{
 const h=setup();try{await bulkFixture(h,2);h.api.archiveLost=true;reviewCurrent(h);await h.$('background-bulk-confirm').onclick();assert.match(h.$('background-bulk-status').textContent,/已确认归档 2 条，失败或未确认 0 条/);assert.match(h.$('background-bulk-items').textContent,/重新读取并核实/);assert.equal(archivePosts(h.api).length,2);assert.equal(posted(h.api).length,2);}finally{await h.w.happyDOM.close();}
});

for(const stop of ['cancel','pagehide'])test('bulk '+stop+' stops only remaining requests; in-flight success stays recoverable and never automatically resumes',async()=>{
 const api=backend(),original=api.fetch.bind(api);let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 api.fetch=async(url,options)=>{const response=await original(url,options);if(url==='api/v1/tasks/task-1/archive'){started();await gate;}return response;};
 const h=setup(api);try{
  await bulkFixture(h);reviewCurrent(h);const running=h.$('background-bulk-confirm').onclick();await ready;
  if(stop==='cancel')h.$('background-bulk-cancel').click();else h.w.dispatchEvent(new h.w.Event('pagehide'));
  release();await running;assert.equal(archivePosts(api).length,1);assert.ok(api.tasks.get('task-1').archivedAt);assert.equal(api.tasks.get('task-2').archivedAt,undefined);assert.match(h.$('background-bulk-status').textContent,/已确认归档 1 条，失败或未确认 0 条，未处理 2 条/);
  if(stop==='pagehide'){h.w.dispatchEvent(new h.w.Event('pageshow'));await h.refresh();assert.equal(archivePosts(api).length,1);}
  h.$('background-bulk-retry').click();assert.equal(h.$('background-bulk-items').children.length,2);assert.doesNotMatch(h.$('background-bulk-items').textContent,/task-1/);assert.equal(archivePosts(api).length,1);
  await h.$('background-bulk-confirm').onclick();assert.equal(archivePosts(api).length,3);assert.equal(posted(api).length,3);
 }finally{release();await h.w.happyDOM.close();}
});

test('refresh, navigation, new completion and stale selection callbacks cannot expand a reviewed or running bulk batch',async()=>{
 const api=backend(),original=api.fetch.bind(api);let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 api.fetch=async(url,options)=>{const response=await original(url,options);if(url==='api/v1/tasks/task-1/archive'){started();await gate;}return response;};
 const h=setup(api);try{
  await bulkFixture(h,2);const firstCheckbox=bulkRow(h,'task-1').querySelector('[data-action=select-archive]');firstCheckbox.click();h.$('background-bulk-review').click();
  const stale=bulkRow(h,'task-2').querySelector('[data-action=select-archive]');stale.checked=true;stale.onchange();assert.equal(h.$('background-bulk-items').children.length,1);
  const running=h.$('background-bulk-confirm').onclick();await ready;await h.import(fixture('New navigation'));h.$('prepare-summary').click();h.$('summary-execution').value='background';await h.$('summary-execution').onchange();await h.submit();api.succeed('task-3');await h.refresh();
  h.$('background-bulk-select').onclick();assert.equal(h.$('background-bulk-items').children.length,1);release();await running;
  assert.equal(archivePosts(api).length,1);assert.equal(api.tasks.get('task-2').archivedAt,undefined);assert.equal(api.tasks.get('task-3').archivedAt,undefined);assert.equal(h.doc().title,'New navigation');assert.equal(posted(api).length,3);
 }finally{release();await h.w.happyDOM.close();}
});

test('refresh prunes selected identities that disappeared, changed or were already archived without selecting replacements',async()=>{
 const h=setup();try{
  await bulkFixture(h);h.$('background-bulk-select').click();h.api.tasks.get('task-1').archivedAt='2026-10-14T00:00:00.000Z';h.api.tasks.get('task-2').attemptId='replacement-attempt';h.api.tasks.delete('task-3');await h.refresh();
  assert.equal(h.$('background-bulk-review').disabled,true);assert.match(h.$('background-bulk-scope').textContent,/已选择 0 条/);assert.equal(archivePosts(h.api).length,0);
 }finally{await h.w.happyDOM.close();}
});

for(const replacement of ['different-identity','old-server'])test('bulk guards directory switch after the preflight read: '+replacement,async()=>{
 const api=backend(),original=api.fetch.bind(api);let armed=false,switched=false;
 api.fetch=async(url,options)=>{
  if(armed&&switched&&replacement==='old-server'&&url.endsWith('/archive')){api.calls.push({url,body:JSON.parse(options.body)});return {ok:false,status:400,json:async()=>({code:'invalid_request',error:'Old server rejects protocol v2'})};}
  const response=await original(url,options);
  if(armed&&!switched&&url==='api/v1/tasks/task-1'){
   const value=await response.json();switched=true;if(replacement==='different-identity')api.tasks.get('task-1').attemptId='replacement-attempt';
   return {ok:true,json:async()=>value};
  }return response;
 };
 const h=setup(api);try{
  await bulkFixture(h,1);reviewCurrent(h);armed=true;await h.$('background-bulk-confirm').onclick();assert.equal(api.tasks.get('task-1').archivedAt,undefined);assert.match(h.$('background-bulk-status').textContent,/已确认归档 0 条，失败或未确认 1 条/);assert.equal(posted(api).length,1);assert.equal(archivePosts(api).length,1);
 }finally{await h.w.happyDOM.close();}
});

test('bulk is disabled on old archive-capable executors but their existing single archive action stays usable',async()=>{
 const h=setup();try{await bulkFixture(h,1);delete h.api.descriptor.archive.identityPrecondition;await h.refresh();assert.equal(h.$('background-bulk-select').disabled,true);assert.equal(h.$('background-task-list').querySelector('[data-action=select-archive]'),null);assert.match(h.$('background-bulk-scope').textContent,/旧版仍可逐条/);await h.$('background-task-list').querySelector('[data-action=archive]').onclick();assert.ok(h.api.tasks.get('task-1').archivedAt);assert.equal(archivePosts(h.api)[0].body.protocolVersion,1);}finally{await h.w.happyDOM.close();}
});

test('browser persistence failure stops the rest of a bulk batch and distinguishes durable server success',async()=>{
 const h=setup();try{
  await bulkFixture(h,2);reviewCurrent(h);const backing=h.w.localStorage;Object.defineProperty(h.w,'localStorage',{configurable:true,value:{getItem:key=>backing.getItem(key),setItem(key,value){if(key===journalKey)throw new Error('Authored journal quota');backing.setItem(key,value);}}});
  await h.$('background-bulk-confirm').onclick();assert.equal(archivePosts(h.api).length,1);assert.ok(h.api.tasks.get('task-1').archivedAt);assert.equal(JSON.parse(backing.getItem(journalKey)).entries[0].task.archivedAt,undefined);assert.match(h.$('background-bulk-status').textContent,/已确认归档 1 条，失败或未确认 0 条，未处理 1 条/);assert.match(h.$('background-bulk-items').textContent,/浏览器关联未保存/);assert.equal(posted(h.api).length,2);
 }finally{await h.w.happyDOM.close();}
});

test('bulk selection and sequential processing are bounded to 128 explicitly displayed terminal tasks',async()=>{
 const api=backend();for(let i=0;i<128;i++){const taskId='bounded-'+String(i).padStart(3,'0');api.tasks.set(taskId,{taskId,attemptId:'attempt-'+taskId,inputDigest:'digest-'+taskId,kind:'summary',provider:'codex',document:{key:'Authored '+i,revision:'revision'},status:'failed'});}
 const h=setup(api);try{
  await h.refresh();assert.equal(h.$('background-task-list').querySelectorAll('[data-action=select-archive]').length,128);reviewCurrent(h);assert.equal(h.$('background-bulk-items').children.length,128);assert.equal(archivePosts(api).length,0);await h.$('background-bulk-confirm').onclick();assert.equal(archivePosts(api).length,128);assert.match(h.$('background-bulk-status').textContent,/已确认归档 128 条，失败或未确认 0 条，未处理 0 条/);assert.equal(posted(api).length,0);
 }finally{await h.w.happyDOM.close();}
});

test('unknown bulk outcome stays explicit, and a user-confirmed retry first discovers an already archived original without posting again',async()=>{
 const api=backend(),original=api.fetch.bind(api);let lost=false,hideReceipt=false;
 api.fetch=async(url,options)=>{if(hideReceipt&&url==='api/v1/tasks/task-1')throw new Error('Authored offline receipt');const response=await original(url,options);if(lost&&url==='api/v1/tasks/task-1/archive'){lost=false;hideReceipt=true;throw new Error('Authored lost ACK');}return response;};
 const h=setup(api);try{
  await bulkFixture(h,1);reviewCurrent(h);lost=true;await h.$('background-bulk-confirm').onclick();assert.match(h.$('background-bulk-status').textContent,/已确认归档 0 条，失败或未确认 1 条/);assert.match(h.$('background-bulk-items').textContent,/结果未确认/);assert.equal(archivePosts(api).length,1);
  hideReceipt=false;await h.refresh();h.$('background-bulk-retry').click();assert.equal(h.$('background-bulk-items').children.length,1);await h.$('background-bulk-confirm').onclick();assert.match(h.$('background-bulk-status').textContent,/已确认归档 1 条，失败或未确认 0 条/);assert.equal(archivePosts(api).length,1);assert.equal(posted(api).length,1);
 }finally{await h.w.happyDOM.close();}
});

test('stopping during bulk preflight sends no mutation and confirmation controls retain usable keyboard focus',async()=>{
 const api=backend(),original=api.fetch.bind(api);let armed=false,release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 api.fetch=async(url,options)=>{const response=await original(url,options);if(armed&&url==='api/v1/tasks/task-1'){armed=false;started();await gate;}return response;};
 const h=setup(api);try{
  await bulkFixture(h,1);const checkbox=bulkRow(h,'task-1').querySelector('[data-action=select-archive]');checkbox.focus();checkbox.click();assert.equal(h.w.document.activeElement.dataset.action,'select-archive');
  h.$('background-bulk-review').click();assert.equal(h.w.document.activeElement,h.$('background-bulk-title'));h.$('background-bulk-cancel').click();assert.equal(h.w.document.activeElement,h.$('background-bulk-review'));h.$('background-bulk-review').click();h.$('background-bulk-confirm').focus();armed=true;
  const running=h.$('background-bulk-confirm').onclick();await ready;assert.equal(h.w.document.activeElement,h.$('background-bulk-cancel'));h.$('background-bulk-cancel').click();release();await running;assert.equal(archivePosts(api).length,0);assert.match(h.$('background-bulk-status').textContent,/未处理 1 条/);
 }finally{release();await h.w.happyDOM.close();}
});

test('bulk candidates reject incomplete metadata and only expose cancellation after settlement is confirmed',async()=>{
 const h=setup();try{
  await h.import();await h.choose();await h.submit();const task=h.api.tasks.get('task-1');task.status='cancelled';await h.refresh();assert.equal(h.$('background-task-list').querySelector('[data-action=select-archive]'),null);task.cancellation={executionSettled:true};await h.refresh();assert.ok(h.$('background-task-list').querySelector('[data-action=select-archive]'));
  h.api.tasks.set('malformed',{taskId:'malformed',attemptId:'fake-attempt',inputDigest:'fake-digest',kind:'summary',status:'failed',provider:'codex'});await h.refresh();assert.equal(bulkRow(h,'malformed').querySelector('[data-action=select-archive]'),null);assert.equal(h.doc().segments.length,2);
 }finally{await h.w.happyDOM.close();}
});
