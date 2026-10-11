/** Authored fixtures only. Source corrections never call a model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),C=require('../reader/core.js'),S=require('../reader/summary.js');
const clone=value=>JSON.parse(JSON.stringify(value));
const fixture=(count=240)=>({...C.validate({title:'Local terminology',language:'en',segments:Array.from({length:count},(_,i)=>({id:'cue-'+i,start:i*2,end:i*2+2,text:'Tensor Flower '+i+' and Tensor Flower.',speaker:'A',...(i===1?{original_text:'Earlier ASR source'}:{}),translations:{zh:{text:'Authored translation '+i,provider:'fixture',source_text:'Tensor Flower '+i+' and Tensor Flower.'}}})),notes:{'cue-1':'Preserve note'}}),key:'source'});
const preview=(doc,find='Tensor Flower',replacement='TensorFlow')=>C.createSourceCorrectionPreview(doc,{find,replacement});
const apply=(doc,selected)=>C.applySourceCorrectionPreview(doc,preview(doc),selected);
const unrelated=doc=>JSON.stringify(doc,(key,value)=>['text','original_text'].includes(key)?undefined:value);

test('240 cue whole-source preview is immutable and each same-cue occurrence can be independently selected',()=>{
 const doc=fixture(),before=JSON.stringify(doc),p=preview(doc);assert.equal(p.total,480);assert.equal(p.cueCount,240);assert.equal(p.hits.at(-1).id,'cue-239');assert.equal(JSON.stringify(doc),before);assert.ok(Object.isFrozen(p.hits[0]));
 const result=C.applySourceCorrectionPreview(doc,p,[479,1,200]);assert.equal(result.changedCount,3);assert.equal(result.occurrenceCount,3);assert.equal(doc.segments[0].text,'Tensor Flower 0 and TensorFlow.');assert.equal(doc.segments[100].text,'TensorFlow 100 and Tensor Flower.');assert.equal(doc.segments[239].text,'Tensor Flower 239 and TensorFlow.');
 assert.equal(doc.segments[0].original_text,'Tensor Flower 0 and Tensor Flower.');assert.throws(()=>C.applySourceCorrectionPreview(doc,p),/重新预览/);
});

test('literal case-sensitive unicode, dollars, backslashes and non-overlap do not invoke regex replacement semantics',()=>{
 for(const [find,replacement,text,expected] of [['  ',' ','Two  spaces','Two spaces'],['\t',' ','Two\tterms','Two terms'],['.$\\','$$\\$&','.$\\ hi .x\\','$$\\$& hi .x\\'],['🌴术语','椰子$&\\','🌴术语 🌴術語 🌴术语','椰子$&\\ 🌴術語 椰子$&\\'],['aa','b','aaaaa','bba'],['Tensor','tensor','Tensor tensor TENSOR','tensor tensor TENSOR']]){
  const doc=fixture(1);doc.segments[0].text=text;C.applySourceCorrectionPreview(doc,preview(doc,find,replacement));assert.equal(doc.segments[0].text,expected);
 }
 const doc=fixture(2);doc.segments[0].text='Tensor';doc.segments[1].text=' Flower';assert.equal(preview(doc).total,0);
});

test('no-op, zero matches, empty selection, cancellation and invalid selection never write or create provenance',()=>{
 for(const kind of ['same','zero','empty','cancel']){const doc=fixture(1),before=JSON.stringify(doc),segments=doc.segments;const p=preview(doc,kind==='zero'?'absent':'Tensor Flower',kind==='same'?'Tensor Flower':'TensorFlow');if(kind!=='cancel')assert.equal(C.applySourceCorrectionPreview(doc,p,kind==='empty'?[]:undefined).changed,false);assert.equal(doc.segments,segments);assert.equal(JSON.stringify(doc),before);}
 for(const selected of [[-1],[0,0],[999],[0.5],['0'],new Set([0])]){const doc=fixture(1),p=preview(doc),before=JSON.stringify(doc);assert.throws(()=>C.applySourceCorrectionPreview(doc,p,selected),/所选/);assert.equal(JSON.stringify(doc),before);}
 for(const find of ['',null,42])assert.throws(()=>preview(fixture(1),find),/不能为空/);
});

test('all validation precedes the one assignment, and latest cue fields survive the transaction and undo',()=>{
 const doc=fixture(3),p=preview(doc),before=unrelated(doc),old=doc.segments;let writes=0,segments=old;Object.defineProperty(doc,'segments',{enumerable:true,get:()=>segments,set:value=>{writes++;segments=value;}});
 const translation=old[1].translations;doc.notes['cue-2']='New note';old[1].saved_excerpt=true;old[1].speaker='New speaker';const history={arbitrary:'Keep by identity'};old[1].history=history;
 const result=C.applySourceCorrectionPreview(doc,p);assert.equal(writes,1);assert.equal(doc.segments[1].translations,translation);assert.equal(doc.segments[1].history,history);assert.equal(doc.segments[1].original_text,'Earlier ASR source');assert.equal(doc.segments[1].speaker,'New speaker');assert.equal(doc.notes['cue-2'],'New note');assert.equal(old[0].text,'Tensor Flower 0 and Tensor Flower.');
 doc.segments[1].new_annotation='While save pending';C.undoSourceCorrection(doc,result.undo);assert.equal(writes,2);assert.equal(doc.segments[1].original_text,'Earlier ASR source');assert.equal(doc.segments[1].new_annotation,'While save pending');assert.equal(Object.hasOwn(doc.segments[0],'original_text'),false);assert.notEqual(unrelated(doc),before);
});

test('blank replacement result rejects every selected cue atomically, but deleting one occurrence is valid',()=>{
 const doc=fixture(2);doc.segments[0].text='Name stays';doc.segments[1].text='Name';const p=preview(doc,'Name',''),before=JSON.stringify(doc),segments=doc.segments;assert.throws(()=>C.applySourceCorrectionPreview(doc,p),/空白/);assert.equal(doc.segments,segments);assert.equal(JSON.stringify(doc),before);assert.equal(C.applySourceCorrectionPreview(doc,p,[0]).changed,true);assert.equal(doc.segments[0].text,' stays');
});

test('whole-source additions, reorders, text or provenance changes invalidate old preview without partial writes',()=>{
 const mutations=[d=>d.segments.push({id:'extra',start:600,end:601,text:'Other'}),d=>d.segments.pop(),d=>d.segments.reverse(),d=>{d.segments[239].text+=' new';},d=>{d.segments[239].id='different';},d=>{d.segments[239].end++;},d=>{d.segments[239].original_text='earlier';},d=>{delete d.segments[1].original_text;}];
 for(const mutate of mutations){const doc=fixture(),p=preview(doc);mutate(doc);const before=JSON.stringify(doc),segments=doc.segments;assert.throws(()=>C.applySourceCorrectionPreview(doc,p,[0]),/重新预览/);assert.equal(JSON.stringify(doc),before);assert.equal(doc.segments,segments);}
 const doc=fixture(1),p=preview(doc);assert.throws(()=>C.applySourceCorrectionPreview(clone(doc),p),/重新预览/);assert.throws(()=>C.applySourceCorrectionPreview(doc,{...p}),/重新预览/);
});

test('undo is latest-batch only, rejects changed related text and does not overwrite unrelated changes',()=>{
 const doc=fixture(3),first=apply(doc,[0]);const stale=preview(doc);const second=C.applySourceCorrectionPreview(doc,preview(doc,'TensorFlow','Term'),[0]);assert.throws(()=>C.undoSourceCorrection(doc,first.undo),/后续修改/);
 doc.segments[2].text='Unrelated newly authored source';doc.notes['cue-0']='New note';C.undoSourceCorrection(doc,second.undo);assert.equal(doc.segments[0].text,'TensorFlow 0 and Tensor Flower.');assert.equal(doc.segments[2].text,'Unrelated newly authored source');assert.throws(()=>C.applySourceCorrectionPreview(doc,stale),/重新预览/);assert.throws(()=>C.undoSourceCorrection(doc,second.undo),/后续修改/);
 for(const mutate of [d=>{d.segments[0].text='Manual edit';},d=>{d.segments[0].original_text='Other';},d=>d.segments.reverse()]){const d=fixture(2),result=apply(d,[0]);mutate(d);const bytes=JSON.stringify(d);assert.throws(()=>C.undoSourceCorrection(d,result.undo),/后续修改/);assert.equal(JSON.stringify(d),bytes);}
});

test('translations, manual review, summary, exact and bilingual excerpt snapshots stay byte-identical and regain currency on undo',()=>{
 const doc=fixture(3),cue=doc.segments[0],review=C.manualReviewSnapshot(doc,cue,'fr');C.saveManualTranslation(doc,cue,'fr','Human wording',review,JSON.stringify(cue.translations.fr));
 const context='12345678-1234-1234-1234-123456789abc';doc.translation_contexts={[context]:doc.segments.map((c,position)=>({id:c.id,text:c.text,start:c.start,end:c.end,speaker:c.speaker,position}))};doc.segments[2].translations.zh.context_id=context;
 doc.exact_excerpts=[C.exactExcerptSnapshot(doc,[cue],[],0,cue.text.length,{id:'excerpt',createdAt:'2026-10-11T00:00:00.000Z'})];
 doc.ai_answers=[{question:C.SUMMARY_QUESTION,purpose:'summary',input_snapshot:{version:1,segments:doc.segments.map(({id,text})=>({id,text}))}}];
 const model=C.translationSelectionModels(doc,[cue],'zh')[0];doc.exact_excerpts.push(C.pairedExactExcerptSnapshot(doc,[cue],[],0,cue.text.length,model,0,model.text.length,{id:'paired',createdAt:'2026-10-11T00:00:00.000Z',confirmedAt:'2026-10-11T00:00:00.000Z'}));
 const plan=S.plan(doc),job=S.create(plan,'codex');const history=()=>JSON.stringify({translations:doc.segments.map(c=>c.translations),contexts:doc.translation_contexts,excerpts:doc.exact_excerpts,answers:doc.ai_answers,job}),bytes=history();
 const status=()=>[C.translationCurrent(doc.segments[0],doc,doc.segments[0].translations.zh),C.manualReviewCurrent(doc.segments[0],doc,doc.segments[0].translations.fr),C.translationCurrent(doc.segments[2],doc,doc.segments[2].translations.zh),C.summaryFreshness(doc.ai_answers[0],doc),C.exactExcerptFreshness(doc.exact_excerpts[0],doc),C.exactExcerptFreshness(doc.exact_excerpts[1],doc),S.current(job,doc)];
 const before=status();const result=apply(doc,[0]);assert.deepEqual(status(),[false,false,false,'stale','stale','stale',false]);assert.equal(history(),bytes);C.undoSourceCorrection(doc,result.undo);assert.deepEqual(status(),before);assert.equal(history(),bytes);
});

test('JSON and library backups recover corrected source and baseline, while TXT/SRT/VTT export current text',()=>{
 const doc=fixture(3);apply(doc);for(const type of ['srt','vtt'])assert.match(C.subtitleExport(doc,type).text,/TensorFlow/);assert.match(C.transcriptText(doc).text,/TensorFlow/);
 const copy=C.parse(JSON.stringify(doc),'corrections.json');assert.equal(copy.schema_version,1);assert.equal(copy.segments[2].text,'TensorFlow 2 and TensorFlow.');assert.equal(copy.segments[2].original_text,'Tensor Flower 2 and Tensor Flower.');assert.equal(copy.segments[1].original_text,'Earlier ASR source');
 const restored=C.mergeLibraryBackup({documents:[],active:null},{format:'coconut-library',version:1,documents:[clone(doc)]}).documents[0];assert.equal(restored.segments[2].text,doc.segments[2].text);assert.equal(Object.keys(doc).some(key=>key.includes('correction')),false);
});

test('preview never traverses or serializes large unrelated payloads',()=>{
 let reads=0;const doc={segments:Array.from({length:10000},(_,i)=>({id:String(i),start:i,end:i+1,text:'Term Term',translations:{get huge(){reads++;throw Error('Not source');}}}))};
 const p=preview(doc,'Term','New');assert.equal(p.total,20000);C.applySourceCorrectionPreview(doc,p,[19999]);assert.equal(reads,0);assert.equal(doc.segments.at(-1).text,'Term New');
});

test('whitespace-only find remains literal, same-whitespace no-op never writes, and deletion cannot blank a cue',()=>{
 const doc=fixture(2);doc.segments[0].text='A\tB';doc.segments[1].text='\t';const before=JSON.stringify(doc),segments=doc.segments;
 assert.equal(C.applySourceCorrectionPreview(doc,preview(doc,'\t','\t')).changed,false);assert.equal(doc.segments,segments);assert.equal(JSON.stringify(doc),before);
 assert.throws(()=>C.applySourceCorrectionPreview(doc,preview(doc,'\t','')),/空白/);assert.equal(doc.segments,segments);assert.equal(JSON.stringify(doc),before);
 C.applySourceCorrectionPreview(doc,preview(doc,'\t',' '),[0]);assert.equal(doc.segments[0].text,'A B');assert.equal(doc.segments[1].text,'\t');
});

test('only one latest batch survives across documents, while zero-change operations retain it',()=>{
 const first=fixture(2),second=fixture(2);second.key='other';const a=apply(first,[0]);
 assert.equal(C.applySourceCorrectionPreview(second,preview(second,'absent','x')).changed,false);assert.equal(C.applySourceCorrectionPreview(second,preview(second,'Tensor Flower','Tensor Flower')).changed,false);assert.equal(C.applySourceCorrectionPreview(second,preview(second),[]).changed,false);
 C.undoSourceCorrection(first,a.undo);assert.equal(first.segments[0].text,'Tensor Flower 0 and Tensor Flower.');
 const old=apply(first,[0]),latest=apply(second,[0]),before=JSON.stringify(first);assert.throws(()=>C.undoSourceCorrection(first,old.undo),/后续修改/);assert.equal(JSON.stringify(first),before);C.undoSourceCorrection(second,latest.undo);assert.throws(()=>C.undoSourceCorrection(first,old.undo),/后续修改/);
});
