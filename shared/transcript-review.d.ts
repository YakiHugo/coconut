import type {ResourceDocument} from './transcript-resources';
export function signature(document:ResourceDocument):string;
export function snapshot(document:ResourceDocument):Record<string,unknown>;
export function merge<T extends ResourceDocument>(current:T,input:unknown,results:unknown[],options:{provider:string;model?:string;jobId?:string}):T;
export function readingSignature(document:ResourceDocument):string;
export type ReadingIssue={cue_id:string;reason:string;proposal?:{original:string;replacement:string}};
export function readingReview(document:ResourceDocument):{
    jobId:string;
    sourceSignature:string;
    edits:ReadonlyMap<string,readonly {cue_id:string;from:number;to:number;text:string}[]>;
    speakers:ReadonlyMap<string,string>;
    headings:readonly {cue_id:string;title:string}[];
    issues:ReadingIssue[];
    batches:number;
    fallbackBatches:number;
}|null;
export function readingBatchCount(document:ResourceDocument):number;
