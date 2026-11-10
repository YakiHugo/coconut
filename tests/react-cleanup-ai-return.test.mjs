import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {Window} from 'happy-dom';
const require=createRequire(import.meta.url),C=require('../reader/core.js'),P=require('../reader/passages.js'),D=require('../reader/disfluency.js');

test('AI return to cleaned passages retains exact source actions and keyboard entry, while changed projections and sources dismiss stale selections',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'coconut-cleanup-ai-return-')),w=new Window({url:'http://localhost/'}),previous={};
    for(const name of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','CSS','IS_REACT_ACT_ENVIRONMENT']){
        previous[name]=Object.getOwnPropertyDescriptor(globalThis,name);
        Object.defineProperty(globalThis,name,{value:name==='IS_REACT_ACT_ENVIRONMENT'?true:w[name]||w,configurable:true,writable:true});
    }
    w.Coconut=C;w.CoconutPassages=P;
    w.HTMLElement.prototype.scrollIntoView=()=>{};
    const copied=[],requests=[],saved=[];
    Object.defineProperty(w.navigator.clipboard,'writeText',{value:async text=>{copied.push(text);},configurable:true});
    const savedChannel=globalThis.MessageChannel,channels=[];
    let root,act;
    try{
        const result=await build({stdin:{contents:"export {ReaderWorkspace} from './frontend/reader-workspace/workspace';export {createRoot} from 'react-dom/client';export {createElement,act} from 'react';",resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false});
        await writeFile(join(directory,'reader.cjs'),result.outputFiles[0].contents);
        globalThis.MessageChannel=class extends savedChannel{constructor(){super();channels.push(this);}};
        const mounted=require(join(directory,'reader.cjs'));act=mounted.act;
        const {ReaderWorkspace,createRoot,createElement}=mounted;
        const host=w.document.createElement('div');w.document.body.append(host);root=createRoot(host);
        let revision=1,aiReturnRequest;
        let doc={key:'cleanup-ai-return',title:'自写口语回归',language:'zh',notes:{},segments:[
            {id:'a',start:0,end:6,speaker:'甲',text:'我呃知道🙂今天讨论模型然后谈产品'},
            {id:'b',start:7,end:9,speaker:'乙',text:'另一段原话保留。'}
        ]};
        const plan=()=>({version:1,policyVersion:'authored-v1',sourceSignature:D.signature(doc),
            decisions:[{cue_id:'a',from:1,to:2,action:'hide',reason:'自写语气词'}],
            marks:[{cue_id:'a',at:6,mark:'。',reason:'自写句界'}],breaks:[{cue_id:'a',at:6,reason:'自写断句'}]});
        doc={...doc,reading_cleanup:plan()};
        const render=()=>root.render(createElement(ReaderWorkspace,{document:doc,revision,media:null,aiReturnRequest,
            onSaveDocument:async next=>{saved.push(next);return true;},onReadingPosition:()=>{},onRequestAi:selection=>requests.push(selection)}));
        const source=()=>host.querySelector('[data-source-id="a"]');
        const original=()=>source().closest('.rw-original');
        const button=name=>host.querySelector('button[aria-label="'+name+'"]');
        const toolbar=()=>host.querySelector('.rw-selection');
        const tab=mode=>host.querySelector('[role="tab"][data-mode="'+mode+'"]');
        const expectedText='我呃知道🙂今天讨论模型';
        const expectedScope={kind:'exact_source_selection',from:0,to:expectedText.length,separators:[],cueIds:['a']};
        const select=()=>act(async()=>{
            const node=source(),walker=w.document.createTreeWalker(node,4),point=offset=>{
                walker.currentNode=node;
                for(let text=walker.nextNode();text;text=walker.nextNode()){
                    if(offset<=text.textContent.length)return [text,offset];offset-=text.textContent.length;
                }
                assert.fail('Selection offset must be inside canonical source text');
            };
            const range=w.document.createRange();range.setStart(...point(0));range.setEnd(...point(expectedText.length));
            w.getSelection().removeAllRanges();w.getSelection().addRange(range);
            node.dispatchEvent(new w.MouseEvent('mouseup',{bubbles:true}));
        });
        const key=async(target,name,options={})=>{
            const event=new w.KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true,...options});
            await act(async()=>{target.focus();target.dispatchEvent(event);});return event;
        };
        const assertActions=()=>{
            assert.ok(toolbar(),'Returning from AI must retain the restored selection toolbar');
            assert.equal(toolbar().getAttribute('aria-description'),'所选原话：'+expectedText);
            for(const name of ['复制原话','保存精确摘录','理解选中文字','翻译选中文字','关闭选文操作']){
                assert.ok(button(name),name+' remains available');assert.equal(button(name).disabled,false);
            }
        };
        const request=async intent=>{
            await act(async()=>button(intent==='understand'?'理解选中文字':'翻译选中文字').click());
            assert.deepEqual(requests.at(-1),{key:doc.key,revision,intent,text:expectedText,cueIds:['a'],scope:expectedScope});
            assert.equal(toolbar(),null);assert.equal(w.getSelection().rangeCount,0);
        };
        const returnFromSummary=async id=>{
            await act(async()=>tab('summary').click());
            assert.equal(tab('summary').getAttribute('aria-selected'),'true');
            assert.equal(source().hasAttribute('data-cleanup-applied'),false,'Summary deactivates the reading projection');
            await act(async()=>{aiReturnRequest={id,documentKey:doc.key};render();});
            assert.equal(tab('passages').getAttribute('aria-selected'),'true');
            assert.equal(source().dataset.cleanupApplied,'true','AI return reactivates the same cleanup projection');
            assertActions();assert.equal(w.document.activeElement,original());
        };
        const assertCleared=async message=>{
            assert.equal(toolbar(),null,message);assert.equal(w.getSelection().rangeCount,0,message);
            assert.equal((await key(original(),'Tab')).defaultPrevented,false,'A stale selection cannot keep a toolbar keyboard entry');
        };

        await act(async()=>render());
        assert.equal(tab('passages').getAttribute('aria-selected'),'true');
        assert.equal(source().dataset.cleanupApplied,'true');
        assert.equal(source().querySelector('[data-cleanup-hidden]').textContent,'呃');
        assert.equal(source().querySelector('[data-cleanup-mark]').getAttribute('data-cleanup-mark'),'。');
        assert.ok(source().querySelector('[data-cleanup-break]'));
        assert.equal(source().textContent,doc.segments[0].text,'Projection preserves canonical text nodes for exact selection');
        await select();assertActions();
        const clipboard=new w.DataTransfer(),copy=new w.ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:clipboard});
        await act(async()=>source().dispatchEvent(copy));
        assert.equal(copy.defaultPrevented,true);assert.equal(clipboard.getData('text/plain'),expectedText,'Native copy includes hidden filler and excludes reading punctuation');

        await request('understand');await returnFromSummary(1);
        await act(async()=>button('复制原话').click());
        assert.deepEqual(copied,[expectedText],'Restored copy keeps canonical text, hidden filler and UTF-16 boundaries');
        await act(async()=>original().dispatchEvent(new w.KeyboardEvent('keyup',{key:'Enter',bubbles:true})));
        assertActions();
        assert.equal((await key(original(),'Tab')).defaultPrevented,true);
        assert.equal(w.document.activeElement,button('复制原话'),'Tab enters the restored local source actions');
        assert.equal((await key(button('复制原话'),'Tab',{shiftKey:true})).defaultPrevented,true);
        assert.equal(w.document.activeElement,original());
        await request('translate');await returnFromSummary(2);
        await act(async()=>button('保存精确摘录').click());
        assert.equal(saved.length,1);assert.equal(saved[0].exact_excerpts[0].text,expectedText,'Restored excerpt saves exact source rather than cleaned prose');
        assert.deepEqual(saved[0].segments,doc.segments,'Selection actions preserve the source');

        await select();assertActions();
        await act(async()=>tab('summary').click());
        assert.equal(toolbar(),null,'Explicit mode changes dismiss the selection actions');
        assert.equal(w.getSelection().rangeCount,0,'Explicit mode changes clear the hidden source range');
        await act(async()=>tab('passages').click());

        await select();assertActions();
        await act(async()=>{doc={...doc,reading_cleanup:{...doc.reading_cleanup,marks:[{cue_id:'a',at:6,mark:'，',reason:'修订句界'}]}};render();});
        assert.equal(revision,1,'Projection invalidation is tested independently of revision changes');
        assert.equal(source().querySelector('[data-cleanup-mark]').getAttribute('data-cleanup-mark'),'，');
        await assertCleared('Changing the cleanup projection must dismiss the old selection');

        await select();assertActions();
        await act(async()=>{
            doc={...doc,segments:doc.segments.map(cue=>cue.id==='a'?{...cue,text:cue.text.replace('知道','明白')}:cue)};
            doc={...doc,reading_cleanup:plan()};revision++;render();
        });
        assert.equal(source().dataset.cleanupApplied,'true','Changed source uses a newly valid cleanup plan');
        assert.match(source().textContent,/明白/);
        await assertCleared('Changing canonical source must dismiss the old selection');
        assert.equal(requests.length,2);assert.equal(saved.length,1);
    }finally{
        if(root)await act(async()=>root.unmount());
        for(const name of Object.keys(previous)){if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else delete globalThis[name];}
        for(const channel of channels){channel.port1.close();channel.port2.close();}
        globalThis.MessageChannel=savedChannel;
        await w.happyDOM.close();await rm(directory,{recursive:true,force:true});
    }
});
