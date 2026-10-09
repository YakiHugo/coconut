/** Real Chromium recovery through the production UI and local HTTP bridge.
 * Sources and provider responses are authored fixtures. No real CLI/model call,
 * media, real transcript, browser trace, or storage dump is produced as an artifact.
 * This file is executed by browser CI, not by the native DOM regression suite. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';

const title='阅读核对练习 · 自写流程样例';
const source={title,language:'en',notes:{'cue-0':'PRIVATE READER NOTE'},segments:Array.from({length:65},(_,i)=>({id:'cue-'+i,start:i*4,end:i*4+4,text:`Observation ${i+1}: verify an original statement before accepting the interpretation.`}))};
const other={title:'另一篇阅读材料 · 自写流程样例',language:'en',segments:[{id:'different',start:0,end:4,text:'This is a separate authored source, without translations.'}]};
const checks=[],requests=[];
const check=(name,value)=>{stage=name;assert.ok(value,name);checks.push(name);};
let server,browser,stage='setup',release,started,holdNext=true,failNext=false;
const waitStarted=()=>new Promise(resolve=>{started=resolve;});
async function boundedStart(promise){let timer;try{await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Injected request did not start within 15 seconds')),15000);})]);}finally{clearTimeout(timer);}}
const providers={
 status:async()=>({ready:true,reason:'Injected lifecycle fixture; no real model'}),
 exclusive:async action=>action(),
 ask:async()=>{throw new Error('No summary or question is authorized in this translation fixture');},
 structured:async(_provider,payload)=>{
  const data=JSON.parse(payload);requests.push(data);
  if(holdNext){holdNext=false;await new Promise(resolve=>{release=resolve;started?.();});release=null;}
  if(failNext){failNext=false;throw new Error('Injected final-batch network rejection');}
  return {translations:data.target_ids.map(id=>({id,text:'这是预置的流程测试译文，请对照原句核查。'}))};
 }
};
try{
 server=await startBridge({port:0,providers});const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});let external=0,errors=0;
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin||url.protocol==='blob:')await route.continue();else{external++;await route.abort();}});
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>errors++);await page.goto(origin);
 const importFixture=async doc=>page.locator('#file').setInputFiles({name:'authored-recovery.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});
 const readDocument=async name=>page.evaluate(title=>JSON.parse(localStorage.getItem('coconut-reader-v1')).documents.find(doc=>doc.title===title),name);
 const translatedCount=doc=>doc.segments.filter(cue=>cue.translations?.zh).length;
 const openLanguage=async()=>{await page.locator('#mode-transcript').click();if(!await page.locator('#language-panel').evaluate(node=>node.open))await page.locator('#language-panel > summary').click();await page.locator('#ai-task').selectOption('translation');};
 const settled=()=>page.waitForFunction(()=>document.querySelector('#stop-subscription-translation').hidden);
 const screenshot=async name=>{
  if(!process.env.COCONUT_UI_SCREENSHOTS)return;
  await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});
  await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,name+'.png'),fullPage:false});
 };
 await importFixture(source);await openLanguage();await page.locator('#check-ai').click();
 stage='close_and_reopen_in_flight';let firstStarted=waitStarted();await page.locator('#ai-consent').check();await page.locator('#subscription-translate').click();await boundedStart(firstStarted);
 await page.locator('#language-panel > summary').click();await page.locator('#language-panel > summary').click();await page.locator('#ai-consent').check();release();await settled();
 let saved=await readDocument(title);check('collapse_reopen_never_revives_old_plan',requests.length===1&&translatedCount(saved)===32&&!(await page.locator('#ai-consent').isChecked()));
 check('pending_batch_keeps_private_note_local',saved.notes['cue-0']==='PRIVATE READER NOTE'&&!JSON.stringify(requests).includes('PRIVATE READER NOTE'));
 await page.locator('#ai-progress').scrollIntoViewIfNeeded();check('mobile_recovery_fits_viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await screenshot('ai-recovery-mobile-stopped');
 const firstBatch=structuredClone(saved.segments.slice(0,32));
 stage='switch_document_during_retry';holdNext=true;const secondStarted=waitStarted();await page.locator('#ai-consent').check();await page.locator('#subscription-translate').click();await boundedStart(secondStarted);
 await importFixture(other);await openLanguage();await page.locator('#ai-consent').check();
 check('other_document_explains_pending_original',await page.locator('#ask-ai').isDisabled()&&(await page.locator('#ai-progress').textContent()).includes(title));
 release();await settled();saved=await readDocument(title);
 check('old_response_writes_only_original_document',requests.length===2&&translatedCount(saved)===64&&translatedCount(await readDocument(other.title))===0);
 check('old_status_is_not_new_document_success',!(await page.locator('#ai-progress').textContent()).includes('保存 32'));
 stage='return_to_original_document';
 if(await page.locator('#toggle-library').isVisible()&&await page.locator('#toggle-library').getAttribute('aria-expanded')==='false')await page.locator('#toggle-library').click();
 await page.locator('#library button').filter({hasText:title}).click();await openLanguage();
 stage='last_batch_failure';failNext=true;await page.locator('#ai-consent').check();await page.locator('#subscription-translate').click();await page.waitForFunction(()=>document.querySelector('#ai-progress').textContent.includes('Injected final-batch network rejection'));await settled();
 check('failure_unlocks_manual_retry_without_losing_results',requests.length===3&&translatedCount(await readDocument(title))===64&&!(await page.locator('#subscription-translate').isDisabled())&&!(await page.locator('#ai-consent').isChecked()));
 await page.setViewportSize({width:1440,height:960});await page.locator('#ai-progress').scrollIntoViewIfNeeded();await screenshot('ai-recovery-desktop-failure');
 stage='reload_and_resume';await page.reload();await openLanguage();await page.locator('#check-ai').click();
 check('reload_does_not_send_or_retain_consent',requests.length===3&&!(await page.locator('#ai-consent').isChecked()));
 await page.locator('#subscription-translate').click();check('retry_without_consent_sends_nothing',requests.length===3);
 await page.locator('#ai-consent').check();await page.locator('#subscription-translate').click();await settled();saved=await readDocument(title);
 check('fresh_confirmation_resumes_only_unfinished_target',requests.length===4&&JSON.stringify(requests[3].target_ids)===JSON.stringify(['cue-64'])&&translatedCount(saved)===65);
 assert.deepEqual(saved.segments.slice(0,32),firstBatch);checks.push('finished_target_translations_are_unchanged');
 stage='same_source_jump_during_translation';
 const jumpSource={...source,title:'同篇定位与翻译 · 自写流程样例'};await importFixture(jumpSource);await openLanguage();await page.locator('#check-ai').click();
 const jumpStart=requests.length;holdNext=true;const jumpStarted=waitStarted();await page.locator('#ai-consent').check();await page.locator('#subscription-translate').click();await boundedStart(jumpStarted);
 await page.locator('#reading-jump').selectOption('cue-64');
 check('same_source_jump_retains_original_consent',await page.locator('#ai-consent').isChecked()&&await page.locator('#language-panel').evaluate(node=>node.open));
 release();await settled();
 check('same_source_jump_finishes_all_confirmed_batches',requests.length-jumpStart===3&&translatedCount(await readDocument(jumpSource.title))===65);
 assert.deepEqual(requests.slice(jumpStart).flatMap(request=>request.target_ids),source.segments.map(cue=>cue.id));checks.push('same_source_jump_preserves_exact_target_order');

 stage='own_translation_updates_search_matches';
 const searchSource={...source,title:'译文搜索与重译 · 自写流程样例',translation_view:'zh',segments:source.segments.map(cue=>({...cue,translations:{zh:{text:'old-needle authored draft',source_text:cue.text,source_language:'en',document_language:'en',provider:'local'}}}))};
 await importFixture(searchSource);await openLanguage();await page.locator('#mode-bilingual').click();await page.locator('#search').fill('old-needle');
 check('old_translation_search_selects_authored_65_cues',await page.locator('.segment').count()===65);await page.locator('#check-ai').click();
 const searchStart=requests.length;holdNext=true;const searchStarted=waitStarted();await page.locator('#ai-consent').check();await page.locator('#subscription-translate').click();await boundedStart(searchStarted);release();await settled();
 const searched=await readDocument(searchSource.title);
 check('own_search_match_changes_do_not_cancel_confirmed_plan',requests.length-searchStart===3&&searched.segments.filter(cue=>cue.translations.zh.provider==='chatgpt_subscription_translation').length===65&&await page.locator('.segment').count()===0);
 assert.deepEqual(requests.slice(searchStart).flatMap(request=>request.target_ids),source.segments.map(cue=>cue.id));checks.push('shrinking_search_never_adds_omits_or_repeats_approved_targets');
 check('no_external_requests_or_browser_errors',external===0&&errors===0);
 console.log(JSON.stringify({suite:'ai-recovery-injected-provider',status:'passed',checks}));
}catch(error){console.error(JSON.stringify({suite:'ai-recovery-injected-provider',status:'failed',stage,checks,error:error.message}));process.exitCode=1;}
finally{release?.();await browser?.close();if(server)await new Promise(resolve=>server.shutdown(resolve));}
