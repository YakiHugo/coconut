/** CI-only real-browser journey. Original authored cues, injected answers and
 * a local bridge only; no account, CLI, quota, external site or media is used.
 * Syntax checks do not count as real-browser evidence. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium, waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {startBridge} from '../desktop/server.mjs';
import {passageReadingFixture} from './helpers/passage-reading-fixture.mjs';
let server,browser,stage='setup',release,hold=false,external=0;
const requests=[],checks=[],errors=[];
const check=(name,value)=>{stage=name;assert.ok(value,name);checks.push(name);};
const providers={status:async()=>({ready:true,reason:'Authored test provider'}),exclusive:async fn=>fn(),ask:async body=>{
 requests.push(body);if(hold)await new Promise(resolve=>{release=resolve;});
 return {answer:'Authored fixture answer. Compare the cited source.',citations:[body.segments[0].id],provider:'authored-fixture'};
}};
const snapshot=async page=>{await page.waitForFunction(()=>document.getElementById('save-status').dataset.state==='saved');return page.evaluate(async()=>{const state=await readPersistedLibrary();return state.documents.find(doc=>doc.key===sessionStorage.getItem('coconut-reader-active-v1'));});};
const scopedIds=page=>page.locator('#passage-question-preview [data-cue-id]').evaluateAll(nodes=>nodes.map(node=>node.dataset.cueId));
async function screenshot(page,label){if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,`passage-question-${label}.png`),fullPage:false,animations:'disabled'});}}
async function load(page,doc){await page.locator('#file').setInputFiles({name:'authored-passage-question.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});await page.waitForFunction(title=>document.getElementById('title').textContent===title,doc.title);await page.locator('#passage-workspace').waitFor({state:'visible'});}
try{
 server=await startBridge({port:0,providers});const origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({headless:true});
 for(const [label,viewport] of [['desktop',{width:1360,height:1000}],['mobile',{width:390,height:844}]]){
  const context=await browser.newContext({viewport,acceptDownloads:true,serviceWorkers:'block'});
  await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin||url.protocol==='blob:')await route.continue();else{external++;await route.abort();}});
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
  const doc=passageReadingFixture();doc.title='问这一段 · 自写验收 '+label;doc.segments=doc.segments.slice(0,120);await load(page,doc);
  await page.evaluate(()=>scrollTo(0,0));
  check(label+'_source_starts_within_350px',(await page.locator('.passage-original').first().boundingBox()).y<=350);
  const button=page.locator('.passage-ask').first(),box=await button.boundingBox();check(label+'_passage_action_has_44px_target',box.height>=44);
  const before=requests.length;await button.focus();await page.keyboard.press('Enter');await page.locator('#passage-question-dialog').waitFor({state:'visible'});
  check(label+'_keyboard_lands_at_source_heading',await page.locator('#passage-question-heading').evaluate(node=>node===document.activeElement));
  check(label+'_only_six_original_cues_previewed',JSON.stringify(await scopedIds(page))===JSON.stringify(doc.segments.slice(0,6).map(cue=>cue.id)));
  check(label+'_opening_never_requests',requests.length===before);
  check(label+'_source_preview_is_visible_before_question',await page.locator('#passage-question-preview').isVisible());await screenshot(page,label+'-source');
  await page.locator('#check-ai').click();await page.locator('#ai-provider').selectOption('claude');await page.locator('#ai-question').fill('Explain this exact passage.');
  await page.locator('#ask-ai').click();check(label+'_unconfirmed_sends_nothing',requests.length===before);
  await page.locator('#ai-consent').check();await page.locator('#passage-question-neighbors').check();check(label+'_expansion_revokes_consent',!await page.locator('#ai-consent').isChecked());
  check(label+'_expansion_preview_count_is_twelve',(await scopedIds(page)).length===12&&await page.locator('#question-scope').getAttribute('data-segment-count')==='12');
  await page.locator('#passage-question-neighbors').uncheck();await page.locator('#ai-consent').check();await page.locator('#ask-ai').click();
  await page.waitForFunction(()=>document.querySelectorAll('.ai-answer').length===1);const saved=await snapshot(page);
  assert.deepEqual(requests.at(-1).segments,doc.segments.slice(0,6).map(({id,text})=>({id,text})));check(label+'_request_only_sent_six_originals',requests.length===before+1);
  check(label+'_saved_exact_source_provenance',saved.ai_answers[0].input_snapshot.scope.cues.length===6&&saved.ai_answers[0].input_snapshot.scope.provider==='claude');
  await page.locator('#ai-question').fill('A newer question draft');await page.locator('#ai-answers .ai-answer button').first().click();
  check(label+'_citation_goes_to_exact_cue',await page.locator('.segment[data-segment-id="split-0"]').evaluate(node=>node===document.activeElement));
  await page.locator('#return-passage-question').click();check(label+'_citation_return_restores_scope_and_draft',(await scopedIds(page)).length===6&&await page.locator('#ai-question').inputValue()==='A newer question draft'&&!await page.locator('#ai-consent').isChecked());
  await page.keyboard.press('Escape');check(label+'_escape_restores_action_focus',await page.locator('.passage-ask').first().evaluate(node=>node===document.activeElement));
  check(label+'_escape_returns_single_composer',await page.locator('#ai-request-home > #ai-request-panel').count()===1);
  // A download is parsed as actual bytes, then re-imported in a fresh context.
  await page.locator('#mode-transcript').click();await page.locator('#language-panel > summary').click();await page.locator('#ai-question').fill('');
  const download=page.waitForEvent('download');await page.locator('#export-ai-history-json').click();const exported=await download,bytes=await fs.readFile(await exported.path());check(label+'_download_preserves_scope',JSON.parse(bytes).ai_answers[0].input_snapshot.scope.cues.length===6);
  // Real delayed response + Escape: valid immutable work saves without reopening or stealing focus.
  await page.locator('#mode-passages').click();await page.locator('.passage-ask').nth(1).click();await page.locator('#ai-question').fill('This pending question will continue in the background.');hold=true;
  await page.locator('#ai-consent').check();await page.locator('#ask-ai').click();const deadline=Date.now()+15000;while(!release&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(release);
  await page.keyboard.press('Escape');release();release=null;hold=false;
  await page.locator('.passage-ask').nth(1).click();await page.locator('#ai-question').fill('New edit after background request');await waitForPersistedLibrary(page,async()=>{const state=await readPersistedLibrary();return state.documents.find(doc=>doc.key===sessionStorage.getItem('coconut-reader-active-v1')).ai_answers.length===2;});
  check(label+'_late_reply_preserves_draft_and_history',await page.locator('#ai-question').inputValue()==='New edit after background request'&&(await snapshot(page)).ai_answers.length===2);
  // Explicit cancellation is distinct from returning to reading.
  await page.locator('#ai-question').fill('Cancel receiving this request.');hold=true;await page.locator('#ai-consent').check();await page.locator('#ask-ai').click();
  const cancelDeadline=Date.now()+15000;while(!release&&Date.now()<cancelDeadline)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(release);
  await page.locator('#stop-question').click();const canceledResponse=page.waitForResponse(response=>response.url().endsWith('/api/ask'));release();release=null;hold=false;await canceledResponse;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  check(label+'_explicit_cancel_does_not_save_late_answer',(await snapshot(page)).ai_answers.length===2);
  check(label+'_modal_has_no_horizontal_overflow',await page.locator('#passage-question-dialog').evaluate(node=>node.scrollWidth<=node.clientWidth&&node.getBoundingClientRect().left>=0&&node.getBoundingClientRect().right<=innerWidth));
  await screenshot(page,label+'-question');await context.close();
  const restored=await browser.newContext({viewport,serviceWorkers:'block'});await restored.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin||url.protocol==='blob:')await route.continue();else{external++;await route.abort();}});const recovery=await restored.newPage();recovery.on('pageerror',error=>errors.push(error.message));await recovery.goto(origin);await load(recovery,JSON.parse(bytes));await recovery.locator('#mode-transcript').click();await recovery.locator('#language-panel > summary').click();
  await recovery.locator('#ai-answers .ai-answer button').first().click();await recovery.locator('#return-passage-question').click();check(label+'_fresh_import_returns_exact_historical_scope',(await scopedIds(recovery)).length===6&&!await recovery.locator('#ai-consent').isChecked());await restored.close();
 }
 check('no_external_requests',external===0);check('no_browser_errors',errors.length===0);console.log(JSON.stringify({ok:true,checks,injectedRequests:requests.length,external,errors},null,2));
}catch(error){console.error(JSON.stringify({ok:false,stage,error:error.message,checks,errors},null,2));process.exitCode=1;}
finally{release?.();await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
