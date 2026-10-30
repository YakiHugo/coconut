import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {runPinnedCaptionHelper,verifiedHelperBytes,helperEnvironment,inspectCaptionOutputFiles,HELPER_LIMITS} from '../desktop/caption-helper-process.mjs';
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
  const result=await runPinnedCaptionHelper({...s,operation:'extract',url:'https://x.com/user/status/123',spawnProcess:fakeSpawn({status,languages:['en','fr','en','https://private.example'],stderr:'secret-url',token:'private'})});
  assert.deepEqual(result,{status,...(status==='language_required'?{languages:['en','fr']}:{})});
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
test('live caption monitor tolerates an atomic part-file rename and still checks finished output',async()=>{
 const visited=[];
 await inspectCaptionOutputFiles('/private-proof',{
  listEntries:async()=>[{name:'caption.en.vtt.part'},{name:'caption.en.vtt'}],
  readStat:async filename=>{visited.push(path.basename(filename));if(filename.endsWith('.part'))throw Object.assign(new Error('renamed'),{code:'ENOENT'});return {isFile:()=>true,size:64};}
 });
 assert.deepEqual(visited,['caption.en.vtt.part','caption.en.vtt']);
});
test('caption monitor fails closed for directory errors, permission errors, symlinks and oversized files',async()=>{
 const listEntries=async()=>[{name:'caption.en.vtt.part'},{name:'caption.en.vtt'}];
 await assert.rejects(inspectCaptionOutputFiles('/private-proof',{listEntries:async()=>{throw Object.assign(new Error('missing directory'),{code:'ENOENT'});}}),{code:'ENOENT'});
 await assert.rejects(inspectCaptionOutputFiles('/private-proof',{listEntries,readStat:async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});}}),{code:'EACCES'});
 for(const stat of [{isFile:()=>false,size:8},{isFile:()=>true,size:HELPER_LIMITS.captionBytes+1}]) {
  await assert.rejects(inspectCaptionOutputFiles('/private-proof',{listEntries,readStat:async filename=>{if(filename.endsWith('.part'))throw Object.assign(new Error('renamed'),{code:'ENOENT'});return stat;}}),{code:'CAPTION_FILE_LIMIT'});
 }
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

const publicProviders=['x','youtube','bilibili'];
const providerSamples=[
 {provider:'youtube',url:'https://www.youtube.com/watch?v=abcdefghijk',id:'abcdefghijk',extractor:'youtube',format:'vtt',body:'WEBVTT\n\n00:00.000 --> 00:01.000\nAuthored YouTube caption.\n'},
 {provider:'bilibili',url:'https://www.bilibili.com/video/BV1xx411c7mD',id:'BV1xx411c7mD',extractor:'bilibili',format:'srt',body:'1\n00:00:00,000 --> 00:00:01,000\nAuthored Bilibili caption.\n'},
];
function providerResult(sample){return {status:'ok',source:{url:sample.url,id:sample.id,title:'Authored offline caption',duration:2,language:'en',extractor:sample.extractor,automatic:false,translated:false,live:false,live_status:'not_live'},track:{language:'en',captionMethod:'platform_provided',languageBasis:'platform_metadata',captionTrack:'en',reviewStatus:'unreviewed'},format:sample.format,captionBase64:Buffer.from(sample.body).toString('base64')};}

test('packaged version exposes only capabilities verified against its artifact receipt',async t=>{
 const s=await fixture(t);s.artifact.publicProviders=publicProviders;
 const result=await runPinnedCaptionHelper({...s,operation:'version',spawnProcess:fakeSpawn({...validVersion,publicProviders})});
 assert.deepEqual(result.publicProviders,publicProviders);
 const helper=createCaptionHelper({...s,run:options=>runPinnedCaptionHelper({...options,tempRoot:s.tempRoot,spawnProcess:fakeSpawn({...validVersion,publicProviders})})});
 assert.deepEqual((await helper.status()).providers,publicProviders);
});
test('packaged extract admits verified YouTube VTT and Bilibili SRT without using development mode',async t=>{
 const s=await fixture(t);s.artifact.publicProviders=publicProviders;
 for(const sample of providerSamples){
  let observed;const result=await runPinnedCaptionHelper({...s,operation:'extract',url:sample.url,spawnProcess:fakeSpawn(providerResult(sample),value=>observed=value)});
  assert.deepEqual(observed.input,{operation:'extract',url:sample.url,language:null});
  assert.equal(result.format,sample.format);assert.equal(result.source.id,sample.id);assert.equal(result.bytes.toString(),sample.body);
 }
 assert.deepEqual(await readdir(s.tempRoot),[]);
});

test('legacy artifacts remain X-only and undeclared providers never spawn',async t=>{
 const s=await fixture(t);
 const legacy=await runPinnedCaptionHelper({...s,operation:'version',spawnProcess:fakeSpawn()});
 assert.deepEqual(legacy.publicProviders,['x']);
 let spawned=0;
 for(const sample of providerSamples)await assert.rejects(runPinnedCaptionHelper({...s,operation:'extract',url:sample.url,spawnProcess:()=>{spawned++;assert.fail('Undeclared provider spawned');}}),{code:'CAPTION_PROVIDER_UNAVAILABLE'});
 assert.equal(spawned,0);
});
test('unknown, duplicate, malformed or mismatched provider advertisements fail closed',async t=>{
 const s=await fixture(t),current={...s.artifact,publicProviders};
 for(const value of [null,[],{},'youtube',['x','youtube','other'],['x','x'],['__proto__']]){
  let spawned=0;
  await assert.rejects(runPinnedCaptionHelper({...s,artifact:{...s.artifact,publicProviders:value},operation:'version',spawnProcess:()=>{spawned++;assert.fail('Invalid receipt spawned');}}),{code:'CAPTION_VERSION'});
  assert.equal(spawned,0);
  await assert.rejects(runPinnedCaptionHelper({...s,artifact:current,operation:'version',spawnProcess:fakeSpawn({...validVersion,publicProviders:value})}),{code:'CAPTION_VERSION'});
 }
 for(const [artifact,response] of [[current,validVersion],[s.artifact,{...validVersion,publicProviders}],[current,{...validVersion,publicProviders:['youtube']}]] ){
  await assert.rejects(runPinnedCaptionHelper({...s,artifact,operation:'version',spawnProcess:fakeSpawn(response)}),{code:'CAPTION_VERSION'});
 }
 assert.deepEqual(await readdir(s.tempRoot),[]);
});
test('packaged provider input and output identity stay bounded and exact',async t=>{
 const s=await fixture(t);s.artifact.publicProviders=publicProviders;
 for(const sample of providerSamples){
  const input=sample.provider==='youtube'?sample.url+'&list=PRIVATE':sample.url+'?p=2';
  await assert.rejects(runPinnedCaptionHelper({...s,operation:'extract',url:input,spawnProcess:()=>assert.fail('Uncanonical source spawned')}),{code:'CAPTION_INPUT'});
  const valid=providerResult(sample);
  for(const changed of [{...valid,source:{...valid.source,id:'different'}},{...valid,source:{...valid.source,url:'https://private.invalid'}},{...valid,format:'json'}]){
   await assert.rejects(runPinnedCaptionHelper({...s,operation:'extract',url:sample.url,spawnProcess:fakeSpawn(changed)}),{code:'CAPTION_OUTPUT'});
  }
 }
});
test('packaged failures retain sanitized network and guard evidence rather than claim no captions',async t=>{
 const s=await fixture(t);s.artifact.publicProviders=publicProviders;
 const diagnostic={stage:'metadata',reason:'transport_unavailable',requests_attempted:1,responses_received:0};
 for(const status of ['network_unavailable','metadata_incomplete','no_matching_captions','extractor_failed','caption_file_invalid','caption_parse_failed','guard_stopped']){
  const result=await runPinnedCaptionHelper({...s,operation:'extract',url:providerSamples[0].url,spawnProcess:fakeSpawn({status,diagnostic:{...diagnostic,url:'PRIVATE'},stderr:'PRIVATE'})});
  assert.deepEqual(result,{status,diagnostic});assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
 }
 const result=await runPinnedCaptionHelper({...s,operation:'extract',url:providerSamples[1].url,spawnProcess:fakeSpawn({status:'guard_stopped',diagnostic:{...diagnostic,reason:'PRIVATE'}})});
 assert.deepEqual(result,{status:'guard_stopped'});
});

async function packagedBridge(t,s,{version={...validVersion,publicProviders},respond=()=>assert.fail('Unexpected extract'),readerDirectory}={}){
 const {preparePackagedCaptions}=await import('../desktop/caption-helper.mjs');
 const {startBridge}=await import('../desktop/server.mjs');
 const requests=[];
 const helper=createCaptionHelper({...s,run:options=>runPinnedCaptionHelper({...options,tempRoot:s.tempRoot,spawnProcess:fakeSpawn(options.operation==='version'?version:respond(options),value=>requests.push(value.input))})});
 const captions=await preparePackagedCaptions({helper,readerDirectory});
 const forbidden=async()=>assert.fail('Packaged captions must not use models, podcast, ASR, or a short-link resolver');
 const server=await startBridge({...captions,port:0,readerDirectory,libraryDirectory:null,providers:{status:forbidden,ask:forbidden,structured:forbidden,exclusive:forbidden},podcastSources:{discover:forbidden},ingestionExecutor:{status:forbidden},captionShortLinkResolver:forbidden});
 t.after(async()=>{await server.shutdown();await helper.shutdown();});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const ingest=url=>fetch(origin+'/api/v1/ingestions',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:1,source:{kind:'url',url}})});
 return {origin,ingest,requests,helper};
}
test('isolated packaged resources import YouTube VTT and Bilibili SRT through the real bridge and reader',async t=>{
 const s=await fixture(t);s.artifact.publicProviders=publicProviders;
 const readerDirectory=path.join(s.resourcesPath,'reader');await mkdir(readerDirectory);
 for(const filename of ['package.json','core.js','summary.js','interview.js','editions.js','passages.js'])await writeFile(path.join(readerDirectory,filename),await readFile(new URL('../reader/'+filename,import.meta.url)));
 const bridge=await packagedBridge(t,s,{readerDirectory,respond:({url})=>providerResult(providerSamples.find(sample=>sample.url===url))});
 const status=await fetch(bridge.origin+'/api/captions/status').then(r=>r.json());
 assert.equal(status.mode,'bundled-helper');assert.equal(status.available,true);assert.deepEqual(status.providers.filter(p=>p.available).map(p=>p.id),publicProviders);assert.equal(status.networkMode,undefined);
 const health=await fetch(bridge.origin+'/api/health').then(r=>r.json());assert.equal(health.capabilities.caption_import,true);assert.equal(health.capabilities.media_import,false);
 for(const sample of providerSamples){
  const response=await bridge.ingest(sample.url);assert.equal(response.status,200);
  const {ingestion}=await response.json();assert.equal(ingestion.state,'ready');assert.equal(ingestion.source.provider,sample.provider);
  const doc=ingestion.transcript.document;assert.equal(doc.source_url,sample.url);assert.equal(doc.provenance.media_id,sample.id);assert.equal(doc.provenance.caption_method,'platform_provided');assert.equal(doc.provenance.source_platform,sample.provider);assert.equal(doc.segments.length,1);assert.equal(doc.segments[0].start,0);assert.equal(doc.segments[0].end,1);assert.match(doc.segments[0].text,/Authored/);assert.equal(ingestion.transcription.model_download,false);
 }
 assert.deepEqual(bridge.requests.map(r=>r.operation),['version','extract','extract']);
 assert.ok(bridge.requests.every(r=>!Object.hasOwn(r,'trustedProxy')));assert.deepEqual(await readdir(s.tempRoot),[]);
 const main=await readFile(new URL('../desktop/main.mjs',import.meta.url),'utf8');assert.match(main,/await preparePackagedCaptions\(/);assert.match(main,/startBridge\(\{[^\n]+captionService,captionStatus/);assert.doesNotMatch(main,/enabledProviders:\['x'\]/);
});
test('legacy packaged app exposes only X and blocks other providers before helper or short-link work',async t=>{
 const s=await fixture(t);const bridge=await packagedBridge(t,s,{version:validVersion});
 const status=await fetch(bridge.origin+'/api/captions/status').then(r=>r.json());assert.deepEqual(status.providers.filter(p=>p.available).map(p=>p.id),['x']);
 for(const url of [...providerSamples.map(sample=>sample.url),'https://b23.tv/Ab12']){
  const response=await bridge.ingest(url);assert.equal(response.status,200);const {ingestion}=await response.json();assert.equal(ingestion.state,'blocked');assert.equal(ingestion.error.code,'captions_unavailable');
 }
 assert.deepEqual(bridge.requests,[{operation:'version'}]);
});
test('missing, damaged and incompatible packages explain repair through status and ingestion without Python setup advice',async t=>{
 for(const [kind,code,message] of [['missing','CAPTION_UNAVAILABLE',/未提供/],['tampered','CAPTION_INTEGRITY',/完整性/],['dependency','CAPTION_VERSION',/版本、依赖/],['capability','CAPTION_VERSION',/来源能力/]]){
  const s=await fixture(t);s.artifact.publicProviders=publicProviders;
  if(kind==='missing')s.artifact=undefined;
  if(kind==='tampered')await writeFile(path.join(s.resourcesPath,'caption-helper/coconut-caption'),'damaged');
  const version=kind==='dependency'?{status:'extractor_failed',diagnostic:{stage:'helper_execution',reason:'helper_error',requests_attempted:null,responses_received:null}}:kind==='capability'?validVersion:{...validVersion,publicProviders};
  const bridge=await packagedBridge(t,s,{version});const status=await fetch(bridge.origin+'/api/captions/status').then(r=>r.json());
  assert.equal(status.available,false);assert.equal(status.mode,'bundled-helper');assert.equal(status.code,code);assert.match(status.message,message);assert.doesNotMatch(status.message,/COCONUT_CAPTION_PYTHON|pip install|npm run dev/);
  assert.ok(status.providers.every(p=>!p.available));
  for(const url of [providerSamples[0].url,'https://b23.tv/Ab12']){
   const response=await bridge.ingest(url);assert.equal(response.status,200);const {ingestion}=await response.json();assert.equal(ingestion.state,'blocked');assert.equal(ingestion.error.setup_code,code);assert.match(ingestion.error.message,message);assert.equal(ingestion.transcript,null);
  }
  assert.ok(bridge.requests.every(r=>r.operation==='version'));assert.deepEqual(await readdir(s.tempRoot),[]);
 }
});
test('tampering after packaged startup returns an actionable integrity failure without extraction',async t=>{
 const s=await fixture(t);s.artifact.publicProviders=publicProviders;
 const bridge=await packagedBridge(t,s,{respond:()=>providerResult(providerSamples[0])});
 await writeFile(path.join(s.resourcesPath,'caption-helper/coconut-caption'),'changed after startup');
 const response=await bridge.ingest(providerSamples[0].url);assert.equal(response.status,400);
 const result=await response.json();assert.equal(result.code,'CAPTION_INTEGRITY');assert.match(result.error,/完整性校验失败/);assert.match(result.error,/重新安装/);assert.doesNotMatch(result.error,/Python|PRIVATE/);
 assert.deepEqual(bridge.requests,[{operation:'version'}]);assert.deepEqual(await readdir(s.tempRoot),[]);
});
test('new package builds require the complete public-provider receipt',async t=>{
 const s=await fixture(t);const {loadCaptionHelperBuild}=await import('../desktop/caption-helper-package.mjs');
 const directory=path.join(s.directory,'build');await mkdir(directory);await mkdir(path.join(directory,'notices'));await mkdir(path.join(directory,'sources'));
 const bytes=await readFile(path.join(s.resourcesPath,'caption-helper/coconut-caption'));await writeFile(path.join(directory,'coconut-caption'),bytes);
 const lockBytes=await readFile(new URL('../desktop/caption-helper-lock.json',import.meta.url));const lock=JSON.parse(lockBytes);
 const receipt={...s.artifact,pyinstaller:lock.pyinstaller,distribution:'minimal-permissive-with-certifi-source',lockSha256:createHash('sha256').update(lockBytes).digest('hex')};
 for(const publicProviders of [undefined,['x'],['x','youtube','other'],['x','youtube','bilibili','bilibili']]){
  await writeFile(path.join(directory,'receipt.json'),JSON.stringify({...receipt,publicProviders}));
  await assert.rejects(loadCaptionHelperBuild(directory,{platform:process.platform,arch:process.arch,lockBytes}),/Native caption helper build receipt mismatch/);
 }
});
