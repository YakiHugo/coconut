/** Test-only receipts. Never serialize source URLs, response headers/bodies or raw errors. */
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createPublicFetcher } from '../../desktop/public-http.mjs';

const transportCodes=new Set(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EPIPE','ABORT_ERR','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID']);
const reasons=new Map([
 ['来源请求已取消或超时','request_aborted_or_timeout'],
 ['无法解析或连接公开来源','dns_or_connection_failed'],
 ['无法连接公开来源','connection_failed'],
 ['公开来源传输中断','transfer_interrupted'],
 ['来源域名解析到非公开地址，已停止请求','non_public_address'],
 ['来源忽略未压缩请求；已停止以避免解压资源失控','unsupported_encoding'],
 ['来源返回了不支持的内容类型','unsupported_content_type'],
 ['来源文件超过允许大小或长度无效','invalid_content_length'],
 ['来源文件超过允许大小','body_limit_exceeded'],
 ['来源文件传输不完整','incomplete_transfer'],
 ['来源重定向过多或缺少目标','invalid_redirect'],
 ['不允许 HTTPS 降级重定向','insecure_redirect'],
 ['来源不是有效的 UTF-8 文本','invalid_utf8'],
 ['所选单集不在当前公开源列表中，请刷新来源后重选','episode_not_in_refreshed_feed'],
 ['请明确选择要导入的文字稿语言','transcript_language_required'],
 ['所选文字稿不在此单集当前公开源中','transcript_not_in_refreshed_feed'],
 ...['发布者 JSON 文字稿无效','仅支持有界的 Podcasting 2.0 segments 时间戳 JSON','发布者返回的内容不是 WebVTT','WebVTT 头部与字幕缺少空行','WebVTT 头部与字幕缺少空行，或元数据含无效时间','文字稿存在无法识别或缺少分隔的字幕块，未导入部分结果','文字稿时间格式无效','文字稿包含空白字幕，未导入部分结果','文字稿为空或片段过多','发布者文字稿的时间戳或正文无效（最多6小时）','字幕含不支持的字符实体'].map(message=>[message,'invalid_publisher_transcript']),
]);
function reason(error) {
 if(error?.code==='ERR_ASSERTION')return 'assertion_failed';
 if(/^公开来源返回 HTTP \d{3}；未使用登录、Cookie 或识别回退$/.test(error?.message||''))return 'http_status_rejected';
 return reasons.get(error?.message)||'unclassified_failure';
}
const milliseconds=(start)=>Math.max(0,Math.round(performance.now()-start));
const requestDefault=(url,options,callback)=>(url.protocol==='https:'?https:http).request(url,options,callback);
export function createPodcastSmokeDiagnostics({lookup=dnsLookup,request=requestDefault}={}) {
 let fetchCount=0,lastRequest=null;
 async function fetchResource(url,options={}) {
  const started=performance.now(),receipt={fetch_index:++fetchCount,requests_attempted:0,responses_received:0,http_status:null,transport_code:null,timeout_ms:options.timeoutMs??20000,timeout:'none',outcome:'pending',elapsed_ms:0};
  // A fresh observer belongs to this exact fetch, including its existing bounded
  // redirects. It delegates all validation, budgets and cancellation unchanged.
  const capture=error=>{if(transportCodes.has(error?.code))receipt.transport_code=error.code;};
  const fetch=createPublicFetcher({
   lookup:async(...args)=>{try{return await lookup(...args);}catch(error){capture(error);throw error;}},
   request:(target,settings,callback)=>{
    receipt.requests_attempted++;
    const req=request(target,settings,response=>{
     receipt.responses_received++;
     receipt.http_status=Number.isInteger(response.statusCode)&&response.statusCode>=100&&response.statusCode<=599?response.statusCode:null;
     callback(response);
    });
    req.on('error',capture);return req;
   },
  });
  try{const result=await fetch(url,options);receipt.outcome='success';return result;}
  catch(error){
   receipt.outcome='failure';
   if(error?.message==='来源请求已取消或超时')receipt.timeout=options.signal?.aborted?(options.signal.reason?.name==='TimeoutError'?'caller_deadline':'caller_cancelled'):'resource_deadline';
   throw error;
  } finally {receipt.elapsed_ms=milliseconds(started);lastRequest={...receipt};}
 }
 return {fetchResource,failure:error=>({reason:reason(error),fetches_attempted:fetchCount,last_request:lastRequest?{...lastRequest}:null})};
}
