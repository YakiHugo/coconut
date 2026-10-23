import { useEffect, useRef, useState } from 'react';
import type { ReaderMedia,ReaderResumePosition } from './contracts';
import { time } from './domain';
export interface SeekIntent {
    id: number;
    owner: string;
    attachmentURL:string;
    attachmentId:number;
    seconds: number;
    end?: number;
    play?: boolean;
}
type Range = {
    id?: string;
    start: number;
    end: number;
    label?: string;
};
type PlaybackState = {
    status: string;
    range: Range | null;
    returnPosition: {
        time: number;
        wasPlaying: boolean;
    } | null;
    error: string;
};
type PlaybackController = {
    listen: (range: Range) => Promise<boolean>;
    replay: () => Promise<boolean>;
    returnToPrevious: () => Promise<boolean>;
    continue: () => Promise<boolean>;
    cancel: () => void;
    getState: () => PlaybackState;
    dispose: () => void;
};
type PlaybackDomain = {
    create: (options: {
        getPlayer: () => HTMLMediaElement | null;
        getDocumentKey: () => string;
        onChange: (state: PlaybackState) => void;
    }) => PlaybackController;
};
export function ReaderPlayer({ media, seek, onTime, onProgress, resumePosition, onResume, onLocate, follow=false, onFollow, canFollow=false }: {
    media: ReaderMedia;
    onLocate?:()=>void;
    follow?:boolean;
    onFollow?:(follow:boolean)=>void;
    canFollow?:boolean;
    resumePosition?:ReaderResumePosition|null;
    onResume?:(seconds:number)=>void;
    seek: SeekIntent | null;
    onTime: (seconds: number) => void;
    onProgress?: (seconds: number, duration: number) => void;
}) {
    const ref = useRef<HTMLMediaElement | null>(null), controller = useRef<PlaybackController | null>(null), pending = useRef<SeekIntent | null>(null), repeatRef = useRef(false), transition = useRef(false), progress = useRef(onProgress), lastIntent=useRef(0), cancelledIntent=useRef(0),engaged=useRef(false),lastProgress=useRef(0),playAttempt=useRef(0);
    progress.current = onProgress;
    const [error, setError] = useState(''), [duration, setDuration] = useState(0), [rate, setRate] = useState(1), [repeat, setRepeat] = useState(false), [playback, setPlayback] = useState<PlaybackState | null>(null), [playing,setPlaying]=useState(false), [currentTime,setCurrentTime]=useState(0);
    const flush = (player = ref.current) => { if (!player || !Number.isFinite(player.duration) || transition.current || !engaged.current || player.seeking)
        return; const origin = controller.current?.getState().returnPosition; progress.current?.(origin?.time ?? player.currentTime, player.duration);lastProgress.current=Date.now(); };
    useEffect(() => {
        const api = (window as unknown as {
            CoconutPassagePlayback: PlaybackDomain;
        }).CoconutPassagePlayback;
        const engine = api.create({ getPlayer: () => ref.current, getDocumentKey: () => media.identity, onChange: state => { setPlayback(state); if (state.error)
                setError(state.error); if (state.status === 'finished' && repeatRef.current)
                queueMicrotask(() => { if (controller.current === engine && repeatRef.current && engine.getState().status === 'finished')
                    void engine.replay(); }); } });
        controller.current = engine;
        const player = ref.current, leave = () => { flush(player);cancelledIntent.current=Math.max(cancelledIntent.current,lastIntent.current);pending.current=null;repeatRef.current=false;setRepeat(false);transition.current=true;try{engine.cancel();player?.pause();}finally{transition.current=false;} };
        window.addEventListener('pagehide', leave);const visibility=()=>{if(document.hidden)flush(player);};document.addEventListener('visibilitychange',visibility);
        return () => { window.removeEventListener('pagehide', leave);document.removeEventListener('visibilitychange',visibility); flush(player); controller.current = null; engine.dispose(); player?.pause(); pending.current = null; };
    }, [media.identity, media.url]);
    const apply = (intent: SeekIntent) => { const player = ref.current; if (!player || intent.owner !== media.identity || intent.attachmentURL !== media.url || intent.id<=cancelledIntent.current)

        return; lastIntent.current=Math.max(lastIntent.current,intent.id); if (!Number.isFinite(player.duration) || player.duration <= 0) {
        pending.current = intent;
        return;
    } if (!Number.isFinite(intent.seconds) || intent.seconds < 0 || intent.seconds > player.duration || (intent.end !== undefined && (!Number.isFinite(intent.end) || intent.end <= intent.seconds || intent.end > player.duration))) {
        setError('该时间超出当前媒体范围，请核对来源与校准。');
        return;
    } pending.current = null; setError(''); if (intent.end !== undefined) {
        void controller.current?.listen({ id: String(intent.id), start: intent.seconds, end: intent.end, label: '所选原声' });
    }
    else {
        controller.current?.cancel();
        engaged.current=true;
        player.currentTime = intent.seconds;
        if (intent.play)
            void player.play().catch(() => setError('播放未能开始，请使用播放器播放按钮。'));
    } };
    useEffect(() => { if (seek)
        apply(seek); }, [seek]);
    const props = { ref: (node: HTMLMediaElement | null) => { ref.current = node; }, controls: media.kind==='video', preload: 'metadata', src: media.url, 'aria-label': '原始音视频', onLoadedMetadata: () => { const player = ref.current; if (!player)
            return; setDuration(player.duration); player.playbackRate = rate; if (pending.current)
            apply(pending.current); }, onTimeUpdate: () => { if (ref.current)
            {onTime(ref.current.currentTime);setCurrentTime(ref.current.currentTime);}if(Date.now()-lastProgress.current>=5000)flush(); }, onPlay:()=>{setPlaying(true);setError('');if(!controller.current?.getState().range)engaged.current=true;},onSeeking:()=>{if(!controller.current?.getState().range)engaged.current=true;},onDurationChange:()=>{if(ref.current)setDuration(ref.current.duration);}, onPause: () => {playAttempt.current++;setPlaying(false);flush();}, onEnded:()=>setPlaying(false), onRateChange:()=>{if(ref.current)setRate(ref.current.playbackRate);}, onError: () => {setPlaying(false);setError('原始媒体无法播放，可能已失效或格式不受支持。文字稿、笔记与书签仍保留。');} };
    const resumeValid=resumePosition&&resumePosition.identity===media.identity&&Number.isFinite(resumePosition.time)&&Number.isFinite(resumePosition.duration)&&Number.isFinite(duration)&&duration>=15&&Math.abs(resumePosition.duration-duration)<1&&resumePosition.time>=5&&resumePosition.time<duration-3;
    const ready=Number.isFinite(duration)&&duration>0;
    const move=(seconds:number)=>{const player=ref.current;if(!player||!ready)return;playAttempt.current++;controller.current?.cancel();pending.current=null;engaged.current=true;player.currentTime=Math.max(0,Math.min(duration,seconds));setCurrentTime(player.currentTime);onTime(player.currentTime);};
    const toggle=()=>{const player=ref.current;if(!player)return;const attempt=++playAttempt.current;if(!player.paused){player.pause();return;}setError('');void player.play().catch(reason=>{if(ref.current===player&&playAttempt.current===attempt&&reason?.name!=='AbortError')setError('播放未能开始，请重试播放按钮。');});};
    return <section className="rw-player" aria-label="常驻播放控制">
        {media.kind==='audio'?<audio {...props}/>:<details className="rw-player-video"><summary>查看视频</summary><video {...props}/></details>}
        <div className="rw-player-main">
            <button type="button" className="rw-player-skip" aria-label="后退 15 秒" disabled={!ready} onClick={()=>move((ref.current?.currentTime||0)-15)}>↶<small>15</small></button>
            <button type="button" className="rw-player-play" aria-label={playing?'暂停播放':'播放原声'} onClick={toggle}>{playing?<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM14 5h4v14h-4z"/></svg>:<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>}</button>
            <button type="button" className="rw-player-skip" aria-label="前进 15 秒" disabled={!ready} onClick={()=>move((ref.current?.currentTime||0)+15)}>↷<small>15</small></button>
            <div className="rw-player-track"><span className="rw-player-name" title={media.name}>{media.name}</span><div className="rw-player-timeline"><span>{time(currentTime)}</span><input type="range" min="0" max={ready?duration:0} step="0.1" value={ready?Math.min(currentTime,duration):0} disabled={!ready} aria-label="播放进度" aria-valuetext={time(currentTime)+' / '+time(ready?duration:0)} onChange={event=>move(Number(event.target.value))}/><span>{time(ready?duration:0)}</span></div></div>
            <label className="rw-player-rate"><span className="rw-sr-only">播放速度</span><select aria-label="播放速度" value={rate} onChange={event=>{const next=Number(event.target.value);setRate(next);if(ref.current)ref.current.playbackRate=next;}}>{[.5,.75,1,1.25,1.5,2].map(n=><option key={n} value={n}>{n}×</option>)}</select></label>
            <button type="button" className="rw-player-locate" disabled={!onLocate} onClick={onLocate} title="定位当前原话">◎ <span>定位原文</span></button>
            {onFollow&&canFollow&&<label className="rw-player-follow"><input type="checkbox" checked={follow} onChange={event=>onFollow(event.target.checked)}/> 跟随播放</label>}
            <details className="rw-player-options"><summary>更多</summary><div className="rw-player-options-body">
                {onFollow&&canFollow&&<label className="rw-player-follow-options"><input type="checkbox" checked={follow} onChange={event=>onFollow(event.target.checked)}/> 跟随播放</label>}
                {resumeValid&&onResume&&<button type="button" onClick={()=>onResume(resumePosition!.time)}>继续收听 {time(resumePosition!.time)} · 仅定位</button>}
                <label><input type="checkbox" checked={repeat} onChange={e => { setRepeat(e.target.checked); repeatRef.current = e.target.checked; }}/> 循环所选回听范围</label><button type="button" onClick={() => { cancelledIntent.current=Math.max(cancelledIntent.current,lastIntent.current);pending.current=null;repeatRef.current=false;setRepeat(false);flush();transition.current=true;try{controller.current?.cancel();ref.current?.pause();}finally{transition.current=false;} }}>停止回听</button>{playback?.returnPosition && <><button onClick={() => { repeatRef.current = false; setRepeat(false); transition.current = true; void controller.current?.returnToPrevious().finally(() => { transition.current = false; flush(); }); }}>回到回听前的位置</button><button onClick={() => { repeatRef.current = false; setRepeat(false); void controller.current?.continue(); }}>从这里继续播放</button></>}
                {media.availability === 'local_session' && <p>原文件仅在此页面读取，未上传。刷新后需重新选择原文件。</p>}
            </div></details>
        </div>{error&&<p role="alert">{error}</p>}
    </section>;
}
