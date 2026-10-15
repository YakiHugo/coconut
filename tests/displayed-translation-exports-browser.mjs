// Compatibility renderer regression; this suite is not default React acceptance.
/** GitHub Actions-only native file import and actual SRT/VTT/Markdown downloads.
 * Authored local prose, production IndexedDB and real keyboard/checkbox actions.
 * No model, provider, upload, storage injection, Electron or user browser. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import C from '../reader/core.js';
import {chromium,expect,waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {displayedTranslationExportsFixture as fixture} from './helpers/displayed-translation-exports-fixture.mjs';
if(process.env.GITHUB_ACTIONS!=='true')throw Error('Run displayed translation exports in GitHub Actions only; use node --check locally.');
const root=new URL('../reader/',import.meta.url),checks=[],geometry=[],errors=[];
let browser,server,page,stage='setup',external=0,mutations=0;
function check(name,value){assert.ok(value,name);checks.push(name);}
async function capture(label){if(!process.env.COCONUT_UI_SCREENSHOTS)return;await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'displayed-exports-'+label+'.png'),animations:'disabled'});}
async function menu(open=true){if(await page.locator('#export-menu').evaluate(node=>node.open)!==open)await page.locator('#export-menu > summary').click();}
async function importDocument(doc){
 await menu(false);if(await page.locator('#add-content').isVisible())await page.locator('#add-content').click();
 const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#import').click()]);
 await chooser.setFiles({name:'authored-export.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});
 await expect(page.locator('#title')).toHaveText(doc.title);await page.waitForFunction(()=>document.getElementById('file').value==='');
 await waitForPersistedLibrary(page,async title=>(await readPersistedLibrary()).documents.some(doc=>doc.title===title),doc.title);
}
async function download(id,label,extension){
 await menu();const [item]=await Promise.all([page.waitForEvent('download'),page.locator(id).click()]);
 const stream=await item.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
 assert.equal(await item.failure(),null);assert.ok(item.suggestedFilename().endsWith(extension));const data=Buffer.concat(chunks);
 if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'displayed-exports-'+label+extension),data);}
 return data.toString('utf8');
}
async function keyboardTarget(id,label){
 await menu(false);await menu();const target=page.locator(id);
 for(let i=0;i<30&&!await target.evaluate(node=>node===document.activeElement);i++)await page.keyboard.press('Tab');
 await expect(target).toBeFocused();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const m=await target.evaluate(node=>{
  const r=node.getBoundingClientRect(),style=getComputedStyle(node),ring=parseFloat(style.outlineWidth)+Math.max(0,parseFloat(style.outlineOffset)),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;
  const points=[[x,y],[r.left+1,y],[r.right-1,y],[x,r.top+1],[x,r.bottom-1]].map(([x,y])=>{const hit=document.elementFromPoint(x,y);return {x,y,clear:hit===node||node.contains(hit)};});
  const clips=[];for(let ancestor=node.parentElement;ancestor&&ancestor!==document.body;ancestor=ancestor.parentElement){const s=getComputedStyle(ancestor),b=ancestor.getBoundingClientRect(),clipX=/auto|scroll|hidden|clip/.test(s.overflowX),clipY=/auto|scroll|hidden|clip/.test(s.overflowY);if(clipX||clipY)clips.push({clipX,clipY,left:b.left+ancestor.clientLeft,top:b.top+ancestor.clientTop,right:b.left+ancestor.clientLeft+ancestor.clientWidth,bottom:b.top+ancestor.clientTop+ancestor.clientHeight});}
  const overlays=['notice-shell','reading-feedback','passage-playback-controls','media-dock'].flatMap(id=>{const n=document.getElementById(id);if(!n)return [];const b=n.getBoundingClientRect(),s=getComputedStyle(n);return [{r:b.toJSON(),visible:!n.hidden&&s.display!=='none'&&s.visibility!=='hidden'&&b.width>0&&b.height>0}];});
  return {r:r.toJSON(),ring,outline:style.outlineStyle,focus:node===document.activeElement&&node.matches(':focus-visible'),points,clips,overlays,width:innerWidth,height:innerHeight};
 });
 geometry.push({label,...m});console.log(JSON.stringify({suite:'displayed-exports-geometry',label,...m}));
 const r=m.r,ring=m.ring,clear=m.focus&&m.outline!=='none'&&ring>=6&&r.width>=44&&r.height>=44&&r.left-ring>=0&&r.top-ring>=0&&r.right+ring<=m.width&&r.bottom+ring<=m.height&&m.points.every(p=>p.clear)&&m.clips.every(c=>(!c.clipX||r.left-ring>=c.left&&r.right+ring<=c.right)&&(!c.clipY||r.top-ring>=c.top&&r.bottom+ring<=c.bottom))&&m.overlays.every(o=>!o.visible||o.r.right<=r.left-ring||o.r.left>=r.right+ring||o.r.top>=r.bottom+ring||o.r.bottom<=r.top-ring);
 if(!clear)await capture(label+'-geometry-failed');check(label+'_44px_full_six_pixel_ring_five_hits_and_overlays',clear);
}
async function switchMode(id){await menu(false);await page.locator(id).click();}
async function originalExports(width,label,doc){
 await menu();check(width+'_'+label+'_option_disabled_and_cleared',await page.locator('#subtitle-bilingual').isDisabled()&&!await page.locator('#subtitle-bilingual').isChecked());
 for(const format of ['srt','vtt']){await page.locator('#subtitle-format').selectOption(format);assert.equal(await download('#export-subtitles',width+'-'+label,'.'+format),C.subtitleExport(doc,format).text);}
 assert.equal(await download('#export-notebook',width+'-'+label,'.notes.md'),C.notebookMarkdown(doc,''));
}
try{
 server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){mutations++;res.writeHead(405).end();return;}
  const pathname=new URL(req.url,'http://localhost').pathname,file=pathname==='/'?'compatibility.html':pathname.slice(1);
  if(!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(file)){res.writeHead(404,{'Content-Type':'application/json'}).end('{"error":"static only"}');return;}
  try{const body=await fs.readFile(new URL(file,root));res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/html'}).end(body);}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
 for(const width of [1360,390]){
  const context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block',viewport:{width,height:900}});
  await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin===origin||['blob:','data:'].includes(u.protocol))await route.continue();else{external++;await route.abort();}});
  page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  stage=width+'_import';await page.goto(origin);const value=fixture();await importDocument(value);
  const before=await download('#export',width+'-before','.json'),doc=JSON.parse(before);
  assert.equal(doc.translation_view,'');await menu(false);await expect(page.locator('.passage-translation').first()).toContainText('中文译文 0');
  await menu();check(width+'_fallback_label_and_original_default',await page.locator('#subtitle-bilingual').isEnabled()&&!await page.locator('#subtitle-bilingual').isChecked()&&(await page.locator('#subtitle-bilingual-label').textContent()).includes('中文（zh）'));
  assert.equal(await download('#export-subtitles',width+'-default','.srt'),C.subtitleExport(doc).text);
  stage=width+'_fallback_keyboard_downloads';await keyboardTarget('#subtitle-bilingual',width+'-fallback-checkbox');await page.keyboard.press('Space');
  await keyboardTarget('#export-subtitles',width+'-subtitle-button');
  for(const format of ['srt','vtt']){
   await page.locator('#subtitle-format').selectOption(format);const actual=await download('#export-subtitles',width+'-fallback','.'+format);
   assert.equal(actual,C.subtitleExport(doc,format,true,'zh').text);check(width+'_'+format+'_fallback_complete_current_only',actual.includes('中文译文 111')&&!/SECRET|française/.test(actual)&&(actual.match(/ --> /g)||[]).length===112);
  }
  await keyboardTarget('#export-notebook',width+'-notebook-button');const markdown=await download('#export-notebook',width+'-fallback','.notes.md');assert.equal(markdown,C.notebookMarkdown(doc,'zh'));check(width+'_notebook_annotations_across_pages_only',markdown.includes('中文译文 111')&&!/Authored source 50|SECRET|française/.test(markdown));
  assert.equal(await download('#export',width+'-after','.json'),before);check(width+'_exports_never_mutate_json_or_history',true);await capture(width+'-fallback');
  stage=width+'_collapsed';await switchMode('#passage-toggle-translation');await originalExports(width,'collapsed',doc);
  await switchMode('#passage-toggle-translation');await menu();check(width+'_reexpansion_does_not_recheck',!await page.locator('#subtitle-bilingual').isChecked());await page.locator('#subtitle-bilingual').check();
  await switchMode('#mode-summary');await originalExports(width,'summary',doc);
  stage=width+'_explicit_french';await switchMode('#mode-bilingual');
  // Use the visible reader-owned native select, with the AI workflow closed.
  await expect(page.locator('#ai-task')).toHaveValue('question');
  await expect(page.locator('#translation-view')).toBeVisible();await expect(page.locator('#translation-view')).toBeEnabled();
  await page.locator('#translation-view').click();await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await expect(page.locator('#transcript .translation').first()).toContainText('Traduction française 0');
  check(width+'_explicit_language_selected_through_visible_reading_toolbar',await page.locator('#translation-view').inputValue()==='fr');
  check(width+'_AI_disclosures_remain_closed',await page.locator('#language-panel').evaluate(node=>!node.open)&&await page.locator('#translation-options').evaluate(node=>!node.open));
  await waitForPersistedLibrary(page,async()=> (await readPersistedLibrary()).documents[0].translation_view==='fr');
  await page.locator('#next-page').click();await page.locator('#search').fill('Authored source 111');await expect(page.locator('#transcript .segment')).toHaveCount(1);
  await menu();check(width+'_explicit_language_clears_stale_choice',!await page.locator('#subtitle-bilingual').isChecked()&&(await page.locator('#subtitle-bilingual-label').textContent()).includes('法文（fr）'));await page.locator('#subtitle-bilingual').check();
  for(const format of ['srt','vtt']){await page.locator('#subtitle-format').selectOption(format);assert.equal(await download('#export-subtitles',width+'-explicit-fr','.'+format),C.subtitleExport(doc,format,true,'fr').text);}
  assert.equal(await download('#export-notebook',width+'-explicit-fr','.notes.md'),C.notebookMarkdown(doc,'fr'));check(width+'_explicit_french_exports_ignore_filter_and_page',true);
  await switchMode('#mode-transcript');await originalExports(width,'original',doc);
  stage=width+'_document_change';await switchMode('#mode-bilingual');await menu();await page.locator('#subtitle-bilingual').check();
  const companion=fixture({key:'other',title:'Authored companion '+width,language:'fr'});companion.segments[0].text='Distinct authored companion source.';for(const item of Object.values(companion.segments[0].translations))item.source_text=companion.segments[0].text;await importDocument(companion);await menu();check(width+'_new_document_own_language_and_unchecked',!await page.locator('#subtitle-bilingual').isChecked()&&(await page.locator('#subtitle-bilingual-label').textContent()).includes('法文（fr）'));
  await page.locator('#subtitle-format').selectOption('srt');assert.equal(await download('#export-subtitles',width+'-companion-default','.srt'),C.subtitleExport(companion).text);await page.locator('#subtitle-bilingual').check();assert.equal(await download('#export-subtitles',width+'-companion-checked','.srt'),C.subtitleExport(companion,'srt',true,'fr').text);
  const missing=fixture({key:'none',title:'Authored unavailable '+width});for(const cue of missing.segments){delete cue.translations.fr;if(cue.translations.zh)cue.translations.zh.source_text='Earlier source';}
  missing.segments[0].text='Distinct authored unavailable source.';await importDocument(missing);await originalExports(width,'only-stale',missing);
  await context.close();
 }
 check('no_external_requests_uploads_or_page_errors',external===0&&mutations===0&&errors.length===0);console.log(JSON.stringify({suite:'displayed-translation-exports',status:'passed',checks,geometryCount:geometry.length}));
}catch(error){await capture(stage+'-failure').catch(()=>{});console.error(JSON.stringify({suite:'displayed-translation-exports',status:'failed',stage,checks,error:error.message,errors}));process.exitCode=1;}
finally{
 if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,'displayed-exports-checks.json'),JSON.stringify({suite:'displayed-translation-exports',status:process.exitCode?'failed':'passed',stage,checks,geometry,errors,external,mutations},null,2));}
 await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
}
