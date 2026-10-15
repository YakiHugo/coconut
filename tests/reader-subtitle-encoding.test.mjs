// Shared reader domain regressions used by the React application.
import test from 'node:test';

import assert from 'node:assert/strict';

import {createRequire} from 'node:module';

import {encodingFixtures,bytesFor} from './helpers/subtitle-encoding-fixtures.mjs';

const C=createRequire(import.meta.url)('../reader/core.js');

const fixture=name=>encodingFixtures.find(f=>f.name.startsWith(name));

for(const f of encodingFixtures)test('real bytes decode '+f.name,()=>{
 const bytes=bytesFor(f),initial=C.decodeSubtitleBytes(bytes);
 assert.equal(initial.ok,!f.encoding);
 const decoded=f.encoding?C.decodeSubtitleBytes(bytes,f.encoding):initial;
 assert.equal(decoded.ok,true);assert.equal(decoded.text,f.text);
 const parsed=C.parse(decoded.text,f.name);assert.equal(parsed.segments[0].start,.125);assert.equal(parsed.segments[0].end,2.75);
 assert.equal(parsed.segments[0].text,f.text.trim().split('\r\n').slice(-2).join('\n'));
});

test('fatal bytes, BOM mismatch, unsupported label, NUL and literal replacement character have distinct results',()=>{
 for(const bytes of [[0xff,0xfe,0x31],[0xfe,0xff,0xd8,0],[0xff,0xfe,0,0xdc],[0xc3,0x28]])assert.equal(C.decodeSubtitleBytes(new Uint8Array(bytes)).ok,false);
 assert.match(C.decodeSubtitleBytes(bytesFor(fixture('utf16le')),'utf-16be').error,/BOM/);
 assert.match(C.decodeSubtitleBytes(bytesFor(fixture('utf8')),'arbitrary').error,/不支持/);
 assert.match(C.decodeSubtitleBytes(new Uint8Array([65,0,66])).error,/NUL/);
 assert.equal(C.decodeSubtitleBytes(new TextEncoder().encode('Actual � in source')).text,'Actual � in source');
 const old=global.TextDecoder;try{global.TextDecoder=class extends old{constructor(label,options){if(label==='gb18030')throw Error('Unavailable');super(label,options);}};assert.equal(C.subtitleEncodings().find(e=>e.id==='gb18030').available,false);assert.match(C.decodeSubtitleBytes(bytesFor(fixture('gb18030')),'gb18030').error,/当前浏览器不支持/);}finally{global.TextDecoder=old;}
});
