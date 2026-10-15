import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
import {installNativeMenuObservation,observePageFileChoosers,invokeObservedNativeMenuCommand} from './helpers/native-menu-observer.mjs';

function observed(adapter){
 const w=new Window({url:'http://127.0.0.1:47831/'});w.document.body.innerHTML='<main class="shell"><button id="import"></button><input id="file" type="file"><input id="local-media-file" type="file"></main>';
 w.CoconutStorageBootstrap={phase:'ready'};w.coconutFileCommand=adapter;
 w.eval('('+installNativeMenuObservation.toString()+')()');
 return w;
}
test('native menu observation never invokes or replaces the real command behavior',async()=>{
 let calls=0,receiver,args;const original=function(...values){calls++;receiver=this;args=values;return false;};
 const w=observed(original);try{
  assert.equal(calls,0);const command=w.coconutFileCommand;const owner={};const request={issuedAt:Date.now(),expiresAt:Date.now()+2000};
  assert.equal(command.call(owner,'import-transcript',request),false);assert.equal(calls,1);assert.equal(receiver,owner);assert.equal(args[1],request);
  const result=w.__coconutNativeMenuObservation.last;assert.equal(result.completed,true);assert.equal(result.result,false);assert.equal(result.resultType,'boolean');assert.equal(result.bootstrapReady,true);assert.equal(result.command,'import-transcript');
  w.eval('('+installNativeMenuObservation.toString()+')()');assert.equal(w.coconutFileCommand,command);
  w.__coconutNativeMenuObservation.dispose();assert.equal(w.coconutFileCommand,original);assert.equal(w.__coconutNativeMenuObservation,undefined);
 }finally{await w.happyDOM.close();}
});
test('native observer propagates exceptions and never fabricates a renderer receipt',async()=>{
 const failure=new Error('real command failure');const w=observed(()=>{throw failure;});try{
  assert.equal(w.__coconutNativeMenuObservation.sequence,0);assert.equal(w.__coconutNativeMenuObservation.last,null);
  assert.throws(()=>w.coconutFileCommand('import-transcript',{}),error=>error===failure);
  assert.equal(w.__coconutNativeMenuObservation.last.threw,true);assert.equal(w.__coconutNativeMenuObservation.last.completed,true);assert.equal(w.__coconutNativeMenuObservation.last.result,undefined);
 }finally{await w.happyDOM.close();}
});
test('native observer watches only actual known input clicks and preserves newer adapters during cleanup',async()=>{
 const w=observed(()=>true);try{
  const state=w.__coconutNativeMenuObservation;w.document.querySelector('#import').click();assert.equal(state.inputClicks,0);
  w.document.querySelector('#file').click();assert.equal(state.inputClicks,1);assert.equal(state.lastInput.id,'file');
  w.document.querySelector('#local-media-file').click();assert.equal(state.inputClicks,2);assert.equal(state.lastInput.id,'local-media-file');
  const newer=()=>false;w.coconutFileCommand=newer;state.dispose();assert.equal(w.coconutFileCommand,newer);
  w.document.querySelector('#file').click();assert.equal(state.inputClicks,2);
 }finally{await w.happyDOM.close();}
});
test('file chooser subscription is immediate, scoped to one live page and disposed on close',()=>{
 class Page extends EventEmitter{closed=false;isClosed(){return this.closed;}}
 const a=new Page(),b=new Page(),first=observePageFileChoosers(a),second=observePageFileChoosers(b);
 assert.equal(a.listenerCount('filechooser'),1);assert.equal(b.listenerCount('filechooser'),1);
 a.emit('filechooser',{});assert.equal(first.count(),1);assert.equal(second.count(),0);
 a.closed=true;a.emit('close');assert.equal(a.listenerCount('filechooser'),0);assert.equal(a.listenerCount('close'),0);a.emit('filechooser',{});assert.equal(first.count(),1);
 b.emit('filechooser',{});assert.equal(second.count(),1);second.dispose();second.dispose();assert.equal(b.listenerCount('filechooser'),0);assert.equal(b.listenerCount('close'),0);
});

test('persistent chooser observation survives per-operation waiter removal and is renewed for each page',async()=>{
 class Page extends EventEmitter{closed=false;isClosed(){return this.closed;}}
 for(let launch=0;launch<3;launch++){
  const page=new Page(),observation=observePageFileChoosers(page);
  for(let selection=0;selection<2;selection++){
   const actual={selection},received=new Promise(resolve=>page.once('filechooser',resolve));
   assert.equal(page.listenerCount('filechooser'),2);
   page.emit('filechooser',actual);assert.equal(await received,actual);
   assert.equal(observation.count(),selection+1);assert.equal(page.listenerCount('filechooser'),1);
  }
  page.closed=true;page.emit('close');assert.equal(page.listenerCount('filechooser'),0);observation.dispose();
 }
});

function commandFixture({accepted=true,deliver=true,throws=false}={}){
 const w=observed(()=>{if(throws)throw new Error('authored renderer failure');if(accepted)w.document.querySelector('#local-media-file').click();return accepted;});
 Object.defineProperty(w.navigator,'userActivation',{value:{isActive:true},configurable:true});
 const state=w.__coconutNativeMenuObservation;
 state.sequence=4;state.last={sequence:4,command:'open-local-media',completed:true,result:true};
 let calls=0,pending;const polls=[];
 const win={isDestroyed:()=>false,isVisible:()=>true,isFocused:()=>true,webContents:{isLoadingMainFrame:()=>false,getURL:()=>w.location.href,isFocused:()=>true}};
 const item={enabled:true,click(value,target){assert.equal(value,item);assert.equal(target,win);calls++;pending=()=>w.coconutFileCommand('open-local-media',{issuedAt:Date.now(),expiresAt:Date.now()+2000});}};
 const application={evaluate:async(fn,arg)=>fn({Menu:{getApplicationMenu:()=>({getMenuItemById:id=>{assert.equal(id,'open-local-media');return item;}})},BrowserWindow:{getAllWindows:()=>[win]}},arg)};
 const evaluate=(fn,arg)=>w.eval('('+fn.toString()+')('+JSON.stringify(arg)+')');
 const page={evaluate:async(fn,arg)=>evaluate(fn,arg),waitForFunction:async(fn,arg)=>{
  // A stale success, another command, and an incomplete command cannot acknowledge this dispatch.
  polls.push(evaluate(fn,arg));state.last={sequence:5,command:'import-transcript',completed:true};polls.push(evaluate(fn,arg));
  state.last={sequence:5,command:'open-local-media',completed:false};polls.push(evaluate(fn,arg));
  if(!deliver)throw new Error('authored receipt timeout');
  try{pending();}catch{} // The real native dispatcher consumes renderer exceptions.
  assert.equal(evaluate(fn,arg),true);
 }};
 return {w,application,page,polls,calls:()=>calls};
}

test('native invocation waits for this page and command receipt, preserving the real input and activation evidence',async()=>{
 const f=commandFixture(),diagnostic={};try{
  const receipt=await invokeObservedNativeMenuCommand(f.application,f.page,'open-local-media',diagnostic);
  assert.equal(f.calls(),1);assert.deepEqual(f.polls,[false,false,false]);
  assert.equal(diagnostic.menuInvoked,true);assert.equal(diagnostic.rendererReceived,true);
  assert.equal(diagnostic.dispatch.wrapperReturnType,'undefined');assert.equal(diagnostic.dispatch.windowCount,1);
  assert.equal(diagnostic.dispatch.trustedURL,true);assert.equal(diagnostic.dispatch.focused,true);
  assert.equal(receipt.result,true);assert.equal(receipt.userActivation,true);
  assert.equal(diagnostic.inputClicks,diagnostic.before.inputClicks+1);
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostic.lastInput)),{id:'local-media-file',userActivation:true});
 }finally{await f.w.happyDOM.close();}
});

test('native invocation records renderer rejection and exceptions without retrying or fabricating a chooser',async()=>{
 for(const options of [{accepted:false},{throws:true}]){
  const f=commandFixture(options),diagnostic={};try{
   const receipt=await invokeObservedNativeMenuCommand(f.application,f.page,'open-local-media',diagnostic);
   assert.equal(f.calls(),1);assert.equal(diagnostic.rendererReceived,true);assert.equal(diagnostic.inputClicks,0);
   assert.equal(receipt.result,options.throws?undefined:false);assert.equal(receipt.threw,options.throws?true:undefined);
  }finally{await f.w.happyDOM.close();}
 }
});

test('returning from the native wrapper alone never acknowledges delivery',async()=>{
 const f=commandFixture({deliver:false}),diagnostic={};try{
  await assert.rejects(invokeObservedNativeMenuCommand(f.application,f.page,'open-local-media',diagnostic),/authored receipt timeout/);
  assert.equal(f.calls(),1);assert.equal(diagnostic.menuInvoked,true);assert.equal(diagnostic.rendererReceived,false);assert.equal(diagnostic.receipt,undefined);
 }finally{await f.w.happyDOM.close();}
});

test('local-media acceptance arms every page before bootstrap and retains native chooser and security gates',async()=>{
 const source=await readFile(new URL('./desktop-local-media-acceptance.mjs',import.meta.url),'utf8');
 assert.match(source,/firstWindow\(\);chooserObservation=observePageFileChoosers\(page\)/);
 assert.ok(source.indexOf('observePageFileChoosers(page)')<source.indexOf('await page.waitForURL'));
 assert.match(source,/page\.setDefaultTimeout\(15000\)/);
 assert.match(source,/page\.waitForEvent\('filechooser'\),invokeObservedNativeMenuCommand/);
 assert.match(source,/assert\.equal\(receipt\.result,true/);assert.match(source,/assert\.equal\(receipt\.userActivation,true/);
 assert.match(source,/check\('actual_picker_target',await chooser\.element\(\)\.getAttribute\('id'\)/);
 assert.match(source,/await chooser\.setFiles\(file\);await decoded\(\)/);
 assert.match(source,/chooserObservation\?\.dispose\(\)/);
 assert.match(source,/nativeCommands,nativeState,chooserEvents:chooserObservation\?\.count\(\)/);
 assert.match(source,/chromiumSandbox:true,bypassCSP:false/);
});
