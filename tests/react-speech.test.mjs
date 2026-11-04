import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const output=await build({entryPoints:['frontend/reader-workspace/speech.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {speechParts,selectionPlaybackStart}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
const cue=()=>({id:'a',start:10,end:20,text:'第一句。第二句。',words:[
    {word:'第一句。',start:11,end:13},{word:'第二句。',start:16,end:19}
]});
const selection=from=>({cueIds:['a'],from,to:8,text:'第二句。',separators:[]});

test('sentence parts preserve original offsets and actual clocks, including pauses',()=>{
    const source=cue(),before=structuredClone(source),parts=speechParts(source);
    assert.deepEqual(parts,[{from:0,to:4,start:11,end:13},{from:4,to:8,start:16,end:19}]);
    assert.equal(parts.map(part=>source.text.slice(part.from,part.to)).join(''),source.text);
    assert.deepEqual(source,before);
    assert.deepEqual(selectionPlaybackStart({segments:[source]},selection(5)),{seconds:16,wordAligned:true});
});

test('missing, stale, invalid or out-of-order word clocks fall back to the source cue',()=>{
    const cases=[{...cue(),words:undefined},{...cue(),text:'校对后不同的文字。'},
        {...cue(),words:[{word:'第一句。第二句。',start:9,end:19}]},
        {...cue(),words:[{word:'第一句。',start:16,end:17},{word:'第二句。',start:12,end:19}]},
        {...cue(),words:[{word:'第一句。第二句。',start:11,end:Infinity}]}];
    for(const source of cases){
        assert.deepEqual(speechParts(source),[{from:0,to:source.text.length,start:10,end:20}]);
        assert.deepEqual(selectionPlaybackStart({segments:[source]},selection(4)),{seconds:10,wordAligned:false});
    }
});

test('repeated words and Unicode use original UTF-16 offsets instead of searching selected text',()=>{
    const source={id:'a',start:0,end:8,text:'🥥 yes. yes.',words:[
        {word:'🥥 ',start:0,end:1},{word:'yes.',start:1,end:2},{word:' yes.',start:5,end:7}]};
    assert.deepEqual(selectionPlaybackStart({segments:[source]},{...selection(8),to:source.text.length}),{seconds:5,wordAligned:true});
    const parts=speechParts(source);assert.equal(parts.map(part=>source.text.slice(part.from,part.to)).join(''),source.text);
    assert.equal(selectionPlaybackStart({segments:[source]},{...selection(1),cueIds:['missing']}),null);
});
test('selection starting exactly at a cue boundary plays the next selected source, not an empty prefix',()=>{
    const source=[{id:'a',start:0,end:1,text:'before'},{id:'b',start:30,end:31,text:'next'}];
    assert.deepEqual(selectionPlaybackStart({segments:source},{cueIds:['a','b'],from:6,to:10,text:' nex',separators:[' ']}),{seconds:30,wordAligned:false});
});
