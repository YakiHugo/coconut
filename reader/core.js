(function (root) {
	"use strict";
 const Summaries=typeof module!=="undefined"&&module.exports?require("./summary.js"):root.CoconutSummary;
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
 function podcastURL(value) {
  if(typeof value!=="string"||value.length>4096)return "";
  try { const url=new URL(value);return ["http:","https:"].includes(url.protocol)&&!url.username&&!url.password&&!url.port&&url.href.length<=4096?url.href:""; }catch{return "";}
 }
 function podcastOrigin(doc) {
  return doc.podcast_source ? (podcastURL(doc.source_url)||podcastURL(doc.podcast_source.feed_url)).replace(/[()]/g,c=>c==='('?'%28':'%29') : '';
 }
 function podcastSource(value) {
  if(!value||typeof value!=="object"||Array.isArray(value))return undefined;
  const feed=podcastURL(value.feed_url),mediaURL=podcastURL(value.media_url),transcriptURL=podcastURL(value.transcript_url);
  if(value.kind==='direct_media')return mediaURL&&['audio','video'].includes(value.media_kind)?{kind:'direct_media',media_url:mediaURL,media_kind:value.media_kind}:undefined;
  if(!feed||typeof value.episode_id!=="string"||!value.episode_id||value.episode_id.length>1000)return undefined;
  return {feed_url:feed,episode_id:value.episode_id,...(mediaURL?{media_url:mediaURL}:{}),...(transcriptURL?{transcript_url:transcriptURL}:{}),...(['audio','video'].includes(value.media_kind)?{media_kind:value.media_kind}:{})};
 }
 function isAudioProject(doc) { return doc?.project_kind==='audio_only'; }
 const AUDIO_NOTE_BUDGET=1000000;
 function audioNoteCharacters(doc) {return (doc.project_note?.length||0)+(doc.timestamp_bookmarks||[]).reduce((total,item)=>total+item.note.length,0);}
 function audioProjectIdentity(doc) {
  const origin=podcastSource(doc?.podcast_source);
  if(!origin)return '';
  return JSON.stringify(origin.kind==='direct_media'?['direct_media',origin.media_url]:['podcast',origin.feed_url,origin.episode_id]);
 }
 function hasProjectAnnotations(doc){return Boolean(doc&&Object.hasOwn(doc,'project_note')&&Array.isArray(doc.timestamp_bookmarks));}
 function projectAnnotationCount(doc){return (doc.project_note?.trim()?1:0)+(doc.timestamp_bookmarks?.length||0);}
 function projectAnnotations(data){
  if(data.project_note!==undefined&&(typeof data.project_note!=='string'||data.project_note.length>100000))throw new Error('项目笔记不能超过100,000字符');
  const bookmarks=data.timestamp_bookmarks??[],ids=new Set();
  if(!Array.isArray(bookmarks)||bookmarks.length>2000)throw new Error('每个原声项目最多保存2,000个时间书签');
  for(const item of bookmarks){
   if(!item||typeof item.id!=='string'||!item.id.length||item.id.length>200||ids.has(item.id)||!Number.isFinite(item.time)||item.time<0||item.time>604800||typeof item.note!=='string'||item.note.length>10000)throw new Error('时间书签内容或时间无效');
   ids.add(item.id);
  }
  if(audioNoteCharacters({...data,timestamp_bookmarks:bookmarks})>AUDIO_NOTE_BUDGET)throw new Error('项目笔记与书签笔记总量不能超过1,000,000字符，请拆分备份');
  return {project_note:data.project_note||'',timestamp_bookmarks:bookmarks.map(({id,time,note})=>({id,time,note}))};
 }
 function attachProjectTranscript(project, transcript){
  if(!isAudioProject(project))throw new Error('只能为尚未导入文字稿的原声项目补充原文');
  const original=validateAudioProject(project),text=validate(transcript);
  if(isAudioProject(text))throw new Error('请选择真正的 JSON / SRT / VTT 定时文字稿，原声项目没有可附加的原文');
  const result={...text,title:original.title,language:text.language||original.language,source_url:original.source_url,podcast_source:original.podcast_source,
   ...projectAnnotations(original),...(original.media_duration?{media_duration:original.media_duration}:{})};
  // The selected file supplies words, not an unrelated local media job association.
  delete result.source_media;
  if(audioProjectIdentity(original)===audioProjectIdentity(text)&&original.podcast_source.media_url===text.podcast_source?.media_url&&original.podcast_source.media_kind===text.podcast_source?.media_kind&&text.podcast_source.transcript_url){
   result.podcast_source={...original.podcast_source,transcript_url:text.podcast_source.transcript_url};
  }
  const attached=validate(result),key=typeof project.key==='string'?project.key:'k'.repeat(200);
  if(new TextEncoder().encode(JSON.stringify({...attached,key},null,2)).byteLength>15*1024*1024)throw new Error('合并后的 JSON 备份超过15MB，无法可靠重新导入；原项目保留，请先整理或拆分文字稿与笔记');
  return attached;
 }
 function validateAudioProject(data) {
  const origin=podcastSource(data.podcast_source);
  if(!Array.isArray(data.segments)||data.segments.length||!origin?.media_url)throw new Error('原声项目必须保留公开媒体来源，且不能把简介或笔记当作文字稿');
  if(typeof data.title==='string'&&data.title.length>500||typeof data.language==='string'&&data.language.length>100)throw new Error('原声项目标题不能超过500字符，语言标记不能超过100字符');
  const annotations=projectAnnotations(data);
  return {schema_version:1,project_kind:'audio_only',transcript_status:data.transcript_status==='unavailable'?'unavailable':'not_imported',
   title:typeof data.title==='string'?data.title:'未命名原声项目',source_url:podcastURL(data.source_url)||origin.feed_url||origin.media_url,
   language:typeof data.language==='string'?data.language:'',podcast_source:origin,
   ...(Number.isFinite(data.media_duration)&&data.media_duration>0&&data.media_duration<=604800?{media_duration:data.media_duration}:{}),
   ...annotations,
   // Audio metadata and user notes are never transcript evidence or model output.
   segments:[],notes:Object.create(null),ai_answers:[],translation_view:'',translation_contexts:Object.create(null),translation_glossary:Object.create(null)};
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
 const QUALITY_LABELS={numbers_changed:'数字或百分比发生变化',glossary_missing:'术语译法未匹配',unchanged_translation:'译文与原文相同',repeated_phrase:'可能重复生成',length_outlier:'译文长度异常，可能漏译或扩写',reading_speed:'按原时间范围显示可能过快'};
 function translationQualityMessage(item) {
  return (item?.quality_warnings||[]).filter(c=>Object.hasOwn(QUALITY_LABELS,c)).map(c=>QUALITY_LABELS[c]).join('；');
 }
 function cleanGlossary(value, strict=false) {
  const fail=()=>{if(strict)throw new Error('术语表最多100条，每个原词/译法1–120字符，不可重复或含控制字符，总长不超过8000字符');return [];};
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>100)return fail();
  const terms=[],seen=new Set();let chars=0;
  for(const e of value){
   if(!e||typeof e.source!=='string'||typeof e.target!=='string')return fail();
   const source=e.source.trim(),target=e.target.trim(),key=source.toLowerCase();
   if(!source||!target||source.length>120||target.length>120||/[\x00-\x1f\x7f]/.test(source+target)||seen.has(key))return fail();
   chars+=source.length+target.length;if(chars>8000)return fail();seen.add(key);terms.push({source,target});
  }
  return terms;
 }
 function termPresent(text, term) {
  const escaped=term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp((/^[A-Za-z0-9_]/.test(term)?'(?<![A-Za-z0-9_])':'')+escaped+(/[A-Za-z0-9_]$/.test(term)?'(?![A-Za-z0-9_])':''),'i').test(text);
 }
 function relevantGlossary(doc, target, cues) {
  return cleanGlossary(doc.translation_glossary?.[target]).filter(e=>cues.some(c=>termPresent(c.text,e.source)));
 }
 function cleanDocumentGlossary(value) {
  const result=Object.create(null);
  for(const language of ['en','zh','ja','ko','fr','de','es']){
   const terms=cleanGlossary(value?.[language]);if(terms.length)result[language]=terms;
  }
  return result;
 }
 function cleanTranslations(value) {
  const output=Object.create(null);
  if(!value || typeof value!=="object" || Array.isArray(value)) return output;
  for(const language of ["en","zh","ja","ko","fr","de","es"]) {
   const item=value[language];
   if(item && typeof item.text==="string" && item.text.length<=12000 && typeof item.source_text==="string" && item.source_text.length<=4000 && typeof item.provider==="string"){
    output[language]={text:item.text,source_text:item.source_text,provider:item.provider.slice(0,100),source_language:typeof item.source_language==="string"?item.source_language:"",...(typeof item.context_id==="string"&&/^[a-f0-9-]{36}$/.test(item.context_id)?{context_id:item.context_id}:{})};
    if(typeof item.document_language==='string'&&item.document_language.length<=100)output[language].document_language=item.document_language;
    if(item.context_version===2){
     Object.assign(output[language],{context_version:2,target_language:language});
     try{if(Array.isArray(item.glossary_snapshot))output[language].glossary_snapshot=cleanGlossary(item.glossary_snapshot,true);}catch{}
     if(typeof item.input_revision==='string'&&/^[a-f0-9]{64}$/.test(item.input_revision))output[language].input_revision=item.input_revision;
    }
    if(Array.isArray(item.quality_warnings))output[language].quality_warnings=[...new Set(item.quality_warnings.filter(c=>typeof c==='string'&&Object.hasOwn(QUALITY_LABELS,c)))];
   }
  }
  return output;
 }
 function sameCueSnapshot(doc, cues, checkMemory=true) {
  return Boolean(doc) && cues.every(c=>{
   const current=doc.segments[c.position];
   if(current?.id!==c.id||current.text!==c.text||current.start!==c.start||current.end!==c.end)return false;
   if(Object.hasOwn(c,'speaker')&&(current.speaker||null)!==c.speaker)return false;
   if(Object.hasOwn(c,'memory_text')){
    const item=current.translations?.[c.memory_language];
    if(item?.text!==c.memory_text||item.source_text!==c.text)return false;
    if(checkMemory&&!translationCurrent(current,doc,item))return false;
   }
   return true;
  });
 }
 function translationCurrent(segment, doc, item) {
  // Iterative traversal verifies the entire reused-memory dependency chain without
  // recursive stack growth. A visited item is checked once even for shared/cyclic
  // imported references; source/term changes anywhere in that chain invalidate it.
  if(!doc)return false;
  const pending=[{segment,item}],seen=new Set();
  while(pending.length){
   const node=pending.pop(),s=node.segment,t=node.item;
   if(!s||!t||t.source_text!==s.text)return false;
   if(seen.has(t))continue;seen.add(t);
   if(Object.hasOwn(t,'document_language')&&t.document_language!==(doc.language||''))return false;
   if(!t.context_id){if(t.provider?.endsWith('_subscription_translation'))return false;continue;}
   const snapshot=doc.translation_contexts?.[t.context_id];
   if(!Array.isArray(snapshot)||!snapshot.some(c=>c.id===s.id)||!sameCueSnapshot(doc,snapshot,false))return false;
   if(t.context_version===2&&!Array.isArray(t.glossary_snapshot))return false;
   const target=t.target_language||Object.keys(s.translations||{}).find(k=>s.translations[k]===t);
   if(JSON.stringify(relevantGlossary(doc,target,snapshot))!==JSON.stringify(t.glossary_snapshot||[]))return false;
   for(const cue of snapshot)if(Object.hasOwn(cue,'memory_text')){
    const dependency=doc.segments[cue.position];
    pending.push({segment:dependency,item:dependency.translations?.[cue.memory_language]});
   }
  }
  return true;
 }
 function cleanContexts(value, segments) {
  const output=Object.create(null), referenced=new Set(segments.flatMap(s=>Object.values(s.translations).map(t=>t.context_id).filter(Boolean)));
  if(!value || typeof value!=='object' || Array.isArray(value))return output;
  for(const key of referenced){
   if(!Object.hasOwn(value,key))continue;
   const cues=value[key];let prior=-1,chars=0,memoryChars=0;const ids=new Set();
   if(!Array.isArray(cues)||!cues.length||cues.length>36)continue;
   const valid=cues.every(c=>{
    if(!c||typeof c.id!=='string'||c.id.length<1||c.id.length>200||ids.has(c.id)||typeof c.text!=='string'||!c.text.length||c.text.length>4000||!Number.isSafeInteger(c.position)||c.position<0||c.position<=prior||!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.start<0||c.end<c.start)return false;
    if(Object.hasOwn(c,'speaker')&&c.speaker!==null&&(typeof c.speaker!=='string'||c.speaker.length>120))return false;
    if(Object.hasOwn(c,'memory_text')){
     if(typeof c.memory_text!=='string'||!c.memory_text.length||c.memory_text.length>12000||!['en','zh','ja','ko','fr','de','es'].includes(c.memory_language))return false;
     memoryChars+=c.memory_text.length;
    }
    ids.add(c.id);prior=c.position;chars+=c.text.length;return true;
   });
   if(valid&&chars<=40000&&memoryChars<=24000)output[key]=cues.map(c=>({id:c.id,text:c.text,position:c.position,start:c.start,end:c.end,...(Object.hasOwn(c,'speaker')?{speaker:c.speaker}:{}),...(Object.hasOwn(c,'memory_text')?{memory_text:c.memory_text,memory_language:c.memory_language}:{})}));
  }
  return output;
 }
 function semanticBoundary(before, after) {
  return before && (!after || before.speaker!==after.speaker || after.start-before.end>2 || /[.!?。！？][\s"'”’）)]*$/.test(before.text));
 }
 function subscriptionPlan(doc, selectedIds, source, target, provider) {
  const selected=new Set(selectedIds),runs=[];
  for(let position=0;position<doc.segments.length;position++){
   const s=doc.segments[position];if(!selected.has(s.id))continue;
   if(!s.id.length||s.id.length>200||!s.text.length||s.text.length>4000||typeof s.speaker==='string'&&s.speaker.length>120)throw new Error('订阅翻译需要每段1–4000字符、片段ID不超过200字符、说话人标签不超过120字符，请先缩小或修正内容');
   const cue={id:s.id,text:s.text,position,start:s.start,end:s.end,speaker:s.speaker||null};
   if(!runs.length||runs.at(-1).at(-1).position!==position-1)runs.push([]);
   runs.at(-1).push(cue);
  }
  const windows=[];
  for(const run of runs){
   for(let start=0;start<run.length;){
    let end=start,chars=0;
    while(end<run.length&&end-start<32&&chars+run[end].text.length<=24000){chars+=run[end].text.length;end++;}
    // Prefer a nearby sentence/turn/pause boundary over an arbitrary cue count.
    if(end<run.length)for(let candidate=end;candidate>=start+Math.max(1,Math.ceil((end-start)/2));candidate--){
     if(semanticBoundary(run[candidate-1],run[candidate])){end=candidate;break;}
    }
    const segments=run.slice(start,end).filter(c=>{const s=doc.segments[c.position],t=s.translations?.[target];return !(translationCurrent(s,doc,t)&&t.source_language===source&&t.provider===provider);});
    const targetIds=new Set(segments.map(c=>c.id));
    const snapshot=run.slice(Math.max(0,start-2),Math.min(run.length,end+2)).map(c=>({...c}));
    if(segments.length){
     const glossary=relevantGlossary(doc,target,snapshot),memory=[];let memoryChars=0;
     for(const cue of snapshot){
      if(targetIds.has(cue.id))continue;
      const s=doc.segments[cue.position],t=s.translations?.[target];
      if(translationCurrent(s,doc,t)&&t.source_language===source&&t.provider===provider&&!t.quality_warnings?.length&&memoryChars+t.text.length<=24000){
       memory.push({id:cue.id,source_text:cue.text,text:t.text});memoryChars+=t.text.length;
       cue.memory_text=t.text;cue.memory_language=target;
      }
     }
     const context=snapshot.filter(c=>!targetIds.has(c.id)).map(({memory_text,memory_language,...c})=>c);
     windows.push({segments,context,snapshot,glossary,memory});
    }
    start=end;
   }
  }
  return {windows,selected:runs.flat().length,total:windows.reduce((n,w)=>n+w.segments.length,0),sent:new Set(windows.flatMap(w=>w.snapshot.map(c=>c.id))).size};
 }
 const SUMMARY_QUESTION=Summaries.QUESTION;
 function summaryReadiness(doc) {
  try {const plan=Summaries.plan(doc);return {ready:true,reason:'',characters:plan.characters,plan};}
  catch(error){return {ready:false,reason:'整篇摘要暂不可用：'+error.message+'。可直接读原文，或筛选较小范围提问；局部回答不会保存为整篇摘要。'};}
 }
 // Only the exact ordered {id,text} payload is evidence for a saved answer.
 // Never discard missing IDs: doing so would make a removed dependency look current.
 function cleanAnswerInput(value) {
  if(!value || value.version!==1 || !Array.isArray(value.segments) || !value.segments.length || value.segments.length>20000)return undefined;
  const ids=new Set();let chars=0;
  if(!value.segments.every(s=>{
   if(!s || typeof s.id!=="string" || !s.id.length || s.id.length>400 || ids.has(s.id) || typeof s.text!=="string"||s.text.length>1000000)return false;
   ids.add(s.id);chars+=s.id.length+s.text.length;return chars<=2200000;
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
 function documentDuration(doc) {
  return isAudioProject(doc)?doc.media_duration||0:doc.segments.reduce((end,segment)=>Math.max(end,segment.end),0);
 }
 function libraryMatches(doc, query, kind='all', scope='title') {
  const audio=isAudioProject(doc), annotated=Boolean(projectAnnotationCount(doc)||doc.segments.some(s=>s.saved_excerpt)||Object.values(doc.notes||{}).some(n=>n.trim()));
  if(kind==='audio'&&!audio||kind==='transcript'&&audio||kind==='annotated'&&!annotated)return false;
  const needle=query.trim().toLocaleLowerCase(),matches=value=>typeof value==='string'&&value.toLocaleLowerCase().includes(needle);
  if(matches(doc.title))return true;
  if(scope==='notes'||scope==='text'){
   if(matches(doc.project_note)||Object.values(doc.notes||{}).some(matches)||(doc.timestamp_bookmarks||[]).some(item=>matches(item.note)))return true;
  }
  return scope==='text'&&doc.segments.some(segment=>matches(segment.text));
 }
 function sortedLibrary(documents, order) {
  const result=documents.slice();
  if(order==='title')result.sort((a,b)=>a.title.localeCompare(b.title,'zh-Hans',{numeric:true,sensitivity:'base'}));
  if(order==='duration')result.sort((a,b)=>documentDuration(a)-documentDuration(b));
  return result;
 }
 function matchesSegment(segment, doc, query, notesOnly=false, excerptsOnly=false) {
  return (!notesOnly || Boolean(doc.notes?.[segment.id])) && (!excerptsOnly || segment.saved_excerpt === true) &&
   [segment.text,segment.speaker||"",doc.notes?.[segment.id]||"",...Object.values(segment.translations||{}).filter(t=>translationCurrent(segment,doc,t)).map(t=>t.text)].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
 }
	function validate(data) {
  if(isAudioProject(data))return validateAudioProject(data);
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
						["kind", "model", "backend", "language", "alignment_warning", "playback_warning", "media_id", "caption_method", "caption_track", "subtitle_check", "language_basis", "review_status", "source_platform", "source_medium"]
							.filter((k) => typeof data.provenance[k] === "string")
							.map((k) => [k, data.provenance[k]]),
					)
				: undefined;
		if (provenance && Number.isFinite(data.provenance.media_duration) && data.provenance.media_duration > 0 && data.provenance.media_duration <= 21600)
			provenance.media_duration = data.provenance.media_duration;
		const sourceMedia = mediaSource(data.source_media);
		return {
			notes,
   ...((data.project_note!==undefined||data.timestamp_bookmarks!==undefined)?projectAnnotations(data):{}),
   ...(Number.isFinite(data.media_duration)&&data.media_duration>0&&data.media_duration<=604800?{media_duration:data.media_duration}:{}),
			...(typeof data.readingPosition === "string" && ids.has(data.readingPosition) ? {readingPosition: data.readingPosition} : {}),
			...(provenance ? { provenance } : {}),
			...(sourceMedia ? { source_media: sourceMedia } : {}),
            ...(podcastSource(data.podcast_source)?{podcast_source:podcastSource(data.podcast_source)}:{}),
			schema_version: 1,
            language: typeof data.language === "string" ? data.language : "",
            translation_view: ["en","zh","ja","ko","fr","de","es"].includes(data.translation_view) ? data.translation_view : "",
            summary_job: Summaries.clean(data.summary_job),
            ai_answers: Array.isArray(data.ai_answers) ? retainAnswers(data.ai_answers).filter(a=>a && typeof a.question==="string" && typeof a.answer==="string" && Array.isArray(a.citations)).map(a=>({question:a.question.slice(0,4000),answer:a.answer.slice(0,100000),citations:a.citations.filter(id=>ids.has(id)),...(cleanAnswerInput(a.input_snapshot) ? {input_snapshot:cleanAnswerInput(a.input_snapshot)} : {}),...(a.purpose==="summary"?{purpose:"summary"}:a.purpose==="question"?{purpose:"question"}:{}),...(a.summary_process?.version===1&&Number.isInteger(a.summary_process.batches)&&a.summary_process.batches>=1&&a.summary_process.batches<=64?{summary_process:{version:1,batches:a.summary_process.batches,requests:a.summary_process.batches+(a.summary_process.batches>1?1:0),citation_basis:a.summary_process.batches>1?"batch_sources":"direct"}}:{}),provider:typeof a.provider==="string"?a.provider.slice(0,100):"unknown"})) : [],
			title: typeof data.title === "string" ? data.title : "未命名文字稿",
			source_url: typeof data.source_url === "string" ? data.source_url : "",
			segments,
            translation_contexts: cleanContexts(data.translation_contexts, segments),
            translation_glossary: cleanDocumentGlossary(data.translation_glossary),
		};
	}
 function retainAnswers(answers) {
  const recent=answers.slice(-20);
  const summary=answers.findLast(a=>a?.purpose==="summary"&&typeof a.question==="string"&&typeof a.answer==="string"&&Array.isArray(a.citations));
  return summary&&!recent.includes(summary)?[summary,...recent.slice(-19)]:recent;
 }
 function summaryFreshness(answer, doc) {
  if(answer?.purpose!=="summary")return "unknown";
  const input=cleanAnswerInput(answer.input_snapshot);
  if(!input)return "unknown";
  return input.segments.length===doc.segments.length && answerFreshness(answer,doc)==="current" ? "current" : "stale";
 }
 function latestSummary(doc) {
  return (doc.ai_answers||[]).findLast(answer=>answer.purpose==="summary") || null;
 }
 function summaryMarkdown(doc, answer=latestSummary(doc)) {
  if(!answer)throw new Error("这篇还没有保存的摘要");
  return aiReadingMarkdown({...doc,ai_answers:[answer]}).replace(" · 本地 AI 记录", " · 播客摘要") +
   (answer.summary_process?.batches>1?"\n生成方式："+answer.summary_process.batches+" 批原文笔记完成后再汇总；所列引用来自被汇总结果引用的批次依据，不能保证每句话均有独立证据。\n":"") + "\n摘要覆盖状态：" + ({current:"覆盖当前整篇原文，仍需核对模型判断",stale:"整篇原文已经变化，旧摘要可能过期",unknown:"缺少完整依据，无法确认摘要覆盖范围"}[summaryFreshness(answer,doc)]) + "\n";
 }
 function aiReadingMarkdown(doc) {
  const line=value=>markdownText(value).replace(/[\r\n]+/g," ");
  const quote=value=>markdownText(value).replace(/\r\n?/g,"\n").split("\n").map(s=>"> "+s).join("\n");
  const lines=["# "+line(doc.title)+" · 本地 AI 记录","","AI 输出仍需核对；以下是本篇已保存的全部回答，不受当前筛选影响。","来源定位使用当前文字稿的时间与链接，可能不同于生成回答时的媒体信息。",""];
  const origin=podcastOrigin(doc);if(origin)lines.push("[播客原站]("+origin+")","时间戳需在原声中手动定位；没有伪造平台时间跳转链接。", "");
  for(const [index,answer] of (doc.ai_answers||[]).entries()){
   const freshness=answerFreshness(answer,doc), input=cleanAnswerInput(answer.input_snapshot);
   lines.push("## 回答 "+(index+1),"","提供商："+line(answer.provider||"unknown"),"",
    "依据状态："+({current:"完整发送原文仍与当前稿一致（不代表回答正确）",stale:"发送原文已变化或移除，回答依据可能过期",unknown:"缺少完整发送原文，无法确认依据是否仍有效"}[freshness]),"",
    "问题：","",quote(answer.question),"","回答：","",quote(answer.answer),"","引用：","");
   const cited=[...new Set(answer.citations||[])];
   if(!cited.length)lines.push("未提供片段引用，请回听核对。","");
   for(const id of cited){
    const segment=doc.segments.find(s=>s.id===id), url=segment?source(doc.source_url,segment.start).replace(/[()]/g,c=>c==="("?"%28":"%29"):"";
    const label=segment?time(segment.start):"原片段已移除";
    lines.push("- "+line(id)+" · "+(url?"["+label+"]("+url+")":label));
   }
   lines.push("","### 本次实际发送的原文","");
   if(!input){lines.push("旧记录没有完整发送原文；不能用当前稿替代历史依据。","");continue;}
   lines.push(input.segments.length+" 个片段；包括模型读到但未引用的内容。","");
   for(const segment of input.segments)lines.push("片段 "+line(segment.id),"",quote(segment.text),"");
  }
  lines.push("完整编辑和恢复请保留 Coconut JSON 备份；本文件不包含媒体或订阅凭据。","");
  return lines.join("\n");
 }
 function parseReadingTime(value) {
  const parts=String(value).trim().split(":");
  if(parts.length>3 || !parts.length || parts.some((part,i)=>!(i===parts.length-1 ? /^\d+(?:\.\d{1,3})?$/ : /^\d+$/).test(part)))return null;
  const numbers=parts.map(Number);
  if(numbers.slice(1).some(n=>n>=60))return null;
  const seconds=numbers.reduce((sum,n)=>sum*60+n,0);
  return Number.isFinite(seconds) && seconds<=Number.MAX_SAFE_INTEGER/1000 ? seconds : null;
 }
 function segmentAtTime(doc,seconds) {
  if(!Number.isFinite(seconds) || seconds<0 || !doc.segments.length || seconds>doc.segments.reduce((end,s)=>Math.max(end,s.end),0))return null;
  return doc.segments.findLast(s=>s.start<=seconds && s.end>=seconds) || doc.segments.find(s=>s.start>=seconds) || null;
 }
 function subtitleExport(doc, format="srt", bilingual=false) {
  if(isAudioProject(doc)||!doc.segments.length)throw new Error('尚未导入文字稿，不能导出字幕');
  if (!["srt","vtt"].includes(format)) throw new Error("不支持的字幕格式");
  const stamp = ms => {
   const hours = Math.floor(ms / 3600000), minutes = Math.floor(ms / 60000) % 60, seconds = Math.floor(ms / 1000) % 60;
   return [hours,minutes,seconds].map(n=>String(n).padStart(2,"0")).join(":") + (format === "srt" ? "," : ".") + String(ms % 1000).padStart(3,"0");
  };
  const text = value => String(value).replace(/\u0000/g,"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\r\n?/g,"\n").split("\n").filter(line=>line.trim()).join("\n");
  let translated = 0;
  const cues = doc.segments.map((segment,index)=>{
   const lines = [text(segment.text) || " "];
   const translation = segment.translations?.[doc.translation_view];
   if (bilingual && translation && translationCurrent(segment,doc,translation)) { lines.push(text(translation.text)); translated++; }
   const start = Math.round(segment.start*1000);
   const end = Math.max(start + 1, Math.round(segment.end*1000));
   return `${index+1}\n${stamp(start)} --> ${stamp(end)}\n${lines.join("\n")}`;
  });
  return {text:(format === "vtt" ? "WEBVTT\n\n" : "") + cues.join("\n\n") + "\n", translated};
 }
 function mergeLibraryBackup(current, backup) {
  if (!backup || backup.format !== "coconut-library" || backup.version !== 1 || !Array.isArray(backup.documents) || backup.documents.length > 500)
   throw new Error("不是支持的 Coconut 书架备份（最多500份）");
  const keys = new Set();
  // Validate the entire file before changing any live state.
  const incoming = backup.documents.map(item => {
   if (!item || typeof item.key !== "string" || !item.key || item.key.length > 200 || keys.has(item.key)) throw new Error("备份的文字稿标识无效或重复");
   keys.add(item.key);
   return {...validate(item), key:item.key};
  });
  const documents = current.documents.slice();
  const fingerprints = new Map(documents.map(d => [JSON.stringify(validate(d)), d.key]));
  const used = new Set(documents.map(d => d.key));
  const mapping = new Map();
  for (const doc of incoming) {
   const fingerprint = JSON.stringify(validate(doc));
   if (fingerprints.has(fingerprint)) { mapping.set(doc.key, fingerprints.get(fingerprint)); continue; }
   let key = doc.key, suffix = 1;
   while (used.has(key)) { const tail = "-restored-" + suffix++; key = doc.key.slice(0,200-tail.length) + tail; }
   documents.push({...doc, key}); used.add(key); fingerprints.set(fingerprint,key); mapping.set(doc.key,key);
  }
  return {documents, active:mapping.get(backup.active) || current.active || documents[0]?.key || null};
 }
	function notebookSegments(doc) {
		return doc.segments.filter(s => s.saved_excerpt === true || Boolean(doc.notes?.[s.id]?.trim()));
	}
	function markdownText(value) {
		return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/[\\`*_{}\[\]()#+.!|~$-]/g, "\\$&");
	}
	function notebookMarkdown(doc) {
  if(isAudioProject(doc))return audioNotebookMarkdown(doc);
		const kept = notebookSegments(doc);
		const text = value => markdownText(value).replace(/\r\n?/g, "\n");
		const singleLine = value => text(value).replace(/\n/g, " ");
		const quote = value => text(value).split("\n").map(line => "> " + line).join("\n");
		const sourceLink = seconds => source(doc.source_url, seconds).replace(/[()]/g, char => char === "(" ? "%28" : "%29");
		const lines = ["# " + singleLine(doc.title), "", "Coconut 阅读笔记 · " + kept.length + " 个片段", "",
			"以下包含本篇全部摘录和非空笔记，不受当前搜索筛选影响。文字稿可能有识别错误，请回听核对。", "",
			"Markdown 用于阅读与整理；完整恢复请另存 Coconut JSON 备份。此文件不包含媒体。", ""];
		const origin = sourceLink(0) || podcastOrigin(doc);
		if (origin) lines.push("[原始来源](" + origin + ")", "");
		else lines.push("未关联可用的原站链接；时间戳仅用于在原始媒体中定位。", "");
        if(podcastOrigin(doc))lines.push("播客原站链接不包含自动时间跳转；请按下列时间戳手动定位。", "");
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
                if(translationCurrent(segment,doc,translated)&&translationQualityMessage(translated))lines.push("译文待核对："+translationQualityMessage(translated), "");
			}
			if (doc.notes?.[segment.id]?.trim()) lines.push("我的笔记：", "", quote(doc.notes[segment.id]), "");
		}
  if(hasProjectAnnotations(doc)){
   lines.push('## 项目笔记与时间书签','','以下是用户自己的记录，不是原文或经过验证的引用。','');
   if(doc.project_note.trim())lines.push('### 项目笔记','',quote(doc.project_note),'');
   for(const item of doc.timestamp_bookmarks)lines.push('### '+time(item.time),'',item.note?quote(item.note):'时间书签（未填写笔记）','');
  }
		return lines.join("\n");
	}
 function audioNotebookMarkdown(doc) {
  const quote=value=>markdownText(value).replace(/\r\n?/g,'\n').split('\n').map(line=>'> '+line).join('\n');
  const lines=['# '+markdownText(doc.title).replace(/[\r\n]+/g,' '),'','Coconut 原声项目笔记','',
   '尚未导入文字稿，没有摘要。以下仅为用户笔记和时间书签，不是原文或经过验证的引用。','',
   'Markdown 用于阅读；完整恢复请保留 Coconut JSON 备份。备份不包含媒体，回听需重新获取或选择本地文件。',''];
  const origin=podcastOrigin(doc);if(origin)lines.push('[原始来源]('+origin+')','时间戳需在原声中手动定位。','');
  if(doc.project_note?.trim())lines.push('## 项目笔记','',quote(doc.project_note),'');
  for(const item of doc.timestamp_bookmarks||[])lines.push('## '+time(item.time),'',item.note?quote(item.note):'时间书签（未填写笔记）','');
  return lines.join('\n');
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
	const api = { hasProjectAnnotations, projectAnnotationCount, attachProjectTranscript, libraryMatches, documentDuration, sortedLibrary, AUDIO_NOTE_BUDGET, audioNoteCharacters, isAudioProject, audioProjectIdentity, SUMMARY_QUESTION, summaryReadiness, podcastURL, podcastSource, cleanGlossary, relevantGlossary, translationQualityMessage, retainAnswers, summaryFreshness, latestSummary, summaryMarkdown, aiReadingMarkdown, parseReadingTime, segmentAtTime, subtitleExport, mergeLibraryBackup, time, source, media, validate, parse, matchesSegment, notebookSegments, notebookMarkdown, translationCurrent, sameCueSnapshot, subscriptionPlan, cleanContexts, answerFreshness };
	if (typeof module !== "undefined" && module.exports) module.exports = api;
	else root.Coconut = api;
})(typeof window !== "undefined" ? window : globalThis);
