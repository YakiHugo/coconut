import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createPublicFetcher,PublicSourceError} from '../desktop/public-http.mjs';

const url='https://publisher.example.org/authored-audio';
const lookup=async()=>[{address:'93.184.216.34',family:4}];
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function clock(t){
  t.mock.timers.enable({apis:['setTimeout']});
  // Keep the overall deadline on the same deterministic clock as the idle timer.
  t.mock.method(AbortSignal,'timeout',milliseconds=>{
    const controller=new AbortController();
    setTimeout(()=>controller.abort(new DOMException('Deadline','TimeoutError')),milliseconds);
    return controller.signal;
  });
}
function transport(t,{headers=true,status=200,fields={}}={}){
  let begin;
  const started=new Promise(resolve=>{begin=resolve;});
  let aborted=false,requests=0;
  const request=(_target,options,callback)=>{
    requests++;
    const req=new EventEmitter(),response=new Readable({read(){}});
    response.statusCode=status;
    response.headers={'content-type':'audio/mp4',...fields};
    const abort=()=>{aborted=true;response.destroy();req.emit('error',new Error('PRIVATE transport details'));};
    options.signal.addEventListener('abort',abort,{once:true});
    response.once('end',()=>options.signal.removeEventListener('abort',abort));
    t.after(()=>{options.signal.removeEventListener('abort',abort);response.destroy();});
    req.end=()=>{if(headers)callback(response);begin(response);};
    return req;
  };
  return {started,request,get aborted(){return aborted;},get requests(){return requests;}};
}
const options={timeoutMs:10000,idleTimeoutMs:100,maxBytes:100};
const code=expected=>error=>error instanceof PublicSourceError&&error.code===expected&&!error.message.includes('PRIVATE');

test('continuing media progress renews the idle budget and completion clears it',async t=>{
  clock(t);
  const fixture=transport(t),fetch=createPublicFetcher({lookup,request:fixture.request});
  const pending=fetch(url,options),response=await fixture.started;
  await flush();
  for(let i=0;i<10;i++){
    t.mock.timers.tick(80);
    response.push(Buffer.from('ab'));
    await flush();
  }
  response.push(null);
  const result=await pending;
  assert.equal(result.body.length,20);
  assert.equal(fixture.aborted,false);
  t.mock.timers.tick(200);
  assert.equal(fixture.aborted,false,'a completed download must not retain an idle abort');
});

test('idle deadlines stop stalled DNS, headers and response bodies',async t=>{
  for(const stage of ['dns','headers','body'])await t.test(stage,async t=>{
    clock(t);
    const fixture=transport(t,{headers:stage!=='headers'});
    const fetch=createPublicFetcher({lookup:stage==='dns'?()=>new Promise(()=>{}):lookup,request:fixture.request});
    const pending=fetch(url,options),rejected=assert.rejects(pending,code('SOURCE_IDLE_TIMEOUT'));
    if(stage!=='dns'){
      const response=await fixture.started;
      if(stage==='body')response.push(Buffer.from('a'));
    }
    await flush();
    t.mock.timers.tick(101);
    await rejected;
    assert.equal(fixture.requests,stage==='dns'?0:1);
    assert.equal(fixture.aborted,stage!=='dns');
  });
});

test('continuous trickle cannot extend the overall media deadline',async t=>{
  clock(t);
  const fixture=transport(t),fetch=createPublicFetcher({lookup,request:fixture.request});
  const pending=fetch(url,{...options,timeoutMs:250}),rejected=assert.rejects(pending,code('SOURCE_TIMEOUT'));
  const response=await fixture.started;
  await flush();
  for(let i=0;i<3;i++){
    t.mock.timers.tick(80);
    response.push(Buffer.from('a'));
    await flush();
  }
  t.mock.timers.tick(11);
  await rejected;
  assert.equal(fixture.aborted,true);
});

test('explicit cancellation stays distinct from network or idle failure',async t=>{
  clock(t);
  const fixture=transport(t),controller=new AbortController();
  const fetch=createPublicFetcher({lookup,request:fixture.request});
  const pending=fetch(url,{...options,signal:controller.signal});
  const rejected=assert.rejects(pending,code('SOURCE_CANCELLED'));
  await fixture.started;
  controller.abort(new Error('PRIVATE caller details'));
  await rejected;
  assert.equal(fixture.aborted,true);
});

test('HTTP, type, size and transfer failures retain safe typed diagnostics',async t=>{
  for(const spec of [
    {status:403,expected:'SOURCE_HTTP',pattern:/HTTP 403/},
    {fields:{'content-type':'text/html'},expected:'SOURCE_TYPE',pattern:/内容类型/},
    {fields:{'content-length':'101'},expected:'SOURCE_LIMIT',pattern:/允许大小/},
    {fields:{'content-length':'3'},body:'ab',expected:'SOURCE_TRANSFER',pattern:/传输不完整/},
  ])await t.test(spec.expected,async t=>{
    const fixture=transport(t,spec),fetch=createPublicFetcher({lookup,request:fixture.request});
    const pending=fetch(url,{...options,types:new Set(['audio/mp4'])});
    const rejected=assert.rejects(pending,error=>code(spec.expected)(error)&&spec.pattern.test(error.message));
    const response=await fixture.started;
    if(spec.body){response.push(spec.body);response.push(null);}
    await rejected;
  });
});
