/* The UI owns durable user intent, never the executor's request lifetime. */
(function(){
 'use strict';
 const STORE='coconut-background-summary-v1',MAX_ENTRIES=128;
 const TaskAPI=window.CoconutTasks,client=typeof TaskAPI?.createClient==='function'?TaskAPI.createClient():null,copy=value=>JSON.parse(JSON.stringify(value));
 const live=new Set(['queued','running','cancel_requested']);
 const labels={queued:'排队中',running:'执行中',cancel_requested:'取消已请求，等待执行收尾',cancelled:'已取消',succeeded:'已完成，等待接收',failed:'失败',interrupted:'执行器中断，不会自动重跑'};
 let entries=[],external=[],previous=null,storageError='',capability=null,connection='尚未检查本机执行器；阅读不受影响。';
 let submitting=false,refreshing=null,timer=null,closed=false,consentSignature='',listSignature='';
 const reads=new Map(),accepting=new Set();
 function beginRead(entry){const version=(reads.get(entry.key)||0)+1;reads.set(entry.key,version);return version;}
 function currentRead(entry,version){return (reads.get(entry.key)||0)===version;}
 function applyTask(entry,task,version){if(!currentRead(entry,version))return false;if(entry.task&&!live.has(entry.task.status)&&task.status!==entry.task.status)throw new Error('任务终态与已保存回执冲突，请刷新核查');entry.task=task;entry.missing=false;beginRead(entry);return true;}
 const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
 try{
  previous=localStorage.getItem(STORE);
  if(!client&&previous!==null)throw new Error('后台任务客户端未加载，无法核对关联；请保留原记录并刷新或修复完整安装');
  const saved=previous===null?{version:1,entries:[]}:JSON.parse(previous);
  if(saved.version!==1||!Array.isArray(saved.entries)||saved.entries.length>MAX_ENTRIES||saved.entries.some(item=>!item||typeof item.key!=='string'||typeof item.lifetime!=='string'||typeof item.payload?.document?.revision!=='string'||item.payload?.idempotencyKey!==item.key||!Array.isArray(item.payload?.segments)))throw new Error('任务关联格式不可用');
  const keys=new Set();
  for(const entry of saved.entries){
   if(keys.has(entry.key)||!uuid(entry.lifetime)||entry.payload.protocolVersion!==1||entry.payload.kind!=='summary'||entry.payload.consent!==true)throw new Error('任务身份无效');
   TaskAPI.submission({key:entry.payload.document.key,segments:entry.payload.segments},{revision:entry.payload.document.revision,provider:entry.payload.provider,idempotencyKey:entry.key,consent:true});
   if(entry.task&&(!validTask(entry,entry.task)||!Object.hasOwn(labels,entry.task.status)))throw new Error('任务状态无效');keys.add(entry.key);
  }
  entries=saved.entries;
 }catch(error){storageError='无法读取任务关联，未覆盖原记录。'+error.message;}
 function save(){
  if(storageError)throw new Error(storageError);
  try{
   if(localStorage.getItem(STORE)!==previous)throw new Error('其他页面已更新任务关联，请刷新此页后继续');
   const next=JSON.stringify({version:1,entries:entries.map(entry=>({...entry,...(entry.task?{task:{...entry.task,result:undefined}}:{})}))});localStorage.setItem(STORE,next);
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
 function canReceive(entry){
  const doc=owner(entry);if(storageError||entry.cancelRequested||entry.retired||!doc||!contentIngressAllowed(doc)||!sourceMatches(entry,doc))return false;
  return TaskAPI.matchesResult(entry.task,doc,entry.payload.document.revision);
 }
 function receipt(entry){return canReceive(entry)?TaskAPI.resultFor(entry.task,owner(entry),entry.payload.document.revision):null;}
 function accepted(entry){const ids=owner(entry)?.background_summary_receipts;return Array.isArray(ids)&&ids.includes(entry.task?.taskId);}
 function mayResubmit(entry){const doc=owner(entry);return !!doc&&contentIngressAllowed(doc)&&!entry.retired&&!entry.cancelRequested&&sourceMatches(entry,doc);}
 function schedule(){
  clearTimeout(timer);timer=null;
  if(!closed&&localOrigin()&&entries.some(entry=>!entry.task||live.has(entry.task.status)))timer=setTimeout(()=>void refresh(),4000);
 }
 function terminalCancellation(task){return task&&['succeeded','failed','interrupted'].includes(task.status)?'任务已结束（'+({succeeded:'已完成',failed:'失败',interrupted:'中断'})[task.status]+'）；已放弃接收，先前请求可能已消耗额度。':null;}
 function button(label,action,entry,handler,disabled=false){const node=el('button','',label);node.type='button';node.dataset.action=action;node.disabled=disabled;node.onclick=handler;return node;}
 function renderTasks(){
  const host=$('background-task-list');
  $('background-task-count').textContent=String(entries.length+external.length);
  $('background-executor-status').textContent=connection;
  if(storageError)message(storageError);
  const signature=JSON.stringify([entries.map(entry=>[entry.key,entry.task&&[entry.task.taskId,entry.task.status,entry.task.progress,entry.task.error,entry.task.result?.answer,entry.task.result?.citations],entry.cancelRequested,entry.retired,entry.missing,accepted(entry),canReceive(entry),owner(entry)===active(),accepting.has(entry.key)]),external,supported(),submitting,storageError]);
  if(signature===listSignature)return;listSignature=signature;
  const opened=new Set([...host.querySelectorAll('section[data-submission-key] details[open]')].map(node=>node.closest('section').dataset.submissionKey));
  const focused=host.contains(document.activeElement)?{key:document.activeElement.closest('section')?.dataset.submissionKey,action:document.activeElement.dataset.action,summary:document.activeElement.tagName==='SUMMARY'}:null;
  host.replaceChildren();
  for(const entry of [...entries].reverse()){
   const task=entry.task,row=el('section','background-task');row.dataset.submissionKey=entry.key;
   row.append(el('h3','',entry.title||'文字稿摘要'));
   let status=entry.cancelRequested?'已请求取消；未确认执行收尾':task?labels[task.status]||'未知任务状态':'提交结果待确认，请刷新查询';
   if(entry.cancelRequested&&terminalCancellation(task))status=terminalCancellation(task);
   if(task?.status==='cancelled')status='已取消；已发送的请求仍可能消耗额度';
   if(accepted(entry))status='已接收至原文稿的摘要历史';
   row.append(el('p','',status+(task?.progress?` · ${task.progress.completed}/${task.progress.total} 次请求完成`:'')));
   row.append(el('p','hint','任务：'+(task?.taskId||'回执待确认')+' · '+entry.payload.provider));
   if(task?.error?.message)row.append(el('p','hint',task.error.message));
   if(entry.retired)row.append(el('p','hint','原文稿已移除或更换，不能接收旧结果。'));
   if(task?.status==='succeeded'&&!entry.cancelRequested){
    const details=el('details'),summary=el('summary','','查看后台结果（尚未写入文稿）');details.open=opened.has(entry.key);details.append(summary,el('p','background-result',task.result?.answer||'结果内容不可用'));if(task.result?.citations?.length)details.append(el('p','hint','原文引用：'+task.result.citations.join('、')));row.append(details);
    const doc=owner(entry),canAccept=canReceive(entry)&&active()===doc&&!accepted(entry)&&!accepting.has(entry.key);
    row.append(button(accepted(entry)?'已接收':'接收至当前原文稿','accept',entry,()=>accept(entry),!canAccept));
    if(!accepted(entry)&&!canAccept)row.append(el('p','hint','请打开原文稿并保持原文一致；修改稿、重新导入或其他文档不能接收此结果。'));
   }
   if(!task&&!entry.cancelRequested&&entry.missing)row.append(button('重发原提交（同一任务意图）','resubmit',entry,()=>resubmit(entry),!available(entry.payload.provider)||submitting||!mayResubmit(entry)));
   if(!task||live.has(task.status))row.append(button('取消后台任务','cancel',entry,()=>cancel(entry),!supported()));
   host.append(row);
  }
  for(const task of external){const row=el('section','background-task');row.append(el('h3','','本机其他任务'),el('p','',`${task.taskId} · ${labels[task.status]||task.status}`),el('p','hint','此浏览器没有原提交关联，不能接收至文稿。'));if(live.has(task.status))row.append(button('取消后台任务','cancel',null,async()=>{try{await client.cancel(task.taskId);await refresh();}catch(error){message('取消结果未确认：'+error.message);}},!supported()));host.append(row);}
  if(focused){const row=[...host.children].find(node=>node.dataset.submissionKey===focused.key),target=focused.summary?row?.querySelector('summary'):[...row?.querySelectorAll('button')||[]].find(node=>node.dataset.action===focused.action&&!node.disabled);target?.focus({preventScroll:true});}
  if(!entries.length&&!external.length)host.append(el('p','hint','暂无后台任务。可在整篇摘要中选择“本机后台”。'));
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
   $('summary-background-status').textContent=(current?'本篇后台任务：'+(current.task?labels[current.task.status]||current.task.status:'提交结果待确认')+'。':'')+connection+(storageError?' '+storageError:'');
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
     if(!initialReads.has(entry.key)||!currentRead(entry,initialReads.get(entry.key)))continue;
     const version=beginRead(entry);
     const metadata=byId.get(entry.task?.taskId);
     const response=metadata&&metadata.status!=='succeeded'?{protocolVersion:1,task:metadata}:metadata?.status==='succeeded'&&entry.task?.result?{protocolVersion:1,task:entry.task}:entry.task?.taskId?await client.get(entry.task.taskId):await client.findSubmission(entry.key);
     if(!currentRead(entry,version))continue;
     if(response.protocolVersion!==1)throw new Error('任务状态协议不兼容');
     if(response.task){if(!validTask(entry,response.task))throw new Error('任务回执与提交不一致');applyTask(entry,response.task,version);if(entry.cancelRequested&&['queued','running'].includes(entry.task.status))await cancel(entry);}
     else entry.missing=true;
    }
    external=listing.tasks.filter(task=>!entries.some(entry=>entry.task?.taskId===task.taskId));safeSave();
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
  if(entries.some(entry=>owner(entry)===doc&&sourceMatches(entry,doc)&&entry.payload.provider===provider&&(!entry.task||live.has(entry.task.status)))){message('已有相同范围的后台任务，请先查询或取消。');$('background-tasks').open=true;return;}
  submitting=true;const source=copy(readiness.plan.source),originalSelection=activeSelectionRevision;renderLanguage();
  try{
   if(entries.length>=MAX_ENTRIES)throw new Error('本机任务关联已达 128 条上限，请保留现有记录；本版尚无清理功能');
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
  if(submitting||!entry.missing||!available(entry.payload.provider)||!mayResubmit(entry))return;
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
 $('summary-open-background-tasks').onclick=()=>{if($('toggle-library').getAttribute('aria-expanded')!=='true')toggleLibraryBrowsing();$('background-tasks').open=true;$('background-tasks').querySelector('summary').focus({preventScroll:true});$('background-tasks').scrollIntoView?.({block:'start'});void refresh();};
 window.addEventListener('coconut-render',render);
 window.addEventListener('coconut-storage-ready',render);
 window.addEventListener('pageshow',()=>{closed=false;if(entries.length)void refresh();});
 window.addEventListener('coconut-document-retiring',event=>{for(const entry of entries)if(entry.payload.document.key===event.detail?.key)entry.retired=true;safeSave();render();});
 window.addEventListener('coconut-source-corrected',event=>{const doc=event.detail?.identity;if(doc?.background_summary_lifetime){doc.background_summary_lifetime=crypto.randomUUID();queueDocument(doc);}render();});
 window.addEventListener('storage',event=>{if(event.key===STORE&&event.newValue!==previous){storageError='其他页面已更新任务关联，请刷新此页再提交或接收。';render();}});
 window.addEventListener('pagehide',()=>{closed=true;clearTimeout(timer);});
 window.CoconutBackgroundSummary={render,submit,refresh};render();
 if(entries.length)void refresh();
})();
