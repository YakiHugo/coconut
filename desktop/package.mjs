/** Explicit package allowlist: never include transcripts, auth, caches or repository metadata. */
import { packager } from '@electron/packager';
import {loadCaptionHelperBuild,stageCaptionHelper,verifyCaptionHelperResources} from './caption-helper-package.mjs';
import {signDevelopmentBundle} from './mac-signing.mjs';
import {MAC_ICON_FILE,WINDOW_ICON_FILE,verifyMacAppIcon,verifyWindowIcon} from './icon-package.mjs';
import {generateAppIcons} from '../scripts/generate-app-icons.mjs';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 1 || !['--mac','--dir'].includes(args[0])) throw new Error('Usage: node desktop/package.mjs --mac|--dir');
const mac = args[0] === '--mac';
if(mac&&process.platform!=='darwin')throw new Error('macOS packages require native macOS signing and verification');
const platform=mac?'darwin':process.platform;
const helperLockBytes=await readFile(path.join(ROOT,'caption-helper-lock.json'));
const helperArtifacts={};
if(mac)for(const arch of ['arm64','x64'])helperArtifacts[`darwin-${arch}`]=await loadCaptionHelperBuild(path.join(ROOT,'helper-build',`darwin-${arch}`),{platform:'darwin',arch,lockBytes:helperLockBytes});
const configuration = JSON.parse(await readFile(path.join(ROOT,'package.json'),'utf8'));
const work = await mkdtemp(path.join(tmpdir(),'coconut-package-'));
try {
  // Derive only from the checked-in original B; no generated binaries in Git.
  const icons=path.join(work,'icons');
  await generateAppIcons({directory:icons});
  await generateAppIcons({directory:icons,check:true});
  const app = path.join(work,'app'), resources = path.join(work,'resources'), reader = path.join(resources,'reader');
  await mkdir(app); await mkdir(reader,{recursive:true});
  for (const name of ['main.mjs','update-preload.cjs','updater.mjs','update-http.mjs','update-install.mjs','providers.mjs','server.mjs','translation.mjs','podcast-sources.mjs','podcast-xml.mjs','public-http.mjs','caption-service.mjs','caption-helper.mjs','caption-helper-process.mjs','caption-helper-lock.json']) await copyFile(path.join(ROOT,name),path.join(app,name));
  await writeFile(path.join(app,'caption-helper-artifacts.json'),JSON.stringify({schemaVersion:1,artifacts:helperArtifacts}));
  for (const name of ['index.html','summary.js','core.js','app.js','language.js','jobs.js','podcasts.js','updates.js','style.css','coconut-mark.png']) await copyFile(path.join(ROOT,'../reader',name),path.join(reader,name));
  const license = path.join(resources,'LICENSE.coconut'); await copyFile(path.join(ROOT,'../LICENSE'),license);
  const windowIcon=path.join(resources,WINDOW_ICON_FILE);
  await copyFile(path.join(icons,WINDOW_ICON_FILE),windowIcon);
  await writeFile(path.join(app,'package.json'),JSON.stringify({name:configuration.name,version:configuration.version,
    productName:configuration.productName,main:configuration.main,type:'module',license:configuration.license}));
  const output = path.join(ROOT,'dist');
  const paths = await packager({dir:app,name:'Coconut',platform,arch:mac ? ['arm64','x64'] : process.arch,
    electronVersion:configuration.devDependencies.electron,out:output,overwrite:true,asar:true,prune:false,
    appBundleId:'io.github.yakihugo.coconut',appCategoryType:'public.app-category.productivity',
    icon:platform==='darwin'?path.join(icons,MAC_ICON_FILE):platform==='win32'?path.join(icons,'coconut.ico'):undefined,
    extendInfo:{CFBundleIconFile:MAC_ICON_FILE},
    osxSign:false,osxNotarize:false,extraResource:[reader,license,windowIcon],
    download:{cacheRoot:process.env.electron_config_cache || path.join(tmpdir(),'coconut-electron-cache')}});
  for (const directory of paths) {
    if(mac||process.platform==='darwin') {
      const arch = directory.endsWith('-arm64') ? 'arm64' : 'x64';
      // Packager leaves Electron's own notices beside the .app; the ZIP contains
      // the .app alone, so preserve both notices inside its resource bundle.
      const appResources = path.join(directory,'Coconut.app/Contents/Resources');
      if(mac)await stageCaptionHelper(path.join(ROOT,'helper-build',`darwin-${arch}`),appResources,helperArtifacts[`darwin-${arch}`]);
      await copyFile(path.join(directory,'LICENSE'),path.join(appResources,'LICENSE.electron'));
      await copyFile(path.join(directory,'LICENSES.chromium.html'),path.join(appResources,'LICENSES.chromium.html'));
      if(mac)await spawnHelperVerification(appResources);
      await verifyMacAppIcon(path.join(directory,'Coconut.app'));
      // Nothing in the bundle may change after this final inside-out seal.
      await signDevelopmentBundle(path.join(directory,'Coconut.app'),{buildRoot:output,electronVersion:configuration.devDependencies.electron});
      if(mac)await verifyCaptionHelperResources(path.join(appResources,'caption-helper'),helperArtifacts[`darwin-${arch}`]);
    }else await verifyWindowIcon(path.join(directory,'resources'));
    if(mac) {
      const arch=directory.endsWith('-arm64')?'arm64':'x64';
      // Legacy asset suffix retained for updater compatibility: these are
      // ad-hoc development signatures, without a trusted Developer ID.
      const archive=path.join(output,`Coconut-${configuration.version}-${arch}-unsigned.zip`);
      await rm(archive,{force:true}); // Do not retain stale entries from an older ZIP.
      const result = process.platform === 'darwin'
        ? spawnSync('/usr/bin/ditto',['-c','-k','--keepParent',path.join(directory,'Coconut.app'),archive],{stdio:'inherit'})
        : spawnSync('zip',['-q','-r','-y',archive,'Coconut.app'],{cwd:directory,stdio:'inherit'});
      if (result.error || result.status !== 0) throw new Error('Failed to archive the unsigned app');
      console.log('Ad-hoc signed developer package (not notarized): '+archive);
    }else console.log('Unpacked developer app: '+directory);
  }
} finally { await rm(work,{recursive:true,force:true}); }

async function spawnHelperVerification(resources) {
  const result=spawnSync('/usr/bin/codesign',['--verify','--strict','--verbose=2',path.join(resources,'caption-helper/coconut-caption')],{stdio:'inherit'});
  if(result.error||result.status!==0)throw new Error('Pinned caption helper signature is invalid');
}
