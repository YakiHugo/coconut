/** Synthetic DOM/geometry negative controls, not native layout/input evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {installNativeMediaViewportProof,nativeMediaAnchorIsStable,nativeMediaPhaseDelta} from './helpers/native-media-viewport.mjs';

function fixture(t){
 const w=new Window();t.after(()=>w.happyDOM.close());
 Object.defineProperties(w,{innerWidth:{value:780,configurable:true},innerHeight:{value:800,configurable:true}});
 w.document.body.innerHTML='<div id="reader-workspace"><div id="reading-mode-toolbar"></div><div id="transcript"><section class="segment selected" data-segment-id="authored"><p class="words"><span>Authored text</span></p></section></div><section id="notes-panel"><button id="close-note"></button><p id="quote">This note quote is not a transcript anchor</p><textarea id="note"></textarea></section></div><div id="media-dock"><button id="dock-rewind"></button></div>';
 const $=id=>w.document.getElementById(id),words=w.document.querySelector('.words'),node=words.firstChild.firstChild;
 const rect=(x,y,width,height)=>({x,y,left:x,top:y,right:x+width,bottom:y+height,width,height});
 const geometry={toolbar:rect(232,6,501,93),dock:rect(232,720,501,64),panel:rect(40,300,700,400),note:rect(60,430,640,130),close:rect(660,320,44,32),rewind:rect(240,730,44,44),words:rect(324,175,300,60),glyph:rect(324,175,8,18)};
 for(const [id,key]of [['reading-mode-toolbar','toolbar'],['media-dock','dock'],['notes-panel','panel'],['note','note'],['close-note','close'],['dock-rewind','rewind']])$(id).getBoundingClientRect=()=>geometry[key];
 words.getBoundingClientRect=()=>geometry.words;
 w.Range.prototype.getBoundingClientRect=function(){return {...geometry.glyph};};
 const inside=(r,x,y)=>x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;
 w.document.elementFromPoint=(x,y)=>{
  if(x<0||x>=w.innerWidth||y<0||y>=w.innerHeight)return null;
  for(const [key,id]of [['toolbar','reading-mode-toolbar'],['note','note'],['close','close-note'],['panel','notes-panel'],['rewind','dock-rewind'],['dock','media-dock']])if(inside(geometry[key],x,y))return $(id);
  if(inside(geometry.words,x,y))return words.firstElementChild||words;
  return $('reader-workspace');
 };
 w.eval('('+installNativeMediaViewportProof.toString()+')()');
 return {w,$,words,node,geometry,rect,capture:()=>w.__nativeDockSourceAnchor(),proof:a=>w.__nativeDockCheckAnchor(a)};
}

test('a prepared native source anchor binds the real nested Text, offsets, owner and hit point',t=>{
 const f=fixture(t),a=f.capture(),p=f.proof(a);
 assert.equal(a.node,f.node);assert.equal(a.offset,0);assert.equal(a.end,1);assert.equal(a.character,'A');assert.equal(p.hit.tag,'SPAN');assert.equal(nativeMediaAnchorIsStable(p),true);
 const view=f.w.__nativeDockReadingView(a);assert.deepEqual({...view.viewport},{width:780,height:800});assert.equal(view.note.visible,true);assert.equal(view.close.visible,true);assert.equal(view.rewind.visible,true);
});

test('the original 780x620 note overlay yields no transcript anchor, never its visible note quote',t=>{
 const f=fixture(t);Object.defineProperty(f.w,'innerHeight',{value:620});f.geometry.panel=f.rect(40,118,700,401);f.geometry.dock=f.rect(232,540,501,64);
 assert.equal(f.capture(),null);const p=f.proof(null);assert.equal(nativeMediaAnchorIsStable(p),false);assert.equal(p.reason,'no-unobscured-transcript-character');assert.ok(p.scan.rejected.some(r=>r.hit.id==='notes-panel'));
});

for(const [name,change]of [
 ['toolbar occlusion',f=>{f.geometry.glyph=f.rect(324,90,8,18);} ],
 ['dock occlusion',f=>{f.geometry.words=f.rect(324,710,300,70);f.geometry.glyph=f.rect(324,720,8,18);} ],
 ['offscreen left edge',f=>{f.geometry.glyph=f.rect(-1,175,8,18);} ],
 ['offscreen right edge',f=>{f.geometry.glyph=f.rect(778,175,8,18);} ],
 ['zero-area Range',f=>{f.geometry.glyph=f.rect(324,175,0,18);} ],
 ['blank source',f=>{f.node.data='   ';} ],
])test('native source preflight rejects '+name,t=>{const f=fixture(t);change(f);assert.equal(f.capture(),null);assert.equal(nativeMediaAnchorIsStable(f.proof(null)),false);});

for(const [name,change]of [
 ['a moved glyph',f=>{f.geometry.glyph=f.rect(324,176,8,18);} ],
 ['a resized glyph',f=>{f.geometry.glyph=f.rect(324,175,9,18);} ],
 ['changed source text',f=>{f.node.data='Different text';} ],
 ['changed offsets',(f,a)=>a.range.setEnd(f.node,2)],
 ['disconnected source',f=>f.words.remove()],
 ['changed cue ownership',f=>{f.words.closest('.segment').dataset.segmentId='another';}],
 ['new overlay',f=>{f.geometry.panel=f.rect(40,118,700,401);}],
])test('the SAME prepared anchor rejects '+name+' at pointer or receipt instead of recapturing',t=>{
 const f=fixture(t),a=f.capture();assert.equal(nativeMediaAnchorIsStable(f.proof(a)),true);change(f,a);assert.equal(nativeMediaAnchorIsStable(f.proof(a)),false);
});

test('full Unicode source characters retain their real UTF-16 offsets',t=>{
 const f=fixture(t);f.node.data='  𠀀 original';const a=f.capture();assert.equal(a.character,'𠀀');assert.equal(a.offset,2);assert.equal(a.end,4);assert.equal(nativeMediaAnchorIsStable(f.proof(a)),true);
});

test('reading preparation measures one real gap without changing scroll or layout',t=>{
 const f=fixture(t);let scrolls=0;f.w.scrollBy=()=>scrolls++;const a=f.w.__nativeDockReadingPreparation();assert.equal(a.ready,true);assert.deepEqual({...a.bounds},{top:99,bottom:300});assert.equal(a.wheelDelta,-15);assert.equal(scrolls,0);
 f.geometry.panel=f.rect(40,118,700,401);const rejected=f.w.__nativeDockReadingPreparation();assert.equal(rejected.ready,false);assert.equal(rejected.reason,'no-readable-gap');assert.equal(scrolls,0);
});

test('save-only layout baseline distinguishes the settled rewind growth from any later displacement',()=>{
 const original={scrollY:10344,header:902,rowTop:150},rewound={scrollY:10383,header:941,rowTop:150},saved={...rewound};
 assert.deepEqual(nativeMediaPhaseDelta(saved,original),{scrollDelta:39,headerDelta:39,rowDelta:0});
 assert.deepEqual(nativeMediaPhaseDelta(saved,rewound),{scrollDelta:0,headerDelta:0,rowDelta:0});
 for(const field of ['scrollY','header','rowTop'])assert.ok(Object.values(nativeMediaPhaseDelta({...saved,[field]:saved[field]+1},rewound)).some(delta=>delta!==0));
});
