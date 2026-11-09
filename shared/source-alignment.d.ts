import type {ResourceDocument} from './transcript-resources.js';
export function mergeAlignmentCandidate<T extends ResourceDocument>(current:T,input:ResourceDocument,candidate:ResourceDocument,report:unknown):T;
