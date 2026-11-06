import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {Window} from 'happy-dom';
const require=createRequire(import.meta.url),C=require('../reader/core.js');

test('continuous playback and local passage review retain context, repeat in place and fence changed sources',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'coconut-listening-')),w=new Window({url:'http://localhost/'}),previous={};
    for(const name of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','CSS']){
        previous[name]=Object.getOwnPropertyDescriptor(globalThis,name);
        Object.defineProperty(globalThis,name,{value:w[name]||w,configurable:true,writable:true});
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT=true;
    w.Coconut=C;w.CoconutPassages=require('../reader/passages.js');w.CoconutPassagePlayback=require('../reader/passage-playback.js');
    w.HTMLElement.prototype.scrollIntoView=()=>{};
    const result=await build({stdin:{contents:"export {ReaderWorkspace} from './frontend/reader-workspace/workspace';export {createRoot} from 'react-dom/client';export {createElement,act} from 'react';",resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false});
    await writeFile(join(directory,'reader.cjs'),result.outputFiles[0].contents);
    const savedChannel=globalThis.MessageChannel,channels=[];
    globalThis.MessageChannel=class extends savedChannel{constructor(){super();channels.push(this);}};
    const {ReaderWorkspace,createRoot,createElement,act}=require(join(directory,'reader.cjs'));
    const host=w.document.createElement('div');w.document.body.append(host);const root=createRoot(host);
    let media={url:'blob:original',identity:'file-candidate-v1:listening',name:'voice.wav',kind:'audio'},revision=1,plays=0;
    let doc={key:'listening',title:'Authored listening',language:'zh',notes:{},segments:[
        {id:'a',start:0,end:2,text:'开头',words:[{word:'开',start:.1,end:.3},{word:'头',start:.3,end:.5}]},
        {id:'b',start:10,end:12,text:'重复重复',words:[{word:'重复',start:10,end:10.5},{word:'重复',start:11,end:11.5}]}
    ],media_timing:{version:1,identity:media.identity,offset:2}};
    const render=()=>root.render(createElement(ReaderWorkspace,{document:doc,revision,media,onSaveDocument:async()=>{throw Error('Listening must not write source');},onReadingPosition:()=>{},onRequestAi:()=>{throw Error('Listening must not request AI');}}));
    w.HTMLMediaElement.prototype.play=async function(){plays++;this.dispatchEvent(new w.Event('play'));};
    w.HTMLMediaElement.prototype.pause=function(){this.dispatchEvent(new w.Event('pause'));};
    const button=name=>host.querySelector('button[aria-label="'+name+'"]');
    const select=async(id,from,to)=>act(async()=>{
        const source=host.querySelector('[data-source-id="'+id+'"]'),walker=w.document.createTreeWalker(source,4),point=offset=>{
            walker.currentNode=source;
            for(let node=walker.nextNode();node;node=walker.nextNode()){
                if(offset<=node.textContent.length)return [node,offset];offset-=node.textContent.length;
            }
        };
        const range=w.document.createRange();range.setStart(...point(from));range.setEnd(...point(to));
        w.getSelection().removeAllRanges();w.getSelection().addRange(range);source.dispatchEvent(new w.MouseEvent('mouseup',{bubbles:true}));
    });
    try{
        await act(async()=>render());let player=host.querySelector('audio');
        Object.defineProperty(player,'duration',{value:60,configurable:true});await act(async()=>player.dispatchEvent(new w.Event('loadedmetadata')));
        assert.equal(plays,0);assert.equal(button('重听刚才所选'),null);
        await select('b',2,4);await act(async()=>button('从所选位置播放').click());
        assert.equal(player.currentTime,12.5,'11 seconds + 2-second calibration - half a second of context');
        assert.equal(plays,1);assert.equal(button('重听刚才所选'),null,'playing a selection does not add another playback button');assert.equal(w.getSelection().toString(),'');
        await act(async()=>{player.currentTime=30;player.playbackRate=1.5;player.dispatchEvent(new w.Event('timeupdate'));player.pause();});
        await select('a',0,1);
        assert.equal(button('重听刚才所选'),null);assert.equal(player.currentTime,30,'selecting another word does not seek or start playback');
        assert.equal(player.playbackRate,1.5);assert.equal(plays,1);
        await act(async()=>{revision++;doc={...doc,media_timing:{...doc.media_timing,offset:-.2}};render();});
        assert.equal(button('重听刚才所选'),null,'document changes do not add replay controls');
        await select('a',0,1);await act(async()=>button('从所选位置播放').click());
        assert.equal(player.currentTime,0,'context is clamped after calibration, never before the media origin');assert.equal(plays,2);
        await act(async()=>{media={...media,url:'blob:replacement'};render();});player=host.querySelector('audio');
        Object.defineProperty(player,'duration',{value:60,configurable:true});await act(async()=>player.dispatchEvent(new w.Event('loadedmetadata')));
        assert.equal(button('重听刚才所选'),null,'replacement media does not add replay controls');assert.equal(plays,2);
        await select('b',2,4);await act(async()=>button('从所选位置播放').click());
        assert.equal(player.currentTime,10.3);assert.equal(plays,3);
        await act(async()=>{media=null;render();});await act(async()=>{media={url:'blob:replacement',identity:'file-candidate-v1:listening',name:'voice.wav',kind:'audio'};render();});
        assert.equal(button('重听刚才所选'),null,'reattaching media does not add replay controls');assert.equal(plays,3);
        player=host.querySelector('audio');Object.defineProperty(player,'duration',{value:60,configurable:true});
        await act(async()=>player.dispatchEvent(new w.Event('loadedmetadata')));
        const original=host.querySelector('[data-source-id="a"]').closest('.rw-original');
        await act(async()=>{original.focus();original.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));});
        assert.equal(w.getSelection().toString(),'开头','keyboard review chooses a short context rather than a single aligned character');
        const review=button('回听所选片段');assert.ok(review);assert.equal(plays,3,'choosing review context never autoplays');
        await act(async()=>review.click());assert.equal(plays,4);assert.equal(player.currentTime,0);
        assert.match(review.textContent,/再听一遍/);assert.equal(host.querySelector('.reader-workspace').dataset.following,'false','review stays at the suspect passage');
        await act(async()=>{player.currentTime=1;player.dispatchEvent(new w.Event('timeupdate'));});
        assert.ok(Math.abs(player.currentTime-.65)<.001,'bounded review pauses after the selection plus a little following audio');
        assert.ok(button('回听所选片段'),'the review remains available after completion');
        await act(async()=>{host.querySelector('.rw-player-play').dispatchEvent(new w.PointerEvent('pointerdown',{bubbles:true}));player.pause();});
        assert.ok(button('回听所选片段'),'using the transport keeps the local comparison and repeat action');
        await act(async()=>{player.playbackRate=1.5;review.click();});
        assert.equal(player.currentTime,0);assert.equal(player.playbackRate,1.5);assert.equal(plays,5);
        assert.equal(w.getSelection().toString(),'开头','replaying keeps the highlighted comparison text');
        await act(async()=>{revision++;doc={...doc,segments:doc.segments.map(cue=>cue.id==='a'?{...cue,text:'改过'}:cue)};render();});
        assert.equal(button('回听所选片段'),null,'changed source cannot replay the old review range');
        await act(async()=>{revision++;doc={...doc,media_timing:{...doc.media_timing,offset:0},segments:[{id:'tail',start:59.8,end:60,text:'最后',words:[{word:'最',start:59.8,end:59.9},{word:'后',start:59.9,end:60}]}]};render();});
        const tail=host.querySelector('[data-source-id="tail"]').closest('.rw-original');
        await act(async()=>{w.getSelection().removeAllRanges();tail.focus();tail.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));});
        await act(async()=>button('回听所选片段').click());assert.ok(Math.abs(player.currentTime-59.3)<.001);
        await act(async()=>{player.currentTime=60.1;player.dispatchEvent(new w.Event('timeupdate'));});
        assert.equal(player.currentTime,60,'following context is capped at the real media end');
    }finally{
        await act(async()=>root.unmount());
        for(const name of Object.keys(previous)){if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else delete globalThis[name];}
        for(const channel of channels){channel.port1.close();channel.port2.close();}
        globalThis.MessageChannel=savedChannel;delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        await w.happyDOM.close();await rm(directory,{recursive:true,force:true});
    }
});
