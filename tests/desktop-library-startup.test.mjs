import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {libraryLocation,DEVELOPMENT_LIBRARY_DIRECTORY} from '../desktop/library-location.mjs';
import {startDevelopmentBridge} from '../desktop/dev.mjs';
import {startBridge} from '../desktop/server.mjs';
import {diagnoseDevelopment,formatDoctorReport} from '../desktop/doctor.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-startup-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
async function stop(server){await new Promise(resolve=>server.shutdown(resolve));}
async function child(t,dir,{entry='server',library=path.join(dir,'library'),extra=[],entryRoot=root}={}){
 const p=spawn(process.execPath,[...extra,path.join(entryRoot,`desktop/${entry}.mjs`),...(entry==='server'?['--port','0']:[])],{cwd:dir,env:{...process.env,HOME:dir,COCONUT_LIBRARY_DIRECTORY:library,COCONUT_CAPTION_PYTHON:''},stdio:['ignore','pipe','pipe']});
 let output='';p.stdout.on('data',c=>output+=c);p.stderr.on('data',c=>output+=c);
 const exit=once(p,'exit');t.after(async()=>{if(p.exitCode===null&&p.signalCode===null){p.kill('SIGTERM');await exit;}});
 const deadline=Date.now()+12000;let match;while(!(match=output.match(/http:\/\/127\.0\.0\.1:\d+/))&&Date.now()<deadline){if(p.exitCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,20));}assert.ok(match,output);
 return {p,origin:match[0],exit,output:()=>output};
}
test('entrypoint directories are stable and separate; explicit relative override stays invalid',()=>{
 assert.equal(libraryLocation({mode:'desktop',userDataDirectory:'/private/app',directory:''}).directory,'/private/app/library');
 assert.equal(libraryLocation({mode:'development',directory:''}).directory,DEVELOPMENT_LIBRARY_DIRECTORY);
 assert.equal(libraryLocation({mode:'cli',directory:''}).directory,path.join(os.homedir(),'.coconut/library'));
 assert.equal(libraryLocation({mode:'development',directory:'relative'}).directory,'relative');
});
test('actual CLI process writes, stops, restarts with same epoch and document; conflicting writer degrades',async t=>{
 const dir=await fixture(t),first=await child(t,dir);let status=await fetch(first.origin+'/api/v1/library').then(r=>r.json());assert.equal(status.enabled,true);
 const document={key:'authored',title:'Persistent startup fixture',segments:[]};
 const r=await fetch(first.origin+'/api/v1/library/commit',{method:'POST',headers:{origin:first.origin,'content-type':'application/json'},body:JSON.stringify({protocolVersion:1,epoch:status.epoch,key:document.key,receiptKey:'create',action:'put',expected:null,document})});assert.equal(r.status,200);
 const conflict=await child(t,dir);const busy=await fetch(conflict.origin+'/api/v1/library').then(r=>r.json());assert.equal(busy.enabled,false);assert.equal(busy.unavailable.code,'library_in_use');assert.equal((await fetch(conflict.origin)).status,200);
 conflict.p.kill('SIGTERM');await conflict.exit;first.p.kill('SIGTERM');await first.exit;
 const second=await child(t,dir);const reopened=await fetch(second.origin+'/api/v1/library').then(r=>r.json());assert.equal(reopened.epoch,status.epoch);
 assert.deepEqual((await fetch(second.origin+'/api/v1/library/document?protocolVersion=1&key=authored').then(r=>r.json())).record.document,document);
 assert.equal((await fs.stat(path.join(dir,'library'))).mode&0o777,0o700);
});
test('development startup publishes real storage location to doctor; failed bind releases library',async t=>{
 const dir=await fixture(t),libraryDirectory=path.join(dir,'library');const first=await startDevelopmentBridge({port:0,taskDirectory:path.join(dir,'tasks'),libraryDirectory});t.after(()=>stop(first.server));
 assert.equal(first.library.enabled,true);assert.equal(first.taskDirectory,path.join(dir,'tasks'));
 const report=await diagnoseDevelopment({port:first.server.address().port});assert.equal(report.library.directory,libraryDirectory);assert.equal(report.library.mode,'development');assert.match(formatDoctorReport(report),/默认书架目录不同/);
 const other=path.join(dir,'other');await assert.rejects(startBridge({port:first.server.address().port,libraryDirectory:other}),{code:'EADDRINUSE'});
 const recovered=await startBridge({port:0,libraryDirectory:other});assert.equal((await fetch(`http://127.0.0.1:${recovered.address().port}/api/v1/library`).then(r=>r.json())).enabled,true);await stop(recovered);
});
test('missing native SQLite degrades actual CLI while independent reader works',async t=>{
 const dir=await fixture(t),loader=path.join(dir,'no-sqlite.mjs');await fs.writeFile(loader,"export async function resolve(s,c,n){if(s==='node:sqlite')throw Error('SQLite unavailable');return n(s,c);}");
 const running=await child(t,dir,{extra:['--experimental-loader',loader]});const state=await fetch(running.origin+'/api/v1/library').then(r=>r.json());assert.equal(state.enabled,false);assert.equal(state.unavailable.code,'runtime_unsupported');assert.equal((await fetch(running.origin)).status,200);assert.equal((await fetch(running.origin+'/api/health').then(r=>r.json())).capabilities.canonical_library,false);
});
test('actual desktop entry passes stable userData library and unchanged task/port options',async()=>{
 let source=await fs.readFile(path.join(root,'desktop/main.mjs'),'utf8');source=source.replace(/^import .*;\n/gm,'').replace("const ROOT = path.dirname(fileURLToPath(import.meta.url));",`const ROOT=${JSON.stringify(path.join(root,'desktop'))};`);
 let ready,captured;const app={requestSingleInstanceLock:()=>true,on:()=>{},whenReady:()=>({then:fn=>{ready=fn();return ready;}}),getPath:()=>'/private/authored-userdata',isPackaged:false,exit:()=>{},quit:()=>{}};
 vm.runInNewContext(source,{app,path,process:{env:{},platform:'linux'},AbortController,clearTimeout,clearInterval,console,readFile:async()=>{throw Error('absent');},createLocalMediaService:()=>({}),libraryLocation:options=>libraryLocation({...options,directory:''}),startBridge:async options=>{captured=options;throw Error('stop before window');},dialog:{showErrorBox:()=>{}}});await ready.catch(()=>{});
 assert.equal(captured.libraryDirectory,'/private/authored-userdata/library');assert.equal(captured.taskDirectory,'/private/authored-userdata/tasks');assert.equal(captured.port,47831);assert.equal(captured.startupMode,'desktop');
});

test('actual development CLI keeps repository directory and fixed origin across launches',async t=>{
 const dir=await fixture(t);await fs.cp(path.join(root,'desktop'),path.join(dir,'desktop'),{recursive:true,filter:source=>!source.includes('node_modules')&&!source.includes('/dist')});await fs.cp(path.join(root,'reader'),path.join(dir,'reader'),{recursive:true});await fs.cp(path.join(root,'shared'),path.join(dir,'shared'),{recursive:true});
 const first=await child(t,dir,{entry:'dev',entryRoot:dir,library:''});assert.equal(first.origin,'http://127.0.0.1:8080');
 const read=()=>fetch(first.origin+'/api/v1/library').then(r=>r.json());const initial=await read();assert.equal(initial.enabled,true);
 const health=await fetch(first.origin+'/api/health').then(r=>r.json());assert.equal(health.library_storage.directory,path.join(dir,'.coconut/dev/library'));
 first.p.kill('SIGTERM');await first.exit;const next=await child(t,dir,{entry:'dev',entryRoot:dir,library:''});assert.equal((await fetch(next.origin+'/api/v1/library').then(r=>r.json())).epoch,initial.epoch);
 assert.ok((await fs.stat(path.join(dir,'.coconut/dev/tasks/writer.lock'))).isFile());
});

test('awaited shutdown and abrupt process termination release the same library without changing its epoch',async t=>{
 const dir=await fixture(t),libraryDirectory=path.join(dir,'library');const initial=await startBridge({port:0,libraryDirectory});const epoch=(await fetch(`http://127.0.0.1:${initial.address().port}/api/v1/library`).then(r=>r.json())).epoch;
 await initial.shutdown();const processOne=await child(t,dir);assert.equal((await fetch(processOne.origin+'/api/v1/library').then(r=>r.json())).epoch,epoch);processOne.p.kill('SIGKILL');await processOne.exit;
 const processTwo=await child(t,dir);assert.equal((await fetch(processTwo.origin+'/api/v1/library').then(r=>r.json())).epoch,epoch);
});
