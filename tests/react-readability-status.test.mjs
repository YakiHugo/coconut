import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),directory=await mkdtemp(path.join(tmpdir(),'reading-status-'));
const built=await build({stdin:{contents:"export {ReaderSource} from './frontend/reader-workspace/source';export {PassageView} from './frontend/reader-workspace/passages';export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';",resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false});
await writeFile(path.join(directory,'ui.cjs'),built.outputFiles[0].contents);
const {ReaderSource,PassageView,createElement:h,renderToStaticMarkup:render}=require(path.join(directory,'ui.cjs'));
const doc={key:'raw',segments:[{id:'one',start:0,end:2,text:'你好世界',speaker:null}],notes:{},provenance:{kind:'automatic_subtitles',speaker_method:'unavailable'}};
test('raw captions disclose absent punctuation and voices, unavailable is never a completed acoustic stage',()=>{
 const raw=render(h(ReaderSource,{doc}));assert.match(raw,/尚未进行标点整理/);assert.match(raw,/说话人尚未标注/);assert.ok(!raw.includes('按声音自动分组'));
 const punctuated=render(h(ReaderSource,{doc:{...doc,provenance:{...doc.provenance,punctuation_method:'local-reading-v1'}}}));
 assert.ok(!punctuated.includes('尚未进行标点整理'));assert.match(punctuated,/说话人尚未标注/);
 const grouped=render(h(ReaderSource,{doc:{...doc,segments:[{...doc.segments[0],speaker:'说话人 1'}],provenance:{punctuation_method:'local-reading-v1',speaker_method:'recording-acoustic-v1'}}}));
 assert.match(grouped,/按声音自动分组/);assert.ok(!grouped.includes('说话人尚未标注'));
});
test('an entirely unlabelled transcript still displays its unknown speaker explicitly',()=>{
 const previous=globalThis.window;
 globalThis.window={CoconutPassages:require('../reader/passages.js')};
 try{const html=render(h(PassageView,{doc,cues:doc.segments,position:'one',onLocate(){},onListen(){},onPlayFrom(){}}));assert.match(html,/rw-speaker-label[^>]*>未标注/);assert.ok(html.includes('data-source-id="one"'));}finally{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;}
});
test.after(()=>rm(directory,{recursive:true,force:true}));
