import fs from 'node:fs';
const source=fs.readFileSync(new URL('../../reader/library-store.js',import.meta.url),'utf8');
export function installSavePipeline(window,{held=false,clock=null}={}){
 window.eval(source);
 const module=window.CoconutLibraryStore,create=module.create,legacy=module.createLegacyAdapter;
 const writes=[];let holding=held,prepares=0,store;
 module.create=options=>{
  store=create({...options,...(clock||{})});window.flushContentForTest=()=>store.flush();
  return store;
 };
 module.createLegacyAdapter=options=>{
  const adapter=legacy(options);
  return {...adapter,prepare(documents){prepares++;return adapter.prepare(documents);},write(value,options){
   if(!holding)return adapter.write(value,options);
   return new Promise(resolve=>writes.push({value,signal:options.signal,
    commit:({ignoreAbort=false}={})=>resolve(adapter.write(value,ignoreAbort?{}:options)),
    fail:(code='quota')=>resolve({ok:false,status:code==='conflict'?'conflict':code==='cancelled'?'cancelled':'failed',error:{code,message:code}}),
    reject:()=>resolve({ok:false,status:'cancelled',error:{code:'cancelled'}})}));
  }};
 };
 return {writes,get store(){return store;},get prepares(){return prepares;},hold(value=true){holding=value;}};
}
export async function settle(){for(let i=0;i<30;i++)await Promise.resolve();}
export function saveClock(){
 let now=0,nextId=0;const jobs=new Map();
 return {now:()=>now,setTimer(fn,ms){const id=++nextId;jobs.set(id,{fn,at:now+ms});return id;},clearTimer:id=>jobs.delete(id),
  async tick(ms){const end=now+ms;while([...jobs.values()].some(job=>job.at<=end)){const [id,job]=[...jobs].sort((a,b)=>a[1].at-b[1].at)[0];jobs.delete(id);now=job.at;job.fn();await settle();}now=end;await settle();}};
}
