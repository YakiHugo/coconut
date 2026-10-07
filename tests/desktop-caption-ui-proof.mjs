/** Explicit real-source proof through the native release ZIP and actual unified UI.
 * Captions/profile stay temporary. No source text, tokens, URLs with credentials,
 * screenshots, media files or account/model requests are published.
 */
import assert from 'node:assert/strict';
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
 app=await electron.launch({executablePath:path.join(extracted,'Coconut.app/Contents/MacOS/Coconut'),args:['--user-data-dir='+profile],cwd:work,chromiumSandbox:true,bypassCSP:false,timeout:45000,env:{HOME:home,TMPDIR:work,PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'}});
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
 check('native_caption_capability_without_asr',await page.evaluate(async()=>{const h=await(await fetch('api/health')).json();return h.capabilities.caption_import===true&&h.capabilities.media_import===false;}));
 check('no_automatic_source_request',captionPosts===0);
 await page.locator('#video-url').fill(source);await page.locator('#caption-language').selectOption('en');stage='public_caption_import';await page.locator('#process-url').click();
 await page.locator('#reader-workspace').waitFor({state:'visible',timeout:150000});
 const document=await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('coconut-reader-v1'));return s.documents.find(d=>d.key===s.active);});
 check('1771_original_cues_saved',document.segments.length===1771&&document.segments[0].start===.22&&document.segments.at(-1).end===3251.49);
 check('source_and_language_evidence_preserved',document.source_url===source&&document.language==='en'&&document.provenance.language_basis==='user_hint'&&document.provenance.caption_track&&document.provenance.caption_method==='platform_provided'&&document.provenance.review_status==='unreviewed');
 check('summary_is_honestly_uncreated',await page.locator('#summary-state').textContent()==='未生成'&&document.ai_answers.length===0);
 await page.locator('#prepare-summary').click();check('summary_plan_does_not_send',!await page.locator('#ai-consent').isChecked()&&await page.locator('#ask-ai').isDisabled());await page.locator('#close-summary-request').click();
 await page.locator('#mode-transcript').click();const link=new URL(await page.locator('.segment .time a').first().getAttribute('href'));check('cue_links_keep_original_post_and_time',link.origin==='https://x.com'&&link.pathname==='/VaibhavSisinty/status/2105733670493651236'&&link.searchParams.get('t')==='0');
 await page.locator('.segment .note-button').first().click();await page.locator('#note').fill('Authored native caption UI verification note');await page.locator('#close-note').click();
 await page.reload();await page.locator('#mode-transcript').click();await page.locator('.segment .note-button').first().click();check('reload_preserves_source_and_note_without_refetch',await page.locator('#note').inputValue()==='Authored native caption UI verification note'&&captionPosts===1);
 check('no_media_model_status_or_external_renderer_requests',forbidden===0&&errors===0&&await page.locator('#source-media audio,#source-media video').count()===0);
 await app.close();app=null;
 check('quit_cleans_native_request_directories',!(await fs.readdir(work)).some(name=>name.startsWith('coconut-caption-')));
 console.log(JSON.stringify({suite:'native-caption-primary-journey',status:'passed',architecture:process.arch,cues:1771,captionPosts,realModelQualityVerified:false,checks}));
}catch(error){console.error(JSON.stringify({suite:'native-caption-primary-journey',status:'failed',stage,category:error.name,checks}));process.exitCode=1;}
finally{try{await app?.close();}finally{if(work)await fs.rm(work,{recursive:true,force:true});}}
