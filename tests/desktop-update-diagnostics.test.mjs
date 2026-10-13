/** CPU-only child-process proofs; no Electron, browser, model or user profile. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const helper=new URL('./helpers/native-update-diagnostics.mjs',import.meta.url).href;
function fixture(source){
 const result=spawnSync(process.execPath,['--input-type=module','--eval',`
  import assert from 'node:assert/strict';
  import {setTimeout as delay} from 'node:timers/promises';
  import {writeSync} from 'node:fs';
  import {runNativeUpdateFixture} from ${JSON.stringify(helper)};
  let kills=0,processReads=0,closed=0;
  const log=text=>writeSync(2,text+'\\n');
  const child={exitCode:null,signalCode:null,kill(signal){kills++;log('fake-child-kill '+signal);return true;}};
  const application={process(){processReads++;return child;},async close(){closed++;}};
  const options={getApplication:()=>application,bodyTimeoutMs:40,cleanupTimeoutMs:40};
  ${source}
 `],{encoding:'utf8',timeout:10000,maxBuffer:256*1024});
 assert.equal(result.error,undefined,result.error?.message);
 assert.equal(result.signal,null,'the fixture must choose a normal failure exit rather than hit the outer test timeout');
 return result;
}
function failed(result,pattern){
 assert.equal(result.status,1,result.stderr);
 assert.match(result.stderr,pattern);
 assert.doesNotMatch(result.stdout,/FIXTURE_PASSED/);
}

test('successful body and graceful cleanup clear both watchdogs without reading or killing the child',()=>{
 const result=fixture(`
  await runNativeUpdateFixture({...options,run:async mark=>{mark('success');await Promise.resolve();},cleanup:()=>application.close()});
  await delay(100);
  assert.equal(closed,1);assert.equal(kills,0);assert.equal(processReads,0);
  console.log('FIXTURE_PASSED');
 `);
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stderr,/cleanup-complete/);assert.match(result.stdout,/FIXTURE_PASSED/);
 assert.doesNotMatch(result.stderr,/fatal|terminate-child/);
});

test('body error is reported before cleanup and rethrown as the same object after graceful cleanup',()=>{
 const result=fixture(`
  const original=new Error('original authored failure');let observed;
  try{await runNativeUpdateFixture({...options,run:async mark=>{mark('assertion');throw original;},cleanup:async()=>{log('cleanup-entered');await application.close();}});}catch(error){observed=error;}
  assert.equal(observed,original);assert.equal(closed,1);assert.equal(kills,0);
  await delay(100);console.log('ERROR_PRESERVED');
 `);
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stderr,/original authored failure/);assert.match(result.stderr,/cleanup-entered/);
 assert.ok(result.stderr.indexOf('original authored failure')<result.stderr.indexOf('cleanup-entered'));
 assert.match(result.stdout,/ERROR_PRESERVED/);assert.doesNotMatch(result.stderr,/fatal/);
});

test('even a falsy thrown body value remains a failure after cleanup',()=>{
 const result=fixture(`
  let caught=false;
  try{await runNativeUpdateFixture({...options,run:async()=>{throw undefined;},cleanup:()=>application.close()});}catch(error){caught=true;assert.equal(error,undefined);}
  assert.equal(caught,true);assert.equal(kills,0);console.log('ERROR_PRESERVED');
 `);
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/ERROR_PRESERVED/);
});

test('an unresolved body fails at its own deadline, records the active stage and never resumes into cleanup or success',()=>{
 const result=fixture(`
  await runNativeUpdateFixture({...options,run:async mark=>{mark('pending-evaluate');await new Promise(()=>{});log('body-resumed');},cleanup:async()=>log('cleanup-entered')});
  console.log('FIXTURE_PASSED');
 `);
 failed(result,/fatal phase=body stage=pending-evaluate deadline exceeded/);
 assert.match(result.stderr,/fake-child-kill SIGKILL/);
 assert.doesNotMatch(result.stderr,/body-resumed|cleanup-entered|cleanup-complete/);
});

test('an unresolved cleanup after a successful body fails and cannot emit a passing result',()=>{
 const result=fixture(`
  await runNativeUpdateFixture({...options,run:async mark=>mark('last-check'),cleanup:async()=>{await new Promise(()=>{});}});
  console.log('FIXTURE_PASSED');
 `);
 failed(result,/fatal phase=cleanup stage=last-check deadline exceeded/);
 assert.match(result.stderr,/body-complete/);assert.match(result.stderr,/fake-child-kill SIGKILL/);
 assert.doesNotMatch(result.stderr,/cleanup-complete/);
});

test('an original error is visible before an unresolved cleanup reaches its independent deadline',()=>{
 const result=fixture(`
  await runNativeUpdateFixture({...options,run:async mark=>{mark('ownership');throw new Error('ORIGINAL_ASSERTION');},cleanup:async()=>{await new Promise(()=>{});}});
  console.log('FIXTURE_PASSED');
 `);
 failed(result,/fatal phase=cleanup stage=ownership deadline exceeded/);
 assert.match(result.stderr,/ORIGINAL_ASSERTION/);assert.match(result.stderr,/begin phase=cleanup/);
 assert.ok(result.stderr.indexOf('ORIGINAL_ASSERTION')<result.stderr.indexOf('begin phase=cleanup'));
 assert.match(result.stderr,/fake-child-kill SIGKILL/);
});

test('cleanup rejection preserves the earlier body error in the log and still fails after terminating the child',()=>{
 const result=fixture(`
  await runNativeUpdateFixture({...options,run:async()=>{throw new Error('ORIGINAL_ASSERTION');},cleanup:async()=>{throw new Error('SECONDARY_CLEANUP');}});
  console.log('FIXTURE_PASSED');
 `);
 failed(result,/fatal phase=cleanup stage=starting cleanup failed/);
 assert.match(result.stderr,/ORIGINAL_ASSERTION/);assert.match(result.stderr,/SECONDARY_CLEANUP/);
 assert.ok(result.stderr.indexOf('ORIGINAL_ASSERTION')<result.stderr.indexOf('SECONDARY_CLEANUP'));
 assert.match(result.stderr,/fake-child-kill SIGKILL/);
});

test('cleanup rejection after a passing body also fails rather than claiming acceptance',()=>{
 const result=fixture(`
  await runNativeUpdateFixture({...options,run:async()=>{},cleanup:async()=>{throw new Error('CLEANUP_ONLY_FAILURE');}});
  console.log('FIXTURE_PASSED');
 `);
 failed(result,/CLEANUP_ONLY_FAILURE/);assert.match(result.stderr,/cleanup failed/);
});

test('the watchdog never signals an already-exited child',()=>{
 const result=fixture(`
  child.exitCode=0;
  await runNativeUpdateFixture({...options,run:async()=>{await new Promise(()=>{});},cleanup:async()=>{}});
  console.log('FIXTURE_PASSED');
 `);
 failed(result,/deadline exceeded/);assert.doesNotMatch(result.stderr,/fake-child-kill|terminate-child/);
});

test('a missing application or failed child termination cannot prevent nonzero timeout exit',()=>{
 for(const setup of ["options.getApplication=()=>null;", "child.kill=()=>{throw new Error('KILL_FAILED');};", "options.getApplication=()=>{throw new Error('HANDLE_FAILED');};"]){
  const result=fixture(`
   ${setup}
   await runNativeUpdateFixture({...options,run:async()=>{await new Promise(()=>{});},cleanup:async()=>{}});
   console.log('FIXTURE_PASSED');
  `);
  failed(result,/fatal phase=body/);
  if(setup.includes('KILL_FAILED'))assert.match(result.stderr,/termination-error.*KILL_FAILED/);
  if(setup.includes('HANDLE_FAILED'))assert.match(result.stderr,/termination-error.*HANDLE_FAILED/);
 }
});

test('the actual native fixture prints success only after the diagnostic runner and keeps its genuine migration close event',()=>{
 const source=readFileSync(new URL('./desktop-updates-ui.mjs',import.meta.url),'utf8');
 assert.match(source,/await runNativeUpdateFixture\(/);
 assert.ok(source.indexOf('console.log(\'Update UI acceptance passed:')>source.indexOf('cleanup:async()=>'));
 assert.match(source,/const startupClosed=application.waitForEvent\('close',\{timeout:15000\}\);/);
 assert.match(source,/await startupClosed;application=null;/);
 assert.match(source,/dialog.showMessageBox=async\(\)=>\(\{response:0\}\)/);
 assert.doesNotMatch(source,/process\.exit\(0\)|SIGKILL|response:1/);
});
