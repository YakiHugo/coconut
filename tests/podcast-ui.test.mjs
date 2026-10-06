import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
const root=new URL('../',import.meta.url),feed='https://publisher.example/feed.xml',episode='a'.repeat(64),media='https://publisher.example/episode.mp3';
const source={feed_url:feed,episode_id:episode,transcript_url:'https://publisher.example/text.vtt',media_url:media,media_kind:'audio'};
const documentFixture={title:'Publisher episode',language:'en',source_url:'https://publisher.example/episode',podcast_source:source,provenance:{kind:'publisher_transcript',caption_method:'publisher_provided',review_status:'unreviewed'},segments:[{id:'one',start:0,end:2,text:'Publisher words'}]};
const discovery={kind:'feed',title:'Public podcast',feed_url:feed,episodes:[{id:episode,title:'<img src=x> Source episode',source_url:'https://publisher.example/episode',duration:2,media:[{url:media,kind:'audio'}],transcripts:[{url:source.transcript_url,type:'text/vtt',language:'en',supported:true}]}],warnings:[]};
async function setup(handler){
 const w=new Window({url:'http://127.0.0.1:8080/'});w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];Object.defineProperty(w,'crypto',{value:webcrypto});
 const calls=[];w.fetch=async(url,options)=>{calls.push({url,options});return url==='api/health'?{ok:true,json:async()=>({local_worker:false,capabilities:{local_agents:true,podcast_import:true,media_import:false}})}:handler(url,options);};
 w.eval(['core','app','language','podcasts','jobs'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
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
  await $('download-podcast-media').onclick();assert.ok(w.document.querySelector('#source-media audio'));assert.ok(!w.localStorage.getItem('coconut-reader-v1').includes('blob:'));assert.equal(calls.filter(c=>c.url.endsWith('/media')).length,1);assert.ok(!calls.some(c=>c.url.includes('/ask')||c.url.includes('language-tools')));
 }finally{await w.happyDOM.close();}
});
test('no transcript never creates fake reading content, while public episode audio can still play',async()=>{
 const noText={...discovery,episodes:[{...discovery.episodes[0],transcripts:[]}]};
 const {w,calls,$}=await setup(url=>url.endsWith('/discover')?response(noText):url.endsWith('/import')?response({status:'needs_transcription'}):audioResponse());try{
  await discover($);let row=$('podcast-results').querySelector('.podcast-episode');await row.querySelector('button').onclick();assert.match($('podcast-status').textContent,/没有可用.*文字稿/);assert.equal(w.localStorage.getItem('coconut-reader-v1'),null);
  await row.querySelectorAll('button')[1].onclick();assert.ok(row.querySelector('audio'));assert.equal(w.localStorage.getItem('coconut-reader-v1'),null);assert.equal(calls.filter(c=>c.url.endsWith('/media')).length,1);
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
