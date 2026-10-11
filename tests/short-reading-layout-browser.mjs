/** CI Chromium only: authored short source, translations and tone audio. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect,waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {readFirstFixture} from './helpers/read-first-fixture.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
const root=fileURLToPath(new URL('../reader/',import.meta.url));
let server,browser,external=0,mutations=0;const errors=[],geometry=[],checks=[];
async function capture(page,label){if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,`short-reading-${label}.png`),fullPage:false,animations:'disabled'});}}
async function firstWords(page,selector,label){
 const proof=await page.locator(selector).first().evaluate(node=>{
  const range=document.createRange();range.selectNodeContents(node);
  const rects=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0);
  const readable=rects.filter(r=>r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth&&node.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)));
  return {top:node.getBoundingClientRect().top,height:node.getBoundingClientRect().height,lines:rects.length,readableLines:readable.length,readableHeight:readable.reduce((sum,r)=>sum+r.height,0),scrollY,viewport:innerHeight};
 });geometry.push({label,...proof});
 assert.ok(proof.top<520,`${label}: source must start in the upper reading area`);
 assert.ok(proof.lines>=2&&proof.height>0&&proof.readableLines>=2&&proof.readableHeight>=28,`${label}: at least two actual text lines must be fully visible and unobscured`);
 assert.ok(proof.scrollY<=1,`${label}: initial import evidence must remain at the natural top-of-page landing`);
}
async function persisted(page,predicate,arg){await waitForPersistedLibrary(page,predicate,arg);}
try{
 server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){mutations++;res.writeHead(405).end();return;}
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  if(!/^[a-z-]+\.(html|js|css|png)$/.test(name)){res.writeHead(404).end();return;}
  try{const bytes=await fs.readFile(path.join(root,name));res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'});res.end(bytes);}catch{res.writeHead(404).end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 for(const width of [320,390])for(const bilingual of [false,true]){
  const label=`${width}-${bilingual?'bilingual':'source'}`,context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['blob:','data:'].includes(url.protocol))return route.continue();external++;return route.abort();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);await page.goto(origin);
  const doc=readFirstFixture(3,{demo:bilingual});delete doc.provenance;
  doc.title='自写短稿：先读原话，再留下自己的判断。完整长标题仍可从信息与设置查看。';doc.source_url='https://www.youtube.com/watch?v=authored1234';
  for(const [i,cue] of doc.segments.entries()){cue.speaker=i===0?'Mina':'Leo';if(bilingual)cue.translations.zh.text='先读原话，再留下自己的判断。这是完整保留的自写译文，可以与原文一起阅读。';}
  await page.locator('#file').setInputFiles({name:'authored-short.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});
  await expect(page.locator('#title')).toHaveText(doc.title);await persisted(page,async title=>(await readPersistedLibrary()).documents.some(d=>d.title===title),doc.title);
  // No extra scrolling, resizing, dismissing feedback or changing layout before
  // this first-use proof: measure the actual import landing with its toast.
  await firstWords(page,'.segment .words',label+'-first-original');if(bilingual)await firstWords(page,'.segment .translation',label+'-first-translation');await capture(page,label+'-first-import');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await expect(page.locator('.passage-toolbar')).toBeHidden();await expect(page.locator('#transcript-tools-disclosure')).not.toHaveAttribute('open','');
  await page.locator('#reading-info > summary').click();await expect(page.locator('#reading-info-title')).toHaveText(doc.title);await expect(page.locator('#subtitle')).toBeVisible();await expect(page.locator('#document-details')).toBeVisible();
  await page.locator('#source').click();await expect(page.locator('#source-url')).toHaveValue(doc.source_url);await page.locator('#source-dialog button[value="cancel"]').click();if(await page.locator('#reading-info').evaluate(n=>n.open))await page.locator('#close-reading-info').click();
  await page.locator('#transcript .segment').first().focus();await page.keyboard.press('Control+f');await expect(page.locator('#search')).toBeFocused();await page.locator('#search').fill('observation 2');await expect(page.locator('#transcript .segment')).toHaveCount(1);
  await page.locator('#transcript-tools-label').click();await expect(page.locator('#transcript-tools-label')).toContainText('observation 2');
  await page.locator('#transcript .segment').first().focus();await page.keyboard.press('/');await expect(page.locator('#search')).toBeFocused();await page.locator('#clear-search').click();
  await page.locator('#speaker-filter').selectOption(JSON.stringify('Mina'));await expect(page.locator('#transcript .segment')).toHaveCount(1);await expect(page.locator('#transcript-tools-label')).toContainText('Mina');await page.locator('#clear-search').click();
  await page.locator('#search').fill('Authored');await page.locator('#search').evaluate(node=>{node.setSelectionRange(1,5);window.shortSearchNode=node;window.shortSearchParent=node.parentElement;window.shortSearchBlurs=0;node.addEventListener('blur',()=>window.shortSearchBlurs++);});
  for(const nextWidth of [1360,width]){await page.setViewportSize({width:nextWidth,height:900});assert.deepEqual(await page.locator('#search').evaluate(node=>({same:node===window.shortSearchNode&&node.parentElement===window.shortSearchParent,focus:document.activeElement===node,start:node.selectionStart,end:node.selectionEnd,blurs:window.shortSearchBlurs})),{same:true,focus:true,start:1,end:5,blurs:0});}
  await page.locator('#clear-search').click();await page.locator('#transcript-tools-label').click();
  await page.locator('#reading-info > summary').click();await page.locator('#reading-time').fill('00:05');
  await page.locator('#reading-time').evaluate(node=>{node.setSelectionRange(1,4);window.shortSettingsBlurs=0;node.addEventListener('blur',()=>window.shortSettingsBlurs++);});
  await page.setViewportSize({width:1360,height:900});
  assert.deepEqual(await page.locator('#reading-time').evaluate(node=>({focus:document.activeElement===node,start:node.selectionStart,end:node.selectionEnd,blurs:window.shortSettingsBlurs,parent:document.getElementById('reading-settings').parentElement.id,visible:!document.getElementById('reading-info').hidden&&document.getElementById('reading-info').open})),{focus:true,start:1,end:4,blurs:0,parent:'reading-info-settings',visible:true});
  await page.locator('#transcript .segment').first().focus();await expect(page.locator('body')).toHaveAttribute('data-header-compact','false');
  if(!await page.locator('#reading-settings').evaluate(n=>n.open))await page.locator('#reading-settings > summary').click();
  await page.locator('#reading-time').focus();await page.locator('#reading-time').evaluate(node=>{node.setSelectionRange(1,4);window.shortSettingsBlurs=0;});
  await page.setViewportSize({width,height:900});
  assert.deepEqual(await page.locator('#reading-time').evaluate(node=>({focus:document.activeElement===node,start:node.selectionStart,end:node.selectionEnd,blurs:window.shortSettingsBlurs,parent:document.getElementById('reading-settings').parentElement.id})),{focus:true,start:1,end:4,blurs:0,parent:'reader-options'});
  await page.locator('#time-navigation button').focus();assert.equal(await page.locator('#reading-settings').evaluate(n=>n.parentElement.id),'reader-options');
  await page.locator('#transcript .segment').first().focus();await expect(page.locator('body')).toHaveAttribute('data-header-compact','true');
  const row=page.locator('.segment[data-segment-id="read-0"]');await row.locator('.note-button').click();await expect(page.locator('#note')).toBeFocused();await page.locator('#note').fill('A retained authored note');await page.locator('#return-excerpt').click();await expect(row).toBeFocused();
  await row.locator('.bookmark-button').click();await expect(row.locator('.bookmark-button')).toBeFocused();await row.locator('.excerpt-button').click();
  await row.locator('.edit-button').click();await page.locator('#edit-segment').fill(doc.segments[0].text+' A verified edit.');await page.locator('#save-edit').click();await expect(row.locator('.edit-button')).toBeFocused();
  await persisted(page,async title=>{const d=(await readPersistedLibrary()).documents.find(d=>d.title===title);return d?.notes['read-0']==='A retained authored note'&&d.readingPosition==='read-0'&&d.segments[0].saved_excerpt&&d.segments[0].text.endsWith('A verified edit.');},doc.title);
  await page.locator('#transcript-tools-label').click();await page.locator('#filter-notes').click();await expect(page.locator('#transcript .segment')).toHaveCount(1);await expect(page.locator('#transcript-tools-label')).toContainText('仅笔记');await page.locator('#filter-all').click();await page.locator('#filter-excerpts').click();await expect(page.locator('#transcript .segment')).toHaveCount(1);await expect(page.locator('#transcript-tools-label')).toContainText('仅摘录');await page.locator('#clear-search').click();await page.locator('#transcript-tools-label').click();
  await page.locator('#toggle-reader-media').click();const [mediaChooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);await mediaChooser.setFiles({name:'authored.wav',mimeType:'audio/wav',buffer:authoredAudioFixture(20)});await expect(page.locator('#source-media audio')).toBeVisible();
  assert.equal(await page.locator('#source-media audio').evaluate(p=>p.paused),true);assert.equal(await page.locator('#episode-media').evaluate(n=>getComputedStyle(n).position==='absolute'),false);
  await page.locator('#reading-info > summary').click();await expect(page.locator('#source-media audio')).toBeVisible();assert.equal(await page.locator('#source-media audio').evaluate(p=>p.paused),true);await page.locator('#close-reading-info').click();await page.locator('#close-reader-media').click();
  await page.evaluate(()=>failContentWrites());await row.locator('.note-button').click();await page.locator('#note').fill('Recover this authored failed note');await expect(page.locator('#save-status')).toHaveAttribute('data-state','failed');await expect(page.locator('#retry-save')).toBeVisible();await expect(page.locator('#export-unsaved-documents')).toBeVisible();await capture(page,label+'-save-failure');
  await page.evaluate(()=>restoreContentWrites());await page.locator('#retry-save').click();await expect(page.locator('#save-status')).toHaveAttribute('data-state','saved');await page.locator('#return-excerpt').click();await page.reload();await expect(page.locator('#reading-info')).toBeVisible();
  checks.push(label+':first-viewport/full-title/source/settings/search/filter/resize/edit/bookmark/media/failure/reload');await context.close();
 }
 assert.deepEqual(errors,[]);assert.equal(external,0);assert.equal(mutations,0);console.log(JSON.stringify({suite:'short-reading-layout',checks,geometry,external,mutations,errors}));
}finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
