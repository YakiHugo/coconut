import {downloadedMediaFile} from './ingestion-media';
import {inspectFile} from './ingestion';
export type VideoAudioFallback={endpoint:'/api/videos/audio';url:string;language:string|null};
function source(value:unknown){
 if(typeof value!=='string')return null;
 const youtube=/^https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})$/.exec(value);
 const bilibili=/^https:\/\/www\.bilibili\.com\/video\/(BV[A-Za-z0-9]{10})$/.exec(value);
 return youtube?{provider:'youtube',id:youtube[1]}:bilibili?{provider:'bilibili',id:bilibili[1]}:null;
}
export function videoAudioFallback(value:unknown):VideoAudioFallback|null{
 const item=value as VideoAudioFallback;
 return item?.endpoint==='/api/videos/audio'&&source(item.url)&&(item.language===null||typeof item.language==='string'&&/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(item.language))?{endpoint:item.endpoint,url:item.url,language:item.language}:null;
}
export async function downloadVideoAudio(value:VideoAudioFallback,signal:AbortSignal){
 const fallback=videoAudioFallback(value);if(!fallback)throw Error('公开原声操作身份无效。');
 const response=await fetch('api/videos/audio',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:fallback.url,language:fallback.language,consent:true}),signal});
 if(!response.ok){const error=await response.json();throw Error(typeof error.error==='string'?error.error:'公开原声检查未完成，未创建项目。');}
 const encoded=response.headers.get('X-Coconut-Media-Source')||'';
 if(!encoded||encoded.length>8192||!/^[A-Za-z0-9_-]+$/.test(encoded))throw Error('原声来源记录无效。');
 let metadata;try{metadata=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(encoded.replace(/-/g,'+').replace(/_/g,'/')),char=>char.charCodeAt(0))));}catch{throw Error('原声来源记录无法读取。');}
 const identity=source(fallback.url)!;
 if(metadata.url!==fallback.url||metadata.provider!==identity.provider||metadata.id!==identity.id||metadata.subtitle_check!=='no_matching_captions'||typeof metadata.title!=='string'||metadata.title.length>500||!Number.isFinite(metadata.duration)||metadata.duration<=0||metadata.duration>21600||!/^[a-f0-9]{64}$/.test(metadata.sha256||''))throw Error('原声来源与请求不一致。');
 const reader=response.body?.getReader();if(!reader)throw Error('浏览器无法读取原声。');
 const chunks:Uint8Array<ArrayBuffer>[]=[];let size=0;
 try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>200*1024*1024)throw Error('原声超过 200 MiB。');chunks.push(new Uint8Array(item.value));}}catch(error){await reader.cancel().catch(()=>{});throw error;}
 const file=downloadedMediaFile(chunks,{name:metadata.title,contentType:response.headers.get('Content-Type')||'',kind:'audio'});
 const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer()),sha256=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
 if(sha256!==metadata.sha256)throw Error('原声内容与来源记录不一致。');
 const inspected=await inspectFile(file);
 return {file,inspected,project:{project_kind:'audio_only',title:metadata.title,source_url:fallback.url,media_duration:metadata.duration,local_media_source:inspected.source,segments:[],media_provenance:{method:'public_video_audio',source_platform:identity.provider,media_id:identity.id,subtitle_check:'no_matching_captions',sha256}}};
}
