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
  const reasons=[],nonContentReasons=[],content=libraryStore.status();
  if(removedDocument)nonContentReasons.push('移除备份仅在本页，关闭后无法撤销；可以撤销或导出备份后再关闭');
  if(hasUnsubmittedReaderDrafts())nonContentReasons.push('笔记或输入草稿有未提交修改');
  if(button('sample').disabled||[...document.querySelectorAll('input[type="file"]')].some(input=>input.files.length>0)||
     sourceSubmitting||sourceCaptionRequest||podcastRequest||podcastMediaRequest||projectCaptionRequest||Number(button('job-count').textContent)>0)nonContentReasons.push('导入、恢复或媒体任务仍在进行');
  if(translating||asking||subscriptionTranslating)nonContentReasons.push('AI 请求仍在进行，当前结果可能尚未保存');
  const contentPending=content.pending,contentFailed=content.unsaved>content.pending;
  if(contentPending)reasons.push('文字稿或笔记正在保存');
  if(contentFailed)reasons.push('文字稿或笔记有未保存修改；保存未完成，可以重试或导出备份');
  reasons.push(...nonContentReasons);
  return {safe:reasons.length===0,flushable:!contentFailed&&nonContentReasons.length===0,
   contentPending,contentFailed,nonContentReasons,reasons};
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
 function releaseOwner(owner){
  if(lifecycleOwner!==owner)return false;
  // Retire this object synchronously before releasing the barrier. A late
  // completion/finally must never unlock another owner's ingress or UI.
  lifecycleOwner=null;owner.retired=true;
  if(owner.phase==='locked')readerClosing=false;
  document.body.inert=owner.previousInert;delete document.body.dataset.lifecyclePending;
  libraryStore.releaseBarrier(owner.token);
  if(!owner.previousInert&&active()===owner.document&&owner.focus?.isConnected&&(!document.activeElement||document.activeElement===document.body))owner.focus.focus({preventScroll:true});
  return true;
 }
 function releaseAttempt(request){
  if(!attemptId(request)||request.id>latestAttempt||request.id===latestAttempt&&request.kind!==latestKind)return false;
  retiredThrough=Math.max(retiredThrough,request.id);
  if(!lifecycleOwner||lifecycleOwner.id!==request.id||lifecycleOwner.kind!==request.kind)return false;
  return releaseOwner(lifecycleOwner);
 }
 function ownerCurrent(owner){
  return lifecycleOwner===owner&&!owner.retired&&owner.id>retiredThrough&&owner.expiresAt>Date.now()&&libraryStore.barrierActive(owner.token);
 }
 function updateNonContentReady(snapshot=closeSnapshot()){
  return snapshot.nonContentReasons.length===0&&!document.querySelector('dialog[open]')&&!pendingMediaDocument&&
   !button('audio-bookmark-time').value.trim()&&!button('audio-bookmark-note').value.trim()&&!button('ai-question').value.trim()&&
   ![...document.querySelectorAll('#audio-bookmarks form')].some(form=>!form.hidden)&&
   ![...document.querySelectorAll('audio,video')].some(media=>!media.paused);
 }
 function commitClose(mode,request){
  if(!currentAttempt(request,request?.kind))return false;
  // Repeated calls share the actual pending completion, not an early true
  // merely because the owner object exists.
  if(lifecycleOwner)return lifecycleOwner.completion;
  const snapshot=closeSnapshot();
  if(mode==='safe'&&(!snapshot.flushable||request.kind==='update'&&!updateNonContentReady(snapshot)))return false;
  const token=libraryStore.acquireBarrier(request.id);if(!token)return false;
  const owner={id:request.id,kind:request.kind,expiresAt:request.expiresAt,token,phase:'pending',retired:false,completion:null,previousInert:document.body.inert===true,focus:document.activeElement,document:active()};
  lifecycleOwner=owner;document.body.inert=true;document.body.dataset.lifecyclePending='true';
  owner.completion=Promise.resolve().then(async()=>{
   try{
    if(!ownerCurrent(owner))return false;
    const receipt=await (mode==='discard'?libraryStore.discardPending(token):libraryStore.flush({token}));
    if(!receipt?.ok||!ownerCurrent(owner))return false;
    const finalSnapshot=closeSnapshot();
    if(mode==='safe'&&(!finalSnapshot.safe||owner.kind==='update'&&!updateNonContentReady(finalSnapshot)))return false;
    // This final clock write must happen while readerClosing is false.
    // Listening storage failure is independent of content persistence.
    flushListening(true);
    if(!ownerCurrent(owner))return false;
    owner.phase='locked';delete document.body.dataset.lifecyclePending;readerClosing=true;document.body.inert=true;
    // Only the successful final owner may retire imports/model request owners.
    cancelLocalImports();retireLanguageOwners();pendingMediaDocument=null;
    sourceCaptionRequest?.abort();sourceCaptionRequest=null;
    podcastRequest?.abort();podcastRequest=null;
    podcastMediaRequest?.abort();podcastMediaRequest=null;
    projectCaptionRequest?.controller.abort();projectCaptionRequest=null;
    return true;
   }catch{releaseOwner(owner);return false;}
   finally{if(owner.phase!=='locked')releaseOwner(owner);}
  });
  return owner.completion;
 }
 window.coconutPrepareClose=(mode='inspect',request)=>{
  if(mode==='inspect')return !request||currentAttempt(request,'close')?closeSnapshot():null;
  if(mode==='release')return releaseAttempt(request);
  if((mode!=='safe'&&mode!=='discard')||!currentAttempt(request,'close'))return false;
  return commitClose(mode,request);
 };
 window.coconutPrepareUpdate=(lock=false,request)=>{
  if(request&&!currentAttempt(request,'update'))return false;
  if(lock)return request?commitClose('safe',request):false;
  if(lifecycleOwner||!updateNonContentReady())return false;
  // Staging may take time. Preflight waits for today's receipt but holds no
  // lasting lock; final install rechecks the latest state behind the barrier.
  return (async()=>{
   try{
    const receipt=await libraryStore.flush();
    if(!receipt?.ok||request&&!currentAttempt(request,'update')||lifecycleOwner)return false;
    const snapshot=closeSnapshot();return snapshot.safe&&updateNonContentReady(snapshot);
   }catch{return false;}
  })();
 };
})();
