/* Small, independent local display preferences. Runs before CSS to avoid a
 * bright first paint after the reader has explicitly selected a dark theme.
 * This file must never read or write document/library data or contact a service. */
(function (root) {
 'use strict';
 const settings = {
  theme: {key:'coconut-reading-theme-v1', values:['light','dark','system'], fallback:'light', control:'reading-theme'},
  measure: {key:'coconut-reading-measure-v1', values:['full','narrow'], fallback:'full', control:'reading-measure'},
 };
 const state = {}, unsaved = new Set();
 const normalize = (setting,value) => setting.values.includes(value) ? value : setting.fallback;
 let media = null, unavailable = false;
 try { media = root.matchMedia('(prefers-color-scheme: dark)'); } catch { /* Explicit light/dark still work. */ }
 for (const [name,setting] of Object.entries(settings)) {
  try { state[name] = normalize(setting,root.localStorage.getItem(setting.key)); }
  catch { state[name] = setting.fallback; unavailable = true; }
 }
 function apply() {
  const theme = state.theme === 'system' ? (media?.matches ? 'dark' : 'light') : state.theme;
  root.document.documentElement.dataset.readerTheme = theme;
  root.document.documentElement.dataset.readingMeasure = state.measure;
  const color = root.document.querySelector('meta[name="theme-color"]');
  if (color) color.content = theme === 'dark' ? '#211f1d' : '#faf9f7';
  for (const [name,setting] of Object.entries(settings)) {
   const control = root.document.getElementById(setting.control);
   if (control) control.value = state[name];
  }
 }
 function status(text) {
  const node = root.document.getElementById('appearance-status');
  if (node) node.textContent = text;
 }
 function change(name,value) {
  const setting = settings[name];
  if (!setting) return;
  state[name] = normalize(setting,value);
  apply();
  try {
   root.localStorage.setItem(setting.key,state[name]);
   unsaved.delete(name);
   status(unsaved.size ? '部分显示偏好仍只在本页生效，浏览器未能保存；请重新选择后重试。' : '显示偏好已保存在此浏览器');
  } catch {
   unsaved.add(name);
   status('本次显示已应用，浏览器未能保存偏好；下次打开可能恢复默认。');
  }
 }
 apply();
 const systemChanged = () => { if (state.theme === 'system') apply(); };
 if (media?.addEventListener) media.addEventListener('change',systemChanged);
 else if (media?.addListener) media.addListener(systemChanged);
 // A second window may change a small preference. It does not invalidate or
 // save this window's document, draft, selection, playback, or reading marker.
 root.addEventListener('storage',event => {
  if (event.storageArea) {
   try { if (event.storageArea !== root.localStorage) return; } catch { return; }
  }
  if (event.key === null) {
   for (const [name,setting] of Object.entries(settings)) state[name] = setting.fallback;
   unsaved.clear();
  } else {
   const name = Object.keys(settings).find(name => settings[name].key === event.key);
   if (!name) return;
   state[name] = normalize(settings[name],event.newValue);
   unsaved.delete(name);
  }
  apply();
  status(unsaved.size ? '其他显示偏好仍只在本页生效；请重新选择后重试保存。' : '显示偏好已与另一窗口同步');
 });
 function connect() {
  apply();
  for (const [name,setting] of Object.entries(settings)) {
   const control = root.document.getElementById(setting.control);
   if (control) control.onchange = () => change(name,control.value);
  }
  if (unavailable) status('浏览器未能读取显示偏好，已使用默认；本页仍可调整。');
 }
 if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded',connect,{once:true});
 else connect();
})(window);
