import React, {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';

type Notice = {message: string; tone?: 'info' | 'error'};
const ToastContext = createContext<(notice: Notice) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({children}: {children: React.ReactNode}) {
    const [notice, setNotice] = useState<(Notice & {id: number}) | null>(null);
    const [paused, setPaused] = useState(false), sequence = useRef(0);
    const notify = useCallback((value: Notice) => {setPaused(false);setNotice({...value, id: ++sequence.current});}, []);
    useEffect(() => {
        if (!notice || paused) return;
        const timer = window.setTimeout(() => setNotice(null), notice.tone === 'error' ? 8000 : 6000);
        return () => window.clearTimeout(timer);
    }, [notice, paused]);
    return <ToastContext.Provider value={notify}>{children}<div className="toast-region" aria-label="操作提示">
        {notice && <div key={notice.id} className="app-toast" data-tone={notice.tone || 'info'} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={event => {if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);}}>
            <span className="toast-icon" aria-hidden="true">{notice.tone === 'error' ? '!' : 'i'}</span>
            <p role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.message}</p>
            <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>×</button>
        </div>}
    </div></ToastContext.Provider>;
}
