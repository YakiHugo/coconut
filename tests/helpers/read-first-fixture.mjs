// Authored local fixtures only. No provider result or external source is used.
export function readFirstFixture(count=3,{summary=null,job=false,bookmark=null,demo=false}={}){
 const doc={key:`read-first-${count}-${summary||'none'}-${job}-${demo}`,title:`Authored read-first ${count} ${summary||'source'}`,language:'en',segments:Array.from({length:count},(_,i)=>({id:`read-${i}`,start:i*5,end:i*5+4,text:`Authored observation ${i+1}: read the source before forming a conclusion.`}))};
 if(demo){doc.provenance={kind:'authored_demo'};doc.translation_view='zh';doc.segments.forEach(cue=>{cue.translations={zh:{text:'自写测试译文。',source_text:cue.text,source_language:'en',document_language:'en',provider:'authored fixture'}};});}
 if(summary){const answer={purpose:'summary',question:'Authored summary fixture',answer:'A saved authored summary.',provider:'authored fixture',citations:['read-0']};if(summary!=='unknown')answer.input_snapshot={version:1,segments:doc.segments.map(({id,text})=>({id,text:summary==='stale'?text+' Previous source.':text}))};doc.ai_answers=[answer];}
 if(job)doc.summary_job={version:1,provider:'codex',snapshot:doc.segments.map(({id,text})=>({id,text})),results:[],status:'paused',in_flight:null};
 if(bookmark)doc.readingPosition=bookmark;
 return doc;
}
