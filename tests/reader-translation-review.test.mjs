// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import {createRequire} from 'node:module';

import {translationReviewFixture} from './helpers/translation-review-fixture.mjs';

const require=createRequire(import.meta.url);

const C=require('../reader/core.js');

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
