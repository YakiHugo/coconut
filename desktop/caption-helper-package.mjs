/** Build-time only: merge audited native receipts into app.asar, then stage resources. */
import {createHash} from 'node:crypto';
import {readFile,cp,chmod,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function loadCaptionHelperBuild(directory,{platform,arch,lockBytes}) {
  const entries=await readdir(directory);const allowed=new Set(['coconut-caption','receipt.json','notices','sources']);
  if(entries.length!==allowed.size || entries.some(name=>!allowed.has(name)))throw new Error('Unexpected helper build files');
  for(const name of entries)if((await lstat(path.join(directory,name))).isSymbolicLink())throw new Error('Helper build may not contain top-level symlinks');
  const receipt=JSON.parse(await readFile(path.join(directory,'receipt.json'),'utf8')),lock=JSON.parse(lockBytes);
  const bytes=await readFile(path.join(directory,'coconut-caption'));
  if(receipt.name!=='coconut-caption'||receipt.platform!==platform||receipt.arch!==arch||receipt.protocol!==1||
     receipt.python!==lock.python||receipt.pyinstaller!==lock.pyinstaller||receipt.ytDlpVersion!==lock.ytDlpVersion||
     receipt.distribution!=='minimal-permissive-with-certifi-source'||receipt.lockSha256!==digest(lockBytes)||
     receipt.bytes!==bytes.length||receipt.sha256!==digest(bytes))throw new Error('Native caption helper build receipt mismatch');
  return receipt;
}
export async function stageCaptionHelper(directory,resourcesPath) {
  const target=path.join(resourcesPath,'caption-helper');
  await cp(directory,target,{recursive:true,errorOnExist:true,force:false});
  await chmod(path.join(target,'coconut-caption'),0o500);
}
