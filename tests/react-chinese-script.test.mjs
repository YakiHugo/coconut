import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {Window} from 'happy-dom';
const require=createRequire(import.meta.url);
test('Chinese display preserves source offsets, searchable fields and canonical exports',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'coconut-script-')),win=new Window({url:'http://localhost/'}),previous={};
 for(const name of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','MutationObserver','getComputedStyle','CSS']){previous[name]=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value:typeof win[name]==='function'&&name==='getComputedStyle'?win[name].bind(win):win[name],configurable:true,writable:true});}
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;let root;const channels=[],SavedChannel=globalThis.MessageChannel;globalThis.MessageChannel=class extends SavedChannel{constructor(){super();channels.push(this);}};
 try{
  await symlink(join(process.cwd(),'node_modules'),join(temp,'node_modules'),'dir');
  const bundle=await build({stdin:{contents:"export * from './frontend/reading-preferences/chinese-script';export * from './frontend/reader-workspace/domain';export * from './frontend/reader-workspace/speech';export * from './frontend/reader-workspace/workspace';",resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'cjs',platform:'node',write:false,external:['react','react-dom','react-dom/client','react/jsx-runtime']});
  const file=join(temp,'ui.cjs');await writeFile(file,bundle.outputFiles[0].contents);
  const {scriptConverter,resolveChineseScript,captureSourceSelection,selectionPlaybackStart,filterCues,ReaderWorkspace}=require(file);
  const convert=scriptConverter('zh-Hans');
  const Coconut=require('../reader/core.js'),Passages=require('../reader/passages.js');win.Coconut=Coconut;win.CoconutPassages=Passages;
  win.HTMLElement.prototype.scrollIntoView=()=>{};
  const host=win.document.createElement('div');win.document.body.append(host);
  const {createElement,act}=await import('react'),{createRoot}=await import('react-dom/client');root=createRoot(host);
  const render=async(doc,chineseScript='zh-Hans')=>act(async()=>root.render(createElement(ReaderWorkspace,{document:doc,revision:1,chineseScript,onSaveDocument:async()=>true,onRequestAi:()=>{},onReadingPosition:()=>{}})));
  const makeDoc=(key,data)=>({...Coconut.validate({title:'Authored',language:'zh',...data}),key});
  const search=async text=>act(async()=>{const input=host.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value').set.call(input,text);input.dispatchEvent(new win.Event('input',{bubbles:true}));});

  await t.test('language preferences convert display while exact selections retain source characters',async()=>{
   assert.equal(resolveChineseScript('system',['zh-TW']),'zh-Hant');assert.equal(resolveChineseScript('system',['zh-CN']),'zh-Hans');assert.equal(resolveChineseScript('system',['en-US']),'source');
   const raw='我們寫代碼，頭髮很長。',simplified=convert(raw);assert.equal(simplified,'我们写代码，头发很长。');assert.equal(scriptConverter('zh-Hant')('头发很长。'),'頭髮很長。');
   const doc=makeDoc('authored',{segments:[{id:'a',start:0,end:2,text:raw}],notes:{a:'保留筆記'}}),before=JSON.stringify(doc);
   await render(doc);const source=host.querySelector('[data-source-id="a"]');assert.equal(source.textContent,simplified);
   const range=win.document.createRange();range.setStart(source.firstChild,0);range.setEnd(source.firstChild,5);
   await act(async()=>win.getSelection().addRange(range));
   const selection=captureSourceSelection(host,doc,win.getSelection(),Passages.separator,convert);assert.equal(selection.text,raw.slice(0,5));assert.equal(selection.from,0);assert.equal(selection.to,5);
   await act(async()=>win.getSelection().removeAllRanges());await search('代码');assert.ok(host.querySelector('[data-source-id="a"]'));
   await search('');await render(doc,'source');assert.equal(host.querySelector('[data-source-id="a"]').textContent,raw);assert.equal(JSON.stringify(doc),before);
  });

  await t.test('rare Hanzi preserve each source offset, sentence endings and word playback',async()=>{
   for(const raw of ['二噁英。','㑮。下一句。','𡞵。下一句。','㑮𡞵。下一句。']){
    const display=convert(raw);assert.deepEqual(Array.from(display,character=>character.length),Array.from(raw,character=>character.length));assert.equal(display,raw);
   }
   const raw='二噁英。㑮𡞵說話。頭髮很長。',display='二噁英。㑮𡞵说话。头发很长。';
   const doc=makeDoc('rare-characters',{segments:[{id:'rare',start:0,end:3,text:raw,words:[{word:'二噁英。',start:0,end:1},{word:'㑮',start:1,end:1.3},{word:'𡞵說話。',start:1.3,end:2},{word:'頭髮很長。',start:2,end:3}]}]}),before=JSON.stringify(doc);
   await render(doc);const source=host.querySelector('[data-source-id="rare"]'),parts=[...source.querySelectorAll('.rw-speech')];
   assert.equal(source.textContent,display);assert.deepEqual(parts.map(part=>part.textContent),['二噁英。','㑮𡞵说话。','头发很长。']);
   for(const part of parts)assert.equal(part.textContent,display.slice(Number(part.dataset.speechFrom),Number(part.dataset.speechTo)));
   const range=win.document.createRange();range.setStart(parts[1].firstChild,1);range.setEnd(parts[1].firstChild,3);
   await act(async()=>win.getSelection().addRange(range));
   const selection=captureSourceSelection(host,doc,win.getSelection(),Passages.separator,convert);assert.equal(selection.text,'𡞵');assert.equal(selection.from,5);assert.equal(selection.to,7);assert.deepEqual(selectionPlaybackStart(doc,selection),{seconds:1.3,wordAligned:true});
   await act(async()=>win.getSelection().removeAllRanges());assert.equal(JSON.stringify(doc),before);
  });

  await t.test('script-normalized searches cover source, translations, notes and speaker names in both reading modes',async()=>{
   const doc=makeDoc('search-fields',{translation_view:'zh',segments:[{id:'body',start:0,end:1,text:'這裡寫代碼。'},{id:'translation',start:1,end:2,text:'English source.',translations:{zh:{text:'傳統譯文專用詞。',source_text:'English source.',provider:'user'}}},{id:'note',start:2,end:3,text:'A note cue.'},{id:'speaker',start:3,end:4,text:'A named voice.',speaker:'陳曉東'}],notes:{note:'讀書筆記專用詞'}}),before=JSON.stringify(doc);
   await render(doc);
   for(const [query,id] of [['代码','body'],['代碼','body'],['译文专用词','translation'],['读书笔记','note'],['陈晓东','speaker']]){
    const filtered=filterCues(doc,query,false,null,convert);assert.deepEqual(filtered.map(cue=>cue.id),[id]);assert.equal(filtered[0],doc.segments.find(cue=>cue.id===id));
    await search(query);assert.deepEqual([...host.querySelectorAll('[data-source-id]')].map(node=>node.dataset.sourceId),[id]);
   }
   await search('');assert.equal(host.querySelector('.rw-translation').textContent,'传统译文专用词。');
   await act(async()=>host.querySelector('[role=tab][data-mode=transcript]').click());assert.equal(host.querySelector('[data-cue-id="translation"] .rw-translation').textContent,'传统译文专用词。');
   await search('译文专用词');assert.deepEqual([...host.querySelectorAll('[data-source-id]')].map(node=>node.dataset.sourceId),['translation']);assert.equal(JSON.stringify(doc),before);
  });

  await t.test('visible format choices convert reading downloads and retain JSON and notebook originals',async()=>{
   const raw='我們寫代碼，頭髮很長。',doc=makeDoc('exports',{segments:[{id:'a',start:0,end:2,text:raw}],notes:{a:'保留筆記'}}),before=JSON.stringify(doc);
   await render(doc);const format=host.querySelector('.rw-exports [role=combobox]');assert.ok(format);assert.equal(win.document.getElementById(format.getAttribute('aria-labelledby')).textContent,'文件格式');assert.equal(host.querySelector('.rw-exports select'),null);assert.equal(host.querySelector('details.rw-exports'),null);
   const blobs=[],savedCreate=URL.createObjectURL,savedRevoke=URL.revokeObjectURL;URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:authored';};URL.revokeObjectURL=()=>{};
   try{
    const download=async label=>{
     await act(async()=>format.click());const option=[...host.querySelectorAll('.rw-exports [role=option]')].find(node=>node.textContent.startsWith(label));assert.ok(option,label);
     await act(async()=>option.click());const count=blobs.length;await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='下载本篇').click());assert.equal(blobs.length,count+1);return blobs.at(-1).text();
    };
    for(const label of ['TXT','SRT','VTT'])assert.match(await download(label),/我们写代码，头发很长。/);
    assert.deepEqual(JSON.parse(await download('Coconut JSON')),JSON.parse(before));const notebook=await download('Markdown');assert.match(notebook,/我們寫代碼，頭髮很長。/);assert.match(notebook,/保留筆記/);
   }finally{URL.createObjectURL=savedCreate;URL.revokeObjectURL=savedRevoke;}
   assert.equal(JSON.stringify(doc),before);
  });
 }finally{if(root){const {act}=await import('react');await act(async()=>root.unmount());}await win.happyDOM.abort();for(const [name,value]of Object.entries(previous))value?Object.defineProperty(globalThis,name,value):delete globalThis[name];globalThis.MessageChannel=SavedChannel;for(const channel of channels){channel.port1.close();channel.port2.close();}await rm(temp,{recursive:true,force:true});}
});
