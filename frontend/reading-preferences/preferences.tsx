import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {ChoicePicker} from '../reader-workspace/controls';

export const preferenceSettings = {
  chineseScript: { key: 'coconut-reading-chinese-script-v1', values: ['system', 'zh-Hans', 'zh-Hant', 'source'], fallback: 'system' },
  theme: { key: 'coconut-reading-theme-v1', values: ['light', 'dark', 'system'], fallback: 'light' },
  measure: { key: 'coconut-reading-measure-v1', values: ['full', 'narrow'], fallback: 'full' },
  layout: { key: 'coconut-reading-layout-v1', values: ['standard', 'large', 'spacious'], fallback: 'standard' },
  shortcuts: { key: 'coconut-reading-shortcuts-v1', values: ['on', 'off'], fallback: 'on' },
} as const;
export type PreferenceName = keyof typeof preferenceSettings;
export type ReadingPreferenceValues = Record<PreferenceName, string>;
const names = Object.keys(preferenceSettings) as PreferenceName[];
function normalize(name: PreferenceName, value: string | null) {
  const setting = preferenceSettings[name];
  return (setting.values as readonly string[]).includes(value || '') ? value! : setting.fallback;
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
      setStatus(unsaved.current.size ? '其他偏好仍只在本页生效，请重新选择后重试保存。' : '阅读偏好已与另一窗口同步');
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
      setStatus(unsaved.current.size ? '部分偏好仍只在本页生效，请重新选择后重试保存。' : '阅读偏好已保存在此浏览器');
    } catch {
      unsaved.current.add(name);
      setStatus('本次设置已生效，但浏览器未能保存；下次打开可能恢复原设置。');
    }
  }
  return { values, status, change };
}
export type ReadingPreferencesController = ReturnType<typeof useReadingPreferences>;
export function ReadingPreferences({ controller,expanded=false }: { controller: ReadingPreferencesController;expanded?:boolean }) {
  const { values, status, change } = controller;
  return <section className="reading-preferences" aria-label="阅读偏好">
    {!expanded&&<h3>阅读偏好</h3>}
    <div className="reading-preferences-options">
      <ChoicePicker label="中文显示" value={values.chineseScript} onChange={value=>change('chineseScript',value)} options={[{value:'system',label:'跟随系统语言'},{value:'zh-Hans',label:'简体中文'},{value:'zh-Hant',label:'繁體中文'},{value:'source',label:'保留原文字形'}]}/>
      <ChoicePicker label="主题" value={values.theme} onChange={value=>change('theme',value)} options={[{value:'light',label:'浅色'},{value:'dark',label:'深色'},{value:'system',label:'跟随系统'}]}/>
      <ChoicePicker label="行宽" value={values.measure} onChange={value=>change('measure',value)} options={[{value:'full',label:'完整宽度'},{value:'narrow',label:'窄行'}]}/>
      <ChoicePicker label="阅读排版" value={values.layout} onChange={value=>change('layout',value)} options={[{value:'standard',label:'标准'},{value:'large',label:'大字'},{value:'spacious',label:'大字 · 宽松行距'}]}/>
      <label><input type="checkbox" checked={values.shortcuts !== 'off'} onChange={event => change('shortcuts', event.target.checked ? 'on' : 'off')} />启用单字符阅读快捷键</label>
    </div>
    <p role="status">{status}</p>
  </section>;
}
