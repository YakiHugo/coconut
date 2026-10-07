import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {Updater,compareVersions,versionParts,selectRelease,checksumFor,REPOSITORY} from '../desktop/updater.mjs';
import {updateURL} from '../desktop/update-http.mjs';
import {inspectZip,installerScript,recoveryScript} from '../desktop/update-install.mjs';
const execute=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
const bytes=Buffer.from('authored update fixture'),version='0.4.0',name=`Coconut-${version}-arm64-unsigned.zip`;
const sums=hash(bytes)+'  '+name+'\n';
const asset=(name,data)=>({name,size:Buffer.byteLength(data),digest:'sha256:'+hash(data),browser_download_url:`${REPOSITORY}/releases/download/v${version}/${name}`});
const release={tag_name:'v'+version,html_url:`${REPOSITORY}/releases/tag/v${version}`,prerelease:true,assets:[asset(name,bytes),asset('SHA256SUMS.txt',sums)]};
async function setup(t,extra={}){
 const directory=await mkdtemp(path.join(os.tmpdir(),'coconut-updater-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const u=new Updater({directory,version:'0.3.0',arch:'arm64',platform:'darwin',text:async url=>url.includes('/repos/')?JSON.stringify([release]):sums,response:async()=>Readable.from([bytes]),...extra});
 await u.initialize();await u.setDeveloper(true);return u;
}
test('numeric versions compare by component; invalid, pre-release and unsafe numbers are rejected',()=>{
 assert.equal(compareVersions('v0.10.0','0.9.99'),1);assert.equal(compareVersions('1.0.0','1.0.0'),0);assert.equal(compareVersions('0.3.0','0.4.0'),-1);
 for(const value of ['1.2.3-beta','01.2.3','1.2','1.2.3+build','999999999999999999.0.0'])assert.equal(versionParts(value),null);
});
test('default stable channel excludes prereleases; opt-in permits numeric development releases, never drafts or downgrade',()=>{
 const options={version:'0.3.0',arch:'arm64'};assert.equal(selectRelease([release],options),null);assert.equal(selectRelease([release],{...options,developer:true}).version,version);
 assert.equal(selectRelease([{...release,draft:true}],{...options,developer:true}),null);
 assert.equal(selectRelease([release],{...options,version:'0.5.0',developer:true}),null);
 assert.equal(selectRelease([{...release,tag_name:'v0.4.0-beta'}],{...options,developer:true}),null);
});
test('wrong architecture, asset source, ambiguous names and missing digests fail closed',()=>{
 const options={version:'0.3.0',arch:'x64',developer:true};assert.throws(()=>selectRelease([release],options),/架构/);
 for(const replacement of [{...release.assets[0],browser_download_url:'https://github.com/attacker/coconut/update.zip'},{...release.assets[0],digest:null}])assert.throws(()=>selectRelease([{...release,assets:[replacement,release.assets[1]]}],{...options,arch:'arm64'}));
 assert.throws(()=>selectRelease([{...release,assets:[...release.assets,release.assets[0]]}],{...options,arch:'arm64'}));
 assert.throws(()=>checksumFor(sums+sums,name));
 for(const url of ['http://github.com/a','https://github.com.evil.test/a','https://user:secret@github.com/a','https://127.0.0.1/a','https://github.com:8443/a'])assert.throws(()=>updateURL(url));
});
test('automatic checks persist a six-hour throttle across launches; manual retry bypasses it',async t=>{
 let calls=0,clock=100000;const u=await setup(t,{now:()=>clock,text:async()=>{calls++;throw new Error('offline');}});
 assert.equal((await u.check()).status,'error');assert.equal(calls,1);await u.check();assert.equal(calls,1);
 const again=new Updater({directory:u.directory,version:'0.3.0',arch:'arm64',platform:'darwin',now:()=>clock,text:u.text});await again.initialize();await again.check();assert.equal(calls,1);
 await again.check({manual:true});assert.equal(calls,2);clock+=6*60*60*1000;await again.check();assert.equal(calls,3);
});
test('download checks both SHA256 sources and size; ready ZIP resumes after relaunch',async t=>{
 const u=await setup(t);await u.check();assert.equal((await u.download()).status,'ready');assert.deepEqual(await readFile(path.join(u.directory,'update.zip')),bytes);
 const again=new Updater({directory:u.directory,version:'0.3.0',arch:'arm64',platform:'darwin'});await again.initialize();assert.equal(again.state.status,'ready');
 await writeFile(path.join(u.directory,'update.zip'),'corrupt');await again.initialize();assert.equal(again.state.status,'error');
});
test('checksum mismatch, truncation, oversized and wrong files never produce a pending update',async t=>{
 for(const stream of [Buffer.from('bad'),bytes.subarray(1),Buffer.concat([bytes,bytes])]){
  const u=await setup(t,{response:async()=>Readable.from([stream])});await u.check();assert.equal((await u.download()).status,'error');await assert.rejects(stat(path.join(u.directory,'pending.json')));await assert.rejects(stat(path.join(u.directory,'update.zip.part')));
 }
 const u=await setup(t,{text:async url=>url.includes('/repos/')?JSON.stringify([release]):sums.replace(hash(bytes),'a'.repeat(64))});await u.check();assert.equal((await u.download()).status,'error');
});
test('cancellation discards partial download, then retry completes',async t=>{
 let interrupted=true;const u=await setup(t,{response:async()=>Readable.from((async function*(){yield bytes.subarray(0,3);if(interrupted)u.cancel();yield bytes.subarray(3);})())});
 await u.check();assert.equal((await u.download()).status,'cancelled');await assert.rejects(stat(path.join(u.directory,'update.zip.part')));
 interrupted=false;assert.equal((await u.download()).status,'ready');
});
test('concurrent checks have one request and channel changes wait for it',async t=>{
 let finish,calls=0;const u=await setup(t,{text:()=>{calls++;return new Promise(resolve=>finish=resolve);}});
 const checking=u.check();while(!finish)await new Promise(r=>setImmediate(r));await u.check({manual:true});await assert.rejects(u.setDeveloper(false));assert.equal(calls,1);finish(JSON.stringify([release]));await checking;
});
// Small, stored ZIP builder with UNIX modes: no unzip tool is needed for security tests.
function zip(entries){
 const chunks=[],central=[];let position=0;
 for(const {name,data='',mode=0x81a4} of entries){const n=Buffer.from(name),b=Buffer.from(data),local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(b.length,18);local.writeUInt32LE(b.length,22);local.writeUInt16LE(n.length,26);chunks.push(local,n,b);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x0314,4);c.writeUInt16LE(20,6);c.writeUInt32LE(b.length,20);c.writeUInt32LE(b.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE((mode*65536)>>>0,38);c.writeUInt32LE(position,42);central.push(c,n);position+=30+n.length+b.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(position,16);return Buffer.concat([...chunks,directory,end]);
}
const required=['Contents/Info.plist','Contents/MacOS/Coconut','Contents/Resources/app.asar'].map(n=>({name:'Coconut.app/'+n}));
test('ZIP validates complete application structure and safe internal framework symlinks',async t=>{
 const u=await setup(t),file=path.join(u.directory,'zip');await writeFile(file,zip([...required,{name:'Coconut.app/Contents/link',data:'Resources',mode:0xa1ff}]));assert.equal(await inspectZip(file),4);
});
test('ZIP rejects traversal, duplicate paths, symlink escape/ancestors, special files and missing bundle',async t=>{
 const u=await setup(t),file=path.join(u.directory,'zip');
 for(const entries of [required.slice(1),[...required,{name:'Coconut.app/../escape'}],[...required,required[0]],[...required,{name:'Coconut.app/Contents/link',data:'../../../escape',mode:0xa1ff}],[...required,{name:'Coconut.app/Contents/link',data:'/tmp',mode:0xa1ff}],[...required,{name:'Coconut.app/Contents/Resources',data:'MacOS',mode:0xa1ff}],[...required,{name:'Coconut.app/fifo',mode:0x11a4}]]){await writeFile(file,zip(entries));await assert.rejects(inspectZip(file));}
});
test('installer preserves old bundle and all user data, then requests system launch',async t=>{
 const u=await setup(t),target=path.join(u.directory,"Coconut's.app"),staged=path.join(u.directory,'stage.app'),backup=path.join(u.directory,'previous.app'),result=path.join(u.directory,'result');
 await mkdir(target);await mkdir(staged);await writeFile(path.join(target,'old'),'old');await writeFile(path.join(staged,'new'),'new');await writeFile(path.join(u.directory,'notes.json'),'untouched');
 const script=path.join(u.directory,'install.sh');await writeFile(script,installerScript({pid:2147483647,target,staged,backup,result,launcher:'/usr/bin/true'}));await execute('/bin/sh',[script]);
 assert.equal(await readFile(path.join(target,'new'),'utf8'),'new');assert.equal(await readFile(path.join(backup,'old'),'utf8'),'old');assert.equal(await readFile(path.join(u.directory,'notes.json'),'utf8'),'untouched');assert.equal((await readFile(result,'utf8')).trim(),'installed');
});
test('launch rejection is recorded, keeps backup, and never invokes security overrides',async t=>{
 const u=await setup(t),target=path.join(u.directory,'app'),staged=path.join(u.directory,'stage'),backup=path.join(u.directory,'backup'),result=path.join(u.directory,'result');await mkdir(target);await mkdir(staged);
 const script=installerScript({pid:2147483647,target,staged,backup,result,launcher:'/usr/bin/false'});assert.ok(!/spctl|xattr|kill -[9A-Z]|sudo/.test(script));const file=path.join(u.directory,'install.sh');await writeFile(file,script);await assert.rejects(execute('/bin/sh',[file]));assert.equal((await readFile(result,'utf8')).trim(),'launch-needs-attention');assert.ok((await stat(backup)).isDirectory());
});
test('running app is never replaced; helper waits for its natural exit',async t=>{
 const u=await setup(t),target=path.join(u.directory,'app'),staged=path.join(u.directory,'stage'),backup=path.join(u.directory,'backup'),result=path.join(u.directory,'result');await mkdir(target);await mkdir(staged);await writeFile(path.join(target,'old'),'old');
 const process=spawn('/bin/sleep',['60']);t.after(()=>process.kill('SIGTERM'));await new Promise(resolve=>process.once('spawn',resolve));
 const file=path.join(u.directory,'install.sh');await writeFile(file,installerScript({pid:process.pid,target,staged,backup,result,launcher:'/usr/bin/true'}));const installation=execute('/bin/sh',[file]);
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(await readFile(path.join(target,'old'),'utf8'),'old');await assert.rejects(stat(backup));process.kill('SIGTERM');await installation;assert.ok((await stat(backup)).isDirectory());
});
test('failed second rename rolls back original; interrupted gap recovery never overwrites an existing app',async t=>{
 const u=await setup(t),target=path.join(u.directory,'app'),staged=path.join(target,'stage'),backup=path.join(u.directory,'backup'),result=path.join(u.directory,'result'),lock=path.join(u.directory,'lock');await mkdir(staged,{recursive:true});await writeFile(path.join(target,'old'),'old');
 const file=path.join(u.directory,'install.sh');await writeFile(file,installerScript({pid:2147483647,target,staged,backup,result,launcher:'/usr/bin/true'}));await assert.rejects(execute('/bin/sh',[file]));assert.equal(await readFile(path.join(target,'old'),'utf8'),'old');await assert.rejects(stat(backup));
 const {rename}=await import('node:fs/promises');await rename(target,backup);await writeFile(lock,'interrupted');
 const recovery=path.join(u.directory,'recovery.sh');await writeFile(recovery,recoveryScript({pid:2147483647,target,backup,lock,launcher:'/usr/bin/true'}));await execute('/bin/sh',[recovery]);assert.equal(await readFile(path.join(target,'old'),'utf8'),'old');await assert.rejects(stat(lock));
 await mkdir(backup);await writeFile(path.join(backup,'another'),'keep');await execute('/bin/sh',[recovery]);assert.equal(await readFile(path.join(backup,'another'),'utf8'),'keep');assert.equal(await readFile(path.join(target,'old'),'utf8'),'old');
});
test('recovery cannot remove the lock or start another app while installation helper lives',async t=>{
 const u=await setup(t),target=path.join(u.directory,'app'),backup=path.join(u.directory,'backup'),lock=path.join(u.directory,'install-lock.json');await mkdir(backup);await writeFile(lock,'active installation');await writeFile(path.join(u.directory,'helper.pid'),String(process.pid));
 const file=path.join(u.directory,'recover.sh');await writeFile(file,recoveryScript({pid:2147483647,target,backup,lock,launcher:'/usr/bin/true'}));await assert.rejects(execute('/bin/sh',[file]));assert.equal(await readFile(lock,'utf8'),'active installation');await assert.rejects(stat(target));assert.ok((await stat(backup)).isDirectory());
});
