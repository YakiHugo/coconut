/** Single-owner browser sessions. Forwarded headers never grant authority. */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';

const digest=value=>createHash('sha256').update(value).digest();
const SESSION_SECONDS=12*60*60;
const securityHeaders=new Set(['host','origin','sec-fetch-site','cookie']);
export function createOwnerAccess({origin,token,backendLabel='Coconut',now=()=>Date.now()}={}){
  const url=new URL(origin);
  if(url.origin!==origin||url.username||url.password||!['https:','http:'].includes(url.protocol)||
    url.protocol==='http:'&&!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Owner access requires an exact HTTPS origin (HTTP is local-only).');
  if(typeof token!=='string'||!/^[\x21-\x7e]{32,256}$/.test(token))throw Error('COCONUT_OWNER_TOKEN must contain 32–256 printable non-space characters.');
  const secret=digest(token),secure=url.protocol==='https:',cookieName=secure?'__Host-coconut_owner':'coconut_owner';
  const id=createHash('sha256').update('owner:'+origin).digest('hex');
  const signature=payload=>createHmac('sha256',secret).update(origin+'|'+payload).digest('base64url');
  function envelope(req){
    const seen=new Set();for(let i=0;i<(req.rawHeaders?.length||0);i+=2){const name=req.rawHeaders[i].toLowerCase();if(securityHeaders.has(name)&&seen.has(name))return false;seen.add(name);}
    return req.headers.host===url.host&&(!req.headers.origin||req.headers.origin===origin)&&
      (!req.headers['sec-fetch-site']||['same-origin','none'].includes(req.headers['sec-fetch-site']));
  }
  function authenticated(req){
    if(!envelope(req))return false;
    const values=String(req.headers.cookie||'').split(';').map(part=>part.trim()).filter(part=>part.startsWith(cookieName+'='));
    if(values.length!==1)return false;
    const value=values[0].slice(cookieName.length+1),match=/^([0-9]{10,13})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if(!match||!timingSafeEqual(Buffer.from(match[2]),Buffer.from(signature(match[1]))))return false;
    const expires=Number(match[1]),time=Math.floor(now()/1000);return expires>time&&expires<=time+SESSION_SECONDS;
  }
  const cookie=(value,maxAge)=>`${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?'; Secure':''}`;
  const sessionValue=()=>{const expires=String(Math.floor(now()/1000)+SESSION_SECONDS);return expires+'.'+signature(expires);};
  function page(res,status,message='',signedIn=false){
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const body=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Coconut · 登录</title><main style="max-width:28rem;margin:12vh auto;padding:1.5rem;font:16px/1.7 system-ui"><h1>Coconut</h1><p>${message||'连接你的声音资料库'}</p>${signedIn?'<p>已登录。</p><a href="/">打开书架</a><form method="post" action="/auth/logout"><button>退出登录</button></form>':'<form method="post" action="/auth/login"><label for="token">访问密钥</label><input id="token" name="token" type="password" autocomplete="current-password" required style="display:block;box-sizing:border-box;width:100%;padding:.7rem;margin:.5rem 0"><button style="padding:.6rem 1rem">登录</button></form>'}</main></html>`;
    res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'same-origin'});res.end(body);
  }
  let failedAt=0,failures=0;
  async function handle(req,res){
    if(!envelope(req))return false;
    const pathname=new URL(req.url,origin).pathname;
    if(pathname==='/login'&&req.method==='GET'){page(res,200,'',authenticated(req));return true;}
    if(!['/auth/login','/auth/logout'].includes(pathname))return false;
    if(req.method!=='POST'||req.headers.origin!==origin){res.writeHead(403);res.end();return true;}
    if(pathname==='/auth/logout'){res.writeHead(303,{'Set-Cookie':cookie('',0),Location:'/login'});res.end();return true;}
    if(req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded'){res.writeHead(415);res.end();return true;}
    if(now()-failedAt>60000){failedAt=now();failures=0;}
    if(failures>=20){res.setHeader('Retry-After','60');page(res,429,'尝试次数过多，请稍后重试。');return true;}
    let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1024){res.writeHead(413);res.end();return true;}chunks.push(chunk);}
    const form=new URLSearchParams(Buffer.concat(chunks).toString('utf8')),values=form.getAll('token');
    if(values.length!==1||!timingSafeEqual(digest(values[0]),secret)){failures++;page(res,401,'访问密钥不正确。');return true;}
    failures=0;
    res.writeHead(303,{'Set-Cookie':cookie(sessionValue(),SESSION_SECONDS),Location:'/'});res.end();return true;
  }
  return Object.freeze({origin,host:url.host,backendLabel,envelope,authenticated,handle,
    discoveryHeaders:()=>({Host:url.host,Cookie:cookieName+'='+sessionValue()}),
    authorize:req=>authenticated(req)?{mode:secure?'private-owner':'local',origin,id,backendLabel,sourceAcquisition:true}:null,
    challenge(req,res){if(!envelope(req))return false;if(req.method==='GET'&&['/','/index.html'].includes(new URL(req.url,origin).pathname)){res.writeHead(303,{Location:'/login'});res.end();return true;}return false;}});
}
