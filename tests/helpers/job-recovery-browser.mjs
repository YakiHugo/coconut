// Compatibility renderer regression; this suite does not establish default React acceptance.
/** Extends synthetic completed-job browser acceptance with authored recovery API
 * responses and its already-prepared tone/video fixture. No model or download. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {waitForPersistedLibrary,expect} from './browser-storage.mjs';
import {authoredAudioFixture} from './authored-audio-fixture.mjs';
import {openCueActions} from '../cue-actions-browser.mjs';

export async function verifyJobRecovery(browser,origin,preparedMedia,onCheck=()=>{}){
 const id='e'.repeat(32),checks=[];let recovered=false,retries=0,external=0,errors=0,unexpected=0,hold=false,release;
 const source=()=>({title:'Authored playback recovery',language:'en',source_url:'https://x.com/example/status/123',
  provenance:{kind:'platform_subtitles',...(!recovered?{playback_warning:'Local playback download unavailable; use the original source link'}:{})},
  ...(recovered?{source_media:{job_id:id,kind:preparedMedia.kind}}:{}),segments:[{id:'first',start:0,end:1,text:'Verify this authored first passage.'},{id:'second',start:1,end:2,text:'Retain the reader correction and note.'},{id:'last',start:2,end:3,text:'A later result must not interrupt a draft.'}]});
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 const check=(name,value)=>{const full='job_recovery_'+name;onCheck(full,value);assert.ok(value,full);checks.push(full);};
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),json=value=>route.fulfill({json:value});
  if(['blob:','data:'].includes(url.protocol))return route.continue();
  if(url.origin!==origin){external++;return route.abort();}
  if(url.pathname==='/api/health')return json({local_worker:true});
  if(url.pathname==='/api/jobs')return json({jobs:[{id,title:'Authored playback recovery',status:'done',stage:'Ready',playback_retryable:!recovered}]});
  if(url.pathname===`/api/jobs/${id}/retry`&&request.method()==='POST'){retries++;if(retries>=2)recovered=true;return json({id,status:'queued'});}
  if(url.pathname===`/api/jobs/${id}/result`){const snapshot=source();if(hold){hold=false;await new Promise(resolve=>{release=resolve;});release=null;}return json(snapshot);}
  if(url.pathname===`/api/jobs/${id}/media`)return route.fulfill({response:await route.fetch({url:origin+`/api/jobs/${preparedMedia.job_id}/media`})});
  if(url.pathname.startsWith('/api/'))return route.fulfill({status:404,json:{error:'No provider in authored job fixture'}});
  if(['GET','HEAD'].includes(request.method()))return route.continue();
  unexpected++;return route.abort();
 });
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>errors++);
 const saved=async()=>{await page.evaluate(()=>libraryStore.flush());return page.evaluate(()=>readPersistedLibrary());};
 const action=name=>page.locator(`[data-job-id="${id}"] [data-job-action="${name}"]`);
 const openJobs=async()=>{if(!await page.locator('#add-workspace').isVisible())await page.locator('#show-jobs').click();};
 const open=async()=>{await openJobs();await action('open').click();await page.locator('#reader-workspace').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('[data-job-action="open"]').disabled);};
 const retry=async()=>{await openJobs();await action('retry').click();await page.waitForFunction(()=>!document.querySelector('[data-job-action="open"]').disabled);};
 try{
  await page.goto(origin+'/compatibility.html');await action('open').waitFor({state:'visible'});await open();await page.locator('#mode-transcript').click();
  const first=page.locator('[data-segment-id="first"]');await openCueActions(first);await first.locator('.note-button').click();await page.locator('#note').fill('Retain this authored job note');await page.locator('#close-note').click();
  const second=page.locator('[data-segment-id="second"]');await openCueActions(second);await second.locator('.edit-button').click();await page.locator('#edit-segment').fill('Reader-corrected authored second passage.');await page.locator('#save-edit').click();
  const before=(await saved()).documents[0];check('initial_job_is_bound',before.local_job_binding?.id===id);
  await retry();await open();const failedRetryLibrary=await saved(),failedRetry=failedRetryLibrary.documents[0];
  check('unsuccessful_retry_retains_one_document',failedRetryLibrary.documents.length===1);
  check('unsuccessful_retry_reuses_original_key',failedRetry.key===before.key);
  check('unsuccessful_retry_preserves_all_note_fields',isDeepStrictEqual(failedRetry.notes,before.notes));
  check('unsuccessful_retry_preserves_all_segment_fields',isDeepStrictEqual(failedRetry.segments,before.segments));
  await retry();await page.reload();await open();const after=(await saved()).documents[0];
  // Reload validates saved cues and may reorder object properties. Compare the
  // complete structures: all fields/values and array order still have to match.
  check('recovery_retains_one_document',(await saved()).documents.length===1);
  check('recovery_reuses_original_key',after.key===before.key);
  check('recovery_preserves_all_note_fields',isDeepStrictEqual(after.notes,before.notes));
  check('recovery_preserves_all_segment_fields',isDeepStrictEqual(after.segments,before.segments));
  check('recovered_media_is_bound_and_warning_cleared',after.source_media?.job_id===id&&!after.provenance.playback_warning);
  await page.waitForFunction(()=>document.querySelector('#source-media audio,#source-media video')?.readyState>=1);
  check('recovered_native_player_is_paused',await page.locator('#source-media audio,#source-media video').evaluate(player=>player.paused&&player.currentTime===0));
  await page.reload();const reopened=(await saved()).documents[0];
  check('reload_retains_one_document',(await saved()).documents.length===1);
  check('reload_preserves_recovered_key',reopened.key===before.key);
  check('reload_preserves_all_note_fields',isDeepStrictEqual(reopened.notes,before.notes));
  check('reload_preserves_all_segment_fields',isDeepStrictEqual(reopened.segments,before.segments));
  check('reload_preserves_recovered_media',reopened.source_media?.job_id===id);

  // Delayed recovery while returning to the same book: no full reader render.
  await page.evaluate(async()=>{const doc=active();delete doc.source_media;doc.provenance.playback_warning='Authored unavailable playback';await commitDocument(doc);render();});
  await openJobs();hold=true;await action('open').click();await expect.poll(()=>!!release,{timeout:15000}).toBe(true);await page.locator('#back-reading').click();await page.locator('#mode-transcript').click();
  await openCueActions(first);await first.locator('.note-button').click();await page.locator('#note').fill('Draft during delayed recovery');await page.locator('#note').focus();
  await page.evaluate(()=>{window.jobRecoveryBefore={row:document.querySelector('.segment'),note:document.querySelector('#note'),focus:document.activeElement,mode:readingMode,workspace:document.body.dataset.workspace,scrollY,hidden:document.querySelector('#episode-media').hidden};});
  release();await page.waitForFunction(()=>!document.querySelector('[data-job-action="open"]').disabled);
  check('late_media_mount_preserves_draft_focus_mode_and_scroll',await page.evaluate(()=>{const b=window.jobRecoveryBefore,p=document.querySelector('#source-media audio,#source-media video');return !!p&&p.paused&&p.currentTime===0&&document.querySelector('.segment')===b.row&&document.querySelector('#note')===b.note&&document.activeElement===b.focus&&b.note.value==='Draft during delayed recovery'&&readingMode===b.mode&&document.body.dataset.workspace===b.workspace&&scrollY===b.scrollY&&document.querySelector('#episode-media').hidden===b.hidden;}));
  if(await page.locator('#episode-media').isHidden()){
   await page.locator('#close-note').click();
   // Closing the note renders the current book and can reveal recovered media.
   // Decide whether to expand from the current panel, not the pre-render state.
   if(await page.locator('#episode-media').isHidden())await page.locator('#toggle-reader-media').click();
  }
  check('ready_media_panel_control_is_expanded',await page.locator('#episode-media').evaluate(panel=>!panel.hidden)&&await page.locator('#toggle-reader-media').getAttribute('aria-expanded')==='true');
  check('ready_media_is_actionable',await page.locator('#source-media audio,#source-media video').isVisible());

  // A deliberate browser-local attachment remains the playback owner.
  const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);
  await chooser.setFiles({name:'authored-local-choice.wav',mimeType:'audio/wav',buffer:authoredAudioFixture(8)});
  await page.waitForFunction(()=>document.querySelector('#source-media audio')?.getAttribute('src')?.startsWith('blob:'));
  await page.evaluate(()=>{const p=document.querySelector('#source-media audio');p.currentTime=1;window.jobRecoveryLocal={player:p,src:p.getAttribute('src')};});
  await openJobs();hold=true;await action('open').click();await expect.poll(()=>!!release,{timeout:15000}).toBe(true);await page.locator('#back-reading').click();release();await page.waitForFunction(()=>!document.querySelector('[data-job-action="open"]').disabled);
  check('recovery_preserves_explicit_local_player_and_position',await page.evaluate(()=>{const p=document.querySelector('#source-media audio'),b=window.jobRecoveryLocal;return p===b.player&&p.getAttribute('src')===b.src&&p.currentTime===1&&p.paused;}));
  await waitForPersistedLibrary(page,async()=>{const docs=(await readPersistedLibrary()).documents;return docs.length===1&&docs[0].notes.first==='Draft during delayed recovery';});
  check('no_external_requests_or_page_errors',external===0&&unexpected===0&&errors===0);return checks;
 }finally{release?.();await context.close();}
}
