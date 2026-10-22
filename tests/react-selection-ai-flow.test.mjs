import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
const script=await readFile('reader/react-app.js','utf8'),page=await readFile('reader/index.html','utf8');
const sources=await Promise.all([...page.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1].split('?')[0]).filter(name=>name!=='react-app.js').map(name=>readFile('reader/'+name,'utf8')));
const wait=async check=>{for(let i=0;i<250;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.ok(check(),'UI did not settle');};
async function setup(){
 const w=new Window({url:'http://localhost/'});w.document.body.innerHTML='<div id="react-root"></div>';Object.defineProperty(w,'crypto',{value:webcrypto});w.structuredClone=structuredClone;
 const scrolled=[];w.HTMLElement.prototype.scrollIntoView=function(){scrolled.push(this);};
 const doc={key:'selection',title:'Authored source',language:'en',notes:{'cue-0':'Initial note'},segments:Array.from({length:65},(_,i)=>({id:'cue-'+i,start:i*2,end:i*2+2,text:'Original phrase '+i+'. More context.'}))};
 w.localStorage.setItem('coconut-reader-v1',JSON.stringify({documents:[doc],active:doc.key}));
 w.sessionStorage.setItem('coconut-reading-view-v1',JSON.stringify({version:1,views:[[doc.key,doc.segments[0].id,'transcript']]}));
 const calls=[];let held=false,observed,aborts=0;
 w.fetch=async(path,options={})=>{
  if(path==='api/health')return {ok:true,json:async()=>({})};
  if(path==='api/language-tools')return {ok:true,json:async()=>({ai:{codex:{ready:true,model_selection:{supported:true}}}})};
  if(path==='api/v1/executor')return {ok:true,json:async()=>({protocolVersion:1,enabled:false})};
  assert.equal(path,'api/ask');const body=JSON.parse(options.body);calls.push(body);
  if(held)return new Promise((resolve,reject)=>{observed=options.signal;observed.addEventListener('abort',()=>{aborts++;reject(new w.DOMException('Cancelled','AbortError'));},{once:true});});
  return {ok:true,json:async()=>({answer:'Authored translation',citations:body.segments.map(c=>c.id)})};
 };
 for(const code of sources)w.eval(code);const adapter=w.CoconutLibraryStore.createLegacyAdapter({getStorage:()=>w.localStorage,validate:w.Coconut.validate});w.CoconutStorageProvider={initialize:async()=>({ok:true,adapter,loaded:adapter.load()})};w.eval(script);
 const button=text=>[...w.document.querySelectorAll('button')].find(b=>b.textContent===text);
 await wait(()=>button('继续阅读'));button('继续阅读').click();await wait(()=>w.document.querySelector('.rw-cues'));
 const selectText=async(id,from=0,to=15)=>{const el=w.document.querySelector(`[data-source-id="${id}"]`),range=w.document.createRange();range.setStart(el.firstChild,from);range.setEnd(el.firstChild,to);w.getSelection().removeAllRanges();w.getSelection().addRange(range);el.dispatchEvent(new w.MouseEvent('mouseup',{bubbles:true}));await wait(()=>button('理解选中文字'));};
 const consent=()=>[...w.document.querySelectorAll('.ai-workspace input[type=checkbox]')].find(el=>el.parentElement.textContent.startsWith('我确认'));
 return {w,doc,calls,scrolled,button,selectText,consent,hold:()=>held=true,get observed(){return observed;},get aborts(){return aborts;},saved:()=>JSON.parse(w.localStorage.getItem('coconut-reader-v1')).documents[0]};
}
test('production selection actions reset stale task intent, focus the panel, preserve exact evidence and return to page two',async()=>{
 const h=await setup(),{w}=h;try{
  h.button('下一页').click();await wait(()=>w.document.querySelector('[data-source-id="cue-55"]'));
  w.document.querySelector('.react-ai-panel').open=true;const task=w.document.querySelector('.ai-workspace select');task.value='summary';task.dispatchEvent(new w.Event('change',{bubbles:true}));await wait(()=>task.value==='summary');w.document.querySelector('.react-ai-panel').open=false;
  await h.selectText('cue-55');h.button('理解选中文字').click();await wait(()=>w.document.activeElement===w.document.querySelector('.ai-workspace h2'));
  assert.equal(task.value,'question');assert.match(w.document.querySelector('.ai-workspace textarea').value,/解释所选原文/);assert.equal(h.calls.length,0);assert.equal(h.consent().checked,false);
  h.button('返回所选原文').click();await wait(()=>w.document.activeElement?.dataset.sourceId==='cue-55');assert.equal(w.document.querySelector('.react-ai-panel').open,false);assert.ok(w.document.querySelector('[data-source-id="cue-64"]'));
  h.button('翻译选中文字').click();await wait(()=>w.document.activeElement===w.document.querySelector('.ai-workspace h2'));assert.match(w.document.querySelector('.ai-workspace textarea').value,/只将所选原文翻译/);assert.equal(h.calls.length,0);assert.match(w.document.querySelector('.ai-workspace').textContent,/完整片段作为上下文/);
  h.button('检查本地 AI 连接').click();await wait(()=>w.document.querySelector('[data-testid=ai-readiness]').textContent.includes('已检测到'));
  h.consent().click();await wait(()=>!h.button('执行本次任务').disabled);h.button('执行本次任务').click();await wait(()=>h.saved().ai_answers?.length===1);
  assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].segments.map(c=>c.id),['cue-55']);assert.match(h.calls[0].question,/只将所选原文翻译/);assert.equal(h.saved().ai_answers[0].input_snapshot.scope.exact_selection.text,'Original phrase');assert.deepEqual(h.saved().segments[55].translations,{});
  h.button('返回所选原文').click();await wait(()=>w.document.activeElement?.dataset.sourceId==='cue-55');assert.match(w.document.querySelector('.rw-selection').textContent,/Original phrase/);
  h.button('理解选中文字').click();await wait(()=>w.document.activeElement===w.document.querySelector('.ai-workspace h2'));assert.match(w.document.querySelector('.ai-workspace textarea').value,/解释所选原文/);assert.equal(h.consent().checked,false);assert.equal(h.calls.length,1);
 }finally{await w.happyDOM.close();}
});
for(const cancel of ['stop','close','return'])test('production '+cancel+' cancels the current frontend fetch, without saving or resending',async()=>{
 const h=await setup(),{w}=h;try{
  await h.selectText('cue-0');h.button('翻译选中文字').click();await wait(()=>w.document.querySelector('.react-ai-panel').open);h.button('检查本地 AI 连接').click();await wait(()=>w.document.querySelector('[data-testid=ai-readiness]').textContent.includes('已检测到'));
  h.hold();h.consent().click();await wait(()=>!h.button('执行本次任务').disabled);h.button('执行本次任务').click();await wait(()=>h.observed);
  if(cancel==='stop')h.button('停止当前请求').click();else if(cancel==='close')w.document.querySelector('.react-ai-panel').open=false;else h.button('停止并返回所选原文').click();
  await wait(()=>h.aborts===1);assert.equal(h.observed.aborted,true);await wait(()=>!h.button('停止当前请求'));assert.equal(h.saved().ai_answers,undefined);assert.equal(h.calls.length,1);assert.equal(h.consent().checked,false);
  if(cancel==='return')assert.equal(w.document.activeElement?.dataset.sourceId,'cue-0');
 }finally{await w.happyDOM.close();}
});
test('leaving the reading session retires old selection intent and its return affordance',async()=>{
 const h=await setup(),{w}=h;try{
  await h.selectText('cue-0');h.button('理解选中文字').click();await wait(()=>w.document.activeElement===w.document.querySelector('.ai-workspace h2'));
  h.button('返回所选原文').click();await wait(()=>w.document.activeElement?.dataset.sourceId==='cue-0');
  [...w.document.querySelectorAll('.app-sidebar nav button')].find(b=>b.textContent.startsWith('我的内容')).click();await wait(()=>w.document.querySelector('.library-page'));
  h.button('继续阅读').click();await wait(()=>w.document.querySelector('.reader-workspace'));await new Promise(r=>setTimeout(r,20));
  assert.equal(w.document.querySelector('.react-ai-panel').open,false);assert.equal(h.button('返回所选原文'),undefined);assert.equal(h.calls.length,0);
  await h.selectText('cue-0');h.button('翻译选中文字').click();await wait(()=>w.document.activeElement===w.document.querySelector('.ai-workspace h2'));assert.match(w.document.querySelector('.ai-workspace textarea').value,/只将所选原文翻译/);
 }finally{await w.happyDOM.close();}
});
test('passage return target is explicitly focusable in real browsers and retains passage mode',async()=>{
 const h=await setup(),{w}=h;try{
  const mode=[...w.document.querySelectorAll('.reader-workspace label')].find(l=>l.textContent.startsWith('阅读方式')).querySelector('select');mode.value='passages';mode.dispatchEvent(new w.Event('change',{bubbles:true}));await wait(()=>w.document.querySelector('.rw-passage'));
  await h.selectText('cue-0');h.button('理解选中文字').click();await wait(()=>w.document.activeElement===w.document.querySelector('.ai-workspace h2'));h.button('返回所选原文').click();await wait(()=>w.document.activeElement?.className==='rw-original');
  assert.equal(w.document.activeElement.getAttribute('tabindex'),'0');assert.equal(mode.value,'passages');assert.equal(w.document.activeElement.contains(w.document.querySelector('[data-source-id="cue-0"]')),true);
 }finally{await w.happyDOM.close();}
});
test('changed note filter cannot falsely report restoration of a now hidden selection',async()=>{
 const h=await setup(),{w}=h;try{
  [...w.document.querySelectorAll('.reader-workspace label')].find(l=>l.textContent.includes('只看笔记')).querySelector('input').click();await wait(()=>w.document.querySelectorAll('[data-source-id]').length===1);
  await h.selectText('cue-0');h.button('理解选中文字').click();await wait(()=>w.document.querySelector('.react-ai-panel').open);
  const note=w.document.querySelector('[aria-label="00:00 的笔记"]');Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(note,'');note.dispatchEvent(new w.Event('input',{bubbles:true}));await wait(()=>h.button('保存笔记'));h.button('保存笔记').click();await wait(()=>!w.document.querySelector('[data-source-id="cue-0"]'));
  h.button('返回所选原文').click();await wait(()=>w.document.activeElement===w.document.querySelector('.reader-workspace'));assert.match(w.document.querySelector('.reader-workspace > p[role=status]').textContent,/未恢复旧选区/);assert.equal(w.document.querySelector('.rw-selection'),null);
 }finally{await w.happyDOM.close();}
});

function key(w,target,name,options={}){target.focus();const event=new w.KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true,...options});target.dispatchEvent(event);return event;}
for(const modeName of ['transcript','passages'])test('selection keyboard entry is local, reversible and dismissible in '+modeName,async()=>{
 const h=await setup(),{w}=h;try{
  if(modeName==='passages'){const mode=[...w.document.querySelectorAll('.reader-workspace label')].find(l=>l.textContent.startsWith('阅读方式')).querySelector('select');mode.value='passages';mode.dispatchEvent(new w.Event('change',{bubbles:true}));await wait(()=>w.document.querySelector('.rw-passage'));}
  await h.selectText('cue-0');const source=w.document.querySelector('[data-source-id="cue-0"]').closest('.rw-original');
  assert.equal(key(w,source,'Tab').defaultPrevented,true);assert.equal(w.document.activeElement,h.button('保存精确摘录'));
  assert.equal(key(w,h.button('保存精确摘录'),'Tab').defaultPrevented,false,'Normal toolbar Tab remains native');
  assert.equal(key(w,h.button('保存精确摘录'),'Tab',{shiftKey:true}).defaultPrevented,true);assert.equal(w.document.activeElement,source);
  assert.equal(key(w,source,'Tab',{shiftKey:true}).defaultPrevented,false,'Reverse Tab can leave the source');
  key(w,source,'Tab');assert.equal(key(w,h.button('理解选中文字'),'Escape').defaultPrevented,true);await wait(()=>!w.document.querySelector('.rw-selection'));assert.equal(w.document.activeElement,source);assert.equal(w.getSelection().rangeCount,0);
  source.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Escape',bubbles:true}));assert.equal(key(w,source,'Tab').defaultPrevented,false,'Escape keyup cannot recapture the dismissed range');
  await h.selectText('cue-0');h.button('理解选中文字').click();await wait(()=>w.document.activeElement===w.document.querySelector('.ai-workspace h2'));h.button('返回所选原文').click();await wait(()=>w.document.activeElement===source);source.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Enter',bubbles:true}));await new Promise(resolve=>setTimeout(resolve,20));assert.ok(w.document.querySelector('.rw-selection'),'Keyboard activation release after AI return keeps the selection');
  assert.equal(key(w,source,'Tab').defaultPrevented,true,'Restored selection keeps the local keyboard entry');assert.equal(w.document.activeElement,h.button('保存精确摘录'));
  key(w,h.button('保存精确摘录'),'Tab',{shiftKey:true});source.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Tab',shiftKey:true,bubbles:true}));source.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Shift',bubbles:true}));await new Promise(resolve=>setTimeout(resolve,20));assert.ok(w.document.querySelector('.rw-selection'),'Navigation keyup does not recapture a collapsed native range after AI return');
  const close=[...w.document.querySelectorAll('.rw-selection button')].find(b=>b.textContent==='关闭');close.click();await wait(()=>!w.document.querySelector('.rw-selection'));assert.equal(w.document.activeElement,source);assert.equal(key(w,source,'Tab').defaultPrevented,false);assert.equal(h.calls.length,0);
 }finally{await w.happyDOM.close();}
});
test('selection keyboard does not intercept notes, other sources, modifiers, IME or cleared and revised selections',async()=>{
 const h=await setup(),{w}=h;try{
  await h.selectText('cue-0');const source=w.document.querySelector('[data-source-id="cue-0"]'),other=w.document.querySelector('[data-source-id="cue-3"]'),note=w.document.querySelector('[aria-label="00:00 的笔记"]');
  for(const target of [note,other,w.document.querySelector('input[type=search]')]){assert.equal(key(w,target,'Tab').defaultPrevented,false);assert.equal(key(w,target,'Escape').defaultPrevented,false);}
  for(const options of [{isComposing:true},{keyCode:229},{ctrlKey:true},{metaKey:true},{altKey:true}]){assert.equal(key(w,source,'Tab',options).defaultPrevented,false);assert.equal(key(w,source,'Escape',options).defaultPrevented,false);}
  w.getSelection().removeAllRanges();source.dispatchEvent(new w.MouseEvent('mouseup',{bubbles:true}));await wait(()=>!w.document.querySelector('.rw-selection'));assert.equal(key(w,source,'Tab').defaultPrevented,false);
  await h.selectText('cue-0');Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(note,'Revised note');note.dispatchEvent(new w.Event('input',{bubbles:true}));await wait(()=>h.button('保存笔记'));
  assert.equal(key(w,source,'Tab').defaultPrevented,true);assert.equal(w.document.activeElement,h.button('复制原话'),'Skip unavailable actions while a note is dirty');
  h.button('保存笔记').click();await wait(()=>h.saved().notes['cue-0']==='Revised note'&&!w.document.querySelector('.rw-selection'));assert.equal(key(w,source,'Tab').defaultPrevented,false);
  await h.selectText('cue-0');[...w.document.querySelectorAll('.app-sidebar nav button')].find(b=>b.textContent.startsWith('我的内容')).click();await wait(()=>w.document.querySelector('.library-page'));h.button('继续阅读').click();await wait(()=>w.document.querySelector('.rw-cues'));assert.equal(key(w,w.document.querySelector('[data-source-id="cue-0"]'),'Tab').defaultPrevented,false,'A new reading session never inherits the old entry');
 }finally{await w.happyDOM.close();}
});
