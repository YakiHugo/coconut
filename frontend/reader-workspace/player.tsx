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
export function ReaderPlayer({ media, seek, onTime, onProgress, resumePosition, onResume }: {
    media: ReaderMedia;
    resumePosition?:ReaderResumePosition|null;
    onResume?:(seconds:number)=>void;
    seek: SeekIntent | null;
    onTime: (seconds: number) => void;
    onProgress?: (seconds: number, duration: number) => void;
}) {
    const ref = useRef<HTMLMediaElement | null>(null), controller = useRef<PlaybackController | null>(null), pending = useRef<SeekIntent | null>(null), repeatRef = useRef(false), transition = useRef(false), progress = useRef(onProgress), lastIntent=useRef(0), cancelledIntent=useRef(0),engaged=useRef(false),lastProgress=useRef(0);
    progress.current = onProgress;
    const [error, setError] = useState(''), [duration, setDuration] = useState(0), [rate, setRate] = useState(1), [repeat, setRepeat] = useState(false), [playback, setPlayback] = useState<PlaybackState | null>(null);
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
    const props = { ref: (node: HTMLMediaElement | null) => { ref.current = node; }, controls: true, preload: 'metadata', src: media.url, 'aria-label': '原始音视频', onLoadedMetadata: () => { const player = ref.current; if (!player)
            return; setDuration(player.duration); player.playbackRate = rate; if (pending.current)
            apply(pending.current); }, onTimeUpdate: () => { if (ref.current)
            onTime(ref.current.currentTime);if(Date.now()-lastProgress.current>=5000)flush(); }, onPlay:()=>{if(!controller.current?.getState().range)engaged.current=true;},onSeeking:()=>{if(!controller.current?.getState().range)engaged.current=true;},onDurationChange:()=>{if(ref.current)setDuration(ref.current.duration);}, onPause: () => flush(), onError: () => setError('原始媒体无法播放，可能已失效或格式不受支持。文字稿、笔记与书签仍保留。') };
    const resumeValid=resumePosition&&resumePosition.identity===media.identity&&Number.isFinite(resumePosition.time)&&Number.isFinite(resumePosition.duration)&&Number.isFinite(duration)&&duration>=15&&Math.abs(resumePosition.duration-duration)<1&&resumePosition.time>=5&&resumePosition.time<duration-3;
    return <section className="rw-player">{media.kind === 'video' ? <video {...props}/> : <audio {...props}/>}<div>{resumeValid&&onResume&&<button type="button" onClick={()=>onResume(resumePosition!.time)}>继续收听 {time(resumePosition!.time)} · 仅定位</button>}<span>{media.name} {duration > 0 ? `· ${time(duration)}` : ''}</span><label>播放速度<select value={rate} onChange={e => { const next = Number(e.target.value); setRate(next); if (ref.current)
        ref.current.playbackRate = next; }}>{[.5, .75, 1, 1.25, 1.5, 2].map(n => <option key={n} value={n}>{n}×</option>)}</select></label><label><input type="checkbox" checked={repeat} onChange={e => { setRepeat(e.target.checked); repeatRef.current = e.target.checked; }}/> 循环所选回听范围</label><button type="button" onClick={() => { cancelledIntent.current=Math.max(cancelledIntent.current,lastIntent.current);pending.current=null;repeatRef.current=false;setRepeat(false);flush();transition.current=true;try{controller.current?.cancel();ref.current?.pause();}finally{transition.current=false;} }}>停止回听</button>{playback?.returnPosition && <><button onClick={() => { repeatRef.current = false; setRepeat(false); transition.current = true; void controller.current?.returnToPrevious().finally(() => { transition.current = false; flush(); }); }}>回到回听前的位置</button><button onClick={() => { repeatRef.current = false; setRepeat(false); void controller.current?.continue(); }}>从这里继续播放</button></>}</div>{media.availability === 'local_session' && <p>原文件仅在此页面读取，未上传。刷新后需重新选择原文件。</p>}{error && <p role="alert">{error}</p>}</section>;
}
