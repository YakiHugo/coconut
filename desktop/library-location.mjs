/** Stable storage roots. Explicit overrides must be absolute, never cwd-relative. */
import path from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
export const DEVELOPMENT_LIBRARY_DIRECTORY=fileURLToPath(new URL('../.coconut/dev/library',import.meta.url));
export function libraryLocation({mode, userDataDirectory, directory=process.env.COCONUT_LIBRARY_DIRECTORY}={}){
 const selected=directory|| (mode==='desktop'?path.join(userDataDirectory,'library'):mode==='development'?DEVELOPMENT_LIBRARY_DIRECTORY:path.join(homedir(),'.coconut','library'));
 return {mode,directory:selected};
}
export function libraryStartupMessage(location,status){
 return `统一书架（${location.mode}）：${location.directory}\n${status.enabled?'统一书架可用；在书架工具中明确确认迁移后才启用，浏览器原始数据会保留。':`统一书架不可用（${status.unavailable?.code||'library_disabled'}）；仍可独立阅读，浏览器数据保持原样。请使用 Node.js 22.13+，并检查目录为绝对路径、私有且未被其他服务占用。`}\n桌面、开发和轻量 CLI 默认使用不同书架目录；切换入口不会自动迁移数据。`;
}
