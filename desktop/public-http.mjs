/** Bounded, anonymous public HTTP. Never use an ambient proxy, cookie jar or credentials. */
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';

const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(network,prefix,'ipv4');
// IPv6 is limited to global unicast, excluding transition/special-purpose/documentation ranges.
for (const [network,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked.addSubnet(network,prefix,'ipv6');
export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address,'ipv4') : family === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !blocked.check(address,'ipv6');
}
export function publicUrl(value, base) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) throw new Error('需要公开的 HTTP(S) 链接');
  let url;
  try { url = new URL(value,base); } catch { throw new Error('链接格式无效'); }
  const hostname = url.hostname.replace(/^\[|\]$/g,'');
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.port || url.hostname.endsWith('.') ||
      /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/i.test(url.hostname) || (!url.hostname.includes('.')&&!isIP(hostname))) throw new Error('仅支持无账号凭据的公开 HTTP(S) 标准端口链接');
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new Error('不允许本机、内网或保留地址');
  for (const key of url.searchParams.keys()) {
    const normalized=key.toLowerCase().replace(/[-_]/g,'');
    if (/^(?:.*token.*|auth.*|password|passwd|apikey|key|secret|signature|sig|jwt|session.*|hdnts|hdnea|policy|keypairid|xamz.+|xgoog.+)$/.test(normalized)) throw new Error('不支持含访问令牌或签名凭据的私有链接，请使用公开发布源');
  }
  url.hash = '';
  return url;
}
export function mime(value) { return String(value || '').split(';')[0].trim().toLowerCase(); }
export function isMediaType(type) {
  return /^(?:audio\/(?:mpeg|mp3|mp4|x-m4a|aac|wav|wave|x-wav|ogg|flac|x-flac|webm)|video\/(?:mp4|webm|ogg|quicktime))$/.test(mime(type));
}
function aborted(signal) { if (signal?.aborted) throw signal.reason || new Error('请求已取消'); }
async function withAbort(promise, signal) {
  aborted(signal);
  let cancel;
  try {
    return await Promise.race([promise,new Promise((_,reject)=>{
      cancel = ()=>reject(signal.reason || new Error('请求已取消')); signal.addEventListener('abort',cancel,{once:true});
    })]);
  } finally { signal.removeEventListener('abort',cancel); }
}
export function createPublicFetcher({lookup = dnsLookup, request = (url,options,callback)=>(url.protocol === 'https:' ? https : http).request(url,options,callback)} = {}) {
  return async function fetchPublic(value,{maxBytes=8*1024*1024,timeoutMs=20000,signal,types,inspectMedia=false,maxMediaBytes=200*1024*1024}={}) {
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal,deadline]) : deadline;
    let url = publicUrl(value);
    try {
      for (let redirects=0;redirects<=4;redirects++) {
        aborted(combined);
        const hostname = url.hostname.replace(/^\[|\]$/g,'');
        const records = isIP(hostname) ? [{address:hostname,family:isIP(hostname)}] : await withAbort(lookup(hostname,{all:true,verbatim:true}),combined);
        if (!records.length || records.some(record=>!isPublicAddress(record.address))) throw new Error('来源域名解析到非公开地址，已停止请求');
        const pinned = records[0];
        const response = await new Promise((resolve,reject)=>{
          let settled = false;
          const done = (error,result)=>{ if (settled) return; settled=true; error ? reject(error) : resolve(result); };
          const req = request(url,{method:'GET',agent:false,signal:combined,maxHeaderSize:16384,
            headers:{'User-Agent':'Coconut/0.1 public-podcast-reader','Accept':'*/*','Accept-Encoding':'identity'},
            // The exact checked address is supplied to the socket; no second DNS lookup/rebinding window.
            lookup:(_host,options,callback)=>options.all ? callback(null,[pinned]) : callback(null,pinned.address,pinned.family)},res=>{
            const fail = message=>{done(new Error(message));res.destroy();};
            if ([301,302,303,307,308].includes(res.statusCode)) {
              const location = res.headers.location; done(null,{redirect:location}); res.destroy(); return;
            }
            if (res.statusCode !== 200) return fail(`公开来源返回 HTTP ${res.statusCode}；未使用登录、Cookie 或识别回退`);
            if (res.headers['content-encoding'] && res.headers['content-encoding'].toLowerCase() !== 'identity') return fail('来源忽略未压缩请求；已停止以避免解压资源失控');
            const type = mime(res.headers['content-type']);
            const mediaOnly = inspectMedia && isMediaType(type);
            if (!mediaOnly && types && !types.has(type)) return fail('来源返回了不支持的内容类型');
            const limit = mediaOnly ? maxMediaBytes : maxBytes;
            const length = res.headers['content-length'];
            if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length)>limit)) return fail('来源文件超过允许大小或长度无效');
            const metadata = {url:url.href,type,length:length===undefined ? null : Number(length)};
            if (mediaOnly) {done(null,{...metadata,body:Buffer.alloc(0)});res.destroy();return;}
            const chunks=[];let bytes=0;
            res.on('data',chunk=>{bytes+=chunk.length;if(bytes>limit)return fail('来源文件超过允许大小');chunks.push(chunk);});
            res.on('end',()=>{
              if (length!==undefined && bytes!==Number(length)) return fail('来源文件传输不完整');
              done(null,{...metadata,body:Buffer.concat(chunks,bytes)});
            });
            res.on('error',()=>done(new Error('公开来源传输中断')));
            res.on('aborted',()=>done(new Error('公开来源传输中断')));
          });
          req.on('error',()=>done(new Error(combined.aborted ? '来源请求已取消或超时' : '无法连接公开来源')));
          req.end();
        });
        if (!Object.hasOwn(response,'redirect')) return response;
        if (!response.redirect || redirects===4) throw new Error('来源重定向过多或缺少目标');
        const next = publicUrl(response.redirect,url);
        if (url.protocol==='https:' && next.protocol!=='https:') throw new Error('不允许 HTTPS 降级重定向');
        url=next;
      }
    } catch(error) {
      if (combined.aborted) throw new Error('来源请求已取消或超时');
      // Do not expose DNS/transport diagnostics that may contain private paths or URLs.
      if (error.code) throw new Error('无法解析或连接公开来源');
      throw error;
    }
  };
}
export const fetchPublic = createPublicFetcher();
