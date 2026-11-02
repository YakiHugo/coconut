/** Source ownership excludes mutable transcript text, notes, title and AI output. */
function sourceMediaIdentity(document){
 const fields=['source_url','podcast_source','media_provenance','local_media_source'];
 function sorted(value){if(Array.isArray(value))return value.map(sorted);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])]));return value;}
 return JSON.stringify(Object.fromEntries(fields.map(key=>{let value=document?.[key]??null;if(key==='podcast_source'&&value&&typeof value==='object'){value={...value};delete value.transcript_url;}return [key,sorted(value)];})));
}
module.exports={sourceMediaIdentity};
