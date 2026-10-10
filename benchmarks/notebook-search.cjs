/** Authored, bounded core-only probe. No browser/network, no timing assertions.
 * Usage: node --expose-gc benchmarks/notebook-search.cjs [cooperative|synchronous] [core.js path]
 * Use flock/timeout as documented in docs/notebook-performance.md on shared hosts.
 */
const {performance}=require('node:perf_hooks'),path=require('node:path');
const mode=process.argv[2]||'cooperative';
if(!['cooperative','synchronous'].includes(mode))throw Error('Expected cooperative or synchronous');
const C=require(process.argv[3]?path.resolve(process.argv[3]):'../reader/core.js');
const fixtures=(n,cues,dense=false)=>Array.from({length:n},(_,d)=>({key:'authored-'+d,title:'Authored notebook document '+d,
 segments:Array.from({length:cues},(_,i)=>({id:'cue-'+i,start:i*2,end:i*2+1,text:'Authored source sentence '+i+' from document '+d+'.',saved_excerpt:dense})),
 notes:{['cue-'+(cues-1)]:'Private end note '+d}}));
const result={node:process.version,mode,measurement:'Node CPU wall durations, not browser frames. Raw GC/preemption outliers retained; no hard latency guarantee.',cases:[]};
async function synchronous(label,docs,query){
 const samplesMs=[];let count;C.libraryCaptures(docs,query);
 for(let i=0;i<5;i++){const start=performance.now();count=C.libraryCaptures(docs,query).length;samplesMs.push(performance.now()-start);}
 const start=performance.now(),timer=new Promise(resolve=>setTimeout(()=>resolve(performance.now()-start),0));C.libraryCaptures(docs,query);
 result.cases.push({label,documents:docs.length,cues:docs.reduce((n,d)=>n+d.segments.length,0),query,kind:'all',count,samplesMs,
  medianMs:[...samplesMs].sort((a,b)=>a-b)[2],timerDelayMs:await timer});
}
async function run(){
 if(mode==='synchronous'){
  for(const n of [100,1000]){let docs=fixtures(n,1000);await synchronous('sparse initial open',docs,'');await synchronous('sparse missing search',docs,'never-present-marker');await synchronous('sparse page-change same query',docs,'Private');docs=null;global.gc?.();}
  const docs=fixtures(100,1000,true);await synchronous('dense initial open',docs,'');await synchronous('dense missing search',docs,'never-present-marker');await synchronous('dense title query',docs,'Authored notebook');
 }else{
  for(const [label,n,cues,dense,query] of [['sparse initial',1000,1000,false,''],['sparse missing',1000,1000,false,'never-present-marker'],['dense initial',100,1000,true,''],['dense missing',100,1000,true,'never-present-marker']]){
   const docs=fixtures(n,cues,dense),trials=[];
   for(let i=0;i<5;i++){
    const queue=[],search=C.createLibraryNotebookSearch({getDocuments:()=>docs,schedule:fn=>queue.push(fn)}),start=performance.now(),job=search.request(query);
    const requestMs=performance.now()-start,sliceSamplesMs=[];
    while(queue.length){const step=queue.shift(),t=performance.now();step();sliceSamplesMs.push(performance.now()-t);}
    const t=performance.now(),same=search.request(query);const repeatMs=performance.now()-t;
    trials.push({requestMs,steps:sliceSamplesMs.length,totalSliceMs:sliceSamplesMs.reduce((a,b)=>a+b,0),maxSliceMs:Math.max(...sliceSamplesMs),repeatMs,same:same===job,count:job.captures.length,sliceSamplesMs});search.cancel();
   }
   result.cases.push({label,documents:n,cues:n*cues,dense,query,trials});global.gc?.();
  }
 }
 console.log(JSON.stringify(result,null,2));
}
run().catch(error=>{console.error(error);process.exitCode=1;});
