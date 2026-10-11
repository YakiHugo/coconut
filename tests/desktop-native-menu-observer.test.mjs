import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Window} from 'happy-dom';
import {installNativeMenuObservation,observePageFileChoosers} from './helpers/native-menu-observer.mjs';

function observed(adapter){
 const w=new Window();w.document.body.innerHTML='<main class="shell"><button id="import"></button><input id="file" type="file"><input id="local-media-file" type="file"></main>';
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
