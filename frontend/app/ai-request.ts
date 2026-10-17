/** Preserve explicit local diagnostics transiently, never in durable documents. */
export function createAiRequest(fetcher:typeof fetch,allowLocalDetails:()=>boolean){
 return async(path:string,body?:Record<string,unknown>,signal?:AbortSignal)=>{
  const response=await fetcher('api/'+path,{signal,method:body?'POST':'GET',...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  const value=await response.json();
  if(!response.ok){const error=new Error(typeof value.error?.message==='string'?value.error.message:typeof value.error==='string'?value.error:'请求失败');
   if(allowLocalDetails()&&value.localProviderDetails&&typeof value.localProviderDetails==='object')Object.assign(error,{localProviderDetails:{message:typeof value.localProviderDetails.message==='string'?value.localProviderDetails.message.slice(0,300):'',upstreamCode:typeof value.localProviderDetails.upstreamCode==='string'?value.localProviderDetails.upstreamCode.slice(0,80):''}});
   throw error;
  }
  return value;
 };
}
