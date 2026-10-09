/** Action-specific consent and scope in real Chromium. Authored source and injected
 * provider responses only: no accounts, CLI, model, public source or media calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {startBridge} from '../desktop/server.mjs';
let server,browser,stage='setup',release,holdTranslation=false,holdSummary=false;
const checks=[],posts=[];let providerCalls=0,external=0,errors=0;
const check=(name,value)=>{stage=name;assert.ok(value,name);checks.push(name);};
const fixture=(title,count=65)=>({title,language:'en',notes:{'cue-5':'PRIVATE LOCAL NOTE'},segments:Array.from({length:count},(_,i)=>({id:'cue-'+i,start:i*4,end:i*4+4,text:`Authored observation ${i+1}: compare the original evidence before drawing a conclusion.${[5,40].includes(i)?' selected-needle':''}`}))});
const providers={
 status:async()=>({ready:true,reason:'Injected acceptance provider; no real CLI or model'}),exclusive:async fn=>fn(),
 ask:async request=>{providerCalls++;if(holdSummary){holdSummary=false;await new Promise(resolve=>{release=resolve;});release=null;}return {answer:'这是预置的验收回答，不代表真实模型质量。',citations:[request.segments[0].id],provider:'authored-fixture'};},
 structured:async(_provider,payload)=>{providerCalls++;const data=JSON.parse(payload);if(holdTranslation){holdTranslation=false;await new Promise(resolve=>{release=resolve;});release=null;}return {translations:data.target_ids.map(id=>({id,text:'这是自写的验收译文，请对照原文核查。'}))};}
};
try{
 server=await startBridge({port:0,providers});const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1360,height:1000},serviceWorkers:'block'});
 await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin===origin){if(req.method()==='POST')posts.push({path:url.pathname,body:req.postDataJSON()});await route.continue();}else if(url.protocol==='blob:')await route.continue();else{external++;await route.abort();}});
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>errors++);await page.goto(origin);
 const importFixture=async doc=>{await page.locator('#file').setInputFiles({name:'authored-ai-action.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});await page.locator('#mode-transcript').click();if(!await page.locator('#language-panel').evaluate(n=>n.open))await page.locator('#language-panel > summary').click();};
 const planFor={question:'#question-scope',translation:'#subscription-translation-scope',summary:'#summary-plan'};
 async function planCount(action,segments,requests){const plan=page.locator(planFor[action]);check(action+'_plan_matches_scope_'+segments,await plan.isVisible()&&Number(await plan.getAttribute('data-segment-count'))===segments&&Number(await plan.getAttribute('data-request-count'))===requests);}
 async function select(action){await page.locator('#ai-task').selectOption(action);}
 async function savedAnswers(count){await page.waitForFunction(count=>{const s=JSON.parse(localStorage.getItem('coconut-reader-v1'));return s.documents.find(d=>d.key===s.active).ai_answers.length===count;},count);}
 async function sendQuestion(){await page.locator('#ai-consent').check();await page.locator('#ask-ai').click();}
 async function waitHeld(){const deadline=Date.now()+15000;while(!release&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));assert.ok(release,'Injected provider reached bounded hold');}
 await importFixture(fixture('三种 AI 阅读动作 · 自写验收'));await page.locator('#search').fill('selected-needle');
 check('opening_and_filtering_never_send',posts.length===0&&providerCalls===0);
 await page.locator('#check-ai').click();await page.waitForFunction(()=>!document.getElementById('ask-ai').disabled);
 await page.locator('#ai-question').fill('Which original observations support the conclusion?');
 await page.locator('#ai-filtered').uncheck();
 // Each action shows its own plan and exactly one subscription submission.
 for(const [label,viewport] of [['desktop',{width:1360,height:1000}],['mobile',{width:390,height:844}]]){
  await page.setViewportSize(viewport);
  for(const action of ['question','translation','summary']){
   await select(action);await planCount(action,action==='translation'?2:65,action==='translation'?2:1);
   check(label+'_'+action+'_only_matching_plan_and_submit_visible',await page.locator(action==='translation'?'#subscription-translate':'#ask-ai').isVisible()&&await page.locator(action==='translation'?'#ask-ai':'#subscription-translate').isHidden()&&(await Promise.all(Object.entries(planFor).filter(([key])=>key!==action).map(([,selector])=>page.locator(selector).isHidden()))).every(Boolean));
   check(label+'_'+action+'_does_not_inherit_consent',!await page.locator('#ai-consent').isChecked());
   await page.locator('#ai-task').evaluate(n=>n.scrollIntoView({block:'start',behavior:'instant'}));
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   check(label+'_'+action+'_viewport_fits',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,`ai-action-${label}-${action}.png`),fullPage:false});}
   const reviewVisible=await page.evaluate(({plan,submit})=>[plan,'#ai-consent',submit].every(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight;}),{plan:planFor[action],submit:action==='translation'?'#subscription-translate':'#ask-ai'});
   check(label+'_'+action+'_scope_consent_and_submit_visible_together',reviewVisible);
   await page.locator('#ai-consent').check();
  }
 }
 check('six_action_reviews_send_nothing',posts.length===0&&providerCalls===0);
 await select('question');await page.locator('#ai-filtered').uncheck();await planCount('question',65,1);
 await page.locator('#ask-ai').click();check('question_without_new_consent_sends_nothing',posts.length===0);
 await sendQuestion();await savedAnswers(1);
 check('full_question_payload_matches_displayed_65_cues',posts.length===1&&posts[0].path==='/api/ask'&&posts[0].body.segments.length===65);
 await page.locator('#ai-filtered').check();await planCount('question',2,1);await sendQuestion();await savedAnswers(2);
 check('filtered_question_payload_matches_two_displayed_cues',posts.length===2&&JSON.stringify(posts[1].body.segments.map(s=>s.id))===JSON.stringify(['cue-5','cue-40']));
 await select('summary');await planCount('summary',65,1);await sendQuestion();await savedAnswers(3);
 check('summary_ignores_reading_filter_with_honest_full_scope',posts.length===3&&posts[2].path==='/api/ask'&&posts[2].body.segments.length===65);
 await select('translation');await planCount('translation',2,2);
 const sent=Number(await page.locator(planFor.translation).getAttribute('data-sent-count'));
 await page.locator('#ai-consent').check();await page.locator('#subscription-translate').click();await page.waitForFunction(()=>document.getElementById('stop-subscription-translation').hidden);
 const translationPosts=posts.slice(3);
 check('translation_payload_matches_approved_targets_and_sent_count',posts.length===5&&translationPosts.every(r=>r.path==='/api/translate-subscription')&&JSON.stringify(translationPosts.flatMap(r=>r.body.segments.map(s=>s.id)))===JSON.stringify(['cue-5','cue-40'])&&new Set(translationPosts.flatMap(r=>[...r.body.segments,...(r.body.context||[])].map(s=>s.id))).size===sent);
 check('user_annotations_never_enter_any_action_payload',!JSON.stringify(posts).includes('PRIVATE LOCAL NOTE'));
 // Switching away and back must permanently stop the old multi-batch plan,
 // even when consent for the new action is checked while the request finishes.
 await importFixture(fixture('动作切换中止翻译 · 自写验收'));await select('translation');await page.locator('#check-ai').click();
 await page.waitForFunction(()=>!document.getElementById('subscription-translate').disabled);await planCount('translation',65,3);
 const beforeTranslation=posts.length;holdTranslation=true;await page.locator('#ai-consent').check();await page.locator('#subscription-translate').click();await waitHeld();
 await select('question');check('switch_from_translation_revokes_consent',!await page.locator('#ai-consent').isChecked());await select('translation');await page.locator('#ai-consent').check();release();
 await page.waitForFunction(()=>document.getElementById('stop-subscription-translation').hidden);
 check('mode_roundtrip_does_not_restart_translation_batches',posts.length===beforeTranslation+1);
 const translated=await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('coconut-reader-v1'));return s.documents.find(d=>d.key===s.active).segments.filter(c=>c.translations?.zh).length;});check('completed_translation_batch_remains_durable',translated===32);
 await importFixture(fixture('动作切换中止摘要 · 自写验收',801));await select('summary');await page.locator('#check-ai').click();await page.waitForFunction(()=>!document.getElementById('ask-ai').disabled);
 const beforeSummary=posts.length;holdSummary=true;await sendQuestion();await waitHeld();
 await select('question');check('switch_from_summary_revokes_consent',!await page.locator('#ai-consent').isChecked());await select('summary');await page.locator('#ai-consent').check();release();
 await page.waitForFunction(()=>document.getElementById('stop-summary').hidden);
 check('mode_roundtrip_does_not_restart_summary_batches',posts.length===beforeSummary+1);
 check('stopped_summary_keeps_partial_work_without_final_claim',await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('coconut-reader-v1')),d=s.documents.find(d=>d.key===s.active);return d.summary_job?.results.length===1&&!d.ai_answers.some(a=>a.purpose==='summary');}));
 check('only_injected_requests_and_no_browser_errors',external===0&&errors===0&&providerCalls===posts.length);
 console.log(JSON.stringify({suite:'ai-actions-injected-provider',status:'passed',checks}));
}catch(error){console.error(JSON.stringify({suite:'ai-actions-injected-provider',status:'failed',stage,checks,error:error.message}));process.exitCode=1;}
finally{release?.();await browser?.close();if(server)await new Promise(resolve=>server.shutdown(resolve));}
