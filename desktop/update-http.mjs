/** HTTPS only; anonymous requests to the official repository and GitHub's asset CDN. */
import https from 'node:https';
const hosts = new Set(['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']);
export function updateURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password || url.hash) throw new Error('更新链接不是官方 GitHub HTTPS 来源');
  return url;
}
export async function updateResponse(value, {signal, redirects=0}={}) {
  const url=updateURL(value);
  if(redirects>5)throw new Error('更新下载重定向过多');
  const response=await new Promise((resolve,reject)=>{
    const request=https.get(url,{signal,headers:{'User-Agent':'Coconut-update','Accept':'application/vnd.github+json'}},resolve);
    request.on('error',reject);
  });
  if([301,302,303,307,308].includes(response.statusCode)){
    response.resume();
    return updateResponse(new URL(response.headers.location,url).href,{signal,redirects:redirects+1});
  }
  if(response.statusCode!==200){response.resume();throw new Error(`GitHub 更新请求失败（HTTP ${response.statusCode}），请稍后重试`);}
  return response;
}
export async function updateText(url,{signal,maxBytes=1024*1024}={}){
  const response=await updateResponse(url,{signal});let size=0;const parts=[];
  try{for await(const chunk of response){size+=chunk.length;if(size>maxBytes)throw new Error('更新元数据超过大小限制');parts.push(chunk);}}
  finally{response.destroy();}
  return Buffer.concat(parts).toString('utf8');
}
