/** Explicit fallback regression harness. Production defaults to IndexedDB.
 * These existing acceptance fixtures seed raw localStorage and inject its quota
 * failures; the independent indexeddb-library-browser suite proves native IDB.
 */
import {chromium as nativeChromium} from '@playwright/test';
export {expect} from '@playwright/test';
const fallback=()=>Object.defineProperty(window,'indexedDB',{configurable:true,value:undefined});
function wrapPage(page){
 if(page.__legacyReadinessWrapped)return page;page.__legacyReadinessWrapped=true;
 for(const method of ['goto','reload']){const original=page[method].bind(page);page[method]=async(...args)=>{const response=await original(...args);await page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready');if(await page.evaluate(()=>CoconutStorageBootstrap.result.backend)!=='legacy')throw new Error('Legacy fallback fixture unexpectedly selected another storage backend');return response;};}
 return page;
}
export const chromium={async launch(options){
 const browser=await nativeChromium.launch(options),newContext=browser.newContext.bind(browser),newPage=browser.newPage.bind(browser);
 browser.newContext=async options=>{const context=await newContext(options);await context.addInitScript(fallback);const newPage=context.newPage.bind(context);context.newPage=async options=>wrapPage(await newPage(options));return context;};
 browser.newPage=async options=>{const page=await newPage(options);await page.addInitScript(fallback);return wrapPage(page);};
 return browser;
}};
