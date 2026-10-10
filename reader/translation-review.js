"use strict";
// Review is local and explicit. Nothing in this module calls a model or network.
(() => {
 const names={en:'英语',zh:'中文',ja:'日语',ko:'韩语',fr:'法语',de:'德语',es:'西班牙语'};
 const PAGE=30;
 let queueKey=null,queueLanguage='',queueOffset=0,session=null;
 const drafts=new Map();
 const queueDialog=$('translation-queue-dialog'),editor=$('translation-edit-dialog');
 const signature=entry=>JSON.stringify([entry.key,entry.id,entry.target]);
 function editorDirty(){return !!(editor.open&&session&&$('translation-edit-text').value!==session.text);}
 function captureDraft(){
  if(!editor.open||!session)return;
  if(editorDirty())drafts.set(signature(session),{...session,draftText:$('translation-edit-text').value});
  else drafts.delete(signature(session));
 }
 function hasDraft(){
  if(editorDirty())return true;
  for(const key of drafts.keys())if(!editor.open||!session||key!==signature(session))return true;
  return false;
 }
 function sync(){if(unloadGuardReady)syncUnsavedUnloadGuard();}
 function discardAllowed(){return !editorDirty()||window.confirm('放弃这条尚未保存的译文修正？');}
 function suspendEditor(){
  captureDraft();session=null;editor.close();sync();
 }
 function languages(){return Object.keys(names);}
 function renderContext(){
  const entries=session.context,total=entries.length,offset=session.contextOffset,container=$('translation-edit-context');
  container.replaceChildren();
  for(const entry of entries.slice(offset,offset+PAGE)){
   const text=Object.hasOwn(entry,'missing_id')?'历史上下文片段已不在当前文字稿：'+entry.missing_id+'。保存只确认当前显示的原文与上下文，历史机器依据仍保留。':Coconut.time(entry.start)+' · '+(entry.speaker?entry.speaker+'：':'')+entry.text;
   container.append(el('p','',text));
  }
  if(!total)container.append(el('p','','没有其他已存上下文。'));
  $('translation-edit-context-previous').disabled=offset===0;
  $('translation-edit-context-next').disabled=offset+PAGE>=total;
  $('translation-edit-context-position').textContent=total?`${offset+1}–${Math.min(offset+PAGE,total)} / ${total} 条上下文`:'0 条上下文';
  $('translation-edit-context-pages').hidden=total<=PAGE;
 }
 function renderQueue(){
  const doc=state.documents.find(d=>d.key===queueKey);if(!doc)return;
  const options=languages(doc),select=$('translation-queue-language');
  if(!options.includes(queueLanguage))queueLanguage=options.includes(doc.translation_view)?doc.translation_view:options[0]||'';
  select.replaceChildren();for(const language of options){const option=el('option','',names[language]);option.value=language;select.append(option);}select.value=queueLanguage;select.disabled=!options.length;
  const missing=$('translation-queue-mode').value==='missing';
  const queue=Coconut.translationReviewQueue(doc,queueLanguage,missing),entries=queue.entries.filter(entry=>!missing||entry.status==='missing');
  queueOffset=Math.min(queueOffset,Math.max(0,Math.floor((entries.length-1)/PAGE)*PAGE));
  $('translation-queue-title').textContent=doc.title+' · 译文核对';
  $('translation-queue-summary').textContent=options.length?`整篇 ${queue.total} 段 · ${names[queueLanguage]}：${queue.stale} 段过期／依据不完整，${queue.quality} 段质量提示，${queue.current} 段无待核对提示；${queue.missing} 段未保存此语言译文。`:'本篇还没有已保存的译文。这里不会自动生成译文。';
  $('translation-queue-list').replaceChildren();
  for(const entry of entries.slice(queueOffset,queueOffset+PAGE)){
   const segment=doc.segments[entry.position],row=el('li','translation-queue-item');
   row.append(el('strong','',Coconut.time(segment.start)+'–'+Coconut.time(segment.end)+' · '+(entry.status==='missing'?'缺失译文':entry.status==='stale'?'过期／依据不完整':'质量提示')),el('p','',entry.reason),el('p','translation-queue-preview',segment.text));
   const button=el('button','translation-queue-open',missing?'对照原文，自己写':'对照原文，核对译文');button.dataset.segmentId=segment.id;button.onclick=()=>openEditor(doc.key,segment.id,queueLanguage,true);row.append(button);
   $('translation-queue-list').append(row);
  }
  $('translation-queue-empty').hidden=entries.length>0;
  $('translation-queue-empty').textContent=missing?'当前语言的每一段都有已存译文。':'当前语言没有待核对的已存译文。选择「缺失译文」可自己写；无提示也不代表内容准确。';
  $('translation-queue-previous').disabled=queueOffset===0;$('translation-queue-next').disabled=queueOffset+PAGE>=entries.length;
  $('translation-queue-position').textContent=entries.length?`${queueOffset+1}–${Math.min(queueOffset+PAGE,entries.length)} / ${entries.length}`:'0 条';
 }
 function openQueue(){
  const doc=active();if(!doc||Coconut.isAudioProject(doc))return;
  if(queueKey!==doc.key){queueKey=doc.key;queueLanguage=doc.translation_view||'';queueOffset=0;}
  renderQueue();if(!queueDialog.open)queueDialog.showModal();
 }
 function openEditor(key,id,target,returnQueue=false){
  if(readerClosing||!discardAllowed())return;
  const doc=state.documents.find(d=>d.key===key),segment=doc?.segments.find(s=>s.id===id),item=segment?.translations?.[target];
  if(!segment||!Object.hasOwn(names,target)||active()!==doc||!contentIngressAllowed(doc))return;
  if(editor.open){drafts.delete(signature(session));session=null;editor.close();}
  queueDialog.close();
  goToSegment(id);if(doc.translation_view!==target){doc.translation_view=target;queueDocument(doc);}setReadingMode('transcript');render();
  const snapshot=Coconut.manualReviewSnapshot(doc,segment,target);
  const draft=drafts.get(signature({key,id,target}));
  session=draft?{...draft,returnQueue}:{key,id,target,document:doc,segment,snapshot,context:[...snapshot.cues.filter(c=>c.id!==id),...(snapshot.missing_cue_ids||[]).map(missing_id=>({missing_id}))],contextOffset:0,expected:JSON.stringify(item),text:item?.text||'',creating:!item,returnQueue};
  renderEditor();
 }
 function renderEditor(){
  const {id,target,document:doc,snapshot}=session,item=session.expected?JSON.parse(session.expected):null,segment=session.snapshot.cues.find(c=>c.id===id);
  $('translation-edit-heading').textContent=Coconut.time(segment.start)+'–'+Coconut.time(segment.end)+' · '+names[target]+(session.creating?' · 自己写译文':'译文核对');
  $('translation-edit-origin').textContent=(!item||item.provider==='user')?'用户自己写的译文；只保存在本篇，不调用 AI 或消耗模型额度。':`初始来源：${item.provider} · ${item.source_language||'未标明原语言'} → ${target}。人工保存不会证明模型输出准确。`;
  $('translation-edit-source').textContent=segment.text;
  $('translation-edit-hint').textContent=session.creating?'只保存你输入的译文和本次显示的原文依据，不保证翻译准确。完整备份请导出 JSON。':'只表示你已核对当前原文，不保证事实或模型质量。保存会保留初始译文与上一版，较早人工版本不会累积；完整备份请导出 JSON。';
  const previousSource=item?.manual_review?.cues?.find(c=>c.id===segment.id)?.text??item?.source_text??'';
  $('translation-edit-previous-source').textContent=previousSource;
  $('translation-edit-status').textContent=!item?'请对照当前原文与上下文，写入所选语言。':!Coconut.translationCurrent(segment,doc,item)?'这份译文依据已变化或记录不完整。请对照当前原文与上下文，修正后保存；确实无需改字时可明确确认已核对。':Coconut.translationQualityMessage(item)||'没有待核对提示；你仍可人工修正。';
  if(!Coconut.translationCurrent(segment,doc,item)&&item?.quality_warnings?.length)$('translation-edit-status').textContent+=' 当时自动提示：'+Coconut.translationQualityMessage({quality_warnings:item.quality_warnings})+'。';
  $('translation-edit-language-field').hidden=!session.creating;
  const select=$('translation-edit-language');select.replaceChildren();
  for(const language of languages()){const option=el('option','',names[language]);option.value=language;option.disabled=!!session.segment.translations?.[language]&&language!==target;select.append(option);}select.value=target;select.disabled=!!item;
  $('translation-edit-previous-heading').hidden=!item;$('translation-edit-previous-source').hidden=!item;
  $('save-next-missing-translation').hidden=!session.creating;
  renderContext();
  $('translation-edit-glossary').textContent=snapshot.glossary_snapshot.length?snapshot.glossary_snapshot.map(term=>term.source+' = '+term.target).join('\n'):'没有匹配的本篇术语。';
  $('translation-edit-text').value=session.draftText??session.text;$('translation-edit-error').textContent='';
  if(Object.hasOwn(session,'draftText'))$('translation-edit-status').textContent+=' 已恢复未提交草稿；下面保留打开时的原文与上下文，保存时会重新检查依据。';
  $('translation-edit-history').hidden=!item?.original_translation;
  $('translation-edit-original-text').textContent=item?.original_translation?.text||'';
  $('translation-edit-prior-text').textContent=item?.manual_review?.previous_text||'';
  updateSaveAction();editor.showModal();$('translation-edit-text').focus();sync();
 }
 function updateSaveAction(){
  const changed=session&&$('translation-edit-text').value!==session.text;
  $('save-translation-edit').textContent=session?.creating?'保存用户译文':changed?'保存人工修正':'保留译文，确认已核对当前原文';
 }
 function focusReviewAction(target){
  // Rendering replaces the original dialog opener. Resolve only the current
  // document's exact cue; never navigate or steal focus after a newer detour.
  if(!target||active()?.key!==target.key||workspace!=='read')return;
  const focusVisible=button=>{
   if(!button||button.disabled||button.closest('[hidden]'))return false;
   for(let parent=button;parent;parent=parent.parentElement){const style=window.getComputedStyle(parent);if(style.display==='none'||style.visibility==='hidden')return false;}
   for(let parent=button.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
   button.focus({preventScroll:true});return true;
  };
  const cue=[...$('transcript').querySelectorAll('.segment')].find(row=>row.dataset.segmentId===target.id);
  if(!focusVisible(cue?.querySelector('.review-translation-button')))focusVisible($('review-translations'));
 }
 function closeEditor(returnToQueue=true){
  if(!discardAllowed())return;
  const target=session,reopen=returnToQueue&&session?.returnQueue&&active()?.key===session.key;
  if(session)drafts.delete(signature(session));session=null;editor.close();sync();
  if(reopen)openQueue();else focusReviewAction(target);
 }
 $('review-translations').onclick=openQueue;
 $('translation-queue-mode').onchange=()=>{queueOffset=0;renderQueue();};
 $('translation-edit-language').onchange=()=>{if(!session)return;const target=$('translation-edit-language').value;if(!discardAllowed()){$('translation-edit-language').value=session.target;return;}if(session.segment.translations?.[target]){$('translation-edit-language').value=session.target;return;}drafts.delete(signature(session));const {key,id,returnQueue}=session;session=null;editor.close();openEditor(key,id,target,returnQueue);};
 $('translation-queue-language').onchange=()=>{queueLanguage=$('translation-queue-language').value;queueOffset=0;renderQueue();};
 $('translation-queue-previous').onclick=()=>{queueOffset-=PAGE;renderQueue();};
 $('translation-queue-next').onclick=()=>{queueOffset+=PAGE;renderQueue();};
 $('translation-queue-close').onclick=()=>queueDialog.close();
 $('translation-edit-context-previous').onclick=()=>{if(session){session.contextOffset=Math.max(0,session.contextOffset-PAGE);renderContext();}};
 $('translation-edit-context-next').onclick=()=>{if(session&&session.contextOffset+PAGE<session.context.length){session.contextOffset+=PAGE;renderContext();}};
 $('translation-edit-cancel').onclick=()=>closeEditor();
 editor.addEventListener('cancel',event=>{event.preventDefault();closeEditor();});
 editor.addEventListener('close',sync);
 $('translation-edit-text').oninput=()=>{captureDraft();updateSaveAction();sync();};
 async function save(event,nextMissing=false){
  event.preventDefault();if(readerClosing||!session)return;
  const submittedSession=session,doc=state.documents.find(d=>d.key===session.key),segment=doc?.segments.find(s=>s.id===session.id);
  if(doc!==session.document||segment!==session.segment){$('translation-edit-error').textContent='原文条目已被替换或关闭，请先复制草稿，再重新打开当前译文核对。';return;}
  if(!contentIngressAllowed(doc))return;
  if(!segment||active()!==doc){$('translation-edit-error').textContent='当前文档已切换，请保留草稿，回到原文档后重新核对。';return;}
  try{
   const text=$('translation-edit-text').value,owner={},focus=document.activeElement;
   const item=Coconut.saveManualTranslation(doc,segment,session.target,text,session.snapshot,session.expected);
   // The accepted text is now document content. Keep the editor available while
   // its receipt waits, using that text as the baseline for any newer draft.
   stopLanguageBatches();
   session.text=text;session.expected=JSON.stringify(item);session.pending=owner;delete session.draftText;$('translation-edit-language').disabled=true;
   drafts.delete(signature(session));updateSaveAction();$('translation-edit-error').textContent='正在保存人工修正…';
   const pending=commitDocument(doc);sync();const receipt=await pending;
   // A receipt must never close a newer editor, discard newer typing or restore
   // old focus after navigation, removal, another submission or native close.
   if(session!==submittedSession||session.pending!==owner||!contentIngressAllowed(doc)||active()!==doc||doc.segments.find(s=>s.id===session.id)!==segment)return;
   if(JSON.stringify(segment.translations?.[session.target])!==session.expected||JSON.stringify(Coconut.manualReviewSnapshot(doc,segment,session.target))!==JSON.stringify(session.snapshot)){$('translation-edit-error').textContent='提交后的原文、上下文或译文又有变化，请重新核对；当前草稿仍保留。';captureDraft();sync();return;}
   if($('translation-edit-text').value!==text){captureDraft();$('translation-edit-error').textContent=receipt.ok?'上次提交已保存；当前新修改仍是未提交草稿。':'上次提交仅保留在当前页；当前新修改仍是未提交草稿，请备份。';sync();return;}
   if(document.activeElement!==focus){$('translation-edit-error').textContent=receipt.ok?'人工修正已保存。':'人工修正仅保留在当前页，尚未保存到浏览器。请立即导出 JSON 备份。';sync();return;}
   const reopen=session.returnQueue,target=session;session=null;editor.close();render();sync();
   notice(receipt.ok?(target.creating?'已保存为用户自己写的译文，可导出 JSON 备份。':'已保存为用户人工核对／修正，初始译文和上一版保留在 JSON 备份中。'):'人工修正仅保留在当前页，尚未保存到浏览器。请立即导出 JSON 备份，暂时不要关闭页面。',receipt.ok?'success':'');
   if(nextMissing&&receipt.ok){const index=doc.segments.indexOf(segment),next=[...doc.segments.slice(index+1),...doc.segments.slice(0,index)].find(cue=>!cue.translations?.[target.target]);if(next){openEditor(doc.key,next.id,target.target,reopen);return;}notice('此语言的缺失译文已补齐。','success');}
   if(reopen)openQueue();else focusReviewAction(target);
  }catch(error){if(session===submittedSession){$('translation-edit-error').textContent=error.message;sync();}}
 }
 $('save-translation-edit').onclick=event=>save(event);
 $('save-next-missing-translation').onclick=event=>save(event,true);
 function renderEntry(){
  if(editor.open&&session&&active()?.key!==session.key)suspendEditor();
  const doc=active();$('review-translations').hidden=!doc||Coconut.isAudioProject(doc);
  if(queueDialog.open){if(active()?.key!==queueKey)queueDialog.close();else renderQueue();}
 }
 window.addEventListener('coconut-workspace-change',event=>{if(event.detail?.workspace!=='read'&&editor.open)suspendEditor();});
 window.addEventListener('coconut-document-retiring',event=>{
  const {key,bundle}=event.detail||{};if(!bundle)return;captureDraft();
  const removedDrafts=new Map();
  for(const [id,draft] of drafts)if(draft.key===key){removedDrafts.set(id,draft);drafts.delete(id);}
  bundle.translationReviewDrafts=removedDrafts;
  if(session?.key===key){session=null;editor.close();}
 });
 window.addEventListener('coconut-document-restored',event=>{
  const doc=state.documents.find(d=>d.key===event.detail?.key);
  for(const [id,draft] of event.detail?.translationReviewDrafts||[]){
   if(!doc||draft.key!==event.detail.key)continue;
   const segment=doc?.segments.find(s=>s.id===draft.id);
   // Only the explicit undo transaction can rebind a draft to a new identity.
   // Source or translation drift still fails the normal save checks.
   drafts.set(id,{...draft,document:doc,segment});
  }
 });
 window.CoconutTranslationReview=Object.freeze({hasDraft,openEditor});
 window.addEventListener('coconut-render',renderEntry);renderEntry();
})();
