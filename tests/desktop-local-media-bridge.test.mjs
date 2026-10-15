/** Production preload/IPC/HTTP boundaries with fake Electron and no browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {startBridge} from '../desktop/server.mjs';
const root=new URL('../',import.meta.url),read=name=>fs.readFileSync(new URL(name,root),'utf8');

test('isolated preload derives path only from a selected File and never returns it to the renderer',async()=>{
 const exposed={},calls=[],selected={},owner={key:'project'};
 vm.runInNewContext(read('desktop/update-preload.cjs'),{require:name=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(name,api)=>{exposed[name]=api;}},ipcRenderer:{invoke:async(...args)=>{calls.push(args);return {status:'remembered'};}},webUtils:{getPathForFile:file=>file===selected?'/authored/Original.wav':''}};}});
 const api=exposed.coconutLocalMedia;assert.ok(Object.isFrozen(api));assert.deepEqual(Object.keys(api).sort(),['forget','reconcile','release','remember','resolve']);
 assert.equal((await api.remember(owner,{},'id')).status,'unavailable');assert.equal(calls.length,0);
 const receipt=await api.remember(owner,selected,'candidate');assert.equal(receipt.status,'remembered');assert.equal(JSON.stringify(receipt).includes('/authored'),false);
 assert.equal(calls[0][0],'coconut:local-media');assert.equal(calls[0][1],'remember');assert.equal(calls[0][2].path,'/authored/Original.wav');assert.equal(calls[0][2].owner,owner);
 await api.resolve(owner);await api.forget(owner);await api.release('token');await api.reconcile([owner],'authored-namespace');assert.equal(calls.at(-1)[2].library,'authored-namespace');assert.deepEqual(calls.slice(1).map(call=>call[1]),['resolve','forget','release','reconcile']);
});

test('native reference IPC admits only the trusted top-level renderer and bounded named actions',async()=>{
 const main=read('desktop/main.mjs'),start=main.indexOf("    ipcMain.handle('coconut:local-media'"),end=main.indexOf('    const {bind:bindFileMenu',start);assert.ok(start>0&&end>start);
 const origin='http://127.0.0.1:47831',mainFrame={url:origin+'/'},window={webContents:{mainFrame}},calls=[];let handler;
 const localMediaService=Object.fromEntries(['remember','resolve','forget','release','reconcile'].map(action=>[action,async(...args)=>{calls.push([action,...args]);return {status:action};}]));
 vm.runInNewContext(main.slice(start,end),{ipcMain:{handle:(name,callback)=>{assert.equal(name,'coconut:local-media');handler=callback;}},window,origin,localMediaService,quitting:false});
 const event={sender:window.webContents,senderFrame:mainFrame},owner={key:'authored'};
 for(const action of ['remember','resolve','forget','release','reconcile'])assert.equal((await handler(event,action,{owner,path:'/authored/file',identity:'id',token:'token',owners:[owner],library:'authored-namespace'})).status,action);
 assert.equal(calls.length,5);assert.equal(calls.at(-1)[2],'authored-namespace');assert.equal(calls[0][1],owner);assert.equal(calls[0][2],'/authored/file');
 for(const invalid of [{...event,sender:{}},{...event,senderFrame:{url:origin+'/'}},{...event,senderFrame:{url:'https://example.org/'}}])await assert.rejects(handler(invalid,'resolve',{owner}),/来源无效/);
 for(const url of [origin+'/#main-content',origin+'/index.html#main-content']){mainFrame.url=url;assert.equal((await handler(event,'forget',{owner})).status,'forget');}
 for(const url of [origin+'/other#main-content',origin+'/?path=/index.html#main-content','https://example.org/#main-content',origin+'/index.html/../#main-content']){mainFrame.url=url;await assert.rejects(handler(event,'resolve',{owner}),/来源无效/);}
 mainFrame.url=origin+'/';await assert.rejects(handler(event,'other',{}),/不支持/);assert.equal(calls.length,7);
});

test('same-origin bridge guard precedes native stream handling; standalone light service has no native route',async t=>{
 let calls=0;const native={async handle(req,res,pathname){calls++;if(!pathname.startsWith('/api/local-media/'))return false;res.writeHead(200,{'Content-Type':'audio/wav'});res.end(req.method==='HEAD'?undefined:'authored');return true;}};
 const server=await startBridge({port:0,localMediaService:native,providers:{}});t.after(()=>new Promise(resolve=>server.shutdown(resolve)));const origin='http://127.0.0.1:'+server.address().port;
 let response=await fetch(origin+'/api/local-media/authored',{headers:{Origin:'https://example.org'}});assert.equal(response.status,403);assert.equal(calls,0);
 response=await fetch(origin+'/api/local-media/authored',{headers:{'Sec-Fetch-Site':'cross-site'}});assert.equal(response.status,403);assert.equal(calls,0);
 response=await fetch(origin+'/api/local-media/authored',{headers:{Origin:origin}});assert.equal(response.status,200);assert.equal(await response.text(),'authored');assert.equal(calls,1);assert.match(response.headers.get('content-security-policy'),/media-src 'self' blob:/);
 const light=await startBridge({port:0,providers:{}});t.after(()=>new Promise(resolve=>light.shutdown(resolve)));assert.equal((await fetch('http://127.0.0.1:'+light.address().port+'/api/local-media/authored')).status,404);
});


test('same-document skip links retain native stream tokens; reload or renderer loss retires them',()=>{
 const main=read('desktop/main.mjs'),start=main.indexOf("    window.webContents.on('did-start-navigation'"),end=main.indexOf("    window.webContents.on('will-attach-webview'",start);assert.ok(start>0&&end>start);
 const handlers=new Map();let releases=0;
 vm.runInNewContext(main.slice(start,end),{window:{webContents:{on:(name,handler)=>handlers.set(name,handler)}},localMediaService:{releaseAll(){releases++;}}});
 const navigate=handlers.get('did-start-navigation');navigate({},'http://127.0.0.1:47831/#main-content',true,true);assert.equal(releases,0);
 navigate({},'http://127.0.0.1:47831/',false,false);assert.equal(releases,0);
 navigate({},'http://127.0.0.1:47831/',false,true);assert.equal(releases,1);
 handlers.get('render-process-gone')();assert.equal(releases,2);
});
