import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {Window} from 'happy-dom';

const require=createRequire(import.meta.url);

test('player distinguishes continuous selection playback from bounded evidence playback',async t=>{
    const directory=await mkdtemp(join(tmpdir(),'coconut-player-')),win=new Window({url:'http://localhost/'}),previous={};
    for(const name of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','CSS']){
        previous[name]=Object.getOwnPropertyDescriptor(globalThis,name);
        Object.defineProperty(globalThis,name,{value:win[name]||win,configurable:true,writable:true});
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT=true;
    const playback=require('../reader/passage-playback.js'),controllers=[];
    win.CoconutPassagePlayback={create:options=>{
        const controller=playback.create(options);controllers.push(controller);return controller;
    }};
    const pauses=new WeakMap(),plays=new WeakMap();
    win.HTMLMediaElement.prototype.play=async function(){
        plays.set(this,(plays.get(this)||0)+1);
        Object.defineProperty(this,'paused',{value:false,configurable:true});
        this.dispatchEvent(new win.Event('play'));
    };
    win.HTMLMediaElement.prototype.pause=function(){
        pauses.set(this,(pauses.get(this)||0)+1);
        Object.defineProperty(this,'paused',{value:true,configurable:true});
        this.dispatchEvent(new win.Event('pause'));
    };
    const result=await build({stdin:{contents:`
        export {ReaderPlayer} from './frontend/reader-workspace/player';
        export {speechSelection,selectionPlaybackStart,LISTENING_LEAD_SECONDS} from './frontend/reader-workspace/speech';
        export {createRoot} from 'react-dom/client';
        export {createElement,act} from 'react';
    `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false});
    await writeFile(join(directory,'player.cjs'),result.outputFiles[0].contents);
    const savedChannel=globalThis.MessageChannel,channels=[];
    globalThis.MessageChannel=class extends savedChannel{constructor(){super();channels.push(this);}};
    const {ReaderPlayer,speechSelection,selectionPlaybackStart,LISTENING_LEAD_SECONDS,createRoot,createElement,act}=require(join(directory,'player.cjs'));
    const media={identity:'original',url:'blob:original',kind:'audio',name:'Original audio'};
    const intent=(id,seconds,extra={})=>({id,owner:media.identity,attachmentURL:media.url,attachmentId:1,seconds,play:true,...extra});
    let root,host,player,seek=null,progress=[],times=[];
    const render=()=>root.render(createElement(ReaderPlayer,{media,seek,onTime:seconds=>times.push(seconds),onProgress:(seconds,duration)=>progress.push({seconds,duration})}));
    const mount=async()=>{
        host=win.document.createElement('div');win.document.body.append(host);root=createRoot(host);
        seek=null;progress=[];times=[];
        await act(async()=>render());player=host.querySelector('audio');
    };
    const metadata=async duration=>{
        Object.defineProperty(player,'duration',{value:duration,configurable:true});
        await act(async()=>player.dispatchEvent(new win.Event('loadedmetadata')));
    };
    const request=async next=>act(async()=>{seek=next;render();});
    const advance=async seconds=>act(async()=>{
        player.currentTime=seconds;player.dispatchEvent(new win.Event('timeupdate'));
    });
    const unmount=async()=>{
        await act(async()=>root.unmount());root=null;host.remove();
    };
    try{
        await t.test('a clicked selection starts with lead-in and keeps playing past its excerpt end',async()=>{
            await mount();await metadata(60);
            const cue={id:'a',start:10,end:20,text:'第一句。第二句。',words:[
                {word:'第一句。',start:11,end:13},{word:'第二句。',start:16,end:19}
            ]};
            const selection=speechSelection(cue,1),doc={segments:[cue]},start=selectionPlaybackStart(doc,selection),calibration=2;
            const seconds=Math.max(0,start.seconds+calibration-LISTENING_LEAD_SECONDS);
            await request(intent(1,seconds));
            assert.equal(player.currentTime,12.5);
            assert.equal(plays.get(player),1);
            assert.equal(controllers.at(-1).getState().range,null);
            const pauseCount=pauses.get(player)||0,beyondExcerpt=cue.words[0].end+calibration+1;
            await advance(beyondExcerpt);
            assert.equal(player.currentTime,beyondExcerpt,'the selected excerpt does not cap ordinary playback');
            assert.equal(player.paused,false);
            assert.equal(pauses.get(player)||0,pauseCount);
            assert.equal(times.at(-1),beyondExcerpt);
            assert.deepEqual(progress.at(-1),{seconds:beyondExcerpt,duration:60},'continuous playback saves the current listening position');
            await unmount();
        });
        await t.test('an explicit evidence end still pauses and clamps at its boundary',async()=>{
            await mount();await metadata(60);
            player.currentTime=40;
            await request(intent(1,10,{end:12}));
            assert.equal(player.currentTime,10);
            assert.equal(player.paused,false);
            assert.deepEqual(controllers.at(-1).getState().returnPosition,{time:40,wasPlaying:false});
            await advance(13);
            assert.equal(player.currentTime,12);
            assert.equal(player.paused,true);
            assert.equal(controllers.at(-1).getState().status,'finished');
            await unmount();
        });
        await t.test('continuous playback cancels an earlier bounded review and its saved origin',async()=>{
            await mount();await metadata(60);
            player.currentTime=40;
            await request(intent(1,10,{end:12}));
            await request(intent(2,11));
            assert.equal(plays.get(player),2);
            assert.equal(controllers.at(-1).getState().range,null);
            assert.equal(controllers.at(-1).getState().returnPosition,null);
            const pauseCount=pauses.get(player)||0;
            await advance(14);
            assert.equal(player.currentTime,14,'the previous end must not clamp the new continuous seek');
            assert.equal(player.paused,false);
            assert.equal(pauses.get(player)||0,pauseCount);
            assert.deepEqual(progress.at(-1),{seconds:14,duration:60},'the previous review origin must not replace continuous progress');
            await unmount();
        });
        await t.test('a continuous intent waiting for metadata retains its start and autoplay',async()=>{
            await mount();
            Object.defineProperty(player,'duration',{value:NaN,configurable:true});
            await request(intent(1,5.5));
            assert.equal(plays.get(player)||0,0);
            assert.equal(player.currentTime,0);
            await metadata(60);
            assert.equal(player.currentTime,5.5);
            assert.equal(plays.get(player),1);
            await advance(20);
            assert.equal(player.currentTime,20);
            assert.equal(player.paused,false);
            assert.equal(controllers.at(-1).getState().range,null);
            await unmount();
        });
    }finally{
        if(root)await act(async()=>root.unmount());
        for(const name of Object.keys(previous)){
            if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else delete globalThis[name];
        }
        for(const channel of channels){channel.port1.close();channel.port2.close();}
        globalThis.MessageChannel=savedChannel;delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        await win.happyDOM.close();await rm(directory,{recursive:true,force:true});
    }
});
