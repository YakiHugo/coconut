import assert from 'node:assert/strict';
import {chromium, expect} from '@playwright/test';
import {mkdtemp, cp, symlink, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startViteDevelopment} from '../scripts/dev.mjs';
import {serviceConfig} from '../server/config.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'coconut-vite-browser-'));
let started, browser;
try {
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {if(response.status() >= 400) console.error(response.status(),response.url());});
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  // First prove the real application boots through unbundled modules and the API.
  started = await startViteDevelopment({config:serviceConfig({COCONUT_PORT:'0',COCONUT_DATA_DIRECTORY:path.join(directory,'real-data')})});
  await page.goto(started.origin);
  await expect(page.getByRole('button',{name:'打开音频或视频文件',exact:true})).toBeVisible().catch(async error => {console.error({errors,body:await page.locator('body').innerText()});throw error;});
  await expect(page).toHaveURL(started.origin + '/#discover');
  await page.goto(started.origin + '/?entry=direct#unknown');
  await expect(page).toHaveURL(started.origin + '/?entry=direct#discover');
  await expect(page.getByRole('button',{name:'添加内容',exact:true})).toHaveAttribute('aria-current','page');
  const library = page.getByRole('button',{name:/我的内容/});
  await library.click();
  await expect(page).toHaveURL(started.origin + '/?entry=direct#library');
  await page.goBack();
  await expect(page.getByRole('button',{name:'添加内容',exact:true})).toHaveAttribute('aria-current','page');
  await page.goForward();
  await expect(library).toHaveAttribute('aria-current','page');
  const historyLength = await page.evaluate(() => history.length);
  await page.evaluate(() => { location.hash = '#read/missing'; });
  await expect(page).toHaveURL(started.origin + '/?entry=direct#library');
  assert.equal(await page.evaluate(() => history.length), historyLength + 1);
  await page.goto(started.origin + '/#read/%ZZ');
  await expect(page).toHaveURL(started.origin + '/#library');
  await expect(library).toHaveAttribute('aria-current','page');
  await page.goto(started.origin + '/#read');
  await expect(page).toHaveURL(started.origin + '/#library');
  assert.deepEqual(errors, []);
  await started.server.shutdown(); started = null;

  // A disposable React fixture proves edits retain component state, without
  // mutating repository sources or touching the user's library.
  const project = path.join(directory,'project');
  await mkdir(path.join(project,'frontend/app'),{recursive:true});
  await cp('reader',path.join(project,'reader'),{recursive:true});
  await cp('shared',path.join(project,'shared'),{recursive:true});
  await cp('vite.config.mjs',path.join(project,'vite.config.mjs'));
  await symlink(path.resolve('node_modules'),path.join(project,'node_modules'),'dir');
  await writeFile(path.join(project,'package.json'),'{"type":"module"}');
  const component = path.join(project,'frontend/app/counter.tsx');
  await writeFile(component, 'import {useState} from "react"; export default function Counter(){const [count,setCount]=useState(0);return <button onClick={()=>setCount(count+1)}>Before {count}</button>}');
  await writeFile(path.join(project,'frontend/app/main.tsx'),'import React from "react";import {createRoot} from "react-dom/client";import Counter from "./counter";import "./style.css";createRoot(document.getElementById("react-root")!).render(<Counter/>);');
  const css = path.join(project,'frontend/app/style.css');
  await writeFile(css,'button {color: rgb(200, 0, 0)}');
  started = await startViteDevelopment({projectRoot:project,readerDirectory:path.join(project,'reader'),config:serviceConfig({COCONUT_PORT:'0',COCONUT_DATA_DIRECTORY:path.join(directory,'fixture-data')})});
  await page.goto(started.origin);
  await page.getByRole('button',{name:'Before 0',exact:true}).click();
  await expect(page.getByRole('button',{name:'Before 1',exact:true})).toBeVisible();
  await page.evaluate(() => {window.__hmrDocumentMarker = 'retained';});
  await writeFile(component,(await readFile(component,'utf8')).replace('Before','After'));
  const button = page.getByRole('button',{name:'After 1',exact:true});
  await expect(button).toBeVisible();
  assert.equal(await page.evaluate(() => window.__hmrDocumentMarker),'retained');
  await writeFile(css,'button {color: rgb(0, 100, 0)}');
  await expect(button).toHaveCSS('color','rgb(0, 100, 0)');
  await expect(button).toHaveText('After 1');
  assert.deepEqual(errors, []);
  console.log('PASS actual React startup, same-origin API, React Fast Refresh state retention and CSS HMR.');
} finally {
  await browser?.close();
  await started?.server.shutdown();
  await rm(directory,{recursive:true,force:true});
}
