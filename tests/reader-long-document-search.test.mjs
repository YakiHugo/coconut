/** Authored CPU-only fixtures; deterministic scheduling, never timing assertions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import C from '../reader/core.js';
import P from '../reader/passages.js';
const cue=(i,text='authored filler')=>({id:`cue-${i}`,text,start:i,end:i+1,speaker:null,translations:{}});
const document=(count=6000)=>({title:'Authored long document',language:'en',notes:{},segments:Array.from({length:count},(_,i)=>cue(i))});
function drain(iterator){let steps=0,result;do{result=iterator.next();if(!result.done){assert.equal(result.value,undefined,'no partial results escape');steps++;assert.ok(steps<100000);}}while(!result.done);return {value:result.value,steps};}
function control(doc){
 const tasks=[];let revision=0,changes=0;const documents=[doc];
 const search=C.createLibrarySearch({getDocuments:()=>documents,getRevision:()=>revision,schedule:run=>tasks.push(run),now:()=>0,workSize:1,onChange:()=>changes++});
 return {search,documents,step(){assert.ok(tasks.length);tasks.shift()();},drain(){let limit=100000;while(tasks.length){assert.ok(limit-->0);tasks.shift()();}},edit(){revision++;},get changes(){return changes;},get pending(){return tasks.length;}};
}
function snapshot(result){return {byCue:[...result.byCue].map(([id,entry])=>[id,JSON.parse(JSON.stringify(entry))]),previews:[...result.previews].map(([id,hit])=>[id,JSON.parse(JSON.stringify(hit))])};}

test('cold indexing yields within one document and warm KMP yields before complete publication',()=>{
 const d=document(50000);d.segments[49998].text='late boundary';d.segments[49999].text='phrase marker';
 let reads=0;for(const s of d.segments){const text=s.text;Object.defineProperty(s,'text',{get(){reads++;return text;}});}
 const c=control(d),job=c.search.request('boundary phrase','all','text');let slices=0;
 while(c.pending){const before=reads;c.step();assert.ok(reads-before<=256,'at most one 128-cue validation/build unit');slices++;
  if(job.pending){assert.equal(job.scanned,0);assert.deepEqual(job.docs,[]);}
 }
 assert.ok(slices>100);assert.equal(job.scanned,1);assert.deepEqual(job.docs,[d]);
 assert.deepEqual(C.libraryHits(d,'boundary phrase','text')[0].ids,['cue-49998','cue-49999']);
 const before=reads,warm=c.search.request('phrase marker','all','text');c.step();assert.equal(warm.pending,true);assert.equal(warm.scanned,0);c.drain();assert.deepEqual(warm.docs,[d]);assert.equal(reads,before,'warm searches do not reread source');
 assert.equal(c.search.request('phrase marker','all','text'),warm);assert.equal(c.pending,0);
});

test('iterator and detached synchronous APIs preserve Unicode offsets, phrase IDs and scope across checkpoints',()=>{
 const d=document(5000);d.segments[127].text='İ😀 left';d.segments[128].text='right';d.segments[4095].text='中文';d.segments[4096].text='短语';
 const build=drain(P.searchIndexSteps(d.segments,new Map([['fr',s=>s.id==='cue-127'?'bonjour':s.id==='cue-128'?'monde':null]])));
 assert.ok(build.steps>50);const index=build.value,{search}=index;
 for(const [query,scope] of [['i̇😀 left right','all'],['中文短语','all'],['bonjour monde','all'],['bonjour monde','text'],['not present','all']]){
  const actual=drain(index.searchSteps(query,scope));assert.ok(actual.steps>1);
  assert.deepEqual(snapshot(actual.value),snapshot(P.searchIndex(d.segments,new Map([['fr',s=>s.id==='cue-127'?'bonjour':s.id==='cue-128'?'monde':null]])).search(query,scope)));
  assert.equal(search(query,scope),actual.value,'detached sync consumer retains completed cache');
 }
 const unicode=search('i̇😀 left right');assert.deepEqual(unicode.byCue.get('cue-127').text,[{start:0,end:8}]);assert.deepEqual(unicode.previews.get('text:cue-127').ids,['cue-127','cue-128']);
 assert.deepEqual([...search('bonjour monde','text').byCue],[]);
});

test('long repetitive overlapping phrase resumes prefix, KMP, membership and range mapping without truncation',()=>{
 const cues=Array.from({length:6000},(_,i)=>cue(i,'a')),index=drain(P.searchIndexSteps(cues)).value,query=Array(3001).fill('a').join(' ');
 const result=drain(index.searchSteps(query));assert.ok(result.steps>100);assert.equal(result.value.byCue.size,6000);
 for(const entry of result.value.byCue.values())assert.deepEqual(entry.text,[{start:0,end:1}]);
 assert.deepEqual(result.value.previews.get('text:cue-0').ids,cues.slice(0,3001).map(s=>s.id));
 const sync=P.searchIndex(cues).search(query);assert.deepEqual([...result.value.byCue.keys()],[...sync.byCue.keys()]);
 assert.deepEqual([...result.value.previews.keys()],[...sync.previews.keys()]);
 for(const key of ['text:cue-0','text:cue-2999'])assert.deepEqual(result.value.previews.get(key).ids,sync.previews.get(key).ids);
});

test('abandoned query iterators never replace the prior complete cache with partial results',()=>{
 const index=P.searchIndex(document().segments),cached=index.search('authored');
 const operation=index.searchSteps('filler');assert.equal(operation.next().done,false);operation.return();
 assert.equal(index.search('authored'),cached);assert.equal(index.search('filler').byCue.size,6000);
});

test('cancel, new query and clear retire a partially built document without reading or publishing stale work',()=>{
 for(const action of ['cancel','replace','clear']){
  const d=document();let reads=0;for(const s of d.segments){const text=s.text;Object.defineProperty(s,'text',{get(){reads++;return text;}});}
  const c=control(d),old=c.search.request('filler','all','text');while(reads<512)c.step();assert.equal(old.pending,true);assert.equal(old.scanned,0);
  const before=reads,changes=c.changes;
  let next;if(action==='cancel')c.search.cancel();else next=c.search.request(action==='clear'?'':'missing','all',action==='clear'?'title':'text');
  assert.equal(old.operation,null);c.step();assert.equal(reads,before);assert.equal(c.changes,changes,'stale callback cannot notify or publish');c.drain();
  assert.equal(old.pending,true);assert.deepEqual(old.docs,[]);if(next)assert.deepEqual(next.docs,action==='clear'?[d]:[]);
 }
});

test('mid-build source edits, array replacement, language and translation metadata changes retire the snapshot',()=>{
 for(const change of ['source','array','language','contexts','glossary','identity','notes']){
  const d=document(),c=control(d),old=c.search.request('authored','all','text');
  for(let i=0;i<110;i++)c.step();assert.equal(old.pending,true,'mutation occurs inside indexing');
  if(change==='source'){d.segments[0].text='new marker';C.invalidateSearch(d);}
  if(change==='array')d.segments=d.segments.map(s=>({...s,text:'new marker'}));
  if(change==='language')d.language='fr';
  if(change==='contexts')d.translation_contexts={};
  if(change==='glossary')d.translation_glossary=[];
  if(change==='identity')c.documents[0]={...d,segments:d.segments.map(s=>({...s,text:'new marker'}))};
  if(change==='notes'){d.notes['cue-0']='new marker';c.edit();}
  c.drain();assert.equal(old.pending,true);assert.deepEqual(old.docs,[]);assert.equal(old.operation,null);
  const fresh=c.search.request('new marker','all','text');c.drain();
  assert.deepEqual(fresh.docs,['source','array','identity','notes'].includes(change)?[c.documents[0]]:[]);
  if(change==='source')assert.equal(C.searchDocument(d,'new marker').byCue.has('cue-0'),true);
 }
});

test('mid-query invalidation cannot restore an old source cache and metadata-only filters remain exact',()=>{
 const d=document();C.searchDocument(d,'authored');const c=control(d),old=c.search.request('filler','all','text');
 for(let i=0;i<60;i++)c.step();assert.equal(old.pending,true);
 d.segments[0].text='revised marker';C.invalidateSearch(d);const freshCache=C.searchDocument(d,'revised marker');c.drain();
 assert.equal(C.searchDocument(d,'revised marker'),freshCache);assert.deepEqual(old.docs,[]);
 d.notes['cue-5999']='late note';d.segments[5999].saved_excerpt=true;c.edit();
 for(const scope of ['title','notes','text'])for(const kind of ['all','annotated','audio','transcript']){
  const result=c.search.request('late note',kind,scope);c.drain();assert.deepEqual(result.docs,C.libraryMatches(d,'late note',kind,scope)?[d]:[]);
 }
});

test('shelf-built cache includes only current source/context-backed translations',()=>{
 const d=document(),a=d.segments[127],b=d.segments[128];
 const snapshot=[127,128].map(position=>{const s=d.segments[position];return {id:s.id,text:s.text,start:s.start,end:s.end,position,speaker:s.speaker};});d.translation_contexts={pair:snapshot};
 for(const [s,text] of [[a,'中文'],[b,'短语']])s.translations.zh={text,source_text:s.text,document_language:'en',provider:'Authored',context_id:'pair',target_language:'zh',glossary_snapshot:[]};
 const c=control(d);let job=c.search.request('filler','all','text');c.drain();assert.deepEqual(job.docs,[d]);assert.deepEqual([...C.searchDocument(d,'中文短语').byCue.keys()],[a.id,b.id]);
 a.text='corrected source';C.invalidateSearch(d);job=c.search.request('corrected source','all','text');c.drain();assert.deepEqual(job.docs,[d]);assert.equal(C.searchDocument(d,'中文短语').byCue.size,0);
 a.text='authored filler';C.invalidateSearch(d);d.translation_contexts={pair:snapshot.map(s=>({...s,text:'obsolete context'}))};job=c.search.request('filler','all','text');c.drain();assert.equal(C.searchDocument(d,'中文短语').byCue.size,0);
});

 test('case-expansion offset indexing yields within one oversized cue without changing its offsets',()=>{
 const segments=[cue(0,'İ'.repeat(10000)+'😀 marker')],built=drain(P.searchIndexSteps(segments));assert.ok(built.steps>=4);
 const result=drain(built.value.searchSteps('i̇😀 marker'));assert.ok(result.steps>=9);
 assert.deepEqual(result.value.byCue.get('cue-0').text,[{start:9999,end:10009}]);
 assert.equal(result.value.previews.get('text:cue-0').snippet.match,'İ😀 marker');
 });
