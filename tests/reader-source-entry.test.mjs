import {installSavePipeline} from './helpers/save-pipeline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url),feed='https://publisher.example.org/feed.xml';
const discovery={kind:'feed',title:'Old source results',feed_url:feed,episodes:[{id:'a'.repeat(64),title:'Old episode',source_url:'https://publisher.example.org/episode',media:[],transcripts:[{url:'https://publisher.example.org/captions.vtt',type:'text/vtt',language:'en',supported:true}]}]};
const documentFixture={title:'Old source document',language:'en',podcast_source:{feed_url:feed,episode_id:'a'.repeat(64)},segments:[{id:'a',start:0,end:2,text:'Original authored source'}]};
const response=value=>({ok:true,json:async()=>value});
async function setup(health,handler=()=>{throw new Error('Unexpected request');}){
 const w=new Window({url:'http://127.0.0.1:8080/'});w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];Object.defineProperty(w,'crypto',{value:webcrypto});
 const calls=[];w.fetch=async(url,options)=>{calls.push([url,options]);return url==='api/health'?response(typeof health==='function'?health():health):url==='api/jobs'?response({jobs:[]}):handler(url,options);};
 const pipeline=installSavePipeline(w);
 w.eval(['summary','core','passages','passage-playback','app','language','podcasts','jobs'].map(n=>fs.readFileSync(new URL('reader/'+n+'.js',root),'utf8')).join('\n'));await new Promise(r=>setTimeout(r,20));
 return {w,calls,pipeline,$:id=>w.document.getElementById(id),label:()=>w.document.querySelector('label[for="video-url"]').textContent};
}
const light=capabilities=>({local_worker:false,capabilities:{local_agents:true,...capabilities}});
async function submit($,url=feed){$('video-url').value=url;return $('url-form').onsubmit({preventDefault(){}});}

test('static and capability-specific entry text never advertises unavailable source fetches',async()=>{
 for(const [health,expected,placeholder] of [[{},'公开链接 · 需桌面应用或本地服务',/当前页面不会获取/],[light({}),'当前服务未启用来源获取',/JSON/],[light({podcast_import:true}),'公开播客链接',/RSS/],[light({caption_import:true}),'公开 X 单视频链接',/x.com/],[light({podcast_import:true,caption_import:true}),'公开播客或 X 单视频链接',/X 单视频/],[{local_worker:true},'公开单视频链接',/YouTube/]]){
  const {w,$,calls,label}=await setup(health);try{
   assert.ok(label().includes(expected));assert.match($('video-url').placeholder,placeholder);assert.equal($('url-form').hidden,false);
   if(!health.local_worker)assert.doesNotMatch($('video-url').placeholder,/YouTube|哔哩/);
   if(health.capabilities?.caption_import)assert.match($('worker-help').textContent,/公开 X.*原语言字幕/);else assert.doesNotMatch($('worker-help').textContent,/公开 X/);
   if(health.local_worker){assert.equal($('worker-status').textContent,'本地处理服务已连接');assert.match($('worker-help').textContent,/只有取消.*仅使用现成字幕/);}
   assert.ok(calls.every(([url])=>url==='api/health'||url==='api/jobs'));
  }finally{await w.happyDOM.close();}
 }
});

// Add is a navigation action, not a file-picker or source-fetch command.
for(const [name,health,target] of [
 ['static',{},'import'],
 ['local without source fetching',light({}),'import'],
 ['podcast',light({podcast_import:true}),'video-url'],
 ['captions',light({caption_import:true}),'video-url'],
 ['advanced worker',{local_worker:true},'video-url'],
])test(`Add focuses a working entry for ${name}, including the demo exit`,async()=>{
 const {w,$,calls}=await setup(health);try{
  let chooser=0;for(const id of ['file','local-media-file','media-file'])$(id).click=()=>chooser++;
  $('video-url').value='https://publisher.example.org/keep-this-draft';
  for(const fromDemo of [false,true]){
   if(fromDemo)await $('sample').onclick();
   $(fromDemo?'demo-finish':'add-content').click();
   assert.equal(w.document.body.dataset.workspace,'add');
   assert.equal(w.document.activeElement.id,target);
   assert.equal($('video-url').value,'https://publisher.example.org/keep-this-draft');
   assert.equal($('local-setup').open,false);
   assert.equal(chooser,0,'navigation must not open a chooser');
  }
  assert.ok(calls.every(([url])=>url==='api/health'||url==='api/jobs'));
 }finally{await w.happyDOM.close();}
});

test('Add uses current source capabilities after refresh, disconnection and reconnection without moving focus during probes',async()=>{
 let health=light({podcast_import:true});const {w,$}=await setup(()=>{if(health===null)throw new Error('Temporary disconnect');return health;});
 try{
  $('video-url').value='https://publisher.example.org/keep-this-draft';
  for(const [next,target] of [[light({}),'import'],[light({caption_import:true}),'video-url'],[null,'import'],[light({podcast_import:true}),'video-url']]){
   $('video-url').focus();health=next;await $('retry-worker').onclick();
   assert.equal(w.document.activeElement.id,'video-url','a capability probe must not steal focus');
   assert.equal($('add-workspace').dataset.sourceAvailable,String(target==='video-url'));
   $('add-content').click();assert.equal(w.document.activeElement.id,target);
   assert.equal($('video-url').value,'https://publisher.example.org/keep-this-draft');
   assert.equal($('local-setup').open,false);
   if(next===null)assert.match($('worker-status').textContent,/连接暂时中断/);
  }
 }finally{await w.happyDOM.close();}
});

for(const id of ['import','open-local-media','paste-subtitles'])test(`source capability reordering keeps the existing ${id} focus`,async()=>{
 let health={};const {w,$}=await setup(()=>health);try{
  $(id).focus();let restores=[];const focus=$(id).focus.bind($(id));$(id).focus=options=>{restores.push(options);focus(options);};
  for(const next of [light({podcast_import:true}),light({}),light({caption_import:true}),{}]){
   health=next;await $('retry-worker').onclick();
   assert.equal(w.document.activeElement.id,id);
   assert.equal($('import').closest('.file-entry').nextElementSibling===$('url-form'),!health.capabilities?.podcast_import&&!health.capabilities?.caption_import);
  }
  assert.ok(restores.length>0);assert.ok(restores.every(options=>options?.preventScroll===true));
 }finally{await w.happyDOM.close();}
});

for(const health of [{},light({podcast_import:true})])test(`first health response preserves an Add focus made before capabilities resolved: ${!!health.capabilities}`,async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);const {w,$}=await setup(()=>pending);try{
  assert.equal($('add-workspace').dataset.sourceAvailable,undefined);
  $('add-content').click();assert.equal(w.document.activeElement.id,'import');
  release(health);
  for(let i=0;i<100&&$('add-workspace').dataset.sourceAvailable===undefined;i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal($('add-workspace').dataset.sourceAvailable,String(!!health.capabilities));
  assert.equal(w.document.activeElement.id,'import');
 }finally{release(health);await w.happyDOM.close();}
});

test('a changed service capability updates entry controls without waiting for a failed connection',async()=>{
 let health=light({podcast_import:true});const {w,$,label}=await setup(()=>health);try{
  assert.equal($('podcast-import').hidden,false);health=light({caption_import:true});await $('retry-worker').onclick();
  assert.equal($('podcast-import').hidden,true);assert.equal($('caption-language-control').hidden,false);assert.equal(label(),'公开 X 单视频链接');assert.match($('worker-help').textContent,/公开 X/);
  health=light({podcast_import:true});await $('retry-worker').onclick();assert.equal($('podcast-import').hidden,false);assert.equal($('caption-language-control').hidden,true);assert.doesNotMatch($('worker-help').textContent,/公开 X/);
 }finally{await w.happyDOM.close();}
});

test('editing a podcast URL retires pending discovery and ignores its late result',async()=>{
 let release,signal;const {w,$}=await setup(light({podcast_import:true}),(_url,options)=>new Promise(resolve=>{signal=options.signal;release=()=>resolve(response(discovery));}));try{
  const pending=submit($);await new Promise(r=>setTimeout(r,0));$('video-url').value='https://new.example.org/feed';$('video-url').dispatchEvent(new w.Event('input'));assert.equal(signal.aborted,true);release();await pending;
  assert.equal($('podcast-results').textContent,'');assert.equal($('cancel-podcast').hidden,true);assert.equal(w.localStorage.getItem('coconut-reader-v1'),null);
 }finally{await w.happyDOM.close();}
});

test('an invalid new submission also retires old podcast output before validation',async()=>{
 let release,signal;const {w,$}=await setup(light({podcast_import:true}),(_url,options)=>new Promise(resolve=>{signal=options.signal;release=()=>resolve(response(discovery));}));try{
  const pending=submit($);await new Promise(r=>setTimeout(r,0));await submit($,'not a URL');assert.equal(signal.aborted,true);release();await pending;
  assert.equal($('podcast-results').textContent,'');assert.match($('source-route-status').textContent,/不含登录凭据/);
 }finally{await w.happyDOM.close();}
});

test('repeated submit and passive health refresh do not restart discovery or unlock its button',async()=>{
 let release,calls=0;const {w,$}=await setup(light({podcast_import:true}),()=>new Promise(resolve=>{calls++;release=()=>resolve(response(discovery));}));try{
  const pending=submit($);await new Promise(r=>setTimeout(r,0));await submit($);assert.equal(calls,1);await $('retry-worker').onclick();assert.equal($('process-url').disabled,true);release();await pending;assert.equal($('process-url').disabled,false);assert.match($('podcast-results').textContent,/Old episode/);
 }finally{await w.happyDOM.close();}
});

test('editing the source while an imported transcript is being fingerprinted cannot save or navigate',async()=>{
 let release;const {w,$}=await setup(light({podcast_import:true}),url=>response(url.endsWith('/discover')?discovery:{status:'ready',document:documentFixture}));
 const original=w.crypto.subtle.digest;try{
  await submit($);w.crypto.subtle.digest=()=>new Promise(resolve=>{release=()=>resolve(new Uint8Array(32).buffer);});
  const pending=$('podcast-results').querySelector('button').onclick();await new Promise(r=>setTimeout(r,0));assert.ok(release);
  $('video-url').value='https://new.example.org/feed';$('video-url').dispatchEvent(new w.Event('input'));release();await pending;
  assert.equal(w.localStorage.getItem('coconut-reader-v1'),null);assert.equal($('reader-workspace').hidden,true);assert.equal($('podcast-results').textContent,'');
 }finally{w.crypto.subtle.digest=original;await w.happyDOM.close();}
});

test('editing a source clears its existing preview and revokes only that object URL',async()=>{
 const withMedia={...discovery,episodes:[{...discovery.episodes[0],media:[{url:'https://publisher.example.org/episode.mp3',kind:'audio'}]}]};
 const {w,$}=await setup(light({podcast_import:true}),url=>url.endsWith('/discover')?response(withMedia):{ok:true,blob:async()=>new Blob(['ID3 fixture'],{type:'audio/mpeg'}),headers:{get:()=> 'audio'}});try{
  await submit($);let pauses=0;const revoked=[];w.URL.createObjectURL=()=> 'blob:source-preview';w.URL.revokeObjectURL=url=>revoked.push(url);
  await [...$('podcast-results').querySelectorAll('button')].find(button=>button.textContent.startsWith('回听原声')).onclick();const player=$('podcast-results').querySelector('audio');assert.ok(player);player.pause=()=>pauses++;
  $('video-url').value='https://new.example.org/feed';$('video-url').dispatchEvent(new w.Event('input'));
  assert.equal(pauses,1);assert.deepEqual(revoked,['blob:source-preview']);assert.equal($('podcast-results').textContent,'');
 }finally{await w.happyDOM.close();}
});


test('without source fetching the primary import is available and connection help needs no URL',async()=>{
 let health={};const {w,$,calls}=await setup(()=>health);try{
  const entry=$('import').closest('.file-entry');
  assert.equal(entry.nextElementSibling,$('url-form'));
  assert.equal($('import').classList.contains('primary'),true);
  assert.match($('import').textContent,/开始阅读/);
  assert.equal($('process-url').textContent,'查看连接方式');assert.equal($('process-url').type,'button');
  $('process-url').click();assert.equal($('local-setup').open,true);
  assert.equal($('video-url').value,'');assert.ok(calls.every(([url])=>url==='api/health'));
  health=light({podcast_import:true});await $('retry-worker').onclick();
  assert.equal($('process-url').type,'submit');assert.equal($('process-url').textContent,'添加到阅读空间');
  assert.equal($('import').classList.contains('primary'),false);assert.equal(entry.parentElement.lastElementChild,entry);
 }finally{await w.happyDOM.close();}
});

async function feedbackUntil(check){for(let i=0;i<1000;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,1));}assert.fail('Import feedback checkpoint');}
for(const failed of [false,true])test('X captions publish the actual final save receipt, failed='+failed,async()=>{
 const {w,$,pipeline}=await setup(light({caption_import:true}),()=>response({status:'ready',document:documentFixture}));
 try{
  pipeline.hold();const pending=submit($,'https://x.com/author/status/123');await feedbackUntil(()=>pipeline.writes.length===1);
  assert.match($('source-route-status').textContent,/正在确认/);assert.doesNotMatch($('notice').textContent,/字幕已保存/);
  if(failed)pipeline.writes[0].fail();else pipeline.writes[0].commit();await pending;
  assert.match($('notice').textContent,failed?/尚未保存/:/字幕已保存/);
  $('add-content').click();assert.match($('source-route-status').textContent,failed?/尚未保存/:/字幕已保存/);
  assert.doesNotMatch($('source-route-status').textContent,/正在/);assert.equal($('cancel-source').hidden,true);assert.equal($('process-url').disabled,false);
 }finally{pipeline.hold(false);await w.happyDOM.close();}
});
for(const change of ['cancel','navigation','url','language'])test('X late receipt cannot announce completion after '+change,async()=>{
 const {w,$,pipeline}=await setup(light({caption_import:true}),()=>response({status:'ready',document:documentFixture}));
 try{
  pipeline.hold();const pending=submit($,'https://x.com/author/status/123');await feedbackUntil(()=>pipeline.writes.length===1);
  if(change==='cancel')$('cancel-source').click();
  if(change==='navigation'){$('add-content').click();$('back-reading').click();}
  if(change==='url'){$('video-url').value='https://x.com/author/status/456';$('video-url').dispatchEvent(new w.Event('input'));}
  if(change==='language'){$('caption-language').value='en';$('caption-language').dispatchEvent(new w.Event('change'));}
  const status=$('source-route-status').textContent;assert.doesNotMatch(status,/正在/);
  pipeline.writes[0].commit();await pending;assert.equal($('source-route-status').textContent,status);assert.doesNotMatch($('notice').textContent,/字幕已保存/);
 }finally{pipeline.hold(false);await w.happyDOM.close();}
});
test('cancelled X response cannot replace a newer source request status',async()=>{
 const replies=[];const {w,$}=await setup(light({caption_import:true}),()=>new Promise(resolve=>replies.push(resolve)));
 try{
  const old=submit($,'https://x.com/author/status/123');await feedbackUntil(()=>replies.length===1);$('cancel-source').click();assert.match($('source-route-status').textContent,/已取消/);
  const fresh=submit($,'https://x.com/author/status/456');await feedbackUntil(()=>replies.length===2);const status=$('source-route-status').textContent;
  replies[0](response({status:'ready',document:documentFixture}));await old;assert.equal($('source-route-status').textContent,status);assert.equal($('process-url').disabled,true);
  replies[1](response({status:'unavailable',message:'New source has no captions'}));await fresh;assert.equal($('source-route-status').textContent,'New source has no captions');
 }finally{await w.happyDOM.close();}
});
test('removing the reading target in Add ends a late X request without importing',async()=>{
 let release,calls=0;const {w,$}=await setup(light({caption_import:true}),()=>++calls===1?response({status:'ready',document:documentFixture}):new Promise(resolve=>release=resolve));
 try{
  await submit($,'https://x.com/author/status/123');$('add-content').click();
  const pending=submit($,'https://x.com/author/status/456');await feedbackUntil(()=>release);
  w.document.querySelector('.library-remove').click();await $('confirm-removal').onclick();
  release(response({status:'ready',document:documentFixture}));await pending;
  assert.doesNotMatch($('source-route-status').textContent,/正在/);assert.equal(JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents.length,0);
 }finally{await w.happyDOM.close();}
});

import {createCaptionService} from '../desktop/caption-service.mjs';
import {captionFixtureURL,captionFixtureResult} from './helpers/caption-diagnostics-fixtures.mjs';
const fixtureCaptionService=fixture=>createCaptionService({enabledProviders:['x'],helper:{extractCaptions:async()=>fixture}});
for(const failed of [false,true])test('partial X import exposes source diagnostics and the actual save receipt, failed='+failed,async()=>{
 const captions=fixtureCaptionService(captionFixtureResult());
 const {w,$,pipeline}=await setup(light({caption_import:true}),async()=>response(await captions.importCaption({url:captionFixtureURL})));
 try{
  pipeline.hold();const pending=submit($,captionFixtureURL);await feedbackUntil(()=>pipeline.writes.length===1);
  assert.match($('source-route-status').textContent,/部分字幕未导入.*跳过 2/);assert.doesNotMatch($('source-route-status').textContent,/字幕已保存/);
  if(failed)pipeline.writes[0].fail();else pipeline.writes[0].commit();await pending;
  assert.match($('notice').textContent,failed?/尚未保存/:/字幕已保存/);assert.match($('notice').textContent,/部分字幕未导入.*跳过 2/);
  $('add-content').click();assert.match($('source-route-status').textContent,/部分字幕未导入.*跳过 2/);
  const row=$('transcript-import-list').firstElementChild;assert.equal(row.dataset.parseState,'partial');assert.equal(row.dataset.status,failed?'unsaved':'saved');
  assert.match(row.textContent,/Authored partial caption fixture/);
  const details=row.querySelector('details');details.open=true;details.ontoggle();
  assert.match(details.textContent,/第 5–7 行.*missing-1.*时间行无法识别/);assert.match(details.textContent,/empty.*没有可导入的文字/);
  assert.match(details.textContent,/<script>plain excerpt<\/script>/);assert.equal(details.querySelector('script'),null);
  assert.equal(JSON.parse(pipeline.writes[0].value).documents[0].segments.length,2);assert.equal(JSON.parse(pipeline.writes[0].value).documents[0].diagnostics,undefined);
  pipeline.hold(false);
  if(failed){await pipeline.store.retry();assert.equal(row.dataset.status,'saved');assert.match(details.textContent,/跳过 2/);}
 }finally{pipeline.hold(false);await w.happyDOM.close();}
});
test('late cancelled partial X output cannot replace a newer source result or create a warning receipt',async()=>{
 const partial=await fixtureCaptionService(captionFixtureResult()).importCaption({url:captionFixtureURL});
 const replies=[];const {w,$}=await setup(light({caption_import:true}),()=>new Promise(resolve=>replies.push(resolve)));
 try{
  const old=submit($,captionFixtureURL);await feedbackUntil(()=>replies.length===1);$('cancel-source').click();
  const fresh=submit($,'https://x.com/newsource/status/456');await feedbackUntil(()=>replies.length===2);
  replies[1](response({status:'unavailable',message:'New source unavailable'}));await fresh;
  replies[0](response(partial));await old;
  assert.equal($('source-route-status').textContent,'New source unavailable');assert.equal($('transcript-import-list').children.length,0);assert.equal(w.localStorage.getItem('coconut-reader-v1'),null);
 }finally{await w.happyDOM.close();}
});
test('partial X reimport keeps one document, reading work and complete access to later diagnostics',async()=>{
 let fixture=captionFixtureResult({complete:true});const captions=createCaptionService({enabledProviders:['x'],helper:{extractCaptions:async()=>fixture}});
 const {w,$}=await setup(light({caption_import:true}),async()=>response(await captions.importCaption({url:captionFixtureURL})));
 try{
  await submit($,captionFixtureURL);$('mode-transcript').click();w.document.querySelector('.note-button').click();$('note').value='Keep my authored note';$('note').dispatchEvent(new w.Event('input'));$('close-note').click();await w.flushContentForTest();
  const original=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];
  $('add-content').click();fixture=captionFixtureResult({warningCount:105});await submit($,captionFixtureURL);
  const saved=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents;assert.equal(saved.length,1);assert.equal(saved[0].key,original.key);assert.deepEqual(saved[0].notes,original.notes);
  const row=$('transcript-import-list').firstElementChild;assert.equal(row.dataset.status,'duplicate');assert.match(row.textContent,/跳过 106/);assert.equal($('stop-transcript-import').hidden,true);
  const details=row.querySelector('details');assert.equal(details.querySelectorAll('li').length,0);details.open=true;details.ontoggle();assert.equal(details.querySelectorAll('li').length,50);
  details.querySelector('button').click();assert.equal(details.querySelectorAll('li').length,100);details.querySelector('button').click();assert.equal(details.querySelectorAll('li').length,106);assert.equal(details.querySelector('button').hidden,true);assert.match(details.textContent,/missing-105/);
 }finally{await w.happyDOM.close();}
});
test('all-invalid X source cannot replace an existing readable document or announce saved captions',async()=>{
 let fixture=captionFixtureResult({complete:true});const captions=createCaptionService({enabledProviders:['x'],helper:{extractCaptions:async()=>fixture}});
 const {w,$}=await setup(light({caption_import:true}),async()=>{try{return response(await captions.importCaption({url:captionFixtureURL}));}catch(error){return {ok:false,json:async()=>({error:error.message})};}});
 try{
  await submit($,captionFixtureURL);const before=w.localStorage.getItem('coconut-reader-v1');$('add-content').click();fixture=captionFixtureResult({onlyInvalid:true});await submit($,captionFixtureURL);
  assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);assert.match($('source-route-status').textContent,/必须包含/);assert.doesNotMatch($('source-route-status').textContent,/字幕已保存|正在/);assert.equal($('add-workspace').hidden,false);
 }finally{await w.happyDOM.close();}
});
for(const change of ['cancel','url','language','navigation'])test('partial X save warning survives '+change+' without a late completion announcement',async()=>{
 const captions=fixtureCaptionService(captionFixtureResult());const {w,$,pipeline}=await setup(light({caption_import:true}),async()=>response(await captions.importCaption({url:captionFixtureURL})));
 let pending;try{
  pipeline.hold();pending=submit($,captionFixtureURL);await feedbackUntil(()=>pipeline.writes.length===1);assert.equal($('stop-transcript-import').hidden,true);
  if(change==='cancel')$('cancel-source').click();
  if(change==='url'){$('video-url').value='https://x.com/other/status/789';$('video-url').dispatchEvent(new w.Event('input'));}
  if(change==='language'){$('caption-language').value='ja';$('caption-language').dispatchEvent(new w.Event('change'));}
  if(change==='navigation')$('add-content').click();
  const status=$('source-route-status').textContent;assert.doesNotMatch(status,/正在/);
  pipeline.hold(false);pipeline.writes[0].commit();await pending;
  assert.equal($('source-route-status').textContent,status);assert.doesNotMatch($('notice').textContent,/字幕已保存/);
  const row=$('transcript-import-list').firstElementChild;assert.equal(row.dataset.status,'saved');assert.match(row.textContent,/跳过 2/);
 }finally{pipeline.hold(false);for(const write of pipeline.writes)write.commit();await pending;await w.happyDOM.close();}
});
test('a later fully parsed X import retires the earlier partial result without changing identity',async()=>{
 let fixture=captionFixtureResult();const captions=createCaptionService({enabledProviders:['x'],helper:{extractCaptions:async()=>fixture}});
 const {w,$}=await setup(light({caption_import:true}),async()=>response(await captions.importCaption({url:captionFixtureURL})));
 try{
  await submit($,captionFixtureURL);const original=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0];assert.equal($('transcript-import-results').hidden,false);
  $('add-content').click();fixture=captionFixtureResult({complete:true});await submit($,captionFixtureURL);
  assert.equal($('transcript-import-results').hidden,true);assert.doesNotMatch($('source-route-status').textContent,/部分字幕|跳过/);assert.doesNotMatch($('notice').textContent,/部分字幕|跳过/);
  const saved=JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents;assert.equal(saved.length,1);assert.equal(saved[0].key,original.key);
 }finally{await w.happyDOM.close();}
});
