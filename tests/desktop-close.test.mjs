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
test('unanswered renderer inspection times out without teardown',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1800000000000});
 const entered=deferred();
 let errors=0,finished=0;const c=createCloseCoordinator({inspect:()=>{entered.resolve();return new Promise(()=>{});},confirm:async()=>true,commit:async()=>true,finish:()=>finished++,onError:()=>errors++,timeoutMs:10});
 const result=c.request();await entered.promise;t.mock.timers.tick(11);
 assert.equal(await result,false);assert.equal(errors,1);assert.equal(finished,0);
});
test('packaged application includes the imported lifecycle coordinator',async()=>{
 const {readFile}=await import('node:fs/promises');
 const script=await readFile(new URL('../desktop/package.mjs',import.meta.url),'utf8');
 assert.match(script,/\['main\.mjs','close-coordinator\.mjs'/);
});

test('quit invalidates older update staging even when the user then cancels quit',async()=>{
 const {createLifecycleOwnership}=await import('../desktop/close-coordinator.mjs');
 const lifecycle=createLifecycleOwnership(),update=lifecycle.begin('update'),close=lifecycle.begin('close');
 assert.equal(lifecycle.current(update),true);assert.equal(lifecycle.claim(close),true);
 assert.equal(lifecycle.current(update),false);lifecycle.retire(close);
 assert.equal(lifecycle.busy(),false);assert.equal(lifecycle.claim(update),false);
 const next=lifecycle.begin('update');assert.equal(lifecycle.claim(next),true);
 lifecycle.retire(update);assert.equal(lifecycle.owns(next),true);
});

test('a final update owns quit until installation settles; no second native question runs',async()=>{
 const {createLifecycleOwnership}=await import('../desktop/close-coordinator.mjs');
 const lifecycle=createLifecycleOwnership(),update=lifecycle.begin('update');assert.equal(lifecycle.claim(update),true);
 const c=createCloseCoordinator({lifecycle,inspect:()=>assert.fail('update already owns final close'),confirm:()=>assert.fail('no second prompt'),commit:()=>assert.fail('no competing commit'),finish:()=>assert.fail('update finishes its own quit')});
 assert.equal(await c.request(),false);assert.equal(lifecycle.owns(update),true);
 lifecycle.retire(update);assert.equal(lifecycle.busy(),false);
});

test('timeout retires ownership before reporting, and late main results never finish',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1800000000000});
 const {createLifecycleOwnership}=await import('../desktop/close-coordinator.mjs');
 const lifecycle=createLifecycleOwnership({timeoutMs:10}),commit=deferred(),entered=deferred();let released,request,finished=0;
 const c=createCloseCoordinator({lifecycle,inspect:()=>({safe:true}),confirm:()=>assert.fail('no prompt'),commit:(_mode,token)=>{request=token;entered.resolve();return commit.promise;},finish:()=>finished++,release:attempt=>{released=attempt;assert.equal(lifecycle.owns(attempt),false);},onError:()=>assert.equal(lifecycle.busy(),false)});
 const result=c.request();await entered.promise;t.mock.timers.tick(11);
 assert.equal(await result,false);assert.equal(released.id,request.id);assert.equal(request.kind,'close');assert.ok(Number.isFinite(request.expiresAt));
 commit.resolve(true);await Promise.resolve();assert.equal(finished,0);
 const update=lifecycle.begin('update');assert.equal(lifecycle.claim(update),true);lifecycle.retire(released);assert.equal(lifecycle.owns(update),true);
});
