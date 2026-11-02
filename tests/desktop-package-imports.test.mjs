/** Compile the exact packaged main-process allowlist, without launching Electron,
 * executing app code, downloading dependencies or making any source/ASR call. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../',import.meta.url));

test('every packaged main-process relative import resolves within the explicit staged allowlist',async t=>{
 const script=await readFile(path.join(root,'desktop/package.mjs'),'utf8');
 const block=script.match(/for \(const name of (\['main\.mjs'[^\]]+\])\) await copyFile\(path\.join\(ROOT,name\),path\.join\(app,name\)\)/);
 assert.ok(block,'Locate the actual packager app allowlist, not a test-owned copy');
 const names=[...block[1].matchAll(/'([^']+)'/g)].map(match=>match[1]);
 const temporary=await mkdtemp(path.join(tmpdir(),'coconut-packaged-imports-'));t.after(()=>rm(temporary,{recursive:true,force:true}));
 const directory=path.join(temporary,'app.asar');await mkdir(directory);
 for(const [folder,pattern] of [['reader',/for \(const name of (\['package.json','index.html'[^\]]+\])/],['shared',/for\(const name of (\['package.json','transcript-resources.js'[^\]]+\])/]]){
  const match=script.match(pattern);assert.ok(match,'Locate '+folder+' resource allowlist');await mkdir(path.join(temporary,folder));
  for(const [,name] of match[1].matchAll(/'([^']+)'/g))await copyFile(path.join(root,folder,name),path.join(temporary,folder,name));
 }
 for(const name of names)await copyFile(path.join(root,'desktop',name),path.join(directory,name));
 const compile=()=>build({entryPoints:[path.join(directory,'main.mjs')],bundle:true,platform:'node',format:'esm',packages:'external',write:false,logLevel:'silent'});
 assert.ok((await compile()).outputFiles[0].contents.length>0);
 // Negative controls reproduce the three observed omissions before packaging.
 // Removing any required new module must fail rather than silently externalize it.
 for(const name of ['source-network.mjs','video-audio-service.mjs','caption-helper-media.mjs']){
  await rm(path.join(directory,name));
  await assert.rejects(compile(),error=>error.errors?.some(item=>item.text.includes(name)));
  await copyFile(path.join(root,'desktop',name),path.join(directory,name));
 }
});
