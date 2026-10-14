/**
 * CPU-only authored fixture. No browser, timer-clamping, rendering, storage,
 * native device, network, or model measurements. Run from the repository root:
 *   flock /tmp/coconut-full-gates.lock node --expose-gc benchmarks/library-search.mjs
 * Pass another checkout as the first argument for a baseline comparison.
 * LIBRARY_PROFILE_SAMPLES defaults to 5; LIBRARY_PROFILE_COMMON_ONLY=1 narrows
 * the experiment to the 100-document common-English case for CPU profiling.
 * Timing values are observations, never correctness-test thresholds.
 */
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(process.argv[2]||fileURLToPath(new URL('../',import.meta.url)));
const require=createRequire(import.meta.url),C=require(resolve(root,'reader/core.js'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const seed=0xc0c02026,cuesPerDocument=600,samples=Number(process.env.LIBRARY_PROFILE_SAMPLES)||5;
const words=['careful','research','people','morning','different','evidence','learning','public','walking','process','important','between','listen','compare','local','conversation','reason','future','reading','question'];
const chinese=['仔细阅读','证据来源','日常学习','公共空间','交流讨论','工作计划','不同观点','真实记录','重要问题','理解变化','保持联系','整理笔记','生活经验','比较方法','继续观察','表达清楚'];
function fixture(count){
 let state=seed;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
 return Array.from({length:count},(_,d)=>{
  const zh=d%2===1,pool=zh?chinese:words;
  return {key:'doc-'+d,schema_version:1,title:(zh?'自写访谈':'Authored interview')+' '+d,language:zh?'zh':'en',notes:{},segments:Array.from({length:cuesPerDocument},(_,i)=>({
   id:'doc-'+d+'-cue-'+i,start:i*6,end:i*6+5.9,
   text:(zh?'这个话题':'The topic ')+Array.from({length:zh?8:12},()=>pool[random()%pool.length]).join(zh?'，':' ')+(i===cuesPerDocument-1&&d===count-2?' uniquequartzmarker 独特石英标记':'')+(zh?'。':'.'),
  }))};
 });
}
const queries=[['empty',''],['rare-en','uniquequartzmarker'],['rare-zh','独特石英标记'],['common-en','the'],['common-zh','话题'],['absent','no-such-authored-marker']];
const percentile=(values,fraction)=>values.length?values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*fraction))]:0;
function run(documents,query,prime=false){
 const tasks=[],sliceTimes=[];
 const search=C.createLibrarySearch({getDocuments:()=>documents,schedule:fn=>tasks.push(fn)});
 if(prime){
  const job=search.request('index priming query','all','text');
  while(tasks.length)tasks.pop()();
  if(job.pending)throw Error('Index prime did not complete');
 }
 const cpu=process.cpuUsage(),start=performance.now();
 const job=search.request(query,'all','text','title'),inputMs=performance.now()-start;
 while(tasks.length){const started=performance.now();tasks.pop()();sliceTimes.push(performance.now()-started);}
 const totalMs=performance.now()-start,cpuMs=Object.values(process.cpuUsage(cpu)).reduce((a,b)=>a+b)/1000;
 if(job.pending||job.scanned!==documents.length)throw Error('Search did not complete');
 const resultHash=hash(JSON.stringify(job.docs.map(d=>d.key)));
 const reusedStart=performance.now();
 if(search.request(query,'all','text','title')!==job)throw Error('Completed result identity changed');
 const reusedMs=performance.now()-reusedStart;
 // Actual shelf limit: forty documents with at most three source previews each.
 const visibleStart=performance.now();
 const visible=job.docs.slice(0,40).flatMap(d=>C.libraryHits(d,query,'text'));
 const visiblePreviewMs=performance.now()-visibleStart;
 // Materialize every source preview separately to expose deferred work instead
 // of hiding it in a getter. Hashing is outside this measured serialization.
 const serializeStart=performance.now();
 const all=query?documents.map(d=>[d.key,...C.searchDocument(d,query,'text').previews.values()]):[];
 const serialized=JSON.stringify(all),allPreviewSerializationMs=performance.now()-serializeStart;
 return {inputMs,totalMs,cpuMs,maxSliceMs:Math.max(0,...sliceTimes),p95SliceMs:percentile(sliceTimes,.95),p99SliceMs:percentile(sliceTimes,.99),
  slices:sliceTimes.length,reusedMs,visiblePreviewMs,visibleSearchTotalMs:totalMs+visiblePreviewMs,visiblePreviewCount:visible.length,
  allPreviewSerializationMs,previewHash:hash(serialized),matches:job.docs.length,resultHash};
}
const fields=['inputMs','totalMs','cpuMs','maxSliceMs','p95SliceMs','p99SliceMs','slices','reusedMs','visiblePreviewMs','visibleSearchTotalMs','visiblePreviewCount','allPreviewSerializationMs','matches'];
const summarize=values=>Object.fromEntries(fields.map(key=>[key,percentile(values.map(value=>value[key]),.5)]));
const rows=[],commonOnly=Boolean(process.env.LIBRARY_PROFILE_COMMON_ONLY);
run(fixture(10),'warmup');
for(const count of (commonOnly?[100]:[10,50,100]))for(const [name,query] of (commonOnly?queries.filter(([name])=>name==='common-en'):queries)){
 const cold=[],warm=[];
 for(let i=0;i<samples;i++){
  let documents=fixture(count);global.gc?.();cold.push(run(documents,query));
  documents=fixture(count);global.gc?.();warm.push(run(documents,query,true));
 }
 const expected=name==='empty'?count:name.startsWith('rare')?1:name.startsWith('common')?count/2:0;
 if(new Set([...cold,...warm].map(row=>row.resultHash)).size!==1||new Set([...cold,...warm].map(row=>row.previewHash)).size!==1||[...cold,...warm].some(row=>row.matches!==expected))throw Error('Unstable result: '+count+' '+name);
 const row={documents:count,cuesPerDocument,characters:fixture(count).reduce((n,d)=>n+d.segments.reduce((m,s)=>m+s.text.length,0),0),query:name,
  cold:summarize(cold),warmIndex:summarize(warm),stable:true,resultHash:cold[0].resultHash,previewHash:cold[0].previewHash,samples:{cold,warm}};
 rows.push(row);console.error(count,name,JSON.stringify({cold:row.cold,warmIndex:row.warmIndex}));
}
console.log(JSON.stringify({node:process.version,seed,cuesPerDocument,samples,forcedGcOutsideMeasurements:Boolean(global.gc),
 sourceSha256:{core:hash(readFileSync(resolve(root,'reader/core.js'))),passages:hash(readFileSync(resolve(root,'reader/passages.js')))},
 fixture:'600 six-second cues per document, 60-minute authored transcripts; alternating English and Chinese; no saved quotations or translations',
 summary:'Each summary field is the median of five runs by default; slice percentiles are computed within each run, then summarized. Raw per-run observations are retained.',
 kind:'CPU-only synchronous scheduler drain; no browser, rendering, I/O, native or actual timer latency claims',rows},null,2));
