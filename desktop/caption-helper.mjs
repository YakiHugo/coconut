import {sourceNetworkFromEnvironment,validateSourceNetwork} from './source-network.mjs';
import {createVideoAudioService} from './video-audio-service.mjs';
/** Only immutable packaged artifacts and their verified public capabilities may run. */
import { readFile } from 'node:fs/promises';
import { runPinnedCaptionHelper, CaptionHelperError, waitForCaptionHelperIdle } from './caption-helper-process.mjs';
import { createCaptionService, packagedCaptionGuidance } from './caption-service.mjs';

const artifacts = JSON.parse(await readFile(new URL('./caption-helper-artifacts.json',import.meta.url),'utf8')).artifacts;
export function createCaptionHelper({resourcesPath, artifact=artifacts[`${process.platform}-${process.arch}`],run=runPinnedCaptionHelper,network=sourceNetworkFromEnvironment()} = {}) {
  const requests=new Set(),pending=new Set();let closing=false,ready=false,ownerLocal=false;
  const sourceNetwork=validateSourceNetwork(network);
  async function execute(options){
    if(closing)throw new CaptionHelperError('CAPTION_CANCELLED','字幕请求已取消');
    const controller=new AbortController();requests.add(controller);
    const operation=run({...options,signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal});pending.add(operation);
    try{return await operation;}finally{requests.delete(controller);pending.delete(operation);}
  }
  return Object.freeze({get ownerLocalOnly(){return ownerLocal;},
    shutdown(){closing=true;for(const request of requests)request.abort();return Promise.allSettled([...pending]).then(()=>waitForCaptionHelperIdle());},
    waitForIdle:waitForCaptionHelperIdle,
    async status({signal} = {}) {
      ready=false;
      try {
        const result=await execute({resourcesPath,artifact,operation:'version',signal});
        ownerLocal=result.ownerLocalVideoProtocol===1;
        if(!ownerLocal&&sourceNetwork.mode!=='direct')throw new CaptionHelperError('CAPTION_VERSION','此安装包不支持统一来源网络配置');
        ready=true;
        return {installed:true,integrity:true,version:result.version,ready:true,code:'ready',providers:result.publicProviders,ownerLocalOnly:ownerLocal,audioFallback:ownerLocal,sourceMedia:ownerLocal,...(ownerLocal?{networkMode:sourceNetwork.mode==='direct'?'direct_public':sourceNetwork.mode==='custom'?'trusted_local_proxy':'environment_proxy'}:{}),
          reason:'原生字幕助手已校验，可尝试读取已启用来源的公开原语言字幕。'};
      } catch(error) {
        if(error.code==='CAPTION_CANCELLED')throw error;
        const code=error.code||'CAPTION_UNAVAILABLE';
        return {installed:false,integrity:false,ready:false,providers:[],reason:packagedCaptionGuidance(code),code};
      }
    },
    async extractAudio({url,language=null,purpose=null,signal,consume}={}){
      if(!ready||!ownerLocal)throw new CaptionHelperError('CAPTION_UNAVAILABLE','此安装包未提供本机媒体获取能力');
      return execute({resourcesPath,artifact,operation:'extract-audio',url,language,purpose,network:sourceNetwork,timeoutMs:910000,signal,consume});
    },
    async extractCaptions({url,language=null,signal} = {}) {
      if(closing||signal?.aborted)throw new CaptionHelperError('CAPTION_CANCELLED','字幕请求已取消');
      if(!ready)throw new CaptionHelperError('CAPTION_UNAVAILABLE','安装包字幕助手尚未通过检查');
      try{return await execute({resourcesPath,artifact,operation:'extract',url,language,...(ownerLocal?{network:sourceNetwork}:{}),signal});}
      catch(error){
        if(['CAPTION_UNAVAILABLE','CAPTION_INTEGRITY','CAPTION_VERSION','CAPTION_START','CAPTION_EXIT'].includes(error.code))throw new CaptionHelperError(error.code,packagedCaptionGuidance(error.code));
        throw error;
      }
    },
  });
}

/** Shared by the Electron entry and offline packaged-resource integration proofs. */
export async function preparePackagedCaptions({helper,readerDirectory,signal}={}){
 const status=await helper.status({signal});
 return {captionStatus:{mode:'bundled-helper',code:status.ready?'ready':status.code,...(status.networkMode?{networkMode:status.networkMode}:{})},
  videoAudioService:status.ready&&status.audioFallback?createVideoAudioService({helper,enabledProviders:status.providers||[],sourceMedia:true}):null,
  captionService:status.ready?createCaptionService({helper,readerDirectory,enabledProviders:status.providers}):null};
}
