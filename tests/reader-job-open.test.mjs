/** Authored completed-job responses only; no worker, media, model or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {installSavePipeline} from './helpers/save-pipeline.mjs';
const root=new URL('../',import.meta.url),KEY='coconut-reader-v1';
const source=title=>({title,language:'en',segments:[{id:'cue',start:0,end:4,text:'Authored '+title}]});
const json=value=>({ok:true,json:async()=>value});
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,0));}assert.ok(check(),'asynchronous checkpoint reached');}
async function setup(){
 const w=new Window({url:'http://127.0.0.1:8080/'}),$=id=>w.document.getElementById(id);
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:{subtle:{digest:(...args)=>webcrypto.subtle.digest(...args)},randomUUID:()=>webcrypto.randomUUID()}});
 const jobs=['A','B'].map(id=>({id,title:'Job '+id,status:'done',stage:'Ready'})),responses=new Map(),calls=[];
 w.fetch=async url=>{calls.push(url);if(url==='api/health')return json({local_worker:true});if(url==='api/jobs')return json({jobs});const id=/api\/jobs\/([AB])\/result/.exec(url)?.[1];if(!id)throw Error('Unexpected fixture request '+url);return responses.get(id)?.promise||json(source(id));};
 const pipeline=installSavePipeline(w);
 w.eval(['summary','core','passages','passage-playback','app','language','podcasts','jobs'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n')+'\nwindow.jobTest={add,active};');
 await until(()=>$('jobs').children.length===2);
 let scrolls=0;$('title').scrollIntoView=()=>{scrolls++;};
 const h={w,$,pipeline,calls,get scrolls(){return scrolls;},library:()=>JSON.parse(w.localStorage.getItem(KEY)||'{"documents":[]}').documents,
  hold(id){const gate=deferred();responses.set(id,gate);return ()=>gate.resolve(json(source(id)));},
  openJob:id=>$('jobs').querySelector(`[data-job-id="${id}"] [data-job-action="open"]`).onclick(),
  add:doc=>w.jobTest.add(w.Coconut.validate(doc)),
  openLibrary:title=>[...$('library').querySelectorAll('.library-open')].find(button=>button.querySelector('.library-title').textContent===title).click(),
  async remove(title){[...$('library').querySelectorAll('.library-entry')].find(row=>row.querySelector('.library-title').textContent===title).querySelector('.library-remove').click();await $('confirm-removal').onclick();}
 };return h;
}
function holdDigest(w){const entered=deferred(),gate=deferred();let first=true;w.crypto.subtle.digest=async(...args)=>{if(first){first=false;entered.resolve();await gate.promise;}return webcrypto.subtle.digest(...args);};return {entered:entered.promise,release:gate.resolve};}
for(const order of ['older-first','newer-first'])test(`both results persist, latest job owns navigation (${order})`,async()=>{
 const h=await setup();try{
  const releaseA=h.hold('A'),releaseB=h.hold('B'),a=h.openJob('A'),b=h.openJob('B');
  if(order==='older-first'){releaseA();await a;assert.equal(h.$('reader-workspace').hidden,true);assert.equal(h.scrolls,0);releaseB();await b;}
  else{releaseB();await b;const scrolls=h.scrolls;h.$('notice').textContent='Newer notice';releaseA();await a;assert.equal(h.scrolls,scrolls);assert.equal(h.$('notice').textContent,'Newer notice');}
  assert.equal(h.$('title').textContent,'B');assert.deepEqual(h.library().map(doc=>doc.title).sort(),['A','B']);
 }finally{await h.w.happyDOM.close();}
});
for(const change of ['library-selection','back-to-reading','leave-and-return-to-add'])test(`completed result saves without overriding ${change}`,async()=>{
 const h=await setup();try{
  await h.add(source('Existing'));await h.add(source('Current'));h.$('show-jobs').click();
  const release=h.hold('A'),pending=h.openJob('A');
  if(change==='library-selection')h.openLibrary('Existing');
  else{h.$('back-reading').click();if(change==='leave-and-return-to-add')h.$('add-content').click();}
  const title=h.$('title').textContent,workspace=h.w.document.body.dataset.workspace,scrolls=h.scrolls,focused=h.w.document.activeElement;
  h.$('notice').textContent='Keep newer notice';release();await pending;
  assert.equal(h.$('title').textContent,title);assert.equal(h.w.document.body.dataset.workspace,workspace);assert.equal(h.scrolls,scrolls);assert.equal(h.w.document.activeElement,focused);assert.equal(h.$('notice').textContent,'Keep newer notice');assert.equal(h.library().length,3);
 }finally{await h.w.happyDOM.close();}
});
test('activation ownership is checked after slow fingerprinting, not just after fetch',async()=>{
 const h=await setup(),hold=holdDigest(h.w);let a;try{
  a=h.openJob('A');await hold.entered;await h.openJob('B');const scrolls=h.scrolls;hold.release();await a;
  assert.equal(h.$('title').textContent,'B');assert.equal(h.scrolls,scrolls);assert.deepEqual(h.library().map(doc=>doc.title).sort(),['A','B']);
 }finally{hold.release();await a;await h.w.happyDOM.close();}
});
for(const change of ['library-selection','newer-job-request','add-workspace'])test(`delayed save receipt cannot scroll or notify after ${change}`,async()=>{
 const h=await setup();let pending,b,releaseB;try{
  await h.add(source('Existing'));h.$('show-jobs').click();h.pipeline.hold();pending=h.openJob('A');await until(()=>h.pipeline.writes.length===1);
  if(change==='library-selection')h.openLibrary('Existing');
  else if(change==='newer-job-request'){releaseB=h.hold('B');b=h.openJob('B');}
  else h.$('add-content').click();
  const title=h.$('title').textContent,workspace=h.w.document.body.dataset.workspace,scrolls=h.scrolls;h.$('notice').textContent='Keep receipt-era notice';
  h.pipeline.hold(false);h.pipeline.writes[0].commit();await pending;
  assert.equal(h.$('title').textContent,title);assert.equal(h.w.document.body.dataset.workspace,workspace);assert.equal(h.scrolls,scrolls);assert.equal(h.$('notice').textContent,'Keep receipt-era notice');
  releaseB?.();await b;
 }finally{h.pipeline.hold(false);releaseB?.();await b;await h.w.happyDOM.close();}
});
test('a removed target cannot be resurrected by its delayed job result',async()=>{
 const h=await setup();try{
  await h.openJob('A');h.$('show-jobs').click();const release=h.hold('A'),pending=h.openJob('A');await h.remove('A');release();await pending;
  assert.equal(h.library().length,0);assert.equal(h.$('reader-workspace').hidden,true);assert.match(h.$('notice').textContent,/导入已取消/);
 }finally{await h.w.happyDOM.close();}
});
test('duplicate pending job click stays deduplicated and does not retire its first open',async()=>{
 const h=await setup();try{
  const release=h.hold('A'),pending=h.openJob('A');await h.openJob('A');assert.equal(h.calls.filter(url=>url==='api/jobs/A/result').length,1);release();await pending;
  assert.equal(h.$('title').textContent,'A');assert.equal(h.library().length,1);assert.equal(h.scrolls,1);
 }finally{await h.w.happyDOM.close();}
});

for(const change of ['newer-job-request','add-workspace'])test(`failed old save receipt cannot replace a newer notice after ${change}`,async()=>{
 const h=await setup();let pending,b,releaseB;try{
  h.pipeline.hold();pending=h.openJob('A');await until(()=>h.pipeline.writes.length===1);
  if(change==='newer-job-request'){releaseB=h.hold('B');b=h.openJob('B');}else h.$('add-content').click();
  h.$('notice').textContent='Newer action feedback';const scrolls=h.scrolls;h.pipeline.hold(false);h.pipeline.writes[0].fail();await pending;
  assert.equal(h.$('notice').textContent,'Newer action feedback');assert.equal(h.scrolls,scrolls);assert.equal(h.w.jobTest.active().title,'A');assert.equal(h.$('save-status').dataset.state,'failed');
  releaseB?.();await b;
 }finally{h.pipeline.hold(false);releaseB?.();await b;await h.w.happyDOM.close();}
});
