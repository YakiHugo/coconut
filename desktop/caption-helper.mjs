/** Only immutable packaged artifacts and their verified public capabilities may run. */
import { readFile } from 'node:fs/promises';
import { runPinnedCaptionHelper, CaptionHelperError, waitForCaptionHelperIdle } from './caption-helper-process.mjs';
import { createCaptionService, packagedCaptionGuidance } from './caption-service.mjs';

const artifacts = JSON.parse(await readFile(new URL('./caption-helper-artifacts.json',import.meta.url),'utf8')).artifacts;
export function createCaptionHelper({resourcesPath, artifact=artifacts[`${process.platform}-${process.arch}`],run=runPinnedCaptionHelper} = {}) {
  const requests=new Set(),pending=new Set();let closing=false,ready=false;
  async function execute(options){
    if(closing)throw new CaptionHelperError('CAPTION_CANCELLED','字幕请求已取消');
    const controller=new AbortController();requests.add(controller);
    const operation=run({...options,signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal});pending.add(operation);
    try{return await operation;}finally{requests.delete(controller);pending.delete(operation);}
  }
  return Object.freeze({
    shutdown(){closing=true;for(const request of requests)request.abort();return Promise.allSettled([...pending]).then(()=>waitForCaptionHelperIdle());},
    waitForIdle:waitForCaptionHelperIdle,
    async status({signal} = {}) {
      ready=false;
      try {
        const result=await execute({resourcesPath,artifact,operation:'version',signal});
        ready=true;
        return {installed:true,integrity:true,version:result.version,ready:true,code:'ready',providers:result.publicProviders,
          reason:'原生字幕助手已校验，可尝试读取已启用来源的公开原语言字幕。'};
      } catch(error) {
        if(error.code==='CAPTION_CANCELLED')throw error;
        const code=error.code||'CAPTION_UNAVAILABLE';
        return {installed:false,integrity:false,ready:false,providers:[],reason:packagedCaptionGuidance(code),code};
      }
    },
    async extractCaptions({url,language=null,signal} = {}) {
      if(closing||signal?.aborted)throw new CaptionHelperError('CAPTION_CANCELLED','字幕请求已取消');
      if(!ready)throw new CaptionHelperError('CAPTION_UNAVAILABLE','安装包字幕助手尚未通过检查');
      try{return await execute({resourcesPath,artifact,operation:'extract',url,language,signal});}
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
 return {captionStatus:{mode:'bundled-helper',code:status.ready?'ready':status.code},
  captionService:status.ready?createCaptionService({helper,readerDirectory,enabledProviders:status.providers}):null};
}
