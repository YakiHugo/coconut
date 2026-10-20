/** Explicit development-only public-video audio; no paid or automatic ASR. */
import {createHash} from 'node:crypto';
import {captionSource,CAPTION_FAILURE_STATUSES,captionDiagnostic} from './caption-service.mjs';
const messages={
 captions_available:'现在已有可用字幕，请重新读取链接以优先导入字幕；未下载原声。',
 media_unavailable:'已确认没有匹配字幕，但未找到可直接取得的公开 M4A 音轨。未尝试播放列表、登录或其他下载方式；可提供合法取得的原文件。',
 access_restricted:'来源明确限制访问，已停止；未切换客户端、登录或绕过限制。',
 language_required:'原语言尚未确认，请先选择原语言并重新检查字幕。',
 network_unavailable:'公开来源连接未完成，无法确认原声可用；未尝试其他路线。',
};
export function createVideoAudioService({helper}={}){
 const available=typeof helper?.extractAudio==='function';
 let busy=false;
 return Object.freeze({available,async download(data,{signal}={}){
  if(!available)throw Object.assign(Error('公开原声助手未配置'),{status:503,code:'video_audio_unavailable'});
  if(data?.consent!==true)throw Error('下载公开原声需要明确操作');
  const source=captionSource(data.url);
  if(!['youtube','bilibili'].includes(source.provider))throw Error('此来源不支持公开原声回退');
  const language=data.language||null;
  if(language!==null&&(typeof language!=='string'||!/^([a-z]{2,3})(-[A-Za-z0-9]{2,8}){0,2}$/.test(language)))throw Error('原语言标记无效');
  if(busy)throw Object.assign(Error('已有公开原声请求正在进行'),{status:409});
  busy=true;
  try{
   const result=await helper.extractAudio({url:source.url,language,signal});
   if(signal?.aborted)throw Error('原声请求已取消');
   if(result?.status!=='media_ready'){
    const status=[...CAPTION_FAILURE_STATUSES,'media_unavailable','captions_available'].includes(result?.status)?result.status:'extractor_failed';
    throw Object.assign(Error(messages[status]||'字幕或媒体检查未完整完成，未下载原声；可重试读取来源或使用合法原文件。'),{status:409,code:status,diagnostic:captionDiagnostic(result?.diagnostic)});
   }
   const meta=result.source,media=result.media,bytes=result.bytes;
   if(!meta||meta.url!==source.url||meta.id!==source.mediaId||meta.provider!==source.provider||meta.subtitle_check!=='no_matching_captions'||meta.format!=='m4a'||!Number.isFinite(meta.duration)||meta.duration<=0||meta.duration>21600||typeof meta.title!=='string'||meta.title.length>500||
    media?.type!=='audio/mp4'||media.kind!=='audio'||!Buffer.isBuffer(bytes)||bytes.length<12||bytes.length>200*1024*1024||media.bytes!==bytes.length||bytes.subarray(4,8).toString()!=='ftyp'||createHash('sha256').update(bytes).digest('hex')!==media.sha256)throw Error('公开原声来源或文件校验未通过');
   // Fixed metadata only: never publish transient CDN/signature URLs.
   return {body:bytes,type:'audio/mp4',source:{url:source.url,provider:source.provider,id:source.mediaId,title:meta.title,duration:meta.duration,subtitle_check:'no_matching_captions',sha256:media.sha256}};
  }finally{busy=false;}
 }});
}
