/** Only explicit CLI error envelopes are diagnostic sources, never stderr or model output. */
import {remoteDiagnostic} from './client-access.mjs';
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
// Error envelopes can echo arbitrary source text or secrets. An exact vocabulary
// is intentionally narrower than redaction: unknown provider prose is not safe.
const SAFE_CODES=new Set(['service_unavailable','connection_error','request_failed','request_refused','unavailable',
 'rate_limit_exceeded','insufficient_quota','model_not_found','unsupported_model','context_length_exceeded',
 'authentication_error','invalid_api_key','invalid_request_error','permission_error','not_found_error',
 'request_too_large','api_error','overloaded_error','server_error','request_timeout']);
const SAFE_MESSAGES=new Set(['Request failed','Service is temporarily unavailable','Failed to connect',
 'Request refused','Service unavailable','Provider unavailable','Internal server error','Unauthorized',
 'Too many requests','Rate limit exceeded','Insufficient quota','Authentication failed']);
function clean(value,input) {
 if(typeof value!=='string'||!SAFE_MESSAGES.has(value))return '';
 // Even known prose is omitted if it is an exact user-supplied string.
 return input.includes(JSON.stringify(value))?'':value;
}
function privateValues(input) {
 const values=[];
 const visit=(value,key='')=>{if(typeof value==='string'&&value.length&&!['id','answer_language','language'].includes(key))values.push(value,JSON.stringify(value).slice(1,-1),...value.split(/\r?\n/).filter(Boolean));else if(Array.isArray(value))value.forEach(item=>visit(item));else if(object(value))Object.entries(value).forEach(([name,item])=>visit(item,name));};
 try{visit(JSON.parse(input));}catch{/* Input is never included in diagnostics. */}
 return values.sort((a,b)=>b.length-a.length);
}
function localClean(value,input) {
 if(typeof value!=='string')return '';
 // Remove prompt echoes before truncation; discard messages containing credential assignments.
 if(/(?:authorization|bearer|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:= ]\s*\S+/i.test(value))return '[private diagnostic omitted]';
 let text=value;
 for(const part of privateValues(input))text=text.split(part).join('[input omitted]');
 text=text.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').replace(/[\x00-\x1f\x7f]/g,' ')
  .replace(/https?:\/\/[^\s]+/gi,'[URL omitted]')
  .replace(/(?:\/[\w.~%-]+){2,}/g,'[path omitted]')
  .replace(/\b(?:sk-|sess-)[A-Za-z0-9_-]+\b/g,'[credential omitted]')
  .replace(/\b[A-Za-z0-9_-]{40,}\b/g,'[identifier omitted]')
  .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g,'[email omitted]')
  ;
 return remoteDiagnostic(text).slice(0,180);
}
export function providerFailure(provider,result,input='') {
 const stdout=typeof result.stdout==='string'?result.stdout:'';
 const events=[];let malformed=0;
 for(const line of stdout.split('\n').filter(line=>line.trim())){
  try{const value=JSON.parse(line);if(object(value))events.push(value);else malformed++;}catch{malformed++;}
 }
 const failures=provider==='codex'?events.filter(event=>event.type==='error'||event.type==='turn.failed'):
  events.filter(event=>event.type==='result'&&(event.is_error===true||String(event.subtype||'').startsWith('error')));
 if(!result.code&&!failures.length)return null;
 const event=failures.at(-1);
 const detail=object(event?.error)?event.error:event;
 const earlier=failures.find(item=>typeof item.message==='string'||typeof item.error?.message==='string');
 const rawMessage=detail?.message|| (typeof event?.error==='string'?event.error:'') || earlier?.error?.message || earlier?.message;
 const message=clean(rawMessage,input);
 const details=failures.toReversed().flatMap(item=>object(item.error)?[item.error,item]:[item]);
 const rawCode=details.find(item=>item.code!=null)?.code;
 const upstreamCode=typeof rawCode==='string'&&SAFE_CODES.has(rawCode)&&!input.includes(JSON.stringify(rawCode))?rawCode:null;
 const rawStatus=details.map(item=>item.status_code??item.http_status??item.status).find(value=>value!=null);
 const upstreamStatus=Number.isInteger(rawStatus)&&rawStatus>=100&&rawStatus<=599?rawStatus:null;
 const diagnostics={provider,exitCode:Number.isInteger(result.code)?result.code:null,upstreamCode,upstreamStatus,
  message:message||null,unrecognizedDetailsOmitted:!!failures.length&&(!message|| (rawCode!=null&&!upstreamCode)),eventTypes:events.map(event=>event.type).filter(type=>['turn.started','turn.completed','turn.failed','error','result'].includes(type)).slice(-12),
  malformedLines:Math.min(malformed,10000),stderrBytes:Buffer.byteLength(typeof result.stderr==='string'?result.stderr:''),stderrOmitted:true};
 const summary='本地代理未完成（CLI'+(diagnostics.exitCode===null?'': ' exit '+diagnostics.exitCode)+'；上游 HTTP '+(upstreamStatus??'未知')+'）'+(upstreamCode?' ['+upstreamCode+']':'')+(message?'：'+message:'。没有可安全显示的结构化错误；原始输出未保存。');
 const error=Object.assign(new Error(summary.slice(0,300)),{code:'provider_failed',providerDiagnostics:diagnostics});
 // Transient local-owner response only. Never merge this into task records or remote responses.
 const localCode=typeof rawCode==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(rawCode)&&localClean(rawCode,input)===rawCode?rawCode:null;
 Object.defineProperty(error,'localProviderDetails',{value:{message:localClean(rawMessage,input)||null,upstreamCode:localCode}});
 return error;
}
