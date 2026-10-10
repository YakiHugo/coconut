/** CI-only native reload, cross-window and IndexedDB isolation proof.
 * Authored fixtures only; do not run in a browser-denied environment. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium,expect} from './helpers/browser-storage.mjs';
import {openLibraryTools} from './helpers/library-tools-browser.mjs';
const KEY='coconut-reading-recency-v1';
const documents=['a','b','c'].map(key=>({key,title:'Authored '+key,language:'en',readingPosition:'cue',notes:{},segments:[{id:'cue',start:0,end:5,text:'Authored source '+key}]}));
let browser,server,external=0;const errors=[],checks=[];
const order=page=>page.locator('#library .library-entry').evaluateAll(nodes=>nodes.map(n=>n.dataset.documentKey));
async function open(page,key){await openLibraryTools(page);await page.locator(`[data-document-key="${key}"] .library-open`).click();await expect(page.locator('#title')).toHaveText('Authored '+key);}
async function sort(page){await openLibraryTools(page);const options=page.locator('#library-options');if(!await options.evaluate(n=>n.open))await options.locator('summary').click();await page.locator('#library-sort').selectOption('opened');}
try{
 server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  if(req.method!=='GET'||!/^[-a-z]+\.(html|css|js|png)$/.test(name)){res.writeHead(404).end();return;}
  try{const body=await fs.readFile(new URL('../reader/'+name,import.meta.url));res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'}).end(body);}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 for(const width of [1360,390]){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external++;return route.abort();});
  await context.addInitScript(docs=>{if(!localStorage.getItem('authored-seeded')){localStorage.setItem('coconut-reader-v1',JSON.stringify({documents:docs}));localStorage.setItem('authored-seeded','yes');}},documents);
  const a=await context.newPage();a.on('pageerror',error=>errors.push(error.message));await a.goto(origin);
  const original=await a.evaluate(()=>readPersistedLibrary());assert.equal(await a.evaluate(key=>localStorage.getItem(key),KEY),null);
  await open(a,'c');await open(a,'b');await sort(a);assert.deepEqual(await order(a),['b','c','a']);
  const beforeReload=await a.evaluate(key=>localStorage.getItem(key),KEY);await a.reload();await openLibraryTools(a);
  assert.equal(await a.locator('#library-sort').inputValue(),'opened');assert.deepEqual(await order(a),['b','c','a']);assert.equal(await a.evaluate(key=>localStorage.getItem(key),KEY),beforeReload);
  const b=await context.newPage();b.on('pageerror',error=>errors.push(error.message));await b.goto(origin);await open(b,'a');
  await expect.poll(()=>order(a)).toEqual(['a','b','c']);await expect(a.locator('#title')).toHaveText('Authored b');
  assert.deepEqual(await a.evaluate(()=>readPersistedLibrary()),original);
  assert.equal(await a.locator('#save-status').getAttribute('data-state'),'saved');
  checks.push(`recent_open_reload_cross_window_and_no_content_changes_${width}`);await context.close();
 }
 assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({suite:'recent-reading',checks,external,pageErrors:errors.length}));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
