import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {directEpisodeFixture,directEpisodeEid,directEpisodeId,directEpisodeURL,directShowURL,directRSSURL,directMediaURL} from './fixtures/direct-episode-import.mjs';

const helper=await build({entryPoints:['frontend/app/episode-link.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {resolveEpisodeLink}=await import('data:text/javascript;base64,'+Buffer.from(helper.outputFiles[0].contents).toString('base64'));
const app=await build({entryPoints:['frontend/app/main.tsx'],bundle:true,format:'iife',platform:'browser',target:['es2022'],minify:true,define:{'process.env.NODE_ENV':'"production"'},outdir:'reader',write:false});
const bundle=app.outputFiles.find(file=>file.path.endsWith('.js')).text,page=await readFile('reader/index.html','utf8');
const scripts=await Promise.all([...page.matchAll(/<script src="([^"]+)"/g)].map(match=>match[1].split('?')[0]).filter(name=>name!=='react-app.js').map(name=>readFile('reader/'+name,'utf8')));
const wait=async(check)=>{for(let attempt=0;attempt<300;attempt++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.ok(check(),'UI did not settle');};
const selection=()=>({kind:'feed',source_type:'xiaoyuzhou_public_page',feed_url:directEpisodeURL,feeds:[],episodes:[{id:directEpisodeId,title:'Authored direct episode',source_url:directEpisodeURL,media:[{url:directMediaURL,kind:'audio'}],transcripts:[]}]});

test('the direct episode helper binds one official HTTPS episode to source, feed, SHA-256 identity and media',async()=>{
 const value=selection();
 assert.equal(await resolveEpisodeLink(directEpisodeURL,value),value.episodes[0]);
 const shared=`https://xiaoyuzhoufm.com/episode/${directEpisodeEid}/?utm_source=share_page&utm_medium=mobile#share`;
 const normalized=selection();normalized.feed_url=shared;
 assert.equal(await resolveEpisodeLink(shared,normalized),normalized.episodes[0],'bare official host, trailing slash and share decorations refer to the same episode');
 const recommended=selection();
 recommended.episodes[0].transcripts=[{url:'https://publisher.example.org/en.vtt',supported:true,type:'text/vtt',language:'en'}];
 recommended.episodes[0].transcript_selection={status:'default',transcript_url:recommended.episodes[0].transcripts[0].url,language:'en',type:'text/vtt'};
 assert.equal(await resolveEpisodeLink(directEpisodeURL,recommended),recommended.episodes[0],'an explicit publisher default needs no manual language choice');
});

test('the direct episode helper rejects nonofficial, non-episode and insecure input',async t=>{
 for(const url of [
  `http://www.xiaoyuzhoufm.com/episode/${directEpisodeEid}`,
  `https://www.xiaoyuzhoufm.com.attacker.example/episode/${directEpisodeEid}`,
  `https://attacker.example/episode/${directEpisodeEid}`,
  `https://www.xiaoyuzhoufm.com@attacker.example/episode/${directEpisodeEid}`,
  `https://user:password@www.xiaoyuzhoufm.com/episode/${directEpisodeEid}`,
  `https://www.xiaoyuzhoufm.com:8443/episode/${directEpisodeEid}`,
  directShowURL,directRSSURL,
  `https://www.xiaoyuzhoufm.com/episode/${directEpisodeEid}/extra`,
  `https://www.xiaoyuzhoufm.com/episode/${directEpisodeEid.slice(1)}`,
  `https://www.xiaoyuzhoufm.com/episode/${directEpisodeEid}0`,
  'not a URL',
 ])await t.test(url,async()=>assert.equal(await resolveEpisodeLink(url,selection()),null));
});

test('the direct episode helper leaves ambiguous or unbound receipts for explicit selection',async t=>{
 const cases=[
  ['RSS source type',value=>value.source_type='rss'],
  ['absent source type',value=>delete value.source_type],
  ['empty episode list',value=>value.episodes=[]],
  ['multiple episodes',value=>value.episodes.push({...value.episodes[0],id:'b'.repeat(64)})],
  ['wrong publisher ID hash',value=>value.episodes[0].id='b'.repeat(64)],
  ['raw publisher ID instead of hash',value=>value.episodes[0].id=directEpisodeEid],
  ['missing source URL',value=>delete value.episodes[0].source_url],
  ['different source episode',value=>value.episodes[0].source_url=directEpisodeURL.slice(0,-1)+'5'],
  ['nonofficial source URL',value=>value.episodes[0].source_url='https://attacker.example/episode/'+directEpisodeEid],
  ['different feed episode',value=>value.feed_url=directEpisodeURL.slice(0,-1)+'5'],
  ['show feed',value=>value.feed_url=directShowURL],
  ['RSS feed',value=>value.feed_url=directRSSURL],
  ['no media',value=>delete value.episodes[0].media],
  ['empty media',value=>value.episodes[0].media=[]],
  ['manual caption choice',value=>{value.episodes[0].transcripts=[{url:'https://publisher.example.org/en.vtt',supported:true,type:'text/vtt',language:'en'}];value.episodes[0].transcript_selection={status:'choice_required'};}],
  ['supported caption without a default',value=>value.episodes[0].transcripts=[{url:'https://publisher.example.org/en.vtt',supported:true,type:'text/vtt',language:'en'}]],
 ];
 for(const [name,change] of cases)await t.test(name,async()=>{const value=selection();change(value);assert.equal(await resolveEpisodeLink(directEpisodeURL,value),null);});
 assert.equal(await resolveEpisodeLink(directEpisodeURL,undefined),null);
 assert.equal(await resolveEpisodeLink(directEpisodeURL,null),null);
});

async function setup({holdSecond=false,selectionOnlyFirst=false}={}){
 const fixture=directEpisodeFixture(),requests=[],finished=[];
 const w=new Window({url:'http://localhost/'});
 Object.defineProperty(w,'crypto',{value:webcrypto});w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;
 w.document.body.innerHTML='<div id="react-root"></div>';
 let release;const gate=new Promise(resolve=>release=resolve);
 w.fetch=async(url,options)=>{
  if(url==='api/health')return {ok:true,json:async()=>({})};
  assert.equal(url,'api/v1/ingestions','Discovery must not call media, model or ASR APIs');
  const data=JSON.parse(options.body);requests.push({data,signal:options.signal});
  // Finish the real parser before the gate, then deliberately ignore AbortSignal.
  // The React request owner must discard a late, otherwise valid receipt.
  const result=await fixture.service.ingest(data);
  if(selectionOnlyFirst&&requests.length===1&&result.ingestion.selection)delete result.ingestion.selection.source_type;
  if(data.episode&&holdSecond)await gate;
  finished.push(data);return {ok:true,json:async()=>result};
 };
 for(const script of scripts)w.eval(script);
 const adapter=w.CoconutLibraryStore.createLegacyAdapter({getStorage:()=>w.localStorage,validate:w.Coconut.validate});
 w.CoconutStorageProvider={initialize:async()=>({ok:true,adapter,loaded:adapter.load()})};w.eval(bundle);
 await wait(()=>w.document.querySelector('#source-url'));
 const button=text=>[...w.document.querySelectorAll('button')].find(node=>typeof text==='string'?node.textContent===text:text.test(node.textContent));
 const input=value=>{const node=w.document.querySelector('#source-url');Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new w.Event('input',{bubbles:true}));};
 const open=url=>{input(url);w.document.querySelector('#source-url').closest('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));};
 const docs=()=>JSON.parse(w.localStorage.getItem('coconut-reader-v1')||'{"documents":[]}').documents;
 return {w,fixture,requests,finished,button,input,open,docs,release};
}

for(const url of [directShowURL,directRSSURL])test('a single-item show or RSS still waits for explicit episode selection: '+url,async()=>{
 const x=await setup();try{
  x.open(url);await wait(()=>x.w.document.querySelector('.episode-list'));
  assert.equal(x.w.document.querySelectorAll('.episode-list article').length,1);
  assert.equal(x.requests.length,1);assert.equal(x.requests[0].data.episode,undefined);
  assert.equal(x.docs().length,0);assert.equal(x.fixture.counts.media,0);
 }finally{x.release();await x.w.happyDOM.close();}
});

test('refreshing an existing episode list remains a metadata read',async()=>{
 const x=await setup({selectionOnlyFirst:true});try{
  x.open(directEpisodeURL);await wait(()=>x.w.document.querySelector('.episode-list'));
  x.button('刷新节目列表').click();await wait(()=>x.finished.length===2&&x.w.document.querySelector('.source-composer')?.getAttribute('aria-busy')==='false');
  assert.equal(x.requests.length,2);assert.ok(x.requests.every(request=>!request.data.episode));
  assert.equal(x.docs().length,0);assert.equal(x.fixture.counts.media,0);
 }finally{x.release();await x.w.happyDOM.close();}
});

for(const boundary of ['cancel','change URL','navigation'])test('a late second-stage direct episode receipt cannot create a project after '+boundary,async()=>{
 const x=await setup({holdSecond:true});try{
  x.open(directEpisodeURL);await wait(()=>x.requests.length===2);
  const first=x.requests[0],second=x.requests[1];
  assert.equal(first.data.source.url,directEpisodeURL);assert.equal(first.data.episode,undefined);
  assert.equal(second.data.episode.episode_id,directEpisodeId);assert.equal(second.data.episode.feed_url,directEpisodeURL);
  assert.equal(second.signal,first.signal,'both ingestion stages must share the same controller');
  assert.equal(x.docs().length,0);
  if(boundary==='cancel')x.button('取消读取').click();
  else if(boundary==='change URL')x.input(directRSSURL);
  else x.button(/^我的内容/).click();
  await wait(()=>second.signal.aborted);
  x.release();await wait(()=>x.finished.length===2);
  // Let the fulfilled JSON, React continuation and persistence queue all run.
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(x.docs().length,0);assert.equal(x.fixture.counts.media,0);
  assert.equal(x.w.document.querySelector('.reader-workspace'),null);
  assert.equal(x.w.document.querySelector('.source-project-choice'),null);
 }finally{x.release();await x.w.happyDOM.close();}
});
