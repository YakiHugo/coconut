import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {CODEX_DISABLED, CLAUDE_REQUIRED_FLAGS, createProviders, runCommand} from '../desktop/providers.mjs';
import {createTranslator} from '../desktop/translation.mjs';
import {startBridge} from '../desktop/server.mjs';

const question = {consent:true,provider:'codex',question:'Explain',language:'zh',segments:[{id:'stable-cue',text:'Source'}]};
const answer = {answer:'Explanation',citations:['stable-cue']};
const output = value => [{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed'}].map(JSON.stringify).join('\n');
const cancelled = error => error.name === 'AbortError' && /已取消/.test(error.message) && !error.providerDiagnostics;
function harness({controller, cancelAt = -1, terminatedAt = -1, invoke} = {}) {
  const calls = []; let finds = 0;
  const providers = createProviders({environment:{PATH:'/bin'},find:async name=>{finds++; return '/fake/'+name;},run:async (binary,args,options)=>{
    calls.push(args);
    const index = calls.length - 1;
    let stdout;
    if (args.includes('--help')) stdout = binary.endsWith('/claude') ? CLAUDE_REQUIRED_FLAGS.join(' ') : '--ephemeral --ignore-user-config --ignore-rules --output-schema --sandbox --model';
    else if (args[0] === 'features') stdout = CODEX_DISABLED.join('\n');
    else if (args[0] === 'login') stdout = 'Logged in using ChatGPT';
    else if (args.includes('auth')) stdout = JSON.stringify({loggedIn:true,authMethod:'claude.ai'});
    else return invoke(options);
    if (index === cancelAt) controller.abort();
    return {code:index === terminatedAt ? null : 0,stdout,stderr:''};
  }});
  return {providers,calls,get finds(){return finds;}};
}

test('pre-cancelled requests do not discover or probe either CLI',async()=>{
  for (const provider of ['codex','claude']) {
    const controller = new AbortController(); controller.abort();
    const item = harness();
    await assert.rejects(item.providers.status(provider,{signal:controller.signal}),cancelled);
    await assert.rejects(item.providers.ask({...question,provider},{signal:controller.signal}),cancelled);
    assert.equal(item.finds,0); assert.equal(item.calls.length,0);
  }
});
test('cancellation after every readiness probe remains cancellation and stops subsequent probes',async()=>{
  for (const provider of ['codex','claude']) for (let cancelAt=0;cancelAt<(provider==='codex'?3:2);cancelAt++) {
    const controller = new AbortController();
    const item = harness({controller,cancelAt});
    await assert.rejects(item.providers.ask({...question,provider},{signal:controller.signal}),cancelled);
    assert.equal(item.calls.length,cancelAt+1);
  }
});
test('terminated readiness commands cannot advertise subscription readiness',async()=>{
  for (const provider of ['codex','claude']) for (let terminatedAt=0;terminatedAt<(provider==='codex'?3:2);terminatedAt++) {
    const item = harness({terminatedAt});
    assert.equal((await item.providers.status(provider)).ready,false);
  }
});
test('cancellation wins against valid answer and translation output; next request can succeed',async()=>{
  for (const translation of [false,true]) {
    let first = true;
    const controller = new AbortController();
    const value = translation ? {translations:[{id:'stable-cue',text:'译文'}]} : answer;
    const {providers} = harness({invoke:async()=>{if(first){first=false;controller.abort();}return {code:0,stdout:output(value)};}});
    const send = translation ? options=>createTranslator(providers)({...question,source:'en',target:'zh'},options) : options=>providers.ask(question,options);
    await assert.rejects(send({signal:controller.signal}),cancelled);
    const result = await send();
    assert.equal(translation ? result[0].id : result.citations[0],'stable-cue');
  }
});
test('complete-looking output with nonzero, missing or signal exit never succeeds',async()=>{
  for (const provider of ['codex','claude']) for (const exit of [{code:1},{code:null,signal:'SIGTERM'},{code:undefined},{code:0,signal:'SIGTERM'}]) {
    const {providers} = harness({invoke:async()=>({...exit,stdout:provider==='codex'?output(answer):JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:answer})})});
    await assert.rejects(providers.ask({...question,provider}),error=>error.code==='provider_failed');
  }
});
test('real process signal exit is retained even after complete output', {skip:process.platform==='win32'},async()=>{
  const result = await runCommand(process.execPath,['-e',`process.stdout.write(${JSON.stringify(output(answer))},()=>process.kill(process.pid,'SIGTERM'))`]);
  assert.equal(result.code,null); assert.equal(result.signal,'SIGTERM'); assert.equal(result.stdout,output(answer));
});
test('cancel kills and reaps a SIGTERM-resistant process before releasing the request slot', {skip:process.platform==='win32',timeout:10000},async t=>{
  const directory = await mkdtemp(path.join(tmpdir(),'coconut-cancel-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const marker = path.join(directory,'ready');
  const controller = new AbortController(); let pid;
  const {providers} = harness({invoke:options=>runCommand(process.execPath,['-e',`process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`],{signal:options.signal,timeout:5000})});
  const pending = providers.ask(question,{signal:controller.signal});
  const rejected = assert.rejects(pending,cancelled);
  for(let i=0;i<200;i++) {try{pid=Number(await readFile(marker,'utf8'));break;}catch{await delay(10);}}
  assert.ok(pid,'child reached ready state');
  process.kill(pid,'SIGTERM');
  assert.doesNotThrow(()=>process.kill(pid,0));
  controller.abort();
  await assert.rejects(providers.ask(question),/正在运行/);
  await rejected;
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  assert.equal(await providers.exclusive(async()=> 'released'),'released');
});
test('runner timeout never accepts partial output',async()=>{
  await assert.rejects(runCommand(process.execPath,['-e','process.stdout.write("partial");setInterval(()=>{},1000)'],{timeout:50}),/超时/);
});

test('cancellation during binary discovery stops before probes or inference',async()=>{
  const controller = new AbortController(); let runs=0;
  const providers = createProviders({find:async()=>{controller.abort();return '/fake/codex';},run:async()=>{runs++;}});
  await assert.rejects(providers.ask(question,{signal:controller.signal}),cancelled);
  assert.equal(runs,0);
});

// Exercise the actual browser-to-server disconnect boundary without any CLI or
// subscription access. The worker is an ordinary local Node child.
test('HTTP disconnect cancels the worker and permits a clean subsequent ask', {skip:process.platform==='win32',timeout:10000},async t=>{
  const directory = await mkdtemp(path.join(tmpdir(),'coconut-http-cancel-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const marker = path.join(directory,'ready'); let first = true;
  const {providers} = harness({invoke:options=>{
    if (!first) return {code:0,stdout:output(answer)};
    first=false;
    return runCommand(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`],{signal:options.signal,timeout:5000});
  }});
  const server = await startBridge({port:0,providers});
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const origin = 'http://127.0.0.1:'+server.address().port;
  const controller = new AbortController();
  const options = {method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(question)};
  const request = fetch(origin+'/api/ask',{...options,signal:controller.signal});
  const rejected = assert.rejects(request,{name:'AbortError'});
  let pid;
  for(let i=0;i<200;i++) {try{pid=Number(await readFile(marker,'utf8'));break;}catch{await delay(10);}}
  assert.ok(pid,'HTTP request started worker');
  controller.abort(); await rejected;
  let released=false;
  for(let i=0;i<200;i++) {
    try {released=await providers.exclusive(async()=>true);break;} catch {await delay(10);}
  }
  assert.ok(released,'disconnect released request slot');
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  const retry = await fetch(origin+'/api/ask',options);
  assert.equal(retry.status,200);
  assert.deepEqual((await retry.json()).citations,['stable-cue']);
});


test('cancellation settles after direct-child reap despite inherited pipes in a detached descendant', {skip:process.platform==='win32',timeout:10000},async t=>{
  const directory = await mkdtemp(path.join(tmpdir(),'coconut-inherited-pipes-test-'));
  const marker = path.join(directory,'pids'); let pids;
  t.after(async()=>{
    if (!pids) {try {pids=JSON.parse(await readFile(marker,'utf8'));} catch {}}
    // Detached descendants are outside the runner's process group. This fixture
    // owns its cleanup; the runner only guarantees its direct child is reaped.
    for (const pid of pids || []) {try{process.kill(pid,'SIGKILL');}catch{}}
    await rm(directory,{recursive:true,force:true});
  });
  const script = `const child=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),5000)'],{detached:true,stdio:['ignore',1,2]});require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`;
  const controller = new AbortController();
  const pending = runCommand(process.execPath,['-e',script],{timeout:8000,signal:controller.signal});
  const rejected = assert.rejects(pending,cancelled);
  for(let i=0;i<400;i++) {try{pids=JSON.parse(await readFile(marker,'utf8'));break;}catch{await delay(10);}}
  assert.ok(pids,'direct child must initialize before cancellation');
  const start = Date.now();
  controller.abort(); await rejected;
  assert.ok(Date.now()-start<2000,'must not wait for detached descendant to close inherited pipes');
  assert.throws(()=>process.kill(pids[0],0),{code:'ESRCH'});
});
