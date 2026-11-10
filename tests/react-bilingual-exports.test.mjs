import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {Window} from 'happy-dom';

const require=createRequire(import.meta.url),core=require('../reader/core.js');
const fixture=(preference='')=>({...core.validate({
    title:'Saved bilingual source',language:'en',translation_view:preference,notes:{a:'Saved note'},
    segments:['Original phrase.','Further context.'].map((text,index)=>({
        id:index?'b':'a',start:index*2,end:index*2+2,text,
        translations:{
            zh:{text:index?'过期译文。':'中文译文。',source_text:index?'Old source.':text,source_language:'en',provider:'user'},
            fr:{text:index?'Contexte français.':'Traduction française.',source_text:text,source_language:'en',provider:'user'},
            ja:{text:'古い訳',source_text:'Old source.',source_language:'en',provider:'user'},
            de:{text:' ',source_text:text,source_language:'en',provider:'user'}
        }
    }))
}),key:'saved-bilingual'});

test('retained bilingual actions choose saved languages without a reader preference',async t=>{
    const directory=await mkdtemp(join(tmpdir(),'coconut-bilingual-actions-')),win=new Window({url:'http://localhost/'}),previous={};
    for(const name of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','CSS']){
        previous[name]=Object.getOwnPropertyDescriptor(globalThis,name);
        Object.defineProperty(globalThis,name,{value:win[name]||win,configurable:true,writable:true});
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT=true;
    win.Coconut=core;win.HTMLElement.prototype.scrollIntoView=()=>{};
    const result=await build({stdin:{contents:`
        export {BilingualCapture} from './frontend/reader-workspace/bilingual';
        export {ReaderExports} from './frontend/reader-workspace/exports';
        export {createRoot} from 'react-dom/client';
        export {createElement,act,Fragment} from 'react';
    `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false});
    await writeFile(join(directory,'actions.cjs'),result.outputFiles[0].contents);
    const savedChannel=globalThis.MessageChannel,channels=[];
    globalThis.MessageChannel=class extends savedChannel{constructor(){super();channels.push(this);}};
    const {BilingualCapture,ReaderExports,createRoot,createElement,act,Fragment}=require(join(directory,'actions.cjs'));
    const createURL=URL.createObjectURL,revokeURL=URL.revokeObjectURL,blobs=new Map(),downloads=[];
    URL.createObjectURL=blob=>{const url='blob:export-'+blobs.size;blobs.set(url,blob);return url;};
    URL.revokeObjectURL=()=>{};
    win.HTMLAnchorElement.prototype.click=function(){downloads.push({url:this.href,name:this.download});};
    let root,host,doc,selection,saves=[],closed=0;
    const render=()=>root.render(createElement(Fragment,null,
        createElement(BilingualCapture,{doc,selection,disabled:false,save:async next=>{saves.push(next);return true;},onClose:()=>closed++}),
        createElement(ReaderExports,{doc,hasDrafts:false})
    ));
    const mount=async value=>{
        doc=value;selection={cueIds:['a'],from:0,to:8,text:'Original',separators:[]};saves=[];closed=0;
        host=win.document.createElement('div');win.document.body.append(host);root=createRoot(host);
        await act(async()=>render());
    };
    const unmount=async()=>{await act(async()=>root.unmount());root=null;host.remove();};
    const button=(scope,label)=>[...scope.querySelectorAll('button')].find(node=>(node.getAttribute('aria-label')||node.textContent)===label);
    const picker=(scope,label)=>[...scope.querySelectorAll('.rw-choice')].find(node=>node.querySelector('.rw-choice-label').textContent===label);
    const choose=async(scope,label,value)=>{
        const control=picker(scope,label);assert.ok(control,label);
        await act(async()=>control.querySelector('[role=combobox]').click());
        const option=[...control.querySelectorAll('[role=option]')].find(node=>node.textContent.replace('✓','')===value);
        assert.ok(option,'missing '+label+' option '+value);
        await act(async()=>option.click());
    };
    const dialog=()=>host.querySelector('dialog'),exports=()=>host.querySelector('.rw-exports');
    const openCapture=async()=>act(async()=>button(host,'保存双语摘录').click());
    const selectTranslation=async(from,to)=>act(async()=>{
        const input=dialog().querySelector('textarea');input.focus();input.setSelectionRange(from,to);input.dispatchEvent(new win.MouseEvent('mouseup',{bubbles:true}));
    });
    const confirm=async()=>act(async()=>dialog().querySelector('input[type=checkbox]').click());
    const download=async()=>{
        await act(async()=>button(exports(),'下载本篇').click());
        return blobs.get(downloads.at(-1).url).text();
    };
    const enableExport=async()=>{await choose(exports(),'文件格式','TXT 整篇文字');await act(async()=>exports().querySelector('input[type=checkbox]').click());};
    t.afterEach(async()=>{if(root)await unmount();});
    try{
        await t.test('capture offers current saved languages, resets pairing on choice, and saves exact French evidence',async()=>{
            await mount(fixture());const before=JSON.stringify(doc);
            assert.ok(button(host,'保存双语摘录'),'an empty reading preference must not hide bilingual capture');
            await openCapture();assert.equal(dialog().querySelector('textarea').value,'中文译文。');
            await selectTranslation(0,2);await confirm();assert.equal(button(dialog(),'确认保存双语摘录').disabled,false);
            await choose(dialog(),'译文语言','fr');
            assert.equal(dialog().querySelector('textarea').value,'Traduction française.');
            assert.equal(button(dialog(),'确认保存双语摘录').disabled,true);
            assert.equal(dialog().querySelector('input[type=checkbox]').checked,false);
            assert.equal(saves.length,0);assert.equal(JSON.stringify(doc),before,'language choice does not save project metadata');
            await act(async()=>picker(dialog(),'译文语言').querySelector('[role=combobox]').click());
            assert.deepEqual([...picker(dialog(),'译文语言').querySelectorAll('[role=option]')].map(node=>node.textContent.replace('✓','')),['zh','fr']);
            await act(async()=>picker(dialog(),'译文语言').querySelector('[role=combobox]').click());
            await selectTranslation(0,10);await confirm();await act(async()=>button(dialog(),'确认保存双语摘录').click());
            assert.equal(saves.length,1);assert.equal(closed,1);
            const saved=saves[0],record=saved.exact_excerpts[0];
            assert.equal(saved.translation_view,'');assert.equal(record.text,'Original');
            assert.equal(record.translation.language,'fr');assert.equal(record.translation.text,'Traduction');
            assert.deepEqual(core.validate(saved).exact_excerpts,saved.exact_excerpts,'the saved pair remains a valid durable snapshot');
            assert.equal(JSON.stringify(doc),before);await unmount();
        });
        await t.test('export chooses its own language for text, subtitles and Markdown without rewriting JSON',async()=>{
            await mount(fixture());const before=JSON.stringify(doc);
            await openCapture();await choose(dialog(),'译文语言','fr');await act(async()=>button(dialog(),'关闭保存双语摘录').click());
            await enableExport();
            assert.equal(picker(exports(),'译文语言').querySelector('[role=combobox]').textContent,'zh⌄','capture choice does not change the export action');
            await choose(exports(),'译文语言','fr');
            for(const format of ['TXT 整篇文字','SRT 字幕','VTT 字幕','Markdown 阅读笔记']){
                await choose(exports(),'文件格式',format);const text=await download();
                assert.match(text,/Traduction française/);assert.doesNotMatch(text,/中文译文|古い訳|过期译文/);
            }
            await choose(exports(),'译文语言','zh');await choose(exports(),'文件格式','TXT 整篇文字');
            const chinese=await download();assert.match(chinese,/中文译文/);assert.match(chinese,/译文已过期/);assert.doesNotMatch(chinese,/过期译文。|française/);
            await choose(exports(),'文件格式','Coconut JSON 完整项目');assert.equal(await download(),JSON.stringify(doc,null,2));
            assert.equal(saves.length,0);assert.equal(JSON.stringify(doc),before);
            assert.equal(host.querySelector('select,details'),null);await unmount();
        });
        await t.test('an existing project language initializes each action and remains unchanged by local choices',async()=>{
            await mount(fixture('fr'));const before=JSON.stringify(doc);
            await openCapture();assert.equal(dialog().querySelector('textarea').value,'Traduction française.');
            await choose(dialog(),'译文语言','zh');await act(async()=>button(dialog(),'关闭保存双语摘录').click());
            await enableExport();assert.equal(picker(exports(),'译文语言').querySelector('[role=combobox]').textContent,'fr⌄');
            await choose(exports(),'译文语言','zh');assert.match(await download(),/中文译文/);
            assert.equal(doc.translation_view,'fr');assert.equal(JSON.stringify(doc),before);assert.equal(saves.length,0);await unmount();
        });
        await t.test('one current language works when the preferred language is stale, and no current language disables the actions',async()=>{
            const value=fixture('ja');delete value.segments[0].translations.zh;
            await mount(value);await openCapture();assert.equal(dialog().querySelector('textarea').value,'Traduction française.');
            assert.equal(picker(dialog(),'译文语言'),undefined);await act(async()=>button(dialog(),'关闭保存双语摘录').click());
            await enableExport();assert.equal(exports().querySelector('input[type=checkbox]').disabled,false);assert.equal(picker(exports(),'译文语言'),undefined);
            assert.match(await download(),/Traduction française/);assert.equal(doc.translation_view,'ja');await unmount();
            const stale=fixture();for(const cue of stale.segments)cue.translations.fr.source_text='Outdated source.';stale.segments[0].translations.zh.source_text='Outdated source.';
            await mount(stale);assert.equal(button(host,'保存双语摘录'),undefined);
            await choose(exports(),'文件格式','TXT 整篇文字');assert.equal(exports().querySelector('input[type=checkbox]').disabled,true);await unmount();
        });
        await t.test('changed translation evidence cannot save a previously confirmed pair',async()=>{
            await mount(fixture());await openCapture();await choose(dialog(),'译文语言','fr');await selectTranslation(0,10);await confirm();
            doc.segments[0].translations.fr.text='Changed translation after confirmation.';
            await act(async()=>button(dialog(),'确认保存双语摘录').click());
            assert.equal(saves.length,0);assert.match(dialog().querySelector('[role=alert]').textContent,/依据已变化/);await unmount();
        });
        await t.test('a replacement model requires a fresh translation range even if its language stays the same',async()=>{
            await mount(fixture());await openCapture();await selectTranslation(0,2);await confirm();
            doc={...doc,segments:doc.segments.map(cue=>({...cue}))};await act(async()=>render());
            assert.equal(button(dialog(),'确认保存双语摘录').disabled,true);assert.equal(saves.length,0);await unmount();
        });
    }finally{
        if(root)await act(async()=>root.unmount());
        URL.createObjectURL=createURL;URL.revokeObjectURL=revokeURL;
        for(const name of Object.keys(previous)){
            if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else delete globalThis[name];
        }
        for(const channel of channels){channel.port1.close();channel.port2.close();}
        globalThis.MessageChannel=savedChannel;delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        await win.happyDOM.close();await rm(directory,{recursive:true,force:true});
    }
});
