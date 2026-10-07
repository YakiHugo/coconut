/** Run helper from the exact native release ZIP; never modify the release artifact. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {proveCaptionHelper} from './desktop-caption-helper-proof.mjs';
import {verifyCaptionHelperResources} from '../desktop/caption-helper-package.mjs';
import {createCaptionHelper} from '../desktop/caption-helper.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(new URL('../desktop/package.json',import.meta.url));
const {extractFile}=await import(pathToFileURL(createRequire(require.resolve('@electron/packager')).resolve('@electron/asar')).href);
assert.equal(process.platform,'darwin','Packaged helper proof requires native macOS');
const work=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-packaged-caption-proof-'));
try {
  const {version}=JSON.parse(await fs.readFile(path.join(root,'desktop/package.json'),'utf8'));
  let resourcesPath,artifact;const packageTrees=[];
  for(const arch of ['arm64','x64']) {
    const archive=path.join(root,'desktop/dist',`Coconut-${version}-${arch}-unsigned.zip`);
    const extracted=path.join(work,arch);await fs.mkdir(extracted);
    execFileSync('/usr/bin/ditto',['-x','-k',archive,extracted],{timeout:60000,stdio:'pipe'});
    const candidate=path.join(extracted,'Coconut.app/Contents/Resources');
    const manifest=JSON.parse(extractFile(path.join(candidate,'app.asar'),'caption-helper-artifacts.json').toString('utf8'));
    for(const name of ['caption-helper.mjs','caption-helper-process.mjs','caption-helper-lock.json'])assert.deepEqual(extractFile(path.join(candidate,'app.asar'),name),await fs.readFile(path.join(root,'desktop',name)),`Packaged ${name} matches reviewed runtime`);
    const receipt=manifest.artifacts[`darwin-${arch}`];assert.ok(receipt,'Native helper receipt is inside app.asar');
    await verifyCaptionHelperResources(path.join(candidate,'caption-helper'),receipt);packageTrees.push(`darwin-${arch}`);
    if(arch===process.arch){resourcesPath=candidate;artifact=receipt;}
  }
  const report=await proveCaptionHelper({resourcesPath,artifact});
  assert.ok((await fs.stat(path.join(resourcesPath,'caption-helper/notices/README.txt'))).size);
  assert.ok((await fs.stat(path.join(resourcesPath,'caption-helper/sources/certifi-2026.7.22.tar.gz'))).size);
  console.log(JSON.stringify({...report,packaged:true,noticesAndSource:true,packageTrees}));
  if(process.argv.includes('--live')) {
    // Explicit CI-only public fixture used in the prior bounded live proof. No
    // source text, signed URL, access token or caption artifact is logged/saved.
    const source='https://x.com/VaibhavSisinty/status/2105733670493651236';
    const {createCaptionService}=await import('../desktop/caption-service.mjs');
    const helper=createCaptionHelper({resourcesPath,artifact});
    assert.equal((await helper.status()).ready,true);
    const result=await createCaptionService({helper,enabledProviders:['x'],readerDirectory:path.join(resourcesPath,'reader')}).importCaption({url:source,language:'en'});
    assert.equal(result.status,'ready','Verified public source must produce a native packaged transcript');
    assert.equal(result.document.segments.length,1771);
    assert.equal(result.document.language,'en');
    assert.equal(result.document.provenance.caption_method,'platform_provided');
    assert.equal(result.document.provenance.review_status,'unreviewed');
    assert.equal(result.document.segments[0].start,0.22);
    assert.equal(result.document.segments.at(-1).end,3251.49);
    console.log(JSON.stringify({ok:true,packaged:true,live:true,target:`darwin-${process.arch}`,cues:result.document.segments.length,
      language:result.document.language,captionMethod:result.document.provenance.caption_method,
      duration:result.document.provenance.media_duration,first:result.document.segments[0].start,last:result.document.segments.at(-1).end}));
  }
} finally {await fs.rm(work,{recursive:true,force:true});}
