import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {runPinnedCaptionHelper,verifiedHelperBytes,helperEnvironment} from '../desktop/caption-helper-process.mjs';
import {createCaptionHelper} from '../desktop/caption-helper.mjs';
const validVersion={status:'ok',protocol:1,version:'2026.08.19',python:'3.14.8',publicExtraction:true,guardProtocol:1,tlsRootsVerified:true};
async function fixture(t) {
 const directory=await mkdtemp(path.join(os.tmpdir(),'coconut-helper-unit-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const resourcesPath=path.join(directory,'resources');await mkdir(path.join(resourcesPath,'caption-helper'),{recursive:true});
 const bytes=Buffer.from('Original inert test bytes, never executed');await writeFile(path.join(resourcesPath,'caption-helper/coconut-caption'),bytes);
 const artifact={name:'coconut-caption',protocol:1,ytDlpVersion:'2026.08.19',python:'3.14.8',platform:process.platform,arch:process.arch,
  bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 const tempRoot=path.join(directory,'private');await mkdir(tempRoot);return {directory,resourcesPath,artifact,tempRoot};
}
function fakeSpawn(response=validVersion,inspect=()=>{}) {
 return (executable,args,options)=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
  child.kill=()=>{queueMicrotask(()=>child.emit('close',null));return true;};
  const chunks=[];child.stdin.on('data',chunk=>chunks.push(chunk));
  child.stdin.on('finish',()=>queueMicrotask(()=>{
   inspect({executable,args,options,input:JSON.parse(Buffer.concat(chunks))});
   child.stdout.end(JSON.stringify(response)+'\n');queueMicrotask(()=>child.emit('close',0));
  }));return child;
 };
}
test('fixed helper command receives only JSON, a private workspace and an empty executable path',async t=>{
 const s=await fixture(t);let observed;
 const result=await runPinnedCaptionHelper({...s,operation:'version',spawnProcess:fakeSpawn(validVersion,value=>observed=value)});
 assert.equal(result.version,'2026.08.19');assert.deepEqual(observed.args,['--protocol=1']);assert.deepEqual(observed.input,{operation:'version'});
 assert.equal(observed.options.shell,false);assert.equal(path.dirname(observed.executable),path.join(observed.options.cwd,'bin'));
 assert.equal(observed.options.env.PATH,path.join(observed.options.cwd,'empty-bin'));
 assert.equal((await readdir(s.tempRoot)).length,0);
});
test('sanitized environment inherits neither account material, proxies nor runtime loader state',()=>{
 const env=helperEnvironment('/private-proof');
 for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','SSL_CERT_FILE','LD_PRELOAD','DYLD_INSERT_LIBRARIES','PYTHONPATH','PYTHONHOME','_PYI_PARENT_PROCESS_LEVEL','_MEIPASS2','NETRC','YTDLP_CONFIG','ELECTRON_RUN_AS_NODE'])assert.ok(!(key in env));
 for(const key of ['HOME','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME'])assert.ok(env[key].startsWith('/private-proof/'));
});
test('artifact integrity and shape fail closed before spawning',async t=>{
 const s=await fixture(t);let spawned=0;const spawnProcess=()=>{spawned++;throw new Error('must not run');};
 for(const artifact of [undefined,{...s.artifact,name:'../evil'},{...s.artifact,sha256:'0'.repeat(64)},{...s.artifact,bytes:1}])await assert.rejects(runPinnedCaptionHelper({...s,artifact,operation:'version',spawnProcess}));
 assert.equal(spawned,0);assert.deepEqual(await readdir(s.tempRoot),[]);
});
test('resource symlinks are never followed',async t=>{
 const s=await fixture(t);await rm(path.join(s.resourcesPath,'caption-helper/coconut-caption'));await writeFile(path.join(s.directory,'other'),'Original inert test bytes, never executed');
 await symlink(path.join(s.directory,'other'),path.join(s.resourcesPath,'caption-helper/coconut-caption'));
 await assert.rejects(verifiedHelperBytes(s.resourcesPath,s.artifact),e=>e.code==='CAPTION_INTEGRITY');
});
test('snapshot is verified before executing and removed after callback failure',async t=>{
 const s=await fixture(t);let privatePath;
 await assert.rejects(runPinnedCaptionHelper({...s,operation:'version',spawnProcess:fakeSpawn(),onSpawn:f=>{privatePath=f.directory;throw new Error('private diagnostic');}}),e=>e.code==='CAPTION_START'&&!e.message.includes('private diagnostic'));
 await assert.rejects(stat(privatePath),{code:'ENOENT'});assert.deepEqual(await readdir(s.tempRoot),[]);
});
test('untrusted routes and language/operation/limit injection never spawn',async t=>{
 const s=await fixture(t);let spawned=false;const spawnProcess=()=>{spawned=true;throw new Error();};
 for(const url of ['file:///etc/passwd','https://x.com/user/status/123?token=secret','https://127.0.0.1/status/123','https://x.com.evil.org/user/status/123','https://x.com/user/status/123;touch'])await assert.rejects(runPinnedCaptionHelper({...s,operation:'extract',url,spawnProcess}),e=>e.code==='CAPTION_INPUT');
 for(const changes of [{operation:'--exec'},{operation:'version',timeoutMs:999999},{operation:'extract',url:'https://x.com/user/status/123',language:'en,--exec'}])await assert.rejects(runPinnedCaptionHelper({...s,...changes,spawnProcess}));
 assert.equal(spawned,false);
});
test('typed public failures never expose raw extractor output',async t=>{
 const s=await fixture(t);
 for(const status of ['unavailable','access_restricted','language_required']) {
  const result=await runPinnedCaptionHelper({...s,operation:'extract',url:'https://x.com/user/status/123',spawnProcess:fakeSpawn({status,stderr:'secret-url',token:'private'})});
  assert.deepEqual(result,{status});
 }
});
test('media identity can differ from post identity while source URL remains exact',async t=>{
 const s=await fixture(t),url='https://x.com/user/status/123';const body='WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nAuthored.\n';
 const response={status:'ok',source:{url,id:'456',title:'Authored',duration:2,language:'en',automatic:false,translated:false,live:false},
  track:{language:'en',captionMethod:'platform_provided',languageBasis:'platform_metadata',captionTrack:'en',reviewStatus:'unreviewed'},format:'vtt',captionBase64:Buffer.from(body).toString('base64')};
 const result=await runPinnedCaptionHelper({...s,operation:'extract',url,spawnProcess:fakeSpawn(response)});
 assert.equal(result.source.id,'456');assert.equal(result.track.captionTrack,'en');assert.equal(result.bytes.toString(),body);
 await assert.rejects(runPinnedCaptionHelper({...s,operation:'extract',url,spawnProcess:fakeSpawn({...response,source:{...response.source,url:'https://x.com/user/status/789'}})}),e=>e.code==='CAPTION_OUTPUT');
});
test('wrong-version/oversized child output never becomes ready and leaves no temporary state',async t=>{
 const s=await fixture(t);
 await assert.rejects(runPinnedCaptionHelper({...s,operation:'version',spawnProcess:fakeSpawn({...validVersion,version:'unknown'})}),e=>e.code==='CAPTION_VERSION');
 await assert.rejects(runPinnedCaptionHelper({...s,operation:'version',maxOutputBytes:16,spawnProcess:fakeSpawn()}),e=>e.code==='CAPTION_OUTPUT_LIMIT');
 assert.deepEqual(await readdir(s.tempRoot),[]);
});
test('missing packaged artifact is honest and does not fall back to PATH or system Python',async()=>{
 const helper=createCaptionHelper();assert.equal((await helper.status()).ready,false);
 await assert.rejects(helper.extractCaptions({url:'https://x.com/user/status/123'}),e=>e.code==='CAPTION_UNAVAILABLE');
});
test('shutdown aborts immediately but waits for child close and cleanup before resolving',async()=>{
 let signal,finish;const helper=createCaptionHelper({run:options=>{signal=options.signal;return new Promise((resolve,reject)=>{finish=()=>reject(Object.assign(new Error('cancelled'),{code:'CAPTION_CANCELLED'}));});}});
 const operation=helper.status();const operationFailure=assert.rejects(operation,e=>e.code==='CAPTION_CANCELLED');
 let stopped=false;const shutdown=helper.shutdown().then(()=>stopped=true);
 assert.equal(signal.aborted,true);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(stopped,false);
 await assert.rejects(helper.extractCaptions({url:'https://x.com/user/status/123'}),e=>e.code==='CAPTION_CANCELLED');
 finish();await operationFailure;await shutdown;assert.equal(stopped,true);
});
test('FIFO resource cannot block integrity preflight or helper cancellation',async t=>{
 if(process.platform==='win32')return;
 const s=await fixture(t);const filename=path.join(s.resourcesPath,'caption-helper/coconut-caption');await rm(filename);
 const {execFileSync}=await import('node:child_process');execFileSync('mkfifo',[filename]);
 await Promise.race([assert.rejects(verifiedHelperBytes(s.resourcesPath,s.artifact),e=>e.code==='CAPTION_INTEGRITY'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('FIFO integrity check blocked')),500).unref())]);
});
test('staged notice/source tree must match the receipt embedded in the app',async t=>{
 const s=await fixture(t);const {verifyCaptionHelperResources,stageCaptionHelper}=await import('../desktop/caption-helper-package.mjs');
 const build=path.join(s.directory,'build');await mkdir(build);const payload=Buffer.from('Authored native placeholder');await writeFile(path.join(build,'coconut-caption'),payload);
 const receipt={resources:{'coconut-caption':createHash('sha256').update(payload).digest('hex')}};
 await writeFile(path.join(build,'receipt.json'),JSON.stringify(receipt));await verifyCaptionHelperResources(build,receipt);
 const target=path.join(s.directory,'staged');await mkdir(target);await stageCaptionHelper(build,target,receipt);
 await writeFile(path.join(target,'caption-helper','added-unsafe-source'),'changed');
 await assert.rejects(verifyCaptionHelperResources(path.join(target,'caption-helper'),receipt),/resource-tree/);
 await writeFile(path.join(build,'coconut-caption'),'changed before staging');
 const second=path.join(s.directory,'second-stage');await mkdir(second);await assert.rejects(stageCaptionHelper(build,second,receipt),/resource-tree/);
});
