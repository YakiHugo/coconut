// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import C from '../reader/core.js';

import {displayedTranslationExportsFixture as fixture} from './helpers/displayed-translation-exports-fixture.mjs';

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

test('language overrides never rewrite immutable bilingual excerpt or AI history bytes',()=>{
 const doc=fixture(),cue=doc.segments[6],model=C.translationSelectionModels(doc,[cue],'fr')[0];
 doc.exact_excerpts=[C.pairedExactExcerptSnapshot(doc,[cue],[],0,cue.text.length,model,0,model.text.length,{id:'authored-fixed-pair',createdAt:'2026-10-11T00:00:00.000Z',confirmedAt:'2026-10-11T00:00:00.000Z'})];
 doc.ai_answers=[{question:'Historic question',answer:'Historic answer'}];
 cue.translations.fr.text='Later French revision';const before=JSON.stringify(doc),history=C.notebookMarkdown(doc,'').split('## 精确摘录')[1];
 for(const target of ['',null,'zh','fr']){
  assert.ok(C.notebookMarkdown(doc,target).includes(history));for(const format of ['srt','vtt'])C.subtitleExport(doc,format,true,target);assert.equal(JSON.stringify(doc),before);
 }
});
