import type {Ingestion} from './ingestion';
/** Receipt-only hints never become document fields or source identity. */
export function captionLanguageChoices(value:unknown):string[]{
 if(!Array.isArray(value)||value.length>128)return [];
 return [...new Set(value.filter((code):code is string=>typeof code==='string'&&/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(code)))].sort();
}
export function captionDiagnostics(value:unknown):NonNullable<Ingestion['diagnostics']>{
 if(!Array.isArray(value))return [];
 return value.filter(item=>item&&typeof item.category==='string').map(item=>({category:item.category.slice(0,80),...(Number.isSafeInteger(item.startLine)&&item.startLine>0?{startLine:item.startLine}:{}),...(Number.isSafeInteger(item.endLine)&&item.endLine>0?{endLine:item.endLine}:{}),...(typeof item.cueId==='string'?{cueId:item.cueId.slice(0,100)}:{}),...(typeof item.preview==='string'?{preview:item.preview.slice(0,2000)}:{})}));
}
export const hasCaptionLoss=(diagnostics:NonNullable<Ingestion['diagnostics']>)=>diagnostics.some(item=>['malformed_timing','empty_cue'].includes(item.category));
