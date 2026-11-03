import {Converter} from 'opencc-js';
export function resolveChineseScript(preference:string,languages:readonly string[]=[]):'source'|'zh-Hans'|'zh-Hant'{
 if(preference==='zh-Hans'||preference==='zh-Hant'||preference==='source')return preference;
 for(const language of languages){if(!/^zh(?:-|$)/i.test(language))continue;return /(?:hant|tw|hk|mo)(?:-|$)/i.test(language)?'zh-Hant':'zh-Hans';}
 return 'source';
}
const converters=new Map<string,(text:string)=>string>();
export function scriptConverter(preference:string,languages:readonly string[]=[]):(text:string)=>string{
 const script=resolveChineseScript(preference,languages);
 if(script==='source')return text=>text;
 if(!converters.has(script))converters.set(script,Converter(script==='zh-Hans'?{from:'t',to:'cn'}:{from:'cn',to:'t'}));
 return converters.get(script)!;
}
