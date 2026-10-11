/** Real CI Chromium coverage for first reading and return visits. Authored local
 * fixtures only; no provider, CLI or external source. Do not run outside CI. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect,waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {readFirstFixture} from './helpers/read-first-fixture.mjs';
const root=fileURLToPath(new URL('../reader/',import.meta.url));
let server,browser,external=0,mutations=0;const errors=[],checks=[];
async function mode(page,value){await expect(page.locator('body')).toHaveAttribute('data-reading-mode',value);await expect(page.locator(value==='summary'?'#summary-workspace':value==='passages'?'#passage-workspace':'#transcript-layout')).toBeVisible();}
async function saved(page,title){await waitForPersistedLibrary(page,async title=>(await readPersistedLibrary())?.documents.some(doc=>doc.title===title),title);}
async function importDoc(page,doc){await page.locator('#file').setInputFiles({name:'authored-read-first.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});await expect(page.locator('#title')).toHaveText(doc.title);await saved(page,doc.title);}
async function reopen(page,title){
 await page.locator('#add-content').click();
 if(await page.locator('#toggle-library').isVisible()&&await page.locator('#toggle-library').getAttribute('aria-expanded')!=='true')await page.locator('#toggle-library').click();
 await page.locator('.library-open').filter({has:page.locator('.library-title',{hasText:title})}).click();
}
async function capture(page,label){if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,`read-first-${label}.png`),fullPage:false,animations:'disabled'});}}
try{
 server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){mutations++;res.writeHead(405).end();return;}
  const pathname=new URL(req.url,'http://localhost').pathname,name=pathname==='/'?'index.html':pathname.slice(1);
  if(!/^[a-z-]+\.(html|js|css|png)$/.test(name)){res.writeHead(404).end();return;}
  try{res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'});res.end(await fs.readFile(path.join(root,name)));}catch{res.end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 for(const width of [320,1360]){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['blob:','data:'].includes(url.protocol))return route.continue();external++;return route.abort();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);await page.goto(origin);
  for(const [count,state] of [[1,'none'],[11,'none'],[12,'none'],[3,'current'],[3,'stale'],[3,'unknown'],[3,'job']]){
   const doc=readFirstFixture(count,{summary:['current','stale','unknown'].includes(state)?state:null,job:state==='job'});doc.title+=` ${state}`;
   const expected=count>=12?'passages':state==='none'?'transcript':'summary';
   await importDoc(page,doc);await mode(page,expected);
   if(state==='none'){
    await capture(page,`${width}-${count}-source-import`);
    await page.locator('#mode-summary').click();await mode(page,'summary');
    // A service capability update is an existing ordinary rerender, not a new
    // document navigation. It must not replace the user's explicit choice.
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('coconut-worker-ready',{detail:{media_import:false}})));await mode(page,'summary');
   }else if(state!=='job')await expect(page.locator('#summary-state')).toHaveAttribute('data-state',state);
   else await expect(page.locator('#prepare-summary')).toHaveText('查看分批进度 / 继续摘要');
   await reopen(page,doc.title);await mode(page,expected);await page.reload();await mode(page,expected);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'narrow reading must not overflow');
   checks.push(`${width}:${count}:${state}:import/reopen/reload`);
  }
  for(const state of ['none','current','job','demo']){
   const doc=readFirstFixture(3,{summary:state==='current'?state:null,job:state==='job',demo:state==='demo'});doc.title+=` restored ${state}`;
   const backup={format:'coconut-library',version:1,active:doc.key,documents:[doc]};
   await page.locator('#library-file').setInputFiles({name:'authored-library.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
   await expect(page.locator('#title')).toHaveText(doc.title);await saved(page,doc.title);await mode(page,['none','demo'].includes(state)?'transcript':'summary');checks.push(`${width}:restore:${state}`);
  }
  for(const bookmark of ['read-2','missing']){
   const doc=readFirstFixture(3,{summary:'current',bookmark});doc.title+=` ${bookmark}`;
   await importDoc(page,doc);await mode(page,bookmark==='read-2'?'transcript':'summary');
   if(bookmark==='read-2')await expect(page.locator('.segment[data-segment-id="read-2"]')).toBeFocused();
   await reopen(page,doc.title);await mode(page,bookmark==='read-2'?'transcript':'summary');
   if(bookmark==='read-2')await expect(page.locator('.segment[data-segment-id="read-2"]')).toBeFocused();
   await page.locator('#mode-summary').click();await page.locator('#summary-citations button').click();await expect(page.locator('.segment[data-segment-id="read-0"]')).toBeFocused();
   checks.push(`${width}:${bookmark}:precise-resume-and-citation`);
  }
  await page.locator('#add-content').click();await page.locator('#sample').click();await expect(page.locator('#sample')).toBeEnabled();await mode(page,'transcript');
  const demoTitle=await page.locator('#title').textContent();await saved(page,demoTitle);
  await expect(page.locator('#mode-bilingual')).toHaveAttribute('aria-pressed','true');await reopen(page,demoTitle);await mode(page,'transcript');await page.reload();await mode(page,'transcript');await expect(page.locator('#mode-bilingual')).toHaveAttribute('aria-pressed','true');await capture(page,`${width}-demo-return`);
  await page.locator('#mode-transcript').click();await waitForPersistedLibrary(page,async title=>(await readPersistedLibrary()).documents.some(doc=>doc.title===title&&doc.translation_view===''),demoTitle);
  await reopen(page,demoTitle);await page.reload();await mode(page,'transcript');await expect(page.locator('#mode-transcript')).toHaveAttribute('aria-pressed','true');checks.push(`${width}:demo-bilingual-and-source-only-return`);
  await context.close();
 }
 assert.deepEqual(errors,[]);assert.equal(external,0);assert.equal(mutations,0);console.log(JSON.stringify({suite:'read-first',checks,external,mutations,errors}));
}finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
