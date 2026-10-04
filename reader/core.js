(function (root) {
	"use strict";
	function time(seconds) {
		const n = Math.max(0, Math.floor(seconds));
		return (
			(n >= 3600 ? String(Math.floor(n / 3600)).padStart(2, "0") + ":" : "") +
			String(Math.floor(n / 60) % 60).padStart(2, "0") +
			":" +
			String(n % 60).padStart(2, "0")
		);
	}
	function source(url, seconds) {
		if (!url) return "";
		let u;
		try {
			u = new URL(url);
		} catch {
			return "";
		}
		if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
			return "";
		const h = u.hostname.toLowerCase();
		const isX = ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(h);
		if (isX && (u.protocol !== "https:" || u.port && u.port !== "443" ||
			!/^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/status)\/[0-9]{1,20}\/?$/.test(u.pathname))) return "";
		if (
			isX || [
				"www.youtube.com",
				"youtube.com",
				"m.youtube.com",
				"youtu.be",
				"www.bilibili.com",
				"bilibili.com",
				"m.bilibili.com",
			].includes(h)
		) {
			u.searchParams.set("t", String(Math.max(0, Math.floor(seconds))));
			u.hash = "";
			return u.href;
		}
		return "";
	}
	function mediaSource(value) {
		if (
			!value || typeof value !== "object" || Array.isArray(value) ||
			typeof value.job_id !== "string" || !/^[a-f0-9]{32}$/.test(value.job_id) ||
			!["audio", "video"].includes(value.kind)
		) return undefined;
		return { job_id: value.job_id, kind: value.kind };
	}
	function media(value) {
		const association = mediaSource(value);
		return association ? "/api/jobs/" + association.job_id + "/media" : "";
	}
	function cleanTranslations(value) {
 const output=Object.create(null);
 if(!value || typeof value!=="object" || Array.isArray(value)) return output;
 for(const language of ["en","zh","ja","ko","fr","de","es"]) {
  const item=value[language];
  if(item && typeof item.text==="string" && item.text.length<=12000 && typeof item.source_text==="string" && item.source_text.length<=4000 && typeof item.provider==="string")
   output[language]={text:item.text,source_text:item.source_text,provider:item.provider.slice(0,100),source_language:typeof item.source_language==="string"?item.source_language:"",...(typeof item.context_id==="string"&&/^[a-f0-9-]{36}$/.test(item.context_id)?{context_id:item.context_id}:{})};
 }
 return output;
}
 function sameCueSnapshot(doc, cues) {
  return Boolean(doc) && cues.every(c=>{const current=doc.segments[c.position];return current?.id===c.id && current.text===c.text && current.start===c.start && current.end===c.end;});
 }
 function translationCurrent(segment, doc, item) {
  if(!item || item.source_text!==segment.text)return false;
  if(!item.context_id)return !item.provider?.endsWith('_subscription_translation');
  const snapshot=doc.translation_contexts?.[item.context_id];
  return Array.isArray(snapshot) && snapshot.some(c=>c.id===segment.id) && sameCueSnapshot(doc,snapshot);
 }
 function cleanContexts(value, segments) {
  const output=Object.create(null), referenced=new Set(segments.flatMap(s=>Object.values(s.translations).map(t=>t.context_id).filter(Boolean)));
  if(!value || typeof value!=='object' || Array.isArray(value))return output;
  for(const key of referenced){
   if(!Object.hasOwn(value,key))continue;
   const cues=value[key];let prior=-1,chars=0;const ids=new Set();
   if(!Array.isArray(cues)||!cues.length||cues.length>36)continue;
   const valid=cues.every(c=>{
    if(!c||typeof c.id!=='string'||c.id.length<1||c.id.length>200||ids.has(c.id)||typeof c.text!=='string'||!c.text.length||c.text.length>4000||!Number.isSafeInteger(c.position)||c.position<0||c.position<=prior||!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.start<0||c.end<c.start)return false;
    ids.add(c.id);prior=c.position;chars+=c.text.length;return true;
   });
   if(valid&&chars<=40000)output[key]=cues.map(c=>({id:c.id,text:c.text,position:c.position,start:c.start,end:c.end}));
  }
  return output;
 }
 function subscriptionPlan(doc, selectedIds, source, target, provider) {
  const selected=new Set(selectedIds),runs=[];
  for(let position=0;position<doc.segments.length;position++){
   const s=doc.segments[position];if(!selected.has(s.id))continue;
   if(!s.id.length||s.id.length>200||!s.text.length||s.text.length>4000)throw new Error('订阅翻译需要每段1–4000字符、片段ID不超过200字符，请先缩小或修正内容');
   const cue={id:s.id,text:s.text,position,start:s.start,end:s.end};
   if(!runs.length||runs.at(-1).at(-1).position!==position-1)runs.push([]);
   runs.at(-1).push(cue);
  }
  const windows=[];
  for(const run of runs){
   for(let start=0;start<run.length;){
    let end=start,chars=0;
    while(end<run.length&&end-start<32&&chars+run[end].text.length<=24000){chars+=run[end].text.length;end++;}
    const segments=run.slice(start,end).filter(c=>{const s=doc.segments[c.position],t=s.translations?.[target];return !(translationCurrent(s,doc,t)&&t.source_language===source&&t.provider===provider);});
    const targetIds=new Set(segments.map(c=>c.id));
    const snapshot=run.slice(Math.max(0,start-2),Math.min(run.length,end+2));
    if(segments.length)windows.push({segments,context:snapshot.filter(c=>!targetIds.has(c.id)),snapshot});
    start=end;
   }
  }
  return {windows,selected:runs.flat().length,total:windows.reduce((n,w)=>n+w.segments.length,0),sent:new Set(windows.flatMap(w=>w.snapshot.map(c=>c.id))).size};
 }
 // Only the exact ordered {id,text} payload is evidence for a saved answer.
 // Never discard missing IDs: doing so would make a removed dependency look current.
 function cleanAnswerInput(value) {
  if(!value || value.version!==1 || !Array.isArray(value.segments) || !value.segments.length || value.segments.length>5000)return undefined;
  const ids=new Set();let chars=0;
  if(!value.segments.every(s=>{
   if(!s || typeof s.id!=="string" || !s.id.length || s.id.length>400 || ids.has(s.id) || typeof s.text!=="string")return false;
   ids.add(s.id);chars+=s.id.length+s.text.length;return chars<=500000;
  }))return undefined;
  return {version:1,segments:value.segments.map(s=>({id:s.id,text:s.text}))};
 }
 function answerFreshness(answer, doc) {
  const input=cleanAnswerInput(answer.input_snapshot);
  if(!input)return 'unknown'; // Legacy source_snapshot only covered citations.
  const selected=new Set(input.segments.map(s=>s.id));
  const current=doc.segments.filter(s=>selected.has(s.id));
  return current.length===input.segments.length && current.every((s,i)=>s.id===input.segments[i].id && s.text===input.segments[i].text) ? 'current' : 'stale';
 }
 function matchesSegment(segment, doc, query, notesOnly=false, excerptsOnly=false) {
  return (!notesOnly || Boolean(doc.notes?.[segment.id])) && (!excerptsOnly || segment.saved_excerpt === true) &&
   [segment.text,segment.speaker||"",doc.notes?.[segment.id]||"",...Object.values(segment.translations||{}).filter(t=>translationCurrent(segment,doc,t)).map(t=>t.text)].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
 }
	function validate(data) {
		if (
			!data ||
			!Array.isArray(data.segments) ||
			!data.segments.length ||
			data.segments.length > 100000
		)
			throw new Error("文字稿必须包含 1–100,000 个片段");
		let prior = -1;
		const ids = new Set();
		const segments = data.segments.map((s, i) => {
			if (
				!s ||
				typeof s.text !== "string" ||
				!Number.isFinite(s.start) ||
				!Number.isFinite(s.end) ||
				s.start < 0 ||
				s.end < s.start ||
				s.start < prior
			)
				throw new Error("第 " + (i + 1) + " 段内容或时间戳无效");
			prior = s.start;
			const id = typeof s.id === "string" ? s.id : "segment-" + (i + 1);
			if (ids.has(id)) throw new Error("片段标识重复");
			ids.add(id);
			return {
				id,
				start: s.start,
				end: s.end,
				text: s.text,
				...(s.saved_excerpt === true ? {saved_excerpt: true} : {}),
				...(typeof s.original_text === "string"
					? { original_text: s.original_text }
					: {}),
				speaker: typeof s.speaker === "string" ? s.speaker : null,
				translations: cleanTranslations(s.translations),
			};
		});
		const notes = Object.create(null);
		if (
			data.notes &&
			typeof data.notes === "object" &&
			!Array.isArray(data.notes)
		) {
			for (const id of ids) {
				if (Object.hasOwn(data.notes, id) && typeof data.notes[id] === "string")
					notes[id] = data.notes[id];
			}
		}
		const provenance =
			data.provenance && typeof data.provenance === "object"
				? Object.fromEntries(
						["kind", "model", "backend", "language", "alignment_warning", "playback_warning", "media_id"]
							.filter((k) => typeof data.provenance[k] === "string")
							.map((k) => [k, data.provenance[k]]),
					)
				: undefined;
		if (provenance && Number.isFinite(data.provenance.media_duration) && data.provenance.media_duration > 0 && data.provenance.media_duration <= 21600)
			provenance.media_duration = data.provenance.media_duration;
		const sourceMedia = mediaSource(data.source_media);
		return {
			notes,
			...(typeof data.readingPosition === "string" && ids.has(data.readingPosition) ? {readingPosition: data.readingPosition} : {}),
			...(provenance ? { provenance } : {}),
			...(sourceMedia ? { source_media: sourceMedia } : {}),
			schema_version: 1,
            language: typeof data.language === "string" ? data.language : "",
            translation_view: ["en","zh","ja","ko","fr","de","es"].includes(data.translation_view) ? data.translation_view : "",
            ai_answers: Array.isArray(data.ai_answers) ? data.ai_answers.slice(-20).filter(a=>a && typeof a.question==="string" && typeof a.answer==="string" && Array.isArray(a.citations)).map(a=>({question:a.question.slice(0,4000),answer:a.answer.slice(0,100000),citations:a.citations.filter(id=>ids.has(id)),...(cleanAnswerInput(a.input_snapshot) ? {input_snapshot:cleanAnswerInput(a.input_snapshot)} : {}),provider:typeof a.provider==="string"?a.provider.slice(0,100):"unknown"})) : [],
			title: typeof data.title === "string" ? data.title : "未命名文字稿",
			source_url: typeof data.source_url === "string" ? data.source_url : "",
			segments,
            translation_contexts: cleanContexts(data.translation_contexts, segments),
		};
	}
	function notebookSegments(doc) {
		return doc.segments.filter(s => s.saved_excerpt === true || Boolean(doc.notes?.[s.id]?.trim()));
	}
	function markdownText(value) {
		return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/[\\`*_{}\[\]()#+.!|~$-]/g, "\\$&");
	}
	function notebookMarkdown(doc) {
		const kept = notebookSegments(doc);
		const text = value => markdownText(value).replace(/\r\n?/g, "\n");
		const singleLine = value => text(value).replace(/\n/g, " ");
		const quote = value => text(value).split("\n").map(line => "> " + line).join("\n");
		const sourceLink = seconds => source(doc.source_url, seconds).replace(/[()]/g, char => char === "(" ? "%28" : "%29");
		const lines = ["# " + singleLine(doc.title), "", "Coconut 阅读笔记 · " + kept.length + " 个片段", "",
			"以下包含本篇全部摘录和非空笔记，不受当前搜索筛选影响。文字稿可能有识别错误，请回听核对。", "",
			"Markdown 用于阅读与整理；完整恢复请另存 Coconut JSON 备份。此文件不包含媒体。", ""];
		const origin = sourceLink(0);
		if (origin) lines.push("[原始来源](" + origin + ")", "");
		else lines.push("未关联可用的原站链接；时间戳仅用于在原始媒体中定位。", "");
		for (const segment of kept) {
			const range = time(segment.start) + "–" + time(segment.end);
			const href = sourceLink(segment.start);
			lines.push("## " + (href ? "[" + range + "](" + href + ")" : range), "");
			lines.push("片段 ID：" + singleLine(segment.id) + (segment.speaker ? " · 说话人标签：" + singleLine(segment.speaker) : ""), "");
			if (segment.saved_excerpt === true) lines.push("已摘录整段", "");
			const corrected = segment.original_text !== undefined && segment.original_text !== segment.text;
			lines.push(corrected ? "原文（已修正）：" : "原文：", "", quote(segment.text), "");
			if (corrected) lines.push("修正前文字稿：", "", quote(segment.original_text), "");
			const translated = segment.translations?.[doc.translation_view];
			if (translated) {
				if (translationCurrent(segment, doc, translated)) lines.push("译文（" + singleLine(doc.translation_view) + "；" + singleLine(translated.provider) + "，机器生成，需核对）：", "", quote(translated.text), "");
				else lines.push("此片段译文已过期，未导出。", "");
			}
			if (doc.notes?.[segment.id]?.trim()) lines.push("我的笔记：", "", quote(doc.notes[segment.id]), "");
		}
		return lines.join("\n");
	}
	function seconds(value) {
		if (!/^(?:\d{2,}:)?[0-5]\d:[0-5]\d[.,]\d{3}$/.test(value)) throw new Error("字幕时间格式无效");
		const parts = value.replace(",", ".").split(":").map(Number);
		if (
			parts.some((n) => !Number.isFinite(n)) ||
			parts.length < 2 ||
			parts.length > 3
		)
			throw new Error("字幕时间格式无效");
		return parts.reduce((n, v) => n * 60 + v, 0);
	}
	function subtitleText(value) {
		const plain = value.replace(/<\/?(?:b|i|u|ruby|rt|v|c|X-word-ms)(?:[ .][^>]*)?>|<\d{2}:\d{2}(?::\d{2})?\.\d{3}>/gi, "");
		const names = {amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" "};
		return plain.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (match, key) => {
			if (key[0] !== "#") return names[key.toLowerCase()] || match;
			const code = key[1].toLowerCase() === "x" ? Number.parseInt(key.slice(2),16) : Number.parseInt(key.slice(1),10);
			return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
		});
	}
	function parse(text, filename) {
		if (filename.toLowerCase().endsWith(".json"))
			return validate(JSON.parse(text));
		const blocks = text
			.replace(/^\uFEFF/, "")
			.replace(/\r\n?/g, "\n")
			.split(/\n\s*\n/);
		const segments = [];
		for (const block of blocks) {
			const lines = block.split("\n");
			const index = lines.findIndex((line) => line.includes("-->"));
			if (index < 0) continue;
			const match = lines[index].match(/^(\S+)\s+-->\s+(\S+)/);
			if (!match) throw new Error("无法识别字幕时间");
			const body = subtitleText(lines.slice(index + 1).join("\n")).trim();
			if (body)
				segments.push({
					id: "segment-" + (segments.length + 1),
					start: seconds(match[1]),
					end: seconds(match[2]),
					text: body,
					speaker: null,
				});
		}
		return validate({
			title: filename.replace(/\.(srt|vtt)$/i, ""),
			source_url: "",
			segments,
		});
	}
	const api = { time, source, media, validate, parse, matchesSegment, notebookSegments, notebookMarkdown, translationCurrent, sameCueSnapshot, subscriptionPlan, cleanContexts, answerFreshness };
	if (typeof module !== "undefined" && module.exports) module.exports = api;
	else root.Coconut = api;
})(typeof window !== "undefined" ? window : globalThis);
