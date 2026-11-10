import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
const output=await build({entryPoints:['frontend/reader-workspace/text-range.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {textRange,textOffsetAtPoint}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));

test('source ranges retain UTF-16 offsets across nested highlights and surrogate pairs',async()=>{
    const w=new Window();
    try{
        const root=w.document.createElement('p');root.innerHTML='<span>前🥥</span><span><b>后</b>文</span>';
        assert.equal(textRange(root,1,4).toString(),'🥥后');
        assert.equal(textRange(root,3,3).collapsed,true,'a cue-boundary endpoint may be collapsed');
        assert.equal(textRange(root,2,9),null);assert.equal(textRange(root,-1,2),null);
    }finally{await w.happyDOM.close();}
});

test('caret hit testing checks both glyph edges, keeps surrogate pairs intact and rejects padding',async()=>{
    const w=new Window();
    try{
        const root=w.document.createElement('p');root.textContent='前🥥后';w.document.body.append(root);
        const makeRange=w.document.createRange.bind(w.document);
        w.document.createRange=()=>{
            const range=makeRange();range.getClientRects=()=>{
                const left=range.startOffset===0?0:range.startOffset<3?10:30;
                return [{left,right:left+(range.toString()==='🥥'?20:10),top:0,bottom:20,width:range.toString()==='🥥'?20:10}];
            };return range;
        };
        // Right half of the emoji snaps the caret after its surrogate pair.
        w.document.caretPositionFromPoint=()=>({offsetNode:root.firstChild,offset:3});
        assert.equal(textOffsetAtPoint(root,26,10),1);
        assert.equal(textOffsetAtPoint(root,35,10),3);
        assert.equal(textOffsetAtPoint(root,90,10),null);
        w.document.caretPositionFromPoint=undefined;
        w.document.caretRangeFromPoint=()=>{const range=makeRange();range.setStart(root.firstChild,3);range.collapse(true);return range;};
        assert.equal(textOffsetAtPoint(root,26,10),1,'WebKit caretRangeFromPoint uses the same source offsets');
        w.document.caretRangeFromPoint=()=>{const range=makeRange();range.selectNodeContents(w.document.body);range.collapse(true);return range;};
        assert.equal(textOffsetAtPoint(root,10,10),null);
    }finally{await w.happyDOM.close();}
});

test('half-open glyph ranges exclude display-only punctuation and line-break nodes at source boundaries',async()=>{
    const w=new Window();
    try{
        const root=w.document.createElement('p');root.innerHTML='前<span data-cleanup-mark="，"></span><span data-cleanup-break="true"></span><b>后</b><span data-cleanup-mark="。"></span>';
        const next=root.querySelector('b').firstChild,first=root.firstChild;
        const glyph=textRange(root,1,2);
        assert.equal(glyph.toString(),'后');assert.equal(glyph.startContainer,next);assert.equal(glyph.startOffset,0);assert.equal(glyph.endContainer,next);assert.equal(glyph.endOffset,1);
        const previous=textRange(root,0,1);assert.equal(previous.startContainer,first);assert.equal(previous.endContainer,first);assert.equal(previous.toString(),'前');
        const collapsed=textRange(root,1,1);assert.equal(collapsed.collapsed,true);assert.equal(collapsed.startContainer,next);
        assert.equal(textRange(root,2,2).collapsed,true);assert.equal(textRange(root,3,3),null);
    }finally{await w.happyDOM.close();}
});
