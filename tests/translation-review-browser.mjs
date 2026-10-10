/** Authored-only Chromium acceptance, for CI. No model or media requests. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from './helpers/browser-storage.mjs';
import {translationReviewFixture} from './helpers/translation-review-fixture.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
let server,browser,stage='setup';const checks=[];
function check(name,passed){stage=name;assert.ok(passed,name);checks.push(name);}
try{
 server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  if(!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(name)){res.writeHead(404).end();return;}
  try{const bytes=await fs.readFile(path.join(root,'reader',name));res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'}).end(bytes);}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({acceptDownloads:true,viewport:{width:1280,height:900},serviceWorkers:'block'});
 let external=0,mutations=0,errors=0;
 await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(!['GET','HEAD'].includes(req.method())){mutations++;await route.abort();return;}if(url.origin===origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>errors++);
 await page.goto(origin);await page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready');const doc=translationReviewFixture();
 await page.locator('#file').setInputFiles({name:'authored-review.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});
 await page.locator('#mode-bilingual').click();
 async function queue(){
  if(!await page.locator('#review-translations').isVisible()){
   // Passage reading nests settings in Information and Settings; its inner
   // settings summary is intentionally hidden. Use the same visible entry as a reader.
   const information=page.locator('#reading-info > summary');
   await (await information.isVisible()?information:page.locator('#reading-settings > summary')).click();
  }
  await page.locator('#review-translations').click();await page.locator('#translation-queue-dialog').waitFor({state:'visible'});
 }
 await queue();
 check('whole_document_queue_separates_missing_stale_and_quality',/1 段过期.*1 段质量提示.*1 段未保存/.test(await page.locator('#translation-queue-summary').textContent()));
 await page.locator('#translation-queue-language').selectOption('ja');check('target_language_is_exact',await page.locator('.translation-queue-open').count()===1&&await page.locator('.translation-queue-open').getAttribute('data-segment-id')==='review-2');
 await page.locator('#translation-queue-language').selectOption('zh');await page.locator('.translation-queue-open[data-segment-id="review-102"]').click();
 check('late_cue_has_full_original_old_basis_and_translation',await page.locator('#translation-edit-source').textContent()===doc.segments[102].text&&await page.locator('#translation-edit-previous-source').textContent()==='Old authored source.'&&await page.locator('#translation-edit-text').inputValue()===doc.segments[102].translations.zh.text);
 check('editor_returns_to_actual_bilingual_late_cue',await page.locator('.segment[data-segment-id="review-102"]').count()===1&&await page.locator('#transcript-layout').evaluate(el=>!el.hidden&&el.classList.contains('is-bilingual')));
 const corrected='  人工修正 <img>\n103 个苹果。  ';await page.locator('#translation-edit-text').fill(corrected);
 page.once('dialog',dialog=>dialog.dismiss());await page.locator('#translation-edit-cancel').click();
 check('declining_discard_keeps_exact_draft',await page.locator('#translation-edit-text').inputValue()===corrected&&await page.locator('#translation-edit-dialog').isVisible());
 await page.locator('#save-translation-edit').click();await page.locator('#translation-queue-dialog').waitFor({state:'visible'});
 check('human_save_removes_only_reviewed_stale_entry',await page.locator('.translation-queue-open[data-segment-id="review-102"]').count()===0&&await page.locator('.translation-queue-open[data-segment-id="review-1"]').count()===1);
 await page.locator('#translation-queue-close').click();
 async function download(button){if(!await page.locator(button).isVisible())await page.locator('#export-menu > summary').click();const pending=page.waitForEvent('download');await page.locator(button).click();const file=await pending;return fs.readFile(await file.path(),'utf8');}
 const json=JSON.parse(await download('#export')),item=json.segments[102].translations.zh;
 check('actual_json_download_preserves_exact_text_and_bounded_history',item.text===corrected&&item.original_translation.text===doc.segments[102].translations.zh.text&&item.original_translation.manual_review===undefined&&item.manual_review.cues.some(c=>c.id==='review-102'&&c.text===doc.segments[102].text));
 await page.locator('#subtitle-format').selectOption('vtt');await page.locator('#subtitle-bilingual').check();const vtt=await download('#export-subtitles');check('actual_vtt_download_contains_current_human_translation',vtt.startsWith('WEBVTT')&&vtt.includes('人工修正 &lt;img&gt;')&&vtt.includes('00:06:48.000 --> 00:06:51.000'));
 const markdown=await download('#export-notebook');check('actual_markdown_download_identifies_human_provenance',markdown.includes('用户人工核对／修正')&&markdown.includes('人工修正 &lt;img&gt;')&&!markdown.includes('机器生成'));
 await page.reload();await page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready');await page.locator('#mode-bilingual').click();await queue();
 check('reload_keeps_saved_review_out_of_queue',await page.locator('.translation-queue-open[data-segment-id="review-102"]').count()===0);
 await page.locator('.translation-queue-open[data-segment-id="review-1"]').click();check('unchanged_review_requires_explicit_current_source_confirmation',(await page.locator('#save-translation-edit').textContent()).includes('确认已核对当前原文'));
 await page.locator('#save-translation-edit').click();check('no_unnecessary_warning_entries_remain',await page.locator('.translation-queue-open').count()===0);await page.locator('#translation-queue-close').click();
 if(!await page.locator('#reading-time').isVisible())await page.locator('#reading-settings > summary').click();await page.locator('#reading-time').fill('06:48');await page.locator('#time-navigation button').click();
 const late=page.locator('.segment[data-segment-id="review-102"]');if(!await late.locator('.edit-button').isVisible())await late.locator('.cue-more > summary').click();await late.locator('.edit-button').click();await page.locator('#edit-segment').fill(doc.segments[102].text+' The source changed.');await page.locator('#save-edit').click();
 await queue();check('later_source_edit_requeues_old_human_confirmation',await page.locator('.translation-queue-open[data-segment-id="review-102"]').count()===1);
 await page.setViewportSize({width:390,height:844});await page.locator('.translation-queue-open[data-segment-id="review-102"]').click();
 check('mobile_editor_fits_without_horizontal_overflow',await page.locator('#translation-edit-dialog').evaluate(el=>el.getBoundingClientRect().left>=0&&el.getBoundingClientRect().right<=innerWidth&&el.scrollWidth<=el.clientWidth));
 check('old_review_basis_is_not_silently_promoted',await page.locator('#translation-edit-previous-source').textContent()===doc.segments[102].text&&(await page.locator('#translation-edit-source').textContent()).includes('source changed'));
 await page.locator('#translation-edit-cancel').click();await page.locator('#translation-queue-close').click();
 const staleVtt=await download('#export-subtitles');check('stale_human_translation_is_excluded_from_later_vtt',!staleVtt.includes('人工修正'));
 // Dialog opening and saving replace cue DOM; native dialog focus restoration
 // cannot use the original detached button. Cover actual keyboard focus on both widths.
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:844});
  for(const cueId of ['review-102','review-104'])for(const action of ['cancel','escape','save']){
   await page.locator('#reading-settings').evaluate(el=>el.open=false);
   const cue=page.locator(`.segment[data-segment-id="${cueId}"]`),button=cue.locator('.review-translation-button');
   if(!await button.isVisible())await cue.locator('.cue-more > summary').click();
   const opener=await button.elementHandle();await button.click();
   check(`direct_${width}_${cueId}_${action}_opener_was_replaced`,!await opener.evaluate(el=>el.isConnected));
   // Exercise the closed-menu case while the modal owns input.
   if(await cue.locator('.cue-more').count())await cue.locator('.cue-more').evaluate(el=>el.open=false);
   if(action==='save')await page.locator('#translation-edit-text').fill(`Human focus check ${width} ${cueId}`);
   if(action==='escape')await page.keyboard.press('Escape');
   else await page.locator(action==='save'?'#save-translation-edit':'#translation-edit-cancel').click();
   check(`direct_${width}_${cueId}_${action}_focus_returns_to_visible_exact_cue`,await button.isVisible()&&await button.evaluate(el=>document.activeElement===el&&(!el.closest('.cue-more')||el.closest('.cue-more').open))&&!await page.locator('#reading-settings').evaluate(el=>el.open));
   await opener.dispose();
  }
 }
 await page.locator('.segment[data-segment-id="review-104"] .review-translation-button').click();
 await page.locator('#search').evaluate(el=>{el.value='No matching source after editor opened';el.dispatchEvent(new Event('input',{bubbles:true}));});
 await page.locator('#translation-edit-cancel').click();
 check('missing_cue_focus_uses_visible_settings_without_discarding_newer_filter',await page.locator('#review-translations').isVisible()&&await page.locator('#review-translations').evaluate(el=>document.activeElement===el)&&await page.locator('.segment').count()===0&&await page.locator('#search').inputValue()==='No matching source after editor opened');
 await page.locator('#clear-search').click();
 const longDoc=translationReviewFixture(70);longDoc.title='Authored long review context';longDoc.translation_contexts={};
 const cue=i=>{const s=longDoc.segments[i];return {id:s.id,position:i,text:s.text,start:s.start,end:s.end,speaker:s.speaker};};
 for(let i=1;i<longDoc.segments.length;i++){
  const item=longDoc.segments[i].translations.zh,contextId=String(i).padStart(8,'0')+'-0000-0000-0000-000000000000';
  delete item.quality_warnings;item.context_id=contextId;
  longDoc.translation_contexts[contextId]=i===1?[cue(i)]:[{...cue(i-1),memory_language:'zh',memory_text:longDoc.segments[i-1].translations.zh.text},cue(i)];
 }
 longDoc.segments[69].translations.zh.source_text='Earlier authored source';
 await page.locator('#file').setInputFiles({name:'authored-long-review.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(longDoc))});
 await page.locator('#title').filter({hasText:longDoc.title}).waitFor({state:'visible'});
 check('long_import_starts_in_passages_with_visible_information_entry',await page.locator('#passage-workspace').isVisible()&&await page.locator('#reading-info > summary').isVisible()&&!await page.locator('#reading-settings > summary').isVisible());
 await queue();
 check('passage_queue_opens_through_visible_settings_without_changing_reading_mode',await page.locator('#passage-workspace').isVisible()&&await page.locator('#reading-info').evaluate(el=>el.open));
 await page.locator('.translation-queue-open[data-segment-id="review-69"]').click();
 await page.locator('#translation-edit-dialog details > summary').first().click();
 check('long_context_has_bounded_first_page',await page.locator('#translation-edit-context > p').count()===30&&await page.locator('#translation-edit-context-position').textContent()==='1–30 / 68 条上下文');
 await page.locator('#translation-edit-text').fill('Long context human correction');
 await page.locator('#translation-edit-context-next').click();await page.locator('#translation-edit-context-next').click();
 check('long_context_pages_keep_draft_and_mobile_width',await page.locator('#translation-edit-context > p').count()===8&&await page.locator('#translation-edit-text').inputValue()==='Long context human correction'&&await page.locator('#translation-edit-dialog').evaluate(el=>el.getBoundingClientRect().left>=0&&el.getBoundingClientRect().right<=innerWidth&&el.scrollWidth<=el.clientWidth));
 await page.locator('#save-translation-edit').click();await page.locator('#translation-queue-close').click();
 const longJson=JSON.parse(await download('#export'));
 check('long_context_download_keeps_every_dependency',longJson.segments[69].translations.zh.manual_review.cues.length===69&&longJson.segments[69].translations.zh.manual_review.cues[0].id==='review-1');
 check('no_model_mutations_external_requests_or_script_errors',mutations===0&&external===0&&errors===0);
 console.log(JSON.stringify({checks},null,2));
}catch(error){console.error('Translation review acceptance failed at '+stage);throw error;}
finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
