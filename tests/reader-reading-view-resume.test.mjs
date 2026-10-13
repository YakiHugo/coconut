import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
const CONTENT='coconut-reader-v1',VIEW='coconut-reading-view-v1',SHARED='coconut-reading-view-defaults-v1';
const sourceRoot=process.env.COCONUT_BASE_SOURCE?pathToFileURL(process.env.COCONUT_BASE_SOURCE+'/'):new URL('../',import.meta.url);
function storage(){const values=new Map(),writes=[];return {values,writes,getItem:key=>values.get(key)??null,setItem(key,value){writes.push(key);values.set(key,String(value));},removeItem:key=>values.delete(key)};}
function setup({docs=largeLibraryFixture(2,{cues:1000}),disk=storage(),session=storage(),deny=false}={}){
 if(!disk.getItem(CONTENT))disk.setItem(CONTENT,JSON.stringify({documents:docs,active:docs[0]?.key}));
 const h=libraryHarness(docs,{probe:true,sourceRoot,configureCore(w){
  Object.defineProperty(w,'localStorage',{value:{...disk,setItem(key,value){if(deny&&key===SHARED)throw Error('Denied preference');disk.setItem(key,value);}}});
  Object.defineProperty(w,'sessionStorage',{value:{...session,setItem(key,value){if(deny)throw Error('Denied preference');session.setItem(key,value);}}});
 }});
 h.scrolled=[];h.w.HTMLElement.prototype.scrollIntoView=function(){h.scrolled.push(this);};
 h.open=key=>h.$('library').querySelector(`[data-document-key="${key}"] .library-open`).click();
 return {...h,disk,session};
}
function lateTranscript(h){h.$('mode-transcript').click();for(let i=0;i<7;i++)h.$('next-page').click();}
const first=h=>h.$('transcript').querySelector('.segment')?.dataset.segmentId;
const remembered=h=>JSON.parse(h.session.getItem(VIEW)||'{"views":[]}').views.find(view=>view[0]==='shelf-0');
function visibleOnly(h,id){for(const node of h.w.document.querySelectorAll('#transcript .segment,#passage-body .passage-original .passage-cue'))node.getBoundingClientRect=()=>({top:(node.dataset.segmentId||node.dataset.cueId)===id?120:2000,bottom:(node.dataset.segmentId||node.dataset.cueId)===id?180:2050,height:60,width:100});}
test('ordinary A to B to A resumes the last transcript page without a manual bookmark or content write',async()=>{
 const h=setup();try{const content=h.disk.getItem(CONTENT),generation=h.pipeline.store.status().generation;lateTranscript(h);assert.equal(first(h),'shelf-0-cue-700');h.open('shelf-1');h.open('shelf-0');
  assert.equal(h.w.document.body.dataset.readingMode,'transcript');assert.equal(first(h),'shelf-0-cue-700');assert.equal(h.disk.getItem(CONTENT),content);assert.equal(h.pipeline.store.status().generation,generation);assert.equal(h.w.libraryProbe.documents[0].readingPosition,undefined);
 }finally{await h.w.happyDOM.close();}
});
test('pagehide captures the visible cue, same-window reload and a new window resume it independently',async()=>{
 const h=setup();let reload,other,again;try{lateTranscript(h);visibleOnly(h,'shelf-0-cue-735');h.w.dispatchEvent(new h.w.Event('pagehide'));assert.deepEqual(remembered(h),['shelf-0','shelf-0-cue-735','transcript']);
  reload=setup({disk:h.disk,session:h.session});assert.equal(first(reload),'shelf-0-cue-700');assert.equal(reload.w.document.body.dataset.readingMode,'transcript');
  other=setup({disk:h.disk});assert.equal(first(other),'shelf-0-cue-700');other.$('previous-page').click();other.w.dispatchEvent(new other.w.Event('pagehide'));
  again=setup({disk:h.disk,session:h.session});assert.equal(first(again),'shelf-0-cue-700','another window cannot replace this window view');
 }finally{for(const env of [h,reload,other,again])await env?.w.happyDOM.close();}
});
test('passage paging and summary choice resume, with manual bookmark left distinct',async()=>{
 const docs=largeLibraryFixture(2,{cues:1000});docs[0].readingPosition='shelf-0-cue-19';const h=setup({docs});try{
  for(let i=0;i<5;i++)h.$('passage-next').click();const cue=h.$('passage-body').firstElementChild.dataset.firstCueId;h.open('shelf-1');h.open('shelf-0');assert.equal(h.w.document.body.dataset.readingMode,'passages');assert.ok(h.$('passage-body').querySelector(`[data-cue-id="${cue}"]`));assert.equal(h.w.libraryProbe.documents[0].readingPosition,'shelf-0-cue-19');
  h.$('resume').click();assert.ok(h.$('transcript').querySelector('[data-segment-id="shelf-0-cue-19"]'),'explicit saved bookmark wins');
  h.$('mode-summary').click();h.open('shelf-1');h.open('shelf-0');assert.equal(h.w.document.body.dataset.readingMode,'summary');
 }finally{await h.w.happyDOM.close();}
});
test('a temporary search detour does not replace progress; explicitly continuing does',async()=>{
 const h=setup();try{lateTranscript(h);h.$('search').focus();h.$('search').value='source sentence 950.';h.$('search').oninput();h.$('next-match').click();h.open('shelf-1');h.open('shelf-0');assert.equal(first(h),'shelf-0-cue-700');
  h.$('search').focus();h.$('search').value='source sentence 950.';h.$('search').oninput();h.$('next-match').click();h.$('continue-search-reading').click();h.open('shelf-1');h.open('shelf-0');assert.equal(h.w.document.body.dataset.readingMode,'passages');assert.ok(h.$('passage-body').querySelector('[data-cue-id="shelf-0-cue-950"]'));
 }finally{await h.w.happyDOM.close();}
});
test('denied preferences keep in-page progress usable and never block durable notes',async()=>{
 const h=setup({deny:true});try{lateTranscript(h);h.open('shelf-1');h.open('shelf-0');assert.equal(first(h),'shelf-0-cue-700');h.$('transcript').querySelector('.note-button').click();h.$('note').value='Saved without view storage';h.$('note').dispatchEvent(new h.w.Event('input',{bubbles:true}));assert.equal((await h.w.flushContentForTest()).ok,true);assert.equal(h.$('save-status').dataset.state,'saved');}
 finally{await h.w.happyDOM.close();}
});

test('stale cue and malformed mode fall back to the explicit bookmark; source shrink clamps pages',async()=>{
 for(const record of [['shelf-0','removed-cue','transcript'],['shelf-0','shelf-0-cue-19','invented-mode']]){
  const docs=largeLibraryFixture(2,{cues:50});docs[0].readingPosition='shelf-0-cue-19';const disk=storage(),session=storage();session.setItem(VIEW,JSON.stringify({version:1,views:[record]}));session.setItem('coconut-reader-active-v1','shelf-1');
  const h=setup({docs,disk,session});try{h.open('shelf-0');assert.equal(h.w.document.body.dataset.readingMode,'passages');assert.ok(h.$('passage-body').querySelector('[data-cue-id="shelf-0-cue-19"]'));assert.equal(h.w.libraryProbe.documents[0].readingPosition,'shelf-0-cue-19');}finally{await h.w.happyDOM.close();}
 }
 const session=storage();session.setItem(VIEW,JSON.stringify({version:1,views:[['shelf-0','shelf-0-cue-49','transcript']]}));const h=setup({docs:largeLibraryFixture(2,{cues:50}),session});try{assert.equal(first(h),'shelf-0-cue-0');assert.ok(h.$('transcript').querySelector('[data-segment-id="shelf-0-cue-49"]'));assert.match(h.$('reading-page-status').textContent,/1–50/);}finally{await h.w.happyDOM.close();}
});
test('capturing progress is passive during note IME and never plays, seeks, dirties content or saves drafts',async()=>{
 const h=setup();try{lateTranscript(h);h.$('transcript').querySelector('.note-button').click();const note=h.$('note'),doc=h.w.libraryProbe.documents[0],before=JSON.stringify(doc),generation=h.pipeline.store.status().generation;note.value='未提交的输入法草稿';note.focus();note.setSelectionRange(2,5);note.dispatchEvent(new h.w.CompositionEvent('compositionstart',{data:'草稿'}));
  let plays=0,fetches=0;h.w.HTMLMediaElement.prototype.play=()=>{plays++;throw Error('Unexpected playback');};h.w.fetch=()=>{fetches++;throw Error('Unexpected network');};visibleOnly(h,'shelf-0-cue-735');Object.defineProperty(h.w.document,'hidden',{configurable:true,value:true});h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
  assert.equal(h.w.document.activeElement,note);assert.equal(h.$('note'),note);assert.equal(note.value,'未提交的输入法草稿');assert.equal(note.selectionStart,2);assert.equal(note.selectionEnd,5);assert.equal(JSON.stringify(doc),before);assert.equal(h.pipeline.store.status().generation,generation);assert.equal(plays,0);assert.equal(fetches,0);assert.deepEqual(remembered(h),['shelf-0','shelf-0-cue-735','transcript']);
 }finally{await h.w.happyDOM.close();}
});
test('ordinary rerenders and scroll events do not write progress; page and mode actions do',async()=>{
 const h=setup();try{lateTranscript(h);const writes=h.session.writes.filter(key=>key===VIEW).length;h.w.libraryProbe.render();for(let i=0;i<20;i++)h.w.dispatchEvent(new h.w.Event('scroll'));assert.equal(h.session.writes.filter(key=>key===VIEW).length,writes);h.$('next-page').click();assert.equal(h.session.writes.filter(key=>key===VIEW).length,writes+1);assert.deepEqual(remembered(h),['shelf-0','shelf-0-cue-800','transcript']);
 }finally{await h.w.happyDOM.close();}
});
test('chapter and passage-detail detours retain the origin until the explicit stay action',async()=>{
 const docs=largeLibraryFixture(2,{cues:1000});const h=setup({docs});try{
  const doc=h.w.libraryProbe.documents[0],cue=doc.segments[940];doc.reading_chapters=[h.w.Coconut.createReadingChapter(doc,{id:'authored-chapter',cueId:cue.id,title:'Authored chapter'})];lateTranscript(h);
  h.$('open-chapters').click();h.$('chapter-list').querySelector('.chapter-open').click();assert.ok(h.$('transcript').querySelector('[data-segment-id="shelf-0-cue-940"]'));h.open('shelf-1');h.open('shelf-0');assert.equal(first(h),'shelf-0-cue-700');
  h.$('open-chapters').click();h.$('chapter-list').querySelector('.chapter-open').click();h.$('stay-at-chapter').click();h.open('shelf-1');h.open('shelf-0');assert.ok(h.$('transcript').querySelector('[data-segment-id="shelf-0-cue-940"]'));
  h.$('mode-passages').click();const passage=h.$('passage-body').firstElementChild,anchor=passage.dataset.firstCueId;passage.querySelector('.passage-details').click();assert.equal(h.w.document.body.dataset.readingMode,'transcript');h.open('shelf-1');h.open('shelf-0');assert.equal(h.w.document.body.dataset.readingMode,'passages');assert.ok(h.$('passage-body').querySelector(`[data-cue-id="${anchor}"]`));
 }finally{await h.w.happyDOM.close();}
});
test('bounded preferences hold only valid cue/mode tuples, preserve unrelated windows and tolerate corrupt/denied storage',async()=>{
 const {default:Coconut}=await import(new URL('reader/core.js',sourceRoot));const disk=storage(),session=storage(),a=Coconut.createReadingViews({getStorage:()=>disk,getSessionStorage:()=>session,limit:3});
 a.record('a','cue-a','transcript');a.record('b','cue-b','passages');a.record('c','cue-c','summary');a.record('d','cue-d','transcript');assert.deepEqual(JSON.parse(session.getItem(VIEW)).views.map(v=>v[0]),['b','c','d']);
 const otherSession=storage(),b=Coconut.createReadingViews({getStorage:()=>disk,getSessionStorage:()=>otherSession,limit:3});assert.deepEqual(b.get('d'),{cueId:'cue-d',mode:'transcript'});b.record('d','other-cue','passages');assert.deepEqual(a.get('d'),{cueId:'cue-d',mode:'transcript'});a.record('c','new-cue','transcript');assert.equal(b.get('d').cueId,'other-cue');assert.ok(JSON.parse(disk.getItem(SHARED)).views.some(v=>v[0]==='d'&&v[1]==='other-cue'));
 session.setItem(VIEW,JSON.stringify({version:1,views:[['valid','cue','summary'],['bad','cue','invalid'],['extra','cue','transcript','private'],['long','x'.repeat(1025),'transcript'],[null,'cue','transcript']]}));const clean=Coconut.createReadingViews({getStorage:()=>storage(),getSessionStorage:()=>session});assert.equal(clean.get('valid').mode,'summary');for(const key of ['bad','extra','long'])assert.equal(clean.get(key),null);
 session.setItem(VIEW,'broken');const denied=Coconut.createReadingViews({getStorage(){throw Error('denied');},getSessionStorage(){throw Error('denied');}});assert.doesNotThrow(()=>denied.record('safe','cue','transcript'));assert.equal(denied.get('safe').cueId,'cue');assert.doesNotThrow(()=>denied.remove('safe'));assert.equal(denied.get('safe'),null);
 a.remove('d');assert.equal(a.get('d'),null);assert.equal(JSON.parse(session.getItem(VIEW)).views.some(v=>v[0]==='d'),false);
});
test('successful document removal clears only its UI record; a failed removal retains it',async()=>{
 const h=setup();try{lateTranscript(h);h.open('shelf-1');h.open('shelf-0');const original=h.session.getItem(VIEW),write=h.disk.setItem;let blocked=true;h.disk.setItem=(key,value)=>{if(blocked&&key===CONTENT)throw Error('Authored content quota');write(key,value);};
  h.$('library').querySelector('[data-document-key="shelf-0"] .library-remove').click();await h.$('confirm-removal').onclick();assert.ok(h.w.libraryProbe.documents.some(doc=>doc.key==='shelf-0'));assert.equal(h.session.getItem(VIEW),original);
  blocked=false;h.$('library').querySelector('[data-document-key="shelf-0"] .library-remove').click();await h.$('confirm-removal').onclick();assert.equal(h.w.libraryProbe.documents.some(doc=>doc.key==='shelf-0'),false);assert.equal(remembered(h),undefined);assert.ok(JSON.parse(h.session.getItem(VIEW)).views.some(view=>view[0]==='shelf-1'));
 }finally{await h.w.happyDOM.close();}
});
test('empty cue IDs remain valid source anchors and the default preference cap is 512 entries',async()=>{
 const {default:Coconut}=await import(new URL('reader/core.js',sourceRoot));const disk=storage(),session=storage(),views=Coconut.createReadingViews({getStorage:()=>disk,getSessionStorage:()=>session});
 views.record('empty','','transcript');assert.deepEqual(views.get('empty'),{cueId:'',mode:'transcript'});for(let i=0;i<600;i++)views.record('doc-'+i,'cue-'+i,'passages');assert.equal(JSON.parse(session.getItem(VIEW)).views.length,512);assert.equal(JSON.parse(disk.getItem(SHARED)).views.length,512);assert.equal(views.get('doc-0'),null);
});
test('successful shared-hint removal or clear retires unowned cached defaults; denied reads retain memory and owned views stay independent',async()=>{
 const {default:Coconut}=await import(new URL('reader/core.js',sourceRoot)),disk=storage(),a=Coconut.createReadingViews({getStorage:()=>disk,getSessionStorage:()=>storage()});
 a.record('a','cue-a','transcript');let denied=false;
 const b=Coconut.createReadingViews({getStorage(){if(denied)throw Error('Read denied');return disk;},getSessionStorage:()=>storage()});
 const owner=Coconut.createReadingViews({getStorage:()=>disk,getSessionStorage:()=>storage()});owner.record('a','my-cue','passages');
 assert.deepEqual(b.get('a'),{cueId:'my-cue',mode:'passages'});denied=true;a.remove('a');assert.deepEqual(b.get('a'),{cueId:'my-cue',mode:'passages'},'failed reads retain the last bounded default');
 denied=false;assert.equal(b.get('a'),null,'a readable empty map retires an unowned cached hint');assert.deepEqual(owner.get('a'),{cueId:'my-cue',mode:'passages'},'the other window own view remains independent');
 a.record('a','replacement','transcript');assert.equal(b.get('a').cueId,'replacement');disk.removeItem(SHARED);assert.equal(b.get('a'),null,'clearing the preference is a successful absent read');
 a.record('a','newer','summary');assert.equal(b.get('a').cueId,'newer');disk.setItem(SHARED,'invalid JSON');assert.equal(b.get('a'),null,'readable corrupt data does not resurrect an obsolete hint');
});
