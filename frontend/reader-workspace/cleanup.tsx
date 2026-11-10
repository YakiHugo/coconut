import * as Disfluency from '@coconut/reader/disfluency.js';
import type {ReaderDocument} from './contracts';

export type CleanupState={state:'none'|'unavailable'|'ready';projection?:Disfluency.Projection;hiddenCount:number;hiddenCharacters:number;markCount:number;breakCount:number;message:string};
export function prepareCleanup(doc:ReaderDocument,displayText:(text:string)=>string):CleanupState {
    const plan=doc.reading_cleanup;
    const empty={hiddenCount:0,hiddenCharacters:0,markCount:0,breakCount:0};
    if(plan===undefined||plan===null)return {state:'none',...empty,message:''};
    try{
        if(typeof plan!=='object'||Array.isArray(plan))throw Error('invalid cleanup');
        const value=plan as {version?:unknown;policyVersion?:unknown;sourceSignature?:unknown;decisions?:unknown;marks?:unknown;breaks?:unknown};
        if(value.version!==1||typeof value.policyVersion!=='string'||typeof value.sourceSignature!=='string'||!Array.isArray(value.decisions)||value.marks!==undefined&&!Array.isArray(value.marks)||value.breaks!==undefined&&!Array.isArray(value.breaks))throw Error('invalid cleanup');
        const projection=Disfluency.createProjection(doc as unknown as Disfluency.SourceDocument,{
            policyVersion:value.policyVersion,sourceSignature:value.sourceSignature,decisions:value.decisions as Disfluency.Decision[],
            ...(value.marks!==undefined?{marks:value.marks as Disfluency.ReadingMark[]}:{}),...(value.breaks!==undefined?{breaks:value.breaks as Disfluency.ReadingBreak[]}:{})
        });
        if(projection.cues.some(cue=>displayText(cue.sourceText).length!==cue.sourceText.length))return {state:'unavailable',...empty,message:'当前字形转换无法精确对应原话，已保留口语。'};
        const hidden=projection.cues.flatMap(cue=>cue.spans.filter(span=>span.action==='hide'));
        return {state:'ready',projection,hiddenCount:hidden.length,hiddenCharacters:hidden.reduce((count,span)=>count+span.to-span.from,0),
            markCount:projection.cues.reduce((count,cue)=>count+cue.marks.length,0),breakCount:projection.cues.reduce((count,cue)=>count+cue.breaks.length,0),message:''};
    }catch{
        return {state:'unavailable',...empty,message:'口语精简建议与当前原文不一致，已保留口语。'};
    }
}
