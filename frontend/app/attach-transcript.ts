import type {Document} from './contracts';
/** Known semantic replacement plus deep opaque preservation, never a raw spread. */
export function attachTranscript(project:Document,transcript:unknown,core:{validate:(value:unknown)=>Record<string,unknown>;attachProjectTranscript:(project:unknown,transcript:unknown)=>Record<string,unknown>},projectFields:(raw:unknown,normalized:unknown)=>Document):Document{
 // Audio-only validation resets transcript-owned containers. Canonical storage
 // may nevertheless retain opaque records inside them. They cannot be copied
 // onto new cue IDs (even matching IDs), nor silently dropped during attachment.
 for(const key of ['notes','translation_glossary','translation_contexts','ai_answers']){
  const value=project[key];
  if(value!==undefined&&!(value&&typeof value==='object'&&Object.keys(value).length===0))throw Error('原声项目保留了旧原文相关记录，无法安全关联到新片段。未修改原项目；请导出完整备份，或将此文字稿另建独立副本。');
 }
 const normalized=core.attachProjectTranscript(project,transcript),known=core.validate(project),raw=structuredClone(transcript) as Record<string,unknown>;
 for(const [key,value]of Object.entries(project)){if(key==='key'||Object.hasOwn(known,key))continue;if(Object.hasOwn(raw,key)&&JSON.stringify(raw[key])!==JSON.stringify(value))throw Error('原项目与文字稿的扩展字段冲突，未覆盖任何数据。请分别导出备份后核对。');raw[key]=structuredClone(value);}
 for(const key of ['local_media_source','podcast_source','project_note','timestamp_bookmarks','media_duration','title','source_url','project_language_override'])if(Object.hasOwn(project,key))raw[key]=structuredClone(project[key]);
 for(const key of ['project_kind','transcript_status','source_media','local_media_source','podcast_source','local_job_binding'])if(!Object.hasOwn(normalized,key))delete raw[key];
 return projectFields(raw,{...normalized,key:project.key});
}
