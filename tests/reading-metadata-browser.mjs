/** CI-only Chromium proof with authored fixtures, native input and real downloads.
 * No external source, AI request, browser installation or local execution needed. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import {chromium, waitForPersistedLibrary} from './helpers/browser-storage.mjs';
import {blankNote, writtenNote, readingMetadataFixture, audioMetadataFixture} from './helpers/reading-metadata-fixture.mjs';
const root = new URL('../reader/', import.meta.url), KEY = 'coconut-reader-v1';
const checks = []; let browser, server, stage = 'setup', external = 0, mutations = 0, errors = 0;
function check(name, value) {assert.ok(value, name); checks.push(name);}
try {
 server = createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {mutations++; res.writeHead(405).end(); return;}
  const pathname = new URL(req.url, 'http://localhost').pathname, filename = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[a-z-]+\.(html|js|css|webmanifest|png)$/.test(filename)) {res.writeHead(404, {'Content-Type': 'application/json'}).end('{"error":"static only"}'); return;}
  try {
   const body = await fs.readFile(new URL(filename, root));
   res.writeHead(200, {'Content-Type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.png') ? 'image/png' : 'text/html'}).end(body);
  } catch {res.writeHead(404).end();}
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const origin = 'http://127.0.0.1:' + server.address().port;
 browser = await chromium.launch({headless: true});
 async function open(width) {
  const context = await browser.newContext({acceptDownloads: true, serviceWorkers: 'block', viewport: {width, height: 900}});
  await context.route('**/*', async route => {
   const u = new URL(route.request().url());
   if (u.origin === origin || ['blob:', 'data:'].includes(u.protocol)) await route.continue();
   else {external++; await route.abort();}
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', () => errors++);
  await page.goto(origin); await page.locator('#import').waitFor({state: 'visible'}); return page;
 }
 async function choose(page, fixture) {
  if (await page.locator('#add-content').isVisible()) await page.locator('#add-content').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#import').click()]);
  await chooser.setFiles({name: 'authored.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(title => document.getElementById('title').textContent === title && !document.getElementById('reader-workspace').hidden, fixture.title);
  await page.waitForFunction(() => document.getElementById('file').value === '');
 }
 async function download(page, selector) {
  if (!await page.locator('#export-menu').evaluate(node => node.open)) await page.locator('#export-menu > summary').click();
  const [item] = await Promise.all([page.waitForEvent('download'), page.locator(selector).click()]);
  const stream = await item.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(await item.failure(), null);
  await page.locator('#export-menu > summary').click();
  return Buffer.concat(chunks).toString('utf8');
 }
 const active = async page => {return page.evaluate(async key => {const state = (await readPersistedLibrary()); return state.documents.find(doc => doc.key === sessionStorage.getItem('coconut-reader-active-v1'));}, KEY);};
 for (const width of [1360, 390]) {
  const page = await open(width), label = width === 390 ? 'mobile' : 'desktop';
  const fixture = readingMetadataFixture(); stage = label + '_overlap';
  await choose(page, fixture);
  check(label + '_all_duration_consumers', await page.locator('#subtitle').textContent() === '4 个片段 · 02:05 · 原话与笔记保存在本机' && await page.locator('#overview-duration').textContent() === '02:05 · 4 段' && await page.locator('#passage-total-time').textContent() === '02:05' && (await page.locator('#library').textContent()).includes('02:05 · 1 则片段笔记'));
  check(label + '_note_and_export_counts', await page.locator('#note-count').textContent() === '1' && await page.locator('#export-notebook').textContent() === '导出阅读笔记（2 段）');
  const json = JSON.parse(await download(page, '#export'));
  assert.deepEqual(json.notes, fixture.notes);
  assert.deepEqual(json.segments.map(({id, start, end}) => ({id, start, end})), fixture.segments.map(({id, start, end}) => ({id, start, end})));
  check(label + '_json_preserves_raw_unicode_and_timing', true);
  const markdown = await download(page, '#export-notebook');
  check(label + '_markdown_matches_counts', markdown.includes('2 个片段') && (markdown.match(/我的笔记：/g) || []).length === 1 && !markdown.includes(blankNote));
  await page.locator('#mode-transcript').click(); await page.locator('#filter-notes').click();
  assert.equal(await page.locator('#transcript .segment').count(), 1);
  await page.locator('.note-button').click(); stage = label + '_typing';
  const typedBlank = blankNote.replace(/\r\n/g, '\n');
  for (let attempt = 0; attempt < 2; attempt++) {
   await page.locator('#note').fill(typedBlank);
   check(label + '_blank_transition_' + attempt, await page.locator('#note-count').textContent() === '0' && await page.locator('#transcript .segment').count() === 0 && (await page.locator('#search-status').textContent()).includes('找到 0 个片段') && await page.locator('#note').evaluate(node => node === document.activeElement));
   await page.locator('#note').fill(writtenNote);
   assert.equal(await page.locator('#transcript .segment').count(), 1);
   assert.equal(await page.locator('#note-count').textContent(), '1');
  }
  await page.locator('#note').fill(typedBlank); await page.locator('#close-note').click();
  check(label + '_close_after_disappearing_result', await page.locator('#notes-panel').isHidden() && await page.locator('#filter-notes').evaluate(node => node === document.activeElement));
  await page.locator('#filter-all').click(); await page.locator('.segment[data-segment-id="last"] .note-button').click();
  await page.locator('#note').fill('A different note'); await page.locator('#close-note').click();
  check(label + '_next_note_remains_clickable', await page.locator('#note-count').textContent() === '1' && await page.locator('.segment[data-segment-id="last"] .saved-note').textContent() === 'A different note');
  await page.locator('#mode-passages').click();
  check(label + '_passage_annotations_agree', await page.locator('.passage-annotation').count() === 2 && (await page.locator('.passage-annotation[data-cue-id="excerpt"]').textContent()).includes('已摘录原文'));
  // Note rendering is immediate; reload only after the exact input generations
  // have reached the selected durable backend, preserving raw Unicode and cues.
  const persistedNotes = {...fixture.notes, noted: typedBlank, last: 'A different note'};
  await waitForPersistedLibrary(page, async expected => {
   const doc = (await readPersistedLibrary()).documents.find(doc => doc.key === expected.key);
   return JSON.stringify(doc?.notes) === JSON.stringify(expected.notes) &&
    JSON.stringify(doc?.segments.map(({id, start, end, text}) => ({id, start, end, text}))) === JSON.stringify(expected.cues);
  }, {key: await page.evaluate(() => sessionStorage.getItem('coconut-reader-active-v1')), notes: persistedNotes,
   cues: fixture.segments.map(({id, start, end, text}) => ({id, start, end, text}))});
  await page.reload(); await page.locator('#reader-workspace').waitFor({state: 'visible'});
  assert.equal((await active(page)).notes.wide, blankNote);
  assert.equal((await active(page)).notes.noted, typedBlank);
  assert.deepEqual((await active(page)).notes, persistedNotes);
  assert.equal(await page.locator('#note-count').textContent(), '1');
  check(label + '_reload_preserves_presence_and_original_whitespace', true);
  stage = label + '_audio'; await choose(page, audioMetadataFixture());
  check(label + '_audio_metadata', (await page.locator('#library').textContent()).includes('03:10 · 0 则项目笔记 · 2 个时间书签') && await page.locator('#export-notebook').textContent() === '导出原声项目笔记（2 项）');
  const audioMarkdown = await download(page, '#export-notebook');
  check(label + '_empty_bookmark_remains_useful', (audioMarkdown.match(/时间书签（未填写笔记）/g) || []).length === 1 && !audioMarkdown.includes('## 项目笔记'));
  await page.locator('#project-note').fill('A project observation');
  check(label + '_project_note_count_updates', (await page.locator('#library').textContent()).includes('1 则项目笔记 · 2 个时间书签') && await page.locator('#export-notebook').textContent() === '导出原声项目笔记（3 项）');
  check(label + '_fits_viewport', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.context().close();
 }
 check('no_external_requests_mutations_or_page_errors', external === 0 && mutations === 0 && errors === 0);
 console.log(JSON.stringify({suite: 'reading-metadata', status: 'passed', checks}));
} catch (error) {
 console.error(JSON.stringify({suite: 'reading-metadata', status: 'failed', stage, checks, error: error.message})); process.exitCode = 1;
} finally {await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));}
