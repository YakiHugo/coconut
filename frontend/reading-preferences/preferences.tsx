import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {ChoicePicker, type Choice} from '../reader-workspace/controls';

const maxFontNameLength = 120;
const fallbackFontFamilies = ['Georgia', 'Inter', 'LXGW WenKai', 'PingFang SC', 'Songti SC'];
const fontOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const fontOptionPrefix = 'font:';
const customFontOption = 'custom';
type FontAccessWindow = Window & { queryLocalFonts?: () => Promise<{ family: string }[]> };
export const preferenceSettings = {
  chineseScript: { key: 'coconut-reading-chinese-script-v1', values: ['system', 'zh-Hans', 'zh-Hant', 'source'], fallback: 'system' },
  theme: { key: 'coconut-reading-theme-v1', values: ['light', 'dark', 'system'], fallback: 'light' },
  measure: { key: 'coconut-reading-measure-v1', values: ['full', 'narrow'], fallback: 'full' },
  layout: { key: 'coconut-reading-layout-v1', values: ['standard', 'large', 'spacious'], fallback: 'standard' },
  fontFamily: { key: 'coconut-reading-font-family-v1', fallback: '' },
  shortcuts: { key: 'coconut-reading-shortcuts-v1', values: ['on', 'off'], fallback: 'on' },
} as const;
export type PreferenceName = keyof typeof preferenceSettings;
export type ReadingPreferenceValues = Record<PreferenceName, string>;
const names = Object.keys(preferenceSettings) as PreferenceName[];
function normalize(name: PreferenceName, value: string | null) {
  if (name === 'fontFamily') {
    return (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxFontNameLength).trimEnd();
  }
  const setting = preferenceSettings[name];
  return (setting.values as readonly string[]).includes(value || '') ? value! : setting.fallback;
}

function readingFontFamily(name: string) {
  // Treat input as one literal installed family, including commas and quotes in names.
  return name ? `"${name.replace(/["\\]/g, '\\$&')}", var(--ui-font)` : undefined;
}

export function useReadingPreferences() {
  const [initial] = useState(() => {
    let unavailable = false;
    const values = {} as ReadingPreferenceValues;
    for (const name of names) {
      try { values[name] = normalize(name, window.localStorage.getItem(preferenceSettings[name].key)); }
      catch { values[name] = preferenceSettings[name].fallback; unavailable = true; }
    }
    return { values, unavailable };
  });
  const [values, setValues] = useState(initial.values);
  const [status, setStatus] = useState(initial.unavailable ? '浏览器未能读取显示偏好，本页仍可调整。' : '');
  const unsaved = useRef(new Set<PreferenceName>());
  const [dark, setDark] = useState(false);
  useLayoutEffect(() => {
    let media: MediaQueryList;
    try { media = window.matchMedia('(prefers-color-scheme: dark)'); } catch { return; }
    const update = () => setDark(media.matches);
    update();
    if (media.addEventListener) media.addEventListener('change', update); else media.addListener(update);
    return () => { if (media.removeEventListener) media.removeEventListener('change', update); else media.removeListener(update); };
  }, []);
  useLayoutEffect(() => {
    const theme = values.theme === 'system' ? (dark ? 'dark' : 'light') : values.theme;
    const root = window.document.documentElement;
    root.dataset.readerTheme = theme;
    root.dataset.readingMeasure = values.measure;
    root.dataset.readingLayout = values.layout;
    const fontFamily = readingFontFamily(values.fontFamily);
    if (fontFamily) root.style.setProperty('--reading-font-family', fontFamily);
    else root.style.removeProperty('--reading-font-family');
    const color = window.document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (color) color.content = theme === 'dark' ? '#211f1d' : '#faf9f7';
  }, [values, dark]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea) { try { if (event.storageArea !== window.localStorage) return; } catch { return; } }
      const name = names.find(name => preferenceSettings[name].key === event.key);
      if (event.key !== null && !name) return;
      if (name) { unsaved.current.delete(name); setValues(previous => ({ ...previous, [name]: normalize(name, event.newValue) })); }
      else { unsaved.current.clear(); setValues(Object.fromEntries(names.map(name => [name, preferenceSettings[name].fallback])) as ReadingPreferenceValues); }
      setStatus(unsaved.current.size ? '其他偏好仍只在本页生效，请重新选择后重试保存。' : '');
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  useEffect(()=>{const update=()=>setValues(previous=>({...previous}));window.addEventListener('languagechange',update);return()=>window.removeEventListener('languagechange',update);},[]);
  function change(name: PreferenceName, raw: string) {
    const value = normalize(name, raw);
    setValues(previous => ({ ...previous, [name]: value }));
    try {
      window.localStorage.setItem(preferenceSettings[name].key, value);
      unsaved.current.delete(name);
      setStatus(unsaved.current.size ? '部分偏好仍只在本页生效，请重新选择后重试保存。' : '');
    } catch {
      unsaved.current.add(name);
      setStatus('本次设置已生效，但浏览器未能保存；下次打开可能恢复原设置。');
    }
  }
  return { values, status, change };
}
export type ReadingPreferencesController = ReturnType<typeof useReadingPreferences>;

function ReadingFont({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId(), host = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [families, setFamilies] = useState<string[] | null>(null);
  const [access, setAccess] = useState<'idle' | 'loading' | 'failed'>('idle');
  const pending = useRef(false);
  const queryLocalFonts = (window as FontAccessWindow).queryLocalFonts;
  const listed = new Set(families ?? fallbackFontFamilies);
  if (value) listed.add(value);
  const options: Choice[] = [
    { value: '', label: '默认' },
    ...[...listed].sort(fontOrder.compare).map(family => ({ value: fontOptionPrefix + family, label: family })),
    { value: customFontOption, label: '自定义' },
  ];
  const selected = draft !== null ? customFontOption : value ? fontOptionPrefix + value : '';
  const name = normalize('fontFamily', draft ?? value);
  async function readLocalFonts() {
    if (!queryLocalFonts || families || pending.current) return;
    pending.current = true;
    setAccess('loading');
    try {
      const faces = await queryLocalFonts.call(window);
      const names = [...new Set(faces.map(face => normalize('fontFamily', face.family)).filter(Boolean))];
      if (names.length) setFamilies(names);
      setAccess(names.length ? 'idle' : 'failed');
    } catch {
      setAccess('failed');
    } finally {
      pending.current = false;
    }
  }
  function choose(option: string) {
    if (option === customFontOption) {
      if (draft === null) setDraft(value);
      return;
    }
    setDraft(null);
    onChange(option.slice(fontOptionPrefix.length));
  }
  return <div className="reading-font" ref={host}>
    <ChoicePicker label="阅读字体" value={selected} onChange={choose} options={options} onOpen={readLocalFonts} />
    {draft !== null && <form className="reading-font-controls" onSubmit={event => {
      event.preventDefault();
      if (!name) return;
      host.current?.querySelector<HTMLButtonElement>('[role=combobox]')?.focus();
      setDraft(null);
      onChange(name);
    }}>
      <input type="text" value={draft} onChange={event => setDraft(event.target.value)}
        aria-label="自定义字体名称" placeholder="本机字体名称" aria-describedby={id} maxLength={maxFontNameLength}
        autoComplete="off" spellCheck={false} />
      <button type="submit" disabled={!name}>应用字体</button>
    </form>}
    <p id={id} className="reading-font-hint" aria-live="polite">
      {access === 'loading' ? '正在读取本机字体…' : !queryLocalFonts ? '此浏览器无法列出本机字体，可选择「自定义」。' : access === 'failed' ? '未能读取本机字体，可重新打开列表重试或选择「自定义」。' : '本机缺少所选字体时使用默认字体。'}
    </p>
    <p className="reading-font-preview" style={{ fontFamily: readingFontFamily(name) }}>
      把听过的话，慢慢读一遍。 <span lang="en">Read at your own pace.</span>
    </p>
  </div>;
}

export function ReadingPreferences({ controller,expanded=false }: { controller: ReadingPreferencesController;expanded?:boolean }) {
  const { values, status, change } = controller;
  return <section className="reading-preferences" aria-label="阅读偏好">
    {!expanded&&<h3>阅读偏好</h3>}
    <div className="reading-preferences-options">
      <ChoicePicker label="中文显示" value={values.chineseScript} onChange={value=>change('chineseScript',value)} options={[{value:'system',label:'跟随系统语言'},{value:'zh-Hans',label:'简体中文'},{value:'zh-Hant',label:'繁體中文'},{value:'source',label:'保留原文字形'}]}/>
      <ChoicePicker label="主题" value={values.theme} onChange={value=>change('theme',value)} options={[{value:'light',label:'浅色'},{value:'dark',label:'深色'},{value:'system',label:'跟随系统'}]}/>
      <ChoicePicker label="行宽" value={values.measure} onChange={value=>change('measure',value)} options={[{value:'full',label:'完整宽度'},{value:'narrow',label:'窄行'}]}/>
      <ChoicePicker label="阅读排版" value={values.layout} onChange={value=>change('layout',value)} options={[{value:'standard',label:'标准'},{value:'large',label:'大字'},{value:'spacious',label:'大字 · 宽松行距'}]}/>
      <ReadingFont value={values.fontFamily} onChange={value => change('fontFamily', value)} />
      <label><input type="checkbox" checked={values.shortcuts !== 'off'} onChange={event => change('shortcuts', event.target.checked ? 'on' : 'off')} />启用单字符阅读快捷键</label>
    </div>
    <p role="status">{status}</p>
  </section>;
}
