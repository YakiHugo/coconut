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
const descriptor={protocolVersion:1,executor:{type:'local-node',online:true},enabled:true,supportedTaskKinds:['summary'],remoteSubmission:false,execution:{disconnect:'continue',restart:'interrupt_without_retry',cancel:'request_then_settle'},providers:{codex:{supported:true},claude:{supported:true}}};
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
    if(!tasks.has(id))tasks.set(id,{taskId:id,kind:'summary',document:body.document,provider:body.provider,status:'running',progress:{completed:0,total:1},input:body.segments});
    if(this.hold)await this.hold;
    if(this.lost){this.lost=false;throw new Error('Lost receipt');}return ok({protocolVersion:1,task:tasks.get(id)});
   }
   if(url.startsWith('api/v1/tasks?submissionKey='))return ok({protocolVersion:1,task:tasks.get(keys.get(decodeURIComponent(url.split('=')[1])))||null});
   if(url==='api/v1/tasks')return ok({protocolVersion:1,tasks:[...tasks.values()]});
   const match=url.match(/^api\/v1\/tasks\/([^/]+)(\/cancel)?$/);
   if(match){const task=tasks.get(match[1]);if(match[2])task.status='cancelled';return ok({protocolVersion:1,task});}
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
