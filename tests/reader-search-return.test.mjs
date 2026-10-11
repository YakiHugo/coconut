import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
import {settle} from './helpers/save-pipeline.mjs';
function setup(cues=1000){
 const docs=largeLibraryFixture(1,{cues});docs[0].readingPosition=docs[0].segments[19].id;
 const h=libraryHarness(docs,{probe:true});h.scrolls=[];h.plays=0;
 h.w.scrollBy=(...args)=>h.scrolls.push(['by',...args]);h.w.scrollTo=(...args)=>h.scrolls.push(['to',...args]);
 h.w.HTMLElement.prototype.scrollIntoView=function(options){h.scrolls.push(['node',this.dataset.cueId||this.dataset.segmentId||this.dataset.firstCueId,options]);};
 h.w.HTMLMediaElement.prototype.play=async()=>{h.plays++;};return h;
}
const cue=(h,id)=>h.$('transcript').querySelector(`[data-segment-id="${id}"]`);
const doc=h=>h.w.libraryProbe.documents[0];
function visible(h,id,top=80){const selector=h.w.document.body.dataset.readingMode==='passages'?'#passage-body .passage-original .passage-cue':'#transcript .segment';for(const node of h.w.document.querySelectorAll(selector))node.getBoundingClientRect=()=>({top:(node.dataset.cueId||node.dataset.segmentId)===id?top:2000,bottom:(node.dataset.cueId||node.dataset.segmentId)===id?top+30:2030});}
function start(h){const {$}=h;$('mode-passages').click();for(let i=0;i<5;i++)$('passage-next').click();const id=$('passage-body').querySelectorAll('.passage-original .passage-cue')[3].dataset.cueId;visible(h,id);$('passage-search').click();return id;}
function search(h,query='source sentence 900.') {h.$('search').value=query;h.$('search').oninput();}
const tick=async()=>{await settle();await new Promise(resolve=>setTimeout(resolve,0));};

test('passage Find enters at the visible source cue and cancel restores its exact original layout and viewport without writes',async()=>{
 const h=setup();try{const before=JSON.stringify(doc(h)),origin=start(h);assert.ok(cue(h,origin));assert.equal(h.$('reading-search-session').hidden,false);assert.equal(h.w.document.activeElement,h.$('search'));
 search(h);h.$('next-match').click();h.scrolls=[];h.$('return-before-search').click();
 assert.equal(h.w.document.body.dataset.readingMode,'passages');assert.ok(h.$('passage-body').querySelector(`[data-cue-id="${origin}"]`));assert.equal(h.w.document.activeElement.dataset.cueId,origin);assert.equal(h.$('reading-search-session').hidden,true);assert.equal(JSON.stringify(doc(h)),before);assert.equal(h.plays,0);assert.ok(h.scrolls.some(item=>item[0]==='by'));
 }finally{await h.w.happyDOM.close();}
});
test('direct transcript search remembers a late filtered page and keeps later note and bookmark changes',async()=>{
 const h=setup();try{const {$}=h;$('mode-transcript').click();for(const s of doc(h).segments)s.saved_excerpt=true;$('filter-excerpts').click();for(let i=0;i<5;i++)$('next-page').click();visible(h,'shelf-0-cue-550');$('search').focus();search(h);$('next-match').click();
 doc(h).notes['shelf-0-cue-900']='Keep my new thought';doc(h).readingPosition='shelf-0-cue-901';$('return-before-search').click();
 assert.equal(h.w.document.body.dataset.readingMode,'transcript');assert.equal($('filter-excerpts').getAttribute('aria-pressed'),'true');assert.equal($('search').value,'');assert.equal(h.w.document.activeElement.dataset.segmentId,'shelf-0-cue-550');assert.equal(doc(h).readingPosition,'shelf-0-cue-901');assert.equal(doc(h).notes['shelf-0-cue-900'],'Keep my new thought');assert.equal(h.plays,0);
 }finally{await h.w.happyDOM.close();}
});
test('clear filters stays with the current match and continuing ends the search detour at that source',async()=>{
 const h=setup();try{const {$}=h;start(h);search(h);$('next-match').click();$('clear-search').click();assert.ok(cue(h,'shelf-0-cue-900'));assert.equal($('search').value,'');assert.equal(h.w.document.activeElement.dataset.segmentId,'shelf-0-cue-900');assert.equal($('reading-search-session').hidden,false);
 $('continue-search-reading').click();assert.equal(h.w.document.body.dataset.readingMode,'passages');assert.ok($('passage-body').querySelector('[data-cue-id="shelf-0-cue-900"]'));assert.equal($('reading-search-session').hidden,true);assert.equal($('reading-context').hidden,true);assert.equal(doc(h).readingPosition,'shelf-0-cue-19');
 }finally{await h.w.happyDOM.close();}
});
test('continue from a searched result has a separate outcome from returning to original reading',async()=>{
 const h=setup();try{const {$}=h;start(h);search(h);$('next-match').click();$('continue-search-reading').click();assert.ok($('passage-body').querySelector('[data-cue-id="shelf-0-cue-900"]'));assert.equal($('search').value,'');assert.equal($('reading-context').hidden,true);assert.equal($('reading-search-session').hidden,true);assert.equal(h.plays,0);
 }finally{await h.w.happyDOM.close();}
});
test('no matches can return to the original reading and cannot claim a current result to continue',async()=>{
 const h=setup();try{const {$}=h,origin=start(h);search(h,'not present anywhere');assert.equal($('continue-search-reading').disabled,true);$('return-before-search').click();assert.ok($('passage-body').querySelector(`[data-cue-id="${origin}"]`));assert.equal(h.w.document.body.dataset.readingMode,'passages');
 }finally{await h.w.happyDOM.close();}
});
test('existing result to context to passages and note return remains nested inside the original reading return',async()=>{
 const h=setup();try{const {$}=h,origin=start(h);search(h);$('next-match').click();cue(h,'shelf-0-cue-900').querySelector('.context-button').click();$('mode-passages').click();const section=$('passage-body').querySelector('[data-cue-id="shelf-0-cue-900"]').closest('.passage');const noteId=section.dataset.firstCueId;section.querySelector('.passage-details').click();cue(h,noteId).querySelector('.note-button').click();$('note').value='Nested thought';$('note').oninput();$('return-to-passages').click();$('return-reading-results').click();assert.equal($('search').value,'source sentence 900.');assert.equal($('reading-search-session').hidden,false);$('return-before-search').click();assert.ok($('passage-body').querySelector(`[data-cue-id="${origin}"]`));assert.equal(doc(h).notes[noteId],'Nested thought');
 }finally{await h.w.happyDOM.close();}
});
for(const action of ['summary','add','different-document','replacement'])test(`new ${action} navigation retires the origin and cannot later restore it`,async()=>{
 const h=setup();try{const {$,w}=h;start(h);search(h);
 if(action==='summary')$('mode-summary').click();else if(action==='add')$('add-content').click();else if(action==='replacement'){w.libraryProbe.documents.splice(0,1,{...doc(h),segments:doc(h).segments.map(s=>({...s}))});w.libraryProbe.render();}else{const newer=largeLibraryFixture(2,{cues:30})[1];w.libraryProbe.documents.push(newer);w.libraryProbe.renderLibrary();w.document.querySelector(`[data-document-key="${newer.key}"] .library-open`).click();}
 const before=JSON.stringify(w.libraryProbe.documents),mode=w.document.body.dataset.readingMode,focus=w.document.activeElement;h.scrolls=[];$('return-before-search').click();assert.equal($('reading-search-session').hidden,true);assert.equal(JSON.stringify(w.libraryProbe.documents),before);assert.equal(w.document.body.dataset.readingMode,mode);assert.equal(w.document.activeElement,focus);assert.equal(h.scrolls.length,0);
 }finally{await h.w.happyDOM.close();}
});
test('a removed or replaced original cue is never guessed from its old ID or numeric index',async()=>{
 for(const replacement of [false,true]){const h=setup();try{const {$}=h,origin=start(h),i=doc(h).segments.findIndex(s=>s.id===origin);search(h);$('next-match').click();doc(h).segments.splice(i,1,...(replacement?[{...doc(h).segments[i]}]:[]));h.w.libraryProbe.render();h.scrolls=[];assert.equal($('return-before-search').disabled,true);$('return-before-search').click();assert.equal(h.scrolls.length,0);assert.match($('reading-search-status').textContent,/原位置.*不可用|原片段.*变化/);assert.ok(cue(h,'shelf-0-cue-900'));
 }finally{await h.w.happyDOM.close();}}
});
test('a corrected original cue returns to its current text without reusing stale pixel geometry',async()=>{
 const h=setup();try{const {$}=h,origin=start(h);search(h);doc(h).segments.find(s=>s.id===origin).text='Corrected while searching';h.w.Coconut.invalidateSearch(doc(h));h.w.libraryProbe.render();h.scrolls=[];$('return-before-search').click();assert.equal(h.w.document.activeElement.dataset.cueId,origin);assert.equal(h.w.document.activeElement.textContent,'Corrected while searching');assert.equal(h.scrolls.some(item=>item[0]==='by'),false);assert.match($('notice').textContent,/已变化|已修正/);
 }finally{await h.w.happyDOM.close();}
});
test('a note removed from the original filter restores the filter truthfully without a guessed source location',async()=>{
 const h=setup();try{const {$}=h;doc(h).notes['shelf-0-cue-70']='Original thought';$('mode-transcript').click();$('filter-notes').click();$('search').focus();search(h,'missing');doc(h).notes['shelf-0-cue-70']='';h.scrolls=[];$('return-before-search').click();assert.equal($('filter-notes').getAttribute('aria-pressed'),'true');assert.equal($('transcript').querySelectorAll('.segment').length,0);assert.equal(h.w.document.activeElement,$('search'));assert.equal(h.scrolls.length,0);assert.equal($('reading-search-session').hidden,true);
 }finally{await h.w.happyDOM.close();}
});
test('query changes, repeated Find, and delayed save receipts retain the first origin without background scrolling',async()=>{
 const h=setup();try{const {$,w}=h,origin=start(h);search(h);$('passage-search').onclick();search(h,'source sentence 800.');$('next-match').click();h.pipeline.hold();cue(h,'shelf-0-cue-800').querySelector('.note-button').click();$('note').value='Slow save';$('note').oninput();void w.flushContentForTest();await settle();h.scrolls=[];const focus=w.document.activeElement;h.pipeline.writes[0].commit();await tick();assert.equal(h.scrolls.length,0);assert.equal(w.document.activeElement,focus);$('return-before-search').click();assert.equal(w.document.activeElement.dataset.cueId,origin);assert.equal(doc(h).notes['shelf-0-cue-800'],'Slow save');
 }finally{await h.w.happyDOM.close();}
});
test('large transcript searching and returning keeps bounded result and passage DOM',async()=>{
 const h=setup(50000);try{const {$}=h,origin=start(h);search(h,'source sentence 49999.');$('next-match').click();assert.equal($('transcript').querySelectorAll('.segment').length,1);$('clear-search').click();assert.ok(cue(h,'shelf-0-cue-49999'));assert.ok($('transcript').querySelectorAll('.segment').length<=100);$('return-before-search').click();assert.equal(h.w.document.activeElement.dataset.cueId,origin);assert.ok($('passage-body').querySelectorAll('.passage').length<=10);assert.equal(h.plays,0);
 }finally{await h.w.happyDOM.close();}
});
test('Escape from Find cancels the journey but composition, modal and unrelated editor keys keep ownership',async()=>{
 const h=setup();try{const {$,w}=h,origin=start(h);search(h);$('search').focus();
 for(const options of [{isComposing:true},{repeat:true},{ctrlKey:true}]){const event=new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,...options});$('search').dispatchEvent(event);assert.equal(event.defaultPrevented,false);assert.equal(w.document.body.dataset.readingMode,'transcript');}
 $('details-dialog').showModal();const modalEvent=new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});$('search').dispatchEvent(modalEvent);assert.equal(modalEvent.defaultPrevented,false);$('details-dialog').close();
 const event=new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});$('search').dispatchEvent(event);assert.equal(event.defaultPrevented,true);assert.equal(w.document.body.dataset.readingMode,'passages');assert.equal(w.document.activeElement.dataset.cueId,origin);
 }finally{await h.w.happyDOM.close();}
});
test('native search-field clearing retains the current match page and existing annotation filters without a scroll',async()=>{
 const h=setup();try{const {$,w}=h;start(h);for(const s of doc(h).segments)s.saved_excerpt=true;$('filter-excerpts').click();search(h);$('next-match').click();$('search').focus();h.scrolls=[];$('search').value='';$('search').oninput();assert.ok(cue(h,'shelf-0-cue-900'));assert.equal($('filter-excerpts').getAttribute('aria-pressed'),'true');assert.equal(w.document.activeElement,$('search'));assert.equal(h.scrolls.length,0);
 }finally{await h.w.happyDOM.close();}
});
test('source reordering keeps the exact surviving cue identity but retires its old geometry',async()=>{
 const h=setup();try{const {$,w}=h,origin=start(h);search(h);const index=doc(h).segments.findIndex(s=>s.id===origin),[source]=doc(h).segments.splice(index,1);doc(h).segments.splice(200,0,source);w.Coconut.invalidateSearch(doc(h));w.libraryProbe.render();h.scrolls=[];$('return-before-search').click();assert.equal(w.document.activeElement.dataset.cueId,origin);assert.equal(h.scrolls.some(item=>item[0]==='by'),false);
 }finally{await h.w.happyDOM.close();}
});
for(const action of ['clear','continue'])test(`new result pagination overrides the old matching focus for ${action}`,async()=>{
 const h=setup();try{const {$,w}=h;start(h);search(h,'source sentence');$('next-match').click();assert.equal(w.document.activeElement.dataset.segmentId,'shelf-0-cue-0');$('next-page').click();assert.equal(w.document.activeElement.dataset.segmentId,'shelf-0-cue-100');$(action==='clear'?'clear-search':'continue-search-reading').click();assert.equal(w.document.activeElement.dataset.segmentId||w.document.activeElement.dataset.cueId,'shelf-0-cue-100');
 }finally{await h.w.happyDOM.close();}
});
test('scrolling away from a formerly focused match chooses the currently visible result',async()=>{
 const h=setup();try{const {$,w}=h;start(h);search(h,'source sentence');$('next-match').click();visible(h,'shelf-0-cue-70');$('continue-search-reading').click();assert.equal(w.document.activeElement.dataset.cueId,'shelf-0-cue-70');
 }finally{await h.w.happyDOM.close();}
});
test('continue reading targets the exact searched cue inside a composed passage',async()=>{
 const h=setup();try{const {$,w}=h;start(h);search(h,'source sentence 903.');$('next-match').click();$('continue-search-reading').click();const target=w.document.activeElement;assert.equal(target.dataset.cueId,'shelf-0-cue-903');assert.notEqual(target.closest('.passage').dataset.firstCueId,target.dataset.cueId);assert.equal(h.scrolls.at(-1)[1],'shelf-0-cue-903');
 }finally{await h.w.happyDOM.close();}
});
test('starting a new Find inside an existing annotation context preserves that original result-return route',async()=>{
 const h=setup();try{const {$}=h;$('mode-transcript').click();doc(h).segments[70].saved_excerpt=true;$('filter-excerpts').click();cue(h,'shelf-0-cue-70').querySelector('.context-button').click();assert.equal($('reading-context').hidden,false);visible(h,'shelf-0-cue-70');$('search').focus();search(h);$('return-before-search').click();assert.equal($('reading-context').hidden,false);$('return-reading-results').click();assert.equal($('filter-excerpts').getAttribute('aria-pressed'),'true');assert.equal($('transcript').querySelectorAll('.segment').length,1);assert.ok(cue(h,'shelf-0-cue-70'));
 }finally{await h.w.happyDOM.close();}
});
test('an original speaker filter whose label disappeared is not silently restored as unfiltered content',async()=>{
 const h=setup();try{const {$,w}=h;doc(h).segments[70].speaker='Former label';$('mode-transcript').click();$('speaker-filter').value=JSON.stringify('Former label');$('speaker-filter').onchange();$('search').focus();search(h,'missing');doc(h).segments[70].speaker='Renamed';w.Coconut.invalidateSearch(doc(h));w.libraryProbe.render();assert.equal($('return-before-search').disabled,true);assert.match($('reading-search-status').textContent,/说话人筛选已无对应标签/);h.scrolls=[];$('return-before-search').click();assert.equal(h.scrolls.length,0);assert.equal(doc(h).segments[70].speaker,'Renamed');
 }finally{await h.w.happyDOM.close();}
});
for(const action of ['return-results','stay-full'])test(`explicit ${action} finishes a new Find begun inside that old context instead of resurrecting it`,async()=>{
 const h=setup();try{const {$}=h;$('mode-transcript').click();doc(h).segments[70].saved_excerpt=true;$('filter-excerpts').click();cue(h,'shelf-0-cue-70').querySelector('.context-button').click();$('search').focus();assert.equal($('reading-search-session').hidden,false);$(action==='return-results'?'return-reading-results':'dismiss-reading-context').click();assert.equal($('reading-search-session').hidden,true);assert.equal($('reading-context').hidden,true);h.scrolls=[];$('return-before-search').click();assert.equal(h.scrolls.length,0);
 }finally{await h.w.happyDOM.close();}
});
test('an edited-away original match does not silently open another search session during fallback focus',async()=>{
 const h=setup();try{const {$,w}=h;doc(h).notes['shelf-0-cue-70']='Original';doc(h).notes['shelf-0-cue-80']='Still here';$('mode-transcript').click();$('filter-notes').click();visible(h,'shelf-0-cue-70');$('search').focus();search(h,'missing');doc(h).notes['shelf-0-cue-70']='';$('return-before-search').click();assert.equal($('reading-search-session').hidden,true);assert.equal(w.document.activeElement,$('search'));assert.equal($('transcript').querySelectorAll('.segment').length,1);assert.ok(cue(h,'shelf-0-cue-80'));
 }finally{await h.w.happyDOM.close();}
});
test('returning preserves newer translation display choices made while exploring a search result',async()=>{
 const h=setup();try{const {$,w}=h;doc(h).language='en';doc(h).translation_view='zh';for(const s of doc(h).segments)s.translations={zh:{text:'已存对照 '+s.id,source_text:s.text,source_language:'en',document_language:'en',provider:'Authored fixture'}};w.Coconut.invalidateSearch(doc(h));const origin=start(h);search(h);$('next-match').click();cue(h,'shelf-0-cue-900').querySelector('.context-button').click();$('mode-passages').click();assert.equal($('passage-toggle-translation').hidden,false);$('passage-toggle-translation').click();assert.equal($('passage-toggle-translation').getAttribute('aria-pressed'),'false');$('return-reading-results').click();$('return-before-search').click();assert.equal(w.document.activeElement.dataset.cueId,origin);assert.equal($('passage-toggle-translation').getAttribute('aria-pressed'),'false');assert.equal(doc(h).translation_view,'zh');
 }finally{await h.w.happyDOM.close();}
});
