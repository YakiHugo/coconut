import React, { useEffect, useRef, useState } from 'react';
import {useOwnedPicker} from '../native-shell/owned-picker-hook';
import {searchCatalog} from './catalog';
import {episodeMetadata,filterEpisodes} from './episode-browser';
import {SubtitleRecovery} from '../recovery-import/recovery';
import { Recovery } from './recovery';
import type { AppStore } from './store';
import {attachTranscript} from './attach-transcript';
import {discoverySession,saveDiscoverySession,matchingSourceDocuments,exactSourceIdentity,ingestionDocument,type DiscoverySession,type SourceAttempt} from './discovery-session';
import {captionLanguageChoices,captionDiagnostics,hasCaptionLoss} from './caption-receipt';
import {captionFailureDiagnostic,captionFailureSummary,captionOriginalURL,type CaptionFailureDiagnostic} from './caption-failure';
import { ingest, inspectFile, type Ingestion } from './ingestion';
import {downloadVideoAudio,validateDownloadedVideoMedia,videoAudioFallback,type VideoAudioFallback} from './video-audio';
export function Discover({ store }: {
    store: AppStore;
}) {
    const [session,setSessionState]=useState(()=>discoverySession(store)),sessionRef=useRef(session);
    const updateSession=(patch:Partial<DiscoverySession>)=>{const next={...sessionRef.current,...patch};sessionRef.current=next;saveDiscoverySession(store,next);setSessionState(next);};
    const {url,catalogQuery,episodeQuery,episodeLimit,selection,receipt,tracks,error,language,languageChoices,languageRequired,lossReviewed}=session;
    const filteredEpisodes=filterEpisodes(selection?.episodes||[],episodeQuery),visibleEpisodes=filteredEpisodes.slice(0,episodeLimit);
    const diagnostics=captionDiagnostics(receipt?.diagnostics),lossPending=!!receipt&&hasCaptionLoss(diagnostics)&&!lossReviewed;
    const [candidate,setCandidateState]=useState<{file:File;inspected:Awaited<ReturnType<typeof inspectFile>>;keys:string[]}|null>(null);
    const [busy,setBusyState]=useState(false),[review,setReview]=useState<{key:string;revision:number}|null>(null),[attaching,setAttaching]=useState(false);
    const [failure,setFailure]=useState<{diagnostic:CaptionFailureDiagnostic|null;original:string|null;audio?:VideoAudioFallback|null}|null>(null);
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
    const openReceipt=(value:Ingestion)=>{
        const content=ingestionDocument(value);if(!content||hasCaptionLoss(captionDiagnostics(value.diagnostics))&&!sessionRef.current.lossReviewed)return;
        try {
            const doc=store.addDocument(content);
            if(!doc){setError('暂时不能添加内容，请先保存当前修改或处理存储状态。');return;}
            if(value.media)store.setRemoteMedia(doc.key,value.media);
            if(value.state==='needs_transcription')store.setMessage(value.transcription?.message||'已打开原声项目，尚未配置文字稿识别。');
            updateSession({receipt:null,error:''});
        }catch(error){setError(error instanceof Error?error.message:'内容无法添加');}
    };
    const request = async (attempt:SourceAttempt) => {
        cancel();setReview(null);
        const controller=new AbortController();owner.current=controller;setBusy(true);
        updateSession({attempt,error:'',receipt:null,lossReviewed:false});
        try {
            const valueResult=await ingest({source:{kind:'url',url:attempt.feed||attempt.url},...(attempt.language?{language:attempt.language}:{}),...(attempt.intent?{intent:attempt.intent}:{}),...(attempt.episode?{episode:{feed_url:attempt.feed,episode_id:attempt.episode.id,...(attempt.track?{transcript_url:attempt.track}:{})}}:{})},controller.signal);
            if(owner.current!==controller)return;
            if(valueResult.state==='awaiting_selection')updateSession({selection:valueResult.selection,receipt:null,attempt:null,episodeLimit:20});
            else if(valueResult.state==='blocked'){
                setFailure({diagnostic:captionFailureDiagnostic(valueResult.error?.diagnostic),original:attempt.feed||attempt.episode?null:captionOriginalURL(attempt.url),audio:valueResult.error?.code==='no_matching_captions'?videoAudioFallback(valueResult.error?.audio_fallback):null});
                updateSession({error:valueResult.error?.message||'暂时无法读取来源。',languageRequired:valueResult.error?.code==='language_required',languageChoices:captionLanguageChoices(valueResult.error?.languages)});
            }
            else {
                if(attempt.episode&&typeof valueResult.source?.feed_checked_at==='string'&&sessionRef.current.selection)updateSession({selection:{...sessionRef.current.selection,feed_checked_at:valueResult.source.feed_checked_at}});
                const content=ingestionDocument(valueResult);
                if(!content){setError('此来源尚未返回可打开的原声或文字稿，请保留来源后重试。');return;}
                updateSession({receipt:valueResult,attempt:null,languageRequired:false,languageChoices:[]});
                if(!hasCaptionLoss(captionDiagnostics(valueResult.diagnostics))&&!matchingSourceDocuments(store.getSnapshot().documents,content).length)openReceipt(valueResult);
            }
        }catch(error){if(owner.current===controller&&!controller.signal.aborted){setFailure({diagnostic:null,original:attempt.feed||attempt.episode?null:captionOriginalURL(attempt.url)});setError(error instanceof Error?error.message:'来源读取失败');}}
        finally{if(owner.current===controller){owner.current=null;setBusy(false);}}
    };
    const openVideoAudio=async()=>{
        const fallback=failure?.audio;if(!fallback||busy||attaching)return;
        cancel();setReview(null);const controller=new AbortController();owner.current=controller;setBusy(true);setError('');
        try{
            const result=await downloadVideoAudio(fallback,controller.signal);
            await validateDownloadedVideoMedia(result.file,result.inspected.kind,result.project.media_duration,controller.signal);
            if(owner.current!==controller||controller.signal.aborted)return;
            const doc=store.addDocument(result.project);
            if(!doc)throw Error('当前项目尚未保存，未创建新媒体项目。');
            store.setFile(doc.key,result.file);
            store.setMedia(doc.key,{url:URL.createObjectURL(result.file),kind:result.inspected.kind,name:doc.title,identity:result.inspected.identity,availability:'local_session'});
            store.select(doc.key);updateSession({receipt:null,attempt:null,error:''});
            store.setMessage('已创建公开媒体项目，项目保存状态请查看页首。媒体仅在本页保留，刷新前若未完成识别上传，需要重新载入；未自动播放或识别。可检查本机识别服务，再明确生成文字稿。');
        }catch(error){if(owner.current===controller&&!controller.signal.aborted){setFailure({diagnostic:null,original:fallback.url});setError(error instanceof Error?error.message:'公开媒体未完成。');}}
        finally{if(owner.current===controller){owner.current=null;setBusy(false);}}
    };
    const changeURL=(value:string)=>{cancel();setReview(null);updateSession({url:value,episodeQuery:'',episodeLimit:20,selection:null,tracks:{},receipt:null,attempt:null,error:'',language:'',languageChoices:[],languageRequired:false,lossReviewed:false});};
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
            if(ok){updateSession({receipt:null,error:''});setReview(null);store.select(target.key);}
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
            const doc = existing[0] || store.addDocument({ project_kind: 'audio_only', title: file.name, local_media_source: inspected.source, segments: [] });
            if (!doc || owner.current !== controller)
                return;
            store.setFile(doc.key, file);
            store.setMedia(doc.key, { url: URL.createObjectURL(file), kind: inspected.kind, name: file.name, identity: inspected.identity, availability: 'local_session' });
            store.select(doc.key);
            store.setMessage('已打开本地原声。文件未上传，未自动播放，尚未自动转写；可在文字稿面板查看识别服务状态。');
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
    const chooseCandidate=(key:string|null)=>{if(!candidate)return;const {file,inspected}=candidate;const existing=key?store.getDocument(key):null;if(key&&(!existing||(existing.local_media_source as {fingerprint?:string})?.fingerprint!==inspected.source.fingerprint)){setError('候选项目已变化，请重新打开文件。');setCandidate(null);return;}if(store.getSnapshot().dirty)return;const doc=existing||store.addDocument({project_kind:'audio_only',title:file.name,local_media_source:inspected.source,segments:[]});if(!doc)return;store.setFile(doc.key,file);store.setMedia(doc.key,{url:URL.createObjectURL(file),kind:inspected.kind,name:file.name,identity:inspected.identity,availability:'local_session'});setCandidate(null);store.select(doc.key);};
    return <section className="discover" aria-labelledby="discover-title">
  <p className="kicker">COCONUT / 从声音开始</p><h1 id="discover-title">今天，想听什么？</h1><p className="lede">从一段声音开始，留住值得重读的想法。</p>
  <form onSubmit={event => { event.preventDefault(); void request({url,...(language?{language}:{})}); }}><label htmlFor="source-url">播客或视频链接</label><div className="source-row"><input id="source-url" disabled={attaching} type="url" required maxLength={4096} value={url} onChange={event=>changeURL(event.target.value)} placeholder="粘贴节目、单集或视频链接"/><button disabled={busy||attaching} type="submit">{busy ? '正在读取…' : '打开链接'}</button></div></form>
  <div className="source-actions"><button data-native-command="open-local-media" type="button" disabled={busy||attaching} onClick={() => {if(store.closeSnapshot().nonContentReasons.length)return;store.invalidateMedia();const captured=store.getSnapshot();picker.controller.begin(fileInput.current,()=>{const value=store.getSnapshot();return value.workspace===captured.workspace&&value.activeKey===captured.activeKey&&value.documents===captured.documents;});}}>打开音频或视频文件</button><input key={picker.inputKey} ref={fileInput} type="file" accept="audio/*,video/*" hidden onChange={event => { const input=event.currentTarget,file=input.files?.[0];void picker.controller.accept(input,async({current})=>{if(file&&current())await openFile(file,current);}); }}/>{busy && <button onClick={()=>{cancel();setError('读取已取消。可重试上次读取。');}}>取消读取</button>}</div>
  {candidate&&<section aria-label="核对原声项目"><h2>核对原声来源</h2><p>部分文件采样与已有项目相同，但不能证明是同一原声。请核对文件名与项目后选择。已有笔记不会被覆盖。</p>{candidate.keys.map(key=><button key={key} onClick={()=>chooseCandidate(key)}>关联到 {store.getDocument(key)?.title||key}</button>)}<button onClick={()=>chooseCandidate(null)}>作为新原声项目打开</button><button onClick={()=>setCandidate(null)}>取消关联</button></section>}
  <p className="quiet">可先听原声，或选择发布者现成文字稿。原声需另行点击载入，不会自动播放、调用 AI、运行识别或下载模型。</p>
  <p role="status" className="source-error">{error}</p>
  {failure&&error&&!busy&&(failure.diagnostic||failure.original)&&<section className="caption-failure" aria-label="本次字幕读取结果">
    {failure.diagnostic&&<p data-caption-diagnostic>{captionFailureSummary(failure.diagnostic)}</p>}
    <p>{failure.audio?'已确认没有匹配原语言的字幕轨道。可明确下载公开媒体并创建新项目；可能是视频中的默认音轨，语言及是否原版未必可确认。下载前会重新核对字幕与访问状态。':'本次未取得可阅读的文字稿，不能据此判断来源没有字幕。链接已保留，可重试读取。'}</p>
    <div className="source-actions">{failure.audio&&<button disabled={busy||attaching} onClick={()=>void openVideoAudio()}>下载公开媒体并新建项目（最多 200 MiB）</button>}
    {failure.original&&<a href={failure.original} target="_blank" rel="noopener noreferrer">打开原站</a>}</div>
  </section>}
  {languageRequired&&<section aria-label="选择视频原语言"><h2 ref={languageHeading} tabIndex={-1}>确认视频原语言</h2><p>以下是来源实际提供且格式可用的字幕语言，并不表示已确认视频原语言。请选择你确认的原语言后重试；不会自动换轨或启动识别。</p>{languageChoices.length>0?<label>视频原语言<select value={language} onChange={event=>{cancel();updateSession({language:event.target.value,error,receipt:null,lossReviewed:false});}}><option value="">请选择原语言</option>{languageChoices.map(code=><option key={code} value={code}>{code}</option>)}</select></label>:<p>当前字幕服务没有返回可选语言，无法在此确认原语言。链接已保留；请更新字幕服务后重试。</p>}{languageChoices.length>0&&<button disabled={busy||!languageChoices.includes(language)} onClick={()=>void request({...session.attempt!,language})}>按所选原语言重试</button>}</section>}
  {session.attempt&&!busy&&error&&!languageRequired&&<button onClick={()=>void request(session.attempt!)}>重试上次读取{session.attempt.episode?'：'+session.attempt.episode.title:''}</button>}
  {selection&&<section className="episode-list" aria-label="选择播客单集"><h2>{selection.title||'选择一集开始'}</h2>{selection.feed_url&&<div className="feed-refresh"><p className="quiet">{checkLabel?'上次来源检查：'+checkLabel+'。一分钟内选择单集可能复用此节目列表；文字稿仍从发布者获取。':'选择单集时检查发布者来源。'} 刷新会重新读取来源，失败时不会使用旧缓存。</p><button disabled={busy||attaching} onClick={()=>void request({url,feed:selection.feed_url})}>刷新节目列表</button></div>}{selection.feeds?.map(feed=><button key={feed.url} disabled={busy||attaching} onClick={()=>{changeURL(feed.url);void request({url:feed.url});}}>{feed.title}</button>)}{selection.truncated&&<p className="episode-warning" role="status">来源列表不完整，仅包含发布者当前返回且服务可读取的部分单集。搜索只查找这些单集，不代表完整节目存档。</p>}{Boolean(selection.warnings?.length)&&<details className="episode-warnings"><summary>来源提示</summary><ul>{selection.warnings!.map((warning,index)=><li key={index}>{warning}</li>)}</ul></details>}{Boolean(selection.episodes?.length)&&<div className="episode-browser"><label htmlFor="episode-query">查找当前列表的单集</label><input id="episode-query" type="search" value={episodeQuery} disabled={attaching} onChange={event=>updateSession({episodeQuery:event.target.value,episodeLimit:20})} placeholder="按单集标题查找"/>{episodeQuery&&<button disabled={attaching} onClick={()=>updateSession({episodeQuery:'',episodeLimit:20})}>清空单集搜索</button>}<p role="status">匹配 {filteredEpisodes.length} 集 · 已显示 {visibleEpisodes.length} 集</p>{!filteredEpisodes.length&&<p>当前列表没有匹配的单集。可清空搜索，或在上方换用具体单集链接。</p>}</div>}{visibleEpisodes.map(episode=>{
      const supported=(episode.transcripts||[]).filter(track=>track.supported&&track.url),selectedTrack=supported.some(track=>!track.selection_conflict&&track.url===tracks[episode.id])?tracks[episode.id]:'',metadata=episodeMetadata(episode),allConflicting=supported.length>0&&supported.every(track=>track.selection_conflict),suggestion=episode.transcript_selection,recommended=suggestion?.status==='default'?supported.find(track=>track.url===suggestion.transcript_url):undefined;
      return <article key={episode.id}><div><h3>{episode.title}</h3>{metadata&&<p className="episode-metadata">{metadata}</p>}<p>{supported.length?'发布者提供带时文字稿 · 未经人工校对':'此单集暂无可导入的带时文字稿'}</p>{allConflicting&&<p className="episode-warning">发布者对同一文字稿地址的标注不一致，暂不可导入。可刷新来源，或先听原声。</p>}{supported.length>0&&<label>文字稿语言与格式 · {episode.title}<select aria-label={'文字稿语言与格式 · '+episode.title} value={selectedTrack} disabled={attaching} onChange={event=>{cancel();setReview(null);updateSession({tracks:{...sessionRef.current.tracks,[episode.id]:event.target.value},receipt:null,attempt:null,error:''});}}><option value="">{recommended?`默认：${recommended.language_source==='inherited'?'按发布者语言 ':''}${recommended.language} · ${recommended.type}（可切换）`:allConflicting?'文字稿标注冲突，暂不可导入':'请选择发布者文字稿语言'}</option>{supported.map((track,index)=><option key={track.url+':'+index} value={track.url} disabled={track.selection_conflict}>{track.selection_conflict?'标注冲突 · ':''}{track.language_source==='inherited'?'按发布者语言 ':''}{track.language||(track.language_status==='invalid'?'语言标注无效':'语言未标明')} · {track.type} · {index+1}</option>)}</select></label>}{!episode.media?.length&&<p className="quiet">此单集未提供可用的公开原声链接。</p>}</div><div className="episode-actions"><button disabled={busy||attaching||supported.length>0&&!selectedTrack&&!recommended} onClick={()=>void request({url,episode,feed:selection.feed_url,track:selectedTrack||undefined})}>打开单集</button><button disabled={busy||attaching||!episode.media?.length} onClick={()=>void request({url,episode,feed:selection.feed_url,intent:'media_only'})}>先听原声</button></div></article>;
  })}{visibleEpisodes.length<filteredEpisodes.length&&<button className="episode-more" disabled={attaching} onClick={()=>updateSession({episodeLimit:episodeLimit+20})}>显示更多单集</button>}</section>}
  {receipt&&Boolean(content)&&diagnostics.length>0&&<section className="caption-review" aria-label="字幕解析检查"><h2 ref={lossHeading} tabIndex={-1}>{hasCaptionLoss(diagnostics)?'部分字幕未导入':'字幕解析提示'}</h2><p>本次保留 {(content as any).segments?.length||0} 个片段，解析报告 {diagnostics.length} 项提示。请核对原文后决定是否保存剩余文字稿。</p><ul>{diagnostics.slice(0,100).map((item,index)=><li key={index}><p>{item.category==='malformed_timing'?'时间格式无效，片段未导入':item.category==='empty_cue'?'片段无可读文字，未导入':item.category} · 原文行 {item.startLine??'?'}–{item.endLine??'?'}</p>{item.cueId&&<p>片段：{item.cueId}</p>}{item.preview&&<pre>{item.preview}</pre>}</li>)}</ul>{diagnostics.length>100&&<p>仅展示前 100 项；其余仍计入上述数量，请核对来源。</p>}{lossPending&&<><button disabled={attaching} onClick={()=>{updateSession({lossReviewed:true});if(!matches.length)openReceipt(receipt);}}>保留剩余文字稿，继续</button><button disabled={attaching} onClick={()=>{setReview(null);updateSession({receipt:null,lossReviewed:false,error:''});}}>取消本次导入</button></>}</section>}
  {receipt&&Boolean(content)&&!lossPending&&<section className="source-project-choice" aria-label={matches.length?'此来源已在书架':'来源等待加入书架'}><h2 ref={choiceHeading} tabIndex={-1}>{matches.length?'此来源已在书架':'来源已就绪，尚未加入书架'}</h2>{matches.length>0&&<p>选择已有项目继续阅读，或明确创建独立副本。已有文字稿和笔记不会自动替换。</p>}{matches.map(doc=><article key={doc.key}><h3>{doc.title}</h3><p>{doc.segments.length?`${doc.segments.length} 段文字`:'原声 · 尚无文字稿'} · 项目标识 {doc.key.slice(-8)}</p><button disabled={attaching} onClick={()=>reopen(doc.key)}>继续已有项目 · {doc.key.slice(-8)}</button>{receipt.state==='ready'&&doc.project_kind==='audio_only'&&!doc.segments.length&&<button disabled={attaching} onClick={()=>setReview({key:doc.key,revision:store.getRevision(doc.key)})}>核对新文字稿 · {doc.key.slice(-8)}</button>}</article>)}{!matches.length&&<p>当前没有相同来源的项目。请确认保存状态后加入书架。</p>}<button disabled={attaching} onClick={()=>{setReview(null);openReceipt(receipt);}}>{matches.length?'另建独立副本':'加入书架'}</button><button disabled={attaching} onClick={()=>{setReview(null);updateSession({receipt:null,error:''});}}>返回单集列表</button></section>}
  {review&&!lossPending&&receipt?.state==='ready'&&Boolean(content)&&<section aria-label="核对并接入文字稿"><h2 ref={reviewHeading} tabIndex={-1}>核对后接入原项目</h2><p>目标：{store.getDocument(review.key)?.title} · {review.key.slice(-8)}</p><p>来源身份相同。发布者可能更新音轨，请核对文字稿语言、内容与原声；接入后保留原项目标识、原声关联、项目笔记和时间书签。</p><p>文字稿语言：{String((content as any).language||'未标明')} · {(content as any).segments?.length||0} 个片段</p><p>{(content as any).segments?.slice(0,3).map((cue:any)=>cue.text).join(' ')}</p><button disabled={attaching} onClick={()=>void confirmAttach()}>{attaching?'正在保存…':'确认接入此原声项目'}</button><button disabled={attaching} onClick={()=>setReview(null)}>取消接入</button></section>}
  {!selection&&!receipt&&<section className="podcast-catalog" aria-labelledby="catalog-title"><div><h2 id="catalog-title">从一个节目开始</h2><p className="quiet">内置公开节目目录。点击后读取最新单集；字幕可用性以发布者来源为准。</p></div><label htmlFor="catalog-query">查找内置节目</label><input id="catalog-query" type="search" value={catalogQuery} onChange={event=>updateSession({catalogQuery:event.target.value})} placeholder="节目名称或主题"/><ul>{searchCatalog(catalogQuery).map(show=><li key={show.id}><div><h3>{show.title}</h3><p>{show.description}</p><a href={show.source} target="_blank" rel="noopener noreferrer">发布者网站</a></div><button disabled={busy||attaching} onClick={()=>{changeURL(show.feed);void request({url:show.feed});}}>查看单集</button></li>)}</ul>{!searchCatalog(catalogQuery).length&&<p>内置目录暂无匹配。也可以在上方粘贴发布者 RSS 或节目链接。</p>}</section>}
  <Recovery store={store}/><SubtitleRecovery store={store}/>
 </section>;
}
