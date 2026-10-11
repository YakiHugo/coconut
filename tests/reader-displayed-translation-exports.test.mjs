import test from 'node:test';
import assert from 'node:assert/strict';
import C from '../reader/core.js';
import {libraryHarness} from './helpers/large-library-harness.mjs';
import {displayedTranslationExportsFixture as fixture} from './helpers/displayed-translation-exports-fixture.mjs';
function setup(documents=[fixture()]){
 const env=libraryHarness(documents,{probe:true}),downloads=[];
 env.w.URL.createObjectURL=blob=>{downloads.push(blob);return 'blob:authored-export';};env.w.URL.revokeObjectURL=()=>{};
 env.w.HTMLAnchorElement.prototype.click=function(){};
 return {...env,downloads,download:async(id)=>{env.$(id).click();return downloads.at(-1).text();}};
}
function setLanguage({w,$},language){$('translation-view').value=language;$('translation-view').dispatchEvent(new w.Event('change'));}
function openDocument({w},index){const key=w.libraryProbe.documents[index].key;w.document.querySelector(`.library-entry[data-document-key="${key}"] .library-open`).click();}
for(const format of ['srt','vtt'])test(format+' explicit displayed language preserves whole source/time and legacy optional argument',()=>{
 const doc=fixture(),before=JSON.stringify(doc),original=C.subtitleExport(doc,format).text;
 assert.equal(C.subtitleExport(doc,format,true).translated,0);
 const fallback=C.subtitleExport(doc,format,true,'zh');assert.equal(fallback.translated,109);assert.match(fallback.text,/中文译文 0/);assert.match(fallback.text,/中文译文 111/);assert.doesNotMatch(fallback.text,/SECRET|française|private note/);
 assert.equal((fallback.text.match(/ --> /g)||[]).length,112);assert.ok(fallback.text.includes(format==='srt'?'00:00:00,125 --> 00:00:02,875':'00:00:00.125 --> 00:00:02.875'));
 assert.equal(C.subtitleExport(doc,format,true,'fr').translated,112);assert.equal(C.subtitleExport(doc,format,false,'fr').text,original);
 doc.translation_view='fr';assert.deepEqual(C.subtitleExport(doc,format,true),C.subtitleExport(doc,format,true,undefined));
 for(const target of ['',null])assert.equal(C.subtitleExport(doc,format,true,target).text,original);
 doc.translation_view='';assert.equal(JSON.stringify(doc),before);
});
test('single-document language override keeps notebook-only scope, explicit original mode, source history and shelf semantics',()=>{
 const doc=fixture(),other=fixture({key:'other',title:'Other authored document',language:'fr'}),before=JSON.stringify([doc,other]);
 const md=C.notebookMarkdown(doc,'zh');assert.match(md,/中文译文 0/);assert.match(md,/中文译文 111/);assert.doesNotMatch(md,/SECRET|française|Authored source 50/);assert.equal((md.match(/此片段译文已过期/g)||[]).length,2);
 assert.doesNotMatch(C.notebookMarkdown(doc),/中文译文/);assert.match(C.notebookMarkdown(other),/Traduction française/);assert.equal(C.notebookMarkdown(other,undefined),C.notebookMarkdown(other));
 for(const target of ['',null])assert.doesNotMatch(C.notebookMarkdown(other,target),/Traduction française/);
 const shelf=C.libraryNotebookMarkdown([doc,other],[doc.key,other.key]);assert.doesNotMatch(shelf,/中文译文/);assert.match(shelf,/Traduction française/);assert.equal(JSON.stringify([doc,other]),before);
});
test('fallback shown in passages exports through SRT/VTT and notes without persisting a selected language',async()=>{
 const env=setup(),{w,$,download}=env;try{
  const doc=w.libraryProbe.documents[0],before=JSON.stringify(doc);assert.equal(w.document.body.dataset.readingMode,'passages');assert.match($('passage-body').textContent,/中文译文 0/);
  assert.equal($('subtitle-bilingual').checked,false);assert.equal($('subtitle-bilingual').disabled,false);assert.match($('subtitle-bilingual-label').textContent,/中文（zh）/);
  assert.doesNotMatch(await download('export-subtitles'),/中文译文/);
  $('subtitle-bilingual').checked=true;
  for(const format of ['srt','vtt']){$('subtitle-format').value=format;const text=await download('export-subtitles');assert.match(text,/中文译文 111/);assert.doesNotMatch(text,/SECRET|française/);assert.equal((text.match(/ --> /g)||[]).length,112);}
  assert.match(await download('export-notebook'),/中文译文 111/);assert.equal(JSON.stringify(doc),before);
  w.libraryProbe.render();assert.equal($('subtitle-bilingual').checked,true,'ordinary receipt render preserves same document/language choice');
 }finally{await w.happyDOM.close();}
});
test('original, collapsed and summary modes clear the option and export no invisible current translation',async()=>{
 for(const mode of ['mode-transcript','passage-toggle-translation','mode-summary']){
  const env=setup(),{w,$,download}=env;try{
   $('subtitle-bilingual').checked=true;$(mode).click();assert.equal($('subtitle-bilingual').disabled,true);assert.equal($('subtitle-bilingual').checked,false);assert.equal($('subtitle-bilingual-label').textContent,'当前未显示译文');
   for(const id of ['export-subtitles','export-notebook'])assert.doesNotMatch(await download(id),/中文译文|française|SECRET/);
   $('subtitle-bilingual').checked=true;assert.doesNotMatch(await download('export-subtitles'),/中文译文|française/,'click-time resolution ignores a stale programmatic check');
  }finally{await w.happyDOM.close();}
 }
});
test('explicit multilingual selection and document changes reset stale opt-ins even when language codes match',async()=>{
 const env=setup([fixture(),fixture({key:'second',title:'Second source'}),fixture({key:'third',title:'Third source',language:'fr'})]),{w,$,download}=env;try{
  $('mode-bilingual').click();$('subtitle-bilingual').checked=true;setLanguage(env,'fr');assert.match($('subtitle-bilingual-label').textContent,/法文（fr）/);assert.equal($('subtitle-bilingual').checked,false);
  $('subtitle-bilingual').checked=true;assert.match(await download('export-subtitles'),/Traduction française 111/);assert.doesNotMatch(await download('export-notebook'),/中文译文/);
  openDocument(env,2);assert.equal($('subtitle-bilingual').checked,false);assert.match($('subtitle-bilingual-label').textContent,/法文（fr）/);
  $('subtitle-bilingual').checked=true;openDocument(env,1);assert.equal($('subtitle-bilingual').checked,false);assert.match($('subtitle-bilingual-label').textContent,/中文（zh）/);assert.doesNotMatch(await download('export-subtitles'),/中文译文|française/);
  $('subtitle-bilingual').checked=true;$('passage-toggle-translation').click();openDocument(env,0);assert.equal($('subtitle-bilingual').checked,false);assert.equal($('subtitle-bilingual').disabled,false);
 }finally{await w.happyDOM.close();}
});
test('filter and later pages never narrow subtitle or notebook exports',async()=>{
 const env=setup(),{w,$,download}=env;try{
  $('mode-bilingual').click();$('next-page').click();$('search').value='Authored source 111';$('search').dispatchEvent(new w.Event('input'));
  assert.equal($('transcript').querySelectorAll('.segment').length,1);$('subtitle-bilingual').checked=true;
  const text=await download('export-subtitles');assert.match(text,/中文译文 0/);assert.match(text,/中文译文 111/);assert.equal((text.match(/ --> /g)||[]).length,112);
  const md=await download('export-notebook');assert.match(md,/中文译文 0/);assert.match(md,/中文译文 111/);assert.doesNotMatch(md,/Authored source 50/);
 }finally{await w.happyDOM.close();}
});
test('missing and only stale fallback languages never enable translation export',async()=>{
 const doc=fixture();for(const cue of doc.segments){delete cue.translations.fr;if(cue.translations.zh)cue.translations.zh.source_text='Earlier source';}
 const env=setup([doc]),{w,$,download}=env;try{assert.equal($('subtitle-bilingual').disabled,true);assert.equal($('subtitle-bilingual').checked,false);assert.doesNotMatch(await download('export-subtitles'),/中文译文|SECRET/);assert.doesNotMatch(await download('export-notebook'),/中文译文|SECRET/);}finally{await w.happyDOM.close();}
});
test('language overrides never rewrite immutable bilingual excerpt or AI history bytes',()=>{
 const doc=fixture(),cue=doc.segments[6],model=C.translationSelectionModels(doc,[cue],'fr')[0];
 doc.exact_excerpts=[C.pairedExactExcerptSnapshot(doc,[cue],[],0,cue.text.length,model,0,model.text.length,{id:'authored-fixed-pair',createdAt:'2026-10-11T00:00:00.000Z',confirmedAt:'2026-10-11T00:00:00.000Z'})];
 doc.ai_answers=[{question:'Historic question',answer:'Historic answer'}];
 cue.translations.fr.text='Later French revision';const before=JSON.stringify(doc),history=C.notebookMarkdown(doc,'').split('## 精确摘录')[1];
 for(const target of ['',null,'zh','fr']){
  assert.ok(C.notebookMarkdown(doc,target).includes(history));for(const format of ['srt','vtt'])C.subtitleExport(doc,format,true,target);assert.equal(JSON.stringify(doc),before);
 }
});
test('native export journey reaches display languages through both real translation disclosures without AI',async()=>{
 const env=setup(),{w,$,download}=env;let fetches=0;w.fetch=async()=>{fetches++;throw Error('No request authorized');};
 const visibleThroughDisclosures=node=>{
  for(let current=node;current;current=current.parentElement){
   if(current.hidden)return false;
   if(current.tagName==='DETAILS'&&!current.open&&!current.querySelector(':scope > summary')?.contains(node))return false;
  }
  return true;
 };
 try{
  $('mode-summary').click();$('mode-bilingual').click();
  // The old native sequence opened the outer panel only, leaving two blockers.
  $('language-panel').open=true;assert.equal($('ai-task').value,'question');assert.equal($('translation-options').hidden,true);assert.equal($('translation-options').open,false);assert.equal(visibleThroughDisclosures($('translation-view')),false);
  $('prepare-bilingual').click();assert.equal($('language-panel').open,true);assert.equal($('ai-task').value,'translation');assert.equal($('translation-options').hidden,false);assert.equal(visibleThroughDisclosures($('translation-view')),false);
  $('translation-options').querySelector(':scope > summary').click();assert.equal($('translation-options').open,true);assert.equal(visibleThroughDisclosures($('translation-view')),true);
  setLanguage(env,'fr');assert.match($('transcript').querySelector('.translation').textContent,/Traduction française 0/);
  $('translation-options').querySelector(':scope > summary').click();$('language-panel').querySelector(':scope > summary').click();assert.equal($('translation-options').open,false);assert.equal($('language-panel').open,false);assert.equal(visibleThroughDisclosures($('translation-view')),false);
  $('next-page').click();$('search').value='Authored source 111';$('search').dispatchEvent(new w.Event('input'));assert.equal($('transcript').querySelectorAll('.segment').length,1);
  $('subtitle-bilingual').checked=true;assert.match(await download('export-subtitles'),/Traduction française 111/);assert.match(await download('export-notebook'),/Traduction française 0/);assert.equal(fetches,0);assert.equal($('ai-consent').checked,false);
 }finally{await w.happyDOM.close();}
});
