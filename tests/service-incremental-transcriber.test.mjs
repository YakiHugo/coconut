import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createTranscriber} from '../desktop/transcriber.mjs';
const python=execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
async function fixture(t,body){
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-incremental-')),script=path.join(directory,'worker.py'),file=path.join(directory,'media');
 await writeFile(script,body);await writeFile(file,Buffer.alloc(30000,97));const handle=await open(file,'r');
 t.after(async()=>{await handle.close();await rm(directory,{recursive:true,force:true});});
 const runner=createTranscriber({python,profile:{backend:'qwen-mlx'},scriptPath:script});
 return {directory,script,file,handle,runner,options:{attemptId:randomUUID(),mediaFd:handle.fd,workDirectory:directory,sourceSnapshot:{binding:'authored'}}};
}
const digest=createHash('sha256').update(Buffer.alloc(30000,97)).digest('hex');
test('incremental probe is offline, protocol-scoped and sanitizes unsupported worker fields',async t=>{
 const {runner}=await fixture(t,`import sys,json,os\nr=json.loads(sys.stdin.readline())\nassert r['operation']=='probe_incremental' and '--probe' in sys.argv\nassert os.environ['HF_HUB_OFFLINE']=='1'\nprint(json.dumps({'available':True,'local_only':True,'incremental_protocol':1,'supported_containers':['flac','mp3'],'secret':'/private/path'}))\n`);
 const status=await runner.incrementalStatus();assert.equal(status.available,true);assert.deepEqual(status.supported_containers,['flac','mp3']);assert.equal(status.secret,undefined);assert.equal(status.model_download,false);
 assert.equal((await createTranscriber({}).incrementalStatus()).available,false);
 assert.equal((await createTranscriber({python,profile:{backend:'moss-mlx'}}).incrementalStatus()).available,false);
 const missing=await createTranscriber({python:'/missing-python',profile:{backend:'qwen-mlx'}}).incrementalStatus();assert.equal(missing.code,'incremental_executor_unavailable');
});
test('real inherited FD, coalesced highest watermarks, seal ordering and open stdin after seal',async t=>{
 const {runner,options,directory,handle}=await fixture(t,`import sys,json,os,time,select,hashlib\ntime.sleep(.15)\nr=json.loads(sys.stdin.readline())\nassert r['operation']=='transcribe_incremental' and r['protocol_version']==1 and r['media_fd']==3 and r['local_only'] is True\nassert r['source_snapshot']['binding']=='authored'\nassert os.environ['TRANSFORMERS_OFFLINE']=='1'\nmessages=[]\nfor line in sys.stdin:\n m=json.loads(line);assert m['attempt_id']==r['attempt_id'];messages.append(m)\n if m['type']=='seal':\n  data=os.pread(3,m['size'],0);assert hashlib.sha256(data).hexdigest()==m['sha256']\n  assert not select.select([sys.stdin],[],[],.05)[0], 'seal must not close parent stdin'\n  open(os.path.join(r['work'],'controls.json'),'w').write(json.dumps(messages))\n  print(json.dumps({'phase':'fallback','reason':'canonical_pcm_mismatch','raw':'secret'}),flush=True)\n  print(json.dumps({'phase':'recognize','chunk':1,'chunks':None,'path':'secret'}),flush=True)\n  print(json.dumps({'phase':'done'}),flush=True)\n  break\n`);
 const events=[],operation=runner.startIncremental({...options,sourceSnapshot:{binding:'authored',padding:'x'.repeat(200000)},onProgress:p=>events.push(p)});t.after(()=>operation.abort());
 for(let n=1;n<=20000;n++)operation.appendWatermark(n);operation.seal({size:30000,sha256:digest});await operation.completion;
 const controls=JSON.parse(await readFile(path.join(directory,'controls.json'),'utf8'));assert.deepEqual(controls.map(m=>m.type),['append','seal']);assert.equal(controls[0].available_bytes,30000);assert.equal(controls[1].size,30000);
 assert.deepEqual(events,[{phase:'fallback',reason:'canonical_pcm_mismatch'},{phase:'recognize',chunk:1},{phase:'done'}]);assert.equal((await handle.stat()).size,30000);
});
test('watermark and seal validation do not close caller-owned FD',async t=>{
 const {runner,options,handle}=await fixture(t,'import time\ntime.sleep(30)\n');
 assert.throws(()=>runner.startIncremental({...options,mediaFd:-1}));assert.throws(()=>runner.startIncremental({...options,attemptId:'not-a-uuid'}));assert.throws(()=>runner.startIncremental({...options,workDirectory:'relative'}));
 const op=runner.startIncremental(options);t.after(()=>op.abort());op.appendWatermark(10);assert.throws(()=>op.appendWatermark(9));assert.throws(()=>op.appendWatermark(NaN));assert.throws(()=>op.seal({size:9,sha256:digest}));op.seal({size:30000,sha256:digest});assert.throws(()=>op.appendWatermark(30001));assert.throws(()=>op.seal({size:30000,sha256:digest}));op.abort();await assert.rejects(op.completion);assert.equal((await handle.stat()).size,30000);
 const controller=new AbortController();controller.abort();assert.throws(()=>runner.startIncremental({...options,signal:controller.signal}));
});
test('signal abort escalates a TERM-ignoring real child and never resolves completion',async t=>{
 const {runner,options,handle}=await fixture(t,`import signal,time,json,sys\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nr=json.loads(sys.stdin.readline())\nprint(json.dumps({'phase':'prepare'}),flush=True)\ntime.sleep(30)\n`);
 const controller=new AbortController();const started=Date.now();const op=runner.startIncremental({...options,signal:controller.signal,onProgress:()=>controller.abort()});t.after(()=>op.abort());await assert.rejects(op.completion);assert.ok(Date.now()-started<7000);assert.equal((await handle.stat()).size,30000);
});
test('unknown fallback reasons, malformed progress, unfinished lines and exit before seal fail closed',async t=>{
 for(const body of [`print('{"phase":"fallback","reason":"transfer_failed"}',flush=True)`,`print('{"phase":"recognize","chunk":-1}',flush=True)`,`print('raw secret path',flush=True)`,`import sys;sys.stdout.write('{"phase":"done"}');sys.stdout.flush()`,`pass`]){
  const {runner,options}=await fixture(t,body+'\n');const events=[],op=runner.startIncremental({...options,onProgress:p=>events.push(p)});t.after(()=>op.abort());await assert.rejects(op.completion);assert.equal(events.length,0);
 }
});
test('parent death closes incremental control pipe and leaves no detached worker',async t=>{
 const {script,file,directory,options}=await fixture(t,`import sys,json,os\nr=json.loads(sys.stdin.readline())\nopen(os.path.join(r['work'],'pid'),'w').write(str(os.getpid()))\nfor line in sys.stdin: pass\n`);
 const module=new URL('../desktop/transcriber.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {openSync} from 'node:fs';import {createTranscriber} from ${JSON.stringify(module)};const runner=createTranscriber(${JSON.stringify({python,scriptPath:script,profile:{backend:'qwen-mlx'}})});await runner.startIncremental({...${JSON.stringify(options)},mediaFd:openSync(${JSON.stringify(file)},'r')}).completion;`],{stdio:'ignore'});t.after(()=>child.kill('SIGKILL'));
 let pid;for(let n=0;n<100&&!pid;n++){try{pid=Number(await readFile(path.join(directory,'pid'),'utf8'));}catch{}await delay(20);}assert.ok(pid);child.kill('SIGKILL');let gone=false;for(let n=0;n<100&&!gone;n++){try{process.kill(pid,0);}catch{gone=true;}await delay(20);}assert.equal(gone,true);
});
