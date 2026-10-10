/** Authored PCM only. Run in CI; never reads personal media or invokes AI. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
const root=new URL('../reader/',import.meta.url),dir=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-listening-'));
let browser,server,page,stage='create authored WAV';
const pageErrors=[],network=[],mediaEvents=[];
const remember=(items,value)=>{items.push(value);if(items.length>30)items.shift();};
try{
 const samples=8000*40,wav=Buffer.alloc(44+samples*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
 for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*220/8000)*1000),44+i*2);
 const audio=path.join(dir,'authored.wav');await fs.writeFile(audio,wav);
 server=createServer(async(req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';if(!/^[a-z-]+\.(html|js|css|png)$/.test(name)){res.writeHead(404).end();return;}try{res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html');res.end(await fs.readFile(new URL(name,root)));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 stage='open static reader';
 browser=await chromium.launch({headless:true});page=await browser.newPage();let external=0;
 page.on('pageerror',error=>remember(pageErrors,error.message));
 page.on('requestfailed',request=>remember(network,{url:request.url(),error:request.failure()?.errorText}));
 page.on('response',response=>{if(response.status()>=400)remember(network,{url:response.url(),status:response.status()});});
 await page.exposeFunction('recordMediaEvent',event=>remember(mediaEvents,event));
 await page.addInitScript(()=>{
  for(const name of ['cancel','change','loadstart','loadedmetadata','canplay','error','emptied'])document.addEventListener(name,event=>{
   const target=event.target;if(target?.id!=='reader-media-file'&&!target?.matches?.('#source-media audio'))return;
   window.recordMediaEvent({event:name,target:target.id||target.tagName,files:target.files?.length,readyState:target.readyState,duration:Number.isFinite(target.duration)?target.duration:null,error:target.error?.message});
  },true);
 });
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===origin||['blob:','data:'].includes(u.protocol))return route.continue();external++;return route.abort();});
 await page.goto(origin);
 const doc={title:'Authored resume proof',segments:[{id:'one',start:0,end:40,text:'Original synthetic media for resume testing.'}]};
 await page.locator('#file').setInputFiles({name:'resume.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});
 const attach=async label=>{
  stage=label;
  await page.waitForFunction(()=>document.getElementById('title').textContent==='Authored resume proof');
  const previous=await page.locator('#source-media audio').count()?await page.locator('#source-media audio').getAttribute('src'):null;
  if(!await page.locator('#attach-reader-media').isVisible())await page.locator('#toggle-reader-media').click();
  // Observe the native picker before opening it. Direct setInputFiles after
  // click can race the browser's cancel event, retiring pendingMediaDocument.
  const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);
  await chooser.setFiles(audio);
  await page.waitForFunction(previous=>{
   const p=document.querySelector('#source-media audio');
   return document.getElementById('notice').textContent.startsWith('打开媒体失败：')||
    (p&&p.getAttribute('src')!==previous&&(p.error||p.readyState>=2&&p.duration===40));
  },previous);
  const media=await page.evaluate(()=>{const p=document.querySelector('#source-media audio');return p?{src:p.getAttribute('src'),error:p.error?.message,readyState:p.readyState,duration:p.duration}:null;});
  assert.ok(media,'media selection did not create a player; see failure diagnostics');
  assert.notEqual(media.src,previous,'selection must produce the newly chosen player');
  assert.equal(media.error,undefined);assert.ok(media.readyState>=2);assert.equal(media.duration,40);
 };
 await attach('initial file chooser and PCM decode');
 stage='save explicit listening position';
 await page.locator('#source-media audio').evaluate(async p=>{
  await new Promise(resolve=>{p.addEventListener('seeked',resolve,{once:true});p.currentTime=12;});
  await p.play();p.pause();
 });
 await page.waitForFunction(()=>Object.keys(localStorage).some(k=>k.startsWith('coconut-listening-v1:')&&JSON.parse(localStorage[k]).time>=12));
 stage='reload saved document';await page.reload();await attach('reselect same file after reload');assert.equal(await page.locator('#source-media audio').evaluate(p=>p.currentTime),0);assert.equal(await page.locator('#source-media audio').evaluate(p=>p.paused),true);
 stage='explicit paused resume';await page.locator('#resume-listening').click();assert.ok(await page.locator('#source-media audio').evaluate(p=>p.currentTime>=12&&p.paused));
 // Same filename, size and duration with different sampled bytes must not match.
 const originalStat=await fs.stat(audio);wav[1000]^=127;await fs.writeFile(audio,wav);await fs.utimes(audio,originalStat.atime,originalStat.mtime);await attach('reject changed same-metadata content');
 await page.waitForFunction(()=>document.querySelector('#resume-listening').hidden);assert.equal(await page.locator('#source-media audio').evaluate(p=>p.currentTime),0);
 assert.equal(external,0);assert.deepEqual(pageErrors,[]);console.log('PASS: explicit paused resume after refresh; changed same-name media rejected; authored WAV only');
}catch(error){
 let snapshot;
 try{snapshot=await page?.evaluate(()=>{
  const p=document.querySelector('#source-media audio');
  return {notice:document.getElementById('notice')?.textContent,mediaStatus:document.getElementById('reader-media-status')?.textContent,
   progressStatus:document.getElementById('listening-progress-status')?.textContent,
   media:p?{src:p.getAttribute('src'),currentSrc:p.currentSrc,readyState:p.readyState,networkState:p.networkState,duration:Number.isFinite(p.duration)?p.duration:null,currentTime:p.currentTime,paused:p.paused,error:p.error?{code:p.error.code,message:p.error.message}:null}:null};
 });}catch(diagnosticError){snapshot={diagnosticError:diagnosticError.message};}
 console.error(JSON.stringify({suite:'listening-progress',stage,error:error.message,snapshot,pageErrors,network,mediaEvents}));
 throw error;
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
