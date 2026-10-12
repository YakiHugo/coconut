/** Read-only browser diagnostics for transport/layout scroll ownership. */
export function installDockViewportObserver(){
 window.__dockViewportObserver?.stop();
 const events=[],calls=[],controller=new AbortController(),originals=[];
 const snapshot=()=>{
  const selectors=['#episode-media','.listening-progress','#resume-listening','#source-media','#playback-controls','#playback-status','#reading-mode-toolbar','#transcript .segment','#media-dock'];
  const boxes=Object.fromEntries(selectors.map(selector=>{
   const node=document.querySelector(selector);if(!node)return [selector,null];
   const rect=node.getBoundingClientRect(),style=getComputedStyle(node);
   return [selector,{rect:{top:rect.top,bottom:rect.bottom,height:rect.height},hidden:node.hidden,display:style.display,gridTemplateRows:style.gridTemplateRows,text:selector==='#resume-listening'||selector==='#playback-status'?node.textContent:null}];
  }));
  const owner=document.scrollingElement;
  return {y:window.scrollY,x:window.scrollX,height:innerHeight,scrollOwner:owner?.tagName,scrollTop:owner?.scrollTop,scrollHeight:owner?.scrollHeight,clientHeight:owner?.clientHeight,focused:document.activeElement?.id||document.activeElement?.className,follow:document.querySelector('#dock-follow')?.dataset.state,inset:getComputedStyle(document.documentElement).scrollPaddingBottom,boxes};
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
 const stop=()=>{controller.abort();observer.disconnect();for(const [owner,name,original]of originals)owner[name]=original;};
 window.__dockViewportObserver={events,calls,snapshot,record,stop};record('installed');
}
