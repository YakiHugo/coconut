import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {settle} from './helpers/save-pipeline.mjs';
const quoteSource=fs.readFileSync(new URL('../reader/quotation.js',import.meta.url),'utf8');
function fixture(){return {key:'paired',title:'Language course',language:'en',source_url:'',translation_view:'zh',readingPosition:'a',notes:{},segments:['First original words','Second original words','Third original words'].map((text,i)=>({id:['a','b','c'][i],text,start:i*2,end:i*2+2,speaker:'A',translations:{zh:{text:['第一段译文','第二段译文','第三段译文'][i],source_text:text,provider:'test-provider',source_language:'en'}}}))};}
function setup(doc=fixture()){const env=libraryHarness([doc],{probe:true,configureCore:w=>w.eval(quoteSource)});env.$('mode-passages').click();return env;}
function start(w,$){w.getSelection().removeAllRanges();w.document.querySelector('.passage-quote').click();$('quotation-source').setSelectionRange(0,5);$('quotation-preview-selection').click();$('quotation-pair-start').click();const field=$('quotation-pair-source');field.setSelectionRange(1,field.value.length-1);$('quotation-pair-preview').click();}
function dirty(w){const event=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(event);return event.defaultPrevented;}
function confirm($){$('quotation-pair-confirm').checked=true;$('quotation-pair-confirm').onchange();$('quotation-pair-compatibility').checked=true;$('quotation-pair-compatibility').onchange();}
test('independent original and translation ranges save immutable v2 with explicit correspondence and version consent',async()=>{
 const {w,$,pipeline}=setup();try{start(w,$);assert.equal($('quotation-save').disabled,true);assert.match($('quotation-pair-origin').textContent,/机器生成/);confirm($);await $('quotation-save').onclick();await pipeline.store.flush();const doc=w.libraryProbe.documents[0],record=doc.exact_excerpts[0];assert.equal(record.version,2);assert.equal(record.text,'First');assert.equal(w.Coconut.exactExcerptTranslationParts(record).length,3);assert.equal(w.Coconut.exactExcerptParts(record).length,1);assert.equal(record.translation.text,'一段译文第二段译文第三段译');assert.equal(record.translation.cues[0].translation.manual_review,undefined);assert.equal(doc.readingPosition,'a');assert.match($('quotation-save-status').textContent,/已保存/);
  const saved=JSON.stringify(record);doc.segments[0].translations.zh.text='Changed';assert.equal(JSON.stringify(record),saved);assert.equal(w.Coconut.validate(JSON.parse(JSON.stringify(doc))).exact_excerpts[0].translation.text,record.translation.text);
 }finally{await w.happyDOM.close();}
});
test('missing translations divide selectable runs and do not concatenate gaps',async()=>{
 const source=fixture();delete source.segments[1].translations;const {w,$}=setup(source);try{start(w,$);assert.equal($('quotation-pair-run').options.length,2);assert.equal($('quotation-pair-source').value,'第一段译文');$('quotation-pair-edit').click();$('quotation-pair-run').value='1';$('quotation-pair-run').onchange();assert.equal($('quotation-pair-source').value,'第三段译文');assert.equal($('quotation-pair-confirm').checked,false);assert.equal($('quotation-save').disabled,true);$('quotation-pair-language').value='ja';$('quotation-pair-language').onchange();assert.match($('quotation-pair-status').textContent,/没有可用/);assert.equal($('quotation-pair-preview').disabled,true);
 }finally{await w.happyDOM.close();}
});
test('closing preserves paired draft and cancelling consent never discards either range',async()=>{
 const {w,$}=setup();try{start(w,$);const text=$('quotation-pair-text').value,original=$('quotation-preview').value;$('quotation-close').click();assert.equal(dirty(w),true);w.document.querySelector('.passage-quote').click();assert.equal($('quotation-pair-text').value,text);assert.equal($('quotation-preview').value,original);confirm($);$('quotation-pair-compatibility').checked=false;$('quotation-pair-compatibility').onchange();assert.equal($('quotation-save').disabled,true);assert.equal($('quotation-pair-text').value,text);$('quotation-pair-discard').click();assert.equal(dirty(w),false);assert.equal($('quotation-preview').value,original.split('\n\n所选译文')[0]);await $('quotation-save').onclick();assert.equal(w.libraryProbe.documents[0].exact_excerpts[0].version,1);
 }finally{await w.happyDOM.close();}
});
test('translation or source replacement and rerender reject save but retain draft',async()=>{
 for(const change of ['translation','source','render']){const {w,$}=setup();try{start(w,$);confirm($);const selected=$('quotation-pair-text').value,doc=w.libraryProbe.documents[0];if(change==='translation')doc.segments[0].translations.zh={...doc.segments[0].translations.zh};else if(change==='source')doc.segments[0]={...doc.segments[0]};else w.libraryProbe.render();await $('quotation-save').onclick();assert.equal(doc.exact_excerpts,undefined);assert.equal($('quotation-pair-text').value,selected);assert.equal(dirty(w),true);assert.match($('quotation-status').textContent+$('quotation-save-status').textContent,/变化|重新/);}finally{await w.happyDOM.close();}}
});
test('failed save preserves paired record and retry never duplicates history',async()=>{
 const {w,$,pipeline}=setup();try{start(w,$);confirm($);pipeline.hold();const saving=$('quotation-save').onclick();await settle();assert.equal(pipeline.writes.length,1);pipeline.writes[0].fail();await saving;assert.match($('quotation-save-status').textContent,/尚未保存/);const record=w.libraryProbe.documents[0].exact_excerpts[0];pipeline.hold(false);await $('quotation-save').onclick();assert.equal(w.libraryProbe.documents[0].exact_excerpts.length,1);assert.equal(w.libraryProbe.documents[0].exact_excerpts[0],record);assert.match($('quotation-save-status').textContent,/已保存/);
 }finally{await w.happyDOM.close();}
});
test('keyboard selection respects graphemes and modal boundaries; Escape keeps draft',async()=>{
 const source=fixture();source.segments[0].translations.zh.text='译 e\u0301 🌴 文';const {w,$}=setup(source);try{start(w,$);$('quotation-pair-edit').click();const field=$('quotation-pair-source');field.setSelectionRange(2,2);field.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(field.selectionEnd,4);field.setSelectionRange(3,4);$('quotation-pair-preview').click();confirm($);await $('quotation-save').onclick();assert.equal(w.libraryProbe.documents[0].exact_excerpts,undefined);assert.match($('quotation-save-status').textContent,/完整译文字符/);$('quotation-close').focus();const tab=new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});$('quotation-close').dispatchEvent(tab);assert.equal(tab.defaultPrevented,true);assert.equal(w.document.activeElement,$('quotation-original-text'));$('quotation-dialog').dispatchEvent(new w.Event('cancel',{cancelable:true}));assert.equal($('quotation-dialog').open,false);assert.equal(dirty(w),true);
 }finally{await w.happyDOM.close();}
});
test('late receipt cannot mark a newer translation selection saved',async()=>{
 const {w,$,pipeline}=setup();try{start(w,$);confirm($);pipeline.hold();const pending=$('quotation-save').onclick();await settle();const first=w.libraryProbe.documents[0].exact_excerpts[0];$('quotation-pair-edit').click();$('quotation-pair-source').setSelectionRange(0,2);$('quotation-pair-preview').click();confirm($);assert.equal(dirty(w),true);pipeline.writes[0].commit();await pending;assert.notEqual($('quotation-save').textContent,'已保存摘录');assert.equal($('quotation-save').disabled,false);assert.equal(dirty(w),true);pipeline.hold(false);await $('quotation-save').onclick();assert.equal(w.libraryProbe.documents[0].exact_excerpts.length,2);assert.equal(w.libraryProbe.documents[0].exact_excerpts[0],first);assert.equal(w.libraryProbe.documents[0].exact_excerpts[1].translation.text,'第一');
 }finally{await w.happyDOM.close();}
});
test('notebook and collection show saved bilingual text after live translation disappears',async()=>{
 const {w,$}=setup();try{start(w,$);confirm($);await $('quotation-save').onclick();const doc=w.libraryProbe.documents[0],record=doc.exact_excerpts[0];$('quotation-close').click();delete doc.segments[0].translations;doc.segments[0].text='Changed';w.libraryProbe.render();$('open-library-notebook').click();await settle();const row=w.document.querySelector('.notebook-capture[data-capture-id="'+record.id+'"]');assert.ok(row);assert.match(row.querySelector('.notebook-paired-translation').textContent,/一段译文第二段译文第三段译/);$('collection-tools').open=true;$('collection-title').value='Paired collection';$('collection-save-title').click();row.querySelector('.collection-add').click();const collection=w.libraryProbe.documents.find(item=>item.project_kind==='reading_collection');assert.equal(collection.items.length,1);assert.match($('collection-items').textContent,/一段译文第二段译文第三段译/);assert.deepEqual(collection.items[0].snapshot.exact_excerpt,record);
 }finally{await w.happyDOM.close();}
});
test('Tab minimally reveals full label above sticky actions, while Space, run changes, pointer and save never cause late scrolling',async()=>{
 const {w,$,pipeline}=setup();try{start(w,$);const frames=[];w.requestAnimationFrame=fn=>frames.push(fn);const dialog=$('quotation-dialog'),input=$('quotation-pair-confirm'),label=input.closest('label'),footer=dialog.querySelector('.quotation-actions'),rect=(top,bottom)=>({top,bottom,left:10,right:370,width:360,height:bottom-top});dialog.getBoundingClientRect=()=>rect(10,700);label.getBoundingClientRect=()=>rect(550,640);input.getBoundingClientRect=()=>rect(560,580);footer.getBoundingClientRect=()=>rect(600,690);dialog.scrollTop=0;
  $('quotation-pair-text').focus();$('quotation-pair-text').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));input.focus();frames.shift()();assert.equal(dialog.scrollTop,48);input.dispatchEvent(new w.KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}));w.dispatchEvent(new w.Event('resize'));await pipeline.store.flush();assert.equal(dialog.scrollTop,48);
  for(const interrupt of [()=>input.dispatchEvent(new w.KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true})),()=>$('quotation-pair-run').onchange(),()=>input.dispatchEvent(new w.Event('pointerdown',{bubbles:true}))]){input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));interrupt();frames.shift()();assert.equal(dialog.scrollTop,48);}
 }finally{await w.happyDOM.close();}
});
test('selected cue alone determines provenance and clipboard failure preserves full bilingual payload',async()=>{
 const source=fixture();source.segments[1].translations.zh.provider='user';const {w,$}=setup(source);try{start(w,$);$('quotation-pair-edit').click();$('quotation-pair-source').setSelectionRange(0,2);$('quotation-pair-preview').click();assert.match($('quotation-pair-origin').textContent,/机器生成/);assert.doesNotMatch($('quotation-pair-origin').textContent,/用户自写/);confirm($);Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async()=>{throw Error('denied');}},configurable:true});await $('quotation-copy').onclick();assert.match($('quotation-preview').value,/First/);assert.match($('quotation-preview').value,/所选译文（zh/);assert.match($('quotation-preview').value,/第一/);assert.equal(w.document.activeElement,$('quotation-preview'));assert.match($('quotation-status').textContent,/手动复制/);
 }finally{await w.happyDOM.close();}
});
test('source removal cannot discard an unsubmitted paired selection',async()=>{
 const {w,$}=setup();try{start(w,$);const text=$('quotation-pair-text').value;$('quotation-close').click();$('library-options').open=true;w.document.querySelector('.library-remove').click();assert.equal($('remove-document-dialog').open,false);assert.equal($('quotation-dialog').open,true);assert.equal($('quotation-pair-text').value,text);assert.equal(w.libraryProbe.documents.length,1);
 }finally{await w.happyDOM.close();}
});
test('one large historical translation enters shelf and notebook scheduling, cancels stale work and publishes the late translated hit without taking focus',async()=>{
 const C=(await import('../reader/core.js')).default,raw=fixture();raw.readingPosition='giant-0';raw.segments=Array.from({length:7},(_,i)=>{const text='Source '+i;return {id:'giant-'+i,text,start:i,end:i+1,translations:{zh:{text:'长'.repeat(11980)+(i===6?'late-needle':''),source_text:text,source_language:'en',provider:'authored'}}};});
 const source={...C.validate(raw),key:raw.key},run=C.translationSelectionModels(source,source.segments,'zh')[0];
 source.exact_excerpts=[C.pairedExactExcerptSnapshot(source,source.segments,Array(6).fill(' '),0,1,run,0,run.text.length,{id:'giant-pair',createdAt:'2026-10-11T00:00:00.000Z',confirmedAt:'2026-10-11T00:00:00.000Z'})];
 // Remove live translated text so the only match is the immutable saved side.
 for(const cue of source.segments)delete cue.translations;
 const queue=[],{w,$}=libraryHarness([source],{probe:true,configureCore(w){for(const name of ['createLibrarySearch','createLibraryNotebookSearch']){const create=w.Coconut[name];w.Coconut[name]=options=>create({...options,schedule:task=>queue.push(task),now:()=>0,workSize:1});}}});
 const drain=()=>{let remaining=20000;while(queue.length){assert.ok(remaining-->0);queue.shift()();}};
 try{
  $('library-scope').value='text';$('library-search').value='late-needle';$('library-search').oninput();assert.equal($('library').getAttribute('aria-busy'),'true');assert.equal($('library').hidden,true);assert.ok(queue.length>0);assert.match($('library-page-status').textContent,/正在查找/);
  $('library-search').value='absent-query';$('library-search').oninput();drain();assert.equal($('library').children.length,0);
  $('library-search').value='late-needle';$('library-search').oninput();assert.equal($('library').getAttribute('aria-busy'),'true');
  $('library-search').value='';$('library-search').oninput();assert.equal($('library').hidden,false);drain();assert.equal($('library').getAttribute('aria-busy'),'false');
  $('library-search').value='late-needle';$('library-search').oninput();$('source-url').focus();const focused=w.document.activeElement;drain();assert.equal($('library').getAttribute('aria-busy'),'false');assert.equal($('library').children.length,1);assert.equal(w.document.activeElement,focused);assert.match($('library').textContent,/摘录时译文/);assert.match($('library').textContent,/late-needle/);
  $('library-scope').value='title';$('library-search').value='Language';$('library-search').oninput();assert.equal($('library').getAttribute('aria-busy'),'false');
  $('open-library-notebook').click();$('notebook-search').value='late-needle';$('notebook-search').oninput();assert.equal($('notebook-captures').getAttribute('aria-busy'),'true');assert.equal($('notebook-captures').children.length,0);assert.match($('notebook-status').textContent,/正在查找/);
  $('notebook-search').value='absent-query';$('notebook-search').oninput();$('notebook-search').focus();const editor=w.document.activeElement;drain();assert.equal($('notebook-captures').getAttribute('aria-busy'),'false');assert.equal($('notebook-captures').children.length,0);assert.equal(w.document.activeElement,editor);
  $('notebook-search').value='late-needle';$('notebook-search').oninput();assert.equal($('notebook-captures').getAttribute('aria-busy'),'true');$('notebook-search').value='';$('notebook-search').oninput();drain();assert.equal($('notebook-captures').children.length,1);
  $('notebook-search').value='late-needle';$('notebook-search').oninput();$('notebook-search').focus();$('notebook-search').setSelectionRange(2,5);drain();assert.equal($('notebook-captures').children.length,1);assert.equal($('notebook-captures').firstElementChild.dataset.captureId,'giant-pair');assert.match($('notebook-captures').textContent,/late-needle/);assert.equal(w.document.activeElement,$('notebook-search'));assert.equal($('notebook-search').selectionStart,2);assert.equal($('notebook-search').selectionEnd,5);

 }finally{await w.happyDOM.close();}
});


test('confirmation view puts exact plain source beside the selected translation and retains complete collapsed evidence',async()=>{
 const {w,$}=setup();try{start(w,$);
  assert.equal($('quotation-original-text').value,'First');assert.equal($('quotation-original-text').readOnly,true);
  assert.equal($('quotation-pair-text').readOnly,true);assert.equal($('quotation-pair-source').readOnly,true);
  assert.equal($('quotation-pair-text').closest('#quotation-result'),$('quotation-result'));
  assert.equal($('quotation-pair-selection').hidden,true);assert.equal($('quotation-pair-confirmations').hidden,false);
  assert.equal($('quotation-citation').open,false);assert.equal($('quotation-citation').hidden,false);
  assert.match($('quotation-preview').value,/First\n\n—— Language course/);assert.match($('quotation-preview').value,/未关联原站链接/);
  assert.match($('quotation-preview').value,/尚未确认对应/);assert.match($('quotation-pair-origin-summary').textContent,/机器生成，需核对/);
  assert.match($('quotation-pair-origin').textContent,/test-provider/);assert.match($('quotation-pair-origin').textContent,/生成时间未记录/);
  assert.equal(w.document.activeElement,$('quotation-pair-text'));assert.equal($('quotation-dialog').scrollTop,0);
  const previous=$('quotation-pair-text').value;$('quotation-pair-source').setSelectionRange(0,2);$('quotation-pair-preview').click();assert.equal($('quotation-pair-text').value,previous,'hidden selector cannot replace confirmed display');
 }finally{await w.happyDOM.close();}
});
test('editing and returning preserves both selected ranges and approvals; a committed new selection needs new correspondence',async()=>{
 const {w,$}=setup();try{start(w,$);confirm($);const previous=$('quotation-pair-text').value,payload=$('quotation-preview').value;
  $('quotation-pair-edit').click();assert.equal($('quotation-pair-selection').hidden,false);assert.equal($('quotation-save').disabled,true);assert.equal($('quotation-pair-confirmations').hidden,true);assert.equal(w.document.activeElement,$('quotation-pair-source'));
  $('quotation-pair-source').setSelectionRange(0,2);$('quotation-pair-return').click();assert.equal($('quotation-pair-text').value,previous);assert.equal($('quotation-preview').value,payload);assert.equal($('quotation-pair-confirm').checked,true);assert.equal($('quotation-save').disabled,false);
  $('quotation-pair-edit').click();$('quotation-pair-source').setSelectionRange(0,2);$('quotation-pair-preview').click();assert.equal($('quotation-pair-text').value,'第一');assert.equal($('quotation-original-text').value,'First');assert.equal($('quotation-pair-confirm').checked,false);assert.equal($('quotation-save').disabled,true);assert.equal(dirty(w),true);
 }finally{await w.happyDOM.close();}
});
test('Escape retains an in-progress translation reselection, and reopening does not reset the existing pair',async()=>{
 const {w,$}=setup();try{start(w,$);confirm($);const selected=$('quotation-pair-text').value;$('quotation-pair-edit').click();$('quotation-pair-source').setSelectionRange(2,7);$('quotation-dialog').dispatchEvent(new w.Event('cancel',{cancelable:true}));w.document.querySelector('.passage-quote').click();
  assert.equal($('quotation-pair-selection').hidden,false);assert.equal(w.document.activeElement,$('quotation-pair-source'));assert.equal($('quotation-pair-source').selectionStart,2);assert.equal($('quotation-pair-source').selectionEnd,7);assert.equal($('quotation-pair-text').value,selected);
  $('quotation-pair-return').click();assert.equal($('quotation-pair-confirm').checked,true);await $('quotation-save').onclick();assert.equal(w.libraryProbe.documents[0].exact_excerpts[0].translation.text,selected);
 }finally{await w.happyDOM.close();}
});
test('changing translation language or range retires the old comparison and cannot return stale correspondence',async()=>{
 const source=fixture();delete source.segments[1].translations;const {w,$}=setup(source);try{start(w,$);confirm($);$('quotation-pair-edit').click();$('quotation-pair-run').value='1';$('quotation-pair-run').onchange();
  assert.equal($('quotation-pair-return').hidden,true);assert.equal($('quotation-pair-result').hidden,true);assert.equal($('quotation-pair-confirm').checked,false);$('quotation-pair-return').click();assert.equal($('quotation-pair-selection').hidden,false);assert.equal($('quotation-save').disabled,true);
  $('quotation-pair-source').setSelectionRange(0,2);$('quotation-pair-preview').click();assert.equal($('quotation-pair-text').value,'第三');$('quotation-pair-edit').click();$('quotation-pair-language').value='ja';$('quotation-pair-language').onchange();assert.equal($('quotation-pair-return').hidden,true);assert.equal($('quotation-pair-evidence').hidden,true);assert.equal($('quotation-save').disabled,true);
 }finally{await w.happyDOM.close();}
});
test('clipboard failure opens the complete evidence field and native selection remains writable only to the clipboard',async()=>{
 const {w,$}=setup();try{start(w,$);confirm($);Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async()=>{throw Error('denied');}},configurable:true});await $('quotation-copy').onclick();
  assert.equal($('quotation-citation').open,true);assert.equal(w.document.activeElement,$('quotation-preview'));assert.equal($('quotation-preview').selectionStart,0);assert.equal($('quotation-preview').selectionEnd,$('quotation-preview').value.length);assert.match($('quotation-preview').value,/用户确认对应，非翻译质量认证/);
  $('quotation-citation').open=false;$('quotation-citation').dispatchEvent(new w.Event('toggle'));assert.equal(w.document.activeElement,$('quotation-citation').firstElementChild);
 }finally{await w.happyDOM.close();}
});
test('closed evidence fields are excluded from modal tab boundaries, but summaries and expanded readonly text remain keyboard reachable',async()=>{
 const {w,$}=setup();try{start(w,$);const key=(node,shift=false)=>{node.focus();const event=new w.KeyboardEvent('keydown',{key:'Tab',shiftKey:shift,bubbles:true,cancelable:true});node.dispatchEvent(event);return event;};
  assert.equal(key($('quotation-original-text'),true).defaultPrevented,true);assert.equal(w.document.activeElement,$('quotation-close'));
  assert.equal(key($('quotation-close')).defaultPrevented,true);assert.equal(w.document.activeElement,$('quotation-original-text'));
  const summary=$('quotation-citation').firstElementChild;assert.equal(key(summary).defaultPrevented,false);$('quotation-citation').open=true;assert.equal(key($('quotation-preview')).defaultPrevented,false);
 }finally{await w.happyDOM.close();}
});
test('discarding only the translation returns the compact original and a successful save keeps compatibility acknowledgement session-local',async()=>{
 const {w,$}=setup();try{start(w,$);confirm($);await $('quotation-save').onclick();$('quotation-close').click();start(w,$);assert.equal($('quotation-pair-compatibility').checked,true);assert.equal($('quotation-pair-confirm').checked,false);
  $('quotation-pair-discard').click();assert.equal($('quotation-original-text').value,'First');assert.equal($('quotation-pair-result').hidden,true);assert.equal($('quotation-pair-confirmations').hidden,true);assert.equal($('quotation-reselect').hidden,false);assert.equal($('quotation-dialog').classList.contains('is-pairing'),false);assert.doesNotMatch($('quotation-preview').value,/所选译文/);
 }finally{await w.happyDOM.close();}
});

test('reselecting an already saved pair is a protected draft until returning, and an old persistence event cannot mark the edit saved',async()=>{
 const {w,$}=setup();try{start(w,$);confirm($);await $('quotation-save').onclick();const record=w.libraryProbe.documents[0].exact_excerpts[0];assert.equal(dirty(w),false);
  $('quotation-pair-edit').click();$('quotation-pair-source').setSelectionRange(2,6);assert.equal(dirty(w),true);w.dispatchEvent(new w.Event('coconut-persistence-change'));assert.equal($('quotation-save').textContent,'保存双语摘录');assert.equal($('quotation-save').disabled,true);
  $('quotation-close').click();w.document.querySelector('.passage-quote').click();assert.equal($('quotation-pair-selection').hidden,false);assert.equal($('quotation-pair-source').selectionStart,2);assert.equal($('quotation-pair-source').selectionEnd,6);
  $('quotation-pair-return').click();assert.equal(dirty(w),false);assert.equal($('quotation-save').textContent,'已保存摘录');assert.equal($('quotation-save').disabled,true);assert.equal(w.libraryProbe.documents[0].exact_excerpts.length,1);assert.equal(w.libraryProbe.documents[0].exact_excerpts[0],record);
  $('quotation-pair-edit').click();assert.equal($('quotation-pair-source').selectionStart,1);assert.equal($('quotation-pair-source').selectionEnd,$('quotation-pair-source').value.length-1,'a new edit begins at the displayed snapshot, not the abandoned tentative cursor');
 }finally{await w.happyDOM.close();}
});

test('copy receipts from an earlier visible dialog cannot overwrite status, disclosure or focus after closing or reopening a retained draft',async()=>{
 for(const result of ['resolve','reject'])for(const reopen of [false,true]){const {w,$}=setup();try{start(w,$);const selected=$('quotation-pair-text').value;let finish;
  Object.defineProperty(w.navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise((resolve,reject)=>{finish=()=>result==='resolve'?resolve():reject(Error('late failure'));})}});
  const pending=$('quotation-copy').onclick();$('quotation-close').click();if(reopen)w.document.querySelector('.passage-quote').click();const focused=w.document.activeElement,status=$('quotation-status').textContent;
  finish();await pending;assert.equal($('quotation-dialog').open,reopen);assert.equal(w.document.activeElement,focused,result+' / '+reopen);assert.equal($('quotation-status').textContent,status);assert.equal($('quotation-citation').open,false);assert.equal($('quotation-pair-text').value,selected);assert.equal(dirty(w),true);
  if(!reopen)w.document.querySelector('.passage-quote').click();assert.equal($('quotation-pair-text').value,selected);assert.equal($('quotation-copy').disabled,false);
 }finally{await w.happyDOM.close();}}
});

test('invalid replacement previews leave the previous pair, provenance and confirmation available to return to',async()=>{
 for(const saved of [false,true])for(const invalid of ['empty','whitespace','split-surrogate']){const source=fixture();source.segments[0].translations.zh.text='字 🌴 词';const {w,$}=setup(source);try{start(w,$);confirm($);if(saved)await $('quotation-save').onclick();const selected=$('quotation-pair-text').value,payload=$('quotation-preview').value,origin=$('quotation-pair-origin').textContent;
  $('quotation-pair-edit').click();const field=$('quotation-pair-source');if(invalid==='empty')field.setSelectionRange(2,2);else if(invalid==='whitespace')field.setSelectionRange(1,2);else field.setSelectionRange(field.value.indexOf('🌴')+1,field.value.indexOf('🌴')+2);$('quotation-pair-preview').click();
  assert.equal($('quotation-pair-selection').hidden,false);assert.equal($('quotation-pair-return').hidden,false);assert.equal($('quotation-pair-text').value,selected);assert.equal($('quotation-pair-origin').textContent,origin);assert.equal($('quotation-pair-confirm').checked,true);assert.equal($('quotation-save').disabled,true);assert.match($('quotation-pair-status').textContent,/请选择|请只选择/);assert.equal(dirty(w),true);
  $('quotation-pair-return').click();assert.equal($('quotation-preview').value,payload);assert.equal($('quotation-pair-text').value,selected);assert.equal($('quotation-pair-confirm').checked,true);assert.equal($('quotation-save').disabled,saved);assert.equal(dirty(w),!saved);
 }finally{await w.happyDOM.close();}}
});
