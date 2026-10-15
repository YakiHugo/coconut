import type { AppSnapshot, Document, Media, RemoteMedia, StoreDependencies, Workspace } from './contracts';
export function createAppStore(deps: StoreDependencies) {
    let documents = deps.documents, activeKey = deps.active, revision = 0, workspace: Workspace = 'discover', message = '', dirty = false, storageInvalid = false;
    let messageGeneration=0,persistenceMessageGeneration:number|null=null;
    const assignMessage=(value:string,persistence=false)=>{message=value;messageGeneration++;persistenceMessageGeneration=persistence?messageGeneration:null;};
    const reconcileMessage=()=>{const status=pipeline.status();if(persistenceMessageGeneration===messageGeneration&&status.status==='saved'&&status.unsaved===0)assignMessage('保存已确认。');};
    let nativeLifecycle:{invalidate:()=>void;selected:(key:string)=>void;retire:(owner:{library:string;key:string;epoch:number;source:Record<string,unknown>})=>Promise<unknown>;dispose:()=>void}|null=null;
    const removalCleanup=new Map<Document,{owner:{library:string;key:string;epoch:number;source:Record<string,unknown>}|null;attachment:Media|null}>();
    function completeRemoval(doc:Document){const pending=removalCleanup.get(doc);if(!pending)return;removalCleanup.delete(doc);if(pending.attachment){releaseMedia(pending.attachment);if(media.get(doc.key)===pending.attachment)media.delete(doc.key);}if(!getDocument(doc.key))files.delete(doc.key);if(pending.owner)void retireOwner(pending.owner);}
    const retirements=new Map<string,{owner:{library:string;key:string;epoch:number;source:Record<string,unknown>};pending:boolean}>();
    async function retireOwner(owner:{library:string;key:string;epoch:number;source:Record<string,unknown>}){if(!nativeLifecycle)return;const entry={owner,pending:true};retirements.set(owner.key,entry);publish();const ok=await nativeLifecycle.retire(owner);if(retirements.get(owner.key)!==entry)return;if(ok===true)retirements.delete(owner.key);else{entry.pending=false;assignMessage('旧原文件引用未能取消，请重试；新的记住操作暂时锁定。');}publish();}
    const portableMedia=new WeakMap<Document,RemoteMedia>();
    const savedSources=new Map(deps.documents.map(doc=>[doc.key,JSON.stringify(doc.local_media_source||null)]));
    const releaseMedia=(item:Media)=>{if(item.release)item.release();else if(item.url.startsWith('blob:'))URL.revokeObjectURL(item.url);};
    const dirtyOwners = new Set<string>(),activities=new Map<string,string>();
    const versions = new Map(documents.map(doc => [doc.key, 0])), listeners = new Set<() => void>(), media = new Map<string, Media>(), remoteMedia = new Map<string, RemoteMedia>(), files = new Map<string, File>();
    const pipeline = deps.createPipeline(() => documents);
    let snapshot: AppSnapshot;let removed:Document|null=null,structuralBusy=false;
    const publish = () => { snapshot = { revision: ++revision, workspace, documents, activeKey, save: pipeline.status(), message, dirty }; for (const listener of listeners)
        listener(); };
    const getDocument = (key = activeKey) => documents.find(doc => doc.key === key) || null;
    const getRevision = (key: string) => versions.get(key) ?? -1;
    const writable = () => { const status = pipeline.status(); return !storageInvalid && !status.blocked && !status.documents?.some(item => ['conflict', 'fenced', 'unreadable', 'version', 'unavailable', 'legacy-changed', 'corruption', 'epoch_conflict', 'revision_conflict', 'source_changed', 'uncertain'].includes((item.error as {
        code?: string;
    })?.code || '')); };
    const select = (key: string) => { if (dirty || !getDocument(key))
        return false; nativeLifecycle?.invalidate();activeKey = key; workspace = 'read'; publish(); return true; };
    async function commitDocument(next: Document, expected: {
        key: string;
        revision: number;
    }) {
        const current = getDocument(expected.key);
        if (!writable() || !current || next.key !== expected.key || getRevision(expected.key) !== expected.revision)
            return false;
        // Validate a detached copy. The caller cannot mutate saved identities later.
        let validated: Document;
        try {
            validated = deps.project(structuredClone(next),{...deps.validate(structuredClone(next)),key:expected.key});
        }
        catch {
            return false;
        }
        const preflight = pipeline.preflightDocuments([{ key: next.key, identity: validated, kind: 'update' }]);
        if (!preflight.ok) {
            assignMessage(preflight.error?.message || '内容暂时无法保存，请保留备份。');
            publish();
            return false;
        }
        documents = documents.map(doc => doc === current ? validated : doc);
        versions.set(next.key, expected.revision + 1);
        const ticket = pipeline.queueDocument(next.key, validated);
        if (ticket.accepted === false) {
            documents = documents.map(doc => doc === validated ? current : doc);
            versions.set(next.key, expected.revision);
            assignMessage('修改未进入保存队列，原内容保留。');
            publish();
            return false;
        }
        publish();
        const result = await ticket.committed;
        if (!result.ok) {
            assignMessage(result.error?.message || '修改仍在本页，保存未完成。请重试或导出备份。',true);
            publish();
        }
        return result.ok;
    }
    function addDocument(value: unknown) {
        if (!writable() || dirty)
            return null;
        const validated = deps.project(structuredClone(value),deps.validate(structuredClone(value)));
        const doc = { ...validated, key: 'react-' + crypto.randomUUID() } as Document;
        const preflight = pipeline.preflightDocuments([{ key: doc.key, identity: doc, kind: 'update' }]);
        if (!preflight.ok)
            throw Error(preflight.error?.message || '存储不能接收此内容');
        const previousDocuments = documents, previousActive = activeKey, previousWorkspace = workspace;
        documents = [...documents, doc];
        versions.set(doc.key, 0);
        nativeLifecycle?.invalidate();activeKey = doc.key;
        workspace = 'read';
        const ticket = pipeline.queueDocument(doc.key, doc);
        if (ticket.accepted === false) {
            documents = previousDocuments;
            activeKey = previousActive;
            workspace = previousWorkspace;
            versions.delete(doc.key);
            assignMessage('内容未进入保存队列，原书架保留。');
            publish();
            return null;
        }
        publish();
        void ticket.committed.then(result => { if (!result.ok) {
            assignMessage('内容已在本页打开，但尚未保存。请重试或导出备份。',true);
            publish();
        } });
        return doc;
    }
    async function removeDocument(key:string){const doc=getDocument(key);if(!doc||dirty||structuralBusy||!writable()||pipeline.status().unsaved)return false;const preflight=pipeline.preflightDocuments([{key,identity:doc,kind:'remove'}]);if(!preflight.ok)return false;const previous=documents,previousActive=activeKey,previousWorkspace=workspace,owner=deps.nativeOwner?.(key),source=doc.local_media_source;structuralBusy=true;removalCleanup.set(doc,{owner:owner&&source?{...owner,key,source:structuredClone(source) as Record<string,unknown>}:null,attachment:media.get(key)||null});nativeLifecycle?.invalidate();documents=documents.filter(item=>item!==doc);if(activeKey===key){activeKey=documents[0]?.key||null;workspace='library';}const ticket=pipeline.queueDocument(key,doc,'remove');if(ticket.accepted===false){removalCleanup.delete(doc);documents=previous;activeKey=previousActive;workspace=previousWorkspace;structuralBusy=false;publish();return false;}removed=doc;publish();const result=await ticket.committed;structuralBusy=false;if(result.ok){completeRemoval(doc);assignMessage('已从书架移除，可撤销本次移除。');}else assignMessage('移除尚未确认保存，请重试保存或导出备份；本页保留撤销内容。',true);publish();return result.ok;}
    async function undoRemove(){if(!removed||dirty||structuralBusy||!writable()||pipeline.status().unsaved||getDocument(removed.key))return false;const doc=structuredClone(removed),preflight=pipeline.preflightDocuments([{key:doc.key,identity:doc,kind:'update'}]);if(!preflight.ok)return false;structuralBusy=true;documents=[...documents,doc];const ticket=pipeline.queueDocument(doc.key,doc);if(ticket.accepted===false){documents=documents.filter(item=>item!==doc);structuralBusy=false;publish();return false;}versions.set(doc.key,(versions.get(doc.key)||0)+1);publish();const result=await ticket.committed;structuralBusy=false;if(result.ok){removed=null;assignMessage('已恢复移除的内容。原文件引用需要重新确认。');}else assignMessage('恢复内容仍在本页，尚未保存。',true);publish();return result.ok;}
    async function restoreJSON(value:unknown,expectedRevision:number){if(value&&typeof value==='object'&&(value as {format?:string}).format==='coconut-library')return restoreBackup(value,expectedRevision);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('请选择完整 Coconut 项目或书架 JSON。');const raw=structuredClone(value) as Record<string,unknown>;deps.validate(structuredClone(raw));const key=typeof raw.key==='string'&&raw.key.length>0&&raw.key.length<=200?raw.key:'import-'+crypto.randomUUID();return restoreBackup({format:'coconut-library',version:1,documents:[{...raw,key}],active:key},expectedRevision);}
    async function restoreBackup(backup: unknown, expectedRevision: number) {
        if (!writable() || dirty || revision !== expectedRevision)
            throw Error('读取期间页面或内容已变化，请重新选择备份。');
        if (!deps.planBackup || !pipeline.queueDocuments)
            throw Error('当前存储不支持原子恢复。');
        const plan = deps.planBackup({ documents, active: activeKey }, backup), existing = new Set(documents);
        const raw=new Map((backup as {documents:Document[]}).documents.map(doc=>[doc.key,doc]));
        const projectedDocuments=[...plan.library.documents],used=new Set(projectedDocuments.map(doc=>doc.key));
        for(const entry of plan.entries){
            const source=raw.get(entry.sourceKey);if(!source)throw Error('备份来源身份不完整。');
            const projected=deps.project(source,{...deps.validate(structuredClone(source)),key:entry.document.key});
            if(entry.outcome==='duplicate'){
                const comparable=(doc:Document)=>JSON.stringify({...doc,key:null});
                if(comparable(projected)===comparable(entry.document))continue;
                let key=source.key,suffix=1;while(used.has(key)){const tail='-restored-'+suffix++;key=source.key.slice(0,200-tail.length)+tail;}used.add(key);projectedDocuments.push({...projected,key});
            }else{const index=projectedDocuments.indexOf(entry.document);if(index<0)throw Error('恢复文档身份不完整。');projectedDocuments[index]=projected;}
        }
        plan.library.documents=projectedDocuments;
        const added=projectedDocuments.filter(doc=>!existing.has(doc));
        const changes = added.map(identity => ({ key: identity.key, identity, kind: 'update' }));
        const preflight = pipeline.preflightDocuments(changes);
        if (!preflight.ok)
            throw Error(preflight.error?.message || '备份超过本次原子保存限制，请拆分后重试。');
        const previousDocuments = documents;
        documents = plan.library.documents;
        for (const doc of added)
            versions.set(doc.key, 0);
        const result = pipeline.queueDocuments(changes);
        if (!result.accepted) {
            documents = previousDocuments;
            for (const doc of added)
                versions.delete(doc.key);
            assignMessage('恢复未进入保存队列，原书架保留。');
            publish();
            return false;
        }
        publish();
        const receipts = await Promise.all(result.tickets.map(ticket => ticket.committed));
        const ok = receipts.every(result => result.ok);
        assignMessage(ok ? `已恢复 ${added.length} 份内容；相同内容已跳过，不同版本分别保留。` : '恢复内容仍在本页，但尚未完整保存。请重试或导出备份。',!ok);
        publish();
        return ok;
    }
    const unsubscribe = pipeline.subscribe((_status,event)=>{if(event?.result?.ok)for(const change of event.result.changes||[])if(change.kind==='remove')completeRemoval(change.identity);if(event?.result?.ok)for(const saved of event.result.checkpoints||[]){const key=saved.identity.key,previous=savedSources.get(key),next=JSON.stringify(saved.identity.local_media_source||null),base=deps.nativeOwner?.(key);if(previous&&previous!=='null'&&previous!==next&&base)void retireOwner({...base,key,source:JSON.parse(previous)});savedSources.set(key,next);}if(event?.result?.ok)reconcileMessage();publish();});
    publish();
    return { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        pendingRetirements:()=>[...retirements.values()].map(value=>({key:value.owner.key,pending:value.pending})),retryRetirement:(key:string)=>{const value=retirements.get(key);if(value&&!value.pending)return retireOwner(value.owner);},
        completeNativeOwners(){if(!deps.nativeCatalogReady?.()||!writable())return null;const owners=[];for(const doc of documents){if(!doc.local_media_source)continue;const base=deps.nativeOwner?.(doc.key);if(!base||savedSources.get(doc.key)!==JSON.stringify(doc.local_media_source))return null;owners.push({...base,key:doc.key,source:structuredClone(doc.local_media_source) as Record<string,unknown>});}return owners;},
        nativeOwner(key:string){const doc=getDocument(key),base=deps.nativeOwner?.(key);if(retirements.has(key)||!base||!doc?.local_media_source||!writable()||savedSources.get(key)!==JSON.stringify(doc.local_media_source))return null;return {...base,key,source:structuredClone(doc.local_media_source) as Record<string,unknown>};},
        releaseNativeMedia(){for(const [key,item]of media){if(item.nativeToken){releaseMedia(item);media.delete(key);}}publish();},
        setNativeLifecycle(value:typeof nativeLifecycle){nativeLifecycle=value;},invalidateMedia(){nativeLifecycle?.invalidate();},
        getDocument, getRevision, commitDocument,restoreJSON,removeDocument,undoRemove,canUndoRemove:()=>!!removed&&!structuralBusy,recoveryDocuments:()=>removed&&!documents.some(doc=>doc.key===removed!.key)?[...documents,removed]:documents, addDocument, select, restoreBackup,
        navigate(next: Workspace) { if (dirty)
            return false; nativeLifecycle?.invalidate();workspace = next; publish(); return true; },
        setDirty(value: boolean, owner = 'reader') { if (value)
            dirtyOwners.add(owner);
        else
            dirtyOwners.delete(owner); const next = dirtyOwners.size > 0; if (dirty !== next) {
            dirty = next;
            publish();
        } },
        setMessage(value: string) { assignMessage(value); publish(); },
        invalidateStorage(value: string) { storageInvalid = true; assignMessage(value || '存储连接已变化，请导出备份后重新打开。'); publish(); },
        getMedia: (key: string) => media.get(key) || null,
        getRemoteMedia: (key: string) => {const temporary=remoteMedia.get(key);if(temporary)return temporary;const doc=getDocument(key);if(!doc?.podcast_source)return null;const cached=portableMedia.get(doc);if(cached)return cached;try{const checked=deps.validate({project_kind:'audio_only',title:doc.title,segments:[],podcast_source:structuredClone(doc.podcast_source)}).podcast_source as {kind?:string;media_kind?:'audio'|'video';media_url?:string;feed_url?:string;episode_id?:string}|undefined;if(!checked?.media_url||!checked.media_kind)return null;const restored:RemoteMedia={kind:checked.media_kind,name:doc.title,download:{endpoint:'/api/podcasts/media',body:checked.kind==='direct_media'?{url:checked.media_url}:{feedUrl:checked.feed_url,episodeId:checked.episode_id,mediaUrl:checked.media_url}}};portableMedia.set(doc,restored);return restored;}catch{return null;}},
        setRemoteMedia(key: string, value: RemoteMedia) { remoteMedia.set(key, value); publish(); },
        getFile: (key: string) => files.get(key) || null,
        setFile(key: string, file: File) { files.set(key, file); },
        setMedia(key: string, next: Media) { nativeLifecycle?.invalidate();const previous = media.get(key); media.set(key, next); if (previous && previous.url !== next.url)
            releaseMedia(previous);if(!next.nativeToken)nativeLifecycle?.selected(key); publish(); },
        setActivity(owner:string,reason:string|null){if(reason)activities.set(owner,reason);else activities.delete(owner);},
        closeSnapshot(){const content=pipeline.status(),nonContentReasons=[...activities.values(),...(dirty?['有未提交的编辑草稿']:[]),...(removed?['本次移除只能在当前页面撤销，请先撤销或导出救援备份']:[])],contentFailed=content.unsaved>0&&!['saved','pending','saving'].includes(content.status),reasons=[...nonContentReasons,...(content.unsaved?['内容尚未保存']:[])];return {safe:!reasons.length,flushable:!contentFailed&&!nonContentReasons.length,reasons,nonContentReasons,contentPending:content.unsaved,contentFailed};},
        acquireBarrier:(id:string)=>pipeline.acquireBarrier?.(id)??null,barrierActive:(token:unknown)=>pipeline.barrierActive?.(token)===true,releaseBarrier:(token:unknown)=>pipeline.releaseBarrier?.(token),discardPending:(token:unknown)=>pipeline.discardPending?.(token)??Promise.resolve({ok:false}),
        retry: () => pipeline.retry(), flush: (token?:unknown) => pipeline.flush(token?{token}:undefined),
        dispose() { nativeLifecycle?.dispose();unsubscribe(); for (const item of media.values())
            releaseMedia(item); listeners.clear(); },
    };
}
export type AppStore = ReturnType<typeof createAppStore>;
