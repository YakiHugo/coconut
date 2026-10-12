/** Read-only browser diagnostics for transport/layout scroll ownership. */
export function installDockViewportObserver({readingAnchors=false}={}){
 window.__dockViewportObserver?.stop();
 const events=[],calls=[],controller=new AbortController(),originals=[];
 const rectValue=rect=>({top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right,width:rect.width,height:rect.height});
 const bounds=()=>({top:Math.max(0,document.querySelector('#reading-mode-toolbar')?.getBoundingClientRect().bottom||0),bottom:Math.min(innerHeight,document.querySelector('#media-dock')?.getBoundingClientRect().top??innerHeight)});
 const clear=(rect,source)=>{const b=bounds(),hit=document.elementFromPoint((rect.left+rect.right)/2,(rect.top+rect.bottom)/2);return rect.width>0&&rect.height>0&&rect.left>=0&&rect.right<=innerWidth&&rect.top>=b.top&&rect.bottom<=b.bottom&&!!hit&&source.contains(hit);};
 const anchors=[],rows=[],loopCue=readingAnchors?document.querySelector('.repeat-button[aria-pressed="true"]')?.closest('.segment'):null;
 if(readingAnchors){
  // Bind actual, unobscured original characters, not the first (often offscreen)
  // cue. Live Ranges retain their exact Text node/offset identities for the audit.
  const lines=new Map();
  for(const source of document.querySelectorAll('#transcript .words')){
   const row=source.closest('.segment'),box=source.getBoundingClientRect(),b=bounds();if(box.bottom<=b.top||box.top>=b.bottom)continue;
   const walker=document.createTreeWalker(source,NodeFilter.SHOW_TEXT);let node;
   while((node=walker.nextNode()))for(let start=0;start<node.length;){
    const character=String.fromCodePoint(node.textContent.codePointAt(start)),end=start+character.length;
    if(character.trim()){
     const range=document.createRange();range.setStart(node,start);range.setEnd(node,end);
     const rect=range.getBoundingClientRect();
     if(clear(rect,source)){
      const key=row.dataset.segmentId+':'+rect.top+':'+rect.bottom,entry={range,node,source,row,text:node.textContent,start,end,character};
      if(!lines.has(key))lines.set(key,[]);lines.get(key).push(entry);
     }
    }
    start=end;
   }
  }
  for(const line of lines.values())for(const index of new Set([0,Math.floor(line.length/2),line.length-1]))anchors.push(line[index]);
  for(const anchor of anchors)if(!rows.includes(anchor.row))rows.push(anchor.row);
 }
 const snapshot=()=>{
  const selectors=['#episode-media','.listening-progress','#resume-listening','#source-media','#playback-controls','#stop-repeat','#repeat-status','#playback-status','#reading-mode-toolbar','#transcript .segment','#media-dock'];
  const boxes=Object.fromEntries(selectors.map(selector=>{
   const node=document.querySelector(selector);if(!node)return [selector,null];
   const rect=node.getBoundingClientRect(),style=getComputedStyle(node);
   return [selector,{rect:rectValue(rect),hidden:node.hidden,display:style.display,gridTemplateRows:style.gridTemplateRows,text:['#resume-listening','#repeat-status','#playback-status'].includes(selector)?node.textContent:null}];
  }));
  const owner=document.scrollingElement;
  const reading=readingAnchors?{bounds:bounds(),anchors:anchors.map(({range,node,source,row,text,start,end,character},id)=>{
   const rect=range.getBoundingClientRect();return {id,cue:row.dataset.segmentId,text,start,end,character,rect:rectValue(rect),sameNode:range.startContainer===node&&range.endContainer===node,sameOffsets:range.startOffset===start&&range.endOffset===end,sameText:node.textContent===text,connected:node.isConnected&&source.contains(node)&&row.contains(source),clear:clear(rect,source)};
  }),rows:rows.map(row=>({cue:row.dataset.segmentId,connected:row.isConnected,rect:rectValue(row.getBoundingClientRect())})),loopCue:loopCue?{cue:loopCue.dataset.segmentId,connected:loopCue.isConnected,rect:rectValue(loopCue.getBoundingClientRect()),pressed:loopCue.querySelector('.repeat-button')?.getAttribute('aria-pressed')}:null}:null;
  return {y:window.scrollY,x:window.scrollX,width:innerWidth,height:innerHeight,scrollOwner:owner?.tagName,scrollTop:owner?.scrollTop,scrollHeight:owner?.scrollHeight,clientHeight:owner?.clientHeight,focused:document.activeElement?.id||document.activeElement?.className,follow:document.querySelector('#dock-follow')?.dataset.state,inset:getComputedStyle(document.documentElement).scrollPaddingBottom,boxes,reading};
 };
 const record=(type,details={})=>{const value={type,time:performance.now(),...snapshot(),...details};if(events.length<200)events.push(value);return value;};
 for(const type of ['pointerdown','pointerup','click','focusin','focusout','seeking','seeked','ended','scroll','scrollend'])document.addEventListener(type,event=>{
  if(['seeking','seeked','ended'].includes(type)&&event.target!==document.querySelector('#source-media audio, #source-media video'))return;
  record(type,{target:event.target.id||event.target.tagName,trusted:event.isTrusted});
 },{capture:true,passive:true,signal:controller.signal});
 for(const [owner,name]of [[Element.prototype,'scrollIntoView'],[window,'scrollTo'],[window,'scrollBy'],[HTMLElement.prototype,'focus']]){
  const original=owner[name];if(typeof original!=='function')continue;originals.push([owner,name,original]);
  owner[name]=function(...args){const value=record(name,{target:this.id||this.dataset?.segmentId||null,args});calls.push(value);return Reflect.apply(original,this,args);};
 }
 const observer=new MutationObserver(()=>record('resume-mutation'));
 observer.observe(document.querySelector('.listening-progress'),{subtree:true,attributes:true,childList:true,characterData:true});
 const loopObserver=new MutationObserver(()=>record('loop-mutation'));
 if(readingAnchors)loopObserver.observe(document.querySelector('#playback-controls'),{subtree:true,attributes:true,childList:true,characterData:true});
 const stop=()=>{controller.abort();observer.disconnect();loopObserver.disconnect();for(const [owner,name,original]of originals)owner[name]=original;};
 window.__dockViewportObserver={events,calls,snapshot,record,stop};record('installed');
}

/** A loop may compact its offscreen controls while native scroll anchoring keeps
 * the actual reading content fixed. No absolute scroll delta is waived without
 * same-character viewport proof and a matching, isolated header contraction. */
export function evaluateDockLoopViewport({events=[],calls=[]}={}){
 const index=events.findIndex(event=>event.type==='click'&&event.target==='dock-rewind'),before=events[index],after=events.at(-1),post=index<0?[]:events.slice(index);
 const near=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<2;
 const sameRect=(a,b)=>!!a&&!!b&&['top','bottom','left','right','width','height'].every(key=>near(a[key],b[key]));
 const baseline=events[0],anchors=baseline?.reading?.anchors||[],rows=baseline?.reading?.rows||[];
 const boundAnchor=(anchor,event)=>anchor.sameNode&&anchor.sameOffsets&&anchor.sameText&&anchor.connected&&anchor.clear&&anchor.rect.width>0&&anchor.rect.height>0&&anchor.rect.top>=event.reading.bounds.top&&anchor.rect.bottom<=event.reading.bounds.bottom;
 const visibleAnchors=anchors.length>=3&&rows.length>0&&baseline?.type==='installed'&&anchors.every(anchor=>boundAnchor(anchor,baseline));
 const sameAnchors=visibleAnchors&&events.every(event=>event.reading?.anchors?.length===anchors.length&&event.reading.anchors.every((anchor,i)=>boundAnchor(anchor,event)&&['id','cue','text','start','end','character'].every(key=>anchor[key]===anchors[i][key])&&sameRect(anchor.rect,anchors[i].rect)));
 const sameRows=rows.length>0&&events.every(event=>event.reading?.rows?.length===rows.length&&event.reading.rows.every((row,i)=>row.connected&&row.cue===rows[i].cue&&sameRect(row.rect,rows[i].rect)));
 const sameLoop=!!before?.reading?.loopCue&&!!after?.reading?.loopCue&&before.reading.loopCue.pressed==='true'&&after.reading.loopCue.pressed==='false'&&post.every(event=>event.reading?.loopCue?.connected&&event.reading.loopCue.cue===before.reading.loopCue.cue&&sameRect(event.reading.loopCue.rect,before.reading.loopCue.rect));
 const loopRetired=sameLoop&&before.boxes['#stop-repeat']?.hidden===false&&after.boxes['#stop-repeat']?.hidden===true&&!!before.boxes['#repeat-status']?.text&&after.boxes['#repeat-status']?.text==='';
 const explainedLayout=post.length>=2&&post.every(event=>{
  const header=event.boxes?.['#episode-media']?.rect,controls=event.boxes?.['#playback-controls']?.rect,bh=before.boxes?.['#episode-media']?.rect,bc=before.boxes?.['#playback-controls']?.rect;
  if(!header||!controls||!bh||!bc)return false;
  const delta=event.y-before.y,collapse=header.height-bh.height;
  return bh.bottom<=0&&bc.bottom<=0&&header.bottom<=0&&controls.bottom<=0&&delta<=0&&collapse<=0&&near(delta,collapse)&&near(event.scrollHeight-before.scrollHeight,collapse)&&near(controls.height-bc.height,collapse)&&near(header.bottom,bh.bottom)&&near(controls.bottom,bc.bottom)&&near(header.width,bh.width)&&near(controls.width,bc.width)&&near(event.scrollTop,event.y)&&near(event.x,before.x)&&event.width===before.width&&event.height===before.height&&event.clientHeight===before.clientHeight&&event.inset===before.inset;
 });
 const pointer=events.filter(event=>['pointerdown','pointerup','click'].includes(event.type));
 const trustedPointer=pointer.length===3&&pointer.every((event,i)=>event.type===['pointerdown','pointerup','click'][i]&&event.target==='dock-rewind'&&event.trusted===true);
 const preClickStable=index>0&&events.slice(0,index+1).every(event=>near(event.y,baseline.y)&&near(event.scrollHeight,baseline.scrollHeight));
 const validDimensions=events.length>0&&events.every(event=>['width','height','clientHeight'].every(key=>Number.isFinite(event[key])&&event[key]>0));
 const nativeOwnership=validDimensions&&trustedPointer&&preClickStable&&post.length>=2&&before.trusted===true&&after.type==='settled'&&calls.length===0&&events.every(event=>event.follow==='off'&&event.scrollOwner==='HTML'&&event.width===baseline.width&&event.height===baseline.height)&&post.every(event=>event.focused==='dock-rewind'&&(!['scroll','seeking','seeked'].includes(event.type)||event.trusted===true));
 return {visibleAnchors,sameAnchors,sameRows,loopRetired,explainedLayout,nativeOwnership};
}
