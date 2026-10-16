/** Link-first ingestion coordinator. Existing adapters own fetching and validation.
 * Receipts are request-scoped, not persisted processing jobs or library writes.
 */
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const Coconut=createRequire(import.meta.url)('../reader/core.js');
import {captionSource} from './caption-service.mjs';

const VIDEO_HOSTS=new Set(['x.com','www.x.com','twitter.com','www.twitter.com','mobile.twitter.com','youtube.com','www.youtube.com','m.youtube.com','youtu.be','bilibili.com','www.bilibili.com','m.bilibili.com']);
const FILE_TYPES=new Map([['mp3','audio'],['wav','audio'],['m4a','audio'],['ogg','audio'],['flac','audio'],['mp4','video'],['webm','video']]);
const unavailableTranscription=Object.freeze({available:false,code:'asr_not_configured',automatic:false,model_download:false,message:'当前轻量服务未配置转写引擎。可以先播放媒体；生成文字稿需要另行配置可用的转写服务。'});
const checkAbort=signal=>{if(signal?.aborted)throw new DOMException('已取消导入','AbortError');};
function inputSource(source){
 if(!source||typeof source!=='object'||Array.isArray(source))throw new Error('请选择链接或音视频文件');
 if(source.kind==='url'){
  if(typeof source.url!=='string'||source.url.length>4096)throw new Error('链接无效');
  let url;try{url=new URL(source.url);}catch{throw new Error('链接无效');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('请使用公开 HTTP / HTTPS 链接');
  url.hash='';return {kind:'url',url:url.href};
 }
 if(source.kind==='file'){
  if(typeof source.name!=='string'||!source.name||source.name.length>300||/[\\/\u0000-\u001f]/.test(source.name))throw new Error('文件名称无效');
  const kind=FILE_TYPES.get(source.name.split('.').at(-1).toLowerCase());
  if(!kind||!Number.isSafeInteger(source.size)||source.size<=0||source.size>200*1024*1024)throw new Error('请选择不超过 200 MiB 的受支持音视频文件');
  if(source.type!==undefined&&(typeof source.type!=='string'||source.type.length>120)||source.last_modified!==undefined&&(!Number.isSafeInteger(source.last_modified)||source.last_modified<0))throw new Error('文件信息无效');
  return {kind:'file',name:source.name,size:source.size,type:source.type||'',last_modified:source.last_modified??0,media_kind:kind};
 }
 throw new Error('不支持的来源类型');
}
function audioProject(source,media,episode=null,feedUrl=''){
 if(!media)return null;
 return {document:Coconut.validate({project_kind:'audio_only',transcript_status:'not_imported',title:episode?.title||media.name||'原声项目',language:episode?.language||'',source_url:episode?.source_url||source.url,media_duration:episode?.duration,podcast_source:feedUrl?{feed_url:feedUrl,episode_id:episode.id,media_url:media.url,media_kind:media.kind}:{kind:'direct_media',media_url:media.url,media_kind:media.kind},segments:[]})};
}
function episodeMedia(result){
 const media=result.episode?.media?.[0];
 return media?{kind:media.kind,url:media.url,name:result.episode.title,mimeType:media.type,availability:'remote',download:{endpoint:'/api/podcasts/media',body:{feedUrl:result.feed_url,episodeId:result.episode.id,mediaUrl:media.url}}}:null;
}
export function createIngestionService({podcastSources,captionService=null}={}){
 const capabilities=()=>({protocolVersion:1,request_scoped:true,persistent:false,url:true,local_file:'metadata_only',captions:captionService?.available===true,transcription:unavailableTranscription});
 async function ingest(data,{signal}={}){
  checkAbort(signal);
  if(data?.protocolVersion!==1)throw new Error('导入协议版本无效');
  if(data.intent!==undefined&&data.intent!=='media_only')throw new Error('导入意图无效');
  const source=inputSource(data.source);
  if(data.intent==='media_only'){
   if(source.kind!=='url'||!data.episode)throw new Error('仅可为明确选择的播客单集打开原始媒体');
   if(Object.hasOwn(data,'transcript_url')||Object.hasOwn(data.episode,'transcript_url'))throw new Error('仅打开原始媒体时不能指定文字稿');
  }
  const base={id:randomUUID(),source,media:null,transcript:null,project:null,selection:null,transcription:unavailableTranscription};
  const finish=fields=>{checkAbort(signal);return {protocolVersion:1,ingestion:{...base,...fields}};};
  if(source.kind==='file'){
   if(data.episode)throw new Error('本地文件不能指定播客单集');
   return finish({state:'needs_transcription',media:{kind:source.media_kind,name:source.name,mimeType:source.type,availability:'local_session'},message:unavailableTranscription.message});
  }
  if(VIDEO_HOSTS.has(new URL(source.url).hostname)){
   if(data.episode)throw new Error('视频链接不能指定播客单集');
   const canonical=captionSource(source.url);base.source={...source,url:canonical.url,provider:canonical.provider,media_id:canonical.mediaId};
   if(!captionService?.available)return finish({state:'blocked',error:{code:'captions_unavailable',message:'字幕获取服务尚未就绪；此链接已保留，可在服务就绪后重试。'}});
   const result=await captionService.importCaption({url:canonical.url,language:data.language},{signal});
   return result.status==='ready'?finish({state:'ready',transcript:{document:result.document},...(result.diagnostics?{diagnostics:result.diagnostics}:{})}):finish({state:'blocked',error:{code:result.status,message:result.message,...(result.status==='language_required'?{languages:result.languages}:{}),...(result.diagnostic?{diagnostic:result.diagnostic}:{})}});
  }
  if(data.episode){
   const episode=data.episode;
   if(typeof episode!=='object'||Array.isArray(episode)||typeof episode.feed_url!=='string'||typeof episode.episode_id!=='string')throw new Error('请明确选择播客单集');
   // The adapter validates selection against its own recently checked RSS snapshot
   // (at most 60 seconds) or a fresh fetch, never client episode metadata.
   if(inputSource({kind:'url',url:episode.feed_url}).url!==source.url)throw new Error('单集来源与当前链接不一致');
   const selection={feedUrl:episode.feed_url,episodeId:episode.episode_id,...(episode.transcript_url?{transcriptUrl:episode.transcript_url}:{})};
   const result=await (data.intent==='media_only'?podcastSources.openEpisodeMedia(selection,{signal}):podcastSources.importEpisode(selection,{signal}));
   return finish({state:result.status==='ready'?'ready':'needs_transcription',source:{...source,feed_url:result.feed_url,episode_id:result.episode.id,...(result.feed_checked_at?{feed_checked_at:result.feed_checked_at,feed_reused:result.feed_reused}:{})},media:episodeMedia(result),project:result.status==='ready'?null:audioProject(source,episodeMedia(result),result.episode,result.feed_url),transcript:result.status==='ready'?{document:result.document}:null,...(result.status!=='ready'?{message:unavailableTranscription.message}:{})});
  }
  const discovery=await podcastSources.discover({url:source.url},{signal});
  if(discovery.kind==='media'){const media={kind:discovery.media.kind,url:discovery.media.url,name:discovery.title,mimeType:discovery.media.type,availability:'remote',download:{endpoint:'/api/podcasts/media',body:{url:discovery.media.url}}};return finish({state:'needs_transcription',media,project:audioProject(source,media),message:unavailableTranscription.message});}
  return finish({state:'awaiting_selection',selection:discovery});
 }
 return Object.freeze({capabilities,ingest});
}
