import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const require=createRequire(import.meta.url),C=require('../reader/core.js'),D=require('../reader/disfluency.js');
const canonical=require('../reader/canonical-library.js'),library=require('../reader/library-store.js');
const bundle=await build({stdin:{contents:"export {createAppStore} from './frontend/app/store';export {prepareCleanup} from './frontend/reader-workspace/cleanup';",resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',write:false,platform:'node'});
const {createAppStore,prepareCleanup}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const source=()=>({key:'cli-source',title:'自写导入回归',segments:[{id:'a',start:0,end:3,speaker:'甲',text:'我呃知道然后继续。',
 words:[{word:'我',start:0,end:.3,text_start:0,text_end:1},{word:'呃',start:.3,end:.4,text_start:1,text_end:2},{word:'知道然后继续。',start:.5,end:3,text_start:2,text_end:9}]}]});
function withPlan(doc=source()){return {...doc,reading_cleanup:{version:1,policyVersion:'authored-v1',sourceSignature:D.signature(doc),
 decisions:[{cue_id:'a',from:1,to:2,action:'hide',reason:'自写填充'}],marks:[{cue_id:'a',at:4,mark:'。',reason:'自写句界'}],breaks:[{cue_id:'a',at:4,reason:'自写断句'}],future:{opaque:['retain']}}};}
function store(initial=[]){
 const values=new Map([[library.KEY,JSON.stringify({documents:initial})]]);
 const adapter=library.createLegacyAdapter({getStorage:()=>({getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}),validate:C.validate});
 const loaded=adapter.load();
 return createAppStore({documents:loaded.documents,active:loaded.active,validate:C.validate,project:canonical.project,planBackup:C.planLibraryBackup,
  createPipeline:getDocuments=>library.create({adapter,getDocuments,delay:0})});
}

test('CLI-authored cleanup survives normal JSON parse and fresh store identity, leaving its source file and existing document intact',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'coconut-cleanup-import-')),input=join(directory,'source.json'),output=join(directory,'reading.json');
 const original=source(),bytes=JSON.stringify(original),existing={...C.validate({title:'Keep original',segments:[{id:'old',start:0,end:1,text:'Original'}]}),key:original.key};
 const app=store([existing]);
 try{
  await writeFile(input,bytes);
  await promisify(execFile)(process.execPath,['scripts/prepare-clean-reading.mjs',input,output],{cwd:process.cwd(),timeout:30000});
  assert.equal(await readFile(input,'utf8'),bytes);
  const generated=JSON.parse(await readFile(output,'utf8')),before=structuredClone(generated);
  assert.ok(generated.reading_cleanup.decisions.length,'the real local CLI generated a source mask');
  const parsed=C.parseWithDiagnostics(JSON.stringify(generated),'reading.json');
  assert.deepEqual(parsed.diagnostics,[]);assert.deepEqual(parsed.document.reading_cleanup,generated.reading_cleanup);
  assert.equal(parsed.document.key,original.key);assert.equal(prepareCleanup(parsed.document,text=>text).state,'ready');
  const imported=app.addDocument(parsed.document);
  assert.notEqual(imported.key,original.key);assert.equal(app.getSnapshot().documents.length,2);
  assert.equal(app.getDocument(original.key).title,'Keep original');
  const ready=prepareCleanup(imported,text=>text);
  assert.equal(ready.state,'ready');assert.ok(ready.hiddenCharacters>0);
  assert.equal(imported.reading_cleanup.sourceSignature,D.signature(imported));
  assert.deepEqual({...imported.reading_cleanup,sourceSignature:generated.reading_cleanup.sourceSignature},generated.reading_cleanup);
  assert.equal(D.signature({...imported,key:original.key}),D.signature(generated));
  assert.deepEqual(generated,before);assert.deepEqual(original,source());
  assert.equal((await app.flush()).ok,true);
 }finally{app.dispose();await rm(directory,{recursive:true,force:true});}
});

test('normal parsing retains stale or malformed cleanup inert and store import rejects it atomically',()=>{
 for(const alter of [
  doc=>{doc.reading_cleanup.version=2;},doc=>{doc.reading_cleanup.sourceSignature='forged';},
  doc=>{doc.reading_cleanup.decisions[0].to=99;},doc=>{doc.reading_cleanup.decisions[0].replacement='invented';},
  doc=>{doc.reading_cleanup.marks[0].mark='改字';},doc=>{doc.reading_cleanup.marks.push({...doc.reading_cleanup.marks[0]});},
  doc=>{doc.reading_cleanup.breaks[0].at=0;},doc=>{doc.segments[0].text='您呃知道然后继续。';},
  doc=>{doc.segments[0].words[0].text_end=0;},doc=>{doc.segments[0].speaker='乙';}
 ]){
  const incoming=withPlan();alter(incoming);const before=structuredClone(incoming),parsed=C.parse(JSON.stringify(incoming),'reading.json'),app=store();
  try{
   assert.deepEqual(parsed.reading_cleanup,incoming.reading_cleanup);
   assert.equal(prepareCleanup(parsed,text=>text).state,'unavailable');
   assert.throws(()=>app.addDocument(parsed));assert.equal(app.getSnapshot().documents.length,0);
   assert.deepEqual(incoming,before);
  }finally{app.dispose();}
 }
});

test('identity rebinding verifies original source and every edit before accepting an unchanged target source',()=>{
 const original=withPlan(),before=structuredClone(original),target={...original,key:'new-import'};
 const rebound=D.rebindPlan(original,target,original.reading_cleanup);
 assert.equal(rebound.sourceSignature,D.signature(target));assert.deepEqual(rebound.future,original.reading_cleanup.future);
 rebound.future.opaque.push('detached');assert.deepEqual(original,before);
 assert.equal(D.rebindPlan(original,original,original.reading_cleanup).sourceSignature,D.signature(original));
 for(const change of [
  doc=>{doc.segments[0].text='我呃改写然后继续。';},doc=>{doc.segments[0].start=.1;},
  doc=>{doc.segments[0].words[0].end=.2;},doc=>{doc.segments[0].words[0].text_start=1;},
  doc=>{doc.segments[0].speaker_id='speaker-0001';},doc=>{doc.segments[0].id='changed';}
 ]){
  const changed=structuredClone(target);change(changed);
  assert.throws(()=>D.rebindPlan(original,changed,original.reading_cleanup));
 }
 assert.throws(()=>D.rebindPlan(original,target,{...original.reading_cleanup,sourceSignature:D.signature(target)}),'a signature forged for the destination cannot establish the original source');
 assert.equal(prepareCleanup(original,text=>text).state,'ready');
});

test('canonical loading and same-key backup recovery preserve opaque invalid cleanup without activating it',async()=>{
 const invalid=withPlan();invalid.reading_cleanup.decisions[0].replacement='forged';invalid.future_project={keep:true};
 const loaded=store([invalid]),restored=store();
 try{
  assert.deepEqual(loaded.getDocument(invalid.key).reading_cleanup,invalid.reading_cleanup);
  assert.equal(prepareCleanup(loaded.getDocument(invalid.key),text=>text).state,'unavailable');
  assert.equal(await restored.restoreJSON(invalid,restored.getSnapshot().revision),true);
  const doc=restored.getDocument(invalid.key);
  assert.deepEqual(doc.reading_cleanup,invalid.reading_cleanup);assert.deepEqual(doc.future_project,{keep:true});
  assert.equal(prepareCleanup(doc,text=>text).state,'unavailable');
 }finally{loaded.dispose();restored.dispose();}
});

test('backup collision rebinds only verified plans and retains invalid plans inert without overwriting either source',async()=>{
 for(const invalid of [false,true]){
  const incoming=withPlan();if(invalid)incoming.reading_cleanup.marks[0].mark='invented';
  incoming.future_project={opaque:true};incoming.segments[0].future_cue={opaque:true};
  const before=structuredClone(incoming),existing={...C.validate({title:'Original',segments:[{id:'old',start:0,end:1,text:'Keep me'}]}),key:incoming.key},app=store([existing]);
  try{
   assert.equal(await app.restoreJSON(incoming,app.getSnapshot().revision),true);
   const imported=app.getDocument(incoming.key+'-restored-1');
   assert.ok(imported);assert.equal(app.getDocument(incoming.key).title,'Original');
   assert.deepEqual(imported.future_project,incoming.future_project);assert.deepEqual(imported.segments[0].future_cue,incoming.segments[0].future_cue);
   assert.equal(prepareCleanup(imported,text=>text).state,invalid?'unavailable':'ready');
   assert.equal(imported.reading_cleanup.sourceSignature,invalid?incoming.reading_cleanup.sourceSignature:D.signature(imported));
   assert.deepEqual(incoming,before);
  }finally{app.dispose();}
 }
});

test('a forged plan matching a predictable recovery destination cannot bypass original-source verification',async()=>{
 const incoming=withPlan(),destination={...incoming,key:incoming.key+'-restored-1'};
 incoming.reading_cleanup.sourceSignature=D.signature(destination);
 const existing={...C.validate({title:'Original',segments:[{id:'old',start:0,end:1,text:'Keep me'}]}),key:incoming.key},app=store([existing]);
 try{
  await assert.rejects(app.restoreJSON(incoming,app.getSnapshot().revision),/重新生成/);
  assert.equal(app.getSnapshot().documents.length,1);assert.equal(app.getDocument(incoming.key).title,'Original');
 }finally{app.dispose();}
});
