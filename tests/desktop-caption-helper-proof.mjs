/** Real frozen helper proof; authored loopback VTT only, no platform or model traffic. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {runPinnedCaptionHelper,verifiedHelperBytes,HELPER_LIMITS} from '../desktop/caption-helper-process.mjs';

export const AUTHORED_VTT='WEBVTT\n\n00:00:00.250 --> 00:00:01.750\nOriginal native helper fixture <T>.\n\n00:00:02.000 --> 00:00:04.000\nThese words are authored for Coconut.\n';
export async function proveCaptionHelper({buildDirectory,resourcesPath,artifact}={}) {
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'coconut-native-caption-proof-'));
  const requests=path.join(temporary,'requests');await fs.mkdir(requests,{mode:0o700});
  let helperPath,seenSlow,server;const hits=[],checks=[];
  const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
  try {
    if(!artifact)artifact=JSON.parse(await fs.readFile(path.join(buildDirectory,'receipt.json'),'utf8'));
    if(!resourcesPath) {
      resourcesPath=path.join(temporary,'Coconut.app','Contents','Resources');
      await fs.mkdir(path.join(resourcesPath,'caption-helper'),{recursive:true});
      await fs.copyFile(path.join(buildDirectory,'coconut-caption'),path.join(resourcesPath,'caption-helper','coconut-caption'));
    }
    helperPath=path.join(resourcesPath,'caption-helper','coconut-caption');
    const clean=async()=>check('private_request_directory_removed',(await fs.readdir(requests)).length===0);
    const options={resourcesPath,artifact,tempRoot:requests};let spawned;
    const onSpawn=facts=>{spawned=facts;assert.equal(facts.env.PATH,path.join(facts.directory,'empty-bin'));assert.ok(Object.values(facts.env).every(v=>!String(v).includes('secret-canary')));};
    // These attacker-controlled inherited settings must not survive to the child.
    process.env.YTDLP_NO_PLUGINS='secret-canary';process.env.PYTHONPATH='secret-canary';process.env._PYI_PARENT_PROCESS_LEVEL='secret-canary';
    const version=await runPinnedCaptionHelper({...options,operation:'version',onSpawn});
    check('native_version_without_python_or_path',version.version==='2026.08.19'&&version.python===artifact.python);await clean();
    server=http.createServer((req,res)=>{
      hits.push(req.url);
      if(req.url==='/slow.vtt'){res.writeHead(200,{'Content-Type':'text/vtt'});res.write('WEBVTT\n');seenSlow?.();return;}
      if(req.url==='/oversized.vtt'){res.writeHead(200,{'Content-Type':'text/vtt','Content-Length':HELPER_LIMITS.captionBytes+1});res.end('WEBVTT\n');return;}
      if(req.url!=='/authored.vtt'){res.writeHead(500);res.end();return;}
      res.writeHead(200,{'Content-Type':'text/vtt','Content-Length':Buffer.byteLength(AUTHORED_VTT)});res.end(AUTHORED_VTT);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const result=await runPinnedCaptionHelper({...options,operation:'authored-fixture',fixtureUrl:base+'/authored.vtt',onSpawn});
    check('original_caption_bytes_and_timestamps',result.bytes.toString('utf8')===AUTHORED_VTT);
    check('source_and_provenance',result.source.duration===4&&result.source.automatic===false&&result.source.translated===false&&result.track.language==='en'&&result.track.reviewStatus==='unreviewed');await clean();
    const controller=new AbortController();let observed;
    const slowStarted=new Promise(resolve=>seenSlow=resolve);
    const cancelled=runPinnedCaptionHelper({...options,operation:'authored-fixture',fixtureUrl:base+'/slow.vtt',signal:controller.signal,onSpawn:facts=>{onSpawn(facts);observed=facts;}});
    const cancellation=assert.rejects(cancelled,error=>error.code==='CAPTION_CANCELLED');
    await Promise.race([slowStarted,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Native slow fixture never started')),15000).unref())]);
    await assert.rejects(runPinnedCaptionHelper({...options,operation:'version'}),error=>error.code==='CAPTION_BUSY');check('single_request_concurrency',true);
    controller.abort();await cancellation;check('cancellation_reaps_native_process',(()=>{try{process.kill(observed.pid,0);return false;}catch(error){return error.code==='ESRCH';}})());await clean();
    seenSlow=null;
    await assert.rejects(runPinnedCaptionHelper({...options,operation:'authored-fixture',fixtureUrl:base+'/slow.vtt',timeoutMs:1500}),error=>error.code==='CAPTION_TIMEOUT');check('timeout_stops_without_result',true);await clean();
    await assert.rejects(runPinnedCaptionHelper({...options,operation:'version',maxOutputBytes:16}),error=>error.code==='CAPTION_OUTPUT_LIMIT');check('bounded_protocol_output',true);await clean();
    await assert.rejects(runPinnedCaptionHelper({...options,operation:'authored-fixture',fixtureUrl:base+'/oversized.vtt'}));check('oversized_caption_rejected',true);await clean();
    const cancelledBefore=new AbortController();cancelledBefore.abort();
    await assert.rejects(runPinnedCaptionHelper({...options,operation:'version',signal:cancelledBefore.signal}),error=>error.code==='CAPTION_CANCELLED');check('preaborted_request_never_spawns',true);
    check('no_media_or_platform_requests',hits.every(hit=>['/authored.vtt','/slow.vtt','/oversized.vtt'].includes(hit)));
    // Tamper a separate copy: preserve the actual packaged release bytes.
    const tampered=path.join(temporary,'tampered');await fs.mkdir(path.join(tampered,'caption-helper'),{recursive:true});
    const original=await fs.readFile(helperPath);original[Math.floor(original.length/2)]^=1;
    await fs.writeFile(path.join(tampered,'caption-helper','coconut-caption'),original,{mode:0o500});
    let didSpawn=false;
    await assert.rejects(runPinnedCaptionHelper({...options,resourcesPath:tampered,operation:'version',onSpawn:()=>didSpawn=true}),error=>error.code==='CAPTION_INTEGRITY');
    check('tampered_bytes_rejected_before_execution',!didSpawn);await clean();
    check('original_packaged_bytes_still_valid',(await verifiedHelperBytes(resourcesPath,artifact)).length===artifact.bytes);
    return {ok:true,target:`${process.platform}-${process.arch}`,version:version.version,checks};
  } finally {
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await fs.rm(temporary,{recursive:true,force:true});
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const root=fileURLToPath(new URL('../',import.meta.url));
  console.log(JSON.stringify(await proveCaptionHelper({buildDirectory:path.join(root,'desktop/helper-build',`${process.platform}-${process.arch}`)})));
}
