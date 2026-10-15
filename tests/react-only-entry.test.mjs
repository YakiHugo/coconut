import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, access} from 'node:fs/promises';

const removed = ['compatibility.html','react-preview.html','app.js','appearance.js','background-summary.js','jobs.js','language.js','podcasts.js','quotation.js','storage-bootstrap.js','style.css','transcript-navigator.js','translation-review.js','updates.js'];

test('React is the only reader entry and old renderers cannot silently return', async () => {
  for (const name of removed) await assert.rejects(access('reader/'+name), {code:'ENOENT'});
  const html = await readFile('reader/index.html','utf8');
  assert.match(html,/id="react-root"/);
  for (const match of html.matchAll(/(?:src|href)="([^"?]+)(?:\?[^"]*)?"/g)) {
    assert.ok(!removed.includes(match[1]), match[1]);
    await access('reader/'+match[1]);
  }
  for (const name of ['application','main','recovery']) {
    const source = await readFile('frontend/app/'+name+'.tsx','utf8');
    assert.doesNotMatch(source,/compatibility\.html|react-preview\.html/);
  }
  const build = await readFile('scripts/build-reader-ui.mjs','utf8');
  assert.doesNotMatch(build,/transcript-navigator/);
  assert.match(build,/frontend\/app\/main\.tsx/);
});

test('native menu readiness admits only the current React entry',async()=>{
  const menu=await readFile('desktop/file-menu.mjs','utf8');
  assert.doesNotMatch(menu,/compatibility\.html|CoconutStorageBootstrap|coconut-storage-ready/);
  assert.match(menu,/CoconutReactDesktopReady===true/);
  assert.match(menu,/coconut-react-desktop-ready/);
  // Removing the old ready event must preserve exact-document receipt checks.
  assert.match(menu,/current===generation/);
  assert.match(menu,/url===window\.webContents\.getURL\(\)\.split/);
});
