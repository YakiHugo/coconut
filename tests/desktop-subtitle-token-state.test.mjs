/** Authored, offline observations only. No target video or platform requests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCaptionService} from '../desktop/caption-service.mjs';
import {createVideoAudioService} from '../desktop/video-audio-service.mjs';
import {startBridge} from '../desktop/server.mjs';
import {sourceInput,initialSourceReport,recordSourceReceipt} from '../scripts/live_source_acceptance.mjs';
const url='https://www.youtube.com/watch?v=abcdefghijk';
const diagnostic={stage:'metadata',reason:'subtitle_token_required',requests_attempted:1,responses_received:1};
const availability={metadata:'unverified',captions:'token_required',media:'unknown'};
const failure=()=>({status:'subtitle_token_required',diagnostic:{...diagnostic,raw:'PRIVATE'},availability:{metadata:'validated',captions:'absent',media:'available'}});

test('actual owner API preserves subtitle requirement, unknown media and no automatic fallback or persistence',async t=>{
 let captions=0,media=0;
 const forbidden=async()=>assert.fail('No model or transcription request is allowed');
 const server=await startBridge({port:0,libraryDirectory:null,
  captionService:createCaptionService({enabledProviders:['youtube'],helper:{extractCaptions:async()=>{captions++;return failure();}}}),
  videoAudioService:createVideoAudioService({helper:{extractAudio:async()=>{media++;return failure();}},sourceMedia:true}),
  providers:{status:forbidden,ask:forbidden,structured:forbidden,exclusive:forbidden}});
 t.after(()=>server.shutdown());const origin='http://127.0.0.1:'+server.address().port;
 const request=(route,body)=>fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const response=await request('/api/v1/ingestions',{protocolVersion:1,source:{kind:'url',url}});
 assert.equal(response.status,200);const payload=await response.json(),receipt=payload.ingestion;
 assert.equal(receipt.state,'blocked');assert.equal(receipt.error.code,'subtitle_token_required');
 assert.deepEqual(receipt.error.availability,availability);assert.deepEqual(receipt.error.diagnostic,diagnostic);
 assert.equal(receipt.error.audio_fallback,undefined);assert.equal(receipt.transcript,null);assert.equal(receipt.project,null);
 assert.match(receipt.error.message,/客户端来源证明，不等于账号登录/);assert.match(receipt.error.message,/媒体是否可取得尚未知/);
 assert.doesNotMatch(JSON.stringify(receipt),/PRIVATE/);assert.equal(captions,1);assert.equal(media,0);
 const input=sourceInput(url,'en',true),report=initialSourceReport(input);
 assert.equal(recordSourceReceipt(report,input,payload,200),null);assert.equal(report.passed,false);
 assert.deepEqual(report.availability,availability);assert.equal(report.metadata.state,'unverified');assert.equal(report.captions.state,'blocked');
 assert.equal(report.media.state,'not_attempted');assert.equal(report.persist.state,'not_attempted');assert.equal(report.restart.state,'not_attempted');
 // An already explicit, separate media request can hit the same extraction stop:
 // it must keep unknown media rather than reclassify it as media access denial.
 const stopped=await request('/api/videos/source-media',{url,language:'en',consent:true});
 assert.equal(stopped.status,409);const error=await stopped.json();assert.equal(error.code,'subtitle_token_required');
 assert.deepEqual(error.availability,availability);assert.match(error.error,/尚未知/);assert.equal(media,1);
});
