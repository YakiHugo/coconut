/* Service declarations describe this connection, not browser-host privileges.
 * They are UI admission only; every server route still authorizes the caller. */
(function(root){
 'use strict';
 const names=['libraryRead','libraryWrite','aiActions','backgroundTasks','localMedia','libraryMigration'];
 const local=()=>['localhost','127.0.0.1','[::1]'].includes(root.location.hostname);
 let current=null,generation=0,epoch=0,request=0,applied=0;
 function normalize(value){
  if(value===undefined&&local())return {mode:'local',id:'legacy-local',backendLabel:'此电脑',online:true,libraryId:null,capabilities:Object.fromEntries(names.map(name=>[name,true]))};
  if(!value||!['local','private-owner'].includes(value.mode)||value.mode==='local'&&!local()||value.online!==true||typeof value.id!=='string'||!value.id||typeof value.backendLabel!=='string'||!value.backendLabel||!(value.libraryId===null||typeof value.libraryId==='string'))return null;
  if(value.mode==='private-owner'&&root.location.protocol!=='https:')return null;
  return {mode:value.mode,id:value.id,backendLabel:value.mode==='private-owner'&&value.backendLabel==='此电脑'?'已连接的电脑':value.backendLabel,online:true,libraryId:value.libraryId,capabilities:Object.fromEntries(names.map(name=>[name,value.capabilities?.[name]===true&&!(value.mode==='private-owner'&&['localMedia','libraryMigration'].includes(name))]))};
 }
 const identity=value=>value?JSON.stringify([value.mode,value.id,value.libraryId]):null;
 function observe(value){
  const next=normalize(value);
  if(JSON.stringify(current)!==JSON.stringify(next)){current=next;generation++;epoch++;root.dispatchEvent(new CustomEvent('coconut-client-changed',{detail:{generation}}));}
  return current;
 }
 const begin=()=>({epoch,order:++request});
 const currentRequest=token=>!!token&&token.epoch===epoch&&token.order>=applied;
 function complete(value,token){
  if(!token||token.epoch!==epoch)return false;
  // Concurrent health/executor reads can describe the exact same connection.
  // An older identical observation adds no authority; lifecycle/identity epoch
  // changes still reject it even after an A -> B -> A round trip.
  if(token.order<applied)return JSON.stringify(normalize(value))===JSON.stringify(current);
  applied=token.order;observe(value);return true;
 }
 function invalidate(){epoch++;observe(null);}
 async function refresh(){
  const token=begin();
  try{const response=await root.fetch('api/health',{signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('连接不可用');const data=await response.json();complete(data.client,token);}
  catch{complete(null,token);}
  return current;
 }
 root.CoconutClientCapabilities={normalize,observe,refresh,begin,complete,currentRequest,identity:()=>identity(current),get current(){return current;},get generation(){return generation;},allows:name=>current?.capabilities[name]===true,local};
 root.addEventListener('offline',invalidate);
 root.addEventListener('pagehide',invalidate);
})(window);
