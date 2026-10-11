/** Authored local data only: no browser, provider, recognition or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),C=require('../reader/core.js'),P=require('../reader/passages.js'),S=require('../reader/summary.js');
const clone=value=>JSON.parse(JSON.stringify(value));
function document(count=81){return {...C.validate({title:'Speaker correction',language:'en',source_url:'',readingPosition:'cue-70',notes:{'cue-0':'Personal note'},segments:Array.from({length:count},(_,i)=>({id:'cue-'+i,start:i*3,end:i*3+2,text:'[Text name] Source '+i,speaker:i%3===0?'B':'A',...(i===1?{original_text:'Uncorrected words',saved_excerpt:true}:{}),translations:{en:{text:'Translation '+i,source_text:'[Text name] Source '+i,provider:'legacy'}}}))}),key:'doc'};}
const preview=(doc,options={})=>C.createSpeakerCorrectionPreview(doc,{cueId:'cue-1',scope:'cue',action:'rename',speaker:'C',...options});
const apply=(doc,options={})=>C.applySpeakerCorrectionPreview(doc,preview(doc,options));
const withoutLabels=doc=>JSON.stringify(doc,(key,value)=>['speaker','original_speaker'].includes(key)?undefined:value);

test('single cue atomically changes only labels and preserves source, annotations and unrelated identity',()=>{
 const doc=document(),before=withoutLabels(doc),old=doc.segments,untouched=old[0],translations=old[1].translations;
 let writes=0,current=doc.segments;Object.defineProperty(doc,'segments',{enumerable:true,configurable:true,get:()=>current,set:value=>{writes++;current=value;}});
 const plan=preview(doc,{speaker:'  Correct person  '});assert.equal(writes,0);assert.equal(plan.total,1);assert.equal(plan.changedCount,1);assert.equal(plan.toSpeaker,'Correct person');
 const result=C.applySpeakerCorrectionPreview(doc,plan);assert.deepEqual(result,{changed:true,changedCount:1,cueIds:['cue-1']});assert.equal(writes,1);
 assert.equal(doc.segments[1].speaker,'Correct person');assert.equal(doc.segments[1].original_speaker,'A');assert.equal(doc.segments[1].original_text,'Uncorrected words');assert.equal(doc.segments[0],untouched);assert.equal(doc.segments[1].translations,translations);assert.equal(old[1].speaker,'A');assert.equal(withoutLabels(doc),before);
 const saved=JSON.stringify(doc);assert.throws(()=>C.applySpeakerCorrectionPreview(doc,plan),/重新预览/);assert.equal(JSON.stringify(doc),saved);assert.equal(writes,1);
});

test('whole exact-label scope spans 81 cues, merges existing names, and restores each original independently',()=>{
 const doc=document(),before=withoutLabels(doc),plan=preview(doc,{scope:'speaker',speaker:'B'});
 assert.equal(plan.total,54);assert.equal(plan.changedCount,54);assert.equal(plan.preview.length,8);assert.equal(plan.truncated,true);assert.equal(plan.mixed,false);
 C.applySpeakerCorrectionPreview(doc,plan);assert.ok(doc.segments.every(cue=>cue.speaker==='B'));assert.equal(doc.segments[80].original_speaker,'A');assert.equal(Object.hasOwn(doc.segments[0],'original_speaker'),false);
 // One formerly-B cue now also has a distinct historical source label.
 doc.segments[0].original_speaker='Initial B';const restore=preview(doc,{scope:'speaker',action:'restore'});
 assert.equal(restore.total,81);assert.equal(restore.changedCount,55);assert.equal(restore.toSpeaker,null);assert.equal(restore.mixed,true);assert.equal(restore.preview[0].toSpeaker,'Initial B');assert.equal(restore.preview[3].toSpeaker,'B');
 const result=C.applySpeakerCorrectionPreview(doc,restore);assert.equal(result.changedCount,55);assert.equal(doc.segments[80].speaker,'A');assert.equal(doc.segments[0].speaker,'Initial B');assert.equal(withoutLabels(doc),before);
});

test('first correction remains the baseline through repeated changes, restoration and JSON round trips',()=>{
 let doc=document();apply(doc);apply(doc,{speaker:'D'});assert.equal(doc.segments[1].original_speaker,'A');
 doc=C.parse(JSON.stringify(doc),'backup.json');assert.equal(doc.schema_version,1);assert.equal(doc.segments[1].original_speaker,'A');
 apply(doc,{action:'restore'});assert.equal(doc.segments[1].speaker,'A');assert.equal(doc.segments[1].original_speaker,'A');
 const old=doc.segments,before=JSON.stringify(doc);assert.deepEqual(apply(doc,{action:'restore'}),{changed:false,changedCount:0,cueIds:[]});assert.equal(doc.segments,old);assert.equal(JSON.stringify(doc),before);
 apply(doc,{speaker:'E'});assert.equal(doc.segments[1].original_speaker,'A');apply(doc,{action:'restore'});assert.equal(doc.segments[1].speaker,'A');
});

test('cancel, no-op, whitespace, unlabeled and mixed-voice prose never create provenance',()=>{
 const doc=document(),before=JSON.stringify(doc),old=doc.segments;preview(doc); // abandoned preview is cancellation
 assert.equal(JSON.stringify(doc),before);assert.equal(apply(doc,{speaker:' A '}).changed,false);assert.equal(apply(doc,{action:'restore'}).changed,false);assert.equal(doc.segments,old);assert.equal(JSON.stringify(doc),before);
 for(const speaker of ['', ' \n\t ',null,42])assert.throws(()=>preview(doc,{speaker}),/不能为空/);
 for(const speaker of [null,'','   ']){const d=document();d.segments[1].speaker=speaker;assert.throws(()=>preview(d),/结构化/);assert.equal(d.segments[1].text,'[Text name] Source 1');}
 assert.throws(()=>preview(doc,{scope:'page'}));assert.throws(()=>preview(doc,{action:'infer'}));assert.throws(()=>preview(doc,{cueId:'missing'}));assert.equal(JSON.stringify(doc),before);
});

test('preview is frozen, bounded and opaque; replacement documents and forged plans cannot commit',()=>{
 const doc=document();doc.segments[1].text='🌴'.repeat(500);const plan=preview(doc,{scope:'speaker'});
 assert.ok(plan.preview.every(row=>row.text.length<=240));assert.ok(Object.isFrozen(plan));assert.ok(Object.isFrozen(plan.preview));assert.ok(Object.isFrozen(plan.preview[0]));assert.throws(()=>{plan.preview[0].toSpeaker='Hijacked';});
 for(const [target,p] of [[clone(doc),plan],[doc,clone(plan)],[doc,{...plan}]]){const before=JSON.stringify(target);assert.throws(()=>C.applySpeakerCorrectionPreview(target,p),/重新预览/);assert.equal(JSON.stringify(target),before);}
 assert.equal(C.applySpeakerCorrectionPreview(doc,plan).changed,true);
});

test('changed, added, removed or reordered targets reject the entire plan without partial writes',()=>{
 const mutations=[d=>{d.segments[1].speaker='New';},d=>{d.segments[80].text+=' edit';},d=>{d.segments[80].original_speaker='other';},d=>{d.segments[80].end++;},d=>{d.segments[80].start++;},d=>{d.segments[80].id='new-id';},d=>{d.segments[80].original_speaker=undefined;},d=>d.segments.pop(),d=>d.segments.push({id:'extra',start:300,end:301,text:'New',speaker:'A'}),d=>{d.segments[0].speaker='A';},d=>{[d.segments[1],d.segments[2]]=[d.segments[2],d.segments[1]];}];
 for(const mutate of mutations){const doc=document(),plan=preview(doc,{scope:'speaker'});mutate(doc);const before=JSON.stringify(doc),segments=doc.segments;assert.throws(()=>C.applySpeakerCorrectionPreview(doc,plan),/重新预览/);assert.equal(JSON.stringify(doc),before);assert.equal(doc.segments,segments);}
 const doc=document(),plan=preview(doc);doc.segments[0].text+=' Unrelated edit';doc.notes['cue-1']='New unrelated note';doc.readingPosition='cue-80';assert.equal(C.applySpeakerCorrectionPreview(doc,plan).changed,true);assert.equal(doc.notes['cue-1'],'New unrelated note');assert.equal(doc.readingPosition,'cue-80');
});

test('newer correction invalidates older plans even after restoring the same source label',()=>{
 const doc=document(),old=preview(doc);apply(doc);apply(doc,{action:'restore'});const before=JSON.stringify(doc);assert.throws(()=>C.applySpeakerCorrectionPreview(doc,old),/重新预览/);assert.equal(JSON.stringify(doc),before);
});

test('optional original_speaker validates strictly without imposing new limits on legacy labels',()=>{
 const doc=document(),long='Long label '.repeat(2000);doc.segments[1].speaker=long;let restored=C.validate(doc);assert.equal(restored.segments[1].speaker,long);assert.equal(Object.hasOwn(restored.segments[1],'original_speaker'),false);
 apply(restored);assert.equal(restored.segments[1].original_speaker,long);restored=C.validate(clone(restored));apply(restored,{action:'restore'});assert.equal(restored.segments[1].speaker,long);
 for(const bad of [null,undefined,42,{},[],true,'',' \n ']){const data=document();data.segments[1].original_speaker=bad;assert.throws(()=>C.validate(data),/原始说话人/);}
});

test('historical exact excerpts retain identical bytes, mark stale, and regain currency after restoration',()=>{
 const doc=document(),cue=doc.segments[1];doc.exact_excerpts=[C.exactExcerptSnapshot(doc,[cue],[],0,cue.text.length,{id:'excerpt',createdAt:'2026-10-11T00:00:00.000Z'})];
 const record=doc.exact_excerpts[0],bytes=JSON.stringify(record);assert.equal(C.exactExcerptFreshness(record,doc),'current');apply(doc);assert.equal(C.exactExcerptFreshness(record,doc),'stale');assert.equal(JSON.stringify(record),bytes);assert.equal(Object.hasOwn(record.snapshot.cues[0],'original_speaker'),false);
 assert.equal(C.validate(clone(doc)).exact_excerpts[0].snapshot.cues[0].speaker,'A');apply(doc,{action:'restore'});assert.equal(C.exactExcerptFreshness(record,doc),'current');assert.equal(JSON.stringify(record),bytes);
});

test('speaker-dependent translations, human reviews and passage questions stale; text-only dependencies stay current',()=>{
 const doc=document(3),cue=doc.segments[1],context='12345678-1234-1234-1234-123456789abc';
 const snap=doc.segments.map((c,position)=>({id:c.id,text:c.text,start:c.start,end:c.end,speaker:c.speaker,position}));doc.translation_contexts={[context]:snap};
 cue.translations.zh={text:'Context translation',source_text:cue.text,provider:'fixture',context_id:context};
 const review=C.manualReviewSnapshot(doc,cue,'fr');C.saveManualTranslation(doc,cue,'fr','Human translation',review,JSON.stringify(cue.translations.fr));
 const whole={question:C.SUMMARY_QUESTION,purpose:'summary',input_snapshot:{version:1,segments:doc.segments.map(({id,text})=>({id,text}))}};
 const passage={input_snapshot:{version:1,segments:[{id:cue.id,text:cue.text}],scope:{kind:'passage',passage_ids:[cue.id],expanded:false,source_title:doc.title,source_url:doc.source_url,source_language:doc.language,provider:'fixture',answer_language:'en',cues:[{id:cue.id,start:cue.start,end:cue.end,speaker:cue.speaker}]}}};
 const plan=S.plan(doc),job=S.create(plan,'codex'),request=S.request(plan,job);assert.ok(request.segments.every(s=>Object.keys(s).sort().join(',')==='id,text'));
 assert.equal(C.translationCurrent(cue,doc,cue.translations.zh),true);assert.equal(C.manualReviewCurrent(cue,doc,cue.translations.fr),true);assert.equal(C.answerFreshness(passage,doc),'current');assert.equal(C.summaryFreshness(whole,doc),'current');
 const historical=JSON.stringify({contexts:doc.translation_contexts,translations:cue.translations,passage,whole,job});apply(doc);const changed=doc.segments[1];
 assert.equal(C.translationCurrent(changed,doc,changed.translations.zh),false);assert.equal(C.manualReviewCurrent(changed,doc,changed.translations.fr),false);assert.equal(C.answerFreshness(passage,doc),'stale');assert.equal(C.translationCurrent(changed,doc,changed.translations.en),true);assert.equal(C.summaryFreshness(whole,doc),'current');assert.equal(S.current(job,doc),true);
 assert.equal(JSON.stringify({contexts:doc.translation_contexts,translations:changed.translations,passage,whole,job}),historical);
});

test('passages, text, notebook, VTT and JSON use corrected labels while SRT and source text stay untouched',()=>{
 const doc=document(3),srt=C.subtitleExport(doc,'srt').text,source=doc.segments.map(c=>c.text);apply(doc,{speaker:'New <speaker> & name'});
 assert.ok(P.build(doc.segments).some(p=>p.speaker==='New <speaker> & name'));assert.match(C.transcriptText(doc).text,/New <speaker> & name/);assert.match(C.notebookMarkdown(doc),/New/);
 assert.match(C.subtitleExport(doc,'vtt').text,/<v New &lt;speaker&gt; &amp; name>/);assert.equal(C.subtitleExport(doc,'srt').text,srt);assert.deepEqual(doc.segments.map(c=>c.text),source);
 const roundtrip=C.parse(JSON.stringify(doc),'labels.json');assert.equal(roundtrip.segments[1].speaker,'New <speaker> & name');assert.equal(roundtrip.segments[1].original_speaker,'A');
});

test('160 matching cues beyond multiple pages update completely; case and spacing remain exact labels',()=>{
 const doc=document(240);doc.segments[0].speaker='a';doc.segments[3].speaker=' A';doc.segments[6].speaker='A ';
 const plan=preview(doc,{scope:'speaker',speaker:'Merged'});assert.equal(plan.total,160);assert.equal(plan.preview.length,8);
 const result=C.applySpeakerCorrectionPreview(doc,plan);assert.equal(result.changedCount,160);assert.equal(result.cueIds.at(-1),'cue-239');assert.equal(doc.segments[239].speaker,'Merged');
 assert.deepEqual([0,3,6].map(i=>doc.segments[i].speaker),['a',' A','A ']);
 const restored=C.mergeLibraryBackup({documents:[],active:null},{format:'coconut-library',version:1,documents:[clone(doc)]});
 const imported=restored.documents[0];assert.equal(imported.segments[239].original_speaker,'A');apply(imported,{scope:'speaker',action:'restore'});assert.equal(imported.segments[239].speaker,'A');
});

test('new label boundary is explicit and shared; old long labels remain no-op or recoverable without truncation',()=>{
 assert.equal(C.SPEAKER_CORRECTION_LABEL_LIMIT,1000);const doc=document();
 apply(doc,{speaker:'x'.repeat(1000)});assert.equal(doc.segments[1].speaker.length,1000);const before=JSON.stringify(doc);
 assert.throws(()=>preview(doc,{speaker:'y'.repeat(1001)}),/1,000/);assert.equal(JSON.stringify(doc),before);apply(doc,{action:'restore'});assert.equal(doc.segments[1].speaker,'A');
 const long=' Original long label '.repeat(100);doc.segments[1].speaker=long;delete doc.segments[1].original_speaker;
 const old=doc.segments;assert.equal(apply(doc,{speaker:long}).changed,false);assert.equal(doc.segments,old);assert.equal(Object.hasOwn(doc.segments[1],'original_speaker'),false);
 apply(doc,{speaker:'short'});assert.equal(doc.segments[1].original_speaker,long);apply(doc,{action:'restore'});assert.equal(doc.segments[1].speaker,long);assert.equal(C.validate(clone(doc)).segments[1].speaker,long);
});

test('unrelated changes on targeted cues survive commit without rejecting the preview',()=>{
 const doc=document(),plan=preview(doc,{scope:'speaker'}),cue=doc.segments[80];
 cue.original_text='Newly retained text source';cue.saved_excerpt=true;cue.translations.en.text='Updated translation';cue.translations.en.original_translation={text:'Old translation'};cue.history=[{note:'Unrelated saved history'}];
 const expected=withoutLabels(doc),translations=cue.translations,history=cue.history;
 assert.equal(C.applySpeakerCorrectionPreview(doc,plan).changed,true);assert.equal(withoutLabels(doc),expected);assert.equal(doc.segments[80].translations,translations);assert.equal(doc.segments[80].history,history);assert.equal(doc.segments[80].speaker,'C');
});

test('preview and conflict checks never serialize or traverse unrelated cue payloads',()=>{
 const doc=document(3),cue=doc.segments[1];let topReads=0,nestedReads=0,serializations=0;
 const payload={toJSON(){serializations++;throw new Error('must not serialize payload');}};
 Object.defineProperty(payload,'largeHistory',{enumerable:true,get(){nestedReads++;throw new Error('must not traverse payload');}});
 for(const key of ['translations','history','saved_excerpt','original_text'])Object.defineProperty(cue,key,{enumerable:true,configurable:true,get(){topReads++;return key==='saved_excerpt'?true:key==='original_text'?'Historical source':payload;}});
 const plan=preview(doc);assert.equal(topReads,0);assert.equal(nestedReads,0);assert.equal(serializations,0);
 C.applySpeakerCorrectionPreview(doc,plan);assert.equal(topReads,4);assert.equal(nestedReads,0);assert.equal(serializations,0);assert.equal(doc.segments[1].translations,payload);assert.equal(doc.segments[1].history,payload);
 const noOp=preview(doc,{speaker:'C'});C.applySpeakerCorrectionPreview(doc,noOp);assert.equal(topReads,4);assert.equal(nestedReads,0);assert.equal(serializations,0);
});

test('five successive 10,000-cue previews do not amplify 12k-per-cue unrelated payloads',()=>{
 let serializations=0,nestedReads=0;
 const doc={segments:Array.from({length:10000},(_,i)=>{
  const translations={};Object.defineProperty(translations,'en',{enumerable:true,get(){nestedReads++;return {text:'x'.repeat(12000)};}});
  return {id:'large-'+i,start:i,end:i+1,text:'Source '+i,speaker:'A',translations,toJSON(){serializations++;return this;}};
 })};
 let plan;for(let i=0;i<5;i++){plan=C.createSpeakerCorrectionPreview(doc,{cueId:'large-0',scope:'speaker',speaker:'New '+i});assert.equal(plan.total,10000);assert.equal(plan.preview.length,8);}
 assert.equal(serializations,0);assert.equal(nestedReads,0);assert.equal(C.applySpeakerCorrectionPreview(doc,plan).changedCount,10000);assert.equal(serializations,0);assert.equal(nestedReads,0);assert.equal(doc.segments[9999].speaker,'New 4');
});
