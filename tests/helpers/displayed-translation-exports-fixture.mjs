/** Original authored prose only; deterministic multilingual export evidence. */
import C from '../../reader/core.js';
export function displayedTranslationExportsFixture({key='displayed-exports',title='Authored displayed exports',language='',count=112}={}){
 const raw={key,title,language:'en',translation_view:language,notes:{'cue-0':'Authored private note','cue-2':'Check source','cue-3':'Check context',['cue-'+(count-1)]:'Final saved note'},segments:Array.from({length:count},(_,i)=>{
  const text='Authored source '+i+' <literal> & words.';
  const translation=(text,fields={})=>({text,source_text:'Authored source '+i+' <literal> & words.',source_language:'en',document_language:'en',provider:'user',...fields});
  return {id:'cue-'+i,start:i*5+0.125,end:i*5+2.875,speaker:i%2?'Reader B':'Reader A',text,translations:{
   ...(i===1?{}:{zh:translation(i===2?'STALE SOURCE SECRET':i===3?'STALE CONTEXT SECRET':'中文译文 '+i, i===2?{source_text:'Earlier source'}:{})}),fr:translation('Traduction française '+i)
  }};
 })};
 const context='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',snapshot=i=>({id:raw.segments[i].id,position:i,text:raw.segments[i].text,start:raw.segments[i].start,end:raw.segments[i].end,speaker:raw.segments[i].speaker});
 if(count>4){raw.translation_contexts={[context]:[{...snapshot(4),text:'Earlier neighboring context'},snapshot(3)]};raw.segments[3].translations.zh.context_id=context;}
 return {...C.validate(raw),key};
}
