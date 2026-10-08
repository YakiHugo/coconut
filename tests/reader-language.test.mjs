import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {prepareTranslation} from '../desktop/translation.mjs';
const root=new URL('../',import.meta.url);
function setup(stored){
 const w=new Window({url:'http://127.0.0.1:8080/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});
 if(stored)w.localStorage.setItem('coconut-reader-v1',stored);
 w.fetch=async()=>{throw new Error('Import and language defaults must not make a request');};
 w.eval(['summary','core','app','language'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 return {w,$:id=>w.document.getElementById(id)};
}
async function importDocument(w,language,title='Regional source'){
 const doc={title,language,provenance:{kind:'publisher_transcript',language},segments:[{id:'one',start:0,end:5,text:'An authored transcript fixture.'}]};
 const input=w.document.getElementById('file'),text=JSON.stringify(doc);
 Object.defineProperty(input,'files',{configurable:true,value:[{name:'locale.json',size:text.length,text:async()=>text}]});
 await input.onchange();
}
const saved=w=>JSON.parse(w.localStorage.getItem('coconut-reader-v1'));

test('regional and script tags select supported languages without changing source provenance',async()=>{
 for(const [tag,base] of [['en-US','en'],['EN-gb','en'],['zh-cn','zh'],['zh-Hant-TW','zh'],['ja-JP','ja'],['ko-KR','ko'],['fr-CA','fr'],['de-DE','de'],['es-MX','es']]){
  const {w,$}=setup();try{
   await importDocument(w,tag);
   assert.equal($('translation-source').value,base,tag);
   assert.equal($('translation-target').value,base==='zh'?'en':'zh',tag);
   const doc=saved(w).documents[0];assert.equal(doc.language,tag);assert.equal(doc.provenance.language,tag);
   assert.equal($('ai-consent').checked,false);
  }finally{await w.happyDOM.close();}
 }
});

test('unknown, missing and malformed language tags still require an explicit source choice',async()=>{
 for(const tag of ['', 'pt-BR', 'invalid', 'en-us trailing', 'en/zh', 'en--US']){
  const {w,$}=setup();try{
   await importDocument(w,tag);assert.equal($('translation-source').value,'',tag);assert.equal(saved(w).documents[0].language,tag);
  }finally{await w.happyDOM.close();}
 }
});

test('manual targets survive renders and edits; only a new document removes a same-language default',async()=>{
 const {w,$}=setup();try{
  await importDocument(w,'en-US');$('translation-source').value='fr';$('translation-source').onchange();$('translation-target').value='ja';$('translation-target').onchange();
  w.dispatchEvent(new w.Event('coconut-render'));assert.equal($('translation-source').value,'fr');assert.equal($('translation-target').value,'ja');
  $('document-details').click();$('document-title').value='A new title';$('save-details').click();
  assert.equal($('translation-source').value,'fr');assert.equal($('translation-target').value,'ja');
  $('ai-consent').checked=true;$('document-details').click();$('document-language').value='ja';$('save-details').click();
  assert.equal($('translation-source').value,'ja');assert.equal($('translation-target').value,'ja','metadata edits must not change the chosen target');assert.equal($('ai-consent').checked,false);
  await importDocument(w,'fr-CA','Different source');assert.equal($('translation-source').value,'fr');assert.equal($('translation-target').value,'ja');
  await importDocument(w,'ja-JP','Japanese source');assert.equal($('translation-source').value,'ja');assert.equal($('translation-target').value,'zh');
 }finally{await w.happyDOM.close();}
});

test('regional source translation sends a valid base language only after consent and restores current provenance',async()=>{
 const {w,$}=setup();let snapshot;try{
  await importDocument(w,'en-US');const requests=[];
  w.fetch=async(url,options)=>({ok:true,json:async()=>{
   if(url.endsWith('language-tools'))return {local_translation:false,ai:{codex:{ready:true}}};
   assert.equal(url,'api/translate-subscription');const data=JSON.parse(options.body);prepareTranslation(data);requests.push(data);
   return {translations:data.segments.map(c=>({id:c.id,source_text:c.text,text:'供测试的译文。',context_version:2,input_revision:'a'.repeat(64),quality_warnings:[]}))};
  }});
  await $('check-ai').onclick();await $('subscription-translate').onclick();assert.equal(requests.length,0);
  $('ai-consent').checked=true;await $('subscription-translate').onclick();assert.equal(requests.length,1);assert.equal(requests[0].source,'en');assert.equal(requests[0].target,'zh');
  const doc=saved(w).documents[0],translation=doc.segments[0].translations.zh;
  assert.equal(doc.language,'en-US');assert.equal(translation.document_language,'en-US');assert.equal(translation.source_language,'en');assert.equal(w.Coconut.translationCurrent(doc.segments[0],doc,translation),true);
  snapshot=w.localStorage.getItem('coconut-reader-v1');
 }finally{await w.happyDOM.close();}
 const restored=setup(snapshot);try{
  assert.equal(restored.$('translation-source').value,'en');
  const doc=saved(restored.w).documents[0];assert.equal(restored.w.Coconut.translationCurrent(doc.segments[0],doc,doc.segments[0].translations.zh),true);
 }finally{await restored.w.happyDOM.close();}
});
