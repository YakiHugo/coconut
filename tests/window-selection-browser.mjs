/** CI-only Chromium proof with authored fixtures. Do not run in a browser-denied
 * environment. Two real same-origin pages share content, but not selection. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {openCueActions} from './cue-actions-browser.mjs';

const root = new URL('../reader/', import.meta.url);
const KEY = 'coconut-reader-v1', ACTIVE_KEY = 'coconut-reader-active-v1';
const LAST_ACTIVE_KEY = 'coconut-reader-last-active-v1';
const source = title => ({title, language:'en', segments:[
 {id:'cue', start:0, end:4, text:'An authored opening sentence for ' + title + '.'},
 {id:'next', start:4, end:8, text:'A second authored sentence for independent window navigation.'},
]});
const checks = [];
let browser, server, stage = 'setup', external = 0, mutations = 0, pageErrors = 0;
function check(name, value) { assert.ok(value, name); checks.push(name); }
const stored = async page => {await page.evaluate(()=>libraryStore.flush());return page.evaluate(key => localStorage.getItem(key), KEY);};
const selected = page => page.evaluate(key => sessionStorage.getItem(key), ACTIVE_KEY);
const counts = page => page.evaluate(() => ({...window.selectionProbe}));
const resetCounts = page => page.evaluate(() => {
 window.selectionProbe.librarySerializations = 0;
 window.selectionProbe.contentWrites = 0;
});

async function expectSelection(page, doc) {
 await page.waitForFunction(title => document.getElementById('title').textContent === title, doc.title);
 await page.locator('#reader-workspace').waitFor({state:'visible'});
 assert.equal(await selected(page), doc.key, 'window selection must be the raw document key');
}
async function importDocument(page, title) {
 await page.locator('#file').setInputFiles({name:title + '.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify(source(title)))});
 await page.waitForFunction(title => document.getElementById('title').textContent === title && document.getElementById('file').files.length === 0, title);
 const library = JSON.parse(await stored(page));
 assert.deepEqual(Object.keys(library), ['documents'], 'new content writes must omit window selection');
 const doc = library.documents.find(item => item.title === title);
 assert.ok(doc, 'imported document must be saved');
 await expectSelection(page, doc);
 return doc;
}
async function showLibrary(page) {
 if (!await page.locator('#library').isVisible()) await page.locator('#toggle-library').click();
}
async function navigate(page, other, doc, name) {
 const disk = await stored(page);
 const otherSnapshot = other && await other.evaluate(key => ({
  title:document.getElementById('title').textContent,
  selected:sessionStorage.getItem(key),
  note:document.getElementById('note').value,
  noteHidden:document.getElementById('notes-panel').hidden,
  warning:document.getElementById('save-status').textContent,
 }), ACTIVE_KEY);
 await resetCounts(page);
 if (other) await resetCounts(other);
 await showLibrary(page);
 await page.locator('#library button').filter({has:page.locator('.library-title', {hasText:doc.title})}).click();
 await expectSelection(page, doc);
 assert.equal(await page.evaluate(key => localStorage.getItem(key), LAST_ACTIVE_KEY), doc.key, name + ': the restart default must remain a lightweight raw key');
 assert.equal(await stored(page), disk, name + ': content storage must be byte-for-byte unchanged');
 assert.deepEqual(await counts(page), {librarySerializations:0, contentWrites:0}, name + ': navigation must neither serialize the library nor write content');
 if (other) {
  assert.deepEqual(await counts(other), {librarySerializations:0, contentWrites:0}, name + ': the other page must not serialize or write content');
  assert.deepEqual(await other.evaluate(key => ({
   title:document.getElementById('title').textContent,
   selected:sessionStorage.getItem(key),
   note:document.getElementById('note').value,
   noteHidden:document.getElementById('notes-panel').hidden,
   warning:document.getElementById('save-status').textContent,
  }), ACTIVE_KEY), otherSnapshot, name + ': the other window and its open note must be untouched');
 }
 check(name, true);
}
async function cleanReload(page, doc) {
 const dialogs = [];
 const unexpected = async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); };
 page.on('dialog', unexpected);
 let failure;
 try { await page.reload({waitUntil:'load', timeout:15000}); }
 catch (error) { failure = error; }
 finally { page.off('dialog', unexpected); }
 assert.deepEqual(dialogs, [], 'saved content and navigation must allow a clean reload');
 if (failure) throw failure;
 await expectSelection(page, doc);
}
async function openNote(page) {
 // This reading-only entry does not change the saved translation preference.
 await page.locator('#summary-open-transcript').click();
 await page.locator('.note-button').first().click();
}
async function downloadJSON(page, wholeLibrary = false) {
 if (wholeLibrary) {
  await showLibrary(page);
  const details = page.locator('.library-backup');
  if (!await details.evaluate(node => node.open)) await details.locator('summary').click();
 } else if (!await page.locator('#export-menu').evaluate(node => node.open)) {
  await page.locator('#export-menu > summary').click();
 }
 const [download] = await Promise.all([
  page.waitForEvent('download'), page.locator(wholeLibrary ? '#export-library' : '#export').click(),
 ]);
 assert.equal(await download.failure(), null, 'the real browser download must finish');
 const stream = await download.createReadStream();
 assert.ok(stream, 'downloaded bytes must be readable');
 const chunks = [];
 for await (const chunk of stream) chunks.push(chunk);
 const bytes = Buffer.concat(chunks);
 return {bytes, name:download.suggestedFilename(), data:JSON.parse(bytes.toString('utf8'))};
}
async function restoreLibrary(page, download, doc) {
 await page.locator('#library-file').setInputFiles({name:download.name, mimeType:'application/json', buffer:download.bytes});
 await page.waitForFunction(() => document.getElementById('library-file').files.length === 0);
 await expectSelection(page, doc);
 assert.deepEqual(Object.keys(JSON.parse(await stored(page))), ['documents']);
 assert.equal(await page.locator('#save-status').getAttribute('data-state'), 'saved', 'restore must be durably saved');
}

try {
 server = createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { mutations++; res.writeHead(405).end(); return; }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(filename)) {
   res.writeHead(404, {'Content-Type':'application/json'}).end('{"error":"static only"}'); return;
  }
  try {
   const body = await fs.readFile(new URL(filename, root));
   const type = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.png') ? 'image/png' : 'text/html';
   res.writeHead(200, {'Content-Type':type}).end(body);
  } catch { res.writeHead(404).end(); }
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const origin = 'http://127.0.0.1:' + server.address().port;
 browser = await chromium.launch({headless:true, ...(process.env.COCONUT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE} : {})});
 const newContext = async () => {
  const context = await browser.newContext({viewport:{width:1360, height:1000}, serviceWorkers:'block'});
  await context.route('**/*', async route => {
   const url = new URL(route.request().url());
   if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) await route.continue();
   else { external++; await route.abort(); }
  });
  await context.addInitScript(({key}) => {
   const probe = window.selectionProbe = {librarySerializations:0, contentWrites:0};
   const stringify = JSON.stringify;
   JSON.stringify = function(value, ...args) {
    // Count both the storage envelope and the separate document-array dirty
    // snapshot. A no-op setItem optimization alone must not satisfy this test.
    const envelope = value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'documents');
    const documents = Array.isArray(value) && value.length > 0 && value.every(doc =>
     doc && typeof doc === 'object' && Array.isArray(doc.segments));
    if (envelope || documents) probe.librarySerializations++;
    return Reflect.apply(stringify, this, [value, ...args]);
   };
   const setItem = Storage.prototype.setItem;
   Storage.prototype.setItem = function(name, value) {
    if (this === localStorage && String(name) === key) probe.contentWrites++;
    return Reflect.apply(setItem, this, [name, value]);
   };
  }, {key:KEY});
  return context;
 };
 const newPage = async context => {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', () => pageErrors++);
  await page.goto(origin);
  await page.locator('#sample').waitFor({state:'attached'});
  return page;
 };

 const context = await newContext(), a = await newPage(context);
 stage = 'authored_imports_and_probe_calibration';
 const alpha = await importDocument(a, 'Window Alpha');
 const beta = await importDocument(a, 'Window Beta');
 const initialCounts = await counts(a);
 check('instrumentation_detects_real_content_serialization_and_writes', initialCounts.librarySerializations >= 4 && initialCounts.contentWrites >= 2);
 check('explicit_import_selects_raw_window_key_and_content_omits_active', await selected(a) === beta.key);

 stage = 'legacy_startup_and_window_precedence';
 const legacy = JSON.stringify({...JSON.parse(await stored(a)), active:beta.key});
 // Seed a real pre-migration library once, before both pages read their baseline.
 await a.evaluate(({key, activeKey, lastActiveKey, legacy}) => {
  localStorage.setItem(key, legacy); sessionStorage.removeItem(activeKey); localStorage.removeItem(lastActiveKey);
 }, {key:KEY, activeKey:ACTIVE_KEY, lastActiveKey:LAST_ACTIVE_KEY, legacy});
 await cleanReload(a, beta);
 const b = await newPage(context);
 await expectSelection(b, beta);
 check('legacy_active_is_a_startup_fallback_without_rewriting_content', await stored(a) === legacy);
 await openNote(b);
 for (const [index, doc] of [alpha, beta, alpha, beta, alpha].entries()) {
  await navigate(a, b, doc, 'pure_navigation_' + (index + 1) + '_does_zero_library_work');
 }
 await cleanReload(a, alpha);
 check('window_selection_wins_over_legacy_active_on_reload', await stored(a) === legacy && await selected(b) === beta.key);

 stage = 'navigation_does_not_block_other_window_save';
 await resetCounts(b);
 await b.locator('#note').fill('A saved note in window B after window A navigated.');
 const afterBSave = JSON.parse(await stored(b));
 assert.deepEqual(Object.keys(afterBSave), ['documents']);
 assert.equal(afterBSave.documents.find(doc => doc.key === beta.key).notes.cue, 'A saved note in window B after window A navigated.');
 const savedCounts = await counts(b);
 check('other_window_content_save_is_real_and_not_a_conflict', savedCounts.contentWrites > 0 && savedCounts.librarySerializations > 0 && await b.locator('#save-status').getAttribute('data-state')==='saved');
 await cleanReload(a, alpha);
 await cleanReload(b, beta);
 check('both_windows_reload_their_own_selection_after_a_shared_content_save', await selected(a) === alpha.key && await selected(b) === beta.key);
 await openNote(b);
 check('other_window_note_survives_reload', await b.locator('#note').inputValue() === 'A saved note in window B after window A navigated.');
 await b.locator('#close-note').click();

 stage = 'new_window_default_and_existing_window_independence';
 await navigate(a, b, beta, 'navigation_before_new_window_beta_does_zero_library_work');
 await navigate(a, b, alpha, 'navigation_before_new_window_alpha_does_zero_library_work');
 const beforeNewWindow = await stored(a), newcomer = await newPage(context);
 await expectSelection(newcomer, alpha);
 await newcomer.close();
 await cleanReload(b, beta);
 await cleanReload(a, alpha);
 check('new_window_uses_last_selection_while_existing_windows_reload_their_own', await stored(a) === beforeNewWindow && await selected(a) === alpha.key && await selected(b) === beta.key);

 stage = 'actual_whole_library_download_and_restore';
 const sharedBeforeExport = await stored(a);
 const backupA = await downloadJSON(a, true), backupB = await downloadJSON(b, true);
 assert.equal(backupA.data.format, 'coconut-library');
 assert.equal(backupA.data.version, 1);
 assert.deepEqual(backupA.data.documents, JSON.parse(sharedBeforeExport).documents);
 assert.deepEqual(backupA.data.documents, backupB.data.documents);
 check('actual_library_downloads_include_each_exporting_windows_active', backupA.data.active === alpha.key && backupB.data.active === beta.key);
 assert.equal(await stored(a), sharedBeforeExport, 'export must not write active into shared content');
 await navigate(a, b, beta, 'navigation_before_restore_does_zero_library_work');
 await restoreLibrary(a, backupA, alpha);
 await cleanReload(a, alpha);
 check('explicit_restore_overrides_the_current_window_selection_and_survives_reload', await selected(b) === beta.key);
 const recoveryContext = await newContext(), recovery = await newPage(recoveryContext);
 await restoreLibrary(recovery, backupA, alpha);
 await cleanReload(recovery, alpha);
 check('actual_library_download_restores_active_and_documents_in_a_clean_browser', JSON.parse(await stored(recovery)).documents.length === backupA.data.documents.length);

 stage = 'explicit_import_overrides_window_selection';
 const gamma = await importDocument(a, 'Window Gamma');
 await cleanReload(a, gamma);
 check('a_new_import_overrides_an_existing_window_selection', await selected(b) === beta.key);

 stage = 'real_content_conflict_and_temporary_edits';
 await cleanReload(b, beta);
 await navigate(a, b, alpha, 'navigation_to_shared_edit_target_a_does_zero_library_work');
 await navigate(b, a, alpha, 'navigation_to_shared_edit_target_b_does_zero_library_work');
 await openNote(a);
 await openNote(b);
 await a.locator('#note').fill('Newest disk note written by window A.');
 const latestDisk = await stored(a);
 assert.equal(JSON.parse(latestDisk).documents.find(doc => doc.key === alpha.key).notes.cue, 'Newest disk note written by window A.');
 await b.locator('#note').fill('Temporary conflicting note kept in window B.');
 await b.waitForFunction(()=>document.getElementById('save-status').dataset.state==='failed');
 assert.match(await b.locator('#save-status').textContent(), /另一个页面|暂停/);
 assert.equal(await stored(b), latestDisk);
 await b.locator('#close-note').click();
 await openCueActions(b.locator('.segment').first());
 await b.locator('.edit-button').first().click();
 await b.locator('#edit-segment').fill('Temporary authored transcript correction in window B.');
 await b.locator('#save-edit').click();
 check('genuine_content_conflict_keeps_latest_disk_and_visible_temporary_work', await stored(b) === latestDisk && await b.locator('#save-status').getAttribute('data-state')==='failed');
 await navigate(b, a, beta, 'dirty_window_navigation_away_does_zero_library_work');
 await navigate(b, a, alpha, 'dirty_window_navigation_back_does_zero_library_work');
 const temporary = await downloadJSON(b);
 assert.equal(temporary.data.notes.cue, 'Temporary conflicting note kept in window B.');
 assert.equal(temporary.data.segments[0].text, 'Temporary authored transcript correction in window B.');
 assert.equal(temporary.data.segments[0].original_text, alpha.segments[0].text);
 check('actual_download_retains_temporary_note_and_correction_without_clearing_warning', await stored(b) === latestDisk && await b.locator('#save-status').getAttribute('data-state')==='failed');
 const latest = await downloadJSON(a);
 check('latest_disk_version_remains_independently_exportable', latest.data.notes.cue === 'Newest disk note written by window A.' && latest.data.segments[0].text === alpha.segments[0].text);

 stage = 'actual_temporary_download_recovery';
 await navigate(recovery, null, beta, 'clean_recovery_window_navigation_does_zero_library_work');
 await recovery.locator('#file').setInputFiles({name:temporary.name, mimeType:'application/json', buffer:temporary.bytes});
 await recovery.waitForFunction(() => document.getElementById('file').files.length === 0);
 const recovered = JSON.parse(await stored(recovery)).documents.find(doc => doc.segments[0].text === 'Temporary authored transcript correction in window B.');
 assert.ok(recovered, 'the actual temporary download must be importable');
 await expectSelection(recovery, recovered);
 await cleanReload(recovery, recovered);
 await openNote(recovery);
 check('downloaded_temporary_edits_recover_and_reload_with_the_imported_selection', await recovery.locator('#note').inputValue() === temporary.data.notes.cue && recovered.segments[0].original_text === alpha.segments[0].text);
 check('no_external_requests_mutations_or_page_errors', external === 0 && mutations === 0 && pageErrors === 0);
 console.log(JSON.stringify({suite:'window-reading-selection', status:'passed', checks}));
} catch (error) {
 console.error(JSON.stringify({suite:'window-reading-selection', status:'failed', stage, checks, error:error.message}));
 process.exitCode = 1;
} finally {
 await browser?.close();
 if (server) await new Promise(resolve => server.close(resolve));
}
