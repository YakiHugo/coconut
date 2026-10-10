// Authored local-only backup data. Never invokes AI or opens source media.
export const MiB=1024*1024;
export function annotatedDocument(title='Annotated backup') {
 const context='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 const cue={id:'cue',start:0,end:4,text:'Authored source words',speaker:'Author'};
 return {title,language:'en',source_url:'',readingPosition:'cue',notes:{cue:'Keep this private note'},
  segments:[{...cue,original_text:'Authored original words',saved_excerpt:true,translations:{zh:{text:'自写测试译文',source_text:cue.text,source_language:'en',document_language:'en',provider:'fixture',context_id:context}}}],
  translation_view:'zh',translation_contexts:{[context]:[{...cue,position:0}]},translation_glossary:{zh:[{source:'Authored',target:'自写'}]},
  ai_answers:[{question:'Authored question',answer:'Authored answer',citations:['cue'],provider:'fixture',input_snapshot:{version:1,segments:[{id:cue.id,text:cue.text}]}}]};
}
export function chineseDocument(){
 const doc=annotatedDocument('600万汉字完整备份');
 doc.segments.push(...Array.from({length:6000},(_,i)=>({id:'large-'+i,start:i+4,end:i+5,text:'汉'.repeat(1000)})));
 return doc;
}
export function oversizedDocument(){
 const doc=annotatedDocument('含大笔记的完整备份');
 // Notes have no source-subtitle budget. This is >50 MiB of actual UTF-8 data.
 doc.notes.cue='完整笔记'.repeat(4400000);
 return doc;
}
