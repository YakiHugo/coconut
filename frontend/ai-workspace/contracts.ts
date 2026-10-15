/** React owns all AI controls. Domain services never query or mutate the DOM. */
export type Provider = 'codex' | 'claude';
export type AiPurpose = 'question' | 'summary' | 'translation';
export interface SourceCue { id: string; text: string; start?: number; end?: number; speaker?: string | null }
export interface AiSelection { documentKey: string; revision: string; segments: SourceCue[]; scope?: Record<string, unknown>; exactText?: string }
export interface AiTaskView { key: string; title?:string; binding?:string|null; generation?:number; taskId?: string; attemptId?: string; inputDigest?: string; provider: string; model: string; status: string; accepted: boolean; canAccept: boolean; canResume: boolean; canCancel: boolean; canRetry:boolean; requestCount:number; unknown: boolean; archived: boolean; canArchive: boolean }
export interface ReviewView { id: string; target: string; source: string; context: string[]; glossary:string[]; original: string; previous: string; text: string; baseline: string; status: string; busy: boolean }
export interface AiSnapshot {
 documentKey: string | null; revision: string; title: string; purpose: AiPurpose; provider: Provider; model: string; target: string; source: string; question: string;
 execution: 'foreground' | 'background'; consent: boolean; scopeNotice: string; selection: AiSelection | null;
 busy: boolean; connected: boolean; message: string; localErrorAvailable: boolean; localError: string | null;
 tasks: AiTaskView[]; answers: Array<{answer: string; citations: string[]; question?: string; purpose?: string; requested_model?: string; provider?: string; input_snapshot?:{segments:SourceCue[];scope?:Record<string,unknown>}}>;
 review: ReviewView | null; reviewQueue: Array<{id: string; text: string; status: string; reason: string}>;
 resumeKey: string | null; translationEngine:'subscription'|'offline'; offlineAvailable:boolean; allowDownload:boolean; glossary:string; glossaryDirty:boolean; hasDirtyDrafts:boolean; unsavedContent:boolean; recoveries:Array<{id:string;title:string;canRetry:boolean}>;
}
export interface AiCommands {
 configure(patch: Partial<Pick<AiSnapshot, 'purpose'|'provider'|'model'|'target'|'source'|'question'|'execution'|'translationEngine'|'allowDownload'>>): void;
 consent(value: boolean): void; connect(): Promise<void>; submit(): Promise<void>; stop(): void; resetSummary():Promise<void>; retrySave():Promise<void>; exportCurrentDocument():void; exportRecovery(id:string):void; discardRecovery(id:string):void;
 refreshTasks(): Promise<void>; loadArchivedTasks():Promise<void>; lookupTask(id:string):Promise<void>; reviewResume(key: string): void; cancelTask(key: string): Promise<void>; retrySubmission(key:string):Promise<void>; acceptTask(key: string): Promise<void>;
 showLocalError(show: boolean): void; openReview(id: string): void; editReview(text: string): void; saveReview(): Promise<void>; closeReview(discard?: boolean): void;
 editGlossary(text:string):void; saveGlossary():Promise<void>; archiveTask(key:string,restore?:boolean,expected?:{binding?:string|null;generation?:number;taskId?:string;attemptId?:string;inputDigest?:string}):Promise<boolean>; exportTask(key:string):Promise<void>; exportHistory():void;
 answerMetadata(index:number):{freshness:string;citations:Array<{id:string;available:boolean}>};
 navigate(id: string): void;
}
