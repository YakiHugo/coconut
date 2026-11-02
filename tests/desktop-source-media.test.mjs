import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {startBridge} from '../desktop/server.mjs';
import {createLibraryStore} from '../desktop/library-store.mjs';
import {createSourceMediaStore} from '../desktop/source-media.mjs';
import shared from '../shared/source-media.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const doc={key:'podcast:one',title:'Episode',source_url:'https://example.com/episode',podcast_source:{kind:'direct_media',media_url:'https://example.com/audio.mp3',media_kind:'audio'},segments:[]};
function commit(library,document,action='put'){const prior=library.get(document.key);return library.commit({protocolVersion:1,epoch:library.describe().epoch,key:document.key,receiptKey:randomUUID(),expected:prior?.token||null,action,...(action==='put'?{document}:{})});}
async function setup(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-source-media-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const library=await createLibraryStore({directory});commit(library,doc);const store=await createSourceMediaStore({directory:path.join(directory,'source-media'),libraryStore:library});t.after(async()=>{await store.shutdown();library.close();});return {directory,library,store};}
test('real SQLite library and copied bytes survive complete service restart; byte ranges are local',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-media-restart-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 let server=await startBridge({port:0,libraryDirectory:directory});t.after(()=>server.shutdown());let origin=`http://127.0.0.1:${server.address().port}`;
 const request=async(endpoint,body)=>{const response=await fetch(origin+endpoint,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
 const description=await(await fetch(origin+'/api/v1/library')).json();await request('/api/v1/library/commit',{protocolVersion:1,epoch:description.epoch,key:doc.key,receiptKey:randomUUID(),expected:null,action:'put',document:doc});
 const bytes=Buffer.from('ID3 saved podcast bytes'),source=hash(shared.sourceMediaIdentity(doc)),query=new URLSearchParams({key:doc.key,source,name:'episode.mp3'});
 const saved=await fetch(origin+'/api/v1/source-media?'+query,{method:'POST',headers:{Origin:origin,'Content-Type':'audio/mpeg'},body:bytes});assert.equal(saved.status,200);const {media}=await saved.json();assert.equal(media.sha256,hash(bytes));
 await server.shutdown();server=await startBridge({port:0,libraryDirectory:directory});origin=`http://127.0.0.1:${server.address().port}`;
 const recovered=await(await fetch(origin+'/api/v1/source-media?'+new URLSearchParams({key:doc.key,source}))).json();assert.deepEqual(recovered.media,media);
 const url=origin+'/api/v1/source-media/content?'+new URLSearchParams({key:doc.key,binding:media.binding,sha256:media.sha256});const full=await fetch(url);assert.equal(full.status,200);assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
 const partial=await fetch(url,{headers:{Range:'bytes=4-8'}});assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),`bytes 4-8/${bytes.length}`);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),bytes.subarray(4,9));
 const invalidRange=await fetch(url,{headers:{Range:'bytes=999-'}});assert.equal(invalidRange.status,416);assert.equal(invalidRange.headers.get('content-range'),'bytes */'+bytes.length);
 assert.equal((await fetch(origin+'/api/v1/source-media?'+new URLSearchParams({key:doc.key,source:'0'.repeat(64)}))).status,409);
 assert.equal((await fetch(origin+'/api/v1/source-media?'+query,{method:'POST',headers:{Origin:'https://foreign.example','Content-Type':'audio/mpeg'},body:bytes})).status,403);assert.equal((await fetch(url,{method:'HEAD'})).headers.get('content-length'),String(bytes.length));
 const savedDoc=await(await fetch(origin+'/api/v1/library/document?protocolVersion=1&key='+encodeURIComponent(doc.key))).json();assert.deepEqual(savedDoc.record.document,doc);
});
test('cross-provider byte dedup retains independent source owners and survives ordinary transcript edits',async t=>{
 const {directory,library,store}=await setup(t),bytes=Buffer.from('same audio bytes'),source=hash(shared.sourceMediaIdentity(doc));const first=await store.save(doc.key,source,Readable.from([bytes]),{type:'audio/mpeg',name:'audio.mp3'});
 const video={key:'youtube:one',source_url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ',title:'Video',segments:[]};commit(library,video);const second=await store.save(video.key,hash(shared.sourceMediaIdentity(video)),Readable.from([bytes]),{type:'audio/mpeg',name:'audio.mp3'});assert.equal(first.sha256,second.sha256);assert.notEqual(first.binding,second.binding);assert.equal((await fs.readdir(path.join(directory,'source-media'))).filter(f=>f.endsWith('.media')).length,1);
 commit(library,{...doc,podcast_source:{...doc.podcast_source,transcript_url:'https://example.com/captions.vtt'},title:'Edited title',segments:[{id:'a',start:0,end:1,text:'Existing caption'}]});assert.deepEqual(await store.read(doc.key),first);
 commit(library,{...doc,source_url:'https://example.com/different'});assert.equal(await store.read(doc.key),null);assert.deepEqual(await store.read(video.key),second);
});
test('cancel, stale source, source replacement mid-upload, missing owner and invalid MIME never issue receipts',async t=>{
 const {store,library}=await setup(t),source=hash(shared.sourceMediaIdentity(doc));
 await assert.rejects(store.save(doc.key,'0'.repeat(64),Readable.from(['bytes']),{type:'audio/mpeg',name:'a.mp3'}),/changed/);
 await assert.rejects(store.save(doc.key,source,Readable.from(['bytes']),{type:'text/html',name:'a.mp3'}),/Invalid/);
 const controller=new AbortController();controller.abort();await assert.rejects(store.save(doc.key,source,Readable.from(['bytes']),{type:'audio/mpeg',name:'a.mp3',signal:controller.signal}),/cancelled/);
 async function* changing(){yield Buffer.from('start');commit(library,{...doc,source_url:'https://example.com/replacement'});yield Buffer.from('end');}
 await assert.rejects(store.save(doc.key,source,Readable.from(changing()),{type:'audio/mpeg',name:'a.mp3'}),/changed/);assert.equal(await store.read(doc.key),null);
 commit(library,doc,'delete');await assert.rejects(store.read(doc.key),/unavailable/);
});
test('storage refuses symlinks and unowned library namespace reuse',async t=>{
 const {directory,library,store}=await setup(t),source=hash(shared.sourceMediaIdentity(doc));const media=await store.save(doc.key,source,Readable.from(['bytes']),{type:'audio/mpeg',name:'a.mp3'});
 const receipt=path.join(directory,'source-media',media.binding+'.json');await fs.unlink(receipt);await fs.symlink(path.join(directory,'library.sqlite'),receipt);await assert.rejects(store.read(doc.key),/Unsafe/);
 const elsewhere=path.join(directory,'other');const other=await createLibraryStore({directory:elsewhere});try{commit(other,doc);const scoped=await createSourceMediaStore({directory:path.join(directory,'source-media'),libraryStore:other});try{assert.equal(await scoped.read(doc.key),null);}finally{await scoped.shutdown();}}finally{other.close();}
});
test('explicit re-download repairs same-size corrupted blobs before returning a durable receipt',async t=>{const {directory,store}=await setup(t),source=hash(shared.sourceMediaIdentity(doc)),bytes=Buffer.from('original');const first=await store.save(doc.key,source,Readable.from([bytes]),{type:'audio/mpeg',name:'a.mp3'});const file=path.join(directory,'source-media',first.sha256+'.media');await fs.writeFile(file,Buffer.from('corrupt!'));await assert.rejects(store.read(doc.key),/integrity/);const repaired=await store.save(doc.key,source,Readable.from([bytes]),{type:'audio/mpeg',name:'a.mp3'});assert.deepEqual(repaired,first);assert.deepEqual(await fs.readFile(file),bytes);});
test('startup retires only private generated incomplete staging files',async t=>{const {directory,library}=await setup(t),root=path.join(directory,'source-media'),stale=path.join(root,'a'.repeat(40)+'.tmp'),unrelated=path.join(root,'user.tmp');await fs.writeFile(stale,'incomplete',{mode:0o600});await fs.writeFile(unrelated,'preserve',{mode:0o600});const restarted=await createSourceMediaStore({directory:root,libraryStore:library});await restarted.shutdown();await assert.rejects(fs.stat(stale),{code:'ENOENT'});assert.equal(await fs.readFile(unrelated,'utf8'),'preserve');});
