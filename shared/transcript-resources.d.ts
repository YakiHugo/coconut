export type ResourceDocument={key:string;title:string;segments:Array<{id:string;start:number;end:number;text:string;[key:string]:unknown}>;[key:string]:unknown};
export type ResourceCapabilities={audio?:boolean;punctuation?:boolean;speakers?:boolean};
export type ResourceRow={kind:string;state:string;message:string};
export function processingSnapshot(doc:ResourceDocument):ResourceDocument;
export function sourceSignature(doc:ResourceDocument):string;
export function inspectResources(doc:ResourceDocument,capabilities?:ResourceCapabilities):{rows:ResourceRow[];steps:string[];asr:boolean;requiresAudio:boolean};
export function mergeProcessingResult<T extends ResourceDocument>(current:T,input:ResourceDocument,result:ResourceDocument):T;
