import {openLibraryTools} from './helpers/library-tools-browser.mjs';
/** CI-only: authored captures, actual downloads and narrow-screen source return. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium,waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {startBridge} from '../desktop/server.mjs';
import {largeLibraryFixture} from './helpers/large-library-fixture.mjs';
let browser,server;let external=0,mutations=0;const errors=[];
try{
 server=await startBridge({port:0});const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true,serviceWorkers:'block'});
 await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(!['GET','HEAD'].includes(request.method())){mutations++;await route.abort();}else if(url.origin===origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
 const docs=largeLibraryFixture(2,{cues:65});for(const doc of docs){doc.segments.forEach((cue,i)=>{cue.id='shared-'+i;cue.saved_excerpt=true;});doc.notes={'shared-64':'Final private note '+doc.key};}
 await page.locator('#library-file').setInputFiles({name:'authored-notebook.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'coconut-library',version:1,documents:docs,active:docs[0].key}))});
 await waitForPersistedLibrary(page,async()=>(await readPersistedLibrary()).documents.length===2);
 const originalTitle=await page.locator('#title').textContent();if(!await page.locator('#open-library-notebook').isVisible())await page.locator('#toggle-library').click();await openLibraryTools(page);await page.locator('#open-library-notebook').click();
 assert.equal(await page.locator('.notebook-capture').count(),30);assert.equal(await page.locator('#title').textContent(),originalTitle);
 assert.ok(await page.locator('#library-notebook').evaluate(n=>n.getBoundingClientRect().right<=innerWidth&&n.scrollWidth<=n.clientWidth));
 await page.locator('#notebook-search').fill('Authored shelf 00001');await page.locator('#notebook-next').click();await page.locator('#notebook-next').click();assert.equal(await page.locator('.notebook-capture').count(),5);
 await page.locator('.notebook-open').last().focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.activeElement===document.getElementById('note'));
 assert.equal(await page.locator('#note').inputValue(),'Final private note shelf-1');assert.equal(await page.locator('#title').textContent(),docs[1].title);
 await page.locator('#close-note').click();await page.locator('#return-library-notebook').click();assert.equal(await page.locator('.notebook-capture').count(),5);
 assert.ok(await page.locator('.notebook-open').last().evaluate(n=>n===document.activeElement));assert.equal(await page.locator('#notebook-search').inputValue(),'Authored shelf 00001');
 await page.locator('.notebook-capture input').last().check();await page.locator('#notebook-search').fill('no match at all');assert.equal(await page.locator('.notebook-capture').count(),0);
 const pending=page.waitForEvent('download');await page.locator('#notebook-export').click();const download=await pending,markdown=await fs.readFile(await download.path(),'utf8');
 assert.match(markdown,/所选 1 篇/);assert.match(markdown,/Authored document 1, source sentence 0/);assert.match(markdown,/source sentence 64/);assert.doesNotMatch(markdown,/Authored document 0/);
 await page.keyboard.press('Escape');assert.equal(await page.locator('#library-notebook').evaluate(n=>n.open),false);
 if(!await page.locator('#open-library-notebook').isVisible())await page.locator('#toggle-library').click();await openLibraryTools(page);await page.locator('#open-library-notebook').click();await page.locator('#notebook-close').click();
 assert.equal(external,0);assert.equal(mutations,0);assert.deepEqual(errors,[]);
 console.log('Library notebook: bounded mobile browsing, qualified source, keyboard return, actual full-document export, Escape and reopen passed.');
}finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
