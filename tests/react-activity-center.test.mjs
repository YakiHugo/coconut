import test from 'node:test';
import assert from 'node:assert/strict';
import {mountedSourceApp,wait} from './helpers/mounted-source-app.mjs';

const operation='11111111-1111-4111-8111-111111111111',fingerprint='b'.repeat(64);
const unknown={operation,binding:{key:'original-project',fingerprint,revision:0},name:'original-audio.mp3',size:5,lastModified:1,language:'',job:null,unknown:true,message:'上传回执尚未确认，请核对原操作。'};

test('restored task receipts stay in the activity center across navigation without resending',async()=>{
 const journal={version:1,entries:[unknown]},x=await mountedSourceApp({service:{ingest:async()=>{throw Error('No source request expected');}}},[],{journal});
 try{
  await wait(()=>x.w.document.querySelector('.activity-count')?.textContent==='1');
  const center=x.w.document.querySelector('.activity-center'),task=center.querySelector('.ingestion-task-list article');
  assert.match(task.textContent,/original-audio.mp3/);
  assert.match(task.textContent,/回执未确认/);
  assert.equal(center.open,false);
  assert.equal(x.w.document.querySelector('main>.ingestion-panel'),null);
  assert.equal(x.w.document.querySelectorAll('.ingestion-task-list article').length,1);
  [...x.w.document.querySelectorAll('nav button')].find(node=>node.textContent.startsWith('我的内容')).click();
  await wait(()=>x.w.document.querySelector('.library-page'));
  assert.equal(center.querySelector('.ingestion-task-list article'),task,'Navigation retains the original task owner and receipt UI');
  await x.discover();
  assert.equal(center.querySelector('.ingestion-task-list article'),task);
  assert.deepEqual(JSON.parse(x.w.localStorage.getItem('coconut-react-ingestion-jobs-v1')),journal);
  assert.equal(x.requests.length,0,'Opening and navigating never resends an unknown upload');
 }finally{await x.w.happyDOM.close();}
});

test('activity disclosure closes with Escape and outside pointer while keeping recovery reachable',async()=>{
 const x=await mountedSourceApp({service:{ingest:async()=>{throw Error('No source request expected');}}});
 try{
  const center=x.w.document.querySelector('.activity-center'),summary=center.querySelector(':scope>summary');
  center.open=true;center.querySelector('[aria-label="关闭任务与状态"]').focus();
  x.w.document.dispatchEvent(new x.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(center.open,false);assert.equal(x.w.document.activeElement,summary);
  center.open=true;x.w.document.querySelector('.discover').dispatchEvent(new x.w.PointerEvent('pointerdown',{bubbles:true}));
  assert.equal(center.open,false);
  assert.equal(center.querySelector('.storage-settings'),null,'Tasks do not contain settings');assert.ok(x.w.document.querySelector('.app-settings .storage-settings [data-testid="storage-setup"]'),'Recovery lives in settings');
  center.open=true;center.querySelector('[aria-label="关闭任务与状态"]').click();
  assert.equal(center.open,false);assert.equal(x.w.document.activeElement,summary);
 }finally{await x.w.happyDOM.close();}
});
