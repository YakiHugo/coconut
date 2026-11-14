import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readHelperMedia} from '../desktop/caption-helper-media.mjs';
const bytes=Buffer.concat([Buffer.from('0000ftypM4A '),Buffer.alloc(200000,1)]);
const receipt=()=>({status:'media_ready',media:{filename:'public-media.bin',type:'audio/mp4',kind:'audio',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}});
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'coconut-stream-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));await writeFile(path.join(dir,'public-media.bin'),bytes);return dir;}
test('helper verifies file without whole Buffer and lends stream until consumer finishes',async t=>{
 const dir=await fixture(t);let size=0;const output=await readHelperMedia(dir,receipt(),{consume:async value=>{assert.equal(value.bytes,undefined);for await(const chunk of value.body){assert.ok(chunk.length<=65536);size+=chunk.length;}return 'saved';}});assert.equal(output,'saved');assert.equal(size,bytes.length);
});
test('helper rejects corrupt file before consumer and propagates rejection/cancellation',async t=>{
 const dir=await fixture(t);await assert.rejects(readHelperMedia(dir,{...receipt(),media:{...receipt().media,sha256:'a'.repeat(64)}},{consume:()=>assert.fail('invalid media reached consumer')}));
 await assert.rejects(readHelperMedia(dir,receipt(),{consume:async()=>{throw Error('storage full');}}),/storage full/);
 const controller=new AbortController();controller.abort();await assert.rejects(readHelperMedia(dir,receipt(),{signal:controller.signal,consume:()=>assert.fail('cancelled media')}));
});
test('cleanup failure is separate from already successful durable consumption',async()=>{
 const {cleanupHelperMedia}=await import('../desktop/caption-helper-media.mjs');let warnings=0;
 const hooks={remove:async()=>{throw Error('cleanup failed');},warn:()=>warnings++};
 await cleanupHelperMedia('/authored/path',true,hooks);assert.equal(warnings,1);
 await assert.rejects(cleanupHelperMedia('/authored/path',false,hooks),/cleanup failed/);
});

test('handle close failure cannot invalidate successful durable consumption',async t=>{
 const dir=await fixture(t);let warnings=0;
 const openFile=async(...args)=>{const handle=await open(...args);return {stat:()=>handle.stat(),createReadStream:options=>handle.createReadStream(options),close:async()=>{await handle.close();throw Error('close failed');}};};
 const options={openFile,warn:()=>warnings++};
 const result=await readHelperMedia(dir,receipt(),{...options,consume:async({body})=>{for await(const chunk of body){}return 'committed';}});
 assert.equal(result,'committed');assert.equal(warnings,1);
 await assert.rejects(readHelperMedia(dir,receipt(),{...options,consume:async()=>{throw Error('consumer failed');}}),/close failed/);
 assert.equal(warnings,1);
});
