import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {installSavePipeline} from './helpers/save-pipeline.mjs';
const root=new URL('../',import.meta.url);

test('sample stays busy through the saved-summary intermediate state and unlocks only after bilingual render and scroll',async()=>{
 const w=new Window({url:'https://coconut.example/'});
 w.document.body.innerHTML=fs.readFileSync(new URL('reader/index.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{value:webcrypto});
 const pipeline=installSavePipeline(w);
 let signalWrite;
 const createAdapter=w.CoconutLibraryStore.createLegacyAdapter;
 w.CoconutLibraryStore.createLegacyAdapter=options=>{
  const adapter=createAdapter(options);
  return {...adapter,write(value,options){const pending=adapter.write(value,options);signalWrite?.();return pending;}};
 };
 w.eval(['summary','core','passages','passage-playback','app','language','podcasts'].map(name=>fs.readFileSync(new URL('reader/'+name+'.js',root),'utf8')).join('\n'));
 const $=id=>w.document.getElementById(id);
 let scrolls=0;$('title').scrollIntoView=()=>scrolls++;
 try{
  // Cover the first opening and both repeated openings used by static browser QA.
  for(let opening=0;opening<3;opening++){
   if(opening)$('demo-finish').click();
   await pipeline.store.flush();pipeline.hold();
   const reachedWrite=new Promise(resolve=>{signalWrite=resolve;});
   const before=scrolls,pending=$('sample').onclick();
   assert.equal($('sample').disabled,true);
   await reachedWrite;
   assert.equal($('sample').disabled,true);
   assert.equal($('demo-guide').hidden,false,'guide alone does not prove readiness');
   assert.equal($('transcript-layout').hidden,true,'source is hidden while add awaits its save');
   assert.equal($('summary-workspace').hidden,false);
   assert.equal(scrolls,before,'final title scroll has not happened');
   assert.ok(w.document.querySelector('.words'),'DOM presence does not prove visible source');
   signalWrite=null;pipeline.hold(false);pipeline.writes.at(-1).commit();await pending;
   assert.equal($('sample').disabled,false);
   assert.equal($('transcript-layout').hidden,false);
   assert.equal($('summary-workspace').hidden,true);
   assert.equal($('mode-bilingual').getAttribute('aria-pressed'),'true');
   assert.equal(w.document.querySelectorAll('.translation').length,3);
   assert.equal(scrolls,before+1,'button unlock follows final title scroll');
  }
 }finally{await w.happyDOM.close();}
});
