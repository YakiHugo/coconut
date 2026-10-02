"use strict";
const $ = (id) => document.getElementById(id);
const KEY = "coconut-reader-v1";
let state = { documents: [], active: null };
let selected = null;
let editingTarget = null;
let sourceTarget = null;
let currentLimit = 100;
let storageBlocked = false;
let lastSavedValue = null;
let mediaWorkerReady = false;
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
	notice(
		"上次保存的数据无法读取，已停止写入以保留原数据。本次内容可继续阅读，请导出备份后再关闭页面。",
	);
}
function save() {
	if (storageBlocked) {
		notice(
			"自动保存已暂停，原有数据未覆盖。请导出本次文字稿与笔记后再关闭页面。",
		);
		return false;
	}
	try {
		if (localStorage.getItem(KEY) !== lastSavedValue) {
			storageBlocked = true;
			notice("另一个页面更新了书架，已暂停保存以避免覆盖。请先导出本页修改，再刷新读取最新数据。");
			return false;
		}
		const nextValue = JSON.stringify(state);
		localStorage.setItem(KEY, nextValue);
		lastSavedValue = nextValue;
		return true;
	} catch {
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
	currentLimit = 100;
	const saved = save();
	render();
	return saved;
}
function render() {
	const doc = active();
	$("library").replaceChildren();
	for (const d of state.documents) {
		const b = el("button", d.key === state.active ? "active" : "", d.title);
		b.onclick = () => {
			state.active = d.key;
			selected = null;
			currentLimit = 100;
			$("search").value = "";
			save();
			render();
		};
		$("library").append(b);
	}
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
		player.preload = "metadata";
		player.src = mediaPath;
		player.setAttribute("aria-label", "原始音视频");
		player.style.width = "100%";
		player.style.maxHeight = "360px";
		player.onerror = () => notice("原始媒体暂时无法播放。请确认此文字稿对应的本地任务仍在这台电脑上。");
		mediaHost.replaceChildren(player);
		mediaHost.hidden = false;
	}
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
	const currentNote = doc.segments.find((segment) => segment.id === selected);
	if (!currentNote) selected = null;
	$("notes-panel").hidden = !selected;
	if (currentNote) {
		$("quote").textContent = currentNote.text;
		$("note-time").textContent = Coconut.time(currentNote.start) + " 的想法";
		$("note").value = doc.notes[currentNote.id] || "";
	}
	const query = $("search").value.trim().toLocaleLowerCase();
	const filtered = doc.segments.filter((s) =>
		[s.text, s.speaker || "", doc.notes[s.id] || ""]
			.join(" ")
			.toLocaleLowerCase()
			.includes(query),
	);
	$("transcript").replaceChildren();
	for (const s of filtered.slice(0, currentLimit)) {
		const row = el(
			"section",
			"segment" + (selected === s.id ? " selected" : ""),
		);
		row.dataset.segmentId = s.id;
		const meta = el("div", "time");
		const href = Coconut.source(doc.source_url, s.start);
		if (href) {
			const a = el("a", "", Coconut.time(s.start));
			a.href = href;
			a.target = "_blank";
			a.rel = "noopener noreferrer";
			a.title = "回到原视频此刻";
			meta.append(a);
		} else if (mediaPath) {
			const seek = el("button", "", Coconut.time(s.start));
			seek.title = "回听本地原文件此刻";
			seek.onclick = () => {
				const player = mediaHost.querySelector("audio,video");
				if (!player) return;
				player.currentTime = s.start;
				player.play().catch(() => notice("请点击播放器开始播放，再按时间戳定位。"));
			};
			meta.append(seek);
		} else meta.textContent = Coconut.time(s.start);
		const body = el("div");
		if (s.speaker) body.append(el("p", "speaker", s.speaker));
		body.append(el("p", "words", s.text));
		const edit = el("button", "", "修正文字");
		edit.onclick = () => {
			editingTarget = { documentKey: doc.key, segmentId: s.id };
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
		if (doc.notes[s.id]) body.append(el("p", "saved-note", doc.notes[s.id]));
		row.append(meta, body);
		$("transcript").append(row);
	}
	if (!filtered.length)
		$("transcript").append(el("p", "hint", "没有匹配的片段，试试另一个词。"));
	if (filtered.length > currentLimit) {
		const more = el("button", "", "继续阅读后面的片段");
		more.onclick = () => {
			currentLimit += 100;
			render();
		};
		$("transcript").append(more);
	}
}
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
	currentLimit = 100;
	render();
};
$("note").oninput = () => {
	const d = active();
	if (d && selected) {
		d.notes[selected] = $("note").value;
		save();
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
		$("source-error").textContent = "请填写有效的 YouTube 或 Bilibili 视频链接";
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
		notice("已发起备份下载，请检查浏览器下载记录并确认文件已保存。备份包含原稿、修正与笔记。");
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
