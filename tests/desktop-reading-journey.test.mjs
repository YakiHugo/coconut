/** Cross-module HTTP contracts only: authored sources, injected CLI output, no network/model calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {startBridge} from '../desktop/server.mjs';
import {createPodcastSources} from '../desktop/podcast-sources.mjs';
import {createCaptionService} from '../desktop/caption-service.mjs';
import {createProviders,CODEX_DISABLED} from '../desktop/providers.mjs';
const require=createRequire(import.meta.url),Coconut=require('../reader/core.js'),Summary=require('../reader/summary.js');
const feedUrl='https://publisher.example.org/feed.xml',captionUrl='https://publisher.example.org/authored.vtt',mediaUrl='https://publisher.example.org/authored.mp3';
const text='WEBVTT\n\n00:00.000 --> 00:05.000\nAn authored example introduces a small idea.\n\n00:05.000 --> 00:10.000\nThe second sentence provides a cited conclusion.\n';
const feed=`<rss xmlns:p="https://podcastindex.org/namespace/1.0"><channel><title>Authored source</title><language>en-US</language><item><guid>authored-episode</guid><title>Authored episode</title><link>https://publisher.example.org/episode</link><enclosure url="${mediaUrl}" type="audio/mpeg" length="11"/><p:transcript url="${captionUrl}" type="text/vtt"/></item></channel></rss>`;
function providersFixture(){
 const calls=[];
 const providers=createProviders({find:async provider=>'/fixture/'+provider,run:async(_binary,args,options)=>{
  if(args.includes('--help'))return {code:0,stdout:'--ephemeral --ignore-user-config --ignore-rules --output-schema --sandbox'};
  if(args[0]==='features')return {code:0,stdout:CODEX_DISABLED.join('\n')};
  if(args[0]==='login')return {code:0,stdout:'Logged in using ChatGPT'};
  if(args.includes('auth'))return {code:0,stdout:JSON.stringify({loggedIn:false})};
  const marker='Untrusted transcript input (JSON):\n',input=JSON.parse(options.input.slice(options.input.indexOf(marker)+marker.length));calls.push(input);
  const output=input.target_ids?{translations:input.target_ids.map(id=>({id,text:'供测试的原文译文。'}))}:{answer:'Authored, injected summary for contract verification.',citations:input.transcript.map(c=>c.id)};
  return {code:0,stdout:[{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(output)}},{type:'turn.completed'}].map(JSON.stringify).join('\n')};
 }});
 return {providers,calls};
}
async function bridge(t,options){
 const server=await startBridge({port:0,...options}),origin=`http://127.0.0.1:${server.address().port}`;
 t.after(()=>new Promise(resolve=>server.shutdown(resolve)));
 const post=(path,data,signal)=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data),signal});
 return {origin,post};
}

test('public source → timed document → consented translation and cited summary → clean JSON recovery',async t=>{
 const {providers,calls}=providersFixture(),sourceCalls=[];
 const podcastSources=createPodcastSources({fetchResource:async(url,options)=>{
  sourceCalls.push(url);assert.ok(options.signal instanceof AbortSignal);
  if(url===feedUrl)return {url,type:'application/rss+xml',body:Buffer.from(feed)};
  if(url===captionUrl)return {url,type:'text/vtt',body:Buffer.from(text)};
  if(url===mediaUrl)return {url,type:'audio/mpeg',body:Buffer.from('ID3 fixture')};
  throw new Error('No other source is authorized in this fixture');
 }});
 const {origin,post}=await bridge(t,{providers,podcastSources});
 const health=await fetch(origin+'/api/health').then(r=>r.json());assert.equal(health.capabilities.podcast_import,true);assert.equal(health.capabilities.caption_import,false);assert.deepEqual(sourceCalls,[]);assert.deepEqual(calls,[]);
 const found=await (await post('/api/podcasts/discover',{url:feedUrl})).json();assert.equal(found.episodes.length,1);
 const imported=await (await post('/api/podcasts/import',{feedUrl,episodeId:found.episodes[0].id})).json();assert.equal(imported.status,'ready');
 const doc=Coconut.validate(imported.document);assert.equal(doc.language,'en-us');assert.equal(doc.provenance.review_status,'unreviewed');assert.deepEqual(doc.segments.map(c=>[c.start,c.end]),[[0,5],[5,10]]);
 assert.deepEqual(sourceCalls,[feedUrl,feedUrl,captionUrl]);assert.deepEqual(calls,[]);
 doc.notes[doc.segments[1].id]='Private reading note must not be model context.';
 const plan=Coconut.subscriptionPlan(doc,[doc.segments[0].id],'en','zh','chatgpt_subscription_translation'),batch=plan.windows[0];
 const payload={source:'en',target:'zh',provider:'codex',segments:batch.segments,context:batch.context,glossary:batch.glossary,memory:batch.memory};
 assert.equal((await post('/api/translate-subscription',payload)).status,400);assert.deepEqual(calls,[]);
 const translated=await post('/api/translate-subscription',{...payload,consent:true});assert.equal(translated.status,200);
 const {translations}=await translated.json();assert.equal(translations.length,1);assert.equal(translations[0].source_text,doc.segments[0].text);
 assert.deepEqual(calls[0].cues.map(c=>c.id),[doc.segments[0].id]);assert.deepEqual(calls[0].target_ids,[doc.segments[0].id]);
 const contextId=randomUUID();doc.translation_contexts={[contextId]:batch.snapshot};doc.segments[0].translations.zh={...translations[0],context_id:contextId,document_language:doc.language,source_language:'en',target_language:'zh',glossary_snapshot:batch.glossary};doc.translation_view='zh';
 const summaryPlan=Summary.plan(doc),job=Summary.create(summaryPlan,'codex'),request=Summary.request(summaryPlan,job);
 assert.equal((await post('/api/ask',{...request,consent:false})).status,400);assert.equal(calls.length,1);
 const summaryResponse=await post('/api/ask',request);assert.equal(summaryResponse.status,200);
 const summary=Summary.accept(summaryPlan,job,await summaryResponse.json());doc.ai_answers=[summary];
 assert.equal(calls.length,2);assert.deepEqual(calls[1].transcript.map(c=>c.id),doc.segments.map(c=>c.id));assert.equal(JSON.stringify(calls).includes('Private reading note'),false);
 const restored=Coconut.parse(JSON.stringify(doc),'recovery.json');assert.equal(restored.language,'en-us');assert.equal(restored.notes[doc.segments[1].id],doc.notes[doc.segments[1].id]);assert.equal(Coconut.summaryFreshness(restored.ai_answers[0],restored),'current');assert.equal(Coconut.translationCurrent(restored.segments[0],restored,restored.segments[0].translations.zh),true);
 assert.match(Coconut.summaryMarkdown(restored),/Authored, injected summary/);assert.equal(Coconut.subtitleExport(restored,'vtt',true).translated,1);
 assert.equal(sourceCalls.includes(mediaUrl),false);
 const media=await post('/api/podcasts/media',{feedUrl,episodeId:found.episodes[0].id,mediaUrl});assert.equal(media.status,200);assert.equal(media.headers.get('X-Coconut-Media-Kind'),'audio');assert.equal(await media.text(),'ID3 fixture');assert.deepEqual(sourceCalls.slice(-2),[feedUrl,mediaUrl]);assert.equal(calls.length,2);
});

test('closing an in-flight caption HTTP request cancels extraction and releases the next import',async t=>{
 let started,aborted,calls=0;
 const began=new Promise(resolve=>{started=resolve;}),stopped=new Promise(resolve=>{aborted=resolve;});
 const captionService=createCaptionService({enabledProviders:['x'],helper:{extractCaptions:async({url,signal})=>{
  calls++;
  if(calls===1){started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted();reject(new Error('Canceled fixture'));},{once:true}));}
  return {status:'ready',source:{url,id:'456',extractor:'twitter',duration:10,language:'en-US',automatic:false},format:'vtt',bytes:Buffer.from(text)};
 }}});
 const {post}=await bridge(t,{captionService}),controller=new AbortController();
 const pending=post('/api/captions/import',{url:'https://x.com/example/status/123'},controller.signal);
 await began;controller.abort();await assert.rejects(pending,{name:'AbortError'});await stopped;
 const imported=await post('/api/captions/import',{url:'https://x.com/example/status/123'});assert.equal(imported.status,200);
 const result=await imported.json();assert.equal(result.status,'ready');assert.equal(result.document.language,'en-US');assert.equal(result.document.provenance.media_id,'456');assert.equal(calls,2);
});
