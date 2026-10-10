/** Production reader/legacy writer, with authored publisher responses only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {installSavePipeline} from './helpers/save-pipeline.mjs';
const root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
const feed='https://publisher.example/feed',media='https://publisher.example/audio.mp3';
const source={feed_url:feed,episode_id:'episode',media_url:media,media_kind:'audio'};
const episode={id:'episode',title:'Authored episode',language:'en',source_url:'https://publisher.example/episode',duration:40,media:[{url:media,kind:'audio'}],transcripts:[{url:'https://publisher.example/text.vtt',type:'text/vtt',supported:true}]};
const discovery={kind:'feed',feed_url:feed,episodes:[episode]};
const transcript={title:'Publisher title',language:'en',source_url:episode.source_url,podcast_source:{...source,transcript_url:episode.transcripts[0].url},segments:[{id:'one',start:0,end:20,text:'Authored words.'}]};
const audio=(key='saved',extra={})=>({key,title:'My edited title',language:'fr',project_kind:'audio_only',podcast_source:{...source},project_note:'Keep my annotation',timestamp_bookmarks:[{id:'mark',time:12,note:'Keep my bookmark'}],segments:[],...extra});
const json=value=>({ok:true,json:async()=>value});
const mediaResponse=(kind='audio')=>({ok:true,blob:async()=>new Blob(['ID3 authored bytes'],{type:'audio/mpeg'}),headers:{get:()=>kind}});
async function setup({documents=[],handler,held=false}={}){
 const w=new Window({url:'http://127.0.0.1:8080/'}),$=id=>w.document.getElementById(id);
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];Object.defineProperty(w,'crypto',{value:webcrypto});
 if(documents.length)w.localStorage.setItem(KEY,JSON.stringify({documents}));
 const calls=[],revoked=[];let urls=0,plays=0;
 w.URL.createObjectURL=()=>`blob:http://127.0.0.1:8080/owned-${++urls}`;w.URL.revokeObjectURL=url=>revoked.push(url);
 w.HTMLMediaElement.prototype.play=function(){plays++;return Promise.resolve();};
 w.fetch=async(url,options)=>{calls.push({url,options});if(url==='api/health')return json({local_worker:false,capabilities:{local_agents:true,podcast_import:true,media_import:false}});return handler?handler(url,options):url.endsWith('/discover')?json(discovery):url.endsWith('/import')?json({status:'ready',document:transcript}):mediaResponse();};
 const pipeline=installSavePipeline(w,{held});
 w.eval(['summary','core','passages','passage-playback','app','language','podcasts','jobs'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+`\nwindow.continuity={active,state,render,queueDocument,selectActiveDocument,attachTranscriptToProject,mediaSelectionRevision,browserMedia,store:libraryStore};`);
 await new Promise(resolve=>setTimeout(resolve,10));
 const h={w,$,calls,revoked,pipeline,get plays(){return plays;},disk:()=>JSON.parse(w.localStorage.getItem(KEY)),api:w.continuity};
 h.discover=async()=>{$('add-content').click();$('podcast-url').value=feed;await $('podcast-form').onsubmit({preventDefault(){}});};
 h.button=text=>[...$('podcast-results').querySelectorAll('button')].find(b=>b.textContent.startsWith(text));
 h.choice=()=>$('podcast-results').querySelector('[aria-label="选择本集的书架项目"]');
 h.choose=key=>{h.choice().value=key==='separate'?key:'project:'+key;h.choice().onchange();};
 return h;
}
function playable(player,time=0){Object.defineProperty(player,'duration',{configurable:true,value:40});Object.defineProperty(player,'readyState',{configurable:true,value:4});player.currentTime=time;player.dispatchEvent(new player.ownerDocument.defaultView.Event('loadedmetadata'));}
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,0));}assert.ok(check(),'asynchronous checkpoint reached');}
async function localFile(h,name='chosen.mp3'){
 h.$('attach-reader-media').click();Object.defineProperty(h.$('reader-media-file'),'files',{configurable:true,value:[{name,type:'audio/mpeg',size:10,slice:()=>({text:async()=> 'ID3 local'})}]});await h.$('reader-media-file').onchange();
}

test('discovery preview → audio notes/bookmark → discovery transcript keeps one project and reader media',async()=>{
 const h=await setup();try{
  await h.discover();await h.button('回听原声').onclick();const preview=h.$('podcast-results').querySelector('audio');playable(preview,8.5);const url=preview.src;
  await h.button('保存原声项目').onclick();const key=h.api.active().key,player=h.$('source-media').querySelector('audio');playable(player);
  assert.equal(player.src,url);assert.equal(player.currentTime,8.5);assert.equal(h.$('podcast-results').querySelector('audio'),null);
  h.$('project-note').value='New project note';h.$('project-note').oninput();h.$('audio-bookmark-time').value='12';h.$('audio-bookmark-note').value='New bookmark';await h.$('audio-bookmark-form').onsubmit({preventDefault(){}});
  player.currentTime=14;player.dispatchEvent(new h.w.Event('seeking'));player.dispatchEvent(new h.w.Event('seeked'));const progress=h.w.localStorage.getItem('coconut-listening-v1:'+key);assert.equal(JSON.parse(progress).time,14);
  const bookmark=h.disk().documents[0].timestamp_bookmarks[0];await h.discover();assert.deepEqual(h.revoked,[]);await h.button('导入发布者文字稿').onclick();
  const saved=h.disk().documents;assert.equal(saved.length,1);assert.equal(saved[0].key,key);assert.equal(saved[0].project_note,'New project note');assert.deepEqual(saved[0].timestamp_bookmarks,[bookmark]);assert.equal(saved[0].segments[0].text,'Authored words.');
  assert.equal(h.$('source-media').querySelector('audio'),player);assert.equal(player.currentTime,14);assert.equal(h.w.localStorage.getItem('coconut-listening-v1:'+key),progress);assert.equal(h.calls.filter(c=>c.url.endsWith('/media')).length,1);assert.equal(h.plays,0);assert.deepEqual(h.revoked,[]);
  h.$('detach-reader-media').click();assert.deepEqual(h.revoked,[url]);assert.ok(!h.w.localStorage.getItem(KEY).includes('blob:'));
 }finally{await h.w.happyDOM.close();}
});

test('discovery target can differ from active document and preserves current edited title/language/notes',async()=>{
 const h=await setup({documents:[audio('project',{project_language_override:true}),{key:'other',title:'Other text',segments:[{id:'x',start:0,end:1,text:'Other'}]}]});try{
  h.api.selectActiveDocument('other');h.api.render();await h.discover();await h.button('导入发布者文字稿').onclick();
  const doc=h.disk().documents.find(d=>d.key==='project');assert.equal(h.disk().documents.length,2);assert.equal(h.api.active().key,'project');assert.equal(doc.title,'My edited title');assert.equal(doc.language,'fr');assert.equal(doc.project_note,'Keep my annotation');assert.equal(doc.timestamp_bookmarks[0].id,'mark');assert.equal(doc.segments.length,1);
 }finally{await h.w.happyDOM.close();}
});

test('same-source backup versions require an explicit target and update only the selected exact identity',async()=>{
 const h=await setup({documents:[audio('first'),audio('second',{project_note:'Second version'})]});try{
  await h.discover();const before=h.w.localStorage.getItem(KEY);assert.equal(h.choice().value,'');await h.button('导入发布者文字稿').onclick();await h.button('保存原声项目').onclick();
  assert.equal(h.w.localStorage.getItem(KEY),before);assert.equal(h.calls.filter(c=>c.url.endsWith('/import')).length,0);assert.match(h.$('podcast-status').textContent,/多个.*选择/);
  h.choose('second');await h.button('导入发布者文字稿').onclick();const saved=h.disk().documents;assert.equal(saved.length,2);assert.equal(saved[0].project_kind,'audio_only');assert.equal(saved[0].project_note,'Keep my annotation');assert.equal(saved[1].segments.length,1);assert.equal(saved[1].project_note,'Second version');assert.equal(h.api.active().key,'second');
 }finally{await h.w.happyDOM.close();}
});

test('explicit separate imports preserve all backup versions even when transcript bytes repeat',async()=>{
 const h=await setup({documents:[audio('first'),audio('second')]});try{
  await h.discover();h.choose('separate');await h.button('导入发布者文字稿').onclick();const third=h.api.active().key;
  await h.discover();h.choose('separate');await h.button('导入发布者文字稿').onclick();const saved=h.disk().documents;assert.equal(saved.length,4);assert.notEqual(h.api.active().key,third);assert.equal(saved[0].project_kind,'audio_only');assert.equal(saved[1].project_kind,'audio_only');
 }finally{await h.w.happyDOM.close();}
});

test('rediscovery reopens existing edited transcript without replacing words or invoking the publisher again',async()=>{
 const h=await setup({documents:[{...transcript,key:'text',segments:[{...transcript.segments[0],text:'My correction'}],notes:{one:'My segment note'},project_note:'My project note',timestamp_bookmarks:[]}]});try{
  await h.discover();await h.button('导入发布者文字稿').onclick();const saved=h.disk().documents;assert.equal(saved.length,1);assert.equal(saved[0].segments[0].text,'My correction');assert.equal(saved[0].notes.one,'My segment note');assert.equal(h.calls.filter(c=>c.url.endsWith('/import')).length,0);
 }finally{await h.w.happyDOM.close();}
});

for(const change of ['cancel','navigate-return','source-edit','remove-undo','source-replaced'])test(`late discovery transcript cannot commit after ${change}`,async()=>{
 let release;const h=await setup({documents:[audio()],handler:url=>url.endsWith('/discover')?json(discovery):new Promise(resolve=>{release=()=>resolve(json({status:'ready',document:transcript}));})});try{
  await h.discover();const pending=h.button('导入发布者文字稿').onclick();await until(()=>release);
  if(change==='cancel')h.$('cancel-podcast').click();
  if(change==='navigate-return'){h.$('back-reading').click();h.$('add-content').click();}
  if(change==='source-edit'){h.api.active().podcast_source={...source,media_url:'https://publisher.example/changed.mp3'};h.api.queueDocument(h.api.active());await h.w.flushContentForTest();}
  if(change==='source-replaced'){h.$('video-url').value='https://publisher.example/other';h.$('video-url').dispatchEvent(new h.w.Event('input'));}
  if(change==='remove-undo'){h.w.document.querySelector('.library-remove').click();await h.$('confirm-removal').onclick();await h.$('undo-removal').onclick();}
  const before=h.w.localStorage.getItem(KEY);release();await pending;assert.equal(h.w.localStorage.getItem(KEY),before);assert.equal(h.api.active().project_kind,'audio_only');
 }finally{release?.();await h.w.happyDOM.close();}
});

for(const change of ['episode','media-url','media-kind'])test(`publisher ${change} mismatch cannot attach words to saved old media`,async()=>{
 const changed={...source,...(change==='episode'?{episode_id:'other'}:change==='media-url'?{media_url:'https://publisher.example/new.mp3'}:{media_kind:'video'})};
 const h=await setup({documents:[audio()],handler:url=>url.endsWith('/discover')?json(discovery):json({status:'ready',document:{...transcript,podcast_source:changed}})});try{
  await h.discover();const before=h.w.localStorage.getItem(KEY);await h.button('导入发布者文字稿').onclick();assert.equal(h.w.localStorage.getItem(KEY),before);assert.equal(h.api.active().project_kind,'audio_only');assert.match(h.$('podcast-status').textContent,/来源不一致|媒体地址或类型已变化/);
 }finally{await h.w.happyDOM.close();}
});

test('selected local media wins over a matching downloaded discovery preview',async()=>{
 const h=await setup({documents:[audio()]});try{
  await localFile(h);const local=h.$('source-media').querySelector('audio').src;await h.discover();await h.button('回听原声').onclick();const preview=h.$('podcast-results').querySelector('audio').src;
  await h.button('导入发布者文字稿').onclick();assert.equal(h.$('source-media').querySelector('audio').src,local);assert.ok(!h.revoked.includes(local));assert.ok(!h.revoked.includes(preview));await h.discover();assert.ok(h.revoked.includes(preview));assert.ok(!h.revoked.includes(local));
 }finally{await h.w.happyDOM.close();}
});

for(const change of ['local-selection','detached-media','new-navigation'])test(`delayed attachment receipt cannot transfer preview after ${change}`,async()=>{
 const h=await setup({documents:[audio()]});try{
  await h.discover();await h.button('回听原声').onclick();const preview=h.$('podcast-results').querySelector('audio').src;
  h.pipeline.hold();const pending=h.button('导入发布者文字稿').onclick();await until(()=>h.pipeline.writes.length===1);
  if(change==='local-selection')await localFile(h);
  if(change==='detached-media'){await localFile(h);h.$('detach-reader-media').click();}
  if(change==='new-navigation')h.$('add-content').click();
  const selected=h.$('source-media').querySelector('audio')?.src;h.pipeline.writes[0].commit();await pending;
  assert.equal(h.$('source-media').querySelector('audio')?.src,selected);assert.notEqual(selected,preview);assert.ok(!h.revoked.includes(preview));assert.equal(h.disk().documents.length,1);
 }finally{h.pipeline.hold(false);await h.w.happyDOM.close();}
});

test('failed discovery attachment retains one complete in-memory project and preview for rescue/retry',async()=>{
 const h=await setup({documents:[audio()]});try{
  await h.discover();await h.button('回听原声').onclick();const preview=h.$('podcast-results').querySelector('audio').src;const before=h.w.localStorage.getItem(KEY);
  h.pipeline.hold();const pending=h.button('导入发布者文字稿').onclick();await until(()=>h.pipeline.writes.length===1);h.pipeline.writes[0].fail();await pending;
  assert.equal(h.w.localStorage.getItem(KEY),before);assert.equal(h.api.state.documents.length,1);assert.equal(h.api.active().key,'saved');assert.equal(h.api.active().segments.length,1);assert.equal(h.api.active().project_note,'Keep my annotation');assert.equal(h.$('source-media').querySelector('audio').src,preview);assert.match(h.$('notice').textContent,/尚未保存/);
  const rescue=h.api.store.snapshotForExport().documents;assert.equal(rescue.length,1);assert.equal(rescue[0].timestamp_bookmarks[0].id,'mark');assert.equal(rescue[0].segments[0].text,'Authored words.');
  h.pipeline.hold(false);await h.$('retry-save').onclick();assert.equal(h.disk().documents.length,1);assert.equal(h.disk().documents[0].key,'saved');
 }finally{h.pipeline.hold(false);await h.w.happyDOM.close();}
});

test('direct media preview is transferred once and cannot be revoked by later discovery cleanup',async()=>{
 const direct={kind:'media',title:'Direct audio',media:{url:media,kind:'audio'}};
 const h=await setup({handler:url=>url.endsWith('/discover')?json(direct):mediaResponse()});try{
  await h.discover();await h.button('回听原声').onclick();const url=h.$('podcast-results').querySelector('audio').src;await h.button('保存原声项目').onclick();assert.equal(h.$('source-media').querySelector('audio').src,url);assert.equal(h.disk().documents[0].podcast_source.kind,'direct_media');
  await h.discover();await h.button('回听原声').onclick();const next=h.$('podcast-results').querySelector('audio').src;await h.discover();assert.ok(h.revoked.includes(next));assert.ok(!h.revoked.includes(url));assert.equal(h.plays,0);
 }finally{await h.w.happyDOM.close();}
});

test('changed preview response kind is rejected before creating any object URL',async()=>{
 const h=await setup({handler:url=>url.endsWith('/discover')?json(discovery):mediaResponse('video')});try{
  await h.discover();await h.button('回听原声').onclick();assert.equal(h.$('podcast-results').querySelector('audio,video'),null);assert.match(h.$('podcast-status').textContent,/类型.*不一致/);assert.equal(h.w.localStorage.getItem(KEY),null);
 }finally{await h.w.happyDOM.close();}
});

test('media identity distinguishes enclosure/type and feed episode while keeping transcript URL independent',async()=>{
 const h=await setup();try{
  const identity=h.w.Coconut.podcastMediaIdentity(audio());assert.ok(identity);
  assert.equal(identity,h.w.Coconut.podcastMediaIdentity(transcript));
  for(const change of [{media_url:media+'?version=2'},{media_kind:'video'},{episode_id:'other'},{feed_url:feed+'/other'}])assert.notEqual(identity,h.w.Coconut.podcastMediaIdentity({podcast_source:{...source,...change}}));
 }finally{await h.w.happyDOM.close();}
});

test('a preview of another episode never transfers to the saved episode',async()=>{
 const other={...episode,id:'other',title:'Other episode',media:[{url:'https://publisher.example/other.mp3',kind:'audio'}]};
 const h=await setup({handler:url=>url.endsWith('/discover')?json({...discovery,episodes:[episode,other]}):mediaResponse()});try{
  await h.discover();const rows=h.$('podcast-results').querySelectorAll('.podcast-episode');
  await [...rows[1].querySelectorAll('button')].find(b=>b.textContent.startsWith('回听')).onclick();const preview=rows[1].querySelector('audio').src;
  await [...rows[0].querySelectorAll('button')].find(b=>b.textContent==='保存原声项目').onclick();assert.equal(h.api.active().podcast_source.episode_id,'episode');assert.equal(h.$('source-media').querySelector('audio'),null);assert.ok(!h.revoked.includes(preview));
 }finally{await h.w.happyDOM.close();}
});

test('explicit source refresh invalidates old publisher media and adopts only the new matching preview',async()=>{
 const newer={...episode,media:[{url:'https://publisher.example/new.mp3',kind:'audio'}]};
 const h=await setup({documents:[audio()],handler:url=>url.endsWith('/discover')?json({...discovery,episodes:[newer]}):mediaResponse()});try{
  await h.$('download-podcast-media').onclick();const old=h.$('source-media').querySelector('audio').src;
  await h.discover();await h.button('回听原声').onclick();const preview=h.$('podcast-results').querySelector('audio').src;await h.button('保存原声项目').onclick();
  assert.equal(h.api.active().key,'saved');assert.equal(h.api.active().podcast_source.media_url,newer.media[0].url);assert.equal(h.$('source-media').querySelector('audio').src,preview);assert.deepEqual(h.revoked,[old]);assert.equal(h.api.active().project_note,'Keep my annotation');
 }finally{await h.w.happyDOM.close();}
});

test('newer annotation edits during attachment persistence stay dirty until their own receipt',async()=>{
 const h=await setup({documents:[audio()]});try{
  await h.discover();h.pipeline.hold();const pending=h.button('导入发布者文字稿').onclick();await until(()=>h.pipeline.writes.length===1);
  h.$('project-note').value='Edited after transcript write started';h.$('project-note').oninput();h.pipeline.writes[0].commit();await pending;
  assert.equal(h.api.active().project_note,'Edited after transcript write started');assert.equal(h.disk().documents[0].project_note,'Keep my annotation');assert.equal(h.$('save-status').dataset.state,'pending');
  const flushed=h.w.flushContentForTest();await until(()=>h.pipeline.writes.length===2);h.pipeline.writes[1].commit();await flushed;assert.equal(h.disk().documents[0].project_note,'Edited after transcript write started');assert.equal(h.disk().documents[0].segments.length,1);
 }finally{h.pipeline.hold(false);await h.w.happyDOM.close();}
});

test('late receipt after navigating to another document and back cannot transfer a preview',async()=>{
 const h=await setup({documents:[audio(),{key:'other',title:'Other',segments:[{id:'x',start:0,end:1,text:'Other words'}]}]});try{
  await h.discover();await h.button('回听原声').onclick();h.pipeline.hold();const pending=h.button('导入发布者文字稿').onclick();await until(()=>h.pipeline.writes.length===1);
  h.api.selectActiveDocument('other');h.api.render();h.api.selectActiveDocument('saved');h.api.render();h.pipeline.writes[0].commit();await pending;
  assert.equal(h.$('source-media').querySelector('audio'),null);assert.equal(h.$('podcast-results').querySelectorAll('audio').length,1);
 }finally{h.pipeline.hold(false);await h.w.happyDOM.close();}
});

test('discovery choice refresh indexes the library once instead of rescanning for every episode row',async()=>{
 const episodes=Array.from({length:200},(_,i)=>({...episode,id:'episode-'+i}));
 const documents=episodes.slice(0,100).map((item,i)=>audio('project-'+i,{podcast_source:{...source,episode_id:item.id}}));
 const h=await setup({documents,handler:()=>json({...discovery,episodes})});try{
  await h.discover();const original=h.w.Coconut.audioProjectIdentity;let checks=0;h.w.Coconut.audioProjectIdentity=doc=>{checks++;return original(doc);};
  h.w.dispatchEvent(new h.w.Event('coconut-render'));assert.equal(checks,documents.length);assert.equal(h.$('podcast-results').querySelectorAll('[aria-label="选择本集的书架项目"]').length,200);
 }finally{await h.w.happyDOM.close();}
});

for(const edit of ['none','title-only','explicit-language','cleared-override'])test(`publisher transcript language wins over inferred audio language unless overridden: ${edit}`,async()=>{
 const chinese={...transcript,language:'zh',segments:[{id:'one',start:0,end:20,text:'这是明确选择的中文文字稿。'}]};
 const handler=url=>url.endsWith('/discover')?json(discovery):json({status:'ready',document:chinese});
 const h=await setup({documents:[audio('saved',{language:'en'})],handler});let restored;try{
  if(edit!=='none'){
   h.$('document-details').click();
   if(edit==='title-only')h.$('document-title').value='Title changed by user';else h.$('document-language').value='fr';
   await h.$('save-details').onclick({preventDefault(){}});
   assert.equal(h.disk().documents[0].project_language_override,edit==='title-only'?undefined:true);
   if(edit==='cleared-override'){h.$('document-details').click();h.$('document-language').value='';await h.$('save-details').onclick({preventDefault(){}});assert.equal(h.disk().documents[0].project_language_override,true);}
  }
  // Reload through validation, so provenance is persisted rather than guessed
  // from the current language value or from an in-memory UI-only flag.
  restored=await setup({documents:h.disk().documents,handler});await restored.discover();await restored.button('导入发布者文字稿').onclick();
  const doc=restored.disk().documents[0];assert.equal(doc.language,edit==='explicit-language'?'fr':edit==='cleared-override'?'':'zh');assert.equal(doc.project_language_override,['explicit-language','cleared-override'].includes(edit)?true:undefined);assert.equal(doc.segments[0].text,chinese.segments[0].text);assert.equal(doc.project_note,'Keep my annotation');
  const exported=restored.w.Coconut.validate(JSON.parse(JSON.stringify(doc)));assert.equal(exported.language,doc.language);assert.equal(exported.project_language_override,doc.project_language_override);
 }finally{await h.w.happyDOM.close();await restored?.w.happyDOM.close();}
});
