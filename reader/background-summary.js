/* The UI owns durable user intent, never the executor's request lifetime. */
(function(){
 'use strict';
 const STORE='coconut-background-summary-v1',MAX_ENTRIES=128,MAX_ARCHIVED_ENTRIES=2048;
 const TaskAPI=window.CoconutTasks,client=typeof TaskAPI?.createClient==='function'?TaskAPI.createClient():null,copy=value=>JSON.parse(JSON.stringify(value));
 const live=new Set(['queued','running','cancel_requested']);
 const labels={queued:'排队中',running:'执行中',cancel_requested:'取消已请求，等待执行收尾',cancelled:'已取消',succeeded:'已完成，等待接收',failed:'失败',interrupted:'执行器中断，不会自动重跑'};
 let entries=[],external=[],previous=null,storageError='',capability=null,connection='尚未检查本机执行器；阅读不受影响。';
 let submitting=false,refreshing=null,timer=null,closed=false,consentSignature='',listSignature='';
 const reads=new Map(),accepting=new Set(),externalResults=new Map(),archiveBusy=new Set();
 let archivePage=[],archiveAfter='',archiveLookup='',archiveLocal=false,archiveNext=null,archiveTotal=0,archiveLoading=false,archiveError='',archiveGeneration=0;
 const isArchived=task=>typeof task?.archivedAt==='string';
 const currentEntries=()=>entries.filter(entry=>!isArchived(entry.task));
 const canArchive=task=>task&&(['succeeded','failed'].includes(task.status)||(task.status==='cancelled'&&task.cancellation?.executionSettled===true));
 const archiveSupported=()=>supported()&&capability.archive?.supported===true;
 function beginRead(entry){const version=(reads.get(entry.key)||0)+1;reads.set(entry.key,version);return version;}
 function currentRead(entry,version){return (reads.get(entry.key)||0)===version;}
 function applyTask(entry,task,version){if(!currentRead(entry,version))return false;if(entry.task&&!live.has(entry.task.status)&&task.status!==entry.task.status)throw new Error('任务终态与已保存回执冲突，请刷新核查');entry.task=task;entry.missing=false;beginRead(entry);return true;}
 const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
 try{
  previous=localStorage.getItem(STORE);
  if(!client&&previous!==null)throw new Error('后台任务客户端未加载，无法核对关联；请保留原记录并刷新或修复完整安装');
  const saved=previous===null?{version:1,entries:[]}:JSON.parse(previous);
  if(![1,2].includes(saved.version)||!Array.isArray(saved.entries)||saved.entries.length>MAX_ENTRIES+MAX_ARCHIVED_ENTRIES||saved.entries.filter(entry=>!isArchived(entry?.task)).length>MAX_ENTRIES||saved.entries.filter(entry=>isArchived(entry?.task)).length>MAX_ARCHIVED_ENTRIES||saved.entries.some(item=>!item||typeof item.key!=='string'||typeof item.lifetime!=='string'||typeof item.payload?.document?.revision!=='string'||item.payload?.idempotencyKey!==item.key||!Array.isArray(item.payload?.segments)))throw new Error('任务关联格式不可用');
  const keys=new Set();
  for(const entry of saved.entries){
   if(keys.has(entry.key)||!uuid(entry.lifetime)||entry.payload.protocolVersion!==1||entry.payload.kind!=='summary'||entry.payload.consent!==true)throw new Error('任务身份无效');
   TaskAPI.submission({key:entry.payload.document.key,segments:entry.payload.segments},{revision:entry.payload.document.revision,provider:entry.payload.provider,idempotencyKey:entry.key,consent:true});
   if(entry.task&&(!validTask(entry,entry.task)||!Object.hasOwn(labels,entry.task.status)||(Object.hasOwn(entry.task,'archivedAt')&&(saved.version!==2||!isArchived(entry.task)||!Number.isFinite(Date.parse(entry.task.archivedAt))||!canArchive(entry.task)))))throw new Error('任务状态无效');keys.add(entry.key);
  }
  entries=saved.entries;
 }catch(error){storageError='无法读取任务关联，未覆盖原记录。'+error.message;}
 function save(){
  if(storageError)throw new Error(storageError);
  try{
   if(localStorage.getItem(STORE)!==previous)throw new Error('其他页面已更新任务关联，请刷新此页后继续');
   if(currentEntries().length>MAX_ENTRIES||entries.length-currentEntries().length>MAX_ARCHIVED_ENTRIES)throw new Error('任务关联数量超出本版上限；未覆盖原记录');
   const next=JSON.stringify({version:2,entries:entries.map(entry=>({...entry,...(entry.task?{task:{...entry.task,result:undefined}}:{})}))});localStorage.setItem(STORE,next);
   if(localStorage.getItem(STORE)!==next)throw new Error('任务关联写入未确认');previous=next;
  }catch(error){storageError='任务关联未保存：'+error.message;throw new Error(storageError);}
 }
 function safeSave(){try{save();return true;}catch(error){message(error.message);return false;}}
 function message(value){$('background-task-message').textContent=value;}
 function supported(){
  return capability?.protocolVersion===1&&capability.enabled===true&&capability.executor?.type==='local-node'&&capability.executor.online===true&&capability.remoteSubmission===false&&capability.supportedTaskKinds?.includes('summary')&&capability.execution?.disconnect==='continue'&&capability.execution.restart==='interrupt_without_retry'&&capability.execution.cancel==='request_then_settle';
 }
 function localOrigin(){return ['127.0.0.1','localhost','[::1]'].includes(location.hostname);}
 function available(provider=$('ai-provider').value){return localOrigin()&&supported()&&capability.providers?.[provider]?.supported===true&&!storageError;}
 function owner(entry){return state.documents.find(doc=>doc.key===entry.payload?.document.key&&doc.background_summary_lifetime===entry.lifetime);}
 function sourceMatches(entry,doc){return !!doc&&doc.segments.length===entry.payload.segments.length&&entry.payload.segments.every((cue,i)=>cue.id===doc.segments[i].id&&cue.text===doc.segments[i].text);}
 function missingTask(entry){return !!entry.task?.taskId&&entry.missing===true;}
 function canReceive(entry){
  const doc=owner(entry);if(storageError||isArchived(entry.task)||missingTask(entry)||entry.cancelRequested||entry.retired||!doc||!contentIngressAllowed(doc)||!sourceMatches(entry,doc))return false;
  return TaskAPI.matchesResult(entry.task,doc,entry.payload.document.revision);
 }
 function receipt(entry){return canReceive(entry)?TaskAPI.resultFor(entry.task,owner(entry),entry.payload.document.revision):null;}
 function accepted(entry){const ids=owner(entry)?.background_summary_receipts;return Array.isArray(ids)&&ids.includes(entry.task?.taskId);}
 function mayResubmit(entry){const doc=owner(entry);return !!doc&&contentIngressAllowed(doc)&&!entry.retired&&!entry.cancelRequested&&sourceMatches(entry,doc);}
 function schedule(){
  clearTimeout(timer);timer=null;
  if(!closed&&localOrigin()&&(entries.some(entry=>!entry.task||live.has(entry.task.status))||external.some(task=>live.has(task.status))))timer=setTimeout(()=>void refresh(),4000);
 }
 function terminalCancellation(task){return task&&['succeeded','failed','interrupted'].includes(task.status)?'任务已结束（'+({succeeded:'已完成',failed:'失败',interrupted:'中断'})[task.status]+'）；已放弃接收，先前请求可能已消耗额度。':null;}
 function button(label,action,entry,handler,disabled=false){const node=el('button','',label);node.type='button';node.dataset.action=action;node.disabled=disabled;node.onclick=handler;return node;}
 function sameTask(left,right){return left?.taskId===right?.taskId&&left?.kind===right?.kind&&left?.status===right?.status&&left?.provider===right?.provider&&left?.document?.key===right?.document?.key&&left?.document?.revision===right?.document?.revision;}
 function exportResult(task){
  const receipt=TaskAPI.recoveryFor(task);if(!receipt){message('结果不完整，未生成下载；请重新查询原任务。');return;}
  let url,link;
  try{
   url=URL.createObjectURL(new Blob([JSON.stringify(receipt,null,2)],{type:'application/json'}));link=el('a');link.href=url;link.download='coconut-summary-'+task.taskId.replace(/[^a-zA-Z0-9_-]/g,'_')+'.json';link.hidden=true;document.body.append(link);link.click();
   message('已发起独立摘要结果 JSON 下载，请确认文件已保存。含完整提交原文与引用，不含时间轴、笔记或媒体；不能作为书架备份导入，也不会恢复原任务关联。');
  }catch{message('结果下载失败，请重试；已读取的结果仍在本页，执行器记录未更改。');}
  finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);}
 }
 function resultPreview(row,task,opened,key,open=false){
  const receipt=TaskAPI.recoveryFor(task);if(!receipt)return;
  const details=el('details'),summary=el('summary','','查看后台结果（尚未写入文稿）'),citations=receipt.result.citations;details.open=open||opened.has(key);details.append(summary,el('p','background-result',receipt.result.answer),el('p','hint','原文引用：'+citations.slice(0,8).join('、')+(citations.length>8?' 等 '+citations.length+' 条':'')));
  const sources=new Map(receipt.result.input_snapshot.segments.map(cue=>[cue.id,cue.text]));
  for(const id of citations.slice(0,8)){const text=sources.get(id);details.append(el('p','background-source',id+'：'+text.slice(0,1200)+(text.length>1200?'…（本段预览已截短）':'')));}
  details.append(el('p','hint','以上为提交时的引用原文预览（最多 8 条，每条 1,200 字符）；独立结果 JSON 包含完整引用和全部 '+receipt.result.input_snapshot.segments.length+' 段原文快照（仅 ID 与文字，无时间轴）。'));row.append(details);
  row.append(button('下载独立结果 JSON（含原文）','export-result',null,()=>exportResult(task)));
  return true;
 }
 async function loadExternal(task){
  if(!client||!localOrigin()||task.status!=='succeeded'||externalResults.get(task.taskId)?.loading||![...external,...archivePage].some(current=>sameTask(current,task)))return;
  const state={loading:true,error:'',task:null,identity:task,open:false};externalResults.set(task.taskId,state);render();
  try{
   const response=await client.get(task.taskId);
   if(externalResults.get(task.taskId)!==state||![...external,...archivePage].some(current=>sameTask(current,task)))return;
   if(response.protocolVersion!==1||!sameTask(response.task,task)||!TaskAPI.recoveryFor(response.task))throw new Error('任务身份、原文快照或结果引用不一致');
   state.task=response.task;state.open=true;
  }catch(error){if(externalResults.get(task.taskId)===state)state.error='无法读取独立结果：'+error.message+'。可重试查询，不会重跑模型。';}
  finally{state.loading=false;render();}
 }
 // Selection and review are page-local. No refresh/new task can join a frozen
 // batch, and a page lifecycle interruption never restarts mutation requests.
 const archiveSelection=new Map();let archiveBatch=null,bulkSignature='',renderedArchiveCandidates=new Map();
 const bulkSupported=()=>archiveSupported()&&capability.archive.identityPrecondition===true;
 const bulkLocked=()=>!!archiveBatch&&(archiveBatch.phase==='review'||archiveBatch.phase==='running');
 const taskIdentity=task=>({taskId:task.taskId,attemptId:task.attemptId,inputDigest:task.inputDigest});
 const identityKey=task=>task&&['taskId','attemptId','inputDigest'].every(key=>typeof task[key]==='string'&&task[key])?JSON.stringify(taskIdentity(task)):null;
 function bulkCandidates(){
  const items=new Map();
  for(const {task,entry} of currentEntries().map(entry=>({task:entry.task,entry})).concat(external.map(task=>({task,entry:null})))){
   const key=identityKey(task);if(!key||task.kind!=='summary'||!['codex','claude'].includes(task.provider)||typeof task.document?.key!=='string'||!task.document.key||typeof task.document.revision!=='string'||!task.document.revision||!canArchive(task)||isArchived(task)||entry&&missingTask(entry)||archiveBusy.has(task.taskId))continue;
   items.set(key,{key,task:{...taskIdentity(task),kind:task.kind,provider:task.provider,document:{key:task.document.key,revision:task.document.revision},status:task.status},entryKey:entry?.key||null,statusLabel:entry&&accepted(entry)?'已完成，摘要已接收':labels[task.status],title:entry?.title||'本机其他任务 · '+(task.document?.key||'未知文稿')});
  }
  return items;
 }
 function selectArchive(row,task){
  const key=identityKey(task);if(!renderedArchiveCandidates.has(key)||!bulkSupported())return;
  const label=el('label','background-archive-selection'),input=el('input');input.type='checkbox';input.dataset.action='select-archive';input.checked=archiveSelection.has(key);input.disabled=bulkLocked()||!!storageError;
  input.onchange=()=>{
   if(bulkLocked()||storageError||!bulkSupported())return;
   const item=bulkCandidates().get(key);if(!item)return;
   if(input.checked&&archiveSelection.size<MAX_ENTRIES)archiveSelection.set(key,item);else archiveSelection.delete(key);
   renderTasks();
  };
  label.append(input,document.createTextNode('选择此任务归档'));row.append(label);
 }
 function reviewArchive(items){
  if(bulkLocked()||!bulkSupported()||storageError||archiveBusy.size||!items.length)return;
  archiveBatch={phase:'review',cancelled:false,items:items.slice(0,MAX_ENTRIES).map(item=>({...copy(item),outcome:'pending',detail:''}))};
  renderTasks();$('background-bulk-title').focus({preventScroll:true});
 }
 function renderBulk(){
  const candidates=bulkCandidates();renderedArchiveCandidates=candidates;
  for(const key of archiveSelection.keys())if(!candidates.has(key))archiveSelection.delete(key);
  const locked=bulkLocked(),enabled=bulkSupported()&&!storageError&&!archiveBusy.size;
  $('background-bulk-scope').textContent=!bulkSupported()?'批量归档需要连接支持身份核对的新版本机执行器；支持归档的旧版仍可逐条操作。':'仅选择下方当前列表中可归档的 '+candidates.size+' 条，最多每批 128 条；不包含已归档、执行中、中断或待确认任务，新完成任务不会自动加入。已选择 '+archiveSelection.size+' 条。';
  $('background-bulk-select').disabled=!enabled||locked||!candidates.size;
  $('background-bulk-select').textContent='选择当前列表可归档任务（'+Math.min(candidates.size,MAX_ENTRIES)+' 条）';
  $('background-bulk-clear').disabled=locked||!archiveSelection.size;
  $('background-bulk-review').disabled=!enabled||locked||!archiveSelection.size;
  $('background-bulk-review').textContent='核对所选 '+archiveSelection.size+' 条任务';
  const panel=$('background-bulk-panel'),batch=archiveBatch;panel.hidden=!batch;if(!batch)return;
  const running=batch.phase==='running',review=batch.phase==='review',success=batch.items.filter(item=>item.outcome==='success').length,failed=batch.items.filter(item=>['failed','unknown'].includes(item.outcome)).length,pending=batch.items.filter(item=>['pending','skipped'].includes(item.outcome)).length,inflight=batch.items.filter(item=>['checking','sending'].includes(item.outcome)).length;
  $('background-bulk-title').textContent=review?'核对 '+batch.items.length+' 条任务后归档':running?'正在逐条归档':'批量归档结果';
  $('background-bulk-status').textContent=review?'确认范围固定为以下 '+batch.items.length+' 条；不会加入之后出现或选择的任务。':batch.items.length+' 条：已确认归档 '+success+' 条，失败或未确认 '+failed+' 条，未处理 '+pending+' 条。'+(running?'处理中 '+inflight+' 条。'+(batch.cancelled?'已请求停止；等待当前请求回执。':'一次仅处理 1 条。'):'成功项仍可在归档中恢复；其余项需重新核对确认。');
  $('background-bulk-confirm').hidden=!review;$('background-bulk-confirm').disabled=!enabled;$('background-bulk-confirm').textContent='确认归档这 '+batch.items.length+' 条';
  $('background-bulk-cancel').textContent=review?'返回选择':running?'停止剩余请求':'关闭结果';$('background-bulk-cancel').disabled=running&&batch.cancelled;
  $('background-bulk-retry').hidden=review||running||!batch.items.some(item=>item.outcome!=='success');$('background-bulk-retry').disabled=!enabled;
  const signature=JSON.stringify(batch.items);if(signature===bulkSignature)return;bulkSignature=signature;
  const opened=new Set([...$('background-bulk-items').querySelectorAll('details[open]')].map(node=>node.dataset.identity));$('background-bulk-items').replaceChildren();
  for(const item of batch.items){
   const li=el('li'),details=el('details');details.dataset.identity=item.key;details.open=opened.has(item.key);
   li.append(el('span','',item.title+' · '+(item.statusLabel||labels[item.task.status]||item.task.status)+' · '+item.task.taskId.slice(0,8)));
   details.append(el('summary','','查看完整任务身份'),el('p','hint',item.task.taskId+' · '+item.task.provider+' · 文稿 '+item.task.document.key));li.append(details);
   li.append(el('p','hint',({pending:'未处理',checking:'正在核对原任务',sending:'归档请求已发送，等待回执',success:'已确认归档',failed:'失败，未确认归档',unknown:'结果未确认',skipped:'未处理，已停止'})[item.outcome]+(item.detail?'：'+item.detail:'')));$('background-bulk-items').append(li);
  }
 }
 function verifyBatchTask(item,response){
  if(response?.protocolVersion!==1||identityKey(response.task)!==item.key||!sameTask(response.task,item.task)||!canArchive(response.task))throw new Error('任务身份或终态已变化，请返回原执行器核查');
  return response.task;
 }
 function applyBatchArchive(item,task){
  const entry=item.entryKey&&entries.find(entry=>entry.key===item.entryKey);
  if(entry){
   if(identityKey(entry.task)!==item.key||!validTask(entry,task))throw new Error('浏览器原任务关联已变化');
   applyTask(entry,task,beginRead(entry));
  }
  external=external.filter(current=>identityKey(current)!==item.key);archiveGeneration++;archiveSelection.delete(item.key);
  if(entry&&!safeSave())item.detail='执行器已归档；浏览器关联未保存。请保留原记录，解决存储问题后刷新核查。';
 }
 async function runArchiveBatch(){
  const batch=archiveBatch;if(!batch||batch.phase!=='review'||!bulkSupported()||storageError||archiveBusy.size)return;
  const confirming=document.activeElement===$('background-bulk-confirm');batch.phase='running';renderTasks();if(confirming)$('background-bulk-cancel').focus({preventScroll:true});
  for(const item of batch.items){
   if(batch.cancelled||closed||!bulkSupported()||storageError){item.outcome='skipped';item.detail=storageError?'浏览器关联未保存，已停止后续操作':'未发送归档请求';continue;}
   item.outcome='checking';archiveBusy.add(item.task.taskId);renderTasks();
   try{
    // GET is for outcome recovery and eligibility; the server-side immutable
    // precondition, not this read, closes the directory-switch race.
    let task=verifyBatchTask(item,await client.get(item.task.taskId));
    if(!isArchived(task)){
     if(batch.cancelled||closed||!bulkSupported()||storageError){item.outcome='skipped';item.detail='未发送归档请求';continue;}
     const entry=item.entryKey&&entries.find(entry=>entry.key===item.entryKey);
     if(entry&&entries.length-currentEntries().length>=MAX_ARCHIVED_ENTRIES)throw new Error('浏览器归档关联已达 2048 条，原记录保留');
     item.outcome='sending';archiveGeneration++;if(entry)beginRead(entry);renderTasks();
     task=verifyBatchTask(item,await client.archive(item.task.taskId,{expected:taskIdentity(item.task)}));
     if(!isArchived(task))throw new Error('归档回执未确认');
    }
    applyBatchArchive(item,task);item.outcome='success';
   }catch(error){
    item.outcome=error.status&&error.status<500?'failed':'unknown';item.detail=error.message+'；未自动重试归档，也不会重跑模型';
    // A lost ACK may already be durably archived. Reconcile read-only, never
    // retry the mutation until the user reviews the remaining exact items.
    try{const task=verifyBatchTask(item,await client.get(item.task.taskId));if(isArchived(task)){item.detail='已重新读取并核实原任务归档';applyBatchArchive(item,task);item.outcome='success';}}catch{}
   }finally{archiveBusy.delete(item.task.taskId);renderTasks();}
  }
  batch.phase='done';renderTasks();
  if(refreshing)await refreshing;if(!closed)await refresh();renderTasks();
 }
 function archiveActions(row,task,entry){
  if(!task||entry&&missingTask(entry)||!archiveSupported())return;
  const busy=archiveBusy.has(task.taskId)||bulkLocked();
  if(!isArchived(task))selectArchive(row,task);
  if(isArchived(task)||canArchive(task))row.append(button(isArchived(task)?'恢复至当前任务列表':'归档任务（保留原文与结果）',isArchived(task)?'restore':'archive',entry,()=>moveArchive(task,entry,!isArchived(task)),busy||!!storageError));
  if(isArchived(task))row.append(button('下载完整任务救援 JSON（含原文与身份）','export-archive',entry,()=>exportArchive(task,entry),busy));
 }
 async function loadArchive(after='',taskId='',local=false){
  if(archiveLoading||!archiveSupported())return;
  archiveLoading=true;archiveError='';const generation=archiveGeneration,versions=new Map(entries.map(entry=>[entry.key,reads.get(entry.key)||0]));renderTasks();
  try{
   let response;const retained=entries.filter(entry=>isArchived(entry.task)).sort((a,b)=>a.task.taskId.localeCompare(b.task.taskId));
   if(taskId){const found=await client.get(taskId);if(found.protocolVersion!==1||!isArchived(found.task))throw new Error('此 taskId 未归档；请查看当前任务列表');const {result,...metadata}=found.task;response={protocolVersion:1,tasks:[metadata],total:1,nextCursor:null};}
   else if(!local)response=await client.listArchived({after,limit:20});
   if(local||(!taskId&&!after&&response?.total===0&&retained.length)){local=true;const remaining=retained.filter(entry=>!after||entry.task.taskId>after),page=remaining.slice(0,20);response={protocolVersion:1,tasks:page.map(entry=>{const {result,...metadata}=entry.task;return metadata;}),total:retained.length,nextCursor:remaining.length>20?page.at(-1).task.taskId:null};}
   if(generation!==archiveGeneration)return;
   if(response.protocolVersion!==1||!Array.isArray(response.tasks)||response.tasks.length>20||response.tasks.some(task=>!isArchived(task)||!canArchive(task)))throw new Error('归档列表协议不兼容');
   archivePage=response.tasks;archiveAfter=after;archiveLookup=taskId;archiveLocal=local;archiveNext=response.nextCursor;archiveTotal=response.total;
   for(const metadata of archivePage){
    const entry=entries.find(entry=>entry.task?.taskId===metadata.taskId);if(!entry||!currentRead(entry,versions.get(entry.key)))continue;
    const version=beginRead(entry);let response;
    try{response=local||metadata.status==='succeeded'?await client.get(metadata.taskId):{protocolVersion:1,task:metadata};}
    catch(error){if(!currentRead(entry,version))continue;if(error.status!==404||error.code!=='not_found')throw error;entry.missing=true;beginRead(entry);continue;}
    if(!currentRead(entry,version))continue;
    if(response.protocolVersion!==1||!validTask(entry,response.task))throw new Error('归档回执与原提交不一致');
    applyTask(entry,response.task,version);
   }
   safeSave();
  }catch(error){archiveError='归档读取失败：'+error.message+'。可重试查询，不会重新执行。';}
  finally{archiveLoading=false;renderTasks();if(generation!==archiveGeneration&&$('background-archive').open)void loadArchive('');}
 }
 async function moveArchive(task,entry,toArchive){
  if(!archiveSupported()||archiveBusy.has(task.taskId)||storageError||bulkLocked())return;
  if(entry&&((toArchive&&entries.length-currentEntries().length>=MAX_ARCHIVED_ENTRIES)||(!toArchive&&currentEntries().length>=MAX_ENTRIES))){message(toArchive?'浏览器归档关联已达 2048 条；未删除记录。':'浏览器当前关联已达 128 条，请先归档其他已收尾任务。');return;}
  let confirmed=false;archiveBusy.add(task.taskId);archiveGeneration++;if(entry)beginRead(entry);renderTasks();
  try{
   const response=await client[toArchive?'archive':'restore'](task.taskId);
   if(response.protocolVersion!==1||!sameTask(response.task,task)||isArchived(response.task)!==toArchive)throw new Error('归档状态回执不一致');
   confirmed=true;archivePage=archivePage.filter(item=>item.taskId!==task.taskId);
   if(entry){if(!validTask(entry,response.task))throw new Error('任务身份不一致');applyTask(entry,response.task,beginRead(entry));if(!safeSave())throw new Error('执行器已保存；浏览器关联未保存，请刷新页面按原任务核查。');}
   message(toArchive?'已归档，原文、结果和提交身份保留；可在归档中查看、导出或恢复。归档释放当前列表名额，不释放总存储字节。':'已恢复至当前任务列表；仍是原任务，没有重新执行。');
  }catch(error){message('操作结果未确认：'+error.message+'。请刷新任务核查原记录，不要重新提交。');}
  finally{if(refreshing)await refreshing;await refresh();if($('background-archive').open)await loadArchive('');archiveBusy.delete(task.taskId);renderTasks();if(confirmed&&(document.activeElement===document.body||document.activeElement.closest?.('section')?.dataset.submissionKey===(entry?entry.key:'external:'+task.taskId))){if(toArchive)$('background-archive').querySelector('summary').focus({preventScroll:true});else [...$('background-task-list').querySelectorAll('section')].find(row=>row.textContent.includes(task.taskId))?.querySelector('[data-action=archive]')?.focus({preventScroll:true});}}
 }
 async function exportArchive(task,entry){
  if(archiveBusy.has(task.taskId))return;archiveBusy.add(task.taskId);renderTasks();let url,link;
  try{
   const response=await client.exportTask(task.taskId),record=response.record;
   if(response.protocolVersion!==1||record?.format!=='coconut-background-task-record'||record.version!==1||!sameTask(record.task,task)||!Array.isArray(record.task.snapshot)||typeof record.task.idempotencyKey!=='string'||typeof record.task.inputDigest!=='string')throw new Error('完整任务记录无效');
   if(entry&&record.task.idempotencyKey!==entry.key)throw new Error('提交身份不一致');
   const saved={format:'coconut-background-task-recovery',version:1,record,...(entry?{association:copy(entry)}:{})};
   url=URL.createObjectURL(new Blob([JSON.stringify(saved,null,2)],{type:'application/json'}));link=el('a');link.href=url;link.download='coconut-task-recovery-'+task.taskId.replace(/[^a-zA-Z0-9_-]/g,'_')+'.json';link.hidden=true;document.body.append(link);link.click();
   message('已发起完整任务救援 JSON 下载，请确认保存。含完整提交原文、结果和任务身份；原浏览器关联如有也已保留。仅用于备份核查，本版不能导入或接管文稿，也不会删除本机记录。');
  }catch(error){message('救援下载失败：'+error.message+'；本机记录未更改。');}
  finally{archiveBusy.delete(task.taskId);link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);renderTasks();}
 }
 function renderTasks(){
  renderBulk();
  const host=$('background-task-list'),archiveHost=$('background-archive-list'),visibleEntries=currentEntries(),archivedEntries=$('background-archive').open?archivePage.map(task=>entries.find(entry=>entry.task?.taskId===task.taskId)).filter(entry=>entry&&isArchived(entry.task)):[];
  $('background-archive-status').textContent=archiveLoading?'正在读取归档…':archiveError||(!archiveSupported()?'归档需要连接支持此功能的本机执行器。':archiveLookup?'taskId 精确查找：'+archiveLookup+'。恢复不会重新执行。':archiveLocal?'本浏览器保留 '+archiveTotal+' 条归档关联；每页核对最多 20 条，找不到时请切回原执行器。':'归档 '+archiveTotal+' 条；每页最多 20 条。恢复只返回当前列表，不会重新执行。');
  $('background-archive-next').disabled=archiveLoading||!archiveNext;$('background-archive-first').disabled=archiveLoading||!archiveSupported();$('background-archive-find').disabled=archiveLoading||!archiveSupported();$('background-archive-local').disabled=archiveLoading||!archiveSupported();$('background-archive-local').textContent='查看本浏览器归档关联（'+entries.filter(entry=>isArchived(entry.task)).length+'）';
  const count=visibleEntries.length+external.length,unfinished=visibleEntries.filter(entry=>!missingTask(entry)&&live.has(entry.task?.status)).length+external.filter(task=>live.has(task.status)).length,unknown=visibleEntries.filter(entry=>!entry.task||missingTask(entry)).length,ready=visibleEntries.filter(entry=>!missingTask(entry)&&entry.task?.status==='succeeded'&&!entry.cancelRequested&&!accepted(entry)).length,standalone=external.filter(task=>task.status==='succeeded').length;
  $('background-task-count').textContent=String(count);
  const compactStatus=$('library-background-task-status');compactStatus.hidden=!count;
  const compactText=count?' · '+(unfinished?'进行中 '+unfinished:unknown?'待确认 '+unknown:ready?'待接收 '+ready:standalone?'可查看结果 '+standalone:count+' 条记录'):'';
  if(compactStatus.textContent!==compactText)compactStatus.textContent=compactText;
  $('background-executor-status').textContent=connection;
  if(storageError)message(storageError);
  const signature=JSON.stringify([[...archiveSelection.keys()],bulkLocked(),bulkSupported(),archivePage,archiveLocal,archiveLookup,archiveLoading,archiveError,$('background-archive').open,[...archiveBusy],entries.map(entry=>[entry.key,entry.task&&[entry.task.taskId,entry.task.attemptId,entry.task.inputDigest,entry.task.status,entry.task.cancellation?.executionSettled,entry.task.progress,entry.task.archivedAt,entry.task.error,entry.task.result?.answer,entry.task.result?.citations],entry.cancelRequested,entry.retired,entry.missing,accepted(entry),canReceive(entry),owner(entry)===active(),accepting.has(entry.key)]),external,[...externalResults].map(([id,state])=>[id,state.loading,state.error,!!state.task]),supported(),submitting,storageError]);
  if(signature===listSignature)return;listSignature=signature;
  const opened=new Set([...$('background-tasks').querySelectorAll('section[data-submission-key] details[open]')].map(node=>node.closest('section').dataset.submissionKey));
  const focused=$('background-tasks').contains(document.activeElement)&&document.activeElement.closest('section[data-submission-key]')?{key:document.activeElement.closest('section')?.dataset.submissionKey,action:document.activeElement.dataset.action,summary:document.activeElement.tagName==='SUMMARY'}:null;
  host.replaceChildren();archiveHost.replaceChildren();
  for(const entry of [...visibleEntries].reverse().concat(archivedEntries)){
   const task=entry.task,row=el('section','background-task');row.dataset.submissionKey=entry.key;
   row.append(el('h3','',entry.title||'文字稿摘要'));
   let status=entry.cancelRequested?'已请求取消；未确认执行收尾':task?labels[task.status]||'未知任务状态':'提交结果待确认，请刷新查询';
   if(entry.cancelRequested&&terminalCancellation(task))status=terminalCancellation(task);
   if(task?.status==='cancelled')status='已取消；已发送的请求仍可能消耗额度';
   if(accepted(entry))status='已接收至原文稿的摘要历史';
   if(missingTask(entry))status='此执行器找不到此任务；不会自动重提交';
   row.append(el('p','',status+(task?.progress?` · ${missingTask(entry)?'上次回执：':''}${task.progress.completed}/${task.progress.total} 次请求完成`:'')));
   row.append(el('p','hint','任务：'+(task?.taskId||'回执待确认')+' · '+entry.payload.provider));
   if(missingTask(entry))row.append(el('p','hint','已保留原任务标识和提交关联。它可能来自其他本机执行器目录；请切回原服务后刷新核查。本页保留的是上次回执，不能据此确认当前执行情况；原请求可能已消耗额度，新提交会创建独立任务。'));
   if(task?.error?.message)row.append(el('p','hint',task.error.message));
   if(entry.retired)row.append(el('p','hint','原文稿已移除或更换，不能接收旧结果。'));
   if(isArchived(task))row.append(el('p','hint','已归档；保留原任务身份、原文与结果。'));
   if(task?.status==='succeeded'&&!entry.cancelRequested&&!missingTask(entry)){
    if(!resultPreview(row,task,opened,entry.key))row.append(el('p','hint',task.result?'结果不完整或引用无法核对，请刷新重新查询；此结果不能接收。':'结果内容尚未读取，请恢复执行器连接后刷新查询。'));
    const doc=owner(entry),canAccept=!isArchived(task)&&canReceive(entry)&&active()===doc&&!accepted(entry)&&!accepting.has(entry.key);
    row.append(button(accepted(entry)?'已接收':'接收至当前原文稿','accept',entry,()=>accept(entry),!canAccept));
    if(!accepted(entry)&&!canAccept)row.append(el('p','hint','请打开原文稿并保持原文一致；修改稿、重新导入或其他文档不能接收此结果。'));
   }
   if(!task&&!entry.cancelRequested&&entry.missing)row.append(button('重发原提交（同一任务意图）','resubmit',entry,()=>resubmit(entry),!available(entry.payload.provider)||submitting||!mayResubmit(entry)));
   if(!missingTask(entry)&&(!task||live.has(task.status)))row.append(button('取消后台任务','cancel',entry,()=>cancel(entry),!supported()));
   archiveActions(row,task,entry);(isArchived(task)?archiveHost:host).append(row);
  }
  for(const task of external.concat($('background-archive').open?archivePage.filter(task=>!entries.some(entry=>entry.task?.taskId===task.taskId)):[])){
   const row=el('section','background-task'),key='external:'+task.taskId;row.dataset.submissionKey=key;
   row.append(el('h3','','本机其他任务'),el('p','',`${task.taskId} · ${task.status==='succeeded'?'已完成，可查看独立结果':labels[task.status]||task.status}`),el('p','hint','此浏览器没有原提交关联，不能接收至文稿。'));
   if(task.error?.message)row.append(el('p','hint',task.error.message));
   if(task.status==='succeeded'){
    const state=externalResults.get(task.taskId);row.append(el('p','hint','原文稿标识：'+task.document?.key+' · '+task.provider));
    if(state?.task){resultPreview(row,state.task,opened,key,state.open);state.open=false;}
    else{
     const view=button(state?.loading?'正在读取结果…':state?.error?'重试读取独立结果':'查看独立结果','view-result',null,()=>loadExternal(task));
     // Keep keyboard focus while this read is pending; the handler fences
     // repeated activation, and the completed view hands focus to its summary.
     view.setAttribute('aria-disabled',String(!!state?.loading));view.setAttribute('aria-busy',String(!!state?.loading));row.append(view);
    }
    if(state?.error)row.append(el('p','hint',state.error));
   }
   if(live.has(task.status))row.append(button('取消后台任务','cancel',null,async()=>{try{await client.cancel(task.taskId);await refresh();}catch(error){message('取消结果未确认：'+error.message);}},!supported()));archiveActions(row,task,null);(isArchived(task)?archiveHost:host).append(row);
  }
  if(focused){const row=[...host.children,...archiveHost.children].find(node=>node.dataset.submissionKey===focused.key),target=focused.summary?row?.querySelector('summary'):[...row?.querySelectorAll('button,input[data-action]')||[]].find(node=>node.dataset.action===focused.action&&!node.disabled)||(focused.action==='view-result'?row?.querySelector('summary'):null);target?.focus({preventScroll:true});}
  if(!visibleEntries.length&&!external.length)host.append(el('p','hint','暂无后台任务。可在整篇摘要中选择“本机后台”。'));
 }
 function render(){
  const selected=$('ai-task').value==='summary',background=selected&&$('summary-execution').value==='background',doc=active();
  $('summary-execution-control').hidden=!selected;$('summary-execution').disabled=!!summaryScope||submitting;
  $('summary-background-status').hidden=!background;
  $('summary-open-background-tasks').hidden=!entries.length&&!background;
  if(background){
   const readiness=Coconut.summaryReadiness(doc),plan=readiness.plan;
   const signature=JSON.stringify([doc?.key,doc?.background_summary_lifetime,$('ai-provider').value,plan?.source]);
   if(signature!==consentSignature){consentSignature=signature;$('ai-consent').checked=false;}
   const provider=$('ai-provider').value==='codex'?'ChatGPT / Codex':'Claude';
   const current=entries.findLast(entry=>owner(entry)===doc);
   $('summary-background-status').textContent=(current?'本篇后台任务：'+(missingTask(current)?'此执行器找不到此任务；新提交会创建独立任务':current.task?labels[current.task.status]||current.task.status:'提交结果待确认')+'。':'')+connection+(storageError?' '+storageError:'');
   $('summary-job-state').hidden=true;$('restart-summary').hidden=true;$('stop-summary').hidden=true;
   $('ask-ai').textContent=submitting?'正在保存并提交…':'提交本机后台摘要';
   $('ask-ai').disabled=!readiness.ready||!available()||submitting||asking||translating||subscriptionTranslating||!contentIngressAllowed(doc);
   if(plan){$('summary-plan').textContent=compactSummaryPlan(plan,null,true);planCounts('summary-plan',plan.segments,plan.requests);}
   $('ai-send-description').textContent='本机后台处理完整原文，以及分批汇总所需的笔记与引用；不发送阅读笔记、译文或音视频。收起面板、切换文档或关闭页面后继续，只能在本机后台任务中显式取消。电脑及执行器须保持运行；重启中断后不会自动重跑，已发送请求的额度可能未知。结果需你核对后接收。前台分批进度不用于此任务。';
   $('ai-consent-copy').textContent=`同意按上述完整范围和最多请求次数发送给 ${provider} 并使用订阅额度；本机后台在收起或离页后继续。登录与剩余额度未由任务接口核验。`;
  }else if(selected&&!$('ai-send-description').textContent.includes('前台模式：')){$('ai-send-description').textContent+=' 前台模式：收起或离开此面板后停止后续批次，当前批次仍可能完成；保留原有分批继续流程。';}
  renderTasks();
 }
 async function refresh(){
  if(refreshing)return refreshing;
  const initialReads=new Map(entries.map(entry=>[entry.key,reads.get(entry.key)||0]));
  refreshing=(async()=>{
   if(!client){capability=null;connection='当前页面缺少后台任务模块，不能处理后台摘要；阅读不受影响。请刷新或修复完整安装。';return;}
   if(!localOrigin()){capability=null;connection='此页面未连接本机 bridge，不能处理后台摘要；原文仍可阅读。请在运行 Coconut 的电脑上打开本机页面。';return;}
   try{
    capability=await client.describe();
    if(!supported()){connection=capability?.protocolVersion!==1?'执行器协议版本不兼容；请更新本机 Coconut，或保留前台摘要。':'本机后台任务能力不可用；阅读及原有前台功能保留。';return;}
    connection='已连接此电脑的后台任务接口；订阅登录与额度仍需单独核验。';
    const listing=await client.list();if(listing.protocolVersion!==1||!Array.isArray(listing.tasks))throw new Error('任务列表协议不兼容');
    const byId=new Map(listing.tasks.map(task=>[task.taskId,task]));
    for(const entry of entries){
     if(!initialReads.has(entry.key)||!currentRead(entry,initialReads.get(entry.key))||(isArchived(entry.task)&&!byId.has(entry.task.taskId)&&!archivePage.some(task=>task.taskId===entry.task.taskId)))continue;
     const version=beginRead(entry);
     const metadata=byId.get(entry.task?.taskId);
     let response;
     try{response=metadata&&metadata.status!=='succeeded'?{protocolVersion:1,task:metadata}:metadata?.status==='succeeded'&&TaskAPI.recoveryFor(entry.task)?{protocolVersion:1,task:{...metadata,result:entry.task.result}}:entry.task?.taskId?await client.get(entry.task.taskId):await client.findSubmission(entry.key);}
     catch(error){
      if(!currentRead(entry,version))continue;
      // A healthy executor can use a different task directory at this same
      // browser origin. Preserve the old identity, never retry its submission,
      // and isolate only the API's explicit per-task not-found response.
      if(!entry.task?.taskId||error.status!==404||error.code!=='not_found')throw error;
      entry.missing=true;beginRead(entry);continue;
     }
     if(!currentRead(entry,version))continue;
     if(response.protocolVersion!==1)throw new Error('任务状态协议不兼容');
     if(response.task){if(!validTask(entry,response.task))throw new Error('任务回执与提交不一致');applyTask(entry,response.task,version);if(entry.cancelRequested&&['queued','running'].includes(entry.task.status))await cancel(entry);}
     else entry.missing=true;
    }
    external=listing.tasks.filter(task=>!entries.some(entry=>entry.task?.taskId===task.taskId));
    for(const [id,state] of externalResults)if(![...external,...archivePage].some(task=>task.taskId===id&&sameTask(task,state.identity)))externalResults.delete(id);
    safeSave();if($('background-archive').open)await loadArchive(archiveAfter,archiveLookup,archiveLocal);
   }catch(error){capability=null;connection='本机执行器暂时不可用：'+error.message+'。任务可能仍在后台执行，请恢复连接后刷新；阅读不受影响。';}
  })().finally(()=>{refreshing=null;renderLanguage();render();schedule();});
  return refreshing;
 }
 function validTask(entry,task){return task?.kind==='summary'&&Object.hasOwn(labels,task.status)&&typeof task.taskId==='string'&&task.document?.key===entry.payload.document.key&&task.document.revision===entry.payload.document.revision&&task.provider===entry.payload.provider;}
 async function send(entry){
  const version=beginRead(entry);
  try{
   const response=await client.submit(entry.payload);if(response.protocolVersion!==1||!validTask(entry,response.task))throw new Error('任务回执不一致，请按原提交查询');
   if(!applyTask(entry,response.task,version))return;safeSave();message('后台任务已接收。可在书架“本机后台任务”查询；收起或离页不会取消。');
  }catch(error){if(!currentRead(entry,version))return;entry.error=error.message;safeSave();message('提交结果未确认，请刷新查询原任务。不要新建任务重复消耗额度。'+error.message);}
 }
 async function submit(){
  if(submitting)return;
  const doc=active(),provider=$('ai-provider').value;
  if(!$('ai-consent').checked||$('summary-execution').value!=='background'||!available(provider)||!contentIngressAllowed(doc))return;
  const readiness=Coconut.summaryReadiness(doc);if(!readiness.ready)return;
  const signature=JSON.stringify([doc.key,doc.background_summary_lifetime,provider,readiness.plan.source]);
  if(signature!==consentSignature){$('ai-consent').checked=false;render();message('原文或范围已变化，请重新确认。');return;}
  if(entries.some(entry=>owner(entry)===doc&&sourceMatches(entry,doc)&&entry.payload.provider===provider&&!missingTask(entry)&&(!entry.task||live.has(entry.task.status)))){message('已有相同范围的后台任务，请先查询或取消。');$('background-tasks').open=true;return;}
  submitting=true;const source=copy(readiness.plan.source),originalSelection=activeSelectionRevision;renderLanguage();
  try{
   if(currentEntries().length>=MAX_ENTRIES)throw new Error('未归档任务关联已达 128 条上限；请在本机后台任务中显式归档已收尾记录后再提交');
   // Local-only ownership survives storage reload, but Coconut.validate strips
   // it on ordinary JSON imports. Reimported copies cannot inherit a task.
   if(!uuid(doc.background_summary_lifetime))doc.background_summary_lifetime=crypto.randomUUID();const lifetime=doc.background_summary_lifetime;
   const saved=await commitDocument(doc);
   if(!saved.ok)throw new Error('原文稿身份未保存，未提交后台任务');
   if(!contentIngressAllowed(doc)||active()!==doc||activeSelectionRevision!==originalSelection||doc.background_summary_lifetime!==lifetime||JSON.stringify(source)!==JSON.stringify(CoconutSummary.plan(doc).source)||!$('ai-consent').checked||$('summary-execution').value!=='background'||$('ai-provider').value!==provider)throw new Error('保存期间文稿或确认已变化，未提交后台任务');
   const key=crypto.randomUUID(),revision=lifetime+':'+crypto.randomUUID();
   const entry={key,lifetime,title:doc.title,payload:TaskAPI.submission(doc,{revision,provider,idempotencyKey:key,consent:true})};
   entries.push(entry);try{save();}catch(error){entries.pop();throw error;}
   $('background-tasks').open=true;$('ai-consent').checked=false;render();await send(entry);
  }catch(error){message(error.message);}
  finally{submitting=false;$('ai-consent').checked=false;renderLanguage();render();schedule();}
 }
 async function resubmit(entry){
  if(submitting||entry.task?.taskId||!entry.missing||!available(entry.payload.provider)||!mayResubmit(entry))return;
  submitting=true;const doc=owner(entry),version=beginRead(entry);
  try{
   const response=await client.findSubmission(entry.key);
   if(!currentRead(entry,version))return;
   if(response.protocolVersion!==1)throw new Error('任务查询版本不兼容');
   if(response.task){if(!validTask(entry,response.task))throw new Error('任务不匹配');applyTask(entry,response.task,version);safeSave();}
   else{
    // A read can outlive the user's cancellation, edit, removal, storage
    // conflict or native-close barrier. Only the original live intent may send.
    if(owner(entry)!==doc||!available(entry.payload.provider)||!mayResubmit(entry))throw new Error('查询期间原文、取消意图或保存状态已变化');
    await send(entry);
   }
  }catch(error){message('原任务查询失败，未重发：'+error.message);}
  finally{submitting=false;renderLanguage();render();schedule();}
 }
 async function cancel(entry){
  if(missingTask(entry)){message('此执行器找不到原任务，未发送取消。请切回原服务后刷新核查。');return;}
  if(entry.task&&!live.has(entry.task.status))return;
  entry.cancelRequested=true;const version=beginRead(entry);safeSave();render();
  try{
   let task=entry.task;
   if(!task?.taskId){
    const found=await client.findSubmission(entry.key);
    if(!currentRead(entry,version))return;
    if(found.protocolVersion!==1)throw new Error('查询协议不兼容');
    if(!found.task)throw new Error('尚未查到原提交，请稍后再次取消；未重发任务');
    if(!validTask(entry,found.task))throw new Error('任务回执不匹配');task=found.task;
   }
   const response=await client.cancel(task.taskId);
   if(!currentRead(entry,version))return;
   if(response.protocolVersion!==1||!validTask(entry,response.task))throw new Error('取消回执不匹配');
   applyTask(entry,response.task,version);safeSave();message(terminalCancellation(entry.task)||'取消已请求；已发送请求可能仍消耗额度，不再接收此任务结果。');
  }catch(error){if(currentRead(entry,version))message('取消结果未确认，请恢复连接后再次取消。'+error.message);}
  finally{render();schedule();}
 }
 async function accept(entry){
  const doc=owner(entry);if(accepting.has(entry.key)||accepted(entry)||active()!==doc)return;
  const answer=receipt(entry);if(!answer)return;
  accepting.add(entry.key);
  // No await between final ownership/source validation and append. Existing
  // notes, source and historical answers are never replaced by a task snapshot.
  doc.ai_answers||=[];doc.ai_answers.push(answer);if(!Array.isArray(doc.background_summary_receipts))doc.background_summary_receipts=[];doc.background_summary_receipts.push(entry.task.taskId);
  const saved=await commitDocument(doc);accepting.delete(entry.key);
  if(!saved.ok){message('接收结果仅在此页，尚未保存。请使用重试保存或导出文稿备份，暂时不要刷新。');}
  else if(owner(entry)===doc&&canReceive(entry))message('已接收并保存至原文稿摘要历史。');
  if(active()===doc){renderLanguage();window.dispatchEvent(new Event('coconut-summary-updated'));}render();
 }
 $('summary-execution').onchange=async()=>{$('ai-consent').checked=false;consentSignature='';renderLanguage();render();if($('summary-execution').value==='background')await refresh();};
 $('background-refresh').onclick=refresh;
 $('background-bulk-select').onclick=()=>{if(bulkLocked()||!bulkSupported()||storageError||archiveBusy.size)return;archiveSelection.clear();for(const [key,item] of [...bulkCandidates()].slice(0,MAX_ENTRIES))archiveSelection.set(key,item);renderTasks();};
 $('background-bulk-clear').onclick=()=>{if(!bulkLocked()){archiveSelection.clear();renderTasks();}};
 $('background-bulk-review').onclick=()=>reviewArchive([...archiveSelection.values()]);
 $('background-bulk-confirm').onclick=runArchiveBatch;
 $('background-bulk-cancel').onclick=()=>{if(archiveBatch?.phase==='running'){archiveBatch.cancelled=true;renderTasks();}else{archiveBatch=null;renderTasks();(!$('background-bulk-review').disabled?$('background-bulk-review'):$('background-refresh')).focus({preventScroll:true});}};
 $('background-bulk-retry').onclick=()=>{if(archiveBatch?.phase==='done')reviewArchive(archiveBatch.items.filter(item=>item.outcome!=='success'));};
 $('background-archive').ontoggle=()=>{if($('background-archive').open)void refresh();};
 $('background-archive-first').onclick=()=>loadArchive('');
 $('background-archive-next').onclick=()=>loadArchive(archiveNext||'','',archiveLocal);
 $('background-archive-local').onclick=()=>loadArchive('','',true);
 $('background-archive-find').onclick=()=>{const id=$('background-archive-id').value.trim();if(!id||id.length>128){message('请输入完整 taskId（最多 128 字符）。');return;}return loadArchive('',id);};
 $('summary-open-background-tasks').onclick=()=>{if($('toggle-library').getAttribute('aria-expanded')!=='true')toggleLibraryBrowsing();if($('library-tools').contains($('background-tasks')))$('library-tools').open=true;$('background-tasks').open=true;$('background-tasks').querySelector('summary').focus({preventScroll:true});$('background-tasks').scrollIntoView?.({block:'start'});void refresh();};
 window.addEventListener('coconut-render',render);
 window.addEventListener('coconut-storage-ready',render);
 window.addEventListener('pageshow',()=>{closed=false;if(entries.length||external.length)void refresh();});
 window.addEventListener('coconut-document-retiring',event=>{for(const entry of entries)if(entry.payload.document.key===event.detail?.key)entry.retired=true;safeSave();render();});
 window.addEventListener('coconut-source-corrected',event=>{const doc=event.detail?.identity;if(doc?.background_summary_lifetime){doc.background_summary_lifetime=crypto.randomUUID();queueDocument(doc);}render();});
 window.addEventListener('storage',event=>{if(event.key===STORE&&event.newValue!==previous){storageError='其他页面已更新任务关联，请刷新此页再提交或接收。';render();}});
 window.addEventListener('pagehide',()=>{closed=true;if(archiveBatch?.phase==='running')archiveBatch.cancelled=true;clearTimeout(timer);});
 window.CoconutBackgroundSummary={render,submit,refresh};render();
 if(entries.length)void refresh();
})();
