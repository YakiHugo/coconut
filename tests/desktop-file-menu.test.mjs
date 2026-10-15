// Compatibility renderer regression; this suite is not default React acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {Window} from 'happy-dom';
import {createFileMenu} from '../desktop/file-menu.mjs';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function native(){
 const window=new EventEmitter(),contents=new EventEmitter();window.webContents=contents;
 let destroyed=false,loading=false,url='http://127.0.0.1:47831/',blocked=false;
 window.isDestroyed=()=>destroyed;contents.isDestroyed=()=>destroyed;contents.getURL=()=>url;contents.isLoadingMainFrame=()=>loading;
 const calls=[],pending=[];contents.executeJavaScript=(code,gesture)=>{calls.push({code,gesture});return gesture?Promise.resolve(true):new Promise(resolve=>pending.push(resolve));};
 const menu=createFileMenu({window,origin:'http://127.0.0.1:47831',blocked:()=>blocked,now:()=>1234});
 const actual=new Map([...menu.submenu,menu.findItem].map(item=>[item.id,{enabled:item.enabled}]));menu.bind({getMenuItemById:id=>actual.get(id)});
 return {menu,actual,calls,pending,contents,window,set(values){if('destroyed'in values)destroyed=values.destroyed;if('loading'in values)loading=values.loading;if('url'in values)url=values.url;if('blocked'in values)blocked=values.blocked;}};
}
test('native File items are disabled until bootstrap and dispatch only explicit bounded commands with a gesture',async()=>{
 const n=native();assert.deepEqual(n.menu.submenu.map(x=>[x.id,x.accelerator]),[['import-transcript','CmdOrCtrl+O'],['open-local-media','CmdOrCtrl+Shift+O'],['backup-library','CmdOrCtrl+Shift+S']]);
 assert.ok(n.menu.submenu.every(x=>!x.enabled));assert.equal(await n.menu.submenu[0].click(),false);assert.equal(n.calls.length,0);
 n.contents.emit('did-finish-load');n.pending.shift()(true);await turn();assert.ok([...n.actual.values()].every(x=>x.enabled));
 for(const item of n.menu.submenu){assert.equal(await item.click(),true);assert.match(n.calls.at(-1).code,new RegExp(item.id));assert.equal(n.calls.at(-1).gesture,true);assert.match(n.calls.at(-1).code,/"expiresAt":3234/);}
 for(const blocked of [{blocked:true},{loading:true},{url:'https://other.example/'},{destroyed:true}]){
  const before=n.calls.length;n.set(blocked);assert.equal(await n.menu.submenu[0].click(),false);assert.equal(n.calls.length,before);
  n.set({blocked:false,loading:false,url:'http://127.0.0.1:47831/',destroyed:false});
 }
});
test('navigation and renderer loss invalidate readiness; late bootstrap never enables a replaced page',async()=>{
 const n=native();n.contents.emit('did-finish-load');const first=n.pending.shift();n.contents.emit('did-start-navigation',{},'http://127.0.0.1:47831/',false,true);n.contents.emit('did-start-loading');first(true);await turn();assert.ok(n.menu.submenu.every(x=>!x.enabled));
 n.contents.emit('did-finish-load');n.pending.shift()(true);await turn();assert.equal(n.menu.submenu[0].enabled,true);
 n.contents.emit('render-process-gone');assert.ok([...n.actual.values()].every(x=>!x.enabled));
 n.contents.emit('did-finish-load');n.pending.shift()(true);await turn();n.set({destroyed:true});n.window.emit('closed');assert.equal(await n.menu.submenu[0].click(),false);
});
test('a renderer execution failure is consumed and never retried',async()=>{
 const n=native();n.contents.emit('did-finish-load');n.pending.shift()(true);await turn();let calls=0;n.contents.executeJavaScript=()=>{calls++;return Promise.reject(Error('closed'));};
 assert.equal(await n.menu.submenu[0].click(),false);assert.equal(calls,1);
});
const root=new URL('../',import.meta.url);
function renderer(desktop=true){
 const w=new Window({url:'http://127.0.0.1:47831/'});w.document.body.innerHTML=fs.readFileSync(new URL('reader/compatibility.html',root),'utf8').split('<body>')[1].split('</body>')[0];
 Object.defineProperty(w,'crypto',{configurable:true,value:webcrypto});
 if(desktop)w.coconutUpdates={state:async()=>({status:'idle',version:'test',arch:'arm64'}),subscribe:()=>{}};
 for(const file of ['summary','core','passages','passage-playback','library-store'])w.eval(fs.readFileSync(new URL(`reader/${file}.js`,root),'utf8'));
 w.eval(['app','language','podcasts'].map(file=>fs.readFileSync(new URL(`reader/${file}.js`,root),'utf8')).join('\n')+'\nlet sourceSubmitting=false,sourceCaptionRequest=null;\n'+fs.readFileSync(new URL('reader/updates.js',root),'utf8')+'\nwindow.menuTest={closing:value=>readerClosing=value};');
 w.CoconutStorageBootstrap={phase:'ready'};
 const $=id=>w.document.getElementById(id),command=id=>w.coconutFileCommand(id,{issuedAt:Date.now(),expiresAt:Date.now()+2000});
 return {w,$,command};
}
test('renderer reuses existing file choosers, and backup exports every document without changing save state',async()=>{
 const {w,$,command}=renderer();try{
  let imports=0,media=0;$('file').click=()=>imports++;$('local-media-file').click=()=>media++;
  assert.equal(command('import-transcript'),true);assert.equal(imports,1);assert.equal(command('open-local-media'),true);assert.equal(media,1);
  $('local-media-file').dispatchEvent(new w.Event('cancel'));
  await $('sample').onclick();let backup;w.URL.createObjectURL=blob=>{backup=blob;return 'blob:backup';};w.URL.revokeObjectURL=()=>{};
  const before=w.localStorage.getItem('coconut-reader-v1');assert.equal(command('backup-library'),true);
  const exported=JSON.parse(await backup.text());assert.equal(exported.format,'coconut-library');assert.ok(exported.documents.length);assert.equal(w.localStorage.getItem('coconut-reader-v1'),before);assert.match($('notice').textContent,/不包含媒体文件/);
 }finally{await w.happyDOM.close();}
});
test('renderer blocks bootstrap, lifecycle, modal, disabled, unknown, expired and obsolete-page commands',async()=>{
 const {w,$,command}=renderer();try{
  let opened=0;$('file').click=()=>opened++;
  for(const phase of ['loading','failed','closed']){w.CoconutStorageBootstrap.phase=phase;assert.equal(command('import-transcript'),false);}w.CoconutStorageBootstrap.phase='ready';
  w.document.body.inert=true;assert.equal(command('import-transcript'),false);w.document.body.inert=false;
  w.document.querySelector('.shell').inert=true;assert.equal(command('import-transcript'),false);w.document.querySelector('.shell').inert=false;
  w.menuTest.closing(true);assert.equal(command('import-transcript'),false);w.menuTest.closing(false);
  $('import').disabled=true;assert.equal(command('import-transcript'),false);$('import').disabled=false;
  $('details-dialog').showModal();$('document-title').focus();const focus=w.document.activeElement;
  assert.equal(command('import-transcript'),false);assert.equal(w.document.activeElement,focus);assert.match($('details-dialog').querySelector('[role="status"][data-file-menu-hint]').textContent,/对话框/);$('details-dialog').close();
  assert.equal(command('import-media'),false);assert.equal(w.coconutFileCommand('import-transcript',{issuedAt:Date.now(),expiresAt:0}),false);
  assert.equal(w.coconutFileCommand('import-transcript',{issuedAt:0,expiresAt:Date.now()+2000}),false);assert.equal(opened,0);
  w.dispatchEvent(new w.Event('pagehide'));assert.equal(command('import-transcript'),false);assert.equal(opened,0);
 }finally{await w.happyDOM.close();}
});
test('ordinary Web reader has no native command hook or intercepted open shortcut',async()=>{
 const {w,$}=renderer(false);try{assert.equal(w.coconutFileCommand,undefined);const e=new w.KeyboardEvent('keydown',{key:'o',ctrlKey:true,bubbles:true,cancelable:true});w.document.dispatchEvent(e);assert.equal(e.defaultPrevented,false);}finally{await w.happyDOM.close();}
});
test('package allowlist includes the native dispatcher',()=>{
 assert.match(fs.readFileSync(new URL('desktop/package.mjs',root),'utf8'),/'file-menu\.mjs'/);
});


test('native Find is a bounded Edit-menu item with bootstrap and lifecycle ownership',async()=>{
 const n=native(),find=n.menu.findItem;assert.equal(find.id,'find-transcript');assert.equal(find.accelerator,'CmdOrCtrl+F');assert.equal(await find.click(),false);
 n.contents.emit('did-finish-load');n.pending.shift()(true);await turn();assert.equal(n.actual.get(find.id).enabled,true);assert.equal(await find.click(),true);
 assert.match(n.calls.at(-1).code,/coconutFileCommand\("find-transcript"/);assert.equal(n.calls.at(-1).gesture,true);
 for(const state of [{blocked:true},{loading:true},{url:'https://other.example/'}]){n.set(state);assert.equal(await find.click(),false);n.set({blocked:false,loading:false,url:'http://127.0.0.1:47831/'});}
 n.contents.emit('render-process-gone');assert.equal(n.actual.get(find.id).enabled,false);assert.equal(await find.click(),false);
 const main=fs.readFileSync(new URL('desktop/main.mjs',root),'utf8');assert.match(main,/id:'coconut-edit-menu',role:'editMenu'/);assert.match(main,/editMenu\.append\(new MenuItem\(findItem\)\)/);
});


test('native menu remains trusted after the real reader skip-link fragment, without admitting query or other paths',async()=>{
 const n=native();n.contents.emit('did-finish-load');n.pending.shift()(true);await turn();
 const item=n.menu.submenu[0];
 for(const url of ['http://127.0.0.1:47831/#main-content','http://127.0.0.1:47831/index.html#main-content']){n.set({url});assert.equal(await item.click(),true);}
 for(const url of ['http://127.0.0.1:47831/other#main-content','http://127.0.0.1:47831/?next=index.html#main-content']){n.set({url});assert.equal(await item.click(),false);}
});

test('bootstrap before did-stop-loading retains verified readiness without retrying renderer work',async()=>{
 const n=native();n.set({loading:true});n.contents.emit('did-start-navigation',{},'http://127.0.0.1:47831/',false,true);n.contents.emit('did-start-loading');n.contents.emit('did-finish-load');n.pending.shift()(true);await turn();
 assert.ok([...n.actual.values()].every(item=>!item.enabled));assert.equal(await n.menu.submenu[0].click(),false);assert.equal(n.calls.length,1);
 n.set({loading:false});n.contents.emit('did-stop-loading');assert.ok([...n.actual.values()].every(item=>item.enabled));assert.equal(n.calls.length,1);
 assert.equal(await n.menu.submenu[0].click(),true);assert.equal(n.calls.at(-1).gesture,true);
});
test('did-stop-loading before bootstrap does not grant readiness, and later receipt can enable',async()=>{
 const n=native();n.set({loading:true});n.contents.emit('did-start-navigation',{},'http://127.0.0.1:47831/',false,true);n.contents.emit('did-start-loading');n.contents.emit('did-finish-load');const loaded=n.pending.shift();n.set({loading:false});n.contents.emit('did-stop-loading');assert.ok([...n.actual.values()].every(item=>!item.enabled));
 loaded(true);await turn();assert.ok([...n.actual.values()].every(item=>item.enabled));assert.equal(n.calls.length,1);
});
for(const invalidation of ['navigation','crash','closed'])test('saved loading receipt cannot re-enable after '+invalidation,async()=>{
 const n=native();n.set({loading:true});n.contents.emit('did-finish-load');n.pending.shift()(true);await turn();
 if(invalidation==='navigation'){n.contents.emit('did-start-navigation',{},'http://127.0.0.1:47831/',false,true);n.contents.emit('did-start-loading');}else if(invalidation==='crash')n.contents.emit('render-process-gone');else {n.set({destroyed:true});n.window.emit('closed');}
 n.set({loading:false});n.contents.emit('did-stop-loading');assert.ok([...n.actual.values()].every(item=>!item.enabled));assert.equal(await n.menu.submenu[0].click(),false);assert.equal(n.calls.length,1);
});
test('late bootstrap from old generation cannot borrow new document stop-loading',async()=>{
 const n=native();n.set({loading:true});n.contents.emit('did-finish-load');const old=n.pending.shift();n.contents.emit('did-start-navigation',{},'http://127.0.0.1:47831/',false,true);n.contents.emit('did-start-loading');n.contents.emit('did-finish-load');const current=n.pending.shift();old(true);await turn();n.set({loading:false});n.contents.emit('did-stop-loading');assert.ok([...n.actual.values()].every(item=>!item.enabled));current(true);await turn();assert.ok([...n.actual.values()].every(item=>item.enabled));
});
for(const url of ['https://external.example/','http://127.0.0.1:47831/?other','http://127.0.0.1:47831/compatibility.html'])test('saved bootstrap cannot transfer to a different document URL '+url,async()=>{
 const n=native();n.set({loading:true});n.contents.emit('did-finish-load');n.pending.shift()(true);await turn();n.set({loading:false,url});n.contents.emit('did-stop-loading');assert.ok([...n.actual.values()].every(item=>!item.enabled));assert.equal(await n.menu.submenu[0].click(),false);
});
test('failed bootstrap and stop without bootstrap remain disabled',async()=>{
 const n=native();n.contents.emit('did-stop-loading');assert.equal(n.menu.submenu[0].enabled,false);n.contents.emit('did-finish-load');n.pending.shift()(false);await turn();n.contents.emit('did-stop-loading');assert.equal(n.menu.submenu[0].enabled,false);
});

for(const timing of ['before-bootstrap','after-bootstrap'])test('React initial same-document route keeps bootstrap ownership '+timing,async()=>{
 const n=native();n.contents.emit('did-start-navigation',{},'http://127.0.0.1:47831/',false,true);n.contents.emit('did-finish-load');const loaded=n.pending.shift();
 if(timing==='after-bootstrap'){loaded(true);await turn();assert.equal(n.menu.submenu[0].enabled,true);}
 n.set({loading:true});n.contents.emit('did-start-loading');n.contents.emit('did-start-navigation',{},'http://127.0.0.1:47831/#discover',true,true);n.set({url:'http://127.0.0.1:47831/#discover'});n.contents.emit('did-navigate-in-page',{},'http://127.0.0.1:47831/#discover',true);
 assert.equal(n.menu.submenu[0].enabled,false);n.set({loading:false});n.contents.emit('did-stop-loading');
 if(timing==='before-bootstrap'){assert.equal(n.menu.submenu[0].enabled,false);loaded(true);await turn();}
 assert.ok([...n.actual.values()].every(item=>item.enabled));assert.equal(n.calls.length,1,'same document never re-probes or forces ready');assert.equal(await n.menu.submenu[0].click(),true);assert.equal(n.calls.at(-1).gesture,true);
});
test('modern same-document event fields preserve receipt; main document navigation always revokes',async()=>{
 const n=native();n.contents.emit('did-finish-load');n.pending.shift()(true);await turn();n.set({loading:true});n.contents.emit('did-start-loading');n.contents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:true});n.set({url:'http://127.0.0.1:47831/#library',loading:false});n.contents.emit('did-navigate-in-page');assert.equal(n.menu.submenu[0].enabled,true);
 n.contents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false});n.contents.emit('did-stop-loading');assert.equal(n.menu.submenu[0].enabled,false);assert.equal(await n.menu.submenu[0].click(),false);
});
test('subframe loading cannot erase main document receipt or grant a missing receipt',async()=>{
 const n=native();n.contents.emit('did-start-navigation',{},'https://external.example/frame',false,false);n.contents.emit('did-stop-loading');assert.equal(n.menu.submenu[0].enabled,false);n.contents.emit('did-finish-load');n.pending.shift()(true);await turn();n.set({loading:true});n.contents.emit('did-start-loading');n.contents.emit('did-start-navigation',{isMainFrame:false,isSameDocument:false});n.set({loading:false});n.contents.emit('did-stop-loading');assert.equal(n.menu.submenu[0].enabled,true);
});
test('loading spinner without bootstrap can never enable a menu',()=>{
 const n=native();n.contents.emit('did-start-loading');n.contents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:true});n.contents.emit('did-navigate-in-page');n.contents.emit('did-stop-loading');assert.ok([...n.actual.values()].every(item=>!item.enabled));assert.equal(n.calls.length,0);
});
for(const order of ['spinner-first','navigation-first'])test('initial full load event order remains gated '+order,async()=>{
 const n=native();n.set({loading:true});const navigation=()=>n.contents.emit('did-start-navigation',{},'http://127.0.0.1:47831/',false,true),spinner=()=>n.contents.emit('did-start-loading');if(order==='spinner-first'){spinner();navigation();}else{navigation();spinner();}n.contents.emit('did-finish-load');n.pending.shift()(true);await turn();assert.equal(n.menu.submenu[0].enabled,false);assert.equal(await n.menu.submenu[0].click(),false);n.set({loading:false});n.contents.emit('did-stop-loading');assert.equal(n.menu.submenu[0].enabled,true);
});
for(const url of ['http://127.0.0.1:47831/?q=1','http://127.0.0.1:47831/index.html','https://external.example/'])test('same-document notification cannot transfer receipt across URL boundary '+url,async()=>{
 const n=native();n.contents.emit('did-finish-load');n.pending.shift()(true);await turn();n.contents.emit('did-start-navigation',{},url,true,true);n.set({url});n.contents.emit('did-navigate-in-page');assert.equal(n.menu.submenu[0].enabled,false);assert.equal(await n.menu.submenu[0].click(),false);
});
