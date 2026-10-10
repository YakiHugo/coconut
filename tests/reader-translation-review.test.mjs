import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {translationReviewFixture} from './helpers/translation-review-fixture.mjs';
const require=createRequire(import.meta.url),C=require('../reader/core.js');
const root=new URL('../',import.meta.url),key='coconut-reader-v1';
function revise(doc,index=102,text='  人工修正 <script>\n103 个苹果。  '){
 const cue=doc.segments[index];return C.saveManualTranslation(doc,cue,'zh',text,C.manualReviewSnapshot(doc,cue,'zh'),JSON.stringify(cue.translations.zh));
}
function transitiveDocument(count=66){
 const doc=C.validate(translationReviewFixture(count));
 const snapshot=i=>({id:doc.segments[i].id,position:i,text:doc.segments[i].text,start:doc.segments[i].start,end:doc.segments[i].end,speaker:doc.segments[i].speaker});
 for(let i=1;i<doc.segments.length;i++){
  const item=doc.segments[i].translations.zh,contextId=String(i).padStart(8,'0')+'-0000-0000-0000-000000000000';
  item.context_id=contextId;
  doc.translation_contexts[contextId]=i===1?[snapshot(i)]:[{...snapshot(i-1),memory_language:'zh',memory_text:doc.segments[i-1].translations.zh.text},snapshot(i)];
 }
 return doc;
}
function setup(stored,desktop=false){
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});
 if(desktop)w.coconutUpdates={state:async()=>({status:'idle',version:'test',arch:'arm64'}),subscribe:()=>{}};
 const doc={...C.validate(translationReviewFixture()),key:'review-doc'};
 w.localStorage.setItem(key,stored||JSON.stringify({documents:[doc]}));
 w.sessionStorage.setItem('coconut-reader-active-v1',doc.key);
 let calls=0;w.fetch=async()=>{calls++;throw new Error('No network permitted for manual review');};
 w.eval(['summary','core','passages','passage-playback','library-store','app','language','translation-review','podcasts'].map(file=>fs.readFileSync(new URL(`reader/${file}.js`,root),'utf8')).join('\n')+'\nwindow.reviewTest={doc:()=>active(),render,flush:()=>libraryStore.flush(),hasUnsavedReaderChanges,other(){const doc=JSON.parse(JSON.stringify(active()));doc.key="other";doc.title="Other review document";state.documents.push(doc);queueDocument(doc);render();},navigate(key){[...$("library").children].find(row=>row.dataset.documentKey===key).querySelector(".library-open").click();},annotations(){active().project_note="";active().timestamp_bookmarks=[];queueDocument(active());render();},closing:value=>readerClosing=value,replace(scope,id){const doc=active();if(scope==="document")state.documents[state.documents.indexOf(doc)]={...doc};else{const index=doc.segments.findIndex(s=>s.id===id);doc.segments[index]={...doc.segments[index]};}}};'+(desktop?'\nlet sourceSubmitting=false,sourceCaptionRequest=null;\n'+fs.readFileSync(new URL('reader/updates.js',root),'utf8'):''));
 let requestId=0;const request=(kind='close')=>({id:++requestId,kind,expiresAt:Date.now()+60000});
 return {w,$:id=>w.document.getElementById(id),calls:()=>calls,request};
}
function input(w,node,text){node.value=text;node.dispatchEvent(new w.Event('input',{bubbles:true}));}
function unload(w){const event=new w.Event('beforeunload',{cancelable:true});w.dispatchEvent(event);return event.defaultPrevented;}
function open($,w,id='review-102'){$('review-translations').click();w.document.querySelector(`[data-segment-id="${id}"].translation-queue-open`).click();}

test('review queue separates missing, stale, quality and ordinary saved translations by target language',()=>{
 const doc=C.validate(translationReviewFixture());const zh=C.translationReviewQueue(doc,'zh'),ja=C.translationReviewQueue(doc,'ja');
 assert.deepEqual([zh.total,zh.missing,zh.stale,zh.quality,zh.current],[105,1,1,1,102]);
 assert.deepEqual(zh.entries.map(e=>[e.id,e.status]),[['review-1','quality'],['review-102','stale']]);
 assert.equal(ja.missing,104);assert.equal(ja.entries[0].id,'review-2');
});

test('human correction preserves exact text, provenance, original translation and one previous version',()=>{
 const doc=C.validate(translationReviewFixture()),original=structuredClone(doc.segments[102].translations.zh),item=revise(doc);
 assert.equal(item.text,'  人工修正 <script>\n103 个苹果。  ');assert.equal(item.provider,original.provider);assert.equal(item.source_language,'en');assert.equal(item.source_text,original.source_text);
 assert.deepEqual(item.original_translation,original);assert.equal(C.translationCurrent(doc.segments[102],doc,item),true);
 revise(doc,102,'New manual revision');const newer=doc.segments[102].translations.zh;
 assert.equal(newer.manual_review.previous_text,item.text);assert.deepEqual(newer.original_translation,original);assert.equal(newer.original_translation.manual_review,undefined);
 const restored=C.parse(JSON.stringify(doc),'review.json'),kept=restored.segments[102].translations.zh;
 assert.deepEqual(kept,newer);assert.equal(C.translationCurrent(restored.segments[102],restored,kept),true);
 assert.match(C.notebookMarkdown(restored),/用户人工核对／修正/);assert.doesNotMatch(C.notebookMarkdown(restored),/机器生成/);
 assert.match(C.subtitleExport(restored,'vtt',true).text,/New manual revision/);
});

for(const change of ['text','neighbor','language','time','speaker','glossary'])test(`human confirmation remains stale after ${change} changes, including backup and exports`,()=>{
 const doc=C.validate(translationReviewFixture()),item=revise(doc);
 if(change==='text')doc.segments[102].text+=' changed';
 if(change==='neighbor')doc.segments[101].text+=' changed';
 if(change==='language')doc.language='fr';
 if(change==='time')doc.segments[102].end+=0.5;
 if(change==='speaker')doc.segments[102].speaker='Another';
 if(change==='glossary')doc.translation_glossary.zh=[{source:'apples',target:'苹果果实'}];
 const restored=C.parse(JSON.stringify(doc),'review.json');assert.equal(C.translationCurrent(restored.segments[102],restored,restored.segments[102].translations.zh),false);
 assert.ok(C.translationReviewQueue(restored,'zh').entries.some(e=>e.id==='review-102'&&e.status==='stale'));
 assert.doesNotMatch(C.subtitleExport(restored,'vtt',true).text,/人工修正/);assert.match(C.notebookMarkdown(restored),/译文已过期/);assert.equal(restored.segments[102].translations.zh.text,item.text);
});

test('human snapshot includes transitive translation-memory source dependencies',()=>{
 const doc=C.validate(translationReviewFixture(8)),a='a'.repeat(8)+'-aaaa-aaaa-aaaa-'+'a'.repeat(12),b='b'.repeat(8)+'-bbbb-bbbb-bbbb-'+'b'.repeat(12);
 const snapshot=i=>({id:doc.segments[i].id,position:i,text:doc.segments[i].text,start:doc.segments[i].start,end:doc.segments[i].end,speaker:doc.segments[i].speaker});
 doc.segments[6].translations.zh.context_id=a;doc.segments[4].translations.zh.context_id=b;
 doc.translation_contexts[a]=[ {...snapshot(4),memory_language:'zh',memory_text:doc.segments[4].translations.zh.text},snapshot(6)];doc.translation_contexts[b]=[snapshot(1),snapshot(4)];
 const item=revise(doc,6,'人工依赖审阅');assert.ok(item.manual_review.cues.some(c=>c.id==='review-1'));
 doc.segments[1].text='Remote context changed';assert.equal(C.translationCurrent(doc.segments[6],doc,item),false);
});

test('65-cue transitive human evidence survives save, validation and JSON without dropping remote dependencies',()=>{
 const doc=transitiveDocument();
 const original=structuredClone(doc.segments[65].translations.zh),contexts=structuredClone(doc.translation_contexts);
 assert.equal(C.translationCurrent(doc.segments[65],doc,original),true);
 assert.equal(C.manualReviewSnapshot(doc,doc.segments[65],'zh').cues.length,65);
 const item=revise(doc,65,'All dependent sources reviewed');assert.equal(item.manual_review.cues.length,65);
 const restored=C.parse(JSON.stringify(C.validate(doc)),'long-review.json'),kept=restored.segments[65].translations.zh;
 assert.deepEqual(kept,item);assert.deepEqual(kept.original_translation,original);assert.deepEqual({...restored.translation_contexts},{...contexts});
 assert.equal(C.translationCurrent(restored.segments[65],restored,kept),true);
 restored.segments[1].text+=' changed remotely';
 assert.equal(C.translationCurrent(restored.segments[65],restored,kept),false);
 const stale=C.validate(restored);assert.equal(C.translationCurrent(stale.segments[65],stale,stale.segments[65].translations.zh),false);
});

test('manual evidence accepts all validated source fields and preserves long previous reviewed source',()=>{
 const doc=C.validate(translationReviewFixture(4));doc.language='en-'+ 'language'.repeat(20);
 doc.segments[0].text='';doc.segments[1].text='Expanded current source '.repeat(200);doc.segments[2].text='Long neighbor '.repeat(400);
 doc.segments[0].id='';doc.segments[2].speaker='Speaker '.repeat(50);
 const first=revise(doc,1,'First human correction'),firstSource=doc.segments[1].text;
 assert.equal(first.manual_review.cues[0].text,'');assert.equal(first.manual_review.cues[2].text,doc.segments[2].text);
 doc.segments[1].text+=' Further corrected source.';const second=revise(doc,1,'Second human correction');
 assert.equal(second.manual_review.previous_source_text,firstSource);
 const restored=C.parse(JSON.stringify(doc),'wide-source.json'),item=restored.segments[1].translations.zh;
 assert.deepEqual(item,second);assert.equal(C.translationCurrent(restored.segments[1],restored,item),true);
 restored.segments[0].text='The empty source is now filled';assert.equal(C.translationCurrent(restored.segments[1],restored,item),false);
});

test('stale context positions follow stable IDs and disclose missing source references during human review',()=>{
 const doc=C.validate(translationReviewFixture(9)),a='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 const snapshot=i=>({id:doc.segments[i].id,position:i,text:doc.segments[i].text,start:doc.segments[i].start,end:doc.segments[i].end,speaker:doc.segments[i].speaker});
 doc.segments[8].translations.zh.context_id=a;doc.segments[4].translations.zh.context_id=b;
 doc.translation_contexts[a]=[{...snapshot(4),memory_language:'zh',memory_text:doc.segments[4].translations.zh.text},snapshot(8)];
 doc.translation_contexts[b]=[snapshot(1),snapshot(2),snapshot(4)];
 doc.segments.splice(1,1); // The remembered cue moves, and one of its source dependencies disappears.
 const target=doc.segments.at(-1),basis=C.manualReviewSnapshot(doc,target,'zh');
 assert.ok(basis.cues.some(c=>c.id==='review-2'));assert.deepEqual(basis.missing_cue_ids,['review-1']);
 const item=revise(doc,7,'Reviewed surviving sources');assert.deepEqual(item.manual_review.missing_cue_ids,['review-1']);
 const restored=C.parse(JSON.stringify(doc),'missing-context.json'),kept=restored.segments.at(-1).translations.zh;
 assert.deepEqual(kept,item);assert.equal(C.translationCurrent(restored.segments.at(-1),restored,kept),true);
 assert.deepEqual(C.manualReviewSnapshot(restored,restored.segments.at(-1),'zh').missing_cue_ids,['review-1']);
 restored.segments[1].text+=' changed';assert.equal(C.translationCurrent(restored.segments.at(-1),restored,kept),false);
 restored.segments[1].text=doc.segments[1].text;
 // A formerly missing reference appearing later also invalidates that absence claim.
 restored.segments.push({id:'review-1',start:100,end:101,text:'Restored source',speaker:null,translations:{}});
 assert.equal(C.translationCurrent(restored.segments[7],restored,kept),false);
});

test('saving rejects changed reviewed source, translation races and empty drafts atomically',()=>{
 for(const change of ['text','translation','glossary','empty']){
  const doc=C.validate(translationReviewFixture()),cue=doc.segments[102],snapshot=C.manualReviewSnapshot(doc,cue,'zh'),expected=JSON.stringify(cue.translations.zh);
  if(change==='text')cue.text+=' changed';if(change==='translation')cue.translations.zh.text+=' newer';if(change==='glossary')doc.translation_glossary.zh=[{source:'apples',target:'新的苹果'}];
  const before=JSON.stringify(cue.translations.zh);assert.throws(()=>C.saveManualTranslation(doc,cue,'zh',change==='empty'?' \n ':'New draft',snapshot,expected));assert.equal(JSON.stringify(cue.translations.zh),before);
 }
});

test('malformed manual evidence cannot fall back to a current machine claim',()=>{
 const doc=C.validate(translationReviewFixture()),cue=doc.segments[1];cue.translations.zh.manual_review={version:2};
 const restored=C.validate(doc);assert.equal(C.translationCurrent(restored.segments[1],restored,restored.segments[1].translations.zh),false);
});

test('current human translations are retained when another provider is selected',()=>{
 const doc=C.validate(translationReviewFixture());revise(doc);
 const plan=C.subscriptionPlan(doc,['review-102'],'en','zh','claude_subscription_translation');assert.equal(plan.total,0);
 doc.segments[102].text+=' changed';assert.equal(C.subscriptionPlan(doc,['review-102'],'en','zh','claude_subscription_translation').total,1);
});

test('DOM queue opens full late-cue editor across filters, exact save survives reload and exports',async()=>{
 const {w,$,calls}=setup();let disk;try{
  $('search').value='not a matching source';$('search').oninput();open($,w);
  assert.equal($('translation-edit-dialog').open,true);assert.match($('translation-edit-heading').textContent,/06:48/);
  assert.equal($('translation-edit-source').textContent,w.reviewTest.doc().segments[102].text);assert.equal($('translation-edit-previous-source').textContent,'Old authored source.');
  assert.match($('translation-edit-text').value,/<script>/);assert.equal($('translation-edit-source').querySelector('script'),null);
  assert.equal($('search').value,'');assert.ok(w.document.querySelector('.segment[data-segment-id="review-102"]'));
  input(w,$('translation-edit-text'),'  手工核对 <img>\n103 个苹果  ');assert.equal(unload(w),true);assert.equal($('save-translation-edit').textContent,'保存人工修正');
  await $('save-translation-edit').onclick(new w.Event('click'));assert.equal($('translation-edit-dialog').open,false);assert.equal($('translation-queue-dialog').open,true);assert.equal(unload(w),false);assert.match($('translation-queue-summary').textContent,/0 段过期/);
  const doc=w.reviewTest.doc();assert.equal(doc.segments[102].translations.zh.text,'  手工核对 <img>\n103 个苹果  ');assert.match(w.Coconut.notebookMarkdown(doc),/手工核对 &lt;img&gt;/);assert.match(w.Coconut.subtitleExport(doc,'vtt',true).text,/手工核对 &lt;img&gt;/);assert.equal(calls(),0);disk=w.localStorage.getItem(key);
 }finally{await w.happyDOM.close();}
 const restored=setup(disk);try{const doc=restored.w.reviewTest.doc();assert.equal(restored.w.Coconut.translationCurrent(doc.segments[102],doc,doc.segments[102].translations.zh),true);assert.match(doc.segments[102].translations.zh.text,/103 个苹果/);}finally{await restored.w.happyDOM.close();}
});

test('explicit unchanged confirmation clears quality hint and preserves machine warning evidence',async()=>{
 const {w,$}=setup();try{open($,w,'review-1');assert.match($('save-translation-edit').textContent,/确认已核对当前原文/);await $('save-translation-edit').onclick(new w.Event('click'));
  const item=w.reviewTest.doc().segments[1].translations.zh;assert.equal(item.quality_warnings[0],'numbers_changed');assert.equal(w.Coconut.translationQualityMessage(item),'');assert.equal(item.original_translation.quality_warnings[0],'numbers_changed');assert.match($('translation-queue-summary').textContent,/0 段质量提示/);
 }finally{await w.happyDOM.close();}
});

test('cancel, Escape and editor switching protect dirty text; background changes never silently refresh the snapshot',async()=>{
 const {w,$}=setup();let questions=0;try{
  open($,w);input(w,$('translation-edit-text'),'unsaved manual draft');w.confirm=()=>{questions++;return false;};
  $('translation-edit-cancel').click();assert.equal($('translation-edit-dialog').open,true);
  $('translation-edit-dialog').dispatchEvent(new w.Event('cancel',{cancelable:true}));assert.equal($('translation-edit-dialog').open,true);
  w.CoconutTranslationReview.openEditor('review-doc','review-1','zh');assert.equal($('translation-edit-text').value,'unsaved manual draft');assert.equal(questions,3);
  w.reviewTest.doc().segments[102].text+=' newer source';w.reviewTest.render();assert.equal($('translation-edit-text').value,'unsaved manual draft');await $('save-translation-edit').onclick(new w.Event('click'));assert.match($('translation-edit-error').textContent,/已变化/);assert.equal(w.reviewTest.doc().segments[102].translations.zh.manual_review,undefined);assert.equal(unload(w),true);
  w.confirm=()=>true;$('translation-edit-cancel').click();assert.equal(unload(w),false);
 }finally{await w.happyDOM.close();}
});

for(const scope of ['document','segment'])test(`replacement ${scope} with identical IDs and contents cannot take ownership of an old manual draft`,async()=>{
 const {w,$}=setup();try{
  open($,w);input(w,$('translation-edit-text'),'Original document draft');
  const before=JSON.stringify(w.reviewTest.doc().segments[102].translations.zh);
  w.reviewTest.replace(scope,'review-102');w.reviewTest.render();await $('save-translation-edit').onclick(new w.Event('click'));
  assert.match($('translation-edit-error').textContent,/替换或关闭/);assert.equal($('translation-edit-dialog').open,true);
  assert.equal($('translation-edit-text').value,'Original document draft');assert.equal(unload(w),true);
  assert.equal(JSON.stringify(w.reviewTest.doc().segments[102].translations.zh),before);
 }finally{await w.happyDOM.close();}
});

test('long context is paged in the editor while all reviewed evidence survives save and reload',async()=>{
 const doc={...transitiveDocument(102),key:'review-doc'};
 const {w,$}=setup(JSON.stringify({documents:[doc],active:doc.key}));let disk;try{
  w.CoconutTranslationReview.openEditor(doc.key,'review-101','zh');
  assert.equal($('translation-edit-source').textContent,doc.segments[101].text);
  assert.equal($('translation-edit-context').children.length,30);assert.equal($('translation-edit-context-position').textContent,'1–30 / 100 条上下文');
  assert.equal($('translation-edit-context-previous').disabled,true);
  input(w,$('translation-edit-text'),'Manual draft across context pages');
  for(let i=0;i<3;i++)$('translation-edit-context-next').click();
  assert.equal($('translation-edit-context').children.length,10);assert.equal($('translation-edit-context-position').textContent,'91–100 / 100 条上下文');
  assert.equal($('translation-edit-context-next').disabled,true);assert.equal($('translation-edit-text').value,'Manual draft across context pages');
  $('translation-edit-context-previous').click();assert.equal($('translation-edit-context-position').textContent,'61–90 / 100 条上下文');
  await $('save-translation-edit').onclick(new w.Event('click'));assert.equal($('translation-edit-dialog').open,false);
  assert.equal(w.reviewTest.doc().segments[101].translations.zh.manual_review.cues.length,101);
  disk=w.localStorage.getItem(key);
 }finally{await w.happyDOM.close();}
 const restored=setup(disk);try{
  const doc=restored.w.reviewTest.doc(),item=doc.segments[101].translations.zh;
  assert.equal(item.manual_review.cues.length,101);assert.equal(restored.w.Coconut.translationCurrent(doc.segments[101],doc,item),true);
  doc.segments[1].text+=' Remote context changed';assert.equal(restored.w.Coconut.translationCurrent(doc.segments[101],doc,item),false);
 }finally{await restored.w.happyDOM.close();}
});

test('editor displays missing historical context separately from current source cues',async()=>{
 const doc={...transitiveDocument(8),key:'review-doc'};doc.segments.splice(1,1);
 const {w,$}=setup(JSON.stringify({documents:[doc],active:doc.key}));try{
  w.CoconutTranslationReview.openEditor(doc.key,'review-7','zh');
  assert.match($('translation-edit-context').textContent,/历史上下文片段已不在当前文字稿：review-1/);
  await $('save-translation-edit').onclick(new w.Event('click'));
  const current=w.reviewTest.doc(),item=current.segments.at(-1).translations.zh;
  assert.deepEqual(Array.from(item.manual_review.missing_cue_ids),['review-1']);
  assert.equal(w.Coconut.translationCurrent(current.segments.at(-1),current,item),true);
 }finally{await w.happyDOM.close();}
});

test('failed persistence retains human text in memory, exposes backup warning and keeps unload protection',async()=>{
 const {w,$}=setup();try{
  open($,w);const storage=w.localStorage,disk=storage.getItem(key);Object.defineProperty(w,'localStorage',{value:{getItem:k=>storage.getItem(k),setItem(){throw new Error('full');}}});
  input(w,$('translation-edit-text'),'Human draft retained');await $('save-translation-edit').onclick(new w.Event('click'));assert.equal(w.reviewTest.doc().segments[102].translations.zh.text,'Human draft retained');assert.equal(storage.getItem(key),disk);assert.equal($('save-status').hidden,false);assert.equal(unload(w),true);assert.match($('notice').textContent,/尚未保存到浏览器/);
 }finally{await w.happyDOM.close();}
});

test('native closing prevents a manual save, with draft still available if close is released',async()=>{
 const {w,$}=setup();try{open($,w);input(w,$('translation-edit-text'),'Pending native draft');const before=w.localStorage.getItem(key);w.reviewTest.closing(true);await $('save-translation-edit').onclick(new w.Event('click'));assert.equal(w.localStorage.getItem(key),before);assert.equal($('translation-edit-dialog').open,true);assert.equal(w.reviewTest.hasUnsavedReaderChanges(),true);w.reviewTest.closing(false);await $('save-translation-edit').onclick(new w.Event('click'));assert.equal(w.reviewTest.doc().segments[102].translations.zh.text,'Pending native draft');}finally{await w.happyDOM.close();}
});

for(const mode of ['subscription','offline'])test(`${mode} in-flight response cannot overwrite a newer manual save`,async()=>{
 const source=translationReviewFixture(4);source.segments[1].translations.zh.source_text='Prior source';const doc={...C.validate(source),key:'review-doc'};
 const {w,$}=setup(JSON.stringify({documents:[doc],active:doc.key}));let release;try{
  let calls=0;
  w.fetch=async(url,options)=>{
   if(url.endsWith('language-tools'))return {ok:true,json:async()=>({local_translation:true,ai:{codex:{ready:true}}})};
   const data=JSON.parse(options.body);calls++;await new Promise(resolve=>release=resolve);
   return {ok:true,json:async()=>({translations:data.segments.map(c=>({id:c.id,text:'Injected late model output',source_text:c.text,provider:'injected_fixture'}))})};
  };
  $('ai-task').value='translation';$('ai-task').onchange();await $('check-ai').onclick();$('ai-consent').checked=true;
  const run=$(mode==='subscription'?'subscription-translate':'translate-document').onclick();assert.equal(calls,1);
  open($,w,'review-1');input(w,$('translation-edit-text'),'Newer human correction');await $('save-translation-edit').onclick(new w.Event('click'));release();await run;
  assert.equal(w.reviewTest.doc().segments[1].translations.zh.text,'Newer human correction');assert.ok(w.reviewTest.doc().segments[1].translations.zh.manual_review);assert.equal(calls,1);
  assert.match($(mode==='subscription'?'ai-progress':'language-status').textContent,/已被人工修正或替换/);
 }finally{release?.();await w.happyDOM.close();}
});

test('queue paging and language changes retain exact missing counts without accumulating clean entries',async()=>{
 const source=translationReviewFixture(105);for(const s of source.segments)if(s.translations?.zh)s.translations.zh.source_text='Earlier source';const doc={...C.validate(source),key:'review-doc'};
 const {w,$}=setup(JSON.stringify({documents:[doc],active:doc.key}));try{
  $('review-translations').click();assert.equal(w.document.querySelectorAll('.translation-queue-open').length,30);assert.equal($('translation-queue-position').textContent,'1–30 / 104');
  $('translation-queue-next').click();assert.equal($('translation-queue-position').textContent,'31–60 / 104');assert.equal(w.document.querySelector('.translation-queue-open').dataset.segmentId,'review-31');
  $('translation-queue-language').value='ja';$('translation-queue-language').onchange();assert.equal(w.document.querySelectorAll('.translation-queue-open').length,1);assert.equal($('translation-queue-position').textContent,'1–1 / 1');assert.match($('translation-queue-summary').textContent,/104 段未保存/);
 }finally{await w.happyDOM.close();}
});

for(const mode of ['subscription','offline'])test(`${mode} human save retires a later planned batch before it can overwrite the revision`,async()=>{
 const source=translationReviewFixture(70);for(const s of source.segments)if(s.translations?.zh)s.translations.zh.source_text='Older source';const doc={...C.validate(source),key:'review-doc'};
 const {w,$}=setup(JSON.stringify({documents:[doc],active:doc.key}));let release;try{
  let calls=0;
  w.fetch=async(url,options)=>{
   if(url.endsWith('language-tools'))return {ok:true,json:async()=>({local_translation:true,ai:{codex:{ready:true}}})};
   const data=JSON.parse(options.body);calls++;if(calls===1)await new Promise(resolve=>release=resolve);
   return {ok:true,json:async()=>({translations:data.segments.map(c=>({id:c.id,text:'Injected model fixture',source_text:c.text,provider:'injected_fixture'}))})};
  };
  $('ai-task').value='translation';$('ai-task').onchange();await $('check-ai').onclick();$('ai-consent').checked=true;
  const run=$(mode==='subscription'?'subscription-translate':'translate-document').onclick();assert.equal(calls,1);
  w.CoconutTranslationReview.openEditor('review-doc','review-65','zh');input(w,$('translation-edit-text'),'Human revision in later batch');await $('save-translation-edit').onclick(new w.Event('click'));release();await run;
  assert.equal(calls,1);assert.equal(w.reviewTest.doc().segments[65].translations.zh.text,'Human revision in later batch');assert.ok(w.reviewTest.doc().segments[65].translations.zh.manual_review);
 }finally{release?.();await w.happyDOM.close();}
});

for(const desktop of [false,true])test(`${desktop?'native':'web'} manual drafts survive navigation alongside glossary and timestamp drafts`,async()=>{
 const {w,$,request}=setup(undefined,desktop),dirty=()=>desktop?!w.coconutPrepareClose('inspect').safe:unload(w);
 try{
  w.reviewTest.annotations();w.reviewTest.other();
  input(w,$('translation-glossary'),'apples = 苹果');input(w,$('audio-bookmark-time'),'12');
  open($,w);input(w,$('translation-edit-text'),'First document human draft');
  w.reviewTest.navigate('other');assert.equal($('translation-edit-dialog').open,false);assert.equal(dirty(),true);
  if(desktop){assert.equal(await w.coconutPrepareUpdate(),false);assert.equal(await w.coconutPrepareClose('safe',request()),false);}
  w.CoconutTranslationReview.openEditor('other','review-1','zh');input(w,$('translation-edit-text'),'Second document human draft');
  w.reviewTest.navigate('review-doc');w.CoconutTranslationReview.openEditor('review-doc','review-102','zh');
  assert.equal($('translation-edit-text').value,'First document human draft');assert.equal($('translation-glossary').value,'apples = 苹果');assert.equal($('audio-bookmark-time').value,'12');
  await $('save-translation-edit').onclick(new w.Event('click'));$('cancel-translation-glossary').click();$('cancel-audio-bookmark').click();assert.equal(dirty(),true,'other document still owns its draft');
  w.reviewTest.navigate('other');w.CoconutTranslationReview.openEditor('other','review-1','zh');assert.equal($('translation-edit-text').value,'Second document human draft');
  w.confirm=()=>true;$('translation-edit-cancel').click();assert.equal(dirty(),false);
 }finally{await w.happyDOM.close();}
});

async function removeReviewDocument(w,$,key='review-doc'){
 [...$('library').children].find(row=>row.dataset.documentKey===key).querySelector('.library-remove').click();await $('confirm-removal').onclick();
}
for(const desktop of [false,true])test(`${desktop?'native':'web'} manual draft removal and undo rebind only the explicit restored document`,async()=>{
 const {w,$}=setup(undefined,desktop),dirty=()=>desktop?!w.coconutPrepareClose('inspect').safe:unload(w);
 try{
  w.reviewTest.other();const original=w.reviewTest.doc();open($,w);input(w,$('translation-edit-text'),'Recovered human draft');
  await removeReviewDocument(w,$);assert.equal($('translation-edit-dialog').open,false);assert.equal(dirty(),true);
  const disk=w.localStorage.getItem(key);await $('save-translation-edit').onclick(new w.Event('click'));assert.equal(w.localStorage.getItem(key),disk,'removed editor cannot save');
  await $('undo-removal').onclick();assert.notEqual(w.reviewTest.doc(),original);assert.equal(dirty(),true);
  w.CoconutTranslationReview.openEditor('review-doc','review-102','zh');assert.equal($('translation-edit-text').value,'Recovered human draft');
  await $('save-translation-edit').onclick(new w.Event('click'));assert.equal(w.reviewTest.doc().segments[102].translations.zh.text,'Recovered human draft');assert.equal(dirty(),false);
  assert.equal(original.segments[102].translations.zh.manual_review,undefined,'retired document identity is never mutated');
 }finally{await w.happyDOM.close();}
});

test('failed noncurrent removal and undo preserve manual drafts, and ending removal retires only that document',async()=>{
 const {w,$}=setup();try{
  w.reviewTest.other();open($,w);input(w,$('translation-edit-text'),'First hidden draft');w.reviewTest.navigate('other');
  w.CoconutTranslationReview.openEditor('other','review-1','zh');input(w,$('translation-edit-text'),'Other live draft');
  const backing=w.localStorage;let blocked=true;Object.defineProperty(w,'localStorage',{value:{getItem:k=>backing.getItem(k),setItem(k,v){if(blocked)throw Error('quota');backing.setItem(k,v);}}});
  await removeReviewDocument(w,$);assert.equal($('remove-document-dialog').open,false);assert.match($('notice').textContent,/移除未保存/);$('cancel-removal').click();assert.equal($('translation-edit-text').value,'Other live draft');
  blocked=false;await removeReviewDocument(w,$);assert.equal($('translation-edit-text').value,'Other live draft');
  blocked=true;await $('undo-removal').onclick();assert.equal($('removal-recovery').hidden,false);assert.equal($('translation-edit-text').value,'Other live draft');
  blocked=false;await $('undo-removal').onclick();assert.equal(w.reviewTest.doc().key,'other');assert.equal($('translation-edit-text').value,'Other live draft');
  w.reviewTest.navigate('review-doc');w.CoconutTranslationReview.openEditor('review-doc','review-102','zh');assert.equal($('translation-edit-text').value,'First hidden draft');
  w.reviewTest.navigate('other');await removeReviewDocument(w,$);$('finish-removal').click();$('confirm-finish-removal').click();assert.equal(unload(w),true);
  w.CoconutTranslationReview.openEditor('other','review-1','zh');assert.equal($('translation-edit-text').value,'Other live draft');w.confirm=()=>true;$('translation-edit-cancel').click();assert.equal(unload(w),false);
 }finally{await w.happyDOM.close();}
});

test('hidden manual draft keeps original evidence and exact identity across replacement and newer source updates',async()=>{
 for(const change of ['document','segment','source']){
  const {w,$}=setup();try{
   w.reviewTest.other();open($,w);input(w,$('translation-edit-text'),'Keep old evidence draft');w.reviewTest.navigate('other');
   w.reviewTest.navigate('review-doc');if(change==='source')w.reviewTest.doc().segments[102].text+=' New source';else w.reviewTest.replace(change,'review-102');
   w.CoconutTranslationReview.openEditor('review-doc','review-102','zh');assert.equal($('translation-edit-text').value,'Keep old evidence draft');await $('save-translation-edit').onclick(new w.Event('click'));
   assert.match($('translation-edit-error').textContent,change==='source'?/已变化/:/替换或关闭/);assert.equal(w.reviewTest.doc().segments[102].translations.zh.manual_review,undefined);assert.equal(unload(w),true);
  }finally{await w.happyDOM.close();}
 }
});

test('manual save preserves complete AI history and exact persisted summary identity',async()=>{
 const doc={...C.validate(translationReviewFixture()),key:'review-doc'};
 doc.ai_answers=Array.from({length:225},(_,i)=>({question:'Question '+i,answer:'Answer '+i,citations:['review-1'],provider:'fixture',purpose:i===3?'summary':'question',input_snapshot:{version:1,segments:doc.segments.map(({id,text})=>({id,text}))}}));
 const {w,$}=setup(JSON.stringify({documents:[doc],active:doc.key}));try{
  const history=JSON.stringify(w.reviewTest.doc().ai_answers);open($,w);input(w,$('translation-edit-text'),'Manual revision with complete history');
  const backing=w.localStorage;let writes=0;Object.defineProperty(w,'localStorage',{value:{getItem:k=>backing.getItem(k),setItem(k,v){writes++;backing.setItem(k,v);}}});
  await $('save-translation-edit').onclick(new w.Event('click'));assert.equal(writes,1);assert.equal(JSON.stringify(w.reviewTest.doc().ai_answers),history);assert.equal(JSON.parse(backing.getItem(key)).documents[0].ai_answers.length,225);
  assert.equal($('ai-history-storage').dataset.state,'saved');assert.equal($('summary-body').textContent,'Answer 3');
  const parsed=w.Coconut.parse(JSON.stringify(w.reviewTest.doc()),'combined.json');assert.equal(JSON.stringify(parsed.ai_answers),history);assert.equal(parsed.segments[102].translations.zh.text,'Manual revision with complete history');
 }finally{await w.happyDOM.close();}
});

for(const mode of ['subscription','offline'])test(`${mode} result from removed ownership cannot overwrite a human draft saved after undo`,async()=>{
 const source=translationReviewFixture(4);source.segments[1].translations.zh.source_text='Prior source';const doc={...C.validate(source),key:'review-doc'};
 const {w,$}=setup(JSON.stringify({documents:[doc],active:doc.key}));let release;try{
  w.fetch=async(url,options)=>{
   if(url.endsWith('language-tools'))return {ok:true,json:async()=>({local_translation:true,ai:{codex:{ready:true}}})};
   const data=JSON.parse(options.body);await new Promise(resolve=>release=resolve);
   return {ok:true,json:async()=>({translations:data.segments.map(c=>({id:c.id,text:'Retired document result',source_text:c.text,provider:'injected_fixture'}))})};
  };
  $('ai-task').value='translation';$('ai-task').onchange();await $('check-ai').onclick();$('ai-consent').checked=true;
  const run=$(mode==='subscription'?'subscription-translate':'translate-document').onclick();
  open($,w,'review-1');input(w,$('translation-edit-text'),'Human draft restored with exact evidence');
  await removeReviewDocument(w,$);await $('undo-removal').onclick();w.CoconutTranslationReview.openEditor('review-doc','review-1','zh');
  assert.equal($('translation-edit-text').value,'Human draft restored with exact evidence');await $('save-translation-edit').onclick(new w.Event('click'));
  const disk=w.localStorage.getItem(key);release();await run;assert.equal(w.localStorage.getItem(key),disk);
  assert.equal(w.reviewTest.doc().segments[1].translations.zh.text,'Human draft restored with exact evidence');
  assert.match($(mode==='subscription'?'ai-progress':'language-status').textContent,/移除或更换/);
 }finally{release?.();await w.happyDOM.close();}
});

for(const id of ['review-1','review-2'])for(const action of ['cancel','escape','save'])test(`direct cue ${id} review ${action} restores focus to the new visible exact-cue action`,async()=>{
 const {w,$}=setup();try{
  $('mode-bilingual').click();$('reading-settings').open=false;
  const row=()=>[...w.document.querySelectorAll('.segment')].find(row=>row.dataset.segmentId===id);
  const opener=row().querySelector('.review-translation-button'),more=opener.closest('.cue-more');if(id==='review-2')assert.ok(more);if(more)more.open=true;opener.focus();opener.click();
  assert.equal(opener.isConnected,false,'opening the editor replaces the old opener');
  const updatedMore=row().querySelector('.cue-more');if(updatedMore)updatedMore.open=false;
  if(action==='escape')$('translation-edit-dialog').dispatchEvent(new w.Event('cancel',{cancelable:true}));
  else if(action==='save')await $('save-translation-edit').onclick(new w.Event('click'));else $('translation-edit-cancel').click();
  const current=row().querySelector('.review-translation-button');assert.equal(w.document.activeElement,current);
  if(current.closest('.cue-more'))assert.equal(current.closest('.cue-more').open,true);assert.equal(current.closest('[hidden]'),null);assert.equal($('reading-settings').open,false);
 }finally{await w.happyDOM.close();}
});

test('missing reviewed cue returns to visible settings without clearing newer filters or jumping to another cue',async()=>{
 const {w,$}=setup();try{
  w.CoconutTranslationReview.openEditor('review-doc','review-1','zh');$('reading-settings').open=false;
  $('search').value='No matching source';$('search').oninput();assert.equal(w.document.querySelector('.segment'),null);
  $('translation-edit-cancel').click();assert.equal(w.document.activeElement,$('review-translations'));assert.equal($('reading-settings').open,true);
  assert.equal($('review-translations').closest('[hidden]'),null);assert.equal($('search').value,'No matching source');assert.equal(w.document.querySelector('.segment'),null);
 }finally{await w.happyDOM.close();}
});

test('a retired editor cancellation cannot steal focus from a newer document with the same cue IDs',async()=>{
 const {w,$}=setup();try{
  w.reviewTest.other();w.CoconutTranslationReview.openEditor('review-doc','review-1','zh');
  w.reviewTest.navigate('other');$('search').focus();$('translation-edit-cancel').onclick();
  assert.equal(w.document.activeElement,$('search'));assert.equal(w.reviewTest.doc().key,'other');
 }finally{await w.happyDOM.close();}
});

test('real library detours with a hidden translation draft update only window selection',async()=>{
 const {w,$}=setup();try{
  w.reviewTest.other();open($,w);input(w,$('translation-edit-text'),'Draft protected across real navigation');
  const storage=w.localStorage,disk=storage.getItem(key),stringify=w.JSON.stringify;let contentWrites=0,contentSerializations=0;
  Object.defineProperty(w,'localStorage',{value:{getItem:k=>storage.getItem(k),setItem(k,v){if(k===key)contentWrites++;storage.setItem(k,v);},removeItem:k=>storage.removeItem(k)}});
  w.JSON.stringify=function(value,...args){
   if(value?.documents||value?.segments&&typeof value.key==='string'||Array.isArray(value)&&value.some(item=>item?.segments&&typeof item.key==='string'))contentSerializations++;
   return stringify.call(this,value,...args);
  };
  w.reviewTest.navigate('other');assert.equal(w.sessionStorage.getItem('coconut-reader-active-v1'),'other');
  assert.equal(storage.getItem('coconut-reader-last-active-v1'),'other');assert.equal(unload(w),true);
  w.reviewTest.navigate('review-doc');assert.equal(w.sessionStorage.getItem('coconut-reader-active-v1'),'review-doc');
  assert.equal(contentWrites,0);assert.equal(contentSerializations,0);assert.equal(storage.getItem(key),disk);assert.equal(Object.hasOwn(JSON.parse(disk),'active'),false);
  w.JSON.stringify=stringify;w.CoconutTranslationReview.openEditor('review-doc','review-102','zh');assert.equal($('translation-edit-text').value,'Draft protected across real navigation');
 }finally{await w.happyDOM.close();}
});


test('missing cue authoring retains exact text and user provenance through JSON, search and subtitle export',()=>{
 const doc=C.validate(translationReviewFixture(3)),cue=doc.segments[0],text='  自己写的苹果 <b>\n第二行  ';
 cue.saved_excerpt=true;const snapshot=C.manualReviewSnapshot(doc,cue,'zh');
 const item=C.saveManualTranslation(doc,cue,'zh',text,snapshot,undefined);
 assert.equal(item.provider,'user');assert.equal(item.original_translation,undefined);assert.equal(item.manual_review.previous_text,'');
 assert.equal(item.text,text);assert.equal(C.translationCurrent(cue,doc,item),true);
 const restored=C.parse(JSON.stringify(doc),'manual.json');assert.deepEqual(restored.segments[0].translations.zh,item);
 assert.equal(C.translationReviewQueue(restored,'zh',true).missing,0);
 assert.match(C.notebookMarkdown(restored),/用户自己写的译文/);
 assert.match(C.subtitleExport(restored,'vtt',true).text,/自己写的苹果/);
 assert.ok(C.searchDocument(restored,'自己写的苹果').byCue.has(cue.id));
 restored.segments[1].text+=' changed';assert.equal(C.translationCurrent(restored.segments[0],restored,restored.segments[0].translations.zh),false);
 assert.doesNotMatch(C.subtitleExport(restored,'vtt',true).text,/自己写的苹果/);
});

for(const change of ['empty','oversized','source','context','language','glossary','duplicate'])test(`missing translation rejects ${change} without changing saved content`,()=>{
 const doc=C.validate(translationReviewFixture(3)),cue=doc.segments[0],snapshot=C.manualReviewSnapshot(doc,cue,'zh');
 let text='Authored draft';
 if(change==='empty')text=' \n ';if(change==='oversized')text='a'.repeat(12001);
 if(change==='source')cue.text+=' changed';if(change==='context')doc.segments[1].text+=' changed';if(change==='language')doc.language='fr';
 if(change==='glossary')doc.translation_glossary.zh=[{source:'apples',target:'果实'}];
 if(change==='duplicate')C.saveManualTranslation(doc,cue,'zh','Other saved text',snapshot,undefined);
 const before=JSON.stringify(cue.translations);assert.throws(()=>C.saveManualTranslation(doc,cue,'zh',text,snapshot,undefined));assert.equal(JSON.stringify(cue.translations),before);
});

test('long exact source survives user authoring and backup validation',()=>{
 const doc=C.validate(translationReviewFixture(2)),cue=doc.segments[0];cue.text='Long source '.repeat(100000);
 C.saveManualTranslation(doc,cue,'zh','User translation',C.manualReviewSnapshot(doc,cue,'zh'),undefined);
 const restored=C.parse(JSON.stringify(doc),'long.json');assert.equal(restored.segments[0].translations.zh.source_text,cue.text);assert.equal(C.translationCurrent(restored.segments[0],restored,restored.segments[0].translations.zh),true);
});

test('bilingual missing cue opens language picker, saves locally and advances only to next missing cue',async()=>{
 const {w,$,calls}=setup();try{
  $('mode-bilingual').click();w.document.querySelector('.segment[data-segment-id="review-0"] .review-translation-button').click();
  assert.equal($('translation-edit-source').textContent,w.reviewTest.doc().segments[0].text);assert.equal($('translation-edit-text').value,'');assert.equal($('translation-edit-language-field').hidden,false);
  $('translation-edit-language').value='ja';$('translation-edit-language').onchange();assert.match($('translation-edit-heading').textContent,/日语/);
  input(w,$('translation-edit-text'),'自分で書いた訳文');await $('save-next-missing-translation').onclick(new w.Event('click'));
  assert.equal(w.reviewTest.doc().segments[0].translations.ja.provider,'user');assert.equal(w.reviewTest.doc().segments[0].translations.zh,undefined);
  assert.equal($('translation-edit-source').textContent,w.reviewTest.doc().segments[1].text);assert.equal($('translation-edit-text').value,'');assert.equal($('translation-edit-language').value,'ja');
  input(w,$('translation-edit-text'),'次の訳文');await $('save-next-missing-translation').onclick(new w.Event('click'));
  assert.equal($('translation-edit-source').textContent,w.reviewTest.doc().segments[3].text,'skip existing Japanese translation');assert.equal(calls(),0);
 }finally{await w.happyDOM.close();}
});

test('missing queue works for a new language and dirty language changes need explicit discard',async()=>{
 const {w,$}=setup();try{
  $('review-translations').click();$('translation-queue-language').value='fr';$('translation-queue-language').onchange();$('translation-queue-mode').value='missing';$('translation-queue-mode').onchange();
  assert.equal(w.document.querySelectorAll('.translation-queue-open').length,30);assert.equal($('translation-queue-position').textContent,'1–30 / 105');w.document.querySelector('.translation-queue-open').click();
  input(w,$('translation-edit-text'),'Brouillon');w.confirm=()=>false;$('translation-edit-language').value='de';$('translation-edit-language').onchange();assert.equal($('translation-edit-language').value,'fr');assert.equal($('translation-edit-text').value,'Brouillon');
  $('translation-edit-cancel').click();assert.equal($('translation-edit-dialog').open,true);
  w.confirm=()=>true;$('translation-edit-cancel').click();assert.equal($('translation-edit-dialog').open,false);assert.equal(w.CoconutTranslationReview.hasDraft(),false);assert.equal(w.reviewTest.doc().segments[0].translations.fr,undefined);
 }finally{await w.happyDOM.close();}
});

test('missing drafts survive document detours and reject concurrent source edits and duplicate translations',async()=>{
 for(const change of ['source','duplicate']){
  const {w,$}=setup();try{
   w.reviewTest.other();w.CoconutTranslationReview.openEditor('review-doc','review-0','zh');input(w,$('translation-edit-text'),'Unsubmitted human draft');w.reviewTest.navigate('other');w.reviewTest.navigate('review-doc');
   const doc=w.reviewTest.doc(),cue=doc.segments[0];if(change==='source')cue.text+=' changed';else w.Coconut.saveManualTranslation(doc,cue,'zh','Other saved text',w.Coconut.manualReviewSnapshot(doc,cue,'zh'),undefined);
   w.CoconutTranslationReview.openEditor('review-doc','review-0','zh');assert.equal($('translation-edit-text').value,'Unsubmitted human draft');await $('save-translation-edit').onclick(new w.Event('click'));assert.match($('translation-edit-error').textContent,/已变化/);assert.equal(unload(w),true);
   assert.equal(cue.translations.zh?.text,change==='duplicate'?'Other saved text':undefined);
  }finally{await w.happyDOM.close();}
 }
});
