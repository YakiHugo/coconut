/** Read-only feasibility probe, NOT an enabled import adapter or acceptance pass.
 * Fixed public samples, no cookies, credentials, proxy or attestation bypass.
 * Logs counts/reasons only; fetched page/caption bodies stay transient.
 */
import { fetchPublic, publicUrl } from '../desktop/public-http.mjs';
import { parsePublisherTranscript } from '../desktop/podcast-sources.mjs';
const signal=AbortSignal.timeout(120000);
const report=(provider,sample,result)=>console.log(JSON.stringify({check:'anonymous_caption_feasibility',provider,sample,...result}));
const json=async url=>JSON.parse((await fetchPublic(url,{signal,maxBytes:2*1024*1024,timeoutMs:15000,types:new Set(['application/json','text/plain','text/javascript'])})).body.toString('utf8'));
function safeTrack(value,allowed){
 const url=publicUrl(value.startsWith('//')?'https:'+value:value);
 if(url.protocol!=='https:'||!allowed(url))throw new Error('unsupported_caption_destination');
 return url.href;
}
async function bilibili(bvid){
 try{
  const view=await json(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  if(view.code!==0||view.data?.bvid!==bvid||!Number.isSafeInteger(view.data?.cid)||view.data.cid<1)return report('bilibili',bvid,{outcome:'public_metadata_unavailable'});
  const player=await json(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${view.data.cid}`);
  if(player.code!==0)return report('bilibili',bvid,{outcome:'public_player_unavailable'});
  if(player.data?.need_login_subtitle===true||player.data?.need_login_subtitle===1)return report('bilibili',bvid,{outcome:'login_required'});
  const tracks=player.data?.subtitle?.subtitles;
  if(!Array.isArray(tracks)||!tracks.length)return report('bilibili',bvid,{outcome:'no_anonymous_caption_tracks',login_required:player.data?.need_login_subtitle===true});
  let unsigned=0,usable=0;
  for(const track of tracks.slice(0,3)){
   let url;try{url=safeTrack(track.subtitle_url,url=>url.hostname==='aisubtitle.hdslb.com'||url.hostname==='i0.hdslb.com'||url.hostname==='subtitle.bilibili.com');}catch{continue;}
   unsigned++;
   const data=await json(url);
   if(!Array.isArray(data.body))continue;
   const segments=parsePublisherTranscript(JSON.stringify({segments:data.body.map(cue=>({start:cue.from,end:cue.to,text:cue.content}))}),'application/json');
   if(segments.length>1)usable++;
  }
  report('bilibili',bvid,{outcome:usable?'unsigned_caption_data_observed':'no_usable_unsigned_caption_data',tracks:tracks.length,unsigned_examined:unsigned,usable_tracks:usable});
 }catch{report('bilibili',bvid,{outcome:'transport_or_schema_unavailable'});}
}
function initialPlayer(html){
 const marker='ytInitialPlayerResponse = ';
 const start=html.indexOf(marker);if(start<0)return null;
 const offset=html.indexOf('{',start+marker.length);if(offset<0)return null;
 let depth=0,quoted=false,escaped=false;
 for(let i=offset;i<html.length;i++){
  const ch=html[i];if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
  if(ch==='"')quoted=true;else if(ch==='{')depth++;else if(ch==='}'&&!--depth)return JSON.parse(html.slice(offset,i+1));
 }
 return null;
}
async function youtube(id){
 try{
  const page=await fetchPublic(`https://www.youtube.com/watch?v=${id}`,{signal,maxBytes:8*1024*1024,timeoutMs:15000,types:new Set(['text/html'])});
  const data=initialPlayer(page.body.toString('utf8'));
  if(data?.videoDetails?.videoId!==id||data?.playabilityStatus?.status!=='OK')return report('youtube',id,{outcome:'public_player_unavailable'});
  const tracks=data.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if(!Array.isArray(tracks)||!tracks.length)return report('youtube',id,{outcome:'no_anonymous_caption_tracks'});
  let unsigned=0,nonempty=0;
  for(const track of tracks.slice(0,3)){
   let url;try{url=safeTrack(track.baseUrl,url=>url.hostname==='www.youtube.com'&&url.pathname==='/api/timedtext');}catch{continue;}
   unsigned++;
   const resource=await fetchPublic(url,{signal,maxBytes:8*1024*1024,timeoutMs:15000,types:new Set(['text/xml','application/xml','application/json','text/vtt'])});
   if(resource.body.length)nonempty++;
  }
  report('youtube',id,{outcome:nonempty?'unsigned_caption_bytes_observed_unverified':'no_usable_unsigned_caption_data',tracks:tracks.length,unsigned_examined:unsigned,nonempty_responses:nonempty});
 }catch{report('youtube',id,{outcome:'transport_or_schema_unavailable'});}
}
await youtube('UF8uR6Z6KLc');
await bilibili('BV1oW411h7Ea');
await bilibili('BV1314y1R7r1');

try{
 const data=await json('https://cdn.syndication.twimg.com/tweet-result?id=2105733670493651236&lang=en');
 const media=Array.isArray(data.mediaDetails)?data.mediaDetails:[];
 report('x','2105733670493651236',{outcome:String(data.id_str)==='2105733670493651236'?'public_metadata_observed':'public_metadata_unavailable',media_items:media.length,video_items:media.filter(item=>item.type==='video').length});
}catch{report('x','2105733670493651236',{outcome:'transport_or_schema_unavailable'});}
