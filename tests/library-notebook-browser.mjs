// Compatibility renderer regression; this suite does not establish default React acceptance.
import {openLibraryTools,openLibrarySearch,closeLibrarySearch} from './helpers/library-tools-browser.mjs';
/** CI-only: authored captures, cooperative typing, downloads and narrow-screen source return. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium,waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {startBridge} from '../desktop/server.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
let browser,server;let external=0,mutations=0;const errors=[];
try{
 server=await startBridge({port:0});const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 async function newPage(viewport={width:390,height:844}){
  const context=await browser.newContext({viewport,acceptDownloads:true,serviceWorkers:'block'});
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(!['GET','HEAD'].includes(request.method())){mutations++;await route.abort();}else if(url.origin===origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
  const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/compatibility.html');return page;
 }
 const page=await newPage();
 const docs=largeLibraryFixture(2,{cues:65});for(const doc of docs){doc.segments.forEach((cue,i)=>{cue.id='shared-'+i;cue.saved_excerpt=true;});doc.notes={'shared-64':'Final private note '+doc.key};}
 docs[0].project_note='Notebook needle project';docs[0].timestamp_bookmarks=Array.from({length:65},(_,i)=>({id:'bookmark-'+i,time:i*10+10,note:'Retained bookmark '+i+(i===64?' Notebook needle':'')}));
 await page.locator('#library-file').setInputFiles({name:'authored-notebook.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'coconut-library',version:1,documents:docs,active:docs[0].key}))});
 await waitForPersistedLibrary(page,async()=>(await readPersistedLibrary()).documents.length===2);
 const originalTitle=await page.locator('#title').textContent();if(!await page.locator('#open-library-notebook').isVisible())await page.locator('#toggle-library').click();await openLibraryTools(page);await page.locator('#open-library-notebook').click();
 assert.equal(await page.locator('.notebook-capture').count(),30);assert.equal(await page.locator('#title').textContent(),originalTitle);
 assert.ok(await page.locator('#library-notebook').evaluate(n=>n.getBoundingClientRect().right<=innerWidth&&n.scrollWidth<=n.clientWidth));
 await page.locator('#notebook-search').fill('Authored shelf 00001');await page.locator('#notebook-next').click();await page.locator('#notebook-next').click();assert.equal(await page.locator('.notebook-capture').count(),5);
 await page.locator('.notebook-open').last().focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.activeElement===document.getElementById('note'));
 assert.equal(await page.locator('#note').inputValue(),'Final private note shelf-1');assert.equal(await page.locator('#title').textContent(),docs[1].title);
 await page.locator('#close-note').click();await page.locator('#return-library-notebook').click();assert.equal(await page.locator('.notebook-capture').count(),5);
 assert.ok(await page.locator('.notebook-open').last().evaluate(n=>n===document.activeElement));assert.equal(await page.locator('#notebook-search').inputValue(),'Authored shelf 00001');
 await page.locator('.notebook-capture input').last().check();await page.locator('#notebook-search').fill('no match at all');assert.equal(await page.locator('.notebook-capture').count(),0);
 const pending=page.waitForEvent('download');await page.locator('#notebook-export').click();const download=await pending,markdown=await fs.readFile(await download.path(),'utf8');
 assert.match(markdown,/所选 1 篇/);assert.match(markdown,/Authored document 1, source sentence 0/);assert.match(markdown,/source sentence 64/);assert.doesNotMatch(markdown,/Authored document 0/);
 await page.keyboard.press('Escape');assert.equal(await page.locator('#library-notebook').evaluate(n=>n.open),false);
 if(!await page.locator('#open-library-notebook').isVisible())await page.locator('#toggle-library').click();await openLibraryTools(page);await page.locator('#open-library-notebook').click();await page.locator('#notebook-close').click();
 // Transcript-bearing project annotation search hits must reveal their editors.
 await openLibrarySearch(page);
 await page.locator('#library-scope').selectOption('notes');await page.locator('#library-search').fill('Notebook needle');
 for(const kind of ['project-note','bookmark']){
  await openLibrarySearch(page);
  await page.locator('.library-hit[data-hit-kind="'+kind+'"]').click();
  const target=kind==='project-note'?page.locator('#project-note'):page.locator('#audio-bookmarks [data-bookmark-id="bookmark-64"] textarea');
  assert.ok(await target.isVisible());assert.ok(await target.evaluate(node=>node===document.activeElement));
 }
 // Correcting the source timestamp changes notebook order, but return keeps identity.
 if(!await page.locator('#open-library-notebook').isVisible())await page.locator('#toggle-library').click();
 await openLibraryTools(page);await page.locator('#open-library-notebook').click();
 await page.locator('#notebook-search').fill('Retained');await page.locator('#notebook-kind').selectOption('note');
 await page.locator('#notebook-next').click();await page.locator('#notebook-next').click();
 const movedKey=await page.locator('.notebook-capture').last().getAttribute('data-capture-key');
 await page.locator('.notebook-open').last().click();
 const bookmark=page.locator('#audio-bookmarks [data-bookmark-id="bookmark-64"]');
 await bookmark.locator('.edit-bookmark-time').click();await bookmark.locator('form input').fill('1');await bookmark.getByRole('button',{name:'保存时间',exact:true}).click();
 await page.locator('#return-library-notebook').click();
 assert.equal(await page.locator('#notebook-search').inputValue(),'Retained');assert.equal(await page.locator('#notebook-kind').inputValue(),'note');
 assert.match(await page.locator('#notebook-status').textContent(),/1–30 \/ 65/);
 assert.equal(await page.locator('.notebook-capture').first().getAttribute('data-capture-key'),movedKey);
 assert.ok(await page.locator('.notebook-open').first().evaluate(node=>node===document.activeElement));
 assert.ok(await page.locator('.notebook-open').first().evaluate(node=>{const rect=node.getBoundingClientRect(),dialog=document.getElementById('library-notebook').getBoundingClientRect();return rect.top>=dialog.top&&rect.bottom<=dialog.bottom;}));
 // Authored bookmark edits reconcile both search views without replacing a live editor.
 const audioPage=await newPage({width:1280,height:900});
 const audioDoc={key:'authored-audio',title:'Authored recording',project_kind:'audio_only',local_media_source:{version:1,kind:'audio',name:'authored.wav',size:64,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)},segments:[],timestamp_bookmarks:[{id:'needle',time:90,note:'Find needle'}]};
 await audioPage.locator('#file').setInputFiles({name:'authored-audio.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(audioDoc))});
 await audioPage.locator('#audio-project').waitFor({state:'visible'});
 await openLibrarySearch(audioPage);
 await audioPage.locator('#library-scope').selectOption('notes');await audioPage.locator('#library-search').fill('needle');
 assert.match(await audioPage.locator('.library-hit').textContent(),/01:30/);
 await closeLibrarySearch(audioPage);await audioPage.locator('#audio-bookmark-search').fill('01:30');
 await audioPage.locator('.edit-bookmark-time').click();await audioPage.locator('#audio-bookmarks form input').fill('180');
 await audioPage.getByRole('button',{name:'保存时间',exact:true}).click();
 assert.match(await audioPage.locator('#audio-bookmark-results').textContent(),/找到 0 \/ 1/);
 assert.ok(await audioPage.locator('#audio-bookmark-search').evaluate(node=>node===document.activeElement));
 await openLibrarySearch(audioPage);assert.match(await audioPage.locator('.library-hit').textContent(),/03:00/);await closeLibrarySearch(audioPage);
 await audioPage.locator('#audio-bookmark-search').fill('needle');
 await audioPage.evaluate(()=>{
  const describe=node=>node?{tag:node.tagName,id:node.id||'',inBookmark:!!node.closest?.('#audio-bookmarks section')}:null;
  window.bookmarkFocusProof={handlerPropertySupported:'onfocusout' in document.createElement('section'),events:[]};
  for(const type of ['pointerdown','pointerup','pointercancel','click','focusin','focusout'])document.addEventListener(type,event=>{
   bookmarkFocusProof.events.push({type,target:describe(event.target),related:describe(event.relatedTarget),active:describe(document.activeElement),rows:document.querySelectorAll('#audio-bookmarks section').length});
   if(bookmarkFocusProof.events.length>40)bookmarkFocusProof.events.shift();
  },true);
 });
 const note=audioPage.locator('#audio-bookmarks textarea');await note.focus();
 await note.evaluate(node=>{window.bookmarkEditorProof=node;node.setSelectionRange(0,node.value.length);});
 await audioPage.keyboard.type('Other thought');
 assert.ok(await note.evaluate(node=>node===window.bookmarkEditorProof&&node===document.activeElement&&node.selectionStart===13&&node.value==='Other thought'));
 // Exercise a non-focusing button activation with the real pointer/click sequence.
 await audioPage.locator('.edit-bookmark-time').evaluate(button=>button.addEventListener('mousedown',event=>{event.preventDefault();document.querySelector('#audio-bookmarks textarea').blur();},{once:true}));
 await audioPage.locator('.edit-bookmark-time').click();assert.ok(await audioPage.locator('#audio-bookmarks form input').isVisible());
 await audioPage.getByRole('button',{name:'取消修正',exact:true}).click();
 await audioPage.locator('#audio-bookmark-time').click();
 try{await audioPage.waitForFunction(()=>document.querySelectorAll('#audio-bookmarks section').length===0);}
 catch(error){
  console.error(JSON.stringify({suite:'bookmark-focus-reconciliation',errors,proof:await audioPage.evaluate(()=>({...bookmarkFocusProof,rows:document.querySelectorAll('#audio-bookmarks section').length,activeId:document.activeElement?.id||'',activeTag:document.activeElement?.tagName||''}))}));
  throw error;
 }
 assert.match(await audioPage.locator('#audio-bookmark-results').textContent(),/找到 0 \/ 1/);
 assert.ok(await audioPage.locator('#audio-bookmark-time').evaluate(node=>node===document.activeElement));
 await waitForPersistedLibrary(audioPage,async()=>{const bookmark=(await readPersistedLibrary()).documents[0]?.timestamp_bookmarks[0];return bookmark?.note==='Other thought'&&bookmark?.time===180;});
 await audioPage.reload();await audioPage.locator('#audio-project').waitFor({state:'visible'});
 assert.equal(await audioPage.locator('#audio-bookmarks textarea').inputValue(),'Other thought');
 assert.match(await audioPage.locator('#audio-bookmarks section > button').first().textContent(),/03:00/);
 // A separate clean context exercises the cooperative path with authored data.
 // 6,148 captures exceed the production work threshold without a timing mock or
 // oversized fixture. The final 68 matches span every document and its last cue.
 const large=await newPage({width:1280,height:900});
 const largeDocs=largeLibraryFixture(4,{cues:1537}),finalQuery='final notebook marker',supersededQuery='superseded notebook marker',expectedKeys=[];
 for(const doc of largeDocs)for(const [index,cue] of doc.segments.entries()){
  cue.saved_excerpt=true;
  if(index%96===0){cue.text+=' '+finalQuery;expectedKeys.push(JSON.stringify([doc.key,'cue',cue.id]));}
  else if(index<40)cue.text+=' '+supersededQuery;
 }
 assert.equal(expectedKeys.length,68);
 await large.locator('#library-file').setInputFiles({name:'authored-cooperative-notebook.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'coconut-library',version:1,documents:largeDocs,active:largeDocs[0].key}))});
 await waitForPersistedLibrary(large,async()=>(await readPersistedLibrary()).documents.length===4,undefined,{timeout:20000});
 const readerTitle=await large.locator('#title').textContent();
 // Observe production DOM updates and trusted keyboard events only. Do not call
 // oninput, replace timers, or invoke the search engine directly in this journey.
 await large.evaluate(()=>{
  const host=document.getElementById('notebook-captures'),input=document.getElementById('notebook-search'),status=document.getElementById('notebook-status');
  const proof=window.notebookBrowserProof={snapshots:[],inputs:[]};
  const snapshot=()=>({query:input.value,pending:host.getAttribute('aria-busy')==='true',rows:host.children.length,status:status.textContent,
   previousDisabled:document.getElementById('notebook-previous').disabled,nextDisabled:document.getElementById('notebook-next').disabled});
  const observer=new MutationObserver(()=>proof.snapshots.push(snapshot()));
  observer.observe(host,{attributes:true,attributeFilter:['aria-busy'],childList:true});observer.observe(status,{childList:true,subtree:true});
  const recordInput=event=>{
   if(event.target!==input)return;
   const entry={value:input.value,trusted:event.isTrusted,pendingBefore:host.getAttribute('aria-busy')==='true'};proof.inputs.push(entry);
  };
  const recordHandledInput=event=>{if(event.target===input)proof.inputs.at(-1).pendingAfter=host.getAttribute('aria-busy')==='true';};
  document.addEventListener('input',recordInput,true);document.addEventListener('input',recordHandledInput);
  proof.stop=()=>{observer.disconnect();document.removeEventListener('input',recordInput,true);document.removeEventListener('input',recordHandledInput);};
 });
 async function settled(start,end,total){
  await large.waitForFunction(({start,end,total})=>document.getElementById('notebook-captures').getAttribute('aria-busy')==='false'&&
   document.getElementById('notebook-status').textContent===`${start}–${end} / ${total} 条记录`,{start,end,total});
 }
 const keys=()=>large.locator('.notebook-capture').evaluateAll(rows=>rows.map(row=>row.dataset.captureKey));
 await openLibraryTools(large);await large.locator('#open-library-notebook').click();await settled(1,30,6148);
 assert.equal(await large.locator('.notebook-capture').count(),30);
 assert.equal(await large.locator('#title').textContent(),readerTitle);
 assert.ok(await large.evaluate(()=>notebookBrowserProof.snapshots.some(item=>item.query===''&&item.pending)),'opening a large notebook exposes pending work before complete counts');
 const search=large.locator('#notebook-search');await search.focus();
 await search.pressSequentially(supersededQuery);await search.press('ControlOrMeta+A');await search.pressSequentially(finalQuery);
 await settled(1,30,expectedKeys.length);
 const typing=await large.evaluate(()=>notebookBrowserProof.inputs);
 assert.ok(typing.length>=supersededQuery.length+finalQuery.length&&typing.every(item=>item.trusted),'queries are entered by real keyboard events');
 assert.ok(typing.every(item=>item.pendingAfter),'every handled keyboard input synchronously exposes pending state');
 assert.ok(typing.some(item=>item.value===supersededQuery&&item.pendingAfter),'the replaced query starts cooperative work');
 // pendingBefore overlap is recorded but not required: keyboard protocol cadence
 // can legitimately let a short job finish between keys. Deterministic scheduler
 // tests separately prove mid-job supersession; this journey tests real typing.
 assert.ok(typing.some(item=>item.value===finalQuery&&item.pendingAfter),'the complete replacement query starts cooperative work');
 assert.equal(await search.inputValue(),finalQuery);assert.ok(await search.evaluate(node=>node===document.activeElement));
 assert.deepEqual(await keys(),expectedKeys.slice(0,30));
 const seen=await keys();
 await large.locator('#notebook-next').click();await settled(31,60,expectedKeys.length);
 assert.deepEqual(await keys(),expectedKeys.slice(30,60));seen.push(...await keys());
 await large.locator('#notebook-next').click();await settled(61,68,expectedKeys.length);
 assert.deepEqual(await keys(),expectedKeys.slice(60));seen.push(...await keys());
 assert.deepEqual(seen,expectedKeys);assert.equal(new Set(seen).size,68);assert.ok(await large.locator('#notebook-next').isDisabled());
 assert.equal(await large.locator('.notebook-capture').count(),8);assert.equal(await search.inputValue(),finalQuery);
 await large.locator('#notebook-previous').click();await settled(31,60,expectedKeys.length);
 await large.locator('#notebook-previous').click();await settled(1,30,expectedKeys.length);
 assert.deepEqual(await keys(),expectedKeys.slice(0,30));assert.ok(await large.locator('#notebook-previous').isDisabled());
 // Clearing through the keyboard must publish the full count again; no older
 // partial query may replace the restored notebook after it finishes.
 await search.focus();await search.press('ControlOrMeta+A');await search.press('Backspace');await settled(1,30,6148);
 await large.locator('#notebook-next').click();await settled(31,60,6148);
 assert.deepEqual(await keys(),largeDocs[0].segments.slice(30,60).map(cue=>JSON.stringify([largeDocs[0].key,'cue',cue.id])));
 const observation=await large.evaluate(()=>{
  notebookBrowserProof.stop();return {snapshots:notebookBrowserProof.snapshots,input:document.getElementById('notebook-search').value};
 });
 const pendingSnapshots=observation.snapshots.filter(item=>item.pending);
 assert.ok(pendingSnapshots.length>0);
 assert.ok(pendingSnapshots.every(item=>item.rows===0&&item.status.includes('正在查找')&&item.previousDisabled&&item.nextDisabled),'pending work hides old rows and never publishes partial counts');
 assert.ok(observation.snapshots.every(item=>item.rows<=30),'only one bounded notebook page is mounted');
 assert.equal(observation.input,'');assert.equal(await large.locator('#title').textContent(),readerTitle);
 await large.locator('#notebook-close').click();
 assert.equal(external,0);assert.equal(mutations,0);assert.deepEqual(errors,[]);
 console.log('Library notebook: bounded mobile browsing, qualified source, keyboard return, actual full-document export, visible annotation search hits, reordered bookmark return, live bookmark search edits and durable timestamp refresh, Escape/reopen, cooperative open, real typing replacement, complete paged counts and stable late matches passed.');
}finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
