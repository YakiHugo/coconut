/** Original authored text only; no source, provider or model calls. */
export function textExportFixture(){
 const segments=[
  {id:'a',start:1.125,end:2,text:'Corrected <b>🌴</b> & e\u0301',original_text:'OLD CORRECTION SECRET',speaker:'Alice',translations:{zh:{text:'人工修正 <译文>。',source_text:'Corrected <b>🌴</b> & e\u0301',provider:'user'}}},
  {id:'b',start:2,end:3,text:' continues.\nSecond line.',speaker:'Alice',translations:{zh:{text:'STALE TRANSLATION SECRET',source_text:'obsolete',provider:'user'}}},
  {id:'c',start:3,end:4,text:'中文。',speaker:'Alice'},
  ...Array.from({length:102},(_,i)=>({id:'tail-'+i,start:10+i*5,end:11+i*5,text:'Unannotated full source '+i+'.',speaker:i%2?'Bob':'Alice'}))
 ];
 return {key:'text-export',title:'Authored / reading',language:'en',translation_view:'zh',source_url:'https://www.youtube.com/watch?v=authored1234',segments,notes:{a:'PRIVATE NOTE SECRET'},project_note:'PRIVATE PROJECT SECRET',media_timing:{version:1,identity:'file-candidate-v1:authored',offset:2}};
}
export const originalParagraph='Corrected <b>🌴</b> & e\u0301 continues.\nSecond line. 中文。';
export const originalText=['Authored / reading','来源：https://www.youtube.com/watch?v=authored1234','','说话人：Alice',originalParagraph,'',...Array.from({length:102},(_,i)=>'说话人：'+(i%2?'Bob':'Alice')+'\nUnannotated full source '+i+'.').join('\n\n').split('\n')].join('\n')+'\n';
