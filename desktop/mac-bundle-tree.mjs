/** Only fresh build output may be signed. Preserve normal in-bundle Framework links. */
import {realpath,lstat,readdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
export const within=(root,file)=>{const relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
export async function validateFreshMacBundle(app,buildRoot) {
  if(!path.isAbsolute(app)||!path.isAbsolute(buildRoot)||path.basename(app)!=='Coconut.app'||!within(buildRoot,app))throw new Error('Signing is restricted to a fresh build bundle');
  const root=await realpath(buildRoot),actual=await realpath(app),stat=await lstat(app);
  if(!stat.isDirectory()||stat.isSymbolicLink()||!within(root,actual))throw new Error('Build bundle may not escape the build directory');
  for(const installedRoot of ['/Applications',path.join(homedir(),'Applications')]) {
    const installed=await realpath(installedRoot).catch(error=>{if(error.code==='ENOENT')return installedRoot;throw error;});
    if(within(installedRoot,app)||within(installed,actual))throw new Error('Never re-sign an installed application');
  }
  // osx-sign begins its walk at Contents. It must be an actual directory;
  // otherwise a top-level link can cause it to mutate unrelated binaries.
  const contents=await lstat(path.join(actual,'Contents'));
  if(!contents.isDirectory()||contents.isSymbolicLink())throw new Error('Bundle Contents must be a real directory');
  async function check(directory) {
    for(const name of await readdir(directory)) {
      const file=path.join(directory,name),entry=await lstat(file);
      if(entry.isSymbolicLink()) {
        const target=await realpath(file);
        if(!within(actual,target))throw new Error('Bundle symlink escapes the fresh application');
      }else if(entry.isDirectory())await check(file);
      else if(!entry.isFile())throw new Error('Bundle contains a special file');
    }
  }
  await check(actual);return actual;
}
