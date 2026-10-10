/** Explicit real-source proof through the native release ZIP and actual unified UI.
 * Captions/profile stay temporary. No source text, tokens, URLs with credentials,
 * screenshots, media files or account/model requests are published.
 */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {openCueActions} from './cue-actions-browser.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {_electron as electron} from '@playwright/test';
const root=fileURLToPath(new URL('../',import.meta.url));
const origin='http://127.0.0.1:47831';
const source='https://x.com/VaibhavSisinty/status/2105733670493651236';
let work,app,stage='setup',captionPosts=0,forbidden=0,errors=0;const checks=[];
const check=(name,value)=>{stage=name;assert.ok(value,name);checks.push(name);};
process.umask(0o077);delete process.env.DEBUG;delete process.env.PWDEBUG;
try{
 assert.equal(process.platform,'darwin');
 work=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-caption-ui-'));
 const {version}=JSON.parse(await fs.readFile(path.join(root,'desktop/package.json'),'utf8'));
 const archive=path.join(root,'desktop/dist',`Coconut-${version}-${process.arch}-unsigned.zip`);
 const extracted=path.join(work,'application');await fs.mkdir(extracted);
 execFileSync('/usr/bin/ditto',['-x','-k',archive,extracted],{timeout:60000,stdio:'pipe'});
 const home=path.join(work,'home'),profile=path.join(work,'profile');await fs.mkdir(home);await fs.mkdir(profile);
 async function launch(profile){
 app=await electron.launch({executablePath:path.join(extracted,'Coconut.app/Contents/MacOS/Coconut'),args:['--user-data-dir='+profile],cwd:work,acceptDownloads:true,chromiumSandbox:true,bypassCSP:false,timeout:45000,env:{HOME:home,TMPDIR:work,PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'}});
 const facts=await app.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion(),userData:app.getPath('userData')}));
 check('exact_native_zip_and_private_profile',facts.packaged&&facts.version===version&&await fs.realpath(facts.userData)===await fs.realpath(profile));
 await app.context().route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===origin&&request.method()==='POST'&&url.pathname==='/api/captions/import'){
   captionPosts++;const body=request.postDataJSON();if(body.url===source&&body.language==='en'){await route.continue();return;}
  }else if(url.origin===origin&&['GET','HEAD'].includes(request.method())&&url.pathname!=='/api/language-tools'){await route.continue();return;}
  forbidden++;await route.abort();
 });
 const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',()=>errors++);
 await page.waitForURL(origin+'/');await page.waitForFunction(()=>!document.querySelector('#caption-language-control').hidden);
 return page;
 }
 let page=await launch(profile);
 check('native_caption_capability_without_asr',await page.evaluate(async()=>{const h=await(await fetch('api/health')).json();return h.capabilities.caption_import===true&&h.capabilities.media_import===false;}));
 check('no_automatic_source_request',captionPosts===0);
 await page.locator('#video-url').fill(source);await page.locator('#caption-language').selectOption('en');stage='public_caption_import';await page.locator('#process-url').click();
 await page.locator('#reader-workspace').waitFor({state:'visible',timeout:150000});
 const document=await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('coconut-reader-v1'));return s.documents.find(d=>d.key===s.active);});
 check('1771_original_cues_saved',document.segments.length===1771&&document.segments[0].start===.22&&document.segments.at(-1).end===3251.49);
 check('source_and_language_evidence_preserved',document.source_url===source&&document.language==='en'&&document.provenance.language_basis==='user_hint'&&document.provenance.caption_track&&document.provenance.caption_method==='platform_provided'&&document.provenance.review_status==='unreviewed');
 check('summary_is_honestly_uncreated',await page.locator('#summary-state').textContent()==='未生成'&&document.ai_answers.length===0);
 await page.locator('#mode-summary').click();await page.locator('#prepare-summary').click();check('summary_plan_does_not_send',!await page.locator('#ai-consent').isChecked()&&await page.locator('#ask-ai').isDisabled());await page.locator('#close-summary-request').click();
 await page.locator('#mode-transcript').click();const link=new URL(await page.locator('.segment .time a').first().getAttribute('href'));check('cue_links_keep_original_post_and_time',link.origin==='https://x.com'&&link.pathname==='/VaibhavSisinty/status/2105733670493651236'&&link.searchParams.get('t')==='0');
 await page.locator('.segment .note-button').first().click();await page.locator('#note').fill('Authored native caption UI verification note');await page.locator('#close-note').click();
 await page.reload();await page.locator('#mode-transcript').click();await page.locator('.segment .note-button').first().click();check('reload_preserves_source_and_note_without_refetch',await page.locator('#note').inputValue()==='Authored native caption UI verification note'&&captionPosts===1);
 check('no_media_model_status_or_external_renderer_requests',forbidden===0&&errors===0&&await page.locator('#source-media audio,#source-media video').count()===0);
 await page.locator('#close-note').click();
 // Reuse this one real import. No additional source fetch or model requests.
 await page.locator('#reading-jump').selectOption(document.segments.at(-1).id);
 const lastId=document.segments.at(-1).id;
 const last=page.locator('.segment').last();
 check('real_last_cue_reached',await last.getAttribute('data-segment-id')===lastId);
 await last.locator('.note-button').click();await page.locator('#note').fill('Authored final-cue recovery note');await page.locator('#close-note').click();
 await openCueActions(last);await last.locator('.excerpt-button').click();
 await openCueActions(last);await last.locator('.bookmark-button').click();
 await openCueActions(last);await last.locator('.edit-button').click();
 await page.locator('#edit-segment').fill('Authored acceptance correction; retain the original source.');await page.locator('#save-edit').click();
 const expected=await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('coconut-reader-v1'));return s.documents.find(d=>d.key===s.active);});
 check('real_last_cue_original_and_annotations_retained',expected.segments.at(-1).original_text===document.segments.at(-1).text&&expected.segments.at(-1).saved_excerpt===true&&expected.readingPosition===lastId);
 async function download(button,name){
  if(!await page.locator('#export-menu').evaluate(n=>n.open))await page.locator('#export-menu > summary').click();
  const [item]=await Promise.all([page.waitForEvent('download'),page.locator(button).click()]);
  const filename=path.join(work,name);await item.saveAs(filename);check('real_'+name+'_saved',await item.failure()===null);return filename;
 }
 const backup=await download('#export','backup.json');
 check('real_caption_json_matches_all_reading_work',isDeepStrictEqual(JSON.parse(await fs.readFile(backup,'utf8')),expected));
 const notebook=await download('#export-notebook','notebook.md');const markdown=await fs.readFile(notebook,'utf8');
 check('real_caption_notebook_keeps_notes_and_source',markdown.includes('Authored final')&&markdown.includes(source)&&markdown.includes('Authored acceptance correction'));
 await app.close();app=null;
 page=await launch(profile);
 const readSaved=()=>page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('coconut-reader-v1'));return s.documents.find(d=>d.key===s.active);});
 check('real_caption_process_restart_restores_complete_document',isDeepStrictEqual(await readSaved(),expected));
 await page.locator('#mode-transcript').click();await page.locator('#resume').click();
 check('real_caption_restart_resumes_last_cue',await page.locator('.segment').last().getAttribute('data-segment-id')===lastId);
 await app.close();app=null;
 const fresh=path.join(work,'fresh-profile');await fs.mkdir(fresh);page=await launch(fresh);
 check('real_caption_restore_profile_starts_empty',await page.locator('#library button').count()===0);
 await page.locator('#file').setInputFiles(backup);await page.locator('#reader-workspace').waitFor({state:'visible'});
 const restored=await readSaved();
 check('real_caption_download_restores_all_fields',isDeepStrictEqual(restored,{...expected,key:restored.key}));
 await page.locator('#mode-transcript').click();await page.locator('#resume').click();await page.locator('.segment').last().locator('.note-button').click();
 check('real_caption_restored_note_and_position_visible',await page.locator('#note').inputValue()==='Authored final-cue recovery note'&&await page.locator('.segment').last().getAttribute('data-segment-id')===lastId);
 check('real_caption_recovery_does_not_refetch_or_infer',captionPosts===1&&forbidden===0&&errors===0);
 await app.close();app=null;
 check('quit_cleans_native_request_directories',!(await fs.readdir(work)).some(name=>name.startsWith('coconut-caption-')));
 console.log(JSON.stringify({suite:'native-caption-primary-journey',status:'passed',architecture:process.arch,cues:1771,captionPosts,realModelQualityVerified:false,checks}));
}catch(error){console.error(JSON.stringify({suite:'native-caption-primary-journey',status:'failed',stage,category:error.name,checks}));process.exitCode=1;}
finally{try{if(app){await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});}).catch(()=>{});await app.close();}}finally{if(work)await fs.rm(work,{recursive:true,force:true});}}
