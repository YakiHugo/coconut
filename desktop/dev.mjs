#!/usr/bin/env node
/** Source-only development entry. Never installs dependencies or starts a model. */
import path from 'node:path';
import {realpath} from 'node:fs/promises';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {startBridge} from './server.mjs';
import {privateProxyFromEnvironment} from './client-access.mjs';
import {libraryLocation,libraryStartupMessage,DEVELOPMENT_LIBRARY_DIRECTORY} from './library-location.mjs';
export {DEVELOPMENT_LIBRARY_DIRECTORY};
import {sourceNetworkFromEnvironment,validateSourceNetwork} from './source-network.mjs';
import {createDevelopmentCaptionHelper,resolvePlayerJsRuntime} from './development-captions.mjs';
import {createCaptionService} from './caption-service.mjs';
import {createCaptionReadability} from './transcript-readability.mjs';
import {createVideoAudioService} from './video-audio-service.mjs';
import {captionSetupGuidance,CAPTION_START_GUIDANCE} from './caption-setup-guidance.mjs';
import {createBilibiliBrowserSession} from './bilibili-browser-session.mjs';
import {createPodcastSources} from './podcast-sources.mjs';
import {createPublicFetcher,validatePodcastProxy} from './public-http.mjs';
import {createCaptionShortLinkResolver} from './caption-short-link.mjs';

export const DEVELOPMENT_TASK_DIRECTORY = fileURLToPath(new URL('../.coconut/dev/tasks', import.meta.url));

export async function startDevelopmentBridge({port = 8080, taskDirectory = DEVELOPMENT_TASK_DIRECTORY, libraryDirectory = libraryLocation({mode:'development'}).directory, captionPython = process.env.COCONUT_CAPTION_PYTHON, captionProxy = process.env.COCONUT_CAPTION_PROXY, sourceNetwork = undefined, podcastProxy = process.env.COCONUT_PODCAST_PROXY, captionHelperDetached = process.platform!=='win32', readingPython = process.env.COCONUT_READING_PYTHON, punctuationModel = process.env.COCONUT_PUNCTUATION_MODEL, segmentationModel = process.env.COCONUT_SPEAKER_SEGMENTATION_MODEL, embeddingModel = process.env.COCONUT_SPEAKER_EMBEDDING_MODEL, ...options} = {}) {
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<22||major===22&&minor<21||major===23||major===24&&minor<5)throw new Error('Coconut development requires Node.js 22.21+ or 24.5+ for standard proxy agents.');
  const trustedPodcastProxy=validatePodcastProxy(podcastProxy);
  const network=validateSourceNetwork(sourceNetwork??(captionProxy===null?{mode:'direct'}:sourceNetworkFromEnvironment({...process.env,...(captionProxy===undefined?{}:{COCONUT_CAPTION_PROXY:captionProxy})})));
  if(trustedPodcastProxy){
    if(options.podcastSources)throw new Error('不能同时覆盖播客来源和配置播客代理');
    options.podcastSources=createPodcastSources({fetchResource:createPublicFetcher({xiaoyuzhouProxy:trustedPodcastProxy})});
  }
  if(!options.podcastSources){
    // Video helpers also support SOCKS. Validate the podcast transport when it
    // is used, so an unsupported podcast proxy cannot disable video or reading.
    let fetchResource;
    options.podcastSources=createPodcastSources({fetchResource:(...args)=>{
      fetchResource??=createPublicFetcher({ownerSources:true,ownerNetwork:network});
      return fetchResource(...args);
    }});
  }
  options.captionShortLinkResolver??=createCaptionShortLinkResolver({ownerNetwork:network});
  let helper=null,captionDiagnostic=null;
  if(captionPython && !options.captionService){
    try{
      options.bilibiliSession??=await createBilibiliBrowserSession({python:captionPython,configuration:taskDirectory?path.join(path.dirname(taskDirectory),'caption-browser.json'):null});
      helper=createDevelopmentCaptionHelper({python:captionPython,network,bilibiliSession:options.bilibiliSession,playerRuntime:await resolvePlayerJsRuntime(),detached:captionHelperDetached});
      const status=await helper.status();
      captionDiagnostic=status;
      options.captionStatus={code:status.ready?'ready':status.code,mode:'development-python',networkMode:status.networkMode};
      if(status.ready)options.captionService=createCaptionService({helper,readerDirectory:options.readerDirectory,enabledProviders:status.providers,enhanceDocument:createCaptionReadability({python:readingPython,model:punctuationModel})});
      if(status.ready&&status.audioFallback)options.videoAudioService=createVideoAudioService({helper,enabledProviders:status.audioProviders,sourceMedia:status.sourceMedia===true});
    }catch(error){options.captionStatus={code:error.code||'CAPTION_UNAVAILABLE',mode:'development-python'};}
  }
  let server;
  try{server=await startBridge({...options, readingPython,punctuationModel,segmentationModel,embeddingModel,port, taskDirectory, libraryDirectory,startupMode:options.startupMode||'development'});}
  catch(error){await helper?.shutdown();throw error;}
  if(helper){
    const shutdown=server.shutdown.bind(server);
    server.shutdown=callback=>{
      const stopping=helper.shutdown();
      return new Promise((resolve,reject)=>shutdown(error=>void stopping.then(()=>{callback?.(error);error?reject(error):resolve();},failure=>{callback?.(failure);reject(failure);}))).catch(error=>{if(!callback)throw error;});
    };
    server.on('close',()=>void helper.shutdown());
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    // fetch intentionally ignores a supplied Host header. Authenticated service
    // discovery uses the same exact public Host/cookie contract as its browsers.
    const discover=options.ownerAccess?route=>new Promise((resolve,reject)=>{
      const req=http.get(origin+route,{headers:options.ownerAccess.discoveryHeaders(),timeout:5000},res=>{
        const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024)res.destroy(Error('Discovery response too large'));else chunks.push(chunk);});
        res.on('error',reject);res.on('end',()=>{try{if(res.statusCode!==200)throw Error('Service discovery was not authorized');resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){reject(error);}});
      });req.on('timeout',()=>req.destroy(Error('Service discovery timed out')));req.on('error',reject);
    }):route=>fetch(origin+route).then(response=>response.json());
    // Passive capability read: does not probe authentication or invoke a provider.
    const executor = await discover('/api/v1/executor');
    const captions=await discover('/api/captions/status');
    const library=await discover('/api/v1/library');
    return {server, origin, taskDirectory, libraryDirectory, library, executor, captions, captionDiagnostic,podcastNetworkMode:trustedPodcastProxy?'xiaoyuzhou_trusted_local_proxy':network.mode==='direct'?'direct_public':'owner_network'};
  } catch (error) {
    await new Promise(resolve => server.shutdown(resolve));
    throw error;
  }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(()=>null) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error('Usage: pnpm run dev:bridge (fixed development port 8080)');
  const {server, origin, taskDirectory, libraryDirectory, library, executor, captions, captionDiagnostic,podcastNetworkMode} = await startDevelopmentBridge({privateProxy:privateProxyFromEnvironment()});
  console.log(`Coconut 开发阅读器：${origin}`);
  console.log(`开发任务目录：${taskDirectory}`);
  console.log(podcastNetworkMode==='xiaoyuzhou_trusted_local_proxy'?'播客网络：小宇宙及其公开音频使用所有者配置的本机代理；其他来源保持直连。':podcastNetworkMode==='owner_network'?'播客网络：小宇宙及其公开音频使用已配置的来源网络；其他来源保持直连。':'播客网络：小宇宙及其公开音频使用本机网络解析，兼容 TUN / Fake-IP；其他来源校验公网地址。');
  console.log(libraryStartupMessage({mode:'development',directory:libraryDirectory},library));
  console.log(`本机后台任务：${executor.enabled ? '可用；提供商尚未检查' : '不可用；请检查开发任务目录，阅读仍可使用'}`);
  console.log(`字幕获取：${captions.available?'公开 X / YouTube / Bilibili 字幕入口已就绪（能否取得字幕取决于来源访问状态）':`${captions.message}（${captions.code}）`}`);
  if(captions.available)console.log(captions.networkMode==='environment_proxy'?'视频来源网络：显式使用启动环境代理与 NO_PROXY；不是系统 / PAC 自动发现，X 不变。':captions.networkMode==='trusted_local_proxy'?'字幕网络：YouTube / Bilibili 使用所有者配置的可信本机代理；X 不变。':'字幕网络：直连公网；未继承系统代理。');
  if(captions.available)console.log(captionDiagnostic?.audioFallback?`公开媒体：${captions.networkMode==='environment_proxy'?'通过启动环境代理配置获取':captions.networkMode==='trusted_local_proxy'?'通过已配置本机代理获取':'直连'} M4A 或单文件 MP4；须先确认无匹配字幕并明确下载。来源限制仍会停止。`:'公开音轨：当前助手未提供可用的媒体获取协议。');
  if(!captions.available){console.log(captionSetupGuidance(captions.code,captionDiagnostic));console.log(CAPTION_START_GUIDANCE);}
  console.log('未发起模型请求。reader 修改后刷新页面；desktop 服务修改后 Ctrl+C 再运行 pnpm run dev:bridge。');
  const stop = () => server.shutdown().catch(() => { process.exitCode = 1; });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
