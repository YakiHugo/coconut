import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
const require = createRequire(import.meta.url);
test('React preferences preserve saved keys, report failed writes, sync windows and clean up keyboard ownership', async () => {
 const temp=await mkdtemp(join(tmpdir(),'coconut-preferences-'));
 const win=new Window({url:'http://localhost/'}), previous={};
 for(const name of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent']) { previous[name]=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value:win[name],configurable:true,writable:true}); }
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const savedChannel=globalThis.MessageChannel,channels=[];globalThis.MessageChannel=class extends savedChannel{constructor(){super();channels.push(this);}};
 let root,act;
 try {
  const backing=win.localStorage,writes=[];let blocked=false;
  const keys={chineseScript:'coconut-reading-chinese-script-v1',theme:'coconut-reading-theme-v1',measure:'coconut-reading-measure-v1',layout:'coconut-reading-layout-v1',shortcuts:'coconut-reading-shortcuts-v1'};
  for(const [key,value] of Object.entries({theme:'dark',measure:'narrow',layout:'spacious',shortcuts:'off'}))backing.setItem(keys[key],value);
  Object.defineProperty(win,'localStorage',{value:{getItem:key=>backing.getItem(key),setItem:(key,value)=>{if(blocked)throw Error('denied');writes.push(key);backing.setItem(key,value);}},configurable:true});
  let system;let removals=0;const media={matches:false,addEventListener:(_,fn)=>{system=fn;},removeEventListener:()=>{removals++;}};win.matchMedia=()=>media;
  const output=await build({stdin:{contents:`
    import {createElement,useRef} from 'react';
    import {ReadingPreferences,useReadingPreferences} from './frontend/reading-preferences/preferences';
    import {useReaderKeyboard} from './frontend/reading-preferences/keyboard';
    export {createRoot} from 'react-dom/client';export {act} from 'react';
    export function Harness({actions,active=true}){const controller=useReadingPreferences(),scopeRef=useRef(null),searchRef=useRef(null);useReaderKeyboard({scopeRef,searchRef,active,enabled:controller.values.shortcuts!=='off',actions});return createElement('section',{ref:scopeRef},createElement(ReadingPreferences,{controller}),createElement('p',{tabIndex:0,'data-text':true},'Source text'),createElement('input',{ref:searchRef,type:'search'}),createElement('textarea'),createElement('div',{contentEditable:true,tabIndex:0,'data-editor':true}),createElement('button',null,'Control'));}
  `,loader:'tsx',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false});
  await writeFile(join(temp,'ui.cjs'),output.outputFiles[0].contents);
  const ui=require(join(temp,'ui.cjs'));act=ui.act;const host=win.document.createElement('div');win.document.body.append(host);root=ui.createRoot(host);
  let calls=[],active=true;let actions={find:()=>{calls.push('find');},play:()=>{calls.push('play');}};
  const {createElement}=require('react'); // The element marker is shared across React copies.
  const render=()=>root.render(createElement(ui.Harness,{actions,active}));
  await act(async()=>render());
  assert.deepEqual(writes,[],'mount must not reset or rewrite saved preferences');
  assert.equal(win.document.documentElement.dataset.readerTheme,'dark');assert.equal(win.document.documentElement.dataset.readingLayout,'spacious');assert.equal(win.document.documentElement.dataset.readingMeasure,'narrow');
  assert.equal(host.querySelector('.reading-preferences').tagName,'SECTION');
  assert.equal(host.querySelector('.reading-preferences select,.reading-preferences details'),null);
  const optionLabels={system:{'中文显示':'跟随系统语言','主题':'跟随系统'},'zh-Hans':'简体中文','zh-Hant':'繁體中文',source:'保留原文字形',light:'浅色',dark:'深色',full:'完整宽度',narrow:'窄行',standard:'标准',large:'大字',spacious:'大字 · 宽松行距'};
  const picker=label=>[...host.querySelectorAll('.rw-choice')].find(node=>node.querySelector('.rw-choice-label').textContent===label);
  const select=label=>picker(label).querySelector('[role=combobox]');
  const selected=label=>select(label).querySelector('span').textContent;
  const change=async(label,value)=>{await act(async()=>select(label).click());await act(async()=>{const expected=typeof optionLabels[value]==='string'?optionLabels[value]:optionLabels[value][label];const node=[...picker(label).querySelectorAll('[role=option]')].find(node=>node.textContent.replace('✓','')===expected);assert.ok(node,'choice exists: '+label+' '+value);node.click();});};
  const source=host.querySelector('[data-text]');
  const key=async(value,options={},target=source)=>{let event;await act(async()=>{target.focus();event=new win.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true,...options});target.dispatchEvent(event);});return event;};
  await change('中文显示','zh-Hant');assert.equal(backing.getItem(keys.chineseScript),'zh-Hant');assert.equal(selected('中文显示'),'繁體中文');
  assert.equal((await key('k')).defaultPrevented,false);assert.deepEqual(calls,[]);
  assert.equal((await key('f',{ctrlKey:true})).defaultPrevented,true);assert.deepEqual(calls,['find']);
  await act(async()=>host.querySelector('input[type=checkbox]').click());assert.equal(backing.getItem(keys.shortcuts),'on');
  await key('k');assert.equal(calls.at(-1),'play');
  const count=calls.length;
  for(const target of [host.querySelector('textarea'),host.querySelector('button'),host.querySelector('[data-editor]')])await key('k',{},target);
  for(const options of [{repeat:true},{isComposing:true},{altKey:true},{ctrlKey:true},{shiftKey:true}])await key('k',options);
  assert.equal(calls.length,count,'native controls and modified or repeated keys retain ownership');
  await act(async()=>win.document.dispatchEvent(new win.Event('compositionstart')));await key('k');assert.equal(calls.length,count);
  await act(async()=>win.dispatchEvent(new win.Event('blur')));await key('k');assert.equal(calls.length,count+1);
  const modal=win.document.createElement('dialog');modal.setAttribute('open','');win.document.body.append(modal);await key('k');assert.equal(calls.length,count+1);modal.remove();
  actions={play:()=>{calls.push('new');return false;}};await act(async()=>render());assert.equal((await key('k')).defaultPrevented,false);assert.equal(calls.at(-1),'new','callbacks are fresh after rerender');
  active=false;await act(async()=>render());const inactiveCount=calls.length;await key('k');assert.equal(calls.length,inactiveCount);
  blocked=true;await change('主题','light');assert.match(host.textContent,/未能保存/);assert.equal(win.document.documentElement.dataset.readerTheme,'light');assert.equal(backing.getItem(keys.theme),'dark');
  blocked=false;await change('行宽','full');assert.match(host.textContent,/部分偏好/);await change('主题','system');assert.equal(backing.getItem(keys.theme),'system');
  await act(async()=>{media.matches=true;system();});assert.equal(win.document.documentElement.dataset.readerTheme,'dark');
  const beforeSync=writes.length;await act(async()=>win.dispatchEvent(new win.StorageEvent('storage',{key:keys.layout,newValue:'large'})));assert.equal(selected('阅读排版'),'大字');assert.equal(writes.length,beforeSync);
  await key('ArrowDown',{},select('主题'));assert.equal(select('主题').getAttribute('aria-expanded'),'true');await key('Escape',{isComposing:true},select('主题'));assert.equal(select('主题').getAttribute('aria-expanded'),'true');await key('Escape',{},select('主题'));assert.equal(select('主题').getAttribute('aria-expanded'),'false');assert.equal(win.document.activeElement,select('主题'));
  await act(async()=>root.unmount());root=null;assert.equal(removals,1);const afterUnmount=calls.length;source.dispatchEvent(new win.KeyboardEvent('keydown',{key:'k',bubbles:true}));assert.equal(calls.length,afterUnmount);
  root=ui.createRoot(host);active=true;const beforeRemount=writes.length;await act(async()=>render());assert.equal(writes.length,beforeRemount);assert.equal(selected('主题'),'跟随系统');assert.equal(selected('行宽'),'完整宽度');assert.equal(selected('阅读排版'),'大字 · 宽松行距','storage event without an actual backing write does not alter reload source');assert.equal(selected('中文显示'),'繁體中文');
  await act(async()=>win.dispatchEvent(new win.StorageEvent('storage',{key:null})));assert.equal(selected('主题'),'浅色');assert.equal(selected('阅读排版'),'标准');assert.equal(selected('中文显示'),'跟随系统语言');assert.equal(writes.length,beforeRemount,'cross-window clear is read-only');
  await act(async()=>root.unmount());root=null;
  Object.defineProperty(win,'localStorage',{value:{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}},configurable:true});root=ui.createRoot(host);await act(async()=>render());assert.equal(selected('主题'),'浅色');assert.match(host.textContent,/未能读取/);await change('阅读排版','large');assert.equal(win.document.documentElement.dataset.readingLayout,'large');assert.match(host.textContent,/未能保存/);

 } finally {
  if(root)await act(async()=>root.unmount());
  for(const [name,value] of Object.entries(previous)){if(value)Object.defineProperty(globalThis,name,value);else delete globalThis[name];}
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;for(const channel of channels){channel.port1.close();channel.port2.close();}globalThis.MessageChannel=savedChannel;await win.happyDOM.close();await rm(temp,{recursive:true,force:true});
 }
});
