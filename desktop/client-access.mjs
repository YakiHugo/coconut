/** Request authorization for the loopback bridge. No proxy is trusted by default. */
import {createHash} from 'node:crypto';
const loopback=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
const proxyHeader=name=>name==='forwarded'||name.startsWith('x-forwarded-')||name.startsWith('tailscale-');
export function privateProxyProfile(value){
  if(value==null)return null;
  if(!value||value.type!=='tailscale-serve')throw new Error('Unsupported private proxy profile');
  let url;try{url=new URL(value.origin);}catch{throw new Error('Private proxy requires an exact HTTPS origin');}
  if(url.protocol!=='https:'||url.origin!==value.origin||url.username||url.password||url.hostname==='localhost'||url.hostname==='127.0.0.1'||url.hostname.includes('*'))throw new Error('Private proxy requires an exact HTTPS origin');
  if(typeof value.ownerLogin!=='string'||!value.ownerLogin||value.ownerLogin.length>254||!/^[\x21-\x7e]+$/.test(value.ownerLogin)||value.ownerLogin.includes(','))throw new Error('Private proxy requires one exact ASCII owner login');
  const backendLabel=value.backendLabel??'此电脑';
  if(typeof backendLabel!=='string'||!backendLabel.trim()||backendLabel.length>80||/[\x00-\x1f\x7f/\\]/.test(backendLabel))throw new Error('Invalid backend display name');
  return Object.freeze({type:value.type,origin:url.origin,host:url.host,ownerLogin:value.ownerLogin,backendLabel,
    id:createHash('sha256').update(JSON.stringify([url.origin,value.ownerLogin])).digest('hex').slice(0,32)});
}
export function privateProxyFromEnvironment(env=process.env){
  const type=env.COCONUT_PRIVATE_PROXY;
  if(!type){if(env.COCONUT_PRIVATE_ORIGIN||env.COCONUT_PRIVATE_OWNER)throw new Error('Set COCONUT_PRIVATE_PROXY explicitly before configuring private access');return null;}
  return privateProxyProfile({type,origin:env.COCONUT_PRIVATE_ORIGIN,ownerLogin:env.COCONUT_PRIVATE_OWNER,backendLabel:env.COCONUT_BACKEND_LABEL});
}
export function authorizeClient(req,{port,profile=null}={}){
  const h=req.headers;
  if(!loopback(req.socket?.remoteAddress))return null;
  // Reject ambiguous security headers rather than relying on Node's combining/discarding rules.
  const counts=new Map();for(let i=0;i<(req.rawHeaders?.length||0);i+=2){const key=req.rawHeaders[i].toLowerCase();counts.set(key,(counts.get(key)||0)+1);}
  if([...counts].some(([key,count])=>count>1&&(proxyHeader(key)||['host','origin','sec-fetch-site'].includes(key))))return null;
  if(h['sec-fetch-site']&&!['same-origin','none'].includes(h['sec-fetch-site']))return null;
  const marked=Object.keys(h).some(proxyHeader);
  const localHost=[`127.0.0.1:${port}`,`localhost:${port}`].includes(h.host);
  if(localHost&&!marked){const origin=`http://${h.host}`;if(h.origin&&h.origin!==origin)return null;return {mode:'local',origin,id:'local'};}
  // Host alone is never authentication. Identity is supplied by the explicitly
  // trusted, local Tailscale Serve process, which strips incoming identity headers.
  // Any proxy marker forbids falling back to local privileges, even on localhost.
  if(!profile||localHost||h.host!==profile.host||h['tailscale-user-login']!==profile.ownerLogin||
    Object.hasOwn(h,'tailscale-funnel-request')||h.forwarded!==undefined||
    h['x-forwarded-host']!==profile.host||h['x-forwarded-proto']!=='https'||
    (h.origin&&h.origin!==profile.origin))return null;
  return {mode:'private-owner',origin:profile.origin,id:profile.id};
}
export function describeClient(access,{profile,libraryStore,taskStore,localMediaService}={}){
  return {id:access.id,mode:access.mode,backendLabel:profile?.backendLabel||'此电脑',online:true,libraryId:libraryStore?.describe().epoch||null,
    capabilities:{libraryRead:!!libraryStore,libraryWrite:!!libraryStore,aiActions:true,backgroundTasks:taskStore?.describe().enabled===true,
      localMedia:access.mode==='local'&&!!localMediaService,libraryMigration:false}};
}
export function localOnlyRoute(pathname){return pathname==='/api/v1/library/migration'||pathname==='/api/local-media'||pathname.startsWith('/api/local-media/');}
// Only diagnostic text is sanitized, never document content or model answers.
export function remoteDiagnostic(message){
  // A path can have an arbitrary root and contain spaces. Diagnostics are not
  // structured path records, so conservatively omit the remainder of an
  // unquoted path's clause instead of leaking ambiguous filename fragments.
  // Preserve quoted boundaries, separate clauses, codes, and non-diagnostic data.
  return String(message||'请求未完成')
    .replace(/(["'`])(?:file:\/\/\/|\/|[A-Za-z]:[\\/]|\\\\)[^\r\n]*?\1/g,'[本机路径]')
    .replace(/(^|[\s(=:\[{<>])(?:file:\/\/\/|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^\r\n;,，。；）)"'`]+/g,'$1[本机路径]')
    .slice(0,300);
}
export function remoteResponseDiagnostics(data,pathname){
  const result={...data};
  if(typeof result.error==='string')result.error=remoteDiagnostic(result.error);
  const task=value=>value?.error?.message?{...value,error:{...value.error,message:remoteDiagnostic(value.error.message)}}:value;
  if(pathname.startsWith('/api/v1/tasks')){
    if(result.task)result.task=task(result.task);
    if(Array.isArray(result.tasks))result.tasks=result.tasks.map(task);
    if(result.record?.task)result.record={...result.record,task:task(result.record.task)};
  }
  if(pathname==='/api/language-tools'&&result.ai)result.ai=Object.fromEntries(Object.entries(result.ai).map(([key,value])=>[key,{...value,...(value.reason?{reason:remoteDiagnostic(value.reason)}:{})}]));
  return result;
}
