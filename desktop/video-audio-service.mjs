/** Explicit development-only public media; no paid or automatic ASR. */
import {createHash} from 'node:crypto';
import {captionSource,CAPTION_FAILURE_STATUSES,captionDiagnostic,captionFailureAvailability,SUBTITLE_TOKEN_GUIDANCE} from './caption-service.mjs';
const messages={
 video_media_unavailable:'公开媒体助手未配置，请由服务所有者检查助手配置后明确重试。',
 video_source_unavailable:'当前助手不支持已有字幕的原声载入，请由服务所有者检查助手版本和配置。',
 subtitle_token_required:SUBTITLE_TOKEN_GUIDANCE,
 captions_available:'现在已有可用字幕，请重新读取链接以优先导入字幕；未下载媒体。',
 media_unavailable:'已确认没有匹配字幕，但未找到可直接取得的公开 M4A 音轨或单文件 MP4。未尝试播放列表、登录或其他下载方式；可提供合法取得的原文件。',
 access_restricted:'来源明确限制访问，已停止；未切换客户端、登录或绕过限制。',
 language_required:'语言选择尚未确认，请先选择原语言并重新检查字幕。',
 network_unavailable:'公开来源连接未完成，无法确认媒体可用；未尝试其他路线。',
};
const reasonMessages={
 subtitle_token_required:SUBTITLE_TOKEN_GUIDANCE,
 login_required:'来源明确要求登录或认证，当前公开入口无法获取原声；可前往原站检查访问权限，或提供合法取得的原文件。',
 subtitle_login_required:'来源字幕接口明确要求登录，字幕检查已停止；原声是否可取得尚未知。可前往原站查看，或提供合法取得的原文件。',
 rate_limited:'来源明确返回请求限流，原声获取已停止；请稍后明确重试。',
 http_access_denied:'来源返回 HTTP 403 / 412 拒绝请求，原声获取已停止；不能据此判断是登录要求、限流或媒体格式不支持。',
 transport_unavailable:messages.network_unavailable,
 non_public_address:'本机 DNS 返回非公网地址，本次未连接来源；请检查网络配置后明确重试。',
 proxy_configuration_invalid:'媒体代理配置无效，请由服务所有者检查本机 HTTP 代理设置；未连接来源。',
 proxy_unavailable:'无法连接已配置的本机媒体代理，原声获取已停止；未改用直连。',
 proxy_auth_required:'本机媒体代理要求认证，此模式不接收代理凭据；未改用其他路线。',
 proxy_connect_rejected:'本机媒体代理未建立来源连接，原声获取已停止；未改用直连。',
 origin_tls_failed:'来源 TLS 证书校验未通过，原声获取已停止；未关闭校验或改用其他路线。',
 unsupported_request:'媒体提取器提出了当前不支持的请求，已停止；未尝试其他下载方式。',
};
const failureCodes=new Set([...CAPTION_FAILURE_STATUSES,'media_unavailable','captions_available','video_media_unavailable','video_source_unavailable']);
const configurationCodes=new Set(['video_media_unavailable','video_source_unavailable']);
/** Validate both new failures and persisted details; helper-supplied availability is never evidence. */
export function videoSourceErrorDetails(value){
 if(!value||!failureCodes.has(value.code))return null;
 const diagnostic=configurationCodes.has(value.code)?null:captionDiagnostic(value.diagnostic);
 const availability=captionFailureAvailability(diagnostic?.reason==='subtitle_token_required'?'subtitle_token_required':value.code);
 return {code:value.code,...(diagnostic?{diagnostic}:{}),...(availability?{availability}:{})};
}
/** Only finite protocol observations enter this type, never an upstream message or cause. */
export class VideoSourceError extends Error{
 constructor(code,{diagnostic=null,purpose=null}={}){
  const details=videoSourceErrorDetails({code,diagnostic});
  if(!details)throw new TypeError('未知的视频来源错误类型');
  diagnostic=details.diagnostic;
  const message=configurationCodes.has(code)?messages[code]
   :reasonMessages[diagnostic?.reason]
   ||(diagnostic?.stage==='media_download'&&diagnostic.reason==='budget_exceeded'
    ?'媒体下载超过 15 分钟或 200 MiB 限制，未保留不完整文件；可检查网络后重试，或提供原文件。'
    :code==='media_unavailable'&&purpose==='source'
     ?'未找到当前支持的公开 M4A 音轨或单文件 MP4，未取得原声；可提供合法取得的原文件。'
     :messages[code]||'字幕或媒体检查未完整完成，未下载媒体；可重试读取来源或使用合法原文件。');
  super(message);this.name='VideoSourceError';this.status=configurationCodes.has(code)?503:409;this.code=code;
  if(diagnostic)this.diagnostic=Object.freeze(diagnostic);
  if(details.availability)this.availability=Object.freeze(details.availability);
  Object.freeze(this);
 }
}
export function createVideoAudioService({helper,enabledProviders=['youtube','bilibili'],sourceMedia=false}={}){
 const providers=Object.freeze([...new Set(enabledProviders)].filter(value=>['youtube','bilibili'].includes(value)));
 const available=typeof helper?.extractAudio==='function'&&providers.length>0;
 let busy=false;
 return Object.freeze({available,providers,ownerLocalOnly:helper?.ownerLocalOnly===true,sourceAvailable:available&&sourceMedia,async download(data,{signal,purpose=null}={}){
  if(!available)throw new VideoSourceError('video_media_unavailable');
  if(purpose==='source'&&!sourceMedia)throw new VideoSourceError('video_source_unavailable');
  if(data?.consent!==true)throw Error('下载公开媒体需要明确操作');
  const source=captionSource(data.url);
  if(!providers.includes(source.provider))throw Error('此来源不支持公开媒体回退');
  const language=data.language||null;
  if(language!==null&&(typeof language!=='string'||!/^([a-z]{2,3})(-[A-Za-z0-9]{2,8}){0,2}$/.test(language)))throw Error('语言标记无效');
  if(busy)throw Object.assign(Error('已有公开媒体请求正在进行'),{status:409});
  busy=true;
  try{
   let result;
   try{result=await helper.extractAudio({url:source.url,language,signal,...(purpose?{purpose}:{})});}
   catch(error){
    if(signal?.aborted||error?.code==='CAPTION_CANCELLED')throw error?.code==='CAPTION_CANCELLED'?Error('媒体请求已取消'):error;
    if(error?.name==='CaptionHelperError'&&['CAPTION_TIMEOUT','CAPTION_EXIT','CAPTION_OUTPUT_LIMIT'].includes(error.code)){
     throw new VideoSourceError('extractor_failed',{diagnostic:{stage:'helper_execution',reason:error.code==='CAPTION_OUTPUT_LIMIT'?'budget_exceeded':'helper_error',requests_attempted:null,responses_received:null},purpose});
    }
    if(error?.name==='CaptionHelperError'&&['CAPTION_START','CAPTION_UNAVAILABLE'].includes(error.code))throw new VideoSourceError('video_media_unavailable');
    throw error;
   }
   if(signal?.aborted)throw Error('媒体请求已取消');
   if(result?.status!=='media_ready'){
    const status=[...CAPTION_FAILURE_STATUSES,'media_unavailable','captions_available'].includes(result?.status)?result.status:'extractor_failed';
    throw new VideoSourceError(status,{diagnostic:result?.diagnostic,purpose});
   }
   const meta=result.source,media=result.media,bytes=result.bytes;
   const shape=(media?.type==='audio/mp4'&&media.kind==='audio'&&meta?.format==='m4a')||(media?.type==='video/mp4'&&media.kind==='video'&&meta?.format==='mp4');
   const lang=meta?.audio_language,validLang=typeof lang==='string'&&/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(lang);
   const audioEvidence=source.provider==='youtube'?
    (media?.kind==='audio'?(meta?.audio_language_basis==='platform_original'&&meta.audio_role==='original'&&validLang||meta?.audio_language_basis==='unlabeled_single_source'&&meta.audio_role==='unknown'&&lang===null&&meta.format==='m4a'||meta?.audio_language_basis==='single_language_track'&&meta.audio_role==='unknown'&&validLang&&meta.format==='m4a'):
     meta?.audio_language_basis==='platform_video_stream'&&['original','default','unknown'].includes(meta.audio_role)&&(lang===null||validLang)&&(meta.audio_role!=='unknown'||lang===null)&&meta.format_id==='18'):
    meta?.audio_language_basis==='provider_single_source'&&lang===null&&meta.audio_role==='unknown';
   if(!shape||!audioEvidence||!meta||meta.url!==source.url||meta.id!==source.mediaId||meta.provider!==source.provider||(purpose==='source'?meta.purpose!=='source'||!['found','no_matching_captions','not_requested'].includes(meta.subtitle_check):meta.subtitle_check!=='no_matching_captions')||!Number.isFinite(meta.duration)||meta.duration<=0||meta.duration>21600||typeof meta.title!=='string'||meta.title.length>500||typeof meta.format_id!=='string'||!/^[A-Za-z0-9_.-]{1,80}$/.test(meta.format_id)||
    !Buffer.isBuffer(bytes)||bytes.length<12||bytes.length>200*1024*1024||media.bytes!==bytes.length||bytes.subarray(4,8).toString()!=='ftyp'||createHash('sha256').update(bytes).digest('hex')!==media.sha256)throw Error('公开媒体来源或文件校验未通过');
   // Fixed metadata only: never publish transient CDN/signature URLs.
   return {body:bytes,type:media.type,kind:media.kind,filename:'public-source.'+meta.format,source:{url:source.url,provider:source.provider,id:source.mediaId,title:meta.title,duration:meta.duration,subtitle_check:meta.subtitle_check,...(purpose?{purpose}:{}),audio_language:lang,audio_language_basis:meta.audio_language_basis,audio_role:meta.audio_role,format:meta.format,format_id:meta.format_id,kind:media.kind,type:media.type,sha256:media.sha256}};
  }finally{busy=false;}
 }});
}
