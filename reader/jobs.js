"use strict";
let localWorker = false;
let localAgents = false;
let sourcePodcastReady = false;
let sourceSubmitting = false;
let pollTimer;
let connectingWorker = false;
let queueRefreshSequence = 0;
let workerWasConnected = false;
const pendingJobActions = new Set();
const jobStatus = {
	queued: "排队中",
	running: "处理中",
	done: "可以阅读",
	failed: "处理失败",
	cancelled: "已取消",
	interrupted: "中断，等待重试",
};
async function jobApi(path, options = {}) {
	const response = await fetch("api/" + path, {
		...options,
		signal: AbortSignal.timeout(30000),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || "请求失败");
	return data;
}
function jsonPost(data = {}) {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	};
}
function updateJobButtons(identifier) {
 for (const row of $("jobs").children) {
  if (identifier !== undefined && row.dataset.jobId !== identifier) continue;
  const pending = pendingJobActions.has(row.dataset.jobId);
  row.setAttribute("aria-busy", String(pending));
  for (const button of row.querySelectorAll("button")) button.disabled = !localWorker || pending;
 }
}
function jobButton(text, action, identifier, name) {
 const button = el("button", "", text);
 button.type = "button";
 button.dataset.jobAction = name;
 button.onclick = async () => {
  if (!localWorker || pendingJobActions.has(identifier)) return;
  pendingJobActions.add(identifier);
  updateJobButtons(identifier);
  try {
   await action();
   await refreshJobs();
  } catch (error) {
   notice(error.message);
  } finally {
   pendingJobActions.delete(identifier);
   updateJobButtons(identifier);
  }
 };
 return button;
}
function renderJobs(jobs) {
 const host = $("jobs");
 const focused = document.activeElement;
 const focusedRow = focused?.closest?.(".job-row");
 const focusId = host.contains(focusedRow) ? focusedRow.dataset.jobId : null;
 const focusAction = focused?.dataset.jobAction;
 const existing = new Map([...host.children].map(row => [row.dataset.jobId, row]));
 const retained = new Set();
 for (const [index, job] of jobs.entries()) {
  const signature = JSON.stringify([job.title, job.status, job.stage, job.error, job.playback_retryable]);
  let row = existing.get(job.id);
  if (!row || row.dataset.signature !== signature) {
   const replacement = el("section", "job-row");
   replacement.dataset.jobId = job.id;
   replacement.dataset.signature = signature;
   replacement.tabIndex = -1;
   replacement.setAttribute("aria-label", job.title);
   const detail = el("div");
   detail.append(el("strong", "", job.title), el("p", "hint", jobStatus[job.status] + " · " + job.stage));
   if (job.error) detail.append(el("p", "job-error", job.error));
   if (job.playback_retryable) detail.append(el("p", "hint", "文字稿已保留，本地视频尚不可用。重试会复用已完成的文字稿；原站链接仍可使用。"));
   replacement.append(detail);
   if (job.status === "done") replacement.append(jobButton("打开阅读", async () => {
    const doc = Coconut.validate(await jobApi("jobs/" + job.id + "/result"));
    await add(doc);
    $("title").scrollIntoView({ behavior: "smooth" });
   }, job.id, "open"));
   if (["queued", "running"].includes(job.status)) replacement.append(jobButton("取消", () => jobApi("jobs/" + job.id + "/cancel", jsonPost()), job.id, "cancel"));
   if (job.playback_retryable || ["failed", "cancelled", "interrupted"].includes(job.status)) replacement.append(jobButton(job.playback_retryable ? "重试本地视频" : "重试", () => jobApi("jobs/" + job.id + "/retry", jsonPost()), job.id, "retry"));
   if (row) row.replaceWith(replacement);
   row = replacement;
  }
  if (host.children[index] !== row) host.insertBefore(row, host.children[index] || null);
  retained.add(row);
 }
 for (const row of [...host.children]) if (!retained.has(row)) row.remove();
 updateJobButtons();
 // Refresh only restores a focus target that it removed, never another field.
 if (focusId && !focused.isConnected && !$("add-workspace").hidden) {
  const row = [...host.children].find(item => item.dataset.jobId === focusId);
  const action = row && [...row.querySelectorAll("button")].find(button => button.dataset.jobAction === focusAction && !button.disabled);
  (action || row || $("jobs-heading")).focus({preventScroll:true});
 }
}
function disconnectedWorker() {
 localWorker = false;
 localAgents = false;
 sourcePodcastReady=false;
 $("advanced-import-options").hidden=true;$("advanced-media-import").hidden=true;
 $("process-url").disabled = false;
 $("import-media").disabled = true;
 $("retry-worker").hidden = false;
 $("retry-worker").textContent = workerWasConnected ? "重新连接" : "重新检查此页面";
 for (const button of $("jobs").querySelectorAll("button")) button.disabled = true;
 $("worker-status").textContent = workerWasConnected
  ? "连接暂时中断 · 下方是上次任务状态，正在尝试重连"
  : (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) ? "暂时无法连接本地处理服务" : "阅读预览 · 未连接本地服务");
 $("worker-help").textContent = workerWasConnected
  ? "请检查运行 Coconut 的终端。已提交的任务可能仍在处理；恢复连接后先查看任务列表，避免重复提交。阅读和笔记仍可使用。"
  : "Web 阅读无需安装。导入文字稿后可选择本地音频或视频同步回听，文件不上传。生成摘要与翻译需连接本地 AI 工具。";
 // Keep the setup guide available without expanding it on every failed probe.
 window.dispatchEvent(new Event("coconut-worker-disconnected"));
}
async function refreshJobs() {
	if (!localWorker) return;
 const request = ++queueRefreshSequence;
	clearTimeout(pollTimer);
	try {
		const data = await jobApi("jobs");
  if (request !== queueRefreshSequence) return false;
        $("job-count").textContent = String(data.jobs.filter(job => ["queued", "running"].includes(job.status)).length);
        $("jobs-heading").textContent = data.jobs.length ? "处理任务" : "暂无处理任务";
        renderJobs(data.jobs);
		$("worker-status").textContent = "本地处理服务已连接";
  return true;
	} catch {
  if (request === queueRefreshSequence) disconnectedWorker();
  return false;
 } finally {
  if (request === queueRefreshSequence) {
   clearTimeout(pollTimer);
   pollTimer = setTimeout(() => localWorker ? refreshJobs() : connectWorker(), document.hidden ? 15000 : 3000);
  }
 }
}
function updateCaptionOptions() {
 const captionsOnly = $("captions-only").checked;
 if (captionsOnly) $("force-asr").checked = false;
 $("force-asr").disabled = captionsOnly;
 $("asr-option-help").textContent = captionsOnly
  ? "没有可用字幕时会停止。取消「仅使用现成字幕」才允许本机语音识别，首次可能下载模型。"
  : "已允许本机语音识别，首次可能下载模型。勾选「重新转录」会跳过现成字幕。";
}
$("captions-only").onchange = updateCaptionOptions;
updateCaptionOptions();
$("url-form").onsubmit = async (event) => {
	event.preventDefault();
	if (sourceSubmitting) return;
 const raw=$("video-url").value.trim();
 let url;try{url=new URL(raw);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error();}catch{$("source-route-status").textContent="请粘贴不含登录凭据的公开 http / https 链接。";return;}
 const video=new Set(['youtube.com','www.youtube.com','m.youtube.com','youtu.be','bilibili.com','www.bilibili.com','m.bilibili.com','b23.tv','x.com','www.x.com','twitter.com','www.twitter.com','mobile.twitter.com']).has(url.hostname);
 if(!video&&sourcePodcastReady){
  $("source-route-status").textContent="正在查找这个链接对应的公开节目。";
  $("podcast-url").value=raw;await $("podcast-form").onsubmit(event);return;
 }
 podcastRequest?.abort();podcastRequest=null;setPodcastBusy(false);
 $("podcast-results").querySelectorAll("audio,video").forEach(player=>player.pause());
 $("podcast-results").replaceChildren();podcastMessage("");
 if(!video||!localWorker){
  $("source-route-status").textContent=video&&localAgents?"这个视频来源暂需可选高级服务。轻量版可直接读取公开播客来源，或导入已取得的字幕；不会自动安装 Python 或识别模型。":"请在 Coconut 桌面应用或本地服务中添加公开链接。这里可以直接导入文字稿和播放本地媒体。";
  $("local-setup").open=true;return;
 }
 sourceSubmitting=true;
 $("source-route-status").textContent="已识别为视频链接，将按下方处理选项创建任务。";
 const button = $("process-url");
	button.disabled = true;
	try {
		await jobApi(
			"jobs",
			jsonPost({
				url: $("video-url").value.trim(),
				options: {
					language: $("import-language").value || null,
					force_transcribe: $("force-asr").checked,
					captions_only: $("captions-only").checked,
					keep_media: $("keep-media").checked,
				},
			}),
		);
		notice("任务已加入。可以离开此页，重新打开后查看处理结果。");
		await refreshJobs();
	} catch (error) {
		notice("提交未确认：" + error.message + "。请先查看任务列表，确认是否已创建，避免重复提交。");
  await refreshJobs();
	} finally {
		button.disabled = false;sourceSubmitting=false;
	}
};
function allowMediaRecognition() {
 if (!$("captions-only").checked) return true;
 $("captions-only").closest("details").open = true;
 $("captions-only").focus();
 notice("本地音视频需要语音识别。请先在处理选项取消「仅使用现成字幕」；首次可能下载模型。已有文字稿可直接导入阅读。");
 return false;
}
$("import-media").onclick = () => { if (allowMediaRecognition()) $("media-file").click(); };
$("media-file").onchange = async () => {
	const file = $("media-file").files[0];
	if (!file) return;
 if (!allowMediaRecognition()) { $("media-file").value = ""; return; }
	$("import-media").disabled = true;
	try {
		if (file.size > 200 * 1024 * 1024)
			throw new Error("首版本地处理服务限制为200 MiB，请先拆分文件");
		await jobApi(
			"uploads?filename=" +
				encodeURIComponent(file.name) +
				"&language=" +
				encodeURIComponent($("import-language").value),
			{
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body: file,
			},
		);
		notice("文件已交给你电脑上的本地处理服务，不会上传到云端。");
		await refreshJobs();
	} catch (error) {
		notice("导入未确认：" + error.message + "。若已发送文件，请先检查任务列表，避免重复导入。");
  await refreshJobs();
	} finally {
		$("media-file").value = "";
		$("import-media").disabled = !localWorker;
	}
};
async function connectWorker() {
 if (connectingWorker) return;
 connectingWorker = true;
 clearTimeout(pollTimer);
 $("retry-worker").disabled = true;
	try {
		const health = await jobApi("health");
		if (!health.local_worker && health.capabilities?.local_agents !== true) throw new Error("No local worker");
  if (!health.local_worker) {
   const newlyConnected = !localAgents;
   localWorker=false;localAgents=true;workerWasConnected=true;
   $("local-setup").open=false;$("retry-worker").hidden=true;
   $("url-form").hidden=false;sourcePodcastReady=health.capabilities?.podcast_import===true;$("advanced-import-options").hidden=true;$("advanced-media-import").hidden=true;$("show-jobs").hidden=true;$("jobs-heading").hidden=true;$("jobs").hidden=true;
   $("process-url").disabled=false;$("import-media").disabled=true;
   $("worker-status").textContent="轻量本地服务已连接 · 无需 Python";
   $("worker-help").textContent="可导入文字稿、在浏览器中同步回听音视频，并调用已登录的本地 CLI。可从公开播客源导入文字稿与回听媒体；不含 ASR 或离线翻译模型，不会自动发送原文。";
   if(newlyConnected)window.dispatchEvent(new CustomEvent("coconut-worker-ready",{detail:{local_agents:true,media_import:false,podcast_import:health.capabilities?.podcast_import===true}}));
   return;
  }
  localAgents=true;sourcePodcastReady=health.capabilities?.podcast_import===true;
		localWorker = true;
 $("advanced-import-options").hidden=false;$("advanced-media-import").hidden=false;
  if (!await refreshJobs()) return;
  workerWasConnected = true;
  $("local-setup").open = false;
		$("retry-worker").hidden = true;
		$("url-form").hidden = false;
		$("show-jobs").hidden = false;
		$("jobs-heading").hidden = false;
        $("jobs").hidden = false;
		window.dispatchEvent(new CustomEvent("coconut-worker-ready",{detail:{local_agents:true,media_import:true,podcast_import:health.capabilities?.podcast_import===true}}));
		$("process-url").disabled = false;
		$("import-media").disabled = false;
		$("worker-help").textContent =
			"默认仅使用现成字幕，没有字幕时停止。只有取消「仅使用现成字幕」才会使用本地语音模型，首次可能下载模型。原始结果保存在本机，不会自动调用付费接口。";
 } catch {
  disconnectedWorker();
 } finally {
  connectingWorker = false;
  $("retry-worker").disabled = false;
  if (!localWorker && workerWasConnected) {
   clearTimeout(pollTimer);
   pollTimer = setTimeout(connectWorker, localAgents ? 15000 : (document.hidden ? 15000 : 3000));
  }
 }
}
$("retry-worker").onclick = connectWorker;
connectWorker();
