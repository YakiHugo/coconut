/** Read-only native acceptance measurements. CPU fixtures test these predicates;
 * only the actual packaged runner can establish layout and trusted input. */
export function installNativeMediaViewportProof(){
 const rectValue=r=>({x:r.left,y:r.top,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height});
 const box=id=>rectValue(document.getElementById(id).getBoundingClientRect());
 const bounds=()=>({top:Math.max(0,box('reading-mode-toolbar').bottom),bottom:Math.min(innerHeight,box('media-dock').top)});
 const hitValue=node=>node?{tag:node.tagName,id:node.id,classes:node.className}:null;
 const hitProof=(r,owner)=>{
  const x=(r.left+r.right)/2,y=(r.top+r.bottom)/2,hit=document.elementFromPoint(x,y),b=bounds();
  return {clear:r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=b.top&&r.bottom<=b.bottom&&!!hit&&owner.contains(hit),point:{x,y},hit:hitValue(hit),bounds:b};
 };
 const characters=function*(words){
  const walker=document.createTreeWalker(words,NodeFilter.SHOW_TEXT);let node;
  while((node=walker.nextNode()))for(let offset=0;offset<node.length;){
   const character=String.fromCodePoint(node.data.codePointAt(offset)),end=offset+character.length;
   if(character.trim()){const range=document.createRange();range.setStart(node,offset);range.setEnd(node,end);yield {node,offset,end,character,range};}
   offset=end;
  }
 };
 window.__nativeDockSourceAnchor=()=>{
  const diagnostic={words:0,characters:0,rejected:[]};window.__nativeDockAnchorScan=diagnostic;
  for(const words of document.querySelectorAll('#transcript .words')){
   const rect=words.getBoundingClientRect(),b=bounds();if(rect.bottom<=b.top||rect.top>=b.bottom)continue;diagnostic.words++;
   for(const candidate of characters(words)){
    diagnostic.characters++;const r=candidate.range.getBoundingClientRect(),hit=hitProof(r,words);
    if(!hit.clear){if(diagnostic.rejected.length<8)diagnostic.rejected.push({cue:words.closest('.segment').dataset.segmentId,offset:candidate.offset,rect:rectValue(r),...hit});continue;}
    return {...candidate,text:candidate.node.data,rect:rectValue(r),words,segment:words.closest('.segment'),cue:words.closest('.segment').dataset.segmentId};
   }
  }return null;
 };
 window.__nativeDockCheckAnchor=a=>{
  if(!a)return {valid:false,reason:'no-unobscured-transcript-character',bounds:bounds(),scan:window.__nativeDockAnchorScan};
  const r=a.range.getBoundingClientRect(),words=a.node.parentElement?.closest('#transcript .words'),hit=hitProof(r,a.words);
  return {valid:true,connected:a.node.isConnected&&a.words.contains(a.node)&&a.segment.contains(a.words),identitySame:a.range.startContainer===a.node&&a.range.endContainer===a.node&&a.range.startOffset===a.offset&&a.range.endOffset===a.end,textSame:a.node.data===a.text,ownerSame:words===a.words&&words?.closest('.segment')===a.segment&&a.segment.dataset.segmentId===a.cue,visible:hit.clear,cue:a.cue,offset:a.offset,end:a.end,character:a.character,before:a.rect,after:rectValue(r),xDelta:r.left-a.rect.left,yDelta:r.top-a.rect.top,widthDelta:r.width-a.rect.width,heightDelta:r.height-a.rect.height,...hit};
 };
 const control=id=>{
  const node=document.getElementById(id),r=node.getBoundingClientRect(),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2,hit=document.elementFromPoint(x,y);
  return {rect:rectValue(r),visible:!node.hidden&&r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&!!hit&&node.contains(hit),point:{x,y},hit:hitValue(hit)};
 };
 window.__nativeDockReadingView=anchor=>({viewport:{width:innerWidth,height:innerHeight},bounds:bounds(),notePanel:box('notes-panel'),note:control('note'),close:control('close-note'),rewind:control('dock-rewind'),sourceAnchor:window.__nativeDockCheckAnchor(anchor)});
 // Measure one ordinary wheel preparation before the audited action. No resize
 // retries, fixed cue/offset guesses, DOM visibility changes or post-click repair.
 window.__nativeDockReadingPreparation=()=>{
  const words=document.querySelector('#transcript .segment.selected .words'),candidate=words&&[...characters(words)].find(a=>{const r=a.range.getBoundingClientRect();return r.width>0&&r.height>0;});
  if(!candidate)return {ready:false,reason:'selected-source-has-no-rendered-character'};
  const r=candidate.range.getBoundingClientRect(),b=bounds(),panel=box('notes-panel'),x=(r.left+r.right)/2;
  const bottom=x>=panel.left&&x<=panel.right?Math.min(b.bottom,panel.top):b.bottom,y=(b.top+bottom)/2,hit=document.elementFromPoint(x,y);
  const ready=bottom-b.top>=r.height+16&&x>=0&&x<innerWidth&&!!hit&&!!hit.closest('#reader-workspace')&&!hit.closest('#notes-panel,#reading-mode-toolbar,#media-dock');
  return {ready,reason:ready?'measured-unobscured-reading-gap':'no-readable-gap',point:{x,y},wheelDelta:Math.round((r.top+r.bottom)/2-y),bounds:{top:b.top,bottom},characterHeight:r.height,sourceRect:rectValue(r),hit:hitValue(hit)};
 };
}

export function nativeMediaAnchorIsStable(a){
 return !!a&&a.valid===true&&a.connected===true&&a.identitySame===true&&a.textSame===true&&a.ownerSame===true&&a.visible===true&&a.xDelta===0&&a.yDelta===0&&a.widthDelta===0&&a.heightDelta===0;
}

export function nativeMediaPhaseDelta(current,baseline){
 return {scrollDelta:current.scrollY-baseline.scrollY,headerDelta:current.header-baseline.header,rowDelta:current.rowTop-baseline.rowTop};
}
