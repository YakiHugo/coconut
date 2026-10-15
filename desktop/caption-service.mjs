/** Captions become source documents only after bounded extraction and identity checks. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(import.meta.url);
const MAX_BYTES=8*1024*1024;
const MAX_DURATION=6*3600;

export const CAPTION_FAILURE_STATUSES=Object.freeze(['unavailable','access_restricted','language_required','network_unavailable','metadata_incomplete','no_matching_captions','extractor_failed','caption_file_invalid','caption_parse_failed','guard_stopped']);
const diagnosticStages=new Set(['initialization','extractor_setup','metadata','track_selection','caption_download','caption_parse','caption_output','helper_execution','reader_parse']);
const diagnosticReasons=new Set(['access_restricted','transport_unavailable','metadata_incomplete','request_scope_stopped','non_public_address','identity_mismatch','budget_exceeded','unexpected_response','upstream_error','dependency_mismatch','alternate_extractor_stopped','unsupported_request','external_execution_stopped','duration_unavailable','redirect_stopped','guard_stopped','language_unknown','no_matching_track','invalid_caption_file','caption_parse_failed','caption_download_or_file_failed','extractor_error','helper_error']);
// Only finite enum/counter observations cross the helper, UI and report boundary.
// An attempted request is not evidence of reaching the platform.
export function captionDiagnostic(value){
 if(!value||typeof value!=='object'||!diagnosticStages.has(value.stage)||!diagnosticReasons.has(value.reason))return null;
 const counts=[value.requests_attempted,value.responses_received];
 const unknown=['helper_execution','reader_parse'].includes(value.stage)&&counts.every(n=>n===null);
 if(!unknown&&(!counts.every(n=>Number.isInteger(n)&&n>=0&&n<=32)||counts[1]>counts[0]))return null;
 return {stage:value.stage,reason:value.reason,requests_attempted:counts[0],responses_received:counts[1]};
}
const failureMessages={
 metadata_incomplete:'来源未提供足够的访问或视频完成状态，暂不能安全导入；可稍后重试或导入已有字幕。',
 network_unavailable:'网络或 TLS 连接未完成，无法判断字幕是否可用；请检查网络后重试。',
 language_required:'无法确认原语言，请选择后重试；未启动识别。',
 access_restricted:'当前公开入口受限，未尝试登录或绕过限制；可打开原站或导入合法取得的字幕。',
 no_matching_captions:'已检查来源元数据，未找到匹配原语言的可用字幕轨道；这不代表其他语言也没有字幕。可导入已有 SRT / VTT；未启动识别。',
 extractor_failed:'字幕提取器未完成，无法判断平台是否有字幕。可导入已有 SRT / VTT；未启动识别。',
 caption_file_invalid:'字幕下载或文件检查未完成，不能判定为没有字幕。可导入已有 SRT / VTT；未启动识别。',
 caption_parse_failed:'已取得的字幕无法解析，未导入。可检查或重新导出 SRT / VTT 后导入；未启动识别。',
 guard_stopped:'公开字幕获取已在边界检查处停止，不能判定为没有字幕；未绕过限制。可导入合法取得的 SRT / VTT。',
 unavailable:'当前入口未取得可用公开字幕，未启动识别、下载媒体或模型。',
};

export function captionSource(value){
 if(typeof value!=='string'||value.length>4096)throw new Error('请输入公开单视频链接');
 let url;try{url=new URL(value);}catch{throw new Error('请输入有效的公开单视频链接');}
 if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')throw new Error('只接受不含登录凭据的 HTTPS 单视频链接');
 let provider,identity;
 if(['x.com','www.x.com','twitter.com','www.twitter.com','mobile.twitter.com'].includes(url.hostname)&&/^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/status)\/[0-9]{1,20}\/?$/.test(url.pathname)){
  provider='x';identity=url.pathname.replace(/\/$/,'').split('/').at(-1);url.hostname='x.com';url.pathname=url.pathname.replace(/\/$/,'');url.search='';
 }else if(['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(url.hostname)){
  identity=url.hostname==='youtu.be'?url.pathname.replace(/^\/|\/$/g,''):url.pathname==='/watch'?url.searchParams.get('v'):/^\/shorts\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)?url.pathname.split('/')[2]:null;
  if(!/^[A-Za-z0-9_-]{11}$/.test(identity||'')||url.searchParams.getAll('v').length>1)throw new Error('请输入单个 YouTube 视频链接');
  provider='youtube';url.hostname='www.youtube.com';url.pathname='/watch';url.search='?v='+identity;
 }else if(['bilibili.com','www.bilibili.com','m.bilibili.com'].includes(url.hostname)&&/^\/video\/BV[A-Za-z0-9]{10}\/?$/.test(url.pathname)){
  if(url.searchParams.has('p')&&url.searchParams.get('p')!=='1')throw new Error('请使用单视频 BV 链接；暂不支持指定分 P');
  provider='bilibili';identity=url.pathname.split('/')[2];url.hostname='www.bilibili.com';url.pathname='/video/'+identity;url.search='';
 }else throw new Error('请使用公开 X、YouTube 单视频或 Bilibili BV 链接；短跳转链接需先在原站展开');
 url.hash='';return {url:url.href,provider,postId:identity,mediaId:identity};
}

export function createCaptionService({helper,readerDirectory=path.resolve(ROOT,'../reader'),enabledProviders=[]}={}){
 const enabled=new Set(enabledProviders);
 const Coconut=require(path.join(readerDirectory,'core.js'));
 let busy=false;
 const providers=Object.freeze(['x','youtube','bilibili'].filter(provider=>helper&&enabled.has(provider)));
 const available=providers.length>0;
 return Object.freeze({
  available,providers,
  async importCaption(data,{signal}={}){
   if(!available)throw new Error('此版本尚未启用内置视频字幕获取，可导入已有字幕；不会启动识别或下载模型');
   const source=captionSource(data?.url);
   if(!enabled.has(source.provider))throw new Error('此视频来源尚未启用');
   const language=data?.language||null;
   if(language!==null&&(typeof language!=='string'||!/^([a-z]{2,3})(-[A-Za-z0-9]{2,8}){0,2}$/.test(language)))throw new Error('原语言标记无效');
   if(busy)throw new Error('正在获取另一份字幕，请等候完成或取消后再试');
   if(signal?.aborted)throw new Error('已取消获取字幕');
   busy=true;
   try{
    const result=await helper.extractCaptions({url:source.url,language,signal});
    if(signal?.aborted)throw new Error('已取消获取字幕');
    if(!result||typeof result!=='object')throw new Error('字幕获取未返回有效结果');
    if(result.status&&result.status!=='ready'){
     // Do not turn retrieval failure or access denial into a claim of absent subtitles.
     if(!CAPTION_FAILURE_STATUSES.includes(result.status))throw new Error('字幕获取未完成，请重试或导入字幕文件');
     const diagnostic=captionDiagnostic(result.diagnostic);
     const message=result.status==='extractor_failed'&&diagnostic?.requests_attempted===0&&['initialization','extractor_setup'].includes(diagnostic.stage)
      ?'本机字幕提取器初始化未完成，尚未尝试来源网络请求；无法判断是否有字幕。可导入已有 SRT / VTT。'
      :failureMessages[result.status];
     return {status:result.status,source_url:source.url,message,...(diagnostic?{diagnostic}:{})};
    }
    const meta=result.source;
    if(!meta||captionSource(meta.url).url!==source.url||typeof meta.id!=='string'||!(source.provider==='x'?/^\d{1,20}$/.test(meta.id):meta.id===source.mediaId))throw new Error('字幕来源与请求无法核对，未导入');
    if(!(source.provider==='x'?['twitter','Twitter']:source.provider==='youtube'?['youtube','Youtube']:['bilibili','BiliBili']).includes(meta.extractor))throw new Error('字幕获取来源类型无法核对');
    if(meta.live||meta.is_live||meta.live_status&&!['not_live','was_live'].includes(meta.live_status)||source.provider==='youtube'&&!['not_live','was_live'].includes(meta.live_status)||meta.playlist||meta.entries||meta._type&&meta._type!=='video')throw new Error('只接受已结束的单视频，不导入直播或合集');
    if(!Number.isFinite(meta.duration)||meta.duration<=0||meta.duration>MAX_DURATION)throw new Error('无法确认视频时长，或超过六小时上限');
    if(!Buffer.isBuffer(result.bytes)||!result.bytes.length||result.bytes.length>MAX_BYTES||!['vtt','srt'].includes(result.format))throw new Error('字幕文件类型或大小不符合导入要求');
    if(typeof meta.language!=='string'||!/^([a-z]{2,3})(-[A-Za-z0-9]{2,8}){0,2}$/.test(meta.language))throw new Error('无法确认字幕原语言');
    if(language&&language.split('-')[0]!==meta.language.split('-')[0])throw new Error('字幕语言与所选原语言不一致');
    if(typeof meta.automatic!=='boolean'||meta.translated===true)throw new Error('无法确认这是原语言字幕，未导入');
    const track=result.track||{};
    if(track.language&&track.language!==meta.language||track.captionMethod&&track.captionMethod!==(meta.automatic?'automatic':'platform_provided'))throw new Error('字幕轨道与来源记录不一致');
    const basis=track.languageBasis||meta.language_basis||'unknown';
    if(!['user_hint','platform_metadata','original_track','single_track','unknown'].includes(basis))throw new Error('字幕语言依据无法核对');
    let parsed;
    try{const text=new TextDecoder('utf-8',{fatal:true}).decode(result.bytes);parsed=Coconut.parseWithDiagnostics(text,'captions.'+result.format);}
    catch(error){error.code='CAPTION_PARSE_FAILED';throw error;}
    const {document,diagnostics}=parsed;
    if(!document.segments.length||document.segments.length>20000||document.segments.some(cue=>cue.end>meta.duration+1||cue.end>MAX_DURATION))throw new Error('字幕片段范围与视频时长无法核对');
    document.title=typeof meta.title==='string'&&meta.title.trim()?meta.title.trim().slice(0,500):'视频文字稿';
    document.source_url=source.url;document.language=meta.language;
    document.provenance={kind:meta.automatic?'automatic_subtitles':'platform_subtitles',caption_method:meta.automatic?'automatic':'platform_provided',review_status:'unreviewed',language:meta.language,caption_track:String(track.captionTrack||meta.caption_track||meta.language).slice(0,100),language_basis:basis,subtitle_check:'found',source_platform:source.provider,source_medium:'video',media_id:meta.id,media_duration:meta.duration};
    // Keep parse loss on this import receipt, outside document identity and provenance.
    return {status:'ready',document:Coconut.validate(document),diagnostics};
   }finally{busy=false;}
  }
 });
}
