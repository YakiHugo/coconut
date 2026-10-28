import React,{useEffect,useState} from 'react';

type SessionStatus={supported:boolean;connected:boolean;profile:string|null;profiles:{id:string;label:string}[]};
export function BilibiliSession({disabled=false}:{disabled?:boolean}){
 const [status,setStatus]=useState<SessionStatus|null>(null),[profile,setProfile]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 useEffect(()=>{
  const controller=new AbortController();
  void fetch('/api/captions/session',{signal:controller.signal}).then(async response=>{
   if(!response.ok)return;const value=await response.json();
   if(value.supported===true&&Array.isArray(value.profiles)){
    setStatus(value);setProfile(value.profile||value.profiles[0]?.id||'');
   }
  }).catch(()=>{});
  return()=>controller.abort();
 },[]);
 if(!status?.supported)return null;
 async function change(action:'connect'|'disconnect'){
  setBusy(true);setMessage('');
  try{
   const response=await fetch('/api/captions/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action==='connect'?{action,browser:'edge',profile}:{action})});
   const value=await response.json();if(!response.ok)throw new Error(value.error||'浏览器连接未完成。');
   setStatus(value);setMessage(action==='connect'?'已连接。现在可以重试读取 B 站链接。':'已断开 Edge，后续读取将使用匿名入口。');
  }catch(error){setMessage(error instanceof Error?error.message:'浏览器连接未完成。');}finally{setBusy(false);}
 }
 return <details className="bilibili-session"><summary>B 站账号 · {status.connected?'已连接 Edge':'连接 Edge 登录态'}</summary>
  <p>复用 Edge 中已有的 B 站登录。连接后自动刷新登录态；账号信息仅用于本机 B 站字幕请求。macOS 可能提示钥匙串授权。</p>
  {!status.connected&&<><label>Edge 配置<select aria-label="Edge 配置" value={profile} disabled={busy||disabled} onChange={event=>setProfile(event.target.value)}>{status.profiles.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
   {!status.profiles.length&&<p>未找到 Edge 配置。请先打开 Edge 并登录 B 站，再刷新此页。</p>}
   <button disabled={busy||disabled||!profile} onClick={()=>void change('connect')}>{busy?'正在连接 Edge…':'连接 Edge 中的 B 站账号'}</button></>}
  {status.connected&&<><p>正在使用：{status.profiles.find(item=>item.id===status.profile)?.label||status.profile}</p><button disabled={busy||disabled} onClick={()=>void change('disconnect')}>断开 Edge</button></>}
  <p role="status">{message}</p>
 </details>;
}
