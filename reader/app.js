"use strict";
const $ = (id) => document.getElementById(id);
const KEY = "coconut-reader-v1";
let state = { documents: [], active: null };
let selected = null;
let notesOnly = false;
let excerptsOnly = false;
let workspace = "read";
let readingScroll = 0;
let editingTarget = null;
let sourceTarget = null;
const PAGE_SIZE = 100;
let pageStart = 0;
let storageBlocked = false;
let lastSavedValue = null;
let mediaWorkerReady = false;
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
async function add(doc) {
	const bytes = new TextEncoder().encode(JSON.stringify(doc));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const key = Array.from(new Uint8Array(digest))
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("");
	if (!state.documents.some((d) => d.key === key))
		state.documents.push({ ...doc, key, notes: doc.notes || {} });
	state.active = key;
	$("search").value = "";
	selected = null;
	pageStart = 0;
	notesOnly = false; excerptsOnly = false;
	workspace = "read";
	const saved = save();
	render();
	return saved;
}
function showWorkspace(next) {
	if (workspace === "read" && next === "add") readingScroll = window.scrollY;
	const returning = workspace === "add" && next === "read";
	workspace = next;
	$("add-workspace").hidden = next !== "add";
	$("reader-workspace").hidden = next !== "read" || !active();
	$("back-reading").hidden = next !== "add" || !active();
	$("export").hidden = next !== "read" || !active();
	$("add-content").setAttribute("aria-pressed", String(next === "add"));
	if (returning) window.scrollTo(0, readingScroll);
}
function goToSegment(id) {
	const doc = active();
	const index = doc ? doc.segments.findIndex(s => s.id === id) : -1;
	if (index < 0) return;
	$("search").value = "";
	notesOnly = false; excerptsOnly = false;
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
	const docs = state.documents.filter(d => d.title.toLocaleLowerCase().includes(query));
	$("library-total").textContent = String(state.documents.length);
	$("library-empty").hidden = docs.length > 0;
	$("library-empty").textContent = state.documents.length ? "没有匹配的标题" : "还没有文字稿。添加一份，或体验示例。";
	for (const d of docs) {
		const b = el("button", d.key === state.active ? "active" : "");
		b.append(el("span", "library-title", d.title));
		const bookmark = d.segments.find(s => s.id === d.readingPosition);
		b.append(el("small", "", Coconut.time(d.segments.at(-1).end) + " · " + Object.values(d.notes).filter(Boolean).length + " 则笔记" + (bookmark ? " · 读到 " + Coconut.time(bookmark.start) : "")));
		b.setAttribute("aria-current", d.key === state.active ? "page" : "false");
		b.onclick = () => {
			state.active = d.key;
			selected = null;
			notesOnly = false; excerptsOnly = false;
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
	const mediaPath = mediaWorkerReady && Coconut.media ? Coconut.media(doc.source_media) : "";
	const mediaHost = $("source-media");
	const currentPlayer = mediaHost.querySelector("audio,video");
	if (!mediaPath) {
		mediaHost.replaceChildren();
		mediaHost.hidden = true;
	} else if (!currentPlayer || currentPlayer.getAttribute("src") !== mediaPath) {
		const player = el(doc.source_media.kind, "source-player");
		player.controls = true;
		player.ontimeupdate = highlightPlayback;
		player.preload = "metadata";
		player.src = mediaPath;
		player.setAttribute("aria-label", "原始音视频");
		player.style.width = "100%";
		player.style.maxHeight = "360px";
		player.onerror = () => notice("原始媒体暂时无法播放。请确认此文字稿对应的本地任务仍在这台电脑上。");
		mediaHost.replaceChildren(player);
		mediaHost.hidden = false;
	}
	$("locate-playback").hidden = !mediaPath;
	$("title").textContent = doc.title;
	$("subtitle").textContent =
		doc.segments.length +
		" 个片段 · " +
		Coconut.time(doc.segments.at(-1).end) +
		" · 原话与笔记保存在本机";
	const provenance = doc.provenance || {};
	const sourceKinds = {platform_subtitles: "平台提供的字幕", automatic_subtitles: "平台自动字幕", imported_subtitles: "导入的字幕", local_asr: "本机语音识别"};
	const provenanceText = sourceKinds[provenance.kind] || "导入文字稿，来源未标明";
	$("provenance").textContent = provenanceText + (provenance.model ? " · " + provenance.model : "") + " · 请回听核对专有名词与重要信息" + (provenance.alignment_warning ? " · 时间对齐降级：" + provenance.alignment_warning : "");
	$("count").textContent = "书架 / " + doc.title;
	const query = $("search").value.trim().toLocaleLowerCase();
	const filtered = doc.segments.filter(s=>Coconut.matchesSegment(s,doc,query,notesOnly,excerptsOnly));
	// Clamp after removing the last matching note/excerpt on a later page.
	pageStart = Math.min(pageStart, Math.max(0, Math.floor((filtered.length - 1) / PAGE_SIZE) * PAGE_SIZE));
	const visible = filtered.slice(pageStart, pageStart + PAGE_SIZE);
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
	const playbackHint = mediaPath ? "点时间戳定位本地原声" : Coconut.source(doc.source_url, 0) ? "点时间戳打开原站；若平台未自动定位，请按显示时间手动跳转" : doc.source_media ? "本地媒体尚未连接；请在保存原任务的电脑启动 Coconut" : "尚未关联音视频；点击「原视频链接」添加来源后可回听";
 $("search-status").textContent = ((query || notesOnly || excerptsOnly) ? "找到 " + filtered.length + " 个片段" : "共 " + doc.segments.length + " 个片段") + " · " + playbackHint;
	$("clear-search").hidden = !query && !notesOnly && !excerptsOnly;
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
				player.currentTime = s.start;
				player.play().catch(() => notice("请点击播放器开始播放，再按时间戳定位。"));
			};
			meta.append(seek);
			if (href) { const external = el("a", "original-source", "原站"); external.href=href; external.target="_blank"; external.rel="noopener noreferrer"; meta.append(external); }
		} else if (href) {
			const a = el("a", "", Coconut.time(s.start)); a.href=href; a.target="_blank"; a.rel="noopener noreferrer"; a.title="打开原视频的时间链接；是否自动定位取决于平台"; meta.append(a);
		} else meta.textContent=Coconut.time(s.start);
		const body = el("div");
		if (s.speaker) body.append(el("p", "speaker", s.speaker));
		body.append(el("p", "words", s.text));
        const translated=s.translations?.[doc.translation_view];
        if(translated) body.append(el("p", "translation"+(!Coconut.translationCurrent(s,doc,translated)?" stale":""), Coconut.translationCurrent(s,doc,translated) ? translated.text : "原文或上下文已变化，或旧译文缺少上下文记录，此译文需要重新生成"));
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
		if (doc.notes[s.id]) body.append(el("p", "saved-note", doc.notes[s.id]));
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
$("add-content").onclick = () => { showWorkspace("add"); $("import").focus(); };
$("back-reading").onclick = () => showWorkspace("read");
$("show-jobs").onclick = () => { showWorkspace("add"); $("jobs-heading").scrollIntoView?.(); };
$("toggle-library").onclick = () => $("toggle-library").setAttribute("aria-expanded", String($("toggle-library").getAttribute("aria-expanded") !== "true"));
$("library-search").oninput = renderLibrary;
$("filter-all").onclick = () => { notesOnly = false; excerptsOnly = false; pageStart = 0; render(); };
$("filter-excerpts").onclick = () => { excerptsOnly = true; notesOnly = false; pageStart = 0; render(); };
$("filter-notes").onclick = () => { notesOnly = true; excerptsOnly = false; pageStart = 0; render(); };
$("clear-search").onclick = () => { $("search").value = ""; notesOnly = false; excerptsOnly = false; pageStart = 0; render(); $("search").focus(); };
$("close-note").onclick = () => {
	const id = selected;
	selected = null;
	render();
	const row = [...$("transcript").querySelectorAll(".segment")].find(row => row.dataset.segmentId === id);
	row?.querySelector(".note-button")?.focus();
};
$("return-excerpt").onclick = () => goToSegment(selected);
document.addEventListener("keydown", event => {
	if (event.key === "Escape" && selected && !document.querySelector("dialog[open]")) $("close-note").click();
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
	const count = Coconut.notebookSegments(doc).length;
	$("export-notebook").disabled = count === 0;
	$("export-notebook").textContent = "导出阅读笔记（" + count + " 段）";
}
$("export-notebook").onclick = () => {
	const doc = active();
	if (!doc || !Coconut.notebookSegments(doc).length) {
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
		notice("已发起 Markdown 下载，包含本篇全部摘录与笔记。请检查浏览器下载记录；完整恢复仍需 JSON 备份。");
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
		notice("已发起备份下载，请检查浏览器下载记录并确认文件已保存。备份包含原稿、修正、摘录与笔记。");
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

window.addEventListener("coconut-worker-ready", () => {
	mediaWorkerReady = true;
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
  state = restored; selected=null; pageStart=0; notesOnly=false; excerptsOnly=false; $("search").value=""; workspace="read";
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
