'use strict';
// Pure resource planning and conservative merge; no fetching, models or storage.
const CUE_FIELDS=['id','start','end','text','speaker','original_text','original_speaker','speaker_id','speaker_status'];
const PROVENANCE_FIELDS=['kind','language','caption_method','caption_track','media_id','source_platform','punctuation_method','punctuation_backend','punctuation_model','punctuation_status','speaker_method','speaker_backend','speaker_model','speaker_status'];
const RESULT_FIELDS=PROVENANCE_FIELDS.filter(key=>key.startsWith('punctuation_')||key.startsWith('speaker_'));
const select=(value,fields)=>Object.fromEntries(fields.filter(key=>Object.hasOwn(value||{},key)).map(key=>[key,value[key]]));
function processingSnapshot(doc){
 const result={schema_version:1,key:doc.key,title:doc.title||'',language:doc.language||'',source_url:doc.source_url||'',provenance:select(doc.provenance,PROVENANCE_FIELDS),segments:doc.segments.map(cue=>({...select(cue,CUE_FIELDS),speaker:cue.speaker??null}))};
 const duration=doc.media_duration||doc.provenance?.media_duration;
 if(Number.isFinite(duration)&&duration>0)result.media_duration=duration;
 return result;
}
function sourceSignature(doc){
 const snapshot=processingSnapshot(doc);
 // Personal notes, titles and translation edits may continue while models run.
 return JSON.stringify({key:snapshot.key,language:snapshot.language,source_url:snapshot.source_url,media_duration:snapshot.media_duration??null,provenance:snapshot.provenance,segments:snapshot.segments});
}
function inspectResources(doc,{audio=false,punctuation=false,speakers=false}={}){
 const cues=doc.segments||[],count=cues.length,provenance=doc.provenance||{};
 const labelled=cues.filter(cue=>typeof cue.speaker==='string'&&cue.speaker.trim()).length;
 const punctuated=cues.filter(cue=>/[。！？.!?][\s"'”’）)\]】」』]*$/u.test(cue.text)).length;
 const supplied=['publisher_transcript','platform_subtitles','authored_demo'].includes(provenance.kind);
 const punctuationDone=!!provenance.punctuation_method||supplied||count>0&&punctuated/count>=.4;
 const speakersDone=labelled===count&&count>0||provenance.speaker_method==='recording-acoustic-v1';
 const rows=[
  {kind:'transcript',state:count?'complete':'missing',message:count?`已有 ${count} 个带时间的片段`:'尚无带时间文字稿，需生成或导入文字稿'},
  {kind:'punctuation',state:!count?'waiting_transcript':punctuationDone?'complete':punctuation?'ready':'missing_model',message:!count?'取得文字稿后整理':punctuationDone?'保留已有标点与原稿':punctuation?'可用本地模型补标点':'标点模型未配置，保留原文'},
  {kind:'speakers',state:!count?'waiting_transcript':speakersDone?(labelled<count?'needs_review':'complete'):!audio?'waiting_audio':!speakers?'missing_model':'ready',message:!count?'取得文字稿后分组':speakersDone?(labelled<count?`${labelled}/${count} 个片段已有标签，其余归属不确定，需回听核对`:'已有说话人标签；自动标签仍需回听核对'):!audio?'待取得对应原声后分组':!speakers?'声纹模型未配置，保留未标注':`可按声音分组，保留已有 ${labelled} 个标签`},
  {kind:'chapters',state:Array.isArray(doc.reading_chapters)&&doc.reading_chapters.length?'complete':'not_provided',message:Array.isArray(doc.reading_chapters)&&doc.reading_chapters.length?'保留已有章节与时间定位':'来源未提供章节，可在阅读记录中添加'}
 ];
 return {rows,steps:rows.filter(row=>row.state==='ready').map(row=>row.kind),asr:count===0,requiresAudio:count>0&&!speakersDone&&!audio};
}
function wordingPreserved(source,output){
 const a=[...source].filter(char=>!/\s/u.test(char)),b=[...output].filter(char=>!/\s/u.test(char));let index=0;
 for(const char of b){if(char===a[index])index++;else if(!'，。？！、；：,.?!;:'.includes(char)||index===0)return false;}
 return index===a.length;
}
function mergeProcessingResult(current,input,result){
 if(sourceSignature(current)!==sourceSignature(input))throw Error('原文、时间或说话人已变化，整理结果未覆盖当前稿。');
 if(!Array.isArray(result?.segments)||result.segments.length!==input.segments.length)throw Error('整理结果的片段不完整。');
 const segments=current.segments.map((cue,index)=>{
  const before=input.segments[index],after=result.segments[index];
  if(!after||['id','start','end'].some(key=>after[key]!==before[key])||typeof after.text!=='string'||!wordingPreserved(before.text,after.text))throw Error('整理结果改变了原文内容或时间，未接收。');
  if(before.speaker&&after.speaker!==before.speaker)throw Error('整理结果改变了已有说话人标签。');
  if(before.original_text!==undefined&&after.original_text!==before.original_text)throw Error('整理结果改变了原始文字记录。');
  const next={...cue};
  for(const field of CUE_FIELDS.slice(3))if(Object.hasOwn(after,field))next[field]=after[field];
  if(after.text!==before.text&&!Object.hasOwn(next,'original_text'))next.original_text=before.text;
  return next;
 });
 const provenance={...current.provenance,...select(result.provenance,RESULT_FIELDS)};
 return {...current,segments,provenance};
}
module.exports={processingSnapshot,sourceSignature,inspectResources,mergeProcessingResult};
