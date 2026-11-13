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
 return Coconut.transcriptionContext({...value,description:publisherText(value.description)});
}
