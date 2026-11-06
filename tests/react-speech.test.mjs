import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const output=await build({entryPoints:['frontend/reader-workspace/speech.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {speechParts,speechSelection,selectionPlaybackStart,selectionPlaybackRange}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
const cue=()=>({id:'a',start:10,end:20,text:'第一句。第二句。',words:[
    {word:'第一句。',start:11,end:13},{word:'第二句。',start:16,end:19}
]});
const selection=from=>({cueIds:['a'],from,to:8,text:'第二句。',separators:[]});

test('clause parts preserve original offsets and actual clocks, including pauses',()=>{
    const source=cue(),before=structuredClone(source),parts=speechParts(source);
    assert.deepEqual(parts,[{from:0,to:4,start:11,end:13},{from:4,to:8,start:16,end:19}]);
    assert.equal(parts.map(part=>source.text.slice(part.from,part.to)).join(''),source.text);
    assert.deepEqual(source,before);
    assert.deepEqual(selectionPlaybackStart({segments:[source]},selection(5)),{seconds:16,wordAligned:true});
});

test('long unpunctuated speech becomes short timed fragments without changing the transcript',()=>{
    const words=Array.from({length:130},(_,i)=>({word:i%11===0?'，':'字',start:10+i*.2,end:10+(i+1)*.2}));
    const source={id:'a',start:10,end:36,text:words.map(w=>w.word).join(''),words};
    const before=structuredClone(source),parts=speechParts(source);
    assert.ok(parts.length>=10,'a 26-second run must not become one clickable fragment');
    assert.equal(parts[0].from,0);assert.equal(parts.at(-1).to,source.text.length);
    assert.equal(parts.map(p=>source.text.slice(p.from,p.to)).join(''),source.text);
    for(const [index,part] of parts.entries()){
        assert.ok(part.end-part.start<=3);
        assert.equal(part.start,words[part.from].start);assert.equal(part.end,words[part.to-1].end);
        if(index)assert.equal(parts[index-1].to,part.from);
        assert.deepEqual(selectionPlaybackStart({segments:[source]},{cueIds:['a'],...part,text:source.text.slice(part.from,part.to),separators:[]}),{seconds:part.start,wordAligned:true});
    }
    assert.deepEqual(source,before);
});

test('short fillers join their clause and punctuation gives a stable stopping point',()=>{
    const words=[{word:'嗯。',start:0,end:.2},{word:'对！',start:.2,end:.4},{word:'接着说，',start:.4,end:1.8},
        {word:'还有后面的内容',start:1.8,end:3.2},{word:'继续',start:3.2,end:4.2}];
    const source={id:'a',start:0,end:4.2,text:words.map(w=>w.word).join(''),words};
    const parts=speechParts(source);
    assert.deepEqual(parts.map(p=>source.text.slice(p.from,p.to)),['嗯。对！接着说，','还有后面的内容继续']);
    assert.ok(parts.every(p=>p.end-p.start<=3));
});

test('real pauses and dense or zero-duration alignments keep listening selections small',()=>{
    const source={id:'a',start:0,end:4,text:'短暂停下🥥'+'快'.repeat(41),words:[
        {word:'短暂',start:0,end:.3},{word:'停下',start:1,end:1.2},
        {word:'🥥',start:1.2,end:1.3},...Array.from({length:41},()=>({word:'快',start:1.3,end:1.3}))]};
    const parts=speechParts(source);
    assert.equal(source.text.slice(parts[0].from,parts[0].to),'短暂');
    assert.ok(parts.every(p=>p.to-p.from<=36));
    assert.equal(parts.map(p=>source.text.slice(p.from,p.to)).join(''),source.text);
});

test('an indivisible aligned word retains its actual interval rather than fabricated times',()=>{
    const source={id:'a',start:0,end:7,text:'整块对齐后面',words:[{word:'整块对齐',start:0,end:6},{word:'后面',start:6,end:7}]};
    assert.deepEqual(speechParts(source),[{from:0,to:4,start:0,end:6},{from:4,to:6,start:6,end:7}]);
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

test('click offsets choose review context around the suspect unit, including repeated and zero-duration words',()=>{
    const words=[{word:'我',start:10,end:10.08},{word:'也',start:10.08,end:10.08},{word:'采访，',start:10.08,end:10.4},
        {word:'founder ',start:10.4,end:11},{word:'founder',start:11,end:11.5},{word:'🥥',start:11.5,end:12}];
    const source={id:'a',start:10,end:12,text:words.map(w=>w.word).join(''),words};
    for(const [offset,from,to,seconds] of [[0,0,1,10],[1,1,2,10.08],[4,2,5,10.08],[8,5,13,10.4],[15,13,20,11],[21,20,22,11.5]]){
        const selected=speechSelection(source,offset);
        assert.ok(selected.from<=from&&selected.to>=to,'the clicked original unit is fully inside its review context');
        assert.equal(selected.text,source.text.slice(selected.from,selected.to));assert.ok(selected.text.length>to-from);
        const range=selectionPlaybackRange({segments:[source]},selected);
        assert.ok(range.seconds<=seconds);assert.ok(range.endSeconds>=seconds);assert.equal(range.wordAligned,true);
    }
    for(const offset of [-1,.5,source.text.length,NaN])assert.equal(speechSelection(source,offset),null);
    assert.equal(speechSelection({...source,text:'Changed'},1).text,'Changed','stale word clocks use the original cue without guessing word timing');
});

test('review selection prefers nearby clause boundaries and stays small when punctuation is missing',()=>{
    const text='前一句结束。这里的转录有点奇怪，我们再听一次。下一句开始。';
    const source={id:'a',start:0,end:text.length*.2,text,words:[...text].map((word,i)=>({word,start:i*.2,end:(i+1)*.2}))};
    const selected=speechSelection(source,text.indexOf('录'));
    assert.ok(selected.text.includes('转录'));assert.ok(selected.text.endsWith('，'));
    assert.ok(!selected.text.includes('前一句'));assert.ok(!selected.text.includes('下一句'));
    const dense={id:'long',start:0,end:26,text:'字'.repeat(130),words:Array.from({length:130},(_,i)=>({word:'字',start:i*.2,end:(i+1)*.2}))};
    const near=speechSelection(dense,70),range=selectionPlaybackRange({segments:[dense]},near);
    assert.ok(near.from<70&&near.to>71,'review includes context on both sides instead of one character');
    assert.ok(near.from>0&&near.to<130);assert.ok(near.text.length<=36);assert.ok(range.endSeconds-range.seconds<=4);
    assert.equal(near.text,dense.text.slice(near.from,near.to));
});

test('bounded review timing covers all selected cues, retains zero spans and rejects detached sources',()=>{
    const first={id:'a',start:1,end:2,text:'也',words:[{word:'也',start:1,end:1}]},last={id:'b',start:3,end:4,text:'后文',words:[{word:'后',start:3,end:3.2},{word:'文',start:3.2,end:4}]};
    assert.deepEqual(selectionPlaybackRange({segments:[first,last]},{cueIds:['a','b'],from:0,to:3,text:'也后文',separators:['']}),{seconds:1,endSeconds:4,wordAligned:true});
    assert.deepEqual(selectionPlaybackRange({segments:[first]},{cueIds:['a'],from:0,to:1,text:'也',separators:[]}),{seconds:1,endSeconds:1,wordAligned:true});
    assert.equal(selectionPlaybackRange({segments:[first,last]},{cueIds:['a','missing'],from:0,to:3,text:'也后文',separators:['']}),null);
});

test('hover, click and playback share a fixed partition regardless of where inside a clause the user clicks',()=>{
    const text='嗯，我们先核对这句话，再继续看下一段。'+'没有标点时也应当按照稳定的词语边界把很长的内容分成可以回听的短片段'.repeat(2);
    const source={id:'a',start:0,end:text.length*.18,text,words:[...text].map((word,i)=>({word,start:i*.18,end:(i+1)*.18}))};
    const before=structuredClone(source),parts=speechParts(source);
    assert.equal(text.slice(parts[0].from,parts[0].to),'嗯，我们先核对这句话，');
    assert.equal(parts.map(p=>text.slice(p.from,p.to)).join(''),text);
    for(const [index,part] of parts.entries()){
        if(index)assert.equal(parts[index-1].to,part.from,'units are adjacent and do not overlap');
        assert.ok(part.end-part.start<=4);assert.ok(part.to-part.from<=36);
        for(let offset=part.from;offset<part.to;offset++){
            const selected=speechSelection(source,offset);
            assert.deepEqual(selected,{cueIds:['a'],from:part.from,to:part.to,text:text.slice(part.from,part.to),separators:[]});
            assert.deepEqual(selectionPlaybackRange({segments:[source]},selected),{seconds:part.start,endSeconds:part.end,wordAligned:true});
        }
    }
    assert.deepEqual(source,before);
});

test('long unpunctuated clauses prefer whole linguistic words over fixed-character cuts',()=>{
    const text='我们先来介绍一下这个图书馆里面收集的资料然后继续往后讨论';
    const wordStart=text.indexOf('介绍'),step=4/(wordStart+1);
    const source={id:'a',start:0,end:text.length*step,text,words:[...text].map((word,i)=>({word,start:i*step,end:(i+1)*step}))};
    const parts=speechParts(source);
    assert.ok(parts.length>1);
    for(const part of parts){assert.notEqual(part.from,wordStart+1);assert.notEqual(part.to,wordStart+1);}
    assert.equal(parts.map(part=>text.slice(part.from,part.to)).join(''),text);
});
