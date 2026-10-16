/** Entirely authored source text; never contacts a publisher or model. */
export function notebookSources(core){
 const long={key:'notebook-long',...core.validate({title:'Notebook authored long source',language:'en',segments:Array.from({length:90},(_,i)=>({id:'cue-'+i,start:i,end:i+1,text:'Authored notebook source '+i+'.'})),notes:{'cue-80':'Needle cue note'},readingPosition:'cue-3'})};
 const excerpts=['current','stale','missing','reordered'].map(kind=>{
  const doc={...structuredClone(long),key:'notebook-'+kind,title:'Notebook '+kind,notes:{}};
  const cues=doc.segments.slice(80,82),record=core.exactExcerptSnapshot(doc,cues,[' '],2,cues[0].text.length+5,{id:'excerpt-'+kind,createdAt:'2026-10-16T00:00:00.000Z'});
  doc.exact_excerpts=[record];doc.exact_excerpt_notes={[record.id]:'Needle '+kind+' excerpt'};
  if(kind==='stale')doc.segments[80].text='Corrected current original';
  if(kind==='missing')doc.segments.splice(80,1);
  if(kind==='reordered'){const first=doc.segments[80],second=doc.segments[81];doc.segments[80]={...second,start:80,end:81};doc.segments[81]={...first,start:81,end:82};}
  return doc;
 });
 const audio={key:'notebook-audio',...core.validate({project_kind:'audio_only',title:'Notebook authored audio',segments:[],podcast_source:{kind:'direct_media',media_url:'https://publisher.example/authored.wav',media_kind:'audio'},project_note:'Needle project note',timestamp_bookmarks:[{id:'bookmark-75',time:75,note:'Needle bookmark'}]})};
 return {long,excerpts,audio,documents:[long,...excerpts,audio]};
}
