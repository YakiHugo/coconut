import type {Document} from './contracts';
// @ts-expect-error Shared with the source job executor.
import {attachTranscript as sharedAttach} from '@coconut/shared/attach-transcript.js';

export const attachTranscript: (project:Document,transcript:unknown,core:{
 validate:(value:unknown)=>Record<string,unknown>;
 attachProjectTranscript:(project:unknown,transcript:unknown)=>Record<string,unknown>;
},projectFields:(raw:unknown,normalized:unknown)=>Document)=>Document=sharedAttach;
