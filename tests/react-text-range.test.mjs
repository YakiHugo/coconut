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
