#!/usr/bin/env node
/** Opt-in public podcast source -> owned media -> restart/readback. Never ASR. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {startBridge} from '../desktop/server.mjs';
import {createPodcastSources} from '../desktop/podcast-sources.mjs';
import {publicUrl} from '../desktop/public-http.mjs';
import identity from '../shared/source-media.js';

const defaults={xiaoyuzhou:'https://www.xiaoyuzhoufm.com/episode/6ae06b84c96c8942ec130784',rss:'https://feeds.podcastindex.org/pc20.xml'};
const digest=value=>createHash('sha256').update(value).digest('hex');
const LIMIT=100*1024*1024;
export async function provePodcastSource({mode='xiaoyuzhou',url=defaults[mode],podcastSources}={}){
 assert.ok(Object.hasOwn(defaults,mode),'Choose xiaoyuzhou or rss');url=publicUrl(url).href;
 if(mode==='xiaoyuzhou')assert.match(url,/^https:\/\/www\.xiaoyuzhoufm\.com\/episode\/[a-f0-9]{24}\/?$/);
 const directory=await mkdtemp(path.join(tmpdir(),'coconut-podcast-source-proof-'));
 const result={check:'public_podcast_source_durable_media',source_url:url,mode,passed:false,transport:podcastSources?'injected_test_transport':'production_default',transcription_attempted:false,paid_calls:0,browser_playback_verified:false,media_decode_verified:false,restore_provider_requests:0};
 const forbidden=()=>{throw Error('No provider, transcription or source refetch is permitted during restore');};
 const rejectTranscription=()=>{result.transcription_attempted=true;return forbidden();};
 const rejectProvider=()=>{result.paid_calls++;return forbidden();};
 const rejectRestoreSource=()=>{result.restore_provider_requests++;return forbidden();};
 const noExecutor={status:async()=>({available:false,code:'not_configured',automatic:false,model_download:false}),upload:rejectTranscription,list:rejectTranscription};
 let server,origin,stage='start';
 async function start(sources){server=await startBridge({port:0,libraryDirectory:directory,podcastSources:sources,ingestionExecutor:noExecutor,providers:{status:async()=>({ready:false}),ask:rejectProvider,structured:rejectProvider}});origin='http://127.0.0.1:'+server.address().port;}
 const response=(route,init={})=>fetch(origin+route,{...init,headers:{Origin:origin,...init.headers},signal:AbortSignal.timeout(150000)});
 async function json(route,body){const r=await response(route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;}
 try{
  await start(podcastSources||createPodcastSources());
  stage='discover_exact_public_source';
  const discovery=(await json('/api/v1/ingestions',{protocolVersion:1,source:{kind:'url',url}})).ingestion;
  assert.equal(discovery.state,'awaiting_selection');
  const selection=discovery.selection,episode=mode==='rss'?selection.episodes.find(e=>e.transcript_selection?.status==='default'):selection.episodes[0];assert.ok(episode,'No suitable publisher episode');
  if(mode==='xiaoyuzhou'){assert.equal(selection.episodes.length,1);assert.equal(episode.source_url,url);assert.equal(episode.transcripts.length,0);}
  const medium=episode.media?.[0];assert.ok(medium&&medium.length>0&&medium.length<=LIMIT,'Explicit media budget is 100 MiB');
  result.episode_id=episode.id;result.episode_source_url=episode.source_url;result.duration_seconds=episode.duration;result.publisher_transcript_count=episode.transcripts.length;
  stage='import_publisher_evidence_without_asr';
  const receipt=(await json('/api/v1/ingestions',{protocolVersion:1,source:{kind:'url',url:selection.feed_url},episode:{feed_url:selection.feed_url,episode_id:episode.id}})).ingestion;
  assert.equal(receipt.state,mode==='rss'?'ready':'needs_transcription');
  const document={...(mode==='rss'?receipt.transcript.document:receipt.project.document),key:'source-closure-'+mode,project_note:'Authored source preservation note',timestamp_bookmarks:[{id:'proof',time:1,note:'Authored source bookmark'}]};
  assert.equal(document.podcast_source.episode_id,episode.id);assert.equal(document.podcast_source.media_url,medium.url);
  if(mode==='rss'){assert.ok(document.segments.length>0);assert.equal(document.provenance.kind,'publisher_transcript');assert.equal(document.provenance.review_status,'unreviewed');}else assert.equal(document.segments.length,0);
  result.publisher_segments=document.segments.length;result.publisher_transcript_sha256=digest(JSON.stringify(document.segments));
  stage='commit_source_project';const library=await json('/api/v1/library');assert.equal(library.backend,'sqlite');
  await json('/api/v1/library/commit',{protocolVersion:1,epoch:library.epoch,action:'put',key:document.key,receiptKey:'source-proof-save',expected:null,document});
  stage='download_explicit_media_with_fresh_source_validation';assert.equal(receipt.media.download.endpoint,'/api/podcasts/media');
  const remote=await response('/api/podcasts/media',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...receipt.media.download.body,maxBytes:LIMIT})});assert.equal(remote.status,200);
  const type=remote.headers.get('content-type'),chunks=[];let size=0;for await(const chunk of remote.body){size+=chunk.length;assert.ok(size<=LIMIT);chunks.push(chunk);}assert.equal(size,medium.length);const bytes=Buffer.concat(chunks),sha256=digest(bytes);
  result.media_bytes=size;result.media_type=type;result.media_sha256=sha256;
  stage='persist_owned_source_media';const source=digest(identity.sourceMediaIdentity(document));
  const params=new URLSearchParams({key:document.key,source,name:mode+'.'+(type==='audio/mp4'?'m4a':'mp3')});
  const storedResponse=await response('/api/v1/source-media?'+params,{method:'POST',headers:{'Content-Type':type},body:bytes});const stored=await storedResponse.json();assert.equal(storedResponse.status,200,JSON.stringify(stored));assert.equal(stored.media.sha256,sha256);assert.equal(stored.media.size,size);
  result.media_persisted=true;
  stage='restart_without_source_adapter';await server.shutdown();server=null;
  await start({discover:rejectRestoreSource,importEpisode:rejectRestoreSource,openEpisodeMedia:rejectRestoreSource,downloadMedia:rejectRestoreSource});
  const reopened=(await json('/api/v1/library/document?protocolVersion=1&key='+document.key)).record.document;assert.deepEqual(reopened,JSON.parse(JSON.stringify(document)));
  const saved=(await json('/api/v1/source-media?'+new URLSearchParams({key:document.key,source}))).media;assert.deepEqual(saved,stored.media);
  const route='/api/v1/source-media/content?'+new URLSearchParams({key:document.key,binding:saved.binding,sha256:saved.sha256});
  stage='read_owned_bytes_and_range_after_restart';
  const head=await response(route,{method:'HEAD'});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),size);assert.equal(head.headers.get('content-type'),type);
  const full=await response(route);assert.equal(full.status,200);const returned=Buffer.from(await full.arrayBuffer());assert.equal(returned.length,size);assert.equal(digest(returned),sha256);
  const range=await response(route,{headers:{Range:'bytes=0-1023'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),`bytes 0-1023/${size}`);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(0,1024));
  result.sqlite_restart_exact_project=true;result.media_restart_hash_match=true;result.range_readback_verified=true;assert.equal(result.restore_provider_requests,0);assert.equal(result.paid_calls,0);assert.equal(result.transcription_attempted,false);result.passed=true;stage='complete';
 }catch(error){// Assertion diffs and upstream errors can contain publisher text or URLs.
  // Keep failures useful by stage without publishing raw source payloads.
  result.error_code=/^[A-Z_a-z0-9-]{1,80}$/.test(String(error.code||error.name))?String(error.code||error.name):'source_proof_failed';}
 finally{
  try{await server?.shutdown();}catch{result.passed=false;result.cleanup_error='service_shutdown_failed';stage='cleanup';}
  finally{try{await rm(directory,{recursive:true,force:true});}catch{result.passed=false;result.cleanup_error='temporary_cleanup_failed';stage='cleanup';}}
 }
 result.stage=stage;return result;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 assert.equal(process.argv[2],'--live','Explicit --live is required; no source requests run by importing this module');
 assert.equal(process.argv.length,4,'Choose --live xiaoyuzhou or --live rss');
 const result=await provePodcastSource({mode:process.argv[3],...(process.env.SOURCE_URL?{url:process.env.SOURCE_URL}:{})});
 console.log(JSON.stringify(result,null,2));process.exitCode=result.passed?0:1;
}
