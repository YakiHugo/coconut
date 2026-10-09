import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloseCoordinator} from '../desktop/close-coordinator.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('cancel keeps services alive, and repeated close requests share one decision',async()=>{
 const decision=deferred();let prompts=0,commits=0,finishes=0;
 const c=createCloseCoordinator({inspect:async()=>({safe:false,reasons:['草稿']}),confirm:()=>{prompts++;return decision.promise;},commit:async()=>{commits++;return true;},finish:()=>{finishes++;}});
 const first=c.request(),second=c.request();assert.equal(first,second);await Promise.resolve();decision.resolve(false);assert.equal(await first,false);assert.equal(prompts,1);assert.equal(commits,0);assert.equal(finishes,0);
});
test('clean close locks before teardown and finishes only once',async()=>{
 const calls=[];const c=createCloseCoordinator({inspect:async()=>({safe:true}),confirm:async()=>assert.fail('no prompt'),commit:async mode=>{calls.push(mode);return true;},finish:()=>calls.push('finish')});
 assert.equal(await c.request(),true);await c.request();assert.deepEqual(calls,['safe','finish']);
});
test('new changes during clean inspection require explicit discard',async()=>{
 const calls=[];let checks=0;const c=createCloseCoordinator({inspect:async()=>({safe:checks++===0,reasons:['new draft']}),confirm:async s=>{assert.equal(s.safe,false);calls.push('prompt');return true;},commit:async mode=>{calls.push(mode);return mode==='discard';},finish:()=>calls.push('finish')});
 assert.equal(await c.request(),true);assert.deepEqual(calls,['safe','prompt','discard','finish']);
});
test('renderer errors fail closed and allow a later retry',async()=>{
 let failed=true,errors=0,finished=0;const c=createCloseCoordinator({inspect:async()=>{if(failed)throw Error('gone');return {safe:true};},confirm:async()=>assert.fail('no discard on unknown state'),commit:async()=>true,finish:()=>finished++,onError:()=>errors++});
 assert.equal(await c.request(),false);assert.equal(finished,0);assert.equal(errors,1);failed=false;assert.equal(await c.request(),true);assert.equal(finished,1);
});
test('unanswered renderer inspection times out without teardown',async()=>{
 let errors=0,finished=0;const c=createCloseCoordinator({inspect:()=>new Promise(()=>{}),confirm:async()=>true,commit:async()=>true,finish:()=>finished++,onError:()=>errors++,timeoutMs:10});
 assert.equal(await c.request(),false);assert.equal(errors,1);assert.equal(finished,0);
});
test('packaged application includes the imported lifecycle coordinator',async()=>{
 const {readFile}=await import('node:fs/promises');
 const script=await readFile(new URL('../desktop/package.mjs',import.meta.url),'utf8');
 assert.match(script,/\['main\.mjs','close-coordinator\.mjs'/);
});
