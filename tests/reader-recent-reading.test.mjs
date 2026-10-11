import test from 'node:test';
import assert from 'node:assert/strict';
import Coconut from '../reader/core.js';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {installSavePipeline} from './helpers/save-pipeline.mjs';
const KEY='coconut-reading-recency-v1',CONTENT='coconut-reader-v1';
const docs=()=>['a','b','c'].map(key=>({key,title:'Authored '+key,language:'en',notes:{cue:'Note '+key},readingPosition:'cue',segments:[{id:'cue',start:0,end:5,text:'Source '+key}]}));
function disk(){const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,String(value)),removeItem:key=>map.delete(key)};}
function setup(storage=disk(),{denied=false,mobile=false}={}){
 if(storage.getItem(CONTENT)===null)storage.setItem(CONTENT,JSON.stringify({documents:docs()}));
 const w=new Window({url:'https://coconut.example/'}),root=new URL('../',import.meta.url);
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});
 Object.defineProperty(w,'localStorage',{value:{...storage,setItem(key,value){if(denied&&key===KEY)throw Error('Denied');storage.setItem(key,value);}}});
 if(mobile){const match=w.matchMedia.bind(w);w.matchMedia=query=>query==='(max-width: 650px)'?{matches:true,addEventListener(){}}:match(query);}
 w.fetch=()=>{throw Error('Unexpected network request');};installSavePipeline(w);
 w.eval(['summary','core','passages','passage-playback','app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+'\nObject.assign(window,{render,renderLibrary,goToSegment,add,active,openTranscriptImportResult});');
 w.HTMLElement.prototype.scrollIntoView=function(){};const h={w,$:id=>w.document.getElementById(id)};
 return {...h,storage,order:()=>[...h.$('library').children].map(n=>n.dataset.documentKey),sort(value='opened'){h.$('library-sort').value=value;h.$('library-sort').onchange();},open(key){h.$('library').querySelector(`[data-document-key="${key}"] .library-open`).click();}};
}
test('bounded preference merges alternating windows, tombstones, malformed records and backwards clocks',()=>{
 const storage=disk(),a=Coconut.createReadingRecency({getStorage:()=>storage,now:()=>100}),b=Coconut.createReadingRecency({getStorage:()=>storage,now:()=>90});
 a.record('a');b.record('b');a.refresh();assert.ok(a.time('b')>a.time('a'));
 b.record('a',true);a.record('c');assert.equal(a.time('a'),0);assert.ok(a.time('b')>0);
 for(let i=0;i<600;i++)a.record('key-'+i);
 assert.equal(JSON.parse(storage.getItem(KEY)).events.length,512);assert.equal(a.time('b'),0);
 storage.setItem(KEY,JSON.stringify({version:1,events:[['bad',NaN,false],['bad2',-1,false],['bad3',3,'yes'],['ok',9999,false],['ok',9999,true]]}));
 const clean=Coconut.createReadingRecency({getStorage:()=>storage});assert.equal(clean.time('ok'),0);assert.equal(clean.time('bad3'),0);
 storage.setItem(KEY,'{broken');assert.doesNotThrow(()=>clean.record('safe'));
});
test('equal/unknown recency uses stable added order and never mutates the source',()=>{
 const documents=docs();assert.deepEqual(Coconut.sortedLibrary(documents,'opened',key=>key==='c'?3:0).map(d=>d.key),['c','a','b']);
 assert.deepEqual(Coconut.sortedLibrary(documents,'opened',()=>5),documents);assert.deepEqual(documents.map(d=>d.key),['a','b','c']);
});
test('startup and renders do not record; explicit shelf open sorts, reloads and leaves content/bookmarks untouched',async()=>{
 const h=setup();let reload;
 try{
  const original=h.storage.getItem(CONTENT);assert.equal(h.$('library-sort').value,'added');assert.equal(h.storage.getItem(KEY),null);
  h.w.render();h.w.goToSegment('cue');assert.equal(h.storage.getItem(KEY),null);
  h.open('c');h.open('b');assert.deepEqual(h.order(),['a','b','c']);h.sort();assert.deepEqual(h.order(),['b','c','a']);
  const recency=h.storage.getItem(KEY);h.w.render();assert.equal(h.storage.getItem(KEY),recency);assert.equal(h.storage.getItem(CONTENT),original);
  reload=setup(h.storage);assert.equal(reload.$('library-sort').value,'opened');assert.deepEqual(reload.order(),['b','c','a']);assert.equal(h.storage.getItem(KEY),recency);
  assert.equal(reload.w.active().readingPosition,'cue');
 }finally{await h.w.happyDOM.close();await reload?.w.happyDOM.close();}
});
test('import/background selection does not record; explicit result, notebook and resume do',async()=>{
 const h=setup();try{
  await h.w.add({title:'Imported',language:'en',segments:[{id:'new',start:0,end:3,text:'New source'}]});assert.equal(h.storage.getItem(KEY),null);
  h.open('b');let time=JSON.parse(h.storage.getItem(KEY)).events.find(e=>e[0]==='b')[1];
  h.w.goToSegment('cue');h.$('resume').click();assert.ok(JSON.parse(h.storage.getItem(KEY)).events.find(e=>e[0]==='b')[1]>time);
  h.$('open-library-notebook').click();h.$('notebook-captures').querySelector('.notebook-open').click();h.sort();assert.equal(h.order()[0],'a');
  h.w.openTranscriptImportResult({identity:h.w.active()});assert.equal(h.order()[0],'a');
 }finally{await h.w.happyDOM.close();}
});
test('storage event merges another window without changing this window selection',async()=>{
 const storage=disk(),a=setup(storage),b=setup(storage);try{
  a.open('b');a.sort();b.open('c');a.w.dispatchEvent(new a.w.StorageEvent('storage',{key:KEY}));
  assert.deepEqual(a.order(),['c','b','a']);assert.equal(a.$('title').textContent,'Authored b');
 }finally{await a.w.happyDOM.close();await b.w.happyDOM.close();}
});
test('denied recency writes still sort in memory and allow durable notes',async()=>{
 const h=setup(disk(),{denied:true});try{
  h.open('c');h.sort();assert.deepEqual(h.order(),['c','a','b']);assert.equal(h.storage.getItem(KEY),null);
  h.w.goToSegment('cue');h.w.document.querySelector('.note-button').click();h.$('note').value='Durable despite preference failure';h.$('note').dispatchEvent(new h.w.Event('input'));h.$('close-note').click();
  assert.equal((await h.w.flushContentForTest()).ok,true);assert.equal(JSON.parse(h.storage.getItem(CONTENT)).documents[2].notes.cue,'Durable despite preference failure');
 }finally{await h.w.happyDOM.close();}
});
test('successful removal forgets recency; same-key restoration stays unknown until explicitly opened',async()=>{
 const h=setup();try{
  h.open('c');h.open('b');h.sort();h.$('library-options').open=true;h.w.renderLibrary();
  h.$('library').querySelector('[data-document-key="b"] .library-remove').click();await h.$('confirm-removal').onclick();
  assert.equal(JSON.parse(h.storage.getItem(KEY)).events.find(e=>e[0]==='b')[2],true);
  await h.$('undo-removal').onclick();assert.deepEqual(h.order(),['c','a','b']);
  h.open('b');assert.deepEqual(h.order(),['b','c','a']);
 }finally{await h.w.happyDOM.close();}
});

test('search-hit opens record once and mobile current-document return immediately refreshes recent order',async()=>{
 const storage=disk(),h=setup(storage,{mobile:true});try{
  h.sort();h.$('library-scope').value='text';h.$('library-search').value='Source b';h.$('library-search').oninput();
  h.$('library').querySelector('.library-hit').click();assert.equal(h.$('title').textContent,'Authored b');
  const events=JSON.parse(storage.getItem(KEY)).events;assert.deepEqual(events.map(e=>e[0]),['b']);
  h.$('library-search').value='';h.$('library-search').oninput();
  const remote=Coconut.createReadingRecency({getStorage:()=>storage});remote.record('c');h.w.dispatchEvent(new h.w.StorageEvent('storage',{key:KEY}));assert.deepEqual(h.order(),['c','b','a']);
  h.$('close-library-search').click();h.$('title').focus();h.$('toggle-library').click();h.open('b');assert.deepEqual(h.order(),['b','c','a']);assert.equal(h.w.document.activeElement,h.$('title'));
 }finally{await h.w.happyDOM.close();}
});
test('completely unavailable preference storage keeps bounded recency in memory',()=>{
 const prefs=Coconut.createReadingRecency({getStorage(){throw Error('Storage denied');},now:()=>7});
 assert.doesNotThrow(()=>prefs.record('a'));assert.equal(prefs.time('a'),7);assert.doesNotThrow(()=>prefs.refresh());assert.equal(prefs.time('a'),7);
});
