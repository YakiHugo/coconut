import {Converter} from 'opencc-js';
export function resolveChineseScript(preference:string,languages:readonly string[]=[]):'source'|'zh-Hans'|'zh-Hant'{
 if(preference==='zh-Hans'||preference==='zh-Hant'||preference==='source')return preference;
 for(const language of languages){if(!/^zh(?:-|$)/i.test(language))continue;return /(?:hant|tw|hk|mo)(?:-|$)/i.test(language)?'zh-Hant':'zh-Hans';}
 return 'source';
}
const converters=new Map<string,(text:string)=>string>();
const sourceText=(text:string)=>text;
export function scriptConverter(preference:string,languages:readonly string[]=[]):(text:string)=>string{
 const script=resolveChineseScript(preference,languages);
 if(script==='source')return sourceText;
 if(!converters.has(script)){
  const convert=Converter(script==='zh-Hans'?{from:'t',to:'cn'}:{from:'cn',to:'t'});
  converters.set(script,text=>{
   const converted=convert(text);
   if(converted===text)return text;
   const original=Array.from(text),display=Array.from(converted);
   // Source selections and word timings use UTF-16 offsets. Keep each source
   // character's width, including rare mappings between BMP and astral Hanzi.
   if(original.length!==display.length)return text;
   return display.map((character,index)=>character.length===original[index].length?character:original[index]).join('');
  });
 }
 return converters.get(script)!;
}
