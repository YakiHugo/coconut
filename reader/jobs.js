"use strict";
let localWorker = false;
let pollTimer;
let connectingWorker = false;
let workerWasConnected = false;
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
function jobButton(text, action) {
	const button = el("button", "", text);
	button.type = "button";
	button.onclick = async () => {
		button.disabled = true;
		try {
			await action();
			await refreshJobs();
		} catch (error) {
			notice(error.message);
		} finally {
			button.disabled = !localWorker;
		}
	};
	return button;
}
function disconnectedWorker() {
 localWorker = false;
 $("process-url").disabled = true;
 $("import-media").disabled = true;
 $("retry-worker").hidden = false;
 $("retry-worker").textContent = workerWasConnected ? "重新连接" : "重新检查此页面";
 for (const button of $("jobs").querySelectorAll("button")) button.disabled = true;
 $("worker-status").textContent = workerWasConnected
  ? "连接暂时中断 · 下方是上次任务状态，正在尝试重连"
  : (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) ? "暂时无法连接本地处理服务" : "当前是阅读预览 · 未连接本地处理服务");
 $("worker-help").textContent = workerWasConnected
  ? "请检查运行 Coconut 的终端。已提交的任务可能仍在处理；恢复连接后先查看任务列表，避免重复提交。阅读和笔记仍可使用。"
  : "此页面可导入文字稿、阅读和记笔记。处理音视频请按下面的步骤在自己的电脑启动，再打开本地地址。";
 if (!workerWasConnected) $("local-setup").open = true;
 window.dispatchEvent(new Event("coconut-worker-disconnected"));
}
async function refreshJobs() {
	if (!localWorker) return;
	clearTimeout(pollTimer);
	try {
		const data = await jobApi("jobs");
		$("jobs").replaceChildren();
		$("job-count").textContent = String(data.jobs.filter(job => ["queued", "running"].includes(job.status)).length);
		$("jobs-heading").textContent = data.jobs.length ? "处理任务" : "暂无处理任务";
		for (const job of data.jobs) {
			const row = el("section", "job-row");
			const detail = el("div");
			detail.append(
				el("strong", "", job.title),
				el("p", "hint", jobStatus[job.status] + " · " + job.stage),
			);
			if (job.error) detail.append(el("p", "job-error", job.error));
            if (job.playback_retryable) detail.append(el("p", "hint", "文字稿已保留，本地视频尚不可用。重试会复用已完成的文字稿；原站链接仍可使用。"));
			row.append(detail);
			if (job.status === "done")
				row.append(
					jobButton("打开阅读", async () => {
						const doc = Coconut.validate(
							await jobApi("jobs/" + job.id + "/result"),
						);
						await add(doc);
						$("title").scrollIntoView({ behavior: "smooth" });
					}),
				);
			if (["queued", "running"].includes(job.status))
				row.append(
					jobButton("取消", () =>
						jobApi("jobs/" + job.id + "/cancel", jsonPost()),
					),
				);
			if (job.playback_retryable || ["failed", "cancelled", "interrupted"].includes(job.status))
				row.append(
					jobButton(job.playback_retryable ? "重试本地视频" : "重试", () =>
						jobApi("jobs/" + job.id + "/retry", jsonPost()),
					),
				);
			$("jobs").append(row);
		}
		$("worker-status").textContent = "本地处理服务已连接";
  return true;
	} catch {
		disconnectedWorker();
  return false;
 } finally {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => localWorker ? refreshJobs() : connectWorker(), document.hidden ? 15000 : 3000);
 }
}
$("url-form").onsubmit = async (event) => {
	event.preventDefault();
	if (!localWorker) return;
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
		button.disabled = !localWorker;
	}
};
$("import-media").onclick = () => $("media-file").click();
$("media-file").onchange = async () => {
	const file = $("media-file").files[0];
	if (!file) return;
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
		if (!health.local_worker) throw new Error("No local worker");
		localWorker = true;
  if (!await refreshJobs()) return;
  workerWasConnected = true;
  $("local-setup").open = false;
		$("retry-worker").hidden = true;
		$("url-form").hidden = false;
		$("show-jobs").hidden = false;
		$("jobs-heading").hidden = false;
		window.dispatchEvent(new Event("coconut-worker-ready"));
		$("process-url").disabled = false;
		$("import-media").disabled = false;
		$("worker-help").textContent =
			"优先读取现成字幕；需要转录时使用本地模型。首次使用会下载模型。原始结果保存在本机，不会自动调用付费接口。";
 } catch {
  disconnectedWorker();
 } finally {
  connectingWorker = false;
  $("retry-worker").disabled = false;
  if (!localWorker && workerWasConnected) {
   clearTimeout(pollTimer);
   pollTimer = setTimeout(connectWorker, document.hidden ? 15000 : 3000);
  }
 }
}
$("retry-worker").onclick = connectWorker;
connectWorker();
