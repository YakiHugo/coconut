'use strict';
const {sourceSignature}=require('./transcript-resources.js');
/** Accept only clocks for the exact source; no automatic textual quality claim. */
function mergeAlignmentCandidate(current,input,candidate,report,assetSha256){
 if(sourceSignature(current)!==sourceSignature(input))throw Error('原稿已变化，旧对齐候选未应用');
 if(!Array.isArray(candidate?.segments)||candidate.segments.length!==input.segments.length)throw Error('对齐片段不完整');
 const segments=current.segments.map((cue,i)=>{
  const before=input.segments[i],after=candidate.segments[i];
  if(!after||['id','start','end','text'].some(k=>after[k]!==before[k]))throw Error('对齐结果改变原文或原始时间');
  if(!Array.isArray(after.words)||!after.words.length||
     Array.isArray(report?.cues)&&report.cues[i]?.status!=='aligned')return cue;
  let previous=cue.start;
  for(const word of after.words){
   if(typeof word.word!=='string'||!word.word.trim()||!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<cue.start||word.end>cue.end||word.end<=word.start||word.start<previous)throw Error('候选逐词时间无效');
   previous=word.end;
  }
  if(after.words.map(word=>word.word).join('')!==cue.text)throw Error('候选逐词时间与原文不符');
  return {...cue,words:after.words.map(word=>({...word})),timing_basis:'word',alignment_status:'complete',...(assetSha256?{alignment_media_sha256:assetSha256}:{})};
 });
 return {...current,segments,source_alignment:{source_snapshot:input,report},provenance:{...current.provenance,alignment_required:report?.status!=='candidate',source_text_quality:'unverified'}};
}
module.exports={mergeAlignmentCandidate};
