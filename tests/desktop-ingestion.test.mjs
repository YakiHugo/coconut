import test from 'node:test';
import assert from 'node:assert/strict';
import {createIngestionService} from '../desktop/ingestion-service.mjs';
import {createIngestionExecutor,normalizeImportJob} from '../desktop/ingestion-executor.mjs';
import {startBridge} from '../desktop/server.mjs';
import {createCaptionShortLinkResolver} from '../desktop/caption-short-link.mjs';
import {Readable} from 'node:stream';
const url='https://publisher.example/feed',id='a'.repeat(64),jobId='b'.repeat(32);
const document={schema_version:1,title:'Original',source_media:{job_id:jobId,kind:'audio'},segments:[{id:'original-id',start:0,end:1,text:'Unchanged source'}]};
const source={kind:'url',url};
const request={protocolVersion:1,source};
const episode={id,title:'Episode',media:[{url:'https://publisher.example/audio.mp3',kind:'audio',type:'audio/mpeg'}]};
test('HTTP Bilibili short-link import passes only resolved canonical identity to caption service',async t=>{
 const calls=[],canonical='https://www.bilibili.com/video/BV1xx411c7mD';
 const resolver=createCaptionShortLinkResolver({fetch:async(url,options)=>{calls.push({url,redirectOnly:options.redirectOnly});return {redirect:canonical+'?share_source=copy&p=1'};}});
 const captionService={available:true,providers:['bilibili'],importCaption:async data=>{calls.push(data);return {status:'network_unavailable',message:'Network unavailable'};}};
 const server=await startBridge({port:0,captionService,captionShortLinkResolver:resolver,podcastSources:{discover:async()=>assert.fail('No podcast fallback')}});t.after(()=>server.shutdown());
 const origin=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(origin+'/api/v1/ingestions',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:1,source:{kind:'url',url:'https://b23.tv/Ab12'},language:'zh'})});
 assert.equal(response.status,200);const {ingestion}=await response.json();assert.equal(ingestion.source.url,canonical);assert.equal(ingestion.source.provider,'bilibili');assert.equal(ingestion.source.media_id,'BV1xx411c7mD');assert.equal(ingestion.error.code,'network_unavailable');
 assert.deepEqual(calls,[{url:'https://b23.tv/Ab12',redirectOnly:true},{url:canonical,language:'zh'}]);
});
test('short-link resolution waits for caption readiness and failures never fall back',async()=>{
 const forbidden=async()=>assert.fail('No adapter or resolver call');
 const request={protocolVersion:1,source:{kind:'url',url:'https://b23.tv/Ab12'}};
 const unavailable=createIngestionService({captionShortLinkResolver:forbidden,podcastSources:{discover:forbidden}});
 assert.equal((await unavailable.ingest(request)).ingestion.error.code,'captions_unavailable');
 const xOnly=createIngestionService({captionService:{available:true,providers:['x'],importCaption:forbidden},captionShortLinkResolver:forbidden,podcastSources:{discover:forbidden}});
 const disabled=await xOnly.ingest(request);assert.equal(disabled.ingestion.error.code,'captions_unavailable');assert.match(disabled.ingestion.error.message,/尚未启用 Bilibili/);assert.equal(disabled.ingestion.source.url,request.source.url);
 const failed=createIngestionService({captionService:{available:true,importCaption:forbidden},captionShortLinkResolver:async()=>{throw Error('PRIVATE target/token');},podcastSources:{discover:forbidden}});
 const result=await failed.ingest(request);assert.equal(result.ingestion.state,'blocked');assert.equal(result.ingestion.error.code,'short_link_unresolved');assert.equal(result.ingestion.source.url,request.source.url);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|token/);
 const controller=new AbortController();const cancelled=createIngestionService({captionService:{available:true,importCaption:forbidden},captionShortLinkResolver:async()=>{controller.abort();throw Error('aborted');}});
 await assert.rejects(cancelled.ingest(request,{signal:controller.signal}),{name:'AbortError'});
});
test('link discovery keeps explicit episode selection and original share source',async()=>{
 const discovery={kind:'feed',feed_url:url,episodes:[episode]};
 const service=createIngestionService({podcastSources:{discover:async()=>discovery}});
 const result=await service.ingest(request);
 assert.equal(result.ingestion.state,'awaiting_selection');assert.equal(result.ingestion.selection,discovery);assert.deepEqual(result.ingestion.source,source);
 assert.equal(service.capabilities().persistent,false);
});
test('selected episode preserves original transcript and guarded media download',async()=>{
 let input;
 const service=createIngestionService({podcastSources:{importEpisode:async data=>{input=data;return {status:'ready',document,episode,feed_url:url};}}});
 const result=await service.ingest({...request,episode:{feed_url:url,episode_id:id}});
 assert.deepEqual(input,{feedUrl:url,episodeId:id});assert.equal(result.ingestion.transcript.document,document);
 assert.deepEqual(result.ingestion.media.download.body,{feedUrl:url,episodeId:id,mediaUrl:episode.media[0].url});
 await assert.rejects(service.ingest({...request,episode:{feed_url:'https://other.example/feed',episode_id:id}}),/不一致/);
});
test('media-only and local file retain player independently of missing ASR',async()=>{
 const service=createIngestionService({podcastSources:{discover:async()=>({kind:'media',title:'Audio',media:episode.media[0]})}});
 const remote=await service.ingest(request);assert.equal(remote.ingestion.state,'needs_transcription');assert.equal(remote.ingestion.media.availability,'remote');assert.equal(remote.ingestion.transcript,null);assert.equal(remote.ingestion.project.document.project_kind,'audio_only');assert.equal(remote.ingestion.project.document.podcast_source.media_url,episode.media[0].url);
 const local=await service.ingest({protocolVersion:1,source:{kind:'file',name:'audio.mp3',size:100,type:'audio/mpeg'}});
 assert.equal(local.ingestion.media.availability,'local_session');assert.equal(local.ingestion.transcription.model_download,false);
 await assert.rejects(service.ingest({protocolVersion:1,source:{kind:'file',name:'/tmp/audio.mp3',size:100}}),/名称/);
});
test('platform captions never fall through to podcast fetch or ASR on failure',async()=>{
 let calls=0;
 const service=createIngestionService({podcastSources:{discover:async()=>{throw new Error('must not run');}},captionService:{available:true,importCaption:async()=>{calls++;return {status:'network_unavailable',message:'Retry network'};}}});
 const response=await service.ingest({protocolVersion:1,source:{kind:'url',url:'https://youtu.be/abcdefghijk'}});
 assert.equal(calls,1);assert.equal(response.ingestion.state,'blocked');assert.equal(response.ingestion.error.code,'network_unavailable');assert.equal(response.ingestion.source.url,'https://www.youtube.com/watch?v=abcdefghijk');
});
test('abort after adapter completion discards late transcript',async()=>{
 const controller=new AbortController();
 const service=createIngestionService({captionService:{available:true,importCaption:async()=>{controller.abort();return {status:'ready',document};}}});
 await assert.rejects(service.ingest({protocolVersion:1,source:{kind:'url',url:'https://youtu.be/abcdefghijk'}},{signal:controller.signal}),{name:'AbortError'});
});
test('HTTP ingestion blocks unsupported Bilibili short forms and rejects ambiguous parts before adapters',async t=>{
 const calls=[];
 const forbidden=name=>async()=>{calls.push(name);throw new Error('Unexpected adapter call');};
 const server=await startBridge({port:0,podcastSources:{discover:forbidden('podcast')},captionService:{available:true,providers:['bilibili'],importCaption:forbidden('caption')},ingestionExecutor:{status:forbidden('transcription')}});
 t.after(()=>server.shutdown());const origin=`http://127.0.0.1:${server.address().port}`;
 for(const [input,message] of [
  ['https://b23.tv/short?share=1','未能安全展开'],
  ['https://www.b23.tv/short','未能安全展开'],
  ['https://www.bilibili.com/video/BV1xx411c7mD?p=1&p=2','暂不支持指定分 P'],
  ['https://www.bilibili.com/video/BV1xx411c7mD?p=2&p=1','暂不支持指定分 P'],
 ]){
  const response=await fetch(origin+'/api/v1/ingestions',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:1,source:{kind:'url',url:input}})});
  const result=await response.json();
  if(message==='未能安全展开'){assert.equal(response.status,200);assert.equal(result.ingestion.state,'blocked');assert.equal(result.ingestion.error.code,'short_link_unresolved');assert.ok(result.ingestion.error.message.includes(message));}
  else{assert.equal(response.status,400);assert.ok(result.error.includes(message));assert.equal(result.ingestion,undefined);}
 }
 assert.deepEqual(calls,[]);
});
const operation={operation_id:'11111111-1111-4111-8111-111111111111',filename:'audio.mp3',size:3,fingerprint:'f'.repeat(64),last_modified:123,language:''};
const missingOperation=()=>new Response(JSON.stringify({error:'Operation not found'}),{status:404});
const job={upload_operation:operation,id:jobId,title:'audio.mp3',status:'queued',stage:'Waiting',options:{local_only:true},created:1,updated:1,error:null};
const jsonResponse=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
test('executor is disabled without configuration and accepts only owner loopback URL',async()=>{
 assert.equal((await createIngestionExecutor({url:''}).status()).code,'asr_not_configured');
 for(const url of ['http://localhost:9000','https://127.0.0.1:9000','http://other.example','http://127.0.0.1:9000/api','http://user:pw@127.0.0.1:9000'])assert.throws(()=>createIngestionExecutor({url}));
 assert.throws(()=>normalizeImportJob({...job,options:{}}),/不是/);
});
test('executor readiness never treats an older download-capable backend as available',async()=>{
 const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async()=>jsonResponse({available:true})});
 assert.equal((await executor.status()).available,false);
});
test('upload requires local-only readiness, forwards bytes to existing queue and normalizes status',async()=>{
 const calls=[];
 const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async(url,options)=>{calls.push([url,options]);if(url.includes('/operations/'))return missingOperation();if(url.endsWith('/status'))return jsonResponse({available:true,model_download:false,upload_operations:1});let body='';for await(const bytes of options.body)body+=bytes.toString();assert.equal(body,'abc');return jsonResponse(job);}});
 const req=Readable.from([Buffer.from('abc')]);req.headers={'content-length':'3','content-type':'application/octet-stream'};
 const result=await executor.upload(req,operation);assert.equal(result.state,'queued');assert.equal(result.persistent,true);assert.equal(result.media.kind,'audio');assert.equal(result.media.url,`/api/v1/ingestions/jobs/${jobId}/media`);
 assert.match(calls[2][0],/local_only=true/);assert.equal(calls[2][1].headers.Origin,'http://127.0.0.1:9000');
});
test('unready upload never submits bytes or creates a queue job',async()=>{
 let calls=0;
 const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async url=>{calls++;if(url.includes('/operations/'))return missingOperation();return jsonResponse({available:false,model_download:false,upload_operations:1,message:'Model missing'});}});
 const req=Readable.from([Buffer.from('abc')]);req.headers={'content-length':'3','content-type':'application/octet-stream'};
 await assert.rejects(executor.upload(req,operation),/Model missing/);assert.equal(calls,2);
});
test('result preserves source document; retries and cancel reuse durable original job id',async()=>{
 const calls=[];
 const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async(url,options)=>{calls.push(url);return jsonResponse(url.endsWith('/result')?document:url.endsWith('/cancel')?{...job,status:'cancelled'}:{...job,status:'done'});}});
 const result=await executor.result(jobId);assert.deepEqual(result.transcript.document,document);assert.equal(result.id,jobId);assert.equal(result.media.url,`/api/v1/ingestions/jobs/${jobId}/media`);
 const cancel=await executor.action(jobId,'cancel');assert.equal(cancel.state,'cancelled');assert.equal(calls.at(-1),`http://127.0.0.1:9000/api/jobs/${jobId}/cancel`);
});
test('Node HTTP contract supports same-origin link ingestion, capabilities and executor routes',async t=>{
 const calls=[];
 const executor={status:async()=>({available:false,code:'missing_model',model_download:false}),list:async()=>[normalizeImportJob(job)],get:async()=>normalizeImportJob(job),action:async(id,action)=>{calls.push(action);return normalizeImportJob({...job,status:'cancelled'});}};
 const server=await startBridge({port:0,ingestionExecutor:executor,podcastSources:{discover:async()=>({kind:'feed',feed_url:url,episodes:[episode]})}});
 t.after(()=>server.shutdown());const origin=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(origin+'/api/v1/ingestions',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(request)});
 assert.equal(response.status,200);assert.equal((await response.json()).ingestion.state,'awaiting_selection');
 assert.equal((await (await fetch(origin+'/api/v1/ingestions/capabilities')).json()).transcription.code,'missing_model');
 assert.equal((await (await fetch(origin+'/api/v1/ingestions/jobs')).json()).ingestions[0].id,jobId);
 const denied=await fetch(origin+`/api/v1/ingestions/jobs/${jobId}/cancel`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"protocolVersion":1}'});assert.equal(denied.status,403);assert.deepEqual(calls,[]);
 const accepted=await fetch(origin+`/api/v1/ingestions/jobs/${jobId}/cancel`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{"protocolVersion":1}'});assert.equal(accepted.status,200);assert.deepEqual(calls,['cancel']);
});
test('real loopback transport forwards upload and reopens completed media without direct Python URLs',async t=>{
 const {default:http}=await import('node:http');const calls=[];
 const backend=http.createServer(async(req,res)=>{
  calls.push(req.url);assert.equal(req.headers.origin,`http://127.0.0.1:${backend.address().port}`);
  if(req.url.endsWith('/media')){res.writeHead(206,{'Content-Type':'audio/mpeg','Content-Length':'2','Content-Range':'bytes 1-2/3','Accept-Ranges':'bytes'});res.end('bc');return;}
  res.setHeader('Content-Type','application/json');
  if(req.url.includes('/operations/')){res.statusCode=404;return res.end(JSON.stringify({error:'Operation not found'}));}
  if(req.url.endsWith('/status'))return res.end(JSON.stringify({available:true,code:'ready',model_download:false,upload_operations:1}));
  if(req.url.startsWith('/api/uploads?')){let body='';for await(const chunk of req)body+=chunk;assert.equal(body,'abc');assert.match(req.url,/local_only=true/);return res.end(JSON.stringify(job));}
  res.end(JSON.stringify({...job,status:'failed'}));
 });
 await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{backend.close(resolve);backend.closeAllConnections();}));
 const executor=createIngestionExecutor({url:`http://127.0.0.1:${backend.address().port}`});
 const server=await startBridge({port:0,ingestionExecutor:executor});t.after(()=>server.shutdown());
 const origin=`http://127.0.0.1:${server.address().port}`;
 const upload=await fetch(origin+'/api/v1/ingestions/upload?'+new URLSearchParams(operation),{method:'POST',headers:{Origin:origin,'Content-Type':'application/octet-stream'},body:Buffer.from('abc')});
 assert.equal(upload.status,201);assert.equal((await upload.json()).ingestion.id,jobId);
 const media=await fetch(origin+`/api/v1/ingestions/jobs/${jobId}/media`,{headers:{Range:'bytes=1-2'}});
 assert.equal(media.status,206);assert.equal(media.headers.get('content-range'),'bytes 1-2/3');assert.equal(await media.text(),'bc');
 assert.equal(calls.filter(route=>route.startsWith('/api/uploads?')).length,1);assert.ok(calls.includes(`/api/ingestion-executor/jobs/${jobId}/media`));
});
test('executor rejects false-like local-only flags, mismatched job IDs and source filenames',async()=>{
 for(const local_only of ['false','true',1,false,null])assert.throws(()=>normalizeImportJob({...job,options:{local_only}}));
 for(const title of ['../audio.mp3','audio.txt','',null])assert.throws(()=>normalizeImportJob({...job,title}));
 const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async()=>jsonResponse({...job,id:'c'.repeat(32)})});
 await assert.rejects(executor.get(jobId),/不同/);
 let calls=0;
 const actionExecutor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async()=>jsonResponse(++calls===1?job:{...job,title:'other.mp3'})});
 await assert.rejects(actionExecutor.action(jobId,'cancel'),/不同|不一致/);
 const uploadExecutor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async url=>url.includes('/operations/')?missingOperation():jsonResponse(url.endsWith('/status')?{available:true,model_download:false,upload_operations:1}:{...job,title:'other.mp4'})});
 const req=Readable.from([Buffer.from('abc')]);req.headers={'content-length':'3','content-type':'application/octet-stream'};
 await assert.rejects(uploadExecutor.upload(req,operation),/不同|不一致/);
});
test('result rejects malformed or mismatched transcript evidence instead of repairing its identity',async()=>{
 const invalid=[{...document,segments:'broken'},{...document,schema_version:2},{...document,source_media:{job_id:'c'.repeat(32),kind:'audio'}},{...document,source_media:{job_id:jobId,kind:'video'}},{...document,source_media:null},{...document,segments:[{start:0,end:1,text:'No ID'}]},{...document,segments:[{id:'a',start:2,end:1,text:'Bad timing'}]}];
 for(const value of invalid){
  const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async url=>jsonResponse(url.endsWith('/result')?value:{...job,status:'done'})});
  await assert.rejects(executor.result(jobId));
 }
});
function mediaSink(){return {headers:null,chunks:[],ended:false,destroyed:false,writeHead(status,headers){this.headers={status,...headers};},write(chunk){this.chunks.push(chunk);return true;},end(){this.ended=true;}};}
test('media relay rejects invalid MIME, size, encoding and ranges before exposing headers',async()=>{
 const invalid=[
  {status:200,headers:{'Content-Type':'text/html','Content-Length':'3'}},
  {status:200,headers:{'Content-Type':'audio/mpeg','Content-Length':String(200*1024*1024+1)}},
  {status:200,headers:{'Content-Type':'audio/mpeg','Content-Length':'0'}},
  {status:200,headers:{'Content-Type':'audio/mpeg','Content-Length':'4'}},
  {status:206,headers:{'Content-Type':'audio/mpeg','Content-Length':'2','Content-Range':'bytes 1-2/4'},range:'bytes=1-2'},
  {status:200,headers:{'Content-Type':'audio/mpeg','Content-Length':'3','Content-Encoding':'gzip'}},
  {status:206,headers:{'Content-Type':'audio/mpeg','Content-Length':'3','Content-Range':'bytes 0-2/3'}},
  {status:206,headers:{'Content-Type':'audio/mpeg','Content-Length':'2','Content-Range':'bytes 0-1/3'},range:'bytes=1-2'},
  {status:206,headers:{'Content-Type':'audio/mpeg','Content-Length':'2','Content-Range':'bytes 1-2/999999999'},range:'bytes=1-2'},
  {status:200,headers:{'Content-Type':'audio/mpeg','Content-Length':'3'},range:'bytes=1-2'},
  {status:403,headers:{'Content-Type':'text/html','Content-Length':'3'}},
 ];
 for(const value of invalid){const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async url=>url.endsWith('/media')?new Response('abc',value):jsonResponse(job)});const res=mediaSink();await assert.rejects(executor.media(jobId,{method:'GET',headers:value.range?{range:value.range}:{}},res));assert.equal(res.headers,null);assert.equal(res.ended,false);}
});
test('media relay never completes a truncated or oversized actual response',async()=>{
 for(const body of ['a','abcd']){
  const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async url=>url.endsWith('/media')?new Response(body,{headers:{'Content-Type':'audio/mpeg','Content-Length':'3'}}):jsonResponse(job)});
  const res=mediaSink();await assert.rejects(executor.media(jobId,{method:'GET',headers:{}},res));assert.equal(res.ended,false);assert.ok(Buffer.concat(res.chunks).length<=3);
 }
});
test('media relay validates open and suffix ranges and HEAD without consuming media',async()=>{
 for(const range of ['bytes=1-','bytes=-2']){
  const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async url=>url.endsWith('/media')?new Response('bc',{status:206,headers:{'Content-Type':'audio/mpeg','Content-Length':'2','Content-Range':'bytes 1-2/3'}}):jsonResponse(job)});
  const res=mediaSink();await executor.media(jobId,{method:'GET',headers:{range}},res);assert.equal(res.ended,true);assert.equal(Buffer.concat(res.chunks).toString(),'bc');
 }
 const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async url=>url.endsWith('/media')?new Response(null,{headers:{'Content-Type':'audio/mpeg','Content-Length':'3'}}):jsonResponse(job)});
 const res=mediaSink();await executor.media(jobId,{method:'HEAD',headers:{}},res);assert.equal(res.ended,true);assert.deepEqual(res.chunks,[]);
});
test('durable upload and list reject coercible array IDs and states',async()=>{
 for(const invalid of [{...job,id:[jobId]},{...job,status:['queued']}]){
  assert.throws(()=>normalizeImportJob(invalid));
  const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async url=>url.includes('/operations/')?missingOperation():jsonResponse(url.endsWith('/status')?{available:true,model_download:false,upload_operations:1}:url.endsWith('/api/jobs')?{jobs:[invalid]}:invalid)});
  await assert.rejects(executor.list());
  const req=Readable.from([Buffer.from('abc')]);req.headers={'content-length':'3','content-type':'application/octet-stream'};
  await assert.rejects(executor.upload(req,operation));
 }
 const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async()=>{throw new Error('must not fetch');}});
 await assert.rejects(executor.get([jobId]),/标识无效/);
});
test('operation recovery binds every persisted request field and never guesses a filename',async()=>{
 const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async url=>{const parsed=new URL(url);assert.equal(parsed.pathname,'/api/ingestion-executor/operations/'+operation.operation_id);assert.equal(parsed.searchParams.get('fingerprint'),operation.fingerprint);return jsonResponse(job);}});
 const recovered=await executor.recover(operation);assert.equal(recovered.source.operation_id,operation.operation_id);assert.equal(recovered.source.size,3);assert.equal(recovered.source.last_modified,123);assert.equal(recovered.source.fingerprint,operation.fingerprint);
 for(const mutation of [{fingerprint:'e'.repeat(64)},{size:4},{last_modified:124},{language:'zh'},{filename:'other.mp3'},{operation_id:'22222222-2222-4222-8222-222222222222'}]){
  const bad=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async()=>jsonResponse({...job,upload_operation:{...operation,...mutation}})});
  await assert.rejects(bad.recover(operation));
 }
});
test('not-found recovery and identity conflicts are distinct from unavailable executor',async()=>{
 for(const [status,code] of [[404,'ingestion_operation_not_found'],[409,'ingestion_operation_conflict'],[503,undefined]]){
  const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async()=>new Response('{"error":"Fixture"}',{status})});
  await assert.rejects(executor.recover(operation),error=>error.status===status&&error.taskCode===code);
 }
});
test('same-operation explicit replay skips model preflight but still forwards bytes for exact backend hash verification',async()=>{
 const calls=[];
 const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async(url,options)=>{calls.push(url);if(url.includes('/operations/'))return jsonResponse(job);assert.match(url,/operation_id=11111111/);let body='';for await(const chunk of options.body)body+=chunk;assert.equal(body,'abc');return jsonResponse(job);}});
 const req=Readable.from([Buffer.from('abc')]);req.headers={'content-length':'3','content-type':'application/octet-stream'};
 assert.equal((await executor.upload(req,operation)).id,jobId);assert.equal(calls.length,2);assert.ok(calls.every(url=>!url.endsWith('/status')));
});
test('unknown recovery failure stops upload without a new operation or body submission',async()=>{
 let calls=0;
 const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async()=>{calls++;throw new Error('Lost connection');}});
 const req=Readable.from([Buffer.from('abc')]);req.headers={'content-length':'3','content-type':'application/octet-stream'};
 await assert.rejects(executor.upload(req,operation),/Lost connection/);assert.equal(calls,1);
});
test('same-origin operation lookup exposes stable not-found code and rejects incomplete identity',async t=>{
 const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async()=>missingOperation()});
 const server=await startBridge({port:0,ingestionExecutor:executor});t.after(()=>server.shutdown());const origin=`http://127.0.0.1:${server.address().port}`;
 const {operation_id,...fields}=operation;
 const response=await fetch(origin+'/api/v1/ingestions/operations/'+operation_id+'?'+new URLSearchParams(fields));
 assert.equal(response.status,404);assert.equal((await response.json()).code,'ingestion_operation_not_found');
 const incomplete=await fetch(origin+'/api/v1/ingestions/operations/'+operation_id+'?filename=audio.mp3');assert.equal(incomplete.status,400);
});
test('older local-only executor without durable operation support cannot receive a new upload',async()=>{
 const calls=[];
 const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async url=>{calls.push(url);return url.includes('/operations/')?missingOperation():jsonResponse({available:true,model_download:false});}});
 const req=Readable.from([Buffer.from('abc')]);req.headers={'content-length':'3','content-type':'application/octet-stream'};
 await assert.rejects(executor.upload(req,operation),error=>error.status===503);assert.equal(calls.length,2);assert.ok(calls.every(url=>!url.includes('/api/uploads')));
});
test('explicit replay retains the previously recovered job ID even when returned metadata matches',async()=>{
 let consumed='';
 const executor=createIngestionExecutor({url:'http://127.0.0.1:9000',fetchImpl:async(url,options)=>{
  if(url.includes('/operations/'))return jsonResponse(job);
  for await(const chunk of options.body)consumed+=chunk;
  return jsonResponse({...job,id:'c'.repeat(32)});
 }});
 const req=Readable.from([Buffer.from('abc')]);req.headers={'content-length':'3','content-type':'application/octet-stream'};
 await assert.rejects(executor.upload(req,operation),/不同/);assert.equal(consumed,'abc');
});
