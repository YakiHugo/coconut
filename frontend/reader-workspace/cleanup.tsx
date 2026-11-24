import * as Disfluency from '@coconut/reader/disfluency.js';
import type {ReaderDocument} from './contracts';
import {spokenReadingEdits} from './spoken-reading';

export type CleanupState={state:'none'|'unavailable'|'ready';projection?:Disfluency.Projection;hiddenCount:number;hiddenCharacters:number;markCount:number;breakCount:number;message:string};
export function prepareCleanup(doc:ReaderDocument):CleanupState {
    const plan=doc.reading_cleanup;
    const empty={hiddenCount:0,hiddenCharacters:0,markCount:0,breakCount:0};
    if(!doc.segments.length)return {state:'none',...empty,message:''};
    const source=doc as unknown as Disfluency.SourceDocument;
    function savedProjection(){
        if(typeof plan!=='object'||Array.isArray(plan))throw Error('invalid cleanup');
        const value=plan as {version?:unknown;policyVersion?:unknown;sourceSignature?:unknown;decisions?:unknown;marks?:unknown;breaks?:unknown};
        if(value.version!==1||typeof value.policyVersion!=='string'||typeof value.sourceSignature!=='string'||!Array.isArray(value.decisions)||value.marks!==undefined&&!Array.isArray(value.marks)||value.breaks!==undefined&&!Array.isArray(value.breaks))throw Error('invalid cleanup');
        return Disfluency.createProjection(source,{
            policyVersion:value.policyVersion,sourceSignature:value.sourceSignature,decisions:value.decisions as Disfluency.Decision[],
            ...(value.marks!==undefined?{marks:value.marks as Disfluency.ReadingMark[]}:{}),...(value.breaks!==undefined?{breaks:value.breaks as Disfluency.ReadingBreak[]}:{})
        });
    }
    try{
        let projection:Disfluency.Projection|undefined;
        if(plan!=null){try{projection=savedProjection();}catch{projection=undefined;}}
        if(!projection){
            const decisions=spokenReadingEdits(doc.segments);
            if(!decisions.length)return {state:'ready',...empty,message:''};
            projection=Disfluency.createProjection(source,{decisions,policyVersion:'spoken-reading-v1'});
        }
        const hidden=projection.cues.flatMap(cue=>cue.spans.filter(span=>span.action==='hide'));
        return {state:'ready',projection,hiddenCount:hidden.length,hiddenCharacters:hidden.reduce((count,span)=>count+span.to-span.from,0),
            markCount:projection.cues.reduce((count,cue)=>count+cue.marks.length,0),breakCount:projection.cues.reduce((count,cue)=>count+cue.breaks.length,0),message:''};
    }catch{
        return {state:'unavailable',...empty,message:'无法生成精读稿，请在「来源与整理」中核对文字稿。'};
    }
}
