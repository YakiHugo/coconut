import type { KeyboardEvent } from 'react';

export type ReadingMode = 'passages' | 'transcript' | 'summary';
const modes: { value: ReadingMode; label: string; path: string }[] = [
    { value: 'passages', label: '文字稿', path: 'M4 4h16v16H4z M8 9h8 M8 13h8 M8 17h4' },
    { value: 'transcript', label: '逐句校对', path: 'M4 6h3 M11 6h9 M4 12h3 M11 12h9 M4 18h3 M11 18h9' },
    { value: 'summary', label: '摘要', path: 'M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h4' },
];

export function ReadingModeTabs({ mode, id, onChange }: { mode: ReadingMode; id: string; onChange: (mode: ReadingMode) => void }) {
    const move = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
        const index = modes.findIndex(item => item.value === mode);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? modes.length - 1
            : event.key === 'ArrowRight' ? (index + 1) % modes.length
            : event.key === 'ArrowLeft' ? (index + modes.length - 1) % modes.length : -1;
        if (next < 0) return;
        event.preventDefault();
        onChange(modes[next].value);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
    };
    return <div className="rw-mode-tabs" role="tablist" aria-label="阅读内容" onKeyDown={move}>{modes.map(item =>
        <button key={item.value} type="button" role="tab" id={`${id}-${item.value}`} aria-controls={`${id}-panel`}
            aria-selected={mode === item.value} tabIndex={mode === item.value ? 0 : -1} data-mode={item.value}
            onClick={() => { if (mode !== item.value) onChange(item.value); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={item.path}/></svg>{item.label}
        </button>
    )}</div>;
}
