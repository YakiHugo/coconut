#!/usr/bin/env node
/** One service entry on a Mac, a private host or a server behind HTTPS. */
import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startDevelopmentBridge} from '../desktop/dev.mjs';
import {createOwnerAccess} from '../desktop/owner-access.mjs';
import {createPublicFetcher} from '../desktop/public-http.mjs';
import {createPodcastSources} from '../desktop/podcast-sources.mjs';
import {serviceConfig} from './config.mjs';
import {startAsrWorker} from './worker.mjs';
import {createIngestionExecutor} from '../desktop/ingestion-executor.mjs';

export async function startService({env=process.env,config=serviceConfig(env),...options}={}){
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<22||major===22&&minor<21||major===23||major===24&&minor<5)throw Error('The standalone service requires Node 22.21+ or 24.5+ for standard proxy agents.');
  const ownerAccess=config.publicOrigin?createOwnerAccess({origin:config.publicOrigin,token:config.ownerToken,backendLabel:config.backendLabel}):null;
  const podcastSources=options.podcastSources||createPodcastSources({fetchResource:createPublicFetcher({ownerSources:true,ownerNetwork:config.network})});
  let worker;
  try{
  if(config.asrPython)worker=await startAsrWorker({python:config.asrPython,directory:path.join(config.dataDirectory,'asr'),modelDirectory:config.modelDirectory});
  const ingestionExecutor=options.ingestionExecutor||createIngestionExecutor({url:worker?.origin||config.asrExecutorUrl||null});
  const started=await startDevelopmentBridge({...options,enableSourceJobs:true,ingestionExecutor,host:config.host,port:config.port,ownerAccess,podcastSources,podcastProxy:null,
    taskDirectory:path.join(config.dataDirectory,'tasks'),libraryDirectory:path.join(config.dataDirectory,'library'),
    captionPython:config.captionPython,readingPython:config.readingPython,sourceNetwork:config.network,startupMode:'service'});
  if(!started.library.enabled||!started.executor.enabled){await started.server.shutdown();throw Error('The service cannot open its library or task storage; existing data was preserved.');}
  if(worker){const shutdown=started.server.shutdown.bind(started.server);started.server.shutdown=callback=>{
    const stopping=(async()=>{try{await shutdown();}finally{await worker.shutdown();}})();
    if(callback)void stopping.then(()=>callback(),callback);return stopping;
  };}
  return {...started,publicOrigin:config.publicOrigin||started.origin};
  }catch(error){await worker?.shutdown();throw error;}
}
if(process.argv[1]&&await realpath(process.argv[1]).catch(()=>null)===fileURLToPath(import.meta.url)){
  if(process.argv.length>2)throw Error('Usage: npm start (configure COCONUT_* environment settings).');
  const {server,publicOrigin}=await startService();console.log(`Coconut 服务：${publicOrigin}`);
  const stop=()=>void server.shutdown().catch(()=>{process.exitCode=1;});process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
