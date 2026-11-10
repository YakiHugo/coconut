export type SourceCue={id:string;text:string;start:number;end:number;speaker?:string|null;speaker_id?:string|null;words?:Array<{word:string;start:number;end:number;text_start?:number;text_end?:number}>;alignment_status?:unknown;timing_basis?:unknown};
export type SourceDocument={key?:string;segments:SourceCue[]};
export type Decision={cue_id:string;from:number;to:number;action:'hide'|'keep';reason:string;confidence?:number};
export type ReadingMark={cue_id:string;at:number;mark:'，'|'。'|'？'|'！'|'；'|'：';reason:string;method?:'rule'|'llm'};
export type ReadingBreak={cue_id:string;at:number;reason:string};
export type Span=Readonly<{from:number;to:number;displayFrom:number;displayTo:number;action:'hide'|'keep';reason?:string;confidence?:number}>;
export type ProjectedCue=Readonly<{cue_id:string;start:number;end:number;speaker:string|null;speaker_id?:string;sourceText:string;text:string;readingText:string;spans:readonly Span[];marks:readonly Readonly<Omit<ReadingMark,'cue_id'>&{displayAt:number}>[];breaks:readonly Readonly<Omit<ReadingBreak,'cue_id'>&{displayAt:number}>[]}>;
export type Projection=Readonly<{version:1;policyVersion:string;sourceSignature:string;cues:readonly ProjectedCue[]}>;
export type CleanupPlan={version:1;policyVersion:string;sourceSignature:string;decisions:Decision[];marks?:ReadingMark[];breaks?:ReadingBreak[];[key:string]:unknown};
export type DisplayRange={cue_id:string;from:number;to:number};
export type SourcePiece=Readonly<{cue_id:string;from:number;to:number;text:string;start:number;end:number;timing_basis:'cue'}>;
export type Selection=Readonly<{ranges:readonly Readonly<DisplayRange&{text:string}>[];pieces:readonly SourcePiece[];displayText:string;continuous:boolean}>;
export const VERSION:1;
export const DEFAULT_POLICY_VERSION:string;
export const LIMITS:Readonly<{cues:number;characters:number;decisions:number;marks:number;breaks:number}>;
export const READING_MARKS:readonly ReadingMark['mark'][];
/** SHA-256 of canonical source identity, including word clocks and speakers. */
export function signature(document:SourceDocument):string;
/** Derived, deeply frozen and disposable; regenerate after JSON serialization. */
export function createProjection(document:SourceDocument,options?:{decisions?:Decision[];marks?:ReadingMark[];breaks?:ReadingBreak[];policyVersion?:string;sourceSignature?:string}):Projection;
export function assertCurrent(document:SourceDocument,projection:Projection,options?:{policyVersion?:string}):Projection;
/** Verify the existing plan against its original source before changing only the document key. Throws for stale source or invalid edits; preserves opaque metadata. */
export function rebindPlan(document:SourceDocument,target:SourceDocument,plan:unknown):CleanupPlan;
export function getCue(projection:Projection,cueId:string):ProjectedCue|null;
/** Offsets refer to cue.text (source with hidden ranges removed), excluding generated marks and breaks in cue.readingText. */
export function select(projection:Projection,ranges:DisplayRange[]):Selection;
