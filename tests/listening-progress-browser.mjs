/** Authored PCM only. Run in CI; never reads personal media or invokes AI. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
const root=new URL('../reader/',import.meta.url),dir=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-listening-'));
let browser,server;
try{
 const samples=8000*40,wav=Buffer.alloc(44+samples*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
 for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*220/8000)*1000),44+i*2);
 const audio=path.join(dir,'authored.wav');await fs.writeFile(audio,wav);
 server=createServer(async(req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';if(!/^[a-z-]+\.(html|js|css|png)$/.test(name)){res.writeHead(404).end();return;}try{res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html');res.end(await fs.readFile(new URL(name,root)));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});const page=await browser.newPage();let external=0;
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===origin||['blob:','data:'].includes(u.protocol))return route.continue();external++;return route.abort();});
 await page.goto(origin);
 const doc={title:'Authored resume proof',segments:[{id:'one',start:0,end:40,text:'Original synthetic media for resume testing.'}]};
 await page.locator('#file').setInputFiles({name:'resume.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});
 const attach=async()=>{if(await page.locator('#toggle-reader-media').isVisible())await page.locator('#toggle-reader-media').click();await page.locator('#attach-reader-media').click();await page.locator('#reader-media-file').setInputFiles(audio);await page.waitForFunction(()=>document.querySelector('#source-media audio')?.duration===40);};
 await attach();await page.locator('#source-media audio').evaluate(async p=>{p.currentTime=12;await new Promise(r=>p.addEventListener('seeked',r,{once:true}));await p.play();p.pause();});
 await page.waitForFunction(()=>Object.keys(localStorage).some(k=>k.startsWith('coconut-listening-v1:')&&JSON.parse(localStorage[k]).time>=12));
 await page.reload();await attach();assert.equal(await page.locator('#source-media audio').evaluate(p=>p.currentTime),0);assert.equal(await page.locator('#source-media audio').evaluate(p=>p.paused),true);
 await page.locator('#resume-listening').click();assert.ok(await page.locator('#source-media audio').evaluate(p=>p.currentTime>=12&&p.paused));
 // Same filename, size and duration with different sampled bytes must not match.
 const originalStat=await fs.stat(audio);wav[1000]^=127;await fs.writeFile(audio,wav);await fs.utimes(audio,originalStat.atime,originalStat.mtime);await page.locator('#attach-reader-media').click();await page.locator('#reader-media-file').setInputFiles(audio);await page.waitForFunction(()=>document.querySelector('#source-media audio')?.duration===40);
 await page.waitForFunction(()=>document.querySelector('#resume-listening').hidden);assert.equal(await page.locator('#source-media audio').evaluate(p=>p.currentTime),0);
 assert.equal(external,0);console.log('PASS: explicit paused resume after refresh; changed same-name media rejected; authored WAV only');
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
