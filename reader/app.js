"use strict";
const $ = (id) => document.getElementById(id);
const KEY = "coconut-reader-v1";
let state = { documents: [], active: null };
let selected = null;
let notesOnly = false;
let excerptsOnly = false;
let speakerFilter = null;
function matchesReadingSegment(segment,doc,query){return (speakerFilter===null||(segment.speaker||'')===speakerFilter)&&Coconut.matchesSegment(segment,doc,query,notesOnly,excerptsOnly);}
let searchFocusedId=null;
let workspace = "read";
let readingScroll = 0;
let editingTarget = null;
let sourceTarget = null;
const PAGE_SIZE = 100;
let pageStart = 0;
let storageBlocked = false;
let lastSavedValue = null;
const persistedSummaries = new Map();
const persistedSummaryJobs = new Map();
function summaryCheckpointSignature(job){return job?JSON.stringify([job.provider,job.snapshot,job.results]):null;}
function summaryCheckpointSaved(doc){return !!doc?.summary_job&&persistedSummaryJobs.get(doc.key)===summaryCheckpointSignature(doc.summary_job);}
function recordPersistedSummaries() { persistedSummaries.clear();persistedSummaryJobs.clear(); for(const doc of state.documents){persistedSummaries.set(doc.key,Coconut.latestSummary(doc));persistedSummaryJobs.set(doc.key,summaryCheckpointSignature(doc.summary_job));} }
let mediaWorkerReady = false;
let readingMode = "summary";
const browserMedia = new Map();
const mediaSelectionRevisions = new Map();
function mediaSelectionRevision(key){return mediaSelectionRevisions.get(key)||0;}
function changeMediaSelection(key,notify=true){const revision=mediaSelectionRevision(key)+1;mediaSelectionRevisions.set(key,revision);if(notify)window.dispatchEvent(new CustomEvent('coconut-media-selection-change',{detail:{key}}));return revision;}
let pendingMediaDocument = null;
const PLAYBACK_RATES=[0.75,1,1.25,1.5,1.75,2];
let playbackRate=1;
let repeating=null;
try {const saved=Number(localStorage.getItem("coconut-playback-rate-v1"));if(PLAYBACK_RATES.includes(saved))playbackRate=saved;}catch{}

function saveWarning(text = "") {
 $("save-status").hidden = !text;
 $("save-status").textContent = text;
}
function notice(text) {
	$("notice").hidden = !text;
	$("notice").textContent = text;
}
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
function save() {
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
		const nextValue = JSON.stringify(state);
		localStorage.setItem(KEY, nextValue);
		lastSavedValue = nextValue;
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
async function add(doc, canCommit = null, reuseAudioSource = false) {
	const bytes = new TextEncoder().encode(JSON.stringify(doc));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	let key = Array.from(new Uint8Array(digest))
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("");
 if(canCommit && !canCommit())throw new Error("导入已取消，书架未改变");
 // A repeated source save refreshes recoverable source metadata, preserving
 // user-owned title, language, notes, bookmark IDs and the stable library key.
 const identity=reuseAudioSource?Coconut.audioProjectIdentity(doc):'';
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
	state.active = key;
 setReadingMode("summary");
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
 if (next !== "read") $("export-menu").open = false;
	$("add-content").setAttribute("aria-pressed", String(next === "add"));
	if (returning) window.scrollTo(0, readingScroll);
}
function goToSegment(id) {
 closeSummaryRequest(false);
 readingMode = "transcript";
	const doc = active();
	const index = doc ? doc.segments.findIndex(s => s.id === id) : -1;
	if (index < 0) return;
	$("search").value = "";
	notesOnly = false; excerptsOnly = false; speakerFilter=null;
	selected = null;
	pageStart = Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
	showWorkspace("read");
	render();
	const row = [...$("transcript").querySelectorAll(".segment")].find(row => row.dataset.segmentId === id);
	row?.scrollIntoView?.({block: "center", behavior: "smooth"});
	row?.focus({preventScroll: true});
}
function renderLibrary() {
	$("library").replaceChildren();
	const query = $("library-search").value.trim().toLocaleLowerCase();
	const docs = Coconut.sortedLibrary(state.documents, $("library-sort").value).filter(d => Coconut.libraryMatches(d,query,$("library-kind").value,$("library-scope").value));
	$("library-total").textContent = String(state.documents.length);
	$("library-empty").hidden = docs.length > 0;
	$("library-empty").textContent = state.documents.length ? "没有匹配的内容，可调整书架筛选或查找范围" : "还没有内容。添加一份，或体验示例。";
	for (const d of docs) {
		const b = el("button", d.key === state.active ? "active" : "");
		b.append(el("span", "library-title", d.title));
		const bookmark = d.segments.find(s => s.id === d.readingPosition);
		b.append(el("small", "", Coconut.isAudioProject(d)?"原声项目 · 未导入文字稿 · "+(d.timestamp_bookmarks||[]).length+" 个时间书签":Coconut.time(d.segments.at(-1).end) + " · " + Object.values(d.notes).filter(Boolean).length + " 则笔记" + (bookmark ? " · 读到 " + Coconut.time(bookmark.start) : "")));
		b.setAttribute("aria-current", d.key === state.active ? "page" : "false");
		b.onclick = () => {
   stopRepeating();$("source-media").querySelector("audio,video")?.pause();closeSummaryRequest(false);
			state.active = d.key;
   setReadingMode("summary");
   searchFocusedId=null;
			selected = null;
			notesOnly = false; excerptsOnly = false; speakerFilter=null;
			pageStart = 0;
			$("search").value = "";
			$("toggle-library").setAttribute("aria-expanded", "false");
			save();
			showWorkspace("read");
			render();
			if (bookmark) goToSegment(bookmark.id);
			else $("title").scrollIntoView?.({block: "start"});
		};
		$("library").append(b);
	}
}
function render() {
	const doc = active();
	renderLibrary();
	showWorkspace(doc ? workspace : "add");
	if (!doc) {
		$("transcript").replaceChildren();
		$("empty").hidden = false;
		$("notes-panel").hidden = true;
		return;
	}
	$("empty").hidden = true;
 const audioOnly=Coconut.isAudioProject(doc);
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
  currentPlayer?.pause();
		mediaHost.replaceChildren();
		mediaHost.hidden = true;
	} else if (!currentPlayer || currentPlayer.getAttribute("src") !== mediaPath) {
  currentPlayer?.pause();
		const player = el(mediaKind, "source-player");
		player.controls = true;
  player.defaultPlaybackRate=playbackRate;
  player.playbackRate=playbackRate;
  player.onloadedmetadata=()=>{player.defaultPlaybackRate=playbackRate;player.playbackRate=playbackRate;updatePlaybackControls();};
  player.onratechange=updatePlaybackControls;
  player.ondurationchange=updatePlaybackControls;
		player.ontimeupdate = () => {if(mediaHost.querySelector("audio,video")!==player)return;repeatPlayback(false,player);highlightPlayback();};
  player.onended=()=>repeatPlayback(true,player);
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
	$("time-navigation-status").textContent="";
	$("subtitle").textContent = audioOnly ? '原声项目 · '+(doc.media_duration?Coconut.time(doc.media_duration)+' · ':'')+'来源、项目笔记与时间书签保存在本机' :
		doc.segments.length +
		" 个片段 · " +
		Coconut.time(doc.segments.at(-1).end) +
		" · 原话与笔记保存在本机";
	const provenance = doc.provenance || {};
	const sourceKinds = {publisher_transcript:"发布者提供的文字稿（未人工核对）",platform_subtitles: "平台提供的字幕", automatic_subtitles: "平台自动字幕", imported_subtitles: "导入的字幕", local_asr: "本机语音识别"};
	const provenanceText = sourceKinds[provenance.kind] || "导入文字稿，来源未标明";
	const medium = provenance.source_medium === "audio" ? "音频内容" : provenance.source_medium === "video" ? "视频内容" : "";
 $("provenance").textContent = [medium, provenance.source_platform].filter(Boolean).join(" · ") + (medium || provenance.source_platform ? " · " : "") + provenanceText + (provenance.model ? " · " + provenance.model : "") + " · 请回听核对专有名词与重要信息" + (provenance.alignment_warning ? " · 时间对齐降级：" + provenance.alignment_warning : "");
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
	const currentNote = visible.find((segment) => segment.id === selected);
	if (!currentNote) selected = null;
	$("notes-panel").hidden = !selected;
	if (currentNote) {
		$("quote").textContent = currentNote.text;
		$("note-time").textContent = Coconut.time(currentNote.start) + " 的想法";
		$("note").value = doc.notes[currentNote.id] || "";
	}
	$("filter-all").setAttribute("aria-pressed", String(!notesOnly && !excerptsOnly));
	$("filter-notes").setAttribute("aria-pressed", String(notesOnly));
	$("filter-excerpts").setAttribute("aria-pressed", String(excerptsOnly));
	$("excerpt-count").textContent = String(doc.segments.filter(s => s.saved_excerpt === true).length);
	renderNotebookAction(doc);
	$("note-count").textContent = String(Object.values(doc.notes).filter(Boolean).length);
	const playbackHint = mediaPath ? "点时间戳定位本地原声" : Coconut.source(doc.source_url, 0) ? "点时间戳打开原站；若平台未自动定位，请按显示时间手动跳转" : doc.source_media ? "本地媒体尚未连接；请在保存原任务的电脑启动 Coconut" : "尚未关联音视频，可在「阅读设置」添加原视频链接";
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
		row.tabIndex = -1;
		const meta = el("div", "time");
		const href = Coconut.source(doc.source_url, s.start);
		if (mediaPath) {
			const seek = el("button", "", Coconut.time(s.start));
			seek.title = "回听本地原文件此刻";
			seek.onclick = () => {
				const player = mediaHost.querySelector("audio,video");
				if (!player) return;
				stopRepeating();
				player.currentTime = s.start;
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
		body.append(highlightedText("p", "words", s.text, query));
        const translated=s.translations?.[doc.translation_view];
        if(translated) body.append(highlightedText("p", "translation"+(!Coconut.translationCurrent(s,doc,translated)?" stale":""), Coconut.translationCurrent(s,doc,translated) ? translated.text : "原文或上下文已变化，或旧译文缺少上下文记录，此译文需要重新生成", query));
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
		const button = el("button", "", doc.notes[s.id] ? "编辑笔记" : "＋ 记一笔");
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
		const excerptButton = el("button", "excerpt-button", s.saved_excerpt === true ? "已摘录 · 取消" : "☆ 摘录整段");
		excerptButton.setAttribute("aria-pressed", String(s.saved_excerpt === true));
		excerptButton.setAttribute("aria-label", (s.saved_excerpt === true ? "取消摘录 " : "摘录整段 ") + Coconut.time(s.start));
		excerptButton.onclick = () => {
			const position = [...$("transcript").querySelectorAll(".segment")].indexOf(row);
			if (s.saved_excerpt === true) delete s.saved_excerpt;
			else s.saved_excerpt = true;
			save();
			render();
			const rows = [...$("transcript").querySelectorAll(".segment")];
			const target = rows.find(item => item.dataset.segmentId === s.id) || rows[Math.min(position, rows.length - 1)];
			(target?.querySelector(".excerpt-button") || $("filter-excerpts")).focus({preventScroll: true});
		};
		body.append(excerptButton);
		const bookmarkButton = el("button", "bookmark-button", doc.readingPosition === s.id ? "已标记阅读位置" : "读到这里");
		bookmarkButton.setAttribute("aria-pressed", String(doc.readingPosition === s.id));
		bookmarkButton.onclick = () => {
			doc.readingPosition = s.id;
			save();
			render();
		};
		body.append(bookmarkButton);
		if (doc.notes[s.id]) body.append(highlightedText("p", "saved-note", doc.notes[s.id], query));
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
 applyReadingMode();
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
 return player && active()?.segments.findLast(s=>s.start<=player.currentTime && s.end>=player.currentTime);
}
function highlightPlayback() {
 const segment=playbackSegment();
 for(const row of $("transcript").querySelectorAll(".segment")) row.classList.toggle("playing",row.dataset.segmentId===segment?.id);
}
$("locate-playback").onclick=()=>{const segment=playbackSegment();if(segment){goToSegment(segment.id);highlightPlayback();}};
$("add-content").onclick = () => { showWorkspace("add"); ($("video-url")).focus(); };
$("back-reading").onclick = () => showWorkspace("read");
$("show-jobs").onclick = () => { showWorkspace("add"); $("jobs-heading").scrollIntoView?.(); };
$("toggle-library").onclick = () => $("toggle-library").setAttribute("aria-expanded", String($("toggle-library").getAttribute("aria-expanded") !== "true"));
$("library-search").oninput = renderLibrary;
$("library-kind").onchange=renderLibrary;
$("library-scope").onchange=renderLibrary;
try{const order=localStorage.getItem('coconut-library-sort-v1');if(['added','title','duration'].includes(order))$('library-sort').value=order;}catch{}
$('library-sort').onchange=()=>{renderLibrary();try{localStorage.setItem('coconut-library-sort-v1',$('library-sort').value);}catch{notice('本次排序已应用，但浏览器未保存偏好。');}};

$('speaker-filter').onchange=()=>{speakerFilter=$('speaker-filter').value==='all'?null:JSON.parse($('speaker-filter').value);pageStart=0;searchFocusedId=null;render();};
$("filter-all").onclick = () => { notesOnly = false; excerptsOnly = false; speakerFilter=null; pageStart = 0; render(); };
$("filter-excerpts").onclick = () => { excerptsOnly = true; notesOnly = false; pageStart = 0; render(); };
$("filter-notes").onclick = () => { notesOnly = true; excerptsOnly = false; pageStart = 0; render(); };
$("clear-search").onclick = () => { $("search").value = ""; notesOnly = false; excerptsOnly = false; speakerFilter=null; pageStart = 0; render(); $("search").focus(); };
$("close-note").onclick = () => {
	const id = selected;
	selected = null;
	render();
	const row = [...$("transcript").querySelectorAll(".segment")].find(row => row.dataset.segmentId === id);
	row?.querySelector(".note-button")?.focus();
};
$("return-excerpt").onclick = () => goToSegment(selected);
document.addEventListener("keydown", event => {
	if (event.key === "Escape" && selected && !$("export-menu").open && !document.querySelector("dialog[open]")) $("close-note").click();
});
$("import").onclick = () => $("file").click();
$("file").onchange = async () => {
	const f = $("file").files[0];
	if (!f) return;
	try {
		if (f.size > 15 * 1024 * 1024)
			throw new Error("文件超过15MB，请先拆分文字稿");
		const saved = await add(Coconut.parse(await f.text(), f.name));
		if (saved) notice("已导入并保存在本机浏览器。没有向服务器上传文件。");
	} catch (e) {
		notice("导入失败：" + e.message);
	} finally {
		$("file").value = "";
	}
};
$("search").oninput = () => {
 searchFocusedId=null;
	pageStart = 0;
	render();
};
$("note").oninput = () => {
	const d = active();
	if (d && selected) {
		d.notes[selected] = $("note").value;
		save();
		$("note-count").textContent = String(Object.values(d.notes).filter(Boolean).length);
		renderLibrary();
		renderNotebookAction(d);
		// Keep pointer targets mounted while focus leaves the note editor.
		// Re-rendering on blur swallows the subsequent click on another row.
		const row = [...$("transcript").querySelectorAll(".segment")].find(
			(item) => item.dataset.segmentId === selected,
		);
		if (row) {
			row.querySelector(".note-button").textContent = d.notes[selected] ? "编辑笔记" : "＋ 记一笔";
			let preview = row.querySelector(".saved-note");
			if (d.notes[selected]) {
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
function renderAudioProject(doc) {
 const panel=$('audio-project'),audioOnly=Coconut.isAudioProject(doc);
 $('audio-project-heading').textContent=audioOnly?'先留下声音和想法':'项目笔记与时间书签';
 $('audio-project-boundary').textContent=audioOnly?'尚未导入文字稿，没有可生成摘要的原文。项目笔记和时间书签只记录你的想法，不会作为原文发送给 AI。':'已补充文字稿。以下项目笔记和时间书签仍是你的记录，不是原文，不会加入发送给 AI 的原文范围。';
 $('attach-project-transcript').hidden=!audioOnly;$('attach-project-help').hidden=!audioOnly;
 if(panel.dataset.documentKey!==doc.key){
  panel.dataset.documentKey=doc.key;$('audio-bookmark-form').reset();$('audio-bookmark-search').value='';$('audio-project-status').textContent='';
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
  const seek=el('button','',Coconut.time(item.time)+' · 定位原声');
  seek.onclick=()=>{
   const player=$('source-media').querySelector('audio,video');
   if(!player||!Number.isFinite(player.duration)||player.duration<=0){$('audio-project-status').textContent='请先单独获取原声，或选择对应的本地文件，等加载完成后再定位。';return;}
   if(item.time>player.duration){$('audio-project-status').textContent='书签超出当前媒体范围，请核对是否选择了对应文件。';return;}
   try{stopRepeating();player.currentTime=item.time;$('audio-project-status').textContent='已定位到 '+Coconut.time(item.time)+'；未自动播放。';}
   catch{$('audio-project-status').textContent='媒体暂时无法定位，书签仍然保留。';}
  };
  const input=el('textarea');input.rows=2;input.value=item.note;input.setAttribute('aria-label',Coconut.time(item.time)+' 的书签笔记');
  input.oninput=()=>{if(active()?.key!==doc.key)return;if(!allowAudioNoteChange(doc,item.note,input.value,10000)){input.value=item.note;return;}item.note=input.value;save();renderNotebookAction(doc);};
  const remove=el('button','','删除书签');remove.onclick=()=>{
   doc.timestamp_bookmarks=doc.timestamp_bookmarks.filter(bookmark=>bookmark.id!==item.id);save();renderAudioProject(doc);renderLibrary();renderNotebookAction(doc);$('audio-bookmark-time').focus();
  };
  const edit=el('button','','修正书签时间'),form=el('form'),timeInput=el('input'),apply=el('button','','保存时间'),cancel=el('button','','取消修正'),error=el('p','hint');
  edit.className='edit-bookmark-time';form.hidden=true;timeInput.value=String(item.time);timeInput.setAttribute('aria-label','修正书签时间（秒、分:秒或时:分:秒）');timeInput.inputMode='decimal';apply.type='submit';cancel.type='button';error.setAttribute('role','status');
  edit.onclick=()=>{form.hidden=false;timeInput.value=String(item.time);error.textContent='';timeInput.focus();};
  cancel.onclick=()=>{form.hidden=true;edit.focus();};
  form.onsubmit=event=>{
   event.preventDefault();if(active()?.key!==doc.key||!doc.timestamp_bookmarks.includes(item))return;
   const next=Coconut.parseReadingTime(timeInput.value);
   if(next===null||next>604800){error.textContent='请输入最长7天的有效时间，原书签未改变。';return;}
   item.time=next;doc.timestamp_bookmarks.sort((a,b)=>a.time-b.time);const persisted=save();renderAudioProject(doc);renderNotebookAction(doc);
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
$('audio-bookmark-search').oninput=()=>{const doc=active();if(Coconut.hasProjectAnnotations(doc))renderAudioProject(doc);};
$('project-note').oninput=()=>{
 const doc=active();if(!Coconut.hasProjectAnnotations(doc))return;
 const input=$('project-note');if(!allowAudioNoteChange(doc,doc.project_note,input.value,100000)){input.value=doc.project_note;return;}
 doc.project_note=input.value;save();renderNotebookAction(doc);
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
		notice(Coconut.isAudioProject(doc)?"已发起项目笔记下载，包含项目笔记与时间书签；没有文字稿或摘要。完整恢复请使用 JSON 备份。":"已发起 Markdown 下载，包含本篇全部摘录与笔记。请检查浏览器下载记录；完整恢复仍需 JSON 备份。");
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
		notice(Coconut.isAudioProject(d)?"已发起项目备份下载，包含来源、项目笔记与时间书签，不包含媒体。请检查下载记录并确认保存。":"已发起备份下载，请检查浏览器下载记录并确认文件已保存。备份包含原稿、修正、摘录与笔记。");
	} catch {
		notice("备份导出失败，文字稿与笔记仍保留在本页。请重试，暂时不要关闭页面。");
	} finally {
		if (link) link.remove();
		// Give the browser time to consume the object URL before releasing it.
		if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
	}
};
$("sample").onclick = () =>
	add({
		schema_version: 1,
		title: "开始一场更有收获的阅读",
		source_url: "",
		segments: [
			{
				id: "demo-1",
				start: 0,
				end: 18,
				text: "这是 Coconut 自写的演示内容，不是真实访谈。阅读长内容时，先找到让你想停下来思考的那一段。",
				speaker: "演示",
			},
			{
				id: "demo-2",
				start: 18,
				end: 42,
				text: "保留时间戳，就可以把一段文字和原来的声音重新连起来。重要的不只是更顺的文字，还有随时查证的能力。",
				speaker: "演示",
			},
			{
				id: "demo-3",
				start: 42,
				end: 68,
				text: "试着在这段旁边记一笔，或者搜索“时间戳”。你的笔记只保存在自己的浏览器里，也可以导出备份。",
				speaker: "演示",
			},
		],
	}).catch((e) => notice("示例打开失败：" + e.message));
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
	(target?.querySelector(".edit-button") || $("search")).focus({preventScroll: true});
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
  if(backup.documents.length>500 || blob.size>50*1024*1024) { notice("书架超过整库恢复限制（500份或50MB），请使用逐份文字稿备份，避免生成无法恢复的文件。"); return; }
  url = URL.createObjectURL(blob);
  link = el("a"); link.href=url; link.download="coconut-library.json"; link.hidden=true; document.body.append(link); link.click();
  notice("已发起整个书架的备份下载，请确认文件已保存；包含文字、笔记及 AI 回答，不包含媒体文件。");
 } catch { notice("书架备份失败，内容仍在本页，请重试后再关闭。"); }
 finally { link?.remove(); if(url)setTimeout(()=>URL.revokeObjectURL(url),60000); }
};
$("restore-library").onclick = () => $("library-file").click();
$("library-file").onchange = async () => {
 const file = $("library-file").files[0]; if(!file)return;
 try {
  if(file.size > 50*1024*1024)throw new Error("书架备份超过50MB，请改用逐份导入");
  const backup = JSON.parse(await file.text());
  const before = state.documents.length;
  const restored = Coconut.mergeLibraryBackup(state, backup);
  state = restored; selected=null; pageStart=0; notesOnly=false; excerptsOnly=false; speakerFilter=null; $("search").value=""; workspace="read";
  const persisted = save(); render();
  if(persisted)notice("已恢复 " + (state.documents.length-before) + " 份文字稿；相同内容已跳过，不同版本分别保留，原书架未删除。");
 } catch(error) { notice("恢复失败，原书架未改变："+error.message); }
 finally { $("library-file").value=""; }
};

$("export-subtitles").onclick = () => {
 const doc=active(); if(!doc)return;
 let url,link;
 try {
  const format=$("subtitle-format").value, bilingual=$("subtitle-bilingual").checked;
  const result=Coconut.subtitleExport(doc,format,bilingual);
  url=URL.createObjectURL(new Blob([result.text],{type:format==="vtt"?"text/vtt;charset=utf-8":"text/plain;charset=utf-8"}));
  link=el("a");link.href=url;link.download=doc.title.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,"_")+"."+format;link.hidden=true;document.body.append(link);link.click();
  notice("已发起整篇字幕下载（"+doc.segments.length+" 段）"+(bilingual?"，附加 "+result.translated+" 段有效译文；缺失或过期译文未导出":"")+"。请确认文件已保存。");
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
 if(persisted)notice("文字稿信息已保存；原始来源信息、时间戳和笔记保持不变。");
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
}
function skipPlayback(delta){
 const player=$("source-media").querySelector("audio,video");if(!player || !Number.isFinite(player.duration) || player.duration<=0)return;
 stopRepeating();
 try{player.currentTime=Math.max(0,Math.min(player.duration,player.currentTime+delta));highlightPlayback();$("playback-status").textContent="已定位到 "+Coconut.time(player.currentTime);}
 catch{$("playback-status").textContent="媒体暂时无法定位，请等待加载后重试。";}
}
$("skip-back").onclick=()=>skipPlayback(-10);$("skip-forward").onclick=()=>skipPlayback(10);
$("playback-rate").onchange=()=>{
 const rate=Number($("playback-rate").value),player=$("source-media").querySelector("audio,video");if(!player || !PLAYBACK_RATES.includes(rate))return;
 try{player.defaultPlaybackRate=rate;player.playbackRate=rate;playbackRate=rate;}catch{$("playback-status").textContent="播放器不支持该速度。";return;}
 try{localStorage.setItem("coconut-playback-rate-v1",String(rate));$("playback-status").textContent="播放速度已保存 · "+rate+"×";}
 catch{$("playback-status").textContent="播放速度已应用，本次未能保存偏好。";}
};

function stopRepeating(){
 repeating=null;$("stop-repeat").hidden=true;$("repeat-status").textContent="";
 for(const button of document.querySelectorAll(".repeat-button")){button.textContent="循环回听此段";button.setAttribute("aria-pressed","false");}
}
function toggleRepeat(segment){
 if(repeating?.key===active()?.key && repeating?.id===segment.id){stopRepeating();return;}
 const player=$("source-media").querySelector("audio,video");
 if(!player || !Number.isFinite(player.duration) || segment.end<=segment.start || segment.end>player.duration){$("repeat-status").textContent="请等待媒体加载，并确认片段时间在媒体范围内。";return;}
 stopRepeating();const target={key:active().key,id:segment.id,path:player.getAttribute("src"),start:segment.start,end:segment.end};repeating=target;
 try{player.currentTime=segment.start;const pending=player.play();pending?.catch(()=>{if(repeating===target){stopRepeating();$("repeat-status").textContent="请先在播放器中开始播放，再循环此段。";}});}
 catch{stopRepeating();$("repeat-status").textContent="此媒体暂时无法循环播放。";return;}
 $("stop-repeat").hidden=false;$("repeat-status").textContent="循环 · "+Coconut.time(segment.start)+"–"+Coconut.time(segment.end);
 for(const row of $("transcript").querySelectorAll(".segment")){const button=row.querySelector(".repeat-button");if(button){const selected=row.dataset.segmentId===segment.id;button.textContent=selected?"正在循环 · 停止":"循环回听此段";button.setAttribute("aria-pressed",String(selected));}}
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
 const row=[...$("transcript").querySelectorAll(".segment")].find(s=>s.dataset.segmentId===searchFocusedId);row?.scrollIntoView?.({block:"center"});row?.focus({preventScroll:true});
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

function applyReadingMode() {
 const audioOnly=Coconut.isAudioProject(active());
 const summary=readingMode==='summary'&&!audioOnly;
 $('summary-workspace').hidden=!summary;
 $('transcript-controls').hidden=summary;
 $('transcript-layout').hidden=summary||audioOnly;
 $('reading-settings').hidden=summary;
 $('language-panel').hidden=audioOnly||summary;
 $('mode-summary').setAttribute('aria-pressed',String(summary));
 const bilingual=!summary&&!audioOnly&&!!active()?.translation_view;
 $('mode-transcript').setAttribute('aria-pressed',String(!summary&&!bilingual));
 $('mode-bilingual').setAttribute('aria-pressed',String(bilingual));
 $('mode-bilingual').disabled=audioOnly;
 $('bilingual-readiness').hidden=!bilingual;
 if(bilingual){const doc=active(),target=doc.translation_view,count=doc.segments.filter(s=>Coconut.translationCurrent(s,doc,s.translations?.[target])).length;
 $('bilingual-status').textContent=count?`当前语言已有 ${count}/${doc.segments.length} 段有效译文；缺失或过期部分仍保留原文，可在翻译选项中继续。`:'还没有当前语言的有效译文。先读原文，或打开翻译选项，核对发送范围与额度后生成；切换视图不会调用模型。';}
}
function setReadingMode(mode) {
 readingMode=mode==='transcript'?'transcript':'summary';
 if(readingMode==='summary'){
  selected=null;$('notes-panel').hidden=true;
  stopRepeating();
 }
 if(readingMode!=='summary'||$('summary-request').hidden)closeSummaryRequest(false);
 applyReadingMode();
}
function renderSummary() {
 const doc=active();if(!doc)return;
 const readiness=Coconut.summaryReadiness(doc);
 const answer=Coconut.latestSummary(doc),freshness=answer?Coconut.summaryFreshness(answer,doc):'empty';
 const persisted=answer && persistedSummaries.get(doc.key)===answer && !storageBlocked;
 $('summary-heading').textContent=answer?'这篇的主要内容':'这篇还没有摘要';
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
   const segment=doc.segments.find(s=>s.id===id);if(!segment)continue;
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
}
$('mode-summary').onclick=()=>setReadingMode('summary');
$('mode-transcript').onclick=()=>{if(active()){active().translation_view='';save();}setReadingMode('transcript');render();};
$('mode-bilingual').onclick=()=>{const doc=active();if(!doc||Coconut.isAudioProject(doc))return;doc.translation_view=doc.translation_view||$('translation-target').value||'zh';save();setReadingMode('transcript');render();};
$('prepare-bilingual').onclick=()=>{closeSummaryRequest(false);$('ai-task').value='question';$('ai-task').dispatchEvent(new Event('change'));$('language-panel').open=true;$('translation-view').scrollIntoView?.({block:'center',behavior:'smooth'});$('translation-view').focus();};
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
  notice('已发起摘要下载，包含引用与历史依据。请检查浏览器下载记录。');
 }catch{notice('摘要导出失败，已保存的摘要仍在此页面，请重试。');}
 finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);}
};
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
  nextURL=URL.createObjectURL(file);const previous=browserMedia.get(key);
  if(key===active()?.key){stopRepeating();$('source-media').querySelector('audio,video')?.pause();}
  browserMedia.set(key,{url:nextURL,kind,name:file.name});if(previous)URL.revokeObjectURL(previous.url);
  if(key===active()?.key){render();}
  notice('媒体只在本次页面读取，未上传。请核对内容和文字稿对应；刷新后重新选择文件即可继续回听。');
 }catch(error){if(nextURL)URL.revokeObjectURL(nextURL);notice('打开媒体失败：'+error.message);}
 finally{input.value='';}
};
$('detach-reader-media').onclick=()=>{
 const key=active()?.key,attachment=browserMedia.get(key);if(!attachment)return;
 changeMediaSelection(key);
 stopRepeating();$('source-media').querySelector('audio,video')?.pause();browserMedia.delete(key);URL.revokeObjectURL(attachment.url);render();
};

let projectTranscriptTarget=null,projectTranscriptRead=0;
$('attach-project-transcript').onclick=()=>{const doc=active();if(Coconut.isAudioProject(doc)){projectTranscriptTarget={key:doc.key,source:JSON.stringify(doc.podcast_source)};$('project-transcript-file').click();}};
$('project-transcript-file').onchange=async()=>{
 const input=$('project-transcript-file'),file=input.files[0],target=projectTranscriptTarget,read=++projectTranscriptRead;projectTranscriptTarget=null;
 if(!file)return;
 try{
  if(!target)throw new Error('请从目标原声项目重新选择文字稿');
  if(file.size>15*1024*1024)throw new Error('文件超过15MB，请先拆分文字稿');
  const text=Coconut.parse(await file.text(),file.name);
  if(read!==projectTranscriptRead)throw new Error('已经选择更新的文字稿，本次导入已取消');
  const persisted=attachTranscriptToProject(text,target);
  notice(persisted?'文字稿已附加到当前项目，原有笔记、时间书签与媒体保留。未调用识别、翻译或摘要模型。':'文字稿已在本页附加，但未能保存，请立即导出 JSON 备份。');
 }catch(error){notice('补充文字稿失败：'+error.message);}
 finally{input.value='';}
};

function attachTranscriptToProject(text,target){
 const index=state.documents.findIndex(doc=>doc.key===target.key),original=state.documents[index];
 if(state.active!==target.key||workspace!=='read'||!Coconut.isAudioProject(original)||JSON.stringify(original.podcast_source)!==target.source)throw new Error('目标项目已经切换或更新，本次未附加文字稿，请重新选择');
 const attached={...Coconut.attachProjectTranscript(original,text),key:original.key};
 state.documents[index]=attached;selected=null;pageStart=0;notesOnly=false;excerptsOnly=false;speakerFilter=null;$('search').value='';
 const persisted=save();setReadingMode('transcript');render();return persisted;
}
