import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

test('the shipped React stylesheet supplies an effective dark root palette after shell styles', async () => {
 const win=new Window();
 try {
  const css=await Promise.all(['frontend/reader-workspace/workspace.css','frontend/reading-preferences/preferences.css','frontend/app/style.css'].map(file=>readFile(file,'utf8')));
  const style=win.document.createElement('style');style.textContent=css.join('\n');win.document.head.append(style);
  const root=win.document.documentElement;
  root.dataset.readerTheme='light';assert.equal(win.getComputedStyle(root).backgroundColor,'#fafaf9');assert.equal(win.getComputedStyle(root).color,'#202124');
  root.dataset.readerTheme='dark';assert.equal(win.getComputedStyle(root).backgroundColor,'#191a1d');assert.equal(win.getComputedStyle(root).color,'#ededee');
  root.dataset.readerTheme='light';assert.equal(win.getComputedStyle(root).backgroundColor,'#fafaf9');
  // Descendant :is() specificity is not modeled reliably by happy-dom. Actual
  // shell/control/reader/system-theme computed colors are tested in Chromium
  // by react-reading-palette-browser.mjs, rather than faking browser evidence.
 } finally {await win.happyDOM.close();}
});
