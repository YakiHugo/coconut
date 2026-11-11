/** Real service + SQLite + original __NEXT_DATA__ + a 32 KB WAV; no external I/O or inference. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
import {startService} from '../server/main.mjs';
import {directEpisodeFixture,directEpisodeId,directEpisodeURL,directEpisodeTitle,directMediaURL} from './fixtures/direct-episode-import.mjs';

const directory=await mkdtemp(path.join(tmpdir(),'coconut-direct-episode-browser-'));
const fixture=directEpisodeFixture(),forbidden=[],errors=[],requests=[];
const token='authored-direct-episode-owner-token-32-characters';
const app=await build({entryPoints:['frontend/app/main.tsx'],bundle:true,format:'iife',platform:'browser',target:['es2022'],minify:true,define:{'process.env.NODE_ENV':'"production"'},outdir:'reader',write:false});
const forbiddenInference=name=>async()=>{forbidden.push(name);throw Error('Inference is forbidden in direct episode acquisition tests');};
const transcriber={profile:{backend:'authored-disabled'},status:async()=>({available:false,model_download:false}),run:forbiddenInference('ASR run')};
const providers={status:async()=>({ready:false}),ask:forbiddenInference('model ask'),structured:forbiddenInference('model structured'),exclusive:forbiddenInference('model exclusive')};
let releaseMedia;
fixture.state.holdMedia=new Promise(resolve=>releaseMedia=resolve);
let server,browser,origin,env={COCONUT_PORT:'0',COCONUT_DATA_DIRECTORY:directory};
const start=async()=>{({server}=await startService({env,podcastSources:fixture.sources,transcriber,providers}));};
try{
 await start();const port=server.address().port;await server.shutdown();
 origin=`http://localhost:${port}`;env={...env,COCONUT_PORT:String(port),COCONUT_PUBLIC_ORIGIN:origin,COCONUT_OWNER_TOKEN:token};await start();
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1360,height:900},serviceWorkers:'block'});
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin){forbidden.push('external browser request: '+url.href);return route.abort();}
  // Test the current production React source without rewriting any generated production assets.
  if(url.pathname==='/react-app.js')return route.fulfill({status:200,contentType:'text/javascript',body:app.outputFiles.find(file=>file.path.endsWith('.js')).text});
  if(url.pathname==='/react-app.css')return route.fulfill({status:200,contentType:'text/css',body:app.outputFiles.find(file=>file.path.endsWith('.css')).text});
  return route.continue();
 });
 const page=await context.newPage();page.setDefaultTimeout(15000);
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{const url=new URL(request.url());requests.push({path:url.pathname,method:request.method(),body:request.method()==='POST'?request.postDataJSON():null});});
 await page.goto(origin+'/');
 await page.getByLabel('访问密钥').fill(token);await page.getByRole('button',{name:'登录',exact:true}).click();
 await expect(page.getByLabel('播客或视频链接')).toBeVisible();
 const initialLibrary=await context.request.get(origin+'/api/v1/library').then(response=>response.json());
 assert.equal(initialLibrary.backend,'sqlite');assert.equal(initialLibrary.sequence,0);
 assert.equal(fixture.calls.length,0,'opening discovery must not fetch the episode or media');

 await page.getByLabel('播客或视频链接').fill(directEpisodeURL);
 await page.getByRole('button',{name:'打开链接',exact:true}).click();
 // This is the only import click: no episode row, "listen first", save or ASR confirmation.
 await expect(page.locator('.reader-workspace')).toBeVisible();
 await expect.poll(()=>fixture.counts.media).toBe(1);
 await expect(page.getByRole('dialog',{name:'任务与状态',exact:true})).toHaveCount(0);
 await expect(page.getByText('正在获取原声，完成后会自动载入播放器。',{exact:true})).toBeVisible();
 releaseMedia();fixture.state.holdMedia=null;
 await expect(page.locator('audio')).toHaveAttribute('src',/api\/v1\/source-media\/content/);
 await expect(page.locator('.save-indicator')).toHaveAttribute('data-state','saved');
 const getCatalog=async()=>context.request.get(origin+'/api/v1/library/catalog?protocolVersion=1').then(response=>response.json());
 const library=await getCatalog();assert.equal(library.entries.length,1);
 const document=await context.request.get(origin+'/api/v1/library/document?'+new URLSearchParams({protocolVersion:'1',key:library.entries[0].key})).then(response=>response.json()).then(result=>result.record.document);
 assert.equal(document.title,directEpisodeTitle);assert.equal(document.project_kind,'audio_only');assert.equal(document.segments.length,0);
 assert.equal(document.source_url,directEpisodeURL);assert.equal(document.podcast_source.feed_url,directEpisodeURL);
 assert.equal(document.podcast_source.episode_id,directEpisodeId);assert.equal(document.podcast_source.media_url,directMediaURL);
 const key=document.key;
 const getJobs=async()=>context.request.get(origin+'/api/v1/source-jobs?'+new URLSearchParams({key})).then(response=>response.json()).then(result=>result.jobs);
 await expect.poll(async()=>(await getJobs()).find(job=>job.kind==='download')?.state).toBe('ready');
 const jobs=await getJobs();assert.equal(jobs.length,1);assert.equal(jobs[0].kind,'download');
 assert.equal(fixture.counts.media,1);

 const ingestionRequests=requests.filter(request=>request.path==='/api/v1/ingestions'&&request.method==='POST');
 assert.equal(ingestionRequests.length,2,'one link submission must discover then select exactly once');
 assert.deepEqual(ingestionRequests[0].body,{protocolVersion:1,source:{kind:'url',url:directEpisodeURL}});
 assert.equal(ingestionRequests[1].body.source.url,directEpisodeURL);
 assert.deepEqual(ingestionRequests[1].body.episode,{feed_url:directEpisodeURL,episode_id:directEpisodeId});
 assert.equal(ingestionRequests[1].body.language,undefined);
 const jobRequests=requests.filter(request=>request.path==='/api/v1/source-jobs'&&request.method==='POST');
 assert.equal(jobRequests.length,1);assert.equal(jobRequests[0].body.kind,'download');assert.equal(jobRequests[0].body.key,key);
 assert.equal(jobRequests[0].body.consent,true);
 assert.deepEqual(requests.filter(request=>request.method==='POST'&&['/api/podcasts/media','/api/v1/source-media','/api/v1/ingestions/upload'].includes(request.path)),[]);
 const mediaURL=new URL(await page.locator('audio').getAttribute('src'),origin).href;
 const mediaResponse=await context.request.get(mediaURL);assert.equal(mediaResponse.status(),200);
 assert.deepEqual(await mediaResponse.body(),fixture.wav,'the service must store and serve the original authored WAV');
 await page.locator('audio').evaluate(async audio=>{await audio.play();});
 await expect.poll(()=>page.locator('audio').evaluate(audio=>audio.currentTime)).toBeGreaterThan(0);

 await page.reload();
 await expect(page.locator('.reader-workspace')).toBeVisible();
 await expect(page.locator('audio')).toHaveAttribute('src',/api\/v1\/source-media\/content/);
 await page.locator('audio').evaluate(async audio=>{await audio.play();});
 await expect.poll(()=>page.locator('audio').evaluate(audio=>audio.currentTime)).toBeGreaterThan(0);
 assert.equal((await context.request.get(new URL(await page.locator('audio').getAttribute('src'),origin).href)).status(),200);
 assert.equal((await getCatalog()).entries.length,1);
 assert.equal((await getJobs()).length,1);assert.equal(fixture.counts.media,1,'reload plays stored bytes without another download');
 assert.equal(requests.filter(request=>request.path==='/api/v1/source-jobs'&&request.method==='POST').length,1);
 assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);
 await context.close();
 console.log('PASS one-click official episode import: real service/SQLite, two ingestion stages, one ready download, stored WAV playback and reload; no ASR/model/external requests.');
}finally{releaseMedia();await browser?.close();await server?.shutdown();await rm(directory,{recursive:true,force:true});}
