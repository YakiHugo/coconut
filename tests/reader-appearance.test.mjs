import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {themeTransitionsSettled} from './helpers/theme-transitions.mjs';
import {Window} from 'happy-dom';
import {installSavePipeline} from './helpers/save-pipeline.mjs';
import {passageReadingFixture} from './helpers/passage-reading-fixture.mjs';
const root=new URL('../',import.meta.url), theme='coconut-reading-theme-v1', measure='coconut-reading-measure-v1';
const source=name=>fs.readFileSync(new URL('reader/'+name,root),'utf8');
function setup({saved={},dark=false,readDenied=false,writeDenied=false,mediaUnavailable=false,legacyMedia=false,app=false}={}) {
 const w=new Window({url:'https://coconut.example/'}),$=id=>w.document.getElementById(id),writes=[],calls=[];
 w.document.write(source('index.html').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]+>/g,''));
 for (const [key,value] of Object.entries(saved)) w.localStorage.setItem(key,value);
 const backing=w.localStorage;
 Object.defineProperty(w,'localStorage',{configurable:true,value:{getItem(key){if(readDenied)throw Error('blocked');return backing.getItem(key);},setItem(key,value){if(writeDenied)throw Error('blocked');writes.push(key);backing.setItem(key,value);},removeItem:key=>backing.removeItem(key)}});
 let listener;
 const media={matches:dark,[legacyMedia?'addListener':'addEventListener'](...args){listener=args.at(-1);}};
 w.matchMedia=()=>{if(mediaUnavailable)throw Error('unavailable');return media;};
 w.fetch=async(...args)=>{calls.push(args);throw Error('No network authorized');};
 w.HTMLElement.prototype.scrollIntoView=function(){};
 w.eval(source('appearance.js'));w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
 let save;
 if(app){save=installSavePipeline(w);w.eval(['summary','core','passages','passage-playback','app','language'].map(name=>source(name+'.js')).join('\n'));}
 return {w,$,writes,calls,save,backing,system(value){media.matches=value;listener?.({matches:value});},change(id,value){$(id).value=value;$(id).onchange();},async close(){w.dispatchEvent(new w.Event('pagehide'));await w.happyDOM.close();}};
}

test('fresh defaults preserve light/full layout even on a dark OS, without a storage write',async()=>{
 const e=setup({dark:true});try{
  assert.equal(e.w.document.documentElement.dataset.readerTheme,'light');assert.equal(e.$('reading-theme').value,'light');
  assert.equal(e.w.document.documentElement.dataset.readingMeasure,'full');assert.equal(e.$('reading-measure').value,'full');
  assert.equal(e.$('reading-theme').closest('details').id,'reading-settings');assert.equal(e.$('reading-settings').open,false);
  assert.deepEqual(e.writes,[]);assert.deepEqual(e.calls,[]);
 }finally{await e.close();}
});

test('valid preferences restore synchronously, native controls persist separately, defaults are reversible',async()=>{
 const e=setup({saved:{[theme]:'dark',[measure]:'narrow'}});try{
  assert.equal(e.w.document.documentElement.dataset.readerTheme,'dark');assert.equal(e.w.document.querySelector('meta[name="theme-color"]').content,'#211f1d');
  assert.equal(e.$('reading-measure').value,'narrow');
  e.change('reading-theme','light');e.change('reading-measure','full');
  assert.equal(e.backing.getItem(theme),'light');assert.equal(e.backing.getItem(measure),'full');
  assert.deepEqual(e.writes,[theme,measure]);assert.match(e.$('appearance-status').textContent,/已保存/);
  const restored=setup({saved:{[theme]:e.backing.getItem(theme),[measure]:e.backing.getItem(measure)},dark:true});
  try{assert.equal(restored.w.document.documentElement.dataset.readerTheme,'light');assert.equal(restored.$('reading-measure').value,'full');}finally{await restored.close();}
 }finally{await e.close();}
});

for(const legacyMedia of [false,true])test(`system theme follows live OS changes with ${legacyMedia?'legacy':'modern'} events only when selected`,async()=>{
 const e=setup({saved:{[theme]:'system'},legacyMedia});try{
  assert.equal(e.w.document.documentElement.dataset.readerTheme,'light');e.system(true);assert.equal(e.w.document.documentElement.dataset.readerTheme,'dark');
  assert.equal(e.$('reading-theme').value,'system');assert.deepEqual(e.writes,[]);
  e.change('reading-theme','light');e.system(false);e.system(true);assert.equal(e.w.document.documentElement.dataset.readerTheme,'light');
  e.change('reading-theme','dark');e.system(false);assert.equal(e.w.document.documentElement.dataset.readerTheme,'dark');
 }finally{await e.close();}
});

for(const bad of ['', 'DARK','undefined','<script>','{"theme":"dark"}'])test('malformed preferences fall back without overwriting stored bytes: '+bad,async()=>{
 const e=setup({saved:{[theme]:bad,[measure]:bad},dark:true});try{
  assert.equal(e.w.document.documentElement.dataset.readerTheme,'light');assert.equal(e.$('reading-measure').value,'full');
  assert.equal(e.backing.getItem(theme),bad);assert.deepEqual(e.writes,[]);
 }finally{await e.close();}
});

test('blocked storage and missing matchMedia still allow in-page settings with honest fallback',async()=>{
 const e=setup({readDenied:true,writeDenied:true,mediaUnavailable:true});try{
  assert.match(e.$('appearance-status').textContent,/未能读取/);e.change('reading-theme','dark');e.change('reading-measure','narrow');
  assert.equal(e.w.document.documentElement.dataset.readerTheme,'dark');assert.equal(e.w.document.documentElement.dataset.readingMeasure,'narrow');
  assert.match(e.$('appearance-status').textContent,/本次显示已应用.*未能保存/);
  e.change('reading-theme','system');assert.equal(e.w.document.documentElement.dataset.readerTheme,'light');assert.deepEqual(e.writes,[]);
 }finally{await e.close();}
});

test('cross-window changes, removal and clear update controls without writing or affecting unrelated keys',async()=>{
 const e=setup();try{
  const storage=(key,newValue)=>e.w.dispatchEvent(new e.w.StorageEvent('storage',{key,newValue}));
  storage(theme,'dark');storage(measure,'narrow');assert.equal(e.$('reading-theme').value,'dark');assert.equal(e.$('reading-measure').value,'narrow');
  storage('coconut-reader-v1','not a preference');assert.equal(e.$('reading-theme').value,'dark');
  storage(theme,null);assert.equal(e.$('reading-theme').value,'light');storage(null,null);assert.equal(e.$('reading-measure').value,'full');
  assert.deepEqual(e.writes,[]);assert.match(e.$('appearance-status').textContent,/另一窗口/);
 }finally{await e.close();}
});

test('appearance controls preserve prose, drafts, active media, selection and document saves',async()=>{
 const e=setup({app:true});try{
  const doc=passageReadingFixture(),text=JSON.stringify(doc);
  Object.defineProperty(e.$('file'),'files',{configurable:true,value:[{name:'authored.json',size:text.length,text:async()=>text}]});await e.$('file').onchange();await e.w.flushContentForTest();
  const original=e.backing.getItem('coconut-reader-v1'),source=e.$('passage-body').textContent,prepares=e.save.prepares;
  e.$('translation-glossary').value='Draft terminology';e.$('translation-glossary').dispatchEvent(new e.w.Event('input',{bubbles:true}));
  const audio=e.w.document.createElement('audio');audio.currentTime=23;e.$('source-media').append(audio);
  const selection=e.w.getSelection(),range=e.w.document.createRange(),cue=e.w.document.querySelector('.passage-cue');range.selectNodeContents(cue);selection.addRange(range);const selected=selection.toString();
  e.$('reading-info').open=true;e.$('reading-theme').focus();
  for(const layout of ['large','spacious','standard']){e.change('reading-layout',layout);e.change('reading-theme','dark');e.change('reading-measure','narrow');e.change('reading-theme','system');e.system(true);e.change('reading-measure','full');}
  assert.equal(e.$('passage-body').textContent,source);assert.equal(e.$('translation-glossary').value,'Draft terminology');
  assert.equal(e.$('source-media').querySelector('audio'),audio);assert.equal(audio.currentTime,23);assert.equal(e.w.getSelection().toString(),selected);
  assert.equal(e.w.document.activeElement,e.$('reading-theme'));assert.equal(e.save.prepares,prepares);assert.equal(e.backing.getItem('coconut-reader-v1'),original);assert.deepEqual(e.calls,[]);
  assert.ok(e.writes.slice(e.writes.indexOf(theme)).every(key=>[theme,measure,'coconut-reading-layout-v1'].includes(key)));
 }finally{await e.close();}
});

test('head preference script is independent of async library bootstrap and all serving paths include it',()=>{
 const html=source('index.html');assert.ok(html.indexOf('src="appearance.js')<html.indexOf('rel="stylesheet"'));
 assert.ok(!/<script[^>]+(?:defer|text\/coconut-pending)[^>]+src="appearance/.test(html));
 for(const file of ['serve.py','desktop/server.mjs','desktop/package.mjs'])assert.match(fs.readFileSync(new URL(file,root),'utf8'),/appearance\.js/);
});

test('a successful preference write does not hide another preference that is still unsaved',async()=>{
 const e=setup();try{
  Object.defineProperty(e.w,'localStorage',{configurable:true,value:{getItem:key=>e.backing.getItem(key),setItem(key,value){if(key===theme)throw Error('blocked');e.backing.setItem(key,value);}}});
  e.change('reading-theme','dark');e.change('reading-measure','narrow');assert.match(e.$('appearance-status').textContent,/部分.*仅在本页|部分.*只在本页/);
  Object.defineProperty(e.w,'localStorage',{configurable:true,value:e.backing});e.change('reading-theme','dark');assert.match(e.$('appearance-status').textContent,/已保存/);
 }finally{await e.close();}
});

test('the dark semantic text palette has at least 4.5:1 contrast on every authored surface',()=>{
 const css=source('style.css').split(':root[data-reader-theme="dark"] {')[1].split('}')[0];
 const colors=Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[a-f0-9]{6})/g)].map(match=>[match[1],match[2]]));
 const luminance=hex=>hex.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
 const contrast=(fg,bg)=>{const a=luminance(fg),b=luminance(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
 for(const text of ['ink','muted','accent','tone-ink','tone-muted','tone-warning','tone-error'])for(const surface of ['canvas','surface','surface-soft','surface-selected','surface-warning','highlight'])assert.ok(contrast(colors[text],colors[surface])>=4.5,text+' on '+surface);
 assert.ok(contrast(colors['on-accent'],colors.accent)>=4.5);assert.ok(contrast(colors['on-ink'],colors.ink)>=4.5);assert.ok(contrast(colors.focus,colors.surface)>=3);assert.ok(contrast(colors['control-edge'],colors.surface)>=3);
});

test('the inert IndexedDB startup and recovery overlay uses the selected canvas before the app is ready',async()=>{
 for(const [choice,color] of [['light','#faf9f7'],['dark','#211f1d']]){
  const e=setup({saved:{[theme]:choice}});try{
   const style=e.w.document.createElement('style');style.textContent=source('style.css');e.w.document.head.append(style);
   assert.ok(e.$('storage-startup'));assert.equal(e.$('storage-startup').hidden,false);
   assert.equal(e.w.CoconutStorageBootstrap,undefined,'appearance does not wait for or initialize the library');
   assert.equal(e.w.getComputedStyle(e.$('storage-startup')).backgroundColor,color);
   assert.equal(e.w.getComputedStyle(e.w.document.documentElement).backgroundColor,color);
  }finally{await e.close();}
 }
});


test('contrast waits for actual control and ancestor theme transitions, including cancellation',()=>{
 class Transition {constructor(playState,pending=false){this.playState=playState;this.pending=pending;}}
 const surface=new Transition('running'),ancestor=new Transition('finished');
 const parent={parentElement:null,getAnimations:()=>[ancestor]};
 const button={parentElement:parent,getAnimations:()=>[surface]};
 let flushed=0;
 const context={document:{querySelector:()=>button},CSSTransition:Transition,getComputedStyle(){flushed++;return {backgroundColor:'#282624'};}};
 const settled=()=>vm.runInNewContext('('+themeTransitionsSettled.toString()+')(["#close-reading-info"])',context);
 assert.equal(settled(),false,'running surface must not be sampled');assert.ok(flushed>0,'style is calculated before testing transitions');
 surface.playState='finished';ancestor.playState='running';assert.equal(settled(),false,'an ancestor transition also delays sampling');
 ancestor.playState='finished';surface.pending=true;assert.equal(settled(),false,'a pending transition delays sampling');
 surface.pending=false;assert.equal(settled(),true,'finished transitions permit contrast sampling');
 surface.playState='idle';assert.equal(settled(),true,'cancelled transitions do not leave the wait stuck');
 let discovered=false;
 context.getComputedStyle=()=>{discovered=true;surface.playState='running';return {backgroundColor:'#282624'};};
 assert.equal(settled(),false,'a transition created by the style flush is detected');assert.equal(discovered,true);
});


test('mobile settings panels use the utility width while desktop keeps the trigger anchor',async()=>{
 for(const width of [320,360,390,640,1360]){
  const e=setup();try{
   e.w.happyDOM.setViewport({width,height:width===640?480:900});
   const style=e.w.document.createElement('style');style.textContent=source('style.css');e.w.document.head.append(style);
   e.$('reading-utility').classList.add('is-compact');e.$('reading-info').hidden=false;e.$('reading-info').open=true;
   assert.equal(e.w.getComputedStyle(e.$('reading-utility')).position,'relative');
   assert.equal(e.w.getComputedStyle(e.$('reading-info')).position,width<=650?'static':'relative');
   assert.equal(e.w.getComputedStyle(e.w.document.querySelector('.reading-info-panel')).position,'absolute');
  }finally{await e.close();}
 }
});
