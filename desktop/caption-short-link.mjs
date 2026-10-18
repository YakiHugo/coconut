/** Only official, single-hop Bilibili sharing redirects; no target fetch here. */
import {fetchPublic,publicUrl} from './public-http.mjs';
import {captionSource} from './caption-service.mjs';

export function createCaptionShortLinkResolver({fetch=fetchPublic}={}){
 return async function resolve(value,{signal}={}){
  // Validate the original spelling too: no credentials, query, fragment or alternate origin.
  if(typeof value!=='string'||!/^https:\/\/b23\.tv\/[A-Za-z0-9]+$/.test(value)||value.length>4096)throw new Error('请使用官方 Bilibili 短链接或完整 BV 链接');
  const input=publicUrl(value);
  const result=await fetch(input.href,{signal,timeoutMs:10000,redirectOnly:true,maxBytes:0});
  const target=publicUrl(result.redirect);
  const canonical=captionSource(target.href);
  if(canonical.provider!=='bilibili')throw new Error('短链接目标不是 Bilibili BV 视频');
  return canonical.url;
 };
}
export const resolveCaptionShortLink=createCaptionShortLinkResolver();
