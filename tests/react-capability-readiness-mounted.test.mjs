import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startDevelopmentBridge} from '../desktop/dev.mjs';
import {createProviders} from '../desktop/providers.mjs';
const script=await readFile('reader/react-app.js','utf8'),page=await readFile('reader/index.html','utf8');
const sources=await Promise.all([...page.matchAll(/<script src="([^"]+)"/g)].map(match=>match[1].split('?')[0]).filter(name=>name!=='react-app.js').map(name=>readFile('reader/'+name,'utf8')));
const wait=async check=>{for(let i=0;i<150;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.ok(check(),'UI did not settle');};
async function setup(options={}){
 const dir=await mkdtemp(join(tmpdir(),'coconut-readiness-'));
 const {server,origin}=await startDevelopmentBridge({port:0,taskDirectory:join(dir,'tasks'),libraryDirectory:join(dir,'library'),captionPython:'',providers:createProviders({find:async()=>null}),...options});
 const w=new Window({url:origin+'/'}),calls=[];w.document.body.innerHTML='<div id="react-root"></div>';Object.defineProperty(w,'crypto',{value:webcrypto});w.structuredClone=structuredClone;
 Object.defineProperty(w.navigator,'locks',{value:{request:async(name,run)=>run()}});
 // Happy DOM's AbortSignal is not a native Node fetch signal. Network responses otherwise use the real bridge.
 w.fetch=async(path,init)=>{calls.push({path,method:init?.method||'GET'});assert.notEqual(init?.method,'POST','readiness checks must never run inference or upload');return fetch(new URL(path,origin+'/'),{...init,signal:undefined});};
 w.localStorage.setItem('coconut-reader-v1',JSON.stringify({documents:[{key:'source',title:'Saved source',language:'en',segments:[{id:'a',start:0,end:2,text:'Original source'}],notes:{}}],active:'source'}));
 for(const source of sources)w.eval(source);const adapter=w.CoconutLibraryStore.createLegacyAdapter({getStorage:()=>w.localStorage,validate:w.Coconut.validate});w.CoconutStorageProvider={initialize:async()=>({ok:true,adapter,loaded:adapter.load()})};w.eval(script);
 await wait(()=>w.document.querySelector('.app-brand'));
 const button=text=>[...w.document.querySelectorAll('button')].find(node=>node.textContent===text);
 const choose=async(label,value)=>{const select=[...w.document.querySelectorAll('.ai-workspace select')].find(node=>node.parentElement.textContent.startsWith(label));select.value=value;select.dispatchEvent(new w.Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,0));};
 const open=async()=>{button('继续阅读').click();await wait(()=>button('检查本地 AI 连接'));w.document.querySelector('.react-ai-panel').open=true;button('检查本地 AI 连接').click();await wait(()=>w.document.body.textContent.includes('已连接本地服务'));};
 const consent=()=>[...w.document.querySelectorAll('.ai-workspace input[type=checkbox]')].find(node=>node.parentElement.textContent.startsWith('我确认'));
 return {w,calls,button,choose,open,consent,origin,close:async()=>{await w.happyDOM.close();await server.shutdown();await rm(dir,{recursive:true,force:true});}};
}
test('actual default Node API missing CLI reason reaches mounted React and disables foreground and background submission',async()=>{
 const h=await setup();try{
  const language=await fetch(h.origin+'/api/language-tools').then(r=>r.json());assert.equal(language.ai.codex.ready,false);
  await h.open();const status=()=>h.w.document.querySelector('[data-testid=ai-readiness]').textContent;assert.equal(status(),language.ai.codex.reason);
  await h.choose('任务','summary');h.consent().click();await wait(()=>h.consent().checked);assert.equal(h.button('执行本次任务').disabled,true);
  await h.choose('执行方式','background');h.consent().click();assert.equal(h.button('执行本次任务').disabled,true);assert.equal(status(),language.ai.codex.reason);
  await h.choose('提供商','claude');assert.equal(status(),language.ai.claude.reason);assert.equal(h.consent().checked,false);
  await h.choose('任务','translation');assert.equal(h.w.document.querySelector('option[value=offline]').disabled,true);
  assert.ok(h.calls.every(call=>call.method==='GET'));assert.equal(h.w.localStorage.getItem('coconut-background-summary-v1'),null);
 }finally{await h.close();}
});
test('ready provider enables only supported mode and model without claiming quota was checked',async()=>{
 const h=await setup({taskDirectory:null,providers:{status:async name=>({ready:name==='codex',reason:'Claude CLI needs subscription login',model_selection:{supported:false}})}});try{
  await h.open();assert.match(h.w.document.querySelector('[data-testid=ai-readiness]').textContent,/未验证指定模型、可用额度或账单/);
  await h.choose('任务','summary');h.consent().click();await wait(()=>!h.button('执行本次任务').disabled);
  await h.choose('执行方式','background');assert.equal(h.button('执行本次任务').disabled,true);assert.match(h.w.document.querySelector('[data-testid=ai-readiness]').textContent,/保持此页打开/);
  await h.choose('执行方式','foreground');await h.choose('提供商','claude');assert.equal(h.button('执行本次任务').disabled,true);assert.match(h.w.document.querySelector('[data-testid=ai-readiness]').textContent,/subscription login/);
 }finally{await h.close();}
});
test('local import does not claim ASR is unconfigured when actual Node API reports a configured executor',async()=>{
 const h=await setup({ingestionExecutor:{status:async()=>({available:true,model_download:false,message:'本地识别服务已就绪。'})}});try{
  h.w.URL.createObjectURL=()=> 'blob:local-fixture';h.w.URL.revokeObjectURL=()=>{};h.w.HTMLInputElement.prototype.click=function(){};
  h.button('打开音频或视频文件').click();const input=h.w.document.querySelector('input[accept="audio/*,video/*"]');Object.defineProperty(input,'files',{value:[new h.w.File(['RIFF local fixture'],'fixture.wav',{type:'audio/wav'})]});input.dispatchEvent(new h.w.Event('change',{bubbles:true}));
  await wait(()=>h.button('检查本地识别服务'));assert.match(h.w.document.body.textContent,/可在文字稿面板查看识别服务状态/);assert.ok(!h.w.document.body.textContent.includes('尚未配置语音识别'));
  h.button('检查本地识别服务').click();await wait(()=>h.w.document.body.textContent.includes('本地识别服务已就绪。'));assert.ok(!h.w.document.body.textContent.includes('尚未配置语音识别'));
  assert.ok(h.calls.every(call=>call.method==='GET'));
 }finally{await h.close();}
});
