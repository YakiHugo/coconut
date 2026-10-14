"use strict";
let quotationController;
let exactNoteEditor=null;
let speakerEditor=null;
let sourceCorrectionEditor=null,sourceCorrectionUndo=null;
const sourceCorrectionSaves=new WeakMap();
const $ = (id) => document.getElementById(id);
const KEY = "coconut-reader-v1";
const ACTIVE_KEY = "coconut-reader-active-v1";
const LAST_ACTIVE_KEY = "coconut-reader-last-active-v1";
let state = { documents: [], active: null };
// Recovery results retain small identity tokens, never removed document copies.
let libraryRestoreReport=null,libraryRestorePage=0,libraryRestoreSequence=0,libraryRestorePainted='';
const libraryRestoreIdentities=new WeakMap();
let libraryRestoreIdentitySequence=0;
const LIBRARY_RESTORE_PAGE_SIZE=25;
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
function localJobIdentity(doc){
 const binding=doc?.local_job_binding;
 return binding&&typeof binding.id==='string'&&typeof binding.fingerprint==='string'&&/^[a-f0-9]{32}$/.test(binding.id)&&/^[a-f0-9]{64}$/.test(binding.fingerprint)?'job:'+binding.id+':'+binding.fingerprint:'';
}
function documentSourceIdentity(doc){return localJobIdentity(doc)||Coconut.audioProjectIdentity(doc)||(doc.source_media?JSON.stringify(doc.source_media):'');}
async function jobSourceBinding(doc,id){
 if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))return null;
 // Only optional playback metadata changes when an import job resumes its
 // completed transcript. Keep every other source field in the exact identity.
 const source=Coconut.validate(doc);delete source.source_media;
 if(source.provenance){source.provenance={...source.provenance};delete source.provenance.playback_warning;if(!Object.keys(source.provenance).length)delete source.provenance;}
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(source)));
 return {id,fingerprint:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')};
}

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
// Find is a temporary journey within one live document. Keep source identity,
// not a second saved reading position or a document snapshot to restore later.
let readingSearchSession=null,restoringReadingSearchFocus=false;
const readingContextHome=document.createComment('reading context home');
$('reading-context').before(readingContextHome);
let workspace = "read";
let readingScroll = 0;
let readingViewOwner=null;
let editingTarget = null;
let sourceTarget = null;
let sourceTargetIdentity = null;
let localImportRevision = 0;
let projectTranscriptTarget = null;
let localMediaPickerTarget=null,pendingLocalMediaChoice=null;
function projectSourceSnapshot(doc){return JSON.stringify(doc.podcast_source||doc.local_media_source);}
let pendingBackupReview = null;
let pendingSubtitleEncoding = null;
let pasteSubtitleRevision=0,pasteSubtitlePreview=null,pasteSubtitleAttempt=null,pasteSubtitleReceipt=null,pasteSubtitleTarget=null;
let transcriptImportBatch = null;
let transcriptDragDepth = 0;
function cancelLocalImports(keepInput = null) {
 resetTranscriptDropTarget();
 localImportRevision++;
 stopTranscriptImportBatch();
 pendingLocalMediaChoice?.(null);
 if(keepInput!=="local-media-file")localMediaPickerTarget=null;
 if(keepInput!=="reader-media-file"&&pendingMediaDocument?.durable)cancelReaderMediaSelection(pendingMediaDocument,{resume:false});
 pendingBackupReview?.(false);
 pendingSubtitleEncoding?.(null);
 retirePastedSubtitleImport();
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
// JSON keeps its backup contract. Subtitle bytes live only for this attempt;
// no encoding guess or lossy File.text() result can enter the save pipeline.
async function readTranscriptFile(file,canCommit,{batch=null,item=null}={}){
 if(file.name.toLowerCase().endsWith('.json')){
  const text=await file.text();
  if(!canCommit())return null;
  // Blob.text() is UTF-8: every decoding error produces U+FFFD. Only that
  // case needs a second byte read, avoiding another large backup buffer for
  // ordinary JSON while distinguishing a real, valid U+FFFD in the source.
  if(!text.includes('\ufffd'))return text;
  const bytes=await file.arrayBuffer();if(!canCommit())return null;
  try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);return text;}
  catch{throw new Error('JSON 备份包含无法按 UTF-8 解码的字节，未导入。请保留原文件并重新导出 UTF-8 JSON；字幕编码选项不适用于 JSON。');}
 }
 const bytes=new Uint8Array(await file.arrayBuffer());
 if(!canCommit())return null;
 const decoded=Coconut.decodeSubtitleBytes(bytes);
 if(decoded.ok)return decoded.text;
 if(item){item.status='encoding';renderTranscriptImportBatch(batch);}
 return chooseSubtitleEncoding(file,bytes,decoded,canCommit,!!batch);
}
function chooseSubtitleEncoding(file,bytes,initial,canCommit,batch){
 return new Promise(resolve=>{
  const dialog=$('subtitle-encoding-dialog'),select=$('subtitle-encoding'),preview=$('subtitle-encoding-preview'),status=$('subtitle-encoding-status'),confirm=$('confirm-subtitle-encoding');
  let settled=false,decoded=null;
  const returnFocus=document.activeElement;
  const finish=value=>{
   if(settled)return;settled=true;
   dialog.removeEventListener('close',cancel);dialog.removeEventListener('cancel',cancel);
   select.onchange=null;confirm.onclick=null;$('cancel-subtitle-encoding').onclick=null;$('stop-subtitle-encoding').onclick=null;
   pendingSubtitleEncoding=null;preview.textContent='';decoded=null;bytes=null;
   const owned=canCommit();if(dialog.open)dialog.close();
   if(owned&&value===null){
    const target=returnFocus?.isConnected&&returnFocus!==document.body&&!returnFocus.closest('[hidden],[inert]')?returnFocus:workspace==='read'&&Coconut.isAudioProject(active())?$('attach-project-transcript'):$('import');
    target?.focus({preventScroll:true});
   }
   resolve(owned?value:null);
  };
  const cancel=event=>{
   if(event?.type==='close'&&dialog.open)return;
   event?.preventDefault();
   if(batch&&['cancel','close'].includes(event?.type))cancelLocalImports();
   finish(null);
  };
  pendingSubtitleEncoding=finish;
  $('subtitle-encoding-file').textContent=file.name;
  $('subtitle-encoding-reason').textContent=initial.error;
  select.replaceChildren();const placeholder=el('option','','请选择原文件编码');placeholder.value='';select.append(placeholder);
  for(const option of Coconut.subtitleEncodings()){
   const node=el('option','',option.label+(option.available?'':'（此浏览器不可用）'));node.value=option.id;node.disabled=!option.available;select.append(node);
  }
  preview.textContent='';status.textContent='选择编码后显示原文件文字预览；请确认文字可读，再导入。';confirm.disabled=true;
  select.onchange=()=>{
   if(!canCommit()){finish(null);return;}
   decoded=null;preview.textContent='';confirm.disabled=true;
   if(!select.value){status.textContent='请选择原文件编码。';return;}
   const candidate=Coconut.decodeSubtitleBytes(bytes,select.value);
   if(!candidate.ok){status.textContent=candidate.error;return;}
   preview.textContent=candidate.text.slice(0,4000).replace(/[\uD800-\uDBFF]$/,'');
   try{
    const parsed=Coconut.parseWithDiagnostics(candidate.text,file.name);
    status.textContent='可读取 '+parsed.document.segments.length+' 段字幕'+(parsed.diagnostics.length?'，另有 '+parsed.diagnostics.length+' 个字幕块未识别（导入后可查看行号）':'')+'。'+(candidate.text.length>4000?'预览为前 4,000 个字符；完整文件已解码检查。':'已显示完整文字。')+' 请核对是否有乱码。';
    decoded=candidate;confirm.disabled=false;
   }catch(error){status.textContent='字节已解码，但无法解析字幕：'+localFileError(error)+'。请重新选择编码或取消检查原文件。';}
  };
  confirm.onclick=()=>{if(decoded?.ok)finish(decoded.text);};
  $('cancel-subtitle-encoding').textContent=batch?'跳过此文件':'取消导入';$('cancel-subtitle-encoding').onclick=cancel;
  $('stop-subtitle-encoding').hidden=!batch;$('stop-subtitle-encoding').onclick=()=>cancelLocalImports();
  dialog.addEventListener('close',cancel);dialog.addEventListener('cancel',cancel);dialog.showModal();select.focus();
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
const persistedLocalMediaSources = new WeakMap();
const pendingStructuralDocuments = new Map();
let pendingLibraryOperation = null;
const deferredContentInputs = new Map();
function summaryCheckpointSignature(job){return job?JSON.stringify([job.provider,job.snapshot,job.results]):null;}
function summaryCheckpointSaved(doc){return !!doc?.summary_job&&persistedSummaryJobs.get(doc)===summaryCheckpointSignature(doc.summary_job);}
function persistenceCheckpoint(doc){return {answerCount:(doc.ai_answers||[]).length,summarySignature:summaryCheckpointSignature(doc.summary_job),localMediaSource:doc.local_media_source?JSON.stringify(doc.local_media_source):null};}
function recordPersistenceCheckpoint(doc,checkpoint){
 if(persistedLocalMediaSources.has(doc)&&persistedLocalMediaSources.get(doc)!==checkpoint.localMediaSource)retireRememberedMedia(doc);
 persistedLocalMediaSources.set(doc,checkpoint.localMediaSource);
 persistedAIAnswerCounts.set(doc,checkpoint.answerCount);persistedSummaryJobs.set(doc,checkpoint.summarySignature);
}
let mediaWorkerReady = false;
let readingMode = "summary";
let subtitleExportDocument=null,subtitleExportLanguage='';
let demoToolsExpanded=false;
const PASSAGES_PER_PAGE=8;
let passageDocumentKey=null,passageAnchor=null,passagePageStart=0,passageReturn=null;
let passageTranslations=true,mediaExpandedKey=null,passagePlayback=null;
let noticeTimer=null,readingSettingsPriorOpen=null,headerDocumentKey=null,mediaCollapsedKey=null;
const compactReadingViewport=window.matchMedia('(max-width:650px)');
let transcriptToolsDocumentKey=null,headerCompositionMode=null,deferredHeaderComposition=false;
document.addEventListener('focusout',event=>{
 if(!deferredHeaderComposition||$('reading-settings').contains(event.relatedTarget))return;
 queueMicrotask(()=>{if(deferredHeaderComposition&&!$('reading-settings').contains(document.activeElement))composeReadingHeader();});
});
compactReadingViewport.addEventListener('change',()=>composeReadingHeader());
function shortTranscriptCompact(doc=active()){
 return workspace==='read'&&readingMode==='transcript'&&compactReadingViewport.matches&&doc&&
  !Coconut.isAudioProject(doc)&&doc.provenance?.kind!=='authored_demo'&&doc.segments.length>0&&doc.segments.length<12;
}
function revealTranscriptTools(){$('transcript-tools-disclosure').open=true;}
function focusReadingSearch(options){revealTranscriptTools();$('search').focus(options);}

function prefersPassageReading(doc){return !Coconut.isAudioProject(doc)&&doc?.provenance?.kind!=='authored_demo'&&doc?.segments.length>=12;}
// Choose only on document entry. Ordinary renders and explicit view switches
// retain the reader's current choice; saved language selection is independent.
function defaultReadingMode(doc){
 if(!doc||Coconut.isAudioProject(doc))return 'summary';
 if(prefersPassageReading(doc))return 'passages';
 if(doc.provenance?.kind==='authored_demo')return 'transcript';
 return Coconut.latestSummary(doc)||doc.summary_job?'summary':'transcript';
}
const browserMedia = new Map();
const mediaSelectionRevisions = new Map();
function mediaSelectionRevision(key){return mediaSelectionRevisions.get(key)||0;}
function changeMediaSelection(key,notify=true){const revision=mediaSelectionRevision(key)+1;mediaSelectionRevisions.set(key,revision);if(notify)window.dispatchEvent(new CustomEvent('coconut-media-selection-change',{detail:{key}}));return revision;}
let pendingMediaDocument = null,readerMediaRequestRevision=0;
function canAssociateLocalMedia(doc){return Boolean(doc&&!Coconut.isAudioProject(doc)&&!Coconut.isReadingCollection(doc)&&doc.segments?.length&&!doc.podcast_source&&!doc.source_media&&!doc.local_job_binding);}
function localMediaBindingSnapshot(doc){return JSON.stringify([doc.local_media_source,doc.podcast_source,doc.source_media,doc.local_job_binding]);}
// Desktop-only references are private to this database lifetime and document
// epoch. Content JSON continues to contain only the portable source metadata.
const rememberedMediaStates=new WeakMap();
const detachedRememberedMedia=new WeakSet();
const pendingNativeMediaSelections=new WeakMap();
const pendingRememberedReplacements=new Map();
let nativeMediaInitialization=null;
let nativeMediaLibrary=null,nativeMediaReady=false,nativeMediaClosed=false,nativeMediaError=false;
// Serialize complete mutations, including stale-success cleanup, so a late
// opt-in cannot forget a newer explicit opt-in for the same owner.
let nativeMediaMutation=Promise.resolve();
function mutateRememberedMedia(operation){const next=nativeMediaMutation.then(operation,operation);nativeMediaMutation=next.catch(()=>{});return next;}
function releaseMediaAttachment(attachment){
 if(!attachment)return;
 if(attachment.nativeToken)void window.coconutLocalMedia?.release(attachment.nativeToken).catch(()=>{});
 else URL.revokeObjectURL(attachment.url);
}
function rememberedMediaOwner(doc){
 const source=doc?.local_media_source,epoch=libraryAdapter.documentEpoch?.(doc?.key);
 if(!nativeMediaReady||nativeMediaClosed||!source||!epoch||!state.documents.includes(doc)||libraryAdapter.status?.().error||persistedLocalMediaSources.get(doc)!==JSON.stringify(source))return null;
 return {library:nativeMediaLibrary,key:doc.key,epoch,source:{...source}};
}
function rememberedMediaState(doc){
 const owner=rememberedMediaOwner(doc);if(!owner)return null;
 let entry=rememberedMediaStates.get(doc);
 if(!entry||JSON.stringify(entry.owner)!==JSON.stringify(owner)){
  entry={owner,status:'unchecked',checked:false,suppressed:detachedRememberedMedia.has(doc),revision:0,pending:false};rememberedMediaStates.set(doc,entry);
 }
 return entry;
}
function rememberedMediaCurrent(doc,entry){return rememberedMediaStates.get(doc)===entry&&JSON.stringify(rememberedMediaOwner(doc))===JSON.stringify(entry.owner);}
const rememberedMediaMessages={
 remembered:'已在这台电脑记住原文件；重新打开项目时仅载入，不自动播放。',
 ready:'已从这台电脑载入原文件，未自动播放。文件信息与部分内容匹配，不是完整内容核验。',
 missing:'找不到记住的原文件。请连接原磁盘后重试，或重新选择原文件；笔记与书签仍保留。',
 changed:'记住的原文件信息或内容已改变。请重新选择原文件并核对声音；笔记与书签仍保留。',
 unavailable:'暂时无法读取或保存原文件引用。请重新选择文件或重试；笔记与书签仍保留。',
 'forget-failed':'旧引用未能取消，重启仍可能载入之前记住的原文件。请点“不再记住”重试，或勾选以记住本次选择。',
 forgotten:'已不再记住原文件。原文件没有删除；已载入的本次媒体不受影响。'
};
function renderRememberedMedia(doc=active(),attachment=browserMedia.get(doc?.key)){
 const host=$('remember-local-media'),entry=doc?rememberedMediaState(doc):null;
 // Note-save receipts also refresh this panel. Keep settled controls and text
 // unchanged so a dock interaction cannot churn the off-screen media header.
 const write=(node,key,value)=>{if(node[key]!==value)node[key]=value;};
 write(host,'hidden',!window.coconutLocalMedia||!doc?.local_media_source||libraryAdapter.backend!=='indexeddb');
 if(host.hidden)return;
 const replacing=pendingRememberedReplacements.get(doc.key),saved=entry&&contentIngressAllowed(doc),remembered=entry&&['remembered','ready','missing','changed'].includes(entry.status);
 write($('remember-local-media-choice'),'checked',Boolean(remembered));
 write($('remember-local-media-choice'),'disabled',Boolean(!saved||entry.pending||!!replacing||!attachment?.file||attachment.origin!=='local'));
 write($('forget-local-media'),'hidden',!entry||!entry.known);
 write($('forget-local-media'),'disabled',Boolean(!saved||entry.pending));
 write($('retry-remembered-media'),'hidden',!entry||entry.pending||entry.suppressed||!!attachment||!['missing','unavailable','changed'].includes(entry.status));
 write($('remember-local-media-status'),'textContent',!nativeMediaReady?(nativeMediaError?'本机原文件引用暂不可用；可重新选择文件继续回听。':'正在准备本机原文件引用…'):!entry?'请先成功保存项目，再记住原文件。':replacing?(replacing.phase==='save-failed'?'请先成功保存这次更换，再选择是否记住当前文件。':'正在保存更换并处理旧原文件引用…'):entry.pending?'正在处理原文件引用…':entry.suppressed&&!attachment&&!['forgotten','unavailable'].includes(entry.status)?'本次已移除媒体。重新选择后可继续回听；不会自动重新载入。':entry.status==='unchecked'&&entry.known?'之前记住的原文件引用仍保留。勾选可改为本次选择，或点“不再记住”取消。':rememberedMediaMessages[entry.status]||'可选：不复制文件，不上传；移动、删除或更改文件后可能需要重新选择。');
}
function queueRememberedMedia(doc){
 const entry=rememberedMediaState(doc);
 if(!entry||entry.checked||entry.pending||entry.suppressed||detachedRememberedMedia.has(doc)||pendingNativeMediaSelections.has(doc)||pendingRememberedReplacements.has(doc.key)||browserMedia.has(doc.key)||active()!==doc||workspace!=='read'||!contentIngressAllowed(doc))return;
 entry.checked=true;void restoreRememberedMedia(doc,entry);
}
async function restoreRememberedMedia(doc,entry){
 const revision=++entry.revision,selection=activeSelectionRevision,mediaRevision=mediaSelectionRevision(doc.key),ingress=localImportRevision;
 const owns=()=>rememberedMediaCurrent(doc,entry)&&entry.revision===revision&&!entry.suppressed&&active()===doc&&workspace==='read'&&activeSelectionRevision===selection&&mediaSelectionRevision(doc.key)===mediaRevision&&localImportRevision===ingress&&contentIngressAllowed(doc)&&!browserMedia.has(doc.key);
 entry.pending=true;renderRememberedMedia(doc);
 let result;
 try{result=await window.coconutLocalMedia.resolve(entry.owner);}catch{result={status:'unavailable'};}
 if(!owns()){
  if(result.token)void window.coconutLocalMedia.release(result.token).catch(()=>{});
  if(entry.revision===revision){entry.pending=false;entry.checked=false;}
  if(active()===doc){renderRememberedMedia(doc);queueMicrotask(()=>queueRememberedMedia(doc));}
  return;
 }
 entry.pending=false;entry.status=result.status;entry.known=['ready','missing','changed','unavailable'].includes(result.status);
 if(result.status==='ready'){
  browserMedia.set(doc.key,{url:result.url,nativeToken:result.token,kind:result.kind,name:result.name,identity:result.identity,origin:'local'});
  // Update only the player and its controls. Never replace an editor, expand
  // settings, seek to saved progress, or start playback on native completion.
  renderSourceMedia(doc);renderMediaTiming();passagePlayback?.sync();refreshPlaybackDock();
  if($('episode-media').hidden)setReaderMediaLabel('本地原声已就绪 · 打开回听','原声');
 }else renderRememberedMedia(doc);
}
$('remember-local-media-choice').onchange=async()=>{
 const doc=active(),attachment=browserMedia.get(doc?.key),entry=doc?rememberedMediaState(doc):null;
 if(!$('remember-local-media-choice').checked){await forgetRememberedMedia(doc,entry);return;}
 if(!entry||entry.pending||pendingRememberedReplacements.has(doc.key)||!attachment?.file||!contentIngressAllowed(doc)){renderRememberedMedia(doc);return;}
 const revision=++entry.revision;entry.pending=true;renderRememberedMedia(doc);
 await mutateRememberedMedia(async()=>{
  let result;try{result=await window.coconutLocalMedia.remember(entry.owner,attachment.file,attachment.identity);}catch{result={status:'unavailable'};}
  // Navigation alone preserves the explicit opt-in. A retired source or newer
  // file selection cannot inherit its receipt or leave a stale durable entry.
  if(!rememberedMediaCurrent(doc,entry)||entry.revision!==revision||browserMedia.get(doc.key)!==attachment){
   if(result.status==='remembered')await window.coconutLocalMedia.forget(entry.owner).catch(()=>{});
   if(entry.revision===revision)entry.pending=false;
   return;
  }
  entry.pending=false;entry.status=result.status;entry.known=result.status==='remembered'||entry.known;entry.checked=true;entry.suppressed=false;
  if(active()===doc)renderRememberedMedia(doc);
 });
};
async function forgetRememberedMedia(doc,entry){
 if(!entry||entry.pending||!contentIngressAllowed(doc)){renderRememberedMedia(doc);return;}
 const revision=++entry.revision;entry.pending=true;entry.suppressed=true;entry.checked=true;renderRememberedMedia(doc);
 let result;try{result=await mutateRememberedMedia(()=>window.coconutLocalMedia.forget(entry.owner));}catch{result={status:'unavailable'};}
 if(!rememberedMediaCurrent(doc,entry)||entry.revision!==revision)return;
 entry.pending=false;entry.status=['forgotten','not-remembered'].includes(result.status)?'forgotten':'unavailable';if(entry.status==='forgotten')entry.known=false;
 if(active()===doc)renderRememberedMedia(doc);
}
$('forget-local-media').onclick=()=>forgetRememberedMedia(active(),rememberedMediaStates.get(active()));
$('retry-remembered-media').onclick=()=>{const doc=active(),entry=rememberedMediaStates.get(doc);if(entry&&!entry.pending&&contentIngressAllowed(doc))void restoreRememberedMedia(doc,entry);};
function suppressRememberedMedia(doc,{detached=false}={}){if(detached)detachedRememberedMedia.add(doc);const entry=rememberedMediaState(doc)||rememberedMediaStates.get(doc);if(entry){entry.revision++;entry.pending=false;entry.checked=true;entry.suppressed=true;}}
function selectedRememberedMedia(doc){
 detachedRememberedMedia.delete(doc);
 const entry=rememberedMediaState(doc)||rememberedMediaStates.get(doc);if(!entry)return;
 entry.revision++;entry.pending=false;entry.suppressed=false;entry.checked=true;
 // Reselection is explicit but does not silently renew consent for a new path.
 // Keep a previous reference available to forget, and offer unchecked opt-in.
 entry.status='unchecked';
}
function retireRememberedMedia(doc,{removed=false}={}){
 if(removed&&pendingRememberedReplacements.get(doc.key)?.document===doc)pendingRememberedReplacements.delete(doc.key);
 const entry=rememberedMediaStates.get(doc);if(!entry)return;
 entry.revision++;entry.pending=false;entry.suppressed=true;
 void mutateRememberedMedia(()=>window.coconutLocalMedia?.forget(entry.owner)).catch(()=>{});rememberedMediaStates.delete(doc);
}
// Explicit replacement retires the old reference even when the bounded
// candidate is identical. Keep this owner through a failed save and its Retry;
// a new opt-in waits until the successful content receipt and cleanup settle.
function beginRememberedReplacement(doc){
 if(!window.coconutLocalMedia||libraryAdapter.backend!=='indexeddb')return null;
 const previous=pendingRememberedReplacements.get(doc.key),epoch=libraryAdapter.documentEpoch?.(doc.key);
 if(!epoch)return null;
 const operation={key:doc.key,document:doc,owner:previous?.owner||{key:doc.key,epoch,source:{...doc.local_media_source}},generation:0,phase:'saving',completion:null};
 pendingRememberedReplacements.set(doc.key,operation);return operation;
}
function finishRememberedReplacement(operation){
 if(operation.completion)return operation.completion;
 operation.phase='cleanup';
 const entry=rememberedMediaStates.get(operation.document),revision=entry?.revision;
 operation.completion=(async()=>{
  await nativeMediaInitialization;
  let result;try{result=nativeMediaLibrary?await mutateRememberedMedia(()=>window.coconutLocalMedia.forget({...operation.owner,library:nativeMediaLibrary})):{status:'unavailable'};}catch{result={status:'unavailable'};}
  const forgotten=['forgotten','not-remembered'].includes(result.status);
  if(pendingRememberedReplacements.get(operation.key)===operation){
   pendingRememberedReplacements.delete(operation.key);
   if(entry&&rememberedMediaStates.get(operation.document)===entry&&entry.revision===revision){entry.known=!forgotten;entry.status=forgotten?'unchecked':'forget-failed';entry.checked=true;}
   if(active()?.key===operation.key)renderRememberedMedia();
  }
  return forgotten;
 })();return operation.completion;
}
function committedRememberedReplacements(result){
 if(!result?.ok)return;
 for(const captured of result.checkpoints){
  const operation=pendingRememberedReplacements.get(captured.key);
  // A later full-document receipt also covers a failed replacement's Retry
  // or an explicit newer source/unlink; never a prior captured generation.
  if(operation&&captured.identity===operation.document&&captured.generation>=operation.generation)void finishRememberedReplacement(operation);
 }
}
async function initializeRememberedMedia(){
 if(!window.coconutLocalMedia||libraryAdapter.backend!=='indexeddb'||!libraryLoad.ok||!libraryAdapter.mediaLibraryIdentity)return;
 try{
  const result=await libraryAdapter.mediaLibraryIdentity();if(!result.ok||nativeMediaClosed)throw new Error('unavailable');
  nativeMediaLibrary=result.identity;nativeMediaReady=true;
  // Keep each saved owner's small state even before its first visit, so
  // removing a different shelf entry can retire its reference immediately.
  const owners=state.documents.map(doc=>rememberedMediaState(doc)?.owner).filter(Boolean);
  nativeMediaReady=false;
  const receipt=await window.coconutLocalMedia.reconcile(owners);
  if(receipt.status!=='reconciled'||!Array.isArray(receipt.rememberedKeys)||nativeMediaClosed)throw new Error('unavailable');
  nativeMediaReady=true;
  const remembered=new Set(receipt.rememberedKeys);
  for(const doc of state.documents){
   const entry=rememberedMediaStates.get(doc);if(!entry||!rememberedMediaCurrent(doc,entry))continue;
   entry.known=remembered.has(doc.key);entry.suppressed=detachedRememberedMedia.has(doc)||entry.suppressed;
   // A picker can finish before initialization/resolve. Its new File does not
   // erase earlier consent: keep that reference visibly revocable while the
   // unchecked option offers to remember this explicit selection instead.
   if(entry.known)entry.status=browserMedia.get(doc.key)?.file?'unchecked':'remembered';
  }
  if(active()){renderRememberedMedia();queueRememberedMedia(active());}
 }catch{nativeMediaReady=false;nativeMediaError=true;if(active())renderRememberedMedia();}
}
window.addEventListener('pagehide',()=>{nativeMediaClosed=true;for(const attachment of browserMedia.values())if(attachment.nativeToken)releaseMediaAttachment(attachment);});

const PLAYBACK_RATES=[0.75,1,1.25,1.5,1.75,2];
let playbackRate=1;
let repeating=null;
const REPEAT_SEEK_TOLERANCE=.03;
let dockFramePending=false;
let playbackIndex=null;
// Range metadata belongs to the rendered button and expires with that render.
const renderedPassageRanges=new WeakMap();
try {const saved=Number(localStorage.getItem("coconut-playback-rate-v1"));if(PLAYBACK_RATES.includes(saved))playbackRate=saved;}catch{}

// A draft never changes ordinary playback until Save. Preview owns a temporary
// physical-media range, reusing passage playback's cancellation/return semantics.
let timingEditor=null,timingRevision=0,timingPreview=null;
// Unsubmitted alignment belongs to this exact document and file, not its shelf
// key or transient object URL. It never enters content JSON or a saved offset.
const mediaTimingDrafts=new WeakMap();
function mediaTimingDraft(doc){return state.documents.includes(doc)?mediaTimingDrafts.get(doc):null;}
function hasMediaTimingDrafts(){return state.documents.some(doc=>mediaTimingDrafts.has(doc));}
function blockMediaTimingMutation(doc){
 if(!mediaTimingDraft(doc))return false;
 const message='本篇有未保存的字幕对齐草稿，请先保存或放弃修改，再移除篇目或更改媒体。';
 if(active()===doc&&workspace==='read'){mediaExpandedKey=doc.key;mediaCollapsedKey=null;render();$('media-timing-status').textContent=message;$('media-timing-offset').focus();$('media-timing').scrollIntoView?.({block:'nearest'});}
 else notice('“'+doc.title+'”有未保存的字幕对齐草稿，请先打开该篇并保存或放弃修改。');
 return true;
}
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
  const draft=mediaTimingDraft(doc),owned=draft?.identity===attachment.identity;
  $('media-timing-offset').value=owned?draft.offset:String(timingOffset());
  $('media-timing-cue').max=String(doc.segments.length);$('media-timing-cue').value=owned?draft.cue:'1';timingExample();
  $('media-timing-discard').hidden=!owned;
  $('media-timing-status').textContent=owned?'尚未保存的对齐草稿已保留在本页；普通回听仍使用已保存的偏移。':doc.media_timing&&doc.media_timing.identity!==attachment.identity?'此文件与已保存的校准不同，当前按零偏移回听。':'当前偏移 '+timingOffset()+' 秒；修改后可先试听，再保存。';
 }
}
function timingChanged(){
 const editor=timingEditor,attachment=timingAttachment();if(!editor||editor.doc!==active()||editor.attachment!==attachment)return;
 const offset=$('media-timing-offset').value;
 if(offset.trim()&&Number(offset)===timingOffset())mediaTimingDrafts.delete(editor.doc);
 else mediaTimingDrafts.set(editor.doc,{identity:attachment.identity,offset,cue:$('media-timing-cue').value});
 timingExample();timingRevision++;$('media-timing-discard').hidden=!mediaTimingDraft(editor.doc);
 $('media-timing-status').textContent=mediaTimingDraft(editor.doc)?'尚未保存；草稿仅保留在本页，普通回听仍使用已保存的偏移。':'当前输入与已应用偏移相同，没有未提交的对齐修改。';
 if(unloadGuardReady)syncUnsavedUnloadGuard();
}
$('media-timing-discard').onclick=()=>{
 const editor=timingEditor,attachment=timingAttachment();if(!editor||editor.doc!==active()||editor.attachment!==attachment)return;
 mediaTimingDrafts.delete(editor.doc);timingRevision++;
 if(passagePlayback?.getState().range?.id==='media-timing-preview'){$('source-media').querySelector('audio,video')?.pause();passagePlayback.cancel();}
 timingPreview=null;
 $('media-timing-offset').value=String(timingOffset());$('media-timing-cue').value='1';timingExample();
 $('media-timing-discard').hidden=true;$('media-timing-status').textContent='已放弃未提交的对齐草稿；已应用的偏移未改变。';$('media-timing-offset').focus();
 if(unloadGuardReady)syncUnsavedUnloadGuard();
};
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
 mediaTimingDrafts.delete(editor.doc);$('media-timing-discard').hidden=true;
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
 if(attachment?.ignoreListeningRecord){s.record=null;s.blocked=true;listeningStatus('旧收听续点未能清除，本次不恢复或保存收听进度。');}
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
 const panel=$('save-status').closest('.save-pipeline'),host=$($('library-search-dialog').open?'library-search-feedback':warning?'save-warning-home':'save-status-home');
 // Never move or hide a focused recovery action when a receipt arrives.
 // Its truthful status updates immediately; compacting waits until focus leaves.
 const focused=document.activeElement,retainRecovery=panel.contains(focused);
 if(panel.parentElement!==host&&(!retainRecovery||!$('library-search-dialog').open&&$('library-search-dialog').contains(panel)))host.append(panel);
 panel.classList.toggle('has-warning',warning||panel.parentElement===$('save-warning-home'));
 $('retry-save').hidden=(!snapshot.unsaved||snapshot.status==='pending')&&focused!==$('retry-save');
 $('retry-save').disabled=snapshot.blocked&&focused!==$('retry-save');
 $('retry-save').setAttribute('aria-disabled',String(snapshot.blocked||snapshot.status==='pending'||!snapshot.unsaved));
 $('export-unsaved-documents').hidden=(!snapshot.unsaved||!warning)&&focused!==$('export-unsaved-documents');
 $('pending-export').hidden=!snapshot.unsaved&&!$('pending-export').contains(focused);
 $('export-pending-library').hidden=!snapshot.unsaved&&focused!==$('export-pending-library');
 if(unloadGuardReady)syncUnsavedUnloadGuard();
 renderLibraryRestoreResults();
}
function notice(text,kind = "") {
 if(noticeTimer!==null){clearTimeout(noticeTimer);noticeTimer=null;}
 const success=!!text&&kind==='success';
 $("notice").dataset.kind=success?'success':'';
 $("notice").hidden=!text;$("notice").textContent=text;
 $('notice-shell').classList.toggle('is-success',success);
 const host=$('library-search-dialog').open?$('library-search-feedback'):success?$('reading-feedback'):$('notice-home');
 if($('notice-shell').parentElement!==host)host.append($('notice-shell'));
 $('dismiss-notice').hidden=!success;
 if(success)noticeTimer=setTimeout(()=>{noticeTimer=null;if($('notice').dataset.kind==='success'&&!$('notice-shell').contains(document.activeElement))notice('');},5000);
}
$('dismiss-notice').onclick=()=>{notice('');($('library-search-dialog').open?$('library-search'):$('main-content')).focus({preventScroll:true});};
window.addEventListener('coconut-storage-export',event=>notice(event.detail.text));

// The adapter is the only content writer. It retains the exact unreadable raw
// value and never rebases over content another window wrote.
const libraryAdapter=window.CoconutStorageBootstrap?.result?.adapter||CoconutLibraryStore.createLegacyAdapter({getStorage:()=>localStorage,validate:Coconut.validate});
const libraryLoad=window.CoconutStorageBootstrap?.result?.loaded||libraryAdapter.load();
// Direct embedding without the asynchronous bootstrap uses the legacy adapter.
if(!window.CoconutStorageBootstrap){$('storage-startup').hidden=true;document.querySelector('.shell').inert=false;}
state={documents:libraryLoad.documents,active:libraryLoad.active};
const restoreLoadedIdentities=new WeakSet(libraryLoad.ok?state.documents:[]);
const loadedCollectionIdentities=new WeakSet(libraryLoad.ok?state.documents.filter(Coconut.isReadingCollection):[]);
if(libraryLoad.ok)for(const doc of state.documents)recordPersistenceCheckpoint(doc,persistenceCheckpoint(doc));
else notice('上次保存的数据无法读取，已停止写入以保留原数据。本次内容可继续阅读，请导出备份后再关闭页面。');
const libraryStore=CoconutLibraryStore.create({adapter:libraryAdapter,getDocuments:()=>state.documents,checkpoint:persistenceCheckpoint});
let notebookContentRevision=0;
let libraryContentRevision=0,notebookRefreshQueued=false,libraryRenderedRevision=-1;
libraryStore.subscribe((snapshot,event)=>{
 const changed=libraryContentRevision!==snapshot.generation;libraryContentRevision=snapshot.generation;
 const collectionOnly=event?.type==='queued'&&event.keys.length>0&&event.keys.every(key=>Coconut.isReadingCollection(state.documents.find(doc=>doc.key===key)));
 if(changed&&!collectionOnly)notebookContentRevision++;
 if(changed&&!notebookRefreshQueued){notebookRefreshQueued=true;queueMicrotask(()=>{notebookRefreshQueued=false;if($('library-notebook').open)renderLibraryNotebook();if(libraryRenderedRevision!==libraryContentRevision)renderLibrary(null,{reuseMetadata:true});});}
 if(event?.result?.ok){for(const captured of event.result.checkpoints)recordPersistenceCheckpoint(captured.identity,captured.checkpoint);committedRememberedReplacements(event.result);}
 if(event?.type==='release')resumeDeferredContentInputs();
 renderSaveStatus(libraryStore.status());
 if($('library-notebook').open)collectionStatus();
 if($('chapter-dialog').open)chapterSaveStatus();
 sourceCorrectionSaveStatus();
 renderPassageReadingPosition();refreshReadingExcerptSaveState();
 if(event?.type==='commit'){
  renderSummaryPersistence();
  if(active()){renderRememberedMedia();queueRememberedMedia(active());}
  window.dispatchEvent(new CustomEvent('coconut-persistence-change',{detail:event.result}));
 }
});
libraryAdapter.subscribe?.(()=>{renderSaveStatus(libraryStore.status());if(active())renderRememberedMedia();});
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
const readingRecency=Coconut.createReadingRecency({getStorage:()=>localStorage});
const readingViews=Coconut.createReadingViews({getSessionStorage:()=>sessionStorage,getStorage:()=>localStorage});
window.addEventListener('pagehide',()=>rememberReadingView());
document.addEventListener('visibilitychange',()=>{if(document.hidden)rememberReadingView();});
function markDocumentOpened(doc){
 if(doc&&state.documents.includes(doc)&&!pendingStructuralDocuments.has(doc.key))readingRecency.record(doc.key);
}
window.addEventListener('storage',event=>{
 if(event.key!==readingRecency.key&&event.key!==null)return;
 readingRecency.refresh();if($('library-sort').value==='opened')renderLibrary();
});
window.addEventListener('coconut-document-removed',event=>{readingRecency.record(event.detail.key,true);readingViews.remove(event.detail.key);});
let activeSelectionRevision=0;
function selectActiveDocument(key,{persist=true}={}) {
 rememberReadingView();readingViewOwner=null;
 endReadingSearch();
 closeSourceCorrection(false);
 activeSelectionRevision++;
 const available=doc=>!Coconut.isReadingCollection(doc)&&!pendingStructuralDocuments.has(doc.key);
 state.active=state.documents.some(doc=>doc.key===key&&available(doc))?key:state.documents.find(available)?.key||null;
 if(persist)rememberActiveDocument();
}
let windowActive=null,lastActive=null;
try { windowActive=sessionStorage.getItem(ACTIVE_KEY); } catch {}
try { lastActive=localStorage.getItem(LAST_ACTIVE_KEY); } catch {}
selectActiveDocument([windowActive,lastActive,state.active].find(key=>state.documents.some(doc=>doc.key===key)));
function active() {
	return state.documents.find((d) => d.key === state.active&&!Coconut.isReadingCollection(d));
}
function el(tag, className, text) {
	const n = document.createElement(tag);
	if (className) n.className = className;
	if (text !== undefined) n.textContent = text;
	return n;
}
async function add(doc, canCommit = null, reuseAudioSource = false, lifecycleRevision = documentLifecycleRevision, sourceKey = doc.key, {target = null, separate = false, activate = true, canActivate = null, onActivate = null, jobId = null} = {}) {
 if(Coconut.isReadingCollection(doc))throw new Error("成果集不能作为文字稿打开，请使用‘恢复书架备份’导入成果集 JSON 备份。");
 if(!contentIngressAllowed())throw new Error("导入已取消，书架未改变");
 const jobBinding=jobId?await jobSourceBinding(doc,jobId):null;
 // This local-only association is deliberately absent from Coconut.validate:
 // ordinary document/library imports must never acquire task ownership.
 if(jobBinding)doc={...doc,local_job_binding:jobBinding};
	const bytes = new TextEncoder().encode(JSON.stringify(jobBinding?Coconut.validate(doc):doc));
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
 const jobMatches=jobBinding?state.documents.filter(d=>localJobIdentity(d)===localJobIdentity(doc)):[];
 if(jobMatches.length>1)throw new Error('本任务有多个本地阅读条目，请先保留所需版本，未自动更新');
 const existing=jobMatches[0]||(target?state.documents.find(d=>d.key===target.key):matches[0]);
 // Never infer ownership from a historical import hash after the user edited
 // that unbound entry. Only a complete unchanged copy may acquire a binding.
 // Identical text from distinct tasks must also retain distinct task bindings.
 if(jobBinding&&!existing){
  const candidate=state.documents.find(d=>d.key===key);
  if(candidate&&(localJobIdentity(candidate)||JSON.stringify(Coconut.validate(candidate))!==JSON.stringify(Coconut.validate(doc))))key=crypto.randomUUID();
 }
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
    browserMedia.delete(key);releaseMediaAttachment(attachment);
   }
  }
 }
 const duplicate=state.documents.some(d=>d.key===key);
	if (!duplicate)state.documents.push({ ...doc, key, notes: doc.notes || {} });
 if(jobBinding){
  const bound=state.documents.find(d=>d.key===key);bound.local_job_binding=jobBinding;
  const media=doc.source_media;
  if(media?.job_id===jobBinding.id){
   bound.source_media={...media};
   if(bound.provenance){bound.provenance={...bound.provenance};delete bound.provenance.playback_warning;}
  }else if(!bound.source_media&&doc.provenance?.playback_warning){
   // A delayed unsuccessful recovery must not downgrade a recovered source.
   bound.provenance={...bound.provenance,playback_warning:doc.provenance.playback_warning};
  }
 }
 // A requested import can finish saving without taking over newer navigation.
 // Evaluate ownership here, after every asynchronous admission check.
 if(!activate || canActivate && !canActivate()){
  const inserted=state.documents.find(d=>d.key===key),receipt=commitDocument(inserted);
  renderLibrary();
  if(jobBinding)refreshRecoveredJobMedia(inserted);
  return {...await receipt,duplicate};
 }
	selectActiveDocument(key);
 passageReturn=null;passageDocumentKey=null;mediaExpandedKey=null;
 searchFocusedId=null;
	$("search").value = "";
	selected = null;
	pageStart = 0;
	notesOnly = false; excerptsOnly = false; speakerFilter=null;
 setReadingMode(defaultReadingMode(active()));
	workspace = "read";
	const inserted=active(),mediaRevision=mediaSelectionRevision(key),selectionRevision=activeSelectionRevision,receipt=commitDocument(inserted);
 onActivate?.({identity:inserted,selectionRevision,navigationRevision:localImportRevision});
	render();
 resumeOpenedDocument(inserted,null);
	return {...await receipt,duplicate,mediaRevision,selectionRevision};
}
function showWorkspace(next) {
 if(workspace==="read"&&next!==workspace)rememberReadingView();
 if(next!==workspace)cancelLocalImports();
 if(next!=="read"){endReadingSearch();clearReadingContext();passageReturn=null;passagePlayback?.cancel();}
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
function clearReadingContext(retireSearchRoute=false) {
 if(retireSearchRoute&&readingSearchSession?.readingContext===readingContext)readingSearchSession.readingContext=null;
 readingContext=null;
 $('reading-context').hidden=true;syncReadingStickyStack();
 document.querySelectorAll('.context-target').forEach(row=>row.classList.remove('context-target'));
}
function endReadingSearch(){readingSearchSession=null;$('reading-search-session').hidden=true;}
function ownedReadingSearch(){
 const origin=readingSearchSession;
 if(origin&&(origin.doc!==active()||origin.selection!==activeSelectionRevision||!state.documents.includes(origin.doc)))endReadingSearch();
 return readingSearchSession;
}
function readingSearchCueSnapshot(cue){return JSON.stringify([cue.id,cue.text,cue.start,cue.end,cue.speaker??null]);}
function readingSearchAnchor(origin){
 if(!origin)return {valid:false};
 const index=origin.doc.segments.indexOf(origin.cue),valid=index>=0&&origin.cue.id===origin.id;
 const filterAvailable=origin.mode!=='transcript'||origin.speakerFilter===null||origin.doc.segments.some(cue=>(cue.speaker||'')===origin.speakerFilter);
 return {valid,filterAvailable,unchanged:valid&&index===origin.index&&readingSearchCueSnapshot(origin.cue)===origin.source};
}
function beginReadingSearch(){
 if(restoringReadingSearchFocus)return;
 if(ownedReadingSearch())return;
 rememberReadingView();
 const doc=active();if(workspace!=='read'||!doc||Coconut.isAudioProject(doc)||!['transcript','passages'].includes(readingMode))return;
 const id=visibleReadingCue(),cue=doc.segments.find(cue=>cue.id===id);if(!cue)return;
 const node=chapterCueNode(id,readingMode);
 readingSearchSession={doc,selection:activeSelectionRevision,cue,id,index:doc.segments.indexOf(cue),source:readingSearchCueSnapshot(cue),mode:readingMode,
  query:$('search').value,notesOnly,excerptsOnly,speakerFilter,pageStart,readingContext,passageReturn,chapterReturn,
  contextCue:doc.segments.find(cue=>cue.id===readingContext?.id),passageCue:doc.segments.find(cue=>cue.id===passageReturn?.cueId),chapterCue:doc.segments.find(cue=>cue.id===chapterReturn?.cueId),viewportTop:node?.getBoundingClientRect().top};
 renderReadingSearch();
}
function readingSearchTarget(){
 const doc=active();if(!doc)return null;
 const query=$('search').value.trim().toLocaleLowerCase();
 const visibleCandidate=id=>{
  if(id===null||id===undefined)return null;const node=chapterCueNode(id,readingMode);if(!node)return null;
  const rect=node.getBoundingClientRect();
  // A mounted row with no layout can still own an explicit match. Once layout
  // exists, an old result cannot overrule a newer page or reading scrolled away.
  const unmeasured=!rect.height&&!rect.width&&rect.top===0&&rect.bottom===0;
  return (unmeasured||rect.bottom>readingDisplayTopEdge()&&rect.top<(window.visualViewport?.height||window.innerHeight))?id:null;
 };
 for(const id of [visibleCandidate(selected),visibleCandidate(searchFocusedId),visibleCandidate(readingContext?.document===doc?readingContext.id:null),visibleReadingCue()]){
  if(id===null||id===undefined)continue;
  const cue=doc.segments.find(cue=>cue.id===id);
  if(cue&&matchesReadingSegment(cue,doc,query))return cue;
 }
 return null;
}
function renderReadingSearch(){
 const origin=ownedReadingSearch(),host=$('reading-search-session');host.hidden=!origin||workspace!=='read'||readingMode!=='transcript';
 if(!origin)return;
 const anchor=readingSearchAnchor(origin);
 $('return-before-search').disabled=!anchor.valid||!anchor.filterAvailable;
 $('continue-search-reading').disabled=!readingSearchTarget();
 $('continue-search-reading').textContent=$('search').value.trim()||notesOnly||excerptsOnly||speakerFilter!==null?'从当前结果继续读':'从当前位置继续读';
 $('reading-search-status').textContent=!anchor.valid?'搜索前的原位置已不可用；可从当前结果继续阅读。':!anchor.filterAvailable?'搜索前的说话人筛选已无对应标签；可从当前结果继续阅读。':'搜索前读到 '+Coconut.time(origin.cue.start)+(anchor.unchanged?'':' · 原片段已变化，返回时定位当前原文');
}
function clearReadingFiltersAt(cue){
 const doc=active();clearReadingContext();passageReturn=null;chapterReturn=null;
 $('search').value='';notesOnly=false;excerptsOnly=false;speakerFilter=null;searchFocusedId=null;selected=null;$('ai-consent').checked=false;
 const index=doc?.segments.indexOf(cue)??-1;
 if(index>=0)pageStart=Math.floor(index/PAGE_SIZE)*PAGE_SIZE;
 render();
 const node=index>=0?chapterCueNode(cue.id,'transcript'):null;
 if(node){scrollReadingTarget(node,{block:'center',behavior:'auto'});node.focus({preventScroll:true});}
 else focusReadingSearchAfterNavigation();
}
function focusReadingSearchAfterNavigation(options){
 restoringReadingSearchFocus=true;try{focusReadingSearch(options);}finally{restoringReadingSearchFocus=false;}
}
function returnBeforeSearch(){
 const origin=ownedReadingSearch(),anchor=readingSearchAnchor(origin);if(!anchor.valid||!anchor.filterAvailable)return;
 endReadingSearch();clearReadingContext();passageReturn=null;chapterReturn=null;selected=null;searchFocusedId=null;$('ai-consent').checked=false;
 // Only view state is restored. Current text, notes, translations, and the
 // explicit reading bookmark belong to the live document throughout this trip.
 $('search').value=origin.query;notesOnly=origin.notesOnly;excerptsOnly=origin.excerptsOnly;speakerFilter=origin.speakerFilter;
 const routeCueCurrent=(cue,id)=>!!cue&&cue.id===id&&origin.doc.segments.includes(cue);
 readingContext=origin.readingContext?.document===origin.doc&&routeCueCurrent(origin.contextCue,origin.readingContext.id)?origin.readingContext:null;
 passageReturn=origin.passageReturn?.key===origin.doc.key&&routeCueCurrent(origin.passageCue,origin.passageReturn.cueId)?origin.passageReturn:null;
 chapterReturn=origin.chapterReturn?.doc===origin.doc&&routeCueCurrent(origin.chapterCue,origin.chapterReturn.cueId)?origin.chapterReturn:null;
 readingMode=origin.mode;
 let available=true;
 if(origin.mode==='passages'){passageDocumentKey=origin.doc.key;passageAnchor=origin.id;}
 else{
  const matches=origin.doc.segments.filter(cue=>matchesReadingSegment(cue,origin.doc,origin.query.trim().toLocaleLowerCase()));
  const index=matches.indexOf(origin.cue);available=index>=0;
  pageStart=available?(index>=origin.pageStart&&index<origin.pageStart+PAGE_SIZE?origin.pageStart:Math.floor(index/PAGE_SIZE)*PAGE_SIZE):origin.pageStart;
 }
 render();
 const node=available?chapterCueNode(origin.id,origin.mode):null;
 if(node){
  node.tabIndex=-1;
  if(anchor.unchanged&&Number.isFinite(origin.viewportTop))window.scrollBy(0,node.getBoundingClientRect().top-origin.viewportTop);
  else scrollReadingTarget(node,{block:'center',behavior:'auto'});
  node.focus({preventScroll:true});
 }else{focusReadingSearchAfterNavigation({preventScroll:true});notice('原片段已离开搜索前的筛选；已恢复筛选，请选择当前结果。');}
 if(!anchor.unchanged)notice('搜索前的原片段已变化，已定位当前原文。');
}
$('search').addEventListener('focus',beginReadingSearch);
$('search').addEventListener('keydown',event=>{
 const anchor=readingSearchAnchor(ownedReadingSearch());
 if(event.key!=='Escape'||readingKeyIgnored(event)||!anchor.valid||!anchor.filterAvailable)return;
 event.preventDefault();event.stopPropagation();returnBeforeSearch();
});
$('return-before-search').onclick=returnBeforeSearch;
$('continue-search-reading').onclick=()=>{
 if(!ownedReadingSearch())return;const cue=readingSearchTarget();if(!cue)return;
 endReadingSearch();clearReadingContext();chapterReturn=null;$('search').value='';notesOnly=false;excerptsOnly=false;speakerFilter=null;searchFocusedId=null;selected=null;$('ai-consent').checked=false;
 openPassage(cue.id,false);
 const node=chapterCueNode(cue.id,'passages');if(node){node.tabIndex=-1;node.classList.add('search-return-target');scrollReadingTarget(node,{block:node.getBoundingClientRect().height>(window.visualViewport?.height||window.innerHeight)?'start':'center',behavior:'auto'});node.focus({preventScroll:true});}
};
function renderReadingContext() {
 if(readingContext?.document!==active())readingContext=null;
 const origin=readingContext,bar=$('reading-context');
 // Move the one existing landmark, retaining its handlers and accessible IDs.
 if(origin&&readingMode==='passages'){if(bar.nextElementSibling!==$('passage-workspace'))$('passage-workspace').before(bar);}
 else if(readingContextHome.nextSibling!==bar)readingContextHome.after(bar);
 $('reading-context').hidden=!origin||workspace!=='read'||readingMode==='summary';
 if(origin)$('reading-context-label').textContent=origin.label+' · '+(!origin.count?'原筛选已无匹配结果':(origin.resultMissing?'原片段已离开结果 · 返回第 ':'第 ')+(origin.index+1)+' / '+origin.count+' 个结果');
 syncReadingStickyStack();
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
 if(readingSearchSession?.readingContext===readingContext)endReadingSearch();
 const origin=readingContext,doc=active();clearReadingContext(true);
 if(!origin||doc!==origin.document)return;
 passageReturn=null;
 $('search').value=origin.query;notesOnly=origin.notesOnly;excerptsOnly=origin.excerptsOnly;speakerFilter=origin.speakerFilter;
 // Display choice can change during the detour; restore the original view without
 // reverting source edits, annotations, or the user's explicit reading bookmark.
 if(contentIngressAllowed(doc)){recordReadingDisplaySelection(doc);if((doc.translation_view||'')!==origin.translationView){doc.translation_view=origin.translationView;queueDocument(doc);}}
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
  else scrollReadingTarget(row,{block:'center'});
  (row.querySelector('.context-button')||row).focus({preventScroll:true});
 }else focusReadingSearch();
 if(exact<0)notice(target?'原片段已不在筛选结果中，已返回相邻结果。':'原筛选已没有匹配片段；可调整筛选继续阅读。');
}
$('return-reading-results').onclick=returnReadingResults;
$('dismiss-reading-context').onclick=()=>{
 const id=readingContext?.id;endReadingSearch();clearReadingContext();
 if(readingMode==='passages'){
  const cue=[...$('passage-body').querySelectorAll('.passage-cue')].find(node=>node.dataset.cueId===id);
  (cue?.closest('.passage')||$('passage-body').querySelector('.passage')||$('mode-passages')).focus({preventScroll:true});
 }else{
  const row=[...$('transcript').querySelectorAll('.segment')].find(node=>node.dataset.segmentId===id);
  if(row)row.focus({preventScroll:true});else focusReadingSearch({preventScroll:true});
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
 scrollReadingTarget(row,{block:alignment,behavior:contextDetour?"auto":"smooth"});
	row?.focus({preventScroll: true});
 rememberReadingView({cueId:row?.dataset.segmentId});
}
// Explicit opens share one resume policy. Run synchronously with activation,
// never after a save receipt that may outlive newer navigation. This only moves
// the reading view: it neither changes the saved position nor starts playback.
function resumeOpenedDocument(doc,fallbackFocus='title',{remembered=false}={}){
 if(active()!==doc)return;
 if(remembered&&restoreReadingView(doc))return;
 const bookmark=doc.segments.find(cue=>cue.id===doc.readingPosition);
 if(bookmark){if(prefersPassageReading(doc))openPassage(bookmark.id);else goToSegment(bookmark.id);}
 else if(fallbackFocus){$('title').scrollIntoView?.({block:'start'});$(fallbackFocus).focus({preventScroll:true});}
}
// Ordinary library navigation, active removal, and active undo share ownership teardown.
function resetReaderForDocumentNavigation(){
 rememberReadingView();readingViewOwner=null;
 libraryTranslationActivation++;libraryTranslationReveal=null;
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
 $('removal-recovery-description').textContent=Coconut.isReadingCollection(removedDocument?.doc)?'整库备份不含已移除的成果集。请单独导出移除备份，用支持成果集的版本通过“恢复书架备份”恢复；不含来源文档或媒体。':'整库备份不含这份内容。可单独导出完整文字稿与笔记；恢复后需重新选择媒体。';
 if(!removedDocument){$('removal-recovery-details').open=false;$('removal-recovery-error').hidden=true;$('removal-export-error').hidden=true;}
 if(unloadGuardReady)syncUnsavedUnloadGuard();
}
function showRemovalRecoveryError(message) {
 $('removal-recovery-error').textContent=message;
 $('removal-recovery-error').hidden=false;
 $('removal-recovery-details').open=true;
}
function requestLibraryRemoval(doc) {
 if(blockMediaTimingMutation(doc))return;
 if(quotationController?.ownsDraft(doc)){quotationController.reopenDraft();return;}
 if(chapterEditor?.doc===doc&&chapterDraft()){if(!$('chapter-editor').open)$('chapter-editor').showModal();$('chapter-editor-status').textContent='本篇有未提交章节草稿，请先保存或取消修改，再移除本篇。';$('chapter-title').focus();return;}
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
 if(mediaTimingDraft(doc)){$('remove-document-dialog').close();blockMediaTimingMutation(doc);return;}
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
 if(wasActive){selectActiveDocument(state.documents[Math.min(index,state.documents.length-1)]?.key||null,{persist:false});$('source-media').replaceChildren();$('source-media').hidden=true;listeningSession=null;renderListeningResume();setReadingMode(defaultReadingMode(active()));workspace=active()?'read':'add';}
 operation.selectionRevision=activeSelectionRevision;
 const ticket=libraryStore.queueDocument(doc.key,doc,'remove',{rollback(){
  if(pendingStructuralDocuments.get(doc.key)!==operation||state.documents.some(item=>item.key===doc.key))return false;
  state.documents.splice(Math.min(index,state.documents.length),0,doc);
  finishStructuralOperation(operation);restoreRemovedDrafts(bundle);
  if(wasActive&&activeSelectionRevision===operation.selectionRevision&&document.activeElement===operation.focusAtStart){resetReaderForDocumentNavigation();selectActiveDocument(doc.key,{persist:false});workspace='read';setReadingMode(defaultReadingMode(doc));render();}else renderLibrary();
  renderRemovalRecovery();return true;
 }});
 removalTarget=null;if(removalDialogOrigin?.doc===doc)removalDialogOrigin.confirmed=true;
 $('remove-document-dialog').close();render();renderRemovalRecovery();
 $('main-content').focus({preventScroll:true});operation.focusAtStart=document.activeElement;
 void libraryStore.flush();const receipt=await ticket.committed;
 if(!receipt.ok){finishStructuralOperation(operation);renderRemovalRecovery();notice('移除未保存，原文档已留在书架。其他修改仍保留；请检查保存状态并先导出备份。');return;}
 if(pendingStructuralDocuments.get(doc.key)!==operation)return;
 finishStructuralOperation(operation);retireRememberedMedia(doc,{removed:true});removedDocument=bundle;
 if(wasActive&&activeSelectionRevision===operation.selectionRevision)rememberActiveDocument();
 $('removal-recovery-details').open=false;$('removal-recovery-error').hidden=true;$('removal-export-error').hidden=true;
 window.dispatchEvent(new CustomEvent('coconut-document-removed',{detail:{key:doc.key,bundle}}));
 const attachment=browserMedia.get(doc.key);if(attachment){browserMedia.delete(doc.key);releaseMediaAttachment(attachment);}
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
 if(canNavigate&&!Coconut.isReadingCollection(doc)&&(recovery.wasActive||!active())){resetReaderForDocumentNavigation();selectActiveDocument(doc.key);workspace='read';setReadingMode(defaultReadingMode(doc));render();}else if(active()===doc)render();else renderLibrary();
 renderRemovalRecovery();
 if(active()===doc&&Coconut.hasProjectAnnotations(doc))$('audio-project-status').textContent='项目已恢复；未提交的书签草稿仅在本页，请保存或取消。';
 if(canNavigate&&active()===doc&&doc.readingPosition){if(prefersPassageReading(doc))openPassage(doc.readingPosition);else goToSegment(doc.readingPosition);}
 notice('已撤销移除，并保存完整文字稿、译文、笔记与阅读位置。','success');
 if(canNavigate)focusLibraryRemoval(doc.key);
};
$('export-removed-document').onclick=()=>{
 if(!removedDocument)return;let url,link;
 try{
  const collection=Coconut.isReadingCollection(removedDocument.doc),backup=collection?{format:'coconut-library',version:1,documents:[removedDocument.doc],active:null}:removedDocument.doc;
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
  url=URL.createObjectURL(blob);link=el('a');link.href=url;link.download='coconut-removed-document.json';link.hidden=true;document.body.append(link);link.click();
  $('removal-export-error').hidden=true;
  if($('remove-document-error').dataset.kind==='export'){$('remove-document-error').textContent='';delete $('remove-document-error').dataset.kind;}
  notice('已发起移除备份下载，请打开文件确认已保存。'+(collection?'请用支持成果集的版本，通过“恢复书架备份”恢复；':'可用“添加文件”恢复；')+'下载不会自动结束撤销。'+backupRecoveryHint(blob));
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
 const collection=Coconut.isReadingCollection(removedDocument.doc);finishRemovalDialogOrigin.confirmed=true;removedDocument=null;$('finish-removal-dialog').close();renderRemovalRecovery();notice(collection?'已结束本页撤销。如有成果集 JSON 备份，请用支持成果集的版本，通过“恢复书架备份”恢复。':'已结束本页撤销。如果另有 JSON 备份，以后可用“添加文件”恢复。');
};

// Shelf paging bounds DOM work only. Filtering, sorting, storage, and backup
// always use the complete document array; the cache retains this page alone.
// Compact shelf management stays in normal flow. Search uses its own native
// dialog; both move existing nodes so state survives every resize.
// One live search/card tree moves between its compact shelf and the native
// wide workspace. Closing restores nodes, never reader content or media state.
let libraryWorkspaceSession=0,libraryWorkspaceOrigin=null,libraryWorkspaceRestore=false,librarySearchPointer=false,librarySearchComposing=false,librarySearchCompositionSession=null,librarySearchCancelledComposition=false;
let libraryWorkspaceReturn=null,libraryWorkspaceScroll=0,libraryWorkspacePage=0,libraryWorkspacePendingRestore=null,libraryWorkspaceFocus=null;
const libraryWorkspacePositions=new WeakMap();
const libraryWorkspaceNodes=[document.querySelector('.library-search'),$('library-search-scope'),$('library-sort').closest('label'),$('library-kind').closest('label'),$('library-page-status'),$('library-pagination'),$('library'),$('library-empty')];
const libraryWorkspaceAnchors=libraryWorkspaceNodes.map(node=>{const anchor=document.createComment('library workspace home');node.before(anchor);return anchor;});
function focusLibrarySearch(){const previous=libraryWorkspaceRestore;libraryWorkspaceRestore=true;$('library-search').focus({preventScroll:true});libraryWorkspaceRestore=previous;}
function libraryResultsPort(){return $('library-search-dialog').open?$('library-search-results'):$('library-list');}
function libraryWorkspaceTarget(){
 const saved=libraryWorkspaceReturn;
 if(!saved||saved.signature!==libraryViewSignature||!state.documents.includes(saved.doc)||pendingStructuralDocuments.has(saved.doc.key))return null;
 const card=libraryCards.get(saved.doc.key);if(card?.doc!==saved.doc)return null;
 if(saved.kind==='translation'){
  if(!Coconut.libraryTranslationHitCurrent(saved.hit,state.documents)||!librarySearch.isCurrent(card.translationSelection))return null;
  return [...(card.translationHits?.querySelectorAll('.library-translation-hit')||[])].find(node=>node.dataset.language===saved.language&&node.dataset.hitId===saved.hit.id)||null;
 }
 if(saved.kind==='saved'){
  if(!Coconut.librarySavedHitCurrent(saved.hit,state.documents)||!librarySearch.isCurrent(card.savedSelection))return null;
  return [...(card.savedHits?.querySelectorAll('.library-saved-hit')||[])].find(node=>node.dataset.captureKey===saved.hit.captureKey)||null;
 }
 if(saved.node?.isConnected&&card.entry.contains(saved.node))return saved.node;
 return null;
}
function visibleLibraryControl(node){
 if(!node?.isConnected||node.disabled)return false;
 for(let parent=node;parent;parent=parent.parentElement){
  const css=getComputedStyle(parent);if(parent.hidden||css.display==='none'||css.visibility==='hidden')return false;
  if(parent.tagName==='DETAILS'&&!parent.open&&node!==parent.querySelector(':scope > summary')&&!parent.querySelector(':scope > summary')?.contains(node))return false;
 }
 return true;
}
function validLibraryWorkspaceFocus(saved){
 const node=saved?.node;
 if(!visibleLibraryControl(node)||saved.signature!==libraryViewSignature||!$('library-search-dialog').contains(node))return false;
 if(saved.doc&&(!state.documents.includes(saved.doc)||pendingStructuralDocuments.has(saved.doc.key)||libraryCards.get(saved.doc.key)?.doc!==saved.doc))return false;
 if(saved.hit?.kind==='translation')return Coconut.libraryTranslationHitCurrent(saved.hit,state.documents);
 if(saved.hit?.captureKey)return Coconut.librarySavedHitCurrent(saved.hit,state.documents);
 return true;
}
function rememberLibraryWorkspace(doc,hit=null,node=document.activeElement){
 if(!$('library-search-dialog').open)return;
 libraryWorkspaceScroll=$('library-search-results').scrollTop;libraryWorkspaceFocus=null;
 libraryWorkspaceReturn={doc,hit,node,kind:hit?.kind==='translation'?'translation':hit?.captureKey?'saved':'ordinary',language:hit?.language,signature:libraryViewSignature};
 $('return-library-search').hidden=false;
}
function openLibraryWorkspace({restore=false}={}){
 rememberReadingView();
 const dialog=$('library-search-dialog');if(dialog.open||libraryWorkspaceRestore)return;
 if(document.querySelector('dialog[open]'))return;
 librarySearchCancelledComposition=false;
 libraryWorkspaceSession++;libraryTranslationActivation++;libraryFocusRevealRevision++;libraryWorkspacePendingRestore=null;
 libraryWorkspaceOrigin={node:document.activeElement,doc:active(),revision:activeSelectionRevision,scroll:window.scrollY};
 // Keep the input itself and its selection. Pointer and composition handlers
 // finish their in-progress operation before moving it; no input is synthesized.
 const input=$('library-search'),selection=[input.selectionStart,input.selectionEnd,input.selectionDirection];
 libraryWorkspaceNodes.forEach((node,index)=>$(index<2?'library-search-query':index<4?'library-search-filter-controls':'library-search-result-content').append(node));
 dialog.showModal();
 $('notice-shell').parentElement!==$('library-search-feedback')&&$('library-search-feedback').append($('notice-shell'));
 renderSaveStatus(libraryStore.status());syncLibraryBackupSelection();
 for(const card of libraryCards.values())card.remove.hidden=true;
 if(restore){libraryPage=libraryWorkspacePage;libraryActiveKey=state.active;}
 renderLibrary(null,{reuseMetadata:true});
 if(restore&&libraryWorkspaceReturn?.signature===libraryViewSignature&&state.documents.includes(libraryWorkspaceReturn.doc)){
  libraryWorkspacePendingRestore={session:libraryWorkspaceSession,focusOwned:true};renderLibrary(libraryWorkspaceReturn.doc.key,{reuseMetadata:true});
 }
 const remembered=libraryWorkspaceFocus,candidate=restore?(libraryWorkspaceTarget()||(validLibraryWorkspaceFocus(remembered)?remembered.node:null)):null;
 const target=visibleLibraryControl(candidate)?candidate:null;
 (target||input).focus({preventScroll:true});
 if(!target&&selection[0]!==null)input.setSelectionRange(...selection);
 $('library-search-results').scrollTop=libraryWorkspaceScroll;
 if(target){libraryWorkspacePendingRestore=null;target.scrollIntoView?.({block:'nearest',behavior:'instant'});}
}
function closeLibraryWorkspace(reason='cancel'){
 const dialog=$('library-search-dialog');if(!dialog.open&&!libraryWorkspaceOrigin)return;
 if(librarySearchComposing)librarySearchCancelledComposition=true;
 libraryWorkspaceSession++;libraryTranslationActivation++;libraryFocusRevealRevision++;libraryWorkspacePendingRestore=null;
 if(reason==='cancel'){libraryWorkspaceReturn=null;libraryWorkspaceFocus=null;}
 const focused=document.activeElement,focusedCard=libraryCards.get(focused?.closest('.library-entry')?.dataset.documentKey);
 if(reason==='cancel'&&focusedCard&&focusedCard.entry.contains(focused)){
  const translation=focused.closest('.library-translation-group'),language=translation?.dataset.language,id=translation?.querySelector('.library-translation-hit')?.dataset.hitId;
  const hit=translation?focusedCard.translationSelection?.translationHits.get(focusedCard.doc)?.find(group=>group.language===language)?.hits.find(hit=>hit.id===id):focusedCard.savedSelection?.savedHits.get(focusedCard.doc)?.hits.find(hit=>hit.captureKey===focused.dataset.captureKey);
  libraryWorkspaceFocus={node:focused,doc:focusedCard.doc,hit,signature:libraryViewSignature};
 }else if(reason==='cancel'&&dialog.contains(focused)&&focused!==$('close-library-search')&&focused.matches('input,select,button,summary')){
  libraryWorkspaceFocus={node:focused,doc:null,signature:libraryViewSignature};
 }
 libraryWorkspaceScroll=$('library-search-results').scrollTop;libraryWorkspacePage=libraryPage;
 const origin=libraryWorkspaceOrigin;libraryWorkspaceOrigin=null;
 // Restore focus explicitly in this stack. A native close event can arrive
 // after immediate reopening or navigation and must never reclaim ownership.
 libraryWorkspaceRestore=true;
 if(dialog.open)dialog.close();
 libraryWorkspaceNodes.forEach((node,index)=>libraryWorkspaceAnchors[index].after(node));
 arrangeLibraryTools();syncLibraryBackupSelection();
 for(const card of libraryCards.values())card.remove.hidden=!$('library-options').open;
 const noticeHost=$('notice').dataset.kind==='success'?$('reading-feedback'):$('notice-home');noticeHost.append($('notice-shell'));
 renderSaveStatus(libraryStore.status());
 if(reason==='cancel'){
  const original=origin?.node,available=visibleLibraryControl(original);
  (available?original:$('open-library-search')).focus({preventScroll:true});
  if(origin?.doc===active()&&origin.revision===activeSelectionRevision)window.scrollTo?.({top:origin.scroll,behavior:'instant'});
 }
 libraryWorkspaceRestore=false;
}
$('open-library-search').onclick=()=>openLibraryWorkspace({restore:true});
$('return-library-search').onclick=()=>openLibraryWorkspace({restore:true});
$('close-library-search').onclick=()=>closeLibraryWorkspace();
$('library-search').addEventListener('pointerdown',()=>{librarySearchPointer=true;});
$('library-search').addEventListener('pointerup',()=>{librarySearchPointer=false;openLibraryWorkspace();});
$('library-search').addEventListener('pointercancel',()=>{librarySearchPointer=false;});
document.addEventListener('pointerup',()=>{if(librarySearchPointer){librarySearchPointer=false;if(document.activeElement===$('library-search'))openLibraryWorkspace();}});
document.addEventListener('pointercancel',()=>{librarySearchPointer=false;});
$('library-search').addEventListener('focus',()=>{if(!librarySearchPointer)openLibraryWorkspace();});
$('library-search').addEventListener('focusout',()=>{librarySearchPointer=false;if(libraryWorkspacePendingRestore)libraryWorkspacePendingRestore.focusOwned=false;});
$('library-search').addEventListener('keydown',event=>{if(event.key!=='Tab'&&event.key!=='Escape'&&!librarySearchComposing)openLibraryWorkspace();});
$('library-search').addEventListener('compositionstart',()=>{librarySearchComposing=true;librarySearchCompositionSession=libraryWorkspaceSession;});
$('library-search').addEventListener('compositionend',()=>{const current=librarySearchCompositionSession===libraryWorkspaceSession;librarySearchComposing=false;librarySearchCompositionSession=null;if(current&&document.activeElement===$('library-search'))openLibraryWorkspace();renderLibrary();});
$('library-scope').addEventListener('focus',()=>openLibraryWorkspace());
// A nonempty native search field otherwise consumes Escape by clearing itself.
// Bubble after the target's handlers, and do not let this same cancellation reach
// background note/media/shelf handlers after the dialog has closed.
$('library-search-dialog').addEventListener('keydown',event=>{
 if(event.key!=='Escape'||event.target!==$('library-search')||!$('library-search-dialog').open||event.defaultPrevented||event.isComposing||event.keyCode===229||librarySearchComposing||readingKeyComposition)return;
 event.preventDefault();event.stopPropagation();closeLibraryWorkspace();
});
$('library-search-dialog').addEventListener('cancel',event=>{event.preventDefault();if(!librarySearchComposing&&!readingKeyComposition)closeLibraryWorkspace();});
// The explicit path owns all application closes. This fallback handles a native
// close initiated by the host while ignoring the delayed event from our path.
$('library-search-dialog').addEventListener('close',()=>{if(!$('library-search-dialog').open&&libraryWorkspaceOrigin)closeLibraryWorkspace();});
const libraryMobile=window.matchMedia('(max-width: 650px)');
const libraryToolNodes=[$('background-tasks'),$('open-library-notebook'),document.querySelector('.library-backup'),$('library-options'),$('library-pagination')];
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
 const movable=libraryToolNodes.filter(node=>!$('library-search-dialog').contains(node));
 $('library-tools').hidden=!libraryMobile.matches;
 if(libraryMobile.matches){
  if(shelfOwnsFocus)$('toggle-library').setAttribute('aria-expanded','true');
  movable.forEach(node=>$('library-tools-content').append(node));
  if(ownsFocus)$('library-tools').open=true;
 }else libraryToolNodes.forEach((node,index)=>{if(movable.includes(node))libraryToolAnchors[index].after(node);});
 if(ownsFocus)focused.focus({preventScroll:true});
 else if(!libraryMobile.matches&&(focused===$('toggle-library')||focused===$('library-tools').querySelector('summary')))$('open-library-search').focus({preventScroll:true});
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
 rememberReadingView();
 libraryBrowseOrigin={key:active()?.key,doc:active(),selectionRevision:activeSelectionRevision,reading:!$('reader-workspace').hidden,node:libraryReaderFocus&&libraryReaderFocus.key===active()?.key?libraryReaderFocus.node:null,scrollY:window.scrollY};
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
const libraryBackupSelection=Coconut.createLibraryBackupSelection();
let librarySelectionMode=false,librarySelectionDropped=0;
function syncLibraryBackupSelection(visible=null) {
 const status=libraryBackupSelection.reconcile(state.documents,pendingStructuralDocuments);
 librarySelectionDropped+=status.removed;
 const shown=visible??($('library').hidden?[]:[...libraryCards.values()].map(card=>card.doc));
 const outside=status.count-libraryBackupSelection.visibleCount(shown);
 $('library-selection-controls').hidden=!librarySelectionMode;
 const modeLabel=librarySelectionMode?'取消选择':'选择备份';
 if($('library-selection-mode').textContent!==modeLabel)$('library-selection-mode').textContent=modeLabel;
 $('library-selection-mode').setAttribute('aria-pressed',String(librarySelectionMode));
 const message='已选 '+status.count+' 份 · 其中 '+outside+' 份不在当前页'+
  (status.blocked?'。选中文档正在移除或恢复，请处理完成后再备份。':'')+
  (librarySelectionDropped?'。已取消 '+librarySelectionDropped+' 份已移除或替换文档的选择。':'');
 if($('library-selection-status').textContent!==message)$('library-selection-status').textContent=message;
 const exportLabel='备份所选 '+status.count+' 份';
 if($('export-selected-library').textContent!==exportLabel)$('export-selected-library').textContent=exportLabel;
 $('export-selected-library').disabled=!status.count||status.blocked;
 $('clear-library-selection').disabled=!status.count;
 const current=librarySelectionMode?new Set(state.documents):null;
 for(const card of libraryCards.values()){
  card.selectLabel.hidden=!librarySelectionMode||$('library-search-dialog').open;
  card.select.checked=libraryBackupSelection.has(card.doc);
  card.select.disabled=pendingStructuralDocuments.has(card.doc.key)||!!current&&!current.has(card.doc);
  const label='选择备份 '+card.doc.title;if(card.select.getAttribute('aria-label')!==label)card.select.setAttribute('aria-label',label);
 }
}
$('library-selection-mode').onclick=()=>{
 librarySelectionMode=!librarySelectionMode;
 if(!librarySelectionMode){libraryBackupSelection.clear();librarySelectionDropped=0;$('library-list').style.removeProperty('--library-keyboard-space');}
 syncLibraryBackupSelection();
};
$('clear-library-selection').onclick=()=>{libraryBackupSelection.clear();librarySelectionDropped=0;syncLibraryBackupSelection();};

function libraryPageFocus(){
 if(libraryMobile.matches&&!$('library-search-dialog').open)$('library-tools').open=false;
 $('toggle-library').setAttribute('aria-expanded','true');
 ($('library').querySelector('.library-open:not(:disabled)')||$('library-search')).focus();
}
function createLibraryCard(d){
 const entry=el('div','library-entry');entry.dataset.documentKey=d.key;
 const open=el('button','library-open');open.type='button';
 const title=el('span','library-title'),metadata=el('small');open.append(title,metadata);
 const openDocument=(hit=null)=>{
  if(pendingStructuralDocuments.has(d.key)||!state.documents.includes(d))return;
  const fromWorkspace=$('library-search-dialog').open;
  if(fromWorkspace&&!contentIngressAllowed(d)){notice('当前保存状态暂不允许打开结果，请先处理保存提示。');return;}
  if(fromWorkspace)rememberLibraryWorkspace(d,hit);
  if(Coconut.isReadingCollection(d)){if(fromWorkspace)closeLibraryWorkspace('selection');openCollection(d);return;}
  markDocumentOpened(d);
  if(!fromWorkspace&&!hit&&libraryMobile.matches&&$('toggle-library').getAttribute('aria-expanded')==='true'&&d.key===active()?.key&&libraryBrowseOrigin?.reading&&libraryBrowseOrigin.doc===d&&libraryBrowseOrigin.selectionRevision===activeSelectionRevision){returnFromLibrary();renderLibrary();return;}
  resetReaderForDocumentNavigation();selectActiveDocument(d.key);
  setReadingMode(defaultReadingMode(d));
  $('toggle-library').setAttribute('aria-expanded','false');showWorkspace('read');render();
  if(fromWorkspace)closeLibraryWorkspace('selection');
  if(hit)openLibraryHit(hit);
  else resumeOpenedDocument(d,'title',{remembered:true});
 };
 open.onclick=()=>openDocument();
 const remove=el('button','library-remove','移除…');remove.type='button';remove.onclick=()=>requestLibraryRemoval(d);
 const selectLabel=el('label','library-select-label'),select=el('input','library-select');select.type='checkbox';selectLabel.hidden=true;
 selectLabel.append(select,document.createTextNode('备份此文档'));
 select.onchange=()=>{libraryBackupSelection.toggle(d,select.checked,state.documents,pendingStructuralDocuments);syncLibraryBackupSelection();};
 entry.append(open,selectLabel,remove);
 return {doc:d,entry,open,title,metadata,remove,select,selectLabel,openDocument,hitSignature:null,hits:null,savedHits:null,savedSelection:null};
}
// Only known content refreshes reuse these derived values. An ordinary render
// remains the conservative path for callers that changed source objects in place.
let libraryMetadata=new WeakMap();
function libraryDocumentMetadata(doc){
 const receipt=libraryStore.status(doc.key),generation=receipt?.identity===doc?receipt.generation:null;
 const previous=libraryMetadata.get(doc);
 if(previous&&previous.generation===generation&&previous.segments===doc.segments&&previous.length===doc.segments.length&&previous.notes===doc.notes&&previous.readingPosition===doc.readingPosition&&previous.mediaDuration===doc.media_duration&&previous.kind===doc.project_kind)return previous;
 const metadata={generation,segments:doc.segments,length:doc.segments.length,notes:doc.notes,readingPosition:doc.readingPosition,mediaDuration:doc.media_duration,kind:doc.project_kind,
  bookmark:doc.readingPosition?doc.segments.find(segment=>segment.id===doc.readingPosition):undefined,duration:Coconut.documentDuration(doc),noteCount:Coconut.segmentNoteCount(doc)};
 libraryMetadata.set(doc,metadata);return metadata;
}
const librarySearch=Coconut.createLibrarySearch({getDocuments:()=>state.documents,getRevision:()=>libraryContentRevision,getDuration:doc=>libraryDocumentMetadata(doc).duration,onChange:()=>renderLibrary(null,{reuseMetadata:true})});
let libraryPendingReveal=null,libraryTranslationReveal=null,libraryTranslationActivation=0;
function renderLibrary(revealKey=null,{reuseMetadata=false}={}) {
 renderLibraryRestoreResults();
 if(!reuseMetadata)libraryMetadata=new WeakMap();
 libraryRenderedRevision=libraryContentRevision;
 const host=$('library'),query=$('library-search').value.trim().toLocaleLowerCase(),scope=$('library-scope').value;
 $('library-scope-hint').hidden=scope!=='translations';
 $('library-search').placeholder=scope==='translations'?'查找已存译文（全部语言）':scope==='title'?'按标题查找':scope==='notes'?'查找标题与笔记（含摘录笔记）':'查找标题、原文、笔记与已存摘录';
 const signature=JSON.stringify([query,$('library-sort').value,$('library-kind').value,scope]);
 const viewChanged=libraryViewSignature!==null&&signature!==libraryViewSignature;
 if(viewChanged){libraryWorkspaceReturn=null;libraryWorkspaceFocus=null;libraryWorkspacePendingRestore=null;libraryWorkspaceScroll=0;if($('library-search-dialog').open)$('library-search-results').scrollTop=0;$('return-library-search').hidden=true;}
 const selection=librarySearch.request(query,$('library-kind').value,scope,$('library-sort').value,!reuseMetadata);
 if(typeof revealKey==='string')libraryPendingReveal={signature,key:revealKey};
 if(libraryPendingReveal?.signature!==signature)libraryPendingReveal=null;
 host.setAttribute('aria-busy',String(selection.pending));
 if(selection.pending){
  if(viewChanged)libraryPage=0;
  libraryViewSignature=signature;
  // Never advertise a partial count or leave old-query hits actionable.
  if(host.contains(document.activeElement))focusLibrarySearch();
  host.hidden=true;$('library-empty').hidden=true;$('library-pagination').hidden=true;$('library-show-active').hidden=true;
  $('library-total').textContent=String(state.documents.filter(doc=>!Coconut.isReadingCollection(doc)).length);
  $('library-page-status').textContent='正在查找… 已检查 '+selection.scanned+' / '+selection.documents.length+' 份';
  syncLibraryBackupSelection([]);
  return;
 }
 host.hidden=false;
 if(libraryPendingReveal){revealKey=libraryPendingReveal.key;libraryPendingReveal=null;}
 const ordinaryCount=state.documents.filter(doc=>!Coconut.isReadingCollection(doc)).length;
 const docs=$('library-sort').value==='opened'?Coconut.sortedLibrary(selection.docs,'opened',readingRecency.time):selection.docs;
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
 $('library-total').textContent=String(state.documents.filter(doc=>!Coconut.isReadingCollection(doc)).length);
 $('library-empty').hidden=docs.length>0;
 $('library-empty').textContent=ordinaryCount?'没有匹配的内容，可调整书架筛选或查找范围':'还没有内容。添加一份，或体验示例。';
 const range=docs.length?(start+1)+'–'+(start+visible.length):'0';
 const status='显示 '+range+' / '+docs.length+' 份'+(docs.length!==ordinaryCount?' · 书架共 '+ordinaryCount+' 份':'');
 if($('library-page-status').textContent!==status)$('library-page-status').textContent=status;
 $('library-pagination').hidden=pageCount<=1;
 $('library-previous').disabled=libraryPage===0;$('library-next').disabled=libraryPage+1>=pageCount;
 $('library-page-count').textContent=String(pageCount||1);$('library-page-number').max=String(pageCount||1);
 if(document.activeElement!==$('library-page-number'))$('library-page-number').value=String(libraryPage+1);
 $('library-show-active').hidden=activeIndex<0||Math.floor(activeIndex/LIBRARY_PAGE_SIZE)===libraryPage;
 const focused=document.activeElement,focusedEntry=focused?.closest('.library-entry');
 const focusKey=focusedEntry?.dataset.documentKey,hitKind=focused?.dataset.hitKind,hitId=focused?.dataset.hitId,hitLanguage=focused?.dataset.language;
 const nextCards=new Map();
 for(const d of visible){
  const previous=libraryCards.get(d.key),card=previous?.doc===d?previous:createLibraryCard(d);
  const {bookmark,duration,noteCount}=libraryDocumentMetadata(d),audioOnly=Coconut.isAudioProject(d);
  const metadata=Coconut.isReadingCollection(d)?['精选成果集',d.items.length+' 条记录']:audioOnly?['原声项目','未导入文字稿',duration?Coconut.time(duration):'时长待确认']:[Coconut.time(duration),noteCount+' 则片段笔记'];
  if(Coconut.hasProjectAnnotations(d))metadata.push((Coconut.hasNoteContent(d.project_note)?1:0)+' 则项目笔记',d.timestamp_bookmarks.length+' 个时间书签');
  if(bookmark)metadata.push('读到 '+Coconut.time(bookmark.start));
  if(card.title.textContent!==d.title)card.title.textContent=d.title;
  const description=metadata.join(' · ');if(card.metadata.textContent!==description)card.metadata.textContent=description;
  card.open.classList.toggle('active',d.key===state.active);card.open.setAttribute('aria-current',d.key===state.active?'page':'false');
  card.open.disabled=pendingStructuralDocuments.has(d.key);card.open.title=card.open.disabled?'正在保存恢复，完成后可打开':'';
  card.remove.setAttribute('aria-label','从书架移除 '+d.title);card.remove.hidden=$('library-search-dialog').open||!$('library-options').open;card.remove.disabled=!!pendingLibraryOperation;
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
  if(card.translationSelection!==selection){
   card.translationHits?.remove();card.translationHits=null;card.translationSelection=selection;
   const groups=selection.translationHits.get(d)||[];
   let retained=libraryWorkspacePositions.get(d);
   if(!retained||retained.signature!==selection.signature){retained={signature:selection.signature,positions:new Map()};libraryWorkspacePositions.set(d,retained);}
   card.translationPositions=retained.positions;card.translationSignature=selection.signature;
   if(groups.length){
    const list=el('div','library-translation-hits');list.setAttribute('aria-label','当前有效译文 · 全部匹配语言');
    for(const group of groups){
     let position=group.positions.get(card.translationPositions.get(group.language))??0;
     const region=el('div','library-translation-group');region.dataset.language=group.language;
     const button=el('button','library-hit library-translation-hit');button.type='button';button.dataset.hitKind='translation';button.dataset.language=group.language;
     const label=el('small'),preview=el('span','library-hit-preview'),source=el('span','library-hit-source');button.append(label,preview,source);
     const controls=el('div','library-translation-pagination'),status=el('span','library-translation-status'),previous=el('button','library-translation-previous','上一处'),next=el('button','library-translation-next','下一处');
     status.setAttribute('role','status');previous.type=next.type='button';
     previous.setAttribute('aria-label',translationLabel(group.language)+'译文上一处');next.setAttribute('aria-label',translationLabel(group.language)+'译文下一处');
     const current=()=>button.isConnected&&librarySearch.isCurrent(selection)&&!pendingStructuralDocuments.has(d.key)&&Coconut.libraryTranslationHitCurrent(group.hits[position],state.documents);
     const refresh=()=>{
      const hit=group.hits[position];button.dataset.hitId=hit.id;card.translationPositions.set(group.language,hit.id);
      label.textContent='译文 · '+translationLabel(hit.language)+' · '+Coconut.time(hit.time)+(hit.cueCount>1?' · 跨 '+hit.cueCount+' 段':'');
      preview.replaceChildren(document.createTextNode(hit.snippet.before),el('mark','',hit.snippet.match),document.createTextNode(hit.snippet.after));source.textContent='原文：'+hit.source;
      status.textContent='第 '+(position+1)+' / '+group.hits.length+' 处';status.setAttribute('aria-label',translationLabel(group.language)+'译文：第 '+(position+1)+' / '+group.hits.length+' 个匹配片段');previous.disabled=position===0;next.disabled=position===group.hits.length-1;
     };
     const move=delta=>{libraryTranslationActivation++;if(!current()){notice('译文搜索结果已变动，请重新查找。');if(state.documents.includes(d))Coconut.invalidateSearch(d);renderLibrary();return;}position=Math.max(0,Math.min(group.hits.length-1,position+delta));refresh();button.focus();const revision=libraryFocusRevealRevision;requestAnimationFrame(()=>revealLibrarySelectionFocus(button,card,revision));};
     previous.onclick=()=>move(-1);next.onclick=()=>move(1);
     button.onclick=()=>{
      const hit=group.hits[position],generation=++libraryTranslationActivation,origin=active(),revision=activeSelectionRevision,focus=document.activeElement,mode=readingMode,space=workspace,session=libraryWorkspaceSession,fromWorkspace=$('library-search-dialog').open;
      if(!current()){notice('译文搜索结果已变动，请重新查找。');if(state.documents.includes(d))Coconut.invalidateSearch(d);renderLibrary();return;}
      if(!contentIngressAllowed(d)){notice('当前保存状态暂不允许切换译文，请先处理保存提示。');return;}
      const operation=Coconut.libraryTranslationHitCurrentSteps(hit,state.documents);
      const step=()=>{
       if(session!==libraryWorkspaceSession||(fromWorkspace&&!$('library-search-dialog').open)||generation!==libraryTranslationActivation||group.hits[position]!==hit||active()!==origin||revision!==activeSelectionRevision||document.activeElement!==focus||readingMode!==mode||workspace!==space||!button.isConnected||!librarySearch.isCurrent(selection)){operation.return();return;}
       if(!current()){operation.return();notice('译文搜索结果已变动，请重新查找。');if(state.documents.includes(d))Coconut.invalidateSearch(d);renderLibrary();return;}
       const result=operation.next();
       if(!result.done){setTimeout(step,0);return;}
       if(!result.value){notice('译文搜索结果已变动，请重新查找。');Coconut.invalidateSearch(d);renderLibrary();return;}
       if(contentIngressAllowed(d))card.openDocument(hit);
      };step();
     };
     controls.append(previous,status,next);controls.hidden=group.hits.length<=1;region.append(button,controls);list.append(region);refresh();
    }
    card.entry.append(list);card.translationHits=list;
   }
  }
  // Historical previews belong to this completed search, not a render-time scan.
  if(card.savedSelection!==selection){
   card.savedHits?.remove();card.savedHits=null;card.savedSelection=selection;
   const saved=selection.savedHits?.get(d);
   if(saved?.hits.length){
    const list=el('div','library-saved-hits');list.setAttribute('aria-label','匹配的已存摘录（历史快照）');
    list.append(el('p','hint','已存摘录 · 历史快照'));
    for(const hit of saved.hits){
     const button=el('button','library-saved-hit');button.type='button';button.dataset.hitKind=hit.kind;button.dataset.hitId=hit.id;button.dataset.captureKey=hit.captureKey;
     button.append(el('small','',hit.matchFields==='translation'?'摘录时译文 · 历史快照':hit.matchFields==='quote'?'已存摘录 · 历史快照':'摘录与笔记 · 历史快照'));
     for(const [label,snippet] of [['摘录：',hit.quoteSnippet],['摘录时译文：',hit.translationSnippet],['我的笔记：',hit.noteSnippet]])if(snippet){
      const preview=el('span','library-hit-preview');preview.append(document.createTextNode(label+snippet.before),el('mark','',snippet.match),document.createTextNode(snippet.after));button.append(preview);
     }
     button.onclick=()=>openSavedLibraryHit(hit,d,selection,button);list.append(button);
    }
    if(saved.total>saved.hits.length){
     const more=el('button','library-saved-more',`查看匹配的已存摘录（共 ${saved.total} 条）`);more.type='button';
     more.onclick=()=>openSavedLibraryHit(saved.hits[0],d,selection,more);list.append(more);
    }
    card.entry.append(list);card.savedHits=list;
   }
  }
  for(const hit of [...(card.hits?.children||[]),...(card.savedHits?.querySelectorAll('button')||[]),...(card.translationHits?.querySelectorAll('.library-translation-hit')||[])])hit.disabled=pendingStructuralDocuments.has(d.key);
  nextCards.set(d.key,card);
 }
 // Avoid moving unchanged nodes: moving a focused button can reset focus in a
 // native browser even if it returns to the same parent in the same task.
 let index=0;
 for(const {entry} of nextCards.values()){if(host.children[index]!==entry)host.insertBefore(entry,host.children[index]||null);index++;}
 while(host.children.length>index)host.lastElementChild.remove();
 libraryCards=nextCards;
 syncLibraryBackupSelection(visible);
 // A refreshed preview or reordered card keeps the exact action when it still
 // exists. Never steal focus from an editor, dialog, or async operation.
 if(focusKey&&(!focused.isConnected||document.activeElement===document.body)){
  const card=libraryCards.get(focusKey);
  const target=hitKind?[...(card?.hits?.children||[]),...(card?.savedHits?.querySelectorAll('button')||[]),...(card?.translationHits?.querySelectorAll('.library-translation-hit')||[])].find(node=>node.dataset.hitKind===hitKind&&node.dataset.hitId===hitId&&node.dataset.language===hitLanguage):focused.classList.contains('library-remove')?card?.remove:focused.classList.contains('library-select')?card?.select:card?.open;
  if(target&&!target.disabled&&!target.hidden)target.focus({preventScroll:true});
  else if(card&&!card.open.disabled)card.open.focus({preventScroll:true});
  else focusLibrarySearch();
 }
 const restore=libraryWorkspacePendingRestore;
 if(restore&&restore.session===libraryWorkspaceSession&&$('library-search-dialog').open){
  libraryWorkspacePendingRestore=null;const target=libraryWorkspaceTarget();
  if(restore.focusOwned&&document.activeElement===$('library-search')){
   $('library-search-results').scrollTop=libraryWorkspaceScroll;
   if(visibleLibraryControl(target)){target.focus({preventScroll:true});target.scrollIntoView?.({block:'nearest',behavior:'instant'});}
  }
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
function bilingualExcerptDisplay(record){
 const paired=Coconut.exactExcerptTranslation?.(record);if(!paired)return '';
 const labels={'user-authored':'用户自写','human-reviewed':'已有人工核对','machine':'机器生成，需核对'};
 return '选取时译文（'+paired.language+'）：\n'+paired.text+'\n初始来源：'+paired.providers.join('、')+' · '+paired.reviewStates.map(value=>labels[value]||value).join('、')+'\n译文生成时间：未记录。配对确认时间：'+paired.confirmedAt+'\n用户确认两段对应，不等于重新核对整份翻译；后续来源变化不会改写快照。'+(paired.qualityWarnings.length?'\n选取时质量提示：'+Coconut.translationQualityMessage({quality_warnings:paired.qualityWarnings}):'');
}
// Copy is read-only and receipt-bound to its own mounted view. A denied clipboard
// write keeps a selectable plain-text fallback, without touching the note editor.
function savedExcerptCopy(record,isCurrent){
 const host=el('div','saved-excerpt-copy'),button=el('button','','复制引用与出处'),status=el('p','hint');let busy=false,field=null;
 button.type='button';button.title='复制选取时原文、译文与出处；不包含个人笔记。';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const current=()=>host.isConnected&&isCurrent();
 button.onclick=async()=>{
  if(busy||!current())return;
  // Keep native keyboard focus while the permission request is pending. The
  // busy guard owns repeated activation; aria-disabled announces that state.
  const payload=CoconutQuotation.savedAttribution(record,Coconut);busy=true;button.setAttribute('aria-disabled','true');status.textContent='正在复制选取时引用与出处…';
  try{
   if(!navigator.clipboard?.writeText)throw Error('unavailable');await navigator.clipboard.writeText(payload);
   if(current())status.textContent='已复制选取时引用与出处，不含个人笔记。';
  }catch{
   if(current()){
    status.textContent='未能自动复制。完整引用已保留，请在下方全选后手动复制。'+(payload.includes('\r\n')?' 手动复制采用预览中的换行格式。':'');
    if(!field){field=el('textarea','saved-excerpt-copy-preview');field.readOnly=true;field.rows=8;field.setAttribute('aria-label','完整引用与出处（选取时快照）');host.append(field);}
    field.value=payload.replace(/\r\n?/g,'\n');
    // A late rejection must not take focus back from a note, another record or
    // a nested dialog the user opened while the native permission was pending.
    if(document.activeElement===button){field.focus();field.select();}
   }
  }finally{busy=false;button.removeAttribute('aria-disabled');}
 };
 host.append(button,status);return {host,button};
}
// Reading recall is derived from immutable captures. It never marks source words,
// changes cue annotations, or persists a second anchor. Each render batches source
// checks once; save receipts only update mounted controls and status text.
const readingExcerptOwners=new WeakMap();
let readingExcerptControls=[],readingExcerptDialog=null;
const READING_EXCERPT_PAGE_SIZE=8;
function readingExcerptIndex(doc){
 const records=doc.exact_excerpts||[],byCue=new Map(),cues=new Map();
 if(!records.length)return {doc,byCue,cues,states:new Map()};
 for(const cue of doc.segments)cues.set(cue.id,cue);
 const states=Coconut.exactExcerptStateBatch(records,doc);
 let owners=readingExcerptOwners.get(doc);if(!owners){owners=new WeakMap();readingExcerptOwners.set(doc,owners);}
 for(const record of records){
  let owner=owners.get(record);
  if(!owner){owner={cues:record.snapshot.cues.map(cue=>cues.get(cue.id)),replaced:false};owners.set(record,owner);}
  owner.replaced=record.snapshot.cues.some((cue,index)=>cues.get(cue.id)!==owner.cues[index]);
  const state=states.get(record.id);
  if(owner.replaced&&state.freshness==='current')state.freshness='stale';
  if(owner.replaced)state.replaced=true;
  // Missing/reordered context has no reliable current location. Keep it in the
  // notebook, rather than guessing from remaining words or matching times.
  if(!state.cueId)continue;
  for(const part of Coconut.exactExcerptParts(record)){
   if(!byCue.has(part.cue.id))byCue.set(part.cue.id,[]);
   byCue.get(part.cue.id).push(record);
  }
 }
 return {doc,byCue,cues,states};
}
function readingExcerptRecords(entry,index){
 const found=new Set();for(const cue of entry.cues)for(const record of index.byCue.get(cue.id)||[])found.add(record);
 return [...found];
}
function readingExcerptHistory(state){
 return state?.freshness==='missing'?'原片段已移除；以下保留选取时快照。':state?.replaced?'历史关联：原片段已替换；以下保留选取时快照。':state?.freshness==='current'?'选取时快照 · 来源仍一致':'历史关联：原文、出处或译文已变化；以下保留选取时快照。';
}
function readingExcerptPersistence(doc){
 const status=libraryStore.status(doc.key);
 return status?.identity===doc&&status.status==='saved'?'已保存到本机':status?.status==='pending'?'正在保存；请暂留本页':'尚未保存到本机；可从笔记编辑中重试或导出备份';
}
function updateReadingExcerptControl(entry,index){
 entry.records=readingExcerptRecords(entry,index);entry.states=index.states;
 const count=entry.records.length,historical=entry.records.some(record=>index.states.get(record.id)?.freshness!=='current');
 entry.button.hidden=!count;entry.button.textContent='摘录 '+count;
 entry.button.dataset.history=String(historical);
 entry.button.setAttribute('aria-label','查看本'+(entry.mode==='passages'?'段':'片段')+'的 '+count+' 条精确摘录与个人笔记'+(historical?'，含历史关联':''));
 entry.button.title=(historical?'含历史关联；打开查看选取时快照。':'查看这段原文中选取的精确摘录。')+' '+readingExcerptPersistence(entry.doc);
}
function readingExcerptControl(doc,cues,mode,index){
 const button=el('button','reading-excerpt-open');button.type='button';button.setAttribute('aria-haspopup','dialog');
 const entry={doc,cues,mode,button,selection:activeSelectionRevision};readingExcerptControls.push(entry);updateReadingExcerptControl(entry,index);
 button.onclick=()=>{
  if(!button.isConnected||active()!==doc||activeSelectionRevision!==entry.selection||!state.documents.includes(doc))return;
  const current=readingExcerptIndex(doc);
  if(cues.some(cue=>current.cues.get(cue.id)!==cue))return;
  updateReadingExcerptControl(entry,current);if(!entry.records.length)return;
  readingExcerptDialog={entry,doc,selection:entry.selection,mode:readingMode,records:entry.records.slice(),page:0,rows:[]};
  renderReadingExcerptList(current);$('reading-excerpts-dialog').showModal();$('reading-excerpts-heading').focus({preventScroll:true});
 };
 return button;
}
function readingExcerptDialogOwned(current=active()){const view=readingExcerptDialog;return !!view&&current===view.doc&&activeSelectionRevision===view.selection&&state.documents.includes(view.doc);}
function refreshReadingExcerptSaveState(){
 const current=active(),persistence=current?readingExcerptPersistence(current):'';
 readingExcerptControls=readingExcerptControls.filter(entry=>entry.button.isConnected);
 for(const entry of readingExcerptControls)if(current===entry.doc)entry.button.title=(entry.button.dataset.history==='true'?'含历史关联；打开查看选取时快照。':'查看这段原文中选取的精确摘录。')+' '+persistence;
 const view=readingExcerptDialog;if(!view)return;
 const ownedView=readingExcerptDialogOwned(current),liveRecords=ownedView?new Set(view.doc.exact_excerpts||[]):null;
 $('reading-excerpts-previous').disabled=!ownedView||view.page===0;
 $('reading-excerpts-next').disabled=!ownedView||(view.page+1)*READING_EXCERPT_PAGE_SIZE>=view.records.length;
 $('reading-excerpts-save-status').textContent=ownedView?persistence:'篇目已更换或移除；这里保留刚才的快照，请关闭后重新选择。';
 for(const row of view.rows){
  const owned=ownedView&&liveRecords.has(row.record);
  row.edit.disabled=!owned;row.copy.disabled=!owned;row.state.textContent=owned?readingExcerptHistory(row.source):'这条摘录已更换或移除；显示的是刚才的快照。';
  const note=owned?Coconut.exactExcerptNote(view.doc,row.record.id):row.noteText;
  if(owned)row.noteText=note;
  row.note.textContent=Coconut.hasNoteContent(note)?'我的笔记：'+readingExcerptPreview(note):'还没有个人笔记';
  row.edit.textContent=Coconut.hasNoteContent(note)?'编辑我的笔记':'添加我的笔记';
 }
}
function refreshReadingExcerpts(doc){
 if(active()!==doc)return;
 const index=readingExcerptIndex(doc);
 for(const entry of readingExcerptControls)if(entry.button.isConnected&&entry.doc===doc)updateReadingExcerptControl(entry,index);
 const view=readingExcerptDialog;
 if(view?.doc===doc)for(const row of view.rows)row.source=index.states.get(row.record.id)||row.source;
 refreshReadingExcerptSaveState();
}
function readingExcerptPreview(text,limit=320){let end=Math.min(text.length,limit);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;return text.slice(0,end)+(end<text.length?'…':'');}
function appendReadingExcerptText(host,label,text){
 host.append(el('p','hint',label));const content=el('p','reading-excerpt-content'),more=el('button','reading-excerpt-more','继续展开');more.type='button';let end=0;
 const extend=()=>{end=Math.min(text.length,end+4000);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;content.textContent=text.slice(0,end);more.hidden=end>=text.length;};
 more.onclick=()=>{extend();if(more.hidden)content.focus({preventScroll:true});};content.tabIndex=-1;extend();host.append(content,more);
}
function renderReadingExcerptList(index=readingExcerptIndex(readingExcerptDialog.doc)){
 const view=readingExcerptDialog;if(!view)return;
 const start=view.page*READING_EXCERPT_PAGE_SIZE,records=view.records.slice(start,start+READING_EXCERPT_PAGE_SIZE);
 $('reading-excerpts-heading').textContent='本'+(view.entry.mode==='passages'?'段':'片段')+'的摘录';
 $('reading-excerpts-position').textContent=(start+1)+'–'+(start+records.length)+' / '+view.records.length+' 条';
 $('reading-excerpts-previous').disabled=view.page===0;$('reading-excerpts-next').disabled=start+records.length>=view.records.length;
 const host=$('reading-excerpts-list');host.replaceChildren();view.rows=[];
 for(const record of records){
  const row=el('li','reading-excerpt-item');row.dataset.excerptId=record.id;
  const source=el('p','hint reading-excerpt-history'),note=el('p','reading-excerpt-note'),edit=el('button','reading-excerpt-edit');edit.type='button';
  const parts=Coconut.exactExcerptParts(record);
  row.append(el('p','hint',Coconut.time(parts[0].cue.start)+' · '+(record.version===2?'双语摘录':'所选原文')),source,el('p','reading-excerpt-preview',readingExcerptPreview(record.text)));
  if(record.version===2)row.append(el('p','reading-excerpt-translation',readingExcerptPreview(record.translation.text)));
  const details=el('details','reading-excerpt-details');details.append(el('summary','','查看完整摘录与来源'));let loaded=false;
  details.addEventListener('toggle',()=>{
   if(!details.open||loaded)return;loaded=true;
   appendReadingExcerptText(details,'选取时原文',record.text);
   if(record.version===2)appendReadingExcerptText(details,'选取时译文与配对信息',bilingualExcerptDisplay(record));
   const origin=Coconut.exactExcerptSource(record);details.append(el('p','hint','摘录时篇目：'+origin.title+'\n摘录时间：'+record.created_at+'\n'+(origin.source_url||'无原站链接')));
  });
  edit.onclick=()=>{if(readingExcerptDialog!==view||!readingExcerptDialogOwned()||!view.doc.exact_excerpts?.includes(record))return;openExactNote(view.doc,record,edit);};
  const copy=savedExcerptCopy(record,()=>readingExcerptDialog===view&&$('reading-excerpts-dialog').open&&readingExcerptDialogOwned()&&view.doc.exact_excerpts?.includes(record));
  row.append(details,copy.host,note,edit);host.append(row);view.rows.push({record,state:source,source:index.states.get(record.id),note,noteText:Coconut.exactExcerptNote(view.doc,record.id),edit,copy:copy.button});
 }
 refreshReadingExcerptSaveState();
}
function closeReadingExcerpts(){
 const view=readingExcerptDialog,owned=readingExcerptDialogOwned();readingExcerptDialog=null;$('reading-excerpts-dialog').close();
 if(!view||!owned)return;
 if(view.mode===readingMode&&view.entry.button.isConnected&&!view.entry.button.hidden){view.entry.button.focus({preventScroll:true});return;}
 const cue=view.entry.cues.find(cue=>view.doc.segments.includes(cue)),node=cue&&chapterCueNode(cue.id,readingMode);
 if(node){node.tabIndex=-1;node.focus({preventScroll:true});}else $('mode-'+readingMode)?.focus({preventScroll:true});
}
$('reading-excerpts-close').onclick=closeReadingExcerpts;
$('reading-excerpts-dismiss').onclick=closeReadingExcerpts;
$('reading-excerpts-dialog').addEventListener('cancel',event=>{event.preventDefault();closeReadingExcerpts();});
$('reading-excerpts-dialog').addEventListener('close',()=>{if(!$('reading-excerpts-dialog').open)readingExcerptDialog=null;});
for(const [id,direction] of [['reading-excerpts-previous',-1],['reading-excerpts-next',1]])$(id).onclick=()=>{
 const view=readingExcerptDialog;if(!view||!readingExcerptDialogOwned())return;
 view.page=Math.max(0,Math.min(Math.ceil(view.records.length/READING_EXCERPT_PAGE_SIZE)-1,view.page+direction));renderReadingExcerptList();$('reading-excerpts-heading').focus({preventScroll:true});$('reading-excerpts-dialog').scrollTop=0;
};

// Native dialogs make the page inert but may hand the last Tab to browser
// chrome. Only the two actual boundaries are ours; interior traversal remains
// native, including readonly evidence and expanded details.
for(const id of ['reading-excerpts-dialog','exact-note-dialog','subtitle-encoding-dialog','local-media-project-dialog','paste-subtitle-dialog'])$(id).addEventListener('keydown',event=>{
 const dialog=$(id);
 if(!dialog.open||event.key!=='Tab'||event.defaultPrevented||event.isComposing||event.keyCode===229||event.altKey||event.ctrlKey||event.metaKey||event.target.closest?.('dialog')!==dialog)return;
 const controls=[...dialog.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex]')].filter(node=>{
  if(node.tabIndex<0||node.matches(':disabled')||node.closest('[hidden],[inert]'))return false;
  for(let parent=node;parent&&parent!==dialog;parent=parent.parentElement){
   const style=getComputedStyle(parent);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return false;
   if(parent.tagName==='DETAILS'&&!parent.open){const summary=parent.querySelector('summary');if(!summary?.contains(node))return false;}
  }
  return true;
 });
 const first=controls[0],last=controls.at(-1),focused=document.activeElement;
 if(first&&((event.shiftKey&&(focused===first||focused===dialog.querySelector('[autofocus]')))||(!event.shiftKey&&focused===last))){event.preventDefault();(event.shiftKey?last:first).focus();}
});
function exactExcerptSaveState(doc,record){
 const status=libraryStore.status(doc.key);
 return state.documents.includes(doc)&&doc.exact_excerpts?.includes(record)&&status?.identity===doc&&status.status==='saved'?'saved':'unsaved';
}
const exactExcerptWrites=new WeakMap();
async function saveExactExcerpt(doc,record){
 if(active()!==doc||!contentIngressAllowed(doc))return {ok:false};
 const existing=Coconut.exactExcerptDuplicate(doc,record);
 if(existing&&exactExcerptSaveState(doc,existing)==='saved')return {ok:true};
 if(!existing)(doc.exact_excerpts??=[]).push(record);
 const owned=existing||record,pending=exactExcerptWrites.get(doc)||new Map();
 if(pending.has(owned))return pending.get(owned);
 const receipt=commitDocument(doc);pending.set(owned,receipt);exactExcerptWrites.set(doc,pending);
 renderLibrary();renderNotebookAction(doc);refreshReadingExcerpts(doc);
 try{return await receipt;}finally{pending.delete(owned);if(!pending.size)exactExcerptWrites.delete(doc);}
}
// The editor owns a document and immutable quotation, never a search-result row.
function exactNoteIdentity(editor){
 return state.documents.includes(editor.doc)&&editor.doc.exact_excerpts?.includes(editor.record);
}
function exactNoteBaseline(doc,id){return {present:Object.hasOwn(doc.exact_excerpt_notes||{},id),text:Coconut.exactExcerptNote(doc,id)};}
function exactNoteDraft(){return !!exactNoteEditor&&$('exact-note-dialog').open&&$('exact-note-text').value!==exactNoteEditor.displayBase;}
function exactNoteText(editor){const displayed=$('exact-note-text').value;return displayed===editor.displayBase?editor.base.text:displayed;}
function openExactNote(doc,record,opener){
 if(!contentIngressAllowed(doc)||!doc.exact_excerpts?.includes(record))return;
 exactNoteEditor={doc,record,opener,base:exactNoteBaseline(doc,record.id),serial:0,pending:false};
 $('exact-note-quote').value=record.text+(bilingualExcerptDisplay(record)?'\n\n'+bilingualExcerptDisplay(record):'');$('exact-note-text').value=exactNoteEditor.base.text;
 // Native textarea values normalize CRLF/CR. Keep raw storage separate from
 // the displayed baseline so opening or saving an unchanged note is lossless.
 exactNoteEditor.displayBase=$('exact-note-text').value;
 $('exact-note-status').textContent='';$('exact-note-save').setAttribute('aria-disabled','false');
 $('exact-note-dialog').showModal();$('exact-note-text').focus({preventScroll:true});
}
function closeExactNote(){
 const editor=exactNoteEditor;exactNoteEditor=null;$('exact-note-dialog').close();
 refreshReadingExcerptSaveState();
 if(editor?.opener?.closest?.('#reading-excerpts-dialog')){
  if(readingExcerptDialogOwned()&&$('reading-excerpts-dialog').open){
   if(editor.opener.isConnected&&!editor.opener.disabled)editor.opener.focus({preventScroll:true});
   else $('reading-excerpts-heading').focus({preventScroll:true});
  }
 }else if(editor?.opener?.isConnected&&!editor.opener.disabled)editor.opener.focus({preventScroll:true});
 else if($('library-notebook').open)$('notebook-search').focus({preventScroll:true});
 syncUnsavedUnloadGuard();
}
$('exact-note-cancel').onclick=closeExactNote;
$('exact-note-close').onclick=()=>{
 if(exactNoteDraft()){$('exact-note-status').textContent='笔记尚未提交。请保存，或选择「取消编辑」丢弃草稿。';return;}
 closeExactNote();
};
$('exact-note-dialog').addEventListener('cancel',event=>{event.preventDefault();$('exact-note-close').click();});
$('exact-note-dialog').addEventListener('close',()=>{if(!$('exact-note-dialog').open){exactNoteEditor=null;syncUnsavedUnloadGuard();}});
$('exact-note-text').oninput=()=>{
 if(!exactNoteEditor)return;exactNoteEditor.serial++;
 $('exact-note-status').textContent=exactNoteDraft()?'尚未提交的笔记草稿':'';
 $('exact-note-save').setAttribute('aria-disabled','false');syncUnsavedUnloadGuard();
};
$('exact-note-save').onclick=async()=>{
 const editor=exactNoteEditor;if(!editor||!$('exact-note-dialog').open)return;
 if(editor.pending&&!exactNoteDraft())return;
 const status=$('exact-note-status'),current=exactNoteBaseline(editor.doc,editor.record.id);
 if(!exactNoteIdentity(editor)){status.textContent='摘录或篇目已更换或移除。草稿仍在这里，可导出后重新选择记录。';return;}
 if(current.present!==editor.base.present||current.text!==editor.base.text){status.textContent='这条笔记已被其他编辑更改，未覆盖。请导出草稿后关闭并重新打开。';return;}
 if(!contentIngressAllowed(editor.doc)){status.textContent='目前无法保存。草稿仍在这里，可导出保留。';return;}
 const displayed=$('exact-note-text').value,text=exactNoteText(editor),serial=++editor.serial;
 editor.doc.exact_excerpt_notes=Coconut.exactExcerptNotesWith(editor.doc,editor.record.id,text);
 editor.base=exactNoteBaseline(editor.doc,editor.record.id);editor.displayBase=displayed;editor.pending=true;editor.savingSerial=serial;
 status.textContent='保存中…';$('exact-note-save').setAttribute('aria-disabled','true');
 const receipt=commitDocument(editor.doc);renderLibrary();if(active()===editor.doc)renderNotebookAction(editor.doc);
 syncUnsavedUnloadGuard();
 const result=await receipt;
 if(editor.savingSerial===serial)editor.pending=false;
 if(exactNoteEditor!==editor||!$('exact-note-dialog').open||editor.serial!==serial)return;
 $('exact-note-save').setAttribute('aria-disabled','false');
 const settledNote=exactNoteBaseline(editor.doc,editor.record.id);
 if(!exactNoteIdentity(editor)||!settledNote.present||settledNote.text!==text){status.textContent='摘录或笔记已更改，请保留当前文字并重新选择记录。';return;}
 status.textContent=result.ok?'已保存到本机':'保存未成功；已提交的笔记仍在本页。可重新保存或导出备份。';
 syncUnsavedUnloadGuard();
};
$('exact-note-export').onclick=()=>{
 const editor=exactNoteEditor;if(!editor)return;let url,link;
 try{
  // Rescue includes the visible draft, even when submission is blocked or stale.
  const text='所选文字摘录：\n'+editor.record.text+(bilingualExcerptDisplay(editor.record)?'\n\n'+bilingualExcerptDisplay(editor.record):'')+'\n\n我的笔记（当前编辑内容）：\n'+exactNoteText(editor);
  url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));link=el('a');link.href=url;link.download='coconut-excerpt-note.txt';link.hidden=true;$('exact-note-dialog').append(link);link.click();
  $('exact-note-status').textContent='已发起当前笔记下载，请打开文件确认。下载不会改变保存状态。';
 }catch{$('exact-note-status').textContent='笔记导出失败，文字仍在这里，可复制保留。';}
 finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);}
};
$('exact-note-backup').onclick=()=>{$('export-unsaved-documents').onclick();$('exact-note-status').textContent=$('notice').textContent;};

// Chapters are authored landmarks. Navigation stays transient and never starts media.
let chapterDirectoryDoc=null,chapterDirectoryCue=null,chapterDirectoryPage=0,chapterOpener=null,chapterEditor=null,chapterReturn=null,chapterLanding=null,chapterDirectoryPrecise=false;
const CHAPTER_PAGE_SIZE=20;
function chapterEligible(doc){return !!doc&&!Coconut.isReadingCollection(doc)&&!Coconut.isAudioProject(doc)&&doc.segments.length>0;}
function chapterCueNode(id,mode=readingMode){return [...document.querySelectorAll(mode==='passages'?'#passage-body .passage-original .passage-cue':'#transcript .segment')].find(node=>(mode==='passages'?node.dataset.cueId:node.dataset.segmentId)===id);}
// Display-only chapter orientation. One full-source index serves both mounted
// views; passage composition, original DOM children and AI/quotation scope stay
// untouched. Equal timestamps and empty cue IDs retain source-order identity.
function readingChapterIndex(doc){
 const entries=Coconut.readingChapters(doc).filter(entry=>entry.status==='current');
 const starts=new Map(entries.map((entry,index)=>[entry.cue.id,{...entry,number:index+1}]));
 const positions=new Map();if(entries.length)doc.segments.forEach((cue,index)=>positions.set(cue.id,index));
 return {starts,at(id){
  const position=positions.get(id);if(position===undefined)return null;
  let low=0,high=entries.length;while(low<high){const middle=(low+high)>>>1;if(entries[middle].index<=position)low=middle+1;else high=middle;}
  return low?starts.get(entries[low-1].cue.id):null;
 }};
}
function readingChapterLabel(entry,kind,id){
 const label=el('div','reading-chapter-label');label.dataset.chapterId=entry.item.id;label.dataset.chapterKind=kind;
 label.append(el('span','reading-chapter-kind',kind==='start'?'章节起点':'所在章节'));
 if(kind==='start'){
  label.id=id;label.append(el('span','reading-chapter-number',String(entry.number)));
 }
 label.append(el('strong','reading-chapter-title',entry.item.title));
 if(kind==='start')label.append(el('span','reading-chapter-location',Coconut.time(entry.cue.start)+' · 片段 '+(entry.index+1)));
 return label;
}
function clearReadingChapterCue(node){
 delete node.dataset.readingChapterMarker;
 const prior=node.dataset.readingChapterDescription;if(!prior)return;
 const descriptions=(node.getAttribute('aria-describedby')||'').split(/\s+/u).filter(id=>id&&id!==prior);
 if(descriptions.length)node.setAttribute('aria-describedby',descriptions.join(' '));else node.removeAttribute('aria-describedby');
 delete node.dataset.readingChapterDescription;
}
function renderReadingChapterMarkers(doc=active()){
 if(!doc||active()!==doc)return;
 const index=readingChapterIndex(doc);
 // Called only for a source render or an explicit chapter edit, never a save
 // receipt. Updating labels preserves cue/player objects, selections and focus.
 for(const host of [$('transcript'),$('passage-body')]){
  host.querySelectorAll('.reading-chapter-labels').forEach(node=>node.remove());
  host.querySelectorAll('[data-reading-chapter-description]').forEach(clearReadingChapterCue);
 }
 let previous=null,serial=0;
 for(const row of $('transcript').querySelectorAll('.segment')){
  const entry=index.at(row.dataset.segmentId),start=index.starts.get(row.dataset.segmentId);
  if(entry&&(start||entry!==previous)){
   const labels=el('div','reading-chapter-labels');labels.append(readingChapterLabel(entry,start?'start':'context','reading-chapter-transcript-'+(++serial)));
   row.querySelector('.segment-content').prepend(labels);
  }
  previous=entry;
 }
 let first=true;
 for(const section of $('passage-body').querySelectorAll('.passage')){
  const original=section.querySelector('.passage-original'),cues=[...original.querySelectorAll('.passage-cue')],labels=el('div','reading-chapter-labels');
  const initial=cues[0],context=initial&&index.at(initial.dataset.cueId);
  if(first&&context&&!index.starts.has(initial.dataset.cueId))labels.append(readingChapterLabel(context,'context'));
  first=false;
  for(const node of cues){
   const entry=index.starts.get(node.dataset.cueId);if(!entry)continue;
   const id='reading-chapter-passage-'+(++serial);labels.append(readingChapterLabel(entry,'start',id));
   node.dataset.readingChapterMarker=String(entry.number);node.dataset.readingChapterDescription=id;
   node.setAttribute('aria-describedby',[(node.getAttribute('aria-describedby')||''),id].filter(Boolean).join(' '));
  }
  if(labels.childElementCount)section.querySelector('.passage-columns').before(labels);
 }
}
function chapterDraft(){return !!chapterEditor&&($('chapter-title').value!==chapterEditor.initialTitle||$('chapter-cue-number').value!==chapterEditor.initialNumber);}
function chapterSaveStatus(){
 const doc=chapterDirectoryDoc;if(!doc)return;const status=libraryStore.status(doc.key),live=state.documents.includes(doc);
 $('chapter-save-status').dataset.state=!live?'missing':status?.identity===doc?status.status:'saved';
 $('chapter-save-status').textContent=!live?'本篇已不在书架，不能继续修改。':status?.identity===doc&&status.status!=='saved'?(status.status==='pending'?'章节正在保存…':'章节尚未保存，请重试或备份本篇。'):'本篇与章节已保存到本机浏览器。';
 $('chapter-retry').hidden=!live||!status||status.status==='saved'||status.status==='pending';
 $('chapter-backup').disabled=!live;
}
function renderChapterReturn(){
 if(chapterReturn?.doc!==active())chapterReturn=null;
 const bar=$('chapter-return');bar.hidden=!chapterReturn||workspace!=='read'||readingMode==='summary';
 if(!bar.hidden){const target=readingMode==='passages'?$('passage-workspace'):$('transcript-layout');if(bar.nextElementSibling!==target)target.before(bar);}
 $('open-source-correction').hidden=!active()?.segments.length;
 $('open-chapters').hidden=!chapterEligible(active());$('open-chapters').textContent='章节目录'+(active()?.reading_chapters?.length?'（'+active().reading_chapters.length+'）':'');
 syncReadingStickyStack();
}
function chapterPosition(){const doc=chapterDirectoryDoc;return doc?.segments.findIndex(cue=>cue.id===chapterDirectoryCue)??-1;}
function renderChapterDirectory(focusId=null){
 const doc=chapterDirectoryDoc,live=doc&&state.documents.includes(doc);const entries=live?Coconut.readingChapters(doc):[],valid=entries.filter(entry=>entry.status==='current'),position=chapterPosition();
 const current=valid.findLast(entry=>entry.index<=position),prior=current?valid[valid.indexOf(current)-1]:null,next=current?valid[valid.indexOf(current)+1]:valid[0];
 $('chapter-current').textContent=current?(chapterDirectoryPrecise?'最近定位章节：':'可见片段所在章节：')+current.item.title+(chapterDirectoryPrecise?'（上下章以此为基准）':''):valid.length?'当前片段位于第一章之前。':'还没有有效章节。';
 $('chapter-previous').disabled=!prior;$('chapter-next').disabled=!next;
 $('chapter-previous').onclick=()=>{if(prior)jumpReadingChapter(doc,prior.item);};$('chapter-next').onclick=()=>{if(next)jumpReadingChapter(doc,next.item);};
 $('chapter-add').disabled=!live||!chapterEligible(doc)||!contentIngressAllowed(doc);
 if(focusId!==null){const index=entries.findIndex(entry=>entry.item.id===focusId);if(index>=0)chapterDirectoryPage=Math.floor(index/CHAPTER_PAGE_SIZE);}
 chapterDirectoryPage=Math.max(0,Math.min(chapterDirectoryPage,Math.ceil(entries.length/CHAPTER_PAGE_SIZE)-1));
 const host=$('chapter-list');host.replaceChildren();
 for(const entry of entries.slice(chapterDirectoryPage*CHAPTER_PAGE_SIZE,(chapterDirectoryPage+1)*CHAPTER_PAGE_SIZE)){
  const {item,cue,status}=entry,row=el('li','chapter-entry');row.dataset.chapterId=item.id;
  row.append(el('strong','',item.title),el('p','hint',status==='current'?'片段 '+(entry.index+1)+' · '+Coconut.time(cue.start):'原起点片段已不存在；请显式重定位。'));
  for(const [kind,label] of [['open','阅读此章'],['rename','改名'],['relocate','重定位起点'],['remove','删除章节']]){
   const button=el('button','chapter-'+kind,label);button.type='button';button.setAttribute('aria-label',label+'：'+item.title);button.disabled=kind==='open'?status!=='current':!contentIngressAllowed(doc);
   button.onclick=()=>{if(!state.documents.includes(doc)||!doc.reading_chapters?.includes(item))return;
    if(kind==='open'){jumpReadingChapter(doc,item);return;}
    if(!contentIngressAllowed(doc))return;
    if(kind==='remove'){if(chapterEditor?.item===item&&chapterDraft()){$('chapter-save-status').textContent='此章节有未提交草稿，请先保存或取消修改。';return;}doc.reading_chapters=doc.reading_chapters.filter(chapter=>chapter!==item);queueDocument(doc);renderNotebookAction(doc);renderChapterReturn();renderReadingChapterMarkers(doc);renderChapterDirectory();$('chapter-add').focus({preventScroll:true});return;}
    openChapterEditor(doc,kind,cue,item,button);
   };row.append(button);
  }host.append(row);
 }
 $('chapter-list-previous').disabled=chapterDirectoryPage===0;$('chapter-list-next').disabled=(chapterDirectoryPage+1)*CHAPTER_PAGE_SIZE>=entries.length;
 chapterSaveStatus();
 if(focusId!==null)[...host.children].find(row=>row.dataset.chapterId===focusId)?.querySelector('.chapter-rename')?.focus({preventScroll:true});
}
function openChapterDirectory(){
 rememberReadingView();
 const doc=active();if(!chapterEligible(doc))return;chapterDirectoryDoc=doc;const landed=chapterLanding,landedNode=landed&&chapterCueNode(landed.cue.id,landed.mode);chapterDirectoryPrecise=!!landed&&landed.doc===doc&&landed.mode===readingMode&&doc.segments.includes(landed.cue)&&landedNode?.classList.contains('chapter-target');chapterDirectoryCue=chapterDirectoryPrecise?landed.cue.id:visibleReadingCue();chapterOpener=document.activeElement;chapterDirectoryPage=0;
 $('chapter-dialog').showModal();renderChapterDirectory();$('chapter-add').focus({preventScroll:true});
}
$('open-chapters').onclick=openChapterDirectory;
$('chapter-close').onclick=()=>{$('chapter-dialog').close();chapterOpener?.isConnected&&chapterOpener.focus({preventScroll:true});};
for(const [id,delta] of [['chapter-list-previous',-1],['chapter-list-next',1]])$(id).onclick=()=>{chapterDirectoryPage+=delta;renderChapterDirectory();$('chapter-list').querySelector('button')?.focus();};
$('chapter-add').onclick=()=>{const doc=chapterDirectoryDoc,cue=doc?.segments.find(cue=>cue.id===chapterDirectoryCue)||doc?.segments[0];if(cue)openChapterEditor(doc,'create',cue,null,$('chapter-add'));};
function chapterEditorPreview(){
 if(!chapterEditor)return;const {doc,mode}=chapterEditor,index=Number($('chapter-cue-number').value)-1,cue=Number.isInteger(index)?doc.segments[index]:null;
 chapterEditor.target=cue||null;
 $('chapter-cue-preview').textContent=cue?'片段 '+(index+1)+' · '+Coconut.time(cue.start)+'\n'+sourcePreview(cue,240):mode==='rename'?'原起点不存在；改名不会自动重新定位。':'请填写有效的完整稿片段序号。';
}
function openChapterEditor(doc,mode,cue,item=null,opener=document.activeElement){
 if(!chapterEligible(doc)||!contentIngressAllowed(doc))return;
 if(chapterDraft()){$('chapter-editor').showModal();$('chapter-editor-status').textContent='已有未提交的章节草稿，请先保存或取消修改。';$('chapter-title').focus();return;}
 const number=cue?String(doc.segments.indexOf(cue)+1):'';
 chapterEditor={doc,item,mode,opener,rawTitle:item?.title||'',initialTitle:item?.title||'',initialNumber:number,target:cue};
 $('chapter-editor-heading').textContent=(mode==='create'?'新建章节':mode==='rename'?'修改章节标题':'显式重定位章节起点')+' · '+doc.title;
 $('chapter-title').value=chapterEditor.initialTitle;chapterEditor.initialTitle=$('chapter-title').value;$('chapter-title').readOnly=mode==='relocate';
 $('chapter-cue-number').value=number;$('chapter-cue-number').max=String(doc.segments.length);$('chapter-cue-number').readOnly=mode==='rename';
 $('chapter-editor-status').textContent='';chapterEditorPreview();$('chapter-editor').showModal();$(mode==='relocate'?'chapter-cue-number':'chapter-title').focus();
}
$('chapter-cue-number').oninput=chapterEditorPreview;
function restoreChapterEditorFocus(editor){const opener=editor?.opener;if(opener?.isConnected){opener.focus({preventScroll:true});return;}if($('chapter-dialog').open){$('chapter-add').focus({preventScroll:true});return;}if(editor?.doc===active()){const node=chapterCueNode(editor.target?.id,'transcript');if(node){focusCueAction(node.querySelector('.chapter-create')||node);return;}}$('main-content').focus({preventScroll:true});}
function closeChapterEditor(){const editor=chapterEditor;$('chapter-editor').close();restoreChapterEditorFocus(editor);}
$('chapter-editor-close').onclick=closeChapterEditor;
$('chapter-editor').addEventListener('cancel',event=>{event.preventDefault();closeChapterEditor();});
$('chapter-dialog').addEventListener('cancel',event=>{event.preventDefault();$('chapter-close').onclick();});
$('chapter-cancel').onclick=()=>{const editor=chapterEditor;chapterEditor=null;$('chapter-editor').close();restoreChapterEditorFocus(editor);};
$('chapter-save').onclick=()=>{
 const editor=chapterEditor;if(!editor)return;const {doc,item,mode,target}=editor;
 if(!contentIngressAllowed(doc)||!state.documents.includes(doc)||item&&!doc.reading_chapters?.includes(item)){$('chapter-editor-status').textContent='本篇或章节已变化，请取消后重新打开。';return;}
 try{
  if(mode!=='rename'&&(!target||doc.segments[Number($('chapter-cue-number').value)-1]!==target))throw Error('起点片段已变化，请重新选择序号并核对原文。');
  const updated=mode==='create'?Coconut.createReadingChapter(doc,{id:crypto.randomUUID(),title:$('chapter-title').value,cueId:target.id}):Coconut.updateReadingChapter(doc,item.id,mode==='rename'?{title:$('chapter-title').value===editor.initialTitle?editor.rawTitle:$('chapter-title').value}:{cueId:target.id});
  doc.reading_chapters=Coconut.readingChaptersWith(doc,updated);queueDocument(doc);renderNotebookAction(doc);renderChapterReturn();renderReadingChapterMarkers(doc);chapterEditor=null;$('chapter-editor').close();
  if($('chapter-dialog').open){renderChapterDirectory(updated.id);}else restoreChapterEditorFocus(editor);
 }catch(error){$('chapter-editor-status').textContent='章节未保存：'+error.message;}
};
for(const id of ['chapter-dialog','chapter-editor'])$(id).addEventListener('keydown',event=>{
 const dialog=$(id);if(!dialog.open||event.key!=='Tab'||event.defaultPrevented||event.isComposing||event.keyCode===229||event.altKey||event.ctrlKey||event.metaKey||event.target.closest?.('dialog')!==dialog)return;
 const controls=[...dialog.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex]')].filter(node=>{
  if(node.tabIndex<0||node.matches(':disabled')||node.closest('[hidden],[inert]'))return false;
  for(let parent=node;parent&&parent!==dialog;parent=parent.parentElement){const style=getComputedStyle(parent);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return false;}return true;
 });
 const first=controls[0],last=controls.at(-1);if(first&&((event.shiftKey&&document.activeElement===first)||(!event.shiftKey&&document.activeElement===last))){event.preventDefault();(event.shiftKey?last:first).focus();}
});
$('chapter-retry').onclick=async()=>{await libraryStore.retry();chapterSaveStatus();};
$('chapter-backup').onclick=()=>{
 let url,link;try{const doc=chapterDirectoryDoc;if(!state.documents.includes(doc))return;const blob=new Blob([JSON.stringify({format:'coconut-library',version:1,documents:[doc],active:doc.key},null,2)],{type:'application/json'});url=URL.createObjectURL(blob);link=el('a');link.href=url;link.download='coconut-chapters.json';link.hidden=true;$('chapter-dialog').append(link);link.click();$('chapter-save-status').textContent='已发起本篇与章节备份下载，请确认文件已保存。不含未提交草稿，下载不改变保存状态；旧版本导入可能丢失章节，请用支持章节的版本恢复。'+backupRecoveryHint(blob);}
 catch{$('chapter-save-status').textContent='章节备份失败，内容仍在本页，请重试。';}finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);}
};
function jumpReadingChapter(doc,item){
 if(active()!==doc||!state.documents.includes(doc)||pendingStructuralDocuments.has(doc.key)||!doc.reading_chapters?.includes(item))return;
 const entry=Coconut.readingChapters(doc).find(entry=>entry.item===item);if(entry?.status!=='current')return;
 rememberReadingView();
 if(!chapterReturn||chapterReturn.doc!==doc){const cueId=chapterDirectoryCue??visibleReadingCue(),node=chapterCueNode(cueId);chapterReturn={doc,mode:readingMode,query:$('search').value,notesOnly,excerptsOnly,speakerFilter,pageStart,passageAnchor,passageReturn,readingContext,selected,searchFocusedId,cueId,viewportTop:node?.getBoundingClientRect().top,scrollY:window.scrollY};}
 $('chapter-dialog').close();$('reading-info').open=false;$('ai-consent').checked=false;clearReadingContext();$('search').value='';notesOnly=false;excerptsOnly=false;speakerFilter=null;selected=null;
 if(readingMode==='passages'){
  openPassage(entry.cue.id,false);
  // A chapter can start halfway through a composed passage. Locate its real
  // source span, not the passage heading or first cue.
  const node=chapterCueNode(entry.cue.id,'passages');if(node){
   node.tabIndex=-1;node.classList.add('chapter-target');renderChapterReturn();
   // The return bar wraps on narrow screens. Reserve its actual sticky height
   // before native scrolling so the exact source span and its ring stay visible.
   const bar=$('chapter-return'),style=getComputedStyle(node),barStyle=getComputedStyle(bar);
   const ring=(parseFloat(style.outlineWidth)||0)+Math.max(0,parseFloat(style.outlineOffset)||0);
   node.style.scrollMarginTop=Math.max(20,bar.getBoundingClientRect().height+Math.max(0,parseFloat(barStyle.top)||0)+ring+2)+'px';
   node.scrollIntoView?.({block:'start',behavior:'auto'});node.focus({preventScroll:true});
  }
 }else{goToSegment(entry.cue.id,true);chapterCueNode(entry.cue.id,'transcript')?.classList.add('chapter-target');}
 chapterDirectoryCue=entry.cue.id;chapterLanding={doc,cue:entry.cue,mode:readingMode};renderChapterReturn();
}
$('return-from-chapter').onclick=()=>{
 if(readingSearchSession?.chapterReturn===chapterReturn)endReadingSearch();
 const origin=chapterReturn,doc=active();chapterReturn=null;chapterLanding=null;document.querySelectorAll('.chapter-target').forEach(node=>node.classList.remove('chapter-target'));
 if(!origin||origin.doc!==doc){renderChapterReturn();return;}
 $('ai-consent').checked=false;$('search').value=origin.query;notesOnly=origin.notesOnly;excerptsOnly=origin.excerptsOnly;speakerFilter=origin.speakerFilter;pageStart=origin.pageStart;passageAnchor=origin.passageAnchor;passageReturn=origin.passageReturn;readingContext=origin.readingContext;readingMode=origin.mode;selected=origin.selected;searchFocusedId=origin.searchFocusedId;
 if(origin.mode==='transcript'){const matches=doc.segments.filter(cue=>matchesReadingSegment(cue,doc,origin.query.trim().toLocaleLowerCase()));const index=matches.findIndex(cue=>cue.id===origin.cueId);pageStart=index>=0&&(index<pageStart||index>=pageStart+PAGE_SIZE)?Math.floor(index/PAGE_SIZE)*PAGE_SIZE:Math.min(pageStart,Math.max(0,Math.floor((matches.length-1)/PAGE_SIZE)*PAGE_SIZE));}
 render();
 const node=chapterCueNode(origin.cueId,origin.mode);if(node){if(origin.mode==='passages')node.tabIndex=-1;if(Number.isFinite(origin.viewportTop))window.scrollBy(0,node.getBoundingClientRect().top-origin.viewportTop);node.focus({preventScroll:true});}else{window.scrollTo?.({top:origin.scrollY,behavior:'auto'});if(origin.mode==='passages')$('passage-body').focus({preventScroll:true});else focusReadingSearch();notice('原片段已不在当前视图；已恢复跳转前的阅读方式与筛选。');}
};
$('stay-at-chapter').onclick=()=>{if(readingSearchSession?.chapterReturn===chapterReturn)endReadingSearch();chapterReturn=null;renderChapterReturn();const node=chapterCueNode(chapterDirectoryCue);node?.focus({preventScroll:true});rememberReadingView({cueId:chapterDirectoryCue});};

// A collection is a saved work product, never the active transcript.
let collectionDocument=null,collectionPage=0;
const COLLECTION_PAGE_SIZE=20;
function collectionCurrent(){return collectionDocument&&state.documents.includes(collectionDocument)&&Coconut.isReadingCollection(collectionDocument)?collectionDocument:null;}
function collectionTitleDraft(){return $('collection-title').value!==(collectionDocument?.title||'');}
function collectionIdentity(item){return JSON.stringify([item.origin.documentKey,item.origin.type,item.origin.id]);}
function collectionStatus(){
 const doc=collectionCurrent(),status=doc?libraryStore.status(doc.key):null;
 const saved=!!doc&&(status?.identity===doc?status.status==='saved':!status&&loadedCollectionIdentities.has(doc));
 $('collection-status').dataset.state=saved?'saved':status?.identity===doc?status.status:'idle';
 $('collection-retry').hidden=!doc||saved||status?.status==='pending';
 if(doc)$('collection-status').textContent=pendingStructuralDocuments.has(doc.key)?'成果集正在处理，请稍候。':saved?'成果集已保存到本机浏览器。':status?.status==='pending'?'正在保存成果集…':'成果集尚未保存，请重试或导出当前快照保留。';
 for(const id of ['collection-backup','collection-delete'])$(id).disabled=!doc||pendingStructuralDocuments.has(doc.key);
 for(const id of ['collection-preview-button','collection-export'])$(id).disabled=!doc||!doc.items.length;
 for(const row of $('notebook-captures').children){
  const button=row.querySelector('.collection-add');if(!button)continue;
  button.hidden=!$('collection-tools').open||!doc;
  const source=state.documents.find(d=>d.key===row.dataset.documentKey);
  const added=doc?.items.some(item=>item.origin.documentKey===source?.key&&item.origin.type===row.dataset.captureType&&String(item.origin.id)===row.dataset.captureId);
  button.disabled=!doc||!contentIngressAllowed(doc)||!contentIngressAllowed(source);button.setAttribute('aria-disabled',String(!!added||button.disabled));button.textContent=added?'已加入成果集':'加入成果集';
 }
 for(const row of $('collection-items').children){const item=doc?.items.find(item=>item.id===row.dataset.itemId);if(item)row.querySelector('.collection-history').textContent=collectionHistory(item);}
}
function collectionHistory(item){
 const status=Coconut.readingCollectionItemState(item,state.documents).status;
 return '选取时快照 · '+({historical:'历史记录，未重新核对来源',current:'来源仍一致',changed:'来源已更新；保留选取时内容',missing:'本书架无此来源；保留选取时内容',ambiguous:'来源无法唯一确认；保留选取时内容'}[status]||'来源待核对')+(item.snapshot.exact_excerpt?' · 精确摘录选取时'+({current:'来源一致',stale:'来源已变化',missing:'原片段已移除'}[item.snapshot.history_status]||'状态待核对'):'');
}
function renderCollection({resetTitle=false,focusId=null,focusClass=null}={}){
 $('collection-preview').hidden=true;
 const doc=collectionCurrent(),select=$('collection-select');
 const blank=el('option','','新建成果集');blank.value='';select.replaceChildren(blank);
 for(const item of state.documents.filter(Coconut.isReadingCollection)){const option=el('option','',item.title);option.value=item.key;select.append(option);}
 select.value=doc?.key||'';
 if(resetTitle)$('collection-title').value=doc?.title||'';
 $('collection-save-title').textContent=doc?'保存名称':'创建成果集';
 const items=doc?.items||[];collectionPage=Math.max(0,Math.min(collectionPage,Math.ceil(items.length/COLLECTION_PAGE_SIZE)-1));
 $('collection-count').textContent=doc?`已精选 ${items.length} 条；仅导出这些记录，顺序如下。`: '先命名创建成果集，再从下方跨篇逐条加入。';
 const host=$('collection-items');host.replaceChildren();
 for(const item of items.slice(collectionPage*COLLECTION_PAGE_SIZE,(collectionPage+1)*COLLECTION_PAGE_SIZE)){
  const row=el('li','collection-item');row.dataset.itemId=item.id;
  const s=item.snapshot;row.append(el('strong','',s.title),el('p','hint',(s.start===null?'无时间位置':Coconut.time(s.start))+' · '+(s.source_url||s.source_label||'无外部链接')),el('p','collection-history hint',collectionHistory(item)));
  const detail=el('details');detail.append(el('summary','','查看所选记录'),el('p','',s.text||''));if(s.exact_excerpt){const bilingual=bilingualExcerptDisplay(s.exact_excerpt);if(bilingual)detail.append(el('p','collection-paired-translation',bilingual));}if(s.note)detail.append(el('p','','我的笔记：\n'+s.note));row.append(detail);
  for(const [kind,label,delta] of [['up','上移',-1],['down','下移',1],['remove','移出成果集',0]]){
   const button=el('button','collection-'+kind,label);button.type='button';button.setAttribute('aria-label',label+'：'+s.title);const index=items.indexOf(item);button.disabled=kind==='up'?index===0:kind==='down'?index===items.length-1:false;
   button.onclick=()=>{if(!contentIngressAllowed(doc)||collectionCurrent()!==doc||!doc.items.includes(item))return;
    const index=doc.items.indexOf(item),next=[...doc.items];if(delta&&(index+delta<0||index+delta>=next.length))return;if(delta){[next[index],next[index+delta]]=[next[index+delta],next[index]];}else next.splice(index,1);
    doc.items=next;queueDocument(doc);$('collection-preview').hidden=true;
    if(delta)collectionPage=Math.floor((index+delta)/COLLECTION_PAGE_SIZE);
    renderCollection({focusId:delta?item.id:next[Math.min(index,next.length-1)]?.id,focusClass:delta?'.collection-'+kind:'.collection-remove'});
    if(!next.length)$('collection-title').focus({preventScroll:true});
   };row.append(button);
  }host.append(row);
 }
 $('collection-previous').disabled=collectionPage===0;$('collection-next').disabled=(collectionPage+1)*COLLECTION_PAGE_SIZE>=items.length;
 collectionStatus();
 if(focusId){const row=[...host.children].find(row=>row.dataset.itemId===focusId),button=row?.querySelector(focusClass);(button&&!button.disabled?button:row?.querySelector('summary')||$('collection-title')).focus({preventScroll:true});}
}
function openCollection(doc){
 if(!$('library-notebook').open)openLibraryNotebook();collectionDocument=doc;collectionPage=0;$('collection-tools').open=true;renderCollection({resetTitle:true});$('collection-select').focus({preventScroll:true});
}
$('collection-tools').addEventListener('toggle',()=>{if($('collection-tools').open)renderCollection();collectionStatus();});
$('collection-select').onchange=()=>{
 if(collectionTitleDraft()){$('collection-select').value=collectionCurrent()?.key||'';$('collection-status').textContent='名称尚未提交，请先保存名称或取消名称修改。';return;}
 collectionDocument=state.documents.find(doc=>doc.key===$('collection-select').value&&Coconut.isReadingCollection(doc))||null;collectionPage=0;$('collection-preview').hidden=true;renderCollection({resetTitle:true});
};
$('collection-reset-title').onclick=()=>{$('collection-title').value=collectionCurrent()?.title||'';collectionStatus();};
$('collection-save-title').onclick=()=>{
 const title=$('collection-title').value.trim();if(!title){$('collection-status').textContent='请填写成果集名称。';$('collection-title').focus();return;}
 let doc=collectionCurrent();if(!contentIngressAllowed(doc)){$('collection-status').textContent='当前无法保存，请先处理书架保存问题。';return;}
 try{if(doc)doc.title=Coconut.createReadingCollection({...doc,title}).title;else{doc=Coconut.createReadingCollection({key:'collection-'+crypto.randomUUID(),title,items:[]});state.documents.push(doc);collectionDocument=doc;}queueDocument(doc);renderCollection({resetTitle:true});renderLibrary();}
 catch(error){$('collection-status').textContent='成果集未创建：'+error.message;}
};
$('collection-retry').onclick=async()=>{if(libraryStore.status().blocked){$('collection-status').textContent='书架存在保存冲突，请保留备份并处理保存提示。';return;}await libraryStore.retry();collectionStatus();};
for(const [id,delta] of [['collection-previous',-1],['collection-next',1]])$(id).onclick=()=>{collectionPage+=delta;renderCollection();$('collection-items').querySelector('summary')?.focus();};
$('collection-preview-button').onclick=()=>{const doc=collectionCurrent();if(!doc)return;$('collection-preview').textContent=Coconut.readingCollectionMarkdown(doc,state.documents);$('collection-preview').hidden=false;$('collection-preview').focus();};
$('collection-delete').onclick=()=>{const doc=collectionCurrent();if(!doc)return;if(collectionTitleDraft()){$('collection-status').textContent='请先保存名称或取消名称修改，再移除成果集。';return;}$('library-notebook').close();requestLibraryRemoval(doc);};
$('collection-backup').onclick=()=>{
 let url,link;try{const doc=collectionCurrent();if(!doc||pendingStructuralDocuments.has(doc.key))return;const backup={format:'coconut-library',version:1,documents:[doc],active:null},blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});url=URL.createObjectURL(blob);link=el('a');link.href=url;link.download='coconut-collection.json';link.hidden=true;$('library-notebook').append(link);link.click();$('collection-status').textContent='已发起此成果集备份下载，请确认文件已保存。只包含所选快照，不含来源文档；需支持成果集的版本恢复。'+backupRecoveryHint(blob);}
 catch{$('collection-status').textContent='成果集备份失败，快照仍在，请重试。';}finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);}
};
$('collection-export').onclick=()=>{
 let url,link;try{const doc=collectionCurrent();if(!doc)return;url=URL.createObjectURL(new Blob([Coconut.readingCollectionMarkdown(doc,state.documents)],{type:'text/markdown;charset=utf-8'}));link=el('a');link.href=url;link.download='coconut-collection.md';link.hidden=true;$('library-notebook').append(link);link.click();$('collection-status').textContent='已发起成果集 Markdown 下载，请确认文件已保存。下载不改变保存状态；完整恢复需支持成果集的版本；旧版不能打开含成果集的书架或备份。';}
 catch{$('collection-status').textContent='成果集下载失败，所选记录仍在，请重试。';}finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);}
};
function addCollectionCapture(capture,selection){
 const doc=collectionCurrent(),source=state.documents.find(item=>item.key===capture.documentKey);
 if(!doc||!contentIngressAllowed(doc)||!contentIngressAllowed(source)||!notebookSearch.isCurrent(selection)||!Coconut.libraryCaptureCurrent(capture,state.documents)){$('collection-status').textContent='记录来源已变化或正在保存处理，请重新选择。';return;}
 try{
  const item=Coconut.collectionItemFromCapture(capture,state.documents,{id:crypto.randomUUID(),createdAt:new Date().toISOString()});
  if(doc.items.some(existing=>collectionIdentity(existing)===collectionIdentity(item)))return;
  const validated=Coconut.createReadingCollection({...doc,items:[...doc.items,item]});
  doc.items=validated.items;queueDocument(doc);$('collection-preview').hidden=true;renderCollection();
 }catch(error){$('collection-status').textContent='未加入成果集：'+error.message;}
}

const notebookSelection=new Set();
let notebookPage=0,notebookReturn=null,notebookOpener=null,notebookRestore=null,notebookPainted=null;
let notebookSavedReveal=null,notebookSavedOrigin=null;
const notebookSearch=Coconut.createLibraryNotebookSearch({getDocuments:()=>state.documents,getRevision:()=>notebookContentRevision,
 onChange:()=>{if($('library-notebook').open)renderLibraryNotebook();else notebookSearch.cancel();}});
const NOTEBOOK_PAGE_SIZE=30;
function pruneNotebookSelection(){
 const keys=new Set(state.documents.map(doc=>doc.key));for(const key of notebookSelection)if(!keys.has(key))notebookSelection.delete(key);
}
function renderLibraryNotebook(){
 const selection=notebookSearch.request($('notebook-search').value,$('notebook-kind').value),host=$('notebook-captures');
 pruneNotebookSelection();host.setAttribute('aria-busy',String(selection.pending));
 if(selection.pending){
  notebookPainted=null;host.replaceChildren();$('notebook-status').textContent='正在查找笔记与摘录…';
  $('notebook-previous').disabled=true;$('notebook-next').disabled=true;syncNotebookSelection();return;
 }
 let savedReveal=notebookSavedReveal;
 if(savedReveal&&(!librarySearch.isCurrent(savedReveal.selection)||!Coconut.librarySavedHitCurrent(savedReveal.hit,state.documents)||pendingStructuralDocuments.has(savedReveal.doc.key))){
  notebookSavedReveal=null;savedReveal=null;
  $('notebook-status').textContent='这条已存摘录已变动，请从更新后的书架重新选择。';renderLibrary();return;
 }
 const captures=selection.captures,savedIndex=savedReveal?selection.indexes.get(savedReveal.hit.captureKey)??-1:-1;
 if(savedReveal&&savedIndex<0){notebookSavedReveal=null;$('notebook-status').textContent='这条已存摘录已变动，请从更新后的书架重新选择。';renderLibrary();return;}
 const returnIndex=notebookRestore?selection.indexes.get(notebookRestore.key)??-1:-1;
 if(savedIndex>=0)notebookPage=Math.floor(savedIndex/NOTEBOOK_PAGE_SIZE);
 if(returnIndex>=0)notebookPage=Math.floor(returnIndex/NOTEBOOK_PAGE_SIZE);
 notebookPage=Math.min(notebookPage,Math.max(0,Math.ceil(captures.length/NOTEBOOK_PAGE_SIZE)-1));
 if(notebookPainted?.selection===selection&&notebookPainted.page===notebookPage&&!notebookRestore&&!savedReveal){syncNotebookSelection();return;}
 notebookPainted={selection,page:notebookPage};
 const start=notebookPage*NOTEBOOK_PAGE_SIZE;host.replaceChildren();
 $('notebook-status').textContent=captures.length?`${start+1}–${Math.min(start+NOTEBOOK_PAGE_SIZE,captures.length)} / ${captures.length} 条记录`:'没有匹配的记录。阅读时摘录原话或记下笔记后，会在这里出现。';
 $('notebook-previous').disabled=notebookPage===0;$('notebook-next').disabled=start+NOTEBOOK_PAGE_SIZE>=captures.length;
 const pageCaptures=captures.slice(start,start+NOTEBOOK_PAGE_SIZE),exactGroups=new Map();
 for(const capture of pageCaptures)if(capture.type==='exact-excerpt'){
  if(!exactGroups.has(capture.documentKey))exactGroups.set(capture.documentKey,{ids:new Set()});
  exactGroups.get(capture.documentKey).ids.add(capture.id);
 }
 // One ephemeral current-source index per document/page; never cache through edits.
 for(const [key,group] of exactGroups){
  const doc=state.documents.find(doc=>doc.key===key),records=doc.exact_excerpts.filter(record=>group.ids.has(record.id));
  group.records=new Map(records.map(record=>[record.id,record]));group.states=Coconut.exactExcerptStateBatch(records,doc);
 }
 for(const capture of pageCaptures){
  const doc=state.documents.find(doc=>doc.key===capture.documentKey),row=el('li','notebook-capture');row.dataset.captureKey=capture.key;row.dataset.captureId=capture.id;row.dataset.captureType=capture.type;row.dataset.documentKey=doc.key;
  const label=el('label'),check=el('input');check.type='checkbox';check.checked=notebookSelection.has(doc.key);check.setAttribute('aria-label','选择篇目 '+doc.title);check.onchange=()=>{check.checked?notebookSelection.add(doc.key):notebookSelection.delete(doc.key);syncNotebookSelection();};label.append(check,document.createTextNode(doc.title));row.append(label);
  const collect=el('button','collection-add','加入成果集');collect.type='button';collect.hidden=true;collect.onclick=()=>addCollectionCapture(capture,selection);row.append(collect);
  row.append(el('p','hint',(capture.type==='cue'?(capture.excerpt?'整段摘录':'片段')+(Coconut.hasNoteContent(capture.note)?' · 笔记':''):capture.type==='exact-excerpt'?'所选文字摘录 · 历史快照':capture.type==='project-note'?'项目笔记':'时间书签')+(capture.time===null?'':' · '+Coconut.time(capture.time))));
  const details=el('details','notebook-details'),summary=el('summary','','查看完整记录与来源');details.append(summary);
  const visibleNote=capture.type==='exact-excerpt'&&!Coconut.hasNoteContent(capture.note)?'':capture.note;
  const previewText=visibleNote?'我的笔记：'+visibleNote:capture.text;
  let previewEnd=Math.min(360,previewText.length);if(previewEnd<previewText.length&&/[\uD800-\uDBFF]/.test(previewText[previewEnd-1])&&/[\uDC00-\uDFFF]/.test(previewText[previewEnd]))previewEnd--;
  const preview=previewText?el('p','notebook-preview',previewText.slice(0,previewEnd)+(previewEnd<previewText.length?'…':'')):null;if(preview)row.append(preview);
  details.addEventListener('toggle',()=>{if(preview)preview.hidden=details.open;if(!details.open&&details.contains(document.activeElement)&&document.activeElement!==summary)summary.focus({preventScroll:true});});
  if(capture.text)details.append(el('p','notebook-content notebook-quote',capture.text));
  if(visibleNote)details.append(el('p','notebook-content notebook-note','我的笔记：\n'+visibleNote));
  const technical=el('details','notebook-technical');technical.append(el('summary','','技术信息'),el('p','hint','文档标识：'+doc.key+'\n记录类型：'+capture.type+'\n记录标识：'+capture.id));
  if(capture.type!=='exact-excerpt')details.append(el('p','hint',doc.local_media_source?'本地媒体：'+doc.local_media_source.name:(doc.source_url||doc.podcast_source?.media_url||'未关联原站链接；可打开原位置核对。')));
  if(capture.type==='cue'){
   const cue=doc.segments.find(cue=>cue.id===capture.id),translation=cue.translations?.[doc.translation_view];
   if(translation)details.append(el('p','notebook-content',Coconut.translationCurrent(cue,doc,translation)?'译文（'+doc.translation_view+'；'+(translation.provider==='user'?'用户自己写的译文':translation.manual_review?'用户已核对':'机器生成，需核对')+'）：\n'+translation.text:'译文已过期，请在原文中核对。'));
   if(cue.original_text!==undefined&&cue.original_text!==cue.text)details.append(el('p','notebook-content','修正前文字稿：\n'+cue.original_text));
  }
  const exact=capture.type==='exact-excerpt'?exactGroups.get(doc.key)?.records.get(capture.id):null;
  const exactState=exact?exactGroups.get(doc.key).states.get(exact.id):null,freshness=exactState?.freshness;
  if(exact&&freshness!=='current')row.append(el('p','hint',freshness==='missing'?'原位置已删除；保留摘录时快照':'原文或出处已变化；保留摘录时快照'));
  if(exact){
   const bilingual=bilingualExcerptDisplay(exact);if(bilingual){details.append(el('p','notebook-content notebook-paired-translation',bilingual));row.append(el('p','hint','双语摘录 · 独立选区与用户配对确认'));}
   const edit=el('button','notebook-edit-exact-note',Coconut.hasNoteContent(Coconut.exactExcerptNote(doc,exact.id))?'编辑我的笔记':'添加我的笔记');edit.type='button';edit.onclick=()=>openExactNote(doc,exact,edit);details.append(edit);
   let populated=false;
   details.addEventListener('toggle',()=>{
    if(!details.open||populated)return;populated=true;
    const parts=Coconut.exactExcerptParts(exact),quote={text:exact.text,parts,start:parts[0].cue.start,end:Math.max(...parts.map(part=>part.cue.end))};
    const attribution=CoconutQuotation.attributionDetails(Coconut.exactExcerptSource(exact),quote,Coconut),metadata=el('dl','notebook-metadata');
    for(const [label,value] of [['摘录时篇目',attribution.title],['原文时间',attribution.range+(attribution.corrected?' · 已修正文字稿':'')],['出处',attribution.location],['摘录时间',exact.created_at]])metadata.append(el('dt','',label),el('dd','',value));
    details.insertBefore(metadata,technical);
    const history=el('details','notebook-history');history.append(el('summary','','摘录时上下文与修正记录'));details.insertBefore(history,technical);
    let historyPopulated=false;history.addEventListener('toggle',()=>{
    if(!history.open){if(history.contains(document.activeElement)&&document.activeElement!==history.firstElementChild)history.firstElementChild.focus({preventScroll:true});return;}if(historyPopulated)return;historyPopulated=true;
    // Historical context is opt-in and bounded per click, including a giant single cue.
    const context=el('p','notebook-content','摘录时上下文：\n'),more=el('button','notebook-more-context','显示更多摘录时上下文');more.type='button';
    const pieces=exact.snapshot.cues.flatMap((cue,i)=>i?[exact.snapshot.separators[i-1],cue.text]:[cue.text]);
    for(const cue of exact.snapshot.cues)if(cue.original_text!==undefined&&cue.original_text!==cue.text)pieces.push('\n摘录时保留的修正前文字稿：\n',cue.original_text);
    let piece=0,offset=0;
    const appendContext=()=>{
     let budget=8000;
     while(piece<pieces.length&&budget>0){
      const text=pieces[piece];if(offset===text.length){piece++;offset=0;continue;}let end=Math.min(text.length,offset+budget);
      if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1])&&/[\uDC00-\uDFFF]/.test(text[end]))end--;
      if(end===offset)break;
      context.append(document.createTextNode(text.slice(offset,end)));budget-=end-offset;offset=end;
      if(offset===text.length){piece++;offset=0;}
     }
     if(piece>=pieces.length){more.textContent='摘录时上下文已完整显示';more.setAttribute('aria-disabled','true');more.hidden=document.activeElement!==more;}
    };
    more.onclick=appendContext;more.addEventListener('focusout',()=>{if(piece>=pieces.length)more.hidden=true;});history.append(context,more);appendContext();
    });
   });
  }
  details.append(technical);
  const open=el('button','notebook-open',exact&&freshness==='stale'?'查看当前对应原文':'打开原位置');
  if(exact&&!exactState.cueId){open.disabled=true;open.textContent=freshness==='missing'?'原位置已删除':'原位置无法确认';}
  open.type='button';open.onclick=()=>{
   if(!$('library-notebook').open)return;
   const sourceCurrent=Coconut.libraryCaptureCurrent(capture,state.documents),exactLocation=exact?Coconut.exactExcerptState(exact,doc).cueId:null;
   if(!notebookSearch.isCurrent(selection)||pendingStructuralDocuments.has(doc.key)||!sourceCurrent||(exact&&!exactLocation)){notebookSearch.cancel();renderLibraryNotebook();$('notebook-status').textContent='这条记录的来源已变动，请从更新后的笔记本重新选择。';$('notebook-search').focus();return;}
   notebookSavedReveal=null;notebookSavedOrigin=null;
   notebookReturn={key:capture.key,page:notebookPage,scroll:$('library-notebook').scrollTop};notebookSearch.cancel();$('library-notebook').close();
   markDocumentOpened(doc);resetReaderForDocumentNavigation();selectActiveDocument(doc.key);setReadingMode('transcript');showWorkspace('read');render();
   openLibraryHit(exact?{kind:'text',id:exactLocation}:{kind:capture.type==='cue'?(Coconut.hasNoteContent(capture.note)?'note':'text'):capture.type,id:capture.id});
   $('return-library-notebook').hidden=false;
  };row.append(details,open);
  if(exact){
   row.append(savedExcerptCopy(exact,()=>$('library-notebook').open&&state.documents.includes(doc)&&doc.exact_excerpts?.includes(exact)).host);
   const remove=el('button','notebook-remove','移除所选摘录');remove.type='button';
   remove.onclick=()=>{
    if(!$('library-notebook').open||!contentIngressAllowed(doc)||!doc.exact_excerpts?.includes(exact)||!Coconut.libraryCaptureCurrent(capture,state.documents)||!notebookSearch.isCurrent(selection))return;
    const removal=Coconut.exactExcerptRemoval(doc,exact.id);
    for(const field of ['exact_excerpts','exact_excerpt_notes']){if(removal[field]===undefined)delete doc[field];else doc[field]=removal[field];}
    queueDocument(doc);
    // Focus moves only for this explicit removal, never for a later save receipt.
    $('notebook-search').focus({preventScroll:true});renderLibrary();if(active()===doc){renderNotebookAction(doc);refreshReadingExcerpts(doc);}renderLibraryNotebook();
   };row.append(remove);
  }
  host.append(row);
 }
 syncNotebookSelection();
 if(savedReveal){
  notebookSavedReveal=null;
  const row=[...host.children].find(row=>row.dataset.captureKey===savedReveal.hit.captureKey),details=row?.querySelector('.notebook-details');
  if(details){details.open=true;details.dispatchEvent(new Event('toggle'));}
  if(savedReveal.focusOwned&&document.activeElement===$('notebook-search')){details?.querySelector('summary')?.focus({preventScroll:true});row?.scrollIntoView?.({block:'nearest',behavior:'auto'});}
 }
 if(notebookRestore){
  const restore=notebookRestore;notebookRestore=null;
  const row=[...host.children].find(row=>row.dataset.captureKey===restore.key);
  // Completion may arrive after the user has moved focus; never reclaim it.
  if(restore.focusOwned&&document.activeElement===$('notebook-search')){
   (row?.querySelector('.notebook-open')||$('notebook-search')).focus({preventScroll:true});
   $('library-notebook').scrollTop=notebookPage===restore.page?restore.scroll:0;row?.scrollIntoView?.({block:'nearest',behavior:'auto'});
  }
 }
}
function syncNotebookSelection(){
 collectionStatus();
 for(const row of $('notebook-captures').children){const key=JSON.parse(row.dataset.captureKey)[0];row.querySelector('input').checked=notebookSelection.has(key);}
 $('notebook-export-scope').textContent='已选 '+notebookSelection.size+' 篇；导出所选篇目的全部记录（包括当前搜索未显示的记录）。';
 $('notebook-export').disabled=notebookSelection.size===0;
}
function openLibraryNotebook(returning=false){
 notebookSavedReveal=null;notebookSavedOrigin=null;notebookOpener=document.activeElement;notebookRestore=null;
 $('library-notebook').showModal();$('notebook-search').focus({preventScroll:true});
 if(collectionDocument&&!collectionCurrent()){collectionDocument=null;renderCollection({resetTitle:true});}else renderCollection();
 notebookRestore=returning&&notebookReturn?{...notebookReturn,focusOwned:true}:null;renderLibraryNotebook();
}
$('open-library-notebook').onclick=()=>openLibraryNotebook();
$('return-library-notebook').onclick=()=>openLibraryNotebook(true);
// Leaving the initial return focus relinquishes its intent permanently; coming
// back to the search box later is a new user choice, not permission to jump.
function openSavedLibraryHit(hit,doc,selection,opener){
 if(!opener.isConnected||!librarySearch.isCurrent(selection)||pendingStructuralDocuments.has(doc.key)||!state.documents.includes(doc)||(hit&&!Coconut.librarySavedHitCurrent(hit,state.documents))){
  renderLibrary();notice('这条已存摘录已变动，请从更新后的书架重新选择。');return;
 }
 notebookSavedReveal=null;notebookRestore=null;notebookReturn=null;notebookOpener=opener;
 const fromWorkspace=$('library-search-dialog').open;
 if(fromWorkspace){rememberLibraryWorkspace(doc,hit,opener);closeLibraryWorkspace('notebook');}
 notebookSavedOrigin={node:opener,doc,hitId:hit?.id,workspace:fromWorkspace,session:libraryWorkspaceSession};
 $('notebook-search').value=$('library-search').value.trim();$('notebook-kind').value='all';notebookPage=0;
 $('library-notebook').showModal();$('notebook-search').focus({preventScroll:true});
 if(hit)notebookSavedReveal={hit,doc,selection,focusOwned:true};
 renderLibraryNotebook();
}
function restoreSavedLibraryFocus(){
 const origin=notebookSavedOrigin;notebookSavedOrigin=null;if(!origin)return false;
 if(origin.workspace){
  if(origin.session!==libraryWorkspaceSession||document.querySelector('dialog[open]'))return true;
  openLibraryWorkspace({restore:true});return true;
 }
 const card=libraryCards.get(origin.doc.key),same=card?.doc===origin.doc;
 const replacement=same&&origin.hitId?[...(card.savedHits?.querySelectorAll('.library-saved-hit')||[])].find(node=>node.dataset.hitId===origin.hitId):null;
 const target=origin.node.isConnected&&!origin.node.disabled?origin.node:replacement|| (same?card.open:null);
 (target&&!target.disabled&&!$('library').hidden?target:$('library-search')).focus({preventScroll:true});return true;
}
$('notebook-search').addEventListener('focusout',()=>{if(notebookRestore)notebookRestore.focusOwned=false;if(notebookSavedReveal)notebookSavedReveal.focusOwned=false;});
$('library-notebook').addEventListener('close',()=>{if(!$('library-notebook').open){notebookSearch.cancel();notebookRestore=null;notebookSavedReveal=null;restoreSavedLibraryFocus();}});
$('notebook-close').onclick=()=>{notebookSearch.cancel();notebookRestore=null;notebookSavedReveal=null;$('library-notebook').close();if(!restoreSavedLibraryFocus())notebookOpener?.focus?.();};
for(const id of ['notebook-search','notebook-kind'])$(id)[id==='notebook-search'?'oninput':'onchange']=()=>{notebookSavedReveal=null;notebookRestore=null;notebookPage=0;renderLibraryNotebook();};
for(const [id,delta] of [['notebook-previous',-1],['notebook-next',1]])$(id).onclick=()=>{notebookSavedReveal=null;notebookRestore=null;notebookPage+=delta;renderLibraryNotebook();$('notebook-captures').querySelector('.notebook-open')?.focus();};
$('notebook-clear-selection').onclick=()=>{notebookSelection.clear();syncNotebookSelection();};
$('notebook-export').onclick=()=>{
 let url,link;
 try{
  pruneNotebookSelection();syncNotebookSelection();if(!notebookSelection.size)return;
  if([...notebookSelection].some(key=>pendingStructuralDocuments.has(key))){$('notebook-status').textContent='所选篇目的来源正在变动，请稍后重新导出。';return;}
  url=URL.createObjectURL(new Blob([Coconut.libraryNotebookMarkdown(state.documents,notebookSelection)],{type:'text/markdown;charset=utf-8'}));
  link=el('a');link.href=url;link.download='coconut-library.notes.md';link.hidden=true;document.body.append(link);link.click();
  notice('已发起所选篇目全部记录的 Markdown 下载，请检查下载记录。完整恢复仍需 JSON 备份。','success');
 }catch{notice('笔记本下载失败，请重试或使用书架备份。');}finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),1000);}
};
function openLibraryHit(hit) {
 if(hit.kind==='text'||hit.kind==='note'||hit.kind==='translation'){
  if(hit.kind==='translation'){const doc=active();if(!contentIngressAllowed(doc))return;recordReadingDisplaySelection(doc);doc.translation_view=hit.language;queueDocument(doc);libraryTranslationReveal={doc,hit};}
  goToSegment(hit.id,true);
  if(hit.kind==='translation'){
   const row=[...$('transcript').querySelectorAll('.segment')].find(row=>row.dataset.segmentId===hit.id);
   scrollReadingTarget(row?.querySelector('.translation mark'),{block:'center',behavior:'auto'});
  }
  if(hit.kind==='note'){
   const row=[...$('transcript').querySelectorAll('.segment')].find(row=>row.dataset.segmentId===hit.id);
   row?.querySelector('.note-button')?.click();
  }
 }else{
  setReadingMode('transcript');
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
 if(target&&$('transcript-reading-tools').contains(target))revealTranscriptTools();
 const disclosure=target?.closest(".cue-more");
 if(disclosure&&target.tagName!=='SUMMARY')disclosure.open=true;
 // Replacing the transcript can move the browser's scroll anchor to another
 // cue. Keep the acted-on short cue at its pre-render viewport position.
 const row=target?.closest('.segment');
 if(row&&viewportTop!==null)window.scrollBy(0,row.getBoundingClientRect().top-viewportTop);
 target?.focus({preventScroll:true});
}
// Keep source-player setup independent from transcript/editor rendering.
function renderSourceMedia(doc){
 const audioOnly=Coconut.isAudioProject(doc);
	const attachment = browserMedia.get(doc.key);
 renderRememberedMedia(doc,attachment);queueMicrotask(()=>queueRememberedMedia(doc));
 const mediaPath = attachment?.url || (mediaWorkerReady && Coconut.media ? Coconut.media(doc.source_media) : "");
 const mediaKind = attachment?.kind || doc.source_media?.kind;
 $("detach-reader-media").hidden = !attachment;
 const linkedTranscript=canAssociateLocalMedia(doc)&&Boolean(doc.local_media_source);
 $("replace-reader-media").hidden=$("unlink-reader-media").hidden=!linkedTranscript;
 $('attach-reader-media').textContent=doc.local_media_source?'重新选择原音视频':'选择对应的音频或视频';
 $("reader-media-status").textContent = attachment ? attachment.name + (attachment.nativeToken?" · 已从这台电脑载入原文件，不上传；未自动播放":window.coconutLocalMedia?" · 文件只在本次页面读取，不上传；可选择在这台电脑记住":" · 文件只在此页面读取，不上传；刷新后需重新选择")+(doc.local_media_source?"。关联仅按文件信息与部分内容核对，未完整核验。":"") : doc.local_media_source?'请重新选择「'+doc.local_media_source.name+'」继续回听。文件关联信息随项目保存；未保存媒体文件，未自动播放。笔记与时间书签仍保留。':"在浏览器中打开文件，不上传。请选与文字稿对应的原文件；刷新页面后需重新选择。";
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
   if(attachment?.nativeToken){const entry=rememberedMediaStates.get(doc);if(entry){entry.status='unavailable';renderRememberedMedia(doc);}}
   if(attachment){$('reader-media-status').textContent='浏览器无法解码「'+attachment.name+'」。请重新选择可播放的原文件；笔记、书签与文字稿仍保留。'+(canAssociateLocalMedia(doc)&&doc.local_media_source?'转换后的文件可用“更换关联文件”明确换绑。':'转换后的文件请从「打开本地音视频」另建项目。');notice($('reader-media-status').textContent);}
   else notice('原始媒体暂时无法播放。请确认此文字稿对应的本地任务仍在这台电脑上。');
  };
		mediaHost.replaceChildren(player);
		mediaHost.hidden = false;
	}
	$("locate-playback").hidden = !mediaPath||audioOnly;
 updatePlaybackControls();
 return {mediaPath,mediaHost};
}
function refreshRecoveredJobMedia(doc){
 if(active()!==doc||workspace!=='read'||!doc.source_media||!mediaWorkerReady||browserMedia.has(doc.key)||$('source-media').querySelector('audio,video'))return;
 // A late result may make the current book playable, but never expand panels,
 // replace a selected local file, rerender a draft, seek, or start playback.
 const {mediaPath}=renderSourceMedia(doc);
 if(mediaPath&&$('episode-media').hidden)setReaderMediaLabel('本地原声已就绪 · 打开回听','原声');
 passagePlayback?.sync();refreshPlaybackDock();
}
function render({keepNoteEditor=false,reuseLibraryMetadata=false}={}) {
 $('reader-workspace').inert=!!active()&&pendingStructuralDocuments.has(active().key);
 // All supported source changes render. Invalidate conservatively even when
 // the same array was edited in place; regular media events reuse the index.
 playbackIndex=null;
 const focusedCueAction=document.activeElement?.closest('.cue-more');
 const cueFocus=focusedCueAction?{key:focusedCueAction.dataset.cueKey,selector:document.activeElement.tagName==='SUMMARY'?'summary':'.'+document.activeElement.className}:null;
	const doc = active();
 readingViewOwner=doc||null;
 readingExcerptControls=[];const excerptIndex=doc&&!Coconut.isAudioProject(doc)?readingExcerptIndex(doc):null;
 if(readingExcerptDialog&&readingExcerptDialog.doc===doc)for(const row of readingExcerptDialog.rows)row.source=excerptIndex?.states.get(row.record.id)||row.source;
 refreshReadingExcerptSaveState();
 renderReadingContext();renderChapterReturn();
	renderLibrary(null,{reuseMetadata:reuseLibraryMetadata});
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
 const {mediaPath,mediaHost}=renderSourceMedia(doc);
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
 renderTranscript(doc,excerptIndex,{keepNoteEditor});
 renderSummary();
 renderPassages(doc,excerptIndex);
 applyReadingMode();
 pauseBoundedForCompactNote();
 if(cueFocus){
  const disclosure=[...document.querySelectorAll('.cue-more')].find(node=>node.dataset.cueKey===cueFocus.key);
  focusCueAction(disclosure?.querySelector(cueFocus.selector));
 }
	highlightPlayback();
	window.dispatchEvent(new Event("coconut-render"));
}
// Display-only updates do not touch the media owner or the live note/IME editor.
function renderTranscript(doc,excerptIndex,{keepNoteEditor=false,displayOnly=false}={}){
 readingExcerptControls=readingExcerptControls.filter(entry=>entry.mode!=='transcript'&&entry.button.isConnected);
 const mediaHost=$("source-media"),mediaPath=mediaHost.querySelector("audio,video")?.getAttribute("src")||"",isDemo=doc.provenance?.kind==='authored_demo';
 const openCueActions=new Set([...document.querySelectorAll(".cue-more[open]")].map(node=>node.dataset.cueKey));
 const hasReadingFilter=!!$('search').value.trim()||notesOnly||excerptsOnly||speakerFilter!==null;
 const speakers=[...new Set(doc.segments.map(s=>s.speaker||''))];
 if(speakerFilter!==null&&!speakers.includes(speakerFilter))speakerFilter=null;
 const selector=$('speaker-filter');selector.replaceChildren(el('option','','全部说话人'));selector.firstChild.value='all';
 for(const speaker of speakers){const option=el('option','',speaker||'未标注说话人');option.value=JSON.stringify(speaker);selector.append(option);}
 selector.value=speakerFilter===null?'all':JSON.stringify(speakerFilter);$('speaker-filter-control').hidden=speakers.length<2;
	const query = $("search").value.trim().toLocaleLowerCase();
	const filtered = doc.segments.filter(s=>matchesReadingSegment(s,doc,query));
 const searchMatches=query?Coconut.searchDocument(doc,query):null;
 const translationReveal=!query&&libraryTranslationReveal?.doc===doc&&doc.translation_view===libraryTranslationReveal.hit.language&&Coconut.libraryTranslationHitCurrent(libraryTranslationReveal.hit,state.documents)?libraryTranslationReveal.hit:null;
	// Clamp after removing the last matching note/excerpt on a later page.
	pageStart = Math.min(pageStart, Math.max(0, Math.floor((filtered.length - 1) / PAGE_SIZE) * PAGE_SIZE));
	const visible = filtered.slice(pageStart, pageStart + PAGE_SIZE);
 if(!query || !filtered.some(s=>s.id===searchFocusedId))searchFocusedId=null;
 $("search-navigation").hidden=!query;
 $("previous-match").disabled=!filtered.length;$("next-match").disabled=!filtered.length;
 $("match-position").textContent=(searchFocusedId?filtered.findIndex(s=>s.id===searchFocusedId)+1:0)+" / "+filtered.length+" 个匹配片段";
	if(!displayOnly){
	const currentNote = visible.find((segment) => segment.id === selected) || (keepNoteEditor && doc.segments.find(segment=>segment.id===selected));
	if (!currentNote) selected = null;
	$("notes-panel").hidden = !selected;
	if (currentNote) {
		$("quote").textContent = currentNote.text;
		$("note-time").textContent = Coconut.time(currentNote.start) + " 的想法";
		if($("note").value !== (doc.notes[currentNote.id] || "")) $("note").value = doc.notes[currentNote.id] || "";
	}
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
 $("resume").title="回到手动标记的位置；普通重新打开会记住上次浏览的位置。";
	$("resume").onclick = () => {if(bookmark){markDocumentOpened(doc);goToSegment(bookmark.id);}};
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
		let speakerCorrection=null;
  if(s.speaker){
   speakerCorrection=el('button','speaker-correction-button','修正说话人标签');
   speakerCorrection.type='button';speakerCorrection.setAttribute('aria-label','修正说话人标签：'+s.speaker);
   speakerCorrection.title='修正说话人标签';speakerCorrection.onclick=()=>openSpeakerCorrection(doc,s,row);
   // Keep the reading label at its original line height. The 44px editing
   // action belongs after the source, alongside the other cue actions.
   body.append(highlightedText('p','speaker',s.speaker,query));
  }
		body.className="segment-content";
  const parallel=el("div","parallel-text");
  parallel.append(highlightedText("p", "words", s.text, query, searchMatches?.byCue.get(s.id)?.text||[]));
        if(translated) parallel.append(highlightedText("p", "translation"+(!Coconut.translationCurrent(s,doc,translated)?" stale":""), Coconut.translationCurrent(s,doc,translated) ? (translated.text.trim()?translated.text:"暂无译文") : "原文或上下文已变化，或旧译文缺少上下文记录，可核对／修正此译文或重新生成", query||(translationReveal?.id===s.id?'translation match':''), translationReveal?.id===s.id?[translationReveal.firstRange]:searchMatches?.byCue.get(s.id)?.translations[doc.translation_view]||[]));
  const textHit=searchMatches?.byCue.get(s.id)?.phrases.text;
  if(textHit?.cueCount>1)body.append(phrasePreview(textHit));
  for(const [language,ranges] of Object.entries(searchMatches?.byCue.get(s.id)?.translations||{})){
   const hit=searchMatches.byCue.get(s.id).phrases['translation:'+language]||searchMatches.previews.get('translation:'+language+':'+s.id),hidden=language!==doc.translation_view;
   if(hit?.cueCount>1||hidden){
    const preview=phrasePreview(hit||{field:'translation',language,id:s.id,ids:[s.id],snippet:CoconutPassages.rangeSnippet(s.translations[language].text,ranges[0].start,ranges[0].end)});
    if(hidden){const reveal=el('button','phrase-show-translation','查看'+translationLabel(language)+'译文');reveal.type='button';reveal.onclick=()=>{if(active()!==doc||!contentIngressAllowed(doc))return;recordReadingDisplaySelection(doc);doc.translation_view=language;queueDocument(doc);render();[...$('transcript').querySelectorAll('.segment')].find(row=>row.dataset.segmentId===s.id)?.focus({preventScroll:true});};preview.append(reveal);}
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
  if(speakerCorrection&&!compact)body.append(speakerCorrection);
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
  const chapter=el('button','chapter-create','设为章节起点');chapter.type='button';chapter.onclick=()=>openChapterEditor(doc,'create',s,null,chapter);
  if(!compact)body.append(chapter);
  if(compact){
   const actions=el('div','cue-actions');
   const more=el('details','cue-more');more.dataset.cueKey=JSON.stringify([doc.key,s.id]);
   const summary=el('summary','',[repeating?.id===s.id?'循环中':'',s.saved_excerpt===true?'已摘录':'','更多'].filter(Boolean).join(' · '));
   summary.dataset.cueTime=Coconut.time(s.start);
   const repeat=meta.querySelector('.repeat-button');
   summary.setAttribute('aria-label',summary.dataset.cueTime+' · '+summary.textContent+'：修正、摘录、阅读位置'+(repeat?'与循环回听':''));
   more.append(summary,edit,excerptButton,bookmarkButton,chapter);
   if(speakerCorrection)more.append(speakerCorrection);
   if(reviewTranslation)more.append(reviewTranslation);
   if(repeat)more.append(repeat);
   more.open=openCueActions.has(more.dataset.cueKey);
   actions.append(button);if(contextButton)actions.append(contextButton);actions.append(more);body.append(actions);
  }
		if (Coconut.hasNoteContent(doc.notes[s.id])) body.append(highlightedText("p", "saved-note", doc.notes[s.id], query));
  body.append(readingExcerptControl(doc,[s],'transcript',excerptIndex));
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
}
function changeReadingPage(direction) {
	pageStart = Math.max(0, pageStart + direction * PAGE_SIZE);
	selected = null;
	render();
	// Replacing a page removes its controls: move focus into the new content
	// rather than dropping keyboard users back to the top of the document.
	const row = $("transcript").querySelector(".segment");
	scrollReadingTarget(row,{block:"start"});
	row?.focus({preventScroll: true});
 rememberReadingView({cueId:row?.dataset.segmentId});
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
  if(demoToolsExpanded)focusReadingSearch();else $('toggle-demo-tools').focus();
 };
 $('demo-note').onclick=()=>{const id=active()?.segments[0]?.id;if(!id)return;goToSegment(id);$('transcript').querySelector('.note-button')?.click();};
 $('reading-jump').onchange=()=>{const id=$('reading-jump').value;if(id)goToSegment(id);};
$("back-reading").onclick = () => {markDocumentOpened(active());showWorkspace("read");renderLibrary();};
$("show-jobs").onclick = () => { showWorkspace("add"); $("jobs-heading").scrollIntoView?.(); };
$("toggle-library").onclick = toggleLibraryBrowsing;
$("library-search").oninput = event=>{if(!librarySearchComposing&&!librarySearchPointer&&!librarySearchCancelledComposition&&(!event||document.activeElement===$("library-search")))openLibraryWorkspace();renderLibrary();};
$("library-kind").onchange=renderLibrary;
$("library-scope").onchange=renderLibrary;
try{const order=localStorage.getItem('coconut-library-sort-v1');if(['added','opened','title','duration'].includes(order))$('library-sort').value=order;}catch{}
$('library-sort').onchange=()=>{renderLibrary();try{localStorage.setItem('coconut-library-sort-v1',$('library-sort').value);}catch{notice('本次排序已应用，但浏览器未保存偏好。');}};

$('speaker-filter').onchange=()=>{clearReadingContext(true);speakerFilter=$('speaker-filter').value==='all'?null:JSON.parse($('speaker-filter').value);pageStart=0;searchFocusedId=null;render();};
$("filter-all").onclick = () => { clearReadingContext(true); notesOnly = false; excerptsOnly = false; speakerFilter=null; pageStart = 0; render(); };
$("filter-excerpts").onclick = () => { clearReadingContext(true); excerptsOnly = true; notesOnly = false; pageStart = 0; render(); };
$("filter-notes").onclick = () => { clearReadingContext(true); notesOnly = true; excerptsOnly = false; pageStart = 0; render(); };
$("clear-search").onclick = () => {
 const origin=ownedReadingSearch(),cue=readingSearchTarget()||(readingSearchAnchor(origin).valid?origin.cue:null);
 clearReadingFiltersAt(cue);
};
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
// Chromium may leave an already-visible control's border at the scrollport
// edge after reverse Tab; CSS scroll-margin does not include its focus ring.
// Let native focus/Tab finish, then correct only this dialog's own scroll.
for(const id of ['paste-subtitle-dialog','source-correction-dialog'])$(id).addEventListener('focusin',event=>{
 const dialog=$(id),target=event.target;
 if(target.closest?.('dialog')!==dialog||!target.matches('button,input,select,textarea,summary'))return;
 requestAnimationFrame(()=>{
  if(!dialog.open||document.activeElement!==target||target.closest('dialog')!==dialog)return;
  const focusStyle=getComputedStyle(target),ring=(parseFloat(focusStyle.outlineWidth)||0)+Math.max(0,parseFloat(focusStyle.outlineOffset)||0);
  if(!ring||focusStyle.outlineStyle==='none')return;
  const rect=target.getBoundingClientRect(),box=dialog.getBoundingClientRect(),style=getComputedStyle(dialog);
  if(!rect.width||!rect.height)return;
  const top=Math.max(0,box.top+dialog.clientTop)+Math.max(ring+2,parseFloat(style.scrollPaddingTop)||0);
  const bottom=Math.min(innerHeight,box.top+dialog.clientTop+dialog.clientHeight)-Math.max(ring+2,parseFloat(style.scrollPaddingBottom)||0);
  if(rect.top<top)dialog.scrollTop+=Math.floor(rect.top-top);
  else if(rect.bottom>bottom)dialog.scrollTop+=Math.ceil(rect.bottom-bottom);
 });
});
function pastedSubtitleHasDraft(){return !!($('paste-subtitle-text').value||$('paste-subtitle-title').value);}
function invalidatePastedSubtitlePreview(message='内容已改变，请重新预览字幕。'){
 pasteSubtitleRevision++;pasteSubtitlePreview=null;pasteSubtitleAttempt=null;pasteSubtitleReceipt=null;
 $('paste-subtitle-preview').replaceChildren();$('paste-subtitle-diagnostics').replaceChildren();
 $('confirm-paste-subtitle').disabled=true;$('paste-subtitle-status').textContent=message;
 renderPastedSubtitleRecovery();if(unloadGuardReady)syncUnsavedUnloadGuard();
}
function retirePastedSubtitleImport(){
 pasteSubtitleAttempt=null;pasteSubtitlePreview=null;pasteSubtitleTarget=null;
 $('confirm-paste-subtitle').disabled=true;
 $('paste-subtitle-preview').replaceChildren();$('paste-subtitle-diagnostics').replaceChildren();
 if($('paste-subtitle-dialog').open)$('paste-subtitle-dialog').close();
}
function pastedSubtitleReceiptCurrent(){
 const receipt=pasteSubtitleReceipt;
 return receipt?.revision===pasteSubtitleRevision&&state.documents.includes(receipt.identity)&&!pendingStructuralDocuments.has(receipt.identity.key)?receipt:null;
}
function renderPastedSubtitleRecovery(){
 const receipt=pastedSubtitleReceiptCurrent(),saved=receipt&&libraryStore.status(receipt.identity.key),complete=saved?.identity===receipt?.identity&&saved?.status==='saved';
 for(const id of ['retry-paste-subtitle','read-paste-subtitle','export-paste-subtitle','paste-subtitle-recovery-help'])$(id).hidden=!receipt;
 $('retry-paste-subtitle').hidden=!receipt||complete;
 $('retry-paste-subtitle').disabled=!!pasteSubtitleAttempt||libraryStore.status().blocked||libraryStore.status().status==='pending';
 $('read-paste-subtitle').textContent=complete?'阅读已保存内容':'在本页阅读';
 $('paste-subtitle-recovery-help').textContent=complete?'已解析的全文已保存到本机。原始粘贴草稿仍在上方，可继续修改后重新预览。':'已解析的全文仍在本页，尚未保存到本机。请重试或导出完整 JSON 救援，确认下载成功后再关闭页面。原始粘贴草稿仍在上方。';
}
function pastedSubtitleTargetCurrent(target){
 return !!target&&active()===target.document&&workspace==='read'&&state.documents.includes(target.document)&&Coconut.isAudioProject(target.document)&&contentIngressAllowed(target.document)&&projectSourceSnapshot(target.document)===target.source&&mediaSelectionRevision(target.key)===target.mediaRevision&&activeSelectionRevision===target.selection&&localImportRevision===target.importRevision;
}
function openPastedSubtitles(project=null){
 if(!contentIngressAllowed(project)){notice('暂时无法导入，请先处理当前保存或恢复操作。');return;}
 if(project&&(!Coconut.isAudioProject(project)||active()!==project||workspace!=='read'))return;
 cancelLocalImports('paste-subtitle');
 pasteSubtitleTarget=project?{key:project.key,document:project,source:projectSourceSnapshot(project),mediaRevision:mediaSelectionRevision(project.key),selection:activeSelectionRevision,importRevision:localImportRevision}:null;
 // The text draft is shared between explicit entry points; its destination and
 // preview never are. A recovery receipt cannot silently change this choice.
 if(pasteSubtitleReceipt&&(!!pasteSubtitleReceipt.project!==!!project||project&&pasteSubtitleReceipt.identity!==project))pasteSubtitleReceipt=null;
 $('paste-subtitle-title').hidden=!!project;$('paste-subtitle-title-label').hidden=!!project;
 $('paste-subtitle-destination').textContent=project?'附加到原声项目「'+project.title+'」。保留项目标题、笔记、时间书签和原声；不会另建文稿。':'保存为独立文字稿；不会附加到现有原声项目。';
 $('confirm-paste-subtitle').textContent=project?'附加到此项目':'开始阅读';
 $('paste-subtitle-status').textContent=pastedSubtitleHasDraft()?'本页草稿已保留，请重新预览并确认目标。':'粘贴后预览，确认片段、时间和目标。';
 renderPastedSubtitleRecovery();$('paste-subtitle-dialog').showModal();$('paste-subtitle-text').focus();
}
$('paste-subtitles').onclick=()=>openPastedSubtitles();
$('paste-project-subtitles').onclick=()=>openPastedSubtitles(active());
for(const id of ['paste-subtitle-title','paste-subtitle-text'])$(id).addEventListener('input',()=>invalidatePastedSubtitlePreview());
$('paste-subtitle-format').addEventListener('change',()=>invalidatePastedSubtitlePreview());
$('clear-paste-subtitle').onclick=()=>{
 $('paste-subtitle-title').value='';$('paste-subtitle-text').value='';$('paste-subtitle-format').value='auto';
 invalidatePastedSubtitlePreview('草稿已清空；已提交的文稿仍保留在书架。');$('paste-subtitle-text').focus();
};
function dismissPastedSubtitle(event){
 if(event?.type==='close'&&$('paste-subtitle-dialog').open)return;
 const project=pasteSubtitleTarget?.document;
 event?.preventDefault();cancelLocalImports();
 if(project&&active()===project&&workspace==='read'&&Coconut.isAudioProject(project))$('paste-project-subtitles').focus({preventScroll:true});
 else if(workspace==='add')$('paste-subtitles').focus({preventScroll:true});
}
$('close-paste-subtitle').onclick=dismissPastedSubtitle;
$('paste-subtitle-dialog').addEventListener('cancel',dismissPastedSubtitle);
$('paste-subtitle-dialog').addEventListener('close',event=>{
 // close events may be queued by an older dialog instance or navigation.
 if($('paste-subtitle-dialog').open)return;
 pasteSubtitleAttempt=null;pasteSubtitlePreview=null;$('confirm-paste-subtitle').disabled=true;
});
function pastedSubtitleTime(seconds){return Coconut.time(seconds)+'.'+String(Math.round(seconds*1000)%1000).padStart(3,'0');}
$('preview-paste-subtitle').onclick=()=>{
 if(!$('paste-subtitle-dialog').open||pasteSubtitleAttempt)return;
 pasteSubtitlePreview=null;$('confirm-paste-subtitle').disabled=true;
 $('paste-subtitle-preview').replaceChildren();$('paste-subtitle-diagnostics').replaceChildren();
 try{
  if(pasteSubtitleTarget&&!pastedSubtitleTargetCurrent(pasteSubtitleTarget))throw new Error('目标项目已经切换或更新，请关闭后从目标项目重新打开；草稿仍保留');
  const parsed=Coconut.parsePastedSubtitles($('paste-subtitle-text').value,{title:pasteSubtitleTarget?'':$('paste-subtitle-title').value,format:$('paste-subtitle-format').value});
  const cues=parsed.document.segments,start=cues[0].start,end=cues.reduce((value,cue)=>Math.max(value,cue.end),0);
  pasteSubtitlePreview={...parsed,revision:pasteSubtitleRevision};
  $('paste-subtitle-status').textContent='识别为 '+parsed.format.toUpperCase()+' · '+cues.length+' 段 · '+pastedSubtitleTime(start)+'–'+pastedSubtitleTime(end)+' · '+backupSize(parsed.bytes)+'。'+(parsed.diagnostics.length?'部分字幕未导入：跳过 '+parsed.diagnostics.length+' 个字幕块，请检查下方行号。':'可识别字幕已解析，请核对原文。')+' 下方显示前 '+Math.min(3,cues.length)+' 段；'+(pasteSubtitleTarget?'确认后附加到上方项目。':'确认后开始阅读。');
  for(const cue of cues.slice(0,3)){
   const item=el('li'),when=el('strong','',pastedSubtitleTime(cue.start)+'–'+pastedSubtitleTime(cue.end)+(cue.speaker?' · '+cue.speaker:''));
   item.append(when,el('p','',cue.text.length>1000?cue.text.slice(0,999).replace(/[\uD800-\uDBFF]$/,'')+'…（本段预览截短，导入保留全文）':cue.text));$('paste-subtitle-preview').append(item);
  }
  setTranscriptImportDiagnostics({row:$('paste-subtitle-diagnostics')},parsed.diagnostics);
  $('confirm-paste-subtitle').disabled=false;
 }catch(error){$('paste-subtitle-status').textContent='无法预览：'+localFileError(error);}
};
function finishPastedSubtitleReading(receipt,{clear=false}={}){
 if(!state.documents.includes(receipt.identity)||pendingStructuralDocuments.has(receipt.identity.key))return;
 if(clear){$('paste-subtitle-title').value='';$('paste-subtitle-text').value='';$('paste-subtitle-format').value='auto';invalidatePastedSubtitlePreview('字幕已保存。');}
 retirePastedSubtitleImport();
 // Attachment already rendered the same project's source. Do not run document
 // navigation again: it would reset the manual player and listening context.
 if(!receipt.project||active()!==receipt.identity||workspace!=='read')openTranscriptImportResult(receipt);
 $('title').focus({preventScroll:true});
 if(receipt.ok)notice(receipt.project?'字幕已附加到此项目并保存，原声、项目笔记和时间书签保留。':receipt.duplicate?'书架已有这份字幕，已打开原稿并保留笔记。':'字幕已保存在本机，可以开始阅读。','success');
 else notice('字幕仍仅在本页，尚未保存。关闭前请重试或导出完整 JSON 备份。');
 if(unloadGuardReady)syncUnsavedUnloadGuard();
}
$('confirm-paste-subtitle').onclick=async()=>{
 const preview=pasteSubtitlePreview;
 if(!$('paste-subtitle-dialog').open||pasteSubtitleAttempt||!preview||preview.revision!==pasteSubtitleRevision||!contentIngressAllowed())return;
 const target=pasteSubtitleTarget;
 if(target&&!pastedSubtitleTargetCurrent(target)){invalidatePastedSubtitlePreview('目标项目已经切换或更新，请关闭后从目标项目重新打开；草稿仍保留。');return;}
 const owner={revision:pasteSubtitleRevision,importRevision:localImportRevision,selection:activeSelectionRevision,document:state.active,workspace};pasteSubtitleAttempt=owner;
 const owned=()=>pasteSubtitleAttempt===owner&&owner.revision===pasteSubtitleRevision&&owner.importRevision===localImportRevision&&owner.selection===activeSelectionRevision&&owner.document===state.active&&owner.workspace===workspace&&$('paste-subtitle-dialog').open&&(!target||mediaSelectionRevision(target.key)===target.mediaRevision);
 const batch=createTranscriptImportBatch([{name:preview.document.title+'.'+preview.format}]),item=batch.items[0];
 setTranscriptImportDiagnostics(item,preview.diagnostics);item.status='saving';renderTranscriptImportBatch(batch);
 $('confirm-paste-subtitle').disabled=true;$('paste-subtitle-status').textContent='正在保存字幕；保存回执确认后进入阅读。';renderPastedSubtitleRecovery();
 try{
  const receipt=target?{...await attachTranscriptToProject(preview.document,target,{canCommit:()=>owned()&&pastedSubtitleTargetCurrent(target)}),project:true}:await add(preview.document,()=>owned()&&contentIngressAllowed(),false,documentLifecycleRevision,undefined,{activate:false});
  finishTranscriptImportReceipt(item,receipt);batch.finished=true;
  if(!owned()||!state.documents.includes(receipt.identity)||target&&(active()!==receipt.identity||projectSourceSnapshot(receipt.identity)!==target.source))return;
  pasteSubtitleAttempt=null;
  if(receipt.ok){finishPastedSubtitleReading(receipt,{clear:true});return;}
  pasteSubtitleReceipt={...receipt,revision:pasteSubtitleRevision};
  $('paste-subtitle-status').textContent='字幕已解析，但保存未成功。草稿和完整文稿仍在本页，请重试或导出救援备份。';
  renderPastedSubtitleRecovery();
 }catch(error){
  item.status=owned()?'failed':'cancelled';if(owned()){item.error=localFileError(error);pasteSubtitleAttempt=null;$('paste-subtitle-status').textContent='导入失败：'+item.error+'。草稿仍在本页，请重新预览后重试。';pasteSubtitlePreview=null;}
 }finally{if(pasteSubtitleAttempt===owner){pasteSubtitleAttempt=null;if($('paste-subtitle-dialog').open)$('paste-subtitle-status').textContent='当前阅读已变化，未自动切换。草稿仍在本页，请重新预览或查看书架。';}batch.finished=true;renderTranscriptImportBatch(batch);if(unloadGuardReady)syncUnsavedUnloadGuard();}
};
$('retry-paste-subtitle').onclick=async()=>{
 const receipt=pastedSubtitleReceiptCurrent();if(!receipt||pasteSubtitleAttempt||libraryStore.status().blocked||libraryStore.status().status==='pending')return;
 const owner={revision:pasteSubtitleRevision,importRevision:localImportRevision,selection:activeSelectionRevision,document:state.active,workspace,mediaRevision:mediaSelectionRevision(receipt.identity.key)};pasteSubtitleAttempt=owner;renderPastedSubtitleRecovery();
 await libraryStore.retry(receipt.identity.key);
 if(pasteSubtitleAttempt!==owner||owner.revision!==pasteSubtitleRevision||owner.importRevision!==localImportRevision||owner.selection!==activeSelectionRevision||owner.document!==state.active||owner.workspace!==workspace||!$('paste-subtitle-dialog').open||receipt.project&&(active()!==receipt.identity||owner.mediaRevision!==mediaSelectionRevision(receipt.identity.key))){if(pasteSubtitleAttempt===owner){pasteSubtitleAttempt=null;renderPastedSubtitleRecovery();if($('paste-subtitle-dialog').open){const saved=libraryStore.status(receipt.identity.key);$('paste-subtitle-status').textContent=saved?.identity===receipt.identity&&saved.status==='saved'?'字幕已保存；当前阅读未切换，草稿仍在本页。可阅读已保存内容或重新预览。':'保存未成功；当前阅读未切换，草稿仍在本页，请重试或导出救援。';}}return;}
 pasteSubtitleAttempt=null;const saved=libraryStore.status(receipt.identity.key);
 if(saved?.identity===receipt.identity&&saved.status==='saved')finishPastedSubtitleReading({...receipt,ok:true},{clear:true});
 else {$('paste-subtitle-status').textContent='保存仍未成功，请保留本页草稿并导出完整 JSON 救援。';renderPastedSubtitleRecovery();}
};
$('read-paste-subtitle').onclick=()=>{const receipt=pastedSubtitleReceiptCurrent();if(receipt){const saved=libraryStore.status(receipt.identity.key),ok=saved?.identity===receipt.identity&&saved.status==='saved';finishPastedSubtitleReading({...receipt,ok},{clear:ok});}};
$('export-paste-subtitle').onclick=()=>{const receipt=pastedSubtitleReceiptCurrent();if(receipt){exportReaderDocument(receipt.identity);$('paste-subtitle-status').textContent=$('notice').textContent;}};
window.addEventListener('coconut-persistence-change',()=>{if($('paste-subtitle-dialog').open)renderPastedSubtitleRecovery();});
$("import").onclick = () => $("file").click();
$("file").onchange = () => selectTranscriptFiles(Array.from($("file").files),true);
function resetTranscriptDropTarget(){
 transcriptDragDepth=0;$('transcript-drop-target').classList.remove('is-file-drag');
}
function isTranscriptFileDrag(event){
 return Array.from(event.dataTransfer?.types||[]).includes('Files');
}
const transcriptDropTarget=$('transcript-drop-target');
transcriptDropTarget.ondragenter=event=>{
 if(!isTranscriptFileDrag(event))return;
 event.preventDefault();transcriptDragDepth++;
 transcriptDropTarget.classList.add('is-file-drag');
};
transcriptDropTarget.ondragover=event=>{
 if(!isTranscriptFileDrag(event))return;
 event.preventDefault();event.dataTransfer.dropEffect=contentIngressAllowed()?'copy':'none';
};
transcriptDropTarget.ondragleave=event=>{
 if(!isTranscriptFileDrag(event))return;
 // Moving between children can leave before the matching enter. A related
 // target inside the owned region must not clear its highlight.
 transcriptDragDepth=Math.max(0,transcriptDragDepth-1);
 if(event.relatedTarget?.nodeType&&transcriptDropTarget.contains(event.relatedTarget))return;
 if(!transcriptDragDepth||event.relatedTarget)resetTranscriptDropTarget();
};
transcriptDropTarget.ondrop=event=>{
 if(!isTranscriptFileDrag(event))return;
 event.preventDefault();resetTranscriptDropTarget();
 let directories;
 try{directories=Array.from(event.dataTransfer.items||[]).filter(item=>item.kind==='file').map(item=>item.webkitGetAsEntry?.()).filter(entry=>entry?.isDirectory);}
 catch{$('transcript-drop-status').textContent='未导入任何文件。无法检查拖放内容，请使用「导入文字稿」选择文件。';return;}
 if(directories.length){$('transcript-drop-status').textContent='未导入任何文件。请拖放文字稿文件，不支持文件夹：'+directories.map(entry=>entry.name).join('、');return;}
 return selectTranscriptFiles(Array.from(event.dataTransfer.files||[]));
};
async function selectTranscriptFiles(files,fromPicker=false){
 const f=files[0];
 if(!f)return;
 // Both picker and drop share admission and the exact same receipt pipeline.
 // Reject unsupported selections before retiring an existing import or reading.
 const unsupported=files.filter(file=>! /\.(json|srt|vtt)$/i.test(file.name));
 if(unsupported.length){if(fromPicker)$('file').value='';$('transcript-drop-status').textContent='未导入任何文件。仅支持 JSON、SRT、VTT；请移除：'+unsupported.map(file=>file.name).join('、');return;}
 if(!contentIngressAllowed()){if(fromPicker)$('file').value='';$('transcript-drop-status').textContent='暂时无法导入，请等待当前保存、恢复或关闭操作完成后重试。';return;}
 $('transcript-drop-status').textContent='';
 if(files.length>1)return importTranscriptFiles(files);
 const revision = cancelLocalImports("file"), lifecycleRevision=documentLifecycleRevision;
 transcriptImportBatch=null;$("transcript-import-results").hidden=true;
 let warningBatch=null;
 const startingDocument = state.active, startingWorkspace = workspace;
 const ownsRequest = () => revision === localImportRevision;
 const canCommit = () => contentIngressAllowed() && ownsRequest() && state.active === startingDocument && workspace === startingWorkspace;
	try {
  const review=localFileReview(f,canCommit);
  if(review!==true&&!(await review))return;
  if(!canCommit())return;
		const text = await readTranscriptFile(f,canCommit);
  if(text===null)return;
  if(!canCommit())return;
		const {document:parsed,diagnostics}=Coconut.parseWithDiagnostics(text,f.name);
  if(diagnostics.length){warningBatch=createTranscriptImportBatch([f]);setTranscriptImportDiagnostics(warningBatch.items[0],diagnostics);warningBatch.items[0].status='saving';renderTranscriptImportBatch(warningBatch);}
  // Exported JSON carries a stable key which validate intentionally omits.
  // Retain it only as async ownership evidence, never as an imported new key.
  let sourceKey;try{const raw=JSON.parse(text);if(typeof raw?.key==='string'&&raw.key.length<=200)sourceKey=raw.key;}catch{}
  const saved = await add(parsed,canCommit,false,lifecycleRevision,sourceKey);
		if(warningBatch)finishTranscriptImportReceipt(warningBatch.items[0],saved);
  if(ownsRequest()&&active()===saved.identity){
   if(diagnostics.length)notice((saved.ok?"已保存可识别的字幕。":"字幕仅在本页，尚未保存。")+transcriptImportWarningNotice(diagnostics));
   else if(saved.ok)notice("已导入并保存在本机浏览器。没有向服务器上传文件。", "success");
  }
	} catch (e) {
		if(warningBatch){const item=warningBatch.items[0];item.status=canCommit()?'failed':'cancelled';if(item.status==='failed')item.error=localFileError(e);}
  if(canCommit())notice("导入失败：" + localFileError(e));
	} finally {
  if(warningBatch){warningBatch.finished=true;renderTranscriptImportBatch(warningBatch);}
		if(ownsRequest())$("file").value = "";
	}
};
// Parse completeness belongs to the import attempt, never to the document or
// its content hash. Save receipts update only persistence state.
function transcriptImportWarningNotice(diagnostics){
 return '部分字幕未导入：跳过 '+diagnostics.length+' 个字幕块。可在「添加内容」的导入结果查看原文件行号。';
}
function setTranscriptImportDiagnostics(item,diagnostics){
 item.diagnostics=diagnostics;
 item.row.dataset.parseState=diagnostics.length?'partial':'complete';
 if(!diagnostics.length)return;
 const details=el('details','transcript-import-warning'),summary=el('summary','', '部分字幕未导入 · 跳过 '+diagnostics.length+' 个字幕块');
 const list=el('ul'),more=el('button','','显示更多行号');more.type='button';
 let rendered=0;
 const append=()=>{
  const end=Math.min(rendered+50,diagnostics.length);
  for(;rendered<end;rendered++){
   const diagnostic=diagnostics[rendered],range=diagnostic.startLine===diagnostic.endLine?String(diagnostic.startLine):diagnostic.startLine+'–'+diagnostic.endLine;
   const reason=diagnostic.category==='empty_cue'?'没有可导入的文字':'时间行无法识别';
   list.append(el('li','','第 '+range+' 行'+(diagnostic.cueId?' · 字幕 '+diagnostic.cueId:'')+' · '+reason+(diagnostic.preview?'：'+diagnostic.preview:'')));
  }
  more.hidden=rendered===diagnostics.length;
 };
 details.ontoggle=()=>{if(details.open&&!rendered)append();};more.onclick=append;
 details.append(summary,list,more);item.row.append(details);
}
function createTranscriptImportBatch(files){
 const batch={items:[],cancelled:false,finished:false};transcriptImportBatch=batch;
 $('transcript-import-list').replaceChildren();$('transcript-import-results').hidden=false;
 for(const file of files){
  const row=el('li','transcript-import-item'),result=el('span','transcript-import-outcome'),open=el('button','','阅读');open.type='button';
  const item={status:'queued',row,result,open,identity:null,diagnostics:[]};open.hidden=true;open.onclick=()=>openTranscriptImportResult(item);
  open.setAttribute('aria-label','阅读 '+file.name);row.append(el('span','transcript-import-name',file.name),result,open);
  batch.items.push(item);$('transcript-import-list').append(row);
 }
 $('stop-transcript-import').onclick=()=>{if(transcriptImportBatch===batch)cancelLocalImports();};
 return batch;
}
function finishTranscriptImportReceipt(item,receipt){
 item.identity=receipt.identity;item.duplicate=receipt.duplicate;
 item.status=receipt.ok?(receipt.duplicate?'duplicate':'saved'):'unsaved';
}
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
 const labels={queued:'等待导入',review:'等待确认大文件',encoding:'等待选择字幕编码',reading:'读取中',saving:'校验并保存中',saved:'已保存',duplicate:'书架已有，未重复添加',unsaved:'仅在本页，尚未保存。请重试保存或导出备份',failed:'导入失败',skipped:'已跳过，未导入',cancelled:'未导入，已停止'};
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
 const pending=(counts.review||0)+(counts.encoding||0)+(counts.reading||0)+(counts.saving||0),done=batch.items.length-(counts.queued||0)-pending;
 const parts=[batch.finished?(batch.cancelled?'已停止导入':'导入完成'):batch.cancelled?'已停止后续文件，等待当前文件确认':'正在导入',done+' / '+batch.items.length+' 个文件'];
 for(const [status,label] of [['saved','已保存'],['duplicate','已有'],['failed','失败'],['skipped','跳过'],['unsaved','未保存'],['cancelled','未导入']])if(counts[status])parts.push(label+' '+counts[status]);
 const warnings=batch.items.reduce((count,item)=>count+(item.diagnostics?.length||0),0);
 if(warnings)parts.push('部分字幕未导入 '+warnings+' 块');
 $('transcript-import-progress').textContent=parts.join(' · ');
 $('stop-transcript-import').hidden=batch.finished||batch.cancelled||batch.cancellable===false;
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
 markDocumentOpened(doc);resetReaderForDocumentNavigation();selectActiveDocument(doc.key);
 setReadingMode(defaultReadingMode(doc));
 $('toggle-library').setAttribute('aria-expanded','false');showWorkspace('read');render();
 resumeOpenedDocument(doc,'reader-workspace');
}
async function importTranscriptFiles(files){
 const revision=cancelLocalImports('file'),lifecycleRevision=documentLifecycleRevision;
 const startingDocument=state.active,startingWorkspace=workspace,selectionRevision=activeSelectionRevision;
 const ownsRequest=()=>revision===localImportRevision;
 const batch=createTranscriptImportBatch(files);
 const canCommit=()=>!batch.cancelled&&ownsRequest()&&contentIngressAllowed()&&state.active===startingDocument&&workspace===startingWorkspace&&activeSelectionRevision===selectionRevision;
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
    const text=await readTranscriptFile(file,canCommit,{batch,item});if(!canCommit()){item.status='cancelled';break;}
    if(text===null){item.status='skipped';renderTranscriptImportBatch(batch);continue;}
    const {document:parsed,diagnostics}=Coconut.parseWithDiagnostics(text,file.name);
    setTranscriptImportDiagnostics(item,diagnostics);
    let sourceKey;try{const raw=JSON.parse(text);if(typeof raw?.key==='string'&&raw.key.length<=200)sourceKey=raw.key;}catch{}
    item.status='saving';renderTranscriptImportBatch(batch);
    const receipt=await add(parsed,canCommit,false,lifecycleRevision,sourceKey,{activate:false});
    finishTranscriptImportReceipt(item,receipt);
    if(!receipt.ok){stopTranscriptImportBatch();break;}
   }catch(error){item.status=canCommit()?'failed':'cancelled';if(item.status==='failed')item.error=localFileError(error);}
   renderTranscriptImportBatch(batch);
  }
 }finally{
  for(const item of batch.items)if(['queued','review','encoding','reading','saving'].includes(item.status))item.status='cancelled';
  if(batch.items.some(item=>item.status==='cancelled'))batch.cancelled=true;
  batch.finished=true;renderTranscriptImportBatch(batch);
  if(ownsRequest())$('file').value='';
 }
}
$("search").oninput = () => {
 const continuing=!$('search').value.trim()?readingSearchTarget():null;
 clearReadingContext();
 searchFocusedId=null;
 const index=continuing?active().segments.filter(cue=>matchesReadingSegment(cue,active(),'')).indexOf(continuing):-1;
	pageStart = index>=0?Math.floor(index/PAGE_SIZE)*PAGE_SIZE:0;
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
   render({keepNoteEditor:true,reuseLibraryMetadata:true});return;
  }
		$("note-count").textContent = String(Coconut.segmentNoteCount(d));
		renderLibrary(null,{reuseMetadata:true});
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
	const count = Coconut.projectAnnotationCount(doc)+Coconut.notebookSegments(doc).length+Coconut.exactExcerptCount(doc)+(doc.reading_chapters?.length||0);
	$("export-notebook").disabled = count === 0;
	$("export-notebook").textContent = Coconut.isAudioProject(doc)?"导出原声项目笔记（"+count+" 项）":"导出阅读笔记（" + count + (Coconut.hasProjectAnnotations(doc)||Coconut.exactExcerptCount(doc)||doc.reading_chapters?.length?" 项）":" 段）");
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
 $('attach-project-transcript').hidden=!audioOnly;$('paste-project-subtitles').hidden=!audioOnly;$('attach-project-help').hidden=!audioOnly;
 if(panel.dataset.documentKey!==doc.key){
  panel.dataset.documentKey=doc.key;$('audio-bookmark-form').reset();$('audio-bookmark-time').value=draft?.time||'';$('audio-bookmark-note').value=draft?.note||'';$('audio-bookmark-search').value='';$('audio-project-status').textContent='';
 }
 $('project-note').value=doc.project_note;
 const host=$('audio-bookmarks');host.replaceChildren();
 if(!doc.timestamp_bookmarks.length)host.append(el('p','hint','还没有时间书签。播放时可以填入当前时间，也可以手动记录。'));
 const query=$('audio-bookmark-search').value.trim().toLocaleLowerCase();
 const matchesBookmark=item=>!query||[item.note,Coconut.time(item.time),String(item.time)].some(value=>value.toLocaleLowerCase().includes(query));
 const bookmarks=doc.timestamp_bookmarks.filter(matchesBookmark);
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
  // Keep the editor and caret stable while typing, and keep row actions usable
  // when focus moves from the note to its time editor or delete button.
  let pendingPointer=null;
  const reconcileBookmarkSearch=nextFocus=>{
   if(active()!==doc||!row.isConnected||pendingPointer||row.contains(document.activeElement)||row.contains(nextFocus)||matchesBookmark(item))return;
   captureAudioBookmarkDrafts();row.remove();
   const count=doc.timestamp_bookmarks.filter(matchesBookmark).length;
   $('audio-bookmark-results').textContent='找到 '+count+' / '+doc.timestamp_bookmarks.length+' 个时间书签';
   if(!count)host.append(el('p','hint','没有匹配的书签，请清除或更换关键词。'));
   if(!nextFocus?.isConnected&&(!document.activeElement||document.activeElement===document.body))$('audio-bookmark-search').focus();
  };
  const releasePointer=(nextFocus=null)=>{
   if(!pendingPointer)return;
   pendingPointer.abort();pendingPointer=null;queueMicrotask(()=>reconcileBookmarkSearch(nextFocus));
  };
  const finishPointer=()=>{
   const owner=pendingPointer;setTimeout(()=>{if(pendingPointer===owner)releasePointer();},0);
  };
  row.onpointerdown=event=>{
   if(event.button!==0)return;
   pendingPointer?.abort();pendingPointer=new AbortController();
   const options={capture:true,signal:pendingPointer.signal};
   // Some browsers blur the note without focusing a clicked button. Hold the
   // row through click; pointer-up without a click must release it as well.
   document.addEventListener('pointerup',finishPointer,{...options,once:true});
   document.addEventListener('pointercancel',()=>releasePointer(),{...options,once:true});
   document.addEventListener('pointerdown',next=>{if(!row.contains(next.target))releasePointer();},options);
   window.addEventListener('blur',()=>releasePointer(),{signal:pendingPointer.signal,once:true});
  };
  row.addEventListener('click',finishPointer);
  // focusout bubbles, but Chromium has no onfocusout handler property.
  row.addEventListener('focusout',event=>{
   if(event.relatedTarget&&!row.contains(event.relatedTarget))releasePointer(event.relatedTarget);
   queueMicrotask(()=>reconcileBookmarkSearch(event.relatedTarget));
  });
  const applyBookmarkNote=value=>{if(!contentIngressAllowed(doc)||!doc.timestamp_bookmarks.includes(item))return;if(!allowAudioNoteChange(doc,item.note,value,10000)){if(input.isConnected)input.value=item.note;return;}item.note=value;queueDocument(doc);if(active()===doc){renderLibrary();renderNotebookAction(doc);reconcileBookmarkSearch();}};
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
   item.time=next;form.hidden=true;doc.timestamp_bookmarks.sort((a,b)=>a.time-b.time);const receipt=commitDocument(doc);renderAudioProject(doc);renderLibrary();renderNotebookAction(doc);
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
	if (!doc || (!Coconut.projectAnnotationCount(doc)&&!Coconut.notebookSegments(doc).length&&!Coconut.exactExcerptCount(doc)&&!doc.reading_chapters?.length)) {
		notice("先摘录一段原话，或写一则笔记，再导出阅读笔记。");
		return;
	}
	let url, link;
	try {
		const blob = new Blob([Coconut.notebookMarkdown(doc,textExportLanguage(doc))], {type: "text/markdown;charset=utf-8"});
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
$("export").onclick = () => exportReaderDocument(active());
function exportReaderDocument(d) {
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
 await add(Coconut.validate(demo),null,false,documentLifecycleRevision,undefined,{onActivate:({identity:doc,selectionRevision})=>{
  // The explicit demo launch starts bilingual before its first visible render.
  // A later save receipt must not undo a reader's newer view/language or scroll.
  if(doc.translation_view!=='zh'){doc.translation_view='zh';queueDocument(doc);}demoToolsExpanded=false;
  setReadingMode('transcript');
  queueMicrotask(()=>{if(active()===doc&&activeSelectionRevision===selectionRevision&&workspace==='read')$('title').scrollIntoView?.({block:'start'});});
 }});
 } catch(error){notice('示例打开失败：'+error.message);}
 finally{$('sample').disabled=false;}
};
readingMode=defaultReadingMode(active());
render();

// Whole-source correction uses explicit, single-use previews. Persistence is a
// separate operation: retries can only save the current document, never replay.
const SOURCE_CORRECTION_PAGE_SIZE=20;
function sourceCorrectionOwned(editor=sourceCorrectionEditor){return !!editor&&active()===editor.doc&&activeSelectionRevision===editor.selection&&state.documents.includes(editor.doc)&&$('source-correction-dialog').open;}
function sourceCorrectionSignature(){return JSON.stringify([$('source-find').value,$('source-replace').value]);}
function sourceCorrectionDraft(){return sourceCorrectionOwned()&&sourceCorrectionSignature()!==sourceCorrectionEditor.savedDraft&&!!($('source-find').value||$('source-replace').value);}
function closeSourceCorrection(restoreFocus=true){
 const editor=sourceCorrectionEditor;sourceCorrectionEditor=null;if($('source-correction-dialog').open)$('source-correction-dialog').close();
 if(restoreFocus&&editor&&active()===editor.doc&&activeSelectionRevision===editor.selection){$('reading-settings').open=true;$('open-source-correction').scrollIntoView?.({block:'center',behavior:'instant'});$('open-source-correction').focus({preventScroll:true});}
}
function sourceCorrectionSaveStatus(){
 const editor=sourceCorrectionEditor;if(!sourceCorrectionOwned(editor))return;
 const saved=libraryStore.status(editor.doc.key),own=saved?.identity===editor.doc,operation=sourceCorrectionSaves.get(editor.doc);
 const pending=own&&saved.status==='pending',failed=own&&saved.status!=='saved'&&saved.status!=='pending';
 $('source-correction-status').textContent=operation?(own&&saved.status==='saved'?operation+'已保存到本机。':pending?operation+'已在本页生效，正在保存。':operation+'仍在本页，尚未保存到本机。请重试或导出完整 JSON 救援；不要关闭页面。'):'';
 const focused=document.activeElement,retry=$('source-correction-retry'),backup=$('source-correction-export');
 retry.hidden=!failed&&focused!==retry;retry.disabled=libraryStore.status().blocked&&focused!==retry;
 retry.setAttribute('aria-disabled',String(pending||libraryStore.status().blocked||!failed));
 backup.hidden=(!operation||own&&saved.status==='saved')&&focused!==backup;
}
function sourceCorrectionSelectionStatus(){
 const editor=sourceCorrectionEditor;if(!editor)return;
 const preview=editor.preview,selected=editor.selected.size;
 $('source-correction-count').textContent=preview?preview.total+' 处 / '+preview.cueCount+' 个原片段；已选 '+selected+' 处（含其他页）。'+(!preview.changes?'查找与替换相同，不会修改。':!preview.total?'没有匹配的原文。':''):'修改查找或替换后，须重新预览。';
 $('apply-source-correction').textContent='应用所选 '+selected+' 处';$('apply-source-correction').disabled=!sourceCorrectionOwned(editor)||!preview?.changes||!selected;
 $('undo-source-correction').hidden=sourceCorrectionUndo?.doc!==editor.doc;
 $('source-correction-undo-help').textContent=sourceCorrectionUndo?'本页仅保留最近一批撤销。应用新批次将替换「'+sourceCorrectionUndo.doc.title+'」的上一批撤销记录；关闭后仍可在本页返回撤销，刷新页面后不保留。':'本页只保留最近一批撤销；刷新页面后不保留。';
}
function renderSourceCorrectionHits(){
 const editor=sourceCorrectionEditor,host=$('source-correction-results');host.replaceChildren();if(!editor)return;
 const preview=editor.preview,start=editor.page*SOURCE_CORRECTION_PAGE_SIZE,total=preview?.total||0;
 for(const hit of preview?.hits.slice(start,start+SOURCE_CORRECTION_PAGE_SIZE)||[]){
  const row=el('section','source-correction-hit');row.dataset.segmentId=hit.id;row.dataset.hitIndex=String(hit.index);
  const label=el('label'),check=el('input');check.type='checkbox';check.value=String(hit.index);check.checked=editor.selected.has(hit.index);check.setAttribute('aria-label','选择第 '+(hit.index+1)+' 处，原片段 '+(hit.position+1)+'，'+Coconut.time(hit.start));
  check.onchange=()=>{if(!sourceCorrectionOwned(editor)||editor.preview!==preview)return;check.checked?editor.selected.add(hit.index):editor.selected.delete(hit.index);sourceCorrectionSelectionStatus();};
  label.append(check,el('span','',Coconut.time(hit.start)+'–'+Coconut.time(hit.end)+' · 原片段 '+(hit.position+1)+' · 第 '+(hit.index+1)+' 处'));
  const before=el('p','source-correction-context'),after=el('p','source-correction-context');before.append('原文：'+hit.before,el('mark','',hit.match),hit.after);after.append('改为：'+hit.before,el('strong','',hit.replacement||'〔删除此处〕'),hit.after);row.append(label,before,after);host.append(row);
 }
 $('source-correction-page').textContent=total?'第 '+(editor.page+1)+' / '+Math.ceil(total/SOURCE_CORRECTION_PAGE_SIZE)+' 页':'';
 $('source-correction-prev').disabled=!preview||editor.page===0;$('source-correction-next').disabled=!preview||start+SOURCE_CORRECTION_PAGE_SIZE>=total;
 $('select-source-page').disabled=$('clear-source-page').disabled=!total;
 sourceCorrectionSelectionStatus();sourceCorrectionSaveStatus();
}
function invalidateSourceCorrectionPreview(){
 const editor=sourceCorrectionEditor;if(!editor)return;editor.preview=null;editor.selected.clear();editor.page=0;$('source-correction-error').textContent='';renderSourceCorrectionHits();
}
$('open-source-correction').onclick=()=>{
 const doc=active();if(!doc?.segments.length||!contentIngressAllowed(doc))return;
 sourceCorrectionEditor={doc,selection:activeSelectionRevision,preview:null,selected:new Set(),page:0,savedDraft:JSON.stringify(['',''])};
 $('source-correction-title').textContent=doc.title;$('source-find').value='';$('source-replace').value='';$('source-correction-error').textContent='';
 $('source-correction-dialog').showModal();renderSourceCorrectionHits();$('source-find').focus();
};
for(const id of ['source-find','source-replace'])$(id).addEventListener('input',invalidateSourceCorrectionPreview);
$('preview-source-correction').onclick=()=>{
 const editor=sourceCorrectionEditor;if(!sourceCorrectionOwned(editor)||!contentIngressAllowed(editor.doc))return;
 invalidateSourceCorrectionPreview();
 try{editor.preview=Coconut.createSourceCorrectionPreview(editor.doc,{find:$('source-find').value,replacement:$('source-replace').value});editor.selected=new Set(editor.preview.hits.map(hit=>hit.index));renderSourceCorrectionHits();}
 catch(error){$('source-correction-error').textContent=error.message;}
};
for(const [id,direction] of [['source-correction-prev',-1],['source-correction-next',1]])$(id).onclick=()=>{
 const editor=sourceCorrectionEditor;if(!sourceCorrectionOwned(editor)||!editor.preview||$(id).disabled)return;editor.page+=direction;renderSourceCorrectionHits();
 // A last-page transition may disable the initiating control. Keep keyboard
 // traversal inside the new result page instead of dropping focus to the body.
 if($(id).disabled)($('source-correction-results').querySelector('input')||$('preview-source-correction')).focus();
};
for(const [id,select] of [['select-source-page',true],['clear-source-page',false]])$(id).onclick=()=>{
 const editor=sourceCorrectionEditor;if(!sourceCorrectionOwned(editor)||!editor.preview)return;
 for(const hit of editor.preview.hits.slice(editor.page*SOURCE_CORRECTION_PAGE_SIZE,(editor.page+1)*SOURCE_CORRECTION_PAGE_SIZE))select?editor.selected.add(hit.index):editor.selected.delete(hit.index);
 for(const check of $('source-correction-results').querySelectorAll('input'))check.checked=editor.selected.has(Number(check.value));sourceCorrectionSelectionStatus();
};
// Transfer excerpt UI ownership only along this known text-correction operation.
// A genuinely replaced same-ID cue is still rejected by the existing guard.
function transferSourceCorrectionExcerptOwners(doc,before){
 const owners=readingExcerptOwners.get(doc);if(!owners)return;
 const replacements=new Map(before.flatMap((cue,index)=>cue!==doc.segments[index]&&cue.id===doc.segments[index]?.id?[[cue,doc.segments[index]]]:[]));
 for(const record of doc.exact_excerpts||[]){const owner=owners.get(record);if(owner)owner.cues=owner.cues.map(cue=>replacements.get(cue)||cue);}
}
function saveSourceCorrection(doc,message){
 sourceCorrectionSaves.set(doc,message);
 const receipt=commitDocument(doc);sourceCorrectionSaveStatus();
 // This callback never navigates, rerenders the reader, or takes focus. The
 // pipeline's generation checks distinguish a newer edit/undo from this write.
 void receipt.then(()=>sourceCorrectionSaveStatus());
}
function sourceCorrectionChanged(editor,before,message){
 const focused=document.activeElement;
 transferSourceCorrectionExcerptOwners(editor.doc,before);
 window.dispatchEvent(new CustomEvent('coconut-source-corrected',{detail:{key:editor.doc.key,identity:editor.doc}}));
 editor.savedDraft=sourceCorrectionSignature();invalidateSourceCorrectionPreview();
 saveSourceCorrection(editor.doc,message);render();
 if(focused===$('apply-source-correction'))$('undo-source-correction').focus();
 else if(focused===$('undo-source-correction'))$('preview-source-correction').focus();
}
$('apply-source-correction').onclick=()=>{
 const editor=sourceCorrectionEditor;if(!sourceCorrectionOwned(editor)||!editor.preview||!contentIngressAllowed(editor.doc))return;
 try{
  const before=editor.doc.segments,result=Coconut.applySourceCorrectionPreview(editor.doc,editor.preview,[...editor.selected]);
  if(!result.changed){invalidateSourceCorrectionPreview();return;}
  sourceCorrectionUndo={doc:editor.doc,token:result.undo};sourceCorrectionChanged(editor,before,'已修正 '+result.occurrenceCount+' 处、'+result.changedCount+' 个原片段；');
 }catch(error){$('source-correction-error').textContent=error.message;editor.preview=null;$('apply-source-correction').disabled=true;}
};
$('undo-source-correction').onclick=()=>{
 const editor=sourceCorrectionEditor,undo=sourceCorrectionUndo;if(!sourceCorrectionOwned(editor)||undo?.doc!==editor.doc||!contentIngressAllowed(editor.doc))return;
 try{const before=editor.doc.segments;Coconut.undoSourceCorrection(editor.doc,undo.token);sourceCorrectionUndo=null;sourceCorrectionChanged(editor,before,'最近一批原文修正已撤销；');}
 catch(error){$('source-correction-error').textContent=error.message;}
};
$('source-correction-retry').onclick=async()=>{
 const editor=sourceCorrectionEditor;if(!sourceCorrectionOwned(editor)||libraryStore.status().blocked||libraryStore.status().status==='pending'||!libraryStore.status().unsaved)return;
 await libraryStore.retry();if(sourceCorrectionOwned(editor))sourceCorrectionSaveStatus();
};
$('source-correction-dialog').addEventListener('focusout',()=>queueMicrotask(sourceCorrectionSaveStatus));
$('source-correction-export').onclick=()=>{if(sourceCorrectionOwned())exportReaderDocument(sourceCorrectionEditor.doc);};
$('close-source-correction').onclick=()=>closeSourceCorrection();
$('source-correction-dialog').addEventListener('cancel',event=>{event.preventDefault();closeSourceCorrection();});
$('source-correction-dialog').addEventListener('close',()=>{if(!$('source-correction-dialog').open)sourceCorrectionEditor=null;});
$('source-correction-dialog').addEventListener('keydown',event=>{
 const dialog=$('source-correction-dialog');if(!sourceCorrectionOwned()||event.key!=='Tab'||event.defaultPrevented||event.isComposing||event.keyCode===229||event.altKey||event.ctrlKey||event.metaKey)return;
 const controls=[...dialog.querySelectorAll('button,input,[tabindex]')].filter(node=>node.tabIndex>=0&&!node.disabled&&!node.closest('[hidden],[inert]'));
 const first=controls[0],last=controls.at(-1);if(first&&(event.shiftKey&&document.activeElement===first||!event.shiftKey&&document.activeElement===last)){event.preventDefault();(event.shiftKey?last:first).focus();}
});

// A preview is bound to the exact document and target cues by core. Never
// rebuild it on submit: doing so would silently accept a stale dialog.
function openSpeakerCorrection(doc,cue,row){
 if(active()!==doc||!contentIngressAllowed(doc))return;
 const matches=doc.segments.filter(s=>matchesReadingSegment(s,doc,$('search').value.trim().toLocaleLowerCase()));
 speakerEditor={doc,selectionRevision:activeSelectionRevision,cueId:cue.id,from:cue.speaker,index:matches.findIndex(s=>s.id===cue.id),viewportTop:row.getBoundingClientRect().top,preview:null};
 $('speaker-original').textContent=cue.speaker;$('speaker-name').maxLength=Coconut.SPEAKER_CORRECTION_LABEL_LIMIT;$('speaker-name').value=cue.speaker;speakerEditor.displayName=$('speaker-name').value;
 $('speaker-action').value='rename';$('speaker-scope').value='cue';
 $('speaker-scope').options[1].textContent='整篇相同标签，共 '+doc.segments.filter(s=>s.speaker===cue.speaker).length+' 段';
 refreshSpeakerPreview();$('speaker-dialog').showModal();$('speaker-name').focus();$('speaker-name').select();
}
function speakerCorrectionDraft(){
 return !!speakerEditor&&$('speaker-dialog').open&&($('speaker-name').value!==speakerEditor.displayName||$('speaker-action').value==='restore'&&speakerEditor.preview?.changedCount>0);
}
function refreshSpeakerPreview(){
 const editor=speakerEditor;if(!editor)return;
 $('speaker-error').textContent='';$('speaker-preview').replaceChildren();$('speaker-merge').textContent='';editor.preview=null;
 $('speaker-name').disabled=$('speaker-action').value==='restore';
 try{
  if(active()!==editor.doc||activeSelectionRevision!==editor.selectionRevision||!state.documents.includes(editor.doc)||!contentIngressAllowed(editor.doc))throw Error('文字稿已变化，请取消后重新打开。');
  const preview=Coconut.createSpeakerCorrectionPreview(editor.doc,{cueId:editor.cueId,scope:$('speaker-scope').value,action:$('speaker-action').value,speaker:$('speaker-name').value===editor.displayName?editor.from:$('speaker-name').value});editor.preview=preview;
  $('speaker-count').textContent='范围内 '+preview.total+' 段，将修改 '+preview.changedCount+' 段'+(preview.truncated?'；以下预览前 '+preview.preview.length+' 段':'')+'。';
  if(preview.action==='restore')$('speaker-merge').textContent=preview.mixed?'将按各段记录恢复，可能拆回不同标签；没有初始记录的片段保持不变。':'按各段记录恢复初始标签；没有初始记录的片段保持不变。';
  else if(preview.toSpeaker!==preview.fromSpeaker&&editor.doc.segments.some(cue=>cue.speaker===preview.toSpeaker))$('speaker-merge').textContent='“'+preview.toSpeaker+'”已存在，修正后将归入同一标签组。';
  for(const cue of preview.preview){const item=el('p','speaker-preview-cue');item.append(el('strong','',Coconut.time(cue.start)+' · '+cue.fromSpeaker+' → '+cue.toSpeaker),el('span','',cue.text));$('speaker-preview').append(item);}
  $('save-speaker').disabled=false;
 }catch(error){$('speaker-count').textContent='';$('speaker-error').textContent=error.message;$('save-speaker').disabled=true;}
}
function closeSpeakerCorrection(){
 const editor=speakerEditor;speakerEditor=null;$('speaker-dialog').close();
 if(editor&&active()===editor.doc){const row=[...$('transcript').querySelectorAll('.segment')].find(node=>node.dataset.segmentId===editor.cueId);(row?.querySelector('.speaker-correction-button')||row||$('search')).focus({preventScroll:true});}
}
// Native text inputs remove CR/LF on assignment. Untouched source labels must
// retain their exact imported value across scope changes, edits reverted to the
// initial display value, and no-op submission. Compare display values without trim.
$('speaker-name').addEventListener('input',refreshSpeakerPreview);
for(const id of ['speaker-scope','speaker-action'])$(id).addEventListener('change',refreshSpeakerPreview);
$('cancel-speaker').onclick=closeSpeakerCorrection;
$('speaker-dialog').addEventListener('cancel',event=>{event.preventDefault();closeSpeakerCorrection();});
// Own the two Tab boundaries explicitly: native dialog traversal can hand the
// final Tab to browser chrome instead of wrapping to the first reader control.
$('speaker-dialog').addEventListener('keydown',event=>{
 const dialog=$('speaker-dialog');
 if(!dialog.open||!speakerEditor||event.key!=='Tab'||event.defaultPrevented||event.isComposing||event.keyCode===229||event.altKey||event.ctrlKey||event.metaKey||event.target.closest?.('dialog')!==dialog)return;
 const controls=[...dialog.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex],[contenteditable="true"]')].filter(node=>{
  if(node.tabIndex<0||node.matches(':disabled')||node.closest('[hidden],[inert]'))return false;
  for(let current=node;current&&current!==dialog;current=current.parentElement){const style=getComputedStyle(current);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return false;}
  return true;
 });
 const first=controls[0],last=controls.at(-1),focused=document.activeElement;
 if(first&&((event.shiftKey&&focused===first)||(!event.shiftKey&&focused===last))){event.preventDefault();(event.shiftKey?last:first).focus();}
});

$('save-speaker').onclick=()=>{
 const editor=speakerEditor;if(!editor?.preview)return;
 try{
  const doc=editor.doc;
  if(active()!==doc||activeSelectionRevision!==editor.selectionRevision||!state.documents.includes(doc)||!contentIngressAllowed(doc))throw Error('文字稿已变化，请取消后重新打开。');
  const result=Coconut.applySpeakerCorrectionPreview(doc,editor.preview);
  if(!result.changed){closeSpeakerCorrection();return;}
  const next=doc.segments.find(cue=>cue.id===editor.cueId).speaker;
  // Keep an existing old group for a single-cue change. If the whole old group
  // disappears (including a mixed restore), follow the initiating cue's label.
  const follow=value=>value===editor.from&&!doc.segments.some(cue=>cue.speaker===value)?next:value;
  speakerFilter=follow(speakerFilter);
  if(readingContext?.document===doc){
   const origin=readingContext;origin.speakerFilter=follow(origin.speakerFilter);
   const matches=doc.segments.filter(cue=>(origin.speakerFilter===null||(cue.speaker||'')===origin.speakerFilter)&&Coconut.matchesSegment(cue,doc,origin.query.trim().toLocaleLowerCase(),origin.notesOnly,origin.excerptsOnly));
   origin.count=matches.length;const index=matches.findIndex(cue=>cue.id===origin.id);origin.resultMissing=index<0;origin.index=index>=0?index:Math.max(0,Math.min(origin.index,matches.length-1));
   origin.label=[origin.query.trim()?'搜索“'+origin.query.trim()+'”':'',origin.excerptsOnly?'摘录':'',origin.notesOnly?'笔记':'',origin.speakerFilter!==null?'说话人：'+(origin.speakerFilter||'未标注'):''].filter(Boolean).join(' · ');
  }
  const matches=doc.segments.filter(cue=>matchesReadingSegment(cue,doc,$('search').value.trim().toLocaleLowerCase()));
  const exact=matches.findIndex(cue=>cue.id===editor.cueId),index=exact>=0?exact:Math.min(editor.index,matches.length-1),target=matches[index];
  pageStart=index>=0?Math.floor(index/PAGE_SIZE)*PAGE_SIZE:0;
  if(searchFocusedId===editor.cueId)searchFocusedId=target?.id||null;
  passageAnchor=editor.cueId;
  queueDocument(doc);speakerEditor=null;$('speaker-dialog').close();render();
  const row=[...$('transcript').querySelectorAll('.segment')].find(node=>node.dataset.segmentId===target?.id);
  const button=row?.querySelector('.speaker-correction-button');const details=button?.closest('details');if(details)details.open=true;
  focusCueAction(button||row||$('search'),exact>=0?editor.viewportTop:null);
  if(exact<0)notice(target?'原片段已不在筛选结果中，已返回相邻结果。':'原筛选已没有匹配片段；可调整筛选继续阅读。');
 }catch(error){$('speaker-error').textContent=error.message;$('save-speaker').disabled=true;}
};

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

// The report's outcome is historical; persistence and reachability are live.
function libraryRestoreIdentity(doc){
 if(!libraryRestoreIdentities.has(doc))libraryRestoreIdentities.set(doc,++libraryRestoreIdentitySequence);
 return libraryRestoreIdentities.get(doc);
}
function libraryRestoreTarget(entry,documents=state.documents){
 const doc=documents.find(doc=>doc.key===entry.key);
 return doc&&libraryRestoreIdentities.get(doc)===entry.identity?doc:null;
}
function libraryRestoreEntryState(entry,documents){
 const doc=documents.get(entry.key);
 if(!doc||libraryRestoreIdentities.get(doc)!==entry.identity)return {status:'unavailable',text:'对应文档已移除或替换，未重新关联'};
 if(pendingStructuralDocuments.has(doc.key))return {doc,status:'processing',text:'正在移除或恢复，请稍候'};
 const receipt=libraryStore.status(doc.key);
 if(receipt?.identity===doc){
  if(receipt.status==='saved')return {doc,status:'saved',text:'当前内容已保存到本机'};
  if(receipt.status==='pending')return {doc,status:'pending',text:'当前内容正在保存，尚无成功回执'};
  return {doc,status:'failed',text:'当前内容未保存，仍在本页；请重试或导出备份'};
 }
 return restoreLoadedIdentities.has(doc)&&!receipt?{doc,status:'saved',text:'已从本机存储读取'}:{doc,status:'unknown',text:'尚未取得当前内容的保存回执，请保留原备份'};
}
function recordLibraryRestoreReport(file,entries){
 libraryRestoreReport={id:++libraryRestoreSequence,name:file.name,entries:entries.map(entry=>({sourceKey:entry.sourceKey,key:entry.document.key,identity:libraryRestoreIdentity(entry.document),title:entry.document.title,kind:Coconut.isReadingCollection(entry.document)?'成果集':Coconut.isAudioProject(entry.document)?'音视频项目':'文字稿',outcome:entry.outcome}))};
 libraryRestorePage=0;$('open-library-restore-results').hidden=false;$('library-restore-results-feedback').textContent='';renderLibraryRestoreResults();
 if($('library-restore-results-dialog').open)$('library-restore-results-heading').focus({preventScroll:true});
}
function renderLibraryRestoreResults(){
 if(!libraryRestoreReport||!$('library-restore-results-dialog').open)return;
 const report=libraryRestoreReport,entries=report.entries,documents=new Map(state.documents.map(doc=>[doc.key,doc]));
 libraryRestorePage=Math.max(0,Math.min(libraryRestorePage,Math.ceil(entries.length/LIBRARY_RESTORE_PAGE_SIZE)-1));
 const counts={added:0,conflict:0,duplicate:0},states=entries.map(entry=>{counts[entry.outcome]++;return libraryRestoreEntryState(entry,documents);});
 $('library-restore-results-file').textContent=report.name;
 $('library-restore-results-summary').textContent=`共 ${entries.length} 项：新增 ${counts.added} · 冲突副本 ${counts.conflict} · 重复跳过 ${counts.duplicate}`;
 const saved=states.filter(item=>item.status==='saved').length,pending=states.filter(item=>item.status==='pending').length,failed=states.filter(item=>['failed','unknown'].includes(item.status)).length,unavailable=entries.length-saved-pending-failed;
 const statusText=`当前对应内容：已保存 ${saved} · 正在保存 ${pending} · 未确认保存 ${failed} · 不可打开 ${unavailable}`;
 if($('library-restore-results-status').textContent!==statusText)$('library-restore-results-status').textContent=statusText;
 const first=libraryRestorePage*LIBRARY_RESTORE_PAGE_SIZE,signature=report.id+':'+libraryRestorePage,host=$('library-restore-results-list');
 if(libraryRestorePainted!==signature){
  libraryRestorePainted=signature;host.replaceChildren();host.start=first+1;
  for(const [offset,entry] of entries.slice(first,first+LIBRARY_RESTORE_PAGE_SIZE).entries()){
   const index=first+offset,row=el('li','library-restore-result');row.dataset.resultIndex=index;row.dataset.outcome=entry.outcome;row.dataset.documentKey=entry.key;
   row.append(el('strong','library-restore-result-title',entry.title),el('p','hint',entry.kind+' · '+({added:'新增',conflict:'冲突副本，原版本保留',duplicate:'重复跳过，未新增'}[entry.outcome])),el('p','hint','备份标识：'+entry.sourceKey+' · 对应标识：'+entry.key),el('p','library-restore-result-status'));
   const button=el('button','library-restore-result-open',entry.kind==='成果集'?'打开对应成果集':'打开对应文档');button.type='button';
   button.onclick=()=>{
    // A stale detached button must never open a newer report or reused key.
    if(libraryRestoreReport!==report||!row.isConnected)return;
    const doc=libraryRestoreTarget(entry);
    if(!doc||pendingStructuralDocuments.has(entry.key)){renderLibraryRestoreResults();return;}
    if(Coconut.isReadingCollection(doc)&&collectionTitleDraft()){$('library-restore-results-feedback').textContent='成果集有尚未提交的名称，请先在书架笔记本中保存或取消名称修改。';return;}
    $('library-restore-results-dialog').close();
    if($('library-search-dialog').open)closeLibraryWorkspace('selection');
    if(Coconut.isReadingCollection(doc)){cancelLocalImports();openCollection(doc);return;}
    markDocumentOpened(doc);resetReaderForDocumentNavigation();selectActiveDocument(doc.key);setReadingMode(defaultReadingMode(doc));
    $('toggle-library').setAttribute('aria-expanded','false');showWorkspace('read');render();resumeOpenedDocument(doc,'title',{remembered:true});
   };
   row.append(button);host.append(row);
  }
 }
 for(const row of host.children){
  const item=states[Number(row.dataset.resultIndex)];row.dataset.state=item.status;
  const status=row.querySelector('.library-restore-result-status');if(status.textContent!==item.text)status.textContent=item.text;
  row.querySelector('.library-restore-result-open').disabled=!item.doc||item.status==='processing';
 }
 $('library-restore-results-position').textContent=entries.length?`${first+1}–${Math.min(first+LIBRARY_RESTORE_PAGE_SIZE,entries.length)} / ${entries.length}`:'没有恢复条目';
 $('library-restore-results-previous').disabled=libraryRestorePage===0;
 $('library-restore-results-next').disabled=first+LIBRARY_RESTORE_PAGE_SIZE>=entries.length;
 const snapshot=libraryStore.status(),retry=$('library-restore-results-retry'),backup=$('library-restore-results-backup');
 retry.hidden=(!failed||!snapshot.unsaved)&&document.activeElement!==retry;retry.disabled=snapshot.blocked||snapshot.status==='pending'||!snapshot.unsaved;
 backup.hidden=(!failed||!snapshot.unsaved)&&document.activeElement!==backup;
}
$('open-library-restore-results').onclick=()=>{
 if(!libraryRestoreReport)return;
 $('library-restore-results-feedback').textContent='';$('library-restore-results-dialog').showModal();renderLibraryRestoreResults();$('library-restore-results-heading').focus({preventScroll:true});
};
function closeLibraryRestoreResults(){
 $('library-restore-results-dialog').close();
 const button=$('open-library-restore-results');if(button.isConnected&&!button.closest('[hidden]'))button.focus({preventScroll:true});
}
$('library-restore-results-close').onclick=closeLibraryRestoreResults;
$('library-restore-results-dialog').addEventListener('cancel',event=>{event.preventDefault();closeLibraryRestoreResults();});
for(const [id,delta] of [['library-restore-results-previous',-1],['library-restore-results-next',1]])$(id).onclick=()=>{
 if($(id).disabled)return;libraryRestorePage+=delta;renderLibraryRestoreResults();$('library-restore-results-heading').focus({preventScroll:true});
};
$('library-restore-results-retry').onclick=async()=>{
 await $('retry-save').onclick();renderLibraryRestoreResults();
 $('library-restore-results-feedback').textContent=libraryStore.status().unsaved?'仍有未保存内容，请保留原备份，并查看保存提示。':'本页待保存内容已取得成功回执。';
};
$('library-restore-results-backup').onclick=()=>{$('export-unsaved-documents').onclick();$('library-restore-results-feedback').textContent=$('notice').textContent;};

// Library restore is additive: a conflicting version becomes another document.
$("export-library").onclick = () => {
 let url, link;
 try {
  const backup = {format:"coconut-library", version:1, documents:state.documents, active:state.active};
  const blob = new Blob([JSON.stringify(backup, null, 2)], {type:"application/json"});
  url = URL.createObjectURL(blob);
  link = el("a"); link.href=url; link.download="coconut-library.json"; link.hidden=true; document.body.append(link); link.click();
  notice("已发起整个书架的完整 JSON 备份下载，请确认文件已保存；包含文字、笔记、译文与 AI 记录及依据，不包含媒体文件。"+(state.documents.some(Coconut.isReadingCollection)?"含精选成果集；需支持成果集的版本，旧版不能打开此书架或备份。":"")+backupRecoveryHint(blob), "success");
 } catch { notice("书架备份失败，内容仍在本页，请重试后再关闭。"); }
 finally { link?.remove(); if(url)setTimeout(()=>URL.revokeObjectURL(url),60000); }
};
$('export-selected-library').onclick=()=>{
 let url,link;
 try {
  const selection=libraryBackupSelection.reconcile(state.documents,pendingStructuralDocuments);
  librarySelectionDropped+=selection.removed;
  if(selection.removed)throw new Error('部分选中文档已移除或替换，请核对选择数量后重新备份。');
  const backup=libraryBackupSelection.backup(state.documents,state.active,pendingStructuralDocuments);
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
  url=URL.createObjectURL(blob);link=el('a');link.href=url;link.download='coconut-selected-library.json';link.hidden=true;document.body.append(link);link.click();
  notice('已发起所选 '+backup.documents.length+' 份备份下载，请确认文件已保存。'+backupRecoveryHint(blob),'success');
 } catch(error){notice(error.message||'所选文档备份失败，内容仍在本页，请重试后再关闭。');}
 finally {link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);syncLibraryBackupSelection();}
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
  const existing=new Set(state.documents),plan=Coconut.planLibraryBackup(state,backup),restored=plan.library,added=restored.documents.filter(doc=>!existing.has(doc));
 if(added.some(doc=>pendingStructuralDocuments.has(doc.key)))throw new Error('文档正在移除或恢复，请稍候重试');
  // An empty restore stays in Add without looking like new navigation on render.
  clearReadingContext();
  const previousDocument=active();
  state = restored; selectActiveDocument(restored.active); selected=null; pageStart=0; notesOnly=false; excerptsOnly=false; speakerFilter=null; $("search").value=""; workspace=active()?"read":"add";
  // Only a newly activated document gets an entry default. An additive/empty
  // restore of the current document preserves its explicit reading choice.
  if(active()!==previousDocument)setReadingMode(defaultReadingMode(active()));
  recordLibraryRestoreReport(file,plan.entries);
  const receipt=commitDocuments(added);render();
  const persisted=await receipt;
  if(persisted.ok && ownsRequest() && state.active===restored.active && workspace===(restored.active?"read":"add"))notice("已恢复 " + added.length + " 份文字稿／项目／成果集；相同内容已跳过，不同版本分别保留，原书架未删除。可从书架备份查看“最近恢复结果”。");
 } catch(error) { if(canCommit())notice("恢复失败，原书架未改变："+localFileError(error)); }
 finally { if(ownsRequest())$("library-file").value=""; }
};

// Reader intent is page-local and identity-owned. Even A → B → A must stop a
// previously sent translation from stealing the newer display selection.
const readingDisplayRevisions=new WeakMap();
function readingDisplayRevision(doc){return readingDisplayRevisions.get(doc)||0;}
function recordReadingDisplaySelection(doc){readingDisplayRevisions.set(doc,readingDisplayRevision(doc)+1);}
function renderReadingDisplayControl(){
 const doc=active(),control=$('reading-display-control'),select=$('translation-view');
 control.hidden=workspace!=='read'||!doc||Coconut.isAudioProject(doc)||!doc.segments.length||readingMode==='summary';
 if(!doc)return;
 const languages=new Set();
 for(const cue of doc.segments)for(const [language,item] of Object.entries(cue.translations||{}))if(item?.text?.trim())languages.add(language);
 const saved=new Set(languages);if(doc.translation_view)languages.add(doc.translation_view);
 const options=[['',languages.size?'仅原文':'仅原文 · 暂无已存译文'],...[...languages].map(language=>[language,translationLabel(language)+' + 原文'+(saved.has(language)?'':' · 暂无已存译文')])];
 const signature=JSON.stringify(options);
 if(select.dataset.options!==signature){select.replaceChildren(...options.map(([value,label])=>{const option=el('option','',label);option.value=value;return option;}));select.dataset.options=signature;}
 select.disabled=languages.size===0;
 select.value=textExportLanguage(doc);
}
function readingStickyNodes(){return [$('reading-mode-toolbar'),...document.querySelectorAll('#reader-workspace > .reading-context')];}
function syncReadingStickyStack(){
 // Every retained return route owns its own row. Measure wrapped labels rather
 // than guessing a mobile height; geometry updates never scroll or move nodes.
 const measurements=readingStickyNodes().map(node=>({node,height:node.hidden?0:node.getBoundingClientRect().height}));
 let inset=6;
 for(const {node,height} of measurements){
  const top=(height>0?inset:6)+'px';if(node.style.top!==top)node.style.top=top;
  if(height>0)inset+=height+6;
 }
 const workspace=$('reader-workspace'),value=inset+'px';
 if(workspace.style.getPropertyValue('--reading-sticky-inset')!==value)workspace.style.setProperty('--reading-sticky-inset',value);
 return inset;
}
const readingStickyObserver=typeof ResizeObserver==='function'?new ResizeObserver(syncReadingStickyStack):null;
for(const node of readingStickyNodes())readingStickyObserver?.observe(node);
window.addEventListener('resize',syncReadingStickyStack);
function readingDisplayTopEdge(){
 return readingStickyNodes().reduce((edge,node)=>{
  const rect=node.getBoundingClientRect(),inset=parseFloat(getComputedStyle(node).top)||0;
  return !node.hidden&&rect.height>0&&rect.top<=inset?Math.max(edge,rect.bottom):edge;
 },0);
}
// Explicit new landings reserve the forthcoming sticky stack even when it is
// still in natural flow. Native smooth scrolling reads this margin immediately;
// restore the inline style afterwards so no old return inset survives the route.
function scrollReadingTarget(node,{block='start',behavior='auto'}={}){
 if(!node)return;
 if(node.closest('dialog')){node.scrollIntoView?.({block,behavior});return;}
 const inset=syncReadingStickyStack(),prior=node.style.getPropertyValue('scroll-margin-top'),priority=node.style.getPropertyPriority('scroll-margin-top');
 const margin=Math.max(parseFloat(getComputedStyle(node).scrollMarginTop)||0,inset);
 const bottomInset=parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom)||0;
 if(block==='center'&&node.getBoundingClientRect().height>(window.visualViewport?.height||window.innerHeight)-margin-bottomInset)block='start';
 node.style.setProperty('scroll-margin-top',margin+'px',priority);
 try{node.scrollIntoView?.({block,behavior});}finally{if(prior)node.style.setProperty('scroll-margin-top',prior,priority);else node.style.removeProperty('scroll-margin-top');}
 if(behavior!=='smooth'){const edge=readingDisplayTopEdge(),top=node.getBoundingClientRect().top;if(edge&&top<edge+6)window.scrollBy(0,top-edge-6);}
}
function readingDisplayCueNode(id){
 return [...document.querySelectorAll(readingMode==='passages'?'#passage-body .passage-original .passage-cue':'#transcript .segment')].find(node=>(node.dataset.cueId||node.dataset.segmentId)===id);
}
function setReadingDisplayLanguage(target){
 const doc=active();if(!doc||!contentIngressAllowed(doc)||Coconut.isAudioProject(doc))return;
 if(target&&!Array.from($('translation-view').options).some(option=>option.value===target))return;
 const sourceNodes=[...document.querySelectorAll(readingMode==='passages'?'#passage-body .passage-original .passage-cue':'#transcript .segment')];
 const edge=readingDisplayTopEdge();
 const node=sourceNodes.find(node=>{const rect=node.getBoundingClientRect();return rect.bottom>edge&&rect.top<(window.visualViewport?.height||innerHeight);})||readingDisplayCueNode(visibleReadingCue());
 const cueId=node?.dataset.cueId||node?.dataset.segmentId,top=node?.getBoundingClientRect().top;
 recordReadingDisplaySelection(doc);
 // Source-only shares the existing page-local passage lifecycle. A concrete
 // language remains persisted; fallback reads never manufacture a saved choice.
 passageTranslations=!!target;
 if((doc.translation_view||'')!==target){doc.translation_view=target;queueDocument(doc);}
 const excerptIndex=readingExcerptIndex(doc);
 if(readingMode==='passages')renderPassages(doc,excerptIndex);
 else if(readingMode==='transcript')renderTranscript(doc,excerptIndex,{keepNoteEditor:true,displayOnly:true});
 renderReadingDisplay();highlightPlayback();
 const restored=readingDisplayCueNode(cueId);
 if(restored&&Number.isFinite(top)){
  const owner=followOwns()?readingFollow:null;window.scrollBy(0,restored.getBoundingClientRect().top-top);
  // Only this synchronous, exact display compensation belongs to the reader.
  // A later wheel/touch/keyboard or different scroll position still suspends.
  if(owner&&readingFollow===owner)owner.scrollY=window.scrollY;
 }
}
$('translation-view').onchange=()=>setReadingDisplayLanguage($('translation-view').value);

function textExportLanguage(doc=active()){
 if(!doc||Coconut.isAudioProject(doc)||readingMode==='summary')return '';
 return readingMode==='passages'?(passageTranslations?passageTargetLanguage(doc):''):doc.translation_view||'';
}
function renderTextExportAction(){
 const doc=active(),unavailable=!doc||Coconut.isAudioProject(doc)||!doc.segments.length,target=textExportLanguage(doc);
 $('export-subtitles').disabled=unavailable;
 const changed=subtitleExportDocument!==doc||subtitleExportLanguage!==target;
 const subtitleOption=$('subtitle-bilingual');
 subtitleOption.disabled=unavailable||!target;
 if(subtitleOption.disabled||subtitleExportDocument!==doc||subtitleExportLanguage!==target)subtitleOption.checked=false;
 subtitleExportDocument=doc;subtitleExportLanguage=target;
 $('subtitle-bilingual-label').textContent=target?'附加当前显示的'+translationLabel(target)+'（'+target+'）有效译文':'当前未显示译文';
 $('export-text').disabled=unavailable;
 $('text-bilingual').disabled=unavailable||!target;
 if($('text-bilingual').disabled||changed)$('text-bilingual').checked=false;
 $('text-export-language').textContent=unavailable?'补充文字稿后可导出。':target?'当前显示语言：'+target+'；缺失与过期译文会标注，不会导出过期内容。':'当前未显示译文；切换双语或展开连贯阅读的译文后可附加。';
}
$('export-text').onclick=()=>{
 const doc=active();if(!doc)return;
 let url,link;
 try{
  const target=$('text-bilingual').checked?textExportLanguage(doc):'';
  const result=Coconut.transcriptText(doc,target);
  url=URL.createObjectURL(new Blob([result.text],{type:'text/plain;charset=utf-8'}));
  link=el('a');link.href=url;link.download=doc.title.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,'_')+'.txt';link.hidden=true;document.body.append(link);link.click();
  notice('已发起整篇文字下载（'+doc.segments.length+' 段）'+(target?'，有效译文 '+result.translated+' 段，缺失 '+result.missing+' 段，过期 '+result.stale+' 段':'')+'。请确认文件已保存。','success');
 }catch{notice('整篇文字导出失败，内容仍在本页，请重试。');}
 finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);}
};

$("export-subtitles").onclick = () => {
 const doc=active(); if(!doc)return;
 let url,link;
 try {
  const format=$("subtitle-format").value, target=textExportLanguage(doc), bilingual=$("subtitle-bilingual").checked&&!!target;
  const result=Coconut.subtitleExport(doc,format,bilingual,target);
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
 const ceiling=Math.max(64,readingDisplayTopEdge()+6);
 if(rect.top<ceiling||rect.bottom>height-128){
  row.scrollIntoView?.({block:rect.height>height-ceiling-128?'start':'center',behavior:'auto'});
  // Native start alignment can leave a long cue below the browser edge but
  // behind our sticky controls. This correction retains the same follow owner.
  const edge=readingDisplayTopEdge(),top=row.getBoundingClientRect().top;
  if(edge&&top<edge+6)window.scrollBy(0,top-edge-6);
 }
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
const followTransport='#reading-display-control,#passage-toggle-translation,#follow-playback,#dock-follow,#dock-play,#dock-rewind,#skip-back,#skip-forward,#playback-rate,audio,video';
window.addEventListener('wheel',()=>suspendReadingFollow(),{capture:true,passive:true});
window.addEventListener('touchstart',event=>{if(!event.target.closest?.(followTransport))suspendReadingFollow();},{capture:true,passive:true});
document.addEventListener('pointerdown',event=>{if(!event.target.closest?.(followTransport))suspendReadingFollow();},true);
document.addEventListener('click',event=>{if(event.target.closest?.('button,a,summary,input,select,textarea')&&!event.target.closest(followTransport))suspendReadingFollow();},true);
document.addEventListener('input',event=>{if(!event.target.closest?.(followTransport))suspendReadingFollow('正在输入');},true);
document.addEventListener('focusin',event=>{if(event.target.matches?.('input,textarea,select,[contenteditable="true"]')&&!event.target.closest(followTransport))suspendReadingFollow('正在输入');},true);
document.addEventListener('keydown',event=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)&&!event.target.closest?.(followTransport))suspendReadingFollow();},true);
window.addEventListener('coconut-render',refreshReadingFollow);
document.addEventListener('visibilitychange',()=>{if(document.hidden)suspendReadingFollow('页面已离开');});

// The dock controls the existing source player; it never creates another one.
function dockRewindAvailable(){
 const player=$('source-media').querySelector('audio,video');
 return !!(workspace==='read'&&!$('reader-workspace').hidden&&!$('source-media').hidden&&contentIngressAllowed(active())&&!$('media-dock').closest('[inert]')&&!document.querySelector('dialog[open]')&&player&&!player.error&&Number.isFinite(player.duration)&&player.duration>0);
}
function syncPlaybackDockInset(){
 const dock=$('media-dock'),rect=dock.getBoundingClientRect();
 // Round the occupied edge outward and leave a full reading gutter. Native
 // centered scrolling halves this clearance and can quantize fractional rows.
 const inset=!dock.hidden&&rect.height>0?Math.ceil(Math.max(0,window.innerHeight-rect.top))+16:0;
 const root=document.documentElement,value=inset+'px';
 if(root.style.getPropertyValue('--reading-dock-inset')!==value)root.style.setProperty('--reading-dock-inset',value);
}
function refreshPlaybackDock(){
 refreshReadingFollow();
 const dock=$('media-dock'),player=$('source-media').querySelector('audio,video');
 const playable=player&&!player.error&&Number.isFinite(player.duration)&&player.duration>0;
 const visible=!!(playable&&workspace==='read'&&!$('reader-workspace').hidden&&!$('source-media').hidden&&($('episode-media').getBoundingClientRect().bottom<=0||(readingFollow&&!readingFollow.suspended&&dock.contains(document.activeElement))));
 if(!readingFollowMoving&&(!readingFollow||readingFollow.suspended)&&!visible&&!dock.hidden&&dock.contains(document.activeElement)&&player&&workspace==='read')player.focus({preventScroll:true});
 if(dock.hidden!==!visible)dock.hidden=!visible;
 if(document.body.dataset.mediaDocked!==String(visible))document.body.dataset.mediaDocked=String(visible);
 // Modal/native-close barriers are checked when invoked; do not latch a paused
 // player's button disabled after a dialog closes without another media event.
 const rewindDisabled=!visible;if($('dock-rewind').disabled!==rewindDisabled)$('dock-rewind').disabled=rewindDisabled;
 if(!visible){syncPlaybackDockInset();return;}
 // Time events need not rewrite unchanged labels or invalidate layout styles.
 const write=(id,value)=>{const node=$(id);if(node.textContent!==value)node.textContent=value;};
 const title=(active()?.title||'当前原声').replace(/\s+/g,' ').slice(0,240);
 write('dock-title',title);if($('dock-title').title!==title)$('dock-title').title=title;
 write('dock-play',player.ended?'重播':player.paused?'播放':'暂停');
 const label=player.ended?'重新播放本篇原声':player.paused?'播放本篇原声':'暂停本篇原声';
 if($('dock-play').getAttribute('aria-label')!==label)$('dock-play').setAttribute('aria-label',label);
 write('dock-current',Coconut.time(player.currentTime));write('dock-total',' / '+Coconut.time(player.duration));write('dock-rate',' · '+player.playbackRate+'×');
 const audioOnly=Coconut.isAudioProject(active());if($('dock-locate').hidden!==audioOnly)$('dock-locate').hidden=audioOnly;
 const cue=playbackSegment();if($('dock-locate').disabled!==!cue)$('dock-locate').disabled=!cue;
 write('dock-locate-full',cue?'定位原文':'此刻无字幕');write('dock-locate-short',cue?'定位':'无字幕');
 const locateLabel=cue?'定位当前播放的原文':'当前时间没有字幕';
 if($('dock-locate').getAttribute('aria-label')!==locateLabel)$('dock-locate').setAttribute('aria-label',locateLabel);
 if($('dock-locate').title!==locateLabel)$('dock-locate').title=locateLabel;
 // Geometry only: native scrolling uses this inset; refreshing never scrolls.
 syncPlaybackDockInset();
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
$('dock-rewind').onclick=()=>{
 // Validate at action time: stale/retired controls cannot seek another workspace
 // or bypass a native-close barrier or modal. Shared skip owns loop/preview exit.
 if($('media-dock').hidden||!dockRewindAvailable())return;
 skipPlayback(-10);refreshPlaybackDock();
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
 stopRepeating();const target={key:active().key,doc:active(),attachment:browserMedia.get(active().key),player,id:segment.id,path:player.getAttribute("src"),start:range.start,end:range.end,expectedSeek:null,seekAcknowledged:false};repeating=target;
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
 if(!target.player.seeking&&target.player.currentTime===target.start){target.expectedSeek=null;target.seekAcknowledged=false;return;}
 target.expectedSeek=target.start;target.seekAcknowledged=false;target.player.currentTime=target.start;
}
function observeRepeatSeek(player,completed){
 const target=repeatTarget(player);if(!target)return;
 if(target.expectedSeek===null){stopRepeating();return;}
 if(!completed){
  // Only the first near-target seeking acknowledges this owned request. A new
  // seeking event after that is user takeover, even at the same media time.
  if(target.seekAcknowledged||Math.abs(player.currentTime-target.expectedSeek)>REPEAT_SEEK_TOLERANCE){stopRepeating();return;}
  target.seekAcknowledged=true;return;
 }
 // Playback can advance before queued seeked delivery. Complete the matched
 // transaction, rather than measuring its running clock against the old target.
 if(!target.seekAcknowledged||player.seeking){stopRepeating();return;}
 target.expectedSeek=null;target.seekAcknowledged=false;
}
function repeatPlayback(ended=false,player=$('source-media').querySelector('audio,video')){
 const target=repeatTarget(player);if(!target||player.seeking||target.expectedSeek!==null)return;
 // Native clocks can round an owned seek just below a fractional mapped start.
 // Use the same tolerance as its seek acknowledgement; later native seeks still
 // retire ownership unconditionally once expectedSeek has been cleared.
 if(player.currentTime<target.start-REPEAT_SEEK_TOLERANCE){stopRepeating();return;}
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
 scrollReadingTarget(row,{block:alignment});row?.focus({preventScroll:true});
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
 for(const cue of doc.segments)for(const [language,item] of Object.entries(cue.translations||{}))if(item?.text?.trim()&&Coconut.translationCurrent(cue,doc,item))return language;
 return '';
}
function appendPassageCue(paragraph,cue,text,previousText){
 if(previousText!==null)paragraph.append(document.createTextNode(CoconutPassages.separator(previousText,text)));
 const span=el('span','passage-cue',text);span.dataset.cueId=cue.id;paragraph.append(span);
 return text;
}
// Update only controls: a save receipt must not rebuild reading text, move focus,
// change the passage page, or disturb a playing/previewing media element.
function renderPassageReadingPosition(){
 const doc=active(),host=$('passage-body');if(!doc||host.dataset.documentKey!==doc.key)return;
 const status=libraryStore.status(doc.key)?.status||'saved';
 for(const button of host.querySelectorAll('.passage-bookmark')){
  const contains=[...button.closest('.passage').querySelectorAll('.passage-original .passage-cue')].some(cue=>cue.dataset.cueId===doc.readingPosition);
  button.setAttribute('aria-pressed',String(contains));
  button.dataset.state=contains?status:'unmarked';
  button.textContent=!contains?'读到这里':status==='saved'?'阅读位置在本段':status==='pending'?'位置待保存':'位置未保存';
  button.title=contains?'本段包含阅读位置；点击将位置改为本段开头。保存状态见页面提示。':'将阅读位置设为本段开头';
 }
}
function renderPassages(doc,excerptIndex=readingExcerptIndex(doc)){
 readingExcerptControls=readingExcerptControls.filter(entry=>entry.mode!=='passages'&&entry.button.isConnected);
 const passages=readingPassages(doc),host=$('passage-body');host.dataset.documentKey=doc.key;
 if(!passages.length){host.replaceChildren();return;}
 if(passageDocumentKey!==doc.key){passageDocumentKey=doc.key;passageAnchor=doc.readingPosition||passages[0].cues[0].id;passagePageStart=0;passageReturn=null;passageTranslations=true;}
 const anchored=CoconutPassages.locate(passages,passageAnchor)||passages[0];
 const index=passages.indexOf(anchored);passagePageStart=Math.floor(index/PASSAGES_PER_PAGE)*PASSAGES_PER_PAGE;
 const visible=passages.slice(passagePageStart,passagePageStart+PASSAGES_PER_PAGE),target=passageTargetLanguage(doc);
 const hasTranslation=!!target&&doc.segments.some(cue=>cue.translations?.[target]?.text?.trim()&&Coconut.translationCurrent(cue,doc,cue.translations[target]));
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
    const item=cue.translations?.[target],current=item?.text?.trim()&&Coconut.translationCurrent(cue,doc,item);
    if(current){previous=appendPassageCue(translated,cue,item.text,previous);}
    else{
     const gap=el('span','passage-translation-gap',Coconut.time(cue.start)+(item?.text?.trim()?' 译文已过期，请核对原文':' 暂无译文'));
     gap.dataset.cueId=cue.id;gap.dataset.state=item?.text?.trim()?'stale':'missing';translated.append(gap);previous=null;
    }
   }
   columns.append(translated);
  }
  section.append(columns);
  if(target&&passageTranslations)for(const cue of passage.cues){const item=cue.translations?.[target];if(item&&Coconut.translationCurrent(cue,doc,item)){const warning=Coconut.translationQualityMessage(item);if(warning)section.append(el('p','passage-translation-warning',Coconut.time(cue.start)+' · 译文待核对：'+warning));}}
  const actions=el('div','passage-actions');
  const bookmark=el('button','passage-bookmark','读到这里'),selection=activeSelectionRevision;bookmark.type='button';
  bookmark.setAttribute('aria-label','读到这里：将阅读位置设为本段开头 '+Coconut.time(passage.start));
  bookmark.onclick=()=>{
   if(!bookmark.isConnected||active()!==doc||activeSelectionRevision!==selection||!contentIngressAllowed(doc))return;
   doc.readingPosition=passage.cues[0].id;
   queueDocument(doc);
   renderPassageReadingPosition();
  };
  actions.append(bookmark,readingExcerptControl(doc,passage.cues,'passages',excerptIndex));
  if(window.CoconutQuotation){
   quotationController??=CoconutQuotation.create({isCurrent:owner=>active()===owner&&state.documents.includes(owner)&&contentIngressAllowed(owner),saveExcerpt:saveExactExcerpt,excerptState:exactExcerptSaveState,onDraftChange:syncUnsavedUnloadGuard});
   const quote=el('button','passage-quote','引用原文');quote.type='button';quote.setAttribute('aria-label','引用 '+Coconut.time(passage.start)+' 的原文');
   quotationController.bind(quote,original,doc,passage.cues);actions.append(quote);
  }
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
 renderReadingChapterMarkers(doc);
 renderPassageReadingPosition();
 renderPassagePlayback(passagePlayback?.getState());
}
// Fixed playback/feedback panels are outside the browser's native focus viewport.
// Only a real Tab move may reveal a passage action; receipts and layout changes
// never scroll. Defer once so native focus scrolling has settled first.
// Shelf selection and translation controls own their exact card identity.
// Move only the shelf scrollport after keyboard focus or explicit hit paging,
// never from save receipts or unrelated background renders.
function revealLibrarySelectionFocus(target,card,revision) {
 const workspace=$('library-search-dialog').open&&($('library-search-results').contains(target)||$('library-search-feedback').contains(target));
 const host=workspace&&$('library-search-feedback').contains(target)?$('library-search-feedback'):libraryResultsPort(),translation=target.matches('.library-translation-hit, .library-translation-pagination button');
 if(revision!==libraryFocusRevealRevision||(!workspace&&!translation&&!librarySelectionMode)||document.activeElement!==target||!target.isConnected||!target.matches(':focus-visible')||target.disabled)return;
 if(target.closest('.library-entry')&&(!card||libraryCards.get(card.doc.key)!==card||!state.documents.includes(card.doc)||pendingStructuralDocuments.has(card.doc.key)))return;
 if(!workspace&&(translation?!card?.translationHits?.contains(target):card?.select!==target))return;
 const label=workspace||translation?target:card.selectLabel,rect=target.getBoundingClientRect(),labelRect=label.getBoundingClientRect(),area=host.getBoundingClientRect(),style=getComputedStyle(target);
 if(!rect.width||!rect.height||!area.width||!area.height||label.hidden)return;
 const ring=(parseFloat(style.outlineWidth)||0)+Math.max(0,parseFloat(style.outlineOffset)||0);
 const bounds={left:Math.min(labelRect.left,rect.left-ring),right:Math.max(labelRect.right,rect.right+ring),top:Math.min(labelRect.top,rect.top-ring),bottom:Math.max(labelRect.bottom,rect.bottom+ring)};
 let slots=[[Math.max(0,area.top+host.clientTop),Math.min(window.innerHeight,area.top+host.clientTop+host.clientHeight)]];
 for(const overlay of ($('library-search-dialog').open?[]:[$('reading-feedback'),$('media-dock')])){
  const css=getComputedStyle(overlay);if(overlay.hidden||css.display==='none'||css.visibility==='hidden')continue;
  const occupied=overlay.getBoundingClientRect();
  if(!occupied.width||!occupied.height||occupied.left>=bounds.right||occupied.right<=bounds.left)continue;
  const top=occupied.top-2,bottom=occupied.bottom+2;
  slots=slots.flatMap(([start,end])=>bottom<=start||top>=end?[[start,end]]:[[start,Math.min(end,top)],[Math.max(start,bottom),end]].filter(([a,b])=>b>a));
 }
 const height=bounds.bottom-bounds.top;
 const moves=slots.filter(([start,end])=>end-start>=height).map(([start,end])=>({start,end,delta:bounds.top<start?bounds.top-start:bounds.bottom>end?bounds.bottom-end:0})).sort((a,b)=>Math.abs(a.delta)-Math.abs(b.delta));
 if(!moves.length||!moves[0].delta)return;
 // Native offsets can quantize fractional CSS coordinates. Prefer a one-pixel
 // inset, but never push the opposite ring edge out of a nearly full slot.
 const {delta,start,end}=moves[0],requested=host.scrollTop+delta;
 const lower=host.scrollTop+bounds.bottom-end,upper=host.scrollTop+bounds.top-start;
 const first=Math.max(0,Math.ceil(lower)),last=Math.floor(upper),inset=delta>0?Math.ceil(requested)+1:Math.floor(requested)-1;
 const destination=first<=last?Math.max(first,Math.min(last,inset)):Math.max(0,Math.min(upper,Math.max(lower,requested)));
 const maximum=Math.max(0,host.scrollHeight-host.clientHeight);
 // A last card may already be at the native scroll limit. Add only the missing
 // trailing room on this keyboard path, retaining it until selection is cancelled.
 if(destination>maximum){
  const extra=parseFloat(host.style.getPropertyValue('--library-keyboard-space'))||0;
  host.style.setProperty('--library-keyboard-space',(extra+destination-maximum)+'px');
 }
 host.scrollTo({top:destination,left:host.scrollLeft,behavior:'instant'});
}
let passageActionTab=false,libraryFocusRevealRevision=0;
document.addEventListener('keydown',event=>{passageActionTab=event.key==='Tab';libraryFocusRevealRevision++;},true);
document.addEventListener('keyup',event=>{if(event.key==='Tab')passageActionTab=false;},true);
document.addEventListener('pointerdown',()=>{passageActionTab=false;libraryFocusRevealRevision++;},true);
document.addEventListener('focusin',event=>{
 const target=event.target,keyboard=passageActionTab;passageActionTab=false;
 const workspace=$('library-search-dialog').open&&target.matches?.('#library-search-results :is(button,input,select,summary), #library-search-feedback :is(button,input,select,summary)');
 if(!keyboard||(!workspace&&!target.matches?.('#passage-body :is(button,a), #transcript :is(button,a,summary), .library-select, .library-translation-hit, .library-translation-pagination button'))||!target.matches(':focus-visible'))return;
 if(workspace||target.matches('.library-select, .library-translation-hit, .library-translation-pagination button')){
  const card=libraryCards.get(target.closest('.library-entry')?.dataset.documentKey),revision=libraryFocusRevealRevision;
  requestAnimationFrame(()=>revealLibrarySelectionFocus(target,card,revision));return;
 }
 const doc=active(),selection=activeSelectionRevision;
 requestAnimationFrame(()=>{
  if(document.activeElement!==target||!target.isConnected||active()!==doc||activeSelectionRevision!==selection||!target.matches(':focus-visible'))return;
  const rect=target.getBoundingClientRect(),style=getComputedStyle(target);
  if(!rect.width||!rect.height)return;
  const ring=(parseFloat(style.outlineWidth)||0)+(parseFloat(style.outlineOffset)||0)+2;
  const bounds={left:rect.left-ring,right:rect.right+ring,top:rect.top-ring,bottom:rect.bottom+ring};
  const toolbar=$('reading-mode-toolbar'),bar=toolbar.getBoundingClientRect(),edge=readingDisplayTopEdge();
  if(edge&&bounds.top<edge&&bounds.right>bar.left&&bounds.left<bar.right){window.scrollBy(0,Math.floor(bounds.top-edge-2));return;}
  let ceiling=Infinity,occluded=false;
  for(const overlay of [$('reading-feedback'),$('media-dock')]){
   if(overlay.hidden||getComputedStyle(overlay).display==='none')continue;
   const area=overlay.getBoundingClientRect();
   if(area.width&&area.height&&area.bottom>0&&area.top<window.innerHeight&&area.left<bounds.right&&area.right>bounds.left){
    ceiling=Math.min(ceiling,area.top);
    if(area.top<bounds.bottom&&area.bottom>bounds.top)occluded=true;
   }
  }
  if(occluded&&bounds.bottom>ceiling)window.scrollBy({top:bounds.bottom-ceiling,left:0,behavior:'instant'});
 });
});
// Only the utility ring may paint over an adjacent, still-unpinned toolbar.
// Once reading scrolls under sticky controls, their normal foreground wins.
const readingUtilityFocusTargets='#keyboard-help-open,#reading-info > summary,#toggle-reader-media,#passage-toggle-translation,#passage-search';
function syncReadingUtilityFocusLayer(){
 const utility=$('reading-utility'),toolbar=$('reading-mode-toolbar'),target=document.activeElement;let raised=false;
 if(workspace==='read'&&!toolbar.hidden&&utility.classList.contains('is-compact')&&target?.matches(readingUtilityFocusTargets)&&target.matches(':focus-visible')){
  const r=target.getBoundingClientRect(),bar=toolbar.getBoundingClientRect(),style=getComputedStyle(target),ring=(parseFloat(style.outlineWidth)||0)+Math.max(0,parseFloat(style.outlineOffset)||0),top=parseFloat(getComputedStyle(toolbar).top)||0;
  raised=r.height>0&&bar.height>0&&bar.top>top&&r.bottom<=bar.top&&r.bottom+ring>bar.top;
 }
 if(utility.classList.contains('utility-focus-front')!==raised)utility.classList.toggle('utility-focus-front',raised);
}
document.addEventListener('focusin',syncReadingUtilityFocusLayer);
document.addEventListener('focusout',event=>{if($('reading-utility').contains(event.target))$('reading-utility').classList.remove('utility-focus-front');});
window.addEventListener('scroll',syncReadingUtilityFocusLayer,{passive:true});
window.addEventListener('resize',syncReadingUtilityFocusLayer);
window.addEventListener('coconut-render',syncReadingUtilityFocusLayer);
// A native select can keep focus while a narrower/shorter viewport moves a
// fixed receipt over its ring. Reveal only that focused control, never dismiss
// the receipt or schedule a source/follow navigation. New user intent wins.
let readingDisplayRevealFrame=null,readingDisplayRevealOwner=null;
function cancelReadingDisplayReveal(){
 if(readingDisplayRevealFrame!==null)cancelAnimationFrame(readingDisplayRevealFrame);
 readingDisplayRevealFrame=null;readingDisplayRevealOwner=null;
}
function scheduleReadingDisplayReveal(){
 cancelReadingDisplayReveal();const target=$('translation-view'),doc=active();
 if(document.activeElement!==target||!doc)return;
 const owner={doc,segments:doc.segments,selection:activeSelectionRevision,display:readingDisplayRevision(doc),scrollY:window.scrollY};readingDisplayRevealOwner=owner;
 readingDisplayRevealFrame=requestAnimationFrame(()=>{
  readingDisplayRevealFrame=null;readingDisplayRevealOwner=null;
  if(document.activeElement!==target||!target.isConnected||workspace!=='read'||document.hidden||$('reading-display-control').hidden||$('reading-mode-toolbar').hidden||active()!==doc||doc.segments!==owner.segments||activeSelectionRevision!==owner.selection||readingDisplayRevision(doc)!==owner.display||window.scrollY!==owner.scrollY)return;
  const r=target.getBoundingClientRect(),style=getComputedStyle(target);if(!r.width||!r.height||style.display==='none'||style.visibility==='hidden')return;
  const ring=(parseFloat(style.outlineWidth)||0)+Math.max(0,parseFloat(style.outlineOffset)||0)+2;
  const bounds={left:r.left-ring,right:r.right+ring,top:r.top-ring,bottom:r.bottom+ring};
  const viewport=window.visualViewport,top=viewport?.offsetTop||0,height=viewport?.height||window.innerHeight;let slots=[[top,top+height]];
  for(const overlay of [$('reading-feedback'),$('media-dock')]){
   const css=getComputedStyle(overlay),box=overlay.getBoundingClientRect();
   if(overlay.hidden||css.display==='none'||css.visibility==='hidden'||!box.width||!box.height||box.left>=bounds.right||box.right<=bounds.left)continue;
   slots=slots.flatMap(([start,end])=>box.bottom<=start||box.top>=end?[[start,end]]:[[start,Math.min(end,box.top)],[Math.max(start,box.bottom),end]].filter(([a,b])=>b>a));
  }
  const toolbar=$('reading-mode-toolbar'),bar=toolbar.getBoundingClientRect(),stickyTop=parseFloat(getComputedStyle(toolbar).top)||0;
  // A pinned toolbar does not move linearly with the page. Do not blindly scroll
  // it, or choose a slot that requires scrolling beyond either document edge.
  if(!bar.height||bar.top<=stickyTop)return;
  const maxY=Math.max(0,document.documentElement.scrollHeight,document.body.scrollHeight)-window.innerHeight;
  const lower=-window.scrollY,upper=Math.min(Math.max(0,maxY)-window.scrollY,bar.top-stickyTop),required=bounds.bottom-bounds.top;
  const moves=slots.filter(([start,end])=>end-start>=required).flatMap(([start,end])=>{
   const first=Math.ceil(Math.max(lower,bounds.bottom-end)),last=Math.floor(Math.min(upper,bounds.top-start));
   return first<=last?[Math.max(first,Math.min(last,0))]:[];
  }).sort((a,b)=>Math.abs(a)-Math.abs(b));
  if(!moves.length||!moves[0])return;
  const follow=followOwns()?readingFollow:null;
  window.scrollBy({top:moves[0],left:0,behavior:'instant'});
  if(window.scrollY===owner.scrollY)return;
  // Only this exact synchronous compensation is owned; a later different
  // scroll position still suspends playback following through its usual path.
  if(follow&&readingFollow===follow)follow.scrollY=window.scrollY;
 });
}
$('translation-view').addEventListener('focus',scheduleReadingDisplayReveal);
window.addEventListener('resize',scheduleReadingDisplayReveal);
window.visualViewport?.addEventListener('resize',scheduleReadingDisplayReveal);
for(const type of ['pointerdown','keydown','touchstart','wheel'])window.addEventListener(type,cancelReadingDisplayReveal,{capture:true,passive:true});
window.addEventListener('scroll',()=>{if(readingDisplayRevealOwner&&window.scrollY!==readingDisplayRevealOwner.scrollY)cancelReadingDisplayReveal();},{passive:true});
function openPassage(cueId,scroll=true){
 const doc=active(),passages=readingPassages(doc),passage=CoconutPassages.locate(passages,cueId)||passages[0];if(!passage)return;
 $('reading-info').open=false;mediaExpandedKey=null;
 passageReturn=null;passageDocumentKey=doc.key;passageAnchor=passage.cues[0].id;
 setReadingMode('passages');render();
 const target=[...$('passage-body').querySelectorAll('.passage')].find(row=>row.dataset.firstCueId===passageAnchor);
 if(scroll){scrollReadingTarget(target,{block:'start',behavior:'auto'});target?.focus({preventScroll:true});}
 rememberReadingView({cueId});
}
function openPassageDetails(cueId,section){
 rememberReadingView();
 const doc=active();if(!doc)return;
 passageAnchor=section.dataset.firstCueId;
 passageReturn={key:doc.key,cueId:passageAnchor,viewportTop:section.getBoundingClientRect().top,scrollY:window.scrollY,focusCueId:cueId};
 goToSegment(cueId,false,true);
}
function returnToPassages(){
 const origin=passageReturn,doc=active();if(!origin||origin.key!==doc?.key)return;
 if(readingSearchSession?.passageReturn===origin)endReadingSearch();
 passageAnchor=origin.cueId;passageReturn=null;setReadingMode('passages');render();
 const passage=CoconutPassages.locate(readingPassages(doc),origin.cueId);
 const section=[...$('passage-body').querySelectorAll('.passage')].find(row=>row.dataset.firstCueId===passage?.cues[0].id);
 if(section){window.scrollBy(0,section.getBoundingClientRect().top-origin.viewportTop);section.querySelector('.passage-details')?.focus({preventScroll:true});}
 else{scrollReadingTarget($('passage-body'),{block:'start'});$('mode-passages').focus({preventScroll:true});}
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
$('reading-info').querySelector('summary').addEventListener('click',()=>{if(!$('reading-info').open){$('export-menu').open=false;if(readingMode==='passages'){mediaExpandedKey=null;updateReaderMediaVisibility(active());refreshPlaybackDock();}}});
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
$('passage-toggle-translation').onclick=()=>setReadingDisplayLanguage(passageTranslations?'':passageTargetLanguage(active()));
$('passage-search').onclick=()=>{
 beginReadingSearch();const doc=active(),anchor=visibleReadingCue();passageReturn=null;
 if(readingMode==='passages'&&doc){const matches=doc.segments.filter(cue=>matchesReadingSegment(cue,doc,$('search').value.trim().toLocaleLowerCase())),index=matches.findIndex(cue=>cue.id===anchor);if(index>=0)pageStart=Math.floor(index/PAGE_SIZE)*PAGE_SIZE;}
 setReadingMode('transcript');render();focusReadingSearch();
};

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
 $('search').setAttribute('aria-keyshortcuts',readingKeysEnabled?'/ Control+F Meta+F Enter Shift+Enter':'Control+F Meta+F Enter Shift+Enter');
}
function hasReadingModal(){
 return !!document.querySelector('dialog[open]')||[...document.querySelectorAll('[aria-modal="true"]')].some(node=>!node.closest('[hidden],[aria-hidden="true"]'));
}
function readingKeyIgnored(event){
 return readerClosing||document.body.inert||$('reader-workspace').inert||!!$('reader-workspace').closest('[inert]')||
  event.defaultPrevented||event.repeat||event.isComposing||readingKeyComposition||event.keyCode===229||
  event.ctrlKey||event.metaKey||event.altKey||event.getModifierState?.('AltGraph')||workspace!=='read'||$('reader-workspace').hidden||!active()||hasReadingModal();
}
function readingTextTarget(node,find=false){
 if(document.designMode==='on'||document.body.isContentEditable||document.body.hasAttribute('contenteditable')&&document.body.getAttribute('contenteditable')!=='false')return false;
 if(!node||node===document||node===document.body||node===document.documentElement)return true;
 if(!$('reader-workspace').contains(node)||find&&node.shadowRoot?.activeElement)return false;
 // Native controls, ARIA widgets, editable ancestors and shadow hosts retain
 // their own keyboard behavior. Empty contenteditable is editable too.
 const controls=find?'textarea,select,audio,video,iframe,object,embed,[inert],[role]:not([role="group"])':'input,textarea,select,button,a,summary,audio,video,iframe,object,embed,[role],[inert]';
 if(node.closest?.(controls)||find&&node.closest?.('input')&&node!==$('search'))return false;
 for(let current=node;current&&current!==document.body;current=current.parentElement){
  if(current.isContentEditable||(current.hasAttribute?.('contenteditable')&&current.getAttribute('contenteditable')!=='false'))return false;
 }
 return true;
}
function openReadingSearch(){
 $('passage-search').onclick();
 if(active()?.provenance?.kind==='authored_demo'&&!demoToolsExpanded)$('toggle-demo-tools').onclick();
 focusReadingSearch();
}
// Shared by the renderer shortcut and the bounded native Edit menu command.
// Find is separate from opt-out character keys and never acquires media.
function openTranscriptFind(){
 if(readingKeyIgnored({})||Coconut.isAudioProject(active())||!active().segments.length||!readingTextTarget(document.activeElement,true))return false;
 openReadingSearch();$('search').select();return true;
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
 if(event.key.toLowerCase()==='f'&&(event.ctrlKey!==event.metaKey)&&(event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&!event.getModifierState?.('AltGraph')){
  if(!event.defaultPrevented&&!event.repeat&&!event.isComposing&&event.keyCode!==229&&readingTextTarget(event.target,true)&&readingTextTarget(event.composedPath?.()[0]||event.target,true)&&openTranscriptFind())event.preventDefault();
  return;
 }
 if(readingKeyIgnored(event))return;
 if(event.target===$('search')&&event.key==='Enter'){
  if(!$('search').value.trim()||$('search').closest('[hidden]'))return;
  event.preventDefault();$(event.shiftKey?'previous-match':'next-match').onclick();return;
 }
 if(!readingKeysEnabled||!readingTextTarget(document.activeElement)||!readingTextTarget(event.target)||!readingTextTarget(event.composedPath?.()[0]||event.target))return;
 const key=event.key.toLowerCase();if(event.shiftKey&&key!=='?')return;
 let action=null;
 if(key==='?')action=openKeyboardHelp;
 else if(key==='/'&&!Coconut.isAudioProject(active()))action=openReadingSearch;
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

function setReaderMediaLabel(label,shortLabel){
 const control=$('toggle-reader-media');control.setAttribute('aria-label',label);control.title=label;
 $('reader-media-label').textContent=label;$('reader-media-short-label').textContent=shortLabel;
}
function updateReaderMediaVisibility(doc=active(),hasMedia=!!$('source-media').querySelector('audio,video')){
 if(!doc)return;
 const audioOnly=Coconut.isAudioProject(doc),demo=doc.provenance?.kind==='authored_demo',compact=readingMode==='passages'&&!audioOnly;
 const expanded=mediaExpandedKey===doc.key,visible=audioOnly||expanded||(!compact&&hasMedia&&mediaCollapsedKey!==doc.key);
 $('episode-media').hidden=(demo&&!hasMedia)||!visible;
 $('toggle-reader-media').hidden=(demo&&!hasMedia)||audioOnly;
 $('toggle-reader-media').setAttribute('aria-expanded',String(visible));
 const label=compact?(visible?'收起原声':hasMedia?'原声':'关联原声'):(visible?'收起原声设置':'关联原声 · 回听这一篇');
 setReaderMediaLabel(label,visible?'收起':'原声');
 $('close-reader-media').hidden=audioOnly||!visible;
}
function composeReadingHeader(){
 const doc=active(),passageCompact=workspace==='read'&&readingMode==='passages'&&doc&&!Coconut.isAudioProject(doc);
 const shortCompact=!!shortTranscriptCompact(doc),headerCompact=!!passageCompact||shortCompact;
 // Breakpoint changes must not reparent an active input or hide its panel.
 // Defer the whole header transition until focus leaves settings, rather than
 // trying to repair focus after losing an IME composition or caret selection.
 const priorCompact=document.body.dataset.headerCompact==='true';
 if(workspace==='read'&&headerDocumentKey===doc?.key&&headerCompositionMode===readingMode&&
    headerCompact!==priorCompact&&$('reading-settings').contains(document.activeElement)){
  deferredHeaderComposition=true;return;
 }
 deferredHeaderComposition=false;headerCompositionMode=readingMode;
 document.body.dataset.headerCompact=String(headerCompact);document.body.dataset.shortReadingCompact=String(shortCompact);
 $('reader-title-slot').hidden=!headerCompact;$('count').hidden=headerCompact;$('reading-info').hidden=!headerCompact;
 $('reading-utility').classList.toggle('is-compact',headerCompact);
 $('reading-utility').classList.toggle('is-passage',!!passageCompact);
 const toolbar=document.querySelector('.passage-toolbar');toolbar.hidden=!passageCompact;
 const titleTarget=headerCompact?$('reader-title-slot'):$('reader-title-home');
 if($('title').parentElement!==titleTarget)titleTarget.append($('title'));
 const metaTarget=headerCompact?$('reading-info-meta'):$('reader-meta-home');
 for(const id of ['subtitle','provenance'])if($(id).parentElement!==metaTarget)metaTarget.append($(id));
 $('reading-info-title').textContent=doc?.title||'';$('title').title=doc?.title||'';
 if(headerDocumentKey!==doc?.key){headerDocumentKey=doc?.key;$('reading-info').open=false;}
 const settings=$('reading-settings');
 if(headerCompact){
  if(settings.parentElement!==$('reading-info-settings')){readingSettingsPriorOpen=settings.open;$('reading-info-settings').append(settings);settings.open=true;}
 }else{
  if(settings.parentElement!==$('reader-options')){$('reader-options').insertBefore(settings,$('language-panel'));settings.open=readingSettingsPriorOpen===true;readingSettingsPriorOpen=null;}
  $('reading-info').open=false;
 }
 const passageHelpTarget=passageCompact?$('reading-info-help'):document.querySelector('.passage-browse');
 if($('passage-browse-help').parentElement!==passageHelpTarget)passageHelpTarget.append($('passage-browse-help'));
 $('reading-info-position').textContent=passageCompact?$('passage-position').textContent:'';
 // The controls keep one fixed parent across breakpoints. Preserve keyboard,
 // selection and IME ownership; only disclose them before they receive focus.
 const tools=$('transcript-reading-tools'),disclosure=$('transcript-tools-disclosure');
 const ownsFocus=tools.contains(document.activeElement),wasCompact=disclosure.classList.contains('is-compact');
 const changedDocument=transcriptToolsDocumentKey!==doc?.key;transcriptToolsDocumentKey=doc?.key;
 const query=$('search').value.trim(),filtered=!!query||notesOnly||excerptsOnly||speakerFilter!==null;
 disclosure.classList.toggle('is-compact',shortCompact);$('transcript-tools-label').hidden=!shortCompact;
 if(!shortCompact)disclosure.open=true;
 else if(!wasCompact||changedDocument)disclosure.open=ownsFocus||filtered;
 else if(ownsFocus)disclosure.open=true;
 const filters=[query?'搜索「'+query+'」':'',notesOnly?'仅笔记':'',excerptsOnly?'仅摘录':'',speakerFilter!==null?'说话人：'+speakerFilter:''].filter(Boolean);
 const label=filters.length?'筛选中 · '+filters.join(' · '):'搜索与筛选';
 $('transcript-tools-label').textContent=label.length>64?label.slice(0,63)+'…':label;$('transcript-tools-label').title=label;

}

function applyReadingMode() {
 const audioOnly=Coconut.isAudioProject(active());
 $('reading-mode-toolbar').hidden=audioOnly;
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
 $('mode-bilingual').disabled=audioOnly;
 renderReadingContext();renderReadingSearch();
 composeReadingHeader();
 renderReadingDisplay();
}
function renderReadingDisplay(){
 const doc=active(),bilingual=readingMode==='transcript'&&!Coconut.isAudioProject(doc)&&!!doc?.translation_view;
 $('mode-transcript').setAttribute('aria-pressed',String(readingMode==='transcript'&&!bilingual));
 $('mode-bilingual').setAttribute('aria-pressed',String(bilingual));
 $('transcript-layout').classList.toggle('is-bilingual',bilingual);
 $('bilingual-readiness').hidden=!bilingual||active()?.provenance?.kind==='authored_demo';
 if(bilingual){const doc=active(),target=doc.translation_view,count=doc.segments.filter(s=>s.translations?.[target]?.text?.trim()&&Coconut.translationCurrent(s,doc,s.translations[target])).length;
 $('bilingual-status').textContent=count?`当前语言已有 ${count}/${doc.segments.length} 段有效译文；缺失部分可逐段「自己写译文」，过期译文可核对／修正；也可在翻译选项中继续。`:'还没有当前语言的有效译文。可逐段「自己写译文」，或打开翻译选项，核对发送范围与额度后生成；切换视图和自己写译文不会调用模型。';}
 renderReadingDisplayControl();
 renderTextExportAction();
 syncReadingStickyStack();
}
function setReadingMode(mode) {
 const previousMode=readingMode;
 readingMode=['transcript','passages'].includes(mode)?mode:'summary';
 if(readingMode==='passages'){if(readingContext?.document!==active())clearReadingContext();selected=null;$('notes-panel').hidden=true;if(typeof stopLanguageBatches==='function')stopLanguageBatches();$('language-panel').open=false;}
 if(readingMode==='summary'){passageReturn=null;endReadingSearch();}
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
// View switches follow the source currently being read, not the other view's
// previously mounted page. Geometry is read before hiding or rebuilding it.
function visibleReadingCue(){
 const passages=readingMode==='passages';
 if(!passages&&readingMode!=='transcript')return null;
 const nodes=[...document.querySelectorAll(passages?'#passage-body .passage-original .passage-cue':'#transcript .segment')];
 const id=node=>passages?node?.dataset.cueId:node?.dataset.segmentId;
 const height=window.visualViewport?.height||window.innerHeight,edge=readingDisplayTopEdge();
 const visible=nodes.find(node=>{const rect=node.getBoundingClientRect();return rect.bottom>edge&&rect.top<height;});
 if(visible)return id(visible);
 // A header can be in view while all source is below it. Keep the current
 // passage anchor when it still belongs to the mounted page, otherwise its start.
 return passages&&nodes.some(node=>id(node)===passageAnchor)?passageAnchor:id(nodes[0]);
}
// Capture at navigation boundaries, never on every scroll pixel. Temporary
// search/chapter/note routes keep the origin until the reader chooses to stay.
function rememberReadingView({cueId}={}){
 const doc=active();
 if(!doc||readingViewOwner!==doc||workspace!=='read'||Coconut.isAudioProject(doc)||pendingStructuralDocuments.has(doc.key))return;
 if(readingSearchSession||readingContext||chapterReturn||passageReturn||$('search').value.trim()||notesOnly||excerptsOnly||speakerFilter!==null)return;
 // Narrow shelves and modal search can hide or move source geometry. Their
 // entry already captured the visible cue, so don't replace it with page start.
 if($('library-search-dialog').open||libraryMobile.matches&&$('toggle-library').getAttribute('aria-expanded')==='true')return;
 const id=cueId??visibleReadingCue()??readingViews.get(doc.key)?.cueId??doc.segments[0]?.id;
 if(doc.segments.some(cue=>cue.id===id))readingViews.record(doc.key,id,readingMode);
}
function restoreReadingView(doc,{focus=true}={}){
 if(!doc||active()!==doc||Coconut.isAudioProject(doc))return false;
 const view=readingViews.get(doc.key),index=doc.segments.findIndex(cue=>cue.id===view?.cueId);
 if(index<0)return false;
 readingViews.record(doc.key,view.cueId,view.mode);
 readingMode=view.mode;pageStart=Math.floor(index/PAGE_SIZE)*PAGE_SIZE;
 passageDocumentKey=doc.key;passageAnchor=view.cueId;
 render();
 const node=view.mode==='summary'?$('title'):chapterCueNode(view.cueId,view.mode);
 if(node){
  if(view.mode==='passages')node.tabIndex=-1;
  // Align the actual source text. Aligning a transcript section's border below
  // the sticky toolbar leaves the preceding section's tail visible, which can
  // become a different saved cue on the next navigation or reload.
  const target=view.mode==='transcript'?node.querySelector('.words')||node:node;
  scrollReadingTarget(target,{block:'start',behavior:'auto'});if(focus)node.focus({preventScroll:true});
 }
 return true;
}
function switchTranscriptView(bilingual){
 const doc=active();if(!doc||bilingual&&(!contentIngressAllowed(doc)||Coconut.isAudioProject(doc)))return;
 const anchor=selected||readingContext?.document===doc&&readingContext.id||searchFocusedId||visibleReadingCue();
 if(contentIngressAllowed(doc)){
  recordReadingDisplaySelection(doc);
  const target=bilingual?doc.translation_view||$('translation-target').value||'zh':'';
  if((doc.translation_view||'')!==target){doc.translation_view=target;queueDocument(doc);}
 }
 const filtered=doc.segments.filter(cue=>matchesReadingSegment(cue,doc,$('search').value.trim().toLocaleLowerCase()));
 const index=filtered.findIndex(cue=>cue.id===anchor);
 if(index>=0)pageStart=Math.floor(index/PAGE_SIZE)*PAGE_SIZE;
 setReadingMode('transcript');render();
 const row=[...$('transcript').querySelectorAll('.segment')].find(node=>node.dataset.segmentId===anchor);
 if(row){scrollReadingTarget(row,{block:'start',behavior:'auto'});row.focus({preventScroll:true});}
 rememberReadingView({cueId:anchor});
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
 openPassage(cueId||visibleReadingCue()||passageAnchor||doc.readingPosition||doc.segments[0]?.id);
};
$('mode-summary').onclick=()=>{rememberReadingView();setReadingMode('summary');rememberReadingView();};
$('mode-transcript').onclick=()=>switchTranscriptView(false);
$('mode-bilingual').onclick=()=>switchTranscriptView(true);
$('prepare-bilingual').onclick=()=>{closeSummaryRequest(false);$('ai-task').value='translation';$('ai-task').dispatchEvent(new Event('change'));$('language-panel').open=true;$('ai-task').scrollIntoView?.({block:'center',behavior:'smooth'});$('translation-target').focus();};
$('summary-open-transcript').onclick=()=>{setReadingMode('transcript');focusReadingSearch();};
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
 focusReadingSearch();
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
// One chooser serves candidate reopening and explicit association changes.
// v1 is a bounded candidate, never proof that every byte is the same.
function chooseLocalMediaProject(matches,canCommit,{allowNew=false,current=null,action='attach',fileName=''}={}){
 pendingLocalMediaChoice?.(null);
 return new Promise(resolve=>{
  const dialog=$('local-media-project-dialog'),host=$('local-media-project-options');host.replaceChildren();let settled=false;
  const finish=choice=>{if(settled)return;settled=true;pendingLocalMediaChoice=null;dialog.removeEventListener('close',cancel);dialog.removeEventListener('cancel',cancel);if(dialog.open)dialog.close();resolve(canCommit()?choice:null);};
  const cancel=event=>{if(event?.type==='close'&&dialog.open)return;event?.preventDefault();finish(null);};
  pendingLocalMediaChoice=finish;
  $('local-media-project-heading').textContent=action==='unlink'?'解除这篇文字稿的文件关联':current?'选择文件关联方式':'选择这个文件对应的项目';
  $('local-media-project-hint').textContent=action==='unlink'?'只解除「'+current.local_media_source.name+'」与本篇的关联，并清除旧文件校准、时长与收听续点。文字稿、笔记、时间书签和历史摘录保留；不会删除原文件。':
   (current?'本次文件：「'+fileName+'」。':'')+'文件信息与部分内容只是候选匹配，未完整核验内容。请选择是否使用本次文件，文字稿与笔记不会合并。'+(action==='replace'?'更换本篇关联会清除旧校准、时长与收听续点；文字、笔记、时间书签和历史摘录保留。':'已有偏移不会自动清除；打开后请核对，可恢复零偏移并保存。');
  const currentButton=$('local-media-current-project');currentButton.hidden=!current;
  currentButton.textContent=action==='unlink'?'解除关联，保留文字稿与笔记':action==='replace'?'更换本篇关联并清除旧校准':'关联到当前文字稿，保留本篇笔记';
  currentButton.onclick=()=>finish({action:'current',document:current});
  for(const doc of matches){
   const snapshot=localMediaBindingSnapshot(doc);
   const button=el('button','',doc.title);button.type='button';button.dataset.documentKey=doc.key;
   button.append(el('small','',Coconut.isAudioProject(doc)?'打开已有原声项目并使用本次文件': '打开已有文字稿并使用本次文件'));
   const count=Coconut.projectAnnotationCount(doc)+Coconut.segmentNoteCount(doc);
   button.append(el('small','',(Coconut.isAudioProject(doc)?'原声项目':doc.segments.length+' 段文字稿')+' · '+count+' 项笔记与书签'));
   if(doc.media_timing)button.append(el('small','', '当前回听偏移 '+doc.media_timing.offset+' 秒；使用本次文件后请核对，可重置。'));
   const preview=Coconut.hasNoteContent(doc.project_note)?doc.project_note:doc.segments.map(cue=>doc.notes?.[cue.id]).find(Coconut.hasNoteContent)||doc.timestamp_bookmarks?.find(item=>Coconut.hasNoteContent(item.note))?.note;
   if(preview)button.append(el('small','',preview.slice(0,100)));
   button.onclick=()=>{
    if(!canCommit())return finish(null);
    if(!contentIngressAllowed(doc)||localMediaBindingSnapshot(doc)!==snapshot){finish(null);notice('候选项目的来源已经改变，请重新选择文件。未更改任何关联。');return;}
    finish({action:'existing',document:doc,source:snapshot});
   };host.append(button);
  }
  $('new-local-media-project').hidden=!allowNew;$('new-local-media-project').onclick=()=>finish({action:'new'});
  $('cancel-local-media-project').textContent=action==='unlink'?'取消解除':'取消打开';
  $('cancel-local-media-project').onclick=cancel;dialog.addEventListener('close',cancel);dialog.addEventListener('cancel',cancel);dialog.showModal();$('cancel-local-media-project').focus();
 });
}
async function openLocalMediaDocument(file,media,source,existing,expectedSource=null){
 if(existing&&(existing.local_media_source?.fingerprint!==source.fingerprint||expectedSource!==null&&localMediaBindingSnapshot(existing)!==expectedSource))throw new Error('候选项目的来源已经改变，请重新选择文件');
 if(existing&&mediaTimingDraft(existing)&&mediaTimingDraft(existing).identity!==media.identity&&blockMediaTimingMutation(existing))return;
 if(existing&&!contentIngressAllowed(existing))throw new Error('这个项目正在移除或恢复，请稍候再打开');
 const doc=existing||{...Coconut.validate({project_kind:'audio_only',title:file.name,local_media_source:source,segments:[]}),key:'local-'+crypto.randomUUID()};
 const nextURL=URL.createObjectURL(file);
 resetReaderForDocumentNavigation();
 if(!existing)state.documents.push(doc);
 const key=doc.key,previous=browserMedia.get(key);changeMediaSelection(key);
 browserMedia.set(key,{url:nextURL,...media,name:file.name,origin:'local',file});selectedRememberedMedia(doc);
 if(previous)releaseMediaAttachment(previous);
 selectActiveDocument(key);workspace='read';setReadingMode(Coconut.isAudioProject(doc)?'transcript':prefersPassageReading(doc)?'passages':'transcript');mediaExpandedKey=key;mediaCollapsedKey=null;render();
 // Navigation owns this scroll now, never a later save receipt.
 $('title').scrollIntoView?.({block:'start'});$('title').focus({preventScroll:true});
 const selection=activeSelectionRevision,receipt=existing?{ok:true,identity:doc}:await commitDocument(doc);
 if(active()===doc)renderRememberedMedia(doc);
 if(active()===doc&&workspace==='read'&&activeSelectionRevision===selection&&browserMedia.get(key)?.url===nextURL&&contentIngressAllowed(doc))notice(receipt.ok?(existing?'已打开原有项目，笔记和文字稿保留。':'本地原声项目已保存，可直接回听、写笔记和时间书签。')+'文件未上传，未运行识别或 AI；请自行点击播放。':'项目已在本页打开，但尚未保存。请先导出 JSON 备份；媒体文件需另行保留。',receipt.ok?'success':'');
}
$('local-media-file').addEventListener('cancel',()=>{localMediaPickerTarget=null;});
$('open-local-media').onclick=()=>{
 if(!contentIngressAllowed())return;
 cancelLocalImports('local-media-file');localMediaPickerTarget={revision:localImportRevision,selection:activeSelectionRevision,lifecycle:documentLifecycleRevision,workspace};$('local-media-file').click();
};
$('local-media-file').onchange=async()=>{
 const input=$('local-media-file'),file=input.files[0],target=localMediaPickerTarget;localMediaPickerTarget=null;
 if(!file)return;
 if(!target){input.value='';return;}
 const revision=cancelLocalImports('local-media-file');
 const canCommit=()=>!!target&&revision===localImportRevision&&target.selection===activeSelectionRevision&&target.workspace===workspace&&contentIngressAllowed();
 try{
  if(!target||target.revision!==revision-1)throw new Error('文件选择已取消，请重新打开本地音视频');
  const media=await inspectLocalMedia(file);if(!canCommit())return;
  const source=await localMediaMetadata(file,media);if(!canCommit())return;
  const candidate=Coconut.validate({project_kind:'audio_only',title:file.name,local_media_source:source,segments:[]});
  if(await wasRemovedSince(candidate,target.lifecycle)||!canCommit())return;
  const matches=state.documents.filter(doc=>doc.local_media_source?.fingerprint===source.fingerprint);
  const needsChoice=matches.length>1||matches.some(doc=>!Coconut.isAudioProject(doc));
  const choice=needsChoice?await chooseLocalMediaProject(matches,canCommit,{allowNew:true}):matches[0]?{action:'existing',document:matches[0]}:{action:'new'};
  if(!canCommit()||!choice)return;
  await openLocalMediaDocument(file,media,source,choice.document,choice.source);
 }catch(error){if(revision===localImportRevision)notice('打开本地音视频失败：'+error.message);}
 finally{if(revision===localImportRevision)input.value='';}
};
function beginReaderMediaSelection(action='attach'){
 const doc=active();if(!doc||!contentIngressAllowed(doc)||action==='replace'&&(!canAssociateLocalMedia(doc)||!doc.local_media_source))return;
 if(action==='replace'&&blockMediaTimingMutation(doc))return;
 if(pendingMediaDocument)cancelReaderMediaSelection(pendingMediaDocument,{resume:false});
 const processing=pendingNativeMediaSelections.get(doc);if(processing)cancelReaderMediaSelection(processing,{resume:false});
 const durable=canAssociateLocalMedia(doc),reference=rememberedMediaState(doc)||rememberedMediaStates.get(doc);
 const nativeReference=reference?{entry:reference,suppressed:reference.suppressed,checked:reference.checked,pending:reference.pending}:null;
 if(reference){reference.revision++;reference.pending=false;reference.checked=true;nativeReference.revision=reference.revision;}
 if(durable)cancelLocalImports('reader-media-file');else pendingLocalMediaChoice?.(null);
 pendingMediaDocument={key:doc.key,document:doc,source:localMediaBindingSnapshot(doc),durable,action,nativeReference,selection:activeSelectionRevision,workspace,ingress:localImportRevision,request:++readerMediaRequestRevision,revision:changeMediaSelection(doc.key)};
 pendingNativeMediaSelections.set(doc,pendingMediaDocument);
 $('reader-media-file').click();
}
function cancelReaderMediaSelection(target=pendingMediaDocument,{resume=true}={}){
 if(pendingMediaDocument===target)pendingMediaDocument=null;
 if(!target||pendingNativeMediaSelections.get(target.document)!==target)return;
 pendingNativeMediaSelections.delete(target.document);
 if(mediaSelectionRevision(target.key)!==target.revision||localMediaBindingSnapshot(target.document)!==target.source)return;
 const doc=target.document,entry=rememberedMediaStates.get(doc),previous=target.nativeReference;
 if(previous&&entry===previous.entry&&entry.revision===previous.revision){
  entry.revision++;entry.pending=false;entry.suppressed=previous.suppressed;
  entry.checked=previous.checked&&!previous.pending;
 }
 if(resume&&active()===doc){renderRememberedMedia(doc);queueRememberedMedia(doc);}
}
$('reader-media-file').addEventListener('cancel',()=>cancelReaderMediaSelection());
$('attach-reader-media').onclick=()=>beginReaderMediaSelection();
$('replace-reader-media').onclick=()=>beginReaderMediaSelection('replace');
// Only explicit reassociation/unlink clears file-owned clocks. Cue timestamps,
// bookmarks and immutable excerpt source snapshots always retain their meaning.
function clearLocalMediaClocks(doc){
 mediaTimingDrafts.delete(doc);
 if(active()===doc){passagePlayback?.cancel();stopRepeating();$('source-media').querySelector('audio,video')?.pause();if(listeningSession?.key==='coconut-listening-v1:'+doc.key)listeningSession=null;}
 delete doc.media_timing;delete doc.media_duration;
 try{localStorage.removeItem('coconut-listening-v1:'+doc.key);return true;}catch{return false;}
}
$('reader-media-file').onchange=async()=>{
 const input=$('reader-media-file'),file=input.files[0],target=pendingMediaDocument;pendingMediaDocument=null;
 if(!file){cancelReaderMediaSelection(target);return;}
 if(!target){input.value='';return;}
 const key=target?.key,revision=target?.revision;let nextURL,installed=false;
 const ownsDocument=()=>target&&contentIngressAllowed(target.document)&&state.documents.find(doc=>doc.key===key)===target.document&&mediaSelectionRevision(key)===revision;
 const ownsView=()=>!target?.durable||active()===target.document&&workspace===target.workspace&&activeSelectionRevision===target.selection&&localImportRevision===target.ingress;
 const canCommit=()=>ownsDocument()&&ownsView()&&localMediaBindingSnapshot(target.document)===target.source;
 try{
  if(!target||!canCommit())throw new Error('原文字稿已关闭，请重新选择');
  const media=await inspectLocalMedia(file);if(!canCommit())return;
  let source;
  if(target.document.local_media_source||target.durable){
   source=await localMediaMetadata(file,media);if(!canCommit())return;
   if(target.document.local_media_source&&target.action!=='replace'&&source.fingerprint!==target.document.local_media_source.fingerprint)throw new Error('文件信息或部分内容与原文件不同。请重新选择「'+target.document.local_media_source.name+'」'+(target.durable?'，或用“更换关联文件”明确换绑。':'；若要打开另一份文件，请从「添加内容」打开本地音视频。')+'现有笔记与书签未改变');
  }
  const associating=target.durable&&(!target.document.local_media_source||target.action==='replace');
  if(associating){
   const matches=state.documents.filter(doc=>doc!==target.document&&doc.local_media_source?.fingerprint===source.fingerprint);
   if(matches.length||target.action==='replace'){
    const choice=await chooseLocalMediaProject(matches,canCommit,{current:target.document,action:target.action,fileName:file.name});
    if(!choice||!canCommit())return;
    if(choice.action==='existing'){await openLocalMediaDocument(file,media,source,choice.document,choice.source);return;}
   }
  }
  if(mediaTimingDraft(target.document)&&(target.action==='replace'||mediaTimingDraft(target.document).identity!==media.identity)&&blockMediaTimingMutation(target.document))return;
  nextURL=URL.createObjectURL(file);if(!canCommit()){URL.revokeObjectURL(nextURL);nextURL=null;return;}
  const doc=target.document,previous=browserMedia.get(key),replacement=target.action==='replace'?beginRememberedReplacement(doc):null;let clocksCleared=true;
  if(target.action==='replace')clocksCleared=clearLocalMediaClocks(doc);
  else if(key===active()?.key){flushListening(true);stopRepeating();$('source-media').querySelector('audio,video')?.pause();}
  if(associating)doc.local_media_source=source;
  browserMedia.set(key,{url:nextURL,...media,name:file.name,origin:'local',file,...(!clocksCleared?{ignoreListeningRecord:true}:{})});installed=true;selectedRememberedMedia(doc);if(previous)releaseMediaAttachment(previous);
  if(key===active()?.key){mediaExpandedKey=key;mediaCollapsedKey=null;render();}
  const saving=associating?commitDocument(doc):Promise.resolve({ok:true});
  if(replacement)replacement.generation=libraryStore.status(doc.key)?.generation||0;
  const receipt=await saving;
  let referenceRetired=true;
  if(replacement){
   if(receipt.ok)referenceRetired=await finishRememberedReplacement(replacement);
   else if(pendingRememberedReplacements.get(doc.key)===replacement)replacement.phase='save-failed';
  }
  if(active()===doc)renderRememberedMedia(doc);
  if(ownsDocument()&&ownsView()&&active()===doc&&browserMedia.get(key)?.url===nextURL)notice(associating?(receipt.ok?'文件关联已保存，文字稿与笔记保留；刷新后需重新选择文件。':'文件关联仅在本页应用，尚未保存。请重试保存或导出 JSON 备份；媒体文件需另行保留。')+(referenceRetired?'':'旧原文件引用取消失败，重启仍可能载入之前记住的原文件；请点“不再记住”重试。')+'未上传文件；文件信息与部分内容并非完整核验，请自行核对并播放。'+(clocksCleared?'':'旧收听续点未能清除，请勿直接恢复旧位置。'):'媒体只在本次页面读取，未上传。'+(doc.local_media_source?'文件信息与部分内容匹配并非完整核验，请核对声音；':'请自行核对声音与文字稿对应；')+'未自动播放。',receipt.ok?'success':'');
 }catch(error){if(nextURL&&!installed)URL.revokeObjectURL(nextURL);if(!target||ownsDocument()&&ownsView()&&active()===target.document)notice('打开媒体失败：'+error.message);}
 finally{
  if(target&&pendingNativeMediaSelections.get(target.document)===target){
   if(installed)pendingNativeMediaSelections.delete(target.document);else cancelReaderMediaSelection(target);
  }
  if(!target||target.request===readerMediaRequestRevision)input.value='';
 }
};
$('detach-reader-media').onclick=()=>{
 const key=active()?.key,attachment=browserMedia.get(key);if(!attachment||blockMediaTimingMutation(active()))return;
 changeMediaSelection(key);suppressRememberedMedia(active(),{detached:true});pendingLocalMediaChoice?.(null);
 flushListening(true);stopRepeating();$('source-media').querySelector('audio,video')?.pause();browserMedia.delete(key);releaseMediaAttachment(attachment);render();
};
$('unlink-reader-media').onclick=async()=>{
 const doc=active();if(!canAssociateLocalMedia(doc)||!doc.local_media_source||!contentIngressAllowed(doc)||blockMediaTimingMutation(doc))return;
 cancelLocalImports();pendingMediaDocument=null;readerMediaRequestRevision++;
 const source=localMediaBindingSnapshot(doc),selection=activeSelectionRevision,ingress=localImportRevision,revision=changeMediaSelection(doc.key);
 const owns=()=>active()===doc&&workspace==='read'&&activeSelectionRevision===selection&&localImportRevision===ingress&&mediaSelectionRevision(doc.key)===revision&&contentIngressAllowed(doc);
 const canCommit=()=>owns()&&localMediaBindingSnapshot(doc)===source;
 const choice=await chooseLocalMediaProject([],canCommit,{current:doc,action:'unlink'});if(!choice||!canCommit()||blockMediaTimingMutation(doc))return;
 const clocksCleared=clearLocalMediaClocks(doc),attachment=browserMedia.get(doc.key);
 delete doc.local_media_source;browserMedia.delete(doc.key);if(attachment)releaseMediaAttachment(attachment);
 mediaExpandedKey=doc.key;mediaCollapsedKey=null;render();$('attach-reader-media').focus();const receipt=await commitDocument(doc);
 if(owns())notice((receipt.ok?'已解除文件关联并保存，文字稿、笔记和历史摘录保留。':'解除关联仅在本页应用，尚未保存；请重试保存或导出 JSON 备份。')+(clocksCleared?'':'旧收听续点未能清除，请勿直接恢复旧位置。'),receipt.ok?'success':'');
};

$('attach-project-transcript').onclick=()=>{const doc=active();if(Coconut.isAudioProject(doc)){projectTranscriptTarget={key:doc.key,document:doc,source:projectSourceSnapshot(doc)};$('project-transcript-file').click();}};
$('project-transcript-file').onchange=async()=>{
 const input=$('project-transcript-file'),file=input.files[0],target=projectTranscriptTarget;projectTranscriptTarget=null;
 if(!file)return;
 const revision=cancelLocalImports('project-transcript-file');
 let warningBatch=null;
 const ownsRequest=()=>revision===localImportRevision;
 const canCommit=()=>ownsRequest()&&state.active===target?.key&&workspace==='read'&&state.documents.find(doc=>doc.key===target.key)===target.document;
 try{
  if(!target)throw new Error('请从目标原声项目重新选择文字稿');
  const review=localFileReview(file,canCommit);
  if(review!==true&&!(await review))return;
  if(!canCommit())return;
  const value=await readTranscriptFile(file,canCommit);
  if(value===null)return;
  if(!canCommit())return;
  const {document:text,diagnostics}=Coconut.parseWithDiagnostics(value,file.name);
  if(diagnostics.length){warningBatch=createTranscriptImportBatch([file]);setTranscriptImportDiagnostics(warningBatch.items[0],diagnostics);warningBatch.items[0].status='saving';renderTranscriptImportBatch(warningBatch);}
  const persisted=await attachTranscriptToProject(text,target);
  if(warningBatch)finishTranscriptImportReceipt(warningBatch.items[0],persisted);
  if(ownsRequest()&&active()===persisted.identity&&contentIngressAllowed(persisted.identity))notice((persisted.ok?'文字稿已附加到当前项目，原有笔记、时间书签与媒体保留。未调用识别、翻译或摘要模型。':'文字稿已在本页附加，但未能保存，请立即导出 JSON 备份。')+(diagnostics.length?transcriptImportWarningNotice(diagnostics):''));
 }catch(error){
  if(warningBatch){const item=warningBatch.items[0];item.status=canCommit()?'failed':'cancelled';if(item.status==='failed')item.error=localFileError(error);}
  if(ownsRequest())notice('补充文字稿失败：'+localFileError(error));
 }
 finally{if(warningBatch){warningBatch.finished=true;renderTranscriptImportBatch(warningBatch);}if(ownsRequest())input.value='';}
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
 // Supplementing this exact project's transcript preserves its existing native
 // consent; it is not a portable backup import or a new document lifetime.
 const replacement=pendingRememberedReplacements.get(original.key);if(replacement?.document===original)replacement.document=attached;
 const reference=rememberedMediaStates.get(original);
 if(reference&&!reference.pending){rememberedMediaStates.set(attached,{...reference,revision:reference.revision+1});rememberedMediaStates.delete(original);}
 if(persistedLocalMediaSources.has(original))persistedLocalMediaSources.set(attached,persistedLocalMediaSources.get(original));
 if(detachedRememberedMedia.has(original))detachedRememberedMedia.add(attached);
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
 if(hasMediaTimingDrafts()||pastedSubtitleHasDraft()||quotationController?.hasDraft()||exactNoteDraft()||sourceCorrectionDraft()||speakerCorrectionDraft()||collectionTitleDraft()||chapterDraft())return true;
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

restoreReadingView(active(),{focus:false});

// Bootstrap can still be admitting language scripts; do not race its ingress
// barrier or offer a reference before the coherent library is ready.
if(!window.CoconutStorageBootstrap||window.CoconutStorageBootstrap.phase==='ready')nativeMediaInitialization=initializeRememberedMedia();
else window.addEventListener('coconut-storage-ready',()=>{nativeMediaInitialization=initializeRememberedMedia();},{once:true});
