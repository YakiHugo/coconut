import React, { useEffect, useRef, useState } from 'react';
import {saveSourceMedia} from './source-media';
import {acquireSourceAudio} from './source-acquisition';
import {useOwnedPicker} from '../native-shell/owned-picker-hook';
import {episodeMetadata,filterEpisodes} from './episode-browser';
import type { AppStore } from './store';
import {attachTranscript} from './attach-transcript';
import {discoverySession,saveDiscoverySession,matchingSourceDocuments,exactSourceIdentity,ingestionDocument,type DiscoverySession,type SourceAttempt} from './discovery-session';
import {captionLanguageChoices,captionDiagnostics,hasCaptionLoss} from './caption-receipt';
import {captionFailureDiagnostic,captionFailureSummary,captionFailureTitle,captionOriginalURL,type CaptionFailureDiagnostic} from './caption-failure';
import {parseSourceLink} from './source-link';
import {resolveEpisodeLink} from './episode-link';
import {useToast} from './toast';
import { ingest, inspectFile, type Ingestion } from './ingestion';
import {downloadVideoAudio,validateDownloadedVideoMedia,videoAudioFallback,type VideoAudioFallback} from './video-audio';
export function Discover({ store }: {
    store: AppStore;
}) {
    const notify = useToast();
    const [session,setSessionState]=useState(()=>discoverySession(store)),sessionRef=useRef(session);
    const updateSession=(patch:Partial<DiscoverySession>)=>{const next={...sessionRef.current,...patch};sessionRef.current=next;saveDiscoverySession(store,next);setSessionState(next);};
    const {url,episodeQuery,episodeLimit,selection,receipt,tracks,error,language,languageChoices,languageRequired,lossReviewed}=session;
    const filteredEpisodes=filterEpisodes(selection?.episodes||[],episodeQuery),visibleEpisodes=filteredEpisodes.slice(0,episodeLimit);
    const diagnostics=captionDiagnostics(receipt?.diagnostics),lossPending=!!receipt&&hasCaptionLoss(diagnostics)&&!lossReviewed;
    const [candidate,setCandidateState]=useState<{file:File;inspected:Awaited<ReturnType<typeof inspectFile>>;keys:string[]}|null>(null);
    const [busy,setBusyState]=useState(false),[review,setReview]=useState<{key:string;revision:number}|null>(null),[attaching,setAttaching]=useState(false);
    const [pendingMedia,setPendingMedia]=useState<{document:NonNullable<ReturnType<AppStore['getDocument']>>;file:File;media:ReturnType<AppStore['getMedia']>;sourceFile:ReturnType<AppStore['getFile']>}|null>(null);
    const [failure,setFailure]=useState<{diagnostic:CaptionFailureDiagnostic|null;original:string|null;audio?:VideoAudioFallback|null}|null>(null);
    const parsedLink = parseSourceLink(url);
    const interrupted = /^读取已(?:取消|暂停)/.test(error);
    const subtitleTokenRequired = failure?.diagnostic?.reason === 'subtitle_token_required';
    useEffect(() => {if (error) notify({message: failure?.diagnostic ? captionFailureTitle(failure.diagnostic) : error, tone: interrupted ? 'info' : 'error'});}, [error, failure, interrupted, notify]);
    const setError=(error:string)=>updateSession({error});
    const choiceHeading=useRef<HTMLHeadingElement|null>(null),reviewHeading=useRef<HTMLHeadingElement|null>(null),lossHeading=useRef<HTMLHeadingElement|null>(null),languageHeading=useRef<HTMLHeadingElement|null>(null);
    useEffect(()=>{const heading=review?reviewHeading.current:lossPending?lossHeading.current:languageRequired?languageHeading.current:receipt?choiceHeading.current:null;if(heading){heading.focus();heading.scrollIntoView?.({block:'nearest'});}},[receipt,review,lossPending,languageRequired]);
    const checkedAt=selection?.feed_checked_at;
    const checkLabel=checkedAt&&!Number.isNaN(Date.parse(checkedAt))?new Date(checkedAt).toLocaleString():null;
    const content=ingestionDocument(receipt),matches=content?matchingSourceDocuments(store.getSnapshot().documents,content):[];
    const mounted=useRef(true);
    useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
    const owner = useRef<AbortController | null>(null), fileInput = useRef<HTMLInputElement>(null);
    const picker=useOwnedPicker({scope:'raw-media',setActivity:store.setActivity,reason:'正在选择原声文件'});
    const sourceState=useRef({busy:false,candidate:false});
    const syncActivity=()=>store.setActivity('source',sourceState.current.busy||sourceState.current.candidate?'正在读取来源或核对候选原文件':null);
    const setBusy=(value:boolean)=>{sourceState.current.busy=value;syncActivity();setBusyState(value);};
    const setCandidate=(value:typeof candidate)=>{sourceState.current.candidate=!!value;syncActivity();setCandidateState(value);};
    const cancelSource = () => { setFailure(null); setCandidate(null);store.invalidateMedia(); owner.current?.abort(); owner.current = null; setBusy(false); };
    const cancel=()=>{picker.controller.retire();cancelSource();};
    useEffect(()=>()=>store.setActivity('source',null),[store]);
    useEffect(()=>{const retire=()=>{if(owner.current){owner.current.abort();owner.current=null;const value={...sessionRef.current,error:'读取已暂停。可重试上次读取。'};sessionRef.current=value;saveDiscoverySession(store,value);}};window.addEventListener('pagehide',retire);return()=>{window.removeEventListener('pagehide',retire);retire();};},[store]);
    const openingReceipt=useRef(false);
    const openReceipt=async(value:Ingestion)=>{
        if(openingReceipt.current)return;
        const content=ingestionDocument(value);if(!content||hasCaptionLoss(captionDiagnostics(value.diagnostics))&&!sessionRef.current.lossReviewed)return;
        openingReceipt.current=true;const controller=new AbortController();owner.current=controller;setBusy(true);
        try {
            const doc=store.addDocument(content,{select:false});
            if(!doc){setError('暂时不能添加内容，请先保存当前修改或处理存储状态。');return;}
            try{await acquireSourceAudio(store,doc.key,controller.signal);}catch(error){if(owner.current===controller&&!controller.signal.aborted)store.setMessage(error instanceof Error?error.message:'原声获取尚未完成，请在来源任务中重试。');}
            if(owner.current!==controller||controller.signal.aborted||!mounted.current)return;
            updateSession({receipt:null,error:''});
            owner.current=null;setBusy(false);store.select(doc.key);
        }catch(error){if(owner.current===controller&&!controller.signal.aborted&&mounted.current)setError(error instanceof Error?error.message:'内容无法添加');}
        finally{openingReceipt.current=false;if(owner.current===controller){owner.current=null;if(mounted.current)setBusy(false);}}
    };
    const request = async (attempt:SourceAttempt) => {
        if (sourceState.current.busy || attaching) return;
        cancel();setReview(null);
        const controller=new AbortController();owner.current=controller;setBusy(true);
        updateSession({attempt,error:'',receipt:null,lossReviewed:false});
        try {
            const read=(attempt:SourceAttempt)=>ingest({source:{kind:'url',url:attempt.feed||attempt.url},...(attempt.language?{language:attempt.language}:{}),...(attempt.intent?{intent:attempt.intent}:{}),...(attempt.episode?{episode:{feed_url:attempt.feed,episode_id:attempt.episode.id,...(attempt.track?{transcript_url:attempt.track}:{})}}:{})},controller.signal);
            let valueResult=await read(attempt);
            if(owner.current!==controller)return;
            if(valueResult.state==='awaiting_selection'&&!attempt.episode&&!attempt.feed){
                const episode=await resolveEpisodeLink(attempt.url,valueResult.selection);
                if(owner.current!==controller||controller.signal.aborted||!mounted.current)return;
                if(episode){
                    attempt={...attempt,feed:valueResult.selection!.feed_url,episode};
                    updateSession({selection:valueResult.selection,attempt,episodeLimit:20});
                    valueResult=await read(attempt);
                    if(owner.current!==controller||controller.signal.aborted||!mounted.current)return;
                }
            }
            if(valueResult.state==='awaiting_selection')updateSession({selection:valueResult.selection,receipt:null,attempt:null,episodeLimit:20});
            else if(valueResult.state==='blocked'){
                const fallback=videoAudioFallback(valueResult.error?.audio_fallback);
                if(valueResult.error?.code==='no_matching_captions'&&fallback){await openVideoAudio(fallback);return;}
                setFailure({diagnostic:captionFailureDiagnostic(valueResult.error?.diagnostic),original:attempt.feed||attempt.episode?null:captionOriginalURL(attempt.url),audio:videoAudioFallback(valueResult.error?.audio_fallback)});
                updateSession({error:valueResult.error?.message||'暂时无法读取来源。',languageRequired:valueResult.error?.code==='language_required',languageChoices:captionLanguageChoices(valueResult.error?.languages)});
            }
            else {
                if(attempt.episode&&typeof valueResult.source?.feed_checked_at==='string'&&sessionRef.current.selection)updateSession({selection:{...sessionRef.current.selection,feed_checked_at:valueResult.source.feed_checked_at}});
                const content=ingestionDocument(valueResult);
                if(!content){setError('此来源尚未返回可打开的原声或文字稿，请保留来源后重试。');return;}
                updateSession({receipt:valueResult,attempt:null,languageRequired:false,languageChoices:[]});
                if(!hasCaptionLoss(captionDiagnostics(valueResult.diagnostics))&&!matchingSourceDocuments(store.getSnapshot().documents,content).length)await openReceipt(valueResult);
            }
        }catch(error){if(owner.current===controller&&!controller.signal.aborted){setFailure({diagnostic:null,original:attempt.feed||attempt.episode?null:captionOriginalURL(attempt.url)});setError(error instanceof Error?error.message:'来源读取失败');}}
        finally{if(owner.current===controller){owner.current=null;setBusy(false);}}
    };
    const openVideoAudio=async(provided?:VideoAudioFallback)=>{
        const fallback=provided||failure?.audio;if(!fallback||(!provided&&busy)||attaching)return;
        cancel();setReview(null);const controller=new AbortController();owner.current=controller;setBusy(true);setError('');
        try{
            const result=await downloadVideoAudio(fallback,controller.signal);
            await validateDownloadedVideoMedia(result.file,result.inspected.kind,result.project.media_duration,controller.signal);
            if(owner.current!==controller||controller.signal.aborted)return;
            const doc=store.addDocument(result.project,{select:false});
            if(!doc)throw Error('当前项目尚未保存，未创建新媒体项目。');
            setPendingMedia({document:doc,file:result.file,media:store.getMedia(doc.key),sourceFile:store.getFile(doc.key)});
            await saveSourceMedia(store,doc.key,result.file,controller.signal);
            if(owner.current!==controller||controller.signal.aborted)return;
            setPendingMedia(null);owner.current=null;setBusy(false);updateSession({receipt:null,attempt:null,error:''});store.select(doc.key);
            store.setMessage('原声已保存。');
        }catch(error){if(owner.current===controller&&!controller.signal.aborted){setFailure({diagnostic:null,original:fallback.url});setError(error instanceof Error?error.message:'公开媒体未完成。');}}
        finally{if(owner.current===controller){owner.current=null;setBusy(false);}}
    };
    const retryMedia=async()=>{
        if(!pendingMedia||busy||attaching)return;
        const {document:doc,file}=pendingMedia;
        if(store.getDocument(doc.key)!==doc||store.getFile(doc.key)!==pendingMedia.sourceFile||store.getMedia(doc.key)!==pendingMedia.media){setError('项目或原声已变化，旧下载未覆盖；请打开项目核对。');return;}
        cancel();const controller=new AbortController();owner.current=controller;setBusy(true);setError('');
        try{await saveSourceMedia(store,doc.key,file,controller.signal);if(owner.current!==controller||controller.signal.aborted)return;
            setPendingMedia(null);owner.current=null;setBusy(false);updateSession({receipt:null,attempt:null,error:''});store.select(doc.key);
        }catch(error){if(owner.current===controller&&!controller.signal.aborted)setError(error instanceof Error?error.message:'原声尚未保存。');}
        finally{if(owner.current===controller){owner.current=null;setBusy(false);}}
    };
    const changeURL=(value:string)=>{cancel();setReview(null);updateSession({url:value,episodeQuery:'',episodeLimit:20,selection:null,tracks:{},receipt:null,attempt:null,error:'',language:'',languageChoices:[],languageRequired:false,lossReviewed:false});};
    const submitLink=()=>{
        const parsed=parseSourceLink(sessionRef.current.url);
        if(!parsed){notify({message:'请粘贴一个有效的播客或视频链接。',tone:'error'});return;}
        if(parsed.url!==sessionRef.current.url)updateSession({url:parsed.url});
        void request({url:parsed.url,...(language?{language}:{})});
    };
    const reopen=(key:string)=>{
        if(!content||!matchingSourceDocuments(store.getSnapshot().documents,content).some(doc=>doc.key===key)){setError('已有项目已变化，请重新读取来源。');return;}
        if(store.select(key))updateSession({receipt:null,error:''});
        else setError('请先保存或取消当前编辑。');
    };
    const confirmAttach=async()=>{
        if(!review||!content||!receipt||attaching||lossPending)return;
        const target=store.getDocument(review.key);
        if(!target||target.project_kind!=='audio_only'||target.segments.length||store.getRevision(target.key)!==review.revision||exactSourceIdentity(target)!==exactSourceIdentity(content)||store.getSnapshot().dirty){setError('原项目已变化，请重新核对后接入文字稿。');setReview(null);return;}
        setAttaching(true);store.setActivity('source-attach','文字稿正在保存到原项目');
        try{
            const core=(window as any).Coconut,next=attachTranscript(target,content,core,(window as any).CoconutCanonicalLibrary.project);
            const ok=await store.commitDocument(next,{key:target.key,revision:review.revision});
            if(!mounted.current)return;
            if(ok){try{await acquireSourceAudio(store,target.key);}catch(error){store.setMessage(error instanceof Error?error.message:'原声获取尚未完成');}if(mounted.current){updateSession({receipt:null,error:''});setReview(null);store.select(target.key);}}
            else{setError('文字稿保存未确认。请查看保存状态；不要重复接入，原项目标识仍保留。');setReview(null);}
        }catch(error){if(mounted.current)setError(error instanceof Error?error.message:'文字稿未能接入，原项目保留');}
        finally{store.setActivity('source-attach',null);if(mounted.current)setAttaching(false);}
    };
    const openFile = async (file: File,current:()=>boolean) => {
        cancelSource();setReview(null);updateSession({receipt:null,attempt:null,error:''});
        const controller = new AbortController();
        owner.current = controller;
        setBusy(true);
        setError('');
        setCandidate(null);
        try {
            const inspected = await inspectFile(file);
            if (owner.current !== controller||!current())
                return;
            const existing = store.getSnapshot().documents.filter(doc => (doc.local_media_source as {
                fingerprint?: string;
            } | undefined)?.fingerprint === inspected.source.fingerprint);
            if (existing.length > 0) {setCandidate({file,inspected,keys:existing.map(doc=>doc.key)});return;}
            const doc = store.addDocument({ project_kind: 'audio_only', title: file.name, local_media_source: inspected.source, segments: [] },{select:false});
            if (!doc || owner.current !== controller)return;
            setPendingMedia({document:doc,file,media:store.getMedia(doc.key),sourceFile:store.getFile(doc.key)});
            await saveSourceMedia(store,doc.key,file,controller.signal);
            if(owner.current!==controller||controller.signal.aborted)return;
            setPendingMedia(null);owner.current=null;setBusy(false);store.select(doc.key);
            store.setMessage('原声已保存。');
        }
        catch (error) {
            if (owner.current === controller)
                setError(error instanceof Error ? error.message : '文件无法打开');
        }
        finally {
            if (owner.current === controller) {
                owner.current = null;
                setBusy(false);
            }
            if (fileInput.current)
                fileInput.current.value = '';
        }
    };
    const chooseCandidate=async(key:string|null)=>{
        if(!candidate||sourceState.current.busy)return;const {file,inspected}=candidate;const existing=key?store.getDocument(key):null;
        if(key&&(!existing||(existing.local_media_source as {fingerprint?:string})?.fingerprint!==inspected.source.fingerprint)){setError('候选项目已变化，请重新打开文件。');setCandidate(null);return;}
        if(store.getSnapshot().dirty)return;
        const doc=existing||store.addDocument({project_kind:'audio_only',title:file.name,local_media_source:inspected.source,segments:[]},{select:false});if(!doc)return;
        setCandidate(null);const controller=new AbortController();owner.current=controller;setBusy(true);setPendingMedia({document:doc,file,media:store.getMedia(doc.key),sourceFile:store.getFile(doc.key)});
        try{await saveSourceMedia(store,doc.key,file,controller.signal);if(owner.current!==controller||controller.signal.aborted)return;setPendingMedia(null);owner.current=null;setBusy(false);store.select(doc.key);}
        catch(error){if(owner.current===controller)setError(error instanceof Error?error.message:'原声尚未保存');}
        finally{if(owner.current===controller){owner.current=null;setBusy(false);}}
    };
    return <section className="discover" aria-labelledby="discover-title">
  <header className="discover-intro"><h1 id="discover-title">今天，想听什么？</h1></header>
  <form className="source-composer" onSubmit={event => {event.preventDefault();submitLink();}} aria-busy={busy}>
    <label className="visually-hidden" htmlFor="source-url">播客或视频链接</label>
    <div className="source-row">
      <button className="source-add" aria-label="打开音频或视频文件" data-native-command="open-local-media" type="button" disabled={busy||attaching} onClick={() => {if(store.closeSnapshot().nonContentReasons.length)return;store.invalidateMedia();const captured=store.getSnapshot();picker.controller.begin(fileInput.current,()=>{const value=store.getSnapshot();return value.workspace===captured.workspace&&value.activeKey===captured.activeKey&&value.documents===captured.documents;});}}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span className="visually-hidden">打开音频或视频文件</span></button>
      <input id="source-url" disabled={attaching} type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={8192} value={url} onChange={event=>changeURL(event.target.value)} onPaste={event=>{const text=event.clipboardData.getData('text'),parsed=parseSourceLink(text);if(parsed){event.preventDefault();changeURL(parsed.url);}}} placeholder="粘贴播客或视频链接…"/>
      {parsedLink&&<span className="source-kind">{parsedLink.label}</span>}
      {busy?<button className="source-submit source-stop" type="button" aria-label="取消读取" onClick={event=>{event.preventDefault();cancel();setError('读取已取消。可重试上次读取。');}}><span aria-hidden="true"/><span className="visually-hidden">取消读取</span></button>:<button className="source-submit" disabled={!url.trim()||attaching} type="submit" aria-label="打开链接"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg><span className="visually-hidden">打开链接</span></button>}
    </div>
    <input key={picker.inputKey} ref={fileInput} type="file" accept="audio/*,video/*" hidden onChange={event => {const input=event.currentTarget,file=input.files?.[0];void picker.controller.accept(input,async({current})=>{if(file&&current())await openFile(file,current);});}}/>
    {busy&&<div className="source-hint"><span role="status" className="source-progress"><span aria-hidden="true"/>正在读取来源…</span></div>}
  </form>
  {pendingMedia&&<section aria-label="原声保存待完成"><p>项目已创建，原声尚未保存。离开本页后需重新关联原文件。</p><button disabled={busy||attaching} onClick={()=>void retryMedia()}>重试保存已下载原声</button><button disabled={busy||attaching} onClick={()=>{cancel();store.select(pendingMedia.document.key);}}>打开已创建的项目</button></section>}
  {candidate&&<section aria-label="核对原声项目"><h2>核对原声来源</h2><p>文件采样与已有项目相同，请核对是否为同一原声。</p>{candidate.keys.map(key=><button key={key} onClick={()=>chooseCandidate(key)}>关联到 {store.getDocument(key)?.title||key}</button>)}<button onClick={()=>chooseCandidate(null)}>作为新原声项目打开</button><button onClick={()=>setCandidate(null)}>取消关联</button></section>}
  {error&&!busy&&!languageRequired&&<section className="source-feedback caption-failure" data-tone={interrupted?'info':'error'} aria-label={failure&&(failure.diagnostic||failure.original)?'本次字幕读取结果':'来源读取结果'}>
    <div className="source-feedback-heading"><span className="source-feedback-icon" aria-hidden="true">{interrupted?'·':'!'}</span><div><h2>{interrupted?error.split('。')[0]:captionFailureTitle(failure?.diagnostic||null)}</h2>{subtitleTokenRequired&&<p>{failure?.audio?'字幕读取需要额外令牌，可单独检查公开原声。':'可前往原站查看或导入已有字幕。'}</p>}</div></div>
    <div className="source-actions">{session.attempt&&!subtitleTokenRequired&&<button type="button" onClick={()=>void request(session.attempt!)}>重试上次读取{session.attempt.episode?'：'+session.attempt.episode.title:''}</button>}{failure?.original&&<a href={failure.original} target="_blank" rel="noopener noreferrer">打开原站</a>}</div>
    {failure?.audio&&<button className="source-audio-fallback" disabled={busy||attaching} onClick={()=>void openVideoAudio()}>{failure.audio.purpose==='source'?'单独检查并获取公开原声（最多 200 MiB）':'下载公开媒体并新建项目（最多 200 MiB）'}</button>}
    <div className="source-diagnostics"><p className="source-error">{error}</p>{failure?.diagnostic&&<p data-caption-diagnostic>{captionFailureSummary(failure.diagnostic)}</p>}<p>{failure?.audio?.purpose==='source'?(failure.diagnostic?.reason==='subtitle_token_required'?'字幕需要额外令牌；公开原声可单独检查，不会自动开始。':'字幕读取未完成；公开原声可单独检查。'):failure?.audio?'公开媒体可能使用默认音轨，语言及是否原版尚未确认。':'未取得可阅读的文字稿。'}</p></div>
  </section>}
  {(!error||busy||languageRequired)&&<p className="source-error" hidden>{error}</p>}
  {languageRequired&&<section aria-label="选择视频原语言"><h2 ref={languageHeading} tabIndex={-1}>确认视频原语言</h2><p>请选择视频原语言。可用字幕语言不一定是原语言。</p>{languageChoices.length>0?<label>视频原语言<select value={language} onChange={event=>{cancel();updateSession({language:event.target.value,error,receipt:null,lossReviewed:false});}}><option value="">请选择原语言</option>{languageChoices.map(code=><option key={code} value={code}>{code}</option>)}</select></label>:<p>字幕服务未返回可选语言，请更新后重试。</p>}{languageChoices.length>0&&<button disabled={busy||!languageChoices.includes(language)} onClick={()=>void request({...session.attempt!,language})}>按所选原语言重试</button>}</section>}
  {selection&&<section className="episode-list" aria-label="选择播客单集"><h2>{selection.title||'选择一集开始'}</h2>{selection.feed_url&&<div className="feed-refresh"><p className="quiet">{checkLabel?'上次检查：'+checkLabel:''}</p><button disabled={busy||attaching} onClick={()=>void request({url,feed:selection.feed_url})}>刷新节目列表</button></div>}{selection.feeds?.map(feed=><button key={feed.url} disabled={busy||attaching} onClick={()=>{changeURL(feed.url);void request({url:feed.url});}}>{feed.title}</button>)}{selection.truncated&&<p className="episode-warning" role="status">来源列表不完整，搜索仅限当前列表。</p>}{Boolean(selection.warnings?.length)&&<div className="episode-warnings"><ul>{selection.warnings!.map((warning,index)=><li key={index}>{warning}</li>)}</ul></div>}{Boolean(selection.episodes?.length)&&<div className="episode-browser"><label htmlFor="episode-query">查找当前列表的单集</label><input id="episode-query" type="search" value={episodeQuery} disabled={busy||attaching} onChange={event=>updateSession({episodeQuery:event.target.value,episodeLimit:20})} placeholder="按单集标题查找"/>{episodeQuery&&<button disabled={busy||attaching} onClick={()=>updateSession({episodeQuery:'',episodeLimit:20})}>清空单集搜索</button>}<p role="status">匹配 {filteredEpisodes.length} 集 · 已显示 {visibleEpisodes.length} 集</p>{!filteredEpisodes.length&&<p>没有匹配的单集。</p>}</div>}{visibleEpisodes.map(episode=>{
      const supported=(episode.transcripts||[]).filter(track=>track.supported&&track.url),selectedTrack=supported.some(track=>!track.selection_conflict&&track.url===tracks[episode.id])?tracks[episode.id]:'',metadata=episodeMetadata(episode),allConflicting=supported.length>0&&supported.every(track=>track.selection_conflict),suggestion=episode.transcript_selection,recommended=suggestion?.status==='default'?supported.find(track=>track.url===suggestion.transcript_url):undefined;
      return <article key={episode.id}><div><h3>{episode.title}</h3>{metadata&&<p className="episode-metadata">{metadata}</p>}<p>{supported.length?'发布者提供带时文字稿 · 未经人工校对':'此单集暂无可导入的带时文字稿'}</p>{allConflicting&&<p className="episode-warning">文字稿标注冲突，暂不可导入。</p>}{supported.length>0&&<label>文字稿语言与格式 · {episode.title}<select aria-label={'文字稿语言与格式 · '+episode.title} value={selectedTrack} disabled={busy||attaching} onChange={event=>{cancel();setReview(null);updateSession({tracks:{...sessionRef.current.tracks,[episode.id]:event.target.value},receipt:null,attempt:null,error:''});}}><option value="">{recommended?`默认：${recommended.language_source==='inherited'?'按发布者语言 ':''}${recommended.language} · ${recommended.type}`:allConflicting?'文字稿标注冲突，暂不可导入':'请选择发布者文字稿语言'}</option>{supported.map((track,index)=><option key={track.url+':'+index} value={track.url} disabled={track.selection_conflict}>{track.selection_conflict?'标注冲突 · ':''}{track.language_source==='inherited'?'按发布者语言 ':''}{track.language||(track.language_status==='invalid'?'语言标注无效':'语言未标明')} · {track.type} · {index+1}</option>)}</select></label>}{!episode.media?.length&&<p className="quiet">此单集未提供可用的公开原声链接。</p>}</div><div className="episode-actions"><button disabled={busy||attaching||supported.length>0&&!selectedTrack&&!recommended} onClick={()=>void request({url,episode,feed:selection.feed_url,track:selectedTrack||undefined})}>打开单集</button><button disabled={busy||attaching||!episode.media?.length} onClick={()=>void request({url,episode,feed:selection.feed_url,intent:'media_only'})}>先听原声</button></div></article>;
  })}{visibleEpisodes.length<filteredEpisodes.length&&<button className="episode-more" disabled={busy||attaching} onClick={()=>updateSession({episodeLimit:episodeLimit+20})}>显示更多单集</button>}</section>}
  {receipt&&Boolean(content)&&diagnostics.length>0&&<section className="caption-review" aria-label="字幕解析检查"><h2 ref={lossHeading} tabIndex={-1}>{hasCaptionLoss(diagnostics)?'部分字幕未导入':'字幕解析提示'}</h2><p>保留 {(content as any).segments?.length||0} 个片段 · {diagnostics.length} 项解析提示</p><ul>{diagnostics.slice(0,100).map((item,index)=><li key={index}><p>{item.category==='malformed_timing'?'时间格式无效，片段未导入':item.category==='empty_cue'?'片段无可读文字，未导入':item.category} · 原文行 {item.startLine??'?'}–{item.endLine??'?'}</p>{item.cueId&&<p>片段：{item.cueId}</p>}{item.preview&&<pre>{item.preview}</pre>}</li>)}</ul>{diagnostics.length>100&&<p>仅展示前 100 项；其余仍计入上述数量，请核对来源。</p>}{lossPending&&<><button disabled={busy||attaching} onClick={()=>{updateSession({lossReviewed:true});if(!matches.length)openReceipt(receipt);}}>保留剩余文字稿，继续</button><button disabled={busy||attaching} onClick={()=>{setReview(null);updateSession({receipt:null,lossReviewed:false,error:''});}}>取消本次导入</button></>}</section>}
  {receipt&&Boolean(content)&&!lossPending&&<section className="source-project-choice" aria-label={matches.length?'此来源已在书架':'来源等待加入书架'}><h2 ref={choiceHeading} tabIndex={-1}>{matches.length?'此来源已在书架':'来源已就绪，尚未加入书架'}</h2>{matches.map(doc=><article key={doc.key}><h3>{doc.title}</h3><p>{doc.segments.length?`${doc.segments.length} 段文字`:'原声 · 尚无文字稿'} · 项目标识 {doc.key.slice(-8)}</p><button disabled={busy||attaching} onClick={()=>reopen(doc.key)}>继续已有项目 · {doc.key.slice(-8)}</button>{receipt.state==='ready'&&doc.project_kind==='audio_only'&&!doc.segments.length&&<button disabled={busy||attaching} onClick={()=>setReview({key:doc.key,revision:store.getRevision(doc.key)})}>核对新文字稿 · {doc.key.slice(-8)}</button>}</article>)}<button disabled={busy||attaching} onClick={()=>{setReview(null);openReceipt(receipt);}}>{matches.length?'另建独立副本':'加入书架'}</button><button disabled={busy||attaching} onClick={()=>{setReview(null);updateSession({receipt:null,error:''});}}>返回单集列表</button></section>}
  {review&&!lossPending&&receipt?.state==='ready'&&Boolean(content)&&<section aria-label="核对并接入文字稿"><h2 ref={reviewHeading} tabIndex={-1}>核对后接入原项目</h2><p>目标：{store.getDocument(review.key)?.title} · {review.key.slice(-8)}</p><p>发布者可能更新音轨，请核对文字稿与原声是否对应。原项目的笔记和书签将保留。</p><p>文字稿语言：{String((content as any).language||'未标明')} · {(content as any).segments?.length||0} 个片段</p><p>{(content as any).segments?.slice(0,3).map((cue:any)=>cue.text).join(' ')}</p><button disabled={busy||attaching} onClick={()=>void confirmAttach()}>{attaching?'正在保存…':'确认接入此原声项目'}</button><button disabled={busy||attaching} onClick={()=>setReview(null)}>取消接入</button></section>}
 </section>;
}
