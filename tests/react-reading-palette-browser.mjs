import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

test('React themes apply the island palette and reading fonts apply to the prose', async () => {
 const browser=await chromium.launch({headless:true,...(process.env.COCONUT_CHROMIUM_EXECUTABLE?{executablePath:process.env.COCONUT_CHROMIUM_EXECUTABLE}:{})});
 try {
  const context=await browser.newContext({colorScheme:'dark',reducedMotion:'reduce'}),page=await context.newPage();
  // An authored document only: no provider, network, or project data is read.
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<html><head></head><body><div id="root"></div></body></html>'}));
  await page.goto('http://coconut.test');
  const styles=await Promise.all(['frontend/reader-workspace/workspace.css','frontend/reading-preferences/preferences.css','frontend/app/style.css','frontend/app/island-theme.css'].map(file=>readFile(file,'utf8')));
  await page.addStyleTag({content:styles.join('\n')});
  const bundle=await build({stdin:{contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {ReadingPreferences,useReadingPreferences} from './frontend/reading-preferences/preferences';
    function App(){const controller=useReadingPreferences();return <div className="react-app" data-workspace="read"><ReadingPreferences controller={controller}/><aside className="app-sidebar"><span className="sidebar-foot">Navigation</span><nav><button aria-current="page">Reader</button></nav></aside><main className="reader-workspace"><p className="rw-original">Source text</p><p className="rw-translation">Translation</p><div className="rw-player"><button className="rw-player-play">Play</button></div><div className="rw-selection">Selection</div><textarea aria-label="Note"/><section className="react-ai-panel"><label>Model<select><option>Local</option></select></label><p>Details</p></section><dialog open>Dialog<input placeholder="Search"/></dialog></main></div>;}createRoot(document.getElementById('root')).render(<App/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,format:'iife',define:{'process.env.NODE_ENV':'"production"'},write:false});
  await page.evaluate(()=>{
    localStorage.setItem('coconut-reading-theme-v1','dark');
    window.queryLocalFonts = () => new Promise(resolve => {
      window.finishFontListing = () => resolve([{family:'Songti SC'},{family:'Georgia'},{family:'Songti SC'}]);
    });
  });
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.waitForFunction(()=>document.documentElement.dataset.readerTheme==='dark');
  const palette=()=>page.evaluate(()=>Object.fromEntries(['.react-app','.app-sidebar','.app-sidebar nav','.app-sidebar [aria-current]','.sidebar-foot','.rw-original','.rw-translation','.rw-player','.rw-player-play','.rw-selection','textarea','.react-ai-panel select','dialog','dialog input'].map(selector=>{const style=getComputedStyle(document.querySelector(selector));return [selector,{color:style.color,background:style.backgroundColor}];})));
  const dark=await palette();
  assert.equal(dark['.react-app'].background,'rgb(26, 33, 25)');
  assert.equal(dark['.app-sidebar'].background,dark['.react-app'].background);
  for(const selector of ['.app-sidebar nav','textarea','.react-ai-panel select','dialog','dialog input'])assert.equal(dark[selector].background,'rgb(37, 50, 33)',selector);
  assert.equal(dark['.rw-original'].color,'rgb(238, 245, 233)');
  assert.equal(dark['.rw-translation'].color,'rgb(184, 197, 181)');
  assert.equal(dark['.rw-player'].background,dark['.app-sidebar [aria-current]'].background);
  assert.equal(dark['.rw-player-play'].background,'rgb(203, 231, 170)');
  assert.equal(dark['.rw-selection'].background,'rgb(53, 71, 47)');
  const theme=page.getByRole('combobox',{name:'主题',exact:true});await theme.press('Home');await theme.press('Enter');
  const light=await palette();
  assert.equal(light['.react-app'].background,'rgb(250, 251, 245)');
  assert.equal(light['.app-sidebar'].background,light['.react-app'].background);
  assert.equal(light['.rw-original'].color,'rgb(32, 52, 39)');
  assert.equal(light['.rw-player-play'].background,'rgb(40, 75, 52)');
  assert.notDeepEqual(light,dark);
  await theme.press('End');await theme.press('Enter');await page.waitForFunction(()=>document.documentElement.dataset.readerTheme==='dark');assert.deepEqual(await palette(),dark);
  await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>document.documentElement.dataset.readerTheme==='light');assert.deepEqual(await palette(),light);
  assert.equal(await page.evaluate(()=>localStorage.getItem('coconut-reading-theme-v1')),'system');

  const picker=page.getByRole('combobox',{name:'阅读字体',exact:true});
  const menu=page.getByRole('listbox',{name:'阅读字体',exact:true});
  const prose=page.locator('.rw-original');
  const defaultFont=await prose.evaluate(node=>getComputedStyle(node).fontFamily);
  await picker.press('End');
  await expect(page.getByText('正在读取本机字体…',{exact:true})).toBeVisible();
  await page.evaluate(()=>window.finishFontListing());
  await expect(menu.getByRole('option')).toHaveText(['默认✓','Georgia','Songti SC','自定义']);
  await expect(menu.locator('[data-active=true]')).toHaveText('自定义');
  await expect(page.locator('.reading-font input')).toHaveCount(0);
  await picker.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(picker).toBeFocused();
  await picker.click();
  await menu.getByRole('option',{name:'Songti SC',exact:true}).click();
  await expect(prose).toHaveCSS('font-family',/^"Songti SC",/);
  await expect(page.locator('.app-sidebar')).toHaveCSS('font-family',defaultFont);
  assert.equal(await page.evaluate(()=>localStorage.getItem('coconut-reading-font-family-v1')),'Songti SC');
  await picker.press('End');
  await picker.press('Enter');
  const custom=page.getByRole('textbox',{name:'自定义字体名称',exact:true});
  await custom.fill('Times New Roman');
  await expect(page.locator('.reading-font-preview')).toHaveCSS('font-family',/^"Times New Roman",/);
  await expect(prose).toHaveCSS('font-family',/^"Songti SC",/);
  await custom.press('Enter');
  await expect(prose).toHaveCSS('font-family',/^"Times New Roman",/);
  await picker.press('Home');
  await picker.press('Enter');
  await expect(prose).toHaveCSS('font-family',defaultFont);
 } finally {await browser.close();}
});
