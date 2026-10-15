(function(root){
 'use strict';
 const CHUNK=1048576,MAX=67108864;
 const issue=(code,message=code)=>Object.assign(new Error(message),{code});
 const failure=e=>({ok:false,status:e.code?.includes('conflict')?'conflict':'failed',error:{code:e.code||'unavailable',message:e.message}});
 function json(value){
  const seen=new Set();let nodes=0;
  function check(v){
   if(++nodes>2000000)throw issue('too_large');
   if(v===null||typeof v==='string'||typeof v==='boolean')return;
   if(typeof v==='number'&&Number.isFinite(v)&&!Object.is(v,-0)&&(!Number.isInteger(v)||Number.isSafeInteger(v)))return;
   if(!v||typeof v!=='object'||seen.has(v)||!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)throw issue('lossy_source','原始记录无法无损转换，请保留浏览器数据。');
   const keys=Reflect.ownKeys(v);
   if(keys.some(k=>typeof k!=='string'||!Object.getOwnPropertyDescriptor(v,k).enumerable&&!(Array.isArray(v)&&k==='length'))||Array.isArray(v)&&(Object.keys(v).length!==v.length||Object.keys(v).some((k,i)=>k!==String(i))))throw issue('lossy_source');
   seen.add(v);for(const k of Object.keys(v)){const d=Object.getOwnPropertyDescriptor(v,k);if(!('value'in d))throw issue('lossy_source');check(d.value);}seen.delete(v);
  }
  check(value);return JSON.stringify(value);
 }
 // Validation supplies safe known fields without discarding opaque nested data.
 function project(raw,normalized){
  if(Array.isArray(normalized)){
   const byId=new Map((Array.isArray(raw)?raw:[]).filter(item=>typeof item?.id==='string').map(item=>[item.id,item]));
   return normalized.map((value,index)=>project(value?.id!==undefined?(byId.get(value.id)??(typeof raw?.[index]?.id!=='string'?raw?.[index]:undefined)):raw?.[index],value));
  }
  if(normalized&&typeof normalized==='object'){
   const result=Object.create(Object.getPrototypeOf(normalized));
   for(const key of new Set([...Object.keys(raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{}),...Object.keys(normalized)]))Object.defineProperty(result,key,{value:Object.hasOwn(normalized,key)?project(raw?.[key],normalized[key]):root.structuredClone(raw[key]),enumerable:true,writable:true,configurable:true});
   return result;
  }
  return normalized;
 }
 const bytes=text=>new TextEncoder().encode(text);
 async function hash(value){return [...new Uint8Array(await root.crypto.subtle.digest('SHA-256',typeof value==='string'?bytes(value):value))].map(n=>n.toString(16).padStart(2,'0')).join('');}
 function base64(data){let value='';for(let i=0;i<data.length;i+=8192)value+=String.fromCharCode(...data.subarray(i,i+8192));return root.btoa(value);}
 function create({primitive,fetch=root.fetch.bind(root),validate=d=>d}={}){
  async function request(path='',body){
   const controller=new AbortController(),timer=root.setTimeout(()=>controller.abort(),15000);
   try{
    const response=await fetch('/api/v1/library'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body),cache:'no-store',signal:controller.signal}:{cache:'no-store',signal:controller.signal});
    const data=await response.json();
    if(!response.ok&&!(response.status===404&&data.state==='absent'))throw Object.assign(issue(data.code||'unavailable',data.error||'PC 书架暂时不可用，请重试；不会切回浏览器写入。'),{definitive:response.status>=400&&response.status<500});
    return data;
   }finally{root.clearTimeout(timer);}
  }
  const requireEpoch=(value,epoch)=>{if(value.epoch!==epoch)throw issue('epoch_conflict','连接的 PC 书架身份已改变，请恢复原服务后重试。');return value;};
  async function catalog(epoch){
   const entries=[];let after='',sequence;
   do{const q=new URLSearchParams({protocolVersion:'1',epoch,limit:'100',...(after?{after,sequence:String(sequence)}:{})});const page=requireEpoch(await request('/catalog?'+q),epoch);if(!Array.isArray(page.entries))throw issue('protocol');sequence=page.sequence;entries.push(...page.entries);after=page.next;}while(after);
   return {entries,sequence};
  }
  async function load(epoch){
   const page=await catalog(epoch),records=[];
   for(const entry of page.entries){const {record}=await request('/document?'+new URLSearchParams({protocolVersion:'1',key:entry.key}));
    if(!record||record.token?.epoch!==epoch||record.token.revision!==entry.token.revision||JSON.stringify(record.identity)!==JSON.stringify(entry.identity)||record.deleted!==entry.deleted||record.sha256!==entry.sha256||await hash(JSON.stringify(record.document))!==entry.sha256)throw issue('catalog_changed');
    if(!Number.isSafeInteger(record.identity?.lifetime)||record.identity.lifetime<1||!Number.isSafeInteger(record.identity.position)||record.identity.position<0)throw issue('protocol');
    if(!record.deleted){if(record.document?.key!==entry.key)throw issue('protocol');validate(root.structuredClone(record.document));}records.push(record);
   }
   const final=await catalog(epoch);if(final.sequence!==page.sequence)throw issue('catalog_changed');return records;
  }
  async function marker(){const value=await primitive.canonicalStatus();if(!value.ok)throw issue(value.error.code,value.error.message);return value.value;}
  async function adopt(m,status){
   const integrity=await primitive.canonicalIntegrity(m);if(!integrity.ok)throw issue(integrity.error.code,integrity.error.message);
   const r=status.receipt;requireEpoch(status,m.epoch);
   if(await hash(m.text)!==m.sha256||status.migrationId!==m.migrationId||status.manifest?.sha256!==m.sha256||status.manifest?.sourceId!==m.sourceId||status.manifest?.mediaLibraryIdentity!==m.mediaLibraryIdentity||status.manifest?.bytes!==m.bytes||status.manifest?.chunks!==m.chunks)throw issue('receipt_mismatch');
   if(status.state!=='committed'||r?.epoch!==m.epoch||r.migrationId!==m.migrationId||r.sourceId!==m.sourceId||r.sha256!==m.sha256||r.mediaLibraryIdentity!==m.mediaLibraryIdentity)throw issue('receipt_mismatch');
   const original=JSON.parse(m.text);if(r.documents!==original.stores.documents.length+original.stores.tombstones.length||!Number.isSafeInteger(r.sequence)||r.sequence<0)throw issue('receipt_mismatch');
   const records=await load(m.epoch),map=new Map(records.map(r=>[r.key,r])),snapshot=JSON.parse(m.text);
   for(const row of [...snapshot.stores.documents,...snapshot.stores.tombstones]){
    const live=map.get(row.key),deleted=!!row.value.deleted,position=deleted?row.value.order:snapshot.stores.catalog.find(c=>c.key===row.key)?.value.order;
    if(!live||live.deleted!==deleted||live.identity.lifetime!==row.value.epoch||live.identity.position!==position||live.sha256!==await hash(JSON.stringify(deleted?null:row.value.payload)))throw issue('verification_failed','PC 副本与冻结原始记录不一致，请保留恢复文件。');
   }
   const saved=await primitive.finishCanonical(m,r);if(!saved.ok)throw issue(saved.error.code);return {ok:true,state:'canonical',receipt:r};
  }
  async function resume(){
   const m=await marker();if(!m)throw issue('missing_migration');if(await hash(m.text)!==m.sha256)throw issue('corruption');
   const state=requireEpoch(await request('/migration?'+new URLSearchParams({protocolVersion:'1',migrationId:m.migrationId})),m.epoch);
   if(state.state==='committed')return adopt(m,state);
   if(state.state==='cancelled')throw issue('cancelled','迁移已取消；请选择确认取消以恢复浏览器书架。');
   const body={protocolVersion:1,epoch:m.epoch,migrationId:m.migrationId};
   await request('/migration',{...body,action:'begin',manifest:{sourceId:m.sourceId,mediaLibraryIdentity:m.mediaLibraryIdentity,sha256:m.sha256,bytes:m.bytes,chunks:m.chunks}});
   const data=bytes(m.text);if(await hash(data)!==m.sha256)throw issue('corruption');
   for(let index=0;index<m.chunks;index++){
    const chunk=data.subarray(index*CHUNK,(index+1)*CHUNK),ack=requireEpoch(await request('/migration',{...body,action:'chunk',index,data:base64(chunk)}),m.epoch);
    if(ack.state==='committed')return adopt(m,ack);
    if(ack.index!==index||ack.sha256!==await hash(chunk))throw issue('receipt_mismatch');
   }
   const integrity=await primitive.canonicalIntegrity(m);if(!integrity.ok)throw issue(integrity.error.code,integrity.error.message);
   return adopt(m,await request('/migration',{...body,action:'finalize'}));
  }
  async function begin(){
   if(await marker())return resume();
   const server=await request();if(!server.enabled||server.migration?.protocolVersion!==1||server.batchProtocolVersion!==2||server.migration.chunkBytes!==CHUNK)throw issue('unsupported','此服务尚未支持安全迁移。');
   const snapshot=await primitive.canonicalSource();if(!snapshot.ok)throw issue(snapshot.error.code,snapshot.error.message);
   const text=json(snapshot),data=bytes(text);if(data.length>MAX)throw issue('too_large');
   for(const row of snapshot.stores.documents)if(bytes(json(row.value.payload)).length>8388608)throw issue('too_large');
   const meta=new Map(snapshot.stores.meta.map(r=>[r.key,r.value]));
   const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
   if(!uuid(server.epoch)||!uuid(meta.get('canonical-source-id'))||!uuid(meta.get('desktop-media-library')))throw issue('invalid_identity');
   for(const row of [...snapshot.stores.documents,...snapshot.stores.tombstones])for(const key of [row.key,row.value.mutationId])if(typeof key!=='string'||!key||bytes(key).length>1024||/[\u0000-\u001f\ud800-\udfff]/u.test(key))throw issue('unsupported_key','原始记录身份不受 PC 协议支持；浏览器书架保持可用。');
   const m={state:'frozen',epoch:server.epoch,migrationId:root.crypto.randomUUID(),sourceId:meta.get('canonical-source-id'),mediaLibraryIdentity:meta.get('desktop-media-library'),text,sha256:await hash(data),bytes:data.length,chunks:Math.ceil(data.length/CHUNK)};
   const frozen=await primitive.freezeCanonical(m);if(!frozen.ok)throw issue(frozen.error.code,frozen.error.message);return resume();
  }
  async function cancel(){
   const m=await marker();if(!m)return {ok:true,state:'cancelled'};if(await hash(m.text)!==m.sha256)throw issue('corruption');
   // Resolve an unknown prior finalize before requesting cancellation. An absent
   // session still needs a durable cancellation tombstone against delayed begin.
   const prior=requireEpoch(await request('/migration?'+new URLSearchParams({protocolVersion:'1',migrationId:m.migrationId})),m.epoch);
   if(prior.state==='committed')return adopt(m,prior);
   const status=prior.state==='cancelled'?prior:requireEpoch(await request('/migration',{protocolVersion:1,epoch:m.epoch,migrationId:m.migrationId,action:'cancel'}),m.epoch);
   if(status.state==='committed')return adopt(m,status);
   if(status.state!=='cancelled'||status.migrationId!==m.migrationId)throw issue('cancellation_unconfirmed');
   const result=await primitive.finishCanonical(m,null,true);if(!result.ok)throw issue(result.error.code);return {ok:true,state:'cancelled'};
  }
  async function discover(){
   const server=await request();
   if(!server.enabled||server.protocolVersion!==1||server.batchProtocolVersion!==2||!server.binding||server.binding.protocolVersion!==1||!server.binding.mediaLibraryIdentity)throw issue('unsupported','此服务尚未支持连接已有书架。');
   await load(server.epoch);return server;
  }
  async function connect(){
   if(await marker())throw issue('fenced','此浏览器已有书架连接或迁移，请刷新后继续。');
   // All remote reads precede the local authority commit. Failures here leave
   // the original browser library writable; no remote writes or imports occur.
   const server=await discover(),snapshot=await primitive.canonicalSource();
   if(!snapshot.ok)throw issue(snapshot.error.code,snapshot.error.message);
   const text=json(snapshot),data=bytes(text);if(data.length>MAX)throw issue('too_large');
   const latest=requireEpoch(await request(),server.epoch);
   if(latest.binding?.mediaLibraryIdentity!==server.binding.mediaLibraryIdentity)throw issue('epoch_conflict');
   const m={state:'connected',version:1,bindingId:root.crypto.randomUUID(),epoch:server.epoch,mediaLibraryIdentity:server.binding.mediaLibraryIdentity,text,sha256:await hash(data)};
   const saved=await primitive.bindCanonical(m);if(!saved.ok)throw issue(saved.error.code,saved.error.message);
   return {ok:true,state:'connected'};
  }
  async function initializeBinding(m){
   if(m.state!=='connected'||m.version!==1||!m.bindingId||await hash(m.text)!==m.sha256)throw issue('corruption');
   const integrity=await primitive.canonicalIntegrity(m);if(!integrity.ok)throw issue(integrity.error.code,integrity.error.message);
   const server=requireEpoch(await request(),m.epoch);
   if(server.binding?.protocolVersion!==1||server.binding.mediaLibraryIdentity!==m.mediaLibraryIdentity)throw issue('binding_mismatch','电脑书架连接身份不一致，请恢复原服务后重试。');
   return {...await initializeAdapter(m),connected:true};
  }
  async function initialize(m){
   if(await hash(m.text)!==m.sha256)throw issue('corruption');
   const integrity=await primitive.canonicalIntegrity(m);if(!integrity.ok)throw issue(integrity.error.code,integrity.error.message);
   if(m.state!=='canonical'||m.receipt?.epoch!==m.epoch||m.receipt?.migrationId!==m.migrationId||m.receipt?.sha256!==m.sha256||m.receipt?.sourceId!==m.sourceId||m.receipt?.mediaLibraryIdentity!==m.mediaLibraryIdentity)throw issue('corruption');
   if(await hash(m.text)!==m.sha256||bytes(m.text).length!==m.bytes||Math.ceil(m.bytes/CHUNK)!==m.chunks)throw issue('corruption');
   const server=requireEpoch(await request(),m.epoch);
   const committed=requireEpoch(await request('/migration?'+new URLSearchParams({protocolVersion:'1',migrationId:m.migrationId})),m.epoch);
   if(committed.state!=='committed'||committed.migrationId!==m.migrationId||JSON.stringify(committed.receipt)!==JSON.stringify(m.receipt)||committed.manifest?.sha256!==m.sha256||committed.manifest?.sourceId!==m.sourceId||committed.manifest?.mediaLibraryIdentity!==m.mediaLibraryIdentity||committed.manifest?.bytes!==m.bytes||committed.manifest?.chunks!==m.chunks)throw issue('corruption');
   return initializeAdapter({...m,mediaLibraryIdentity:server.binding?.mediaLibraryIdentity||m.mediaLibraryIdentity});
  }
  async function initializeAdapter(m){
   const records=await load(m.epoch),tokens=new Map(records.map(r=>[r.key,r])),captures=new WeakMap(),retries=new Map(),unresolved=new Set();let closed=false,writeTail=Promise.resolve();
   async function send(capture){
    if(capture.result)return capture.result;
    const submitted=capture.captured.filter(item=>!item.acknowledged);
    if(!submitted.length){retries.delete(capture.signature);return capture.result={ok:true,status:'saved',receipts:capture.captured.map(item=>item.acknowledged)};}
    capture.sent=true;unresolved.add(capture);
    let response;try{response=await request('/batch',capture.body);}catch(error){if(error.definitive)unresolved.delete(capture);throw error;}
    const result=requireEpoch(response,m.epoch);if(result.protocolVersion!==2||result.receipts?.length!==submitted.length)throw issue('receipt_mismatch');
    const receipts=result.receipts.map((r,i)=>{const {command:c,change}=submitted[i];if(r.key!==c.key||r.action!==c.action||r.receiptKey!==c.receiptKey||r.token?.epoch!==m.epoch||r.token.revision!==(c.expected?.revision||0)+1||r.deleted!==(c.action==='delete')||r.identity?.lifetime!==(c.expectedIdentity?c.expectedIdentity.lifetime+(c.action==='restore'?1:0):1)||!Number.isSafeInteger(r.identity.position)||r.identity.position<0||c.expectedIdentity&&r.identity.position!==c.expectedIdentity.position)throw issue('receipt_mismatch');return {...r,ok:true,status:'saved',generation:change.generation,kind:change.kind,epoch:r.identity.lifetime,revision:r.token.revision,order:r.identity.position};});
    for(const r of result.receipts)tokens.set(r.key,r);unresolved.delete(capture);retries.delete(capture.signature);capture.result={ok:true,status:'saved',receipts:capture.captured.map(item=>item.acknowledged||receipts.find(receipt=>receipt.key===item.command.key))};return capture.result;
   }
   const adapter={backend:'canonical',maxBatchSize:100,maxBatchBytes:16777216,documentEpoch:key=>tokens.get(key)?.deleted?null:tokens.get(key)?.identity.lifetime??null,
    mediaLibraryIdentity:async()=>({ok:true,identity:m.mediaLibraryIdentity}),
    estimateBatchBytes(changes){
     const commands=changes.map(c=>{const current=tokens.get(c.key),action=c.kind==='remove'?'delete':current?.deleted?'restore':'put',document=action==='delete'?undefined:c.identity;
      if(document&&bytes(json(document)).length>8388608)throw Object.assign(issue('document_too_large','Document exceeds the canonical 8388608-byte limit.'),{retryable:false});
      return {action,key:c.key,expected:current?.token||null,expectedIdentity:current?.identity||null,receiptKey:'00000000-0000-0000-0000-000000000000',...(document?{document}:{})};});
     return bytes(json({protocolVersion:2,epoch:m.epoch,commands})).length;
    },
    prepareChanges(changes){
     if(closed||!changes.length||changes.length>100)throw issue('unavailable');
     if(adapter.estimateBatchBytes(changes)>adapter.maxBatchBytes)throw Object.assign(issue('atomic_batch_too_large','Atomic document group exceeds the canonical request byte limit.'),{retryable:false});
     const signature=json(changes.map(c=>({key:c.key,kind:c.kind,generation:c.generation,identity:c.identity})));
     if(retries.has(signature))return retries.get(signature);const seen=new Set();
     const captured=changes.map(c=>{if(seen.has(c.key)||!Number.isSafeInteger(c.generation))throw issue('validation');seen.add(c.key);const current=tokens.get(c.key),action=c.kind==='remove'?'delete':current?.deleted?'restore':'put';const document=action==='delete'?undefined:root.structuredClone(c.identity);if(document){if(document.key!==c.key)throw issue('validation');validate(root.structuredClone(document));json(document);}return {change:{key:c.key,generation:c.generation,kind:c.kind},command:{action,key:c.key,expected:current?.token||null,expectedIdentity:current?.identity||null,receiptKey:root.crypto.randomUUID(),...(document?{document}:{})}};});
     const body=json({protocolVersion:2,epoch:m.epoch,commands:captured.map(c=>c.command)});if(bytes(body).length>16777216)throw issue('too_large');const handle=Object.freeze({});captures.set(handle,{body,captured,signature,dependencies:[...unresolved].filter(previous=>previous.captured.some(old=>captured.some(item=>item.command.key===old.command.key)))});retries.set(signature,handle);return handle;
    },
    write(handle,{signal}={}){
     const operation=writeTail.then(async()=>{try{
      const capture=captures.get(handle);if(!capture||closed)throw issue('unavailable');if(capture.result)return capture.result;if(signal?.aborted)throw issue('cancelled');
      // A newer edit cannot strand an older ambiguous commit. Resolve its exact
      // bytes first, then advance only the successor's matching captured CAS.
      for(const previous of new Set([...unresolved,...capture.dependencies]))if(previous!==capture&&previous.captured.some(old=>capture.captured.some(item=>item.command.key===old.command.key))){
       // A rolled-back structural intent is not revived by an unrelated save.
       // Every member of an uncertain atomic predecessor needs a successor owner.
       if(!previous.result&&previous.captured.some(old=>!capture.captured.some(item=>item.command.key===old.command.key&&(item.change.generation>old.change.generation||item.change.generation===old.change.generation&&item.change.kind===old.change.kind&&JSON.stringify(item.command.document)===JSON.stringify(old.command.document)))))throw issue('ambiguous_batch','先前原子保存结果尚未确认；请保留恢复备份并重新载入书架。');
       const acknowledged=await send(previous);capture.acknowledgedPrior=true;
       if(!capture.sent)for(const item of capture.captured){
        const index=previous.captured.findIndex(old=>old.command.key===item.command.key&&old.change.generation<=item.change.generation&&JSON.stringify(old.command.expected)===JSON.stringify(item.command.expected));
        if(index>=0){const receipt=acknowledged.receipts[index];if(previous.captured[index].change.generation===item.change.generation){item.acknowledged=receipt;continue;}item.command.expected=receipt.token;item.command.expectedIdentity=receipt.identity;item.command.action=item.change.kind==='remove'?'delete':receipt.deleted?'restore':'put';}
       }
      }
      if(closed||signal?.aborted)throw issue('cancelled');
      if(!capture.sent)capture.body=json({protocolVersion:2,epoch:m.epoch,commands:capture.captured.filter(item=>!item.acknowledged).map(c=>c.command)});
      return await send(capture);
     }catch(e){const capture=captures.get(handle);return capture&&(unresolved.has(capture)||capture.acknowledgedPrior||e.code==='ambiguous_batch')?{...failure(issue('uncertain','保存结果尚未确认。请重试同一操作或导出未保存内容；不要把它视为已撤销。')),uncertain:true}:failure(e);}});
     writeTail=operation.then(()=>{});return operation;
    },status:()=>({backend:'canonical'}),subscribe:()=>()=>{},close(){closed=true;primitive.close();}};
   return {ok:true,backend:'canonical',adapter,loaded:{ok:true,documents:records.filter(r=>!r.deleted).sort((a,b)=>a.identity.position-b.identity.position||a.key.localeCompare(b.key)).map(r=>project(r.document,{...validate(root.structuredClone(r.document)),key:r.key})),active:null}};
  }
  return {begin,resume,cancel,initialize,initializeBinding,connect,discover,marker,load,request};
 }
 const api={create,json,hash};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CoconutCanonicalLibrary=api;
})(typeof globalThis==='undefined'?this:globalThis);
