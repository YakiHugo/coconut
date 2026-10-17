import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {sourceDiscoveryFixture,sourceFeed,frenchTrack,unlabelledTrack,upgradeTrack,audioFirstFixture,audioFirstTrack} from './fixtures/source-discovery.mjs';
const bundle=await readFile('reader/react-app.js','utf8'),page=await readFile('reader/index.html','utf8');
const scripts=await Promise.all([...page.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1].split('?')[0]).filter(name=>name!=='react-app.js').map(name=>readFile('reader/'+name,'utf8')));
const wait=async(check)=>{for(let i=0;i<300;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.ok(check(),'UI did not settle');};
const built=await build({entryPoints:['frontend/app/discovery-session.ts'],bundle:true,format:'esm',write:false,platform:'node'});
const {exactSourceIdentity,matchingSourceDocuments}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
async function setup(fixture=sourceDiscoveryFixture(),seed=[]){
 const w=new Window({url:'http://localhost/'});Object.defineProperty(w,'crypto',{value:webcrypto});w.structuredClone=structuredClone;w.document.body.innerHTML='<div id="react-root"></div>';
 if(seed.length)w.localStorage.setItem('coconut-reader-v1',JSON.stringify({documents:seed,active:seed[0].key}));
 const requests=[];w.fetch=async(path,options)=>{
  if(path==='api/health')return {ok:true,json:async()=>({})};
  assert.equal(path,'api/v1/ingestions');const data=JSON.parse(options.body);requests.push(data);
  try{const result=await fixture.service.ingest(data,{signal:options.signal});return {ok:true,json:async()=>result};}catch(error){return {ok:false,json:async()=>({error:error.message})};}
 };
 for(const script of scripts)w.eval(script);
 const adapter=w.CoconutLibraryStore.createLegacyAdapter({getStorage:()=>w.localStorage,validate:w.Coconut.validate});w.CoconutStorageProvider={initialize:async()=>({ok:true,adapter,loaded:adapter.load()})};w.eval(bundle);
 await wait(()=>w.document.querySelector('#source-url'));
 const buttons=(text)=>[...w.document.querySelectorAll('button')].filter(x=>x.textContent===text),button=text=>buttons(text)[0];
 const input=(node,value)=>{Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new w.Event('input',{bubbles:true}));};
 const select=(node,value)=>{node.value=value;node.dispatchEvent(new w.Event('change',{bubbles:true}));};
 const docs=()=>JSON.parse(w.localStorage.getItem('coconut-reader-v1')||'{"documents":[]}').documents;
 const discover=async()=>{button('发现与添加').click();await wait(()=>w.document.querySelector('#source-url'));};
 const load=async()=>{input(w.document.querySelector('#source-url'),sourceFeed);w.document.querySelector('#source-url').closest('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await wait(()=>w.document.querySelector('.episode-list'));};
 const episode=title=>[...w.document.querySelectorAll('.episode-list article')].find(node=>node.querySelector('h3').textContent===title);
 const open=async(title,track)=>{const article=episode(title);if(track){select(article.querySelector('select'),track);await wait(()=>!article.querySelector('button').disabled);}article.querySelector('button').click();await new Promise(r=>setTimeout(r,0));};
 return {w,fixture,requests,button,buttons,input,select,docs,discover,load,episode,open};
}
test('real parser track selection, retry, session return, exact reopen and explicit multiple copies',async()=>{
 const x=await setup();const {w}=x;try{
  await x.load();const first=x.episode('Authored multilingual episode');assert.equal(first.querySelector('button').disabled,true);assert.match(first.textContent,/en · text\/vtt · 2/);
  x.fixture.state.failTrack=true;await x.open('Authored multilingual episode',frenchTrack);await wait(()=>w.document.body.textContent.includes('Authored transcript temporarily unavailable'));
  assert.ok(x.episode('Authored multilingual episode'));assert.equal(x.episode('Authored multilingual episode').querySelector('select').value,frenchTrack);assert.equal(x.docs().length,0);
  x.fixture.state.failTrack=false;x.button('重试上次读取：Authored multilingual episode').click();await wait(()=>w.document.querySelector('.reader-workspace'));await wait(()=>x.docs().length===1);
  const original=x.docs()[0];assert.equal(original.language,'fr');assert.equal(original.segments[0].text,'Bonjour, cette source reste intacte.');assert.equal(x.requests.at(-1).episode.transcript_url,frenchTrack);
  await x.discover();assert.equal(w.document.querySelector('#source-url').value,sourceFeed);assert.ok(x.episode('Authored evolving episode'));assert.equal(x.episode('Authored multilingual episode').querySelector('select').value,frenchTrack);
  await x.open('Authored multilingual episode');await wait(()=>w.document.querySelector('.source-project-choice'));assert.equal(x.docs().length,1);assert.equal(x.buttons('确认接入此原声项目').length,0);
  x.button('继续已有项目 · '+original.key.slice(-8)).click();await wait(()=>w.document.querySelector('.reader-workspace'));assert.equal(x.docs()[0].key,original.key);
  await x.discover();await x.open('Authored multilingual episode');await wait(()=>w.document.querySelector('.source-project-choice'));x.button('另建独立副本').click();await wait(()=>x.docs().length===2);
  await x.discover();await x.open('Authored multilingual episode');await wait(()=>w.document.querySelectorAll('.source-project-choice article').length===2);assert.equal(w.document.querySelector('.reader-workspace'),null);x.button('继续已有项目 · '+original.key.slice(-8)).click();await wait(()=>w.document.querySelector('.reader-workspace'));assert.equal(x.docs().length,2);
 }finally{await w.happyDOM.close();}
});
test('audio-only upgrade requires explicit preview and preserves original key, notes, bookmarks and opaque data',async()=>{
 const fixture=sourceDiscoveryFixture(),base={protocolVersion:1,source:{kind:'url',url:sourceFeed}};
 const selection=(await fixture.service.ingest(base)).ingestion.selection,second=selection.episodes[1];
 const project=(await fixture.service.ingest({...base,episode:{feed_url:sourceFeed,episode_id:second.id}})).ingestion.project.document;
 project.key='original-project';project.project_note='My original project note';project.opaque={keep:['unchanged']};project.timestamp_bookmarks=[{id:'b',time:1,note:'Keep bookmark',future:{keep:true}}];project.podcast_source.future={keep:'source extension'};
 fixture.state.upgrade=true;
 const x=await setup(fixture,[project]);const {w}=x;try{
  await x.load();await x.open('Authored evolving episode',upgradeTrack);await wait(()=>w.document.querySelector('.source-project-choice'));
  assert.equal(x.docs()[0].segments.length,0);x.button('核对新文字稿 · -project').click();await wait(()=>w.document.querySelector('[aria-label="核对并接入文字稿"]'));assert.match(w.document.body.textContent,/The original project keeps its notes/);
  x.button('取消接入').click();assert.equal(x.docs()[0].segments.length,0);x.button('核对新文字稿 · -project').click();x.button('确认接入此原声项目').click();await wait(()=>x.docs()[0].segments.length===1);await wait(()=>w.document.querySelector('.reader-workspace'));
  const saved=x.docs()[0];assert.equal(x.docs().length,1);assert.equal(saved.key,project.key);assert.equal(saved.project_note,project.project_note);assert.deepEqual(saved.opaque,project.opaque);assert.deepEqual(saved.timestamp_bookmarks,project.timestamp_bookmarks);assert.deepEqual(saved.podcast_source.future,project.podcast_source.future);assert.equal(saved.podcast_source.transcript_url,upgradeTrack);
  await x.discover();await x.open('Authored evolving episode');await wait(()=>w.document.querySelector('.source-project-choice'));assert.equal(x.button('核对新文字稿 · -project'),undefined,'existing transcript cannot be overwritten');
 }finally{await w.happyDOM.close();}
});
test('cancel, newer URL and leaving discovery retire requests while retaining completed discovery context',async()=>{
 const x=await setup();const {w}=x;try{
  await x.load();let release;x.fixture.state.hold=new Promise(resolve=>release=resolve);await x.open('Authored multilingual episode',unlabelledTrack);await wait(()=>x.button('取消读取'));x.button('取消读取').click();assert.ok(x.episode('Authored multilingual episode'));release();x.fixture.state.hold=null;await new Promise(r=>setTimeout(r,25));assert.equal(x.docs().length,0);
  x.button('重试上次读取：Authored multilingual episode').click();await wait(()=>x.docs().length===1);assert.equal(x.docs()[0].segments[0].text,'A publisher track without language metadata.');
  await x.discover();x.fixture.state.hold=new Promise(resolve=>release=resolve);await x.open('Authored multilingual episode');await wait(()=>x.button('取消读取'));x.input(w.document.querySelector('#source-url'),'https://publisher.example.org/new');release();x.fixture.state.hold=null;await new Promise(r=>setTimeout(r,25));assert.equal(w.document.querySelector('.episode-list'),null);assert.equal(w.document.querySelector('.source-project-choice'),null);assert.equal(x.docs().length,1);
  await x.load();x.fixture.state.hold=new Promise(resolve=>release=resolve);await x.open('Authored multilingual episode',frenchTrack);await wait(()=>x.button('取消读取'));x.button('我的内容 1').click();await wait(()=>w.document.querySelector('.library-page'));release();x.fixture.state.hold=null;await new Promise(r=>setTimeout(r,25));await x.discover();assert.ok(x.episode('Authored multilingual episode'));assert.match(w.document.body.textContent,/读取已暂停/);assert.equal(x.docs().length,1);
 }finally{await w.happyDOM.close();}
});
test('source identity uses exact provider/feed/episode or direct URL, never title, enclosure or filename',()=>{
 const source={feed_url:sourceFeed,episode_id:'a'.repeat(64),media_url:'https://publisher.example.org/shared.mp3'},doc={key:'one',title:'Same title',segments:[],podcast_source:source};
 assert.equal(matchingSourceDocuments([doc],{...doc,podcast_source:{...source,transcript_url:frenchTrack}}).length,1);
 assert.equal(matchingSourceDocuments([doc],{...doc,podcast_source:{...source,episode_id:'b'.repeat(64)}}).length,0);
 assert.equal(matchingSourceDocuments([doc],{...doc,podcast_source:{...source,feed_url:sourceFeed+'?other'}}).length,0);
 assert.equal(exactSourceIdentity({title:'Same title',source_url:'https://publisher.example.org/one'}),null);
 assert.equal(exactSourceIdentity({podcast_source:{kind:'direct_media',media_url:'https://publisher.example.org/a.mp3#x'}}),exactSourceIdentity({podcast_source:{kind:'direct_media',media_url:'https://publisher.example.org/a.mp3'}}));
 assert.notEqual(exactSourceIdentity({provenance:{kind:'platform_subtitles',source_platform:'youtube',media_id:'same'}}),exactSourceIdentity({provenance:{kind:'platform_subtitles',source_platform:'bilibili',media_id:'same'}}));
});
test('actual backend rejects trackless language mismatch; React explicit track resolves it without backend changes',async()=>{
 const fixture=sourceDiscoveryFixture();fixture.state.onlyFrench=true;const source={protocolVersion:1,source:{kind:'url',url:sourceFeed}},episode=(await fixture.service.ingest(source)).ingestion.selection.episodes[0];
 await assert.rejects(fixture.service.ingest({...source,episode:{feed_url:sourceFeed,episode_id:episode.id}}),/明确选择/);
 const x=await setup(fixture);try{await x.load();await x.open('Authored multilingual episode',frenchTrack);await wait(()=>x.docs().length===1);assert.equal(x.docs()[0].language,'fr');}finally{await x.w.happyDOM.close();}
});
test('publisher without feed or track language still allows explicit unlabelled track selection',async()=>{
 const fixture=sourceDiscoveryFixture();fixture.state.feedLanguage='';const x=await setup(fixture);try{await x.load();assert.match(x.episode('Authored multilingual episode').textContent,/语言未标明/);await x.open('Authored multilingual episode',unlabelledTrack);await wait(()=>x.docs().length===1);assert.equal(x.docs()[0].segments[0].text,'A publisher track without language metadata.');}finally{await x.w.happyDOM.close();}
});
test('direct-media link reopens existing audio project without duplicating or replacing its source',async()=>{
 const x=await setup();try{
  const load=()=>{x.input(x.w.document.querySelector('#source-url'),'https://publisher.example.org/direct.mp3');x.w.document.querySelector('#source-url').closest('form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));};
  load();await wait(()=>x.docs().length===1);const original=x.docs()[0];assert.equal(original.project_kind,'audio_only');await x.discover();load();await wait(()=>x.w.document.querySelector('.source-project-choice'));assert.equal(x.docs().length,1);x.button('继续已有项目 · '+original.key.slice(-8)).click();await wait(()=>x.w.document.querySelector('.reader-workspace'));assert.deepEqual(x.docs()[0],original);
 }finally{await x.w.happyDOM.close();}
});
test('refreshing a feed retires a track that the publisher removed rather than sending a hidden selection',async()=>{
 const x=await setup();try{await x.load();x.select(x.episode('Authored multilingual episode').querySelector('select'),unlabelledTrack);await new Promise(r=>setTimeout(r,0));x.fixture.state.onlyFrench=true;x.button('刷新节目列表').click();await wait(()=>x.episode('Authored multilingual episode').querySelectorAll('option').length===2);assert.equal(x.episode('Authored multilingual episode').querySelector('select').value,'');assert.equal(x.episode('Authored multilingual episode').querySelector('button').disabled,true);assert.equal(x.fixture.counts.feed,2);assert.equal(x.docs().length,0);}finally{await x.w.happyDOM.close();}
});
test('feed snapshots reuse only the completed RSS; explicit refresh invalidates failures and recovery preserves source context',async()=>{
 const x=await setup(),{w,fixture}=x;let release;try{
  const checked=()=>w.document.querySelector('.feed-refresh p').textContent;
  await x.load();assert.deepEqual(fixture.counts,{feed:1,transcript:0});assert.match(checked(),/上次来源检查：/);const initialCheck=checked();
  await x.open('Authored multilingual episode',frenchTrack);await wait(()=>x.docs().length===1);assert.deepEqual(fixture.counts,{feed:1,transcript:1},'opening a publisher track reuses RSS but fetches the actual transcript');
  const original=structuredClone(x.docs());await x.discover();assert.equal(checked(),initialCheck);assert.equal(x.episode('Authored multilingual episode').querySelector('select').value,frenchTrack);
  fixture.state.upgrade=true;assert.equal(x.episode('Authored evolving episode').querySelector('select'),null,'publisher changes do not mutate the completed selection');
  fixture.state.now+=1000;fixture.state.holdFeed=new Promise(resolve=>release=resolve);x.button('刷新节目列表').click();await wait(()=>fixture.counts.feed===2&&x.button('取消读取'));
  assert.equal(checked(),initialCheck);assert.equal(x.button('刷新节目列表').disabled,true);assert.equal(x.episode('Authored multilingual episode').querySelector('button').disabled,true);assert.equal(w.document.querySelector('#source-url').value,sourceFeed);
  release();release=null;fixture.state.holdFeed=null;await wait(()=>x.episode('Authored evolving episode').querySelector('select')&&!x.button('刷新节目列表').disabled);
  const refreshedCheck=checked();assert.notEqual(refreshedCheck,initialCheck);assert.deepEqual(fixture.counts,{feed:2,transcript:1});assert.equal(x.episode('Authored multilingual episode').querySelector('select').value,frenchTrack);
  fixture.state.failFeed=true;fixture.state.now+=1000;x.button('刷新节目列表').click();await wait(()=>fixture.counts.feed===3&&!x.button('刷新节目列表').disabled&&w.document.querySelector('.source-error').textContent.includes('Authored feed temporarily unavailable'));
  assert.equal(checked(),refreshedCheck);assert.ok(x.episode('Authored evolving episode').querySelector('select'));assert.equal(w.document.querySelector('#source-url').value,sourceFeed);assert.equal(x.episode('Authored multilingual episode').querySelector('select').value,frenchTrack);assert.deepEqual(x.docs(),original);
  await x.open('Authored multilingual episode');await wait(()=>fixture.counts.feed===4&&!x.button('刷新节目列表').disabled&&w.document.querySelector('.source-error').textContent.includes('Authored feed temporarily unavailable'));
  assert.equal(fixture.counts.transcript,1,'an import after failed refresh must fetch and fail RSS, never use the old snapshot');assert.equal(w.document.querySelector('.source-project-choice'),null);assert.deepEqual(x.docs(),original);assert.equal(checked(),refreshedCheck);
  fixture.state.failFeed=false;fixture.state.now+=1000;x.button('刷新节目列表').click();await wait(()=>fixture.counts.feed===5&&!x.button('刷新节目列表').disabled&&!w.document.querySelector('.source-error').textContent);
  assert.notEqual(checked(),refreshedCheck);assert.equal(x.episode('Authored multilingual episode').querySelector('select').value,frenchTrack);
  await x.open('Authored multilingual episode');await wait(()=>w.document.querySelector('.source-project-choice'));assert.deepEqual(fixture.counts,{feed:5,transcript:2});assert.deepEqual(x.docs(),original,'recovery offers the existing project without mutating it');
 }finally{release?.();fixture.state.holdFeed=null;await w.happyDOM.close();}
});
test('cancelled refreshes and navigation never replace the completed episode list or repopulate a newer URL',async()=>{
 const x=await setup(),{w,fixture}=x;let release;try{
  const checked=()=>w.document.querySelector('.feed-refresh p').textContent;
  await x.load();x.select(x.episode('Authored multilingual episode').querySelector('select'),frenchTrack);await new Promise(resolve=>setTimeout(resolve,0));const initialCheck=checked();
  fixture.state.now+=1000;fixture.state.holdFeed=new Promise(resolve=>release=resolve);x.button('刷新节目列表').click();await wait(()=>fixture.counts.feed===2&&x.button('取消读取'));x.button('取消读取').click();
  release();release=null;fixture.state.holdFeed=null;await new Promise(resolve=>setTimeout(resolve,25));assert.equal(checked(),initialCheck);assert.match(w.document.querySelector('.source-error').textContent,/读取已取消/);assert.equal(x.episode('Authored multilingual episode').querySelector('select').value,frenchTrack);assert.equal(x.docs().length,0);
  await x.open('Authored multilingual episode');await wait(()=>x.docs().length===1);assert.deepEqual(fixture.counts,{feed:3,transcript:1},'cancelled explicit refresh retires the previous cached RSS');await x.discover();const importCheck=checked();assert.notEqual(importCheck,initialCheck);
  fixture.state.now+=1000;fixture.state.holdFeed=new Promise(resolve=>release=resolve);x.button('刷新节目列表').click();await wait(()=>fixture.counts.feed===4&&x.button('取消读取'));x.button('我的内容 1').click();await wait(()=>w.document.querySelector('.library-page'));
  release();release=null;fixture.state.holdFeed=null;await new Promise(resolve=>setTimeout(resolve,25));await x.discover();assert.equal(checked(),importCheck);assert.match(w.document.querySelector('.source-error').textContent,/读取已暂停/);assert.equal(x.episode('Authored multilingual episode').querySelector('select').value,frenchTrack);
  fixture.state.holdFeed=new Promise(resolve=>release=resolve);x.button('刷新节目列表').click();await wait(()=>fixture.counts.feed===5&&x.button('取消读取'));x.input(w.document.querySelector('#source-url'),'https://publisher.example.org/new');
  release();release=null;fixture.state.holdFeed=null;await new Promise(resolve=>setTimeout(resolve,25));assert.equal(w.document.querySelector('#source-url').value,'https://publisher.example.org/new');assert.equal(w.document.querySelector('.episode-list'),null);assert.equal(w.document.querySelector('.source-project-choice'),null);assert.equal(x.docs().length,1);
 }finally{release?.();fixture.state.holdFeed=null;await w.happyDOM.close();}
});
test('durable source attachment refuses opaque original cue containers without deleting or rebinding them; explicit copy preserves original',async()=>{
 const fixture=sourceDiscoveryFixture(),base={protocolVersion:1,source:{kind:'url',url:sourceFeed}},second=(await fixture.service.ingest(base)).ingestion.selection.episodes[1];
 const project=(await fixture.service.ingest({...base,episode:{feed_url:sourceFeed,episode_id:second.id}})).ingestion.project.document;
 project.key='original-project';project.project_note='Keep the original note';project.opaque={keep:true};fixture.state.upgrade=true;
 await fixture.service.ingest(base); // A publisher change becomes available only after an explicit discovery refresh.
 const incoming=(await fixture.service.ingest({...base,episode:{feed_url:sourceFeed,episode_id:second.id,transcript_url:upgradeTrack}})).ingestion.transcript.document;
 project.notes={[incoming.segments[0].id]:'Retained original note, not about the new cue'};project.translation_glossary={future_record:{meaning:'Retained'}};project.translation_contexts={future_context:{keep:true}};
 const x=await setup(fixture,[project]);try{
  const original=structuredClone(x.docs()[0]);await x.load();await x.open('Authored evolving episode',upgradeTrack);await wait(()=>x.w.document.querySelector('.source-project-choice'));x.button('核对新文字稿 · -project').click();await wait(()=>x.button('确认接入此原声项目'));x.button('确认接入此原声项目').click();await wait(()=>x.w.document.querySelector('.source-error').textContent.includes('旧原文相关记录'));
  assert.deepEqual(x.docs(),[original]);assert.equal(x.w.document.querySelector('.reader-workspace'),null);assert.equal(x.docs()[0].segments.length,0);
  x.button('取消接入').click();x.button('另建独立副本').click();await wait(()=>x.docs().length===2);const old=x.docs().find(doc=>doc.key===project.key),copy=x.docs().find(doc=>doc.key!==project.key);
  assert.deepEqual(old,original);assert.equal(copy.segments[0].id,incoming.segments[0].id);assert.deepEqual(copy.notes,{},'opaque old notes never become annotations of the new cue');
  const reopened=await setup(fixture,x.docs());try{assert.deepEqual(reopened.docs().find(doc=>doc.key===project.key),original);assert.equal(reopened.docs().length,2);}finally{await reopened.w.happyDOM.close();}
 }finally{await x.w.happyDOM.close();}
});

for(const absent of ['source','check timestamp'])test(`optional feed-check display metadata cannot block a parsed transcript when ${absent} is absent`,async()=>{
 const fixture=sourceDiscoveryFixture(),ingest=fixture.service.ingest;
 fixture.service={ingest:async(...args)=>{
  const value=await ingest(...args);
  if(args[0].episode){
   if(absent==='source')delete value.ingestion.source;
   else{delete value.ingestion.source.feed_checked_at;delete value.ingestion.source.feed_reused;}
  }
  return value;
 }};
 const x=await setup(fixture);try{
  await x.load();const checked=x.w.document.querySelector('.feed-refresh p').textContent;
  await x.open('Authored multilingual episode',frenchTrack);
  await wait(()=>x.w.document.querySelector('.reader-workspace'));
  await wait(()=>x.docs().length===1);
  assert.equal(x.docs()[0].segments[0].text,'Bonjour, cette source reste intacte.');
  await x.discover();assert.equal(x.w.document.querySelector('.feed-refresh p').textContent,checked);
  assert.equal(x.w.document.querySelector('.source-error').textContent,'');
 }finally{await x.w.happyDOM.close();}
});


test('explicit audio-first bypasses an advertised broken track, preserves selection and never downgrades existing transcript projects',async()=>{
 const fixture=audioFirstFixture(),x=await setup(fixture);try{
  await x.load();const action=()=>[...x.episode('Authored audio-first episode').querySelectorAll('button')].find(button=>button.textContent==='先听原声');
  assert.equal(x.episode('Authored audio-first episode').querySelector('button').disabled,true);assert.equal(action().disabled,false,'audio-first does not require selecting a track');
  const missing=[...x.episode('Authored episode without audio').querySelectorAll('button')].find(button=>button.textContent==='先听原声');assert.equal(missing.disabled,true);assert.match(x.episode('Authored episode without audio').textContent,/未提供可用的公开原声/);
  action().click();action().click();await wait(()=>x.docs().length===1);const original=x.docs()[0];assert.equal(original.project_kind,'audio_only');assert.equal(original.segments.length,0);assert.deepEqual(fixture.counts,{feed:1,transcript:0,media:0});assert.equal(x.requests.at(-1).intent,'media_only');assert.equal(x.requests.at(-1).episode.transcript_url,undefined);assert.equal(x.w.document.querySelector('audio'),null);
  await x.discover();await x.open('Authored audio-first episode',audioFirstTrack);await wait(()=>x.w.document.querySelector('.source-error').textContent.includes('不是 WebVTT'));assert.equal(action().disabled,false);assert.equal(x.docs().length,1);assert.equal(x.docs()[0].segments.length,0);
  const transcriptCalls=fixture.counts.transcript;action().click();await wait(()=>x.w.document.querySelector('.source-project-choice'));assert.equal(fixture.counts.transcript,transcriptCalls);assert.equal(x.docs().length,1);x.button('继续已有项目 · '+original.key.slice(-8)).click();await wait(()=>x.w.document.querySelector('.reader-workspace'));
  fixture.state.fixed=true;await x.discover();assert.equal(x.episode('Authored audio-first episode').querySelector('select').value,audioFirstTrack);await x.open('Authored audio-first episode');await wait(()=>x.w.document.querySelector('.source-project-choice'));x.button('核对新文字稿 · '+original.key.slice(-8)).click();await wait(()=>x.button('确认接入此原声项目'));x.button('确认接入此原声项目').click();await wait(()=>x.docs()[0].segments.length===1);await wait(()=>x.w.document.querySelector('.reader-workspace'));const upgraded=structuredClone(x.docs()[0]);
  await x.discover();action().click();await wait(()=>x.w.document.querySelector('.source-project-choice'));assert.equal(x.buttons('确认接入此原声项目').length,0);x.button('继续已有项目 · '+original.key.slice(-8)).click();await wait(()=>x.w.document.querySelector('.reader-workspace'));assert.deepEqual(x.docs(),[upgraded]);assert.equal(fixture.counts.media,0);
 }finally{await x.w.happyDOM.close();}
});
for(const boundary of ['cancel','new URL','navigation'])test('audio-first retires a delayed source check on '+boundary,async()=>{
 const fixture=audioFirstFixture(),x=await setup(fixture);let release;try{
  await x.load();fixture.state.now+=60001;fixture.state.holdFeed=new Promise(resolve=>release=resolve);
  const action=()=>[...x.episode('Authored audio-first episode').querySelectorAll('button')].find(button=>button.textContent==='先听原声');action().click();await wait(()=>fixture.counts.feed===2&&x.button('取消读取'));assert.equal(action().disabled,true);
  if(boundary==='cancel')x.button('取消读取').click();
  if(boundary==='new URL')x.input(x.w.document.querySelector('#source-url'),'https://publisher.example.org/new');
  if(boundary==='navigation')x.button('我的内容 0').click();
  release();release=null;fixture.state.holdFeed=null;await new Promise(resolve=>setTimeout(resolve,25));assert.equal(x.docs().length,0);assert.equal(fixture.counts.transcript,0);assert.equal(fixture.counts.media,0);
  if(boundary==='cancel'){x.button('重试上次读取：Authored audio-first episode').click();await wait(()=>x.docs().length===1);assert.equal(x.requests.at(-1).intent,'media_only');}
  if(boundary==='new URL')assert.equal(x.w.document.querySelector('.episode-list'),null);
  if(boundary==='navigation'){await x.discover();assert.match(x.w.document.querySelector('.source-error').textContent,/读取已暂停/);}
 }finally{release?.();await x.w.happyDOM.close();}
});
test('bounded episode browsing preserves import identity and resets search, expansion and source context',async()=>{
 const fixture=sourceDiscoveryFixture();fixture.state.extraEpisodes=205;
 const x=await setup(fixture),{w}=x;
 try{
  await x.load();const rows=()=>w.document.querySelectorAll('.episode-list article'),search=()=>w.document.querySelector('#episode-query');
  assert.equal(rows().length,20);assert.match(w.document.querySelector('.episode-warning').textContent,/来源列表不完整/);assert.match(w.document.querySelector('.episode-warnings').textContent,/发布者提供的文字稿/);
  assert.match(x.episode('Authored multilingual episode').textContent,/时长 1:02:03/);assert.match(x.episode('Authored multilingual episode').textContent,/2026/);
  x.button('显示更多单集').click();await wait(()=>rows().length===40);
  x.input(search(),' ARCHIVE episode 190 ');await wait(()=>rows().length===1);assert.ok(x.episode('Archive episode 190'));assert.equal(x.button('显示更多单集'),undefined);
  x.input(search(),'unfindable');await wait(()=>rows().length===0);assert.match(w.document.body.textContent,/当前列表没有匹配/);
  x.button('清空单集搜索').click();await wait(()=>rows().length===20);
  x.button('显示更多单集').click();await wait(()=>rows().length===40);
  x.input(search(),'Archive');await wait(()=>rows().length===20);x.button('显示更多单集').click();await wait(()=>rows().length===40);
  x.button('刷新节目列表').click();await wait(()=>fixture.counts.feed===2&&rows().length===20);assert.equal(search().value,'Archive');
  x.input(search(),'evolving');await wait(()=>rows().length===1);const audio=x.episode('Authored evolving episode');[...audio.querySelectorAll('button')].find(b=>b.textContent==='先听原声').click();await wait(()=>x.docs().length===1);assert.equal(x.docs()[0].title,'Authored evolving episode');assert.equal(x.requests.at(-1).intent,'media_only');
  await x.discover();assert.equal(search().value,'evolving');assert.equal(rows().length,1);
  x.button('清空单集搜索').click();await wait(()=>rows().length===20);await x.open('Authored multilingual episode',frenchTrack);await wait(()=>x.docs().length===2);assert.equal(x.docs().find(d=>d.title==='Authored multilingual episode').language,'fr');
  await x.discover();x.input(search(),'Archive');await wait(()=>search().value==='Archive');x.input(w.document.querySelector('#source-url'),'https://publisher.example.org/new');await wait(()=>!search());await x.load();assert.equal(search().value,'');assert.equal(rows().length,20);
 }finally{await w.happyDOM.close();}
});
test('episode metadata omits absent and invalid values without fabricating dates or durations',async()=>{
 const output=await build({entryPoints:['frontend/app/episode-browser.ts'],bundle:true,format:'esm',write:false,platform:'node'});
 const {episodeMetadata}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'));
 assert.equal(episodeMetadata({id:'a',title:'Missing'}),'');
 assert.equal(episodeMetadata({id:'a',title:'Invalid',published:'nonsense',duration:NaN}),'');
 assert.equal(episodeMetadata({id:'a',title:'Invalid',duration:-5}),'');
 assert.equal(episodeMetadata({id:'a',title:'Short',duration:65.7}),'时长 1:05');
});
