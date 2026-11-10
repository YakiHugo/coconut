/** Local rules first, bounded optional fallback, immutable source projection. */
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runCommand,safeEnvironment} from './providers.mjs';
import {createReadingFallback} from './reading-fallback.mjs';
const require=createRequire(import.meta.url),D=require('../reader/disfluency.js');
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
// Keep logical identity names stable; packaged desktop modules live in app.asar,
// while Python, reader and shared resources remain beside it in Resources.
const files=[
 ...['transcript_cleanup.py','transcript_boundaries.py','reader/disfluency.js','shared/reading-fallback.js'].map(file=>[file,new URL('../'+file,import.meta.url)]),
 ...['reading-fallback.mjs','clean-reading.mjs'].map(file=>['desktop/'+file,new URL('./'+file,import.meta.url)])
];
export async function cleanReadingIdentity(){return hash(await Promise.all(files.map(async([file,url])=>[file,hash(await readFile(url,'utf8'))])));}
export function readingSource(document){
 const fields=['id','text','start','end','speaker','speaker_id','words','alignment_status','timing_basis'];
 const source={key:document.key||'',title:document.title||'',segments:document.segments.map(cue=>Object.fromEntries(fields.filter(k=>Object.hasOwn(cue,k)).map(k=>[k,cue[k]])))};
 source.transcription_glossary=(Array.isArray(document.transcription_glossary)?document.transcription_glossary:[]).map(t=>({term:typeof t==='string'?t:t?.term})).filter(t=>typeof t.term==='string'&&t.term.length>=2&&t.term.length<=120).slice(0,100);
 source.speaker_identity_evidence={speakers:(Array.isArray(document.speaker_identity_evidence?.speakers)?document.speaker_identity_evidence.speakers:[]).map(s=>({name:s.name})).filter(s=>typeof s.name==='string'&&s.name.length>=2&&s.name.length<=120).slice(0,64)};
 D.signature(source);return JSON.parse(JSON.stringify(source));
}

/** Merge masks without moving an inserted mark across any visible source text. */
export function mergeReadingEdits(document,{decisions=[],marks=[],breaks=[]}={}){
 const groups=new Map(),byId=new Map(document.segments.map(c=>[c.id,c]));
 for(const edit of decisions){if(edit.action!=='hide')continue;if(!groups.has(edit.cue_id))groups.set(edit.cue_id,[]);groups.get(edit.cue_id).push(edit);}
 const merged=[];
 for(const [cue_id,rows] of groups){
  rows.sort((a,b)=>a.from-b.from||a.to-b.to);const spans=[];
  for(const row of rows){const prior=spans.at(-1);if(prior&&row.from<=prior.to){prior.to=Math.max(prior.to,row.to);if(prior.reason!==row.reason)prior.reason='reading_cleanup';}
   else spans.push({cue_id,from:row.from,to:row.to,action:'hide',reason:row.reason});}
  merged.push(...spans);
 }
 const normalize=rows=>{
  const map=new Map();for(const row of rows){let at=row.at;
   for(const edit of merged)if(edit.cue_id===row.cue_id&&edit.from<at&&at<edit.to){at=edit.from;break;}
   const id=row.cue_id+':'+at;
   if(map.has(id)){const prior=map.get(id);if(prior.mark!==row.mark)throw Error('阅读断句建议冲突，已保留原稿');continue;}
   map.set(id,{...row,at});}
  return [...map.values()].sort((a,b)=>document.segments.indexOf(byId.get(a.cue_id))-document.segments.indexOf(byId.get(b.cue_id))||a.at-b.at);
 };
 return {decisions:merged,marks:normalize(marks),breaks:normalize(breaks)};
}

export function createCleanReadingPlanner({python='python3',fallback=createReadingFallback(),run=runCommand,environment=process.env}={}){
 const env=safeEnvironment(environment);
 return {
  identity:cleanReadingIdentity,
  async prepare(document,{directory,provider='',model='',audioPath=null,signal,onProgress=()=>{},boundaryPlan=null}={}){
   if(!path.isAbsolute(directory||'')||!['','codex'].includes(provider))throw Error('阅读整理配置无效');
   const source=readingSource(document),sourceSignature=D.signature(document),identity=await cleanReadingIdentity();
   await mkdir(directory,{recursive:true,mode:0o700});
   onProgress({phase:'rules'});
   const local=await run(python,['-c','import json,sys;from transcript_cleanup import decisions;print(json.dumps(decisions(json.load(sys.stdin)),ensure_ascii=False))'],
    {cwd:ROOT,env,input:JSON.stringify(source),signal,timeout:120000,maxBytes:16*1024*1024});
   if(local.code!==0)throw Error('本地口语规则未完成，原稿已保留');
   const base=JSON.parse(local.stdout);let boundaries=boundaryPlan;
   if(!boundaries){
    onProgress({phase:'boundaries'});
    const result=await run(python,[path.join(ROOT,'transcript_boundaries.py'),'--stdio'],
     {cwd:ROOT,env,input:JSON.stringify({document:source,audioPath,workDirectory:path.join(directory,'acoustic'),reading_cleanup:base}),signal,timeout:600000,maxBytes:16*1024*1024});
    if(result.code!==0)throw Error('停顿断句未完成，原稿已保留');boundaries=JSON.parse(result.stdout);
   }
   const localEdits=mergeReadingEdits(source,{decisions:[...base.decisions,...(boundaries.decisions||[])],marks:boundaries.marks||[],breaks:boundaries.breaks||[]});
   // Validate local output before it can be supplied as context to a text model.
   D.createProjection(source,{...localEdits,policyVersion:'conservative-reading-v3',sourceSignature});
   onProgress({phase:provider?'fallback':'validate'});
   const boundaryCandidates=(boundaries.issues||[]).flatMap(issue=>(issue.candidate_marks||[]).map(candidate=>({cue_id:issue.cue_id,at:candidate.at,
    allowed_marks:candidate.allowed_marks||[candidate.mark||'。'],reason:issue.reason,priority:issue.priority,from:issue.from,to:issue.to,context_ids:issue.context_ids||[]})));
   const reviewed=await fallback.run(source,{directory:path.join(directory,'fallback'),provider,model,baseDecisions:localEdits.decisions,
    boundaryCandidates,maxFraction:.1,maxWindows:12,maxRequests:3,signal,onProgress});
   const final=mergeReadingEdits(source,{decisions:[...localEdits.decisions,...(reviewed.decisions||[])],marks:[...localEdits.marks,...(reviewed.marks||[])],breaks:localEdits.breaks});
   const projection=D.createProjection(document,{...final,policyVersion:'conservative-reading-v3',sourceSignature});
   const stats={edits:final.decisions.length,hiddenCharacters:final.decisions.reduce((n,e)=>n+e.to-e.from,0),sourceCharacters:source.segments.reduce((n,c)=>n+c.text.length,0),
    marks:final.marks.length,breaks:final.breaks.length,ruleEdits:localEdits.decisions.length,ruleMarks:localEdits.marks.length,
    fallbackEdits:(reviewed.decisions||[]).length,fallbackMarks:(reviewed.marks||[]).length,llmCalls:reviewed.stats?.historicalRequests??reviewed.stats?.requests??0,llmCallsThisRun:reviewed.stats?.requests||0};
   const reading_cleanup={version:1,policyVersion:'conservative-reading-v3',sourceSignature,...final,stats,
    issues:[...(boundaries.issues||[]),...(reviewed.issues||[])],fallback:{provider,model,stats:reviewed.stats||{},identity:reviewed.identity||null},
    provenance:{method:'local_rules_with_optional_bounded_fallback',policy_sha256:identity,automatic_unreviewed:true},
    boundarySummary:{acoustic:boundaries.acousticSummary||boundaries.acoustic_summary||null,cueBoundaries:boundaries.cue_boundaries||[]}};
   signal?.throwIfAborted();
   const result={reading_cleanup,sourceSignature,identity,projectionStats:{cues:projection.cues.length},fallback:reviewed,local:{base,boundaries}};
   await writeFile(path.join(directory,'result.tmp'),JSON.stringify(result),{mode:0o600});await rename(path.join(directory,'result.tmp'),path.join(directory,'result.json'));
   return result;
  }
 };
}
