import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url),feed='https://publisher.example.org/feed.xml';
const discovery={kind:'feed',title:'Old source results',feed_url:feed,episodes:[{id:'a'.repeat(64),title:'Old episode',source_url:'https://publisher.example.org/episode',media:[],transcripts:[{url:'https://publisher.example.org/captions.vtt',type:'text/vtt',language:'en',supported:true}]}]};
const documentFixture={title:'Old source document',language:'en',segments:[{id:'a',start:0,end:2,text:'Original authored source'}]};
const response=value=>({ok:true,json:async()=>value});
async function setup(health,handler=()=>{throw new Error('Unexpected request');}){
 const w=new Window({url:'http://127.0.0.1:8080/'});w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];Object.defineProperty(w,'crypto',{value:webcrypto});
 const calls=[];w.fetch=async(url,options)=>{calls.push([url,options]);return url==='api/health'?response(typeof health==='function'?health():health):url==='api/jobs'?response({jobs:[]}):handler(url,options);};
 w.eval(['summary','core','app','language','podcasts','jobs'].map(n=>fs.readFileSync(new URL('reader/'+n+'.js',root),'utf8')).join('\n'));await new Promise(r=>setTimeout(r,20));
 return {w,calls,$:id=>w.document.getElementById(id),label:()=>w.document.querySelector('label[for="video-url"]').textContent};
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
