import {installSavePipeline} from './helpers/save-pipeline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url),feed='https://publisher.example/feed.xml',episode='a'.repeat(64),media='https://publisher.example/episode.mp3';
const source={feed_url:feed,episode_id:episode,transcript_url:'https://publisher.example/text.vtt',media_url:media,media_kind:'audio'};
const documentFixture={title:'Publisher episode',language:'en',source_url:'https://publisher.example/episode',podcast_source:source,provenance:{kind:'publisher_transcript',caption_method:'publisher_provided',review_status:'unreviewed'},segments:[{id:'one',start:0,end:2,text:'Publisher words'}]};
const discovery={kind:'feed',title:'Public podcast',feed_url:feed,episodes:[{id:episode,title:'<img src=x> Source episode',source_url:'https://publisher.example/episode',duration:2,media:[{url:media,kind:'audio'}],transcripts:[{url:source.transcript_url,type:'text/vtt',language:'en',supported:true}]}],warnings:[]};
async function setup(handler,stored){
 const w=new Window({url:'http://127.0.0.1:8080/'});w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];Object.defineProperty(w,'crypto',{value:webcrypto});
 if(stored!==undefined)w.localStorage.setItem('coconut-reader-v1',stored);
 const calls=[];w.fetch=async(url,options)=>{calls.push({url,options});return url==='api/health'?{ok:true,json:async()=>({local_worker:false,capabilities:{local_agents:true,podcast_import:true,media_import:false}})}:handler(url,options);};
 installSavePipeline(w);
 w.eval(['summary','core','passages','passage-playback','app','language','podcasts','jobs'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 w.URL.createObjectURL=()=> 'blob:http://127.0.0.1:8080/local-media';w.URL.revokeObjectURL=()=>{};
 await new Promise(resolve=>setTimeout(resolve,20));return {w,calls,$:id=>w.document.getElementById(id)};
}
const response=value=>({ok:true,json:async()=>value});
const audioResponse=()=>({ok:true,blob:async()=>new Blob(['ID3 synthetic media'],{type:'audio/mpeg'}),headers:{get:()=> 'audio'}});
async function discover($){$('podcast-url').value=feed;await $('podcast-form').onsubmit({preventDefault(){}});}
async function importDocument(w,doc){const input=w.document.getElementById('file'),text=JSON.stringify(doc);Object.defineProperty(input,'files',{configurable:true,value:[{name:'fixture.json',size:text.length,text:async()=>text}]});await input.onchange();}

test('podcast capabilities expose a passive source entry with literal untrusted titles',async()=>{
 const {w,calls,$}=await setup(()=>response(discovery));try{
  assert.equal($('podcast-import').hidden,false);assert.deepEqual(calls.map(c=>c.url),['api/health']);
  await discover($);assert.equal($('podcast-results').querySelector('h3').textContent,'<img src=x> Source episode');assert.equal($('podcast-results').querySelector('img'),null);assert.equal(calls.length,2);
 }finally{await w.happyDOM.close();}
});
test('publisher transcript import retains source metadata and downloads media only on a separate click',async()=>{
 const {w,calls,$}=await setup(url=>url.endsWith('/discover')?response(discovery):url.endsWith('/import')?response({status:'ready',document:documentFixture}):audioResponse());try{
  await discover($);const row=$('podcast-results').querySelector('.podcast-episode');row.querySelector('select').value=source.transcript_url;await row.querySelector('button').onclick();
  const payload=JSON.parse(calls.at(-1).options.body);assert.equal(payload.transcriptUrl,source.transcript_url);assert.equal(payload.episodeId,episode);assert.ok(!calls.some(c=>c.url.endsWith('/media')));
  const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.deepEqual(doc.podcast_source,source);assert.match($('provenance').textContent,/发布者/);assert.equal($('summary-state').textContent,'未生成');
  $('mode-transcript').click();assert.equal($('transcript-layout').hidden,false);
  assert.equal($('episode-media').hidden,true);assert.equal($('toggle-reader-media').hidden,false);assert.equal($('toggle-reader-media').getAttribute('aria-expanded'),'false');
  $('toggle-reader-media').click();assert.equal($('episode-media').hidden,false);assert.equal($('podcast-playback').hidden,false);assert.equal($('download-podcast-media').hidden,false);assert.equal($('download-podcast-media').disabled,false);assert.equal($('toggle-reader-media').getAttribute('aria-expanded'),'true');
  assert.ok(!calls.some(c=>c.url.endsWith('/media')),'expanding source controls must not download media');
  await $('download-podcast-media').onclick();assert.ok(w.document.querySelector('#source-media audio'));assert.ok(!w.localStorage.getItem('coconut-reader-v1').includes('blob:'));assert.equal(calls.filter(c=>c.url.endsWith('/media')).length,1);assert.ok(!calls.some(c=>c.url.includes('/ask')||c.url.includes('language-tools')));
 }finally{await w.happyDOM.close();}
});
test('no transcript saves an honest audio project and media remains a separate action',async()=>{
 const noText={...discovery,episodes:[{...discovery.episodes[0],transcripts:[]}]};
 const {w,calls,$}=await setup(url=>url.endsWith('/discover')?response(noText):url.endsWith('/import')?response({status:'needs_transcription'}):audioResponse());try{
  await discover($);await $('podcast-results').querySelector('.podcast-episode button').onclick();
  assert.match($('podcast-status').textContent,/没有可用.*文字稿/);
  const saved=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];
  assert.equal(saved.project_kind,'audio_only');assert.equal(saved.transcript_status,'unavailable');assert.deepEqual(saved.segments,[]);assert.deepEqual(saved.ai_answers,[]);
  assert.equal($('audio-project').hidden,false);assert.equal($('summary-workspace').hidden,true);assert.equal($('language-panel').hidden,true);assert.equal($('export-subtitles').disabled,true);
  assert.match($('audio-project').textContent,/没有可生成摘要的原文/);assert.ok(!calls.some(c=>c.url.endsWith('/media')));
  await $('download-podcast-media').onclick();assert.ok($('source-media').querySelector('audio'));assert.equal(calls.filter(c=>c.url.endsWith('/media')).length,1);
  assert.ok(!calls.some(c=>/ask|translate|language-tools|jobs/.test(c.url)));
 }finally{await w.happyDOM.close();}
});
test('canceling a source read preserves the shelf and never starts inference',async()=>{
 const {w,calls,$}=await setup((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})));try{
  await importDocument(w,documentFixture);const before=w.localStorage.getItem('coconut-reader-v1');const pending=$('podcast-form').onsubmit({preventDefault(){}});$('cancel-podcast').click();await pending;
  assert.match($('podcast-status').textContent,/已取消/);assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);assert.ok(!calls.some(c=>c.url.includes('/ask')));
 }finally{await w.happyDOM.close();}
});
test('browser source metadata rejects credentials and survives full JSON restoration',async()=>{
 const {w}=await setup(()=>response({}));try{
  const parsed=w.Coconut.validate(documentFixture);assert.deepEqual(JSON.parse(JSON.stringify(parsed.podcast_source)),source);
  assert.equal(w.Coconut.validate({...documentFixture,podcast_source:{...source,feed_url:'https://user:secret@example.com/feed'}}).podcast_source,undefined);
  assert.equal(w.Coconut.podcastURL('javascript:alert(1)'), '');
 }finally{await w.happyDOM.close();}
});

test('late publisher download never replaces a newer local media selection',async()=>{
 let finish;const {w,$}=await setup(()=>new Promise(resolve=>{finish=()=>resolve(audioResponse());}));try{
  await importDocument(w,documentFixture);let count=0;w.URL.createObjectURL=()=> 'blob:http://127.0.0.1:8080/'+(++count);
  const pending=$('download-podcast-media').onclick();$('attach-reader-media').click();
  Object.defineProperty($('reader-media-file'),'files',{configurable:true,value:[{name:'chosen-by-user.mp3',type:'audio/mpeg',size:10,slice:()=>({text:async()=> 'ID3 local'})}]});await $('reader-media-file').onchange();
  const chosen=w.document.querySelector('audio').src;finish();await pending;
  assert.equal(w.document.querySelector('audio').src,chosen);assert.match($('reader-media-status').textContent,/chosen-by-user/);assert.equal(count,1);
 }finally{await w.happyDOM.close();}
});

test('cancel during transcript fingerprinting prevents both persistence and navigation',async()=>{
 const {w,$}=await setup(url=>url.endsWith('/discover')?response(discovery):response({status:'ready',document:documentFixture}));const original=w.crypto.subtle.digest;try{
  await discover($);let finish;w.crypto.subtle.digest=()=>new Promise(resolve=>{finish=()=>resolve(new Uint8Array(32).buffer);});
  const pending=$('podcast-results').querySelector('button').onclick();await new Promise(resolve=>setTimeout(resolve,0));assert.ok(finish);$('cancel-podcast').click();finish();await pending;
  assert.equal(w.localStorage.getItem('coconut-reader-v1'),null);assert.equal($('reader-workspace').hidden,true);assert.match($('podcast-status').textContent,/取消/);
 }finally{w.crypto.subtle.digest=original;await w.happyDOM.close();}
});

test('podcast exports keep an untimed publisher origin without inventing platform seeking',async()=>{
 const {w}=await setup(()=>response({}));try{
  const doc=w.Coconut.validate({...documentFixture,notes:{one:'Keep'},ai_answers:[{purpose:'summary',question:'Summary',answer:'Test output',citations:['one'],input_snapshot:{version:1,segments:[{id:'one',text:'Publisher words'}]}}]});
  for(const report of [w.Coconut.notebookMarkdown(doc),w.Coconut.aiReadingMarkdown(doc),w.Coconut.summaryMarkdown(doc)]){assert.match(report,/https:\/\/publisher\.example\/episode/);assert.match(report,/手动定位/);assert.ok(!report.includes('?t='));assert.ok(!report.includes('未关联可用的原站链接'));}
 }finally{await w.happyDOM.close();}
});


test('partial source lists disclose their limit and hidden source audio pauses on return to reading',async()=>{
 const {w,$}=await setup(()=>response({...discovery,truncated:true}));try{
  await importDocument(w,documentFixture);$('add-content').click();await discover($);
  assert.match($('podcast-results').querySelector('.podcast-truncation').textContent,/200.*不是完整/);
  const preview=w.document.createElement('audio');let pauses=0;preview.pause=()=>{pauses++;};$('podcast-results').append(preview);
  $('back-reading').click();assert.equal(pauses,1);$('add-content').click();assert.equal(pauses,1);
  const player=w.document.createElement('audio');let readerPauses=0;player.pause=()=>{readerPauses++;};$('source-media').append(player);
  $('add-content').click();assert.equal(readerPauses,1);
 }finally{await w.happyDOM.close();}
});

const audioProject={project_kind:'audio_only',transcript_status:'unavailable',title:'Only audio',source_url:'https://publisher.example/episode',podcast_source:source,media_duration:120,segments:[]};
test('audio project notes, bookmarks and source survive refresh, document export and full-library restore',async()=>{
 const first=await setup(()=>audioResponse());let second,third;try{
  const {w,$}=first;await importDocument(w,audioProject);
  $('project-note').value='My unverified project note';$('project-note').dispatchEvent(new w.Event('input'));
  $('audio-bookmark-time').value='1:02.500';$('audio-bookmark-note').value='<script>my note</script>';await $('audio-bookmark-form').onsubmit({preventDefault(){}});
  assert.equal($('audio-bookmarks').querySelector('script'),null);
  const persisted=w.localStorage.getItem('coconut-reader-v1'),doc=JSON.parse(persisted).documents[0];
  assert.equal(doc.timestamp_bookmarks[0].time,62.5);assert.equal(doc.project_note,'My unverified project note');
  assert.deepEqual(doc.segments,[]);assert.deepEqual(doc.ai_answers,[]);assert.ok(!persisted.includes('blob:'));
  const blobs=[];w.URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:export';};
  $('export').click();const exported=await blobs.at(-1).text();assert.equal(JSON.parse(exported).project_note,doc.project_note);
  $('export-library').click();const library=await blobs.at(-1).text();
  second=await setup(()=>audioResponse(),persisted);
  assert.equal(second.$('project-note').value,doc.project_note);assert.equal(second.$('audio-bookmarks').querySelector('textarea').value,doc.timestamp_bookmarks[0].note);
  assert.equal(second.$('source-media').querySelector('audio'),null);assert.deepEqual(second.calls.map(c=>c.url),['api/health']);
  second.$('audio-bookmarks').querySelector('button').click();assert.match(second.$('audio-project-status').textContent,/先单独获取原声/);
  await second.$('download-podcast-media').onclick();assert.deepEqual(JSON.parse(second.calls.at(-1).options.body),{feedUrl:feed,episodeId:episode,mediaUrl:media});
  third=await setup(()=>audioResponse());await importDocument(third.w,JSON.parse(exported));
  assert.equal(third.$('project-note').value,doc.project_note);assert.equal(third.$('audio-bookmarks').querySelector('textarea').value,doc.timestamp_bookmarks[0].note);
  const file=third.$('library-file');Object.defineProperty(file,'files',{configurable:true,value:[{name:'library.json',size:library.length,text:async()=>library}]});await file.onchange();
  assert.equal(JSON.parse(third.w.localStorage.getItem('coconut-reader-v1')).documents.length,1);
  const restored=JSON.parse(third.w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.deepEqual(restored.timestamp_bookmarks,doc.timestamp_bookmarks);
  assert.match(third.w.Coconut.notebookMarkdown(restored),/用户笔记和时间书签/);
 }finally{await first.w.happyDOM.close();await second?.w.happyDOM.close();await third?.w.happyDOM.close();}
});
test('direct media source saves without a download and can be retrieved explicitly after refresh',async()=>{
 const direct={kind:'media',title:'Direct media',media:{url:media,kind:'audio'}};
 const first=await setup(url=>url.endsWith('/discover')?response(direct):audioResponse());let restored;try{
  const {w,$,calls}=first;await discover($);await [...$('podcast-results').querySelectorAll('button')].find(b=>b.textContent==='保存原声项目').onclick();
  assert.deepEqual(calls.map(c=>c.url),['api/health','api/podcasts/discover']);
  const before=w.localStorage.getItem('coconut-reader-v1'),doc=JSON.parse(before).documents[0];assert.deepEqual(doc.podcast_source,{kind:'direct_media',media_url:media,media_kind:'audio'});
  restored=await setup(()=>audioResponse(),before);await restored.$('download-podcast-media').onclick();assert.deepEqual(JSON.parse(restored.calls.at(-1).options.body),{url:media});
  assert.equal(restored.$('audio-project').hidden,false);assert.equal(restored.$('summary-workspace').hidden,true);
 }finally{await first.w.happyDOM.close();await restored?.w.happyDOM.close();}
});
test('repeated source saves reopen notes without overwriting or duplicating the existing project',async()=>{
 const {w,$}=await setup(()=>response(discovery));try{
  await discover($);const keep=()=>[...$('podcast-results').querySelectorAll('button')].find(b=>b.textContent==='保存原声项目');await keep().onclick();
  $('project-note').value='Keep this note';$('project-note').dispatchEvent(new w.Event('input'));$('add-content').click();await keep().onclick();
  const shelf=JSON.parse(w.localStorage.getItem('coconut-reader-v1'));assert.equal(shelf.documents.length,1);assert.equal($('project-note').value,'Keep this note');
 }finally{await w.happyDOM.close();}
});
test('audio project saves can be cancelled during fingerprinting and never steal newer navigation',async()=>{
 const {w,$}=await setup(()=>response(discovery));const original=w.crypto.subtle.digest;try{
  await discover($);let finish;w.crypto.subtle.digest=()=>new Promise(resolve=>{finish=()=>resolve(new Uint8Array(32).buffer);});
  const pending=[...$('podcast-results').querySelectorAll('button')].find(b=>b.textContent==='保存原声项目').onclick();
  $('cancel-podcast').click();finish();await pending;assert.equal(w.localStorage.getItem('coconut-reader-v1'),null);assert.equal($('reader-workspace').hidden,true);
 }finally{w.crypto.subtle.digest=original;await w.happyDOM.close();}
});
test('timestamp bookmarks validate input and can be edited or removed without losing project notes',async()=>{
 const {w,$}=await setup(()=>response({}));try{
  await importDocument(w,audioProject);$('project-note').value='Keep';$('project-note').dispatchEvent(new w.Event('input'));
  $('audio-bookmark-time').value='NaN';await $('audio-bookmark-form').onsubmit({preventDefault(){}});assert.match($('audio-project-status').textContent,/有效/);
  $('audio-bookmark-time').value='12';await $('audio-bookmark-form').onsubmit({preventDefault(){}});
  const note=$('audio-bookmarks').querySelector('textarea');note.value='Revised';note.dispatchEvent(new w.Event('input'));
  assert.equal($('save-status').dataset.state,'pending');assert.equal((await w.flushContentForTest()).ok,true);
  assert.equal(JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0].timestamp_bookmarks[0].note,'Revised');
  $('audio-bookmarks').querySelectorAll('button')[1].click();assert.equal((await w.flushContentForTest()).ok,true);const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(doc.timestamp_bookmarks.length,0);assert.equal(doc.project_note,'Keep');
 }finally{await w.happyDOM.close();}
});
test('importing a changed audio JSON backup preserves both versions instead of silently reusing source identity',async()=>{
 const {w,$}=await setup(()=>response({}));try{
  await importDocument(w,{...audioProject,project_note:'Existing version'});await importDocument(w,{...audioProject,project_note:'Recovered version'});
  const shelf=JSON.parse(w.localStorage.getItem('coconut-reader-v1'));assert.equal(shelf.documents.length,2);assert.equal(shelf.documents[0].project_note,'Existing version');assert.equal($('project-note').value,'Recovered version');
 }finally{await w.happyDOM.close();}
});
test('saving rediscovered source refreshes obsolete enclosure metadata without losing notes or bookmarks',async()=>{
 const refreshed={...discovery,episodes:[{...discovery.episodes[0],source_url:'https://publisher.example/new-episode',duration:240,media:[{url:'https://publisher.example/revised.mp3',kind:'audio'}]}]};
 const {w,$,calls}=await setup(url=>url.endsWith('/discover')?response(refreshed):audioResponse());try{
  await importDocument(w,{...audioProject,project_note:'Keep my project note',timestamp_bookmarks:[{id:'bookmark',time:45,note:'Keep this timestamp'}]});
  const initial=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];
  await $('download-podcast-media').onclick();assert.ok($('source-media').querySelector('audio'));let revoked=[];w.URL.revokeObjectURL=url=>revoked.push(url);
  $('add-content').click();await discover($);await [...$('podcast-results').querySelectorAll('button')].find(b=>b.textContent==='保存原声项目').onclick();
  const shelf=JSON.parse(w.localStorage.getItem('coconut-reader-v1')),saved=shelf.documents[0];
  assert.equal(shelf.documents.length,1);assert.equal(saved.key,initial.key);assert.equal(saved.title,initial.title);assert.equal(saved.project_note,initial.project_note);assert.deepEqual(saved.timestamp_bookmarks,initial.timestamp_bookmarks);
  assert.equal(saved.source_url,refreshed.episodes[0].source_url);assert.equal(saved.podcast_source.media_url,refreshed.episodes[0].media[0].url);assert.equal(saved.media_duration,240);assert.equal(saved.transcript_status,'not_imported');
  assert.equal($('source-media').querySelector('audio'),null);assert.equal(revoked.length,1);
  await $('download-podcast-media').onclick();assert.equal(JSON.parse(calls.at(-1).options.body).mediaUrl,refreshed.episodes[0].media[0].url);assert.ok($('source-media').querySelector('audio'));
 }finally{await w.happyDOM.close();}
});
test('source refresh preserves a deliberately selected local file while invalidating an old pending publisher download',async()=>{
 let finish;const refreshed={...discovery,episodes:[{...discovery.episodes[0],media:[{url:'https://publisher.example/new-video.mp4',kind:'video'}]}]};
 const {w,$}=await setup(url=>url.endsWith('/discover')?response(refreshed):new Promise(resolve=>{finish=()=>resolve(audioResponse());}));try{
  await importDocument(w,audioProject);$('attach-reader-media').click();
  Object.defineProperty($('reader-media-file'),'files',{configurable:true,value:[{name:'my-local-audio.mp3',type:'audio/mpeg',size:10,slice:()=>({text:async()=> 'ID3 local'})}]});await $('reader-media-file').onchange();
  const local=$('source-media').querySelector('audio').src,pending=$('download-podcast-media').onclick();
  $('add-content').click();await discover($);await [...$('podcast-results').querySelectorAll('button')].find(b=>b.textContent==='保存原声项目').onclick();finish();await pending;
  assert.equal($('source-media').querySelector('audio').src,local);assert.match($('reader-media-status').textContent,/my-local-audio/);
  const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(doc.podcast_source.media_kind,'video');assert.equal(doc.media_duration,2);
 }finally{await w.happyDOM.close();}
});
test('audio note edits and added bookmarks reject aggregate overflow before mutation without truncation',async()=>{
 const {w,$}=await setup(()=>response({}));try{
  const bookmarks=Array.from({length:100},(_,index)=>({id:'mark-'+index,time:index,note:'x'.repeat(9999)}));
  await importDocument(w,{...audioProject,project_note:'p'.repeat(100),timestamp_bookmarks:bookmarks});
  const before=w.localStorage.getItem('coconut-reader-v1');
  $('project-note').value='p'.repeat(101);$('project-note').dispatchEvent(new w.Event('input'));
  assert.equal($('project-note').value,'p'.repeat(100));assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);assert.match($('audio-project-status').textContent,/已保留原内容/);
  const note=$('audio-bookmarks').querySelector('textarea');note.value='x'.repeat(10000);note.dispatchEvent(new w.Event('input'));
  assert.equal(note.value,'x'.repeat(9999));assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);
  $('audio-bookmark-time').value='123';$('audio-bookmark-note').value='one more';await $('audio-bookmark-form').onsubmit({preventDefault(){}});
  assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);assert.equal($('audio-bookmark-note').value,'one more');
  $('project-note').value='p'.repeat(99);$('project-note').dispatchEvent(new w.Event('input'));
  note.value='x'.repeat(10000);note.dispatchEvent(new w.Event('input'));
  assert.equal((await w.flushContentForTest()).ok,true);
  const saved=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(saved.project_note.length,99);assert.equal(saved.timestamp_bookmarks[0].note.length,10000);
 }finally{await w.happyDOM.close();}
});
test('single-note limits reject oversized pasted edits and retain previous content without clipping',async()=>{
 const {w,$}=await setup(()=>response({}));try{
  await importDocument(w,{...audioProject,project_note:'Previous project note',timestamp_bookmarks:[{id:'mark',time:1,note:'Previous bookmark'}]});
  const before=w.localStorage.getItem('coconut-reader-v1');
  $('project-note').value='x'.repeat(100001);$('project-note').dispatchEvent(new w.Event('input'));assert.equal($('project-note').value,'Previous project note');
  const note=$('audio-bookmarks').querySelector('textarea');note.value='x'.repeat(10001);note.dispatchEvent(new w.Event('input'));assert.equal(note.value,'Previous bookmark');
  $('audio-bookmark-time').value='2';$('audio-bookmark-note').value='x'.repeat(10001);await $('audio-bookmark-form').onsubmit({preventDefault(){}});
  assert.equal($('audio-bookmark-note').value.length,10001);assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);
 }finally{await w.happyDOM.close();}
});

test('all valid publisher titles up to 500 characters remain saveable as audio projects',async()=>{
 const title='公开节目'.repeat(125),longTitle={...discovery,episodes:[{...discovery.episodes[0],title,transcripts:[]}]};
 const {w,$}=await setup(()=>response(longTitle));try{
  await discover($);await [...$('podcast-results').querySelectorAll('button')].find(b=>b.textContent==='保存原声项目').onclick();
  const saved=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(saved.title,title);assert.equal(saved.project_kind,'audio_only');
  assert.throws(()=>w.Coconut.validate({...saved,title:title+'多'}),/500/);
 }finally{await w.happyDOM.close();}
});

test('audio bookmark time correction validates, reorders and retains its saved note',async()=>{
 const {w,$}=await setup(()=>response({}));try{
  await importDocument(w,{project_kind:'audio_only',title:'Audio',podcast_source:source,segments:[],timestamp_bookmarks:[{id:'first',time:10,note:'keep me'},{id:'second',time:20,note:'next'}]});
  let row=$('audio-bookmarks').querySelector('.audio-bookmark');row.querySelector('.edit-bookmark-time').click();
  let form=row.querySelector('form');form.querySelector('input').value='nonsense';await form.onsubmit({preventDefault(){}});assert.match(form.textContent,/未改变/);
  form.querySelector('input').value='0:30';await form.onsubmit({preventDefault(){}});
  const saved=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.deepEqual(saved.timestamp_bookmarks.map(b=>b.id),['second','first']);assert.equal(saved.timestamp_bookmarks[1].note,'keep me');assert.equal(saved.timestamp_bookmarks[1].time,30);
  assert.equal(w.document.activeElement.closest('.audio-bookmark').dataset.bookmarkId,'first');
  row=[...$('audio-bookmarks').children].at(-1);row.querySelector('.edit-bookmark-time').click();form=row.querySelector('form');form.querySelector('input').value='40';form.querySelector('[type="button"]').click();assert.equal(JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0].timestamp_bookmarks[1].time,30);
 }finally{await w.happyDOM.close();}
});

test('audio bookmark search finds notes or timestamps without losing hidden bookmarks',async()=>{
 const {w,$}=await setup(()=>response({}));try{
  await importDocument(w,{project_kind:'audio_only',title:'Audio',podcast_source:source,segments:[],timestamp_bookmarks:[{id:'a',time:10,note:'Interesting point'},{id:'b',time:20,note:'Other'}]});
  const before=w.localStorage.getItem('coconut-reader-v1'),search=$('audio-bookmark-search');search.value='interesting';search.oninput();assert.equal($('audio-bookmarks').querySelectorAll('.audio-bookmark').length,1);assert.match($('audio-bookmark-results').textContent,/1 \/ 2/);
  search.value='00:20';search.oninput();assert.equal($('audio-bookmarks').querySelector('.audio-bookmark').dataset.bookmarkId,'b');
  search.value='missing';search.oninput();assert.equal($('audio-bookmarks').querySelectorAll('.audio-bookmark').length,0);
  search.value='';search.oninput();assert.equal($('audio-bookmarks').querySelectorAll('.audio-bookmark').length,2);assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);
 }finally{await w.happyDOM.close();}
});

test('editing a filtered timestamp restores focus to bookmark search when the row leaves results',async()=>{
 const {w,$}=await setup(()=>response({}));try{
  await importDocument(w,{project_kind:'audio_only',title:'Audio',podcast_source:source,segments:[],timestamp_bookmarks:[{id:'a',time:10,note:'Keep'}]});
  $('audio-bookmark-search').value='00:10';$('audio-bookmark-search').oninput();
  const row=$('audio-bookmarks').querySelector('.audio-bookmark');row.querySelector('.edit-bookmark-time').click();const form=row.querySelector('form');form.querySelector('input').value='20';await form.onsubmit({preventDefault(){}});
  assert.equal($('audio-bookmarks').querySelectorAll('.audio-bookmark').length,0);assert.equal(w.document.activeElement,$('audio-bookmark-search'));
  assert.equal(JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0].timestamp_bookmarks[0].note,'Keep');
 }finally{await w.happyDOM.close();}
});

const originalAudioProject=()=>({project_kind:'audio_only',title:'Retain my title',language:'en',podcast_source:source,segments:[],project_note:'PRIVATE PROJECT NOTE',timestamp_bookmarks:[{id:'saved-mark',time:1,note:'PRIVATE BOOKMARK'}]});
async function attachFile(w,$,payload){
 $('attach-project-transcript').click();const value=JSON.stringify(payload);
 Object.defineProperty($('project-transcript-file'),'files',{configurable:true,value:[{name:'captions.json',size:value.length,text:async()=>value}]});await $('project-transcript-file').onchange();
}
test('explicit transcript attachment keeps one project, loaded media, notes and restorable annotations',async()=>{
 const {w,$,calls}=await setup(()=>audioResponse());let stored;
 try{
  await importDocument(w,originalAudioProject());await $('download-podcast-media').onclick();const player=$('source-media').querySelector('audio');
  const key=w.sessionStorage.getItem('coconut-reader-active-v1');
  await attachFile(w,$,documentFixture);stored=w.localStorage.getItem('coconut-reader-v1');const shelf=JSON.parse(stored),doc=shelf.documents[0];
  assert.equal(shelf.documents.length,1);assert.equal(w.sessionStorage.getItem('coconut-reader-active-v1'),key);assert.equal(doc.title,'Retain my title');assert.equal(doc.segments[0].text,'Publisher words');assert.equal(doc.project_note,'PRIVATE PROJECT NOTE');assert.equal(doc.timestamp_bookmarks[0].id,'saved-mark');
  assert.equal($('source-media').querySelector('audio'),player);assert.equal($('audio-project').hidden,false);assert.equal($('transcript-layout').hidden,false);assert.equal($('language-panel').hidden,false);assert.equal($('export-notebook').disabled,false);assert.equal($('attach-project-transcript').hidden,true);assert.equal($('summary-state').textContent,'未生成');
  assert.equal(calls.filter(c=>c.url.endsWith('/media')).length,1);assert.equal(calls.filter(c=>/ask|translate/.test(c.url)).length,0);
  $('project-note').value='Updated after attachment';$('project-note').oninput();assert.equal((await w.flushContentForTest()).ok,true);stored=w.localStorage.getItem('coconut-reader-v1');
 }finally{await w.happyDOM.close();}
 const restored=await setup(()=>response({}),stored);try{
  restored.$('mode-transcript').click();assert.equal(restored.$('project-note').value,'Updated after attachment');assert.equal(restored.w.document.querySelector('#audio-bookmarks textarea').value,'PRIVATE BOOKMARK');assert.equal(restored.$('source-media').querySelector('audio'),null);
 }finally{await restored.w.happyDOM.close();}
});
test('invalid or late file attachment never alters an old or different project',async()=>{
 const {w,$}=await setup(()=>response({}));try{
  await importDocument(w,originalAudioProject());const before=w.localStorage.getItem('coconut-reader-v1');await attachFile(w,$,{segments:[]});assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);
  let release;$('attach-project-transcript').click();Object.defineProperty($('project-transcript-file'),'files',{configurable:true,value:[{name:'text.json',size:10,text:()=>new Promise(resolve=>{release=resolve;})}]});const pending=$('project-transcript-file').onchange();
  await importDocument(w,{...documentFixture,title:'Other document'});release(JSON.stringify(documentFixture));await pending;
  const shelf=JSON.parse(w.localStorage.getItem('coconut-reader-v1'));assert.equal(shelf.documents[0].project_kind,'audio_only');assert.equal(shelf.documents[0].project_note,'PRIVATE PROJECT NOTE');assert.equal($('title').textContent,'Other document');assert.match($('notice').textContent,/已导入并保存在本机浏览器/,'obsolete attachment does not replace the current import success');
 }finally{await w.happyDOM.close();}
});
test('publisher attachment checks exact identity and never downgrades an attached project when re-saved',async()=>{
 let mismatch=true;const {w,$}=await setup(url=>url.endsWith('/discover')?response(discovery):response({status:'ready',document:{...documentFixture,podcast_source:{...source,episode_id:mismatch?'wrong':episode}}}));try{
  await importDocument(w,originalAudioProject());const before=w.localStorage.getItem('coconut-reader-v1');await $('fetch-project-transcript').onclick();assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);assert.match($('audio-project-status').textContent,/不一致/);
  mismatch=false;await $('fetch-project-transcript').onclick();assert.equal(JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0].segments.length,1);
  $('add-content').click();await discover($);await [...$('podcast-results').querySelectorAll('button')].find(button=>button.textContent==='保存原声项目').onclick();
  const shelf=JSON.parse(w.localStorage.getItem('coconut-reader-v1'));assert.equal(shelf.documents.length,1);assert.equal(shelf.documents[0].segments.length,1);assert.equal(shelf.documents[0].project_note,'PRIVATE PROJECT NOTE');
 }finally{await w.happyDOM.close();}
});
test('attached project summary sends transcript words without project note or bookmark content',async()=>{
 let request;const {w,$}=await setup((url,options)=>url.endsWith('language-tools')?response({ai:{codex:{ready:true}}}):(request=JSON.parse(options.body),response({answer:'Injected test summary',citations:['one'],provider:'synthetic-fixture'})));try{
  await importDocument(w,originalAudioProject());await attachFile(w,$,documentFixture);await $('check-ai').onclick();$('ai-task').value='summary';$('ai-task').onchange();$('ai-consent').checked=true;await $('ask-ai').onclick();
  assert.equal(request.segments.length,1);assert.equal(request.segments[0].text,'Publisher words');assert.ok(!JSON.stringify(request).includes('PRIVATE'));assert.equal($('summary-state').dataset.state,'current');
 }finally{await w.happyDOM.close();}
});
test('cancelled publisher attachment preserves the original project and its notes',async()=>{
 const {w,$}=await setup((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})));try{
  await importDocument(w,originalAudioProject());const before=w.localStorage.getItem('coconut-reader-v1'),pending=$('fetch-project-transcript').onclick();$('cancel-project-transcript').click();await pending;
  assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);assert.match($('audio-project-status').textContent,/已取消/);assert.equal($('fetch-project-transcript').disabled,false);
 }finally{await w.happyDOM.close();}
});
test('failed storage after attachment preserves an exportable complete project with a clear warning',async()=>{
 const {w,$}=await setup(()=>response({}));try{
  await importDocument(w,originalAudioProject());const before=w.localStorage.getItem('coconut-reader-v1');Object.defineProperty(w,'localStorage',{value:{getItem:()=>before,setItem:()=>{throw Error('quota');}}});
  await attachFile(w,$,documentFixture);assert.match($('notice').textContent,/未能保存/);assert.equal($('transcript-layout').hidden,false);assert.equal($('project-note').value,'PRIVATE PROJECT NOTE');
  let backup;w.URL.createObjectURL=blob=>{backup=blob;return 'blob:backup';};$('export').click();const restored=w.Coconut.parse(await backup.text(),'backup.json');assert.equal(restored.project_note,'PRIVATE PROJECT NOTE');assert.equal(restored.segments.length,1);assert.equal(restored.timestamp_bookmarks[0].id,'saved-mark');
 }finally{await w.happyDOM.close();}
});

test('changed publisher media cannot silently pair a new transcript with the saved old audio',async()=>{
 const {w,$}=await setup(()=>response({status:'ready',document:{...documentFixture,podcast_source:{...source,media_url:'https://publisher.example/replacement.mp3'}}}));try{
  await importDocument(w,originalAudioProject());const before=w.localStorage.getItem('coconut-reader-v1');await $('fetch-project-transcript').onclick();assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);assert.match($('audio-project-status').textContent,/新文字稿配到旧原声/);
 }finally{await w.happyDOM.close();}
});
test('matching publisher attachment retains the newly verified transcript source URL',async()=>{
 const nextURL='https://publisher.example/new-transcript.vtt';const {w,$}=await setup(()=>response({status:'ready',document:{...documentFixture,podcast_source:{...source,transcript_url:nextURL}}}));try{
  await importDocument(w,{...originalAudioProject(),podcast_source:{...source,transcript_url:undefined}});await $('fetch-project-transcript').onclick();const doc=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal(doc.podcast_source.transcript_url,nextURL);assert.equal(doc.podcast_source.media_url,source.media_url);
 }finally{await w.happyDOM.close();}
});

test('episode picker finds the final title in a 200-episode discovery without fetching or importing',async()=>{
 const episodes=Array.from({length:200},(_,index)=>({...discovery.episodes[0],id:String(index).padStart(64,'0'),title:index===199?'FINAL <img src=x> Interview':'Episode '+index}));
 const {w,calls,$}=await setup(()=>response({...discovery,episodes,truncated:true}));try{
  await discover($);const initialCalls=calls.length;
  assert.match($('podcast-episode-count').textContent,/200 \/ 200.*不完整/);
  const search=$('podcast-episode-search');search.value=' final ';search.dispatchEvent(new w.Event('input'));
  const rows=[...$('podcast-results').querySelectorAll('.podcast-episode')];
  assert.equal(rows.filter(row=>!row.hidden).length,1);assert.equal(rows[199].hidden,false);
  assert.equal(rows[199].querySelector('img'),null);assert.match($('podcast-episode-count').textContent,/1 \/ 200/);
  assert.equal(calls.length,initialCalls);assert.equal(w.localStorage.getItem('coconut-reader-v1'),null);
  search.value='absent';search.dispatchEvent(new w.Event('input'));
  assert.equal($('podcast-results').querySelector('.podcast-filter-empty').hidden,false);
  $('podcast-results').querySelector('.podcast-clear').click();
  assert.equal(search.value,'');assert.equal(rows.filter(row=>!row.hidden).length,200);assert.equal(w.document.activeElement,search);
  assert.equal(calls.length,initialCalls);
 }finally{await w.happyDOM.close();}
});

test('episode transcript filter distinguishes supported tracks and preserves selected language and rows',async()=>{
 const episodes=[{...discovery.episodes[0],title:'Supported',transcripts:[...discovery.episodes[0].transcripts,{url:'https://publisher.example/zh.srt',language:'zh',type:'application/x-subrip',supported:true}]},{...discovery.episodes[0],id:'b'.repeat(64),title:'Unsupported',transcripts:[{url:'https://publisher.example/text.html',type:'text/html',supported:false}]},{...discovery.episodes[0],id:'c'.repeat(64),title:'No transcript',transcripts:[]}];
 const {w,calls,$}=await setup(()=>response({...discovery,episodes}));try{
  await discover($);const rows=[...$('podcast-results').querySelectorAll('.podcast-episode')];
  const track=rows[0].querySelector('select');track.value='https://publisher.example/zh.srt';
  assert.match(rows[0].textContent,/2 份可导入/);assert.match(rows[1].textContent,/仅发现不支持/);assert.equal(rows[1].querySelector('button').textContent,'检查本集文字稿');
  const availability=$('podcast-episode-availability');availability.value='supported';availability.dispatchEvent(new w.Event('change'));
  assert.deepEqual(rows.map(row=>row.hidden),[false,true,true]);assert.match($('podcast-episode-count').textContent,/1 \/ 3/);
  $('podcast-episode-search').value='Unsupported';$('podcast-episode-search').dispatchEvent(new w.Event('input'));
  assert.equal($('podcast-results').querySelector('.podcast-filter-empty').hidden,false);
  $('podcast-results').querySelector('.podcast-clear').click();
  assert.equal(rows[0].querySelector('select'),track);assert.equal(track.value,'https://publisher.example/zh.srt');assert.equal(calls.length,2);
  assert.deepEqual(rows.map(row=>row.hidden),[false,false,false]);
  await discover($);assert.equal($('podcast-episode-search').value,'');assert.equal($('podcast-episode-availability').value,'all');
 }finally{await w.happyDOM.close();}
});

test('filtering pauses only a newly hidden preview and does not release its URL or restart playback',async()=>{
 const episodes=[{...discovery.episodes[0],title:'First'},{...discovery.episodes[0],id:'b'.repeat(64),title:'Second'}];
 const {w,calls,$}=await setup(url=>url.endsWith('/discover')?response({...discovery,episodes}):audioResponse());try{
  await discover($);const row=$('podcast-results').querySelector('.podcast-episode');
  await [...row.querySelectorAll('button')].find(button=>button.textContent.startsWith('回听原声')).onclick();
  const player=row.querySelector('audio');let pauses=0,plays=0;player.pause=()=>pauses++;player.play=()=>plays++;
  const revoked=[];w.URL.revokeObjectURL=url=>revoked.push(url);const requestCount=calls.length;
  const search=$('podcast-episode-search');search.value='second';search.dispatchEvent(new w.Event('input'));
  assert.equal(row.hidden,true);assert.equal(pauses,1);search.dispatchEvent(new w.Event('input'));assert.equal(pauses,1);
  $('podcast-results').querySelector('.podcast-clear').click();
  assert.equal(row.hidden,false);assert.equal(row.querySelector('audio'),player);assert.equal(plays,0);assert.deepEqual(revoked,[]);assert.equal(calls.length,requestCount);
 }finally{await w.happyDOM.close();}
});

test('episode filters cannot unlock an in-flight import and single-episode results stay direct',async()=>{
 let finish;const episodes=[{...discovery.episodes[0],title:'First'},{...discovery.episodes[0],id:'b'.repeat(64),title:'Second'}];
 const {w,$}=await setup(url=>url.endsWith('/discover')?response({...discovery,episodes}):new Promise(resolve=>{finish=()=>resolve(response({status:'ready',document:documentFixture}));}));try{
  await discover($);const pending=$('podcast-results').querySelector('.podcast-episode button').onclick();
  const search=$('podcast-episode-search');search.value='second';search.dispatchEvent(new w.Event('input'));
  assert.ok([...$('podcast-results').querySelectorAll('button')].every(button=>button.disabled));assert.equal($('process-url').disabled,true);
  $('podcast-results').querySelector('.podcast-clear').click();assert.equal($('process-url').disabled,true);finish();await pending;
  assert.equal($('reader-workspace').hidden,false);
 }finally{await w.happyDOM.close();}
 const single=await setup(()=>response(discovery));try{await discover(single.$);assert.equal(single.$('podcast-episode-search'),null);assert.ok(single.$('podcast-results').querySelector('.podcast-episode button'));}finally{await single.w.happyDOM.close();}
});
test('removed and undone audio project rejects its earlier publisher transcript request',async()=>{
 let release;const {w,$}=await setup(()=>new Promise(resolve=>{release=()=>resolve(response({status:'ready',document:documentFixture}));}));try{
  await importDocument(w,originalAudioProject());const before=w.localStorage.getItem('coconut-reader-v1');const pending=$('fetch-project-transcript').onclick();
  w.document.querySelector('.library-remove').click();await $('confirm-removal').onclick();await $('undo-removal').onclick();release();await pending;
  assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);assert.match($('audio-project-status').textContent,/取消|原声|书签|项目/);
 }finally{release?.();await w.happyDOM.close();}
});
