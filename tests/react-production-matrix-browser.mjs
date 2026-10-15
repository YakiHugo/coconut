/**
 * Authored browser matrix against the actual bundled React entry.
 * Real browser + Node child process + SQLite for authority/persistence.
 * Provider, source acquisition, and native bridge are explicitly fakes.
 * No upstream platform, proxy, ASR, downloaded model, or macOS proof is claimed.
 * Authority transitions and edits use React UI; readback uses the real API.
 */
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {encodingFixtures,bytesFor} from './helpers/subtitle-encoding-fixtures.mjs';

const output=process.env.COCONUT_REACT_ARTIFACTS||'/tmp/coconut-react-authored';
const root=await mkdtemp(path.join(tmpdir(),'coconut-react-matrix-'));
const checks=[],contexts=new Set(),services=new Set(),errors=[],blocked=[],forbidden=[];
let browser,stage='startup',serial=0;
const documentA={schema_version:1,key:'matrix-a',title:'Authored source A',language:'en',notes:{cue:'Original note'},opaque:{keep:'source extension'},segments:[{id:'cue',start:0,end:2,text:'Read the authored source carefully.',opaque:{keep:true}}]};
const documentB={...documentA,key:'matrix-b',title:'Authored source B',notes:{},segments:[{id:'cue',start:0,end:2,text:'A different authored source.'}]};
const original=JSON.stringify({documents:[documentA,documentB],active:documentA.key});
const pass=(name,details={})=>{checks.push({name,...details});console.log('PASS '+name);};
function startService(name,port=0){
 const directory=path.join(root,name),child=fork(new URL('./fixtures/react-matrix-server.mjs',import.meta.url),[String(port),directory],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
 const asks=[],acks=new Map();let diagnostic='',exited=false;
 child.stdout.resume();child.stderr.on('data',bytes=>{diagnostic=(diagnostic+bytes).slice(-12000);});
 return new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{child.kill();reject(Error('Fixture startup deadline: '+diagnostic));},15000);
  child.once('error',reject);child.once('exit',code=>{exited=true;clearTimeout(timeout);reject(Error('Fixture exit '+code+': '+diagnostic));});
  child.on('message',message=>{
   if(message.type==='ask')asks.push(message.data);
   if(message.type==='ack'){acks.get(message.id)?.();acks.delete(message.id);}
   if(message.type==='ready'){
    clearTimeout(timeout);
    const service={origin:'http://127.0.0.1:'+message.port,port:message.port,asks,name,
     command(type,value){return new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{acks.delete(id);reject(Error('Fixture command deadline'));},10000);acks.set(id,()=>{clearTimeout(timer);resolve();});child.send({type,value,id});});},
     close(){services.delete(service);if(exited)return Promise.resolve();return new Promise(resolve=>{const timer=setTimeout(()=>child.kill(),5000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.send({type:'close'});});}};
    services.add(service);resolve(service);
   }
  });
 });
}
async function contextFor(service,{seed=original,width=1360,bridge=false,preferences={},remembered=[]}={}){
 const context=await browser.newContext({viewport:{width,height:960},acceptDownloads:true,serviceWorkers:'block'});contexts.add(context);
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.origin===service.origin){if(route.request().method()==='POST'&&!['/api/ask','/api/v1/library/migration','/api/v1/library/batch'].includes(url.pathname)){forbidden.push(url.pathname);return route.abort('blockedbyclient');}return route.continue();}if(['blob:','data:'].includes(url.protocol))return route.continue();
  blocked.push(url.origin+url.pathname);return route.abort('blockedbyclient');
 });
 if(seed)await context.addInitScript(raw=>{if(!localStorage.getItem('matrix-seeded')){localStorage.setItem('coconut-reader-v1',raw);localStorage.setItem('matrix-seeded','yes');}},seed);
 await context.addInitScript(({preferences,remembered})=>{if(!localStorage.getItem('matrix-preferences-seeded')){for(const [key,value]of Object.entries(preferences))localStorage.setItem(key,value);localStorage.setItem('matrix-preferences-seeded','yes');}if(remembered.length&&!sessionStorage.getItem('matrix-native-seeded')){sessionStorage.setItem('authored-remembered',JSON.stringify(remembered));sessionStorage.setItem('matrix-native-seeded','yes');}},{preferences,remembered});
 if(bridge)await context.exposeBinding('reportAuthoredUpdateAction',(_source,action)=>forbidden.push('native-update:'+action));
 if(bridge)await context.addInitScript(nativeWav=>{
  const calls=[];window.authoredNativeCalls=calls;
  const forbiddenUpdate=action=>async()=>{calls.push({kind:'unexpected-update',action});await window.reportAuthoredUpdateAction(action);throw Error('Authored matrix forbids update action: '+action);};
  window.coconutUpdates={state:async()=>{calls.push({kind:'update-state'});return {status:'idle',version:'authored-fixture',arch:'arm64',developer:false,message:'Authored read-only update fixture; no release check performed.'};},subscribe:()=>{calls.push({kind:'update-subscribe'});return ()=>calls.push({kind:'update-unsubscribe'});},...Object.fromEntries(['check','download','install','cancel','developer'].map(action=>[action,forbiddenUpdate(action)]))};
  window.coconutLocalMedia={
   reconcile:async owners=>{calls.push({kind:'reconcile',owners});return {status:'reconciled',rememberedKeys:JSON.parse(sessionStorage.getItem('authored-remembered')||'[]')};},
   remember:async(owner,file,identity)=>{calls.push({kind:'remember',owner,name:file.name,identity});sessionStorage.setItem('authored-remembered',JSON.stringify([owner.key]));return {status:'remembered'};},
   resolve:async owner=>{calls.push({kind:'resolve',owner});if(!JSON.parse(sessionStorage.getItem('authored-remembered')||'[]').includes(owner.key))return {status:'not-remembered'};return {status:'ready',token:'authored-native-token',url:URL.createObjectURL(new Blob([Uint8Array.from(atob(nativeWav),character=>character.charCodeAt(0))],{type:'audio/wav'})),kind:'audio',name:'Authored native mock',identity:'authored-native-identity'};},
   forget:async owner=>{calls.push({kind:'forget',owner});sessionStorage.removeItem('authored-remembered');return {status:'forgotten'};},
   release:async token=>{calls.push({kind:'release',token});}
  };
 },wav(150).toString('base64'));
 const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push({stage,message:error.message}));
 await page.goto(service.origin+'/index.html');await expect(page.getByRole('heading',{name:'今天，想听什么？'})).toBeVisible();
 assert.equal(await page.locator('script[src="app.js"], #transcript, .shell').count(),0,'No legacy renderer');
 return {context,page};
}
async function openStorage(page){const settings=page.locator('details.storage-settings');if(await settings.count()&&!await settings.evaluate(node=>node.open))await settings.locator(':scope > summary').click();}
async function authority(page,action){
 await openStorage(page);
 await page.getByTestId('storage-discover').click();
 await page.getByTestId('storage-'+action).click();
 await expect(page.getByTestId('storage-review-confirm')).toBeVisible();
 await Promise.all([page.waitForEvent('domcontentloaded'),page.getByTestId('storage-review-confirm').click()]);
 await expect(page.getByTestId('storage-review-confirm')).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'今天，想听什么？'})).toBeVisible();
}

const record=async(service,key=documentA.key)=>{
 const response=await fetch(service.origin+'/api/v1/library/document?protocolVersion=1&key='+encodeURIComponent(key));assert.equal(response.status,200);return (await response.json()).record;
};
async function openA(page){await page.getByRole('button',{name:/^我的内容/}).click();await page.locator('.library-page li button').filter({hasText:documentA.title}).first().click();await expect(page.getByRole('heading',{name:documentA.title,exact:true})).toBeVisible();}
async function editNote(page,text){const details=page.locator('.rw-cue').first().locator('details');if(!await details.evaluate(node=>node.open))await details.locator('summary').click();await page.getByRole('textbox',{name:'00:00 的笔记'}).fill(text);await page.getByRole('button',{name:'保存笔记',exact:true}).click();}
const saved=page=>expect(page.locator('.app-header [role=status]')).toHaveText('已保存');
async function shot(page,name,width){await page.setViewportSize({width,height:960});const geometry=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));assert.ok(geometry.document<=width+1&&geometry.body<=width+1,JSON.stringify(geometry));await page.screenshot({path:path.join(output,`matrix-${name}-${width}.png`),fullPage:true});return geometry;}
async function assertReaderFlow(page,width){
 await page.setViewportSize({width,height:960});const player=page.locator('.rw-player');await expect(player).toHaveCSS('position','static');const evidence=[];
 for(const target of [page.getByRole('button',{name:'返回原阅读状态',exact:true}),page.locator('.rw-summary').getByText('Authored saved whole-source summary',{exact:true}),page.getByRole('textbox',{name:'项目笔记',exact:true})]){
  await target.evaluate(node=>node.scrollIntoView({block:'center'}));await expect(target).toBeVisible();const proof=await target.evaluate(node=>{const player=document.querySelector('.rw-player'),p=player.getBoundingClientRect(),r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return {viewport:innerHeight,playerBottom:p.bottom,targetTop:r.top,targetBottom:r.bottom,targetInViewport:r.top>=0&&r.bottom<=innerHeight,hit:!!hit&&(hit===node||node.contains(hit)),overlap:p.left<r.right&&p.right>r.left&&p.top<r.bottom&&p.bottom>r.top};});assert.equal(proof.targetInViewport,true);assert.equal(proof.overlap,false,'Player must not cover reading or editing after scroll');assert.equal(proof.hit,true,'Reading target must receive real pointer hit');evidence.push(proof);
 }
 await page.evaluate(()=>window.scrollTo(0,0));return {width,targets:evidence};
}
async function downloadJSON(page,button){await expect(button).toBeVisible();await expect(button).toBeEnabled();const [download]=await Promise.all([page.waitForEvent('download'),button.click()]);assert.equal(await download.failure(),null);const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
async function chooseFile(page,button,file){const [chooser]=await Promise.all([page.waitForEvent('filechooser'),button.click()]);await chooser.setFiles(file);}
async function backup(page){return downloadJSON(page,page.getByRole('button',{name:'导出完整备份',exact:true}));}
function wav(seconds=1){const b=Buffer.alloc(44+16000*seconds);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;}

try{
 await mkdir(output,{recursive:true});
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 stage='Canonical authority, durable save, restart, independent binding and CAS';
 let service=await startService('canonical');const first=await contextFor(service);const {page}=first;
 const empty=await (await fetch(service.origin+'/api/v1/library/catalog?protocolVersion=1')).json();assert.equal(empty.entries.length,0,'No automatic adoption');await openStorage(page);const raw=await downloadJSON(page,page.getByTestId('storage-export-raw'));assert.deepEqual(raw,JSON.parse(original));
 await authority(page,'begin');await openA(page);await editNote(page,'Durable React edit');await saved(page);
 let durable=await record(service);assert.equal(durable.document.notes.cue,'Durable React edit');assert.deepEqual(durable.document.opaque,documentA.opaque);assert.deepEqual(durable.document.segments[0].opaque,documentA.segments[0].opaque);
 const beforeRestart=durable;const port=service.port;await service.close();service=await startService('canonical',port);await page.reload();await expect(page.getByRole('heading',{name:documentA.title,exact:true})).toBeVisible();await expect(page).toHaveURL(new RegExp('#read/'+documentA.key+'$'));
 await page.locator('.rw-cue details > summary').first().click();await expect(page.getByRole('textbox',{name:'00:00 的笔记'})).toHaveValue('Durable React edit');assert.deepEqual(await record(service),beforeRestart);
 pass('React save survives actual Node process restart and SQLite readback',{authoritySetup:'explicit React review and confirmation'});
 const second=await contextFor(service,{seed:null});await authority(second.page,'connect');await openA(second.page);
 await editNote(page,'First client wins');await saved(page);const winner=await record(service);
 await editNote(second.page,'Stale second client must not overwrite');await expect(second.page.locator('.app-header [role=status]')).toHaveText('保存未完成');assert.deepEqual(await record(service),winner);
 const conflictBackup=await backup(second.page);assert.equal(conflictBackup.documents.find(d=>d.key===documentA.key).notes.cue,'Stale second client must not overwrite');
 pass('Independent canonical binding rejects stale CAS and retains recoverable React edit');
 await second.context.close();contexts.delete(second.context);
 await page.reload();await openA(page);const prior=await record(service);let dropped=false,requests=[];
 await page.route('**/api/v1/library/batch',async route=>{requests.push(route.request().postDataJSON());if(!dropped){dropped=true;const response=await route.fetch();assert.equal(response.status(),200);await response.dispose();return route.abort('failed');}return route.continue();});
 await editNote(page,'Lost acknowledgment survives retry');await expect(page.locator('.app-header [role=status]')).toHaveText('保存未完成');const committed=await record(service);assert.equal(committed.document.notes.cue,'Lost acknowledgment survives retry');assert.equal(committed.token.revision,prior.token.revision+1);
 await page.getByRole('button',{name:'重试保存',exact:true}).click();await saved(page);await expect(page.locator('.app-message[role=status]')).toHaveText('保存已确认。');await expect(page.locator('.reader-workspace > p[role=status]')).toHaveText('已保存');await expect(page.getByText('保存结果尚未确认。请重试同一操作或导出未保存内容；不要把它视为已撤销。',{exact:true})).toHaveCount(0);await expect(page.getByText('尚未保存。内容可能已更新或存储暂不可用，请保留草稿后重试。',{exact:true})).toHaveCount(0);assert.deepEqual(await record(service),committed);assert.ok(requests.length>=2);assert.deepEqual(requests[0],requests[1],'Retry exact receipt identity, no duplicate write');await page.unroute('**/api/v1/library/batch');
 await shot(page,'canonical-reading',1360);await shot(page,'canonical-reading',390);pass('Lost successful write acknowledgment retries identical receipt without another SQLite revision');
 await first.context.close();contexts.delete(first.context);await service.close();

 stage='React canonical interrupted migration controls and exact recovery download';
 for(const scenario of ['lost-finalize','cancel-before-commit']){
  const s=await startService(scenario),f=await contextFor(s);let interrupted=false;
  await f.page.route('**/api/v1/library/migration',async route=>{
   if(route.request().method()==='POST'){
    const action=route.request().postDataJSON().action;
    if(!interrupted&&action===(scenario==='lost-finalize'?'finalize':'chunk')){
     interrupted=true;if(scenario==='lost-finalize'){const response=await route.fetch();assert.equal(response.status(),200);await response.dispose();}return route.abort('failed');
    }
   }return route.continue();
  });
  await openStorage(f.page);await f.page.getByTestId('storage-discover').click();await f.page.getByTestId('storage-begin').click();await f.page.getByTestId('storage-review-confirm').click();await expect(f.page.getByTestId('storage-resume')).toBeVisible();assert.equal(interrupted,true);
  const snapshot=await downloadJSON(f.page,f.page.getByTestId('storage-export-recovery'));assert.ok(JSON.stringify(snapshot).includes(documentA.segments[0].text),'Frozen original source is exportable');assert.equal(await f.page.evaluate(()=>localStorage.getItem('coconut-reader-v1')),original);
  await f.page.unroute('**/api/v1/library/migration');await f.page.reload();await expect(f.page.getByTestId('storage-resume')).toBeVisible();await expect(f.page.getByRole('textbox',{name:'项目笔记',exact:true})).toHaveCount(0);
  await f.page.getByTestId(scenario==='lost-finalize'?'storage-resume':'storage-cancel').click();await Promise.all([f.page.waitForEvent('domcontentloaded'),f.page.getByTestId('storage-review-confirm').click()]);await expect(f.page.getByRole('heading',{name:'今天，想听什么？'})).toBeVisible();
  const catalog=await (await fetch(s.origin+'/api/v1/library/catalog?protocolVersion=1')).json();assert.equal(catalog.entries.length,scenario==='lost-finalize'?2:0);
  if(scenario==='lost-finalize'){assert.equal((await record(s)).token.revision,1);await expect(f.page.getByTestId('storage-setup')).toContainText('已连接电脑统一书架');}
  else {await expect(f.page.getByTestId('storage-setup')).toContainText('当前使用本浏览器书架');await openA(f.page);await editNote(f.page,'Browser writes resume after confirmed cancellation');await saved(f.page);}
  pass('React '+scenario+' uses review, frozen recovery export, reload and confirmed authority receipt');await f.context.close();contexts.delete(f.context);await s.close();
 }

 stage='Native startup close barrier over actual canonical load and failure';
 const startupService=await startService('native-startup'),startupFixture=await contextFor(startupService,{bridge:true});const sp=startupFixture.page;
 await authority(sp,'begin');const originalRecord=await record(startupService);let releaseLoad,loadArrived=false;
 const loadGate=new Promise(resolve=>{releaseLoad=resolve;});
 await sp.route('**/api/v1/library',async route=>{loadArrived=true;await loadGate;await route.continue();});
 await sp.reload();await expect(sp.getByRole('heading',{name:'正在打开 Coconut',exact:true})).toBeVisible();await expect.poll(()=>loadArrived).toBe(true);
 assert.equal(await sp.evaluate(()=>coconutPrepareClose('inspect').safe),false);assert.equal(await sp.evaluate(()=>coconutPrepareUpdate(false,{id:100,kind:'update',expiresAt:Date.now()+20000})),false);
 await sp.evaluate(()=>{window.authoredStartupClose=null;window.authoredStartupRequest={id:101,kind:'close',expiresAt:Date.now()+20000};coconutPrepareClose('safe',authoredStartupRequest).then(result=>{window.authoredStartupClose=result;});});
 assert.equal(await sp.evaluate(()=>authoredStartupClose),null,'Close cannot acknowledge before real canonical read settles');await expect(sp.locator('.react-app')).toHaveCount(0);releaseLoad();await expect.poll(()=>sp.evaluate(()=>authoredStartupClose)).toBe(true);await expect(sp.locator('.react-app')).toHaveCount(0);assert.deepEqual(await record(startupService),originalRecord);assert.equal(await sp.evaluate(()=>localStorage.getItem('coconut-reader-v1')),original);
 assert.equal(await sp.evaluate(()=>coconutPrepareClose('release',authoredStartupRequest)),true);assert.equal(await sp.evaluate(()=>coconutPrepareClose('safe',authoredStartupRequest)),false,'Retired native receipt cannot close another lifetime');await sp.unroute('**/api/v1/library');
 await sp.route('**/api/v1/library',route=>route.abort('failed'));await sp.reload();await expect(sp.getByRole('heading',{name:'暂时无法打开书架',exact:true})).toBeVisible();await expect(sp.getByTestId('storage-export-recovery')).toBeVisible();await expect.poll(()=>sp.evaluate(()=>coconutPrepareClose('inspect').safe)).toBe(true);assert.equal(await sp.evaluate(()=>coconutPrepareUpdate(false,{id:102,kind:'update',expiresAt:Date.now()+20000})),false);assert.equal(await sp.evaluate(()=>coconutPrepareClose('safe',{id:103,kind:'close',expiresAt:Date.now()+20000})),true);assert.equal(await sp.evaluate(()=>localStorage.getItem('coconut-reader-v1')),original);assert.deepEqual(await record(startupService),originalRecord);
 pass('Native startup mock close waits real canonical loading, blocks update/admission, retires receipt and preserves failed-load recovery');await startupFixture.context.close();contexts.delete(startupFixture.context);await startupService.close();

 stage='Legacy preferences, saved summary reading and scoped keyboard behavior';
 const require=createRequire(import.meta.url),core=require('../reader/core.js'),summary=require('../reader/summary.js');
 const summaryDoc={...core.validate({title:'Authored saved summary source',language:'en',segments:Array.from({length:65},(_,i)=>({id:'summary-cue-'+i,start:i*2,end:i*2+2,text:'Original summary source '+i}))}),key:'matrix-summary',local_media_source:{version:1,kind:'audio',name:'Authored native mock',size:wav(150).length,last_modified:1,type:'audio/wav',fingerprint:'a'.repeat(64)}};
 const summaryPlan=summary.plan(summaryDoc),summaryJob=summary.create(summaryPlan,'codex');let savedSummary;while(!savedSummary){const request=summary.request(summaryPlan,summaryJob);savedSummary=summary.accept(summaryPlan,summaryJob,{answer:'Authored saved whole-source summary',citations:[request.segments.at(-1).id]});}summaryDoc.ai_answers=[savedSummary];assert.equal(core.summaryFreshness(savedSummary,summaryDoc),'current');
 const staleSummary={...structuredClone(summaryDoc),key:'matrix-summary-stale',title:'Authored stale summary source'};staleSummary.segments[64].text='Changed current source 64';assert.equal(core.summaryFreshness(savedSummary,staleSummary),'stale');
 const missingSummary={...structuredClone(summaryDoc),key:'matrix-summary-missing',title:'Authored missing summary source',segments:summaryDoc.segments.slice(0,64)};assert.equal(core.summaryFreshness(savedSummary,missingSummary),'stale');
 const prefKeys={theme:'coconut-reading-theme-v1',measure:'coconut-reading-measure-v1',layout:'coconut-reading-layout-v1',shortcuts:'coconut-reading-shortcuts-v1'};
 const preferenceSeed={[prefKeys.theme]:'dark',[prefKeys.measure]:'narrow',[prefKeys.layout]:'spacious',[prefKeys.shortcuts]:'off','coconut-reading-view-defaults-v1':JSON.stringify({version:1,views:[[summaryDoc.key,'summary-cue-64','summary']]})};
 const readingService=await startService('reading-defaults'),reading=await contextFor(readingService,{bridge:true,remembered:[summaryDoc.key],preferences:preferenceSeed,seed:JSON.stringify({documents:[summaryDoc,staleSummary,missingSummary],active:summaryDoc.key})}),rp=reading.page;
 await expect(rp.locator('html')).toHaveAttribute('data-reader-theme','dark');await expect(rp.locator('html')).toHaveCSS('background-color','rgb(33, 31, 29)');await expect(rp.locator('html')).toHaveCSS('color','rgb(233, 230, 223)');await expect(rp.locator('html')).toHaveAttribute('data-reading-measure','narrow');await expect(rp.locator('html')).toHaveAttribute('data-reading-layout','spacious');
 const prefs=rp.locator('.reading-preferences');await prefs.locator('summary').click();await expect(prefs.locator('label').filter({hasText:/^主题/}).locator('select')).toHaveValue('dark');await expect(prefs.getByLabel('启用单字符阅读快捷键',{exact:true})).not.toBeChecked();await prefs.locator('label').filter({hasText:/^主题/}).locator('select').selectOption('system');await rp.emulateMedia({colorScheme:'light'});await expect(rp.locator('html')).toHaveAttribute('data-reader-theme','light');await expect(rp.locator('html')).toHaveCSS('background-color','rgb(248, 247, 243)');await rp.emulateMedia({colorScheme:'dark'});await expect(rp.locator('html')).toHaveAttribute('data-reader-theme','dark');await expect(rp.locator('html')).toHaveCSS('background-color','rgb(33, 31, 29)');await expect(rp.locator('html')).toHaveCSS('color','rgb(233, 230, 223)');await prefs.locator('label').filter({hasText:/^行宽/}).locator('select').selectOption('full');await prefs.locator('label').filter({hasText:/^阅读排版/}).locator('select').selectOption('large');
 const other=await reading.context.newPage();await other.goto(readingService.origin+'/index.html');await expect(other.getByRole('heading',{name:'今天，想听什么？'})).toBeVisible();await other.locator('.reading-preferences > summary').click();await other.locator('.reading-preferences label').filter({hasText:/^主题/}).locator('select').selectOption('light');await expect(rp.locator('html')).toHaveAttribute('data-reader-theme','light');await expect(rp.locator('html')).toHaveCSS('background-color','rgb(248, 247, 243)');await expect(prefs.getByRole('status')).toHaveText('阅读偏好已与另一窗口同步');await other.close();
 await rp.reload();await expect(rp.getByRole('heading',{name:'今天，想听什么？'})).toBeVisible();assert.deepEqual(await rp.evaluate(keys=>Object.fromEntries(Object.entries(keys).map(([name,key])=>[name,localStorage.getItem(key)])),prefKeys),{theme:'light',measure:'full',layout:'large',shortcuts:'off'});
 await rp.getByRole('button',{name:'继续阅读',exact:true}).click();const mode=rp.locator('.reader-workspace label').filter({hasText:/^阅读方式/}).locator('select'),search=rp.getByRole('searchbox',{name:'搜索原话、译文和笔记'});await expect(mode).toHaveValue('summary');await expect(rp.getByRole('region',{name:'摘要阅读'})).toContainText('覆盖当前整篇原文');assert.equal(readingService.asks.length,0);
 await rp.getByRole('navigation',{name:'摘要引用'}).getByRole('button').last().click();await expect(mode).toHaveValue('transcript');await expect(rp.locator('[data-cue-id="summary-cue-64"]')).toBeVisible();await mode.selectOption('summary');await rp.getByRole('button',{name:'返回原阅读状态',exact:true}).click();await expect(rp.locator('.rw-current')).toHaveAttribute('data-cue-id','summary-cue-64');
 await mode.selectOption('passages');await search.fill('source 6');const filteredPassages=await rp.locator('.rw-passages').innerText();await mode.selectOption('summary');await rp.getByRole('button',{name:'返回原阅读状态',exact:true}).click();await expect(mode).toHaveValue('passages');await expect(search).toHaveValue('source 6');assert.equal(await rp.locator('.rw-passages').innerText(),filteredPassages);
 await search.fill('');await mode.selectOption('transcript');await expect.poll(()=>rp.locator('audio').evaluate(player=>player.duration)).toBe(150);assert.equal(await rp.locator('audio').evaluate(player=>player.paused),true);
 const source=rp.locator('.rw-original').first();await source.focus();await source.press('/');await expect(source).toBeFocused();await source.press('Control+f');await expect(search).toBeFocused();await search.press('l');await expect(search).toHaveValue('l');await search.fill('');
 await prefs.locator('summary').click();await prefs.getByLabel('启用单字符阅读快捷键',{exact:true}).check();await prefs.locator('label').filter({hasText:/^阅读排版/}).locator('select').focus();await rp.keyboard.press('Escape');await expect(prefs).not.toHaveAttribute('open');await expect(prefs.locator('summary')).toBeFocused();
 await rp.locator('audio').evaluate(player=>{player.currentTime=20;});await source.focus();await source.press('l');await expect.poll(()=>rp.locator('audio').evaluate(player=>player.currentTime)).toBe(25);await source.press('j');await expect.poll(()=>rp.locator('audio').evaluate(player=>player.currentTime)).toBe(20);
 await source.dispatchEvent('compositionstart');await source.press('l');assert.equal(await rp.locator('audio').evaluate(player=>player.currentTime),20);await source.dispatchEvent('compositionend');
 assert.equal(await source.evaluate(node=>{const event=new KeyboardEvent('keydown',{key:'l',bubbles:true,cancelable:true,isComposing:true});node.dispatchEvent(event);return event.defaultPrevented;}),false);assert.equal(await source.evaluate(node=>{const event=new KeyboardEvent('keydown',{key:'l',bubbles:true,cancelable:true,repeat:true});node.dispatchEvent(event);return event.defaultPrevented;}),false);assert.equal(await rp.locator('audio').evaluate(player=>player.currentTime),20);
 await source.press('?');const help=rp.getByRole('dialog',{name:'阅读快捷键'}),closeHelp=help.getByRole('button',{name:'关闭快捷键帮助'});await expect(closeHelp).toBeFocused();await rp.keyboard.press('Tab');await expect.poll(()=>help.evaluate(node=>node.contains(document.activeElement))).toBe(true);await rp.keyboard.press('Shift+Tab');await expect.poll(()=>help.evaluate(node=>node.contains(document.activeElement))).toBe(true);await closeHelp.press('l');assert.equal(await rp.locator('audio').evaluate(player=>player.currentTime),20);await closeHelp.press('Escape');await expect(help).toHaveCount(0);await expect(source).toBeFocused();await source.press('/');await expect(search).toBeFocused();await search.press('l');await expect(search).toHaveValue('l');assert.equal(await rp.locator('audio').evaluate(player=>player.currentTime),20);await search.fill('');
 await rp.getByRole('textbox',{name:'项目笔记',exact:true}).focus();assert.equal(await rp.getByRole('textbox',{name:'项目笔记',exact:true}).evaluate(node=>{const e=new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true});node.dispatchEvent(e);return e.defaultPrevented;}),false);
 await source.focus();await source.press('k');await expect.poll(()=>rp.locator('audio').evaluate(player=>player.paused)).toBe(false);await source.press('k');await expect.poll(()=>rp.locator('audio').evaluate(player=>player.paused)).toBe(true);await expect(rp.locator('.reader-workspace > p[role=status]')).not.toContainText('播放未能开始');await source.press('g');await expect(rp.locator('.rw-current')).toBeVisible();
 await mode.selectOption('summary');const readingGeometry=[];for(const width of [1360,390]){readingGeometry.push(await assertReaderFlow(rp,width));await expect(rp.locator('.reader-workspace > p[role=status]')).not.toContainText('播放未能开始');await shot(rp,'summary-preferences',width);}pass('Normal-flow player does not cover summary, return controls or project notes after scrolling',{geometry:readingGeometry});await rp.getByRole('button',{name:'查看 AI 计划与记录',exact:true}).click();await expect(rp.locator('.react-ai-panel')).toHaveAttribute('open');assert.equal(readingService.asks.length,0,'Summary reading and opening plan never run inference');
 for(const stale of [staleSummary,missingSummary]){await rp.getByRole('button',{name:/^我的内容/}).click();await rp.locator('.library-page li button').filter({hasText:stale.title}).first().click();await mode.selectOption('summary');await expect(rp.getByRole('region',{name:'摘要阅读'})).toContainText('可能过期');await expect(rp.getByRole('navigation',{name:'摘要引用'}).getByRole('button')).toHaveCount(0);await rp.locator('.rw-summary details > summary').click();await expect(rp.locator('.rw-summary details')).toContainText('Original summary source 64');if(stale===missingSummary)await expect(rp.getByRole('navigation',{name:'摘要引用'})).toContainText('原片段已不存在');}
 await rp.getByRole('button',{name:'发现与添加',exact:true}).click();const urlInput=rp.getByRole('textbox',{name:'播客或视频链接'});await urlInput.focus();assert.equal(await urlInput.evaluate(node=>{const e=new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true});node.dispatchEvent(e);return e.defaultPrevented;}),false);assert.equal(readingService.asks.length,0);
 pass('Legacy preference keys persist and synchronize; saved summary restores scope/provenance; real keyboard input, IME, modal and focus boundaries',{media:'Authored WAV through explicitly mocked native receipt, actual browser playback'});await reading.context.close();contexts.delete(reading.context);await readingService.close();

 stage='React AI explicit consent, provenance, late source and transient errors';
 const aiService=await startService('ai'),ai=await contextFor(aiService);await authority(ai.page,'begin');await openA(ai.page);
 await ai.page.locator('.react-ai-panel > summary').click();assert.equal(aiService.asks.length,0);await ai.page.getByRole('button',{name:'检查本地 AI 连接',exact:true}).click();await expect(ai.page.getByText(/前台语言服务可用|连接可用；发送前/)).toBeVisible();
 const consent=ai.page.getByRole('checkbox',{name:/我确认上述范围、提供商与模型/}),submit=ai.page.getByRole('button',{name:'执行本次任务',exact:true});
 await ai.page.locator('.ai-workspace fieldset label').filter({hasText:/^问题/}).locator('textarea').fill('Explain this authored source');await expect(submit).toBeDisabled();assert.equal(aiService.asks.length,0);
 await consent.check();await ai.page.getByLabel('模型',{exact:true}).fill('authored-model');await expect(consent).not.toBeChecked();await expect(submit).toBeDisabled();await consent.check();await submit.click();await expect(ai.page.getByText('回答已保存。请对照原文核对。',{exact:true})).toBeVisible();
 assert.equal(aiService.asks.length,1);assert.equal(aiService.asks[0].consent,true);assert.equal(aiService.asks[0].model,'authored-model');assert.deepEqual(aiService.asks[0].segments,[{id:'cue',text:documentA.segments[0].text}]);await saved(ai.page);
 let answer=(await record(aiService)).document.ai_answers[0];assert.equal(answer.input_snapshot.segments[0].text,documentA.segments[0].text);assert.deepEqual(answer.citations,['cue']);await ai.page.getByRole('button',{name:'查看当时发送的原文依据',exact:true}).click();await expect(ai.page.getByText('这是历史请求的原文，可能与当前文稿不同。',{exact:true})).toBeVisible();
 await expect(ai.page.locator('.ai-workspace fieldset label').filter({hasText:/^问题/}).locator('textarea')).toHaveValue('Explain this authored source');await aiService.command('mode','hold');await ai.page.locator('.ai-workspace fieldset label').filter({hasText:/^问题/}).locator('textarea').fill('Delayed source A question');await consent.check();await submit.click();await expect.poll(()=>aiService.asks.length).toBe(2);
 await ai.page.getByRole('button',{name:/^我的内容/}).click();await ai.page.locator('.library-page li button').filter({hasText:documentB.title}).first().click();await expect(ai.page.getByRole('heading',{name:documentB.title,exact:true})).toBeVisible();
 const lateResponse=ai.page.waitForResponse(response=>response.url().endsWith('/api/ask'));await aiService.command('release');await lateResponse;await ai.page.locator('.react-ai-panel > summary').click();await expect(ai.page.getByText('0 条记录',{exact:true})).toBeVisible();assert.equal((await record(aiService,documentB.key)).document.ai_answers?.length||0,0);assert.equal((await record(aiService)).document.ai_answers.length,1);
 await aiService.command('mode','error');await ai.page.getByRole('button',{name:'检查本地 AI 连接',exact:true}).click();await expect(ai.page.getByText(/前台语言服务可用|连接可用；发送前/)).toBeVisible();await ai.page.locator('.ai-workspace fieldset label').filter({hasText:/^问题/}).locator('textarea').fill('Error details fixture');await consent.check();await submit.click();await expect(ai.page.getByRole('button',{name:'查看本次本机错误详情',exact:true})).toBeVisible();await expect(ai.page.getByText(/AUTHORED_LOCAL_DETAIL/)).toHaveCount(0);await ai.page.getByRole('button',{name:'查看本次本机错误详情',exact:true}).click();await expect(ai.page.getByText(/AUTHORED_LOCAL_DETAIL/)).toBeVisible();assert.ok(!JSON.stringify(await backup(ai.page)).includes('AUTHORED_LOCAL_DETAIL'));await shot(ai.page,'ai-error-details',1360);await shot(ai.page,'ai-error-details',390);
 await ai.page.locator('.react-ai-panel > summary').click();await ai.page.locator('.react-ai-panel > summary').click();await expect(ai.page.getByRole('button',{name:'查看本次本机错误详情',exact:true})).toHaveCount(0);
 pass('React AI uses consent-bound fake provider, preserves citations, rejects late source results and keeps diagnostics transient');
 await ai.context.close();contexts.delete(ai.context);await aiService.close();

 stage='Authored native bridge mock receipts, subtitle encoding and JSON recovery';
 const localService=await startService('local'),local=await contextFor(localService,{seed:null,bridge:true,width:390}),p=local.page;
 await expect(p.locator('.subtitle-recovery')).not.toHaveAttribute('open');await expect(p.locator('.recovery-entry')).not.toHaveAttribute('open');await expect(p.getByRole('button',{name:'打开音频或视频文件',exact:true})).toBeVisible();await expect(p.getByRole('button',{name:'查看单集',exact:true}).first()).toBeVisible();await shot(p,'source-first-home',390);await shot(p,'source-first-home',1360);
 // Real browser picker ownership with a MOCK native bridge; empty selection is not an OS cancel proof.
 const [emptyChooser]=await Promise.all([p.waitForEvent('filechooser'),p.getByRole('button',{name:'打开音频或视频文件',exact:true}).click()]);
 const picking=await p.evaluate(()=>coconutPrepareClose('inspect'));assert.equal(picking.safe,false);assert.equal(picking.flushable,false);assert.equal(await p.evaluate(()=>coconutPrepareUpdate()),false);assert.equal(await p.evaluate(()=>coconutPrepareClose('safe',{id:11,kind:'close',expiresAt:Date.now()+10000})),false);
 await emptyChooser.setFiles([]);await expect.poll(()=>p.evaluate(()=>coconutPrepareClose('inspect').safe)).toBe(true);await expect(p.getByRole('heading',{name:'今天，想听什么？'})).toBeVisible();assert.equal(await p.locator('audio,video,.reader-workspace').count(),0);pass('Real picker blocks close/update until an empty selection retires its owner',{limitation:'Empty browser selection, not native OS cancel; native lifecycle bridge is a mock'});
 await chooseFile(p,p.getByRole('button',{name:'打开音频或视频文件',exact:true}),{name:'authored-native.wav',mimeType:'audio/wav',buffer:wav()});await expect(p.getByRole('heading',{name:'authored-native.wav',exact:true})).toBeVisible();await saved(p);assert.equal(await p.locator('audio').evaluate(player=>player.paused),true);assert.equal(await p.locator('.rw-cue').count(),0);await p.getByRole('textbox',{name:'项目笔记',exact:true}).fill('Keep this project note');await p.getByRole('button',{name:'保存笔记',exact:true}).click();await saved(p);
 await p.getByRole('checkbox',{name:'在这台电脑记住原文件',exact:true}).check();await expect(p.getByText(/已在这台电脑记住原文件/)).toBeVisible();const nativeBefore=await p.evaluate(()=>authoredNativeCalls);assert.equal(nativeBefore.filter(c=>c.kind==='remember').length,1);assert.ok(nativeBefore.find(c=>c.kind==='remember').owner.epoch>0);
 const rawBackup=await backup(p),rawDoc=rawBackup.documents[0];assert.equal(rawDoc.project_note,'Keep this project note');assert.ok(!JSON.stringify(rawBackup).includes('authored-native-token'));
 await p.reload();await p.getByRole('button',{name:'继续阅读',exact:true}).click();await expect(p.locator('audio')).toBeVisible();assert.equal(await p.locator('audio').evaluate(player=>player.paused),true);await expect(p.getByText(/已载入本机原文件，未自动播放/)).toBeVisible();await p.getByRole('button',{name:'不再记住',exact:true}).click();await expect(p.getByText(/已不再记住原文件/)).toBeVisible();assert.equal(await p.locator('audio').count(),1,'Forget preserves loaded session');
 const closeInspection=await p.evaluate(()=>coconutPrepareClose('inspect'));assert.equal(closeInspection.safe,true);
 await p.getByRole('textbox',{name:'项目笔记',exact:true}).fill('Unsaved native close guard');assert.equal(await p.evaluate(()=>coconutPrepareClose('inspect').safe),false);assert.equal(await p.evaluate(()=>coconutPrepareClose('safe',{id:12,kind:'close',expiresAt:Date.now()+10000})),false);await p.getByRole('button',{name:'取消修改',exact:true}).click();
 pass('Native bridge MOCK receives persisted owners, remember/resolve/forget receipts and rejects close with dirty draft',{limitation:'Browser-injected mock; no macOS/Electron/native file proof'});
 await p.getByText('已有字幕？恢复到此原声项目',{exact:true}).click();await p.locator('.subtitle-recovery > summary').click();await p.getByRole('button',{name:'补充到当前原声项目（重新核对）',exact:true}).click();
 const encoded=encodingFixtures.find(item=>item.name==='gb18030.srt');await chooseFile(p,p.getByRole('button',{name:'选择字幕文件（可多选）',exact:true}),{name:encoded.name,mimeType:'application/x-subrip',buffer:bytesFor(encoded)});
 await expect(p.locator('.subtitle-recovery label').filter({hasText:/^原始文件编码/}).locator('select')).toBeVisible();await expect(p.getByRole('button',{name:'将已核对字幕附加到目标项目',exact:true})).toBeDisabled();await p.locator('.subtitle-recovery label').filter({hasText:/^原始文件编码/}).locator('select').selectOption(encoded.encoding);const reviewed=p.getByRole('checkbox',{name:'我已核对文字、编码和诊断，确认加入',exact:true});await reviewed.check();await p.locator('.subtitle-recovery label').filter({hasText:/^原始文件编码/}).locator('select').selectOption('utf-8');await expect(reviewed).toHaveCount(0);await p.locator('.subtitle-recovery label').filter({hasText:/^原始文件编码/}).locator('select').selectOption(encoded.encoding);await expect(reviewed).not.toBeChecked();await reviewed.check();await p.getByRole('button',{name:'将已核对字幕附加到目标项目',exact:true}).click();await expect(p.locator('.rw-original')).toContainText('中文测试𠀀');await saved(p);assert.equal(await p.locator('audio').count(),1);
 const attached=await backup(p);assert.ok(!JSON.stringify(attached).includes('authored-native-token'),'Resolved native token never enters portable backup');assert.equal(attached.documents.length,1);assert.equal(attached.documents[0].key,rawDoc.key);assert.equal(attached.documents[0].project_note,'Keep this project note');assert.deepEqual(attached.documents[0].local_media_source,rawDoc.local_media_source);assert.equal(attached.documents[0].segments[0].text,'中文测试𠀀\n第二行');await shot(p,'attached-subtitle',390);
 assert.equal(await p.evaluate(()=>coconutPrepareClose('safe',{id:13,kind:'close',expiresAt:Date.now()+10000})),true);await expect.poll(()=>p.evaluate(()=>authoredNativeCalls.filter(c=>c.kind==='release').map(c=>c.token))).toEqual(['authored-native-token']);assert.equal(await p.locator('#react-root').evaluate(node=>node.inert),true);assert.equal(await p.evaluate(()=>coconutPrepareClose('release',{id:13,kind:'close',expiresAt:Date.now()+10000})),true);
 const restored=await contextFor(localService,{seed:null,width:390});await restored.page.locator('.recovery-entry > summary').click();await chooseFile(restored.page,restored.page.getByRole('button',{name:'恢复书架备份',exact:true}),{name:'authored-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(attached))});await expect(restored.page.getByText('恢复结果见上方保存状态。',{exact:true})).toBeVisible();await saved(restored.page);const recovered=await backup(restored.page);assert.deepEqual(recovered.documents,attached.documents);await restored.page.reload();await restored.page.getByRole('button',{name:/^我的内容/}).click();await restored.page.locator('.library-page li button').filter({hasText:rawDoc.title}).first().click();await expect(restored.page.getByRole('heading',{name:rawDoc.title,exact:true})).toBeVisible();await expect(restored.page.locator('.rw-original')).toContainText('中文测试𠀀');await expect(restored.page.getByRole('textbox',{name:'项目笔记',exact:true})).toHaveValue('Keep this project note');assert.equal(await restored.page.locator('audio').count(),0,'JSON does not serialize a native session URL');
 pass('Real GB18030 bytes require renewed review; attach preserves raw project identity and JSON recovery reload');
 assert.deepEqual(localService.asks,[],'Recovery/native flow never invokes inference');
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.deepEqual(forbidden,[],'No ASR/upload/download/task submission');
 await writeFile(path.join(output,'react-production-matrix.json'),JSON.stringify({status:'passed',checks,boundaries:['fake provider','fake source acquisition in companion smoke','native bridge mock','no upstream/ASR/model/Mac verification'],errors,blocked,forbidden},null,2));
 console.log('PASS production React authored matrix');
}catch(error){await writeFile(path.join(output,'react-production-matrix-failure.json'),JSON.stringify({stage,message:error.message,stack:error.stack,checks,errors,blocked,forbidden},null,2));throw error;}
finally{for(const context of contexts)await context.close().catch(()=>{});await browser?.close();for(const service of [...services])await service.close();await rm(root,{recursive:true,force:true});}
