/** CI-only actual TXT downloads. Original authored fixtures; static loopback only.
 * A syntax check is not evidence that this browser journey passed. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from './helpers/browser-storage.mjs';
import {textExportFixture,originalText} from './helpers/text-export-fixture.mjs';
if(!process.env.CI)throw Error('Text export browser acceptance is CI-only.');
const root=new URL('../reader/',import.meta.url),checks=[];
let browser,server,stage='setup',external=0,mutations=0,errors=0;
function check(name,value){stage=name;assert.ok(value,name);checks.push(name);}
try{
 server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){mutations++;res.writeHead(405).end();return;}
  const pathname=new URL(req.url,'http://localhost').pathname,filename=pathname==='/'?'index.html':pathname.slice(1);
  if(!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(filename)){res.writeHead(404,{'Content-Type':'application/json'}).end('{"error":"static only"}');return;}
  try{const body=await fs.readFile(new URL(filename,root));res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.png')?'image/png':'text/html'}).end(body);}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
 for(const width of [1360,390]){
  const context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block',viewport:{width,height:900}});
  await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin===origin||['blob:','data:'].includes(u.protocol))await route.continue();else{external++;await route.abort();}});
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>errors++);
  async function choose(value){
   if(await page.locator('#add-content').isVisible())await page.locator('#add-content').click();
   const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#import').click()]);
   await chooser.setFiles({name:'authored.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
   await page.waitForFunction(title=>document.getElementById('title').textContent===title&&!document.getElementById('reader-workspace').hidden,value.title);
   await page.waitForFunction(()=>document.getElementById('file').value==='');
  }
  async function menu(){if(!await page.locator('#export-menu').evaluate(node=>node.open))await page.locator('#export-menu > summary').click();}
  async function download(id,label){
   await menu();const [item]=await Promise.all([page.waitForEvent('download'),page.locator(id).click()]);
   const stream=await item.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
   assert.equal(await item.failure(),null);const body=Buffer.concat(chunks);
   if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await fs.writeFile(path.join(process.env.COCONUT_UI_SCREENSHOTS,`text-export-${width}-${label}.txt`),body);}
   return {name:item.suggestedFilename(),text:body.toString('utf8')};
  }
  stage=width+'_import';await page.goto(origin);await page.locator('#import').waitFor({state:'visible'});
  const value=textExportFixture();value.translation_view='';await choose(value);
  await page.locator('#mode-transcript').click();await page.locator('#next-page').click();await page.locator('#search').fill('Unannotated full source 101');
  await page.waitForFunction(()=>document.querySelectorAll('.segment').length===1);
  const original=await download('#export-text','original');assert.equal(original.text,originalText);
  check(width+'_actual_whole_unannotated_txt_despite_page_and_filter',original.name==='Authored _ reading.txt'&&!original.text.includes('SECRET'));
  check(width+'_download_retains_disclosure_and_focus',await page.locator('#export-menu').evaluate(node=>node.open)&&await page.locator('#export-text').evaluate(node=>node===document.activeElement));
  await page.locator('#export-menu > summary').click();await page.locator('#mode-passages').click();await menu();
  check(width+'_automatic_passage_language_available',await page.locator('#text-bilingual').isEnabled()&&(await page.locator('#text-export-language').textContent()).includes('zh'));
  await page.locator('#text-bilingual').check();const bilingual=await download('#export-text','bilingual');
  check(width+'_actual_bilingual_current_and_gap_labels',bilingual.text.includes('人工修正 <译文>。')&&bilingual.text.includes('有效 1 段 · 缺失 103 段 · 过期 1 段')&&bilingual.text.includes('[译文已过期，未导出]')&&bilingual.text.includes('[暂无译文]')&&!bilingual.text.includes('SECRET'));
  check(width+'_export_panel_fits_viewport',await page.locator('.export-panel').evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}));
  if(process.env.COCONUT_UI_SCREENSHOTS)await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,`text-export-${width}.png`)});
  await page.locator('#export-menu > summary').click();await page.locator('#passage-toggle-translation').click();await menu();
  check(width+'_collapsed_translation_disables_and_clears_option',await page.locator('#text-bilingual').isDisabled()&&!await page.locator('#text-bilingual').isChecked());
  assert.equal((await download('#export-text','collapsed')).text,originalText);
  await page.locator('#export-menu > summary').click();await page.locator('#mode-bilingual').click();await menu();await page.locator('#text-bilingual').check();await page.locator('#export-menu > summary').click();await page.locator('#mode-summary').click();await menu();
  check(width+'_summary_has_no_displayed_translation',await page.locator('#text-bilingual').isDisabled()&&!await page.locator('#text-bilingual').isChecked()&&await page.locator('#export-text').isEnabled());
  await choose({key:'audio',title:'Authored audio only',project_kind:'audio_only',segments:[],local_media_source:{version:1,kind:'audio',name:'Original.wav',size:64,last_modified:7,type:'audio/wav',fingerprint:'a'.repeat(64)}});await menu();
  check(width+'_audio_only_disabled',await page.locator('#export-text').isDisabled()&&await page.locator('#text-bilingual').isDisabled());
  await context.close();
 }
 check('no_external_provider_calls_uploads_or_page_errors',external===0&&mutations===0&&errors===0);
 console.log(JSON.stringify({suite:'text-export',status:'passed',checks}));
}catch(error){console.error(JSON.stringify({suite:'text-export',status:'failed',stage,checks,error:error.message}));process.exitCode=1;}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
