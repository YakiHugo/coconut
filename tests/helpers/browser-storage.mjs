/** Browser acceptance utilities: real selected-backend reads, no in-memory save evidence. */
import {chromium as nativeChromium} from '@playwright/test';
export {expect} from '@playwright/test';
export function storageAssertions(){
 window.readPersistedLibrary=async()=>{
  const backend=window.CoconutStorageBootstrap?.result?.backend;
  if(backend==='legacy')return JSON.parse(localStorage.getItem('coconut-reader-v1')||'{"documents":[]}');
  if(backend!=='indexeddb')return null;
  return new Promise((resolve,reject)=>{
   const open=indexedDB.open('coconut-reader-library-v1');open.onerror=()=>reject(open.error);
   open.onsuccess=()=>{
    const db=open.result,tx=db.transaction(['documents','catalog'],'readonly');
    const docs=tx.objectStore('documents').getAll(),catalog=tx.objectStore('catalog').getAll();
    tx.oncomplete=()=>{db.close();const rows=new Map(docs.result.map(row=>[row.key,row.payload]));resolve({documents:catalog.result.sort((a,b)=>a.order-b.order||(a.key<b.key?-1:a.key>b.key?1:0)).map(row=>rows.get(row.key))});};
    tx.onabort=()=>{db.close();reject(tx.error||new Error('Storage read aborted'));};
   };
  });
 };
 window.failContentWrites=()=>{
  if(window.CoconutStorageBootstrap?.result?.backend==='indexeddb'){
   const originals=new Map(['put','add','delete'].map(name=>[name,IDBObjectStore.prototype[name]]));
   window.restoreContentWrites=()=>{for(const [name,original] of originals)IDBObjectStore.prototype[name]=original;};
   for(const [name,original] of originals)IDBObjectStore.prototype[name]=function(...args){if(this.transaction.db.name==='coconut-reader-library-v1'&&this.name==='documents')throw new DOMException('Authored quota failure','QuotaExceededError');return original.apply(this,args);};
  }else{
   const original=Storage.prototype.setItem;window.restoreContentWrites=()=>{Storage.prototype.setItem=original;};Storage.prototype.setItem=function(key,value){if(this===localStorage&&key==='coconut-reader-v1')throw new DOMException('Authored quota failure','QuotaExceededError');return original.call(this,key,value);};
  }
 };
}
export async function installStorageAssertions(page){await page.addInitScript(storageAssertions);await page.evaluate(storageAssertions);}
export async function readerReady(page){await page.waitForFunction(()=>window.CoconutStorageBootstrap?.phase==='ready');if(await page.evaluate(()=>CoconutStorageBootstrap.result.backend)!=='indexeddb')throw new Error('Production browser journey unexpectedly fell back from IndexedDB');}
function wrapPage(page){
 if(page.__storageReadinessWrapped)return page;page.__storageReadinessWrapped=true;
 for(const method of ['goto','reload']){const original=page[method].bind(page);page[method]=async(...args)=>{const response=await original(...args);await readerReady(page);return response;};}
 return page;
}
export const chromium={async launch(options){
 const browser=await nativeChromium.launch(options),newContext=browser.newContext.bind(browser),newPage=browser.newPage.bind(browser);
 browser.newContext=async options=>{const context=await newContext(options);await context.addInitScript(storageAssertions);const newPage=context.newPage.bind(context);context.newPage=async options=>wrapPage(await newPage(options));return context;};
 browser.newPage=async options=>{const page=await newPage(options);await page.addInitScript(storageAssertions);return wrapPage(page);};
 return browser;
}};
