"use strict";
let localWorker = false;
let pollTimer;
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
			button.disabled = false;
		}
	};
	return button;
}
async function refreshJobs() {
	if (!localWorker) return;
	clearTimeout(pollTimer);
	try {
		const data = await jobApi("jobs");
		$("jobs").replaceChildren();
		for (const job of data.jobs) {
			const row = el("section", "job-row");
			const detail = el("div");
			detail.append(
				el("strong", "", job.title),
				el("p", "hint", jobStatus[job.status] + " · " + job.stage),
			);
			if (job.error) detail.append(el("p", "job-error", job.error));
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
			if (["failed", "cancelled", "interrupted"].includes(job.status))
				row.append(
					jobButton("重试", () =>
						jobApi("jobs/" + job.id + "/retry", jsonPost()),
					),
				);
			$("jobs").append(row);
		}
		$("worker-status").textContent = "本地处理服务已连接";
	} catch {
		$("worker-status").textContent = "连接暂时中断；任务记录仍在本机";
	}
	pollTimer = setTimeout(refreshJobs, document.hidden ? 15000 : 3000);
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
				},
			}),
		);
		notice("任务已加入。可以离开此页，重新打开后查看处理结果。");
		await refreshJobs();
	} catch (error) {
		notice("无法开始：" + error.message);
	} finally {
		button.disabled = false;
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
		notice("导入失败：" + error.message);
	} finally {
		$("media-file").value = "";
		$("import-media").disabled = !localWorker;
	}
};
(async () => {
	try {
		const health = await jobApi("health");
		if (!health.local_worker) throw new Error("No local worker");
		localWorker = true;
		$("process-url").disabled = false;
		$("import-media").disabled = false;
		$("worker-help").textContent =
			"优先读取现成字幕；需要转录时使用本地模型。首次使用会下载模型。原始结果保存在本机，不会自动调用付费接口。";
		await refreshJobs();
	} catch {
		$("worker-status").textContent = "阅读预览模式 · 未连接本地处理服务";
	}
})();
