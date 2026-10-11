import {openLibraryTools} from './helpers/library-tools-browser.mjs';
/** Real Chromium acceptance of authored cross-document search and keyboard navigation.
 * No model, media, third-party text, or external network calls are used.
 * Run in CI or an explicitly permitted browser environment. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from './helpers/browser-storage.mjs';
import {splitCueFixture} from './helpers/split-cue-fixture.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
let server, browser, stage = 'setup';
const checks = [];
function check(name, passed) {stage = name; assert.ok(passed, name); checks.push(name);}
async function visibleCue(page, id) {
  await page.waitForFunction(id => {
    const element = [...document.querySelectorAll('#transcript .segment')].find(row => row.dataset.segmentId === id);
    if (!element || element !== document.activeElement) return false;
    const r = element.getBoundingClientRect();
    const previous = window.__librarySearchAuditPosition;
    const stable = previous?.id === id && Math.abs(previous.top - r.top) < 0.25 ? previous.stable + 1 : 0;
    window.__librarySearchAuditPosition = {id, top: r.top, stable};
    return stable >= 4 && r.top < innerHeight && r.bottom > 0;
  }, id);
}
try {
  server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {res.writeHead(405).end(); return;}
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(name)) {res.writeHead(404).end(); return;}
    try {
      const bytes = await fs.readFile(path.join(root, 'reader', name));
      const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/html';
      res.writeHead(200, {'Content-Type': type}).end(bytes);
    } catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true, ...(process.env.COCONUT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.COCONUT_CHROMIUM_EXECUTABLE} : {})});
  let external = 0, mutations = 0, errors = 0;
  async function context() {
    const context = await browser.newContext({acceptDownloads: true, viewport: {width: 1360, height: 1000}, serviceWorkers: 'block'});
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {mutations++; await route.abort(); return;}
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) await route.continue();
      else {external++; await route.abort();}
    });
    return context;
  }
  const first=await context(),page=await first.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>errors++);
  await page.goto(origin);
  async function openLibrary(options=false){
    if(!await page.locator('#library-search').isVisible())await page.locator('#toggle-library').click();
    await page.locator('#library-search').waitFor({state:'visible'});
    if(options)await openLibraryTools(page);
    if(options&&!await page.locator('#library-scope').isVisible())await page.locator('.library-options > summary').click();
    if(options)await page.locator('#library-scope').waitFor({state:'visible'});
  }

  const source=splitCueFixture();source.notes['split-1751']='Private <img src=x> needle';
  async function load(doc){await page.locator('#file').setInputFiles({name:'authored.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});await page.waitForFunction(title=>document.querySelector('#title').textContent===title,doc.title);}
  await load(source);const other=splitCueFixture(5);other.title='Another document';await load(other);
  await openLibrary(true);await page.locator('#library-scope').selectOption('text');await page.locator('#library-search').fill('crossing-marker');
  const hit=page.locator('.library-hit');await hit.waitFor();await hit.focus();await page.keyboard.press('Enter');await visibleCue(page,'split-1750');
  check('keyboard_source_hit_lands_on_real_late_cue',await page.locator('.segment[data-segment-id="split-1749"]').count()===1&&await page.locator('.segment').count()<=100);
  check('library_query_survives_open',await page.locator('#library-search').inputValue()==='crossing-marker');
  await openLibrary(true);await page.locator('#library-scope').selectOption('notes');await page.locator('#library-search').fill('<img');
  check('snippet_is_text_not_html',await page.locator('.library-hit img').count()===0&&await page.locator('.library-hit mark').textContent()==='<img');
  await page.locator('.library-hit').focus();await page.keyboard.press('Enter');
  check('note_hit_focuses_correct_editor',await page.locator('#note').evaluate(el=>el===document.activeElement&&el.value.includes('needle')));
  await page.locator('#close-note').click();
  const audio={project_kind:'audio_only',title:'Authored audio project',segments:[],project_note:'Needle project',timestamp_bookmarks:[{id:'stamp',time:3,note:'Needle bookmark'}],podcast_source:{feed_url:'https://example.com/feed',episode_id:'a'.repeat(64),media_url:'https://example.com/a.mp3',media_kind:'audio'}};
  await load(audio);await openLibrary();await page.locator('#library-search').fill('Needle bookmark');await page.locator('.library-hit').focus();await page.keyboard.press('Enter');
  check('audio_bookmark_hit_focuses_note_without_playback',await page.locator('#audio-bookmarks textarea').evaluate(el=>el===document.activeElement)&&await page.locator('audio').count()===0);
  await page.setViewportSize({width:390,height:844});await openLibrary(true);
  await page.locator('#library-scope').selectOption('notes');await page.locator('#library-search').fill('Needle project');
  await page.locator('.library-hit').focus();await page.keyboard.press('Enter');
  check('mobile_hit_focuses_project_note_and_collapses_library',await page.locator('#project-note').evaluate(el=>el===document.activeElement)&&await page.locator('#toggle-library').getAttribute('aria-expanded')==='false');
  await openLibrary(true);
  check('mobile_return_preserves_query_and_scope',await page.locator('#library-search').inputValue()==='Needle project'&&await page.locator('#library-scope').inputValue()==='notes');
  await page.locator('#library-search').fill('no matching content');
  check('mobile_empty_results_are_truthful',await page.locator('.library-hit').count()===0&&await page.locator('#library-empty').isVisible());
  stage='saved historical quotation setup';
  await page.setViewportSize({width:1360,height:1000});
  const historical=await page.evaluate(()=>{
    const doc={title:'Historical saved quotation owner',language:'en',segments:Array.from({length:40},(_,i)=>({id:'history-cue-'+i,start:i,end:i+1,text:'Historical savedneedle quotation '+i})),notes:Object.fromEntries(Array.from({length:40},(_,i)=>['history-cue-'+i,'savedneedle current note '+i]))};
    doc.exact_excerpts=Array.from({length:5},(_,i)=>Coconut.exactExcerptSnapshot(doc,[doc.segments[i]],[],0,doc.segments[i].text.length,{id:'history-'+i,createdAt:'2026-10-11T00:00:00.000Z'}));
    doc.exact_excerpt_notes={'history-0':'savedneedle private-history <img> thought'};
    doc.segments[0].text='Corrected source no longer contains the saved quotation';doc.segments.splice(1,1);delete doc.notes['history-cue-1'];return doc;
  });
  await load(historical);const keep=splitCueFixture(3);keep.title='Keep this reader active';await load(keep);
  await page.locator('#open-library-notebook').click();await page.locator('#notebook-kind').selectOption('note');await page.locator('#notebook-search').fill('old hidden query');await page.locator('#notebook-close').click();
  await openLibrary(true);await page.locator('#library-scope').selectOption('text');await page.locator('#library-search').fill('savedneedle');
  await page.locator('.library-saved-hit').first().waitFor();
  check('saved_and_current_previews_have_independent_three_item_caps',await page.locator('.library-hit').count()===3&&await page.locator('.library-saved-hit').count()===3&&/5/.test(await page.locator('.library-saved-more').textContent()));
  const saved=page.locator('.library-saved-hit[data-hit-id="history-0"]');await saved.focus();await page.keyboard.press('Enter');
  const historicalRow=page.locator('.notebook-capture[data-capture-id="history-0"]');
  await page.waitForFunction(()=>document.activeElement?.closest('.notebook-capture')?.dataset.captureId==='history-0');
  check('keyboard_saved_hit_resolves_second_page_and_expands_correct_capture',/^31–/.test(await page.locator('#notebook-status').textContent())&&await historicalRow.locator('.notebook-details').evaluate(el=>el.open)&&await historicalRow.locator('.notebook-details > summary').evaluate(el=>el===document.activeElement));
  check('historical_open_preserves_reader_and_never_starts_media',await page.locator('#title').textContent()==='Keep this reader active'&&await page.locator('audio,video').count()===0&&await page.locator('#notebook-kind').inputValue()==='all');
  check('corrected_snapshot_is_explicit_historical_evidence',/原文或出处已变化/.test(await historicalRow.textContent())&&await historicalRow.locator('.notebook-quote').textContent()==='Historical savedneedle quotation 0');
  await page.keyboard.press('Escape');await saved.waitFor();
  await page.waitForFunction(()=>document.activeElement?.dataset.hitId==='history-0');
  check('escape_restores_originating_saved_hit',await saved.evaluate(el=>el===document.activeElement));
  await page.locator('.library-saved-more').click();check('saved_continuation_keeps_complete_query_and_all_record_kinds',await page.locator('#notebook-search').inputValue()==='savedneedle'&&await page.locator('#notebook-kind').inputValue()==='all'&&/44/.test(await page.locator('#notebook-status').textContent()));await page.locator('#notebook-close').click();

  const screenshot=async name=>{if(process.env.COCONUT_UI_SCREENSHOTS){await fs.mkdir(process.env.COCONUT_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.COCONUT_UI_SCREENSHOTS,'library-saved-'+name+'.png'),animations:'disabled'});}};
  await page.setViewportSize({width:390,height:844});await openLibrary(true);await page.locator('#library-search').fill('Historical savedneedle quotation 1');
  const missing=page.locator('.library-saved-hit[data-hit-id="history-1"]');await missing.scrollIntoViewIfNeeded();
  check('narrow_saved_shelf_fits_viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await screenshot('390-shelf-missing-source');
  await missing.focus();await page.keyboard.press('Enter');const missingRow=page.locator('.notebook-capture[data-capture-id="history-1"]');
  await missingRow.waitFor();check('deleted_cue_still_opens_exact_saved_evidence',await missingRow.locator('.notebook-open').isDisabled()&&/原位置已删除/.test(await missingRow.textContent()));
  check('narrow_saved_details_fit_dialog',await page.locator('#library-notebook').evaluate(el=>el.scrollWidth<=el.clientWidth+1));await screenshot('390-expanded-missing-source');await page.locator('#notebook-close').click();

  await openLibrary(true);await page.locator('#library-scope').selectOption('notes');await page.locator('#library-search').fill('private-history');await page.locator('.library-saved-hit').click();
  await page.locator('.notebook-edit-exact-note').click();await page.locator('#exact-note-text').fill('replacement-history personal thought');await page.locator('#exact-note-save').click();
  await page.waitForFunction(()=>document.querySelector('#exact-note-status').textContent==='已保存到本机'&&document.querySelectorAll('.library-saved-hit').length===0);
  check('note_save_refreshes_shelf_while_editor_stays_open',await page.locator('#exact-note-dialog').evaluate(el=>el.open)&&await page.locator('#exact-note-text').inputValue()==='replacement-history personal thought');
  await page.locator('#exact-note-close').click();await page.locator('#notebook-close').click();await page.locator('#library-search').fill('replacement-history');await page.locator('.library-saved-hit').waitFor();
  await page.reload();await page.waitForFunction(()=>document.querySelector('#title').textContent==='Keep this reader active');await openLibrary(true);await page.locator('#library-scope').selectOption('notes');await page.locator('#library-search').fill('replacement-history');await page.locator('.library-saved-hit').waitFor();
  check('saved_note_search_survives_reload',await page.locator('.library-saved-hit').count()===1&&await page.locator('.library-saved-hit mark').textContent()==='replacement-history');
  await page.locator('.library-saved-hit').focus();await page.keyboard.press('Enter');await page.locator('.notebook-edit-exact-note').click();await page.locator('#exact-note-text').fill('');await page.locator('#exact-note-save').click();
  await page.waitForFunction(()=>document.querySelector('#exact-note-status').textContent==='已保存到本机'&&document.querySelectorAll('.library-saved-hit').length===0);
  check('removing_personal_note_removes_only_note_search_hit',await page.locator('#exact-note-dialog').evaluate(el=>el.open));await page.locator('#exact-note-close').click();await page.locator('#notebook-close').click();
  await openLibrary(true);await page.locator('#library-scope').selectOption('text');await page.locator('#library-search').fill('Historical savedneedle quotation 0');await page.locator('.library-saved-hit').waitFor();check('quotation_remains_searchable_after_note_removal',await page.locator('.library-saved-hit').count()===1);
  check('no_network_side_effects_or_script_errors',external===0&&mutations===0&&errors===0);
  console.log(JSON.stringify({checks},null,2));
} catch(error){console.error('Library search acceptance failed at '+stage);throw error;}
finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
