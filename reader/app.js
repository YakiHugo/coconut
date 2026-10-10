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
let removalFocusKey = null;
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
let selected = null;
let notesOnly = false;
let excerptsOnly = false;
let speakerFilter = null;
function matchesReadingSegment(segment,doc,query){return (speakerFilter===null||(segment.speaker||'')===speakerFilter)&&Coconut.matchesSegment(segment,doc,query,notesOnly,excerptsOnly);}
let searchFocusedId=null;
// A temporary detour, never a persisted reading position or an AI selection.
let readingContext=null;
let workspace = "read";
let readingScroll = 0;
let editingTarget = null;
let sourceTarget = null;
let localImportRevision = 0;
let projectTranscriptTarget = null;
let pendingBackupReview = null;
function cancelLocalImports(keepInput = null) {
 localImportRevision++;
 pendingBackupReview?.(false);
 if(keepInput!=="project-transcript-file")projectTranscriptTarget=null;
 // Retire all import paths while preserving a newly selected input's file.
 for(const id of ["file", "library-file", "project-transcript-file"])if(id!==keepInput)$(id).value = "";
 return localImportRevision;
}
window.addEventListener("pagehide", () => cancelLocalImports());
function backupSize(bytes){return (bytes/1024/1024).toFixed(2)+' MiB';}
function localFileReview(file, canCommit, library = false) {
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
   $('continue-large-backup').onclick=null;$('cancel-large-backup').onclick=null;
   pendingBackupReview=null;if(dialog.open)dialog.close();
   const accepted=proceed&&canCommit();
   if(accepted)notice('正在完整读取 '+backupSize(file.size)+' 的备份，请稍候；请保留原备份文件。');
   resolve(accepted);
  };
  const cancel=event=>{
   // Native dialog.close() queues its event. An earlier selection's queued
   // close must not dismiss a newer review that is already open.
   if(event?.type==='close'&&dialog.open)return;
   event?.preventDefault();finish(false);
  };
  pendingBackupReview=finish;
  $('large-backup-size').textContent='文件大小：'+backupSize(file.size)+'（通常直接读取的预算为50 MiB）。';
  $('continue-large-backup').onclick=()=>finish(true);$('cancel-large-backup').onclick=cancel;
  dialog.addEventListener('close',cancel);dialog.addEventListener('cancel',cancel);
  dialog.showModal();$('cancel-large-backup').focus();
 });
}
function localFileError(error) {
 if(['RangeError','NotReadableError','AbortError'].includes(error?.name))return '读取或处理文件失败，可能超出当前设备可用内存。请保留原备份，在内存更充足的浏览器或电脑上重试。';
 return error.message;
}
function backupRecoveryHint(blob){return blob.size>Coconut.BACKUP_REVIEW_BYTES?' 文件为'+backupSize(blob.size)+'，恢复时需要确认继续读取；需要足够可用内存，浏览器可能无法自动保存，请保留下载文件。':'';}

const PAGE_SIZE = 100;
let pageStart = 0;
let storageBlocked = false;
let lastSavedValue = null;
let savedDocumentsValue = "[]";
let unsavedDocumentChanges = false;
let unloadGuardReady = false;
let unloadGuardAttached = false;
let hasLanguageDrafts = () => false;
const audioBookmarkDrafts = new Map();
const persistedSummaries = new Map();
let persistedAIAnswerCounts = new WeakMap();
const persistedSummaryJobs = new Map();
function summaryCheckpointSignature(job){return job?JSON.stringify([job.provider,job.snapshot,job.results]):null;}
function summaryCheckpointSaved(doc){return !!doc?.summary_job&&persistedSummaryJobs.get(doc.key)===summaryCheckpointSignature(doc.summary_job);}
function recordPersistedSummaries() {
 // Answer arrays are append-only; capture counts only after a successful write.
 // Rebuild by document identity so replacement/restored documents cannot inherit it.
 persistedAIAnswerCounts = new WeakMap(state.documents.map(doc=>[doc,(doc.ai_answers||[]).length]));
 persistedSummaries.clear();persistedSummaryJobs.clear(); for(const doc of state.documents){persistedSummaries.set(doc.key,Coconut.latestSummary(doc));persistedSummaryJobs.set(doc.key,summaryCheckpointSignature(doc.summary_job));} }
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

function saveWarning(text = "") {
 $("save-status").hidden = !text;
 $("save-status").textContent = text;
 unsavedDocumentChanges = !!text && JSON.stringify(state.documents)!==savedDocumentsValue;
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

try {
	lastSavedValue = localStorage.getItem(KEY);
	const stored = JSON.parse(lastSavedValue || "null");
	if (
		stored &&
		(!Array.isArray(stored.documents) ||
			stored.documents.some((d) => !d || typeof d.key !== "string"))
	)
		throw new Error("Invalid saved library");
	if (stored && Array.isArray(stored.documents)) {
		state = {
			documents: stored.documents.map((d) => ({
				...d,
				...Coconut.validate(d),
			})),
			active: stored.active,
		};
	}
 recordPersistedSummaries();
} catch {
	storageBlocked = true;
 saveWarning("自动保存已暂停，原有数据未覆盖。关闭前请逐份导出本页修改过的文字稿与笔记。");
	notice(
		"上次保存的数据无法读取，已停止写入以保留原数据。本次内容可继续阅读，请导出备份后再关闭页面。",
	);
}
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
function selectActiveDocument(key) {
 state.active=state.documents.some(doc=>doc.key===key)?key:state.documents[0]?.key||null;
 rememberActiveDocument();
}
let windowActive=null,lastActive=null;
try { windowActive=sessionStorage.getItem(ACTIVE_KEY); } catch {}
try { lastActive=localStorage.getItem(LAST_ACTIVE_KEY); } catch {}
selectActiveDocument([windowActive,lastActive,state.active].find(key=>state.documents.some(doc=>doc.key===key)));
// Compare validated in-memory documents, not active-tab navigation or unread storage.
savedDocumentsValue = JSON.stringify(state.documents);
function save() {
 // Approved native discard must not persist late async results during teardown.
 if(readerClosing)return false;
	if (storageBlocked) {
  saveWarning("自动保存已暂停，原有数据未覆盖。关闭前请逐份导出本页修改过的文字稿与笔记。");
		notice(
			"自动保存已暂停，原有数据未覆盖。请导出本次文字稿与笔记后再关闭页面。",
		);
		return false;
	}
	try {
		if (localStorage.getItem(KEY) !== lastSavedValue) {
			storageBlocked = true;
   saveWarning("另一个页面更新了书架，本页自动保存已暂停。先逐份导出本页修改，再刷新；否则修改可能丢失。");
			notice("另一个页面更新了书架，已暂停保存以避免覆盖。请先导出本页修改，再刷新读取最新数据。");
			return false;
		}
		const nextValue = JSON.stringify({documents:state.documents});
		localStorage.setItem(KEY, nextValue);
		lastSavedValue = nextValue;
  savedDocumentsValue = JSON.stringify(state.documents);
  recordPersistedSummaries();
  saveWarning();
		return true;
	} catch {
  saveWarning("修改尚未保存到浏览器。请逐份导出本页修改过的文字稿与笔记，暂时不要关闭或刷新页面。");
		notice("浏览器保存空间不足或被禁用；当前内容仍在本页，请及时导出备份。");
		return false;
	}
}
function active() {
	return state.documents.find((d) => d.key === state.active);
}
function el(tag, className, text) {
	const n = document.createElement(tag);
	if (className) n.className = className;
	if (text !== undefined) n.textContent = text;
	return n;
}
async function add(doc, canCommit = null, reuseAudioSource = false, lifecycleRevision = documentLifecycleRevision, sourceKey = doc.key) {
	const bytes = new TextEncoder().encode(JSON.stringify(doc));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	let key = Array.from(new Uint8Array(digest))
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("");
 if(await wasRemovedSince(doc,lifecycleRevision,key) || (removedDocumentRevisions.get(sourceKey)||0)>lifecycleRevision || canCommit && !canCommit())throw new Error("导入已取消，书架未改变");
 // A repeated source save refreshes recoverable source metadata, preserving
 // user-owned title, language, notes, bookmark IDs and the stable library key.
 const identity=reuseAudioSource?Coconut.audioProjectIdentity(doc):'';
 // Match the complete validated backup, just like whole-library restore. The
 // original hash remains the first choice when reopening an unedited source;
 // otherwise an exported edited snapshot should reuse the same library entry.
 if(!identity&&!state.documents.some(d=>d.key===key)){
  const fingerprint=JSON.stringify(Coconut.validate(doc));
  const matching=state.documents.find(d=>JSON.stringify(Coconut.validate(d))===fingerprint);
  if(matching)key=matching.key;
 }
 const existing=identity&&state.documents.find(d=>Coconut.audioProjectIdentity(d)===identity);
 if(existing){
  key=existing.key;
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
	if (!state.documents.some((d) => d.key === key))
		state.documents.push({ ...doc, key, notes: doc.notes || {} });
	selectActiveDocument(key);
 passageReturn=null;passageDocumentKey=key;passageAnchor=active()?.segments[0]?.id||null;mediaExpandedKey=null;
 setReadingMode(prefersPassageReading(active())?"passages":"summary");
 searchFocusedId=null;
	$("search").value = "";
	selected = null;
	pageStart = 0;
	notesOnly = false; excerptsOnly = false; speakerFilter=null;
	workspace = "read";
	const saved = save();
	render();
	return saved;
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
 if(readingContext?.key!==active()?.key)readingContext=null;
 const origin=readingContext;
 $('reading-context').hidden=!origin||workspace!=='read'||readingMode==='summary';
 if(origin)$('reading-context-label').textContent=origin.label+' · 第 '+(origin.index+1)+' / '+origin.count+' 个结果';
}
function openReadingContext(id) {
 const doc=active(),query=$('search').value;
 if(!doc||(!query.trim()&&!notesOnly&&!excerptsOnly&&speakerFilter===null))return;
 const matches=doc.segments.filter(s=>matchesReadingSegment(s,doc,query.trim().toLocaleLowerCase()));
 const index=matches.findIndex(s=>s.id===id);if(index<0)return;
 const row=[...$('transcript').querySelectorAll('.segment')].find(node=>node.dataset.segmentId===id);
 const labels=[query.trim()?'搜索“'+query.trim()+'”':'',excerptsOnly?'摘录':'',notesOnly?'笔记':'',speakerFilter!==null?'说话人：'+(speakerFilter||'未标注'):''].filter(Boolean);
 readingContext={key:doc.key,id,index,count:matches.length,label:labels.join(' · '),query,notesOnly,excerptsOnly,speakerFilter,pageStart,translationView:doc.translation_view||'',viewportTop:row?.getBoundingClientRect().top};
 $('ai-consent').checked=false;
 goToSegment(id,true);
}
function returnReadingResults() {
 const origin=readingContext,doc=active();clearReadingContext();
 if(!origin||doc?.key!==origin.key)return;
 $('search').value=origin.query;notesOnly=origin.notesOnly;excerptsOnly=origin.excerptsOnly;speakerFilter=origin.speakerFilter;
 // Display choice can change during the detour; restore the original view without
 // reverting source edits, annotations, or the user's explicit reading bookmark.
 if((doc.translation_view||'')!==origin.translationView){doc.translation_view=origin.translationView;save();}
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
 const row=[...$('transcript').querySelectorAll('.segment')].find(node=>node.dataset.segmentId===id);
 (row||$('search')).focus({preventScroll:true});
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
 const row=[...$('library').children].find(node=>node.dataset.documentKey===key);
 // Undo can run with the mobile shelf or its organizing controls collapsed.
 // Restore focus to an available action, never a hidden removal button.
 $('toggle-library').setAttribute('aria-expanded','true');
 (row?.querySelector($('library-options').open?'.library-remove':'.library-open')||$('library-search')).focus();
}
function syncLibraryRemovalControls() {
 for(const button of $('library').querySelectorAll('.library-remove'))button.hidden=!$('library-options').open;
}
$('library-options').addEventListener('toggle',syncLibraryRemovalControls);
function renderRemovalRecovery() {
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
 if(!state.documents.includes(doc))return;
 removalTarget=doc;removalFocusKey=doc.key;
 $('remove-document-title').textContent=doc.title;
 $('remove-document-error').textContent='';delete $('remove-document-error').dataset.kind;
 $('replace-removal-warning').hidden=!removedDocument;
 $('replace-removal-warning').textContent=removedDocument?'继续移除将结束上一篇“'+removedDocument.doc.title+'”的撤销，且不再保留它的本页副本。可取消，或先导出上一篇备份。':'';
 $('export-previous-removal').hidden=!removedDocument;
 $('remove-document-dialog').showModal();$('cancel-removal').focus();
}
$('cancel-removal').onclick=()=>{$('remove-document-dialog').close();};
$('remove-document-dialog').addEventListener('close',()=>{const confirmed=removalTarget===null;removalTarget=null;if(confirmed&&removedDocument)$('undo-removal').focus();else focusLibraryRemoval(removalFocusKey);});
$('confirm-removal').onclick=()=>{
 const doc=removalTarget;if(!doc||!state.documents.includes(doc))return;
 captureAudioBookmarkDrafts();
 const bookmarkDraft=audioBookmarkDrafts.get(doc.key);
 const previous=state,index=state.documents.indexOf(doc);
 // Clone before changing state: late AI results cannot mutate the recovery copy.
 const snapshot=JSON.parse(JSON.stringify(doc));
 state={...state,documents:state.documents.filter(item=>item!==doc),active:state.active===doc.key?null:state.active};
 if(!state.active)state.active=state.documents[Math.min(index,state.documents.length-1)]?.key||null;
 if(!save()){
  state=previous;saveWarning('移除未保存，原书架仍在。请先导出需要保留的内容，再重试。');
  $('remove-document-error').textContent='未能保存移除，书架未改变。请先备份，再重试。';delete $('remove-document-error').dataset.kind;return;
 }
 if(previous.active!==state.active)rememberActiveDocument();
 removedDocument={doc:snapshot,index,wasActive:previous.active===doc.key,bookmarkDraft};
 audioBookmarkDrafts.delete(doc.key);
 // Retire the old DOM owner before undo can restore the same key with a new identity.
 if($('audio-project').dataset.documentKey===doc.key){
  delete $('audio-project').dataset.documentKey;$('audio-bookmark-form').reset();$('audio-bookmarks').replaceChildren();
 }
 $('removal-recovery-details').open=false;$('removal-recovery-error').hidden=true;$('removal-export-error').hidden=true;
 documentLifecycleRevision++;removedDocumentRevisions.set(doc.key,documentLifecycleRevision);
 removedDocumentAliases.push({revision:documentLifecycleRevision,source:documentSourceIdentity(snapshot),signature:libraryDocumentSignature(snapshot).catch(()=>null)});
 changeMediaSelection(doc.key);
 if(projectTranscriptTarget?.key===doc.key)projectTranscriptTarget=null;
 window.dispatchEvent(new CustomEvent('coconut-document-removed',{detail:{key:doc.key}}));
 if(previous.active===doc.key){
  resetReaderForDocumentNavigation();
  $('source-media').replaceChildren();$('source-media').hidden=true;listeningSession=null;renderListeningResume();
  setReadingMode(prefersPassageReading(active())?'passages':'summary');workspace=active()?'read':'add';
 }
 const attachment=browserMedia.get(doc.key);if(attachment){browserMedia.delete(doc.key);URL.revokeObjectURL(attachment.url);}
 removalTarget=null;$('remove-document-dialog').close();render();renderRemovalRecovery();
 $('toggle-library').setAttribute('aria-expanded','false');
 notice('已从保存的书架移除。可在本页撤销或导出这份备份；刷新、关闭或离开页面后不能撤销。','success');
 $('undo-removal').focus();
};
$('undo-removal').onclick=()=>{
 const recovery=removedDocument;if(!recovery)return;
 const previous=state;
 // A new identity object retires callbacks created before removal, even with the same key.
 const doc=JSON.parse(JSON.stringify(recovery.doc));
 if(state.documents.some(item=>item.key===doc.key)){showRemovalRecoveryError('书架中已有同编号内容。请先导出备份，再通过添加文件恢复。');notice('书架中已有同编号内容。请导出移除备份，再通过添加文件恢复；不同版本会分别保留。');return;}
 const documents=[...state.documents];documents.splice(Math.min(recovery.index,documents.length),0,doc);
 state={...state,documents,active:recovery.wasActive?doc.key:state.active||doc.key};
 if(!save()){
  state=previous;saveWarning('撤销尚未保存。移除的完整备份仍在本页，请重试撤销或导出移除备份，暂时不要关闭页面。');
  showRemovalRecoveryError('撤销未保存。可重试或先导出备份，暂时不要离开本页。');
  notice('撤销未成功，完整内容仍保留在本页恢复区。请导出移除备份，或释放空间后重试。');return;
 }
 const changedActive=previous.active!==state.active;
 if(changedActive)rememberActiveDocument();
 if(recovery.bookmarkDraft)audioBookmarkDrafts.set(doc.key,recovery.bookmarkDraft);
 window.dispatchEvent(new CustomEvent('coconut-document-restored',{detail:{key:doc.key,glossaryDrafts:recovery.glossaryDrafts,translationReviewDrafts:recovery.translationReviewDrafts}}));
 removedDocument=null;
 if(changedActive){
  resetReaderForDocumentNavigation();
  workspace=active()?'read':'add';setReadingMode(prefersPassageReading(active())?'passages':'summary');
 }
 render();renderRemovalRecovery();
 if(active()===doc&&Coconut.hasProjectAnnotations(doc))$('audio-project-status').textContent='项目已恢复；未提交的书签草稿仅在本页，请保存或取消。';
 if(changedActive&&active()?.key===doc.key&&doc.readingPosition){if(prefersPassageReading(doc))openPassage(doc.readingPosition);else goToSegment(doc.readingPosition);}
 notice('已撤销移除，并保存完整文字稿、译文、笔记与阅读位置。','success');focusLibraryRemoval(doc.key);
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
 if(!removedDocument)return;
 $('finish-removal-dialog').showModal();$('cancel-finish-removal').focus();
};
$('export-previous-removal').onclick=()=>$('export-removed-document').onclick();
$('cancel-finish-removal').onclick=()=>{$('finish-removal-dialog').close();};
$('finish-removal-dialog').addEventListener('close',()=>{
 if(removedDocument){$('removal-recovery-details').open=true;$('finish-removal').focus();}
 else focusLibraryRemoval(null);
});
$('confirm-finish-removal').onclick=()=>{
 removedDocument=null;$('finish-removal-dialog').close();renderRemovalRecovery();notice('已结束本页撤销。如果另有 JSON 备份，以后可用“添加文件”恢复。');
};

function renderLibrary() {
	$("library").replaceChildren();
	const query = $("library-search").value.trim().toLocaleLowerCase();
	const docs = Coconut.sortedLibrary(state.documents, $("library-sort").value).filter(d => Coconut.libraryMatches(d,query,$("library-kind").value,$("library-scope").value));
	$("library-total").textContent = String(state.documents.length);
	$("library-empty").hidden = docs.length > 0;
	$("library-empty").textContent = state.documents.length ? "没有匹配的内容，可调整书架筛选或查找范围" : "还没有内容。添加一份，或体验示例。";
	for (const d of docs) {
		const entry=el("div","library-entry");entry.dataset.documentKey=d.key;
		const b = el("button", "library-open"+(d.key === state.active ? " active" : ""));
		b.append(el("span", "library-title", d.title));
		const bookmark = d.segments.find(s => s.id === d.readingPosition);
  const audioOnly=Coconut.isAudioProject(d),duration=Coconut.documentDuration(d);
  const metadata=audioOnly?['原声项目','未导入文字稿',duration?Coconut.time(duration):'时长待确认']:[Coconut.time(duration),Coconut.segmentNoteCount(d)+' 则片段笔记'];
  if(Coconut.hasProjectAnnotations(d))metadata.push((Coconut.hasNoteContent(d.project_note)?1:0)+' 则项目笔记',d.timestamp_bookmarks.length+' 个时间书签');
  if(bookmark)metadata.push('读到 '+Coconut.time(bookmark.start));
  b.append(el('small','',metadata.join(' · ')));
		b.setAttribute("aria-current", d.key === state.active ? "page" : "false");
		const openDocument = (hit=null) => {
   resetReaderForDocumentNavigation();selectActiveDocument(d.key);
   setReadingMode(prefersPassageReading(d)?"passages":"summary");
			$("toggle-library").setAttribute("aria-expanded", "false");
			showWorkspace("read");
			render();
			if(hit)openLibraryHit(hit);
			else if (bookmark){if(prefersPassageReading(d))openPassage(bookmark.id);else goToSegment(bookmark.id);}
			else $("title").scrollIntoView?.({block: "start"});
		};
		b.onclick=()=>openDocument();
  const remove=el('button','library-remove','移除…');remove.type='button';remove.setAttribute('aria-label','从书架移除 '+d.title);
  remove.hidden=!$('library-options').open;remove.onclick=()=>requestLibraryRemoval(d);
  entry.append(b,remove);
  const hits=Coconut.libraryHits(d,query,$('library-scope').value);
  if(hits.length){
   const list=el('div','library-hits');list.setAttribute('aria-label','匹配预览（最多 3 项）');
   for(const hit of hits){
    const button=el('button','library-hit');button.type='button';button.dataset.hitKind=hit.kind;button.dataset.hitId=hit.id||'';
    const label={'text':'原文','note':'片段笔记','project-note':'项目笔记','bookmark':'时间书签'}[hit.kind];
    button.append(el('small','',label+(hit.time===undefined?'':' · '+Coconut.time(hit.time))));
    const preview=el('span','library-hit-preview');preview.append(document.createTextNode(hit.snippet.before),el('mark','',hit.snippet.match),document.createTextNode(hit.snippet.after));
    button.append(preview);button.onclick=()=>openDocument(hit);list.append(button);
   }
   entry.append(list);
  }
  $("library").append(entry);
	}
}
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
 $("reader-media-status").textContent = attachment ? attachment.name + " · 仅在此页面读取，不上传；刷新后需重新选择" : "在浏览器中打开文件，不上传。请选与文字稿对应的原文件；刷新页面后需重新选择。";
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
  player.onloadedmetadata=()=>{player.defaultPlaybackRate=playbackRate;player.playbackRate=playbackRate;updatePlaybackControls();};
  player.onratechange=updatePlaybackControls;
  player.ondurationchange=updatePlaybackControls;
		player.ontimeupdate = () => {if(mediaHost.querySelector("audio,video")!==player)return;repeatPlayback(false,player);highlightPlayback();};
  player.onended=()=>repeatPlayback(true,player);
  for(const event of ["play","pause","timeupdate","ratechange","loadedmetadata","durationchange","ended","error","emptied"])player.addEventListener(event,refreshPlaybackDock);
  bindListening(player,doc,attachment);
		player.preload = "metadata";
		player.src = mediaPath;
		player.setAttribute("aria-label", "原始音视频");
		player.style.width = "100%";
		player.style.maxHeight = "360px";
		player.onerror = () => notice(attachment ? "浏览器无法播放这个文件，可换用 MP3、M4A、MP4 或 WebM 等受支持格式。文字稿与笔记仍可阅读。" : "原始媒体暂时无法播放。请确认此文字稿对应的本地任务仍在这台电脑上。");
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
 updateReaderMediaVisibility(doc,!!mediaPath);
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
				player.currentTime = s.start;takeListeningOwnership();
				player.play().catch(() => notice("请点击播放器开始播放，再按时间戳定位。"));
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
  parallel.append(highlightedText("p", "words", s.text, query));
        if(translated) parallel.append(highlightedText("p", "translation"+(!Coconut.translationCurrent(s,doc,translated)?" stale":""), Coconut.translationCurrent(s,doc,translated) ? translated.text : "原文或上下文已变化，或旧译文缺少上下文记录，可核对／修正此译文或重新生成", query));
        body.append(parallel);
        if(translated && Coconut.translationCurrent(s,doc,translated)) { const warning=Coconut.translationQualityMessage(translated); if(warning)body.append(el("p","translation-review","待核对："+warning)); }

		const edit = el("button", "edit-button", "修正文字");
		edit.onclick = () => {
			editingTarget = {
				documentKey: doc.key, segmentId: s.id,
				position: [...$("transcript").querySelectorAll(".segment")].indexOf(row),
			};
			$("edit-error").textContent = "";
			$("edit-segment").value = s.text;
			$("edit-dialog").showModal();
		};
		body.append(edit);
  let reviewTranslation=null;
  if(translated){
   reviewTranslation=el('button','review-translation-button',translated.manual_review?'核对／修正人工译文':'核对／修正译文');
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
   const viewportTop=row.classList.contains('short-cue')?row.getBoundingClientRect().top:null;
			const position = [...$("transcript").querySelectorAll(".segment")].indexOf(row);
			if (s.saved_excerpt === true) delete s.saved_excerpt;
			else s.saved_excerpt = true;
			save();
			render();
			const rows = [...$("transcript").querySelectorAll(".segment")];
			const target = rows.find(item => item.dataset.segmentId === s.id) || rows[Math.min(position, rows.length - 1)];
			focusCueAction(target?.querySelector(".excerpt-button") || $("filter-excerpts"),target?.dataset.segmentId===s.id?viewportTop:null);
		};
		body.append(excerptButton);
		const bookmarkButton = el("button", "bookmark-button", doc.readingPosition === s.id ? "已标记阅读位置" : "读到这里");
		bookmarkButton.setAttribute("aria-pressed", String(doc.readingPosition === s.id));
		bookmarkButton.onclick = () => {
   const viewportTop=row.classList.contains('short-cue')?row.getBoundingClientRect().top:null;
			doc.readingPosition = s.id;
			save();
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
 return playbackIndex.index.find(player.currentTime);
}
function highlightPlayback() {
 const segment=playbackSegment();
 for(const span of $("passage-body").querySelectorAll(".passage-cue"))span.classList.toggle("passage-current",span.dataset.cueId===segment?.id);
 for(const row of $("transcript").querySelectorAll(".segment")) row.classList.toggle("playing",row.dataset.segmentId===segment?.id);
}
$("locate-playback").onclick=()=>locateReadingPlayback();
$("add-content").onclick = () => { showWorkspace("add"); ($("video-url")).focus(); };
 document.querySelector('.brand').onclick=event=>{event.preventDefault();showWorkspace('add');$('sample').focus();};
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
$("toggle-library").onclick = () => $("toggle-library").setAttribute("aria-expanded", String($("toggle-library").getAttribute("aria-expanded") !== "true"));
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
	const f = $("file").files[0];
	if (!f) return;
 const revision = cancelLocalImports("file"), lifecycleRevision=documentLifecycleRevision;
 const startingDocument = state.active, startingWorkspace = workspace;
 const ownsRequest = () => revision === localImportRevision;
 const canCommit = () => ownsRequest() && state.active === startingDocument && workspace === startingWorkspace;
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
		if (saved && ownsRequest()) notice("已导入并保存在本机浏览器。没有向服务器上传文件。", "success");
	} catch (e) {
		if(canCommit())notice("导入失败：" + localFileError(e));
	} finally {
		if(ownsRequest())$("file").value = "";
	}
};
$("search").oninput = () => {
 clearReadingContext();
 searchFocusedId=null;
	pageStart = 0;
	render();
};
$("note").oninput = () => {
	const d = active();
	if (d && selected) {
  const segment=d.segments.find(item=>item.id===selected),query=$('search').value;
  const matched=segment&&matchesReadingSegment(segment,d,query);
		d.notes[selected] = $("note").value;
		save();
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
			(item) => item.dataset.segmentId === selected,
		);
		if (row) {
			row.querySelector(".note-button").textContent = Coconut.hasNoteContent(d.notes[selected]) ? "编辑笔记" : "＋ 记一笔";
			let preview = row.querySelector(".saved-note");
			if (Coconut.hasNoteContent(d.notes[selected])) {
				if (!preview) {
					preview = el("p", "saved-note");
					row.lastElementChild.append(preview);
				}
				preview.textContent = d.notes[selected];
			} else if (preview) preview.remove();
		}
	}
};
$("source").onclick = () => {
	if (!active()) {
		notice("请先导入文字稿");
		return;
	}
	sourceTarget = active().key;
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
	if (!doc) {
		$("source-error").textContent = "原文字稿已不可用，请重新打开来源设置";
		return;
	}
	doc.source_url = url;
	save();
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
  const ownsBookmark=()=>active()===doc&&doc.timestamp_bookmarks.includes(item);
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
  input.oninput=()=>{if(!ownsBookmark())return;if(!allowAudioNoteChange(doc,item.note,input.value,10000)){input.value=item.note;return;}item.note=input.value;save();renderLibrary();renderNotebookAction(doc);};
  const remove=el('button','','删除书签');remove.onclick=()=>{
   if(!ownsBookmark())return;
   doc.timestamp_bookmarks=doc.timestamp_bookmarks.filter(bookmark=>bookmark.id!==item.id);save();renderAudioProject(doc);renderLibrary();renderNotebookAction(doc);$('audio-bookmark-time').focus();
  };
  const edit=el('button','','修正书签时间'),form=el('form'),timeInput=el('input'),apply=el('button','','保存时间'),cancel=el('button','','取消修正'),error=el('p','hint');
  edit.className='edit-bookmark-time';form.hidden=true;timeInput.value=String(item.time);timeInput.setAttribute('aria-label','修正书签时间（秒、分:秒或时:分:秒）');timeInput.inputMode='decimal';apply.type='submit';cancel.type='button';error.setAttribute('role','status');
  if(draft?.edits.has(item.id)){form.hidden=false;timeInput.value=draft.edits.get(item.id);}
  edit.onclick=()=>{if(!ownsBookmark())return;if(form.hidden){form.hidden=false;timeInput.value=String(item.time);error.textContent='';}timeInput.focus();};
  cancel.onclick=()=>{if(!ownsBookmark())return;form.hidden=true;edit.focus();};
  form.onsubmit=event=>{
   event.preventDefault();if(!ownsBookmark())return;
   const next=Coconut.parseReadingTime(timeInput.value);
   if(next===null||next>604800){error.textContent='请输入最长7天的有效时间，原书签未改变。';return;}
   item.time=next;form.hidden=true;doc.timestamp_bookmarks.sort((a,b)=>a.time-b.time);const persisted=save();renderAudioProject(doc);renderNotebookAction(doc);
   $('audio-project-status').textContent=persisted?'书签时间已更新，笔记保留。':'书签时间仅在本页，请立即导出 JSON 备份。';
   ([...host.children].find(element=>element.dataset.bookmarkId===item.id)?.querySelector('.edit-bookmark-time')||$('audio-bookmark-search')).focus();
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
$('project-note').oninput=()=>{
 const doc=active();if(!Coconut.hasProjectAnnotations(doc))return;
 const input=$('project-note');if(!allowAudioNoteChange(doc,doc.project_note,input.value,100000)){input.value=doc.project_note;return;}
 doc.project_note=input.value;save();renderLibrary();renderNotebookAction(doc);
};
$('use-playback-time').onclick=()=>{
 const player=$('source-media').querySelector('audio,video');if(!player||!Number.isFinite(player.currentTime))return;
 $('audio-bookmark-time').value=String(Math.floor(player.currentTime*1000)/1000);$('audio-bookmark-note').focus();
};
$('audio-bookmark-form').onsubmit=event=>{
 event.preventDefault();const doc=active();if(!Coconut.hasProjectAnnotations(doc))return;
 const seconds=Coconut.parseReadingTime($('audio-bookmark-time').value);
 if(seconds===null||seconds>604800){$('audio-project-status').textContent='请输入有效的秒数、分:秒或时:分:秒，最长7天。';return;}
 if(doc.timestamp_bookmarks.length>=2000){$('audio-project-status').textContent='已达到2,000个时间书签上限，请先备份和整理。';return;}
 const note=$('audio-bookmark-note').value;if(!allowAudioNoteChange(doc,'',note,10000))return;
 doc.timestamp_bookmarks.push({id:crypto.randomUUID(),time:seconds,note});
 doc.timestamp_bookmarks.sort((a,b)=>a.time-b.time);
 const persisted=save();$('audio-bookmark-form').reset();renderAudioProject(doc);renderLibrary();renderNotebookAction(doc);
 $('audio-project-status').textContent=persisted?'时间书签已保存，可导出 JSON 备份。':'书签仅在本页，尚未保存成功，请立即导出 JSON 备份。';$('audio-bookmark-time').focus();
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
 await add(Coconut.validate(demo));
 // Explicitly reopening the bilingual tryout restores its view, never its edited content.
 active().translation_view='zh';save();demoToolsExpanded=false;
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
	if (!segment || !text) {
		$("edit-error").textContent = "文字不能为空";
		return;
	}
	if (segment.original_text === undefined) segment.original_text = segment.text;
	segment.text = text;
	save();
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
 const canCommit = () => ownsRequest() && state.active === startingDocument && workspace === startingWorkspace;
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
  const before=state.documents.length,restored=Coconut.mergeLibraryBackup(state,backup);
  // An empty restore stays in Add without looking like new navigation on render.
  clearReadingContext();
  state = restored; selectActiveDocument(restored.active); selected=null; pageStart=0; notesOnly=false; excerptsOnly=false; speakerFilter=null; $("search").value=""; workspace=active()?"read":"add";
  const persisted = save(); render();
  if(persisted && ownsRequest())notice("已恢复 " + (state.documents.length-before) + " 份文字稿；相同内容已跳过，不同版本分别保留，原书架未删除。");
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

let detailsTarget=null;
$("document-details").onclick=()=>{
 const doc=active();if(!doc)return;
 detailsTarget=doc.key;$("document-title").value=doc.title;$("details-error").textContent="";
 const language=$("document-language");language.querySelector('[data-custom]')?.remove();
 if(doc.language && ![...language.options].some(o=>o.value===doc.language)){const option=el("option","",doc.language);option.value=doc.language;option.dataset.custom="true";language.append(option);}
 language.value=doc.language||"";$("details-dialog").showModal();
};
$("save-details").onclick=event=>{
 event.preventDefault();const doc=state.documents.find(d=>d.key===detailsTarget), title=$("document-title").value.trim();
 if(!doc || !title || title.length>200){$("details-error").textContent="请输入1–200字的标题";return;}
 doc.title=title;doc.language=$("document-language").value;
 const persisted=save();$("details-dialog").close();render();$("document-details").focus();
 if(persisted)notice("文字稿信息已保存；原始来源信息、时间戳和笔记保持不变。", "success");
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
// The dock controls the existing source player; it never owns or starts media.
function refreshPlaybackDock(){
 const dock=$('media-dock'),player=$('source-media').querySelector('audio,video');
 const playable=player&&!player.error&&Number.isFinite(player.duration)&&player.duration>0;
 const visible=!!(playable&&workspace==='read'&&!$('reader-workspace').hidden&&!$('source-media').hidden&&$('episode-media').getBoundingClientRect().bottom<=0);
 if(!visible&&!dock.hidden&&dock.contains(document.activeElement)&&player&&workspace==='read')player.focus({preventScroll:true});
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
 try{if(player.ended){stopRepeating();player.currentTime=0;}await player.play();}
 catch(error){if(error?.name!=='AbortError'&&player===$('source-media').querySelector('audio,video'))notice('媒体暂时无法播放，请回到播放器检查文件或重试。');}
 refreshPlaybackDock();
};
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
 if(!player || !Number.isFinite(player.duration) || segment.end<=segment.start || segment.end>player.duration){$("repeat-status").textContent="请等待媒体加载，并确认片段时间在媒体范围内。";return;}
 stopRepeating();const target={key:active().key,id:segment.id,path:player.getAttribute("src"),start:segment.start,end:segment.end};repeating=target;
 try{player.currentTime=segment.start;const pending=player.play();pending?.catch(()=>{if(repeating===target){stopRepeating();$("repeat-status").textContent="请先在播放器中开始播放，再循环此段。";}});}
 catch{stopRepeating();$("repeat-status").textContent="此媒体暂时无法循环播放。";return;}
 $("stop-repeat").hidden=false;$("repeat-status").textContent="循环 · "+Coconut.time(segment.start)+"–"+Coconut.time(segment.end);
 for(const row of $("transcript").querySelectorAll(".segment")){const button=row.querySelector(".repeat-button");if(button){const selected=row.dataset.segmentId===segment.id;button.textContent=selected?"正在循环 · 停止":"循环回听此段";button.setAttribute("aria-pressed",String(selected));}}
 refreshCueActionLabels();
}
function repeatPlayback(ended=false,player=$("source-media").querySelector("audio,video")){
 const target=repeating;if(!target || !player || player!==$("source-media").querySelector("audio,video"))return;
 if(target.key!==active()?.key || target.path!==player.getAttribute("src")){stopRepeating();return;}
 if(player.currentTime<target.start){stopRepeating();return;}
 if(player.currentTime>=target.end || ended){
  try{player.currentTime=target.start;if(ended)player.play()?.catch(()=>{if(repeating===target)stopRepeating();});}catch{stopRepeating();}
 }
}
$("stop-repeat").onclick=stopRepeating;

function highlightedText(tag,className,value,query){
 const node=el(tag,className),text=String(value),needle=query.trim();
 if(!needle){node.textContent=text;return node;}
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
  listen.onclick=()=>{stopRepeating();passagePlayback.listen({id:passage.key,start:passage.start,end:passage.end,label:Coconut.time(passage.start)+'–'+Coconut.time(passage.end)});};
  actions.append(listen);
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
 const status=state?.status||'idle',host=$('passage-playback-controls');if(!host)return;
 host.dataset.state=status;host.hidden=status==='idle'||workspace!=='read';document.body.dataset.passageListening=String(!host.hidden);
 $('passage-playback-status').textContent=({loading:'正在打开这一段…',playing:'回听 '+(state?.range?.label||'')+' · 到段尾自动停下',paused:'这一段已暂停',finished:'这一段已听完 · '+(state?.range?.label||''),error:state?.error||'这段暂时无法回听'})[status]||'';
 $('passage-replay').disabled=status==='loading';$('passage-continue').disabled=status==='loading';$('passage-return-playback').hidden=!state?.returnPosition;
 $('passage-stop').hidden=status==='finished'||status==='error';
 const player=$('source-media').querySelector('audio,video'),available=player&&!player.error&&Number.isFinite(player.duration)&&player.duration>0;
 for(const button of $('passage-body').querySelectorAll('.passage-listen')){
  const passage=renderedPassageRanges.get(button),bounded=available&&passage&&passage.end>passage.start&&passage.end<=player.duration;
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
 $('bilingual-status').textContent=count?`当前语言已有 ${count}/${doc.segments.length} 段有效译文；缺失或过期部分仍保留原文，可在翻译选项中继续。`:'还没有当前语言的有效译文。先读原文，或打开翻译选项，核对发送范围与额度后生成；切换视图不会调用模型。';}
}
function setReadingMode(mode) {
 const previousMode=readingMode;
 readingMode=['transcript','passages'].includes(mode)?mode:'summary';
 if(readingMode==='passages'){clearReadingContext();selected=null;$('notes-panel').hidden=true;if(typeof stopLanguageBatches==='function')stopLanguageBatches();$('language-panel').open=false;}
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
function renderSummary() {
 const doc=active();if(!doc)return;
 const readiness=Coconut.summaryReadiness(doc);
 const answer=Coconut.latestSummary(doc),freshness=answer?Coconut.summaryFreshness(answer,doc):'empty';
 const persisted=answer && persistedSummaries.get(doc.key)===answer && !storageBlocked;
 renderSourceOverview(doc,!!answer);
 $('summary-heading').textContent=answer?'这篇的主要内容':'想先抓住重点？';
 $('summary-state').textContent=answer&&!persisted?'仅在此页 · 请备份':({current:'已保存 · 待核对',stale:'原文有更新',unknown:'依据待确认',empty:'未生成'})[freshness];
 $('summary-state').dataset.state=answer&&!persisted?'unsaved':freshness;
 $('summary-status').textContent=answer ? ({current:'覆盖当前整篇原文 · '+answer.provider+' · 摘要不代替原话',stale:'原文已经修改、增加或移除，下面是旧摘要。重新生成前请对照原文。',unknown:'这份摘要缺少完整发送记录，无法确认覆盖范围，请对照原文。'})[freshness] : '已有原文可直接阅读。连接已登录的本地 Codex 或 Claude Code，确认发送全文与使用额度后，才会生成摘要。';
 if(!answer&&doc.summary_job)$('summary-status').textContent=summaryCheckpointSaved(doc)?'分批进度已保存，整篇摘要尚未完成。查看计划后需再次确认发送与额度，才会继续；不会自动重新请求。':'最新分批进度尚未保存到浏览器，当前页面仍可导出 JSON 备份；关闭或刷新可能丢失进度，整篇摘要尚未完成。';
 if(answer?.summary_process?.batches>1)$('summary-status').textContent+=' · '+answer.summary_process.batches+' 批完成后汇总；引用来自被采用的批次依据，请回源核对。';
 if(answer&&!persisted)$('summary-status').textContent='这份摘要尚未保存到浏览器。关闭或刷新前请先导出摘要或 JSON 备份。'+$('summary-status').textContent;
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
$('mode-passages').onclick=()=>openPassage(passageAnchor||active()?.readingPosition||active()?.segments[0]?.id);
$('mode-summary').onclick=()=>setReadingMode('summary');
$('mode-transcript').onclick=()=>{if(active()){active().translation_view='';save();}setReadingMode('transcript');render();};
$('mode-bilingual').onclick=()=>{const doc=active();if(!doc||Coconut.isAudioProject(doc))return;doc.translation_view=doc.translation_view||$('translation-target').value||'zh';save();setReadingMode('transcript');render();};
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
$('reader-media-file').addEventListener('cancel' ,()=>{pendingMediaDocument=null;});
$('attach-reader-media').onclick=()=>{pendingMediaDocument=active()?.key||null;if(pendingMediaDocument)$('reader-media-file').click();};
$('reader-media-file').onchange=async()=>{
 const input=$('reader-media-file'),file=input.files[0],key=pendingMediaDocument;pendingMediaDocument=null;
 if(!file)return;
 const revision=changeMediaSelection(key);
 let nextURL;
 try{
  if(!key||!state.documents.some(d=>d.key===key))throw new Error('原文字稿已关闭，请重新选择');
  const extension=file.name.split('.').pop().toLowerCase();
  const supportedTypes=new Set(['audio/mpeg','audio/mp3','audio/mp4','audio/x-m4a','audio/wav','audio/x-wav','audio/ogg','audio/flac','audio/x-flac','audio/aac','audio/opus','video/mp4','video/webm','audio/webm','video/quicktime','video/x-m4v','application/octet-stream']);
  if(file.type&&!supportedTypes.has(file.type.toLowerCase()))throw new Error('请选择 MP3、M4A、WAV、OGG、FLAC、MP4、WebM 等实际音视频文件');
  const kind=file.type.startsWith('video/')||['mp4','webm','mov','m4v'].includes(extension)?'video':file.type.startsWith('audio/')||['mp3','m4a','wav','ogg','flac','aac','opus'].includes(extension)?'audio':null;
  if(!kind||!file.size)throw new Error('请选择可播放的音频或视频文件');
  const prefix=await file.slice(0,1024).text();
  if(/(?:mpegurl|scpls|dash\+xml)/i.test(file.type)||/^\s*(?:#EXTM3U|\[playlist\]|<\?xml|<MPD|<SmoothStreamingMedia|<ASX|<smil)/i.test(prefix))throw new Error('请选择实际音视频文件，不支持会连接远程地址的播放列表');
  if(mediaSelectionRevision(key)!==revision)return;
  const identity=await fingerprintMedia(file);
  if(mediaSelectionRevision(key)!==revision)return;
  nextURL=URL.createObjectURL(file);const previous=browserMedia.get(key);
  if(key===active()?.key){stopRepeating();$('source-media').querySelector('audio,video')?.pause();}
  browserMedia.set(key,{url:nextURL,kind,name:file.name,identity});if(previous)URL.revokeObjectURL(previous.url);
  if(key===active()?.key){render();}
  notice('媒体只在本次页面读取，未上传。请核对内容和文字稿对应；刷新后重新选择文件即可继续回听。', "success");
 }catch(error){if(nextURL)URL.revokeObjectURL(nextURL);notice('打开媒体失败：'+error.message);}
 finally{input.value='';}
};
$('detach-reader-media').onclick=()=>{
 const key=active()?.key,attachment=browserMedia.get(key);if(!attachment)return;
 changeMediaSelection(key);
 stopRepeating();$('source-media').querySelector('audio,video')?.pause();browserMedia.delete(key);URL.revokeObjectURL(attachment.url);render();
};

$('attach-project-transcript').onclick=()=>{const doc=active();if(Coconut.isAudioProject(doc)){projectTranscriptTarget={key:doc.key,document:doc,source:JSON.stringify(doc.podcast_source)};$('project-transcript-file').click();}};
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
  const persisted=attachTranscriptToProject(text,target);
  notice(persisted?'文字稿已附加到当前项目，原有笔记、时间书签与媒体保留。未调用识别、翻译或摘要模型。':'文字稿已在本页附加，但未能保存，请立即导出 JSON 备份。');
 }catch(error){if(ownsRequest())notice('补充文字稿失败：'+localFileError(error));}
 finally{if(ownsRequest())input.value='';}
};

function attachTranscriptToProject(text,target){
 const index=state.documents.findIndex(doc=>doc.key===target.key),original=state.documents[index];
 if(original!==target.document||state.active!==target.key||workspace!=='read'||!Coconut.isAudioProject(original)||JSON.stringify(original.podcast_source)!==target.source)throw new Error('目标项目已经切换或更新，本次未附加文字稿，请重新选择');
 const attached={...Coconut.attachProjectTranscript(original,text),key:original.key};
 state.documents[index]=attached;selected=null;pageStart=0;notesOnly=false;excerptsOnly=false;speakerFilter=null;$('search').value='';
 const persisted=save();setReadingMode('transcript');render();return persisted;
}


// Last-resort protection, not a backup: browsers require prior user activation,
// show their own text, and may omit this event on mobile or process termination.
// Keep the existing export warnings. Attach only while actual changes remain.
// https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event
function hasUnsavedReaderChanges() {
 captureAudioBookmarkDrafts();
 if(removedDocument||unsavedDocumentChanges||audioBookmarkDrafts.size||hasLanguageDrafts()||window.CoconutTranslationReview?.hasDraft())return true;
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
 // Input handlers run first, so synchronously saved notes never install a guard.
 for(const event of ["input","change","click","submit"])document.addEventListener(event,syncUnsavedUnloadGuard);
 // Dialog close does not bubble; capture also covers native Escape/Cancel.
 document.addEventListener("close",syncUnsavedUnloadGuard,true);
 syncUnsavedUnloadGuard();
}
