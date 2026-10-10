/** CI-only real Chromium evidence for authored reading appearance. No user
 * sources, model requests, accounts or external services are involved. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect} from './helpers/browser-storage.mjs';
import {splitCueFixture} from './helpers/split-cue-fixture.mjs';
import {authoredAudioFixture} from './helpers/authored-audio-fixture.mjs';
import {themeTransitionsSettled} from './helpers/theme-transitions.mjs';
if (!process.env.CI) throw new Error('Reading appearance browser acceptance is CI-only; use the authored Node/HappyDOM suite locally.');
const root=fileURLToPath(new URL('../',import.meta.url)),checks=[],evidence=[];
let server,browser,page,stage='setup',mutations=0,external=0;
const errors=[];
function check(name,value){stage=name;assert.ok(value,name);checks.push(name);}
async function capture(name){
 if(!process.env.COCONUT_UI_SCREENSHOTS)return;
 await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});
 await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'appearance-'+name+'.png'),fullPage:false,animations:'disabled'});
}
async function settings(){
 const compact=await page.locator('#reading-info').isVisible();
 const panel=page.locator(compact?'#reading-info':'#reading-settings');
 if(!await panel.evaluate(node=>node.open))await panel.locator(':scope > summary').click();
 await expect(page.locator('#reading-theme')).toBeVisible();
}
async function closeSettings(){
 if(await page.locator('#reading-info').isVisible())await page.locator('#close-reading-info').click();
 else await page.locator('#reading-settings > summary').click();
}
async function noOverflow(name){check(name,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
async function contrast(name,selectors){
 // A theme change updates inherited text immediately while button surfaces
 // transition for 150ms. Measure the settled theme, not an intermediate frame.
 await page.waitForFunction(themeTransitionsSettled,selectors,{timeout:15000});
 const ratios=await page.evaluate(selectors=>{
  const rgb=text=>{const nums=text.match(/[\d.]+/g)?.map(Number);if(!nums||nums.length<3)throw Error('Unrecognized color '+text);return [...nums.slice(0,3),nums[3]??1];};
  const over=(a,b)=>[...a.slice(0,3).map((v,i)=>v*a[3]+b[i]*(1-a[3])),1];
  const luminance=color=>color.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  const ratio=(a,b)=>{const la=luminance(a),lb=luminance(b);return (Math.max(la,lb)+.05)/(Math.min(la,lb)+.05);};
  return selectors.map(selector=>{
   const node=document.querySelector(selector);if(!node||!node.getClientRects().length)throw Error('Missing visible contrast target '+selector);
   const ancestors=[];for(let n=node;n;n=n.parentElement)ancestors.unshift(n);
   let bg=[255,255,255,1];for(const n of ancestors)bg=over(rgb(getComputedStyle(n).backgroundColor),bg);
   const style=getComputedStyle(node),fg=over(rgb(style.color),bg);
   return {selector,foreground:style.color,background:bg,ratio:ratio(fg,bg)};
  });
 },selectors);
 evidence.push({name,ratios});console.log(JSON.stringify({suite:'reading-appearance',name,ratios}));
 for(const item of ratios)check(name+' '+item.selector,item.ratio>=4.5);
}
async function controls(name){
 const rows=await page.evaluate(()=>['reading-layout','reading-measure','reading-theme'].map(id=>{
  const node=document.getElementById(id),rect=node.getBoundingClientRect(),style=getComputedStyle(node);
  return {id,width:rect.width,height:rect.height,left:rect.left,right:rect.right,clientWidth:innerWidth,label:node.closest('label').textContent,display:style.display};
 }));
 const panel=await page.locator('.reading-info-panel').evaluate(node=>{const rect=node.getBoundingClientRect();return {left:rect.left,right:rect.right,width:rect.width,viewport:innerWidth};});
 const close=await page.locator('#close-reading-info').evaluate(node=>{const rect=node.getBoundingClientRect();return {left:rect.left,right:rect.right,width:rect.width,height:rect.height};});
 evidence.push({name,panel,close});console.log(JSON.stringify({suite:'reading-appearance',name,panel,close}));
 check(name+'_panel_within_viewport',panel.left>=0&&panel.right<=panel.viewport);
 check(name+'_close_within_viewport',close.left>=0&&close.right<=panel.viewport&&close.width>=44&&close.height>=44);
 evidence.push({name,controls:rows});for(const row of rows)check(name+' '+row.id,row.height>=44&&row.width>=44&&row.left>=0&&row.right<=row.clientWidth&&row.label.length>0);
 // Native controls participate in real keyboard tab order and retain their
 // visible focus ring; Escape still returns through the reader's own disclosure.
 await page.locator('#reading-layout').focus();await page.keyboard.press('Tab');await expect(page.locator('#reading-measure')).toBeFocused();
 await page.keyboard.press('Tab');await expect(page.locator('#reading-theme')).toBeFocused();
 check(name+'_visible_focus_ring',await page.locator('#reading-theme').evaluate(node=>{const style=getComputedStyle(node);return style.outlineStyle!=='none'&&parseFloat(style.outlineWidth)>=2;}));
}
async function saved(){await page.evaluate(()=>libraryStore.flush());return page.evaluate(()=>readPersistedLibrary());}
try{
 server=createServer(async(req,res)=>{
  if(req.method!=='GET'&&req.method!=='HEAD'){mutations++;res.writeHead(405).end();return;}
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  if(!/^[a-z-]+\.(html|js|css|png)$/.test(name)){res.writeHead(404).end();return;}
  try{res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'});res.end(await fs.readFile(path.join(root,'reader',name)));}catch{res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1360,height:1000},colorScheme:'dark',serviceWorkers:'block'});
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin||['blob:','data:'].includes(url.protocol))await route.continue();else{external++;await route.abort();}});
 page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);await page.goto(origin);
 check('new_reader_remains_light_on_dark_OS',await page.locator('html').getAttribute('data-reader-theme')==='light');
 const doc=splitCueFixture(180);doc.title='阅读外观 · 自写双语长文';delete doc.readingPosition;
 await page.locator('#file').setInputFiles({name:'authored-appearance.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});
 await expect(page.locator('#passage-workspace')).toBeVisible();const original=await saved();
 const prose=await page.locator('#passage-body').textContent();
 for(const width of [1360,390,360,320]){
  await page.setViewportSize({width,height:900});await page.evaluate(()=>scrollTo(0,0));
  // Log the real layout before asserting so a failure retains useful geometry.
  const geometry=await page.evaluate(()=>Object.fromEntries([
   ['source','.passage-original'],['header','main > header'],['title','#reader-title-slot #title'],
   ['utility','#reading-utility'],['export','#export-menu > summary'],['settings','#reading-info > summary'],
   ['translation','#passage-toggle-translation'],['search','#passage-search'],['keyboard','#keyboard-help-open'],['media','#toggle-reader-media']
  ].map(([name,selector])=>{const node=document.querySelector(selector),rect=node.getBoundingClientRect();return [name,{top:rect.top,left:rect.left,right:rect.right,width:rect.width,height:rect.height}];})));
  evidence.push({name:'default_'+width+'_geometry',geometry});console.log(JSON.stringify({suite:'reading-appearance',name:'default_'+width+'_geometry',geometry}));
  check('default_'+width+'_source_within_350px',await page.locator('.passage-original').first().evaluate(n=>{const top=n.getBoundingClientRect().top;return top>=0&&top<=350;}));
  for(const name of ['export','settings','translation','search','keyboard','media']){
   const rect=geometry[name];check('default_'+width+'_'+name+'_touch_target',rect.width>=44&&rect.height>=44&&rect.left>=0&&rect.right<=width);
  }
  await noOverflow('default_'+width+'_no_overflow');await capture('default-light-'+width);
 }
 await page.setViewportSize({width:1360,height:1000});await settings();await controls('desktop_preferences');
 const sourceWidth=await page.locator('.passage-columns').first().evaluate(n=>n.getBoundingClientRect().width);
 await page.locator('#reading-measure').selectOption('narrow');
 check('narrow_reduces_parallel_line_measure',await page.locator('.passage-columns').first().evaluate(n=>n.getBoundingClientRect().width)<sourceWidth);
 await page.locator('#reading-layout').selectOption('large');const large=await page.locator('.passage-original').first().evaluate(n=>({size:parseFloat(getComputedStyle(n).fontSize),leading:parseFloat(getComputedStyle(n).lineHeight)}));
 await page.locator('#reading-layout').selectOption('spacious');const spacious=await page.locator('.passage-original').first().evaluate(n=>({size:parseFloat(getComputedStyle(n).fontSize),leading:parseFloat(getComputedStyle(n).lineHeight)}));
 check('spacious_adds_leading_without_shrinking_text',spacious.size>=large.size&&spacious.leading>large.leading);
 await page.locator('#reading-theme').selectOption('dark');
 await contrast('dark_settings',['#reading-theme','#reading-measure','#reading-layout','.reading-appearance .hint','#appearance-status','#close-reading-info']);await capture('dark-settings-desktop');
 await page.keyboard.press('Escape');await expect(page.locator('#reading-info > summary')).toBeFocused();await contrast('dark_bilingual',['.passage-original','.passage-translation','.passage-speaker','.passage-ask','#reading-info > summary']);
 check('appearance_does_not_rewrite_or_drop_source',await page.locator('#passage-body').textContent()===prose);check('appearance_does_not_change_stored_document',JSON.stringify(await saved())===JSON.stringify(original));
 await capture('dark-spacious-narrow-desktop');
 for(const width of [640,390,360,320]){
  await page.setViewportSize({width,height:width===640?480:900});await page.evaluate(()=>scrollTo(0,0));await noOverflow('dark_'+width+'_no_overflow');await capture('dark-spacious-'+width);
  await settings();await controls('mobile_'+width+'_preferences');await noOverflow('settings_'+width+'_no_overflow');await capture('dark-settings-'+width);await closeSettings();
 }
 // Preference changes never replace the media element, seek it, or start it.
 await page.locator('#toggle-reader-media').click();
 const [mediaChooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#attach-reader-media').click()]);
 await mediaChooser.setFiles({name:'authored-tone.wav',mimeType:'audio/wav',buffer:authoredAudioFixture(180)});
 await page.waitForFunction(()=>{const p=document.querySelector('#source-media audio');return p&&p.readyState>=2&&p.duration===180;});
 await page.locator('#source-media audio').evaluate(p=>{window.appearancePlayer=p;p.currentTime=24;});
 await settings();await page.locator('#reading-theme').selectOption('light');await page.locator('#reading-theme').selectOption('dark');await closeSettings();
 check('theme_retains_paused_player_and_time',await page.evaluate(()=>appearancePlayer===document.querySelector('#source-media audio')&&appearancePlayer.paused&&Math.abs(appearancePlayer.currentTime-24)<.1));
 // Real modal focus and its dark source preview.
 await page.locator('.passage-ask').first().click();await expect(page.locator('#passage-question-dialog')).toBeVisible();
 await contrast('dark_question_dialog',['#passage-question-dialog h2','#passage-question-preview p','#ai-question','#close-passage-question']);
 await capture('dark-question-dialog-320');await page.keyboard.press('Escape');await expect(page.locator('.passage-ask').first()).toBeFocused();
 // A note remains editable on its original cue in the same scheme.
 await page.locator('#mode-transcript').click();await page.locator('.segment .note-button').first().click();await page.locator('#note').fill('自写笔记：深色与窄栏不会改变我的想法。');
 await contrast('dark_note_editor',['#notes-panel h2','#quote','#note','#close-note']);await noOverflow('dark_note_editor_320_no_overflow');await capture('dark-note-320');await page.locator('#close-note').click();await saved();
 await page.locator('#mode-passages').click();
 await settings();await page.locator('#reading-theme').selectOption('system');await closeSettings();await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-reader-theme','light');
 await page.emulateMedia({colorScheme:'dark'});await expect(page.locator('html')).toHaveAttribute('data-reader-theme','dark');
 await page.reload();check('refresh_restores_system_spacious_narrow',await page.evaluate(()=>document.getElementById('reading-theme').value==='system'&&document.documentElement.dataset.readerTheme==='dark'&&document.documentElement.dataset.readingLayout==='spacious'&&document.documentElement.dataset.readingMeasure==='narrow'));
 // Second-window preference changes propagate without library writes.
 const other=await context.newPage();await other.goto(origin);await other.evaluate(()=>localStorage.setItem('coconut-reading-theme-v1','light'));await expect(page.locator('html')).toHaveAttribute('data-reader-theme','light');await other.close();
 await settings();await page.locator('#reading-layout').selectOption('standard');await page.locator('#reading-measure').selectOption('full');await page.locator('#reading-theme').selectOption('light');await closeSettings();
 await page.reload();await page.evaluate(()=>scrollTo(0,0));check('default_restore_returns_source_budget',await page.locator('.passage-original').first().evaluate(n=>{const top=n.getBoundingClientRect().top;return top>=0&&top<=350;}));await capture('restored-light-320');
 check('no_external_requests_or_mutations',external===0&&mutations===0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({suite:'reading-appearance',status:'passed',checks,evidence},null,2));
}catch(error){if(page)await capture('failed-'+stage.replace(/[^a-z0-9-]/gi,'-')).catch(()=>{});console.error(JSON.stringify({suite:'reading-appearance',status:'failed',stage,error:error.stack,checks,evidence,errors},null,2));process.exitCode=1;
}finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
