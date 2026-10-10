/** Real Chromium acceptance of authored cross-document search and keyboard navigation.
 * No model, media, third-party text, or external network calls are used.
 * Run in CI or an explicitly permitted browser environment. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
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
  check('no_network_side_effects_or_script_errors',external===0&&mutations===0&&errors===0);
  console.log(JSON.stringify({checks},null,2));
} catch(error){console.error('Library search acceptance failed at '+stage);throw error;}
finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
