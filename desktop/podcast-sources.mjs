/** Public publisher sources for the zero-Python reader. No accounts, ASR or inference. */
import { createHash } from 'node:crypto';
import { fetchPublic, publicUrl, mime, isMediaType } from './public-http.mjs';
import { parseXml, decodeEntities } from './podcast-xml.mjs';

export const PODCAST_LIMITS=Object.freeze({metadataBytes:8*1024*1024,transcriptBytes:8*1024*1024,mediaBytes:200*1024*1024,episodes:200,segments:30000,duration:21600,concurrent:2});
const ATOM='http://www.w3.org/2005/Atom',PODCAST='https://podcastindex.org/namespace/1.0',ITUNES='http://www.itunes.com/dtds/podcast-1.0.dtd';
// The namespace's own Podcasting 2.0 feed still uses this earlier published URI.
const PODCAST_URIS=new Set([PODCAST,'https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md']);
const FEED_TYPES=new Set(['application/rss+xml','application/atom+xml','application/xml','text/xml','text/plain','application/octet-stream']);
const PAGE_TYPES=new Set([...FEED_TYPES,'text/html','application/xhtml+xml']);
const TRANSCRIPT_TYPES=new Set(['text/vtt','application/x-subrip','application/srt','text/srt','application/json']);
const JSON_TYPES=new Set(['application/json','text/javascript','application/javascript']);
const hash=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>String(value??'').replace(/<[^<>]*>/g,'').replace(/\s+/g,' ').trim();
const small=value=>plain(value).slice(0,500);
const nodeText=node=>node ? node.text+node.children.map(nodeText).join('') : '';
const child=(node,name,uri=node.uri)=>node.children.find(item=>item.local===name&&item.uri===uri);
const children=(node,name,uri=node.uri)=>node.children.filter(item=>item.local===name&&item.uri===uri);
const value=(node,name,uri=node.uri)=>nodeText(child(node,name,uri)).trim();
const language=value=>/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value||'') ? value.toLowerCase() : '';
const primary=value=>language(value).split('-')[0];
const isXiaoyuzhou=url=>['xiaoyuzhoufm.com','www.xiaoyuzhoufm.com'].includes(new URL(url).hostname);
const textBody=resource=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(resource.body);}catch{throw new Error('来源不是有效的 UTF-8 文本');}};
function safeLink(value,base) {try{return publicUrl(value,base).href;}catch{return '';}}
function seconds(value) {
  if(typeof value==='number')return Number.isFinite(value)&&value>0 ? value : null;
  if(!/^\d+(?::[0-5]?\d){0,2}(?:\.\d+)?$/.test(value||''))return null;
  const result=value.split(':').reduce((n,item)=>n*60+Number(item),0);return result>0 ? result : null;
}
function mediaItem(url,type,length,base) {
  const link=safeLink(url,base);type=mime(type);
  if(!link||!isMediaType(type))return null;
  const bytes=/^\d+$/.test(String(length))&&Number.isSafeInteger(Number(length)) ? Number(length) : null;
  return {url:link,type,kind:type.startsWith('video/')?'video':'audio',length:bytes};
}
export function parsePodcastFeed(text,feedUrl) {
  const root=parseXml(text,publicUrl(feedUrl).href);
  const atom=root.uri===ATOM&&['feed','entry'].includes(root.local);
  const channel=!atom&&root.local==='rss'&&root.uri===''?child(root,'channel',''):root;
  if(!channel||(!atom&&channel===root))throw new Error('来源不是 RSS 2.0 或 Atom 播客源');
  const items=atom?(root.local==='entry'?[root]:children(root,'entry',ATOM)):children(channel,'item','');
  const feedLanguage=language(atom?root.language:value(channel,'language',''));
  const seen=new Set(),episodes=[];let skipped=0;
  for(const item of items) {
    const itemLanguage=language(item.language)||feedLanguage;
    const media=(atom?children(item,'link',ATOM).filter(n=>n.attrs.rel==='enclosure').map(n=>mediaItem(n.attrs.href,n.attrs.type,n.attrs.length,n.base)):
      children(item,'enclosure','').map(n=>mediaItem(n.attrs.url,n.attrs.type,n.attrs.length,n.base))).filter(Boolean);
    const transcripts=item.children.filter(n=>n.local==='transcript'&&PODCAST_URIS.has(n.uri)).map(n=>({url:safeLink(n.attrs.url,n.base),type:mime(n.attrs.type),language:language(n.attrs.language)||itemLanguage,rel:n.attrs.rel==='captions'?'captions':'',supported:TRANSCRIPT_TYPES.has(mime(n.attrs.type))})).filter(t=>t.url);
    if(!media.length&&!transcripts.length){skipped++;continue;}
    const linkNode=atom?children(item,'link',ATOM).find(n=>!n.attrs.rel||n.attrs.rel==='alternate'):child(item,'link','');
    const sourceUrl=safeLink(atom?linkNode?.attrs.href:nodeText(linkNode).trim(),linkNode?.base||item.base);
    const guid=value(item,atom?'id':'guid',atom?ATOM:'')||sourceUrl||media[0]?.url||transcripts[0]?.url;
    const id=hash(guid);if(seen.has(id)){skipped++;continue;}seen.add(id);
    episodes.push({id,title:small(value(item,'title',atom?ATOM:''))||'未命名单集',source_url:sourceUrl||feedUrl,
      language:itemLanguage,duration:seconds(value(item,'duration',ITUNES)),published:small(value(item,atom?'published':'pubDate',atom?ATOM:'')),media,transcripts});
    if(episodes.length===PODCAST_LIMITS.episodes)break;
  }
  if(!episodes.length)throw new Error('此源中没有可用的公开音视频 enclosure 或发布者文字稿');
  return {kind:'feed',title:small(value(channel,'title',atom?ATOM:''))||'播客',feed_url:feedUrl,language:feedLanguage,episodes,feeds:[],
    truncated:items.length>episodes.length+skipped,warnings:['发布者提供的文字稿不等于人工校对；没有文字稿时不会自动识别。']};
}
function htmlAttributes(tag) {
  const result=Object.create(null),text=tag.replace(/^<\/?[^\s/>]+/,'').replace(/\/?>$/,'');
  const pattern=/\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;let position=0,count=0;
  while(position<text.length){
    pattern.lastIndex=position;const match=pattern.exec(text);
    if(!match){if(text.slice(position).trim())return Object.create(null);break;}
    if(++count>128)return Object.create(null);
    position=pattern.lastIndex;
    try{const key=match[1].toLowerCase();if(!Object.hasOwn(result,key))result[key]=decodeEntities(match[2]??match[3]??match[4]??'');}catch{return Object.create(null);}
  }
  return result;
}
function* htmlElements(html) {
  // Only actual start tags count. Ignore comments, raw-text elements and inert
  // subtrees; a stale JSON example inside a comment/template is not page state.
  const tagName=/<\/?([a-zA-Z][a-zA-Z0-9:-]*)/y;
  const inert=[];let position=0;
  while(position<html.length) {
    const start=html.indexOf('<',position);if(start<0)return;
    if(html.startsWith('<!--',start)){const end=html.indexOf('-->',start+4);if(end<0)return;position=end+3;continue;}
    if(/^<[!?]/.test(html.slice(start,start+2))){const end=html.indexOf('>',start+2);if(end<0)return;position=end+1;continue;}
    tagName.lastIndex=start;const match=tagName.exec(html);
    if(!match){if(/^<\/?[a-zA-Z]/.test(html.slice(start,start+3)))return;position=start+1;continue;}
    let end=tagName.lastIndex,quote='';
    for(;end<html.length;end++){
      const character=html[end];
      if(quote){if(character===quote)quote='';}
      else if(character==='"'||character==="'")quote=character;
      else if(character==='>')break;
      else if(character==='<')return;
    }
    if(end===html.length)return;
    const tag=html.slice(start,end+1);position=end+1;
    const name=match[1].toLowerCase(),closing=tag.startsWith('</');
    if(closing){if(inert.at(-1)===name)inert.pop();continue;}
    if(name==='plaintext')return;
    if(['template','svg','math'].includes(name)){inert.push(name);continue;}
    if(['script','style','textarea','title','xmp','iframe','noembed','noframes','noscript'].includes(name)) {
      const end=new RegExp('</'+name+'\\s*>','ig');end.lastIndex=position;const finish=end.exec(html);if(!finish)return;
      const body=html.slice(position,finish.index);position=end.lastIndex;
      if(name==='script'&&!inert.length)yield {name,attrs:htmlAttributes(tag),body};
      continue;
    }
    if(!inert.length)yield {name,attrs:htmlAttributes(tag),body:''};
  }
}
export function publisherFeeds(html,url) {
  const feeds=[];
  for(const element of htmlElements(html)) {
    if(element.name!=='link')continue;
    const attrs=element.attrs,href=safeLink(attrs.href,url);
    if(href&&attrs.rel?.toLowerCase().split(/\s+/).includes('alternate')&&['application/rss+xml','application/atom+xml'].includes(mime(attrs.type))&&!feeds.some(item=>item.url===href))feeds.push({url:href,title:small(attrs.title)||'发布者 RSS / Atom'});
    if(feeds.length===10)break;
  }
  return feeds;
}
export function parseXiaoyuzhouPage(html,url) {
  const source=publicUrl(url),match=source.pathname.match(/^\/(podcast|episode)\/([a-f0-9]{24})\/?$/);
  if(!isXiaoyuzhou(url)||!match)throw new Error('请提供小宇宙官方节目或单集分享链接');
  let state;
  for(const element of htmlElements(html)) {
    if(element.name==='script'&&element.attrs.id==='__NEXT_DATA__'&&element.attrs.type==='application/json') {
      if(state)throw new Error('小宇宙公开页面含重复状态数据');
      try{state=JSON.parse(element.body);}catch{throw new Error('小宇宙公开页面数据无效');}
    }
  }
  const page=state?.props?.pageProps,show=page?.podcast;
  if((match[1]==='podcast'&&show?.pid!==match[2])||(match[1]==='episode'&&page?.episode?.eid!==match[2]))throw new Error('小宇宙页面未提供与链接匹配的公开节目数据');
  const candidates=match[1]==='episode'?[page.episode]:Array.isArray(show.episodes)?show.episodes:[];
  const episodes=[];
  for(const item of candidates.slice(0,PODCAST_LIMITS.episodes)) {
    if(!/^[a-f0-9]{24}$/.test(item?.eid)||item.status!=='NORMAL'||item.payType!=='FREE'||item.isPrivateMedia!==false||item.media?.source?.mode!=='PUBLIC'||
       (match[1]==='podcast'&&item.pid!==match[2])||item.enclosure?.url!==item.media.source.url)continue;
    const media=mediaItem(item.media.source.url,item.media.mimeType,item.media.size,url);
    if(!media)continue;
    episodes.push({id:hash(item.eid),title:small(item.title)||'未命名单集',source_url:`https://www.xiaoyuzhoufm.com/episode/${item.eid}`,
      language:'',duration:seconds(item.duration),published:small(item.pubDate),media:[media],transcripts:[]});
  }
  if(!episodes.length)throw new Error('此小宇宙页面没有同时明确标记免费、非私有、公开媒体的可导入单集。请使用主播公开 RSS 或合法本地文件');
  return {kind:'feed',source_type:'xiaoyuzhou_public_page',title:small(show?.title||page?.episode?.podcast?.title||page?.episode?.title)||'小宇宙公开播客',feed_url:source.href,language:'',episodes,feeds:[],
    truncated:match[1]==='podcast',warnings:['仅列出此公开页面当前展示、明确免费且非私有的单集，不是完整订阅。','此入口只提供公开媒体；未获取时间戳文字稿，简介、时间轴和平台 AI 摘要不会冒充原文。']};
}
function subtitleText(text) {
  const stripped=text.replace(/<[^<>]*>/g,'');
  try{return decodeEntities(stripped.replace(/&nbsp;/g,' ')).trim();}catch{throw new Error('字幕含不支持的字符实体');}
}
function cueTime(value) {
  if(!/^(?:\d{2,}:)?[0-5]\d:[0-5]\d[.,]\d{3}$/.test(value))throw new Error('文字稿时间格式无效');
  return value.replace(',','.').split(':').reduce((n,v)=>n*60+Number(v),0);
}
export function parsePublisherTranscript(text,type) {
  let segments=[];
  if(mime(type)==='application/json') {
    let data;try{data=JSON.parse(text);}catch{throw new Error('发布者 JSON 文字稿无效');}
    if(!Array.isArray(data?.segments)||data.segments.length>PODCAST_LIMITS.segments)throw new Error('仅支持有界的 Podcasting 2.0 segments 时间戳 JSON');
    segments=data.segments.map(cue=>({start:cue?.startTime??cue?.start,end:cue?.endTime??cue?.end,text:cue?.body??cue?.text,speaker:typeof cue?.speaker==='string'?cue.speaker:null}));
  } else {
    const normalized=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
    if(type==='text/vtt'&&!/^WEBVTT(?:[ \t]|\n|$)/.test(normalized))throw new Error('发布者返回的内容不是 WebVTT');
    const blocks=normalized.split(/\n\s*\n/);
    for(const [blockIndex,block] of blocks.entries()) {
      if(!block.trim())continue;
      if(type==='text/vtt'&&blockIndex===0&&/^WEBVTT(?:[ \t]|\n|$)/.test(block)){
        if(block.includes('-->'))throw new Error('WebVTT 头部与字幕缺少空行');
        continue;
      }
      if(type==='text/vtt'&&/^(?:NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block)){
        if(block.includes('-->'))throw new Error('WebVTT 头部与字幕缺少空行，或元数据含无效时间');
        continue;
      }
      const lines=block.split('\n'),i=lines.findIndex(line=>line.includes('-->'));
      if(i<0||i>1||lines.filter(line=>line.includes('-->')).length!==1)throw new Error('文字稿存在无法识别或缺少分隔的字幕块，未导入部分结果');
      const match=lines[i].match(/^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/);if(!match)throw new Error('文字稿时间格式无效');
      const start=cueTime(match[1]),end=cueTime(match[2]),body=subtitleText(lines.slice(i+1).join('\n'));
      if(!body)throw new Error('文字稿包含空白字幕，未导入部分结果');
      segments.push({start,end,text:body,speaker:null});
    }
  }
  if(!segments.length||segments.length>PODCAST_LIMITS.segments)throw new Error('文字稿为空或片段过多');
  let prior=-1;
  return segments.map((cue,index)=>{
    if(!Number.isFinite(cue.start)||!Number.isFinite(cue.end)||cue.start<0||cue.end<cue.start||cue.end>PODCAST_LIMITS.duration||cue.start<prior||typeof cue.text!=='string'||!cue.text.trim()||cue.text.length>12000)throw new Error('发布者文字稿的时间戳或正文无效（最多6小时）');
    prior=cue.start;
    return {id:'segment-'+(index+1),start:cue.start,end:cue.end,text:cue.text.trim(),speaker:cue.speaker?.slice(0,120)||null};
  });
}
export function createPodcastSources({fetchResource=fetchPublic}={}) {
  let active=0;
  const bounded=async action=>{if(active>=PODCAST_LIMITS.concurrent)throw new Error('最多同时处理两个播客请求，请稍后重试');active++;try{return await action();}finally{active--;}};
  async function feed(url,signal) {
    const input=publicUrl(url),xiaoyuzhou=isXiaoyuzhou(input.href);
    const resource=await fetchResource(input.href,{signal,maxBytes:PODCAST_LIMITS.metadataBytes,types:xiaoyuzhou?PAGE_TYPES:FEED_TYPES});
    if(xiaoyuzhou)return parseXiaoyuzhouPage(textBody(resource),resource.url);
    return parsePodcastFeed(textBody(resource),resource.url);
  }
  async function discover({url}={}, {signal}={}) {
    const input=publicUrl(url);
    if(/(?:^|\.)spotify\.com$/.test(input.hostname))throw new Error('Spotify 链接不能用于提取音轨。请提供该节目的原发布者公开 RSS，或合法取得的音视频文件');
    if(['podcasts.apple.com','itunes.apple.com'].includes(input.hostname)) {
      const id=input.pathname.match(/\/id(\d+)(?:\/|$)/)?.[1];if(!id)throw new Error('请使用含节目 ID 的 Apple Podcasts 分享链接');
      const country=input.pathname.match(/^\/([a-z]{2})\//)?.[1]||'us';
      const lookup=await fetchResource(`https://itunes.apple.com/lookup?id=${id}&entity=podcast&country=${country}`,{signal,maxBytes:1024*1024,types:JSON_TYPES});
      let data;try{data=JSON.parse(textBody(lookup));}catch{throw new Error('Apple 目录返回无效数据');}
      const show=Array.isArray(data.results)&&data.results.find(item=>String(item.collectionId)===id&&item.kind==='podcast'&&item.feedUrl);
      if(!show)throw new Error('Apple 目录未提供此节目的公开 RSS；请提供原发布者 RSS 或合法本地文件');
      const result=await feed(show.feedUrl,signal);
      return {...result,resolved_from:input.href,warnings:[...result.warnings,input.searchParams.has('i')?'此分享链接指向单集；目录只确认节目 RSS，请在列表中明确选择对应单集，不会自动导入最新一集。':'已通过 Apple 公开目录找到发布者 RSS；仅使用 RSS 中发布的文件。']};
    }
    const resource=await fetchResource(input.href,{signal,maxBytes:PODCAST_LIMITS.metadataBytes,types:PAGE_TYPES,inspectMedia:true,maxMediaBytes:PODCAST_LIMITS.mediaBytes});
    if(isMediaType(resource.type))return {kind:'media',title:small(decodeURIComponent(new URL(resource.url).pathname.split('/').pop()||'公开媒体')),feed_url:'',episodes:[],feeds:[],media:mediaItem(resource.url,resource.type,resource.length,resource.url),warnings:['仅获取了媒体响应头，尚未下载；没有文字稿，不会自动识别。媒体时长将在播放时由浏览器确认。']};
    const text=textBody(resource);
    if(!['text/html','application/xhtml+xml'].includes(resource.type))return parsePodcastFeed(text,resource.url);
    const feeds=publisherFeeds(text,resource.url);
    if(isXiaoyuzhou(input.href)&&!feeds.length)return parseXiaoyuzhouPage(text,resource.url);
    // No hidden platform API, arbitrary JSON-state media extraction or authentication fallback.
    if(!feeds.length)throw new Error(['xiaoyuzhoufm.com','www.xiaoyuzhoufm.com'].includes(input.hostname)?'小宇宙此公开页面未声明可用 RSS。请提供主播公开 RSS 或合法本地音视频；节目简介和时间轴不是完整文字稿':'此页面未声明公开 RSS / Atom，请提供发布者 RSS 或音视频文件直链');
    return {kind:'choices',title:'选择发布者公开源',feed_url:'',episodes:[],feeds,warnings:['页面入口不是单集导入；选择 RSS 后，还需明确选择一集。']};
  }
  async function chosen(data,signal) {
    if(!data||typeof data.episodeId!=='string'||!/^[a-f0-9]{64}$/.test(data.episodeId))throw new Error('请先明确选择一集播客');
    const current=await feed(data.feedUrl,signal),episode=current.episodes.find(item=>item.id===data.episodeId);
    if(!episode)throw new Error('所选单集不在当前公开源列表中，请刷新来源后重选');
    return {current,episode};
  }
  async function importEpisode(data, {signal}={}) {
    const {current,episode}=await chosen(data,signal),available=episode.transcripts.filter(t=>t.supported);
    if(!available.length)return {status:'needs_transcription',episode,feed_url:current.feed_url,message:'此单集没有可导入的发布者时间戳文字稿；可选择合法字幕文件，不会自动识别或下载模型。'};
    let transcript;
    if(data.transcriptUrl)transcript=available.find(item=>item.url===data.transcriptUrl);
    else {
      const matching=available.filter(t=>primary(t.language)===primary(episode.language));
      if(!matching.length || new Set(matching.map(t=>primary(t.language))).size>1)throw new Error('请明确选择要导入的文字稿语言');
      transcript=matching.find(t=>t.type==='text/vtt')||matching.find(t=>t.type==='application/x-subrip')||matching[0];
    }
    if(!transcript)throw new Error('所选文字稿不在此单集当前公开源中');
    const resource=await fetchResource(transcript.url,{signal,maxBytes:PODCAST_LIMITS.transcriptBytes,types:new Set([transcript.type,'text/plain','application/octet-stream'])});
    const segments=parsePublisherTranscript(textBody(resource),transcript.type);
    const medium=episode.media[0];
    const document={schema_version:1,title:episode.title,source_url:episode.source_url,language:transcript.language||episode.language||null,segments,
      provenance:{kind:'publisher_transcript',caption_method:'publisher_provided',caption_track:transcript.url,subtitle_check:'found',language_basis:'publisher_metadata',review_status:'unreviewed',source_platform:'podcast_rss',...(medium?{source_medium:medium.kind}:{}),...(episode.duration&&episode.duration<=PODCAST_LIMITS.duration?{media_duration:episode.duration}:{})},
      podcast_source:{feed_url:current.feed_url,episode_id:episode.id,transcript_url:transcript.url,...(medium?{media_url:medium.url,media_kind:medium.kind}:{})}};
    return {status:'ready',document,episode,feed_url:current.feed_url};
  }
  async function downloadMedia(data,{signal}={}) {
    const maxBytes=data?.maxBytes??PODCAST_LIMITS.mediaBytes;
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>PODCAST_LIMITS.mediaBytes)throw new Error('媒体下载大小上限无效');
    let media;
    if(data?.feedUrl) {
      const {episode}=await chosen(data,signal);
      if(episode.duration>PODCAST_LIMITS.duration)throw new Error('此单集时长超过6小时');
      media=episode.media.find(item=>item.url===data.mediaUrl);
      if(!media)throw new Error('媒体链接不在所选单集当前的公开 enclosure 中');
      if(media.length>maxBytes)throw new Error('发布者声明的媒体超过本次下载大小上限（最多200 MiB）');
    } else {media={url:publicUrl(data?.url).href};}
    const types=new Set(['audio/mpeg','audio/mp3','audio/mp4','audio/x-m4a','audio/aac','audio/wav','audio/wave','audio/x-wav','audio/ogg','audio/flac','audio/x-flac','audio/webm','video/mp4','video/webm','video/ogg','video/quicktime']);
    const resource=await fetchResource(media.url,{signal,maxBytes,timeoutMs:120000,types});
    const kind=resource.type.startsWith('video/')?'video':'audio';
    if(media.kind&&media.kind!==kind)throw new Error('媒体类型与发布者 enclosure 声明不符');
    if(!resource.body.length)throw new Error('媒体文件为空');
    return {body:resource.body,type:resource.type,kind,filename:kind==='video'?'podcast-video':'podcast-audio'};
  }
  return {discover:(...args)=>bounded(()=>discover(...args)),importEpisode:(...args)=>bounded(()=>importEpisode(...args)),downloadMedia:(...args)=>bounded(()=>downloadMedia(...args))};
}
