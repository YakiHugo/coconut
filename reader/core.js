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
 function matchesSegment(segment, doc, query, notesOnly=false) {
  return (!notesOnly || Boolean(doc.notes?.[segment.id])) &&
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
            ai_answers: Array.isArray(data.ai_answers) ? data.ai_answers.slice(-20).filter(a=>a && typeof a.question==="string" && typeof a.answer==="string" && Array.isArray(a.citations)).map(a=>({question:a.question.slice(0,4000),answer:a.answer.slice(0,100000),citations:a.citations.filter(id=>ids.has(id)),source_snapshot:a.source_snapshot && typeof a.source_snapshot==="object" ? Object.fromEntries(Object.entries(a.source_snapshot).filter(([id,text])=>ids.has(id)&&typeof text==="string")) : {},provider:typeof a.provider==="string"?a.provider.slice(0,100):"unknown"})) : [],
			title: typeof data.title === "string" ? data.title : "未命名文字稿",
			source_url: typeof data.source_url === "string" ? data.source_url : "",
			segments,
            translation_contexts: cleanContexts(data.translation_contexts, segments),
		};
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
	const api = { time, source, media, validate, parse, matchesSegment, translationCurrent, sameCueSnapshot, subscriptionPlan, cleanContexts };
	if (typeof module !== "undefined" && module.exports) module.exports = api;
	else root.Coconut = api;
})(typeof window !== "undefined" ? window : globalThis);
