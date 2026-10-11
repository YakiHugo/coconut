// Run from the repository root under the shared full-gates lock.
import C from '../../reader/core.js';
import {performance} from 'node:perf_hooks';
function document(text,note='',count=1){
 const record={version:1,id:'quote',created_at:'2026-10-11T01:00:00.000Z',text,snapshot:{source:{title:'Authored profile',language:'en',source_url:''},cues:[{id:'captured',text,start:0,end:1,speaker:null}],separators:[],from:0,to:text.length}};
 return {...C.validate({title:'Authored profile',segments:[{id:'live',text:'unrelated',start:0,end:1}],exact_excerpts:Array.from({length:count},(_,i)=>({...record,id:'quote-'+i})),...(note?{exact_excerpt_notes:{'quote-0':note}}:{})}),segments:[],key:'profile'};
}
const rows=[];
for(const [name,doc,query,scope,field] of [
 ['2M quotation, late match',document('x'.repeat(2_000_000)+' late needle'),'needle','text','quote'],
 ['2M note, late match',document('quotation','x'.repeat(2_000_000)+' late needle'),'needle','notes','note'],
 ['2M note with Unicode expansion',document('quotation','İ'+'x'.repeat(2_000_000)+' late needle'),'needle','notes','note'],
 ['2M whitespace-only note',document('quotation',' '.repeat(2_000_000)),'needle','notes','note'],
 ['5,000 historical records, no live cues',document('saved needle','',5000),'needle','text','quote'],
 ]){
 const text=field==='note'?C.exactExcerptNote(doc,'quote-0'):doc.exact_excerpts[0].text;
 let start=performance.now();text.toLocaleLowerCase();const atomicLowercaseMs=performance.now()-start;
 const tasks=[],search=C.createLibrarySearch({getDocuments:()=>[doc],schedule:fn=>tasks.push(fn)});
 start=performance.now();const job=search.request(query,'all',scope),inputMs=performance.now()-start;let maxSliceMs=0,slices=0,totalMs=inputMs;
 while(tasks.length){start=performance.now();tasks.shift()();const duration=performance.now()-start;maxSliceMs=Math.max(maxSliceMs,duration);totalMs+=duration;slices++;}
 start=performance.now();if(search.request(query,'all',scope)!==job)throw Error('cache not reused');const reusedMs=performance.now()-start;
 rows.push({name,characters:text.length,records:doc.exact_excerpts.length,matchedRecords:job.savedHits.get(doc)?.total||0,previewCount:job.savedHits.get(doc)?.hits.length||0,inputMs,totalMs,maxSliceMs,slices,reusedMs,atomicLowercaseMs});
}
console.log(JSON.stringify({runtime:process.version,kind:'Single-run authored CPU observations, not browser latency or a hard scheduling guarantee',rows},null,2));
