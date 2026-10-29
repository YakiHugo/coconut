import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

test('React saved and system themes change the actual shell, reader and control palette', async () => {
 const browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 try {
  const context=await browser.newContext({colorScheme:'dark'}),page=await context.newPage();
  // An authored document only: no provider, network, or project data is read.
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<html><head></head><body><div id="root"></div></body></html>'}));
  await page.goto('http://coconut.test');
  const styles=await Promise.all(['frontend/reader-workspace/workspace.css','frontend/reading-preferences/preferences.css','frontend/app/style.css'].map(file=>readFile(file,'utf8')));
  await page.addStyleTag({content:styles.join('\n')});
  const bundle=await build({stdin:{contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {ReadingPreferences,useReadingPreferences} from './frontend/reading-preferences/preferences';
    function App(){const controller=useReadingPreferences();return <><ReadingPreferences controller={controller}/><aside className="app-sidebar"><span className="sidebar-foot">Navigation</span><nav><button aria-current="page">Reader</button></nav></aside><main className="reader-workspace"><p className="rw-original">Source text</p><p className="rw-translation">Translation</p><div className="rw-player">Player</div><div className="rw-selection">Selection</div><textarea aria-label="Note"/><section className="react-ai-panel"><label>Model<select><option>Local</option></select></label><p>Details</p></section><dialog open>Dialog<input placeholder="Search"/></dialog></main></>;}createRoot(document.getElementById('root')).render(<App/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,format:'iife',define:{'process.env.NODE_ENV':'"production"'},write:false});
  await page.evaluate(()=>localStorage.setItem('coconut-reading-theme-v1','dark'));
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.waitForFunction(()=>document.documentElement.dataset.readerTheme==='dark');
  const palette=()=>page.evaluate(()=>Object.fromEntries(['html','body','.app-sidebar','.sidebar-foot','.rw-original','.rw-translation','.rw-player','.rw-selection','textarea','.react-ai-panel select','dialog','dialog input'].map(selector=>{const style=getComputedStyle(document.querySelector(selector));return [selector,{color:style.color,background:style.backgroundColor}];})));
  const dark=await palette();assert.equal(dark.html.background,'rgb(25, 26, 29)');assert.equal(dark.html.color,'rgb(237, 237, 238)');
  for(const selector of ['.app-sidebar','textarea','.react-ai-panel select','dialog','dialog input'])assert.equal(dark[selector].background,'rgb(36, 37, 42)',selector);
  assert.equal(dark['.rw-original'].color,dark.html.color);assert.equal(dark['.rw-translation'].color,'rgb(164, 165, 173)');assert.equal(dark['.rw-player'].background,dark.html.background);assert.equal(dark['.rw-selection'].background,'rgb(42, 51, 82)');
  await page.locator('.reading-preferences > summary').click();await page.locator('.reading-preferences label').filter({hasText:/^主题/}).locator('select').selectOption('light');
  const light=await palette();assert.equal(light.html.background,'rgb(250, 250, 249)');assert.notDeepEqual(light,dark);assert.equal(light['.app-sidebar'].background,'rgb(250, 250, 249)');
  await page.locator('.reading-preferences label').filter({hasText:/^主题/}).locator('select').selectOption('system');await page.waitForFunction(()=>document.documentElement.dataset.readerTheme==='dark');assert.deepEqual(await palette(),dark);
  await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>document.documentElement.dataset.readerTheme==='light');assert.deepEqual(await palette(),light);
  assert.equal(await page.evaluate(()=>localStorage.getItem('coconut-reading-theme-v1')),'system');
 } finally {await browser.close();}
});
