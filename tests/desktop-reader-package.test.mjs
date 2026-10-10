/** Node-only module-scope regressions; no Electron, browser or network launch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifyReaderResources} from '../desktop/reader-package.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),execute=promisify(execFile);
async function layout(t,kind,{boundary=true}={}) {
  const work=await mkdtemp(path.join(tmpdir(),'coconut-reader-modules-'));
  t.after(()=>rm(work,{recursive:true,force:true}));
  let app,reader;
  if(kind==='source'){
    app=path.join(work,'source/desktop');reader=path.join(work,'source/reader');
  }else{
    const resources=path.join(work,kind==='direct'?'direct/desktop/dist/Coconut-darwin-arm64/Coconut.app/Contents/Resources':'extracted/Coconut.app/Contents/Resources');
    // A plain directory models package scope only; real ASAR is checked in CI.
    app=path.join(resources,'app.asar');reader=path.join(resources,'reader');
    if(kind==='direct'){
      const desktop=path.join(work,'direct/desktop');await mkdir(desktop,{recursive:true});
      await copyFile(path.join(root,'desktop/package.json'),path.join(desktop,'package.json'));
    }
  }
  await mkdir(app,{recursive:true});await mkdir(reader,{recursive:true});
  await writeFile(path.join(app,'package.json'),JSON.stringify({type:'module'}));
  for(const name of ['podcast-sources.mjs','public-http.mjs','podcast-xml.mjs','caption-service.mjs'])await copyFile(path.join(root,'desktop',name),path.join(app,name));
  for(const name of ['core.js','summary.js',...(boundary?['package.json']:[])])await copyFile(path.join(root,'reader',name),path.join(reader,name));
  return {app,reader};
}
async function loadReader({app,reader}) {
  const source=pathToFileURL(path.join(app,'podcast-sources.mjs')).href;
  const caption=pathToFileURL(path.join(app,'caption-service.mjs')).href;
  const code=`import assert from 'node:assert/strict';
    import {parsePublisherTranscript} from ${JSON.stringify(source)};
    import {createCaptionService} from ${JSON.stringify(caption)};
    const cues=parsePublisherTranscript('WEBVTT\\n\\n00:00.000 --> 00:01.000\\n<v Ren&eacute;>Hello</v>','text/vtt');
    assert.equal(cues[0].speaker,'René');
    assert.equal(createCaptionService({readerDirectory:${JSON.stringify(reader)}}).available,false);
    console.log('reader module scope passed');`;
  return execute(process.execPath,['--input-type=module','-e',code],{timeout:15000,maxBuffer:1024*1024});
}
for(const kind of ['source','direct','extracted'])test('explicit reader CommonJS boundary loads in '+kind+' layout',async t=>{
  const fixture=await layout(t,kind);
  await verifyReaderResources(fixture.reader);
  const {stdout}=await loadReader(fixture);assert.match(stdout,/reader module scope passed/);
});
test('direct build under an ESM desktop parent reproduces the missing-boundary failure',async t=>{
  const fixture=await layout(t,'direct',{boundary:false});
  await assert.rejects(loadReader(fixture),error=>/does not provide an export named 'default'/.test(error.stderr));
  await assert.rejects(verifyReaderResources(fixture.reader),{code:'ENOENT'});
});
test('verification rejects wrong module type and missing reader dependencies',async t=>{
  const fixture=await layout(t,'extracted');
  await writeFile(path.join(fixture.reader,'package.json'),JSON.stringify({type:'module'}));
  await assert.rejects(verifyReaderResources(fixture.reader),/must declare type:commonjs/);
  await copyFile(path.join(root,'reader/package.json'),path.join(fixture.reader,'package.json'));
  await rm(path.join(fixture.reader,'summary.js'));
  await assert.rejects(verifyReaderResources(fixture.reader),/Cannot find module/);
});
test('packager stages the boundary and checks each output before signing; exact ZIP proof also verifies it',async()=>{
  const source=await readFile(path.join(root,'desktop/package.mjs'),'utf8');
  assert.match(source,/\['package.json','index.html','summary.js','core.js'/);
  const staged=source.indexOf('await verifyReaderResources(reader)'),pack=source.indexOf('await packager('),output=source.indexOf('await verifyReaderResources(readerResources)'),sign=source.indexOf('await signDevelopmentBundle(');
  assert.ok(staged>=0&&staged<pack&&pack<output&&output<sign);
  const proof=await readFile(path.join(root,'tests/desktop-caption-helper-packaged-proof.mjs'),'utf8');
  assert.match(proof,/await verifyReaderResources\(path.join\(candidate,'reader'\)\)/);
  assert.match(proof,/reader\/package.json/);
});
