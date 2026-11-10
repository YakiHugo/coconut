import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {cleanReadingIdentity} from '../desktop/clean-reading.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const resourceFiles=['transcript_cleanup.py','transcript_boundaries.py','reader/disfluency.js','shared/reading-fallback.js'];
const moduleFiles=['clean-reading.mjs','reading-fallback.mjs','providers.mjs','review-providers.mjs','provider-errors.mjs','client-access.mjs'];
async function stage(t,kind){
 const work=await realpath(await mkdtemp(path.join(tmpdir(),'coconut-clean-identity-')));
 t.after(()=>rm(work,{recursive:true,force:true}));
 const resources=path.join(work,kind==='source'?'source':'Coconut.app/Contents/Resources');
 // Node can exercise the staged ASAR layout as a directory; Electron supplies
 // the archive filesystem in the finished package.
 const app=path.join(resources,kind==='source'?'desktop':'app.asar');
 await mkdir(app,{recursive:true});
 await writeFile(path.join(app,'package.json'),JSON.stringify({type:'module'}));
 for(const name of moduleFiles)await copyFile(path.join(root,'desktop',name),path.join(app,name));
 for(const name of [...resourceFiles,'reader/package.json','shared/package.json']){
  await mkdir(path.dirname(path.join(resources,name)),{recursive:true});
  await copyFile(path.join(root,name),path.join(resources,name));
 }
 const module=await import(pathToFileURL(path.join(app,'clean-reading.mjs')).href);
 return {resources,app,module};
}

for(const kind of ['source','packaged'])test('real cleanup identity and planner resolve resources in '+kind+' layout',async t=>{
 const {resources,module}=await stage(t,kind),calls=[];
 let fallbackOptions;
 const planner=module.createCleanReadingPlanner({
  environment:{},
  run:async(binary,args,options)=>{
   calls.push({binary,args,options});
   return {code:0,stdout:JSON.stringify({decisions:[],marks:[],breaks:[],issues:[]})};
  },
  fallback:{run:async(source,options)=>{
   fallbackOptions=options;
   return {decisions:[],marks:[],issues:[],stats:{requests:0}};
  }}
 });
 const identity=await planner.identity();
 assert.match(identity,/^[a-f0-9]{64}$/);
 assert.equal(identity,await cleanReadingIdentity(),'identical bytes have the same identity across layouts');
 assert.equal(identity,await module.cleanReadingIdentity());
 const result=await planner.prepare({key:'x',segments:[{id:'a',text:'今天继续。',start:0,end:1}]},{
  directory:path.join(resources,'work'),provider:'codex',model:'test-model'
 });
 assert.equal(result.identity,identity);
 assert.equal(result.reading_cleanup.provenance.policy_sha256,identity);
 assert.equal(calls.length,2);
 for(const call of calls)assert.equal(path.resolve(call.options.cwd),resources,'Python imports still use the external resource root');
 assert.equal(calls[1].args[0],path.join(resources,'transcript_boundaries.py'));
 assert.equal(fallbackOptions.provider,'codex');
 assert.equal(fallbackOptions.model,'test-model');
 assert.equal(fallbackOptions.maxFraction,.1);
 assert.equal(fallbackOptions.maxWindows,12);
 assert.equal(fallbackOptions.maxRequests,3);
});

test('packaged identity retains every code and policy input and fails on missing resources',async t=>{
 const {resources,app,module}=await stage(t,'packaged');
 const planner=module.createCleanReadingPlanner(),identity=await planner.identity();
 const inputs=[...resourceFiles.map(name=>path.join(resources,name)),...['reading-fallback.mjs','clean-reading.mjs'].map(name=>path.join(app,name))];
 for(const file of inputs){
  const original=await readFile(file);
  await writeFile(file,Buffer.concat([original,Buffer.from('\n')]));
  assert.notEqual(await planner.identity(),identity,path.basename(file)+' must invalidate the identity');
  await rm(file);
  await assert.rejects(planner.identity(),error=>error.code==='ENOENT'&&error.path===file);
  await writeFile(file,original);
  assert.equal(await planner.identity(),identity);
 }
});
