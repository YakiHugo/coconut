import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url),source=fs.readFileSync(new URL('reader/storage-bootstrap.js',root),'utf8');
const tick=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
function setup(initialize){
 const w=new Window({url:'https://coconut.example/'});w.document.write(fs.readFileSync(new URL('reader/index.html',root),'utf8').replace(/<script\b[^>]*\bdefer[^>]*>[\s\S]*?<\/script>/g,''));w.Coconut={validate:x=>x};w.CoconutStorageProvider={initialize};
 const admitted=[];w.document.head.append=script=>{admitted.push(script.src);queueMicrotask(()=>script.onload());};w.eval(source);
 return {w,admitted,$:id=>w.document.getElementById(id)};
}
test('bootstrap admits no app script or input until complete load, then runs classics in declared order',async()=>{
 let resolve;const pending=new Promise(done=>{resolve=done;}),f=setup(()=>pending);
 try{
  assert.equal(f.w.document.querySelector('.shell').inert,true);assert.equal(f.admitted.length,0);assert.equal(f.w.coconutPrepareClose('inspect').readiness,'loading');assert.equal(f.w.coconutPrepareUpdate(),false);
  resolve({ok:true,backend:'indexeddb',legacyRaw:'original',loaded:{documents:[]},adapter:{}});await tick();
  assert.deepEqual(f.admitted.map(src=>new URL(src).pathname),['/app.js','/language.js','/translation-review.js','/podcasts.js','/jobs.js','/updates.js']);
  assert.equal(f.w.CoconutStorageBootstrap.phase,'ready');assert.equal(f.w.document.querySelector('.shell').inert,false);assert.equal(f.$('storage-startup').hidden,true);assert.equal(f.$('export-original-storage').hidden,false);
 }finally{await f.w.happyDOM.close();}
});
test('failed startup preserves raw rescue, leaves scripts unadmitted, and retry can load coherently',async()=>{
 let calls=0;const f=setup(async()=>++calls===1?{ok:false,error:{code:'blocked'},legacyRaw:' exact raw ' }:{ok:true,backend:'legacy',loaded:{documents:[]},adapter:{}});
 try{await tick();assert.equal(f.w.CoconutStorageBootstrap.phase,'failed');assert.equal(f.admitted.length,0);assert.equal(f.$('storage-startup-retry').hidden,false);assert.match(f.$('storage-startup-message').textContent,/另一个窗口/);
  let blob;f.w.URL.createObjectURL=value=>{blob=value;return 'blob:recovery';};f.w.HTMLAnchorElement.prototype.click=function(){};f.$('storage-startup-export').click();assert.equal(await blob.text(),' exact raw ');
  f.$('storage-startup-retry').click();await tick();assert.equal(f.w.CoconutStorageBootstrap.phase,'ready');assert.match(f.$('storage-backend-hint').textContent,/容量较小/);
 }finally{await f.w.happyDOM.close();}
});
test('native close during migration waits for actual shutdown acknowledgement and never admits late scripts',async()=>{
 let finish,completeLoad,options;const stopped=new Promise(resolve=>{finish=resolve;}),loading=new Promise(resolve=>{completeLoad=resolve;});
 const f=setup(input=>{options=input;input.onStorage({shutdown:()=>stopped});return loading;});
 try{
  const token={id:1,kind:'close',expiresAt:Date.now()+10000};let settled=false;const close=f.w.coconutPrepareClose('safe',token).then(result=>{settled=true;return result;});await tick();assert.equal(settled,false);assert.equal(options.signal.aborted,true);assert.equal(f.admitted.length,0);
  finish({ok:true});assert.equal(await close,true);completeLoad({ok:true,backend:'indexeddb',loaded:{documents:[]},adapter:{}});await tick();assert.equal(f.admitted.length,0);assert.equal(f.w.CoconutStorageBootstrap.phase,'closed');
 }finally{await f.w.happyDOM.close();}
});
test('failed startup can safely quit without treating unreadable storage as unsaved edits',async()=>{
 const f=setup(async()=>({ok:false,error:{code:'corruption'},legacyRaw:'{broken'}));try{await tick();const snapshot=f.w.coconutPrepareClose('inspect');assert.equal(snapshot.safe,true);assert.equal(snapshot.readiness,'failed');assert.equal(snapshot.contentFailed,false);
  assert.equal(await f.w.coconutPrepareClose('safe',{id:1,kind:'close',expiresAt:Date.now()+10000}),true);assert.equal(f.admitted.length,0);
 }finally{await f.w.happyDOM.close();}
});
test('expired native startup owner and delayed release cannot close a newer attempt',async()=>{
 const finishes=[];const f=setup(input=>{input.onStorage({shutdown:()=>new Promise(resolve=>finishes.push(resolve))});return new Promise(()=>{});});
 try{
  assert.equal(f.w.coconutPrepareClose('safe',{id:1,kind:'close',expiresAt:Date.now()-1}),false);
  const a={id:2,kind:'close',expiresAt:Date.now()+10000},b={id:3,kind:'close',expiresAt:Date.now()+10000};const pa=f.w.coconutPrepareClose('safe',a);assert.equal(f.w.coconutPrepareClose('release',a),true);
  const pb=f.w.coconutPrepareClose('safe',b);assert.equal(f.w.coconutPrepareClose('release',a),false);await tick();finishes[0]();assert.equal(await pa,false);finishes[1]();assert.equal(await pb,true);
 }finally{await f.w.happyDOM.close();}
});

test('native startup close waits for a currently loading classic script and blocks the next script',async()=>{
 const f=setup(async()=>({ok:true,backend:'indexeddb',loaded:{documents:[]},adapter:{}}));let current;
 f.w.document.head.append=script=>{f.admitted.push(script.src);current=script;};
 try{await tick();assert.equal(f.admitted.length,1);let complete=false;const close=f.w.coconutPrepareClose('safe',{id:1,kind:'close',expiresAt:Date.now()+10000}).then(value=>{complete=true;return value;});await tick();assert.equal(complete,false);current.onload();assert.equal(await close,true);await tick();assert.equal(f.admitted.length,1);}
 finally{await f.w.happyDOM.close();}
});

test('raw recovery export losslessly envelopes literal lone UTF-16 surrogates',async()=>{
 const raw='{"documents":[],"unpaired":"'+String.fromCharCode(0xd800)+'"}';
 const f=setup(async()=>({ok:false,error:{code:'corruption'},legacyRaw:raw}));
 try{await tick();let blob;f.w.URL.createObjectURL=value=>{blob=value;return 'blob:recovery';};f.w.HTMLAnchorElement.prototype.click=function(){};f.$('storage-startup-export').click();const recovery=JSON.parse(await blob.text());assert.equal(recovery.raw,raw);assert.equal(recovery.format,'coconut-original-storage');assert.match(f.$('storage-recovery-hint').textContent,/无损封装/);}
 finally{await f.w.happyDOM.close();}
});
test('startup storage recovery export contains every database record and current legacy raw',async()=>{
 const recovery={format:'coconut-storage-recovery',version:1,stores:{documents:[{key:'broken',value:{unexpected:'preserved'}}],legacySnapshots:[{key:'legacy-v1',value:{raw:'old'}}]},currentLegacyRaw:'changed'};
 const f=setup(async()=>({ok:false,error:{code:'legacy-changed'},legacyRaw:'changed',recovery}));
 try{await tick();assert.equal(f.$('storage-startup-recovery').hidden,false);let blob;f.w.URL.createObjectURL=value=>{blob=value;return 'blob:recovery';};f.w.HTMLAnchorElement.prototype.click=function(){};f.$('storage-startup-recovery').click();assert.deepEqual(JSON.parse(await blob.text()),recovery);assert.match(f.$('storage-recovery-hint').textContent,/不能直接导入/);}
 finally{await f.w.happyDOM.close();}
});

test('a late native hook install cannot steal the pending startup close or its release',async()=>{
 const f=setup(async()=>({ok:true,backend:'indexeddb',loaded:{documents:[]},adapter:{}}));let current,appCalls=0;
 f.w.document.head.append=script=>{f.admitted.push(script.src);current=script;};
 try{await tick();const token={id:1,kind:'close',expiresAt:Date.now()+10000};const close=f.w.coconutPrepareClose('safe',token);
  f.w.coconutPrepareClose=()=>{appCalls++;return 'wrong-owner';};f.w.coconutPrepareUpdate=()=>{appCalls++;return true;};
  assert.equal(f.w.coconutPrepareUpdate(),false);assert.equal(f.w.coconutPrepareClose('release',token),true);current.onload();assert.equal(await close,false);await tick();assert.equal(appCalls,0);assert.equal(f.w.CoconutStorageBootstrap.phase,'failed');assert.equal(f.$('storage-startup-retry').hidden,false);
 }finally{await f.w.happyDOM.close();}
});
test('native hooks hand over exactly once startup is fully ready',async()=>{
 const f=setup(async()=>({ok:true,backend:'indexeddb',loaded:{documents:[]},adapter:{}}));
 try{f.w.coconutPrepareClose=mode=>'app-'+mode;f.w.coconutPrepareUpdate=()=>true;assert.equal(f.w.coconutPrepareClose('inspect').readiness,'loading');assert.equal(f.w.coconutPrepareUpdate(),false);await tick();assert.equal(f.w.coconutPrepareClose('inspect'),'app-inspect');assert.equal(f.w.coconutPrepareUpdate(),true);}
 finally{await f.w.happyDOM.close();}
});

test('retired startup attempts cannot reacquire native ownership after a successful retry',async()=>{
 let calls=0;const f=setup(async()=>++calls===1?{ok:false,error:{code:'blocked'}}:{ok:true,backend:'indexeddb',loaded:{documents:[]},adapter:{}});
 try{await tick();const old={id:1,kind:'close',expiresAt:Date.now()+10000};assert.equal(await f.w.coconutPrepareClose('safe',old),true);assert.equal(f.w.coconutPrepareClose('release',old),true);f.$('storage-startup-retry').click();f.w.coconutPrepareClose=()=>true;f.w.coconutPrepareUpdate=()=>true;await tick();assert.equal(f.w.CoconutStorageBootstrap.phase,'ready');assert.equal(f.w.coconutPrepareClose('safe',old),false);assert.equal(f.w.coconutPrepareUpdate(true,{...old,kind:'update'}),false);assert.equal(f.w.coconutPrepareClose('safe',{...old,id:2}),true);}
 finally{await f.w.happyDOM.close();}
});

test('non-JSON structured-clone corruption cannot silently become a lossy complete recovery download',async()=>{
 const cyclic={};cyclic.self=cyclic;const sparse=new Array(1);sparse.private='preserve';
 for(const value of [new Map([['private','preserve']]),new Set(['keep']),new Date(0),new Uint8Array([1]),1n,undefined,NaN,Infinity,-0,sparse,cyclic]){
  const recovery={format:'coconut-storage-recovery',stores:{documents:[{key:'damaged',value}]}};
  const f=setup(async()=>({ok:false,error:{code:'corruption'},recovery}));
  try{await tick();let downloads=0;f.w.URL.createObjectURL=()=>{downloads++;return 'blob:wrong';};f.$('storage-startup-recovery').click();assert.equal(downloads,0);assert.match(f.$('storage-recovery-hint').textContent,/无法无损/);assert.equal(f.w.CoconutStorageBootstrap.result.recovery,recovery);}
  finally{await f.w.happyDOM.close();}
 }
});
