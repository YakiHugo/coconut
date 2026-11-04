import type {ResourceDocument} from './transcript-resources';
export function signature(document:ResourceDocument):string;
export function snapshot(document:ResourceDocument):Record<string,unknown>;
export function merge<T extends ResourceDocument>(current:T,input:unknown,results:unknown[],options:{provider:string;model?:string;jobId?:string}):T;
