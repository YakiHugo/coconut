/** Build-time only: merge audited native receipts into app.asar, then stage resources. */
import {createHash} from 'node:crypto';
import {readFile,cp,chmod,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function treeHashes(directory,prefix='') {
  const entries=await readdir(directory,{withFileTypes:true});const hashes={};
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
    const filename=path.join(directory,entry.name),name=prefix+entry.name;
    if(entry.isSymbolicLink())throw new Error('Helper resource/source symlink is forbidden');
    if(entry.isDirectory())Object.assign(hashes,await treeHashes(filename,name+'/'));
    else if(entry.isFile())hashes[name]=digest(await readFile(filename));
    else throw new Error('Unexpected helper resource type');
  }
  return hashes;
}
async function inputHashes(root) {
  const names=['desktop/caption-helper-lock.json','desktop/caption-helper-requirements.txt',
    'desktop/helper/caption_helper_launcher.py','desktop/helper/coconut-caption.spec','desktop/helper/hooks/hook-yt_dlp.py',
    'scripts/build_caption_helper.py','scripts/public_x_caption_guard.py','subtitle_import.py','transcript.py','LICENSE'];
  const hashes={};for(const name of names)hashes[name]=digest(await readFile(path.join(root,name)));
  Object.assign(hashes,await treeHashes(path.join(root,'desktop/vendor/caption-helper-notices'),'desktop/vendor/caption-helper-notices/'));
  return hashes;
}
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
  const expectedInputs=await inputHashes(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
  if(!isDeepStrictEqual(receipt.inputs,expectedInputs))throw new Error('Helper source receipt mismatch');
  await verifyCaptionHelperResources(directory,receipt);
  return receipt;
}
export async function verifyCaptionHelperResources(directory,receipt) {
  const resources=await treeHashes(directory);delete resources['receipt.json'];
  const stored=JSON.parse(await readFile(path.join(directory,'receipt.json'),'utf8'));
  if(!isDeepStrictEqual(stored,receipt)||!isDeepStrictEqual(receipt.resources,resources))throw new Error('Helper resource-tree receipt mismatch');
}
export async function stageCaptionHelper(directory,resourcesPath,receipt) {
  const target=path.join(resourcesPath,'caption-helper');
  await cp(directory,target,{recursive:true,errorOnExist:true,force:false});
  await chmod(path.join(target,'coconut-caption'),0o500);
  await verifyCaptionHelperResources(target,receipt);
}
