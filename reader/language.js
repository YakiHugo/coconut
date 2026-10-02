"use strict";
const languageNames={en:"English",zh:"中文",ja:"日本語",ko:"한국어",fr:"Français",de:"Deutsch",es:"Español"};
let aiStatuses={}, languageReady=false, aiReady=false, translating=false, stopTranslation=false, asking=false, languageDocument=null;
for(const [code,name] of Object.entries(languageNames))for(const id of ["translation-source","translation-target","translation-view"]){const option=document.createElement('option');option.value=code;option.textContent=id==='translation-view'?name+' + 原文':name;document.getElementById(id).append(option);}
document.getElementById('translation-target').value='zh';
async function languageApi(path,data){
 const response=await fetch('api/'+path,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(path==='translate'?600000:200000)});
 const value=await response.json();if(!response.ok)throw new Error(value.error||'请求失败');return value;
}
function renderLanguage(){
 if(!$("language-panel"))return;
 const doc=active();if(!doc)return;
 if(languageDocument!==doc.key){languageDocument=doc.key;$('translation-source').value=doc.language||doc.provenance?.language?.split('-')[0]||'';$('ai-consent').checked=false;}
 $('translation-view').value=doc.translation_view||'';
 $('translate-document').disabled=!languageReady||translating;
 $('ask-ai').disabled=!aiReady||asking;
 const host=$('ai-answers');host.replaceChildren();
 for(const answer of (doc.ai_answers||[]).slice().reverse()){
  const section=el('section','ai-answer');
  if(Object.entries(answer.source_snapshot||{}).some(([id,text])=>doc.segments.find(s=>s.id===id)?.text!==text))section.append(el('p','hint','引用原文已修正，此回答依据可能过期，请重新提问'));
  section.append(el('strong','',answer.question),el('p','',answer.answer));
  for(const id of answer.citations){const segment=doc.segments.find(s=>s.id===id);if(!segment)continue;const button=el('button','',Coconut.time(segment.start)+' · 原文');button.onclick=()=>goToSegment(id);section.append(button);}
  if(!answer.citations.length)section.append(el('p','hint','回答未提供片段引用，请回听核对'));
  host.append(section);
 }
}
async function checkLanguageTools(){
 const checkButton=$('check-ai');if(!checkButton)return;checkButton.disabled=true;
 try{const status=await languageApi('language-tools');if(!checkButton.isConnected)return;languageReady=true;aiStatuses=status.ai||{};aiReady=aiStatuses[$('ai-provider').value]?.ready===true;$('ai-status').textContent=aiStatuses[$('ai-provider').value]?.reason||'认证状态未知';$('language-status').textContent='本地翻译可用；未安装的语言模型需要你允许下载。机器翻译可能有误，原文和时间戳始终保留。';}
 catch{if(!checkButton.isConnected)return;languageReady=false;aiReady=false;$('ai-status').textContent='未连接本地处理服务。公开页面不会替你调用订阅账户，请在本机启动 Coconut。';}
 finally{checkButton.disabled=false;renderLanguage();}
}
$('check-ai').onclick=checkLanguageTools;
$('ai-provider').onchange=()=>{aiReady=aiStatuses[$('ai-provider').value]?.ready===true;$('ai-status').textContent=aiStatuses[$('ai-provider').value]?.reason||'请检查本机订阅连接';$('ai-consent').checked=false;renderLanguage();};
window.addEventListener('coconut-worker-ready',checkLanguageTools);
window.addEventListener('coconut-render',renderLanguage);
$('translation-view').onchange=()=>{if(active()){active().translation_view=$('translation-view').value;save();render();}};
$('stop-translation').onclick=()=>{stopTranslation=true;$('language-status').textContent='正在完成当前批次；已完成译文会保留，下次可以继续。';};
$('translate-document').onclick=async()=>{
 const doc=active(),source=$('translation-source').value,target=$('translation-target').value;
 if(!doc||!source||source===target){notice('请选择不同的原文和翻译语言');return;}
 const key=doc.key;const pending=doc.segments.filter(s=>!(s.translations?.[target]?.source_text===s.text&&s.translations[target].source_language===source));
 if(!pending.length){doc.translation_view=target;save();render();return;}
 translating=true;stopTranslation=false;$('stop-translation').hidden=false;renderLanguage();let completed=0;
 try{
  for(let index=0;index<pending.length&&!stopTranslation;index+=32){
   const batch=pending.slice(index,index+32).map(s=>({id:s.id,text:s.text}));
   $('language-status').textContent=`本机翻译中：${completed}/${pending.length} 段；可以停止后续批次，已完成内容会保存。`;
   const result=await languageApi('translate',{source,target,segments:batch,allow_download:$('download-model').checked});
   if(!Array.isArray(result.translations)||result.translations.length!==batch.length||new Set(result.translations.map(t=>t.id)).size!==batch.length)throw new Error('翻译批次不完整，未覆盖原文');
   const destination=state.documents.find(d=>d.key===key);if(!destination)throw new Error('原文字稿已关闭');
   for(const item of result.translations){const original=batch.find(s=>s.id===item.id);const segment=destination.segments.find(s=>s.id===item.id);if(!original||!segment||item.source_text!==original.text||typeof item.text!=='string'||!item.text.trim())throw new Error('翻译片段对应关系无效');}
   for(const item of result.translations){const segment=destination.segments.find(s=>s.id===item.id);if(segment.text!==item.source_text)continue;segment.translations||={};segment.translations[target]={text:item.text,source_text:item.source_text,source_language:source,provider:item.provider};completed++;}
   destination.translation_view=target;save();if(active()?.key===key)render();
  }
  $('language-status').textContent=`${stopTranslation?'已停止后续批次':'本次翻译完成'}：保存 ${completed} 段译文。原稿、时间戳与已有笔记均保留。`;
 }catch(error){$('language-status').textContent='翻译暂停：'+error.message+'。已完成译文保留，可重试继续。';}
 finally{translating=false;$('stop-translation').hidden=true;renderLanguage();}
};
$('ask-ai').onclick=async()=>{
 const doc=active();if(!doc||asking)return;
 if(!$('ai-consent').checked){notice('请先确认本次把所选文字发送给所选提供商并使用订阅额度');return;}
 const question=$('ai-question').value.trim();if(!question){notice('请先输入问题');return;}
 const query=$('search').value.trim().toLocaleLowerCase();
 const segments=doc.segments.filter(s=>!$('ai-filtered').checked||Coconut.matchesSegment(s,doc,query,notesOnly)).map(s=>({id:s.id,text:s.text}));
 const key=doc.key;asking=true;renderLanguage();$('ai-progress').textContent=`正在让所选 AI 阅读 ${segments.length} 段；不会切换到付费 API。`;
 try{
  const answer=await languageApi('ask',{question,language:$('translation-target').value,provider:$('ai-provider').value,segments});
  const destination=state.documents.find(d=>d.key===key);if(!destination)throw new Error('原文字稿已关闭');
  if(segments.some(s=>destination.segments.find(current=>current.id===s.id)?.text!==s.text))throw new Error('请求期间原文已修改，请按新原文重新提问');
  if(typeof answer.answer!=='string'||!Array.isArray(answer.citations)||answer.citations.some(id=>!segments.some(s=>s.id===id)))throw new Error('回答引用无效');
  destination.ai_answers||=[];destination.ai_answers.push({...answer,question,source_snapshot:Object.fromEntries(segments.filter(s=>answer.citations.includes(s.id)).map(s=>[s.id,s.text]))});destination.ai_answers=destination.ai_answers.slice(-20);save();
  $('ai-progress').textContent='回答已保存在这份文字稿中，可点击引用返回原文；AI 判断仍需核对。';
 }catch(error){$('ai-progress').textContent='AI 阅读未完成：'+error.message;}
 finally{asking=false;$('ai-consent').checked=false;renderLanguage();}
};
renderLanguage();
