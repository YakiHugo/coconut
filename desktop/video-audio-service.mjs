/** Explicit development-only public media; no paid or automatic ASR. */
import {createHash} from 'node:crypto';
import {captionSource,CAPTION_FAILURE_STATUSES,captionDiagnostic} from './caption-service.mjs';
const messages={
 captions_available:'现在已有可用字幕，请重新读取链接以优先导入字幕；未下载媒体。',
 media_unavailable:'已确认没有匹配字幕，但未找到可直接取得的公开 M4A 音轨或单文件 MP4。未尝试播放列表、登录或其他下载方式；可提供合法取得的原文件。',
 access_restricted:'来源明确限制访问，已停止；未切换客户端、登录或绕过限制。',
 language_required:'语言选择尚未确认，请先选择原语言并重新检查字幕。',
 network_unavailable:'公开来源连接未完成，无法确认媒体可用；未尝试其他路线。',
};
export function createVideoAudioService({helper,enabledProviders=['youtube','bilibili'],sourceMedia=false}={}){
 const providers=Object.freeze([...new Set(enabledProviders)].filter(value=>['youtube','bilibili'].includes(value)));
 const available=typeof helper?.extractAudio==='function'&&providers.length>0;
 let busy=false;
 return Object.freeze({available,providers,sourceAvailable:available&&sourceMedia,async download(data,{signal,purpose=null}={}){
  if(!available)throw Object.assign(Error('公开媒体助手未配置'),{status:503,code:'video_media_unavailable'});
  if(purpose==='source'&&!sourceMedia)throw Object.assign(Error('当前助手不支持已有字幕的原声载入'),{status:503});
  if(data?.consent!==true)throw Error('下载公开媒体需要明确操作');
  const source=captionSource(data.url);
  if(!providers.includes(source.provider))throw Error('此来源不支持公开媒体回退');
  const language=data.language||null;
  if(language!==null&&(typeof language!=='string'||!/^([a-z]{2,3})(-[A-Za-z0-9]{2,8}){0,2}$/.test(language)))throw Error('语言标记无效');
  if(busy)throw Object.assign(Error('已有公开媒体请求正在进行'),{status:409});
  busy=true;
  try{
   const result=await helper.extractAudio({url:source.url,language,signal,...(purpose?{purpose}:{})});
   if(signal?.aborted)throw Error('媒体请求已取消');
   if(result?.status!=='media_ready'){
    const status=[...CAPTION_FAILURE_STATUSES,'media_unavailable','captions_available'].includes(result?.status)?result.status:'extractor_failed';
    const diagnostic=captionDiagnostic(result?.diagnostic);
    const message=diagnostic?.stage==='media_download'&&diagnostic.reason==='budget_exceeded'
     ?'媒体下载超过 15 分钟或 200 MiB 限制，未保留不完整文件；可检查网络后重试，或提供原文件。'
     :messages[status]||'字幕或媒体检查未完整完成，未下载媒体；可重试读取来源或使用合法原文件。';
    throw Object.assign(Error(message),{status:409,code:status,diagnostic});
   }
   const meta=result.source,media=result.media,bytes=result.bytes;
   const shape=(media?.type==='audio/mp4'&&media.kind==='audio'&&meta?.format==='m4a')||(media?.type==='video/mp4'&&media.kind==='video'&&meta?.format==='mp4');
   const lang=meta?.audio_language,validLang=typeof lang==='string'&&/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(lang);
   const audioEvidence=source.provider==='youtube'?
    (media?.kind==='audio'?meta?.audio_language_basis==='platform_original'&&meta.audio_role==='original'&&validLang:
     meta?.audio_language_basis==='platform_video_stream'&&['original','default','unknown'].includes(meta.audio_role)&&(lang===null||validLang)&&(meta.audio_role!=='unknown'||lang===null)&&meta.format_id==='18'):
    meta?.audio_language_basis==='provider_single_source'&&lang===null&&meta.audio_role==='unknown';
   if(!shape||!audioEvidence||!meta||meta.url!==source.url||meta.id!==source.mediaId||meta.provider!==source.provider||(purpose==='source'?meta.purpose!=='source'||!['found','no_matching_captions'].includes(meta.subtitle_check):meta.subtitle_check!=='no_matching_captions')||!Number.isFinite(meta.duration)||meta.duration<=0||meta.duration>21600||typeof meta.title!=='string'||meta.title.length>500||typeof meta.format_id!=='string'||!/^[A-Za-z0-9_.-]{1,80}$/.test(meta.format_id)||
    !Buffer.isBuffer(bytes)||bytes.length<12||bytes.length>200*1024*1024||media.bytes!==bytes.length||bytes.subarray(4,8).toString()!=='ftyp'||createHash('sha256').update(bytes).digest('hex')!==media.sha256)throw Error('公开媒体来源或文件校验未通过');
   // Fixed metadata only: never publish transient CDN/signature URLs.
   return {body:bytes,type:media.type,kind:media.kind,filename:'public-source.'+meta.format,source:{url:source.url,provider:source.provider,id:source.mediaId,title:meta.title,duration:meta.duration,subtitle_check:meta.subtitle_check,...(purpose?{purpose}:{}),audio_language:lang,audio_language_basis:meta.audio_language_basis,audio_role:meta.audio_role,format:meta.format,format_id:meta.format_id,kind:media.kind,type:media.type,sha256:media.sha256}};
  }finally{busy=false;}
 }});
}
