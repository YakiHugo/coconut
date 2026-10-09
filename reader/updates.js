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
  if(hasUnsavedReaderChanges())reasons.push('文字稿或笔记有未保存修改');
  if(glossaryDirty()||glossaryDrafts.size>0)reasons.push('术语表有未保存修改');
  if(button('audio-bookmark-time').value.trim()||button('audio-bookmark-note').value.trim()||
     [...document.querySelectorAll('#audio-bookmarks form')].some(form=>{
      if(form.hidden)return false;
      const original=active()?.timestamp_bookmarks?.find(item=>item.id===form.parentElement.dataset.bookmarkId);
      return original&&Coconut.parseReadingTime(form.querySelector('input').value)!==original.time;
     }))reasons.push('时间书签尚未提交');
  const question=button('ai-question').value.trim();
  if(question&&!active()?.ai_answers?.some(answer=>answer.question===question))reasons.push('提问草稿仍在输入框');
  if(button('sample').disabled||[...document.querySelectorAll('input[type="file"]')].some(input=>input.files.length>0)||
     sourceSubmitting||sourceCaptionRequest||podcastRequest||podcastMediaRequest||projectCaptionRequest||Number(button('job-count').textContent)>0)reasons.push('导入、恢复或媒体任务仍在进行');
  if(translating||asking||subscriptionTranslating)reasons.push('AI 请求仍在进行，当前结果可能尚未保存');
  return {safe:reasons.length===0,reasons};
 }
 window.coconutPrepareClose=(mode='inspect')=>{
  if(mode==='inspect')return closeSnapshot();
  if(mode==='release'){
   if(readerClosing&&JSON.stringify(state.documents)!==savedDocumentsValue)saveWarning('退出未完成，当前页仍有未保存内容；请保存或导出备份后再退出。');
   readerClosing=false;document.body.inert=false;return true;
  }
  if(mode!=='safe'&&mode!=='discard')return false;
  if(mode==='safe'){
   if(!closeSnapshot().safe)return false;
   // A corrupt/stale untouched library needs no rewrite merely to close it.
   // All actual mutations already use synchronous save() and its dirty flag.
  }
  readerClosing=true;document.body.inert=true;
  // Only an approved final close reaches here. Async readers lose ownership;
  // submitted model calls cannot advance to another consented batch.
  cancelLocalImports();stopLanguageBatches();pendingMediaDocument=null;
  sourceCaptionRequest?.abort();sourceCaptionRequest=null;
  podcastRequest?.abort();podcastRequest=null;
  podcastMediaRequest?.abort();podcastMediaRequest=null;
  projectCaptionRequest?.controller.abort();projectCaptionRequest=null;
  return true;
 };
 // Returning false always keeps the window and original user data open.
 window.coconutPrepareUpdate=(lock=false)=>{
  if(document.querySelector('dialog[open]')||storageBlocked||!document.getElementById('save-status').hidden||glossaryDirty()||glossaryDrafts.size>0||pendingMediaDocument||
     [...document.querySelectorAll('input[type="file"]')].some(input=>input.files.length>0)||
     document.getElementById('audio-bookmark-time').value.trim()||document.getElementById('audio-bookmark-note').value.trim()||
     document.getElementById('ai-question').value.trim()||
     [...document.querySelectorAll('#audio-bookmarks form')].some(form=>!form.hidden)||
     sourceSubmitting||sourceCaptionRequest||podcastRequest||podcastMediaRequest||projectCaptionRequest||translating||asking||subscriptionTranslating||Number(document.getElementById('job-count').textContent)>0||
     [...document.querySelectorAll('audio,video')].some(media=>!media.paused))return false;
  const saved=save();if(saved&&lock)document.body.inert=true;return saved;
 };
})();
