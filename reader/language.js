"use strict";
const languageNames={en:"English",zh:"中文",ja:"日本語",ko:"한국어",fr:"Français",de:"Deutsch",es:"Español"};
let languageCheckSequence=0;
let subscriptionSelectionSignature="";
let aiStatuses={}, languageReady=false, aiReady=false, translating=false, stopTranslation=false, asking=false, subscriptionTranslating=false, stopSubscription=false, subscriptionScope=null, languageDocument=null;
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
 $('translate-document').disabled=!languageReady||translating||subscriptionTranslating;
 $('ask-ai').disabled=!aiReady||asking||subscriptionTranslating;
 $('subscription-translate').disabled=!aiReady||asking||translating||subscriptionTranslating;
 const matches=doc.segments.filter(s=>Coconut.matchesSegment(s,doc,$('search').value,notesOnly,excerptsOnly));
 const signature=JSON.stringify([doc.key,$('translation-source').value,$('translation-target').value,$('ai-provider').value,$('ai-filtered').checked,matches.map(s=>s.id)]);
 if(!subscriptionTranslating&&subscriptionSelectionSignature!==signature){subscriptionSelectionSignature=signature;$('ai-consent').checked=false;}
 if(subscriptionTranslating){
  $('subscription-translation-scope').textContent=`正在用 ${subscriptionScope.provider==='codex'?'ChatGPT/Codex':'Claude'} 把 ${languageNames[subscriptionScope.source]||''} → ${languageNames[subscriptionScope.target]||''}：确认筛选的 ${subscriptionScope.selected} 段内，翻译 ${subscriptionScope.total} 段，共 ${subscriptionScope.requests} 次请求；已译的筛选片段也可能重复发送作上下文。不发送筛选外内容；修改筛选不扩大本次范围。`;
 }else{
  try{
   const plan=Coconut.subscriptionPlan(doc,matches.map(s=>s.id),$('translation-source').value,$('translation-target').value,($('ai-provider').value==='codex'?'chatgpt':'claude')+'_subscription_translation');
   $('subscription-translation-scope').textContent=`当前筛选 ${plan.selected} 段：待翻译 ${plan.total} 段，计划 ${plan.windows.length} 次模型请求，共发送 ${plan.sent} 段所选原文；已译的所选片段也可能重复发送作上下文。不发送未选片段；筛选断点的上下文不可用。会使用订阅额度；可停止后续批次，真实订阅翻译质量尚未验收。`;
  }catch(error){$('subscription-translation-scope').textContent=error.message;$('subscription-translate').disabled=true;}
 }

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
 const checkButton=$('check-ai');if(!checkButton)return;const sequence=++languageCheckSequence;checkButton.disabled=true;
 try{const status=await languageApi('language-tools');if(!checkButton.isConnected||sequence!==languageCheckSequence)return;languageReady=true;aiStatuses=status.ai||{};aiReady=aiStatuses[$('ai-provider').value]?.ready===true;$('ai-status').textContent=aiStatuses[$('ai-provider').value]?.reason||'认证状态未知';$('language-status').textContent='本地翻译可用；未安装的语言模型需要你允许下载。机器翻译可能有误，原文和时间戳始终保留。';}
 catch{if(!checkButton.isConnected||sequence!==languageCheckSequence)return;languageReady=false;aiReady=false;$('ai-status').textContent='未连接本地处理服务。公开页面不会替你调用订阅账户，请在本机启动 Coconut。';}
 finally{if(sequence===languageCheckSequence){checkButton.disabled=false;renderLanguage();}}
}
$('check-ai').onclick=checkLanguageTools;
$('ai-filtered').onchange=()=>{
 $('ai-consent').checked=false;
 if(subscriptionTranslating){stopSubscription=true;$('ai-progress').textContent='读取范围已变化，当前订阅批次结束后停止；重新开始前需再次确认范围与额度。';}
 renderLanguage();
};
$('ai-provider').onchange=()=>{aiReady=aiStatuses[$('ai-provider').value]?.ready===true;$('ai-status').textContent=aiStatuses[$('ai-provider').value]?.reason||'请检查本机订阅连接';$('ai-consent').checked=false;renderLanguage();};
$('language-setup').onclick=()=>{showWorkspace('add');$('local-setup').open=true;$('local-setup').scrollIntoView({behavior:'smooth'});$('local-setup').querySelector('summary').focus();};
window.addEventListener('coconut-worker-ready',()=>{
 $('language-prerequisite').textContent='本地服务已连接。订阅功能还需官方 CLI 已安装并登录；确认所选片段及额度后才会发出请求。';
 $('language-setup').hidden=true;
 checkLanguageTools();
});
window.addEventListener('coconut-worker-disconnected',()=>{
 languageCheckSequence++;$('check-ai').disabled=true;
 $('language-prerequisite').textContent='本地服务未连接：先启动 Coconut 并打开本地地址，再检查已登录的官方 CLI；已有译文与笔记仍可阅读。';
 $('language-setup').hidden=false;
 languageReady=false;aiReady=false;aiStatuses={};stopTranslation=true;stopSubscription=true;
 $('ai-consent').checked=false;
 $('ai-status').textContent='本地服务已断开。连接恢复后重新检查订阅；不会自动重新发送文字。';
 $('language-status').textContent='本地服务未连接；已有译文仍可阅读与备份。';
 renderLanguage();
});
window.addEventListener('coconut-render',renderLanguage);
for(const id of ['translation-source','translation-target'])$(id).onchange=()=>{$('ai-consent').checked=false;renderLanguage();};
$('translation-view').onchange=()=>{if(active()){active().translation_view=$('translation-view').value;save();render();}};
$('stop-translation').onclick=()=>{stopTranslation=true;$('language-status').textContent='正在完成当前批次；已完成译文会保留，下次可以继续。';};
$('translate-document').onclick=async()=>{
 const doc=active(),source=$('translation-source').value,target=$('translation-target').value;
 if(translating||subscriptionTranslating){notice('已有翻译正在运行，请先停止或等待完成');return;}
 if(!doc||!source||source===target){notice('请选择不同的原文和翻译语言');return;}
 const key=doc.key;const pending=doc.segments.filter(s=>!(Coconut.translationCurrent(s,doc,s.translations?.[target])&&s.translations[target].source_language===source));
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
   destination.translation_view=target;if(!save())throw new Error('本批译文暂留在此页面，浏览器保存未成功，请立即导出备份；后续请求已停止');if(active()?.key===key)render();
  }
  $('language-status').textContent=`${stopTranslation?'已停止后续批次':'本次翻译完成'}：保存 ${completed} 段译文。原稿、时间戳与已有笔记均保留。`;
 }catch(error){$('language-status').textContent='翻译暂停：'+error.message+'。已完成译文保留，可重试继续。';}
 finally{translating=false;$('stop-translation').hidden=true;if(active()?.key===key)render();renderLanguage();}
};
$('ask-ai').onclick=async()=>{
 const doc=active();if(!doc||asking)return;
 if(!$('ai-consent').checked){notice('请先确认本次把所选文字发送给所选提供商并使用订阅额度');return;}
 const question=$('ai-question').value.trim();if(!question){notice('请先输入问题');return;}
 const query=$('search').value.trim().toLocaleLowerCase();
 const segments=doc.segments.filter(s=>!$('ai-filtered').checked||Coconut.matchesSegment(s,doc,query,notesOnly,excerptsOnly)).map(s=>({id:s.id,text:s.text}));
 const key=doc.key;asking=true;renderLanguage();$('ai-progress').textContent=`正在让所选 AI 阅读 ${segments.length} 段；不会切换到付费 API。`;
 try{
  const answer=await languageApi('ask',{question,language:$('translation-target').value,provider:$('ai-provider').value,segments,consent:true});
  const destination=state.documents.find(d=>d.key===key);if(!destination)throw new Error('原文字稿已关闭');
  if(segments.some(s=>destination.segments.find(current=>current.id===s.id)?.text!==s.text))throw new Error('请求期间原文已修改，请按新原文重新提问');
  if(typeof answer.answer!=='string'||!Array.isArray(answer.citations)||answer.citations.some(id=>!segments.some(s=>s.id===id)))throw new Error('回答引用无效');
  destination.ai_answers||=[];destination.ai_answers.push({...answer,question,source_snapshot:Object.fromEntries(segments.filter(s=>answer.citations.includes(s.id)).map(s=>[s.id,s.text]))});destination.ai_answers=destination.ai_answers.slice(-20);const persisted=save();
  $('ai-progress').textContent=persisted?'回答已保存在这份文字稿中，可点击引用返回原文；AI 判断仍需核对。':'回答暂留在当前页，浏览器保存未成功；请先导出备份，勿关闭页面。';
 }catch(error){$('ai-progress').textContent='AI 阅读未完成：'+error.message;}
 finally{asking=false;$('ai-consent').checked=false;renderLanguage();}
};
renderLanguage();

$('stop-subscription-translation').onclick=()=>{stopSubscription=true;$('ai-progress').textContent='当前订阅批次结束后停止；已完成内容保留。';};
$('subscription-translate').onclick=async()=>{
 const doc=active(),source=$('translation-source').value,target=$('translation-target').value,provider=$('ai-provider').value;
 if(!doc||subscriptionTranslating||asking||translating)return;
 if(!$('ai-consent').checked){notice('请先确认本次把筛选片段发送给所选AI，并消耗所显示批次的订阅额度');return;}
 if(!source||source===target){notice('请选择不同的原文和翻译语言');return;}
 const providerName=(provider==='codex'?'chatgpt':'claude')+'_subscription_translation';
 const selectedCues=doc.segments.filter(s=>Coconut.matchesSegment(s,doc,$('search').value,notesOnly,excerptsOnly));
 let plan;
 try{plan=Coconut.subscriptionPlan(doc,selectedCues.map(s=>s.id),source,target,providerName);}catch(error){notice(error.message);return;}
 if(!plan.total){notice('当前筛选没有需要订阅翻译的新片段');return;}
 const key=doc.key;subscriptionScope={key,total:plan.total,selected:plan.selected,requests:plan.windows.length,source,target,provider};subscriptionTranslating=true;stopSubscription=false;$('stop-subscription-translation').hidden=false;renderLanguage();let completed=0;
 try{
  for(const window of plan.windows){
   if(stopSubscription||!$('ai-consent').checked)break;
   const batch=window.segments;const before=state.documents.find(d=>d.key===key);
   if(!Coconut.sameCueSnapshot(before,window.snapshot))throw new Error('原文或所选上下文已修改，未发出本批模型请求，请重新开始');
   $('ai-progress').textContent=`订阅翻译中：${completed}/${plan.total} 段；上下文仅来自确认的筛选，不购买额度，不回退到API。`;
   const result=await languageApi('translate-subscription',{source,target,provider,segments:batch,context:window.context,consent:true});
   if(!Array.isArray(result.translations)||result.translations.length!==batch.length||result.translations.some((t,i)=>t.id!==batch[i].id||t.source_text!==batch[i].text||typeof t.text!=='string'||!t.text.trim()||t.text.length>12000))throw new Error('订阅结果与目标片段未完整对应，本批不保存');
   const destination=state.documents.find(d=>d.key===key);if(!destination)throw new Error('原文字稿已关闭');
   if(!Coconut.sameCueSnapshot(destination,window.snapshot))throw new Error('本批原文或上下文已修改，为避免错配，本批全部不保存');
   const contextId=crypto.randomUUID();destination.translation_contexts||=Object.create(null);destination.translation_contexts[contextId]=window.snapshot;
   for(const item of result.translations){const segment=destination.segments.find(s=>s.id===item.id);segment.translations||={};segment.translations[target]={text:item.text,source_text:item.source_text,source_language:source,provider:providerName,context_id:contextId};}
   destination.translation_contexts=Coconut.cleanContexts(destination.translation_contexts,destination.segments);
   completed+=batch.length;destination.translation_view=target;if(!save())throw new Error('本批译文暂留在此页面，浏览器保存未成功，请立即导出备份；后续请求已停止');if(active()?.key===key)render();
  }
  $('ai-progress').textContent=`${completed<plan.total?'已停止后续批次':'本次订阅翻译完成'}：保存 ${completed} 段。下次需重新确认发送与额度，才会继续剩余部分。翻译仅关联原字幕时间范围，不是译文逐字对齐。`;

 }catch(error){$('ai-progress').textContent='订阅翻译暂停：'+error.message+'。已完成结果仍在当前页；校验失败的批次不会覆盖旧译文。请检查保存提示并备份。';}
 finally{subscriptionTranslating=false;subscriptionScope=null;$('ai-consent').checked=false;$('stop-subscription-translation').hidden=true;if(active()?.key===key)render();renderLanguage();}
};
