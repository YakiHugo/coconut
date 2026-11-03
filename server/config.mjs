/** Deployment configuration is read once, before opening storage or sockets. */
import path from 'node:path';
import {homedir} from 'node:os';
import {sourceNetworkFromEnvironment,validateSourceNetwork} from '../desktop/source-network.mjs';

export function serviceConfig(env=process.env){
  const portText=env.COCONUT_PORT??'8080';
  if(!/^\d{1,5}$/.test(portText)||Number(portText)>65535)throw Error('COCONUT_PORT must be between 0 and 65535.');
  const host=env.COCONUT_HOST||'127.0.0.1';
  if(!['127.0.0.1','0.0.0.0'].includes(host))throw Error('COCONUT_HOST must be 127.0.0.1 or 0.0.0.0.');
  const dataDirectory=env.COCONUT_DATA_DIRECTORY||path.join(homedir(),'.coconut','service');
  if(!path.isAbsolute(dataDirectory))throw Error('COCONUT_DATA_DIRECTORY must be absolute.');
  const publicOrigin=env.COCONUT_PUBLIC_ORIGIN||null,ownerToken=env.COCONUT_OWNER_TOKEN||null;
  if(!!publicOrigin!==!!ownerToken)throw Error('Configure COCONUT_PUBLIC_ORIGIN and COCONUT_OWNER_TOKEN together.');
  if(host!=='127.0.0.1'&&(!publicOrigin||!publicOrigin.startsWith('https://')))throw Error('A non-loopback listener requires an HTTPS public origin and owner token.');
  if(env.COCONUT_PRIVATE_PROXY||env.COCONUT_PRIVATE_ORIGIN||env.COCONUT_PRIVATE_OWNER)throw Error('The standalone service uses owner sessions; do not combine private-proxy profiles.');
  let network;
  if(env.COCONUT_SOURCE_NETWORK!==undefined||env.COCONUT_SOURCE_PROXY!==undefined||env.COCONUT_CAPTION_PROXY!==undefined)network=sourceNetworkFromEnvironment(env);
  else if(env.COCONUT_PODCAST_PROXY)network=validateSourceNetwork({mode:'custom',proxy:env.COCONUT_PODCAST_PROXY});
  else {const environment=Object.fromEntries(['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy','NO_PROXY','no_proxy'].filter(key=>env[key]!==undefined).map(key=>[key,env[key]]));network=Object.keys(environment).length?validateSourceNetwork({mode:'environment',environment}):validateSourceNetwork();}
  if(env.COCONUT_PODCAST_PROXY&&(network.mode!=='custom'||network.proxy!==env.COCONUT_PODCAST_PROXY.replace(/\/$/,'')))throw Error('Conflicting source and podcast proxy settings.');
  return Object.freeze({host,port:Number(portText),dataDirectory,publicOrigin,ownerToken,backendLabel:env.COCONUT_BACKEND_LABEL||'Coconut',network,
    captionPython:env.COCONUT_CAPTION_PYTHON||null,readingPython:env.COCONUT_READING_PYTHON||null});
}
