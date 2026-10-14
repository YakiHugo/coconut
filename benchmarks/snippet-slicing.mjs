/** Bounded preview work on short and giant authored fields; no timing assertions. */
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(process.argv[2]||fileURLToPath(new URL('../',import.meta.url)));
const P=createRequire(import.meta.url)(resolve(root,'reader/passages.js'));
const iterations=10000,samples=5,rows=[];
for(const [name,unit] of [['bmp','Authored 中文，e\u0301\r\n'],['astral','Authored 😀𠮷👩‍💻，中文\r\n']])for(const length of [1000,2000000]){
 const text=unit.repeat(Math.ceil(length/unit.length)).slice(0,length),times=[];let checksum=0;
 for(let sample=-1;sample<samples;sample++){
  global.gc?.();const start=performance.now();
  for(let i=0;i<iterations;i++){
   const from=100+(i*31)%(text.length-500),snippet=P.rangeSnippet(text,from,from+300);
   checksum+=snippet.before.length+snippet.match.length+snippet.after.length;
  }
  const duration=performance.now()-start;if(sample>=0)times.push(duration);
 }
 rows.push({name,characters:text.length,iterations,medianMs:[...times].sort((a,b)=>a-b)[Math.floor(samples/2)],samplesMs:times,checksum});
}
console.log(JSON.stringify({node:process.version,samples,kind:'CPU-only authored repeated rangeSnippet calls; warmup excluded, explicit GC outside timing, checksum retains output work',rows},null,2));
