/** React owns views; the store alone owns durable document identity. */
export type Document = {
    key: string;
    title: string;
    segments: Array<{
        id: string;
        start: number;
        end: number;
        text: string;
        [key: string]: unknown;
    }>;
    notes: Record<string, string>;
    [key: string]: unknown;
};
export type Media = {
    url: string;
    kind: 'audio' | 'video';
    name: string;
    identity: string;
    availability: 'remote' | 'local_session';
    nativeToken?:string;release?:()=>void;
};
export type Workspace = 'discover' | 'library' | 'read';
export type SaveStatus = {
    status: string;
    unsaved: number;
    blocked?: boolean;
    documents?: Array<{
        error?: {
            message?: string;
        };
    }>;
    generation?: number;
};
export type AppSnapshot = {
    revision: number;
    workspace: Workspace;
    documents: readonly Document[];
    activeKey: string | null;
    save: SaveStatus;
    message: string;
    dirty: boolean;
};
export type SaveResult = {
    ok: boolean;
    status?: string;
    error?: {
        code?: string;
        message?: string;
    };
};
export type StoreDependencies = {
    nativeCatalogReady?:()=>boolean;
    nativeOwner?:(key:string)=>{library:string;epoch:number}|null;
    documents: Document[];
    active: string | null;
    validate: (value: unknown) => Omit<Document, 'key'>;
    project:(raw:unknown,normalized:unknown)=>Document;
    createPipeline: (getDocuments: () => Document[]) => SavePipeline;
    planBackup?: (current: {
        documents: Document[];
        active: string | null;
    }, backup: unknown) => {
        library: {
            documents: Document[];
            active: string | null;
        };
        entries: Array<{
            outcome: string; sourceKey:string; document:Document;
        }>;
    };
};
export type SavePipeline = {
    status: () => SaveStatus;
    preflightDocuments: (changes: Array<{
        key: string;
        identity: Document;
        kind: string;
    }>) => SaveResult;
    queueDocument: (key: string, identity: Document, kind?: string) => {
        accepted?: boolean;
        committed: Promise<SaveResult>;
    };
    queueDocuments?: (changes: Array<{
        key: string;
        identity: Document;
        kind: string;
    }>) => {
        accepted: boolean;
        tickets: Array<{
            committed: Promise<SaveResult>;
        }>;
    };
    subscribe: (listener: (status?:unknown,event?:{result?:{ok:boolean;changes?:Array<{key:string;identity:Document;kind:string}>;checkpoints?:Array<{identity:Document}>}}) => void) => () => void;
    acquireBarrier?:(id:string)=>unknown|null;barrierActive?:(token:unknown)=>boolean;releaseBarrier?:(token:unknown)=>unknown;discardPending?:(token:unknown)=>Promise<SaveResult>;
    flush: (token?:unknown) => Promise<SaveResult>;
    retry: () => Promise<SaveResult>;
};
export type RemoteMedia = {
    kind: 'audio' | 'video';
    name?: string;
    url?: string;
    download?: {
        endpoint: string;
        body: unknown;
    };
};
