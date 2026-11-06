import { useEffect, useRef, useState } from 'react';
import type { ReaderMedia } from './contracts';
import {ChoicePicker} from './controls';
import { time } from './domain';
export const PLAYBACK_RATES = [.5, .75, 1, 1.25, 1.5, 2];
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
export function ReaderPlayer({ media, seek, onTime, onProgress }: {
    media: ReaderMedia;
    seek: SeekIntent | null;
    onTime: (seconds: number) => void;
    onProgress?: (seconds: number, duration: number) => void;
}) {
    const ref = useRef<HTMLMediaElement | null>(null), controller = useRef<PlaybackController | null>(null), pending = useRef<SeekIntent | null>(null), transition = useRef(false), progress = useRef(onProgress), lastIntent=useRef(0), cancelledIntent=useRef(0),engaged=useRef(false),lastProgress=useRef(0),playAttempt=useRef(0);
    progress.current = onProgress;
    const [error, setError] = useState(''), [duration, setDuration] = useState(0), [rate, setRate] = useState(1), [playing,setPlaying]=useState(false), [currentTime,setCurrentTime]=useState(0);
    const flush = (player = ref.current) => { if (!player || !Number.isFinite(player.duration) || transition.current || !engaged.current || player.seeking)
        return; const origin = controller.current?.getState().returnPosition; progress.current?.(origin?.time ?? player.currentTime, player.duration);lastProgress.current=Date.now(); };
    useEffect(() => {
        const api = (window as unknown as {
            CoconutPassagePlayback: PlaybackDomain;
        }).CoconutPassagePlayback;
        const engine = api.create({ getPlayer: () => ref.current, getDocumentKey: () => media.identity, onChange: state => { if (state.error) setError(state.error); } });
        controller.current = engine;
        const player = ref.current, leave = () => { flush(player);cancelledIntent.current=Math.max(cancelledIntent.current,lastIntent.current);pending.current=null;transition.current=true;try{engine.cancel();player?.pause();}finally{transition.current=false;} };
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
        const attempt=++playAttempt.current;
        player.currentTime = intent.seconds;
        if (intent.play)
            void player.play().catch(reason => {if(ref.current===player&&playAttempt.current===attempt&&reason?.name!=='AbortError')setError('播放未能开始，请使用播放器播放按钮。');});
    } };
    useEffect(() => { if (seek)
        apply(seek); }, [seek]);
    const props = { ref: (node: HTMLMediaElement | null) => { ref.current = node; }, controls: media.kind==='video', preload: 'metadata', src: media.url, 'aria-label': '原始音视频', onLoadedMetadata: () => { const player = ref.current; if (!player)
            return; setDuration(player.duration); player.playbackRate = rate; if (pending.current)
            apply(pending.current); }, onTimeUpdate: () => { if (ref.current)
            {onTime(ref.current.currentTime);setCurrentTime(ref.current.currentTime);}if(Date.now()-lastProgress.current>=5000)flush(); }, onPlay:()=>{setPlaying(true);setError('');if(!controller.current?.getState().range)engaged.current=true;},onSeeking:()=>{if(!controller.current?.getState().range)engaged.current=true;},onDurationChange:()=>{if(ref.current)setDuration(ref.current.duration);}, onPause: () => {playAttempt.current++;setPlaying(false);flush();}, onEnded:()=>setPlaying(false), onRateChange:()=>{if(ref.current)setRate(ref.current.playbackRate);}, onError: () => {setPlaying(false);setError('原始媒体无法播放，可能已失效或格式不受支持。文字稿、笔记与书签仍保留。');} };
    const ready=Number.isFinite(duration)&&duration>0;
    const move=(seconds:number)=>{const player=ref.current;if(!player||!ready)return;playAttempt.current++;controller.current?.cancel();pending.current=null;engaged.current=true;player.currentTime=Math.max(0,Math.min(duration,seconds));setCurrentTime(player.currentTime);onTime(player.currentTime);};
    const toggle=()=>{const player=ref.current;if(!player)return;const attempt=++playAttempt.current;if(!player.paused){player.pause();return;}setError('');void player.play().catch(reason=>{if(ref.current===player&&playAttempt.current===attempt&&reason?.name!=='AbortError')setError('播放未能开始，请重试播放按钮。');});};
    const changeRate=(value:string)=>{const next=Number(value);if(ref.current)ref.current.playbackRate=next;setRate(next);};
    return <section className="rw-player" aria-label="常驻播放控制">
        {media.kind==='audio'?<audio {...props}/>:<video className="rw-player-video" {...props}/>}
        <div className="rw-player-main">
            <button type="button" className="rw-player-play" aria-label={playing?'暂停播放':'播放原声'} title={playing?'暂停 · 空格 / K':'播放 · 空格 / K'} onClick={toggle}>{playing?<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM14 5h4v14h-4z"/></svg>:<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>}</button>
            <div className="rw-player-track">
                <input className="rw-player-progress" type="range" min="0" max={ready?duration:0} step="0.1" value={ready?Math.min(currentTime,duration):0} disabled={!ready} aria-label="播放进度" aria-valuetext={time(currentTime)+' / '+time(ready?duration:0)} style={{backgroundSize:(ready?Math.min(100,currentTime/duration*100):0)+'% 4px'}} onKeyDown={event=>{
            if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.nativeEvent.isComposing)return;
            if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();move((ref.current?.currentTime||0)+(event.key==='ArrowRight'?5:-5));}
        }} onChange={event=>move(Number(event.target.value))}/>
                <div className="rw-player-time" aria-label="播放时间"><span>{time(currentTime)}</span><span>{time(ready?duration:0)}</span></div>
            </div>
            <div className="rw-player-rate"><ChoicePicker label="播放速度" value={String(rate)} options={PLAYBACK_RATES.map(n=>({value:String(n),label:n+'×'}))} onChange={changeRate}/></div>
        </div>{error&&<p role="alert">{error}</p>}
    </section>;
}
