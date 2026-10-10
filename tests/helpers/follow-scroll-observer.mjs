/** Browser callbacks also exercised by the Node follow tests. Observation only. */
export function installFollowScrollObserver(){
 const state={initialY:window.scrollY,wheel:false,moved:false,ended:false,lastY:null,stationary:0,events:[],calls:[]};
 const record=(type,details={})=>{
  const entry={type,time:performance.now(),y:window.scrollY,follow:document.querySelector('#dock-follow')?.dataset.state,...details};
  if(state.events.length<300)state.events.push(entry);return entry;
 };
 const controller=new AbortController(),originals=[];
 window.addEventListener('wheel',event=>{state.wheel=true;state.ended=false;state.stationary=0;record('wheel',{deltaY:event.deltaY,trusted:event.isTrusted});},{capture:true,passive:true,signal:controller.signal});
 document.addEventListener('scroll',event=>{if(state.wheel&&window.scrollY>state.initialY)state.moved=true;state.ended=false;state.stationary=0;record('scroll',{trusted:event.isTrusted});},{signal:controller.signal});
 document.addEventListener('scrollend',event=>{if(state.moved)state.ended=true;record('scrollend',{trusted:event.isTrusted});},{signal:controller.signal});
 for(const [owner,name] of [[Element.prototype,'scrollIntoView'],[window,'scrollTo'],[window,'scrollBy']]){
  const original=owner[name];originals.push([owner,name,original]);
  owner[name]=function(...args){const entry=record(name,{target:this.id||this.dataset?.segmentId||null,afterWheel:state.wheel});state.calls.push(entry);return Reflect.apply(original,this,args);};
 }
 window.__followScrollObserver={state,record,stop(){controller.abort();for(const [owner,name,original] of originals)owner[name]=original;}};
 record('installed');
}
export function followWheelSettled(){
 const {state}=window.__followScrollObserver;
 state.stationary=window.scrollY===state.lastY?state.stationary+1:0;state.lastY=window.scrollY;
 return state.wheel&&state.moved&&state.ended&&state.stationary>=2&&document.querySelector('#dock-follow').dataset.state==='suspended';
}
