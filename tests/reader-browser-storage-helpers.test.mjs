/** Node-only checks for acceptance polling; no browser is launched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {waitForPersistedLibrary} from './helpers/browser-storage.mjs';

test('persisted-record polling awaits false reads until the actual committed condition is true',async()=>{
 let reads=0;const arg={key:'authored'},predicate=async value=>{await Promise.resolve();assert.equal(value,arg);return ++reads>=3;};
 const page={evaluate:async(fn,value)=>fn(value)};
 await waitForPersistedLibrary(page,predicate,arg,{timeout:2000});
 assert.equal(reads,3);
});
test('persisted-record polling cannot accept an unresolved Promise as save evidence',async()=>{
 let release,settled=false,reads=0;
 const page={evaluate:()=>{reads++;return new Promise(resolve=>{release=resolve;});}};
 const waiting=waitForPersistedLibrary(page,()=>false,null,{timeout:2000}).then(()=>{settled=true;});
 for(let i=0;i<20&&!release;i++)await Promise.resolve();
 assert.equal(reads,1);assert.equal(settled,false);
 release(true);await waiting;assert.equal(settled,true);
});
test('persisted-record polling fails truthfully when storage never reaches the expected state',async()=>{
 let reads=0;
 await assert.rejects(waitForPersistedLibrary({evaluate:async()=>{reads++;return false;}},()=>false,null,{timeout:25}),/Committed library storage did not reach the expected state/);
 assert.ok(reads>=1);
});
test('persisted-record polling never converts a rejected storage read into success',async()=>{
 await assert.rejects(waitForPersistedLibrary({evaluate:async()=>{throw Error('Authored storage read failed');}},()=>false,null,{timeout:25}),/Committed library storage did not reach the expected state|Authored storage read failed/);
});
test('browser acceptance does not use truthy async predicates with waitForFunction',async()=>{
 const directory=new URL('./',import.meta.url);
 for(const filename of await fs.readdir(directory)){
  if(!filename.endsWith('.mjs')||!filename.includes('browser'))continue;
  const source=await fs.readFile(new URL(filename,directory),'utf8');
  assert.doesNotMatch(source,/\.waitForFunction\(\s*async\b/,filename+' must use awaited storage polling');
 }
});

test('prepared-job acceptance binds deferred storage polling in the top-level document helper scope',async()=>{
 const source=await fs.readFile(new URL('./browser-acceptance.mjs',import.meta.url),'utf8');
 const declaration=source.match(/^let browser, server, temporary[^;]*;/m)?.[0];assert.ok(declaration);
 const helper=source.slice(source.indexOf('async function waitForDocument('),source.indexOf('async function importFile('));
 const start=source.indexOf("  const {chromium, waitForPersistedLibrary: pollStored}");assert.notEqual(start,-1);
 const initialization=source.slice(start,source.indexOf('  browser = await chromium.launch',start))
  .replace("await import('./helpers/browser-storage.mjs')",'helpers');
 const calls=[],page={locator:selector=>({click:async()=>{calls.push(selector);}})};
 const helpers={waitForPersistedLibrary:async(target,predicate,arg)=>{assert.equal(target,page);assert.equal(typeof predicate,'function');calls.push(arg);}};
 await vm.runInNewContext(declaration+'\n'+helper+'\n(async()=>{'+initialization+'await waitForDocument(page,3);})()', {page,helpers});
 assert.deepEqual(calls,[3,'#mode-transcript']);
});
