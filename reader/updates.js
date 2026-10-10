/* Desktop-only update controls. All URLs, files and installation stay in the main process. */
(() => {
 const api=window.coconutUpdates;if(!api)return;
 const panel=document.getElementById('app-updates'),status=document.getElementById('update-status');panel.hidden=false;
 const button=id=>document.getElementById(id);
 function render(s){
  panel.querySelector('summary').textContent='应用更新'+(s.status==='ready'?' · 可安装':s.status==='downloading'?' · 下载中':s.status==='error'?' · 请重试':'');
  button('update-version').textContent=`Coconut ${s.version} · ${s.arch==='arm64'?'Apple Silicon':'Intel'}`;
  status.textContent=s.message;
  button('update-developer').checked=s.developer;
  const busy=['checking','downloading','installing'].includes(s.status);
  button('update-check').disabled=busy||s.status==='ready';
  button('update-developer').disabled=busy;
  button('update-download').hidden=!['available','error','cancelled'].includes(s.status)||!s.nextVersion;
  button('update-download').textContent=s.status==='available'?'下载 '+s.nextVersion:'重新下载';
  button('update-install').hidden=s.status!=='ready';
  button('update-cancel').hidden=!['checking','downloading'].includes(s.status);
  button('update-progress').hidden=s.status!=='downloading';
  button('update-progress').value=s.progress||0;
 }
 const run=async action=>{try{render(await action());}catch(error){status.textContent=error.message||'更新操作失败，请重试。';}};
 button('update-check').onclick=()=>run(api.check);
 button('update-download').onclick=()=>run(api.download);
 button('update-cancel').onclick=()=>run(api.cancel);
 button('update-install').onclick=()=>run(api.install);
 button('update-developer').onchange=()=>run(()=>api.developer(button('update-developer').checked));
 api.subscribe(render);void run(api.state);
 // Native lifecycle inspection is read-only: dismissing the native question
 // must not stop a request, revoke consent, cancel imports, or close a draft.
 function closeSnapshot(){
  const reasons=[];
  if(removedDocument)reasons.push('移除备份仅在本页，关闭后无法撤销；可以撤销或导出备份后再关闭');
  if(hasUnsavedReaderChanges())reasons.push('文字稿、笔记或输入草稿有未保存修改');
  if(button('sample').disabled||[...document.querySelectorAll('input[type="file"]')].some(input=>input.files.length>0)||
     sourceSubmitting||sourceCaptionRequest||podcastRequest||podcastMediaRequest||projectCaptionRequest||Number(button('job-count').textContent)>0)reasons.push('导入、恢复或媒体任务仍在进行');
  if(translating||asking||subscriptionTranslating)reasons.push('AI 请求仍在进行，当前结果可能尚未保存');
  return {safe:reasons.length===0,reasons};
 }
 // Main-process attempts are monotonically numbered for this renderer. Keep
 // only two watermarks: no old release may unlock a newer close/update, and a
 // call queued before a timeout cannot acquire a lock when it finally arrives.
 let lifecycleOwner=null,latestAttempt=0,latestKind=null,retiredThrough=0;
 const attemptId=request=>request&&Number.isSafeInteger(request.id)&&request.id>0&&['close','update'].includes(request.kind);
 function currentAttempt(request,kind){
  if(!attemptId(request)||request.kind!==kind||!Number.isFinite(request.expiresAt)||request.expiresAt<=Date.now()||
     request.id<=retiredThrough||request.id<latestAttempt||lifecycleOwner&&(lifecycleOwner.id!==request.id||lifecycleOwner.kind!==request.kind))return false;
  latestAttempt=request.id;latestKind=request.kind;return true;
 }
 function releaseAttempt(request){
  if(!attemptId(request)||request.id>latestAttempt||request.id===latestAttempt&&request.kind!==latestKind)return false;
  retiredThrough=Math.max(retiredThrough,request.id);
  if(!lifecycleOwner||lifecycleOwner.id!==request.id||lifecycleOwner.kind!==request.kind)return false;
  lifecycleOwner=null;
  if(readerClosing&&JSON.stringify(state.documents)!==savedDocumentsValue)saveWarning('退出未完成，当前页仍有未保存内容；请保存或导出备份后再退出。');
  readerClosing=false;document.body.inert=false;return true;
 }
 function commitClose(mode,request){
  if(!currentAttempt(request,request?.kind))return false;
  if(lifecycleOwner)return lifecycleOwner.id===request.id;
  if(mode==='safe'&&!closeSnapshot().safe)return false;
  // All content mutations currently save synchronously. A clean lifecycle
  // transition need not rewrite a corrupt/stale untouched library.
  flushListening(true);
  lifecycleOwner={id:request.id,kind:request.kind};readerClosing=true;document.body.inert=true;
  // Only an approved final close/install reaches here. Async readers lose
  // ownership; submitted model calls cannot advance another consented batch.
  cancelLocalImports();stopLanguageBatches();pendingMediaDocument=null;
  sourceCaptionRequest?.abort();sourceCaptionRequest=null;
  podcastRequest?.abort();podcastRequest=null;
  podcastMediaRequest?.abort();podcastMediaRequest=null;
  projectCaptionRequest?.controller.abort();projectCaptionRequest=null;
  return true;
 }
 window.coconutPrepareClose=(mode='inspect',request)=>{
  if(mode==='inspect')return !request||currentAttempt(request,'close')?closeSnapshot():null;
  if(mode==='release')return releaseAttempt(request);
  if((mode!=='safe'&&mode!=='discard')||!currentAttempt(request,'close'))return false;
  return commitClose(mode,request);
 };
 function updateReady(){
  // Share all native busy/draft predicates, including the asynchronous sample
  // fingerprint. Update has additional media/dialog restrictions.
  return closeSnapshot().safe&&!document.querySelector('dialog[open]')&&!storageBlocked&&button('save-status').hidden&&!pendingMediaDocument&&
   !button('audio-bookmark-time').value.trim()&&!button('audio-bookmark-note').value.trim()&&!button('ai-question').value.trim()&&
   ![...document.querySelectorAll('#audio-bookmarks form')].some(form=>!form.hidden)&&
   ![...document.querySelectorAll('audio,video')].some(media=>!media.paused);
 }
 window.coconutPrepareUpdate=(lock=false,request)=>{
  if(request&&!currentAttempt(request,'update'))return false;
  if(lock&&!request)return false;
  if(lifecycleOwner)return !!lock&&lifecycleOwner.id===request?.id&&lifecycleOwner.kind==='update';
  if(!updateReady())return false;
  return lock?commitClose('safe',request):true;
 };
})();
