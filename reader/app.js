"use strict";
const $ = (id) => document.getElementById(id);
const KEY = "coconut-reader-v1";
const ACTIVE_KEY = "coconut-reader-active-v1";
const LAST_ACTIVE_KEY = "coconut-reader-last-active-v1";
let state = { documents: [], active: null };
let readerClosing = false;
// One bounded recovery slot, held only in this page so removal frees storage.
// Never replace it silently or mistake a requested download for a saved backup.
let removedDocument = null;
let removalTarget = null;
let removalDialogOrigin = null;
let finishRemovalDialogOrigin = null;
let documentLifecycleRevision = 0;
const removedDocumentRevisions = new Map();
// Tombstones retain small identities/digests, never another document-sized trash copy.
const removedDocumentAliases = [];
function documentSourceIdentity(doc){return Coconut.audioProjectIdentity(doc)||(doc.source_media?JSON.stringify(doc.source_media):'');}
async function libraryDocumentSignature(doc){
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(Coconut.validate(doc))));
 return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function wasRemovedSince(doc,revision,key=doc.key){
 if((removedDocumentRevisions.get(key)||0)>revision)return true;
 if(!removedDocumentAliases.some(item=>item.revision>revision))return false;
 const signature=await libraryDocumentSignature(doc),source=documentSourceIdentity(doc);
 // Iterate the live list: a removal while a digest settles must also be checked.
 for(const removed of removedDocumentAliases){
  if(removed.revision<=revision)continue;
  if(source&&source===removed.source)return true;
  const previous=await removed.signature;
  if(previous===null||previous===signature)return true;
 }
 return (removedDocumentRevisions.get(key)||0)>revision;
}
let readingFollow = null, readingFollowFrame = null, readingFollowRevision = 0, readingFollowMoving = false;
let selected = null;
let notesOnly = false;
let excerptsOnly = false;
let speakerFilter = null;
function matchesReadingSegment(segment,doc,query){return (speakerFilter===null||(segment.speaker||'')===speakerFilter)&&Coconut.matchesSegment(segment,doc,query,notesOnly,excerptsOnly);}
let searchFocusedId=null;
// A temporary detour, never a persisted reading position or an AI selection.
let readingContext=null;
const readingContextHome=document.createComment('reading context home');
$('reading-context').before(readingContextHome);
let workspace = "read";
let readingScroll = 0;
let editingTarget = null;
let sourceTarget = null;
let sourceTargetIdentity = null;
let localImportRevision = 0;
let projectTranscriptTarget = null;
let localMediaPickerTarget=null,pendingLocalMediaChoice=null;
function projectSourceSnapshot(doc){return JSON.stringify(doc.podcast_source||doc.local_media_source);}
let pendingBackupReview = null;
let transcriptImportBatch = null;
function cancelLocalImports(keepInput = null) {
 localImportRevision++;
 stopTranscriptImportBatch();
 pendingLocalMediaChoice?.(null);
 if(keepInput!=="local-media-file")localMediaPickerTarget=null;
 pendingBackupReview?.(false);
 if(keepInput!=="project-transcript-file")projectTranscriptTarget=null;
 // Retire all import paths while preserving a newly selected input's file.
 for(const id of ["file", "library-file", "project-transcript-file", "local-media-file"])if(id!==keepInput)$(id).value = "";
 return localImportRevision;
}
window.addEventListener("pagehide", () => cancelLocalImports());
function backupSize(bytes){return (bytes/1024/1024).toFixed(2)+' MiB';}
function localFileReview(file, canCommit, library = false, batch = false) {
 const json=library||file.name.toLowerCase().endsWith('.json');
 if(!json){
  if(file.size>Coconut.SUBTITLE_IMPORT_BYTES)throw new Error('字幕文件超过15 MiB，请先拆分 SRT / VTT；完整 JSON 备份不受此字幕限制');
  return true;
 }
 if(file.size<=Coconut.BACKUP_REVIEW_BYTES)return true;
 // File.size is available before reading any content. The budget is a review
 // threshold, not a dead end for files Coconut itself can export.
 return new Promise(resolve=>{
  const dialog=$('large-backup-dialog');
  let settled=false;
  const finish=proceed=>{
   if(settled)return;settled=true;
   dialog.removeEventListener('close',cancel);dialog.removeEventListener('cancel',cancel);
   $('continue-large-backup').onclick=null;$('cancel-large-backup').onclick=null;$('stop-large-backup-batch').onclick=null;
   pendingBackupReview=null;if(dialog.open)dialog.close();
   const accepted=proceed&&canCommit();
   if(accepted)notice('正在完整读取 '+backupSize(file.size)+' 的备份，请稍候；请保留原备份文件。');
   resolve(accepted);
  };
  const cancel=event=>{
   // Native dialog.close() queues its event. An earlier selection's queued
   // close must not dismiss a newer review that is already open.
   if(event?.type==='close'&&dialog.open)return;
   event?.preventDefault();
   if(batch&&['cancel','close'].includes(event?.type))cancelLocalImports();
   finish(false);
  };
  pendingBackupReview=finish;
  $('large-backup-size').textContent=file.name+' · 文件大小：'+backupSize(file.size)+'（通常直接读取的预算为50 MiB）。';
  $('cancel-large-backup').textContent=batch?'跳过此文件':'取消';
  $('stop-large-backup-batch').hidden=!batch;$('stop-large-backup-batch').onclick=()=>cancelLocalImports();
  $('continue-large-backup').onclick=()=>finish(true);$('cancel-large-backup').onclick=cancel;
  dialog.addEventListener('close',cancel);dialog.addEventListener('cancel',cancel);
  dialog.showModal();$('cancel-large-backup').focus();
 });
}
function localFileError(error) {
 if(['RangeError','NotReadableError','AbortError'].includes(error?.name))return '读取或处理文件失败，可能超出当前设备可用内存。请保留原备份，在内存更充足的浏览器或电脑上重试。';
 return error?.message||'无法读取此文件，请检查文件内容后重试';
}
function backupRecoveryHint(blob){return blob.size>Coconut.BACKUP_REVIEW_BYTES?' 文件为'+backupSize(blob.size)+'，恢复时需要确认继续读取；需要足够可用内存，浏览器可能无法自动保存，请保留下载文件。':'';}

const PAGE_SIZE = 100;
let pageStart = 0;
let storageBlocked = false;
let unloadGuardReady = false;
let unloadGuardAttached = false;
let hasLanguageDrafts = () => false;
const audioBookmarkDrafts = new Map();
const persistedAIAnswerCounts = new WeakMap();
const persistedSummaryJobs = new WeakMap();
const pendingStructuralDocuments = new Map();
let pendingLibraryOperation = null;
const deferredContentInputs = new Map();
function summaryCheckpointSignature(job){return job?JSON.stringify([job.provider,job.snapshot,job.results]):null;}
function summaryCheckpointSaved(doc){return !!doc?.summary_job&&persistedSummaryJobs.get(doc)===summaryCheckpointSignature(doc.summary_job);}
function persistenceCheckpoint(doc){return {answerCount:(doc.ai_answers||[]).length,summarySignature:summaryCheckpointSignature(doc.summary_job)};}
function recordPersistenceCheckpoint(doc,checkpoint){
 persistedAIAnswerCounts.set(doc,checkpoint.answerCount);persistedSummaryJobs.set(doc,checkpoint.summarySignature);
}
let mediaWorkerReady = false;
let readingMode = "summary";
let demoToolsExpanded=false;
const PASSAGES_PER_PAGE=8;
let passageDocumentKey=null,passageAnchor=null,passagePageStart=0,passageReturn=null;
let passageTranslations=true,mediaExpandedKey=null,passagePlayback=null;
let noticeTimer=null,readingSettingsPriorOpen=null,headerDocumentKey=null,mediaCollapsedKey=null;
function prefersPassageReading(doc){return !Coconut.isAudioProject(doc)&&doc?.provenance?.kind!=='authored_demo'&&doc?.segments.length>=12;}
const browserMedia = new Map();
const mediaSelectionRevisions = new Map();
function mediaSelectionRevision(key){return mediaSelectionRevisions.get(key)||0;}
function changeMediaSelection(key,notify=true){const revision=mediaSelectionRevision(key)+1;mediaSelectionRevisions.set(key,revision);if(notify)window.dispatchEvent(new CustomEvent('coconut-media-selection-change',{detail:{key}}));return revision;}
let pendingMediaDocument = null;
const PLAYBACK_RATES=[0.75,1,1.25,1.5,1.75,2];
let playbackRate=1;
let repeating=null;
let dockFramePending=false;
let playbackIndex=null;
// Range metadata belongs to the rendered button and expires with that render.
const renderedPassageRanges=new WeakMap();
try {const saved=Number(localStorage.getItem("coconut-playback-rate-v1"));if(PLAYBACK_RATES.includes(saved))playbackRate=saved;}catch{}

// A draft never changes ordinary playback until Save. Preview owns a temporary
// physical-media range, reusing passage playback's cancellation/return semantics.
let timingEditor=null,timingRevision=0,timingPreview=null;
function timingAttachment(){const a=browserMedia.get(active()?.key);return a?.origin==='local'&&a.identity?a:null;}
function timingOffset(){return Coconut.mediaTimingOffset(active(),timingAttachment()?.identity);}
function timingRange(range,offset=timingOffset()){return Coconut.mediaTimingRange(range,offset,$('source-media').querySelector('audio,video')?.duration);}
function timingDraft(){const raw=$('media-timing-offset').value;const value=Number(raw);return raw.trim()&&Number.isFinite(value)&&Math.abs(value)<=3600?Math.round(value*1000)/1000:null;}
function timingCue(){const index=Number($('media-timing-cue').value);return Number.isInteger(index)&&index>=1?active()?.segments[index-1]:undefined;}
function timingExample(){const cue=timingCue(),offset=timingDraft();$('media-timing-example').textContent=cue&&offset!==null?'第 '+$('media-timing-cue').value+' 段 · 字幕 '+Coconut.time(cue.start)+' → 媒体 '+(cue.start+offset<0?'小于 00:00':Coconut.time(cue.start+offset))+' · '+cue.text.slice(0,100):'请选择有效片段和偏移。';}
function renderMediaTiming(){
 const doc=active(),attachment=timingAttachment(),host=$('media-timing');
 host.hidden=!attachment||!doc?.segments.length;
 if(host.hidden){timingEditor=null;return;}
 if(timingEditor?.doc!==doc||timingEditor.attachment!==attachment){
  timingEditor={doc,attachment};timingRevision++;timingPreview=null;
  $('media-timing-offset').value=String(timingOffset());
  $('media-timing-cue').max=String(doc.segments.length);$('media-timing-cue').value='1';timingExample();
  $('media-timing-status').textContent=doc.media_timing&&doc.media_timing.identity!==attachment.identity?'此文件与已保存的校准不同，当前按零偏移回听。':'当前偏移 '+timingOffset()+' 秒；修改后可先试听，再保存。';
 }
}
function timingChanged(){timingExample();timingRevision++;$('media-timing-status').textContent='尚未保存；普通回听仍使用已保存的偏移。';}
$('media-timing-offset').oninput=timingChanged;
$('media-timing-cue').oninput=timingChanged;
$('media-timing-reset').onclick=()=>{$('media-timing-offset').value='0';timingChanged();};
$('media-timing-align').onclick=()=>{
 const cue=timingCue(),player=$('source-media').querySelector('audio,video');if(!cue||!player||!Number.isFinite(player.duration))return;
 const offset=Math.round((player.currentTime-cue.start)*1000)/1000;
 if(Math.abs(offset)>3600){$('media-timing-status').textContent='偏移必须在正负 3600 秒内。';return;}
 $('media-timing-offset').value=String(offset);timingChanged();
};
$('media-timing-preview').onclick=()=>{
 const offset=timingDraft(),cue=timingCue(),range=offset===null?null:timingRange(cue,offset);
 if(!range){$('media-timing-status').textContent='无法试听：偏移须在正负 3600 秒内，整个片段须位于媒体时长内。';return;}
 stopRepeating();timingPreview={offset,doc:active(),attachment:timingAttachment()};
 passagePlayback.listen({...range,id:'media-timing-preview',label:'校准试听 · '+Coconut.time(cue.start)});
};
$('media-timing-return').onclick=()=>passagePlayback?.returnToPrevious();
$('media-timing-save').onclick=async()=>{
 const editor=timingEditor,offset=timingDraft();
 if(!editor||editor.doc!==active()||editor.attachment!==timingAttachment()||!contentIngressAllowed(editor.doc))return;
 if(offset===null){$('media-timing-status').textContent='请输入正负 3600 秒内的偏移。';return;}
 if(passagePlayback?.getState().range?.id==='media-timing-preview')$('source-media').querySelector('audio,video')?.pause();
 passagePlayback?.cancel();stopRepeating();timingPreview=null;
 editor.doc.media_timing={version:1,identity:editor.attachment.identity,offset};
 const revision=++timingRevision;const receipt=commitDocument(editor.doc);
 $('media-timing-status').textContent='对齐已在本页应用，正在保存…';highlightPlayback();renderPassagePlayback(passagePlayback?.getState());
 const result=await receipt;
 if(timingEditor!==editor||revision!==timingRevision||active()!==editor.doc||timingAttachment()!==editor.attachment)return;
 $('media-timing-status').textContent=result.ok?'已保存偏移 '+offset+' 秒；重新选择同一文件后继续应用。':'对齐仅在本页应用，保存失败；请重试保存或导出 JSON 备份。';
};

// Resume state is deliberately separate from transcript/reading bookmarks.
let listeningSession=null;
function listeningStatus(text=''){$('listening-progress-status').textContent=text;}
async function fingerprintMedia(file){
 if(!globalThis.crypto?.subtle||typeof file.slice(0,1).arrayBuffer!=='function')return null;
 // Three bounded 64 KiB samples plus metadata are a candidate match, not a
 // full-file integrity proof. Even a match requires an explicit resume click.
 const size=64*1024,offsets=[...new Set([0,Math.max(0,Math.floor((file.size-size)/2)),Math.max(0,file.size-size)])];
 const samples=[];
 for(const offset of offsets){
  const bytes=await file.slice(offset,offset+size).arrayBuffer();
  samples.push(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join(''));
 }
 return 'file-candidate-v1:'+JSON.stringify([file.name,file.size,file.lastModified,file.type,offsets,samples]);
}
// A reselected document can reuse its player and source while retiring the
// earlier navigation's playback request. Error guidance follows that lifetime.
function playbackErrorOwner(player,doc=active()){
 const source=player.getAttribute('src'),attachment=browserMedia.get(doc?.key),selection=activeSelectionRevision;
 return ()=>active()===doc&&activeSelectionRevision===selection&&$('source-media').querySelector('audio,video')===player&&player.getAttribute('src')===source&&browserMedia.get(doc?.key)===attachment;
}
function takeListeningOwnership(){if(listeningSession){listeningSession.preview=false;listeningSession.engaged=true;}}
function listeningPreview(){return passagePlayback?.getState();}
function renderListeningResume(){
 const s=listeningSession,button=$('resume-listening');
 const valid=s&&s.record&&s.record.identity===s.identity&&Number.isFinite(s.player.duration)&&s.player.duration>=15&&
  Math.abs(s.record.duration-s.player.duration)<1&&s.record.time>=5&&s.record.time<s.player.duration-3;
 button.hidden=!valid;
 if(valid){button.textContent='继续收听 '+Coconut.time(s.record.time)+' · 仅定位';button.title=s.identity.startsWith('file-candidate')?'文件信息、部分内容及媒体时长与上次匹配；请核对原声，点击后仅定位。':'点击后仅定位，不自动播放。';}
}
function flushListening(force=false){
 const s=listeningSession;if(!s||!s.identity||s.blocked||readerClosing)return;
 const preview=listeningPreview();
 if(preview?.range){s.preview=true;return;}
 if(s.preview||!s.engaged||!Number.isFinite(s.player.duration)||s.player.duration<15||s.player.seeking)return;
 const time=s.player.currentTime;if(!Number.isFinite(time)||time<0)return;
 if(!force&&Date.now()-s.savedAt<5000)return;
 const record={version:1,identity:s.identity,time:time>=s.player.duration-3||time<5?0:time,duration:s.player.duration};
 const value=JSON.stringify(record);if(value===s.raw)return;
 s.savedAt=Date.now();
 try{
  if(localStorage.getItem(s.key)!==s.raw){s.blocked=true;throw new Error('changed');}
  localStorage.setItem(s.key,value);s.raw=value;s.record=record;s.savedAt=Date.now();listeningStatus('');renderListeningResume();
 }catch{listeningStatus(s.blocked?'另一个页面更新了收听进度，本页已暂停保存；刷新后读取。':'收听进度未能保存；'+(s.raw?'上次已保存的位置仍保留。':'本次还没有已保存的位置。')+'本次位置 '+Coconut.time(time)+'。');}
}
function bindListening(player,doc,attachment){
 const identity=attachment?attachment.identity:doc.source_media?'job-v1:'+JSON.stringify(doc.source_media):null;
 const s={player,identity,key:'coconut-listening-v1:'+doc.key,raw:null,record:null,engaged:false,preview:false,savedAt:0,blocked:false};
 listeningSession=s;listeningStatus('');
 try{
  s.raw=localStorage.getItem(s.key);
  if(s.raw){const r=JSON.parse(s.raw);if(r?.version!==1||typeof r.identity!=='string'||!Number.isFinite(r.time)||!Number.isFinite(r.duration)||r.time<0||r.duration<=0)throw new Error('invalid');s.record=r;}
 }catch{s.blocked=true;listeningStatus('已保存的收听进度无法读取，原记录未覆盖。');}
 if(!identity)listeningStatus('无法核验此文件内容，本次不保存收听进度。');
 const current=()=>listeningSession===s;
 player.addEventListener('play',()=>{
  if(!current())return;const preview=listeningPreview();
  if(preview?.range&&!['finished','error'].includes(preview.status)){s.preview=true;return;}
  s.preview=false;s.engaged=true;
 });
 player.addEventListener('seeking',()=>{if(current()&&!listeningPreview()?.range){if(!s.preview||Math.abs(player.currentTime-s.previewStoppedAt)>.03){s.preview=false;s.engaged=true;}}});
 for(const event of ['pause','seeked','ended'])player.addEventListener(event,()=>{if(current())flushListening(true);});
 player.addEventListener('timeupdate',()=>{if(current())flushListening();});
 for(const event of ['loadedmetadata','durationchange'])player.addEventListener(event,()=>{if(current())renderListeningResume();});
 renderListeningResume();
}
window.addEventListener('pagehide',()=>flushListening(true));
window.addEventListener('visibilitychange',()=>{if(document.hidden)flushListening(true);});

function saveWarning(text = "") { renderSaveStatus(libraryStore.status(),text); }
function renderSaveStatus(snapshot,detail='') {
 const failure=snapshot.documents.find(item=>item.status!=='saved'&&item.status!=='pending')?.error||libraryAdapter.status?.().error;
 storageBlocked=!libraryLoad.ok||['conflict','fenced','unreadable','version','unavailable','legacy-changed','corruption'].includes(failure?.code);
 const reasons={version:'存储版本已改变，请先导出修改，再刷新读取',unavailable:'文档数据库连接已中断，请先导出修改，再刷新重试',corruption:'原有存储记录无法完整核验，原数据仍保留', 'legacy-changed':'旧版页面修改了原书架，请先导出修改与原数据，再重新载入',quota:'浏览器保存空间不足',denied:'浏览器禁止了保存',conflict:'另一个页面更新了书架，先备份本页修改，再刷新读取',fenced:'存储版本已改变，先备份本页修改，再刷新读取',unreadable:'原有数据无法读取，已保留原数据',cancelled:'保存已取消，内容仍在本页',identity:'文档身份已改变，当前修改尚未保存'};
 const failed=snapshot.status!=='saved'&&snapshot.status!=='pending';
 $('save-status').hidden=false;$('save-status').dataset.state=storageBlocked||failed?'failed':snapshot.status;
 const message=detail||(storageBlocked&&!snapshot.unsaved?(reasons[failure?.code]||'原有数据无法读取，已保留原数据')+'。本次导入或修改请另存备份。':snapshot.status==='saved'?(libraryAdapter.backend==='indexeddb'?'已保存到本机文档数据库':'已保存到本机浏览器（兼容存储，容量较小）'):snapshot.status==='pending'?'正在保存 · '+snapshot.unsaved+' 份文档':(reasons[failure?.code]||'浏览器保存未成功')+'。'+snapshot.unsaved+' 份文档仍在本页，请重试或导出未保存文档备份。');
 const warning=storageBlocked||failed;
 const statusText=warning?message:snapshot.status==='pending'?'保存中':'已保存';
 if($('save-status').textContent!==statusText)$('save-status').textContent=statusText;
 if($('save-status').title!==message)$('save-status').title=message;
 if($('save-status').getAttribute('aria-label')!==message)$('save-status').setAttribute('aria-label',message);
 const panel=$('save-status').closest('.save-pipeline'),host=$(warning?'save-warning-home':'save-status-home');
 // Never move or hide a focused recovery action when a receipt arrives.
 // Its truthful status updates immediately; compacting waits until focus leaves.
 const focused=document.activeElement,retainRecovery=panel.contains(focused);
 if(panel.parentElement!==host&&!retainRecovery)host.append(panel);
 panel.classList.toggle('has-warning',warning||panel.parentElement===$('save-warning-home'));
 $('retry-save').hidden=(!snapshot.unsaved||snapshot.status==='pending')&&focused!==$('retry-save');
 $('retry-save').disabled=snapshot.blocked&&focused!==$('retry-save');
 $('retry-save').setAttribute('aria-disabled',String(snapshot.blocked||snapshot.status==='pending'||!snapshot.unsaved));
 $('export-unsaved-documents').hidden=(!snapshot.unsaved||!warning)&&focused!==$('export-unsaved-documents');
 $('pending-export').hidden=!snapshot.unsaved&&!$('pending-export').contains(focused);
 $('export-pending-library').hidden=!snapshot.unsaved&&focused!==$('export-pending-library');
 if(unloadGuardReady)syncUnsavedUnloadGuard();
}
function notice(text,kind = "") {
 if(noticeTimer!==null){clearTimeout(noticeTimer);noticeTimer=null;}
 const success=!!text&&kind==='success';
 $("notice").dataset.kind=success?'success':'';
 $("notice").hidden=!text;$("notice").textContent=text;
 $('notice-shell').classList.toggle('is-success',success);
 const host=success?$('reading-feedback'):$('notice-home');
 if($('notice-shell').parentElement!==host)host.append($('notice-shell'));
 $('dismiss-notice').hidden=!success;
 if(success)noticeTimer=setTimeout(()=>{noticeTimer=null;if($('notice').dataset.kind==='success'&&!$('notice-shell').contains(document.activeElement))notice('');},5000);
}
$('dismiss-notice').onclick=()=>{notice('');$('main-content').focus({preventScroll:true});};
window.addEventListener('coconut-storage-export',event=>notice(event.detail.text));

// The adapter is the only content writer. It retains the exact unreadable raw
// value and never rebases over content another window wrote.
const libraryAdapter=window.CoconutStorageBootstrap?.result?.adapter||CoconutLibraryStore.createLegacyAdapter({getStorage:()=>localStorage,validate:Coconut.validate});
const libraryLoad=window.CoconutStorageBootstrap?.result?.loaded||libraryAdapter.load();
// Direct embedding without the asynchronous bootstrap uses the legacy adapter.
if(!window.CoconutStorageBootstrap){$('storage-startup').hidden=true;document.querySelector('.shell').inert=false;}
state={documents:libraryLoad.documents,active:libraryLoad.active};
if(libraryLoad.ok)for(const doc of state.documents)recordPersistenceCheckpoint(doc,persistenceCheckpoint(doc));
else notice('上次保存的数据无法读取，已停止写入以保留原数据。本次内容可继续阅读，请导出备份后再关闭页面。');
const libraryStore=CoconutLibraryStore.create({adapter:libraryAdapter,getDocuments:()=>state.documents,checkpoint:persistenceCheckpoint});
let libraryContentRevision=0;
libraryStore.subscribe((snapshot,event)=>{
 libraryContentRevision=snapshot.generation;
 if(event?.result?.ok)for(const captured of event.result.checkpoints)recordPersistenceCheckpoint(captured.identity,captured.checkpoint);
 if(event?.type==='release')resumeDeferredContentInputs();
 renderSaveStatus(libraryStore.status());
 if(event?.type==='commit'){
  renderSummaryPersistence();
  window.dispatchEvent(new CustomEvent('coconut-persistence-change',{detail:event.result}));
 }
});
libraryAdapter.subscribe?.(()=>renderSaveStatus(libraryStore.status()));
function contentIngressAllowed(doc=null){
 return (!window.CoconutStorageBootstrap||window.CoconutStorageBootstrap.phase==='ready')&&!readerClosing&&!libraryStore.status().blocked&&(!doc||state.documents.includes(doc)&&!pendingStructuralDocuments.has(doc.key));
}
// Native final flush temporarily disables interaction. Retain an already queued
// input/IME event rather than silently dropping its text at the ingress barrier.
function deferContentInput(doc,input,previous,apply){
 if(contentIngressAllowed(doc)){deferredContentInputs.delete(input);return false;}
 if(!readerClosing&&libraryStore.status().blocked&&state.documents.includes(doc)&&!pendingStructuralDocuments.has(doc.key)){
  if(input.value!==previous)deferredContentInputs.set(input,{doc,value:input.value,apply});else deferredContentInputs.delete(input);
 }
 return true;
}
function resumeDeferredContentInputs(){
 const drafts=[...deferredContentInputs];deferredContentInputs.clear();
 for(const [input,draft] of drafts){
  if(contentIngressAllowed(draft.doc))draft.apply(draft.value);
  else if(state.documents.includes(draft.doc))deferredContentInputs.set(input,draft);
 }
}
function rejectedContentReceipt(doc){return {accepted:false,key:doc?.key,identity:doc,generation:libraryStore.status().generation,committed:Promise.resolve({ok:false,status:'cancelled',identity:doc})};}
function queueDocument(doc,kind='update',options={}){
 if(!contentIngressAllowed(kind==='remove'?null:doc))return rejectedContentReceipt(doc);
 return libraryStore.queueDocument(doc.key,doc,kind,options);
}
async function commitDocument(doc,kind='update',options={}){
 const ticket=queueDocument(doc,kind,options);if(ticket.accepted)void libraryStore.flush();return ticket.committed;
}
async function commitDocuments(documents){
 if(!contentIngressAllowed()||documents.some(doc=>!contentIngressAllowed(doc)))return {ok:false,status:'cancelled'};
 const batch=libraryStore.queueDocuments(documents.map(identity=>({key:identity.key,identity})));
 if(batch.accepted)void libraryStore.flush();
 const results=await Promise.all(batch.tickets.map(ticket=>ticket.committed));return {ok:batch.accepted&&results.every(result=>result.ok),results};
}
document.addEventListener('focusout',event=>{
 if(event.target.closest?.('.save-pipeline, #pending-export, #export-pending-library'))queueMicrotask(()=>renderSaveStatus(libraryStore.status()));
});
$('retry-save').onclick=async()=>{if(libraryStore.status().blocked||libraryStore.status().status==='pending'||!libraryStore.status().unsaved)return;const result=await libraryStore.retry();if(result.ok&&!libraryStore.status().unsaved&&!readerClosing)notice('本页待保存修改已保存到本机浏览器。','success');};
$('export-unsaved-documents').onclick=$('export-pending-documents').onclick=$('export-pending-library').onclick=()=>{
 let url,link;
 try{
  const snapshot=libraryStore.snapshotForExport();
  if(!snapshot.documents.length){notice('没有待保存文档。未提交表单草稿和移除恢复区仍仅在本页，请分别处理；可从导出菜单备份文字稿与笔记。');return;}
  const backup={format:'coconut-library',version:1,documents:snapshot.documents,active:state.active};
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
  url=URL.createObjectURL(blob);link=el('a');link.href=url;link.download='coconut-unsaved-documents.json';link.hidden=true;document.body.append(link);link.click();
  notice('已发起 '+snapshot.documents.length+' 份未保存文档的完整备份下载，请打开文件确认。包含文字、笔记、译文与 AI 历史；未提交表单草稿和移除恢复区仍仅在本页，请分别处理。下载不会改变保存状态。'+backupRecoveryHint(blob));
 }catch{notice('未保存文档备份失败，完整内容仍在本页，请重试。');}
 finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);}
};
window.addEventListener('pagehide',()=>{void libraryStore.flush();});
window.addEventListener('visibilitychange',()=>{if(document.hidden)void libraryStore.flush();});
renderSaveStatus(libraryStore.status());
// Selection belongs to this window. The small shared hint is only a default
// for a new window; neither preference is part of content conflict detection.
// Old libraries remain a fallback, and JSON backups explicitly include active.
function rememberActiveDocument() {
 try {
  if(state.active===null)sessionStorage.removeItem(ACTIVE_KEY);
  else sessionStorage.setItem(ACTIVE_KEY,state.active);
 } catch { /* Reading and content saves still work when session storage is denied. */ }
 try {
  if(state.active===null)localStorage.removeItem(LAST_ACTIVE_KEY);
  else localStorage.setItem(LAST_ACTIVE_KEY,state.active);
 } catch { /* A preference failure is not a failed document save. */ }
}
let activeSelectionRevision=0;
function selectActiveDocument(key,{persist=true}={}) {
 activeSelectionRevision++;
 const available=doc=>!pendingStructuralDocuments.has(doc.key);
 state.active=state.documents.some(doc=>doc.key===key&&available(doc))?key:state.documents.find(available)?.key||null;
 if(persist)rememberActiveDocument();
}
let windowActive=null,lastActive=null;
try { windowActive=sessionStorage.getItem(ACTIVE_KEY); } catch {}
try { lastActive=localStorage.getItem(LAST_ACTIVE_KEY); } catch {}
selectActiveDocument([windowActive,lastActive,state.active].find(key=>state.documents.some(doc=>doc.key===key)));
function active() {
	return state.documents.find((d) => d.key === state.active);
}
function el(tag, className, text) {
	const n = document.createElement(tag);
	if (className) n.className = className;
	if (text !== undefined) n.textContent = text;
	return n;
}
async function add(doc, canCommit = null, reuseAudioSource = false, lifecycleRevision = documentLifecycleRevision, sourceKey = doc.key, {target = null, separate = false, activate = true, canActivate = null} = {}) {
 if(!contentIngressAllowed())throw new Error("导入已取消，书架未改变");
	const bytes = new TextEncoder().encode(JSON.stringify(doc));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	let key = Array.from(new Uint8Array(digest))
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("");
 if(!contentIngressAllowed() || await wasRemovedSince(doc,lifecycleRevision,key) || (removedDocumentRevisions.get(sourceKey)||0)>lifecycleRevision || canCommit && !canCommit())throw new Error("导入已取消，书架未改变");
 // A repeated source save refreshes recoverable source metadata, preserving
 // user-owned title, language, notes, bookmark IDs and the stable library key.
 const identity=reuseAudioSource?Coconut.audioProjectIdentity(doc):'';
 if(separate)key=crypto.randomUUID();
 // Match the complete validated backup, just like whole-library restore. The
 // original hash remains the first choice when reopening an unedited source;
 // otherwise an exported edited snapshot should reuse the same library entry.
 if(!identity&&!separate&&!state.documents.some(d=>d.key===key)){
  const fingerprint=JSON.stringify(Coconut.validate(doc));
  const matching=state.documents.find(d=>JSON.stringify(Coconut.validate(d))===fingerprint);
  if(matching)key=matching.key;
 }
 const matches=identity?state.documents.filter(d=>Coconut.audioProjectIdentity(d)===identity):[];
 if(identity&&!target&&matches.length>1)throw new Error('本集有多个书架版本，请明确选择目标项目或单独导入');
 const existing=target?state.documents.find(d=>d.key===target.key):matches[0];
 if(target&&(existing!==target.document||JSON.stringify(existing?.podcast_source)!==target.source||Coconut.audioProjectIdentity(existing)!==identity))throw new Error('目标项目已经更新，请重新选择');
 if(!contentIngressAllowed()||pendingStructuralDocuments.has(existing?.key||key))throw new Error('这份文档正在移除或恢复，请稍候再导入');
 if(existing)key=existing.key;
 if(existing&&Coconut.isAudioProject(existing)){
  const mediaChanged=existing.podcast_source.media_url!==doc.podcast_source.media_url||existing.podcast_source.media_kind!==doc.podcast_source.media_kind;
  existing.podcast_source=doc.podcast_source;existing.source_url=doc.source_url;existing.transcript_status=doc.transcript_status;
  if(doc.media_duration!==undefined)existing.media_duration=doc.media_duration;else delete existing.media_duration;
  if(mediaChanged){
   changeMediaSelection(key);
   const attachment=browserMedia.get(key);
   if(attachment?.origin==='publisher'){
    if(active()?.key===key){stopRepeating();$('source-media').querySelector('audio,video')?.pause();}
    browserMedia.delete(key);URL.revokeObjectURL(attachment.url);
   }
  }
 }
 const duplicate=state.documents.some(d=>d.key===key);
	if (!duplicate)state.documents.push({ ...doc, key, notes: doc.notes || {} });
 // A requested import can finish saving without taking over newer navigation.
 // Evaluate ownership here, after every asynchronous admission check.
 if(!activate || canActivate && !canActivate()){
  const inserted=state.documents.find(d=>d.key===key),receipt=commitDocument(inserted);
  renderLibrary();
  return {...await receipt,duplicate};
 }
	selectActiveDocument(key);
 passageReturn=null;passageDocumentKey=key;passageAnchor=active()?.segments[0]?.id||null;mediaExpandedKey=null;
 setReadingMode(prefersPassageReading(active())?"passages":"summary");
 searchFocusedId=null;
	$("search").value = "";
	selected = null;
	pageStart = 0;
	notesOnly = false; excerptsOnly = false; speakerFilter=null;
	workspace = "read";
	const inserted=active(),mediaRevision=mediaSelectionRevision(key),selectionRevision=activeSelectionRevision,receipt=commitDocument(inserted);
	render();
	return {...await receipt,mediaRevision,selectionRevision};
}
function showWorkspace(next) {
 if(next!==workspace)cancelLocalImports();
 if(next!=="read"){clearReadingContext();passageReturn=null;passagePlayback?.cancel();}
 if(next!==workspace)window.dispatchEvent(new CustomEvent("coconut-workspace-change",{detail:{workspace:next}}));
 if(next!=="read"&&typeof closeSummaryRequest==="function")closeSummaryRequest(false);
 if(next!=="add")$("podcast-results")?.querySelectorAll("audio,video").forEach(player=>player.pause());
 if(next!=="read"){stopRepeating();$("source-media").querySelectorAll("audio,video").forEach(player=>player.pause());}
	if (workspace === "read" && next === "add") readingScroll = window.scrollY;
	const returning = workspace === "add" && next === "read";
	workspace = next;
	$("add-workspace").hidden = next !== "add";
	$("reader-workspace").hidden = next !== "read" || !active();
	$("back-reading").hidden = next !== "add" || !active();
	$("export").hidden = next !== "read" || !active();
 $("export-menu").hidden = next !== "read" || !active();
 document.body.dataset.workspace = next;
 $("count").textContent = next === "add" ? "你的内容，从这里开始" : active() ? "书架 / " + active().title : "阅读空间";
 if (next !== "read") $("export-menu").open = false;
	$("add-content").setAttribute("aria-pressed", String(next === "add"));
 composeReadingHeader();
	if (returning) window.scrollTo(0, readingScroll);
 refreshPlaybackDock();
}
function clearReadingContext() {
 readingContext=null;
 $('reading-context').hidden=true;
 document.querySelectorAll('.context-target').forEach(row=>row.classList.remove('context-target'));
}
function renderReadingContext() {
 if(readingContext?.document!==active())readingContext=null;
 const origin=readingContext,bar=$('reading-context');
 // Move the one existing landmark, retaining its handlers and accessible IDs.
 if(origin&&readingMode==='passages'){if(bar.nextElementSibling!==$('passage-workspace'))$('passage-workspace').before(bar);}
 else if(readingContextHome.nextSibling!==bar)readingContextHome.after(bar);
 $('reading-context').hidden=!origin||workspace!=='read'||readingMode==='summary';
 if(origin)$('reading-context-label').textContent=origin.label+' · 第 '+(origin.index+1)+' / '+origin.count+' 个结果';
}
function captureReadingContext(id) {
 const doc=active(),query=$('search').value;
 if(!doc||(!query.trim()&&!notesOnly&&!excerptsOnly&&speakerFilter===null))return;
 const matches=doc.segments.filter(s=>matchesReadingSegment(s,doc,query.trim().toLocaleLowerCase()));
 const index=matches.findIndex(s=>s.id===id);if(index<0)return;
 const row=[...$('transcript').querySelectorAll('.segment')].find(node=>node.dataset.segmentId===id);
 const labels=[query.trim()?'搜索“'+query.trim()+'”':'',excerptsOnly?'摘录':'',notesOnly?'笔记':'',speakerFilter!==null?'说话人：'+(speakerFilter||'未标注'):''].filter(Boolean);
 readingContext={key:doc.key,document:doc,id,index,count:matches.length,label:labels.join(' · '),query,notesOnly,excerptsOnly,speakerFilter,pageStart,translationView:doc.translation_view||'',viewportTop:row?.getBoundingClientRect().top};
 $('ai-consent').checked=false;
 return true;
}
function openReadingContext(id) {
 if(captureReadingContext(id))goToSegment(id,true);
}
function returnReadingResults() {
 const origin=readingContext,doc=active();clearReadingContext();
 if(!origin||doc!==origin.document)return;
 passageReturn=null;
 $('search').value=origin.query;notesOnly=origin.notesOnly;excerptsOnly=origin.excerptsOnly;speakerFilter=origin.speakerFilter;
 // Display choice can change during the detour; restore the original view without
 // reverting source edits, annotations, or the user's explicit reading bookmark.
 if(contentIngressAllowed(doc)&&(doc.translation_view||'')!==origin.translationView){doc.translation_view=origin.translationView;queueDocument(doc);}
 readingMode='transcript';selected=null;
 const matches=doc.segments.filter(s=>matchesReadingSegment(s,doc,origin.query.trim().toLocaleLowerCase()));
 const exact=matches.findIndex(s=>s.id===origin.id);
 const index=exact>=0?exact:Math.min(origin.index,matches.length-1);
 const target=matches[index];
 pageStart=index>=0?Math.floor(index/PAGE_SIZE)*PAGE_SIZE:0;
 searchFocusedId=origin.query.trim()?target?.id||null:null;
 $('ai-consent').checked=false;
 render();
 const row=[...$('transcript').querySelectorAll('.segment')].find(node=>node.dataset.segmentId===target?.id);
 if(row){
  if(exact>=0&&Number.isFinite(origin.viewportTop))window.scrollBy(0,row.getBoundingClientRect().top-origin.viewportTop);
  else row.scrollIntoView?.({block:'center'});
  (row.querySelector('.context-button')||row).focus({preventScroll:true});
 }else $('search').focus();
 if(exact<0)notice(target?'原片段已不在筛选结果中，已返回相邻结果。':'原筛选已没有匹配片段；可调整筛选继续阅读。');
}
$('return-reading-results').onclick=returnReadingResults;
$('dismiss-reading-context').onclick=()=>{
 const id=readingContext?.id;clearReadingContext();
 if(readingMode==='passages'){
  const cue=[...$('passage-body').querySelectorAll('.passage-cue')].find(node=>node.dataset.cueId===id);
  (cue?.closest('.passage')||$('passage-body').querySelector('.passage')||$('mode-passages')).focus({preventScroll:true});
 }else{
  const row=[...$('transcript').querySelectorAll('.segment')].find(node=>node.dataset.segmentId===id);
  (row||$('search')).focus({preventScroll:true});
 }
};
function goToSegment(id,contextDetour=false,preservePassageReturn=false) {
 if(!preservePassageReturn)passageReturn=null;
 if(readingMode==='summary'||!$('summary-request').hidden||$('ai-task').value==='summary')closeSummaryRequest(false);
 readingMode = "transcript";
	const doc = active();
	const index = doc ? doc.segments.findIndex(s => s.id === id) : -1;
	if (index < 0) return;
	$("search").value = "";
	notesOnly = false; excerptsOnly = false; speakerFilter=null;
	selected = null;
	pageStart = contextDetour ? Math.max(0,Math.min(index-3,doc.segments.length-PAGE_SIZE)) : Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
	showWorkspace("read");
	render();
	const row = [...$("transcript").querySelectorAll(".segment")].find(row => row.dataset.segmentId === id);
 // Center ordinary cues, but show the opening of a cue taller than the viewport.
 const alignment = row && row.getBoundingClientRect().height > (window.visualViewport?.height || window.innerHeight) ? "start" : "center";
	// A context detour can cross most of a 100-cue page. Land immediately so
 // the requested evidence is readable instead of animating past the AI tools.
 row?.scrollIntoView?.({block: alignment, behavior: contextDetour ? "auto" : "smooth"});
	row?.focus({preventScroll: true});
}
// Ordinary library navigation, active removal, and active undo share ownership teardown.
function resetReaderForDocumentNavigation(){
 if(typeof closePassageQuestion==='function')closePassageQuestion();
 // Flush while the old player owns its own key. Preview clocks never become
 // the main position, and a same-URL destination still gets new ownership.
 flushListening(true);
 cancelLocalImports();passagePlayback?.cancel();stopRepeating();
 $('source-media').querySelectorAll('audio,video').forEach(player=>player.pause());
 closeSummaryRequest(false);clearReadingContext();
 selected=null;pageStart=0;notesOnly=false;excerptsOnly=false;speakerFilter=null;
 passageReturn=null;passageDocumentKey=null;searchFocusedId=null;$('search').value='';
}
function focusLibraryRemoval(key) {
 if(key)renderLibrary(key);
 const row=[...$('library').children].find(node=>node.dataset.documentKey===key);
 // Undo can run with the mobile shelf or its organizing controls collapsed.
 // Restore focus to an available action, never a hidden removal button.
 $('toggle-library').setAttribute('aria-expanded','true');
 (row?.querySelector($('library-options').open?'.library-remove':'.library-open')||$('library-search')).focus();
}
function removalDialogMayRestoreFocus(dialog,opener) {
 const focused=document.activeElement;
 return !focused||focused===document.body||focused===opener||dialog.contains(focused);
}
function syncLibraryRemovalControls() {
 for(const button of $('library').querySelectorAll('.library-remove'))button.hidden=!$('library-options').open;
}
$('library-options').addEventListener('toggle',syncLibraryRemovalControls);
function renderRemovalRecovery() {
 $('undo-removal').disabled=!!pendingLibraryOperation;$('finish-removal').disabled=!!pendingLibraryOperation;
 $('removal-recovery').hidden=!removedDocument;
 $('removal-recovery-title').textContent=removedDocument?'已移除：'+removedDocument.doc.title:'';
 $('removal-recovery-short-title').textContent=removedDocument?removedDocument.doc.title:'';
 if(!removedDocument){$('removal-recovery-details').open=false;$('removal-recovery-error').hidden=true;$('removal-export-error').hidden=true;}
 if(unloadGuardReady)syncUnsavedUnloadGuard();
}
function showRemovalRecoveryError(message) {
 $('removal-recovery-error').textContent=message;
 $('removal-recovery-error').hidden=false;
 $('removal-recovery-details').open=true;
}
function requestLibraryRemoval(doc) {
 if(!contentIngressAllowed(doc)||pendingLibraryOperation)return;
 removalTarget=doc;removalDialogOrigin={doc,node:document.activeElement,recovery:removedDocument,confirmed:false};
 $('remove-document-title').textContent=doc.title;
 $('remove-document-error').textContent='';delete $('remove-document-error').dataset.kind;
 $('replace-removal-warning').hidden=!removedDocument;
 $('replace-removal-warning').textContent=removedDocument?'继续移除将结束上一篇“'+removedDocument.doc.title+'”的撤销，且不再保留它的本页副本。可取消，或先导出上一篇备份。':'';
 $('export-previous-removal').hidden=!removedDocument;
 $('remove-document-dialog').showModal();$('cancel-removal').focus();
}
$('cancel-removal').onclick=()=>{$('remove-document-dialog').close();};
$('remove-document-dialog').addEventListener('close',()=>{
 const dialog=$('remove-document-dialog');
 if(dialog.open)return; // A queued close must not retire a newer confirmation.
 const origin=removalDialogOrigin;removalDialogOrigin=null;if(!origin)return;
 if(removalTarget===origin.doc)removalTarget=null;
 // Confirmation closes before the writer settles. Its receipt alone owns
 // success focus; a queued close must never focus the previous recovery bundle.
 if(origin.confirmed||pendingLibraryOperation)return;
 if(origin.recovery!==removedDocument||!removalDialogMayRestoreFocus(dialog,origin.node))return;
 if(state.documents.includes(origin.doc))focusLibraryRemoval(origin.doc.key);
});
function finishStructuralOperation(operation){
 if(pendingStructuralDocuments.get(operation.key)===operation)pendingStructuralDocuments.delete(operation.key);
 if(pendingLibraryOperation===operation)pendingLibraryOperation=null;
}
function restoreRemovedDrafts(bundle){
 if(bundle.bookmarkDraft)audioBookmarkDrafts.set(bundle.doc.key,bundle.bookmarkDraft);
 window.dispatchEvent(new CustomEvent('coconut-document-restored',{detail:{...bundle,key:bundle.doc.key}}));
}
$('confirm-removal').onclick=async()=>{
 const doc=removalTarget;if(!doc||!contentIngressAllowed(doc)||pendingLibraryOperation)return;
 captureAudioBookmarkDrafts();
 const index=state.documents.indexOf(doc),wasActive=active()===doc;
 const bundle={doc:JSON.parse(JSON.stringify(doc)),index,wasActive,bookmarkDraft:audioBookmarkDrafts.get(doc.key)};
 const operation={key:doc.key,identity:doc,bundle,selectionRevision:null};
 pendingLibraryOperation=operation;pendingStructuralDocuments.set(doc.key,operation);
 // Retire request owners immediately, but keep the previous one-slot backup
 // until this deletion has a successful disk receipt.
 documentLifecycleRevision++;removedDocumentRevisions.set(doc.key,documentLifecycleRevision);
 removedDocumentAliases.push({revision:documentLifecycleRevision,source:documentSourceIdentity(bundle.doc),signature:libraryDocumentSignature(bundle.doc).catch(()=>null)});
 window.dispatchEvent(new CustomEvent('coconut-document-retiring',{detail:{key:doc.key,bundle}}));
 changeMediaSelection(doc.key);if(projectTranscriptTarget?.key===doc.key)projectTranscriptTarget=null;
 if(wasActive)resetReaderForDocumentNavigation();
 audioBookmarkDrafts.delete(doc.key);
 if($('audio-project').dataset.documentKey===doc.key){delete $('audio-project').dataset.documentKey;$('audio-bookmark-form').reset();$('audio-bookmarks').replaceChildren();}
 state.documents.splice(index,1);
 if(wasActive){selectActiveDocument(state.documents[Math.min(index,state.documents.length-1)]?.key||null,{persist:false});$('source-media').replaceChildren();$('source-media').hidden=true;listeningSession=null;renderListeningResume();setReadingMode(prefersPassageReading(active())?'passages':'summary');workspace=active()?'read':'add';}
 operation.selectionRevision=activeSelectionRevision;
 const ticket=libraryStore.queueDocument(doc.key,doc,'remove',{rollback(){
  if(pendingStructuralDocuments.get(doc.key)!==operation||state.documents.some(item=>item.key===doc.key))return false;
  state.documents.splice(Math.min(index,state.documents.length),0,doc);
  finishStructuralOperation(operation);restoreRemovedDrafts(bundle);
  if(wasActive&&activeSelectionRevision===operation.selectionRevision&&document.activeElement===operation.focusAtStart){resetReaderForDocumentNavigation();selectActiveDocument(doc.key,{persist:false});workspace='read';setReadingMode(prefersPassageReading(doc)?'passages':'summary');render();}else renderLibrary();
  renderRemovalRecovery();return true;
 }});
 removalTarget=null;if(removalDialogOrigin?.doc===doc)removalDialogOrigin.confirmed=true;
 $('remove-document-dialog').close();render();renderRemovalRecovery();
 $('main-content').focus({preventScroll:true});operation.focusAtStart=document.activeElement;
 void libraryStore.flush();const receipt=await ticket.committed;
 if(!receipt.ok){finishStructuralOperation(operation);renderRemovalRecovery();notice('移除未保存，原文档已留在书架。其他修改仍保留；请检查保存状态并先导出备份。');return;}
 if(pendingStructuralDocuments.get(doc.key)!==operation)return;
 finishStructuralOperation(operation);removedDocument=bundle;
 if(wasActive&&activeSelectionRevision===operation.selectionRevision)rememberActiveDocument();
 $('removal-recovery-details').open=false;$('removal-recovery-error').hidden=true;$('removal-export-error').hidden=true;
 window.dispatchEvent(new CustomEvent('coconut-document-removed',{detail:{key:doc.key,bundle}}));
 const attachment=browserMedia.get(doc.key);if(attachment){browserMedia.delete(doc.key);URL.revokeObjectURL(attachment.url);}
 renderLibrary();renderRemovalRecovery();
 notice('已从保存的书架移除。可在本页撤销或导出这份备份；刷新、关闭或离开页面后不能撤销。','success');
 // Receipt callbacks never pull focus away from a newer document or input.
 if(activeSelectionRevision===operation.selectionRevision&&document.activeElement===$('main-content')){$('toggle-library').setAttribute('aria-expanded','false');$('undo-removal').focus();}
};
$('undo-removal').onclick=async()=>{
 const recovery=removedDocument;if(!recovery||pendingLibraryOperation||!contentIngressAllowed())return;
 const doc=JSON.parse(JSON.stringify(recovery.doc));
 if(state.documents.some(item=>item.key===doc.key)){showRemovalRecoveryError('书架中已有同编号内容。请先导出备份，再通过添加文件恢复。');notice('书架中已有同编号内容。请导出移除备份，再通过添加文件恢复；不同版本会分别保留。');return;}
 const operation={key:doc.key,identity:doc,selectionRevision:activeSelectionRevision,previousActive:state.active,focusAtStart:document.activeElement};
 pendingLibraryOperation=operation;pendingStructuralDocuments.set(doc.key,operation);
 state.documents.splice(Math.min(recovery.index,state.documents.length),0,doc);
 const ticket=libraryStore.queueDocument(doc.key,doc,'restore',{rollback(){
  if(pendingStructuralDocuments.get(doc.key)!==operation||!state.documents.includes(doc))return false;
  state.documents.splice(state.documents.indexOf(doc),1);finishStructuralOperation(operation);
  if(active()===undefined||state.active===doc.key){selectActiveDocument(operation.previousActive);workspace=active()?'read':'add';render();}else renderLibrary();
  renderRemovalRecovery();return true;
 }});
 renderLibrary();renderRemovalRecovery();void libraryStore.flush();const receipt=await ticket.committed;
 if(!receipt.ok){finishStructuralOperation(operation);renderRemovalRecovery();showRemovalRecoveryError('撤销未保存。可重试或先导出备份，暂时不要离开本页。');notice('撤销未成功，完整内容和未提交草稿仍保留在本页恢复区。请导出移除备份，或释放空间后重试。');return;}
 if(pendingStructuralDocuments.get(doc.key)!==operation)return;
 finishStructuralOperation(operation);restoreRemovedDrafts(recovery);if(removedDocument===recovery)removedDocument=null;
 const ownsFocus=document.activeElement===operation.focusAtStart||document.activeElement===document.body;
 const canNavigate=activeSelectionRevision===operation.selectionRevision&&ownsFocus;
 if(canNavigate&&(recovery.wasActive||!active())){resetReaderForDocumentNavigation();selectActiveDocument(doc.key);workspace='read';setReadingMode(prefersPassageReading(doc)?'passages':'summary');render();}else if(active()===doc)render();else renderLibrary();
 renderRemovalRecovery();
 if(active()===doc&&Coconut.hasProjectAnnotations(doc))$('audio-project-status').textContent='项目已恢复；未提交的书签草稿仅在本页，请保存或取消。';
 if(canNavigate&&active()===doc&&doc.readingPosition){if(prefersPassageReading(doc))openPassage(doc.readingPosition);else goToSegment(doc.readingPosition);}
 notice('已撤销移除，并保存完整文字稿、译文、笔记与阅读位置。','success');
 if(canNavigate)focusLibraryRemoval(doc.key);
};
$('export-removed-document').onclick=()=>{
 if(!removedDocument)return;let url,link;
 try{
  const blob=new Blob([JSON.stringify(removedDocument.doc,null,2)],{type:'application/json'});
  url=URL.createObjectURL(blob);link=el('a');link.href=url;link.download='coconut-removed-document.json';link.hidden=true;document.body.append(link);link.click();
  $('removal-export-error').hidden=true;
  if($('remove-document-error').dataset.kind==='export'){$('remove-document-error').textContent='';delete $('remove-document-error').dataset.kind;}
  notice('已发起移除备份下载，请打开文件确认已保存。可用“添加文件”恢复；下载不会自动结束撤销。'+backupRecoveryHint(blob));
 }catch{
  const message='移除备份下载失败，完整内容仍在本页，请重试或撤销移除。';
  $('removal-recovery-details').open=true;$('removal-export-error').textContent=message;$('removal-export-error').hidden=false;
  if($('remove-document-dialog').open){$('remove-document-error').textContent=message;$('remove-document-error').dataset.kind='export';}
  notice(message);
 }
 finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);}
};
$('finish-removal').onclick=()=>{
 if(!removedDocument||pendingLibraryOperation)return;
 finishRemovalDialogOrigin={recovery:removedDocument,confirmed:false};
 $('finish-removal-dialog').showModal();$('cancel-finish-removal').focus();
};
$('export-previous-removal').onclick=()=>$('export-removed-document').onclick();
$('cancel-finish-removal').onclick=()=>{$('finish-removal-dialog').close();};
$('finish-removal-dialog').addEventListener('close',()=>{
 const dialog=$('finish-removal-dialog');
 if(dialog.open)return;
 const origin=finishRemovalDialogOrigin;finishRemovalDialogOrigin=null;if(!origin)return;
 if(!removalDialogMayRestoreFocus(dialog,$('finish-removal')))return;
 if(origin.confirmed){if(!removedDocument)focusLibraryRemoval(null);}
 else if(removedDocument===origin.recovery){
  // Native close already restores the opener. Never reopen a disclosure that
  // the user collapsed while the close event was waiting to be dispatched.
  ($('removal-recovery-details').open?$('finish-removal'):$('removal-recovery-details').querySelector('summary')).focus();
 }
});
$('confirm-finish-removal').onclick=()=>{
 if(pendingLibraryOperation||!finishRemovalDialogOrigin||removedDocument!==finishRemovalDialogOrigin.recovery)return;
 finishRemovalDialogOrigin.confirmed=true;removedDocument=null;$('finish-removal-dialog').close();renderRemovalRecovery();notice('已结束本页撤销。如果另有 JSON 备份，以后可用“添加文件”恢复。');
};

// Shelf paging bounds DOM work only. Filtering, sorting, storage, and backup
// always use the complete document array; the cache retains this page alone.
// Mobile browsing is a full-height normal-flow pane, never a modal. Move the
// existing tools (not clones) so state and event ownership survive every resize.
const libraryMobile=window.matchMedia('(max-width: 650px)');
const libraryToolNodes=[$('open-library-notebook'),document.querySelector('.library-backup'),$('library-options'),$('library-pagination')];
const libraryToolAnchors=libraryToolNodes.map(node=>{const anchor=document.createComment('library tool home');node.before(anchor);return anchor;});
let libraryReaderFocus=null,libraryBrowseOrigin=null;
document.addEventListener('focusin',event=>{
 if($('main-content').contains(event.target))libraryReaderFocus={node:event.target,key:active()?.key};
 // CSS applies the narrow breakpoint before MQL callbacks. Record genuine
 // desktop shelf ownership now, so narrowing cannot hide and blur its control.
 if(!libraryMobile.matches)$('toggle-library').setAttribute('aria-expanded',String($('library-list').contains(event.target)));
});
document.addEventListener('focusout',event=>{
 // A deliberate desktop departure/blur ends that ownership. Do not remember
 // or refocus an old node when the user has already moved back to the reader.
 if(!libraryMobile.matches&&$('library-list').contains(event.target)&&!$('library-list').contains(event.relatedTarget))$('toggle-library').setAttribute('aria-expanded','false');
});
function arrangeLibraryTools(){
 const focused=document.activeElement,ownsFocus=libraryToolNodes.some(node=>node.contains(focused)),shelfOwnsFocus=$('library-list').contains(focused);
 $('library-tools').hidden=!libraryMobile.matches;
 if(libraryMobile.matches){
  if(shelfOwnsFocus)$('toggle-library').setAttribute('aria-expanded','true');
  libraryToolNodes.forEach(node=>$('library-tools-content').append(node));
  if(ownsFocus)$('library-tools').open=true;
 }else libraryToolNodes.forEach((node,index)=>libraryToolAnchors[index].after(node));
 if(ownsFocus)focused.focus({preventScroll:true});
 else if(!libraryMobile.matches&&(focused===$('toggle-library')||focused===$('library-tools').querySelector('summary')))$('library-search').focus({preventScroll:true});
}
libraryMobile.addEventListener('change',arrangeLibraryTools);
arrangeLibraryTools();
function returnFromLibrary(){
 const origin=libraryBrowseOrigin;libraryBrowseOrigin=null;
 $('toggle-library').setAttribute('aria-expanded','false');
 const sameReader=!!origin&&origin.doc===active()&&origin.selectionRevision===activeSelectionRevision;
 const node=sameReader&&origin.node?.isConnected&&!origin.node.closest('[hidden]')?origin.node:(!$('reader-workspace').hidden?$('title'):$('main-content'));
 node.focus({preventScroll:true});
 if(sameReader)window.scrollTo?.({top:origin.scrollY,behavior:'instant'});
 node.scrollIntoView?.({block:sameReader?'nearest':'start',behavior:'instant'});
}
function toggleLibraryBrowsing(){
 if($('toggle-library').getAttribute('aria-expanded')==='true'){returnFromLibrary();return;}
 libraryBrowseOrigin={key:active()?.key,doc:active(),selectionRevision:activeSelectionRevision,reading:!$('reader-workspace').hidden,node:libraryReaderFocus?.key===active()?.key?libraryReaderFocus.node:null,scrollY:window.scrollY};
 $('toggle-library').setAttribute('aria-expanded','true');
 if(libraryMobile.matches)$('toggle-library').closest('aside').scrollIntoView?.({block:'start',behavior:'instant'});
}
document.addEventListener('keydown',event=>{
 if(event.key!=='Escape'||event.defaultPrevented||event.isComposing||readingKeyComposition||event.keyCode===229||event.target.closest?.('select')||!libraryMobile.matches||$('toggle-library').getAttribute('aria-expanded')!=='true')return;
 if(!$('toggle-library').closest('aside').contains(document.activeElement)||document.querySelector('dialog[open], [popover]:popover-open')||$('export-menu').open||$('reading-info').open)return;
 event.preventDefault();event.stopImmediatePropagation();returnFromLibrary();
});
const LIBRARY_PAGE_SIZE=40;
let libraryPage=0,libraryViewSignature=null,libraryActiveKey=null,libraryCards=new Map();
function libraryPageFocus(){
 if(libraryMobile.matches)$('library-tools').open=false;
 $('toggle-library').setAttribute('aria-expanded','true');
 ($('library').querySelector('.library-open:not(:disabled)')||$('library-search')).focus();
}
function createLibraryCard(d){
 const entry=el('div','library-entry');entry.dataset.documentKey=d.key;
 const open=el('button','library-open');open.type='button';
 const title=el('span','library-title'),metadata=el('small');open.append(title,metadata);
 const openDocument=(hit=null)=>{
  if(pendingStructuralDocuments.has(d.key)||!state.documents.includes(d))return;
  if(!hit&&libraryMobile.matches&&$('toggle-library').getAttribute('aria-expanded')==='true'&&d.key===active()?.key&&libraryBrowseOrigin?.reading&&libraryBrowseOrigin.doc===d&&libraryBrowseOrigin.selectionRevision===activeSelectionRevision){returnFromLibrary();return;}
  resetReaderForDocumentNavigation();selectActiveDocument(d.key);
  setReadingMode(prefersPassageReading(d)?'passages':'summary');
  $('toggle-library').setAttribute('aria-expanded','false');showWorkspace('read');render();
  const bookmark=d.segments.find(s=>s.id===d.readingPosition);
  if(hit)openLibraryHit(hit);
  else if(bookmark){if(prefersPassageReading(d))openPassage(bookmark.id);else goToSegment(bookmark.id);}
  else{$('title').scrollIntoView?.({block:'start'});$('title').focus({preventScroll:true});}
 };
 open.onclick=()=>openDocument();
 const remove=el('button','library-remove','移除…');remove.type='button';remove.onclick=()=>requestLibraryRemoval(d);
 entry.append(open,remove);
 return {doc:d,entry,open,title,metadata,remove,openDocument,hitSignature:null,hits:null};
}
const librarySearch=Coconut.createLibrarySearch({getDocuments:()=>state.documents,getRevision:()=>libraryContentRevision,onChange:()=>renderLibrary()});
let libraryPendingReveal=null;
function renderLibrary(revealKey=null) {
 const host=$('library'),query=$('library-search').value.trim().toLocaleLowerCase(),scope=$('library-scope').value;
 const signature=JSON.stringify([query,$('library-sort').value,$('library-kind').value,scope]);
 const viewChanged=libraryViewSignature!==null&&signature!==libraryViewSignature;
 const selection=librarySearch.request(query,$('library-kind').value,scope,$('library-sort').value);
 if(typeof revealKey==='string')libraryPendingReveal={signature,key:revealKey};
 if(libraryPendingReveal?.signature!==signature)libraryPendingReveal=null;
 host.setAttribute('aria-busy',String(selection.pending));
 if(selection.pending){
  if(viewChanged)libraryPage=0;
  libraryViewSignature=signature;
  // Never advertise a partial count or leave old-query hits actionable.
  if(host.contains(document.activeElement))$('library-search').focus({preventScroll:true});
  host.hidden=true;$('library-empty').hidden=true;$('library-pagination').hidden=true;$('library-show-active').hidden=true;
  $('library-total').textContent=String(state.documents.length);
  $('library-page-status').textContent='正在查找… 已检查 '+selection.scanned+' / '+selection.documents.length+' 份';
  return;
 }
 host.hidden=false;
 if(libraryPendingReveal){revealKey=libraryPendingReveal.key;libraryPendingReveal=null;}
 const docs=selection.docs;
 const activeIndex=docs.findIndex(d=>d.key===state.active);
 if(viewChanged)libraryPage=0;
 else if(state.active!==libraryActiveKey&&activeIndex>=0)libraryPage=Math.floor(activeIndex/LIBRARY_PAGE_SIZE);
 if(typeof revealKey==='string'){
  const index=docs.findIndex(d=>d.key===revealKey);if(index>=0)libraryPage=Math.floor(index/LIBRARY_PAGE_SIZE);
 }
 const pageCount=Math.ceil(docs.length/LIBRARY_PAGE_SIZE);
 libraryPage=Math.max(0,Math.min(libraryPage,pageCount-1));
 libraryViewSignature=signature;libraryActiveKey=state.active;
 const start=libraryPage*LIBRARY_PAGE_SIZE,visible=docs.slice(start,start+LIBRARY_PAGE_SIZE);
 $('library-total').textContent=String(state.documents.length);
 $('library-empty').hidden=docs.length>0;
 $('library-empty').textContent=state.documents.length?'没有匹配的内容，可调整书架筛选或查找范围':'还没有内容。添加一份，或体验示例。';
 const range=docs.length?(start+1)+'–'+(start+visible.length):'0';
 const status='显示 '+range+' / '+docs.length+' 份'+(docs.length!==state.documents.length?' · 书架共 '+state.documents.length+' 份':'');
 if($('library-page-status').textContent!==status)$('library-page-status').textContent=status;
 $('library-pagination').hidden=pageCount<=1;
 $('library-previous').disabled=libraryPage===0;$('library-next').disabled=libraryPage+1>=pageCount;
 $('library-page-count').textContent=String(pageCount||1);$('library-page-number').max=String(pageCount||1);
 if(document.activeElement!==$('library-page-number'))$('library-page-number').value=String(libraryPage+1);
 $('library-show-active').hidden=activeIndex<0||Math.floor(activeIndex/LIBRARY_PAGE_SIZE)===libraryPage;
 const focused=document.activeElement,focusedEntry=focused?.closest('.library-entry');
 const focusKey=focusedEntry?.dataset.documentKey,hitKind=focused?.dataset.hitKind,hitId=focused?.dataset.hitId;
 const nextCards=new Map();
 for(const d of visible){
  const previous=libraryCards.get(d.key),card=previous?.doc===d?previous:createLibraryCard(d);
  const bookmark=d.segments.find(s=>s.id===d.readingPosition),audioOnly=Coconut.isAudioProject(d),duration=Coconut.documentDuration(d);
  const metadata=audioOnly?['原声项目','未导入文字稿',duration?Coconut.time(duration):'时长待确认']:[Coconut.time(duration),Coconut.segmentNoteCount(d)+' 则片段笔记'];
  if(Coconut.hasProjectAnnotations(d))metadata.push((Coconut.hasNoteContent(d.project_note)?1:0)+' 则项目笔记',d.timestamp_bookmarks.length+' 个时间书签');
  if(bookmark)metadata.push('读到 '+Coconut.time(bookmark.start));
  if(card.title.textContent!==d.title)card.title.textContent=d.title;
  const description=metadata.join(' · ');if(card.metadata.textContent!==description)card.metadata.textContent=description;
  card.open.classList.toggle('active',d.key===state.active);card.open.setAttribute('aria-current',d.key===state.active?'page':'false');
  card.open.disabled=pendingStructuralDocuments.has(d.key);card.open.title=card.open.disabled?'正在保存恢复，完成后可打开':'';
  card.remove.setAttribute('aria-label','从书架移除 '+d.title);card.remove.hidden=!$('library-options').open;card.remove.disabled=!!pendingLibraryOperation;
  const hits=Coconut.libraryHits(d,query,scope),hitSignature=JSON.stringify(hits);
  if(card.hitSignature!==hitSignature){
   card.hits?.remove();card.hits=null;card.hitSignature=hitSignature;
   if(hits.length){
    const list=el('div','library-hits');list.setAttribute('aria-label','匹配预览（最多 3 项）');
    for(const hit of hits){
     const button=el('button','library-hit');button.type='button';button.dataset.hitKind=hit.kind;button.dataset.hitId=hit.id||'';
     if(hit.ids){button.dataset.cueCount=String(hit.ids.length);if(hit.ids.length<=32)button.dataset.cueIds=JSON.stringify(hit.ids);}
     const label={'text':'原文','note':'片段笔记','project-note':'项目笔记','bookmark':'时间书签'}[hit.kind];
     button.append(el('small','',label+(hit.time===undefined?'':' · '+Coconut.time(hit.time))));
     const preview=el('span','library-hit-preview');preview.append(document.createTextNode(hit.snippet.before),el('mark','',hit.snippet.match),document.createTextNode(hit.snippet.after));
     button.append(preview);button.onclick=()=>card.openDocument(hit);list.append(button);
    }
    card.entry.append(list);card.hits=list;
   }
  }
  for(const hit of card.hits?.children||[])hit.disabled=pendingStructuralDocuments.has(d.key);
  nextCards.set(d.key,card);
 }
 // Avoid moving unchanged nodes: moving a focused button can reset focus in a
 // native browser even if it returns to the same parent in the same task.
 let index=0;
 for(const {entry} of nextCards.values()){if(host.children[index]!==entry)host.insertBefore(entry,host.children[index]||null);index++;}
 while(host.children.length>index)host.lastElementChild.remove();
 libraryCards=nextCards;
 // A refreshed preview or reordered card keeps the exact action when it still
 // exists. Never steal focus from an editor, dialog, or async operation.
 if(focusKey&&(!focused.isConnected||document.activeElement===document.body)){
  const card=libraryCards.get(focusKey);
  const target=hitKind?[...(card?.hits?.children||[])].find(node=>node.dataset.hitKind===hitKind&&node.dataset.hitId===hitId):focused.classList.contains('library-remove')?card?.remove:card?.open;
  if(target&&!target.disabled&&!target.hidden)target.focus({preventScroll:true});
  else if(card&&!card.open.disabled)card.open.focus({preventScroll:true});
  else $('library-search').focus({preventScroll:true});
 }
}
$('library-previous').onclick=()=>{if(libraryPage>0){libraryPage--;renderLibrary();libraryPageFocus();}};
$('library-next').onclick=()=>{if(!$('library-next').disabled){libraryPage++;renderLibrary();libraryPageFocus();}};
$('library-page-form').onsubmit=event=>{
 event.preventDefault();const page=Number($('library-page-number').value),max=Number($('library-page-number').max);
 if(!Number.isInteger(page)||page<1||page>max){$('library-page-number').reportValidity?.();return;}
 libraryPage=page-1;renderLibrary();libraryPageFocus();$('library-page-number').value=String(libraryPage+1);
};
$('library-show-active').onclick=()=>{renderLibrary(state.active);const card=libraryCards.get(state.active);$('toggle-library').setAttribute('aria-expanded','true');card?.open.focus();};
// This modal deliberately leaves the reader, selection and media untouched.
const notebookSelection=new Set();
let notebookPage=0,notebookReturn=null,notebookOpener=null;
const NOTEBOOK_PAGE_SIZE=30;
function renderLibraryNotebook(){
 const captures=Coconut.libraryCaptures(state.documents,$('notebook-search').value,$('notebook-kind').value);
 for(const key of notebookSelection)if(!state.documents.some(doc=>doc.key===key))notebookSelection.delete(key);
 notebookPage=Math.min(notebookPage,Math.max(0,Math.ceil(captures.length/NOTEBOOK_PAGE_SIZE)-1));
 const start=notebookPage*NOTEBOOK_PAGE_SIZE,host=$('notebook-captures');host.replaceChildren();
 $('notebook-status').textContent=captures.length?`${start+1}–${Math.min(start+NOTEBOOK_PAGE_SIZE,captures.length)} / ${captures.length} 条记录`:'没有匹配的记录。阅读时摘录原话或记下笔记后，会在这里出现。';
 $('notebook-previous').disabled=notebookPage===0;$('notebook-next').disabled=start+NOTEBOOK_PAGE_SIZE>=captures.length;
 for(const capture of captures.slice(start,start+NOTEBOOK_PAGE_SIZE)){
  const doc=state.documents.find(doc=>doc.key===capture.documentKey),row=el('li','notebook-capture');row.dataset.captureKey=capture.key;
  const source=capture.type==='cue'?doc.segments.find(cue=>cue.id===capture.id):capture.type==='bookmark'?doc.timestamp_bookmarks.find(item=>item.id===capture.id):doc;
  const label=el('label'),check=el('input');check.type='checkbox';check.checked=notebookSelection.has(doc.key);check.setAttribute('aria-label','选择篇目 '+doc.title);check.onchange=()=>{check.checked?notebookSelection.add(doc.key):notebookSelection.delete(doc.key);syncNotebookSelection();};label.append(check,document.createTextNode(doc.title));row.append(label);
  row.append(el('p','hint',(capture.type==='cue'?(capture.excerpt?'摘录':'片段')+(Coconut.hasNoteContent(capture.note)?' · 笔记':''):capture.type==='project-note'?'项目笔记':'时间书签')+(capture.time===null?'':' · '+Coconut.time(capture.time))));
  const details=el('details'),summary=el('summary','','查看完整记录与来源');details.append(summary);
  if(capture.text){row.append(el('p','notebook-preview',capture.text));details.append(el('p','notebook-content',capture.text));}
  if(capture.note){row.append(el('p','notebook-preview',capture.note));details.append(el('p','notebook-content','我的笔记：\n'+capture.note));}
  details.append(el('p','hint','文档标识：'+doc.key+' · '+capture.type+' · '+capture.id));
  details.append(el('p','hint',doc.local_media_source?'本地媒体：'+doc.local_media_source.name:(doc.source_url||doc.podcast_source?.media_url||'未关联原站链接；可打开原位置核对。')));
  if(capture.type==='cue'){
   const cue=doc.segments.find(cue=>cue.id===capture.id),translation=cue.translations?.[doc.translation_view];
   if(translation)details.append(el('p','notebook-content',Coconut.translationCurrent(cue,doc,translation)?'译文（'+doc.translation_view+'；'+(translation.provider==='user'?'用户自己写的译文':translation.manual_review?'用户已核对':'机器生成，需核对')+'）：\n'+translation.text:'译文已过期，请在原文中核对。'));
   if(cue.original_text!==undefined&&cue.original_text!==cue.text)details.append(el('p','notebook-content','修正前文字稿：\n'+cue.original_text));
  }
  const open=el('button','notebook-open','打开原位置');open.type='button';open.onclick=()=>{
   const sourceCurrent=capture.type==='cue'?doc.segments.includes(source)&&source.text===capture.text&&source.start===capture.time:capture.type==='bookmark'?doc.timestamp_bookmarks.includes(source)&&source.time===capture.time:Coconut.hasNoteContent(doc.project_note);
   if(pendingStructuralDocuments.has(doc.key)||!state.documents.includes(doc)||!sourceCurrent){renderLibraryNotebook();$('notebook-status').textContent='这条记录的来源已变动，请从更新后的笔记本重新选择。';$('notebook-search').focus();return;}
   notebookReturn={key:capture.key,scroll:$('library-notebook').scrollTop};$('library-notebook').close();
   resetReaderForDocumentNavigation();selectActiveDocument(doc.key);setReadingMode('transcript');showWorkspace('read');render();
   openLibraryHit({kind:capture.type==='cue'?(Coconut.hasNoteContent(capture.note)?'note':'text'):capture.type,id:capture.id});
   $('return-library-notebook').hidden=false;
  };row.append(details,open);host.append(row);
 }
 syncNotebookSelection();
}
function syncNotebookSelection(){
 for(const row of $('notebook-captures').children){const key=JSON.parse(row.dataset.captureKey)[0];row.querySelector('input').checked=notebookSelection.has(key);}
 $('notebook-export-scope').textContent='已选 '+notebookSelection.size+' 篇；导出所选篇目的全部记录（包括当前搜索未显示的记录）。';
 $('notebook-export').disabled=notebookSelection.size===0;
}
function openLibraryNotebook(returning=false){
 notebookOpener=document.activeElement;renderLibraryNotebook();$('library-notebook').showModal();
 const row=returning&&notebookReturn?[...$('notebook-captures').children].find(row=>row.dataset.captureKey===notebookReturn.key):null;
 (row?.querySelector('.notebook-open')||$('notebook-search')).focus({preventScroll:true});
 if(returning&&notebookReturn)$('library-notebook').scrollTop=notebookReturn.scroll;
}
$('open-library-notebook').onclick=()=>openLibraryNotebook();
$('return-library-notebook').onclick=()=>openLibraryNotebook(true);
$('notebook-close').onclick=()=>{$('library-notebook').close();notebookOpener?.focus?.();};
for(const id of ['notebook-search','notebook-kind'])$(id)[id==='notebook-search'?'oninput':'onchange']=()=>{notebookPage=0;renderLibraryNotebook();};
for(const [id,delta] of [['notebook-previous',-1],['notebook-next',1]])$(id).onclick=()=>{notebookPage+=delta;renderLibraryNotebook();$('notebook-captures').querySelector('.notebook-open')?.focus();};
$('notebook-clear-selection').onclick=()=>{notebookSelection.clear();syncNotebookSelection();};
$('notebook-export').onclick=()=>{
 let url,link;
 try{
  renderLibraryNotebook();if(!notebookSelection.size)return;
  url=URL.createObjectURL(new Blob([Coconut.libraryNotebookMarkdown(state.documents,notebookSelection)],{type:'text/markdown;charset=utf-8'}));
  link=el('a');link.href=url;link.download='coconut-library.notes.md';link.hidden=true;document.body.append(link);link.click();
  notice('已发起所选篇目全部记录的 Markdown 下载，请检查下载记录。完整恢复仍需 JSON 备份。','success');
 }catch{notice('笔记本下载失败，请重试或使用书架备份。');}finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),1000);}
};
function openLibraryHit(hit) {
 if(hit.kind==='text'||hit.kind==='note'){
  goToSegment(hit.id,true);
  if(hit.kind==='note'){
   const row=[...$('transcript').querySelectorAll('.segment')].find(row=>row.dataset.segmentId===hit.id);
   row?.querySelector('.note-button')?.click();
  }
 }else{
  $('audio-bookmark-search').value='';renderAudioProject(active());
  const target=hit.kind==='project-note'?$('project-note'):[...$('audio-bookmarks').children].find(row=>row.dataset.bookmarkId===hit.id)?.querySelector('textarea');
  target?.scrollIntoView?.({block:'center',behavior:'auto'});target?.focus({preventScroll:true});
 }
}
function isLightCueText(text) {
 // Count wider glyphs conservatively so a 160-character Chinese paragraph
 // does not receive the same density treatment as a short English fragment.
 return text.length<=160&&!/[\r\n\u2028\u2029]/.test(text)&&Array.from(text).reduce((width,char)=>width+(char.codePointAt(0)>255?2:1),0)<=100;
}
function focusCueAction(target, viewportTop=null) {
 const disclosure=target?.closest(".cue-more");
 if(disclosure&&target.tagName!=='SUMMARY')disclosure.open=true;
 // Replacing the transcript can move the browser's scroll anchor to another
 // cue. Keep the acted-on short cue at its pre-render viewport position.
 const row=target?.closest('.segment');
 if(row&&viewportTop!==null)window.scrollBy(0,row.getBoundingClientRect().top-viewportTop);
 target?.focus({preventScroll:true});
}
function render({keepNoteEditor=false}={}) {
 $('reader-workspace').inert=!!active()&&pendingStructuralDocuments.has(active().key);
 // All supported source changes render. Invalidate conservatively even when
 // the same array was edited in place; regular media events reuse the index.
 playbackIndex=null;
 const focusedCueAction=document.activeElement?.closest('.cue-more');
 const cueFocus=focusedCueAction?{key:focusedCueAction.dataset.cueKey,selector:document.activeElement.tagName==='SUMMARY'?'summary':'.'+document.activeElement.className}:null;
 const openCueActions=new Set([...document.querySelectorAll(".cue-more[open]")].map(node=>node.dataset.cueKey));
	const doc = active();
 renderReadingContext();
	renderLibrary();
	showWorkspace(doc ? workspace : "add");
	if (!doc) {
		$("transcript").replaceChildren();
		$("empty").hidden = false;
		$("notes-panel").hidden = true;
		return;
	}
	$("empty").hidden = true;
 const audioOnly=Coconut.isAudioProject(doc),duration=Coconut.documentDuration(doc);
 $('audio-project').hidden=!Coconut.hasProjectAnnotations(doc);
 if(!audioOnly&&Coconut.hasProjectAnnotations(doc))renderAudioProject(doc);
 $('transcript-reading-tools').hidden=audioOnly;
 $('reading-modes').hidden=audioOnly;
 $('time-navigation').hidden=audioOnly;
 $('export-subtitles').disabled=audioOnly;
 $('export').textContent=audioOnly?'导出原声项目与笔记':'导出文字稿与笔记';
	const attachment = browserMedia.get(doc.key);
 const mediaPath = attachment?.url || (mediaWorkerReady && Coconut.media ? Coconut.media(doc.source_media) : "");
 const mediaKind = attachment?.kind || doc.source_media?.kind;
 $("detach-reader-media").hidden = !attachment;
 $('attach-reader-media').textContent=doc.local_media_source?'重新选择原音视频':'选择对应的音频或视频';
 $("reader-media-status").textContent = attachment ? attachment.name + " · 仅在此页面读取，不上传；刷新后需重新选择" : doc.local_media_source?'请重新选择「'+doc.local_media_source.name+'」继续回听。笔记、时间书签和项目已保留；未保存媒体文件，未自动播放。':"在浏览器中打开文件，不上传。请选与文字稿对应的原文件；刷新页面后需重新选择。";
	const mediaHost = $("source-media");
 if(repeating && (repeating.key!==doc.key || repeating.path!==mediaPath))stopRepeating();
	const currentPlayer = mediaHost.querySelector("audio,video");
	if (!mediaPath) {
  flushListening(true);currentPlayer?.pause();listeningSession=null;renderListeningResume();
		mediaHost.replaceChildren();
		mediaHost.hidden = true;
	} else if (!currentPlayer || currentPlayer.getAttribute("src") !== mediaPath || listeningSession?.key!=='coconut-listening-v1:'+doc.key) {
  flushListening(true);currentPlayer?.pause();
		const player = el(mediaKind, "source-player");
		player.controls = true;
  player.defaultPlaybackRate=playbackRate;
  player.playbackRate=playbackRate;
  player.onloadedmetadata=()=>{
   player.defaultPlaybackRate=playbackRate;player.playbackRate=playbackRate;updatePlaybackControls();
   const current=state.documents.find(item=>item.key===doc.key);
   if(current?.local_media_source&&contentIngressAllowed(current)&&browserMedia.get(doc.key)===attachment&&mediaHost.querySelector('audio,video')===player&&Number.isFinite(player.duration)&&player.duration>0&&player.duration<=604800&&current.media_duration!==player.duration){
    current.media_duration=player.duration;queueDocument(current);renderLibrary();
    if(Coconut.isAudioProject(current))$('subtitle').textContent='本地原声项目 · '+Coconut.time(player.duration)+' · 项目笔记与时间书签保存在本机';
   }
  };
  player.onratechange=updatePlaybackControls;
  player.ondurationchange=updatePlaybackControls;
		player.ontimeupdate = () => {if(mediaHost.querySelector("audio,video")!==player)return;repeatPlayback(false,player);highlightPlayback();};
  player.onended=()=>repeatPlayback(true,player);
  player.addEventListener("seeking",()=>observeRepeatSeek(player,false));
  player.addEventListener("seeked",()=>observeRepeatSeek(player,true));
  for(const event of ["play","pause","timeupdate","ratechange","loadedmetadata","durationchange","ended","error","emptied"])player.addEventListener(event,refreshPlaybackDock);
  for(const event of ["play","pause","timeupdate","ended","error","emptied"])player.addEventListener(event,()=>{
   if(followPlayer()!==player)return;
   if(event==='emptied'){cancelFollowFrame();readingFollow=null;}
   else if(event==='error')suspendReadingFollow('原声暂不可用');
   scheduleReadingFollow();
  });
  bindListening(player,doc,attachment);
		player.preload = "metadata";
		player.src = mediaPath;
		player.setAttribute("aria-label", "原始音视频");
		player.style.width = "100%";
		player.style.maxHeight = "360px";
		player.onerror = () => {
   if(mediaHost.querySelector('audio,video')!==player||active()?.key!==doc.key)return;
   if(attachment){$('reader-media-status').textContent='浏览器无法解码「'+attachment.name+'」。请重新选择可播放的原文件；笔记、书签与文字稿仍保留。转换后的文件请从「打开本地音视频」另建项目。';notice($('reader-media-status').textContent);}
   else notice('原始媒体暂时无法播放。请确认此文字稿对应的本地任务仍在这台电脑上。');
  };
		mediaHost.replaceChildren(player);
		mediaHost.hidden = false;
	}
	$("locate-playback").hidden = !mediaPath||audioOnly;
 updatePlaybackControls();
	$("title").textContent = doc.title;
 const isDemo=doc.provenance?.kind==='authored_demo';
 document.body.dataset.demo=String(isDemo);
 document.body.dataset.demoTools=String(demoToolsExpanded);
 $('toggle-demo-tools').setAttribute('aria-expanded',String(demoToolsExpanded));
 const hasReadingFilter=!!$('search').value.trim()||notesOnly||excerptsOnly||speakerFilter!==null;
 $('toggle-demo-tools').textContent=demoToolsExpanded?'收起工具':hasReadingFilter?'筛选中 · 查看':'搜索与工具';
 $('demo-guide').hidden=!isDemo;
 // The authored tryout has no media; don't suggest attaching an unrelated recording.
 updateReaderMediaVisibility(doc,!!mediaPath);renderMediaTiming();
 if(!passagePlayback)passagePlayback=CoconutPassagePlayback.create({getPlayer:()=>$('source-media').querySelector('audio,video'),getDocumentKey:()=>active()?.key,onTakeover:takeListeningOwnership,onChange:state=>{if(listeningSession){if(state.range)listeningSession.preview=true;else if(listeningSession.preview)listeningSession.previewStoppedAt=listeningSession.player.currentTime;}renderPassagePlayback(state);}});
 passagePlayback.sync();
 $('reader-kind').textContent=isDemo?'一分钟试读':audioOnly?'原声项目':doc.language?doc.language.toUpperCase()+' · 原文可回查':'原文可回查';
 renderReadingNavigation(doc);
	$("time-navigation-status").textContent="";
	$("subtitle").textContent = audioOnly ? '原声项目 · '+(duration?Coconut.time(duration)+' · ':'时长待确认 · ')+'来源、项目笔记与时间书签保存在本机' :
		doc.segments.length +
		" 个片段 · " +
		Coconut.time(duration) +
		" · 原话与笔记保存在本机";
	const provenance = doc.provenance || {};
	const sourceKinds = {authored_demo:"Coconut 自写演示内容与预置译文（不是节目字幕或模型生成结果）",publisher_transcript:"发布者提供的文字稿（未人工核对）",platform_subtitles: "平台提供的字幕", automatic_subtitles: "平台自动字幕", imported_subtitles: "导入的字幕", local_asr: "本机语音识别"};
	const provenanceText = sourceKinds[provenance.kind] || "导入文字稿，来源未标明";
	const medium = provenance.source_medium === "audio" ? "音频内容" : provenance.source_medium === "video" ? "视频内容" : "";
 $("provenance").textContent = [medium, provenance.source_platform].filter(Boolean).join(" · ") + (medium || provenance.source_platform ? " · " : "") + provenanceText + (provenance.model ? " · " + provenance.model : "") + (isDemo ? " · 没有对应音视频" : " · 请回听核对专有名词与重要信息") + (provenance.alignment_warning ? " · 时间对齐降级：" + provenance.alignment_warning : "");
	if(isDemo){$('provenance').hidden=true;$('subtitle').textContent='3 个片段 · 英文 / 中文';}
 else $('provenance').hidden=false;
 $("count").textContent = "书架 / " + doc.title;
 if(audioOnly){
  $('provenance').textContent=doc.transcript_status==='unavailable'?'未发现可用的公开定时文字稿；未运行语音识别或模型':'尚未导入文字稿；未运行语音识别或模型';
  $('notes-panel').hidden=true;$('transcript').replaceChildren();
  renderAudioProject(doc);renderNotebookAction(doc);applyReadingMode();
  window.dispatchEvent(new Event('coconut-render'));return;
 }
 const speakers=[...new Set(doc.segments.map(s=>s.speaker||''))];
 if(speakerFilter!==null&&!speakers.includes(speakerFilter))speakerFilter=null;
 const selector=$('speaker-filter');selector.replaceChildren(el('option','','全部说话人'));selector.firstChild.value='all';
 for(const speaker of speakers){const option=el('option','',speaker||'未标注说话人');option.value=JSON.stringify(speaker);selector.append(option);}
 selector.value=speakerFilter===null?'all':JSON.stringify(speakerFilter);$('speaker-filter-control').hidden=speakers.length<2;
	const query = $("search").value.trim().toLocaleLowerCase();
	const filtered = doc.segments.filter(s=>matchesReadingSegment(s,doc,query));
 const searchMatches=query?Coconut.searchDocument(doc,query):null;
	// Clamp after removing the last matching note/excerpt on a later page.
	pageStart = Math.min(pageStart, Math.max(0, Math.floor((filtered.length - 1) / PAGE_SIZE) * PAGE_SIZE));
	const visible = filtered.slice(pageStart, pageStart + PAGE_SIZE);
 if(!query || !filtered.some(s=>s.id===searchFocusedId))searchFocusedId=null;
 $("search-navigation").hidden=!query;
 $("previous-match").disabled=!filtered.length;$("next-match").disabled=!filtered.length;
 $("match-position").textContent=(searchFocusedId?filtered.findIndex(s=>s.id===searchFocusedId)+1:0)+" / "+filtered.length+" 个匹配片段";
	const currentNote = visible.find((segment) => segment.id === selected) || (keepNoteEditor && doc.segments.find(segment=>segment.id===selected));
	if (!currentNote) selected = null;
	$("notes-panel").hidden = !selected;
	if (currentNote) {
		$("quote").textContent = currentNote.text;
		$("note-time").textContent = Coconut.time(currentNote.start) + " 的想法";
		if($("note").value !== (doc.notes[currentNote.id] || "")) $("note").value = doc.notes[currentNote.id] || "";
	}
	$("filter-all").setAttribute("aria-pressed", String(!notesOnly && !excerptsOnly));
	$("filter-notes").setAttribute("aria-pressed", String(notesOnly));
	$("filter-excerpts").setAttribute("aria-pressed", String(excerptsOnly));
	$("excerpt-count").textContent = String(doc.segments.filter(s => s.saved_excerpt === true).length);
	renderNotebookAction(doc);
	$("note-count").textContent = String(Coconut.segmentNoteCount(doc));
	const playbackHint = isDemo && !mediaPath ? "自写双语示例 · 可试读、摘录与记笔记，没有对应音视频" : mediaPath ? "点时间戳定位本地原声" : Coconut.source(doc.source_url, 0) ? "点时间戳打开原站；若平台未自动定位，请按显示时间手动跳转" : doc.source_media ? "本地媒体尚未连接；请在保存原任务的电脑启动 Coconut" : "尚未关联音视频，可在「阅读设置」添加原视频链接";
 $('reading-page-status').textContent=filtered.length?`${pageStart+1}–${pageStart+visible.length} / ${filtered.length} 段`:"没有匹配片段";
 $("search-status").textContent = ((query || notesOnly || excerptsOnly || speakerFilter!==null) ? "找到 " + filtered.length + " 个片段" : "共 " + doc.segments.length + " 个片段") + " · " + playbackHint;
	$("clear-search").hidden = !query && !notesOnly && !excerptsOnly && speakerFilter===null;
	const bookmark = doc.segments.find(s => s.id === doc.readingPosition);
	$("resume").hidden = !bookmark;
	$("resume").textContent = bookmark ? "继续阅读 · " + Coconut.time(bookmark.start) : "";
	$("resume").onclick = () => bookmark && goToSegment(bookmark.id);
	$("transcript").replaceChildren();
	for (const s of visible) {
		const row = el(
			"section",
			"segment" + (selected === s.id ? " selected" : "") + (s.saved_excerpt === true ? " excerpted" : ""),
		);
		row.dataset.segmentId = s.id;
  row.classList.toggle("context-target",readingContext?.id===s.id);
  const translated=s.translations?.[doc.translation_view];
  // Dense caption fragments remain individual source-timed cues. Long text,
  // stale translations and quality warnings keep the full reading treatment.
  const compact=s.end>s.start&&s.end-s.start<=3&&isLightCueText(s.text)&&
   (!translated||(Coconut.translationCurrent(s,doc,translated)&&isLightCueText(translated.text)&&!Coconut.translationQualityMessage(translated)));
  row.classList.toggle('short-cue',compact);
		row.tabIndex = -1;
		const meta = el("div", "time");
		const href = Coconut.source(doc.source_url, s.start);
		if (mediaPath) {
			const seek = el("button", "", Coconut.time(s.start));
			seek.title = "回听本地原文件此刻";
			seek.onclick = () => {
				const player = mediaHost.querySelector("audio,video");
				if (!player) return;
				passagePlayback?.cancel();stopRepeating();
				const mapped=s.start+timingOffset();if(!Number.isFinite(mapped)||mapped<0||(Number.isFinite(player.duration)&&mapped>player.duration)){notice('校准后的时间超出媒体范围，未定位。');return;}
                player.currentTime = mapped;takeListeningOwnership();
				const ownsPlaybackError=playbackErrorOwner(player,doc);
                player.play().catch(error=>{
                 if(error?.name==='AbortError'||!ownsPlaybackError())return;
                 notice("请点击播放器开始播放，再按时间戳定位。");
                });
			};
			meta.append(seek);
   const repeat=el("button","repeat-button",repeating?.id===s.id?"正在循环 · 停止":"循环回听此段");
   repeat.disabled=s.end<=s.start;repeat.setAttribute("aria-pressed",String(repeating?.id===s.id));repeat.onclick=()=>toggleRepeat(s);meta.append(repeat);
			if (href) { const external = el("a", "original-source", "原站"); external.href=href; external.target="_blank"; external.rel="noopener noreferrer"; meta.append(external); }
		} else if (href) {
			const a = el("a", "", Coconut.time(s.start)); a.href=href; a.target="_blank"; a.rel="noopener noreferrer"; a.title="打开原视频的时间链接；是否自动定位取决于平台"; meta.append(a);
		} else meta.textContent=Coconut.time(s.start);
		const body = el("div");
		if (s.speaker) body.append(highlightedText("p", "speaker", s.speaker, query));
		body.className="segment-content";
  const parallel=el("div","parallel-text");
  parallel.append(highlightedText("p", "words", s.text, query, searchMatches?.byCue.get(s.id)?.text||[]));
        if(translated) parallel.append(highlightedText("p", "translation"+(!Coconut.translationCurrent(s,doc,translated)?" stale":""), Coconut.translationCurrent(s,doc,translated) ? translated.text : "原文或上下文已变化，或旧译文缺少上下文记录，可核对／修正此译文或重新生成", query, searchMatches?.byCue.get(s.id)?.translations[doc.translation_view]||[]));
  const textHit=searchMatches?.byCue.get(s.id)?.phrases.text;
  if(textHit?.cueCount>1)body.append(phrasePreview(textHit));
  for(const [language,ranges] of Object.entries(searchMatches?.byCue.get(s.id)?.translations||{})){
   const hit=searchMatches.byCue.get(s.id).phrases['translation:'+language]||searchMatches.previews.get('translation:'+language+':'+s.id),hidden=language!==doc.translation_view;
   if(hit?.cueCount>1||hidden){
    const preview=phrasePreview(hit||{field:'translation',language,id:s.id,ids:[s.id],snippet:CoconutPassages.rangeSnippet(s.translations[language].text,ranges[0].start,ranges[0].end)});
    if(hidden){const reveal=el('button','phrase-show-translation','查看'+translationLabel(language)+'译文');reveal.type='button';reveal.onclick=()=>{if(active()!==doc||!contentIngressAllowed(doc))return;doc.translation_view=language;queueDocument(doc);render();[...$('transcript').querySelectorAll('.segment')].find(row=>row.dataset.segmentId===s.id)?.focus({preventScroll:true});};preview.append(reveal);}
    body.append(preview);
   }
  }
        body.append(parallel);
        if(translated && Coconut.translationCurrent(s,doc,translated)) { const warning=Coconut.translationQualityMessage(translated); if(warning)body.append(el("p","translation-review","待核对："+warning)); }

		const edit = el("button", "edit-button", "修正文字");
		edit.onclick = () => {
			editingTarget = {
				documentKey: doc.key, identity:doc, segmentId: s.id,
				position: [...$("transcript").querySelectorAll(".segment")].indexOf(row),
			};
			$("edit-error").textContent = "";
			$("edit-segment").value = s.text;
			$("edit-dialog").showModal();
		};
		body.append(edit);
  let reviewTranslation=null;
  if(translated||doc.translation_view){
   reviewTranslation=el('button','review-translation-button',!translated?'自己写译文':translated.provider==='user'?'核对／修正自己写的译文':translated.manual_review?'核对／修正人工译文':'核对／修正译文');
   reviewTranslation.onclick=()=>window.CoconutTranslationReview?.openEditor(doc.key,s.id,doc.translation_view);

  }
		const button = el("button", "", Coconut.hasNoteContent(doc.notes[s.id]) ? "编辑笔记" : "＋ 记一笔");
		button.onclick = () => {
			selected = s.id;
			$("notes-panel").hidden = false;
			$("note-time").textContent = Coconut.time(s.start) + " 的想法";
			$("quote").textContent = s.text;
			$("note").value = doc.notes[s.id] || "";
			render();
			$("note").focus();
		};
		button.className = "note-button";
		body.append(button);
  let contextButton=null;
  if(hasReadingFilter){
   contextButton=el('button','context-button','查看上下文');
   contextButton.setAttribute('aria-label','查看 '+Coconut.time(s.start)+' 的上下文');
   contextButton.onclick=()=>openReadingContext(s.id);body.append(contextButton);
  }
		const excerptButton = el("button", "excerpt-button", s.saved_excerpt === true ? "已摘录 · 取消" : "☆ 摘录整段");
		excerptButton.setAttribute("aria-pressed", String(s.saved_excerpt === true));
		excerptButton.setAttribute("aria-label", (s.saved_excerpt === true ? "取消摘录 " : "摘录整段 ") + Coconut.time(s.start));
		excerptButton.onclick = () => {
   if(!contentIngressAllowed(doc)||active()!==doc)return;
   const viewportTop=row.classList.contains('short-cue')?row.getBoundingClientRect().top:null;
			const position = [...$("transcript").querySelectorAll(".segment")].indexOf(row);
			if (s.saved_excerpt === true) delete s.saved_excerpt;
			else s.saved_excerpt = true;
			queueDocument(doc);
			render();
			const rows = [...$("transcript").querySelectorAll(".segment")];
			const target = rows.find(item => item.dataset.segmentId === s.id) || rows[Math.min(position, rows.length - 1)];
			focusCueAction(target?.querySelector(".excerpt-button") || $("filter-excerpts"),target?.dataset.segmentId===s.id?viewportTop:null);
		};
		body.append(excerptButton);
		const bookmarkButton = el("button", "bookmark-button", doc.readingPosition === s.id ? "已标记阅读位置" : "读到这里");
		bookmarkButton.setAttribute("aria-pressed", String(doc.readingPosition === s.id));
		bookmarkButton.onclick = () => {
   if(!contentIngressAllowed(doc)||active()!==doc)return;
   const viewportTop=row.classList.contains('short-cue')?row.getBoundingClientRect().top:null;
			doc.readingPosition = s.id;
			queueDocument(doc);
			render();
   // Rendering replaces the focused control; keep keyboard readers at this cue.
   const target = [...$("transcript").querySelectorAll(".segment")].find(item => item.dataset.segmentId === s.id);
   focusCueAction(target?.querySelector(".bookmark-button"),viewportTop);
		};
		body.append(bookmarkButton);
  if(reviewTranslation)body.append(reviewTranslation);
  if(compact){
   const actions=el('div','cue-actions');
   const more=el('details','cue-more');more.dataset.cueKey=JSON.stringify([doc.key,s.id]);
   const summary=el('summary','',[repeating?.id===s.id?'循环中':'',s.saved_excerpt===true?'已摘录':'','更多'].filter(Boolean).join(' · '));
   summary.dataset.cueTime=Coconut.time(s.start);
   const repeat=meta.querySelector('.repeat-button');
   summary.setAttribute('aria-label',summary.dataset.cueTime+' · '+summary.textContent+'：修正、摘录、阅读位置'+(repeat?'与循环回听':''));
   more.append(summary,edit,excerptButton,bookmarkButton);
   if(reviewTranslation)more.append(reviewTranslation);
   if(repeat)more.append(repeat);
   more.open=openCueActions.has(more.dataset.cueKey);
   actions.append(button);if(contextButton)actions.append(contextButton);actions.append(more);body.append(actions);
  }
		if (Coconut.hasNoteContent(doc.notes[s.id])) body.append(highlightedText("p", "saved-note", doc.notes[s.id], query));
		row.append(meta, body);
		$("transcript").append(row);
	}
	if (!filtered.length)
		$("transcript").append(el("p", "hint", excerptsOnly && !query ? "还没有摘录。回到全文，点击「摘录整段」留下值得重读的原话，不必先写笔记。" : notesOnly && !query ? "还没有笔记。回到全文，在想停下来的片段旁记一笔。" : "没有匹配的片段，试试另一个词。"));
	if (filtered.length > PAGE_SIZE) {
		const navigation = el("nav", "reading-pages");
		navigation.setAttribute("aria-label", "文字稿分页");
		const previous = el("button", "", "前面的片段");
		previous.id = "previous-page";
		previous.disabled = pageStart === 0;
		previous.onclick = () => changeReadingPage(-1);
		const position = el("span", "hint", `${pageStart + 1}–${pageStart + visible.length} / ${filtered.length} 段`);
		position.setAttribute("role", "status");
		const next = el("button", "", "继续阅读后面的片段");
		next.id = "next-page";
		next.disabled = pageStart + PAGE_SIZE >= filtered.length;
		next.onclick = () => changeReadingPage(1);
		navigation.append(previous, position, next);
		$("transcript").append(navigation);
	}
 renderSummary();
 renderPassages(doc);
 applyReadingMode();
 pauseBoundedForCompactNote();
 if(cueFocus){
  const disclosure=[...document.querySelectorAll('.cue-more')].find(node=>node.dataset.cueKey===cueFocus.key);
  focusCueAction(disclosure?.querySelector(cueFocus.selector));
 }
	highlightPlayback();
	window.dispatchEvent(new Event("coconut-render"));
}
function changeReadingPage(direction) {
	pageStart = Math.max(0, pageStart + direction * PAGE_SIZE);
	selected = null;
	render();
	// Replacing a page removes its controls: move focus into the new content
	// rather than dropping keyboard users back to the top of the document.
	const row = $("transcript").querySelector(".segment");
	row?.scrollIntoView?.({block: "start"});
	row?.focus({preventScroll: true});
}
function playbackSegment() {
 const player=$("source-media").querySelector("audio,video");
 const segments=active()?.segments;
 if(!player||!segments)return undefined;
 if(playbackIndex?.segments!==segments)playbackIndex={segments,index:Coconut.createPlaybackIndex(segments)};
 const preview=passagePlayback?.getState();
 const offset=preview?.range?.id==='media-timing-preview'&&timingPreview?.doc===active()&&timingPreview?.attachment===timingAttachment()?timingPreview.offset:timingOffset();
 return playbackIndex.index.find(player.currentTime-offset);
}
function highlightPlayback() {
 const segment=playbackSegment();
 for(const span of $("passage-body").querySelectorAll(".passage-cue"))span.classList.toggle("passage-current",span.dataset.cueId===segment?.id);
 for(const row of $("transcript").querySelectorAll(".segment")) row.classList.toggle("playing",row.dataset.segmentId===segment?.id);
}
$("locate-playback").onclick=()=>locateReadingPlayback();
$("add-content").onclick = () => { if(libraryMobile.matches)$("toggle-library").setAttribute("aria-expanded","false"); showWorkspace("add"); ($("video-url")).focus(); };
 document.querySelector('.brand').onclick=event=>{event.preventDefault();if(libraryMobile.matches)$('toggle-library').setAttribute('aria-expanded','false');showWorkspace('add');$('sample').focus();};
 $('demo-finish').onclick=()=>$('add-content').click();
 $('toggle-demo-tools').onclick=()=>{
  demoToolsExpanded=!demoToolsExpanded;
  if(!demoToolsExpanded){$('language-panel').open=false;$('reading-settings').open=false;}
  render();
  if(demoToolsExpanded)$('search').focus();else $('toggle-demo-tools').focus();
 };
 $('demo-note').onclick=()=>{const id=active()?.segments[0]?.id;if(!id)return;goToSegment(id);$('transcript').querySelector('.note-button')?.click();};
 $('reading-jump').onchange=()=>{const id=$('reading-jump').value;if(id)goToSegment(id);};
$("back-reading").onclick = () => showWorkspace("read");
$("show-jobs").onclick = () => { showWorkspace("add"); $("jobs-heading").scrollIntoView?.(); };
$("toggle-library").onclick = toggleLibraryBrowsing;
$("library-search").oninput = renderLibrary;
$("library-kind").onchange=renderLibrary;
$("library-scope").onchange=renderLibrary;
try{const order=localStorage.getItem('coconut-library-sort-v1');if(['added','title','duration'].includes(order))$('library-sort').value=order;}catch{}
$('library-sort').onchange=()=>{renderLibrary();try{localStorage.setItem('coconut-library-sort-v1',$('library-sort').value);}catch{notice('本次排序已应用，但浏览器未保存偏好。');}};

$('speaker-filter').onchange=()=>{clearReadingContext();speakerFilter=$('speaker-filter').value==='all'?null:JSON.parse($('speaker-filter').value);pageStart=0;searchFocusedId=null;render();};
$("filter-all").onclick = () => { clearReadingContext(); notesOnly = false; excerptsOnly = false; speakerFilter=null; pageStart = 0; render(); };
$("filter-excerpts").onclick = () => { clearReadingContext(); excerptsOnly = true; notesOnly = false; pageStart = 0; render(); };
$("filter-notes").onclick = () => { clearReadingContext(); notesOnly = true; excerptsOnly = false; pageStart = 0; render(); };
$("clear-search").onclick = () => { clearReadingContext(); $("search").value = ""; notesOnly = false; excerptsOnly = false; speakerFilter=null; pageStart = 0; render(); $("search").focus(); };
$("close-note").onclick = () => {
	const id = selected;
	selected = null;
	render();
	const row = [...$("transcript").querySelectorAll(".segment")].find(row => row.dataset.segmentId === id);
	(row?.querySelector(".note-button") || $("filter-notes")).focus();
};
$("return-excerpt").onclick = () => goToSegment(selected,false,!!passageReturn);
document.addEventListener("keydown", event => {
	if (event.key === "Escape" && selected && !$("export-menu").open && !document.querySelector("dialog[open]")) $("close-note").click();
});
$("import").onclick = () => $("file").click();
$("file").onchange = async () => {
	const files=Array.from($("file").files),f=files[0];
	if (!f) return;
 if(files.length>1)return importTranscriptFiles(files);
 const revision = cancelLocalImports("file"), lifecycleRevision=documentLifecycleRevision;
 transcriptImportBatch=null;$("transcript-import-results").hidden=true;
 const startingDocument = state.active, startingWorkspace = workspace;
 const ownsRequest = () => revision === localImportRevision;
 const canCommit = () => contentIngressAllowed() && ownsRequest() && state.active === startingDocument && workspace === startingWorkspace;
	try {
  const review=localFileReview(f,canCommit);
  if(review!==true&&!(await review))return;
  if(!canCommit())return;
		const text = await f.text();
  if(!canCommit())return;
		const parsed=Coconut.parse(text,f.name);
  // Exported JSON carries a stable key which validate intentionally omits.
  // Retain it only as async ownership evidence, never as an imported new key.
  let sourceKey;try{const raw=JSON.parse(text);if(typeof raw?.key==='string'&&raw.key.length<=200)sourceKey=raw.key;}catch{}
  const saved = await add(parsed,canCommit,false,lifecycleRevision,sourceKey);
		if (saved.ok && ownsRequest() && active()===saved.identity) notice("已导入并保存在本机浏览器。没有向服务器上传文件。", "success");
	} catch (e) {
		if(canCommit())notice("导入失败：" + localFileError(e));
	} finally {
		if(ownsRequest())$("file").value = "";
	}
};
// A batch owns its files, not the reader. Each file awaits its actual save
// receipt before the next read, retaining successful identities after failure
// or cancellation without accumulating file contents or imposing a batch cap.
function stopTranscriptImportBatch(){
 const batch=transcriptImportBatch;if(!batch||batch.finished||batch.cancelled)return;
 batch.cancelled=true;
 for(const item of batch.items)if(item.status==='queued')item.status='cancelled';
 renderTranscriptImportBatch(batch);
}
function renderTranscriptImportBatch(batch){
 if(transcriptImportBatch!==batch)return;
 const labels={queued:'等待导入',review:'等待确认大文件',reading:'读取中',saving:'校验并保存中',saved:'已保存',duplicate:'书架已有，未重复添加',unsaved:'仅在本页，尚未保存。请重试保存或导出备份',failed:'导入失败',skipped:'已跳过，未读取',cancelled:'未导入，已停止'};
 const counts={};for(const item of batch.items){
  // Results are navigation handles, never a second hidden removal archive.
  if(item.identity&&!state.documents.includes(item.identity))item.identity=null;
  counts[item.status]=(counts[item.status]||0)+1;
  if(item.row.dataset.status!==item.status)item.row.dataset.status=item.status;
  const readable=['saved','duplicate','unsaved'].includes(item.status),available=state.documents.includes(item.identity)&&!pendingStructuralDocuments.has(item.identity?.key);
  const label=readable&&!available?'这份内容已移除或正在恢复，请在书架确认':labels[item.status]+(item.error?'：'+item.error:'');
  if(item.result.textContent!==label)item.result.textContent=label;
  item.open.hidden=!readable||!available;
 }
 const pending=(counts.review||0)+(counts.reading||0)+(counts.saving||0),done=batch.items.length-(counts.queued||0)-pending;
 const parts=[batch.finished?(batch.cancelled?'已停止导入':'导入完成'):batch.cancelled?'已停止后续文件，等待当前文件确认':'正在导入',done+' / '+batch.items.length+' 个文件'];
 for(const [status,label] of [['saved','已保存'],['duplicate','已有'],['failed','失败'],['skipped','跳过'],['unsaved','未保存'],['cancelled','未导入']])if(counts[status])parts.push(label+' '+counts[status]);
 $('transcript-import-progress').textContent=parts.join(' · ');
 $('stop-transcript-import').hidden=batch.finished||batch.cancelled;
}
window.addEventListener('coconut-persistence-change',()=>{
 const batch=transcriptImportBatch;if(!batch)return;
 for(const item of batch.items){
  if(item.status!=='unsaved'||!state.documents.includes(item.identity))continue;
  const saved=libraryStore.status(item.identity.key);
  if(saved?.identity===item.identity&&saved.status==='saved')item.status=item.duplicate?'duplicate':'saved';
 }
 renderTranscriptImportBatch(batch);
});
function openTranscriptImportResult(item){
 const doc=item.identity;
 if(!state.documents.includes(doc)||pendingStructuralDocuments.has(doc?.key)){
  item.result.textContent='这份内容已移除或正在恢复，请在书架确认';item.open.hidden=true;return;
 }
 resetReaderForDocumentNavigation();selectActiveDocument(doc.key);
 setReadingMode(prefersPassageReading(doc)?'passages':'summary');
 $('toggle-library').setAttribute('aria-expanded','false');showWorkspace('read');render();
 const bookmark=doc.segments.find(cue=>cue.id===doc.readingPosition);
 if(bookmark){if(prefersPassageReading(doc))openPassage(bookmark.id);else goToSegment(bookmark.id);}
 else{$('title').scrollIntoView?.({block:'start'});$('reader-workspace').focus({preventScroll:true});}
}
async function importTranscriptFiles(files){
 const revision=cancelLocalImports('file'),lifecycleRevision=documentLifecycleRevision;
 const startingDocument=state.active,startingWorkspace=workspace,selectionRevision=activeSelectionRevision;
 const ownsRequest=()=>revision===localImportRevision;
 const batch={items:[],cancelled:false,finished:false};transcriptImportBatch=batch;
 const canCommit=()=>!batch.cancelled&&ownsRequest()&&contentIngressAllowed()&&state.active===startingDocument&&workspace===startingWorkspace&&activeSelectionRevision===selectionRevision;
 $('transcript-import-list').replaceChildren();$('transcript-import-results').hidden=false;
 for(const file of files){
  const row=el('li','transcript-import-item'),result=el('span','transcript-import-outcome'),open=el('button','','阅读');open.type='button';
  const item={status:'queued',row,result,open,identity:null};open.hidden=true;open.onclick=()=>openTranscriptImportResult(item);
  open.setAttribute('aria-label','阅读 '+file.name);row.append(el('span','transcript-import-name',file.name),result,open);
  batch.items.push(item);$('transcript-import-list').append(row);
 }
 $('stop-transcript-import').onclick=()=>{if(transcriptImportBatch===batch)cancelLocalImports();};
 renderTranscriptImportBatch(batch);
 try{
  for(const [index,file] of files.entries()){
   const item=batch.items[index];if(!canCommit())break;
   try{
    item.status='review';renderTranscriptImportBatch(batch);
    const review=localFileReview(file,canCommit,false,true);
    if(review!==true&&!(await review)){item.status=canCommit()?'skipped':'cancelled';renderTranscriptImportBatch(batch);continue;}
    if(!canCommit()){item.status='cancelled';break;}
    item.status='reading';renderTranscriptImportBatch(batch);
    const text=await file.text();if(!canCommit()){item.status='cancelled';break;}
    const parsed=Coconut.parse(text,file.name);
    let sourceKey;try{const raw=JSON.parse(text);if(typeof raw?.key==='string'&&raw.key.length<=200)sourceKey=raw.key;}catch{}
    item.status='saving';renderTranscriptImportBatch(batch);
    const receipt=await add(parsed,canCommit,false,lifecycleRevision,sourceKey,{activate:false});
    item.identity=receipt.identity;item.duplicate=receipt.duplicate;
    item.status=receipt.ok?(receipt.duplicate?'duplicate':'saved'):'unsaved';
    if(!receipt.ok){stopTranscriptImportBatch();break;}
   }catch(error){item.status=canCommit()?'failed':'cancelled';if(item.status==='failed')item.error=localFileError(error);}
   renderTranscriptImportBatch(batch);
  }
 }finally{
  for(const item of batch.items)if(['queued','review','reading','saving'].includes(item.status))item.status='cancelled';
  if(batch.items.some(item=>item.status==='cancelled'))batch.cancelled=true;
  batch.finished=true;renderTranscriptImportBatch(batch);
  if(ownsRequest())$('file').value='';
 }
}
$("search").oninput = () => {
 clearReadingContext();
 searchFocusedId=null;
	pageStart = 0;
	render();
};
$("note").oninput = () => {
 const doc=active(),id=selected;if(!doc||!id||!doc.segments.some(segment=>segment.id===id))return;
 if(deferContentInput(doc,$('note'),doc.notes[id]||'',value=>applyCueNote(doc,id,value)))return;
 applyCueNote(doc,id,$('note').value);
};
function applyCueNote(d,id,value){
 if(!contentIngressAllowed(d)||!d.segments.some(segment=>segment.id===id))return;
 {
  const segment=d.segments.find(item=>item.id===id),query=$('search').value;
  const matched=segment&&matchesReadingSegment(segment,d,query);
		d.notes[id] = value;
		queueDocument(d);
  if(active()!==d)return;
  // Reconcile membership while typing, but keep the mounted editor/caret even
  // if its cue no longer matches. Never replace pointer targets on blur.
  if(segment&&matched!==matchesReadingSegment(segment,d,query)){
   render({keepNoteEditor:true});return;
  }
		$("note-count").textContent = String(Coconut.segmentNoteCount(d));
		renderLibrary();
		renderNotebookAction(d);
		// Keep pointer targets mounted while focus leaves the note editor.
		// Re-rendering on blur swallows the subsequent click on another row.
		const row = [...$("transcript").querySelectorAll(".segment")].find(
			(item) => item.dataset.segmentId === id,
		);
		if (row) {
			row.querySelector(".note-button").textContent = Coconut.hasNoteContent(d.notes[id]) ? "编辑笔记" : "＋ 记一笔";
			let preview = row.querySelector(".saved-note");
			if (Coconut.hasNoteContent(d.notes[id])) {
				if (!preview) {
					preview = el("p", "saved-note");
					row.lastElementChild.append(preview);
				}
				preview.textContent = d.notes[id];
			} else if (preview) preview.remove();
		}
	}
}
$("source").onclick = () => {
	if (!active()) {
		notice("请先导入文字稿");
		return;
	}
	sourceTarget = active().key;sourceTargetIdentity=active();
	$("source-url").value = active().source_url;
	$("source-error").textContent = "";
	$("source-dialog").showModal();
};
$("save-source").onclick = (e) => {
	e.preventDefault();
	const url = $("source-url").value.trim();
	if (url && !Coconut.source(url, 0)) {
		$("source-error").textContent = "请填写有效的 YouTube、Bilibili 或 X 视频链接";
		return;
	}
	const doc = state.documents.find((d) => d.key === sourceTarget);
	if (!doc || doc!==sourceTargetIdentity || !contentIngressAllowed(doc)) {
		$("source-error").textContent = "原文字稿已不可用，请重新打开来源设置";
		return;
	}
	doc.source_url = url;
	queueDocument(doc);
	$("source-dialog").close();
	render();
};
function renderNotebookAction(doc) {
	const count = Coconut.projectAnnotationCount(doc)+Coconut.notebookSegments(doc).length;
	$("export-notebook").disabled = count === 0;
	$("export-notebook").textContent = Coconut.isAudioProject(doc)?"导出原声项目笔记（"+count+" 项）":"导出阅读笔记（" + count + (Coconut.hasProjectAnnotations(doc)?" 项）":" 段）");
}
// Drafts belong to a document, not to the currently rendered form. Keep them
// in memory across navigation/search; only a successful save writes to storage.
function captureAudioBookmarkDrafts() {
 const documents=new Map(state.documents.map(doc=>[doc.key,doc]));
 const key=$('audio-project').dataset.documentKey;
 const doc=documents.get(key);
 if(Coconut.hasProjectAnnotations(doc)){
  const draft=audioBookmarkDrafts.get(key)||{time:'',note:'',edits:new Map()};
  const bookmarks=new Map(doc.timestamp_bookmarks.map(item=>[item.id,item]));
  draft.time=$('audio-bookmark-time').value;draft.note=$('audio-bookmark-note').value;
  for(const form of document.querySelectorAll('#audio-bookmarks form')){
   const id=form.parentElement.dataset.bookmarkId,original=bookmarks.get(id);
   const value=form.querySelector('input').value;
   if(original&&!form.hidden&&Coconut.parseReadingTime(value)!==original.time)draft.edits.set(id,value);
   else draft.edits.delete(id);
  }
  audioBookmarkDrafts.set(key,draft);
 }
 for(const [key,draft] of audioBookmarkDrafts){
  const doc=documents.get(key);
  // Removal saves transactionally: missing documents can still be rolled back.
  // Confirmed removal explicitly moves its draft into the one-slot recovery.
  if(!doc)continue;
  const bookmarks=new Map((doc.timestamp_bookmarks||[]).map(item=>[item.id,item]));
  for(const [id,value] of draft.edits){
   const original=bookmarks.get(id);
   if(!original||Coconut.parseReadingTime(value)===original.time)draft.edits.delete(id);
  }
  if(!doc||(!draft.time.trim()&&!draft.note.trim()&&!draft.edits.size))audioBookmarkDrafts.delete(key);
 }
}
function renderAudioProject(doc) {
 captureAudioBookmarkDrafts();
 const draft=audioBookmarkDrafts.get(doc.key);
 const panel=$('audio-project'),audioOnly=Coconut.isAudioProject(doc);
 $('audio-project-heading').textContent=audioOnly?'先留下声音和想法':'项目笔记与时间书签';
 $('audio-project-boundary').textContent=audioOnly?'尚未导入文字稿，没有可生成摘要的原文。项目笔记和时间书签只记录你的想法，不会作为原文发送给 AI。':'已补充文字稿。以下项目笔记和时间书签仍是你的记录，不是原文，不会加入发送给 AI 的原文范围。';
 $('attach-project-transcript').hidden=!audioOnly;$('attach-project-help').hidden=!audioOnly;
 if(panel.dataset.documentKey!==doc.key){
  panel.dataset.documentKey=doc.key;$('audio-bookmark-form').reset();$('audio-bookmark-time').value=draft?.time||'';$('audio-bookmark-note').value=draft?.note||'';$('audio-bookmark-search').value='';$('audio-project-status').textContent='';
 }
 $('project-note').value=doc.project_note;
 const host=$('audio-bookmarks');host.replaceChildren();
 if(!doc.timestamp_bookmarks.length)host.append(el('p','hint','还没有时间书签。播放时可以填入当前时间，也可以手动记录。'));
 const query=$('audio-bookmark-search').value.trim().toLocaleLowerCase();
 const bookmarks=doc.timestamp_bookmarks.filter(item=>!query||[item.note,Coconut.time(item.time),String(item.time)].some(value=>value.toLocaleLowerCase().includes(query)));
 $('audio-bookmark-results').textContent=query?'找到 '+bookmarks.length+' / '+doc.timestamp_bookmarks.length+' 个时间书签':'共 '+bookmarks.length+' 个时间书签';
 if(query&&!bookmarks.length)host.append(el('p','hint','没有匹配的书签，请清除或更换关键词。'));
 for(const item of bookmarks){
  const row=el('section','audio-bookmark');row.dataset.bookmarkId=item.id;
  const ownsBookmark=()=>active()===doc&&doc.timestamp_bookmarks.includes(item)&&contentIngressAllowed(doc);
  const seek=el('button','',Coconut.time(item.time)+' · 定位原声');
  seek.onclick=()=>{
   if(!ownsBookmark())return;
   const player=$('source-media').querySelector('audio,video');
   if(!player||!Number.isFinite(player.duration)||player.duration<=0){$('audio-project-status').textContent='请先单独获取原声，或选择对应的本地文件，等加载完成后再定位。';return;}
   if(item.time>player.duration){$('audio-project-status').textContent='书签超出当前媒体范围，请核对是否选择了对应文件。';return;}
   try{passagePlayback?.cancel();stopRepeating();player.currentTime=item.time;takeListeningOwnership();$('audio-project-status').textContent='已定位到 '+Coconut.time(item.time)+'；未自动播放。';}
   catch{$('audio-project-status').textContent='媒体暂时无法定位，书签仍然保留。';}
  };
  const input=el('textarea');input.rows=2;input.value=item.note;input.setAttribute('aria-label',Coconut.time(item.time)+' 的书签笔记');
  const applyBookmarkNote=value=>{if(!contentIngressAllowed(doc)||!doc.timestamp_bookmarks.includes(item))return;if(!allowAudioNoteChange(doc,item.note,value,10000)){if(input.isConnected)input.value=item.note;return;}item.note=value;queueDocument(doc);if(active()===doc){renderLibrary();renderNotebookAction(doc);}};
  input.oninput=()=>{if(active()!==doc||!doc.timestamp_bookmarks.includes(item))return;if(deferContentInput(doc,input,item.note,applyBookmarkNote))return;applyBookmarkNote(input.value);};
  const remove=el('button','','删除书签');remove.onclick=()=>{
   if(!ownsBookmark())return;
   doc.timestamp_bookmarks=doc.timestamp_bookmarks.filter(bookmark=>bookmark.id!==item.id);queueDocument(doc);renderAudioProject(doc);renderLibrary();renderNotebookAction(doc);$('audio-bookmark-time').focus();
  };
  const edit=el('button','','修正书签时间'),form=el('form'),timeInput=el('input'),apply=el('button','','保存时间'),cancel=el('button','','取消修正'),error=el('p','hint');
  edit.className='edit-bookmark-time';form.hidden=true;timeInput.value=String(item.time);timeInput.setAttribute('aria-label','修正书签时间（秒、分:秒或时:分:秒）');timeInput.inputMode='decimal';apply.type='submit';cancel.type='button';error.setAttribute('role','status');
  if(draft?.edits.has(item.id)){form.hidden=false;timeInput.value=draft.edits.get(item.id);}
  edit.onclick=()=>{if(!ownsBookmark())return;if(form.hidden){form.hidden=false;timeInput.value=String(item.time);error.textContent='';}timeInput.focus();};
  cancel.onclick=()=>{if(!ownsBookmark())return;form.hidden=true;edit.focus();};
  form.onsubmit=async event=>{
   event.preventDefault();if(!ownsBookmark())return;
   const next=Coconut.parseReadingTime(timeInput.value);
   if(next===null||next>604800){error.textContent='请输入最长7天的有效时间，原书签未改变。';return;}
   item.time=next;form.hidden=true;doc.timestamp_bookmarks.sort((a,b)=>a.time-b.time);const receipt=commitDocument(doc);renderAudioProject(doc);renderNotebookAction(doc);
   ([...host.children].find(element=>element.dataset.bookmarkId===item.id)?.querySelector('.edit-bookmark-time')||$('audio-bookmark-search')).focus();
   const persisted=await receipt;
   if(ownsBookmark()&&item.time===next&&libraryStore.status(doc.key)?.generation===persisted.generation)$('audio-project-status').textContent=persisted.ok?'书签时间已更新，笔记保留。':'书签时间仅在本页，请立即导出 JSON 备份。';
  };
  form.append(timeInput,apply,cancel,error);row.append(seek,input,remove,edit,form);host.append(row);
 }
}
function allowAudioNoteChange(doc,previous,value,limit){
 if(value.length>limit||Coconut.audioNoteCharacters(doc)-previous.length+value.length>Coconut.AUDIO_NOTE_BUDGET){
  $('audio-project-status').textContent='本次修改超过笔记容量，已保留原内容。项目笔记最多100,000字符，每则书签10,000字符，所有笔记合计1,000,000字符；请先备份并整理。';return false;
 }
 return true;
}
$('cancel-audio-bookmark').onclick=()=>{$('audio-bookmark-form').reset();captureAudioBookmarkDrafts();$('audio-project-status').textContent='已取消未保存的时间书签。';$('audio-bookmark-time').focus();};
$('audio-bookmark-search').oninput=()=>{const doc=active();if(Coconut.hasProjectAnnotations(doc))renderAudioProject(doc);};
function applyProjectNote(doc,value){
 if(!contentIngressAllowed(doc)||!Coconut.hasProjectAnnotations(doc))return;
 if(!allowAudioNoteChange(doc,doc.project_note,value,100000)){if(active()===doc)$('project-note').value=doc.project_note;return;}
 doc.project_note=value;queueDocument(doc);if(active()===doc){renderLibrary();renderNotebookAction(doc);}
}
$('project-note').oninput=()=>{
 const doc=active();if(!Coconut.hasProjectAnnotations(doc))return;
 const input=$('project-note');if(deferContentInput(doc,input,doc.project_note,value=>applyProjectNote(doc,value)))return;
 applyProjectNote(doc,input.value);
};
$('use-playback-time').onclick=()=>{
 const player=$('source-media').querySelector('audio,video');if(!player||!Number.isFinite(player.currentTime))return;
 $('audio-bookmark-time').value=String(Math.floor(player.currentTime*1000)/1000);$('audio-bookmark-note').focus();
};
$('audio-bookmark-form').onsubmit=async event=>{
 event.preventDefault();const doc=active();if(!Coconut.hasProjectAnnotations(doc)||!contentIngressAllowed(doc))return;
 const seconds=Coconut.parseReadingTime($('audio-bookmark-time').value);
 if(seconds===null||seconds>604800){$('audio-project-status').textContent='请输入有效的秒数、分:秒或时:分:秒，最长7天。';return;}
 if(doc.timestamp_bookmarks.length>=2000){$('audio-project-status').textContent='已达到2,000个时间书签上限，请先备份和整理。';return;}
 const note=$('audio-bookmark-note').value;if(!allowAudioNoteChange(doc,'',note,10000))return;
 doc.timestamp_bookmarks.push({id:crypto.randomUUID(),time:seconds,note});
 doc.timestamp_bookmarks.sort((a,b)=>a.time-b.time);
 const receipt=commitDocument(doc);$('audio-bookmark-form').reset();renderAudioProject(doc);renderLibrary();renderNotebookAction(doc);$('audio-bookmark-time').focus();
 const persisted=await receipt;
 if(active()===doc&&contentIngressAllowed(doc)&&libraryStore.status(doc.key)?.generation===persisted.generation)$('audio-project-status').textContent=persisted.ok?'时间书签已保存，可导出 JSON 备份。':'书签仅在本页，尚未保存成功，请立即导出 JSON 备份。';
};
$("export-notebook").onclick = () => {
	const doc = active();
	if (!doc || (!Coconut.projectAnnotationCount(doc)&&!Coconut.notebookSegments(doc).length)) {
		notice("先摘录一段原话，或写一则笔记，再导出阅读笔记。");
		return;
	}
	let url, link;
	try {
		const blob = new Blob([Coconut.notebookMarkdown(doc)], {type: "text/markdown;charset=utf-8"});
		url = URL.createObjectURL(blob);
		link = el("a"); link.href = url;
		link.download = doc.title.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "_") + ".notes.md";
		link.hidden = true; document.body.append(link); link.click();
		notice(Coconut.isAudioProject(doc)?"已发起项目笔记下载，包含项目笔记与时间书签；没有文字稿或摘要。完整恢复请使用 JSON 备份。":"已发起 Markdown 下载，包含本篇全部摘录与笔记。请检查浏览器下载记录；完整恢复仍需 JSON 备份。", "success");
	} catch {
		notice("阅读笔记导出失败，摘录与笔记仍在本页。请重试，暂时不要关闭页面。");
	} finally {
		link?.remove();
		if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
	}
};
$("export").onclick = () => {
	const d = active();
	if (!d) {
		notice("书架还是空的，先导入一份内容吧");
		return;
	}
	let url;
	let link;
	try {
		const blob = new Blob([JSON.stringify(d, null, 2)], {
			type: "application/json",
		});
		url = URL.createObjectURL(blob);
		link = el("a");
		link.href = url;
		link.download = d.title.replace(/[\\/:*?"<>|]/g, "_") + ".coconut.json";
		link.hidden = true;
		document.body.append(link);
		link.click();
		// A click requests a download; only the user/browser can confirm disk persistence.
		notice((Coconut.isAudioProject(d)?"已发起项目备份下载，包含来源、项目笔记与时间书签，不包含媒体。请检查下载记录并确认保存。":"已发起完整 JSON 备份下载，请检查下载记录并确认保存；包含原稿、修正、摘录、笔记、译文与 AI 记录及依据，不包含媒体。")+backupRecoveryHint(blob), "success");
	} catch {
		notice("备份导出失败，文字稿与笔记仍保留在本页。请重试，暂时不要关闭页面。");
	} finally {
		if (link) link.remove();
		// Give the browser time to consume the object URL before releasing it.
		if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
	}
};
$("sample").onclick = async () => {
 if($('sample').disabled)return;
 cancelLocalImports();
 $('sample').disabled=true;
 try {
 const demo={
		schema_version: 1,
		title: "把好想法，变成自己的想法",
  language: "en",
  translation_view: "zh",
  provenance: {kind: "authored_demo"},
		source_url: "",
		segments: [
			{
				id: "demo-1",
				start: 0,
				end: 18,
				text: "A good idea does not always arrive as an answer. Sometimes it begins with a sentence you want to read twice.",
				speaker: "",
			},
			{
				id: "demo-2",
				start: 18,
				end: 42,
				text: "Keep the sentence. Add one line in your own words. Later, that note can remind you why it mattered to you.",
				speaker: "",
			},
			{
				id: "demo-3",
				start: 42,
				end: 68,
				text: "A timestamp is a way back, not a verdict. When a detail matters, return to the original voice before turning it into a conclusion.",
				speaker: "",
			},
		],
 };
 const translations=[
  '好想法，不一定以答案的样子出现。有时，它只是一句话，让你忍不住读第二遍。',
  '先留下那句话，再用自己的话写一行。下次回来，这一行会提醒你：当时为什么被它打动。',
  '时间戳是一条回去的路，不是结论。重要的细节，先回到原声核对，再把它变成自己的理解。'
 ];
 demo.segments.forEach((segment,index)=>{segment.translations={zh:{text:translations[index],source_text:segment.text,source_language:'en',document_language:'en',provider:'Coconut 自写示例译文'}};});
 const result=await add(Coconut.validate(demo)),doc=result.identity;
 // A delayed receipt cannot redirect or modify the user's newer selection.
 if(active()!==doc||!contentIngressAllowed(doc))return;
 if(doc.translation_view!=='zh'){doc.translation_view='zh';queueDocument(doc);}demoToolsExpanded=false;
 setReadingMode('transcript');render();
 $('title').scrollIntoView?.({block:'start'});
 } catch(error){notice('示例打开失败：'+error.message);}
 finally{$('sample').disabled=false;}
};
if(prefersPassageReading(active()))readingMode='passages';
render();

$("save-edit").onclick = (event) => {
	event.preventDefault();
	const doc =
		editingTarget &&
		state.documents.find((d) => d.key === editingTarget.documentKey);
	const segment =
		doc && doc.segments.find((s) => s.id === editingTarget.segmentId);
	const text = $("edit-segment").value.trim();
	if (!segment || !text || doc!==editingTarget.identity || !contentIngressAllowed(doc)) {
		$("edit-error").textContent = "文字不能为空";
		return;
	}
	if (segment.original_text === undefined) segment.original_text = segment.text;
	segment.text = text;
 Coconut.invalidateSearch(doc);
	queueDocument(doc);
	$("edit-dialog").close();
	render();
	// Rendering replaces the dialog’s original opener. Restore the reader’s
	// keyboard position even when the correction no longer matches the search.
	const rows = [...$("transcript").querySelectorAll(".segment")];
	const target = doc.key === active()?.key ? (rows.find(row => row.dataset.segmentId === segment.id)
		|| rows[Math.min(editingTarget.position, rows.length - 1)]) : null;
	focusCueAction(target?.querySelector(".edit-button") || $("search"));
};
$("restore-edit").onclick = (event) => {
	event.preventDefault();
	const doc =
		editingTarget &&
		state.documents.find((d) => d.key === editingTarget.documentKey);
	const segment =
		doc && doc.segments.find((s) => s.id === editingTarget.segmentId);
	if (segment && segment.original_text !== undefined) {
		$("edit-segment").value = segment.original_text;
		$("edit-error").textContent = "原稿已填入，点击保存后生效";
	}
};

window.addEventListener("coconut-worker-ready", event => {
	mediaWorkerReady = event.detail?.media_import !== false;
	render();
});

// Library restore is additive: a conflicting version becomes another document.
$("export-library").onclick = () => {
 let url, link;
 try {
  const backup = {format:"coconut-library", version:1, documents:state.documents, active:state.active};
  const blob = new Blob([JSON.stringify(backup, null, 2)], {type:"application/json"});
  url = URL.createObjectURL(blob);
  link = el("a"); link.href=url; link.download="coconut-library.json"; link.hidden=true; document.body.append(link); link.click();
  notice("已发起整个书架的完整 JSON 备份下载，请确认文件已保存；包含文字、笔记、译文与 AI 记录及依据，不包含媒体文件。"+backupRecoveryHint(blob), "success");
 } catch { notice("书架备份失败，内容仍在本页，请重试后再关闭。"); }
 finally { link?.remove(); if(url)setTimeout(()=>URL.revokeObjectURL(url),60000); }
};
$("restore-library").onclick = () => $("library-file").click();
$("library-file").onchange = async () => {
 const file = $("library-file").files[0]; if(!file)return;
 const revision = cancelLocalImports("library-file"), lifecycleRevision=documentLifecycleRevision;
 const startingDocument = state.active, startingWorkspace = workspace;
 const ownsRequest = () => revision === localImportRevision;
 const canCommit = () => contentIngressAllowed() && ownsRequest() && state.active === startingDocument && workspace === startingWorkspace;
 try {
  const review=localFileReview(file,canCommit,true);
  if(review!==true&&!(await review))return;
  if(!canCommit())return;
  const text = await file.text();
  if(!canCommit())return;
  const backup = JSON.parse(text);
  // Validate first, then await only small identity checks. Merge the latest state
  // after those awaits so unrelated in-page edits are never overwritten.
  Coconut.mergeLibraryBackup(state,backup);
  let checkedRevision;
  do{
   checkedRevision=documentLifecycleRevision;
   for(const doc of backup.documents)if(await wasRemovedSince(doc,lifecycleRevision))throw new Error("读取备份期间有内容被移除，本次恢复已取消；如需重新恢复，请再次选择备份");
   if(!canCommit())return;
   // A later document's digest may have yielded while an earlier one was removed.
   // Recheck the batch at one stable lifecycle revision before the synchronous merge.
  }while(checkedRevision!==documentLifecycleRevision);
  const existing=new Set(state.documents),restored=Coconut.mergeLibraryBackup(state,backup),added=restored.documents.filter(doc=>!existing.has(doc));
 if(added.some(doc=>pendingStructuralDocuments.has(doc.key)))throw new Error('文档正在移除或恢复，请稍候重试');
  // An empty restore stays in Add without looking like new navigation on render.
  clearReadingContext();
  state = restored; selectActiveDocument(restored.active); selected=null; pageStart=0; notesOnly=false; excerptsOnly=false; speakerFilter=null; $("search").value=""; workspace=active()?"read":"add";
  const receipt=commitDocuments(added);render();
  const persisted=await receipt;
  if(persisted.ok && ownsRequest() && state.active===restored.active && workspace===(restored.active?"read":"add"))notice("已恢复 " + added.length + " 份文字稿；相同内容已跳过，不同版本分别保留，原书架未删除。");
 } catch(error) { if(canCommit())notice("恢复失败，原书架未改变："+localFileError(error)); }
 finally { if(ownsRequest())$("library-file").value=""; }
};

$("export-subtitles").onclick = () => {
 const doc=active(); if(!doc)return;
 let url,link;
 try {
  const format=$("subtitle-format").value, bilingual=$("subtitle-bilingual").checked;
  const result=Coconut.subtitleExport(doc,format,bilingual);
  url=URL.createObjectURL(new Blob([result.text],{type:format==="vtt"?"text/vtt;charset=utf-8":"text/plain;charset=utf-8"}));
  link=el("a");link.href=url;link.download=doc.title.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,"_")+"."+format;link.hidden=true;document.body.append(link);link.click();
  notice("已发起整篇字幕下载（"+doc.segments.length+" 段）"+(bilingual?"，附加 "+result.translated+" 段有效译文；缺失或过期译文未导出":"")+"。请确认文件已保存。", "success");
 } catch { notice("字幕导出失败，内容仍在本页，请重试。"); }
 finally {link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);}
};

let detailsTarget=null,detailsTargetIdentity=null,detailsSaveRevision=0;
$("document-details").onclick=()=>{
 const doc=active();if(!doc)return;
 detailsTarget=doc.key;detailsTargetIdentity=doc;$("document-title").value=doc.title;$("details-error").textContent="";
 const language=$("document-language");language.querySelector('[data-custom]')?.remove();
 if(doc.language && ![...language.options].some(o=>o.value===doc.language)){const option=el("option","",doc.language);option.value=doc.language;option.dataset.custom="true";language.append(option);}
 language.value=doc.language||"";$("details-dialog").showModal();
};
$("save-details").onclick=async event=>{
 event.preventDefault();const doc=state.documents.find(d=>d.key===detailsTarget), title=$("document-title").value.trim();
 if(!doc || doc!==detailsTargetIdentity || !contentIngressAllowed(doc) || !title || title.length>200){$("details-error").textContent="请输入1–200字的标题";return;}
 const language=$("document-language").value;
 // Feed/episode metadata is only a hint until real words arrive. Persist an
 // override solely after an actual user language change, never a title edit.
 if(Coconut.isAudioProject(doc)&&language!==doc.language)doc.project_language_override=true;
 doc.title=title;doc.language=language;
 const operation=++detailsSaveRevision,receipt=commitDocument(doc);$("details-dialog").close();render();$("document-details").focus();
 const persisted=await receipt;
 if(persisted.ok&&operation===detailsSaveRevision&&active()===doc&&!$("details-dialog").open&&contentIngressAllowed(doc))notice("文字稿信息已保存；原始来源信息、时间戳和笔记保持不变。", "success");
};

$("time-navigation").onsubmit=event=>{
 event.preventDefault();const doc=active();if(!doc)return;
 const seconds=Coconut.parseReadingTime($("reading-time").value);
 if(seconds===null){$("time-navigation-status").textContent="请输入秒数、分:秒或时:分:秒；秒和小时格式中的分钟须小于60。";return;}
 const segment=Coconut.segmentAtTime(doc,seconds);
 if(!segment){$("time-navigation-status").textContent="该时间超出文字稿范围。";return;}
 goToSegment(segment.id);
 $("time-navigation-status").textContent=seconds<segment.start?"此处没有字幕，已定位下一段 · "+Coconut.time(segment.start):"已定位 · "+Coconut.time(segment.start)+"；未自动播放音视频。";
};

const LAYOUT_KEY="coconut-reading-layout-v1";
function applyReadingLayout(value){
 const layout=["standard","large","spacious"].includes(value)?value:"standard";
 document.documentElement.dataset.readingLayout=layout;$("reading-layout").value=layout;
}
try { applyReadingLayout(localStorage.getItem(LAYOUT_KEY)); } catch { applyReadingLayout("standard"); }
$("reading-layout").onchange=()=>{
 applyReadingLayout($("reading-layout").value);
 try {localStorage.setItem(LAYOUT_KEY,$("reading-layout").value);$("layout-status").textContent="排版已保存在此浏览器";}
 catch {$("layout-status").textContent="本次排版已应用，浏览器未能保存偏好；文字稿不受影响。";}
};

function updatePlaybackControls(){
 const player=$("source-media").querySelector("audio,video");
 $("playback-controls").hidden=!player;
 const seekable=Boolean(player && Number.isFinite(player.duration) && player.duration>0);
 $('use-playback-time').disabled=!seekable;
 $("skip-back").disabled=!seekable;$("skip-forward").disabled=!seekable;
 const actual=player?.playbackRate ?? playbackRate, selector=$("playback-rate");
 selector.querySelector('[data-current]')?.remove();
 if(!PLAYBACK_RATES.includes(actual)){const option=el("option","","当前 "+actual+"×");option.value=String(actual);option.dataset.current="true";selector.append(option);}
 selector.value=String(actual);
 refreshPlaybackDock();
 renderPassagePlayback(passagePlayback?.getState());
}
// Opt-in, page-local following. Media events alone advance the viewport: a save
// receipt may render, but must never acquire scrolling ownership.

function followPlayer(){return $('source-media').querySelector('audio,video');}
function followAvailable(){const p=followPlayer();return !!(p&&!p.error&&Number.isFinite(p.duration)&&p.duration>0&&active()?.segments?.length&&!Coconut.isAudioProject(active()));}
function followOwns(){const f=readingFollow;return !!(f&&f.doc===active()&&f.segments===active()?.segments&&f.player===followPlayer()&&f.src===f.player.getAttribute('src')&&f.source===documentSourceIdentity(active())&&f.attachment===browserMedia.get(active()?.key));}
function cancelFollowFrame(){readingFollowRevision++;if(readingFollowFrame!==null)cancelAnimationFrame(readingFollowFrame);readingFollowFrame=null;}
function refreshReadingFollow(){
 if(readingFollow&&!followOwns()){cancelFollowFrame();readingFollow=null;}
 const available=followAvailable(),f=readingFollow;
 for(const id of ['follow-playback','dock-follow']){
  const button=$(id);if(button.disabled!==!available)button.disabled=!available;
  if(button.getAttribute('aria-pressed')!==String(!!f))button.setAttribute('aria-pressed',String(!!f));
  const state=!f?'off':f.suspended?'suspended':'following';if(button.dataset.state!==state)button.dataset.state=state;
  const label=!available?'跟随不可用':!f?'跟随原声':f.suspended?'恢复跟随':f.player.paused?'跟随待播放':'停止跟随';
  if(button.textContent!==label)button.textContent=label;
  const title=!available?'关联可播放的原声和定时文字稿后可用':f?.suspended?'跟随已暂停：'+f.suspended+'。点击恢复，不会清除筛选或开始播放。':f?'手动浏览会暂停跟随；点击关闭':'仅播放时跟随当前原文；手动浏览会暂停，不会自动播放';
  if(button.title!==title)button.title=title;
 }
}
function suspendReadingFollow(reason='手动浏览'){
 if(!readingFollow||readingFollow.suspended)return;
 cancelFollowFrame();readingFollow.suspended=reason;refreshReadingFollow();
}
function followBlocked(){
 if(workspace!=='read'||document.hidden||document.querySelector('dialog[open]')||selected||readingContext||passageReturn)return true;
 const focused=document.activeElement;
 return !!((focused?.matches('input,textarea,select,[contenteditable="true"]')&&!focused.closest(followTransport))||focused?.closest('#transcript,#passage-body'));
}
function advanceReadingFollow(){
 if(!followOwns()||readingFollow.suspended||!followAvailable())return;
 const player=followPlayer();if(player.paused||player.ended)return;
 if(followBlocked()){suspendReadingFollow('正在编辑或查看其他内容');return;}
 if(!['transcript','bilingual','passages'].includes(readingMode)){suspendReadingFollow('请先打开原文或连贯阅读');return;}
 const cue=playbackSegment();if(!cue)return;
 const doc=active(),query=$('search').value.trim().toLocaleLowerCase();
 if(!matchesReadingSegment(cue,doc,query)){suspendReadingFollow('当前原声不在筛选结果中');return;}
 let row;
 if(readingMode==='passages'){
  row=[...$('passage-body').querySelectorAll('.passage-cue')].find(node=>node.dataset.cueId===cue.id);
  if(!row){const passages=readingPassages(doc),passage=CoconutPassages.locate(passages,cue.id);if(!passage)return;
  const nextPage=Math.floor(passages.indexOf(passage)/PASSAGES_PER_PAGE)*PASSAGES_PER_PAGE;
  if(nextPage!==passagePageStart){passageAnchor=passage.cues[0].id;renderPassages(doc);highlightPlayback();}}
  row=[...$('passage-body').querySelectorAll('.passage-cue')].find(node=>node.dataset.cueId===cue.id);
 }else{
  row=[...$('transcript').querySelectorAll('.segment')].find(node=>node.dataset.segmentId===cue.id);
  if(!row){const matches=doc.segments.filter(s=>matchesReadingSegment(s,doc,query)),index=matches.indexOf(cue);
  if(index<0)return;
  const nextPage=Math.floor(index/PAGE_SIZE)*PAGE_SIZE;
  if(nextPage!==pageStart){pageStart=nextPage;render({keepNoteEditor:true});}}
  row=[...$('transcript').querySelectorAll('.segment')].find(node=>node.dataset.segmentId===cue.id);
 }
 if(!row)return;
 const rect=row.getBoundingClientRect(),height=window.visualViewport?.height||window.innerHeight;
 // An instant bounded correction avoids queued smooth scrolling competing with
 // manual intent and also respects reduced-motion preferences.
 if(rect.top<64||rect.bottom>height-128)row.scrollIntoView?.({block:rect.height>height-192?'start':'center',behavior:'auto'});
}
function scheduleReadingFollow(){
 refreshReadingFollow();if(!readingFollow||readingFollow.suspended||readingFollowFrame!==null)return;
 const revision=readingFollowRevision;
 readingFollowFrame=requestAnimationFrame(()=>{readingFollowFrame=null;if(revision===readingFollowRevision){readingFollowMoving=true;try{advanceReadingFollow();}finally{readingFollowMoving=false;if(readingFollow)readingFollow.scrollY=window.scrollY;}}});
}
function toggleReadingFollow(){
 if(!followAvailable())return;
 cancelFollowFrame();
 if(readingFollow&&!readingFollow.suspended)readingFollow=null;
 else{const player=followPlayer();readingFollow={doc:active(),segments:active().segments,player,src:player.getAttribute('src'),source:documentSourceIdentity(active()),attachment:browserMedia.get(active().key),scrollY:window.scrollY,suspended:null};scheduleReadingFollow();}
 refreshReadingFollow();
}
$('follow-playback').onclick=toggleReadingFollow;$('dock-follow').onclick=toggleReadingFollow;
// Input intent cancels a queued correction before it runs. A scroll to any
// other position also suspends (including scrollbar/assistive navigation);
// our instant correction records its final position before async scroll events.
// Capture runs before navigation removes a focused row or opens an editor.
window.addEventListener('scroll',()=>{if(readingFollow&&!readingFollowMoving&&Math.abs(window.scrollY-readingFollow.scrollY)>1)suspendReadingFollow();},{passive:true});
const followTransport='#follow-playback,#dock-follow,#dock-play,#skip-back,#skip-forward,#playback-rate,audio,video';
window.addEventListener('wheel',()=>suspendReadingFollow(),{capture:true,passive:true});
window.addEventListener('touchstart',event=>{if(!event.target.closest?.(followTransport))suspendReadingFollow();},{capture:true,passive:true});
document.addEventListener('pointerdown',event=>{if(!event.target.closest?.(followTransport))suspendReadingFollow();},true);
document.addEventListener('click',event=>{if(event.target.closest?.('button,a,summary,input,select,textarea')&&!event.target.closest(followTransport))suspendReadingFollow();},true);
document.addEventListener('input',event=>{if(!event.target.closest?.(followTransport))suspendReadingFollow('正在输入');},true);
document.addEventListener('focusin',event=>{if(event.target.matches?.('input,textarea,select,[contenteditable="true"]')&&!event.target.closest(followTransport))suspendReadingFollow('正在输入');},true);
document.addEventListener('keydown',event=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)&&!event.target.closest?.(followTransport))suspendReadingFollow();},true);
window.addEventListener('coconut-render',refreshReadingFollow);
document.addEventListener('visibilitychange',()=>{if(document.hidden)suspendReadingFollow('页面已离开');});

// The dock controls the existing source player; it never owns or starts media.
function refreshPlaybackDock(){
 refreshReadingFollow();
 const dock=$('media-dock'),player=$('source-media').querySelector('audio,video');
 const playable=player&&!player.error&&Number.isFinite(player.duration)&&player.duration>0;
 const visible=!!(playable&&workspace==='read'&&!$('reader-workspace').hidden&&!$('source-media').hidden&&($('episode-media').getBoundingClientRect().bottom<=0||(readingFollow&&!readingFollow.suspended&&dock.contains(document.activeElement))));
 if(!readingFollowMoving&&(!readingFollow||readingFollow.suspended)&&!visible&&!dock.hidden&&dock.contains(document.activeElement)&&player&&workspace==='read')player.focus({preventScroll:true});
 if(dock.hidden!==!visible)dock.hidden=!visible;
 if(document.body.dataset.mediaDocked!==String(visible))document.body.dataset.mediaDocked=String(visible);
 if(!visible)return;
 // Time events need not rewrite unchanged labels or invalidate layout styles.
 const write=(id,value)=>{const node=$(id);if(node.textContent!==value)node.textContent=value;};
 const title=(active()?.title||'当前原声').replace(/\s+/g,' ').slice(0,240);
 write('dock-title',title);if($('dock-title').title!==title)$('dock-title').title=title;
 write('dock-play',player.ended?'重播':player.paused?'播放':'暂停');
 const label=player.ended?'重新播放本篇原声':player.paused?'播放本篇原声':'暂停本篇原声';
 if($('dock-play').getAttribute('aria-label')!==label)$('dock-play').setAttribute('aria-label',label);
 write('dock-current',Coconut.time(player.currentTime));write('dock-total',' / '+Coconut.time(player.duration));write('dock-rate',' · '+player.playbackRate+'×');
 const audioOnly=Coconut.isAudioProject(active());if($('dock-locate').hidden!==audioOnly)$('dock-locate').hidden=audioOnly;
 const cue=playbackSegment();if($('dock-locate').disabled!==!cue)$('dock-locate').disabled=!cue;write('dock-locate',cue?'定位原文':'此刻无字幕');
}
function schedulePlaybackDock(){
 if(dockFramePending)return;
 dockFramePending=true;requestAnimationFrame(()=>{dockFramePending=false;refreshPlaybackDock();});
}
$('dock-play').onclick=async()=>{
 const player=$('source-media').querySelector('audio,video');
 if(!player||player.error||!Number.isFinite(player.duration)||player.duration<=0)return;
 if(!player.paused){player.pause();refreshPlaybackDock();return;}
 if(passagePlayback?.getState().status==='finished')passagePlayback.cancel();
 const ownsPlaybackError=playbackErrorOwner(player);
 try{if(player.ended){stopRepeating();player.currentTime=0;}await player.play();}
 catch(error){if(error?.name!=='AbortError'&&ownsPlaybackError())notice('媒体暂时无法播放，请回到播放器检查文件或重试。');}
 refreshPlaybackDock();
};
$('media-dock').addEventListener('focusout',schedulePlaybackDock);
$('dock-locate').onclick=()=>locateReadingPlayback();
$('dock-return').onclick=()=>{
 const player=$('source-media').querySelector('audio,video');if(!player)return;
 $('reading-info').open=false;mediaExpandedKey=active()?.key||null;mediaCollapsedKey=null;updateReaderMediaVisibility(active());refreshPlaybackDock();
 $('source-media').scrollIntoView?.({block:'center',behavior:'smooth'});player.focus({preventScroll:true});
};
window.addEventListener('scroll',schedulePlaybackDock,{passive:true});
window.addEventListener('resize',schedulePlaybackDock);
window.visualViewport?.addEventListener('resize',schedulePlaybackDock);
window.addEventListener('coconut-render',refreshPlaybackDock);
function skipPlayback(delta){
 passagePlayback?.cancel();
 const player=$("source-media").querySelector("audio,video");if(!player || !Number.isFinite(player.duration) || player.duration<=0)return;
 stopRepeating();
 try{player.currentTime=Math.max(0,Math.min(player.duration,player.currentTime+delta));takeListeningOwnership();highlightPlayback();$("playback-status").textContent="已定位到 "+Coconut.time(player.currentTime);}
 catch{$("playback-status").textContent="媒体暂时无法定位，请等待加载后重试。";}
}
$("skip-back").onclick=()=>skipPlayback(-10);$("skip-forward").onclick=()=>skipPlayback(10);
$("playback-rate").onchange=()=>{
 const rate=Number($("playback-rate").value),player=$("source-media").querySelector("audio,video");if(!player || !PLAYBACK_RATES.includes(rate))return;
 try{player.defaultPlaybackRate=rate;player.playbackRate=rate;playbackRate=rate;}catch{$("playback-status").textContent="播放器不支持该速度。";return;}
 try{localStorage.setItem("coconut-playback-rate-v1",String(rate));$("playback-status").textContent="播放速度已保存 · "+rate+"×";}
 catch{$("playback-status").textContent="播放速度已应用，本次未能保存偏好。";}
};

function refreshCueActionLabels(){
 for(const row of $('transcript').querySelectorAll('.short-cue')){
  const summary=row.querySelector('.cue-more > summary');
  if(summary){
   summary.textContent=[row.querySelector('.repeat-button')?.getAttribute('aria-pressed')==='true'?'循环中':'',row.classList.contains('excerpted')?'已摘录':'','更多'].filter(Boolean).join(' · ');
   summary.setAttribute('aria-label',summary.dataset.cueTime+' · '+summary.textContent+'：修正、摘录、阅读位置'+(row.querySelector('.repeat-button')?'与循环回听':''));
  }
 }
}
function stopRepeating(){
 repeating=null;$("stop-repeat").hidden=true;$("repeat-status").textContent="";
 for(const button of document.querySelectorAll(".repeat-button")){button.textContent="循环回听此段";button.setAttribute("aria-pressed","false");}
 refreshCueActionLabels();
}
function toggleRepeat(segment){
 passagePlayback?.cancel();
 if(repeating?.key===active()?.key && repeating?.id===segment.id){stopRepeating();return;}
 const player=$("source-media").querySelector("audio,video");
 const range=timingRange(segment);
 if(!player || !range){$("repeat-status").textContent="请等待媒体加载，并确认片段时间在媒体范围内。";return;}
 stopRepeating();const target={key:active().key,doc:active(),attachment:browserMedia.get(active().key),player,id:segment.id,path:player.getAttribute("src"),start:range.start,end:range.end,expectedSeek:null};repeating=target;
 try{seekRepeat(target);const pending=player.play();pending?.catch(()=>{if(repeating===target){stopRepeating();$("repeat-status").textContent="请先在播放器中开始播放，再循环此段。";}});}
 catch{stopRepeating();$("repeat-status").textContent="此媒体暂时无法循环播放。";return;}
 $("stop-repeat").hidden=false;$("repeat-status").textContent="循环 · "+Coconut.time(segment.start)+"–"+Coconut.time(segment.end);
 for(const row of $("transcript").querySelectorAll(".segment")){const button=row.querySelector(".repeat-button");if(button){const selected=row.dataset.segmentId===segment.id;button.textContent=selected?"正在循环 · 停止":"循环回听此段";button.setAttribute("aria-pressed",String(selected));}}
 refreshCueActionLabels();
}
function repeatTarget(player){
 const target=repeating;
 // Detached media events cannot retire a newer loop on the current player.
 if(!target||target.player!==player||player!==$('source-media').querySelector('audio,video'))return null;
 if(target.doc!==active()||target.path!==player.getAttribute('src')||target.attachment!==browserMedia.get(target.key)){stopRepeating();return null;}
 return target;
}
function seekRepeat(target){
 // Keep ownership until seeked: browsers queue seeking/seeked asynchronously.
 if(!target.player.seeking&&target.player.currentTime===target.start){target.expectedSeek=null;return;}
 target.expectedSeek=target.start;target.player.currentTime=target.start;
}
function observeRepeatSeek(player,completed){
 const target=repeatTarget(player);if(!target)return;
 if(target.expectedSeek===null||Math.abs(player.currentTime-target.expectedSeek)>.03){stopRepeating();return;}
 if(completed)target.expectedSeek=null;
}
function repeatPlayback(ended=false,player=$('source-media').querySelector('audio,video')){
 const target=repeatTarget(player);if(!target||player.seeking)return;
 if(player.currentTime<target.start){stopRepeating();return;}
 if(player.currentTime>=target.end || ended){
  try{seekRepeat(target);if(ended)player.play()?.catch(()=>{if(repeating===target)stopRepeating();});}catch{stopRepeating();}
 }
}
$("stop-repeat").onclick=stopRepeating;

function translationLabel(language){return {zh:'中文',en:'英文',ja:'日文',ko:'韩文',fr:'法文',de:'德文',es:'西班牙文'}[language]||language;}
function phrasePreview(hit){
 const preview=el('p','phrase-match'),count=hit.cueCount??hit.ids.length;preview.dataset.cueCount=String(count);
 // Complete membership stays in the source index. Avoid repeating enormous ID
 // lists in every result DOM node for a long, heavily overlapping query.
 if(count<=32)preview.dataset.cueIds=JSON.stringify(hit.ids);else{preview.dataset.firstCueId=hit.id;preview.dataset.lastCueId=hit.lastId;}
 preview.dataset.field=hit.field;if(hit.language)preview.dataset.language=hit.language;
 const label=(hit.language?translationLabel(hit.language)+'译文':'原文')+(count>1?` · 跨 ${count} 个片段`:'');
 preview.append(el('small','',label+' · '),document.createTextNode(hit.snippet.before),el('mark','',hit.snippet.match),document.createTextNode(hit.snippet.after));return preview;
}
function highlightedText(tag,className,value,query,ranges=null){
 const node=el(tag,className),text=String(value),needle=query.trim();
 if(!needle){node.textContent=text;return node;}
 if(ranges){
  let end=0;for(const range of ranges){node.append(document.createTextNode(text.slice(end,range.start)),el('mark','',text.slice(range.start,range.end)));end=range.end;}
  node.append(document.createTextNode(text.slice(end)));return node;
 }
 // Escape all regexp operators; imported text is always a text node.
 const expression=new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"giu");
 let end=0;
 for(const match of text.matchAll(expression)){node.append(document.createTextNode(text.slice(end,match.index)),el("mark","",match[0]));end=match.index+match[0].length;}
 node.append(document.createTextNode(text.slice(end)));return node;
}
function moveSearchMatch(direction){
 const doc=active(),query=$("search").value.trim();if(!doc || !query)return;
 const matches=doc.segments.filter(s=>matchesReadingSegment(s,doc,query));if(!matches.length)return;
 const current=matches.findIndex(s=>s.id===searchFocusedId);
 const index=current<0?(direction>0?0:matches.length-1):(current+direction+matches.length)%matches.length;
 searchFocusedId=matches[index].id;pageStart=Math.floor(index/PAGE_SIZE)*PAGE_SIZE;selected=null;render();
 const row=[...$("transcript").querySelectorAll(".segment")].find(s=>s.dataset.segmentId===searchFocusedId);
 const alignment = row && row.getBoundingClientRect().height > (window.visualViewport?.height || window.innerHeight) ? "start" : "center";
 row?.scrollIntoView?.({block:alignment});row?.focus({preventScroll:true});
}
$("previous-match").onclick=()=>moveSearchMatch(-1);$("next-match").onclick=()=>moveSearchMatch(1);

// A native disclosure keeps export options keyboard-accessible and out of the reading canvas.
document.addEventListener("click", event => {
 const menu = $("export-menu");
 // Exports click a temporary, hidden download link outside the disclosure.
 // It is not a user dismissal and must not strand focus in the closed panel.
 if (event.target.closest?.("a[download][hidden]")) return;
 if (menu.open && !menu.contains(event.target)) {
  const restoreFocus = menu.contains(document.activeElement);
  menu.open = false;
  if (restoreFocus) menu.querySelector("summary").focus();
 }
});
document.addEventListener("keydown", event => {
 const menu = $("export-menu");
 if (event.key === "Escape" && menu.open && !document.querySelector("dialog[open]")) {
  menu.open = false;
  menu.querySelector("summary").focus();
 }
});

// Reading composition is transient: source cues, annotations, exports and AI scope stay cue-based.
function readingPassages(doc=active()){return doc&&!Coconut.isAudioProject(doc)?CoconutPassages.build(doc.segments):[];}
function passageTargetLanguage(doc){
 if(doc.translation_view)return doc.translation_view;
 for(const cue of doc.segments)for(const [language,item] of Object.entries(cue.translations||{}))if(Coconut.translationCurrent(cue,doc,item))return language;
 return '';
}
function appendPassageCue(paragraph,cue,text,previousText){
 if(previousText!==null)paragraph.append(document.createTextNode(CoconutPassages.separator(previousText,text)));
 const span=el('span','passage-cue',text);span.dataset.cueId=cue.id;paragraph.append(span);
 return text;
}
function renderPassages(doc){
 const passages=readingPassages(doc),host=$('passage-body');
 if(!passages.length){host.replaceChildren();return;}
 if(passageDocumentKey!==doc.key){passageDocumentKey=doc.key;passageAnchor=doc.readingPosition||passages[0].cues[0].id;passagePageStart=0;passageReturn=null;passageTranslations=true;}
 const anchored=CoconutPassages.locate(passages,passageAnchor)||passages[0];
 const index=passages.indexOf(anchored);passagePageStart=Math.floor(index/PASSAGES_PER_PAGE)*PASSAGES_PER_PAGE;
 const visible=passages.slice(passagePageStart,passagePageStart+PASSAGES_PER_PAGE),target=passageTargetLanguage(doc);
 const hasTranslation=!!target&&doc.segments.some(cue=>Coconut.translationCurrent(cue,doc,cue.translations?.[target]));
 const toggle=$('passage-toggle-translation');toggle.hidden=!hasTranslation;toggle.setAttribute('aria-pressed',String(passageTranslations));toggle.textContent=passageTranslations?'收起已存译文':'对照已存译文';
 const duration=Coconut.documentDuration(doc);
 const slider=$('passage-time-range');slider.max=String(Math.max(1,Math.ceil(duration)));slider.value=String(anchored.start);slider.disabled=duration<=0;
 slider.setAttribute('aria-valuetext',Coconut.time(anchored.start)+'，共 '+Coconut.time(duration));
 $('passage-time-label').textContent=Coconut.time(anchored.start);$('passage-total-time').textContent=Coconut.time(duration);
 $('passage-position').textContent='第 '+(index+1)+' / '+passages.length+' 段';
 $('passage-page-status').textContent=(passagePageStart+1)+'–'+(passagePageStart+visible.length)+' / '+passages.length+' 段';
 $('passage-previous').disabled=passagePageStart===0;$('passage-next').disabled=passagePageStart+PASSAGES_PER_PAGE>=passages.length;
 host.replaceChildren();
 for(const passage of visible){
  const section=el('section','passage');section.dataset.passageId=passage.key;section.dataset.firstCueId=passage.cues[0].id;section.tabIndex=-1;
  const meta=el('div','passage-meta');meta.append(el('span','passage-time',Coconut.time(passage.start)+'–'+Coconut.time(passage.end)));
  if(passage.speaker)meta.append(el('span','passage-speaker',passage.speaker));section.append(meta);
  const columns=el('div','passage-columns');columns.classList.toggle('has-translation',!!target&&passageTranslations);
  const original=el('p','passage-original');original.lang=doc.language||'';let previous=null;
  for(const cue of passage.cues)previous=appendPassageCue(original,cue,cue.text,previous);columns.append(original);
  if(target&&passageTranslations){
   const translated=el('p','passage-translation');translated.lang=target;previous=null;
   for(const cue of passage.cues){
    const item=cue.translations?.[target],current=item&&Coconut.translationCurrent(cue,doc,item);
    if(current){previous=appendPassageCue(translated,cue,item.text,previous);}
    else{
     const gap=el('span','passage-translation-gap',Coconut.time(cue.start)+(item?' 译文已过期，请核对原文':' 暂无译文'));
     gap.dataset.cueId=cue.id;gap.dataset.state=item?'stale':'missing';translated.append(gap);previous=null;
    }
   }
   columns.append(translated);
  }
  section.append(columns);
  if(target&&passageTranslations)for(const cue of passage.cues){const item=cue.translations?.[target];if(item&&Coconut.translationCurrent(cue,doc,item)){const warning=Coconut.translationQualityMessage(item);if(warning)section.append(el('p','passage-translation-warning',Coconut.time(cue.start)+' · 译文待核对：'+warning));}}
  const actions=el('div','passage-actions');
  const listen=el('button','passage-listen','回听这一段');listen.type='button';listen.dataset.passageId=passage.key;
  renderedPassageRanges.set(listen,passage);
  listen.onclick=()=>{const range=timingRange(passage);if(!range)return;stopRepeating();passagePlayback.listen({...range,id:passage.key,label:Coconut.time(passage.start)+'–'+Coconut.time(passage.end)});};
  actions.append(listen);
  const ask=el('button','passage-ask','问这一段');ask.type='button';ask.setAttribute('aria-label','问这一段 '+Coconut.time(passage.start)+' 的原文');ask.onclick=()=>preparePassageQuestion(doc,passage);actions.append(ask);
  const details=el('button','passage-details','逐句核对');details.type='button';details.setAttribute('aria-label','逐句核对 '+Coconut.time(passage.start)+' 的原文与笔记');details.onclick=()=>openPassageDetails(passage.cues[0].id,section);actions.append(details);
  const external=Coconut.source(doc.source_url,passage.start);
  if(external){const source=el('a','passage-source-link','原站 ↗');source.href=external;source.target='_blank';source.rel='noopener noreferrer';actions.append(source);}
  section.append(actions);
  for(const cue of passage.cues){
   const hasNote=Coconut.hasNoteContent(doc.notes[cue.id]);
   if(!hasNote&&!cue.saved_excerpt)continue;
   const annotation=el('button','passage-annotation',Coconut.time(cue.start)+' · '+(hasNote?doc.notes[cue.id]:'已摘录原文'));annotation.type='button';annotation.dataset.cueId=cue.id;
   annotation.onclick=()=>openPassageDetails(cue.id,section);section.append(annotation);
  }
  host.append(section);
 }
 renderPassagePlayback(passagePlayback?.getState());
}
function openPassage(cueId,scroll=true){
 const doc=active(),passages=readingPassages(doc),passage=CoconutPassages.locate(passages,cueId)||passages[0];if(!passage)return;
 $('reading-info').open=false;mediaExpandedKey=null;
 passageReturn=null;passageDocumentKey=doc.key;passageAnchor=passage.cues[0].id;
 setReadingMode('passages');render();
 const target=[...$('passage-body').querySelectorAll('.passage')].find(row=>row.dataset.firstCueId===passageAnchor);
 if(scroll){target?.scrollIntoView?.({block:'start',behavior:'auto'});target?.focus({preventScroll:true});}
}
function openPassageDetails(cueId,section){
 const doc=active();if(!doc)return;
 passageAnchor=section.dataset.firstCueId;
 passageReturn={key:doc.key,cueId:passageAnchor,viewportTop:section.getBoundingClientRect().top,scrollY:window.scrollY,focusCueId:cueId};
 goToSegment(cueId,false,true);
}
function returnToPassages(){
 const origin=passageReturn,doc=active();if(!origin||origin.key!==doc?.key)return;
 passageAnchor=origin.cueId;passageReturn=null;setReadingMode('passages');render();
 const passage=CoconutPassages.locate(readingPassages(doc),origin.cueId);
 const section=[...$('passage-body').querySelectorAll('.passage')].find(row=>row.dataset.firstCueId===passage?.cues[0].id);
 if(section){window.scrollBy(0,section.getBoundingClientRect().top-origin.viewportTop);section.querySelector('.passage-details')?.focus({preventScroll:true});}
 else{$('passage-body').scrollIntoView?.({block:'start'});$('mode-passages').focus({preventScroll:true});}
}
function movePassagePage(direction){
 const passages=readingPassages(),index=Math.max(0,Math.min(passages.length-1,passagePageStart+direction*PASSAGES_PER_PAGE));
 if(passages[index])openPassage(passages[index].cues[0].id);
}
function renderPassagePlayback(state){
 $('media-timing-return').hidden=state?.range?.id!=='media-timing-preview'||!state?.returnPosition;
 const status=state?.status||'idle',host=$('passage-playback-controls');if(!host)return;
 host.dataset.state=status;host.hidden=status==='idle'||workspace!=='read';document.body.dataset.passageListening=String(!host.hidden);
 $('passage-playback-status').textContent=({loading:'正在打开这一段…',playing:'回听 '+(state?.range?.label||'')+' · 到段尾自动停下',paused:'这一段已暂停',finished:'这一段已听完 · '+(state?.range?.label||''),error:state?.error||'这段暂时无法回听'})[status]||'';
 $('passage-replay').disabled=status==='loading';$('passage-continue').disabled=status==='loading';$('passage-return-playback').hidden=!state?.returnPosition;
 $('passage-stop').hidden=status==='finished'||status==='error';
 const player=$('source-media').querySelector('audio,video'),available=player&&!player.error&&Number.isFinite(player.duration)&&player.duration>0;
 for(const button of $('passage-body').querySelectorAll('.passage-listen')){
  const passage=renderedPassageRanges.get(button),bounded=available&&passage&&!!timingRange(passage);
  const current=state?.range?.id===button.dataset.passageId&&['loading','playing'].includes(status);
  button.disabled=!bounded||current;button.textContent=current?'正在回听这一段':'回听这一段';
  button.title=bounded?'只回听这段，到段尾自动停下':player?'等待原声加载，或检查文字稿时间与媒体对应':'先关联对应的原声文件，即可回听这段';
 }
}
function locateReadingPlayback(){const cue=playbackSegment();if(cue){if(readingMode==='passages')openPassage(cue.id);else goToSegment(cue.id);highlightPlayback();}}
$('toggle-reader-media').onclick=()=>{const doc=active();if(!doc)return;$('reading-info').open=false;$('export-menu').open=false;mediaExpandedKey=$('episode-media').hidden?doc.key:null;mediaCollapsedKey=mediaExpandedKey?null:doc.key;updateReaderMediaVisibility(doc);refreshPlaybackDock();};
$('close-reader-media').onclick=()=>{mediaExpandedKey=null;mediaCollapsedKey=active()?.key||null;updateReaderMediaVisibility(active());refreshPlaybackDock();$('toggle-reader-media').focus({preventScroll:true});};
$('close-reading-info').onclick=()=>{$('reading-info').open=false;$('reading-info').querySelector('summary').focus({preventScroll:true});};
$('reading-info').querySelector('summary').addEventListener('click',()=>{if(!$('reading-info').open){$('export-menu').open=false;mediaExpandedKey=null;updateReaderMediaVisibility(active());refreshPlaybackDock();}});
$('export-menu').querySelector('summary').addEventListener('click',()=>{if(!$('export-menu').open){$('reading-info').open=false;if(readingMode==='passages'){mediaExpandedKey=null;updateReaderMediaVisibility(active());refreshPlaybackDock();}}});
document.addEventListener('keydown',event=>{
 if(event.key!=='Escape'||document.querySelector('dialog[open]'))return;
 if($('reading-info').open){event.preventDefault();$('close-reading-info').click();}
 else if(readingMode==='passages'&&!$('episode-media').hidden){event.preventDefault();$('close-reader-media').click();}
});
document.addEventListener('click',event=>{
 const target=event.target;
 if(target.closest?.('dialog,a[download]'))return;
 // A pointer dismissal keeps focus on the newly chosen reading control.
 if($('reading-info').open&&!$('reading-info').contains(target))$('reading-info').open=false;
 if(readingMode==='passages'&&!$('episode-media').hidden&&!$('episode-media').contains(target)&&!$('toggle-reader-media').contains(target)&&!$('dock-return').contains(target)){
  mediaExpandedKey=null;updateReaderMediaVisibility(active());refreshPlaybackDock();
 }
});
$('passage-time-range').oninput=()=>{$('passage-time-label').textContent=Coconut.time(Number($('passage-time-range').value));};
$('passage-time-range').onchange=()=>{const passage=CoconutPassages.atTime(readingPassages(),Number($('passage-time-range').value));if(passage)openPassage(passage.cues[0].id);};
$('passage-previous').onclick=()=>movePassagePage(-1);$('passage-next').onclick=()=>movePassagePage(1);
$('return-to-passages').onclick=returnToPassages;
$('passage-toggle-translation').onclick=()=>{passageTranslations=!passageTranslations;renderPassages(active());};
$('passage-search').onclick=()=>{passageReturn=null;setReadingMode('transcript');$('search').focus();};

// Character shortcuts are opt-out, scoped to reading text, and never become
// another playback owner. Invoke the existing controls without synthesizing a
// pointer click that could dismiss an unrelated reading overlay.
const READING_KEYS_PREFERENCE='coconut-reading-shortcuts-v1';
let readingKeysEnabled=true,readingKeyComposition=false,keyboardHelpOrigin=null;
try{readingKeysEnabled=localStorage.getItem(READING_KEYS_PREFERENCE)!=='off';}catch{}
const readingKeyControls={'keyboard-help-open':'Shift+/',search:'/', 'passage-search':'/',
 'skip-back':'J','skip-forward':'L','dock-play':'K','locate-playback':'G','dock-locate':'G'};
function updateReadingKeyHints(){
 $('keyboard-shortcuts-enabled').checked=readingKeysEnabled;
 for(const [id,key] of Object.entries(readingKeyControls)){
  if(readingKeysEnabled)$(id).setAttribute('aria-keyshortcuts',key);else $(id).removeAttribute('aria-keyshortcuts');
 }
 // These shortcuts belong only to the focused search input, and remain usable
 // when character shortcuts are turned off.
 $('search').setAttribute('aria-keyshortcuts',readingKeysEnabled?'/ Enter Shift+Enter':'Enter Shift+Enter');
}
function hasReadingModal(){
 return !!document.querySelector('dialog[open]')||[...document.querySelectorAll('[aria-modal="true"]')].some(node=>!node.closest('[hidden],[aria-hidden="true"]'));
}
function readingKeyIgnored(event){
 return readerClosing||document.body.inert||$('reader-workspace').inert||!!$('reader-workspace').closest('[inert]')||
  event.defaultPrevented||event.repeat||event.isComposing||readingKeyComposition||event.keyCode===229||
  event.ctrlKey||event.metaKey||event.altKey||event.getModifierState?.('AltGraph')||workspace!=='read'||$('reader-workspace').hidden||!active()||hasReadingModal();
}
function readingTextTarget(node){
 if(document.designMode==='on'||document.body.isContentEditable||document.body.hasAttribute('contenteditable')&&document.body.getAttribute('contenteditable')!=='false')return false;
 if(!node||node===document||node===document.body||node===document.documentElement)return true;
 if(!$('reader-workspace').contains(node))return false;
 // Native controls, ARIA widgets, editable ancestors and shadow hosts retain
 // their own keyboard behavior. Empty contenteditable is editable too.
 if(node.closest?.('input,textarea,select,button,a,summary,audio,video,iframe,object,embed,[role],[inert]'))return false;
 for(let current=node;current&&current!==document.body;current=current.parentElement){
  if(current.isContentEditable||(current.hasAttribute?.('contenteditable')&&current.getAttribute('contenteditable')!=='false'))return false;
 }
 return true;
}
function openKeyboardHelp(){
 if(workspace!=='read'||!active()||hasReadingModal())return;
 keyboardHelpOrigin={node:document.activeElement,key:active().key};
 $('keyboard-help').showModal();$('keyboard-help-close').focus({preventScroll:true});
}
$('keyboard-help-open').onclick=openKeyboardHelp;
$('keyboard-help-close').onclick=()=>$('keyboard-help').close();
$('keyboard-help').addEventListener('close',()=>{
 if($('keyboard-help').open)return; // A queued close must not undo a newer opening.
 const origin=keyboardHelpOrigin;keyboardHelpOrigin=null;
 if(workspace!=='read'||origin?.key!==active()?.key)return;
 // Native close events are queued. Do not overwrite a newer intentional focus
 // move (for example Slash opening search after Escape closes this dialog).
 const focused=document.activeElement;
 if(focused&&focused!==document.body&&focused!==origin.node&&!$('keyboard-help').contains(focused))return;
 const target=origin.node?.isConnected&&!origin.node.closest?.('[hidden],[inert]')?origin.node:$('keyboard-help-open');
 target?.focus({preventScroll:true});
});
$('keyboard-shortcuts-enabled').onchange=()=>{
 readingKeysEnabled=$('keyboard-shortcuts-enabled').checked;updateReadingKeyHints();
 try{localStorage.setItem(READING_KEYS_PREFERENCE,readingKeysEnabled?'on':'off');$('keyboard-preference-status').textContent=readingKeysEnabled?'已启用阅读快捷键。':'已关闭单字符快捷键。';}
 catch{$('keyboard-preference-status').textContent='本次设置已生效，但浏览器未保存；刷新后可能恢复原设置。';}
};
updateReadingKeyHints();
document.addEventListener('compositionstart',()=>{readingKeyComposition=true;});
document.addEventListener('compositionend',()=>{readingKeyComposition=false;});
window.addEventListener('blur',()=>{readingKeyComposition=false;});
document.addEventListener('keydown',event=>{
 if(readingKeyIgnored(event))return;
 if(event.target===$('search')&&event.key==='Enter'){
  if(!$('search').value.trim()||$('search').closest('[hidden]'))return;
  event.preventDefault();$(event.shiftKey?'previous-match':'next-match').onclick();return;
 }
 if(!readingKeysEnabled||!readingTextTarget(document.activeElement)||!readingTextTarget(event.target)||!readingTextTarget(event.composedPath?.()[0]||event.target))return;
 const key=event.key.toLowerCase();if(event.shiftKey&&key!=='?')return;
 let action=null;
 if(key==='?')action=openKeyboardHelp;
 else if(key==='/'&&!Coconut.isAudioProject(active()))action=()=>{
  $('passage-search').onclick();
  if(active()?.provenance?.kind==='authored_demo'&&!demoToolsExpanded)$('toggle-demo-tools').onclick();
  $('search').focus();
 };
 else{
  const player=$('source-media').querySelector('audio,video');
  if(!player||player.error||!Number.isFinite(player.duration)||player.duration<=0)return;
  const id=({j:'skip-back',l:'skip-forward',k:'dock-play',g:'locate-playback'})[key],control=id&&$(id);
  if(control&&!control.disabled&&(key!=='g'||playbackSegment()))action=control.onclick;
 }
 if(action){event.preventDefault();action();}
});

$('passage-replay').onclick=()=>{stopRepeating();passagePlayback?.replay();};
$('passage-continue').onclick=()=>passagePlayback?.continue();
$('passage-return-playback').onclick=()=>passagePlayback?.returnToPrevious();
$('passage-stop').onclick=()=>{const player=$('source-media').querySelector('audio,video');passagePlayback?.cancel();player?.pause();};
function pauseBoundedForCompactNote(){
 if(!$('notes-panel').hidden&&(window.visualViewport?.height||window.innerHeight)<=520&&['loading','playing'].includes(passagePlayback?.getState().status))$('source-media').querySelector('audio,video')?.pause();
}
window.addEventListener('resize',pauseBoundedForCompactNote);
window.visualViewport?.addEventListener('resize',pauseBoundedForCompactNote);
window.addEventListener('pagehide',()=>{if(passagePlayback?.getState().range)$('source-media').querySelector('audio,video')?.pause();passagePlayback?.cancel();});

function updateReaderMediaVisibility(doc=active(),hasMedia=!!$('source-media').querySelector('audio,video')){
 if(!doc)return;
 const audioOnly=Coconut.isAudioProject(doc),demo=doc.provenance?.kind==='authored_demo',compact=readingMode==='passages'&&!audioOnly;
 const expanded=mediaExpandedKey===doc.key,visible=audioOnly||expanded||(!compact&&hasMedia&&mediaCollapsedKey!==doc.key);
 $('episode-media').hidden=(demo&&!hasMedia)||!visible;
 $('toggle-reader-media').hidden=(demo&&!hasMedia)||audioOnly;
 $('toggle-reader-media').setAttribute('aria-expanded',String(visible));
 $('toggle-reader-media').textContent=compact?(visible?'收起原声':hasMedia?'原声':'关联原声'):(visible?'收起原声设置':'关联原声 · 回听这一篇');
 $('close-reader-media').hidden=audioOnly||!visible;
}
function composeReadingHeader(){
 const doc=active(),compact=workspace==='read'&&readingMode==='passages'&&doc&&!Coconut.isAudioProject(doc);
 $('reader-title-slot').hidden=!compact;$('count').hidden=!!compact;$('reading-info').hidden=!compact;
 $('reading-utility').classList.toggle('is-compact',!!compact);
 const toolbar=document.querySelector('.passage-toolbar');toolbar.hidden=!compact;
 const titleTarget=compact?$('reader-title-slot'):$('reader-title-home');
 if($('title').parentElement!==titleTarget)titleTarget.append($('title'));
 const metaTarget=compact?$('reading-info-meta'):$('reader-meta-home');
 for(const id of ['subtitle','provenance'])if($(id).parentElement!==metaTarget)metaTarget.append($(id));
 $('reading-info-title').textContent=doc?.title||'';$('title').title=doc?.title||'';
 if(headerDocumentKey!==doc?.key){headerDocumentKey=doc?.key;$('reading-info').open=false;}
 const settings=$('reading-settings');
 if(compact){
  if(settings.parentElement!==$('reading-info-settings')){readingSettingsPriorOpen=settings.open;$('reading-info-settings').append(settings);settings.open=true;}
  if($('passage-browse-help').parentElement!==$('reading-info-help'))$('reading-info-help').append($('passage-browse-help'));
  $('reading-info-position').textContent=$('passage-position').textContent;
 }else{
  if(settings.parentElement!==$('reader-options')){$('reader-options').insertBefore(settings,$('language-panel'));settings.open=readingSettingsPriorOpen===true;readingSettingsPriorOpen=null;}
  if($('passage-browse-help').parentElement!==document.querySelector('.passage-browse'))document.querySelector('.passage-browse').append($('passage-browse-help'));
  $('reading-info').open=false;
 }
}

function applyReadingMode() {
 const audioOnly=Coconut.isAudioProject(active());
 updateReaderMediaVisibility(active());
 const summary=readingMode==='summary'&&!audioOnly;
 const passages=readingMode==='passages'&&!audioOnly;
 document.body.dataset.readingMode=readingMode;
 $('passage-workspace').hidden=!passages;
 $('mode-passages').setAttribute('aria-pressed',String(passages));
 $('passage-return-bar').hidden=!passageReturn||passageReturn.key!==active()?.key||readingMode!=='transcript';
 $('toggle-demo-tools').hidden=summary||active()?.provenance?.kind!=='authored_demo';
 $('summary-workspace').hidden=!summary;
 $('transcript-controls').hidden=summary||passages;
 $('transcript-layout').hidden=summary||passages||audioOnly;
 $('reading-settings').hidden=summary;
 $('language-panel').hidden=audioOnly||summary||passages;
 $('mode-summary').setAttribute('aria-pressed',String(summary));
 const bilingual=!summary&&!passages&&!audioOnly&&!!active()?.translation_view;
 $('mode-transcript').setAttribute('aria-pressed',String(!summary&&!passages&&!bilingual));
 $('mode-bilingual').setAttribute('aria-pressed',String(bilingual));
 $('transcript-layout').classList.toggle('is-bilingual',bilingual);
 $('mode-bilingual').disabled=audioOnly;
 renderReadingContext();
 $('bilingual-readiness').hidden=!bilingual||active()?.provenance?.kind==='authored_demo';
 composeReadingHeader();
 if(bilingual){const doc=active(),target=doc.translation_view,count=doc.segments.filter(s=>Coconut.translationCurrent(s,doc,s.translations?.[target])).length;
 $('bilingual-status').textContent=count?`当前语言已有 ${count}/${doc.segments.length} 段有效译文；缺失部分可逐段「自己写译文」，过期译文可核对／修正；也可在翻译选项中继续。`:'还没有当前语言的有效译文。可逐段「自己写译文」，或打开翻译选项，核对发送范围与额度后生成；切换视图和自己写译文不会调用模型。';}
}
function setReadingMode(mode) {
 const previousMode=readingMode;
 readingMode=['transcript','passages'].includes(mode)?mode:'summary';
 if(readingMode==='passages'){if(readingContext?.document!==active())clearReadingContext();selected=null;$('notes-panel').hidden=true;if(typeof stopLanguageBatches==='function')stopLanguageBatches();$('language-panel').open=false;}
 if(readingMode==='summary')passageReturn=null;
 if(readingMode==='summary'){
  clearReadingContext();
  selected=null;$('notes-panel').hidden=true;
  stopRepeating();
 }
 if(readingMode==='summary'?$('summary-request').hidden:previousMode==='summary'||!$('summary-request').hidden||$('ai-task').value==='summary')closeSummaryRequest(false);
 applyReadingMode();
}
// A bounded map of actual source positions, never fabricated chapter titles or an AI summary.
function sourceStops(doc,limit){
 const segments=doc?.segments||[];
 if(!segments.length)return [];
 const count=Math.min(limit,segments.length);
 return Array.from({length:count},(_,index)=>segments[Math.floor(index*(segments.length-1)/Math.max(1,count-1))]);
}
function sourcePreview(segment,limit=90){
 const text=segment.text.replace(/\s+/g,' ').trim();
 return text.length>limit?text.slice(0,limit)+'…':text;
}
function renderReadingNavigation(doc){
 const select=$('reading-jump'),previous=select.value;
 select.replaceChildren();
 const placeholder=el('option','','选择时间位置…');placeholder.value='';select.append(placeholder);
 for(const segment of sourceStops(doc,20)){
  const option=el('option','',Coconut.time(segment.start)+' · '+sourcePreview(segment,30));
  option.value=segment.id;select.append(option);
 }
 select.value=[...select.options].some(option=>option.value===previous)?previous:'';
}
function sourceTimeStops(doc,limit){
 const cues=doc.segments||[];if(!cues.length)return [];
 const first=cues[0].start,last=cues.at(-1).start,count=Math.min(limit,cues.length);
 return [...new Map(Array.from({length:count},(_,index)=>{const time=first+(last-first)*index/Math.max(1,count-1);const cue=cues.findLast(item=>item.start<=time)||cues[0];return [cue.id,cue];})).values()];
}
function renderSourceOverview(doc,hasSummary){
 $('source-overview').hidden=Coconut.isAudioProject(doc);
 $('overview-duration').textContent=Coconut.time(Coconut.documentDuration(doc))+' · '+doc.segments.length+' 段';
 const host=$('overview-segments');host.replaceChildren();
 for(const segment of sourceTimeStops(doc,6)){
  const button=el('button','overview-segment');
  button.append(el('span','overview-time',Coconut.time(segment.start)),el('span','overview-quote',sourcePreview(segment)),el('span','overview-arrow','↗'));
  button.setAttribute('aria-label',Coconut.time(segment.start)+' · '+sourcePreview(segment));
  button.dataset.cueId=segment.id;button.onclick=()=>openPassage(segment.id);host.append(button);
 }
}
function renderSummaryPersistence(){
 const doc=active();if(!doc)return;
 const answer=Coconut.latestSummary(doc),freshness=answer?Coconut.summaryFreshness(answer,doc):'empty';
 const persisted=answer&&(doc.ai_answers||[]).indexOf(answer)<(persistedAIAnswerCounts.get(doc)||0);
 $('summary-state').textContent=answer&&!persisted?'仅在此页 · 请备份':({current:'已保存 · 待核对',stale:'原文有更新',unknown:'依据待确认',empty:'未生成'})[freshness];
 $('summary-state').dataset.state=answer&&!persisted?'unsaved':freshness;
 $('summary-status').textContent=answer ? ({current:'覆盖当前整篇原文 · '+answer.provider+' · 摘要不代替原话',stale:'原文已经修改、增加或移除，下面是旧摘要。重新生成前请对照原文。',unknown:'这份摘要缺少完整发送记录，无法确认覆盖范围，请对照原文。'})[freshness] : '已有原文可直接阅读。连接已登录的本地 Codex 或 Claude Code，确认发送全文与使用额度后，才会生成摘要。';
 if(!answer&&doc.summary_job)$('summary-status').textContent=summaryCheckpointSaved(doc)?'分批进度已保存，整篇摘要尚未完成。查看计划后需再次确认发送与额度，才会继续；不会自动重新请求。':'最新分批进度尚未保存到浏览器，当前页面仍可导出 JSON 备份；关闭或刷新可能丢失进度，整篇摘要尚未完成。';
 if(answer?.summary_process?.batches>1)$('summary-status').textContent+=' · '+answer.summary_process.batches+' 批完成后汇总；引用来自被采用的批次依据，请回源核对。';
 if(answer&&!persisted)$('summary-status').textContent='这份摘要尚未保存到浏览器。关闭或刷新前请先导出摘要或 JSON 备份。'+$('summary-status').textContent;
}
function renderSummary() {
 const doc=active();if(!doc)return;
 const readiness=Coconut.summaryReadiness(doc);
 const answer=Coconut.latestSummary(doc),freshness=answer?Coconut.summaryFreshness(answer,doc):'empty';
 const persisted=answer && (doc.ai_answers||[]).indexOf(answer)<(persistedAIAnswerCounts.get(doc)||0);
 renderSourceOverview(doc,!!answer);
 $('summary-heading').textContent=answer?'这篇的主要内容':'想先抓住重点？';
 renderSummaryPersistence();
 $('summary-body').textContent=answer?.answer||'';
 $('summary-citations').replaceChildren();
 if(answer){
  for(const id of [...new Set(answer.citations)]){
   const segment=doc.segments.find(s=>s.id===id);
   if(!segment){$('summary-citations').append(el('p','hint','原片段已不存在：'+id+'。请查看历史记录中的依据状态。'));continue;}
   const button=el('button','',Coconut.time(segment.start)+' · 核对原文');
   button.onclick=()=>goToSegment(id);$('summary-citations').append(button);
  }
  if(!answer.citations.length)$('summary-citations').append(el('p','hint','这份摘要没有片段引用，请在原文中自行核对。'));
 }
 $('prepare-summary').textContent=doc.summary_job?'查看分批进度 / 继续摘要':answer?'重新生成整篇摘要':'查看整篇摘要计划';
 $('prepare-summary').disabled=!readiness.ready;
 $('summary-readiness').hidden=readiness.ready;$('summary-readiness').textContent=readiness.reason;
 $('summary-select-excerpt').hidden=readiness.ready;
 $('export-summary').hidden=!answer;
 $('browse-ai-history').hidden=!(doc.ai_answers||[]).length;
 $('browse-ai-history').textContent='浏览全部 AI 历史（'+(doc.ai_answers||[]).length+' 则）';
}
$('mode-passages').onclick=()=>{
 const doc=active();if(!doc)return;
 if(readingMode==='passages'){openPassage(passageAnchor||doc.readingPosition||doc.segments[0]?.id);return;}
 const origin=readingContext?.document===doc?readingContext:null;
 let cueId=selected||origin?.id||searchFocusedId;
 if(!doc.segments.some(cue=>cue.id===cueId))cueId=null;
 const query=$('search').value;
 if(!origin&&(query.trim()||notesOnly||excerptsOnly||speakerFilter!==null)){
  const matches=doc.segments.filter(cue=>matchesReadingSegment(cue,doc,query.trim().toLocaleLowerCase()));
  if(!matches.some(cue=>cue.id===cueId))cueId=matches[pageStart]?.id;
  captureReadingContext(cueId);
 }
 // The outer result snapshot owns filters; passages and their note detours read
 // full source context. Neither this anchor nor returning changes the bookmark.
 if(readingContext?.document===doc){$('search').value='';notesOnly=false;excerptsOnly=false;speakerFilter=null;searchFocusedId=null;}
 openPassage(cueId||passageAnchor||doc.readingPosition||doc.segments[0]?.id);
};
$('mode-summary').onclick=()=>setReadingMode('summary');
$('mode-transcript').onclick=()=>{const doc=active();if(contentIngressAllowed(doc)&&doc?.translation_view){doc.translation_view='';queueDocument(doc);}setReadingMode('transcript');render();};
$('mode-bilingual').onclick=()=>{const doc=active();if(!doc||!contentIngressAllowed(doc)||Coconut.isAudioProject(doc))return;const target=doc.translation_view||$('translation-target').value||'zh';if(doc.translation_view!==target){doc.translation_view=target;queueDocument(doc);}setReadingMode('transcript');render();};
$('prepare-bilingual').onclick=()=>{closeSummaryRequest(false);$('ai-task').value='translation';$('ai-task').dispatchEvent(new Event('change'));$('language-panel').open=true;$('ai-task').scrollIntoView?.({block:'center',behavior:'smooth'});$('translation-target').focus();};
$('summary-open-transcript').onclick=()=>{setReadingMode('transcript');$('search').focus();};
$('prepare-summary').onclick=()=>{
 const readiness=Coconut.summaryReadiness(active());
 if(!readiness.ready){$('ai-consent').checked=false;renderSummary();notice(readiness.reason);return;}
 $('summary-request').hidden=false;
 $('summary-request-slot').append($('ai-request-panel'));
 $('ai-request-panel').classList.add('summary-only');
 $('ai-task').value='summary';$('ai-filtered').checked=false;$('ai-consent').checked=false;
 $('ai-task').dispatchEvent(new Event('change'));
 $('summary-request-heading').scrollIntoView?.({block:'center',behavior:'smooth'});$('summary-request-heading').focus();
};
function closeSummaryRequest(restoreFocus=true) {
 $('ai-consent').checked=false;
 window.dispatchEvent(new Event('coconut-summary-stop'));
 if($('summary-request').hidden)return;
 $('summary-request').hidden=true;
 $('ai-request-home').append($('ai-request-panel'));
 $('ai-request-panel').classList.remove('summary-only');
 if(restoreFocus)$('prepare-summary').focus();
}
$('close-summary-request').onclick=()=>closeSummaryRequest();
$('summary-connection-setup').onclick=()=>$('language-setup').click();
function prepareExcerptQuestion(){
 closeSummaryRequest(false);setReadingMode('transcript');$('language-panel').open=true;
 $('ai-task').value='question';$('ai-filtered').checked=true;$('ai-consent').checked=false;
 $('ai-task').dispatchEvent(new Event('change'));
 $('search').focus();
 notice('先用搜索、摘录或笔记筛选较小范围，再填写问题。回答只依据所选片段，不会保存为整篇摘要。');
}
$('summary-select-excerpt').onclick=prepareExcerptQuestion;
$('ai-select-excerpt').onclick=prepareExcerptQuestion;
window.addEventListener('coconut-summary-updated',renderSummary);
$('export-summary').onclick=()=>{
 const doc=active();if(!doc||!Coconut.latestSummary(doc))return;
 let url,link;
 try{
  url=URL.createObjectURL(new Blob([Coconut.summaryMarkdown(doc)],{type:'text/markdown;charset=utf-8'}));
  link=el('a');link.href=url;link.download=doc.title.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,'_')+'.summary.md';link.hidden=true;document.body.append(link);link.click();
  notice('已发起摘要下载，包含引用与历史依据。请检查浏览器下载记录。', "success");
 }catch{notice('摘要导出失败，已保存的摘要仍在此页面，请重试。');}
 finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);}
};
$('resume-listening').onclick=()=>{
 const s=listeningSession;if(!s||$('resume-listening').hidden)return;
 const time=s.record.time;passagePlayback?.cancel();stopRepeating();
 s.player.pause();
 try{s.player.currentTime=time;s.preview=false;s.engaged=true;listeningStatus('已定位到 '+Coconut.time(time)+'；请点击播放器开始，未自动播放。');}
 catch{listeningStatus('暂时无法定位，请等待媒体加载后重试。');}
};
// File-backed object URLs stream from the user's selection; no upload-sized
// buffer, ASR permission, server, or model is involved in either local path.
async function inspectLocalMedia(file){
 const extension=file.name.split('.').pop().toLowerCase(),type=(file.type||'').toLowerCase();
 const supportedTypes=new Set(['audio/mpeg','audio/mp3','audio/mp4','audio/x-m4a','audio/wav','audio/x-wav','audio/ogg','audio/flac','audio/x-flac','audio/aac','audio/opus','video/mp4','video/webm','audio/webm','video/quicktime','video/x-m4v','application/octet-stream']);
 if(type&&!supportedTypes.has(type))throw new Error('请选择 MP3、M4A、WAV、OGG、FLAC、MP4、WebM 等实际音视频文件');
 const kind=type.startsWith('video/')?'video':type.startsWith('audio/')?'audio':['mp4','webm','mov','m4v'].includes(extension)?'video':['mp3','m4a','wav','ogg','flac','aac','opus'].includes(extension)?'audio':null;
 if(!kind||!Number.isSafeInteger(file.size)||file.size<=0)throw new Error('请选择可播放的音频或视频文件');
 const prefix=await file.slice(0,1024).text();
 if(/(?:mpegurl|scpls|dash\+xml)/i.test(type)||/^\s*(?:#EXTM3U|\[playlist\]|<\?xml|<MPD|<SmoothStreamingMedia|<ASX|<smil|<!doctype|<html)/i.test(prefix))throw new Error('请选择实际音视频文件，不支持会连接远程地址的播放列表');
 const identity=await fingerprintMedia(file);
 return {kind,identity};
}
async function localMediaMetadata(file,media){
 if(!media.identity)throw new Error('此页面无法核验文件，请使用安全页面或本地 Coconut；原有项目未改变');
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(media.identity));
 const source=Coconut.localMediaSource({version:1,kind:media.kind,name:file.name,size:file.size,last_modified:file.lastModified,type:file.type||'',fingerprint:Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')});
 if(!source)throw new Error('文件名或文件信息无效，请重新选择实际音视频文件');
 return source;
}
function chooseLocalMediaProject(matches,canCommit){
 return new Promise(resolve=>{
  const dialog=$('local-media-project-dialog'),host=$('local-media-project-options');host.replaceChildren();let settled=false;
  const finish=doc=>{if(settled)return;settled=true;pendingLocalMediaChoice=null;dialog.removeEventListener('close',cancel);dialog.removeEventListener('cancel',cancel);if(dialog.open)dialog.close();resolve(canCommit()?doc:null);};
  const cancel=event=>{if(event?.type==='close'&&dialog.open)return;event?.preventDefault();finish(null);};
  pendingLocalMediaChoice=finish;
  for(const doc of matches){
   const button=el('button','',doc.title);button.type='button';button.dataset.documentKey=doc.key;
   button.append(el('small','',Coconut.isAudioProject(doc)?'原声项目 · '+Coconut.projectAnnotationCount(doc)+' 项笔记与书签':doc.segments.length+' 段文字稿 · '+Coconut.projectAnnotationCount(doc)+' 项笔记与书签'));
   if(Coconut.hasNoteContent(doc.project_note))button.append(el('small','',doc.project_note.slice(0,100)));
   button.onclick=()=>finish(doc);host.append(button);
  }
  $('cancel-local-media-project').onclick=cancel;dialog.addEventListener('close',cancel);dialog.addEventListener('cancel',cancel);dialog.showModal();$('cancel-local-media-project').focus();
 });
}
$('local-media-file').addEventListener('cancel',()=>{localMediaPickerTarget=null;});
$('open-local-media').onclick=()=>{
 if(!contentIngressAllowed())return;
 cancelLocalImports('local-media-file');localMediaPickerTarget={revision:localImportRevision,selection:activeSelectionRevision,lifecycle:documentLifecycleRevision,workspace};$('local-media-file').click();
};
$('local-media-file').onchange=async()=>{
 const input=$('local-media-file'),file=input.files[0],target=localMediaPickerTarget;localMediaPickerTarget=null;
 if(!file)return;
 const revision=cancelLocalImports('local-media-file');let nextURL,installed=false;
 const canCommit=()=>!!target&&revision===localImportRevision&&target.selection===activeSelectionRevision&&target.workspace===workspace&&contentIngressAllowed();
 try{
  if(!target||target.revision!==revision-1)throw new Error('文件选择已取消，请重新打开本地音视频');
  const media=await inspectLocalMedia(file);if(!canCommit())return;
  const source=await localMediaMetadata(file,media);if(!canCommit())return;
  const candidate=Coconut.validate({project_kind:'audio_only',title:file.name,local_media_source:source,segments:[]});
  if(await wasRemovedSince(candidate,target.lifecycle)||!canCommit())return;
  const matches=state.documents.filter(doc=>doc.local_media_source?.fingerprint===source.fingerprint);
  const existing=matches.length>1?await chooseLocalMediaProject(matches,canCommit):matches[0];
  if(!canCommit()||matches.length>1&&!existing)return;
  if(existing&&!contentIngressAllowed(existing))throw new Error('这个项目正在移除或恢复，请稍候再打开');
  const doc=existing||{...candidate,key:'local-'+crypto.randomUUID()};
  nextURL=URL.createObjectURL(file);if(!canCommit()){URL.revokeObjectURL(nextURL);nextURL=null;return;}
  resetReaderForDocumentNavigation();
  if(!existing)state.documents.push(doc);
  const key=doc.key,previous=browserMedia.get(key);changeMediaSelection(key);
  browserMedia.set(key,{url:nextURL,...media,name:file.name,origin:'local'});installed=true;
  if(previous)URL.revokeObjectURL(previous.url);
  selectActiveDocument(key);workspace='read';setReadingMode(Coconut.isAudioProject(doc)?'transcript':prefersPassageReading(doc)?'passages':'transcript');mediaExpandedKey=Coconut.isAudioProject(doc)?key:null;mediaCollapsedKey=null;render();
  // The newly opened project owns this scroll now, never a later save receipt.
  $('title').scrollIntoView?.({block:'start'});
  const receipt=existing?{ok:true,identity:doc}:await commitDocument(doc);
  if(active()===doc&&browserMedia.get(key)?.url===nextURL&&contentIngressAllowed(doc))notice(receipt.ok?(existing?'已打开原有项目，笔记和文字稿保留。':'本地原声项目已保存，可直接回听、写笔记和时间书签。')+'文件未上传，未运行识别或 AI；请自行点击播放。':'项目已在本页打开，但尚未保存。请先导出 JSON 备份；媒体文件需另行保留。',receipt.ok?'success':'');
 }catch(error){if(nextURL&&!installed)URL.revokeObjectURL(nextURL);if(revision===localImportRevision)notice('打开本地音视频失败：'+error.message);}
 finally{if(revision===localImportRevision)input.value='';}
};
$('reader-media-file').addEventListener('cancel',()=>{pendingMediaDocument=null;});
$('attach-reader-media').onclick=()=>{const doc=active();pendingMediaDocument=doc?{key:doc.key,document:doc,source:projectSourceSnapshot(doc)}:null;if(pendingMediaDocument)$('reader-media-file').click();};
$('reader-media-file').onchange=async()=>{
 const input=$('reader-media-file'),file=input.files[0],target=pendingMediaDocument;pendingMediaDocument=null;
 if(!file)return;
 const key=target?.key,revision=changeMediaSelection(key);let nextURL;
 const canCommit=()=>target&&contentIngressAllowed(target.document)&&state.documents.find(doc=>doc.key===key)===target.document&&projectSourceSnapshot(target.document)===target.source&&mediaSelectionRevision(key)===revision;
 try{
  if(!target||!canCommit())throw new Error('原文字稿已关闭，请重新选择');
  const {kind,identity}=await inspectLocalMedia(file);if(!canCommit())return;
  if(target.document.local_media_source){
   const source=await localMediaMetadata(file,{kind,identity});if(!canCommit())return;
   if(source.fingerprint!==target.document.local_media_source.fingerprint)throw new Error('文件信息或部分内容与原文件不同。请重新选择「'+target.document.local_media_source.name+'」；若要打开另一份文件，请从「添加内容」打开本地音视频。现有笔记与书签未改变');
  }
  nextURL=URL.createObjectURL(file);const previous=browserMedia.get(key);
  if(key===active()?.key){stopRepeating();$('source-media').querySelector('audio,video')?.pause();}
  browserMedia.set(key,{url:nextURL,kind,name:file.name,identity,origin:'local'});if(previous)URL.revokeObjectURL(previous.url);
  if(key===active()?.key){render();notice('媒体只在本次页面读取，未上传。请核对内容和文字稿对应；刷新后重新选择文件即可继续回听。', "success");}
 }catch(error){if(nextURL)URL.revokeObjectURL(nextURL);if(!target||active()===target.document)notice('打开媒体失败：'+error.message);}
 finally{input.value='';}
};
$('detach-reader-media').onclick=()=>{
 const key=active()?.key,attachment=browserMedia.get(key);if(!attachment)return;
 changeMediaSelection(key);
 stopRepeating();$('source-media').querySelector('audio,video')?.pause();browserMedia.delete(key);URL.revokeObjectURL(attachment.url);render();
};

$('attach-project-transcript').onclick=()=>{const doc=active();if(Coconut.isAudioProject(doc)){projectTranscriptTarget={key:doc.key,document:doc,source:projectSourceSnapshot(doc)};$('project-transcript-file').click();}};
$('project-transcript-file').onchange=async()=>{
 const input=$('project-transcript-file'),file=input.files[0],target=projectTranscriptTarget;projectTranscriptTarget=null;
 if(!file)return;
 const revision=cancelLocalImports('project-transcript-file');
 const ownsRequest=()=>revision===localImportRevision;
 const canCommit=()=>ownsRequest()&&state.active===target?.key&&workspace==='read'&&state.documents.find(doc=>doc.key===target.key)===target.document;
 try{
  if(!target)throw new Error('请从目标原声项目重新选择文字稿');
  const review=localFileReview(file,canCommit);
  if(review!==true&&!(await review))return;
  if(!canCommit())return;
  const value=await file.text();
  if(!canCommit())return;
  const text=Coconut.parse(value,file.name);
  const persisted=await attachTranscriptToProject(text,target);
  if(ownsRequest()&&active()===persisted.identity&&contentIngressAllowed(persisted.identity))notice(persisted.ok?'文字稿已附加到当前项目，原有笔记、时间书签与媒体保留。未调用识别、翻译或摘要模型。':'文字稿已在本页附加，但未能保存，请立即导出 JSON 备份。');
 }catch(error){if(ownsRequest())notice('补充文字稿失败：'+localFileError(error));}
 finally{if(ownsRequest())input.value='';}
};

async function attachTranscriptToProject(text,target,{canCommit=null,activate=false,publisher=false}={}){
 const index=state.documents.findIndex(doc=>doc.key===target?.key),original=state.documents[index];
 // Both entry points must own the exact object and captured source. Discovery
 // supplies its own live request/navigation owner, never the active reader key.
 const ownsWorkspace=canCommit?canCommit():state.active===target?.key&&workspace==='read';
 if(!contentIngressAllowed(original)||!original||original!==target?.document||!ownsWorkspace||!Coconut.isAudioProject(original)||projectSourceSnapshot(original)!==target.source)throw new Error('目标项目已经切换或更新，本次未附加文字稿，请重新选择');
 if(publisher&&(!Coconut.podcastMediaIdentity(original)||Coconut.podcastMediaIdentity(original)!==Coconut.podcastMediaIdentity(text)))throw new Error('发布者媒体地址或类型已变化，未把新文字稿配到旧原声。请重新发现并保存来源，或选择单独导入。');
 const attached={...Coconut.attachProjectTranscript(original,text),key:original.key};
 captureAudioBookmarkDrafts();
 state.documents[index]=attached;
 if(activate){selectActiveDocument(attached.key);workspace='read';passageReturn=null;passageDocumentKey=attached.key;passageAnchor=attached.segments[0]?.id||null;mediaExpandedKey=null;}
 selected=null;pageStart=0;notesOnly=false;excerptsOnly=false;speakerFilter=null;searchFocusedId=null;$('search').value='';
 const mediaRevision=mediaSelectionRevision(attached.key),selectionRevision=activeSelectionRevision,receipt=commitDocument(attached);setReadingMode('transcript');render();return {...await receipt,mediaRevision,selectionRevision};
}


// Last-resort protection, not a backup: browsers require prior user activation,
// show their own text, and may omit this event on mobile or process termination.
// Keep the existing export warnings. Attach only while actual changes remain.
// https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event
function hasPendingOrFailedContent(){return libraryStore.status().unsaved>0;}
function hasUnsavedReaderChanges(){return hasPendingOrFailedContent()||hasUnsubmittedReaderDrafts();}
function hasUnsubmittedReaderDrafts() {
 if(removedDocument||pendingLibraryOperation||[...deferredContentInputs.values()].some(draft=>state.documents.includes(draft.doc))||hasLanguageDrafts()||window.CoconutTranslationReview?.hasDraft())return true;
 const current=active();
 if(current&&selected&&!$('notes-panel').hidden&&current.segments.some(segment=>segment.id===selected)&&$('note').value!==(current.notes[selected]||''))return true;
 const formKey=$('audio-project').dataset.documentKey;
 for(const [key,draft] of audioBookmarkDrafts){
  const doc=state.documents.find(item=>item.key===key);if(!doc||key===formKey)continue;
  if(draft.time.trim()||draft.note.trim()||[...draft.edits].some(([id,value])=>{const item=doc.timestamp_bookmarks?.find(item=>item.id===id);return item&&Coconut.parseReadingTime(value)!==item.time;}))return true;
 }
 const formDoc=state.documents.find(doc=>doc.key===formKey);
 if(Coconut.hasProjectAnnotations(formDoc)){
  if(active()===formDoc&&!$('audio-project').hidden&&$('project-note').value!==formDoc.project_note)return true;
  for(const input of active()===formDoc&&!$('audio-project').hidden?document.querySelectorAll('#audio-bookmarks textarea'):[]){
   const original=formDoc.timestamp_bookmarks.find(item=>item.id===input.closest('[data-bookmark-id]')?.dataset.bookmarkId);
   if(original&&input.value!==original.note)return true;
  }
  const visibleIds=new Set([...document.querySelectorAll('#audio-bookmarks form')].map(form=>form.parentElement.dataset.bookmarkId));
  for(const [id,value] of audioBookmarkDrafts.get(formKey)?.edits||[]){
   const original=formDoc.timestamp_bookmarks.find(item=>item.id===id);
   if(!visibleIds.has(id)&&original&&Coconut.parseReadingTime(value)!==original.time)return true;
  }
  if($('audio-bookmark-time').value.trim()||$('audio-bookmark-note').value.trim())return true;
  for(const form of document.querySelectorAll('#audio-bookmarks form')){
   const original=formDoc.timestamp_bookmarks.find(item=>item.id===form.parentElement.dataset.bookmarkId);
   if(!form.hidden&&original&&Coconut.parseReadingTime(form.querySelector('input').value)!==original.time)return true;
  }
 }
 if($("edit-dialog").open && editingTarget){
  const doc=state.documents.find(d=>d.key===editingTarget.documentKey);
  const segment=doc?.segments.find(s=>s.id===editingTarget.segmentId);
  if(segment && $("edit-segment").value!==segment.text)return true;
 }
 if($("source-dialog").open){
  const doc=state.documents.find(d=>d.key===sourceTarget);
  if(doc && $("source-url").value!==(doc.source_url||""))return true;
 }
 if($("details-dialog").open){
  const doc=state.documents.find(d=>d.key===detailsTarget);
  if(doc && ($("document-title").value!==doc.title || $("document-language").value!==(doc.language||"")))return true;
 }
 return false;
}
function warnUnsavedUnload(event) {
 // Recheck in case a dialog was just canceled or an edit was saved.
 if(!hasUnsavedReaderChanges()){syncUnsavedUnloadGuard();return;}
 event.preventDefault();event.returnValue=true;
}
function syncUnsavedUnloadGuard() {
 const dirty=hasUnsavedReaderChanges();
 if(dirty===unloadGuardAttached)return;
 unloadGuardAttached=dirty;
 if(dirty)window.addEventListener("beforeunload",warnUnsavedUnload);
 else window.removeEventListener("beforeunload",warnUnsavedUnload);
}
// The trusted Electron preload exposes this capability before reader scripts.
// Desktop close/quit uses its own native approval gate before service teardown;
// Web beforeunload remains separate.
if(!window.coconutUpdates){
 unloadGuardReady=true;
 // Input handlers register pending content first; the guard clears only on its receipt.
 for(const event of ["input","change","click","submit"])document.addEventListener(event,syncUnsavedUnloadGuard);
 // Dialog close does not bubble; capture also covers native Escape/Cancel.
 document.addEventListener("close",syncUnsavedUnloadGuard,true);
 syncUnsavedUnloadGuard();
}
