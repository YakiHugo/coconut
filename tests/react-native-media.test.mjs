import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const {outputFiles}=await build({entryPoints:['frontend/native-media/controller.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {createNativeMediaController}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function setup(){
 let owner={library:'library',key:'one',epoch:1,source:{fingerprint:'candidate'}},active=true,media=null,file=null;
 const calls=[],released=[];let gate=null,rememberGate=null;
 const bridge={async reconcile(){return {status:'reconciled',rememberedKeys:['one']};},async resolve(){return gate?gate.promise:{status:'missing'};},async remember(value){calls.push(['remember',value]);if(rememberGate)await rememberGate.promise;return {status:'remembered'};},async forget(value){calls.push(['forget',value]);return {status:'forgotten'};},async release(token){released.push(token);}};
 const controller=createNativeMediaController({bridge,owner:()=>owner,active:()=>active,media:()=>media,file:()=>file,attach:(_key,value)=>{media=value;}});
 await controller.initialize([owner]);
 return {controller,calls,released,get owner(){return owner;},set owner(value){owner=value;},get media(){return media;},set media(value){media=value;},set file(value){file=value;},set active(value){active=value;},set gate(value){gate=value;},set rememberGate(value){rememberGate=value;}};
}
const ready=()=>({status:'ready',token:'token',url:'/api/local-media/token',identity:'candidate',kind:'audio',name:'audio.wav'});
test('restore retains native identity and transfers exactly-once release to store owner',async()=>{
 const e=await setup(),gate=deferred();e.gate=gate;const pending=e.controller.resolve('one');gate.resolve(ready());await pending;
 assert.equal(e.media.identity,'candidate');assert.equal(e.media.nativeToken,'token');assert.equal(e.media.autoplay,undefined);assert.equal(e.media.currentTime,undefined);
 e.controller.dispose();assert.deepEqual(e.released,[]);e.media.release();e.media.release();assert.deepEqual(e.released,['token']);
});
for(const action of ['navigate','source','manual','dispose','suppress','picker'])test('late native response released after '+action,async()=>{
 const e=await setup(),gate=deferred();e.gate=gate;const pending=e.controller.resolve('one');
 if(action==='navigate'){e.active=false;e.controller.invalidate();}if(action==='source')e.owner={...e.owner,epoch:2};if(action==='manual')e.media={identity:'new'};if(action==='dispose')e.controller.dispose();if(action==='suppress')e.controller.suppress('one');if(action==='picker')e.controller.invalidate();
 gate.resolve(ready());await pending;assert.notEqual(e.media?.nativeToken,'token');assert.deepEqual(e.released,['token']);
});
test('missing is retryable; forgetting keeps session attachment and suppresses restoration',async()=>{
 const e=await setup();await e.controller.resolve('one');assert.equal(e.controller.state('one').status,'missing');
 const gate=deferred();e.gate=gate;const pending=e.controller.resolve('one',true);gate.resolve(ready());await pending;const media=e.media;
 await e.controller.forget('one');assert.equal(e.media,media);assert.equal(e.controller.state('one').status,'forgotten');assert.equal(e.controller.state('one').known,false);assert.deepEqual(e.released,[]);
});
test('stale remember cleanup precedes a newer opt-in, navigation alone preserves opt-in',async()=>{
 const e=await setup(),gate=deferred();e.media={identity:'old'};e.file={};e.rememberGate=gate;const old=e.controller.remember('one');await Promise.resolve();
 e.media={identity:'new'};e.file={};e.controller.selected('one');const next=e.controller.remember('one');gate.resolve();await Promise.all([old,next]);
 assert.deepEqual(e.calls.map(call=>call[0]),['remember','forget','remember']);assert.equal(e.controller.state('one').status,'remembered');
 e.controller.selected('one');const nav=e.controller.remember('one');e.active=false;e.controller.invalidate();await nav;assert.equal(e.controller.state('one').status,'remembered');
});
test('owner unavailable cannot remember optimistic unsaved source',async()=>{
 const e=await setup();e.media={identity:'new'};e.file={};e.owner=null;await e.controller.remember('one');assert.deepEqual(e.calls,[]);
});

test('picker invalidation does not restart automatic resolution while a choice is pending',async()=>{
 const e=await setup(),gate=deferred();e.gate=gate;const pending=e.controller.resolve('one');e.controller.invalidate();gate.resolve(ready());await pending;
 assert.equal(e.controller.state('one').checked,true);await e.controller.resolve('one');assert.equal(e.media,null);assert.deepEqual(e.released,['token']);
});
