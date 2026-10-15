export interface ReaderCue {
    id: string;
    start: number;
    end: number;
    text: string;
    speaker?: string | null;
    translations?: Record<string, {
        text?: string;
        [key: string]: unknown;
    }>;
    [key: string]: unknown;
}
export interface ReaderDocument {
    key: string;
    title: string;
    segments: ReaderCue[];
    notes: Record<string, string>;
    readingPosition?: string;
    translation_view?: string;
    project_note?: string;
    timestamp_bookmarks?: Array<{
        id: string;
        time: number;
        note: string;
    }>;
    local_media_source?: {
        name: string;
        [key: string]: unknown;
    };
    media_timing?: {
        version: 1;
        identity: string;
        offset: number;
    };
    exact_excerpts?: Array<{
        id: string;
        text: string;
        [key: string]: unknown;
    }>;
    exact_excerpt_notes?: Record<string, string>;
    [key: string]: unknown;
}
export interface ReaderMedia {
    url: string;
    kind: 'audio' | 'video';
    name: string;
    identity: string;
    availability?: 'remote' | 'local_session';
}
export interface ReaderSelection {
    key: string;
    revision: number;
    text: string;
    cueIds: string[];
    scope?: {
        kind: 'exact_source_selection';
        from: number;
        to: number;
        separators: string[];
        cueIds: string[];
    };
}
export interface ReaderSnapshot {
    document: ReaderDocument;
    revision: number;
    media: ReaderMedia | null;
    saveStatus?: string;
}
export interface ReaderView {documentKey:string;cueId:string;mode:'transcript'|'passages'}
export interface ReaderResumePosition {identity:string;time:number;duration:number}
export interface ReaderWorkspaceProps extends ReaderSnapshot {
    initialView?:ReaderView|null;
    onViewChange?:(view:ReaderView)=>void;
    resumePosition?:ReaderResumePosition|null;
    onVisibleSelection?:(selection:{key:string;revision:number;cueIds:string[]})=>void;
    onReviewTranslation?:(cueId:string)=>void;
    navigationRequest?:{id:number;cueId:string;documentKey:string;revision:number}|null;
    onSaveDocument(next: ReaderDocument, expected: {
        key: string;
        revision: number;
    }): Promise<boolean>;
    onReadingPosition(cueId: string): void;
    onRequestAi(selection: ReaderSelection): void;
    onDirtyChange?(dirty: boolean): void;
    onMediaProgress?(seconds: number, duration: number): void;
}
export interface ReaderCommands {
    updateDocument(key: string, expectedRevision: number, update: (doc: ReaderDocument) => ReaderDocument): Promise<boolean>;
    saveReadingPosition(key: string, cueId: string): void;
}
export function createReaderCommands(adapter: {
    getDocument(key: string): ReaderDocument | undefined;
    getRevision(key: string): number;
    commitDocument(next: ReaderDocument, expected: {
        key: string;
        revision: number;
    }): Promise<boolean>;
    onReadingPosition(key: string, cueId: string): void;
}): ReaderCommands {
    return { async updateDocument(key, revision, update) {
            const doc = adapter.getDocument(key);
            if (!doc || adapter.getRevision(key) !== revision)
                return false;
            const next = update(structuredClone(doc));
            if (next.key !== key)
                return false;
            return adapter.commitDocument(next, { key, revision });
        }, saveReadingPosition(key, cueId) {
            if (adapter.getDocument(key)?.segments.some(cue => cue.id === cueId))
                adapter.onReadingPosition(key, cueId);
        } };
}
