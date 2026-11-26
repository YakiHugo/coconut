import {useLayoutEffect, useRef, type RefObject} from 'react';
import type {ReaderView} from './contracts';

export type ReadingPosition = Pick<ReaderView, 'cueId' | 'speechFrom'>;

export function readingScrollContainer(host: HTMLElement) {
    const main = host.closest<HTMLElement>('#main-content');
    return main && /^(auto|scroll)$/.test(window.getComputedStyle(main).overflowY) ? main : window;
}

function scrollTop(scroller: HTMLElement | Window) {
    return scroller instanceof HTMLElement ? scroller.scrollTop : scroller.scrollY;
}

export function readingBounds(host: HTMLElement, scroller: HTMLElement | Window) {
    const workspace = host.closest('.reader-workspace');
    const viewportTop = scroller instanceof HTMLElement ? scroller.getBoundingClientRect().top : 0;
    const tabs = workspace?.querySelector<HTMLElement>('.rw-content-switch');
    const search = workspace?.querySelector<HTMLElement>('.rw-search-panel:not([hidden])');
    const stickyBottom = (element: HTMLElement) => viewportTop
        + (Number.parseFloat(window.getComputedStyle(element).top) || 0) + element.getBoundingClientRect().height;
    const top = Math.max(tabs ? stickyBottom(tabs) : viewportTop, search ? stickyBottom(search) : viewportTop);
    const player = workspace?.querySelector('.rw-player')?.getBoundingClientRect();
    const bottom = Math.min(window.innerHeight, scroller instanceof HTMLElement ? scroller.getBoundingClientRect().bottom : Infinity,
        player && player.height > 0 ? player.top : Infinity);
    return {top, bottom};
}

export function readingPosition(cue: HTMLElement, speech = cue): ReadingPosition {
    const cueId = cue.dataset.sourceId!;
    const speechFrom = Number(speech.dataset.speechFrom);
    return speechFrom > 0 ? {cueId, speechFrom} : {cueId};
}

function visiblePosition(host: HTMLElement, scroller: HTMLElement | Window): ReadingPosition | undefined {
    const firstChild = host.firstElementChild;
    const rows = firstChild?.classList.contains('rw-passages') ? firstChild.children : host.children;
    if (!rows.length) return;
    const {top, bottom} = readingBounds(host, scroller);
    // Only measure the rows near the reading edge, including in long transcripts.
    let low = 0, high = rows.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (rows[middle].getBoundingClientRect().bottom <= top) low = middle + 1;
        else high = middle;
    }
    for (let index = low; index < rows.length; index++) {
        if (rows[index].getBoundingClientRect().top >= bottom) break;
        for (const paragraph of rows[index].querySelectorAll<HTMLElement>('.rw-original')) {
            const rect = paragraph.getBoundingClientRect();
            if (rect.bottom <= top || rect.top >= bottom) continue;
            const cues = paragraph.matches('[data-source-id]') ? [paragraph] : paragraph.querySelectorAll<HTMLElement>('[data-source-id]');
            for (const cue of cues) {
                if (cue.textContent?.trim()) return readingPosition(cue, cue.querySelector<HTMLElement>('[data-speech-from]') ?? cue);
            }
        }
    }
}

export function useReadingPosition(host: RefObject<HTMLDivElement | null>, mode: Exclude<ReaderView['mode'], 'summary'> | null,
    canCapture: () => boolean, save: (position: ReadingPosition, mode: ReaderView['mode']) => void) {
    const callbacks = useRef({canCapture, save});
    callbacks.current = {canCapture, save};
    const syncScroll = useRef<{reset: () => void; flush: () => void} | null>(null);

    useLayoutEffect(() => {
        const root = host.current;
        if (!root || !mode) return;
        const scroller = readingScrollContainer(root);
        let previous = scrollTop(scroller);
        let pending: ReadingPosition | undefined;
        let timer = 0;
        const flush = () => {
            window.clearTimeout(timer);
            if (pending) callbacks.current.save(pending, mode);
            pending = undefined;
        };
        const capture = () => {
            const next = scrollTop(scroller);
            if (next === previous) return;
            previous = next;
            if (!callbacks.current.canCapture()) return;
            pending = visiblePosition(root, scroller) ?? pending;
            window.clearTimeout(timer);
            timer = window.setTimeout(flush, 160);
        };
        const saveBeforeLeaving = () => { capture(); flush(); };
        const visibilityChanged = () => {
            if (document.visibilityState === 'hidden') saveBeforeLeaving();
        };
        syncScroll.current = {
            reset: () => {
                previous = scrollTop(scroller);
                pending = undefined;
                window.clearTimeout(timer);
            },
            flush: saveBeforeLeaving,
        };
        scroller.addEventListener('scroll', capture, {passive: true});
        window.addEventListener('pagehide', saveBeforeLeaving);
        document.addEventListener('visibilitychange', visibilityChanged);
        return () => {
            flush();
            syncScroll.current = null;
            scroller.removeEventListener('scroll', capture);
            window.removeEventListener('pagehide', saveBeforeLeaving);
            document.removeEventListener('visibilitychange', visibilityChanged);
        };
    }, [host, mode]);

    return syncScroll;
}
