/** Authored fixtures only. Exercises the production bundle and IndexedDB bootstrap. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect} from './helpers/browser-storage.mjs';
import {readFirstFixture} from './helpers/read-first-fixture.mjs';
const root=fileURLToPath(new URL('../reader/',import.meta.url));
let browser,server,activePage,stage='setup',external=0;const errors=[],geometry=[];
try{
 server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  if(!/^[a-z-]+\.(html|js|css|png)$/.test(name)){res.writeHead(404).end();return;}
  try{res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'});res.end(await fs.readFile(path.join(root,name)));}catch{res.end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 for(const width of [320,390,1360]){
  const context=await browser.newContext({viewport:{width,height:width===320?640:width===390?740:900},hasTouch:width<650,isMobile:width<650,serviceWorkers:'block'});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external++;return route.abort();});
  const page=await context.newPage();activePage=page;stage=`${width}:startup`;page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
  const doc=readFirstFixture(125);doc.readingPosition='read-3';
  stage=`${width}:import`;await page.locator('#file').setInputFiles({name:'authored-navigation.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});
  stage=`${width}:ready`;await expect(page.locator('#title')).toHaveText(doc.title);await expect(page.locator('#open-transcript-navigator')).toBeVisible();await expect(page.locator('.passage-browse')).toBeHidden();
  await page.evaluate(()=>libraryStore.flush());const contentBefore=await page.evaluate(()=>JSON.stringify(state.documents));
  stage=`${width}:open-and-page`;await page.locator('#open-transcript-navigator').click();await expect(page.locator('#transcript-navigator-dialog')).toBeVisible();
  await expect(page.locator('.navigator-results li')).toHaveCount(40);
  await page.locator('#transcript-navigator-dialog').getByRole('button',{name:'后面的原文'}).click();
  await expect(page.locator('.navigator-results li').first()).toContainText('Authored observation 41');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  stage=`${width}:geometry-and-focus`;const bounds=await page.locator('#transcript-navigator-dialog').evaluate(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};});
  assert.ok(bounds.left>=0&&bounds.right<=width&&bounds.top>=0&&bounds.bottom<=bounds.height);geometry.push(bounds);
  for(let i=0;i<6;i++){await page.keyboard.press('Tab');assert.equal(await page.locator('#transcript-navigator-dialog').evaluate(node=>node.contains(document.activeElement)),true);}

  if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,`navigator-${width}.png`)});}
  stage=`${width}:exact-jump`;await page.locator('.navigator-results li').first().getByRole('button').click();
  await expect(page.locator('body')).toHaveAttribute('data-reading-mode','passages');await expect(page.locator('#transcript-navigator-dialog')).not.toBeVisible();
  await expect(page.locator('#passage-body .passage-cue').first()).toHaveAttribute('data-cue-id','read-40');
  stage=`${width}:escape-and-time`;await page.locator('#open-transcript-navigator').click();await page.keyboard.press('Escape');await expect(page.locator('#open-transcript-navigator')).toBeFocused();
  await page.locator('#open-transcript-navigator').click();await page.locator('#navigator-time').fill('bad');await page.locator('#transcript-navigator-dialog').getByRole('button',{name:'前往',exact:true}).click();await expect(page.locator('#navigator-error')).toContainText('请输入');
  await page.locator('#navigator-time').fill('0:10');await page.locator('#transcript-navigator-dialog').getByRole('button',{name:'前往',exact:true}).click();await expect(page.locator('#transcript-navigator-dialog')).not.toBeVisible();
  stage=`${width}:search-and-chapters`;await page.locator('#open-transcript-navigator').click();await page.locator('#transcript-navigator-dialog').getByRole('button',{name:'查找文字'}).click();await expect(page.locator('#search')).toBeFocused();await expect(page.locator('body')).toHaveAttribute('data-reading-mode','transcript');
  await expect(page.locator('.transcript-navigation')).toBeHidden();
  await page.locator('#open-transcript-navigator').click();await page.locator('#transcript-navigator-dialog').getByRole('button',{name:'章节目录'}).click();await expect(page.locator('#chapter-dialog')).toBeVisible();await page.locator('#chapter-close').click();await expect(page.locator('#open-transcript-navigator')).toBeFocused();
  assert.equal(await page.evaluate(()=>JSON.stringify(state.documents)),contentBefore,'navigation must not rewrite source, notes, translations or saved bookmarks');
  await context.close();
 }
 // A missing optional bundle must never strand IndexedDB bootstrap or remove
 // the original time-navigation controls.
 stage='bundle-fallback';const context=await browser.newContext();await context.route('**/transcript-navigator.js*',route=>route.abort());const page=await context.newPage();activePage=page;await page.goto(origin);
 await page.locator('#file').setInputFiles({name:'fallback.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(readFirstFixture(125)))});
 await expect(page.locator('.passage-browse')).toBeVisible();await page.locator('#mode-transcript').click();await expect(page.locator('#reading-jump')).toBeVisible();await page.locator('#reading-jump').selectOption({index:2});await expect(page.locator('.segment:focus')).toHaveCount(1);
 if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'navigator-fallback.png')});}
 await context.close();
 if(process.env.COCONUT_UI_SCREENSHOTS)await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'navigator-checks.json'),JSON.stringify({geometry,external,errors},null,2));
 assert.equal(external,0);assert.deepEqual(errors,[]);console.log('Transcript navigation: responsive UI, exact jumps, existing search/chapters, Escape focus, bounded DOM and bundle-failure fallback passed.');
}catch(error){
 if(process.env.COCONUT_UI_SCREENSHOTS){
  await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});
  if(activePage&&!activePage.isClosed())await activePage.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'navigator-failure.png')}).catch(()=>{});
  await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'navigator-checks.json'),JSON.stringify({failed:true,stage,geometry,external,errors,message:error.message},null,2));
 }
 throw error;
}finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
