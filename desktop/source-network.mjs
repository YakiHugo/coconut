/** Owner startup configuration only; never accept this object from an import request.
 * Environment mode is an explicit proxy-variable snapshot, not OS/PAC discovery.
 * The helper must use that snapshot with upstream yt-dlp, not getproxies()'s OS fallback.
 */
const PROXY_KEYS=Object.freeze(['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy']);
const ENV_KEYS=Object.freeze([...PROXY_KEYS,'NO_PROXY','no_proxy']);
const SCHEMES=new Set(['http:','socks4:','socks4a:','socks5:','socks5h:']);
const invalid=()=>Object.assign(new Error('Invalid source network configuration; use an explicit supported credential-free proxy setting.'),{code:'SOURCE_NETWORK_CONFIGURATION'});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>Object.keys(value).every(key=>allowed.includes(key));

function environmentProxy(value){
 if(typeof value!=='string'||value.length>2048||/[\x00-\x20\x7f\\]/.test(value))throw invalid();
 // Empty variables are meaningful to upstream's case/precedence handling.
 if(value==='')return value;
 let url;try{url=new URL(value);}catch{throw invalid();}
 const authority=/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)\/?$/.exec(value);
 if(!authority||authority[1].includes('@')||!SCHEMES.has(url.protocol)||!url.hostname||url.username||url.password||url.search||url.hash||url.pathname&&url.pathname!=='/'||url.port==='0')throw invalid();
 return value;
}
function customProxy(value){
 const match=typeof value==='string'&&/^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?$/.exec(value);
 if(!match||match[0]!==value||Number(match[2])>65535)throw invalid();
 return `http://${match[1]}:${match[2]}`;
}

/** Return an immutable, detached, validated configuration; errors never echo values. */
export function validateSourceNetwork(value){
 if(value===undefined||value===null)return Object.freeze({mode:'direct'});
 if(!object(value))throw invalid();
 if(value.mode==='direct'){
  if(!keys(value,['mode']))throw invalid();
  return Object.freeze({mode:'direct'});
 }
 if(value.mode==='custom'){
  if(!keys(value,['mode','proxy']))throw invalid();
  return Object.freeze({mode:'custom',proxy:customProxy(value.proxy)});
 }
 if(value.mode==='environment'){
  if(!keys(value,['mode','environment'])||!object(value.environment)||!keys(value.environment,ENV_KEYS))throw invalid();
  const environment={};
  for(const key of ENV_KEYS){
   if(!Object.hasOwn(value.environment,key))continue;
   const item=value.environment[key];
   if(PROXY_KEYS.includes(key))environment[key]=environmentProxy(item);
   else{
    if(typeof item!=='string'||item.length>4096||/[\x00-\x1f\x7f]/.test(item))throw invalid();
    environment[key]=item;
   }
  }
  return Object.freeze({mode:'environment',environment:Object.freeze(environment)});
 }
 throw invalid();
}

/** Direct is the default even when the parent process has ordinary proxy variables. */
export function sourceNetworkFromEnvironment(env=process.env){
 if(!object(env))throw invalid();
 const mode=env.COCONUT_SOURCE_NETWORK,proxy=env.COCONUT_SOURCE_PROXY;
 if(mode===undefined&&proxy===undefined){
  return env.COCONUT_CAPTION_PROXY===undefined?validateSourceNetwork():validateSourceNetwork({mode:'custom',proxy:env.COCONUT_CAPTION_PROXY});
 }
 if(mode==='direct'&&proxy===undefined)return validateSourceNetwork({mode});
 if(mode==='custom')return validateSourceNetwork({mode,proxy});
 if(mode==='environment'&&proxy===undefined){
  const environment={};
  for(const key of ENV_KEYS)if(Object.hasOwn(env,key))environment[key]=env[key];
  return validateSourceNetwork({mode,environment});
 }
 throw invalid();
}

/** Only these explicitly selected variables may augment the isolated helper env. */
export function helperNetworkEnvironment(network){
 const validated=validateSourceNetwork(network);
 // urllib's macOS proxy_bypass falls back to OS settings when its env map is
 // empty. Keep the explicit custom proxy visible there too, with no bypass list.
 return validated.mode==='environment'?{...validated.environment}:validated.mode==='custom'?{all_proxy:validated.proxy}:{};
}
