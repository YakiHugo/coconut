import {downloadedMediaFile} from './ingestion-media';
import {inspectFile} from './ingestion';
export type VideoAudioFallback={endpoint:'/api/videos/media';url:string;language:string|null};
function source(value:unknown){
 if(typeof value!=='string')return null;
 const youtube=/^https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})$/.exec(value);
 const bilibili=/^https:\/\/www\.bilibili\.com\/video\/(BV[A-Za-z0-9]{10})$/.exec(value);
 return youtube?{provider:'youtube',id:youtube[1]}:bilibili?{provider:'bilibili',id:bilibili[1]}:null;
}
export function videoAudioFallback(value:unknown):VideoAudioFallback|null{
 const item=value as VideoAudioFallback;
 return item?.endpoint==='/api/videos/media'&&source(item.url)&&(item.language===null||typeof item.language==='string'&&/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(item.language))?{endpoint:item.endpoint,url:item.url,language:item.language}:null;
}
export async function downloadVideoAudio(value:VideoAudioFallback,signal:AbortSignal){
 const fallback=videoAudioFallback(value);if(!fallback)throw Error('公开媒体操作身份无效。');
 const response=await fetch('api/videos/media',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:fallback.url,language:fallback.language,consent:true}),signal});
 if(!response.ok){const error=await response.json();throw Error(typeof error.error==='string'?error.error:'公开媒体检查未完成，未创建项目。');}
 const encoded=response.headers.get('X-Coconut-Media-Source')||'';
 if(!encoded||encoded.length>8192||!/^[A-Za-z0-9_-]+$/.test(encoded))throw Error('媒体来源记录无效。');
 let metadata;try{metadata=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(encoded.replace(/-/g,'+').replace(/_/g,'/')),char=>char.charCodeAt(0))));}catch{throw Error('媒体来源记录无法读取。');}
 const identity=source(fallback.url)!;
 const shape=(metadata.type==='audio/mp4'&&metadata.kind==='audio'&&metadata.format==='m4a')||(metadata.type==='video/mp4'&&metadata.kind==='video'&&metadata.format==='mp4');
 const lang=metadata.audio_language,validLang=typeof lang==='string'&&/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(lang);
 const audioEvidence=identity.provider==='youtube'?
  (metadata.kind==='audio'?metadata.audio_language_basis==='platform_original'&&metadata.audio_role==='original'&&validLang:
   metadata.audio_language_basis==='platform_video_stream'&&['original','default','unknown'].includes(metadata.audio_role)&&(lang===null||validLang)&&(metadata.audio_role!=='unknown'||lang===null)&&metadata.format_id==='18'):
  metadata.audio_language_basis==='provider_single_source'&&lang===null&&metadata.audio_role==='unknown';
 if(!shape||!audioEvidence||metadata.url!==fallback.url||metadata.provider!==identity.provider||metadata.id!==identity.id||metadata.subtitle_check!=='no_matching_captions'||typeof metadata.title!=='string'||metadata.title.length>500||!Number.isFinite(metadata.duration)||metadata.duration<=0||metadata.duration>21600||typeof metadata.format_id!=='string'||!/^[A-Za-z0-9_.-]{1,80}$/.test(metadata.format_id)||!/^[a-f0-9]{64}$/.test(metadata.sha256||'')||response.headers.get('Content-Type')!==metadata.type)throw Error('媒体来源与请求不一致。');
 const reader=response.body?.getReader();if(!reader)throw Error('浏览器无法读取媒体。');
 const chunks:Uint8Array<ArrayBuffer>[]=[];let size=0;
 try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>200*1024*1024)throw Error('媒体超过 200 MiB。');chunks.push(new Uint8Array(item.value));}}catch(error){await reader.cancel().catch(()=>{});throw error;}
 const file=downloadedMediaFile(chunks,{name:metadata.title,contentType:response.headers.get('Content-Type')||'',kind:metadata.kind});
 const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer()),sha256=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
 if(sha256!==metadata.sha256)throw Error('媒体内容与来源记录不一致。');
 const inspected=await inspectFile(file);
 return {file,inspected,project:{project_kind:'audio_only',title:metadata.title,source_url:fallback.url,media_duration:metadata.duration,local_media_source:inspected.source,segments:[],media_provenance:{method:'public_video_media',source_platform:identity.provider,media_id:identity.id,subtitle_check:'no_matching_captions',audio_language:metadata.audio_language,audio_language_basis:metadata.audio_language_basis,audio_role:metadata.audio_role,media_kind:metadata.kind,container:metadata.format,format_id:metadata.format_id,sha256}}};
}

/** Decode before creating a project; never call play or infer original voice. */
export async function validateDownloadedVideoMedia(file:File,kind:'audio'|'video',duration:number,signal:AbortSignal){
 if(signal.aborted)throw Error('媒体读取已取消。');
 const player=document.createElement(kind),url=URL.createObjectURL(file);
 player.preload='metadata';player.autoplay=false;player.muted=true;
 try{
  await new Promise<void>((resolve,reject)=>{
   const done=(error?:Error)=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);player.removeEventListener('loadedmetadata',ready);player.removeEventListener('error',failed);error?reject(error):resolve();};
   const cancel=()=>done(Error('媒体读取已取消。')),failed=()=>done(Error('公开媒体无法解码，未创建项目。'));
   const ready=()=>{const value=player.duration;if(!Number.isFinite(value)||value<=0||Math.abs(value-duration)>Math.max(5,duration*0.05)||(kind==='video'&&(!(player as HTMLVideoElement).videoWidth||!(player as HTMLVideoElement).videoHeight)))failed();else done();};
   const timer=setTimeout(()=>done(Error('公开媒体解码超时，未创建项目。')),10000);
   player.addEventListener('loadedmetadata',ready);player.addEventListener('error',failed);signal.addEventListener('abort',cancel,{once:true});
   player.src=url;player.load();
  });
 }finally{player.removeAttribute('src');player.load();URL.revokeObjectURL(url);}
}
