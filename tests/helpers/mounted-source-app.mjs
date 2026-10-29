import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const bundle=await readFile('reader/react-app.js','utf8'),page=await readFile('reader/index.html','utf8');
const scripts=await Promise.all([...page.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1].split('?')[0]).filter(name=>name!=='react-app.js').map(name=>readFile('reader/'+name,'utf8')));
export const wait=async check=>{for(let i=0;i<300;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.ok(check(),'UI did not settle');};
export async function mountedSourceApp(fixture,seed=[],{journal}={}){
 const w=new Window({url:'http://localhost/'});Object.defineProperty(w,'crypto',{value:webcrypto});w.structuredClone=structuredClone;w.document.body.innerHTML='<div id="react-root"></div>';
 if(journal)w.localStorage.setItem('coconut-react-ingestion-jobs-v1',JSON.stringify(journal));
 if(seed.length)w.localStorage.setItem('coconut-reader-v1',JSON.stringify({documents:seed,active:seed[0].key}));
 const receipts=[],requests=[];w.fetch=async(path,options)=>{if(path==='api/health')return {ok:true,json:async()=>({})};assert.equal(path,'api/v1/ingestions');const data=JSON.parse(options.body);requests.push(data);try{const result=await fixture.service.ingest(data,{signal:options.signal});receipts.push(result);return {ok:true,json:async()=>result};}catch(error){return {ok:false,json:async()=>({error:error.message})};}};
 for(const script of scripts)w.eval(script);const adapter=w.CoconutLibraryStore.createLegacyAdapter({getStorage:()=>w.localStorage,validate:w.Coconut.validate});w.CoconutStorageProvider={initialize:async()=>({ok:true,adapter,loaded:adapter.load()})};w.eval(bundle);await wait(()=>w.document.querySelector('#source-url'));
 const button=text=>[...w.document.querySelectorAll('button')].find(x=>x.textContent===text),input=(node,value)=>{Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new w.Event('input',{bubbles:true}));},select=(node,value)=>{node.value=value;node.dispatchEvent(new w.Event('change',{bubbles:true}));};
 const docs=()=>JSON.parse(w.localStorage.getItem('coconut-reader-v1')||'{"documents":[]}').documents;
 const open=url=>{input(w.document.querySelector('#source-url'),url);w.document.querySelector('#source-url').closest('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));};
 const discover=async()=>{button('添加内容').click();await wait(()=>w.document.querySelector('#source-url'));};
 return {w,fixture,requests,receipts,button,input,select,docs,open,discover};
}
