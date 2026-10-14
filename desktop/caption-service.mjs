/** Captions become source documents only after bounded extraction and identity checks. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(import.meta.url);
const MAX_BYTES=8*1024*1024;
const MAX_DURATION=6*3600;

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
     if(!['unavailable','access_restricted','language_required','network_unavailable','metadata_incomplete'].includes(result.status))throw new Error('字幕获取未完成，请重试或导入字幕文件');
     return {status:result.status,source_url:source.url,message:result.status==='metadata_incomplete'?'来源未提供足够的访问或视频完成状态，暂不能安全导入；可稍后重试或导入已有字幕。':result.status==='network_unavailable'?'网络或 TLS 连接未完成，无法判断字幕是否可用；请检查网络后重试。':result.status==='language_required'?'无法确认原语言，请选择后重试；未启动识别。':result.status==='access_restricted'?'当前公开入口受限，未尝试登录或绕过限制；可打开原站或导入合法取得的字幕。':'当前入口未取得可用公开字幕，未启动识别、下载媒体或模型。'};
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
    const text=new TextDecoder('utf-8',{fatal:true}).decode(result.bytes);
    const {document,diagnostics}=Coconut.parseWithDiagnostics(text,'captions.'+result.format);
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
