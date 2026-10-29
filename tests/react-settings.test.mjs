import test from 'node:test';
import assert from 'node:assert/strict';
import {mountedSourceApp,wait} from './helpers/mounted-source-app.mjs';

test('the add surface contains only ingestion; preferences and recovery have one settings home',async()=>{
 const x=await mountedSourceApp({service:{ingest:async()=>{throw Error('No request expected');}}});
 try{
  const settings=x.w.document.querySelector('.app-settings'),main=x.w.document.querySelector('#main-content');
  assert.equal(settings.open,false);
  assert.equal(main.querySelector('.podcast-catalog,.reading-preferences,.recovery-entry,.storage-settings,.subtitle-recovery'),null);
  assert.ok(settings.querySelector('.reading-preferences'));
  assert.ok(settings.querySelector('.subtitle-recovery'));
  assert.ok(settings.querySelector('[data-native-command="backup-library"]'));
  settings.querySelector(':scope>summary').click();await wait(()=>settings.open&&main.inert);
  const theme=[...settings.querySelectorAll('label')].find(node=>node.textContent.startsWith('主题')).querySelector('select');
  x.select(theme,'dark');await wait(()=>x.w.document.documentElement.dataset.readerTheme==='dark');
  x.button('×').click();await wait(()=>!settings.open&&!main.inert);
  settings.querySelector(':scope>summary').click();await wait(()=>settings.open);
  assert.equal(theme.value,'dark');assert.equal(x.requests.length,0);
 }finally{await x.w.happyDOM.close();}
});

test('closing settings retains a subtitle draft, pauses its owner and can resume without importing',async()=>{
 const x=await mountedSourceApp({service:{ingest:async()=>{throw Error('No request expected');}}});
 try{
  const settings=x.w.document.querySelector('.app-settings'),subtitles=settings.querySelector('.subtitle-recovery');
  settings.querySelector(':scope>summary').click();await wait(()=>settings.open);
  subtitles.open=true;
  const area=subtitles.querySelector('textarea'),text='1\n00:00:00,000 --> 00:00:02,000\nKeep this source draft.';
  Object.getOwnPropertyDescriptor(x.w.HTMLTextAreaElement.prototype,'value').set.call(area,text);area.dispatchEvent(new x.w.Event('input',{bubbles:true}));
  await wait(()=>area.value===text);
  settings.querySelector('[aria-label="关闭设置"]').click();await wait(()=>!settings.open&&!subtitles.open);
  settings.querySelector(':scope>summary').click();await wait(()=>settings.open);
  assert.equal(area.value,text);subtitles.open=true;
  await wait(()=>[...subtitles.querySelectorAll('button')].some(node=>node.textContent==='继续核对保留的草稿'));
  assert.equal(x.docs().length,0);assert.equal(x.requests.length,0);
 }finally{await x.w.happyDOM.close();}
});
