/* Desktop-only update controls. All URLs, files and installation stay in the main process. */
(() => {
 const api=window.coconutUpdates;if(!api)return;
 const panel=document.getElementById('app-updates'),status=document.getElementById('update-status');panel.hidden=false;
 const button=id=>document.getElementById(id);
 function render(s){
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
