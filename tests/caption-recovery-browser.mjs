// Compatibility renderer regression; this suite is not default React acceptance.
/** Real browser/local recovery proof with authored outcomes. No platform requests. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium,readerReady,installStorageAssertions} from './helpers/browser-storage.mjs';
const geometry=[];
const root=new URL('../reader/',import.meta.url);
let outcome='access_restricted',posts=0,browser;
const messages={access_restricted:'当前公开入口受限，未尝试登录或绕过限制；可打开原站或导入合法取得的字幕。',language_required:'无法确认原语言，请选择后重试；未启动识别。'};
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 const json=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 if(url.pathname==='/api/health')return json({local_worker:false,capabilities:{local_agents:true,caption_import:true}});
 if(url.pathname==='/api/captions/import'){posts++;return json({status:outcome,message:messages[outcome]});}
 if(req.method!=='GET'||url.pathname.startsWith('/api/')){res.writeHead(404,{'Content-Type':'application/json'});res.end('{}');return;}
 const filename=url.pathname==='/'?'compatibility.html':url.pathname.slice(1);
 if(!/^[a-z-]+\.(html|js|css|png)$/.test(filename)){res.writeHead(404).end();return;}
 try{const data=await fs.readFile(new URL(filename,root));res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.png')?'image/png':'text/html'});res.end(data);}catch{res.writeHead(404).end();}
});
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_PATH?{executablePath:process.env.COCONUT_CHROMIUM_PATH}:{})});
 const page=await browser.newPage({viewport:{width:1360,height:1000}});let external=0;const pageErrors=[],assetFailures=[];
 page.on('pageerror',error=>pageErrors.push(error.message));
 page.on('response',response=>{const url=new URL(response.url());if(url.origin===origin&&!url.pathname.startsWith('/api/')&&response.status()>=400)assetFailures.push(url.pathname);});
 await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external++;return route.abort();}return route.continue();});
 await page.goto(origin);await readerReady(page);await installStorageAssertions(page);
 await page.locator('#sample').click();await page.waitForFunction(()=>!document.getElementById('sample').disabled);
 const before=await page.evaluate(()=>readPersistedLibrary());await page.locator('#add-content').click();
 await page.locator('#video-url').fill('https://x.com/author/status/123');await page.locator('#caption-language').selectOption('en');
 await page.locator('#process-url').click();await page.locator('#caption-recovery').waitFor({state:'visible'});
 assert.equal(await page.locator('#source-route-status').textContent(),messages.access_restricted);
 const chooser=page.waitForEvent('filechooser');await page.locator('#caption-recovery-file').click();await (await chooser).setFiles([]);
 assert.equal(await page.locator('#video-url').inputValue(),'https://x.com/author/status/123');
 assert.equal(await page.locator('#caption-language').inputValue(),'en');
 assert.deepEqual(await page.evaluate(()=>readPersistedLibrary()),before);
 await page.locator('#caption-recovery-paste').focus();await page.keyboard.press('Enter');await page.locator('#paste-subtitle-dialog').waitFor({state:'visible'});
 const srt='1\n00:00:00,000 --> 00:00:02,000\nAuthored recovery caption.';
 await page.locator('#paste-subtitle-text').fill(srt);await page.locator('#close-paste-subtitle').click();
 assert.equal(await page.evaluate(()=>document.activeElement.id),'caption-recovery-paste');
 for(const width of [1360,390,320]){
  await page.setViewportSize({width,height:1000});await page.locator('#caption-recovery').scrollIntoViewIfNeeded();
  const dimensions=await page.locator('#caption-recovery').evaluate(n=>{const r=n.getBoundingClientRect();return {width:innerWidth,left:r.left,right:r.right,overflow:document.documentElement.scrollWidth>innerWidth};});
  assert.equal(dimensions.overflow,false);assert.ok(dimensions.left>=0&&dimensions.right<=width);geometry.push(dimensions);
  if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'caption-recovery-'+width+'.png'),fullPage:true});}
 }
 await page.setViewportSize({width:1360,height:1000});
 await page.locator('#caption-recovery-paste').click();assert.equal(await page.locator('#paste-subtitle-text').inputValue(),srt);
 await page.locator('#preview-paste-subtitle').click();await page.locator('#confirm-paste-subtitle').click();await page.locator('#reader-workspace').waitFor({state:'visible'});
 await page.waitForFunction(()=>!document.getElementById('paste-subtitle-dialog').open);
 assert.equal((await page.evaluate(()=>readPersistedLibrary())).documents.length,2);
 assert.equal(posts,1);assert.equal(external,0);assert.match(await page.locator('#reader-workspace').textContent(),/Authored recovery caption/);
 await page.locator('#add-content').click();outcome='language_required';await page.locator('#process-url').click();await page.locator('#caption-recovery-language').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>document.activeElement.id),'caption-language');
 await page.locator('#caption-language').selectOption('ja');assert.equal(await page.locator('#caption-recovery').isVisible(),false);
 await page.locator('#process-url').click();await page.locator('#caption-recovery').waitFor({state:'visible'});
 const files=page.waitForEvent('filechooser');await page.locator('#caption-recovery-file').click();
 await (await files).setFiles({name:'authored-recovery.vtt',mimeType:'text/vtt',buffer:Buffer.from('WEBVTT\n\n00:00.000 --> 00:02.000\nAuthored file recovery caption.\n')});
 await page.locator('#reader-workspace').waitFor({state:'visible'});
 await page.waitForFunction(()=>document.getElementById('save-status').dataset.state==='saved');
 assert.equal((await page.evaluate(()=>readPersistedLibrary())).documents.length,3);
 assert.match(await page.locator('#reader-workspace').textContent(),/Authored file recovery caption/);
 assert.equal(posts,3);assert.equal(external,0);

 assert.deepEqual(pageErrors,[]);assert.deepEqual(assetFailures,[]);
 const result={ok:true,geometry,posts,external,pageErrors:pageErrors.length,assetFailures:assetFailures.length,checks:['failure is not success','cancel file selection preserves context','keyboard paste and focus return','draft retained on close','real SRT paste and VTT file imports with persisted reading','language fallback and stale recovery cleared']};
 if(process.env.COCONUT_UI_SCREENSHOTS)await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'caption-recovery-checks.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
