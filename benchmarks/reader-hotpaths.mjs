/** Local synthetic microbenchmark; timings are observations, never test thresholds. */
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {Window} from 'happy-dom';
const root=new URL(process.argv[2]||'../',import.meta.url);
const iterations=20,timingRuns=3;
const w=new Window({url:'https://coconut.example/'});
w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
for(const name of ['summary','core','passages','passage-playback'])w.eval(fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8'));
w.eval(['app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+`
window.readerProbe={set(doc){state={documents:[doc],active:doc.key};},renderPassages,renderPassagePlayback,playbackSegment,highlightPlayback,matchesReadingSegment};`);
const originalBuild=w.CoconutPassages.build;
let builds=0,visits=0;
w.CoconutPassages={...w.CoconutPassages,build(...args){builds++;return originalBuild(...args);}};
const rows=[];
function measure(name,run){builds=0;visits=0;const start=performance.now();run();return {name,ms:+(performance.now()-start).toFixed(3),passageBuilds:builds,cueReads:visits};}
try {
 for(const count of [1771,20000,50000]){
  const entry={cues:count,iterations,measurements:[]};
  for(let run=0;run<=timingRuns;run++){
  const instrumented=run===0;
  const raw=Array.from({length:count},(_,i)=>({id:'cue-'+i,start:i*2,end:i*2+1.8,text:'Authored sentence '+i+'.'}));
  const segments=instrumented?new Proxy(raw,{get(target,key,receiver){if(typeof key==='string'&&/^\d+$/.test(key))visits++;return Reflect.get(target,key,receiver);}}):raw;
  const doc={key:'synthetic-'+count,title:'Synthetic transcript',segments,notes:{}};
  w.readerProbe.set(doc);
  const player=w.document.createElement('audio');Object.defineProperty(player,'duration',{value:count*2});w.document.getElementById('source-media').replaceChildren(player);
  const measurements=[];
  measurements.push(measure('render first eight passages',()=>w.readerProbe.renderPassages(doc)));
  measurements.push(measure('20 passage control refreshes',()=>{for(let i=0;i<iterations;i++)w.readerProbe.renderPassagePlayback({status:'idle'});}));
  measurements.push(measure('60 cue lookups at early/middle/late positions',()=>{for(let i=0;i<iterations;i++)for(const index of [1,Math.floor(count/2),count-2]){player.currentTime=index*2+.5;const cue=w.readerProbe.playbackSegment();if(cue?.id!=='cue-'+index)throw Error('Wrong cue');}}));
  measurements.push(measure('60 warmed playback highlights',()=>{for(let i=0;i<iterations;i++)for(const index of [1,Math.floor(count/2),count-2]){player.currentTime=index*2+.5;w.readerProbe.highlightPlayback();}}));
  measurements.push(measure('20 literal full-text scans',()=>{for(let i=0;i<iterations;i++)segments.filter(cue=>w.readerProbe.matchesReadingSegment(cue,doc,'sentence 17'));}));
  if(instrumented)entry.measurements=measurements.map(({ms,...counts})=>counts);
  else measurements.forEach((result,i)=>(entry.measurements[i].uninstrumentedSamplesMs??=[]).push(result.ms));
  }
  for(const result of entry.measurements)result.uninstrumentedMedianMs=[...result.uninstrumentedSamplesMs].sort((a,b)=>a-b)[Math.floor(timingRuns/2)];
  rows.push(entry);
 }
 console.log(JSON.stringify({node:process.version,platform:process.platform,iterations,timingRuns,rows},null,2));
}finally{await w.happyDOM.close();}
