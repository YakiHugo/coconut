import { useEffect, useRef, type RefObject } from 'react';
export type ReadingKeyboardActions = Partial<Record<'find' | 'help' | 'back' | 'forward' | 'play' | 'locate', () => boolean | void>>;
export interface ReadingKeyboardOptions {
  scopeRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  active: boolean;
  actions: ReadingKeyboardActions;
  searchRef?: RefObject<HTMLInputElement | null>;
}
// Callbacks are the existing reader commands. This helper never creates a
// playback owner, queries legacy controls, or captures keys outside the reader.
export function useReaderKeyboard(options: ReadingKeyboardOptions) {
  const latest = useRef(options); latest.current = options;
  useEffect(() => {
    let composing = false;
    const start = () => { composing = true; }, end = () => { composing = false; };
    const keydown = (event: KeyboardEvent) => {
      const { scopeRef, searchRef, enabled, active, actions } = latest.current;
      const scope = scopeRef.current;
      if (!active || !scope || scope.closest('[hidden],[inert],[aria-hidden="true"]') || document.hidden || document.designMode === 'on' || event.defaultPrevented || event.repeat || composing || event.isComposing || event.keyCode === 229 || event.altKey || event.getModifierState?.('AltGraph')) return;
      if (document.querySelector('dialog[open]') || [...document.querySelectorAll('[aria-modal="true"]')].some(node => !node.closest('[hidden],[aria-hidden="true"]'))) return;
      const find = event.key.toLowerCase() === 'f' && event.ctrlKey !== event.metaKey && !event.shiftKey;
      if (!find && (event.ctrlKey || event.metaKey || !enabled)) return;
      const allowed = (node: EventTarget | null) => {
        if (!(node instanceof HTMLElement) || !scope.contains(node)) return false;
        for (let current: HTMLElement | null = node; current; current = current.parentElement) {
          if (current.isContentEditable || (current.hasAttribute('contenteditable') && current.getAttribute('contenteditable') !== 'false')) return false;
        }
        if (node.shadowRoot?.activeElement) return false;
        const controls = find ? 'textarea,select,audio,video,iframe,object,embed,[inert],[role]:not([role="group"])' : 'input,textarea,select,button,a,summary,audio,video,iframe,object,embed,[inert],[role]';
        return !node.closest(controls) && !(find && node.closest('input') && node !== searchRef?.current);
      };
      if (![document.activeElement, event.target, event.composedPath()[0]].every(allowed)) return;
      const key = event.key.toLowerCase();
      if (!find && event.shiftKey && key !== '?') return;
      const commands: Record<string, keyof ReadingKeyboardActions> = { '/': 'find', '?': 'help', j: 'back', l: 'forward', k: 'play', g: 'locate' };
      const command = find ? 'find' : commands[key];
      const action = command && actions[command];
      if (action && action() !== false) event.preventDefault();
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('compositionstart', start);
    document.addEventListener('compositionend', end);
    window.addEventListener('blur', end);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('compositionstart', start);
      document.removeEventListener('compositionend', end);
      window.removeEventListener('blur', end);
    };
  }, []);
}
