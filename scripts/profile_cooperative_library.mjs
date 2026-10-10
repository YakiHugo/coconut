/** CPU-only authored fixtures. Run under the shared full-gates lock. No browser latency claims. */
import {performance} from 'node:perf_hooks';
import Coconut from '../reader/core.js';
import {largeLibraryFixture} from '../tests/helpers/large-library-fixture.mjs';
const results=[];
const percentile=(values,fraction)=>values.length?values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*fraction))]:0;
for(const [count,cues] of [[5000,8],[150,2000],[1,50000]]){
 const documents=largeLibraryFixture(count,{cues});
 for(const doc of documents)doc.segments.at(-1).text='authored final needle';
 const tasks=[];const search=Coconut.createLibrarySearch({getDocuments:()=>documents,schedule:run=>tasks.push(run),now:()=>performance.now()});
 for(const [temperature,query] of [['cold','final needle'],['warm-index','authored final'],['warm-result','authored final']]){
  const start=performance.now();const job=search.request(query,'all','text','title');const inputMs=performance.now()-start;const slices=[];
  while(tasks.length){const begin=performance.now();tasks.shift()();slices.push(performance.now()-begin);}
  results.push({documents:count,cuesPerDocument:cues,temperature,inputMs:+inputMs.toFixed(2),totalMs:+(performance.now()-start).toFixed(2),medianSliceMs:+percentile(slices,0.5).toFixed(2),p95SliceMs:+percentile(slices,0.95).toFixed(2),maxSliceMs:+Math.max(0,...slices).toFixed(2),slices:slices.length,matched:job.docs.length});
 }
}
console.log(JSON.stringify({environment:'Node '+process.version+' CPU-only; resumable cue/character work; whole-run join/fold and final sort remain atomic; no browser/input latency measurement',results},null,2));
