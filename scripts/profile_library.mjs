/** Node/HappyDOM CPU/DOM proxy. Does not measure browser layout or input latency. */
import {performance} from 'node:perf_hooks';
import {libraryHarness} from '../tests/helpers/large-library-harness.mjs';
import {largeLibraryFixture} from '../tests/helpers/large-library-fixture.mjs';
const results=[];
const sourceRoot=process.argv[2]?new URL(process.argv[2]):undefined;
for(const count of [100,1000,5000]){
 const tasks=[];
 const {w,$}=libraryHarness(largeLibraryFixture(count),{probe:true,sourceRoot,configureCore(w){const create=w.Coconut.createLibrarySearch;if(create)w.Coconut.createLibrarySearch=options=>create({...options,schedule:run=>tasks.push(run)});}});
 try{
  const sample=(run,n=5)=>{const times=[];for(let i=0;i<n;i++){const start=performance.now();run(i);times.push(performance.now()-start);}return Number(times.sort((a,b)=>a-b)[Math.floor(n/2)].toFixed(2));};
  const refreshMs=sample(()=>w.libraryProbe.renderLibrary());
  const titleQueryMs=sample(i=>{$('library-search').value=i%2?'Authored':'shelf';$('library-search').oninput();});
  $('library-scope').value='text';const fullTextQueryMs=sample(i=>{$('library-search').value=i%2?'source sentence':'Authored document';$('library-search').oninput();while(tasks.length)tasks.shift()();},3);
  $('library-scope').value='title';$('library-search').value='';$('library-search').oninput();
  const card=$('library').querySelector('.library-open');card.focus();w.libraryProbe.renderLibrary();
  results.push({documents:count,cuesPerDocument:8,mountedCards:$('library').children.length,refreshMedianMs:refreshMs,titleQueryMedianMs:titleQueryMs,fullTextQueryMedianMs:fullTextQueryMs,unchangedCardRetained:card.isConnected,focusedCardRetained:w.document.activeElement===card});
 }finally{await w.happyDOM.close();}
}
console.log(JSON.stringify({environment:'Node '+process.version+' / HappyDOM; authored 8-cue documents; warm medians',results},null,2));
