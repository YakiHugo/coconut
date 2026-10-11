/** Authored display-only chapters. No recording, model, account or user data. */
export const CHAPTER_MARKER_SEARCH = 'findme';
export const CHAPTER_MARKER_LONG_TITLE = 'ChapterOnlyNeedle · '+ '完整保留的手动章节标题需要自然换行而不能截断'.repeat(6);
export const chapterMarkerCueId = index => index === 16 ? '' : 'c'+index;
export function chapterMarkersFixture(label = 'desktop') {
 const matches = new Set([0,1,2,3,5,6,17,18,96,99,100,101,102,110,169,170,171,200]);
 const segments = Array.from({length:256}, (_,index) => {
  const text = 'Source c'+index+(matches.has(index)?' findme':'')+' stays whole.';
  // c0–c7 remain one natural paragraph, with equal-time c2 and c5 anchors.
  // Every cue uses the SAME speaker: chapter titles cannot cause grouping.
  const start=index<8?0:index*.5;
  return {id:chapterMarkerCueId(index),start,end:start+.4,text,speaker:'Authored narrator',
   ...(index%4===1?{saved_excerpt:true}:{}),
   translations:{zh:{text:'自写对照文字 '+index+'。',source_text:text,source_language:'en',document_language:'en',provider:'Authored fixture; no model'}}};
 });
 return {schema_version:1,key:'authored-chapter-markers-'+label,title:'手动章节阅读路标 · authored '+label,
  language:'en',translation_view:'zh',readingPosition:'c0',notes:{c19:'Authored private note; never part of a quotation.'},segments,
  // Deliberately NOT source order. A missing anchor shares time zero with the
  // real first paragraph, but may never be guessed onto one of those cues.
  reading_chapters:[
   {id:'late',cue_id:'c170',time:85,title:'后半章 · 独立的阅读位置',note:''},
   {id:'missing',cue_id:'removed-cue',time:0,title:'MissingAnchorMustNeverBecomeALandmark',note:''},
   {id:'second',cue_id:'c5',time:0,title:CHAPTER_MARKER_LONG_TITLE,note:''},
   {id:'empty',cue_id:'',time:8,title:'空字符串锚点也有明确身份',note:''},
   {id:'first',cue_id:'c2',time:0,title:'第一章 · 同段中的准确起点',note:''},
   {id:'middle',cue_id:'c90',time:45,title:'中间章 · 跨页继续阅读',note:''},
  ]};
}
