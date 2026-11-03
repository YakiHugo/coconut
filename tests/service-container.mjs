/** Real container lifecycle smoke; no public sources or model downloads. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const id='coconut-smoke-'+randomUUID(),volume=id+'-data',image=process.env.COCONUT_TEST_IMAGE||'coconut-service:review';
const token='authored-container-test-token-with-32-characters',origin='https://reader.example.test';
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
let port,cookie;
function request(route,{method='GET',body,authenticate=true}={}){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:route,method,headers:{Host:new URL(origin).host,...(authenticate&&cookie?{Cookie:cookie}:{}),...(body!==undefined?{Origin:origin,'Content-Type':route==='/auth/login'?'application/x-www-form-urlencoded':'application/json'}:{})}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)}));});req.on('error',reject);req.end(body);});}
async function start(){docker('run','--detach','--name',id,'--publish','127.0.0.1::8080','--mount',`type=volume,source=${volume},target=/data`,'--env',`COCONUT_PUBLIC_ORIGIN=${origin}`,'--env',`COCONUT_OWNER_TOKEN=${token}`,image);port=Number(docker('port',id,'8080/tcp').split(':').at(-1));let ready=false;for(let i=0;i<100;i++){try{if((await request('/healthz')).status===200){ready=true;break;}}catch{}await delay(200);}assert.equal(ready,true,'container must become ready');}
try{
 await start();assert.equal((await request('/api/health',{authenticate:false})).status,401);
 assert.deepEqual((await request('/healthz',{authenticate:false})).json(),{status:'ok'});
 const login=await request('/auth/login',{method:'POST',body:new URLSearchParams({token}).toString()});assert.equal(login.status,303);cookie=login.headers['set-cookie'][0].split(';')[0];
 const capabilities=(await request('/api/v1/ingestions/capabilities')).json();assert.equal(capabilities.transcription.available,false);assert.equal(capabilities.transcription.model_download,false);
 const epoch=(await request('/api/v1/library')).json().epoch,document={key:'container-persistence',title:'Authored container evidence',segments:[]};
 assert.equal((await request('/api/v1/library/commit',{method:'POST',body:JSON.stringify({protocolVersion:1,epoch,receiptKey:randomUUID(),action:'put',key:document.key,expected:null,document})})).status,200);
 docker('stop','--time','20',id);docker('rm',id);await start();
 assert.deepEqual((await request('/api/v1/library/document?protocolVersion=1&key='+document.key)).json().record.document,document);
 console.log('Container login, offline worker and durable restart passed.');
}finally{try{docker('rm','--force',id);}catch{}try{docker('volume','rm',volume);}catch{}}
