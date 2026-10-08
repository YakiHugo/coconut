/** Original authored subtitle fixtures; no third-party captions or private data. */
export const expectedCues = [
 {id:'segment-1',start:1.125,end:3.875,text:'Café by the harbor — 你好。\nWe kept one quiet detail & a question.'},
 {id:'segment-2',start:65.01,end:68.456,text:'Is 2 < 3? Keep <code> as written. 🌿'},
 {id:'segment-3',start:3601.002,end:3604.999,text:'最后一段：再见，港口。'},
];
export const subtitleFixtures = ['srt','vtt'].map(format=>{
 const blocks = format==='srt' ? [
  '17\n00:00:01,125 --> 00:00:03,875\n<b>Café by the harbor — 你好。</b>\nWe kept one quiet detail &amp; a question.',
  '42\n00:01:05,010 --> 00:01:08,456\nIs 2 &lt; 3? Keep <code> as written. &#x1F33F;',
  '103\n01:00:01,002 --> 01:00:04,999\n最后一段：再见，港口。',
 ] : [
  'WEBVTT Authored harbor notebook\nKind: captions\nLanguage: en',
  'NOTE original fixture metadata\nThis metadata is not a spoken cue.',
  'STYLE\n::cue { color: lime; }',
  'REGION\nid:harbor\nwidth:80%',
  'harbor-opening\n00:01.125 --> 00:03.875 align:start position:10%\n<v Narrator><b>Café by the harbor — 你好。</b></v>\nWe kept one quiet detail &amp; a question.',
  'harbor-question\n01:05.010 --> 01:08.456 line:80%\nIs 2 &lt; 3? Keep <code> as written. &#x1F33F;',
  'harbor-closing\n01:00:01.002 --> 01:00:04.999\n最后一段：再见，港口。',
 ];
 return {format,name:`Authored harbor ${format.toUpperCase()}.${format}`,
  title:`Authored harbor ${format.toUpperCase()}`,mimeType:format==='vtt'?'text/vtt':'application/x-subrip',
  text:'\uFEFF'+(blocks.join('\n\n')+'\n').replace(/\n/g,'\r\n'),
  invalid:`${format==='vtt'?'WEBVTT\n\n':''}broken-cue\n00:00:09.000 --> 00:00:01.000\nThis reversed interval must fail.\n`};
});
export const note='My authored note: 保留这段想法 🌱';
export const correction='Corrected authored question: 2 < 3 & the harbor stays quiet. 🌿';
export const cueSnapshot=doc=>doc.segments.map(({id,start,end,text})=>({id,start,end,text}));
