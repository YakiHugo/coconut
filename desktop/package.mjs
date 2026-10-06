/** Explicit package allowlist: never include transcripts, auth, caches or repository metadata. */
import { packager } from '@electron/packager';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 1 || !['--mac','--dir'].includes(args[0])) throw new Error('Usage: node desktop/package.mjs --mac|--dir');
const mac = args[0] === '--mac';
const configuration = JSON.parse(await readFile(path.join(ROOT,'package.json'),'utf8'));
const work = await mkdtemp(path.join(tmpdir(),'coconut-package-'));
try {
  const app = path.join(work,'app'), resources = path.join(work,'resources'), reader = path.join(resources,'reader');
  await mkdir(app); await mkdir(reader,{recursive:true});
  for (const name of ['main.mjs','providers.mjs','server.mjs','translation.mjs','podcast-sources.mjs','podcast-xml.mjs','public-http.mjs']) await copyFile(path.join(ROOT,name),path.join(app,name));
  for (const name of ['index.html','summary.js','core.js','app.js','language.js','jobs.js','podcasts.js','style.css']) await copyFile(path.join(ROOT,'../reader',name),path.join(reader,name));
  const license = path.join(resources,'LICENSE.coconut'); await copyFile(path.join(ROOT,'../LICENSE'),license);
  await writeFile(path.join(app,'package.json'),JSON.stringify({name:configuration.name,version:configuration.version,
    productName:configuration.productName,main:configuration.main,type:'module',license:configuration.license}));
  const output = path.join(ROOT,'dist');
  const paths = await packager({dir:app,name:'Coconut',platform:mac ? 'darwin' : process.platform,arch:mac ? ['arm64','x64'] : process.arch,
    electronVersion:configuration.devDependencies.electron,out:output,overwrite:true,asar:true,prune:false,
    appBundleId:'io.github.yakihugo.coconut',appCategoryType:'public.app-category.productivity',
    osxSign:false,osxNotarize:false,extraResource:[reader,license],
    download:{cacheRoot:process.env.electron_config_cache || path.join(tmpdir(),'coconut-electron-cache')}});
  if (mac) {
    for (const directory of paths) {
      const arch = directory.endsWith('-arm64') ? 'arm64' : 'x64';
      const archive = path.join(output,`Coconut-${configuration.version}-${arch}-unsigned.zip`);
      // Packager leaves Electron's own notices beside the .app; the ZIP contains
      // the .app alone, so preserve both notices inside its resource bundle.
      const appResources = path.join(directory,'Coconut.app/Contents/Resources');
      await copyFile(path.join(directory,'LICENSE'),path.join(appResources,'LICENSE.electron'));
      await copyFile(path.join(directory,'LICENSES.chromium.html'),path.join(appResources,'LICENSES.chromium.html'));
      await rm(archive,{force:true}); // Do not retain stale entries from an older ZIP.
      const result = process.platform === 'darwin'
        ? spawnSync('/usr/bin/ditto',['-c','-k','--keepParent',path.join(directory,'Coconut.app'),archive],{stdio:'inherit'})
        : spawnSync('zip',['-q','-r','-y',archive,'Coconut.app'],{cwd:directory,stdio:'inherit'});
      if (result.error || result.status !== 0) throw new Error('Failed to archive the unsigned app');
      console.log('Unsigned developer package: '+archive);
    }
  } else for (const directory of paths) console.log('Unpacked developer app: '+directory);
} finally { await rm(work,{recursive:true,force:true}); }
