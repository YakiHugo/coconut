/** CI-only Chromium proof for authored reading landmarks. Native clipboard is
 * read only after this isolated CI browser writes its own authored sentinel.
 * There is no clipboard shim, model, external service, recording or user data.
 * A syntax/static check is not a browser pass. Never run this outside CI. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium,expect,waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {openTranscriptTools} from './helpers/reading-tools-browser.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
import {themeTransitionsSettled} from './helpers/theme-transitions.mjs';
import {chapterMarkersFixture,CHAPTER_MARKER_SEARCH,CHAPTER_MARKER_LONG_TITLE} from './helpers/chapter-markers-fixture.mjs';
import {startBridge} from '../desktop/server.mjs';

if(!process.env.CI)throw Error('Chapter landmark browser acceptance is CI-only; use node --check locally.');
const checks=[],errors=[],geometry=[],accessibility=[],screenshots=[];
let browser,server,directory,page,failure=null,stage='setup',external=0,mutations=0,providers=0;
const cueSelector=id=>'#passage-body .passage-original .passage-cue[data-cue-id="'+id+'"]';
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
async function frames(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function activate(selector){await page.locator(selector).waitFor({state:'visible'});await page.locator(selector).evaluate(node=>node.focus({preventScroll:true}));await page.keyboard.press('Enter');}
async function capture(label){
 if(!process.env.COCONUT_UI_SCREENSHOTS)return;
 await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});
 const name='chapter-markers-'+label+'.png';await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,name),fullPage:false,animations:'disabled'});screenshots.push(name);
}
async function saved(){await page.evaluate(()=>libraryStore.flush());return page.evaluate(async()=>{const key=sessionStorage.getItem('coconut-reader-active-v1');return(await readPersistedLibrary()).documents.find(doc=>doc.key===key);});}
async function reveal(selector){
 const owners=await page.locator(selector).evaluate(node=>{const ids=[];for(let n=node.parentElement;n;n=n.parentElement)if(n.tagName==='DETAILS')ids.unshift(n.id);return ids;});
 for(const id of owners){assert.ok(id,'Native disclosure needs an ID');if(!await page.locator('#'+id).evaluate(node=>node.open))await page.locator('#'+id+' > summary').click();}
 await expect(page.locator(selector)).toBeVisible();return owners;
}
async function closeDisclosures(owners){for(const id of [...owners].reverse())if(await page.locator('#'+id).evaluate(node=>node.open))await page.locator('#'+id+' > summary').click();await frames();}
async function directoryOpen(){if(await page.locator('#chapter-dialog').evaluate(node=>node.open))return;await reveal('#open-chapters');await activate('#open-chapters');await expect(page.locator('#chapter-dialog')).toBeVisible();}
async function directoryClose(){if(await page.locator('#chapter-dialog').evaluate(node=>node.open))await activate('#chapter-close');}
async function firstPage(){await directoryClose();await activate('#mode-passages');while(await page.locator('#passage-previous').isEnabled())await activate('#passage-previous');await frames();}
async function position(selector,top=80){await page.locator(selector).first().evaluate((node,top)=>window.scrollBy({top:node.getBoundingClientRect().top-top,left:0,behavior:'instant'}),top);await frames();}
const chapterAction=(id,kind)=>'.chapter-entry[data-chapter-id="'+id+'"] .chapter-'+kind;

// This independent source-order oracle never calls the product's chapter index.
// It checks every mounted row, including absence of false/repeated boundaries.
async function labelsMatch(label,doc){
 const actual=await page.evaluate(()=>{
  const labels=node=>[...node.querySelectorAll(':scope > .reading-chapter-labels > .reading-chapter-label')].map(n=>({id:n.dataset.chapterId,kind:n.dataset.chapterKind,title:n.querySelector('.reading-chapter-title')?.textContent,location:n.querySelector('.reading-chapter-location')?.textContent??null,number:n.querySelector('.reading-chapter-number')?.textContent??null}));
  return {transcript:[...document.querySelectorAll('#transcript .segment')].map(row=>({id:row.dataset.segmentId,labels:labels(row.querySelector('.segment-content'))})),passages:[...document.querySelectorAll('#passage-body .passage')].map(section=>({ids:[...section.querySelectorAll('.passage-original .passage-cue')].map(n=>n.dataset.cueId),labels:labels(section),markers:[...section.querySelectorAll('.passage-original .passage-cue[data-reading-chapter-marker]')].map(n=>({id:n.dataset.cueId,number:n.dataset.readingChapterMarker,description:n.getAttribute('aria-describedby'),target:n.dataset.readingChapterDescription,targetText:document.getElementById(n.dataset.readingChapterDescription)?.querySelector('.reading-chapter-title')?.textContent}))}))};
 });
 const positions=new Map(doc.segments.map((cue,index)=>[cue.id,index]));
 const chapters=doc.reading_chapters.filter(item=>positions.has(item.cue_id)).sort((a,b)=>positions.get(a.cue_id)-positions.get(b.cue_id));
 const at=id=>chapters.findLast(item=>positions.get(item.cue_id)<=positions.get(id));
 const shape=(item,kind)=>({id:item.id,kind,title:item.title,number:kind==='start'?String(chapters.indexOf(item)+1):null});
 function match(actualLabels,expected,where){
  assert.deepEqual(actualLabels.map(({location,...rest})=>rest),expected,where);
  for(const row of actualLabels){const item=chapters.find(item=>item.id===row.id);if(row.kind==='start')assert.ok(row.location?.endsWith(' · 片段 '+(positions.get(item.cue_id)+1)),where+' exact source position');else assert.equal(row.location,null,where+' context cannot claim a boundary');}
 }
 let previous=null;
 for(const row of actual.transcript){const item=at(row.id),start=item?.cue_id===row.id;match(row.labels,item&&(start||item!==previous)?[shape(item,start?'start':'context')]:[],label+' transcript '+row.id);previous=item;}
 for(const [index,section] of actual.passages.entries()){
  const expected=[],context=at(section.ids[0]);if(index===0&&context&&context.cue_id!==section.ids[0])expected.push(shape(context,'context'));
  const starts=chapters.filter(item=>section.ids.includes(item.cue_id));for(const item of starts)expected.push(shape(item,'start'));
  match(section.labels,expected,label+' paragraph '+index);
  assert.deepEqual(section.markers.map(({id,number})=>({id,number})),starts.map(item=>({id:item.cue_id,number:String(chapters.indexOf(item)+1)})),label+' exact inline cue boundaries');
  for(const marker of section.markers){const item=starts.find(item=>item.cue_id===marker.id);assert.ok(marker.description?.split(/\s+/u).includes(marker.target));assert.equal(marker.targetText,item.title);}
 }
 check(label+'_source_order_boundaries_context_and_descriptions_are_exact',true);return actual;
}
async function originalParagraph(label,fixture){
 const source=page.locator('#passage-body .passage-original').first();
 const actual=await source.evaluate(node=>({text:node.textContent,tag:node.tagName,children:[...node.childNodes].map(n=>({type:n.nodeType,tag:n.tagName??null,text:n.textContent,id:n.nodeType===1?n.dataset.cueId:null,count:n.childNodes.length})),ids:[...node.querySelectorAll('.passage-cue')].map(n=>n.dataset.cueId)}));
 assert.deepEqual(actual.ids,Array.from({length:8},(_,i)=>'c'+i));assert.equal(actual.tag,'P');assert.equal(actual.text,fixture.segments.slice(0,8).map(cue=>cue.text).join(' '));
 assert.equal(actual.children.length,15);
 for(const [index,node] of actual.children.entries()){if(index%2)assert.deepEqual(node,{type:3,tag:null,text:' ',id:null,count:0});else assert.deepEqual(node,{type:1,tag:'SPAN',text:fixture.segments[index/2].text,id:'c'+index/2,count:1});}
 const bounds=await page.locator('#passage-body .passage').first().evaluate(section=>({section:section.getBoundingClientRect().toJSON(),source:section.querySelector('.passage-original').getBoundingClientRect().toJSON(),labels:[...section.querySelectorAll('.reading-chapter-label')].map(node=>({id:node.dataset.chapterId,rect:node.getBoundingClientRect().toJSON(),text:node.querySelector('.reading-chapter-title').textContent,overflow:getComputedStyle(node.querySelector('.reading-chapter-title')).textOverflow})),markers:[...section.querySelectorAll('.passage-original [data-reading-chapter-marker]')].map(node=>({id:node.dataset.cueId,content:getComputedStyle(node,'::before').content,userSelect:getComputedStyle(node,'::before').userSelect,rects:[...node.getClientRects()].map(r=>r.toJSON())})),viewport:innerWidth,documentWidth:document.documentElement.scrollWidth}));
 geometry.push({label,...bounds});check(label+'_has_one_untouched_c0_c7_paragraph',true);
 check(label+'_titles_are_outside_prose_without_horizontal_overflow',bounds.documentWidth<=bounds.viewport&&bounds.labels.every(row=>row.rect.left>=0&&row.rect.right<=bounds.viewport&&row.rect.bottom<=bounds.source.top+1&&row.overflow!=='ellipsis'));
 check(label+'_native_generated_cue_numbers_are_visible_and_unselectable',bounds.markers.length===2&&bounds.markers.every(row=>row.userSelect==='none'&&row.content.includes('[')&&row.content.includes(']')&&row.rects.some(r=>r.width>0&&r.height>0)));
}
async function nativeSelection(fixture){
 const expected=fixture.segments[1].text.slice(4)+' '+fixture.segments.slice(2,6).map(cue=>cue.text).join(' ')+' '+fixture.segments[6].text.slice(0,9);
 const result=await page.evaluate(()=>{
  const paragraph=document.querySelector('#passage-body .passage-original'),cues=paragraph.querySelectorAll('.passage-cue');
  const range=document.createRange();range.setStart(cues[1].firstChild,4);range.setEnd(cues[6].firstChild,9);
  const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
  const doc=state.documents.find(doc=>doc.key===sessionStorage.getItem('coconut-reader-active-v1'));
  const model=CoconutQuotation.compose([...cues].map(node=>doc.segments.find(cue=>cue.id===node.dataset.cueId)),CoconutPassages.separator);
  const quote=CoconutQuotation.domSelection(paragraph,model,selection);
  return {selection:selection.toString(),range:range.toString(),quote:quote.text,parts:quote.parts.map(part=>({id:part.cue.id,from:part.from,to:part.to})),rects:[...range.getClientRects()].map(rect=>rect.toJSON())};
 });
 assert.equal(result.selection,expected,'Native selection must never include generated numbers or chapter titles');assert.equal(result.range,expected);assert.equal(result.quote,expected,'Strict, unmodified quotation.domSelection must accept the real paragraph');
 assert.deepEqual(result.parts.map(part=>part.id),['c1','c2','c3','c4','c5','c6']);geometry.push({label:stage+'-native-cross-chapter-selection',...result});await frames();return expected;
}
async function accessibleCue(label,id,title,fullParagraph){
 const cdp=await page.context().newCDPSession(page);
 try{
  await cdp.send('Accessibility.enable');const document=await cdp.send('DOM.getDocument');const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:document.root.nodeId,selector:cueSelector(id)});assert.ok(nodeId);
  const {node}=await cdp.send('DOM.describeNode',{nodeId});const {nodes}=await cdp.send('Accessibility.getFullAXTree');const ax=nodes.find(item=>item.backendDOMNodeId===node.backendNodeId);assert.ok(ax,'Actual marked source cue has an AX node');
  const byId=new Map(nodes.map(item=>[item.nodeId,item])),descendants=[];const visit=item=>{if(!item)return;descendants.push(item);for(const child of item.childIds||[])visit(byId.get(child));};visit(ax);
  const names=descendants.filter(item=>!item.ignored).map(item=>({role:item.role?.value,name:item.name?.value??'',description:item.description?.value??''}));
  const descriptions=names.map(item=>item.description).join(' '),spoken=names.map(item=>item.name).join(' ');
  const evidence={label,cue:id,ignored:ax.ignored,role:ax.role?.value,name:ax.name?.value,description:ax.description?.value,descendants:names};accessibility.push(evidence);
  check(label+'_'+id+'_real_accessibility_tree_describes_actual_chapter_title',!ax.ignored&&descriptions.includes(title));
  check(label+'_'+id+'_generated_number_is_silent_and_paragraph_is_not_renamed',!names.some(item=>/^\s*\[?\d+\]?\s*$/u.test(item.name))&&!/\[\d+\]/u.test(spoken)&&!names.some(item=>item.name===fullParagraph||item.description.includes(fullParagraph)));
  // Inspect the entire source paragraph as well: a browser must not expose a
  // generated number as a sibling of the cue rather than its descendant.
  const paragraphQuery=await cdp.send('DOM.querySelector',{nodeId:document.root.nodeId,selector:'#passage-body .passage-original'});
  const paragraphDOM=await cdp.send('DOM.describeNode',{nodeId:paragraphQuery.nodeId});const paragraphAX=nodes.find(item=>item.backendDOMNodeId===paragraphDOM.node.backendNodeId);assert.ok(paragraphAX);
  descendants.length=0;visit(paragraphAX);const paragraphNames=descendants.filter(item=>!item.ignored).map(item=>({role:item.role?.value,name:item.name?.value??''}));
  evidence.paragraph=paragraphNames;check(label+'_'+id+'_whole_paragraph_accessibility_tree_has_no_generated_number',!paragraphNames.some(item=>/^\s*\[?\d+\]?\s*$/u.test(item.name)||/\[\s*\d+\s*\]/u.test(item.name)));
  const sourceText=await page.locator(cueSelector(id)).textContent();check(label+'_'+id+'_source_is_exposed_once_as_static_text',nodes.filter(item=>!item.ignored&&item.role?.value==='StaticText'&&item.name?.value===sourceText).length===1);
 }finally{await cdp.detach();}
}
async function rememberIdentity(){await page.evaluate(()=>{
 window.__chapterIdentity={cues:[...document.querySelectorAll('#passage-body .passage-original .passage-cue')],rows:[...document.querySelectorAll('#transcript .segment')],paragraphs:[...document.querySelectorAll('#passage-body .passage-original')].map(node=>({node,children:[...node.childNodes]})),player:document.querySelector('#source-media audio')};
});}
async function identity(label){const proof=await page.evaluate(()=>{const saved=window.__chapterIdentity;return {cues:saved.cues.every(node=>node.isConnected&&document.querySelector('#passage-body .passage-original .passage-cue[data-cue-id="'+node.dataset.cueId+'"]')===node),rows:saved.rows.every(node=>node.isConnected),paragraphs:saved.paragraphs.every(({node,children})=>node.isConnected&&children.length===node.childNodes.length&&children.every((child,index)=>child===node.childNodes[index])),player:saved.player===document.querySelector('#source-media audio'),paused:saved.player.paused,time:saved.player.currentTime,plays:window.__chapterAudit.plays};});check(label+'_preserves_original_cue_children_rows_and_paused_player_identity',proof.cues&&proof.rows&&proof.paragraphs&&proof.player&&proof.paused&&proof.time===0&&proof.plays===0);}
async function installReceiptAudit(){await page.evaluate(()=>{
 const adapter=CoconutStorageBootstrap.result.adapter,write=adapter.write.bind(adapter);window.__chapterWrites={hold:false,pending:[]};
 adapter.write=(...args)=>window.__chapterWrites.hold?new Promise((resolve,reject)=>window.__chapterWrites.pending.push(()=>write(...args).then(resolve,reject))):write(...args);
 window.__releaseChapterWrites=async()=>{window.__chapterWrites.hold=false;await Promise.all(window.__chapterWrites.pending.splice(0).map(release=>release()));};
 for(const method of ['scrollTo','scrollBy']){const original=window[method];window[method]=function(...args){window.__chapterAudit.scrolls.push({method});return original.apply(this,args);};}
 const into=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(...args){window.__chapterAudit.scrolls.push({method:'scrollIntoView',id:this.id});return into.apply(this,args);};
});}
async function receiptSnapshot(){return page.evaluate(()=>({scrollY,top:document.querySelector('#passage-body .passage-original').getBoundingClientRect().top,focus:document.activeElement.id,page:document.querySelector('#passage-page-status').textContent}));}
async function readingState(){return page.evaluate(()=>({mode:document.body.dataset.readingMode,bilingual:document.getElementById('mode-bilingual').getAttribute('aria-pressed'),query:document.getElementById('search').value,rows:[...document.querySelectorAll('#transcript .segment')].map(row=>row.dataset.segmentId),page:document.getElementById('passage-page-status').textContent,paragraphs:[...document.querySelectorAll('#passage-body .passage')].map(node=>node.dataset.passageId)}));}

try{
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-chapter-markers-'));const audio=path.join(directory,'authored-tone.wav');await fs.writeFile(audio,authoredAudioFixture());
 server=await startBridge({port:0,providers:{status:async()=>({ready:false,reason:'Authored chapter landmarks; no CLI or model'}),exclusive:async action=>action(),structured:async()=>{providers++;throw Error('Unexpected model call');},ask:async()=>{providers++;throw Error('Unexpected model call');}}});
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 for(const [label,viewport] of [['desktop',{width:1360,height:1000}],['mobile',{width:390,height:844}]]){
  stage=label+' setup';const context=await browser.newContext({viewport,serviceWorkers:'block'});
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin});
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(!['GET','HEAD'].includes(request.method())){mutations++;await route.abort();}else if(url.origin===origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
  await context.addInitScript(()=>{window.__chapterAudit={plays:0,copy:[],scrolls:[]};document.addEventListener('play',event=>{if(event.target instanceof HTMLMediaElement)window.__chapterAudit.plays++;},true);document.addEventListener('copy',event=>queueMicrotask(()=>window.__chapterAudit.copy.push({trusted:event.isTrusted,prevented:event.defaultPrevented})),true);});
  page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push({label,message:error.message,stack:error.stack}));await page.goto(origin);
  const fixture=chapterMarkersFixture(label);await page.locator('#library-file').setInputFiles({name:'authored-chapter-markers.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'coconut-library',version:1,documents:[fixture],active:fixture.key}))});
  await page.waitForFunction(title=>document.getElementById('title').textContent===title&&document.getElementById('library-file').value==='',fixture.title);
  await waitForPersistedLibrary(page,async key=>(await readPersistedLibrary()).documents.some(doc=>doc.key===key&&doc.reading_chapters?.length===6),fixture.key);
  check(label+'_commits_authored_fixture_to_real_indexeddb',await page.evaluate(()=>CoconutStorageBootstrap.result.backend==='indexeddb'));
  if(!await page.locator('#attach-reader-media').isVisible())await activate('#toggle-reader-media');
  const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);await chooser.setFiles(audio);
  await page.waitForFunction(()=>{const player=document.querySelector('#source-media audio');return player&&!player.error&&player.readyState>=2;});await activate('#close-reader-media');
  const initial=await saved();await firstPage();
  stage=label+' real unchanged paragraph';await position('#passage-body .passage');await originalParagraph(label,fixture);await labelsMatch(label+'_initial',initial);await capture(label+'-real-paragraph');
  const firstLabels=page.locator('#passage-body .passage').first().locator('.reading-chapter-label');assert.deepEqual(await firstLabels.evaluateAll(nodes=>nodes.map(n=>n.dataset.chapterId)),['first','second']);
  check(label+'_two_equal_time_chapters_are_inside_one_original_paragraph',await page.locator(cueSelector('c2')).getAttribute('data-reading-chapter-marker')==='1'&&await page.locator(cueSelector('c5')).getAttribute('data-reading-chapter-marker')==='2');
  check(label+'_empty_id_has_its_own_boundary_without_timestamp_guessing',await page.locator(cueSelector('')).getAttribute('data-reading-chapter-marker')==='3'&&await page.locator('#passage-body [data-chapter-id="missing"]').count()===0&&await page.locator(cueSelector('c0')).getAttribute('data-reading-chapter-marker')===null);
  check(label+'_landmarks_never_decorate_translation_cues',await page.locator('.passage-translation [data-reading-chapter-marker],.passage-translation .reading-chapter-label').count()===0);
  const fullParagraph=fixture.segments.slice(0,8).map(cue=>cue.text).join(' ');await accessibleCue(label,'c2',fixture.reading_chapters.find(c=>c.id==='first').title,fullParagraph);await accessibleCue(label,'c5',CHAPTER_MARKER_LONG_TITLE,fullParagraph);

  stage=label+' actual native cross-chapter copy';await page.evaluate(()=>navigator.clipboard.writeText('AUTHORED_COCONUT_CHAPTER_COPY_SENTINEL'));
  const expected=await nativeSelection(fixture);await capture(label+'-native-cross-chapter-selection');await page.keyboard.press('Control+c');
  await expect.poll(()=>page.evaluate(()=>window.__chapterAudit.copy.length)).toBe(1);
  const copied=await page.evaluate(()=>navigator.clipboard.readText());assert.equal(copied,expected,'Actual native clipboard must exclude chapter labels AND generated numbers');
  check(label+'_trusted_default_browser_copy_is_exact_without_clipboard_mock',await page.evaluate(()=>window.__chapterAudit.copy[0].trusted&&!window.__chapterAudit.copy[0].prevented));
  stage=label+' strict native quotation save';await page.locator('#passage-body .passage').first().locator('.passage-quote').click();await expect(page.locator('#quotation-dialog')).toBeVisible();await expect(page.locator('#quotation-selector')).toBeHidden();
  assert.equal(await page.locator('#quotation-original-text').inputValue(),expected);check(label+'_native_range_enters_ready_quotation_without_picker_fallback',(await page.locator('#quotation-preview').inputValue()).startsWith(expected+'\n\n'));
  await activate('#quotation-save');await expect(page.locator('#quotation-save-status')).toContainText('已保存到本机');
  const quoted=await saved(),record=quoted.exact_excerpts.find(item=>item.text===expected);assert.ok(record?.snapshot);assert.equal(quoted.exact_excerpts.length,1);
  assert.deepEqual(record.snapshot.cues.map(cue=>[cue.id,cue.text]),fixture.segments.slice(0,8).map(cue=>[cue.id,cue.text]));assert.deepEqual(record.snapshot.separators,Array(7).fill(' '));assert.equal(record.snapshot.from,fixture.segments[0].text.length+1+4);assert.equal(record.snapshot.to,fixture.segments.slice(0,6).map(cue=>cue.text).join(' ').length+1+9);
  assert.deepEqual(quoted.segments,initial.segments);assert.deepEqual(quoted.reading_chapters,initial.reading_chapters);check(label+'_exact_native_selection_is_durable_with_original_snapshot',true);
  await page.keyboard.press('Escape');await expect(page.locator('#quotation-dialog')).toBeHidden();await page.evaluate(()=>getSelection().removeAllRanges());

  stage=label+' passage pagination and search round trip';await activate('#passage-next');const pageTwo=await labelsMatch(label+'_passage_page_two',await saved());
  assert.equal(pageTwo.passages[0].ids[0],'c64');assert.deepEqual(pageTwo.passages[0].labels.map(row=>[row.id,row.kind]),[['empty','context']]);check(label+'_continued_page_starts_with_owning_chapter_context',true);
  const prior=await readingState();await position('#passage-body .passage-original');const beforeSearch=await receiptSnapshot();
  await activate('#passage-search');await openTranscriptTools(page);await page.locator('#search').fill(CHAPTER_MARKER_SEARCH);await page.waitForFunction(()=>document.querySelectorAll('#transcript .segment').length===18);await labelsMatch(label+'_filtered_search',await saved());
  await activate('#mode-bilingual');await labelsMatch(label+'_filtered_bilingual',await saved());await activate('#return-before-search');await expect(page.locator('#reading-search-session')).toBeHidden();
  const returned=await readingState();for(const property of ['mode','query','page','paragraphs'])assert.deepEqual(returned[property],prior[property],label+' search return '+property);
  assert.equal((await saved()).translation_view,'zh','Returning to reading preserves the newer explicit bilingual choice');await frames();const afterSearch=await receiptSnapshot();geometry.push({label:label+'-search-round-trip',before:beforeSearch,after:afterSearch});check(label+'_search_returns_to_same_passage_page_and_viewport',Math.abs(afterSearch.top-beforeSearch.top)<3);await labelsMatch(label+'_after_search_return',await saved());
  await activate('#mode-transcript');await openTranscriptTools(page);if(await page.locator('#clear-search').isVisible())await activate('#clear-search');while(await page.locator('#previous-page').isEnabled())await activate('#previous-page');await labelsMatch(label+'_sentence_mode',await saved());
  await activate('#next-page');const transcriptTwo=await labelsMatch(label+'_sentence_page_two',await saved());assert.equal(transcriptTwo.transcript[0].id,'c100');assert.deepEqual(transcriptTwo.transcript[0].labels.map(row=>[row.id,row.kind]),[['middle','context']]);
  await activate('#mode-bilingual');await labelsMatch(label+'_bilingual_page_two',await saved());await page.locator('#filter-excerpts').click();await labelsMatch(label+'_excerpt_filtered_bilingual',await saved());await page.locator('#filter-excerpts').click();
  await page.locator('#search').fill('ChapterOnlyNeedle');await page.waitForFunction(()=>document.querySelectorAll('#transcript .segment').length===0);check(label+'_manual_titles_do_not_become_original_search_text',true);await activate('#clear-search');await firstPage();

  stage=label+' keyboard chapter edits preserve source and player';await rememberIdentity();await directoryOpen();check(label+'_missing_anchor_stays_unavailable_without_guessing',await page.locator(chapterAction('missing','open')).isDisabled());await activate('#chapter-add');await expect(page.locator('#chapter-title')).toBeFocused();await page.locator('#chapter-title').fill('Temporary authored boundary');await page.keyboard.press('Tab');await expect(page.locator('#chapter-cue-number')).toBeFocused();await page.locator('#chapter-cue-number').fill('5');await page.keyboard.press('Tab');await expect(page.locator('#chapter-save')).toBeFocused();await page.keyboard.press('Enter');await expect(page.locator('#chapter-editor')).toBeHidden();
  let current=await saved();const temporary=current.reading_chapters.find(item=>item.cue_id==='c4');assert.ok(temporary);await identity(label+'_create');await labelsMatch(label+'_create',current);
  await activate(chapterAction(temporary.id,'relocate'));await expect(page.locator('#chapter-cue-number')).toBeFocused();await page.locator('#chapter-cue-number').fill('7');await page.keyboard.press('Tab');await expect(page.locator('#chapter-save')).toBeFocused();await page.keyboard.press('Enter');await expect(page.locator('#chapter-editor')).toBeHidden();current=await saved();assert.equal(current.reading_chapters.find(item=>item.id===temporary.id).cue_id,'c6');await identity(label+'_relocate');await labelsMatch(label+'_relocate',current);
  await activate(chapterAction(temporary.id,'remove'));current=await saved();assert.equal(current.reading_chapters.length,6);await identity(label+'_remove');await labelsMatch(label+'_remove',current);
  await installReceiptAudit();await page.evaluate(()=>{window.__chapterWrites.hold=true;});await activate(chapterAction('first','rename'));await expect(page.locator('#chapter-title')).toBeFocused();const renamed='第一章 · Keyboard renamed precise boundary';await page.locator('#chapter-title').fill(renamed);await page.keyboard.press('Tab');await expect(page.locator('#chapter-cue-number')).toBeFocused();assert.equal(await page.locator('#chapter-cue-number').inputValue(),'3');check(label+'_rename_does_not_relocate_equal_time_anchor',await page.locator('#chapter-cue-number').evaluate(node=>node.readOnly));await page.keyboard.press('Tab');await expect(page.locator('#chapter-save')).toBeFocused();await page.keyboard.press('Enter');await expect(page.locator('#chapter-editor')).toBeHidden();await page.waitForFunction(()=>window.__chapterWrites.pending.length>0);await identity(label+'_rename_pending');
  const pending=await page.evaluate(async()=>{const key=sessionStorage.getItem('coconut-reader-active-v1');return(await readPersistedLibrary()).documents.find(doc=>doc.key===key);});assert.notEqual(pending.reading_chapters.find(item=>item.id==='first').title,renamed);check(label+'_held_receipt_does_not_fake_committed_chapter_title',true);
  await directoryClose();await position('#passage-body .passage-original');await page.locator('#passage-body').evaluate(node=>node.focus({preventScroll:true}));await frames();const beforeReceipt=await receiptSnapshot();
  await page.evaluate(()=>{window.__chapterReceiptLabels=[...document.querySelectorAll('.reading-chapter-labels')];window.__chapterAudit.scrolls=[];});await page.evaluate(()=>window.__releaseChapterWrites());current=await saved();await frames();const afterReceipt=await receiptSnapshot();const receipt=await page.evaluate(()=>({calls:window.__chapterAudit.scrolls,labels:window.__chapterReceiptLabels.every(node=>node.isConnected)}));geometry.push({label:label+'-real-indexeddb-save-receipt',before:beforeReceipt,after:afterReceipt,...receipt});assert.equal(current.reading_chapters.find(item=>item.id==='first').title,renamed);assert.deepEqual(afterReceipt,beforeReceipt);check(label+'_real_save_receipt_never_scrolls_refocuses_or_rebuilds_labels',receipt.calls.length===0&&receipt.labels);await identity(label+'_rename_committed');await labelsMatch(label+'_renamed',current);

  stage=label+' appearance and long title wrapping';const owners=await reveal('#reading-layout');const beforeSize=await page.locator('#passage-body .passage-original').first().evaluate(node=>parseFloat(getComputedStyle(node).fontSize));await page.locator('#reading-layout').selectOption('large');await page.locator('#reading-theme').selectOption('dark');await closeDisclosures(owners);await page.waitForFunction(themeTransitionsSettled,['.reading-chapter-label','.passage-original']);await position('#passage-body .passage');await originalParagraph(label+'_large_dark',fixture);await identity(label+'_appearance');
  const afterSize=await page.locator('#passage-body .passage-original').first().evaluate(node=>parseFloat(getComputedStyle(node).fontSize));check(label+'_large_type_and_dark_theme_are_real_product_settings',afterSize>beforeSize&&await page.locator('html').getAttribute('data-reader-theme')==='dark');await labelsMatch(label+'_large_dark',current);
  const long=page.locator('#passage-body .reading-chapter-label[data-chapter-id="second"] .reading-chapter-title');assert.equal(await long.textContent(),CHAPTER_MARKER_LONG_TITLE);await position('#passage-body .reading-chapter-label[data-chapter-id="second"]');
  const titleGeometry=await long.evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);const style=getComputedStyle(node);return {text:node.textContent,rect:node.getBoundingClientRect().toJSON(),lines:[...range.getClientRects()].map(r=>r.toJSON()),whiteSpace:style.whiteSpace,overflow:style.textOverflow,viewport:innerWidth,documentWidth:document.documentElement.scrollWidth};});geometry.push({label:label+'-complete-long-title',...titleGeometry});check(label+'_complete_long_title_wraps_inside_viewport',titleGeometry.documentWidth<=titleGeometry.viewport&&titleGeometry.rect.left>=0&&titleGeometry.rect.right<=titleGeometry.viewport&&titleGeometry.overflow!=='ellipsis'&&(label!=='mobile'||titleGeometry.lines.length>1));await capture(label+'-long-title-large-dark');
  await position('#passage-body .passage');await nativeSelection(fixture);await capture(label+'-large-dark-native-selection');await page.evaluate(()=>getSelection().removeAllRanges());
  const final=await saved();assert.deepEqual(final.segments,initial.segments);assert.deepEqual(final.notes,initial.notes);assert.equal(final.readingPosition,initial.readingPosition);assert.equal(final.exact_excerpts[0].text,expected);assert.deepEqual(final.reading_chapters,current.reading_chapters);check(label+'_chapters_appearance_and_quote_leave_source_and_reading_position_intact',true);
  await context.close();page=null;
 }
 check('no_external_requests_model_calls_http_mutations_or_browser_errors',external===0&&mutations===0&&providers===0&&errors.length===0);
 console.log(JSON.stringify({suite:'chapter-markers',status:'passed',checks,geometry,accessibility,screenshots}));
}catch(error){
 const probe=await page?.evaluate(()=>({mode:document.body.dataset.readingMode,query:document.getElementById('search')?.value,dialogs:[...document.querySelectorAll('dialog[open]')].map(n=>n.id),active:document.activeElement?.outerHTML,save:document.getElementById('save-status')?.textContent,chapterStatus:document.getElementById('chapter-editor-status')?.textContent,quotationStatus:document.getElementById('quotation-status')?.textContent,paragraphs:[...document.querySelectorAll('#passage-body .passage')].map(n=>({id:n.dataset.passageId,labels:[...n.querySelectorAll('.reading-chapter-label')].map(l=>({id:l.dataset.chapterId,kind:l.dataset.chapterKind,text:l.textContent}))})),audit:window.__chapterAudit})).catch(()=>null);
 if(page&&!page.isClosed())await capture('failure').catch(()=>{});
 failure={probe,error:{message:error.message,stack:error.stack}};console.error(JSON.stringify({suite:'chapter-markers',status:'failed',stage,checks,geometry,accessibility,screenshots,...failure,errors,external,mutations,providers}));process.exitCode=1;
}finally{
 if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'chapter-markers-checks.json'),JSON.stringify({suite:'chapter-markers',status:failure?'failed':'passed',stage,checks,geometry,accessibility,screenshots,errors,external,mutations,providers,...failure},null,2));}
 await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());if(directory)await fs.rm(directory,{recursive:true,force:true});
}
