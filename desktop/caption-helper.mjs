/** Only immutable packaged artifacts may run; only the guarded public X route is enabled. */
import { readFile } from 'node:fs/promises';
import { runPinnedCaptionHelper, CaptionHelperError, waitForCaptionHelperIdle } from './caption-helper-process.mjs';

const artifacts = JSON.parse(await readFile(new URL('./caption-helper-artifacts.json',import.meta.url),'utf8')).artifacts;
export function createCaptionHelper({resourcesPath, artifact=artifacts[`${process.platform}-${process.arch}`],run=runPinnedCaptionHelper} = {}) {
  const requests=new Set(),pending=new Set();let closing=false;
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
      try {
        const result=await execute({resourcesPath,artifact,operation:'version',signal});
        return {installed:true,integrity:true,version:result.version,ready:true,
          reason:'原生字幕助手已校验，可读取支持的公开 X 原语字幕。'};
      } catch(error) {
        if(error.code==='CAPTION_CANCELLED')throw error;
        return {installed:false,integrity:false,ready:false,reason:'已校验的原生字幕助手尚未随应用提供。',code:error.code||'CAPTION_UNAVAILABLE'};
      }
    },
    async extractCaptions({url,language=null,signal} = {}) {
      if(signal?.aborted)throw new CaptionHelperError('CAPTION_CANCELLED','字幕请求已取消');
      return execute({resourcesPath,artifact,operation:'extract',url,language,signal});
    },
  });
}
