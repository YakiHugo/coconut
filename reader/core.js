(function (root) {
	"use strict";
 const BACKUP_REVIEW_BYTES=50*1024*1024, SUBTITLE_IMPORT_BYTES=15*1024*1024;
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
 // Durable local media identity contains metadata and a bounded candidate hash,
 // never file bytes, paths, object URLs, or a permission to upload/read the file.
 function localMediaSource(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||!['audio','video'].includes(value.kind))return undefined;
  if(typeof value.name!=='string'||!value.name||value.name.length>500||/[\\/\x00-\x1f\x7f]/.test(value.name)||!Number.isSafeInteger(value.size)||value.size<=0||!Number.isSafeInteger(value.last_modified)||value.last_modified<0)return undefined;
  if(typeof value.type!=='string'||value.type.length>100||/[\x00-\x1f\x7f]/.test(value.type)||typeof value.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.fingerprint))return undefined;
  return {version:1,kind:value.kind,name:value.name,size:value.size,last_modified:value.last_modified,type:value.type,fingerprint:value.fingerprint};
 }
 function isAudioProject(doc) { return doc?.project_kind==='audio_only'; }
 const AUDIO_NOTE_BUDGET=1000000;
 function audioNoteCharacters(doc) {return (doc.project_note?.length||0)+(doc.timestamp_bookmarks||[]).reduce((total,item)=>total+item.note.length,0);}
 function audioProjectIdentity(doc) {
  const local=localMediaSource(doc?.local_media_source);
  if(local)return JSON.stringify(['local_media',local.fingerprint]);
  const origin=podcastSource(doc?.podcast_source);
  if(!origin)return '';
  return JSON.stringify(origin.kind==='direct_media'?['direct_media',origin.media_url]:['podcast',origin.feed_url,origin.episode_id]);
 }
 // Episode identity chooses a library project; media identity separately owns
 // temporary publisher bytes. A new enclosure/type must never inherit old audio.
 function podcastMediaIdentity(doc) {
  const source=podcastSource(doc?.podcast_source),episode=audioProjectIdentity(doc);
  return episode&&source?.media_url&&['audio','video'].includes(source.media_kind)?JSON.stringify([episode,source.media_url,source.media_kind]):'';
 }
 function hasProjectAnnotations(doc){return Boolean(doc&&Object.hasOwn(doc,'project_note')&&Array.isArray(doc.timestamp_bookmarks));}
 // Presence is a view/export decision only: never trim or rewrite a saved note.
 // Unicode White_Space includes NEL; FEFF also follows JavaScript trim semantics.
 // Zero-width joiners and combining marks are not whitespace.
 function hasNoteContent(value){return typeof value==='string'&&/[^\p{White_Space}\uFEFF]/u.test(value);}
 function segmentNoteCount(doc){return doc.segments.reduce((count,segment)=>count+Number(hasNoteContent(doc.notes?.[segment.id])),0);}
 // A timestamp bookmark is useful even without a note, and counts as one item.
 function projectAnnotationCount(doc){return Number(hasNoteContent(doc.project_note))+(doc.timestamp_bookmarks?.length||0);}
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
  const result={...text,title:original.title,language:original.project_language_override?original.language:text.language||original.language,project_language_override:original.project_language_override===true,source_url:original.source_url,podcast_source:original.podcast_source,
   ...projectAnnotations(original),...(original.media_duration?{media_duration:original.media_duration}:{})};
  // The selected file supplies words, not an unrelated local media job association.
  delete result.source_media;delete result.local_media_source;
  if(original.local_media_source){result.local_media_source=original.local_media_source;delete result.podcast_source;}
  if(original.podcast_source&&audioProjectIdentity(original)===audioProjectIdentity(text)&&original.podcast_source.media_url===text.podcast_source?.media_url&&original.podcast_source.media_kind===text.podcast_source?.media_kind&&text.podcast_source.transcript_url){
   result.podcast_source={...original.podcast_source,transcript_url:text.podcast_source.transcript_url};
  }
  // JSON backups have a reviewed large-file recovery path. Combining a valid
  // transcript with project notes must not impose the subtitle file budget.
  return validate(result);
 }
 function validateAudioProject(data) {
  const origin=podcastSource(data.podcast_source),local=localMediaSource(data.local_media_source);
  if(data.local_media_source!==undefined&&!local)throw new Error('本地文件信息无效，请重新选择原音视频；项目备份未改变');
  if(!Array.isArray(data.segments)||data.segments.length||(!origin?.media_url&&!local)||origin&&local)throw new Error('原声项目必须保留一个公开媒体或本地文件来源，且不能把简介或笔记当作文字稿');
  if(typeof data.title==='string'&&data.title.length>500||typeof data.language==='string'&&data.language.length>100)throw new Error('原声项目标题不能超过500字符，语言标记不能超过100字符');
  const annotations=projectAnnotations(data);
  return {schema_version:1,project_kind:'audio_only',transcript_status:data.transcript_status==='unavailable'?'unavailable':'not_imported',
   title:typeof data.title==='string'?data.title:'未命名原声项目',source_url:local?(podcastURL(data.source_url)||''):podcastURL(data.source_url)||origin.feed_url||origin.media_url,
   language:typeof data.language==='string'?data.language:'',...(local?{local_media_source:local}:{podcast_source:origin}),
   ...(data.project_language_override===true?{project_language_override:true}:{}),
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
  if(item?.manual_review?.version===1&&item.manual_review.text===item.text)return '';
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
 function cleanTranslations(value, includeReview=true) {
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
    if(includeReview&&item.original_translation){const original=cleanTranslations({[language]:item.original_translation},false)[language];if(original)output[language].original_translation=original;}
    if(includeReview&&Object.hasOwn(item,'manual_review'))output[language].manual_review=cleanManualReview(item.manual_review,language);

   }
  }
  return output;
 }
 // A human review is tied to exactly the source/context shown in its editor.
 // Historical machine provenance remains intact and is never promoted to a new run.
 function manualReviewSnapshot(doc, segment, target) {
  const position=doc.segments.indexOf(segment);
  if(position<0||!["en","zh","ja","ko","fr","de","es"].includes(target))throw new Error('找不到这段译文');
  const item=segment.translations?.[target],ids=new Set(),pending=[item],seen=new Set(),byId=new Map(doc.segments.map(s=>[s.id,s]));
  while(pending.length){
   const translation=pending.pop();if(!translation||seen.has(translation))continue;seen.add(translation);
   const context=translation.manual_review?.cues||doc.translation_contexts?.[translation.context_id]||[];
   for(const cue of context){ids.add(cue.id);if(cue.memory_language)pending.push(byId.get(cue.id)?.translations?.[cue.memory_language]);}
   for(const id of translation.manual_review?.missing_cue_ids||[])ids.add(id);
  }
  for(const cue of doc.segments.slice(Math.max(0,position-1),position+2))ids.add(cue.id);
  const cues=doc.segments.flatMap((s,index)=>ids.has(s.id)?[{id:s.id,position:index,text:s.text,start:s.start,end:s.end,speaker:s.speaker||null}]:[]);
  const missing=[...ids].filter(id=>!byId.has(id)).sort();
  return {target_language:target,document_language:doc.language||'',cues,...(missing.length?{missing_cue_ids:missing}:{}),glossary_snapshot:relevantGlossary(doc,target,cues)};
 }
 function cleanManualReview(value,target) {
  const invalid={invalid:true};
  // Evidence can span the entire transitive memory graph, not one model batch.
  // Match the document's supported cue count and source fields without dropping
  // distant, empty, or long source cues that must still participate in freshness.
  if(!value||value.version!==1||value.target_language!==target||typeof value.text!=='string'||!value.text.trim()||value.text.length>12000||typeof value.document_language!=='string'||typeof value.previous_text!=='string'||value.previous_text.length>12000||typeof value.previous_source_text!=='string'||!Array.isArray(value.cues)||!value.cues.length||value.cues.length>100000)return invalid;
  const ids=new Set();let prior=-1;
  for(const c of value.cues){
   if(!c||typeof c.id!=='string'||ids.has(c.id)||!Number.isSafeInteger(c.position)||c.position<0||c.position<=prior||typeof c.text!=='string'||!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.start<0||c.end<c.start||(c.speaker!==null&&typeof c.speaker!=='string'))return invalid;
   ids.add(c.id);prior=c.position;
  }
  if(Object.hasOwn(value,'missing_cue_ids')){
   if(!Array.isArray(value.missing_cue_ids)||value.missing_cue_ids.length>100000)return invalid;
   for(const id of value.missing_cue_ids){if(typeof id!=='string'||ids.has(id))return invalid;ids.add(id);}
  }
  try{
   if(!Array.isArray(value.glossary_snapshot))return invalid;
   return {version:1,text:value.text,target_language:target,document_language:value.document_language,cues:value.cues.map(({id,position,text,start,end,speaker})=>({id,position,text,start,end,speaker})),...(value.missing_cue_ids?.length?{missing_cue_ids:[...value.missing_cue_ids]}:{}),glossary_snapshot:cleanGlossary(value.glossary_snapshot,true),previous_text:value.previous_text,previous_source_text:value.previous_source_text};
  }catch{return invalid;}
 }
 function manualReviewCurrent(segment,doc,item) {
  const review=item?.manual_review,missing=review?.missing_cue_ids?.length?new Set(review.missing_cue_ids):null;
  return review?.version===1&&Array.isArray(review.cues)&&Array.isArray(review.glossary_snapshot)&&review.text===item.text&&review.document_language===(doc.language||'')&&review.cues.some(c=>c.id===segment.id&&c.text===segment.text)&&sameCueSnapshot(doc,review.cues,false)&&(!missing||!doc.segments.some(s=>missing.has(s.id)))&&JSON.stringify(review.glossary_snapshot)===JSON.stringify(relevantGlossary(doc,review.target_language,review.cues));
 }
 function saveManualTranslation(doc,segment,target,text,snapshot,expectedTranslation) {
  const item=segment.translations?.[target];
  if(!item||JSON.stringify(item)!==expectedTranslation||JSON.stringify(manualReviewSnapshot(doc,segment,target))!==JSON.stringify(snapshot))throw new Error('原文、上下文或译文已变化，请关闭后重新打开核对；草稿仍在此处，可先复制。');
  if(typeof text!=='string'||!text.trim()||text.length>12000)throw new Error('译文不能为空，且最多 12,000 字符');
  const review=cleanManualReview({version:1,...snapshot,text,previous_text:item.text,previous_source_text:item.manual_review?.cues?.find(c=>c.id===segment.id)?.text??item.source_text},target);
  if(review.invalid)throw new Error('核对依据超过支持范围，未保存；请先导出 JSON 备份');
  const original=item.original_translation||cleanTranslations({[target]:item},false)[target];
  const result={...item,text,original_translation:original,manual_review:review};
  segment.translations[target]=result;invalidateSearch(doc);
  return result;
 }
 function translationReviewQueue(doc,target) {
  const result={entries:[],missing:0,current:0,stale:0,quality:0,total:doc?.segments.length||0};
  for(const [position,segment] of (doc?.segments||[]).entries()){
   const item=segment.translations?.[target];
   if(!item){result.missing++;continue;}
   const status=!translationCurrent(segment,doc,item)?'stale':!item.text.trim()||translationQualityMessage(item)?'quality':'current';
   result[status]++;
   if(status!=='current')result.entries.push({id:segment.id,position,status,reason:status==='stale'?'原文、上下文或语言依据已变化，或旧记录不完整':!item.text.trim()?'译文为空，需人工补全':translationQualityMessage(item)});
  }
  return result;
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
   if(!s||!t)return false;
   if(t.manual_review){if(!manualReviewCurrent(s,doc,t))return false;continue;}
   if(t.source_text!==s.text)return false;
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
    const segments=run.slice(start,end).filter(c=>{const s=doc.segments[c.position],t=s.translations?.[target];return !(translationCurrent(s,doc,t)&&(t.manual_review||t.source_language===source&&t.provider===provider));});
    const targetIds=new Set(segments.map(c=>c.id));
    const snapshot=run.slice(Math.max(0,start-2),Math.min(run.length,end+2)).map(c=>({...c}));
    if(segments.length){
     const glossary=relevantGlossary(doc,target,snapshot),memory=[];let memoryChars=0;
     for(const cue of snapshot){
      if(targetIds.has(cue.id))continue;
      const s=doc.segments[cue.position],t=s.translations?.[target];
      if(translationCurrent(s,doc,t)&&!t.manual_review&&t.source_language===source&&t.provider===provider&&!t.quality_warnings?.length&&memoryChars+t.text.length<=24000){
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
 // The exact ordered {id,text} payload is evidence for a saved answer.
 // Passage questions additionally retain source identity and timing as local provenance.
 // Never discard missing IDs: doing so would make a removed dependency look current.
 function cleanAnswerInput(value) {
  if(!value || value.version!==1 || !Array.isArray(value.segments) || !value.segments.length || value.segments.length>20000)return undefined;
  const ids=new Set();let chars=0;
  if(!value.segments.every(s=>{
   if(!s || typeof s.id!=="string" || !s.id.length || s.id.length>400 || ids.has(s.id) || typeof s.text!=="string"||s.text.length>1000000)return false;
   ids.add(s.id);chars+=s.id.length+s.text.length;return chars<=2200000;
  }))return undefined;
  const segments=value.segments.map(s=>({id:s.id,text:s.text}));
  let scope;
  if(value.scope!==undefined){
   const v=value.scope,ordered=segments.map(s=>s.id);
   if(!v||v.kind!=="passage"||segments.length>48||!Array.isArray(v.passage_ids)||!v.passage_ids.length||v.passage_ids.length>16||
    !Array.isArray(v.cues)||v.cues.length!==segments.length||typeof v.expanded!=="boolean"||
    !["source_title","source_url","source_language","provider","answer_language"].every(key=>typeof v[key]==="string"&&v[key].length<=4000))return undefined;
   const start=ordered.indexOf(v.passage_ids[0]);
   if(start<0||!v.expanded&&v.passage_ids.length!==segments.length||v.passage_ids.some((id,index)=>typeof id!=="string"||ordered[start+index]!==id)||
    !v.cues.every((cue,index)=>cue&&cue.id===ordered[index]&&Number.isFinite(cue.start)&&cue.start>=0&&Number.isFinite(cue.end)&&cue.end>=cue.start&&(cue.speaker===null||typeof cue.speaker==="string"&&cue.speaker.length<=1000)))return undefined;
   scope={kind:"passage",passage_ids:[...v.passage_ids],expanded:v.expanded,
    source_title:v.source_title,source_url:v.source_url,source_language:v.source_language,provider:v.provider,answer_language:v.answer_language,
    cues:v.cues.map(({id,start,end,speaker})=>({id,start,end,speaker}))};
  }
  return {version:1,segments,...(scope?{scope}:{})};
 }
 function answerFreshness(answer, doc) {
  const input=cleanAnswerInput(answer.input_snapshot);
  if(!input)return 'unknown'; // Legacy source_snapshot only covered citations.
  const selected=new Set(input.segments.map(s=>s.id));
  const current=doc.segments.filter(s=>selected.has(s.id));
  const same=current.length===input.segments.length&&current.every((s,i)=>s.id===input.segments[i].id&&s.text===input.segments[i].text);
  if(!same)return 'stale';
  const scope=input.scope;
  if(scope){const start=doc.segments.findIndex(cue=>cue.id===input.segments[0].id);if(input.segments.some((cue,index)=>doc.segments[start+index]?.id!==cue.id))return 'stale';}
  if(scope&&(scope.source_title!==(doc.title||'')||scope.source_url!==(doc.source_url||'')||scope.source_language!==(doc.language||'')||
   current.some((cue,index)=>cue.start!==scope.cues[index].start||cue.end!==scope.cues[index].end||(cue.speaker??null)!==scope.cues[index].speaker)))return 'stale';
  return 'current';
 }
 // Transcript length is the latest cue end, including gaps and overlaps;
 // audio-only projects use known media length. Neither route mutates cues.
 function documentDuration(doc) {
  return isAudioProject(doc)?doc.media_duration||0:doc.segments.reduce((end,segment)=>Math.max(end,segment.end),0);
 }
 function libraryMatches(doc, query, kind='all', scope='title') {
  const audio=isAudioProject(doc), annotated=Boolean(projectAnnotationCount(doc)||doc.segments.some(s=>s.saved_excerpt)||doc.segments.some(segment=>hasNoteContent(doc.notes?.[segment.id])));
  if(kind==='audio'&&!audio||kind==='transcript'&&audio||kind==='annotated'&&!annotated)return false;
  const needle=query.trim().toLocaleLowerCase(),matches=value=>typeof value==='string'&&value.toLocaleLowerCase().includes(needle);
  if(matches(doc.title))return true;
  if(scope==='notes'||scope==='text'){
   const matchesNote=value=>hasNoteContent(value)&&matches(value);
   if(matchesNote(doc.project_note)||doc.segments.some(segment=>matchesNote(doc.notes?.[segment.id]))||(doc.timestamp_bookmarks||[]).some(item=>matchesNote(item.note)))return true;
  }
  return scope==='text'&&searchDocument(doc,needle,'text').byCue.size>0;
 }
 // Return small, source-backed previews, never HTML or a synthetic summary.
 function librarySnippet(value, query) {
  if(typeof value!=='string'||!query.trim())return null;
  const needle=query.trim().toLocaleLowerCase(),folded=value.toLocaleLowerCase(),offset=folded.indexOf(needle);
  if(offset<0)return null;
  // Case folding may expand a character (e.g. İ); map back to real code points.
  const chars=Array.from(value);let position=0,start=0,end=chars.length;
  for(let i=0;i<chars.length;i++){
   const next=position+chars[i].toLocaleLowerCase().length;
   if(position<=offset&&next>offset)start=i;
   if(next>=offset+needle.length){end=i+1;break;}
   position=next;
  }
  const left=Math.max(0,start-35),right=Math.min(chars.length,Math.max(end,start+100),end+65);
  return {before:(left?'…':'')+chars.slice(left,start).join(''),match:chars.slice(start,Math.min(end,start+120)).join('')+(end-start>120?'…':''),after:chars.slice(end,right).join('')+(right<chars.length?'…':'')};
 }
 function libraryHits(doc,query,scope='title',limit=3) {
  if(!query.trim()||scope==='title')return [];
  const hits=[],cap=Math.max(0,Math.min(10,Math.floor(limit)||0));
  const add=(kind,id,text,time)=>{if(hits.length>=cap||(kind!=='text'&&!hasNoteContent(text)))return;const snippet=librarySnippet(text,query);if(snippet)hits.push({kind,id,time,snippet});};
  add('project-note',null,doc.project_note);
  for(const bookmark of doc.timestamp_bookmarks||[]){add('bookmark',bookmark.id,bookmark.note,bookmark.time);if(hits.length>=cap)return hits;}
  const sourceHits=scope==='text'?searchDocument(doc,query,'text').previews:null;
  for(const segment of doc.segments){
   add('note',segment.id,doc.notes?.[segment.id],segment.start);
   const hit=sourceHits?.get('text:'+segment.id);
   if(hit&&hits.length<cap)hits.push({kind:'text',id:segment.id,ids:hit.ids,time:segment.start,snippet:hit.snippet});
   if(hits.length>=cap)break;
  }
  return hits;
 }
 function sortedLibrary(documents, order) {
  const result=documents.slice();
  if(order==='title')result.sort((a,b)=>a.title.localeCompare(b.title,'zh-Hans',{numeric:true,sensitivity:'base'}));
  if(order==='duration')result.sort((a,b)=>documentDuration(a)-documentDuration(b));
  return result;
 }
 // A document-identity cache, not persistent state. Ordinary note/bookmark/view
 // saves do not rebuild source text. Mutators must invalidate before readers or
 // AI scope checks observe changed text, translations, contexts or glossary.
 const searchIndexes=new WeakMap();
 function invalidateSearch(doc){searchIndexes.delete(doc);}
 function searchDocument(doc,query,scope='all') {
  let cache=searchIndexes.get(doc);
  if(!cache||cache.segments!==doc.segments||cache.length!==doc.segments.length||cache.language!==(doc.language||'')||cache.contexts!==doc.translation_contexts||cache.glossary!==doc.translation_glossary){
   const passages=typeof module!=="undefined"&&module.exports?require('./passages.js'):root.CoconutPassages;
   const languages=new Set(doc.segments.flatMap(cue=>Object.keys(cue.translations||{})));
   const translations=new Map([...languages].map(language=>[language,cue=>{const item=cue.translations?.[language];return translationCurrent(cue,doc,item)?item.text:null;}]));
   cache={segments:doc.segments,length:doc.segments.length,language:doc.language||'',contexts:doc.translation_contexts,glossary:doc.translation_glossary,index:passages.searchIndex(doc.segments,translations)};searchIndexes.set(doc,cache);
  }
  return cache.index.search(query,scope==='text'?'text':'all');
 }
 let lastSearchQuery='',lastSearchNeedle='';
 function searchNeedle(query){if(query!==lastSearchQuery){lastSearchQuery=query;lastSearchNeedle=query.trim().toLocaleLowerCase();}return lastSearchNeedle;}
 function matchesSegment(segment, doc, query, notesOnly=false, excerptsOnly=false) {
  const note=doc.notes?.[segment.id],hasNote=hasNoteContent(note),needle=searchNeedle(query);
  if(notesOnly&&!hasNote||excerptsOnly&&segment.saved_excerpt!==true)return false;
  if(!needle)return true;
  // Metadata fields are independent and live. Never invent a phrase by joining
  // original, speaker, note, or different translation-language fields together.
  return searchDocument(doc,needle).byCue.has(segment.id)||[segment.speaker||'',hasNote?note:''].some(text=>text.toLocaleLowerCase().includes(needle));
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
		const localSource=localMediaSource(data.local_media_source);
  if(data.local_media_source!==undefined&&(!localSource||data.podcast_source!==undefined||data.source_media!==undefined))throw new Error('本地文件来源无效或混入其他媒体来源');
  const sourceMedia = mediaSource(data.source_media);
		return {
			notes,
   ...((data.project_note!==undefined||data.timestamp_bookmarks!==undefined)?projectAnnotations(data):{}),
   ...(data.project_language_override===true&&hasProjectAnnotations(data)?{project_language_override:true}:{}),
   ...(Number.isFinite(data.media_duration)&&data.media_duration>0&&data.media_duration<=604800?{media_duration:data.media_duration}:{}),
			...(typeof data.readingPosition === "string" && ids.has(data.readingPosition) ? {readingPosition: data.readingPosition} : {}),
			...(provenance ? { provenance } : {}),
			...(sourceMedia ? { source_media: sourceMedia } : {}),
   ...(localSource?{local_media_source:localSource}:{}),
            ...(podcastSource(data.podcast_source)?{podcast_source:podcastSource(data.podcast_source)}:{}),
			schema_version: 1,
            language: typeof data.language === "string" ? data.language : "",
            translation_view: ["en","zh","ja","ko","fr","de","es"].includes(data.translation_view) ? data.translation_view : "",
            summary_job: Summaries.clean(data.summary_job),
            ai_answers: Array.isArray(data.ai_answers) ? retainAnswers(data.ai_answers).map(cleanAnswer) : [],
			title: typeof data.title === "string" ? data.title : "未命名文字稿",
			source_url: localSource?(podcastURL(data.source_url)||''):typeof data.source_url === "string" ? data.source_url : "",
			segments,
            translation_contexts: cleanContexts(data.translation_contexts, segments),
            translation_glossary: cleanDocumentGlossary(data.translation_glossary),
		};
	}
 function cleanAnswer(answer) {
  const input=cleanAnswerInput(answer.input_snapshot),process=answer.summary_process;
  return {
   question:answer.question.slice(0,4000),answer:answer.answer.slice(0,100000),
   // References are historical data too. Missing current cues must stay visible
   // as unavailable references, never be silently erased or retargeted.
   citations:answer.citations.filter(id=>typeof id==="string"),
   ...(input?{input_snapshot:input}:{}),
   ...(["summary","question"].includes(answer.purpose)?{purpose:answer.purpose}:{}),
   ...(process?.version===1&&Number.isInteger(process.batches)&&process.batches>=1&&process.batches<=64?{summary_process:{version:1,batches:process.batches,requests:process.batches+(process.batches>1?1:0),citation_basis:process.batches>1?"batch_sources":"direct"}}:{}),
   provider:typeof answer.provider==="string"?answer.provider.slice(0,100):"unknown"
  };
 }
 function retainAnswers(answers) {
  // Storage is append-only history. Limit the rendered page, never the records.
  return answers.filter(a=>a && typeof a.question==="string" && typeof a.answer==="string" && Array.isArray(a.citations));
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
  const lines=["# "+line(doc.title)+" · 本地 AI 记录","","AI 输出仍需核对；以下是本篇当前保留的全部回答，不受当前筛选或历史分页影响。包含当前页尚未保存到浏览器的结果，请结合页面保存提示核对。","来源定位使用当前文字稿的时间与链接，可能不同于生成回答时的媒体信息。",""];
  const origin=podcastOrigin(doc);if(origin)lines.push("[播客原站]("+origin+")","时间戳需在原声中手动定位；没有伪造平台时间跳转链接。", "");
  for(const [index,answer] of (doc.ai_answers||[]).entries()){
   const freshness=answer.purpose==="summary"?summaryFreshness(answer,doc):answerFreshness(answer,doc), input=cleanAnswerInput(answer.input_snapshot);
   lines.push("## 回答 "+(index+1),"","提供商："+line(answer.provider||"unknown"),"",
    "依据状态："+({current:"完整发送原文仍与当前稿一致（不代表回答正确）",stale:"发送原文或整篇范围已变化，回答依据可能过期",unknown:"缺少完整发送原文，无法确认依据是否仍有效"}[freshness]),"",
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
   if(input.scope){const scope=input.scope;lines.push("范围：问这一段"+(scope.expanded?"（明确加入前后相邻段落）":"（仅所选段落）"),"来源："+line(scope.source_title),"来源地址："+line(scope.source_url||"未提供"),"原文语言："+line(scope.source_language||"未标注"),"所选工具："+line(scope.provider)+" · 回答语言："+line(scope.answer_language),"原段落片段："+scope.passage_ids.map(line).join("、"),"");}
   lines.push(input.segments.length+" 个片段；包括模型读到但未引用的内容。","");
   for(const [position,segment] of input.segments.entries()){const cue=input.scope?.cues[position];lines.push("片段 "+line(segment.id)+(cue?" · 请求时 "+time(cue.start)+"–"+time(cue.end)+" · "+cue.start+"–"+cue.end+" 秒"+(cue.speaker?" · "+line(cue.speaker):""):""),"",quote(segment.text),"");}
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
 // Snapshot the cue timeline for repeated playback lookups. Source order, not
 // chronological order, wins overlaps, exactly as Array.findLast does. Each
 // node bounds its source-order interval; right-first traversal finds the last
 // matching cue without assuming sorted starts or non-overlapping timestamps.
 // Ordinary chronological transcripts take O(log n) per lookup; adversarial
 // interleaved bounds can still require O(n). Rebuild after timeline mutations.
 function createPlaybackIndex(segments) {
  const cues=Array.from(segments);
  let size=1;while(size<cues.length)size*=2;
  const starts=new Float64Array(size*2).fill(Infinity);
  const ends=new Float64Array(size*2).fill(-Infinity);
  for(let i=0;i<cues.length;i++){
   starts[size+i]=cues[i].start;ends[size+i]=cues[i].end;
  }
  for(let node=size-1;node>0;node--){
   starts[node]=Math.min(starts[node*2],starts[node*2+1]);
   ends[node]=Math.max(ends[node*2],ends[node*2+1]);
  }
  function find(seconds) {
   if(!Number.isFinite(seconds))return undefined;
   function visit(node) {
    if(starts[node]>seconds||ends[node]<seconds)return undefined;
    if(node>=size)return cues[node-size];
    return visit(node*2+1)||visit(node*2);
   }
   return visit(1);
  }
  return Object.freeze({find});
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
  const escape = value => String(value).replace(/\u0000/g,"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const text = value => escape(value).replace(/\r\n?/g,"\n").split("\n").filter(line=>line.trim()).join("\n");
  let translated = 0;
  const cues = doc.segments.map((segment,index)=>{
   const lines = [text(segment.text) || " "];
   const translation = segment.translations?.[doc.translation_view];
   if (bilingual && translation && translationCurrent(segment,doc,translation)) { lines.push(text(translation.text)); translated++; }
   const start = Math.round(segment.start*1000);
   const end = Math.max(start + 1, Math.round(segment.end*1000));
   const speaker = typeof segment.speaker === "string" ? segment.speaker.replace(/[\t\n\f\r ]+/g," ").replace(/^ | $/g,"") : "";
   const body = lines.join("\n");
   return `${index+1}\n${stamp(start)} --> ${stamp(end)}\n${format === "vtt" && speaker ? "<v "+escape(speaker)+">"+body+"</v>" : body}`;
  });
  return {text:(format === "vtt" ? "WEBVTT\n\n" : "") + cues.join("\n\n") + "\n", translated};
 }
 function mergeLibraryBackup(current, backup) {
  if (!backup || backup.format !== "coconut-library" || backup.version !== 1 || !Array.isArray(backup.documents))
   throw new Error("不是支持的 Coconut 书架备份");
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
		return doc.segments.filter(s => s.saved_excerpt === true || hasNoteContent(doc.notes?.[s.id]));
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
				if (translationCurrent(segment, doc, translated)) lines.push("译文（" + singleLine(doc.translation_view) + "；初始来源：" + singleLine(translated.provider) + (translated.manual_review ? "；用户人工核对／修正）：" : "；机器生成，需核对）："), "", quote(translated.text), "");
				else lines.push("此片段译文已过期，未导出。", "");
                if(translationCurrent(segment,doc,translated)&&translationQualityMessage(translated))lines.push("译文待核对："+translationQualityMessage(translated), "");
			}
			if (hasNoteContent(doc.notes?.[segment.id])) lines.push("我的笔记：", "", quote(doc.notes[segment.id]), "");
		}
  if(hasProjectAnnotations(doc)&&projectAnnotationCount(doc)){
   lines.push('## 项目笔记与时间书签','','以下是用户自己的记录，不是原文或经过验证的引用。','');
   if(hasNoteContent(doc.project_note))lines.push('### 项目笔记','',quote(doc.project_note),'');
   for(const item of doc.timestamp_bookmarks)lines.push('### '+time(item.time),'',hasNoteContent(item.note)?quote(item.note):'时间书签（未填写笔记）','');
  }
		return lines.join("\n");
	}
 function audioNotebookMarkdown(doc) {
  const quote=value=>markdownText(value).replace(/\r\n?/g,'\n').split('\n').map(line=>'> '+line).join('\n');
  const lines=['# '+markdownText(doc.title).replace(/[\r\n]+/g,' '),'','Coconut 原声项目笔记','',
   '尚未导入文字稿，没有摘要。以下仅为用户笔记和时间书签，不是原文或经过验证的引用。','',
   'Markdown 用于阅读；完整恢复请保留 Coconut JSON 备份。备份不包含媒体，回听需重新获取或选择本地文件。',''];
  const origin=podcastOrigin(doc);if(origin)lines.push('[原始来源]('+origin+')','时间戳需在原声中手动定位。','');
  if(hasNoteContent(doc.project_note))lines.push('## 项目笔记','',quote(doc.project_note),'');
  for(const item of doc.timestamp_bookmarks||[])lines.push('## '+time(item.time),'',hasNoteContent(item.note)?quote(item.note):'时间书签（未填写笔记）','');
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
	function subtitleEntities(value) {
		const names = {amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" "};
		return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (match, key) => {
			if (key[0] !== "#") return names[key.toLowerCase()] || match;
			const code = key[1].toLowerCase() === "x" ? Number.parseInt(key.slice(2),16) : Number.parseInt(key.slice(1),10);
			return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
		});
	}
	function subtitleText(value) {
		return subtitleEntities(value.replace(/<\/?(?:b|i|u|ruby|rt|v|c|X-word-ms)(?:[ .][^>]*)?>|<\d{2}:\d{2}(?::\d{2})?\.\d{3}>/gi, ""));
	}
 // BEGIN GENERATED HTML NAMED REFERENCES
 // Generated by scripts/vtt_entities.py from Python html.entities.html5.
 const VTT_ENTITIES = Object.freeze({"AElig":"\u00c6","AElig;":"\u00c6","AMP":"&","AMP;":"&","Aacute":"\u00c1","Aacute;":"\u00c1","Abreve;":"\u0102","Acirc":"\u00c2","Acirc;":"\u00c2","Acy;":"\u0410","Afr;":"\ud835\udd04","Agrave":"\u00c0","Agrave;":"\u00c0","Alpha;":"\u0391","Amacr;":"\u0100","And;":"\u2a53","Aogon;":"\u0104","Aopf;":"\ud835\udd38","ApplyFunction;":"\u2061","Aring":"\u00c5","Aring;":"\u00c5","Ascr;":"\ud835\udc9c","Assign;":"\u2254","Atilde":"\u00c3","Atilde;":"\u00c3","Auml":"\u00c4","Auml;":"\u00c4","Backslash;":"\u2216","Barv;":"\u2ae7","Barwed;":"\u2306","Bcy;":"\u0411","Because;":"\u2235","Bernoullis;":"\u212c","Beta;":"\u0392","Bfr;":"\ud835\udd05","Bopf;":"\ud835\udd39","Breve;":"\u02d8","Bscr;":"\u212c","Bumpeq;":"\u224e","CHcy;":"\u0427","COPY":"\u00a9","COPY;":"\u00a9","Cacute;":"\u0106","Cap;":"\u22d2","CapitalDifferentialD;":"\u2145","Cayleys;":"\u212d","Ccaron;":"\u010c","Ccedil":"\u00c7","Ccedil;":"\u00c7","Ccirc;":"\u0108","Cconint;":"\u2230","Cdot;":"\u010a","Cedilla;":"\u00b8","CenterDot;":"\u00b7","Cfr;":"\u212d","Chi;":"\u03a7","CircleDot;":"\u2299","CircleMinus;":"\u2296","CirclePlus;":"\u2295","CircleTimes;":"\u2297","ClockwiseContourIntegral;":"\u2232","CloseCurlyDoubleQuote;":"\u201d","CloseCurlyQuote;":"\u2019","Colon;":"\u2237","Colone;":"\u2a74","Congruent;":"\u2261","Conint;":"\u222f","ContourIntegral;":"\u222e","Copf;":"\u2102","Coproduct;":"\u2210","CounterClockwiseContourIntegral;":"\u2233","Cross;":"\u2a2f","Cscr;":"\ud835\udc9e","Cup;":"\u22d3","CupCap;":"\u224d","DD;":"\u2145","DDotrahd;":"\u2911","DJcy;":"\u0402","DScy;":"\u0405","DZcy;":"\u040f","Dagger;":"\u2021","Darr;":"\u21a1","Dashv;":"\u2ae4","Dcaron;":"\u010e","Dcy;":"\u0414","Del;":"\u2207","Delta;":"\u0394","Dfr;":"\ud835\udd07","DiacriticalAcute;":"\u00b4","DiacriticalDot;":"\u02d9","DiacriticalDoubleAcute;":"\u02dd","DiacriticalGrave;":"`","DiacriticalTilde;":"\u02dc","Diamond;":"\u22c4","DifferentialD;":"\u2146","Dopf;":"\ud835\udd3b","Dot;":"\u00a8","DotDot;":"\u20dc","DotEqual;":"\u2250","DoubleContourIntegral;":"\u222f","DoubleDot;":"\u00a8","DoubleDownArrow;":"\u21d3","DoubleLeftArrow;":"\u21d0","DoubleLeftRightArrow;":"\u21d4","DoubleLeftTee;":"\u2ae4","DoubleLongLeftArrow;":"\u27f8","DoubleLongLeftRightArrow;":"\u27fa","DoubleLongRightArrow;":"\u27f9","DoubleRightArrow;":"\u21d2","DoubleRightTee;":"\u22a8","DoubleUpArrow;":"\u21d1","DoubleUpDownArrow;":"\u21d5","DoubleVerticalBar;":"\u2225","DownArrow;":"\u2193","DownArrowBar;":"\u2913","DownArrowUpArrow;":"\u21f5","DownBreve;":"\u0311","DownLeftRightVector;":"\u2950","DownLeftTeeVector;":"\u295e","DownLeftVector;":"\u21bd","DownLeftVectorBar;":"\u2956","DownRightTeeVector;":"\u295f","DownRightVector;":"\u21c1","DownRightVectorBar;":"\u2957","DownTee;":"\u22a4","DownTeeArrow;":"\u21a7","Downarrow;":"\u21d3","Dscr;":"\ud835\udc9f","Dstrok;":"\u0110","ENG;":"\u014a","ETH":"\u00d0","ETH;":"\u00d0","Eacute":"\u00c9","Eacute;":"\u00c9","Ecaron;":"\u011a","Ecirc":"\u00ca","Ecirc;":"\u00ca","Ecy;":"\u042d","Edot;":"\u0116","Efr;":"\ud835\udd08","Egrave":"\u00c8","Egrave;":"\u00c8","Element;":"\u2208","Emacr;":"\u0112","EmptySmallSquare;":"\u25fb","EmptyVerySmallSquare;":"\u25ab","Eogon;":"\u0118","Eopf;":"\ud835\udd3c","Epsilon;":"\u0395","Equal;":"\u2a75","EqualTilde;":"\u2242","Equilibrium;":"\u21cc","Escr;":"\u2130","Esim;":"\u2a73","Eta;":"\u0397","Euml":"\u00cb","Euml;":"\u00cb","Exists;":"\u2203","ExponentialE;":"\u2147","Fcy;":"\u0424","Ffr;":"\ud835\udd09","FilledSmallSquare;":"\u25fc","FilledVerySmallSquare;":"\u25aa","Fopf;":"\ud835\udd3d","ForAll;":"\u2200","Fouriertrf;":"\u2131","Fscr;":"\u2131","GJcy;":"\u0403","GT":">","GT;":">","Gamma;":"\u0393","Gammad;":"\u03dc","Gbreve;":"\u011e","Gcedil;":"\u0122","Gcirc;":"\u011c","Gcy;":"\u0413","Gdot;":"\u0120","Gfr;":"\ud835\udd0a","Gg;":"\u22d9","Gopf;":"\ud835\udd3e","GreaterEqual;":"\u2265","GreaterEqualLess;":"\u22db","GreaterFullEqual;":"\u2267","GreaterGreater;":"\u2aa2","GreaterLess;":"\u2277","GreaterSlantEqual;":"\u2a7e","GreaterTilde;":"\u2273","Gscr;":"\ud835\udca2","Gt;":"\u226b","HARDcy;":"\u042a","Hacek;":"\u02c7","Hat;":"^","Hcirc;":"\u0124","Hfr;":"\u210c","HilbertSpace;":"\u210b","Hopf;":"\u210d","HorizontalLine;":"\u2500","Hscr;":"\u210b","Hstrok;":"\u0126","HumpDownHump;":"\u224e","HumpEqual;":"\u224f","IEcy;":"\u0415","IJlig;":"\u0132","IOcy;":"\u0401","Iacute":"\u00cd","Iacute;":"\u00cd","Icirc":"\u00ce","Icirc;":"\u00ce","Icy;":"\u0418","Idot;":"\u0130","Ifr;":"\u2111","Igrave":"\u00cc","Igrave;":"\u00cc","Im;":"\u2111","Imacr;":"\u012a","ImaginaryI;":"\u2148","Implies;":"\u21d2","Int;":"\u222c","Integral;":"\u222b","Intersection;":"\u22c2","InvisibleComma;":"\u2063","InvisibleTimes;":"\u2062","Iogon;":"\u012e","Iopf;":"\ud835\udd40","Iota;":"\u0399","Iscr;":"\u2110","Itilde;":"\u0128","Iukcy;":"\u0406","Iuml":"\u00cf","Iuml;":"\u00cf","Jcirc;":"\u0134","Jcy;":"\u0419","Jfr;":"\ud835\udd0d","Jopf;":"\ud835\udd41","Jscr;":"\ud835\udca5","Jsercy;":"\u0408","Jukcy;":"\u0404","KHcy;":"\u0425","KJcy;":"\u040c","Kappa;":"\u039a","Kcedil;":"\u0136","Kcy;":"\u041a","Kfr;":"\ud835\udd0e","Kopf;":"\ud835\udd42","Kscr;":"\ud835\udca6","LJcy;":"\u0409","LT":"<","LT;":"<","Lacute;":"\u0139","Lambda;":"\u039b","Lang;":"\u27ea","Laplacetrf;":"\u2112","Larr;":"\u219e","Lcaron;":"\u013d","Lcedil;":"\u013b","Lcy;":"\u041b","LeftAngleBracket;":"\u27e8","LeftArrow;":"\u2190","LeftArrowBar;":"\u21e4","LeftArrowRightArrow;":"\u21c6","LeftCeiling;":"\u2308","LeftDoubleBracket;":"\u27e6","LeftDownTeeVector;":"\u2961","LeftDownVector;":"\u21c3","LeftDownVectorBar;":"\u2959","LeftFloor;":"\u230a","LeftRightArrow;":"\u2194","LeftRightVector;":"\u294e","LeftTee;":"\u22a3","LeftTeeArrow;":"\u21a4","LeftTeeVector;":"\u295a","LeftTriangle;":"\u22b2","LeftTriangleBar;":"\u29cf","LeftTriangleEqual;":"\u22b4","LeftUpDownVector;":"\u2951","LeftUpTeeVector;":"\u2960","LeftUpVector;":"\u21bf","LeftUpVectorBar;":"\u2958","LeftVector;":"\u21bc","LeftVectorBar;":"\u2952","Leftarrow;":"\u21d0","Leftrightarrow;":"\u21d4","LessEqualGreater;":"\u22da","LessFullEqual;":"\u2266","LessGreater;":"\u2276","LessLess;":"\u2aa1","LessSlantEqual;":"\u2a7d","LessTilde;":"\u2272","Lfr;":"\ud835\udd0f","Ll;":"\u22d8","Lleftarrow;":"\u21da","Lmidot;":"\u013f","LongLeftArrow;":"\u27f5","LongLeftRightArrow;":"\u27f7","LongRightArrow;":"\u27f6","Longleftarrow;":"\u27f8","Longleftrightarrow;":"\u27fa","Longrightarrow;":"\u27f9","Lopf;":"\ud835\udd43","LowerLeftArrow;":"\u2199","LowerRightArrow;":"\u2198","Lscr;":"\u2112","Lsh;":"\u21b0","Lstrok;":"\u0141","Lt;":"\u226a","Map;":"\u2905","Mcy;":"\u041c","MediumSpace;":"\u205f","Mellintrf;":"\u2133","Mfr;":"\ud835\udd10","MinusPlus;":"\u2213","Mopf;":"\ud835\udd44","Mscr;":"\u2133","Mu;":"\u039c","NJcy;":"\u040a","Nacute;":"\u0143","Ncaron;":"\u0147","Ncedil;":"\u0145","Ncy;":"\u041d","NegativeMediumSpace;":"\u200b","NegativeThickSpace;":"\u200b","NegativeThinSpace;":"\u200b","NegativeVeryThinSpace;":"\u200b","NestedGreaterGreater;":"\u226b","NestedLessLess;":"\u226a","NewLine;":"\n","Nfr;":"\ud835\udd11","NoBreak;":"\u2060","NonBreakingSpace;":"\u00a0","Nopf;":"\u2115","Not;":"\u2aec","NotCongruent;":"\u2262","NotCupCap;":"\u226d","NotDoubleVerticalBar;":"\u2226","NotElement;":"\u2209","NotEqual;":"\u2260","NotEqualTilde;":"\u2242\u0338","NotExists;":"\u2204","NotGreater;":"\u226f","NotGreaterEqual;":"\u2271","NotGreaterFullEqual;":"\u2267\u0338","NotGreaterGreater;":"\u226b\u0338","NotGreaterLess;":"\u2279","NotGreaterSlantEqual;":"\u2a7e\u0338","NotGreaterTilde;":"\u2275","NotHumpDownHump;":"\u224e\u0338","NotHumpEqual;":"\u224f\u0338","NotLeftTriangle;":"\u22ea","NotLeftTriangleBar;":"\u29cf\u0338","NotLeftTriangleEqual;":"\u22ec","NotLess;":"\u226e","NotLessEqual;":"\u2270","NotLessGreater;":"\u2278","NotLessLess;":"\u226a\u0338","NotLessSlantEqual;":"\u2a7d\u0338","NotLessTilde;":"\u2274","NotNestedGreaterGreater;":"\u2aa2\u0338","NotNestedLessLess;":"\u2aa1\u0338","NotPrecedes;":"\u2280","NotPrecedesEqual;":"\u2aaf\u0338","NotPrecedesSlantEqual;":"\u22e0","NotReverseElement;":"\u220c","NotRightTriangle;":"\u22eb","NotRightTriangleBar;":"\u29d0\u0338","NotRightTriangleEqual;":"\u22ed","NotSquareSubset;":"\u228f\u0338","NotSquareSubsetEqual;":"\u22e2","NotSquareSuperset;":"\u2290\u0338","NotSquareSupersetEqual;":"\u22e3","NotSubset;":"\u2282\u20d2","NotSubsetEqual;":"\u2288","NotSucceeds;":"\u2281","NotSucceedsEqual;":"\u2ab0\u0338","NotSucceedsSlantEqual;":"\u22e1","NotSucceedsTilde;":"\u227f\u0338","NotSuperset;":"\u2283\u20d2","NotSupersetEqual;":"\u2289","NotTilde;":"\u2241","NotTildeEqual;":"\u2244","NotTildeFullEqual;":"\u2247","NotTildeTilde;":"\u2249","NotVerticalBar;":"\u2224","Nscr;":"\ud835\udca9","Ntilde":"\u00d1","Ntilde;":"\u00d1","Nu;":"\u039d","OElig;":"\u0152","Oacute":"\u00d3","Oacute;":"\u00d3","Ocirc":"\u00d4","Ocirc;":"\u00d4","Ocy;":"\u041e","Odblac;":"\u0150","Ofr;":"\ud835\udd12","Ograve":"\u00d2","Ograve;":"\u00d2","Omacr;":"\u014c","Omega;":"\u03a9","Omicron;":"\u039f","Oopf;":"\ud835\udd46","OpenCurlyDoubleQuote;":"\u201c","OpenCurlyQuote;":"\u2018","Or;":"\u2a54","Oscr;":"\ud835\udcaa","Oslash":"\u00d8","Oslash;":"\u00d8","Otilde":"\u00d5","Otilde;":"\u00d5","Otimes;":"\u2a37","Ouml":"\u00d6","Ouml;":"\u00d6","OverBar;":"\u203e","OverBrace;":"\u23de","OverBracket;":"\u23b4","OverParenthesis;":"\u23dc","PartialD;":"\u2202","Pcy;":"\u041f","Pfr;":"\ud835\udd13","Phi;":"\u03a6","Pi;":"\u03a0","PlusMinus;":"\u00b1","Poincareplane;":"\u210c","Popf;":"\u2119","Pr;":"\u2abb","Precedes;":"\u227a","PrecedesEqual;":"\u2aaf","PrecedesSlantEqual;":"\u227c","PrecedesTilde;":"\u227e","Prime;":"\u2033","Product;":"\u220f","Proportion;":"\u2237","Proportional;":"\u221d","Pscr;":"\ud835\udcab","Psi;":"\u03a8","QUOT":"\"","QUOT;":"\"","Qfr;":"\ud835\udd14","Qopf;":"\u211a","Qscr;":"\ud835\udcac","RBarr;":"\u2910","REG":"\u00ae","REG;":"\u00ae","Racute;":"\u0154","Rang;":"\u27eb","Rarr;":"\u21a0","Rarrtl;":"\u2916","Rcaron;":"\u0158","Rcedil;":"\u0156","Rcy;":"\u0420","Re;":"\u211c","ReverseElement;":"\u220b","ReverseEquilibrium;":"\u21cb","ReverseUpEquilibrium;":"\u296f","Rfr;":"\u211c","Rho;":"\u03a1","RightAngleBracket;":"\u27e9","RightArrow;":"\u2192","RightArrowBar;":"\u21e5","RightArrowLeftArrow;":"\u21c4","RightCeiling;":"\u2309","RightDoubleBracket;":"\u27e7","RightDownTeeVector;":"\u295d","RightDownVector;":"\u21c2","RightDownVectorBar;":"\u2955","RightFloor;":"\u230b","RightTee;":"\u22a2","RightTeeArrow;":"\u21a6","RightTeeVector;":"\u295b","RightTriangle;":"\u22b3","RightTriangleBar;":"\u29d0","RightTriangleEqual;":"\u22b5","RightUpDownVector;":"\u294f","RightUpTeeVector;":"\u295c","RightUpVector;":"\u21be","RightUpVectorBar;":"\u2954","RightVector;":"\u21c0","RightVectorBar;":"\u2953","Rightarrow;":"\u21d2","Ropf;":"\u211d","RoundImplies;":"\u2970","Rrightarrow;":"\u21db","Rscr;":"\u211b","Rsh;":"\u21b1","RuleDelayed;":"\u29f4","SHCHcy;":"\u0429","SHcy;":"\u0428","SOFTcy;":"\u042c","Sacute;":"\u015a","Sc;":"\u2abc","Scaron;":"\u0160","Scedil;":"\u015e","Scirc;":"\u015c","Scy;":"\u0421","Sfr;":"\ud835\udd16","ShortDownArrow;":"\u2193","ShortLeftArrow;":"\u2190","ShortRightArrow;":"\u2192","ShortUpArrow;":"\u2191","Sigma;":"\u03a3","SmallCircle;":"\u2218","Sopf;":"\ud835\udd4a","Sqrt;":"\u221a","Square;":"\u25a1","SquareIntersection;":"\u2293","SquareSubset;":"\u228f","SquareSubsetEqual;":"\u2291","SquareSuperset;":"\u2290","SquareSupersetEqual;":"\u2292","SquareUnion;":"\u2294","Sscr;":"\ud835\udcae","Star;":"\u22c6","Sub;":"\u22d0","Subset;":"\u22d0","SubsetEqual;":"\u2286","Succeeds;":"\u227b","SucceedsEqual;":"\u2ab0","SucceedsSlantEqual;":"\u227d","SucceedsTilde;":"\u227f","SuchThat;":"\u220b","Sum;":"\u2211","Sup;":"\u22d1","Superset;":"\u2283","SupersetEqual;":"\u2287","Supset;":"\u22d1","THORN":"\u00de","THORN;":"\u00de","TRADE;":"\u2122","TSHcy;":"\u040b","TScy;":"\u0426","Tab;":"\t","Tau;":"\u03a4","Tcaron;":"\u0164","Tcedil;":"\u0162","Tcy;":"\u0422","Tfr;":"\ud835\udd17","Therefore;":"\u2234","Theta;":"\u0398","ThickSpace;":"\u205f\u200a","ThinSpace;":"\u2009","Tilde;":"\u223c","TildeEqual;":"\u2243","TildeFullEqual;":"\u2245","TildeTilde;":"\u2248","Topf;":"\ud835\udd4b","TripleDot;":"\u20db","Tscr;":"\ud835\udcaf","Tstrok;":"\u0166","Uacute":"\u00da","Uacute;":"\u00da","Uarr;":"\u219f","Uarrocir;":"\u2949","Ubrcy;":"\u040e","Ubreve;":"\u016c","Ucirc":"\u00db","Ucirc;":"\u00db","Ucy;":"\u0423","Udblac;":"\u0170","Ufr;":"\ud835\udd18","Ugrave":"\u00d9","Ugrave;":"\u00d9","Umacr;":"\u016a","UnderBar;":"_","UnderBrace;":"\u23df","UnderBracket;":"\u23b5","UnderParenthesis;":"\u23dd","Union;":"\u22c3","UnionPlus;":"\u228e","Uogon;":"\u0172","Uopf;":"\ud835\udd4c","UpArrow;":"\u2191","UpArrowBar;":"\u2912","UpArrowDownArrow;":"\u21c5","UpDownArrow;":"\u2195","UpEquilibrium;":"\u296e","UpTee;":"\u22a5","UpTeeArrow;":"\u21a5","Uparrow;":"\u21d1","Updownarrow;":"\u21d5","UpperLeftArrow;":"\u2196","UpperRightArrow;":"\u2197","Upsi;":"\u03d2","Upsilon;":"\u03a5","Uring;":"\u016e","Uscr;":"\ud835\udcb0","Utilde;":"\u0168","Uuml":"\u00dc","Uuml;":"\u00dc","VDash;":"\u22ab","Vbar;":"\u2aeb","Vcy;":"\u0412","Vdash;":"\u22a9","Vdashl;":"\u2ae6","Vee;":"\u22c1","Verbar;":"\u2016","Vert;":"\u2016","VerticalBar;":"\u2223","VerticalLine;":"|","VerticalSeparator;":"\u2758","VerticalTilde;":"\u2240","VeryThinSpace;":"\u200a","Vfr;":"\ud835\udd19","Vopf;":"\ud835\udd4d","Vscr;":"\ud835\udcb1","Vvdash;":"\u22aa","Wcirc;":"\u0174","Wedge;":"\u22c0","Wfr;":"\ud835\udd1a","Wopf;":"\ud835\udd4e","Wscr;":"\ud835\udcb2","Xfr;":"\ud835\udd1b","Xi;":"\u039e","Xopf;":"\ud835\udd4f","Xscr;":"\ud835\udcb3","YAcy;":"\u042f","YIcy;":"\u0407","YUcy;":"\u042e","Yacute":"\u00dd","Yacute;":"\u00dd","Ycirc;":"\u0176","Ycy;":"\u042b","Yfr;":"\ud835\udd1c","Yopf;":"\ud835\udd50","Yscr;":"\ud835\udcb4","Yuml;":"\u0178","ZHcy;":"\u0416","Zacute;":"\u0179","Zcaron;":"\u017d","Zcy;":"\u0417","Zdot;":"\u017b","ZeroWidthSpace;":"\u200b","Zeta;":"\u0396","Zfr;":"\u2128","Zopf;":"\u2124","Zscr;":"\ud835\udcb5","aacute":"\u00e1","aacute;":"\u00e1","abreve;":"\u0103","ac;":"\u223e","acE;":"\u223e\u0333","acd;":"\u223f","acirc":"\u00e2","acirc;":"\u00e2","acute":"\u00b4","acute;":"\u00b4","acy;":"\u0430","aelig":"\u00e6","aelig;":"\u00e6","af;":"\u2061","afr;":"\ud835\udd1e","agrave":"\u00e0","agrave;":"\u00e0","alefsym;":"\u2135","aleph;":"\u2135","alpha;":"\u03b1","amacr;":"\u0101","amalg;":"\u2a3f","amp":"&","amp;":"&","and;":"\u2227","andand;":"\u2a55","andd;":"\u2a5c","andslope;":"\u2a58","andv;":"\u2a5a","ang;":"\u2220","ange;":"\u29a4","angle;":"\u2220","angmsd;":"\u2221","angmsdaa;":"\u29a8","angmsdab;":"\u29a9","angmsdac;":"\u29aa","angmsdad;":"\u29ab","angmsdae;":"\u29ac","angmsdaf;":"\u29ad","angmsdag;":"\u29ae","angmsdah;":"\u29af","angrt;":"\u221f","angrtvb;":"\u22be","angrtvbd;":"\u299d","angsph;":"\u2222","angst;":"\u00c5","angzarr;":"\u237c","aogon;":"\u0105","aopf;":"\ud835\udd52","ap;":"\u2248","apE;":"\u2a70","apacir;":"\u2a6f","ape;":"\u224a","apid;":"\u224b","apos;":"'","approx;":"\u2248","approxeq;":"\u224a","aring":"\u00e5","aring;":"\u00e5","ascr;":"\ud835\udcb6","ast;":"*","asymp;":"\u2248","asympeq;":"\u224d","atilde":"\u00e3","atilde;":"\u00e3","auml":"\u00e4","auml;":"\u00e4","awconint;":"\u2233","awint;":"\u2a11","bNot;":"\u2aed","backcong;":"\u224c","backepsilon;":"\u03f6","backprime;":"\u2035","backsim;":"\u223d","backsimeq;":"\u22cd","barvee;":"\u22bd","barwed;":"\u2305","barwedge;":"\u2305","bbrk;":"\u23b5","bbrktbrk;":"\u23b6","bcong;":"\u224c","bcy;":"\u0431","bdquo;":"\u201e","becaus;":"\u2235","because;":"\u2235","bemptyv;":"\u29b0","bepsi;":"\u03f6","bernou;":"\u212c","beta;":"\u03b2","beth;":"\u2136","between;":"\u226c","bfr;":"\ud835\udd1f","bigcap;":"\u22c2","bigcirc;":"\u25ef","bigcup;":"\u22c3","bigodot;":"\u2a00","bigoplus;":"\u2a01","bigotimes;":"\u2a02","bigsqcup;":"\u2a06","bigstar;":"\u2605","bigtriangledown;":"\u25bd","bigtriangleup;":"\u25b3","biguplus;":"\u2a04","bigvee;":"\u22c1","bigwedge;":"\u22c0","bkarow;":"\u290d","blacklozenge;":"\u29eb","blacksquare;":"\u25aa","blacktriangle;":"\u25b4","blacktriangledown;":"\u25be","blacktriangleleft;":"\u25c2","blacktriangleright;":"\u25b8","blank;":"\u2423","blk12;":"\u2592","blk14;":"\u2591","blk34;":"\u2593","block;":"\u2588","bne;":"=\u20e5","bnequiv;":"\u2261\u20e5","bnot;":"\u2310","bopf;":"\ud835\udd53","bot;":"\u22a5","bottom;":"\u22a5","bowtie;":"\u22c8","boxDL;":"\u2557","boxDR;":"\u2554","boxDl;":"\u2556","boxDr;":"\u2553","boxH;":"\u2550","boxHD;":"\u2566","boxHU;":"\u2569","boxHd;":"\u2564","boxHu;":"\u2567","boxUL;":"\u255d","boxUR;":"\u255a","boxUl;":"\u255c","boxUr;":"\u2559","boxV;":"\u2551","boxVH;":"\u256c","boxVL;":"\u2563","boxVR;":"\u2560","boxVh;":"\u256b","boxVl;":"\u2562","boxVr;":"\u255f","boxbox;":"\u29c9","boxdL;":"\u2555","boxdR;":"\u2552","boxdl;":"\u2510","boxdr;":"\u250c","boxh;":"\u2500","boxhD;":"\u2565","boxhU;":"\u2568","boxhd;":"\u252c","boxhu;":"\u2534","boxminus;":"\u229f","boxplus;":"\u229e","boxtimes;":"\u22a0","boxuL;":"\u255b","boxuR;":"\u2558","boxul;":"\u2518","boxur;":"\u2514","boxv;":"\u2502","boxvH;":"\u256a","boxvL;":"\u2561","boxvR;":"\u255e","boxvh;":"\u253c","boxvl;":"\u2524","boxvr;":"\u251c","bprime;":"\u2035","breve;":"\u02d8","brvbar":"\u00a6","brvbar;":"\u00a6","bscr;":"\ud835\udcb7","bsemi;":"\u204f","bsim;":"\u223d","bsime;":"\u22cd","bsol;":"\\","bsolb;":"\u29c5","bsolhsub;":"\u27c8","bull;":"\u2022","bullet;":"\u2022","bump;":"\u224e","bumpE;":"\u2aae","bumpe;":"\u224f","bumpeq;":"\u224f","cacute;":"\u0107","cap;":"\u2229","capand;":"\u2a44","capbrcup;":"\u2a49","capcap;":"\u2a4b","capcup;":"\u2a47","capdot;":"\u2a40","caps;":"\u2229\ufe00","caret;":"\u2041","caron;":"\u02c7","ccaps;":"\u2a4d","ccaron;":"\u010d","ccedil":"\u00e7","ccedil;":"\u00e7","ccirc;":"\u0109","ccups;":"\u2a4c","ccupssm;":"\u2a50","cdot;":"\u010b","cedil":"\u00b8","cedil;":"\u00b8","cemptyv;":"\u29b2","cent":"\u00a2","cent;":"\u00a2","centerdot;":"\u00b7","cfr;":"\ud835\udd20","chcy;":"\u0447","check;":"\u2713","checkmark;":"\u2713","chi;":"\u03c7","cir;":"\u25cb","cirE;":"\u29c3","circ;":"\u02c6","circeq;":"\u2257","circlearrowleft;":"\u21ba","circlearrowright;":"\u21bb","circledR;":"\u00ae","circledS;":"\u24c8","circledast;":"\u229b","circledcirc;":"\u229a","circleddash;":"\u229d","cire;":"\u2257","cirfnint;":"\u2a10","cirmid;":"\u2aef","cirscir;":"\u29c2","clubs;":"\u2663","clubsuit;":"\u2663","colon;":":","colone;":"\u2254","coloneq;":"\u2254","comma;":",","commat;":"@","comp;":"\u2201","compfn;":"\u2218","complement;":"\u2201","complexes;":"\u2102","cong;":"\u2245","congdot;":"\u2a6d","conint;":"\u222e","copf;":"\ud835\udd54","coprod;":"\u2210","copy":"\u00a9","copy;":"\u00a9","copysr;":"\u2117","crarr;":"\u21b5","cross;":"\u2717","cscr;":"\ud835\udcb8","csub;":"\u2acf","csube;":"\u2ad1","csup;":"\u2ad0","csupe;":"\u2ad2","ctdot;":"\u22ef","cudarrl;":"\u2938","cudarrr;":"\u2935","cuepr;":"\u22de","cuesc;":"\u22df","cularr;":"\u21b6","cularrp;":"\u293d","cup;":"\u222a","cupbrcap;":"\u2a48","cupcap;":"\u2a46","cupcup;":"\u2a4a","cupdot;":"\u228d","cupor;":"\u2a45","cups;":"\u222a\ufe00","curarr;":"\u21b7","curarrm;":"\u293c","curlyeqprec;":"\u22de","curlyeqsucc;":"\u22df","curlyvee;":"\u22ce","curlywedge;":"\u22cf","curren":"\u00a4","curren;":"\u00a4","curvearrowleft;":"\u21b6","curvearrowright;":"\u21b7","cuvee;":"\u22ce","cuwed;":"\u22cf","cwconint;":"\u2232","cwint;":"\u2231","cylcty;":"\u232d","dArr;":"\u21d3","dHar;":"\u2965","dagger;":"\u2020","daleth;":"\u2138","darr;":"\u2193","dash;":"\u2010","dashv;":"\u22a3","dbkarow;":"\u290f","dblac;":"\u02dd","dcaron;":"\u010f","dcy;":"\u0434","dd;":"\u2146","ddagger;":"\u2021","ddarr;":"\u21ca","ddotseq;":"\u2a77","deg":"\u00b0","deg;":"\u00b0","delta;":"\u03b4","demptyv;":"\u29b1","dfisht;":"\u297f","dfr;":"\ud835\udd21","dharl;":"\u21c3","dharr;":"\u21c2","diam;":"\u22c4","diamond;":"\u22c4","diamondsuit;":"\u2666","diams;":"\u2666","die;":"\u00a8","digamma;":"\u03dd","disin;":"\u22f2","div;":"\u00f7","divide":"\u00f7","divide;":"\u00f7","divideontimes;":"\u22c7","divonx;":"\u22c7","djcy;":"\u0452","dlcorn;":"\u231e","dlcrop;":"\u230d","dollar;":"$","dopf;":"\ud835\udd55","dot;":"\u02d9","doteq;":"\u2250","doteqdot;":"\u2251","dotminus;":"\u2238","dotplus;":"\u2214","dotsquare;":"\u22a1","doublebarwedge;":"\u2306","downarrow;":"\u2193","downdownarrows;":"\u21ca","downharpoonleft;":"\u21c3","downharpoonright;":"\u21c2","drbkarow;":"\u2910","drcorn;":"\u231f","drcrop;":"\u230c","dscr;":"\ud835\udcb9","dscy;":"\u0455","dsol;":"\u29f6","dstrok;":"\u0111","dtdot;":"\u22f1","dtri;":"\u25bf","dtrif;":"\u25be","duarr;":"\u21f5","duhar;":"\u296f","dwangle;":"\u29a6","dzcy;":"\u045f","dzigrarr;":"\u27ff","eDDot;":"\u2a77","eDot;":"\u2251","eacute":"\u00e9","eacute;":"\u00e9","easter;":"\u2a6e","ecaron;":"\u011b","ecir;":"\u2256","ecirc":"\u00ea","ecirc;":"\u00ea","ecolon;":"\u2255","ecy;":"\u044d","edot;":"\u0117","ee;":"\u2147","efDot;":"\u2252","efr;":"\ud835\udd22","eg;":"\u2a9a","egrave":"\u00e8","egrave;":"\u00e8","egs;":"\u2a96","egsdot;":"\u2a98","el;":"\u2a99","elinters;":"\u23e7","ell;":"\u2113","els;":"\u2a95","elsdot;":"\u2a97","emacr;":"\u0113","empty;":"\u2205","emptyset;":"\u2205","emptyv;":"\u2205","emsp13;":"\u2004","emsp14;":"\u2005","emsp;":"\u2003","eng;":"\u014b","ensp;":"\u2002","eogon;":"\u0119","eopf;":"\ud835\udd56","epar;":"\u22d5","eparsl;":"\u29e3","eplus;":"\u2a71","epsi;":"\u03b5","epsilon;":"\u03b5","epsiv;":"\u03f5","eqcirc;":"\u2256","eqcolon;":"\u2255","eqsim;":"\u2242","eqslantgtr;":"\u2a96","eqslantless;":"\u2a95","equals;":"=","equest;":"\u225f","equiv;":"\u2261","equivDD;":"\u2a78","eqvparsl;":"\u29e5","erDot;":"\u2253","erarr;":"\u2971","escr;":"\u212f","esdot;":"\u2250","esim;":"\u2242","eta;":"\u03b7","eth":"\u00f0","eth;":"\u00f0","euml":"\u00eb","euml;":"\u00eb","euro;":"\u20ac","excl;":"!","exist;":"\u2203","expectation;":"\u2130","exponentiale;":"\u2147","fallingdotseq;":"\u2252","fcy;":"\u0444","female;":"\u2640","ffilig;":"\ufb03","fflig;":"\ufb00","ffllig;":"\ufb04","ffr;":"\ud835\udd23","filig;":"\ufb01","fjlig;":"fj","flat;":"\u266d","fllig;":"\ufb02","fltns;":"\u25b1","fnof;":"\u0192","fopf;":"\ud835\udd57","forall;":"\u2200","fork;":"\u22d4","forkv;":"\u2ad9","fpartint;":"\u2a0d","frac12":"\u00bd","frac12;":"\u00bd","frac13;":"\u2153","frac14":"\u00bc","frac14;":"\u00bc","frac15;":"\u2155","frac16;":"\u2159","frac18;":"\u215b","frac23;":"\u2154","frac25;":"\u2156","frac34":"\u00be","frac34;":"\u00be","frac35;":"\u2157","frac38;":"\u215c","frac45;":"\u2158","frac56;":"\u215a","frac58;":"\u215d","frac78;":"\u215e","frasl;":"\u2044","frown;":"\u2322","fscr;":"\ud835\udcbb","gE;":"\u2267","gEl;":"\u2a8c","gacute;":"\u01f5","gamma;":"\u03b3","gammad;":"\u03dd","gap;":"\u2a86","gbreve;":"\u011f","gcirc;":"\u011d","gcy;":"\u0433","gdot;":"\u0121","ge;":"\u2265","gel;":"\u22db","geq;":"\u2265","geqq;":"\u2267","geqslant;":"\u2a7e","ges;":"\u2a7e","gescc;":"\u2aa9","gesdot;":"\u2a80","gesdoto;":"\u2a82","gesdotol;":"\u2a84","gesl;":"\u22db\ufe00","gesles;":"\u2a94","gfr;":"\ud835\udd24","gg;":"\u226b","ggg;":"\u22d9","gimel;":"\u2137","gjcy;":"\u0453","gl;":"\u2277","glE;":"\u2a92","gla;":"\u2aa5","glj;":"\u2aa4","gnE;":"\u2269","gnap;":"\u2a8a","gnapprox;":"\u2a8a","gne;":"\u2a88","gneq;":"\u2a88","gneqq;":"\u2269","gnsim;":"\u22e7","gopf;":"\ud835\udd58","grave;":"`","gscr;":"\u210a","gsim;":"\u2273","gsime;":"\u2a8e","gsiml;":"\u2a90","gt":">","gt;":">","gtcc;":"\u2aa7","gtcir;":"\u2a7a","gtdot;":"\u22d7","gtlPar;":"\u2995","gtquest;":"\u2a7c","gtrapprox;":"\u2a86","gtrarr;":"\u2978","gtrdot;":"\u22d7","gtreqless;":"\u22db","gtreqqless;":"\u2a8c","gtrless;":"\u2277","gtrsim;":"\u2273","gvertneqq;":"\u2269\ufe00","gvnE;":"\u2269\ufe00","hArr;":"\u21d4","hairsp;":"\u200a","half;":"\u00bd","hamilt;":"\u210b","hardcy;":"\u044a","harr;":"\u2194","harrcir;":"\u2948","harrw;":"\u21ad","hbar;":"\u210f","hcirc;":"\u0125","hearts;":"\u2665","heartsuit;":"\u2665","hellip;":"\u2026","hercon;":"\u22b9","hfr;":"\ud835\udd25","hksearow;":"\u2925","hkswarow;":"\u2926","hoarr;":"\u21ff","homtht;":"\u223b","hookleftarrow;":"\u21a9","hookrightarrow;":"\u21aa","hopf;":"\ud835\udd59","horbar;":"\u2015","hscr;":"\ud835\udcbd","hslash;":"\u210f","hstrok;":"\u0127","hybull;":"\u2043","hyphen;":"\u2010","iacute":"\u00ed","iacute;":"\u00ed","ic;":"\u2063","icirc":"\u00ee","icirc;":"\u00ee","icy;":"\u0438","iecy;":"\u0435","iexcl":"\u00a1","iexcl;":"\u00a1","iff;":"\u21d4","ifr;":"\ud835\udd26","igrave":"\u00ec","igrave;":"\u00ec","ii;":"\u2148","iiiint;":"\u2a0c","iiint;":"\u222d","iinfin;":"\u29dc","iiota;":"\u2129","ijlig;":"\u0133","imacr;":"\u012b","image;":"\u2111","imagline;":"\u2110","imagpart;":"\u2111","imath;":"\u0131","imof;":"\u22b7","imped;":"\u01b5","in;":"\u2208","incare;":"\u2105","infin;":"\u221e","infintie;":"\u29dd","inodot;":"\u0131","int;":"\u222b","intcal;":"\u22ba","integers;":"\u2124","intercal;":"\u22ba","intlarhk;":"\u2a17","intprod;":"\u2a3c","iocy;":"\u0451","iogon;":"\u012f","iopf;":"\ud835\udd5a","iota;":"\u03b9","iprod;":"\u2a3c","iquest":"\u00bf","iquest;":"\u00bf","iscr;":"\ud835\udcbe","isin;":"\u2208","isinE;":"\u22f9","isindot;":"\u22f5","isins;":"\u22f4","isinsv;":"\u22f3","isinv;":"\u2208","it;":"\u2062","itilde;":"\u0129","iukcy;":"\u0456","iuml":"\u00ef","iuml;":"\u00ef","jcirc;":"\u0135","jcy;":"\u0439","jfr;":"\ud835\udd27","jmath;":"\u0237","jopf;":"\ud835\udd5b","jscr;":"\ud835\udcbf","jsercy;":"\u0458","jukcy;":"\u0454","kappa;":"\u03ba","kappav;":"\u03f0","kcedil;":"\u0137","kcy;":"\u043a","kfr;":"\ud835\udd28","kgreen;":"\u0138","khcy;":"\u0445","kjcy;":"\u045c","kopf;":"\ud835\udd5c","kscr;":"\ud835\udcc0","lAarr;":"\u21da","lArr;":"\u21d0","lAtail;":"\u291b","lBarr;":"\u290e","lE;":"\u2266","lEg;":"\u2a8b","lHar;":"\u2962","lacute;":"\u013a","laemptyv;":"\u29b4","lagran;":"\u2112","lambda;":"\u03bb","lang;":"\u27e8","langd;":"\u2991","langle;":"\u27e8","lap;":"\u2a85","laquo":"\u00ab","laquo;":"\u00ab","larr;":"\u2190","larrb;":"\u21e4","larrbfs;":"\u291f","larrfs;":"\u291d","larrhk;":"\u21a9","larrlp;":"\u21ab","larrpl;":"\u2939","larrsim;":"\u2973","larrtl;":"\u21a2","lat;":"\u2aab","latail;":"\u2919","late;":"\u2aad","lates;":"\u2aad\ufe00","lbarr;":"\u290c","lbbrk;":"\u2772","lbrace;":"{","lbrack;":"[","lbrke;":"\u298b","lbrksld;":"\u298f","lbrkslu;":"\u298d","lcaron;":"\u013e","lcedil;":"\u013c","lceil;":"\u2308","lcub;":"{","lcy;":"\u043b","ldca;":"\u2936","ldquo;":"\u201c","ldquor;":"\u201e","ldrdhar;":"\u2967","ldrushar;":"\u294b","ldsh;":"\u21b2","le;":"\u2264","leftarrow;":"\u2190","leftarrowtail;":"\u21a2","leftharpoondown;":"\u21bd","leftharpoonup;":"\u21bc","leftleftarrows;":"\u21c7","leftrightarrow;":"\u2194","leftrightarrows;":"\u21c6","leftrightharpoons;":"\u21cb","leftrightsquigarrow;":"\u21ad","leftthreetimes;":"\u22cb","leg;":"\u22da","leq;":"\u2264","leqq;":"\u2266","leqslant;":"\u2a7d","les;":"\u2a7d","lescc;":"\u2aa8","lesdot;":"\u2a7f","lesdoto;":"\u2a81","lesdotor;":"\u2a83","lesg;":"\u22da\ufe00","lesges;":"\u2a93","lessapprox;":"\u2a85","lessdot;":"\u22d6","lesseqgtr;":"\u22da","lesseqqgtr;":"\u2a8b","lessgtr;":"\u2276","lesssim;":"\u2272","lfisht;":"\u297c","lfloor;":"\u230a","lfr;":"\ud835\udd29","lg;":"\u2276","lgE;":"\u2a91","lhard;":"\u21bd","lharu;":"\u21bc","lharul;":"\u296a","lhblk;":"\u2584","ljcy;":"\u0459","ll;":"\u226a","llarr;":"\u21c7","llcorner;":"\u231e","llhard;":"\u296b","lltri;":"\u25fa","lmidot;":"\u0140","lmoust;":"\u23b0","lmoustache;":"\u23b0","lnE;":"\u2268","lnap;":"\u2a89","lnapprox;":"\u2a89","lne;":"\u2a87","lneq;":"\u2a87","lneqq;":"\u2268","lnsim;":"\u22e6","loang;":"\u27ec","loarr;":"\u21fd","lobrk;":"\u27e6","longleftarrow;":"\u27f5","longleftrightarrow;":"\u27f7","longmapsto;":"\u27fc","longrightarrow;":"\u27f6","looparrowleft;":"\u21ab","looparrowright;":"\u21ac","lopar;":"\u2985","lopf;":"\ud835\udd5d","loplus;":"\u2a2d","lotimes;":"\u2a34","lowast;":"\u2217","lowbar;":"_","loz;":"\u25ca","lozenge;":"\u25ca","lozf;":"\u29eb","lpar;":"(","lparlt;":"\u2993","lrarr;":"\u21c6","lrcorner;":"\u231f","lrhar;":"\u21cb","lrhard;":"\u296d","lrm;":"\u200e","lrtri;":"\u22bf","lsaquo;":"\u2039","lscr;":"\ud835\udcc1","lsh;":"\u21b0","lsim;":"\u2272","lsime;":"\u2a8d","lsimg;":"\u2a8f","lsqb;":"[","lsquo;":"\u2018","lsquor;":"\u201a","lstrok;":"\u0142","lt":"<","lt;":"<","ltcc;":"\u2aa6","ltcir;":"\u2a79","ltdot;":"\u22d6","lthree;":"\u22cb","ltimes;":"\u22c9","ltlarr;":"\u2976","ltquest;":"\u2a7b","ltrPar;":"\u2996","ltri;":"\u25c3","ltrie;":"\u22b4","ltrif;":"\u25c2","lurdshar;":"\u294a","luruhar;":"\u2966","lvertneqq;":"\u2268\ufe00","lvnE;":"\u2268\ufe00","mDDot;":"\u223a","macr":"\u00af","macr;":"\u00af","male;":"\u2642","malt;":"\u2720","maltese;":"\u2720","map;":"\u21a6","mapsto;":"\u21a6","mapstodown;":"\u21a7","mapstoleft;":"\u21a4","mapstoup;":"\u21a5","marker;":"\u25ae","mcomma;":"\u2a29","mcy;":"\u043c","mdash;":"\u2014","measuredangle;":"\u2221","mfr;":"\ud835\udd2a","mho;":"\u2127","micro":"\u00b5","micro;":"\u00b5","mid;":"\u2223","midast;":"*","midcir;":"\u2af0","middot":"\u00b7","middot;":"\u00b7","minus;":"\u2212","minusb;":"\u229f","minusd;":"\u2238","minusdu;":"\u2a2a","mlcp;":"\u2adb","mldr;":"\u2026","mnplus;":"\u2213","models;":"\u22a7","mopf;":"\ud835\udd5e","mp;":"\u2213","mscr;":"\ud835\udcc2","mstpos;":"\u223e","mu;":"\u03bc","multimap;":"\u22b8","mumap;":"\u22b8","nGg;":"\u22d9\u0338","nGt;":"\u226b\u20d2","nGtv;":"\u226b\u0338","nLeftarrow;":"\u21cd","nLeftrightarrow;":"\u21ce","nLl;":"\u22d8\u0338","nLt;":"\u226a\u20d2","nLtv;":"\u226a\u0338","nRightarrow;":"\u21cf","nVDash;":"\u22af","nVdash;":"\u22ae","nabla;":"\u2207","nacute;":"\u0144","nang;":"\u2220\u20d2","nap;":"\u2249","napE;":"\u2a70\u0338","napid;":"\u224b\u0338","napos;":"\u0149","napprox;":"\u2249","natur;":"\u266e","natural;":"\u266e","naturals;":"\u2115","nbsp":"\u00a0","nbsp;":"\u00a0","nbump;":"\u224e\u0338","nbumpe;":"\u224f\u0338","ncap;":"\u2a43","ncaron;":"\u0148","ncedil;":"\u0146","ncong;":"\u2247","ncongdot;":"\u2a6d\u0338","ncup;":"\u2a42","ncy;":"\u043d","ndash;":"\u2013","ne;":"\u2260","neArr;":"\u21d7","nearhk;":"\u2924","nearr;":"\u2197","nearrow;":"\u2197","nedot;":"\u2250\u0338","nequiv;":"\u2262","nesear;":"\u2928","nesim;":"\u2242\u0338","nexist;":"\u2204","nexists;":"\u2204","nfr;":"\ud835\udd2b","ngE;":"\u2267\u0338","nge;":"\u2271","ngeq;":"\u2271","ngeqq;":"\u2267\u0338","ngeqslant;":"\u2a7e\u0338","nges;":"\u2a7e\u0338","ngsim;":"\u2275","ngt;":"\u226f","ngtr;":"\u226f","nhArr;":"\u21ce","nharr;":"\u21ae","nhpar;":"\u2af2","ni;":"\u220b","nis;":"\u22fc","nisd;":"\u22fa","niv;":"\u220b","njcy;":"\u045a","nlArr;":"\u21cd","nlE;":"\u2266\u0338","nlarr;":"\u219a","nldr;":"\u2025","nle;":"\u2270","nleftarrow;":"\u219a","nleftrightarrow;":"\u21ae","nleq;":"\u2270","nleqq;":"\u2266\u0338","nleqslant;":"\u2a7d\u0338","nles;":"\u2a7d\u0338","nless;":"\u226e","nlsim;":"\u2274","nlt;":"\u226e","nltri;":"\u22ea","nltrie;":"\u22ec","nmid;":"\u2224","nopf;":"\ud835\udd5f","not":"\u00ac","not;":"\u00ac","notin;":"\u2209","notinE;":"\u22f9\u0338","notindot;":"\u22f5\u0338","notinva;":"\u2209","notinvb;":"\u22f7","notinvc;":"\u22f6","notni;":"\u220c","notniva;":"\u220c","notnivb;":"\u22fe","notnivc;":"\u22fd","npar;":"\u2226","nparallel;":"\u2226","nparsl;":"\u2afd\u20e5","npart;":"\u2202\u0338","npolint;":"\u2a14","npr;":"\u2280","nprcue;":"\u22e0","npre;":"\u2aaf\u0338","nprec;":"\u2280","npreceq;":"\u2aaf\u0338","nrArr;":"\u21cf","nrarr;":"\u219b","nrarrc;":"\u2933\u0338","nrarrw;":"\u219d\u0338","nrightarrow;":"\u219b","nrtri;":"\u22eb","nrtrie;":"\u22ed","nsc;":"\u2281","nsccue;":"\u22e1","nsce;":"\u2ab0\u0338","nscr;":"\ud835\udcc3","nshortmid;":"\u2224","nshortparallel;":"\u2226","nsim;":"\u2241","nsime;":"\u2244","nsimeq;":"\u2244","nsmid;":"\u2224","nspar;":"\u2226","nsqsube;":"\u22e2","nsqsupe;":"\u22e3","nsub;":"\u2284","nsubE;":"\u2ac5\u0338","nsube;":"\u2288","nsubset;":"\u2282\u20d2","nsubseteq;":"\u2288","nsubseteqq;":"\u2ac5\u0338","nsucc;":"\u2281","nsucceq;":"\u2ab0\u0338","nsup;":"\u2285","nsupE;":"\u2ac6\u0338","nsupe;":"\u2289","nsupset;":"\u2283\u20d2","nsupseteq;":"\u2289","nsupseteqq;":"\u2ac6\u0338","ntgl;":"\u2279","ntilde":"\u00f1","ntilde;":"\u00f1","ntlg;":"\u2278","ntriangleleft;":"\u22ea","ntrianglelefteq;":"\u22ec","ntriangleright;":"\u22eb","ntrianglerighteq;":"\u22ed","nu;":"\u03bd","num;":"#","numero;":"\u2116","numsp;":"\u2007","nvDash;":"\u22ad","nvHarr;":"\u2904","nvap;":"\u224d\u20d2","nvdash;":"\u22ac","nvge;":"\u2265\u20d2","nvgt;":">\u20d2","nvinfin;":"\u29de","nvlArr;":"\u2902","nvle;":"\u2264\u20d2","nvlt;":"<\u20d2","nvltrie;":"\u22b4\u20d2","nvrArr;":"\u2903","nvrtrie;":"\u22b5\u20d2","nvsim;":"\u223c\u20d2","nwArr;":"\u21d6","nwarhk;":"\u2923","nwarr;":"\u2196","nwarrow;":"\u2196","nwnear;":"\u2927","oS;":"\u24c8","oacute":"\u00f3","oacute;":"\u00f3","oast;":"\u229b","ocir;":"\u229a","ocirc":"\u00f4","ocirc;":"\u00f4","ocy;":"\u043e","odash;":"\u229d","odblac;":"\u0151","odiv;":"\u2a38","odot;":"\u2299","odsold;":"\u29bc","oelig;":"\u0153","ofcir;":"\u29bf","ofr;":"\ud835\udd2c","ogon;":"\u02db","ograve":"\u00f2","ograve;":"\u00f2","ogt;":"\u29c1","ohbar;":"\u29b5","ohm;":"\u03a9","oint;":"\u222e","olarr;":"\u21ba","olcir;":"\u29be","olcross;":"\u29bb","oline;":"\u203e","olt;":"\u29c0","omacr;":"\u014d","omega;":"\u03c9","omicron;":"\u03bf","omid;":"\u29b6","ominus;":"\u2296","oopf;":"\ud835\udd60","opar;":"\u29b7","operp;":"\u29b9","oplus;":"\u2295","or;":"\u2228","orarr;":"\u21bb","ord;":"\u2a5d","order;":"\u2134","orderof;":"\u2134","ordf":"\u00aa","ordf;":"\u00aa","ordm":"\u00ba","ordm;":"\u00ba","origof;":"\u22b6","oror;":"\u2a56","orslope;":"\u2a57","orv;":"\u2a5b","oscr;":"\u2134","oslash":"\u00f8","oslash;":"\u00f8","osol;":"\u2298","otilde":"\u00f5","otilde;":"\u00f5","otimes;":"\u2297","otimesas;":"\u2a36","ouml":"\u00f6","ouml;":"\u00f6","ovbar;":"\u233d","par;":"\u2225","para":"\u00b6","para;":"\u00b6","parallel;":"\u2225","parsim;":"\u2af3","parsl;":"\u2afd","part;":"\u2202","pcy;":"\u043f","percnt;":"%","period;":".","permil;":"\u2030","perp;":"\u22a5","pertenk;":"\u2031","pfr;":"\ud835\udd2d","phi;":"\u03c6","phiv;":"\u03d5","phmmat;":"\u2133","phone;":"\u260e","pi;":"\u03c0","pitchfork;":"\u22d4","piv;":"\u03d6","planck;":"\u210f","planckh;":"\u210e","plankv;":"\u210f","plus;":"+","plusacir;":"\u2a23","plusb;":"\u229e","pluscir;":"\u2a22","plusdo;":"\u2214","plusdu;":"\u2a25","pluse;":"\u2a72","plusmn":"\u00b1","plusmn;":"\u00b1","plussim;":"\u2a26","plustwo;":"\u2a27","pm;":"\u00b1","pointint;":"\u2a15","popf;":"\ud835\udd61","pound":"\u00a3","pound;":"\u00a3","pr;":"\u227a","prE;":"\u2ab3","prap;":"\u2ab7","prcue;":"\u227c","pre;":"\u2aaf","prec;":"\u227a","precapprox;":"\u2ab7","preccurlyeq;":"\u227c","preceq;":"\u2aaf","precnapprox;":"\u2ab9","precneqq;":"\u2ab5","precnsim;":"\u22e8","precsim;":"\u227e","prime;":"\u2032","primes;":"\u2119","prnE;":"\u2ab5","prnap;":"\u2ab9","prnsim;":"\u22e8","prod;":"\u220f","profalar;":"\u232e","profline;":"\u2312","profsurf;":"\u2313","prop;":"\u221d","propto;":"\u221d","prsim;":"\u227e","prurel;":"\u22b0","pscr;":"\ud835\udcc5","psi;":"\u03c8","puncsp;":"\u2008","qfr;":"\ud835\udd2e","qint;":"\u2a0c","qopf;":"\ud835\udd62","qprime;":"\u2057","qscr;":"\ud835\udcc6","quaternions;":"\u210d","quatint;":"\u2a16","quest;":"?","questeq;":"\u225f","quot":"\"","quot;":"\"","rAarr;":"\u21db","rArr;":"\u21d2","rAtail;":"\u291c","rBarr;":"\u290f","rHar;":"\u2964","race;":"\u223d\u0331","racute;":"\u0155","radic;":"\u221a","raemptyv;":"\u29b3","rang;":"\u27e9","rangd;":"\u2992","range;":"\u29a5","rangle;":"\u27e9","raquo":"\u00bb","raquo;":"\u00bb","rarr;":"\u2192","rarrap;":"\u2975","rarrb;":"\u21e5","rarrbfs;":"\u2920","rarrc;":"\u2933","rarrfs;":"\u291e","rarrhk;":"\u21aa","rarrlp;":"\u21ac","rarrpl;":"\u2945","rarrsim;":"\u2974","rarrtl;":"\u21a3","rarrw;":"\u219d","ratail;":"\u291a","ratio;":"\u2236","rationals;":"\u211a","rbarr;":"\u290d","rbbrk;":"\u2773","rbrace;":"}","rbrack;":"]","rbrke;":"\u298c","rbrksld;":"\u298e","rbrkslu;":"\u2990","rcaron;":"\u0159","rcedil;":"\u0157","rceil;":"\u2309","rcub;":"}","rcy;":"\u0440","rdca;":"\u2937","rdldhar;":"\u2969","rdquo;":"\u201d","rdquor;":"\u201d","rdsh;":"\u21b3","real;":"\u211c","realine;":"\u211b","realpart;":"\u211c","reals;":"\u211d","rect;":"\u25ad","reg":"\u00ae","reg;":"\u00ae","rfisht;":"\u297d","rfloor;":"\u230b","rfr;":"\ud835\udd2f","rhard;":"\u21c1","rharu;":"\u21c0","rharul;":"\u296c","rho;":"\u03c1","rhov;":"\u03f1","rightarrow;":"\u2192","rightarrowtail;":"\u21a3","rightharpoondown;":"\u21c1","rightharpoonup;":"\u21c0","rightleftarrows;":"\u21c4","rightleftharpoons;":"\u21cc","rightrightarrows;":"\u21c9","rightsquigarrow;":"\u219d","rightthreetimes;":"\u22cc","ring;":"\u02da","risingdotseq;":"\u2253","rlarr;":"\u21c4","rlhar;":"\u21cc","rlm;":"\u200f","rmoust;":"\u23b1","rmoustache;":"\u23b1","rnmid;":"\u2aee","roang;":"\u27ed","roarr;":"\u21fe","robrk;":"\u27e7","ropar;":"\u2986","ropf;":"\ud835\udd63","roplus;":"\u2a2e","rotimes;":"\u2a35","rpar;":")","rpargt;":"\u2994","rppolint;":"\u2a12","rrarr;":"\u21c9","rsaquo;":"\u203a","rscr;":"\ud835\udcc7","rsh;":"\u21b1","rsqb;":"]","rsquo;":"\u2019","rsquor;":"\u2019","rthree;":"\u22cc","rtimes;":"\u22ca","rtri;":"\u25b9","rtrie;":"\u22b5","rtrif;":"\u25b8","rtriltri;":"\u29ce","ruluhar;":"\u2968","rx;":"\u211e","sacute;":"\u015b","sbquo;":"\u201a","sc;":"\u227b","scE;":"\u2ab4","scap;":"\u2ab8","scaron;":"\u0161","sccue;":"\u227d","sce;":"\u2ab0","scedil;":"\u015f","scirc;":"\u015d","scnE;":"\u2ab6","scnap;":"\u2aba","scnsim;":"\u22e9","scpolint;":"\u2a13","scsim;":"\u227f","scy;":"\u0441","sdot;":"\u22c5","sdotb;":"\u22a1","sdote;":"\u2a66","seArr;":"\u21d8","searhk;":"\u2925","searr;":"\u2198","searrow;":"\u2198","sect":"\u00a7","sect;":"\u00a7","semi;":";","seswar;":"\u2929","setminus;":"\u2216","setmn;":"\u2216","sext;":"\u2736","sfr;":"\ud835\udd30","sfrown;":"\u2322","sharp;":"\u266f","shchcy;":"\u0449","shcy;":"\u0448","shortmid;":"\u2223","shortparallel;":"\u2225","shy":"\u00ad","shy;":"\u00ad","sigma;":"\u03c3","sigmaf;":"\u03c2","sigmav;":"\u03c2","sim;":"\u223c","simdot;":"\u2a6a","sime;":"\u2243","simeq;":"\u2243","simg;":"\u2a9e","simgE;":"\u2aa0","siml;":"\u2a9d","simlE;":"\u2a9f","simne;":"\u2246","simplus;":"\u2a24","simrarr;":"\u2972","slarr;":"\u2190","smallsetminus;":"\u2216","smashp;":"\u2a33","smeparsl;":"\u29e4","smid;":"\u2223","smile;":"\u2323","smt;":"\u2aaa","smte;":"\u2aac","smtes;":"\u2aac\ufe00","softcy;":"\u044c","sol;":"/","solb;":"\u29c4","solbar;":"\u233f","sopf;":"\ud835\udd64","spades;":"\u2660","spadesuit;":"\u2660","spar;":"\u2225","sqcap;":"\u2293","sqcaps;":"\u2293\ufe00","sqcup;":"\u2294","sqcups;":"\u2294\ufe00","sqsub;":"\u228f","sqsube;":"\u2291","sqsubset;":"\u228f","sqsubseteq;":"\u2291","sqsup;":"\u2290","sqsupe;":"\u2292","sqsupset;":"\u2290","sqsupseteq;":"\u2292","squ;":"\u25a1","square;":"\u25a1","squarf;":"\u25aa","squf;":"\u25aa","srarr;":"\u2192","sscr;":"\ud835\udcc8","ssetmn;":"\u2216","ssmile;":"\u2323","sstarf;":"\u22c6","star;":"\u2606","starf;":"\u2605","straightepsilon;":"\u03f5","straightphi;":"\u03d5","strns;":"\u00af","sub;":"\u2282","subE;":"\u2ac5","subdot;":"\u2abd","sube;":"\u2286","subedot;":"\u2ac3","submult;":"\u2ac1","subnE;":"\u2acb","subne;":"\u228a","subplus;":"\u2abf","subrarr;":"\u2979","subset;":"\u2282","subseteq;":"\u2286","subseteqq;":"\u2ac5","subsetneq;":"\u228a","subsetneqq;":"\u2acb","subsim;":"\u2ac7","subsub;":"\u2ad5","subsup;":"\u2ad3","succ;":"\u227b","succapprox;":"\u2ab8","succcurlyeq;":"\u227d","succeq;":"\u2ab0","succnapprox;":"\u2aba","succneqq;":"\u2ab6","succnsim;":"\u22e9","succsim;":"\u227f","sum;":"\u2211","sung;":"\u266a","sup1":"\u00b9","sup1;":"\u00b9","sup2":"\u00b2","sup2;":"\u00b2","sup3":"\u00b3","sup3;":"\u00b3","sup;":"\u2283","supE;":"\u2ac6","supdot;":"\u2abe","supdsub;":"\u2ad8","supe;":"\u2287","supedot;":"\u2ac4","suphsol;":"\u27c9","suphsub;":"\u2ad7","suplarr;":"\u297b","supmult;":"\u2ac2","supnE;":"\u2acc","supne;":"\u228b","supplus;":"\u2ac0","supset;":"\u2283","supseteq;":"\u2287","supseteqq;":"\u2ac6","supsetneq;":"\u228b","supsetneqq;":"\u2acc","supsim;":"\u2ac8","supsub;":"\u2ad4","supsup;":"\u2ad6","swArr;":"\u21d9","swarhk;":"\u2926","swarr;":"\u2199","swarrow;":"\u2199","swnwar;":"\u292a","szlig":"\u00df","szlig;":"\u00df","target;":"\u2316","tau;":"\u03c4","tbrk;":"\u23b4","tcaron;":"\u0165","tcedil;":"\u0163","tcy;":"\u0442","tdot;":"\u20db","telrec;":"\u2315","tfr;":"\ud835\udd31","there4;":"\u2234","therefore;":"\u2234","theta;":"\u03b8","thetasym;":"\u03d1","thetav;":"\u03d1","thickapprox;":"\u2248","thicksim;":"\u223c","thinsp;":"\u2009","thkap;":"\u2248","thksim;":"\u223c","thorn":"\u00fe","thorn;":"\u00fe","tilde;":"\u02dc","times":"\u00d7","times;":"\u00d7","timesb;":"\u22a0","timesbar;":"\u2a31","timesd;":"\u2a30","tint;":"\u222d","toea;":"\u2928","top;":"\u22a4","topbot;":"\u2336","topcir;":"\u2af1","topf;":"\ud835\udd65","topfork;":"\u2ada","tosa;":"\u2929","tprime;":"\u2034","trade;":"\u2122","triangle;":"\u25b5","triangledown;":"\u25bf","triangleleft;":"\u25c3","trianglelefteq;":"\u22b4","triangleq;":"\u225c","triangleright;":"\u25b9","trianglerighteq;":"\u22b5","tridot;":"\u25ec","trie;":"\u225c","triminus;":"\u2a3a","triplus;":"\u2a39","trisb;":"\u29cd","tritime;":"\u2a3b","trpezium;":"\u23e2","tscr;":"\ud835\udcc9","tscy;":"\u0446","tshcy;":"\u045b","tstrok;":"\u0167","twixt;":"\u226c","twoheadleftarrow;":"\u219e","twoheadrightarrow;":"\u21a0","uArr;":"\u21d1","uHar;":"\u2963","uacute":"\u00fa","uacute;":"\u00fa","uarr;":"\u2191","ubrcy;":"\u045e","ubreve;":"\u016d","ucirc":"\u00fb","ucirc;":"\u00fb","ucy;":"\u0443","udarr;":"\u21c5","udblac;":"\u0171","udhar;":"\u296e","ufisht;":"\u297e","ufr;":"\ud835\udd32","ugrave":"\u00f9","ugrave;":"\u00f9","uharl;":"\u21bf","uharr;":"\u21be","uhblk;":"\u2580","ulcorn;":"\u231c","ulcorner;":"\u231c","ulcrop;":"\u230f","ultri;":"\u25f8","umacr;":"\u016b","uml":"\u00a8","uml;":"\u00a8","uogon;":"\u0173","uopf;":"\ud835\udd66","uparrow;":"\u2191","updownarrow;":"\u2195","upharpoonleft;":"\u21bf","upharpoonright;":"\u21be","uplus;":"\u228e","upsi;":"\u03c5","upsih;":"\u03d2","upsilon;":"\u03c5","upuparrows;":"\u21c8","urcorn;":"\u231d","urcorner;":"\u231d","urcrop;":"\u230e","uring;":"\u016f","urtri;":"\u25f9","uscr;":"\ud835\udcca","utdot;":"\u22f0","utilde;":"\u0169","utri;":"\u25b5","utrif;":"\u25b4","uuarr;":"\u21c8","uuml":"\u00fc","uuml;":"\u00fc","uwangle;":"\u29a7","vArr;":"\u21d5","vBar;":"\u2ae8","vBarv;":"\u2ae9","vDash;":"\u22a8","vangrt;":"\u299c","varepsilon;":"\u03f5","varkappa;":"\u03f0","varnothing;":"\u2205","varphi;":"\u03d5","varpi;":"\u03d6","varpropto;":"\u221d","varr;":"\u2195","varrho;":"\u03f1","varsigma;":"\u03c2","varsubsetneq;":"\u228a\ufe00","varsubsetneqq;":"\u2acb\ufe00","varsupsetneq;":"\u228b\ufe00","varsupsetneqq;":"\u2acc\ufe00","vartheta;":"\u03d1","vartriangleleft;":"\u22b2","vartriangleright;":"\u22b3","vcy;":"\u0432","vdash;":"\u22a2","vee;":"\u2228","veebar;":"\u22bb","veeeq;":"\u225a","vellip;":"\u22ee","verbar;":"|","vert;":"|","vfr;":"\ud835\udd33","vltri;":"\u22b2","vnsub;":"\u2282\u20d2","vnsup;":"\u2283\u20d2","vopf;":"\ud835\udd67","vprop;":"\u221d","vrtri;":"\u22b3","vscr;":"\ud835\udccb","vsubnE;":"\u2acb\ufe00","vsubne;":"\u228a\ufe00","vsupnE;":"\u2acc\ufe00","vsupne;":"\u228b\ufe00","vzigzag;":"\u299a","wcirc;":"\u0175","wedbar;":"\u2a5f","wedge;":"\u2227","wedgeq;":"\u2259","weierp;":"\u2118","wfr;":"\ud835\udd34","wopf;":"\ud835\udd68","wp;":"\u2118","wr;":"\u2240","wreath;":"\u2240","wscr;":"\ud835\udccc","xcap;":"\u22c2","xcirc;":"\u25ef","xcup;":"\u22c3","xdtri;":"\u25bd","xfr;":"\ud835\udd35","xhArr;":"\u27fa","xharr;":"\u27f7","xi;":"\u03be","xlArr;":"\u27f8","xlarr;":"\u27f5","xmap;":"\u27fc","xnis;":"\u22fb","xodot;":"\u2a00","xopf;":"\ud835\udd69","xoplus;":"\u2a01","xotime;":"\u2a02","xrArr;":"\u27f9","xrarr;":"\u27f6","xscr;":"\ud835\udccd","xsqcup;":"\u2a06","xuplus;":"\u2a04","xutri;":"\u25b3","xvee;":"\u22c1","xwedge;":"\u22c0","yacute":"\u00fd","yacute;":"\u00fd","yacy;":"\u044f","ycirc;":"\u0177","ycy;":"\u044b","yen":"\u00a5","yen;":"\u00a5","yfr;":"\ud835\udd36","yicy;":"\u0457","yopf;":"\ud835\udd6a","yscr;":"\ud835\udcce","yucy;":"\u044e","yuml":"\u00ff","yuml;":"\u00ff","zacute;":"\u017a","zcaron;":"\u017e","zcy;":"\u0437","zdot;":"\u017c","zeetrf;":"\u2128","zeta;":"\u03b6","zfr;":"\ud835\udd37","zhcy;":"\u0436","zigrarr;":"\u21dd","zopf;":"\ud835\udd6b","zscr;":"\ud835\udccf","zwj;":"\u200d","zwnj;":"\u200c"});
 // END GENERATED HTML NAMED REFERENCES
 function vttEntities(value) {
  const windows1252 = {128:8364,130:8218,131:402,132:8222,133:8230,134:8224,135:8225,136:710,137:8240,138:352,139:8249,140:338,142:381,145:8216,146:8217,147:8220,148:8221,149:8226,150:8211,151:8212,152:732,153:8482,154:353,155:8250,156:339,158:382,159:376};
  // Decode exactly once, after tokenizing tags. Decoded '<v ...>' stays text.
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+);?|[a-z][a-z0-9]*;?)/gi,(match,key)=>{
   if (key[0] === '#') {
    const code = /^#x/i.test(key) ? Number.parseInt(key.slice(2),16) : Number.parseInt(key.slice(1),10);
    return !code || code>0x10ffff || code>=0xd800 && code<=0xdfff ? "\ufffd" : String.fromCodePoint(windows1252[code] || code);
   }
   // Longest known prefix. WebVTT annotations are not HTML attributes.
   for(let length=Math.min(key.length,32);length>0;length--){
    const name=key.slice(0,length);
    if(!Object.hasOwn(VTT_ENTITIES,name))continue;
    return VTT_ENTITIES[name]+key.slice(length);
   }
   return match;
  });
 }
	function vttPayload(value) {
		// Keep the existing one-speaker cue model. Mixed/partly unvoiced cues retain
		// labels in readable text instead of inventing a speaker or sub-cue times.
		// Voice classes, annotations and nesting follow WebVTT §§4.2.2 and 6.4.
		const stack = [{tag:"", speaker:null}], runs = [];
		const append = raw => {
			const text = vttEntities(raw);
			const speaker = stack[stack.length-1].speaker;
			if (runs.length && runs[runs.length-1].speaker === speaker) runs[runs.length-1].text += text;
			else runs.push({speaker,text});
		};
		const tags = /<\/?(?:b|i|u|ruby|rt|v|c|lang|X-word-ms)(?:[.][^\t\n\f\r >]*)?(?:[\t\n\f\r ][^>]*)?>|<\d{2,}:\d{2}(?::\d{2})?\.\d{3}>/gi;
		let position = 0;
		for (const match of value.matchAll(tags)) {
			append(value.slice(position,match.index)); position = match.index + match[0].length;
			const tag = match[0].match(/^<(\/?)([a-z-]+)(?:[.][^\t\n\f\r >]*)?(?:[\t\n\f\r ]([^>]*))?>$/i);
			if (!tag) continue; // Inline timestamps and legacy word timing wrappers.
			const name = tag[2].toLowerCase();
			if (name === "x-word-ms") continue;
			if (tag[1]) {
				if (name === "ruby" && stack[stack.length-1].tag === "rt") stack.pop();
				if (stack[stack.length-1].tag === name) stack.pop();
			} else if (name !== "rt" || stack[stack.length-1].tag === "ruby") {
				const speaker = name === "v" ? vttEntities(tag[3] || "").replace(/[\t\n\f\r ]+/g," ").replace(/^ | $/g,"") || null : stack[stack.length-1].speaker;
				stack.push({tag:name,speaker});
			}
		}
		append(value.slice(position));
		const spoken = runs.filter(run=>run.text.trim());
		const voices = new Set(spoken.map(run=>run.speaker));
		const speaker = voices.size === 1 ? spoken[0]?.speaker || null : null;
		const text = voices.size > 1 ? spoken.map(run=>(run.speaker ? "["+run.speaker+"] " : "")+run.text.trim()).join("\n") : runs.map(run=>run.text).join("").trim();
		return {text,speaker};
	}
	function parse(text, filename) {
		if (filename.toLowerCase().endsWith(".json"))
			return validate(JSON.parse(text));
		const isVtt = filename.toLowerCase().endsWith(".vtt") || /^(?:\uFEFF)?WEBVTT(?:[ \t]|\r?\n|$)/.test(text);
		const blocks = text
			.replace(/^\uFEFF/, "")
			.replace(/\r\n?/g, "\n")
			.split(/\n\s*\n/);
		const segments = [];
		for (const block of blocks) {
			const lines = block.split("\n");
			if (isVtt && /^(?:WEBVTT|NOTE|STYLE|REGION)(?:[ \t]|$)/.test(lines[0].trim())) continue;
			const index = lines.findIndex((line) => line.includes("-->"));
			if (index < 0) continue;
			const match = lines[index].match(/^(\S+)\s+-->\s+(\S+)/);
			if (!match) throw new Error("无法识别字幕时间");
			const payload = lines.slice(index + 1).join("\n");
			const {text:body, speaker} = isVtt ? vttPayload(payload) : {text:subtitleText(payload).trim(), speaker:null};
			if (body)
				segments.push({
					id: "segment-" + (segments.length + 1),
					start: seconds(match[1]),
					end: seconds(match[2]),
					text: body,
					speaker,
				});
		}
		return validate({
			title: filename.replace(/\.(srt|vtt)$/i, ""),
			source_url: "",
			segments,
		});
	}
	const api = { localMediaSource, searchDocument, invalidateSearch, manualReviewSnapshot, manualReviewCurrent, saveManualTranslation, translationReviewQueue, hasNoteContent, segmentNoteCount, BACKUP_REVIEW_BYTES, SUBTITLE_IMPORT_BYTES, vttPayload, libraryHits, librarySnippet, hasProjectAnnotations, projectAnnotationCount, attachProjectTranscript, libraryMatches, documentDuration, sortedLibrary, AUDIO_NOTE_BUDGET, audioNoteCharacters, isAudioProject, audioProjectIdentity, podcastMediaIdentity, SUMMARY_QUESTION, summaryReadiness, podcastURL, podcastSource, cleanGlossary, relevantGlossary, translationQualityMessage, retainAnswers, summaryFreshness, latestSummary, summaryMarkdown, aiReadingMarkdown, parseReadingTime, createPlaybackIndex, segmentAtTime, subtitleExport, mergeLibraryBackup, time, source, media, validate, parse, matchesSegment, notebookSegments, notebookMarkdown, translationCurrent, sameCueSnapshot, subscriptionPlan, cleanContexts, answerFreshness };
	if (typeof module !== "undefined" && module.exports) module.exports = api;
	else root.Coconut = api;
})(typeof window !== "undefined" ? window : globalThis);
