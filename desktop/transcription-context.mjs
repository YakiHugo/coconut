/** Bounded publisher text, kept separate from transcript and audio ownership. */
import Coconut from '../reader/core.js';
import {decodeEntities} from './podcast-xml.mjs';

export function publisherText(value){
 if(typeof value!=='string')return '';
 let text=value.slice(0,100000)
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'')
  .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi,'\n')
  .replace(/<[^>]*>/g,'');
 try{text=decodeEntities(text.replace(/&nbsp;/gi,' '));}catch{/* Keep unsupported entities as literal publisher text. */}
 return text.replace(/\r\n?/g,'\n').split('\n').map(line=>line.replace(/[ \t]+/g,' ').trim()).filter(Boolean).join('\n').slice(0,6000);
}

export function publisherContext(value){
 if(!value||typeof value!=='object')return undefined;
 const description=publisherText(value.description);
 const explicit=Coconut.publisherChapters(value.chapters);
 const notes=description.split('\n').flatMap(line=>{
  const match=line.match(/^\[?(\d{1,3}:\d{2}(?::\d{2})?)\]?[ \t–—:：-]+(.{2,200})$/u);
  if(!match)return [];
  const parts=match[1].split(':').map(Number);
  if(parts.slice(1).some(part=>part>=60))return [];
  return [{start:parts.reduce((total,part)=>60*total+part,0),title:match[2]}];
 });
 const anchors=Coconut.publisherChapters(notes);
 return Coconut.transcriptionContext({...value,description,chapters:explicit.length?explicit:anchors.length>=2?anchors:[]});
}
