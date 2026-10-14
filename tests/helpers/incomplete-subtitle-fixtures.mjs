/** Authored damaged subtitles only. No source or missing end time is invented. */
export const incompleteSubtitleFixtures=['srt','vtt'].map(format=>{
 const clock=value=>format==='srt'?`00:00:0${value},000`:`00:0${value}.000`;
 const blocks=[
  `1\n${clock(0)} --> ${clock(1)}\nOpening authored sentence.`,
  `2\n${clock(1)}\nOmitted <img src=x> detail without an end time.`,
  `3\n${clock(3)} --> ${clock(4)}\nClosing authored sentence.`,
  `4\n${clock(4)} → 00:0`,
 ];
 const header=format==='vtt'?'WEBVTT\r\n\r\n':'';
 return {format,name:`Incomplete.${format}`,title:'Incomplete',text:'\uFEFF'+header+blocks.join('\n\n').replace(/\n/g,'\r\n'),
  ranges:format==='vtt'?[[7,9],[15,16]]:[[5,7],[13,14]],
  cues:['Opening authored sentence.','Closing authored sentence.']};
});
