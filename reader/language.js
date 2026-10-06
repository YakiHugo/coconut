"use strict";
const languageNames={en:"英语",zh:"中文",ja:"日语",ko:"韩语",fr:"法语",de:"德语",es:"西班牙语"};
let languageCheckSequence=0;
let subscriptionSelectionSignature="";
let languageDocumentLabel=null;
let glossaryDocumentSignature="";
const glossaryDrafts=new Map();
function savedGlossaryText(doc,target){return Coconut.cleanGlossary(doc?.translation_glossary?.[target]).map(e=>JSON.stringify(e.source)+' = '+JSON.stringify(e.target)).join('\n');}
function glossaryDirty(){return $('translation-glossary')&&$('translation-glossary').value!==savedGlossaryText(active(),$('translation-target').value);}
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
 if(languageDocument!==doc.key || languageDocumentLabel!==(doc.language||'')){
  if(languageDocument===doc.key && translating)stopTranslation=true;
  if(languageDocument===doc.key && subscriptionTranslating)stopSubscription=true;
  languageDocument=doc.key;languageDocumentLabel=doc.language||'';
  $('translation-source').value=languageDocumentLabel;$('ai-consent').checked=false;
 }
 $('translation-view').value=doc.translation_view||'';
 $('translate-document').disabled=!languageReady||translating||subscriptionTranslating;
 $('ask-ai').disabled=!aiReady||asking||subscriptionTranslating;
 $('subscription-translate').disabled=!aiReady||asking||translating||subscriptionTranslating;
 const matches=doc.segments.filter(s=>Coconut.matchesSegment(s,doc,$('search').value,notesOnly,excerptsOnly));
 if($('ai-task')){$('ai-question').disabled=$('ai-task').value==='summary';$('ai-filtered').disabled=$('ai-task').value==='summary';if($('ai-task').value==='summary')$('ai-filtered').checked=false;}
 const signature=JSON.stringify([doc.key,$('translation-source').value,$('translation-target').value,$('ai-provider').value,$('ai-filtered').checked,$('ai-task')?.value,doc.translation_glossary,matches.map(s=>s.id)]);
 const glossarySignature=JSON.stringify([doc.key,$('translation-target').value]);
 if($('translation-glossary')&&glossaryDocumentSignature!==glossarySignature){glossaryDocumentSignature=glossarySignature;$('translation-glossary').value=glossaryDrafts.get(glossarySignature)??savedGlossaryText(doc,$('translation-target').value);}
 if($('translation-quality')){const warnings=doc.segments.filter(s=>Coconut.translationCurrent(s,doc,s.translations?.[$('translation-target').value])&&s.translations[$('translation-target').value].quality_warnings?.length);$('translation-quality').textContent=warnings.length?`当前译文有 ${warnings.length} 段自动核对提示，请回听检查数字、术语与漏译。提示只检测表面异常，不能证明语义正确。`:'自动核对可提示数字、术语、重复与阅读速度风险；没有提示也不代表语义正确。';}
 if(!subscriptionTranslating&&subscriptionSelectionSignature!==signature){subscriptionSelectionSignature=signature;$('ai-consent').checked=false;}
 if(subscriptionTranslating){
  $('subscription-translation-scope').textContent=`正在用 ${subscriptionScope.provider==='codex'?'ChatGPT/Codex':'Claude'} 把 ${languageNames[subscriptionScope.source]||''} → ${languageNames[subscriptionScope.target]||''}：确认筛选的 ${subscriptionScope.selected} 段内，翻译 ${subscriptionScope.total} 段，共 ${subscriptionScope.requests} 次请求；已译的筛选片段也可能重复发送作上下文。同时发送所选片段的说话人标签、匹配术语及已有译文建议。不发送筛选外内容；修改筛选不扩大本次范围。`;
 }else{
  try{
   const plan=Coconut.subscriptionPlan(doc,matches.map(s=>s.id),$('translation-source').value,$('translation-target').value,($('ai-provider').value==='codex'?'chatgpt':'claude')+'_subscription_translation');
   $('subscription-translation-scope').textContent=`当前筛选 ${plan.selected} 段：待翻译 ${plan.total} 段，计划 ${plan.windows.length} 次模型请求，共发送 ${plan.sent} 段所选原文；已译的所选片段也可能重复发送作上下文。按句末、说话人和停顿优先分批；只附匹配术语、所选说话人标签及已有译文建议。不发送未选片段；筛选断点的上下文不可用。会使用订阅额度；可停止后续批次，真实订阅翻译质量尚未验收。`;
  }catch(error){$('subscription-translation-scope').textContent=error.message;$('subscription-translate').disabled=true;}
 }

 $("export-ai-reading").disabled=!(doc.ai_answers||[]).length;
 const host=$('ai-answers');host.replaceChildren();
 for(const answer of (doc.ai_answers||[]).slice().reverse()){
  const section=el('section','ai-answer');
  const freshness=Coconut.answerFreshness(answer,doc);
  if(freshness==='stale')section.append(el('p','hint','本次发送的原文已修改或移除，此回答依据可能过期，请重新提问'));
  if(freshness==='unknown')section.append(el('p','hint','此回答缺少完整的发送原文记录，无法确认依据是否仍有效，请核对或重新提问'));
  section.append(el('strong','',answer.question),el('p','',answer.answer));
  for(const id of answer.citations){const segment=doc.segments.find(s=>s.id===id);if(!segment)continue;const button=el('button','',Coconut.time(segment.start)+' · 原文');button.onclick=()=>goToSegment(id);section.append(button);}
  if(!answer.citations.length)section.append(el('p','hint','回答未提供片段引用，请回听核对'));
  host.append(section);
 }
}
async function checkLanguageTools(){
 const checkButton=$('check-ai');if(!checkButton)return;const sequence=++languageCheckSequence;checkButton.disabled=true;
 try{const status=await languageApi('language-tools');if(!checkButton.isConnected||sequence!==languageCheckSequence)return;languageReady=status.local_translation!==false;aiStatuses=status.ai||{};aiReady=aiStatuses[$('ai-provider').value]?.ready===true;$('ai-status').textContent=aiStatuses[$('ai-provider').value]?.reason||'认证状态未知';$('language-status').textContent=languageReady?'离线模型只提供逐段粗稿，不能理解跨段指代；上下文翻译请使用已连接的本地 CLI。未安装模型仍需你允许下载。':'桌面版不安装重型离线翻译模型；可连接本地 CLI 使用已有订阅做上下文翻译。不会自动发送文字或切换付费 API。';}
 catch{if(!checkButton.isConnected||sequence!==languageCheckSequence)return;languageReady=false;aiReady=false;$('ai-status').textContent='未连接本地处理服务。公开页面不会替你调用订阅账户，请在本机启动 Coconut。';}
 finally{if(sequence===languageCheckSequence){checkButton.disabled=false;renderLanguage();}}
}
$('check-ai').onclick=checkLanguageTools;
$('ai-filtered').onchange=()=>{
 $('ai-consent').checked=false;
 if(subscriptionTranslating){stopSubscription=true;$('ai-progress').textContent='读取范围已变化，当前订阅批次结束后停止；重新开始前需再次确认范围与额度。';}
 renderLanguage();
};
$('ai-provider').onchange=()=>{if(subscriptionTranslating)stopSubscription=true;aiReady=aiStatuses[$('ai-provider').value]?.ready===true;$('ai-status').textContent=aiStatuses[$('ai-provider').value]?.reason||'请检查本机订阅连接';$('ai-consent').checked=false;renderLanguage();};
$('language-setup').onclick=()=>{showWorkspace('add');$('local-setup').open=true;$('local-setup').scrollIntoView({behavior:'smooth'});$('local-setup').querySelector('summary').focus();};
window.addEventListener('coconut-worker-ready',()=>{
 $('language-prerequisite').textContent='本地连接已就绪。CLI 功能需要官方工具已安装并登录；确认所选文字、匹配术语和已有译文建议及额度后才会发出请求。';
 $('language-setup').hidden=true;
 $('check-ai').disabled=false;
 $('ai-status').textContent='点击「检查本地 CLI 连接」后才会检测已安装工具和订阅登录。打开页面不会启动 CLI 或发送原文。';
 renderLanguage();
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
for(const id of ['translation-source','translation-target'])$(id).onchange=()=>{$('ai-consent').checked=false;if(subscriptionTranslating)stopSubscription=true;renderLanguage();};
if($('ai-task'))$('ai-task').onchange=()=>{$('ai-consent').checked=false;if(subscriptionTranslating)stopSubscription=true;renderLanguage();};
if($('translation-glossary'))$('translation-glossary').oninput=()=>{glossaryDrafts.set(glossaryDocumentSignature,$('translation-glossary').value);$('ai-consent').checked=false;if(subscriptionTranslating)stopSubscription=true;};
if($('save-translation-glossary'))$('save-translation-glossary').onclick=()=>{
 const doc=active();if(!doc)return;
 try{
  const entries=$('translation-glossary').value.split(/\r?\n/).filter(line=>line.trim()).map(line=>{if(line.trim().startsWith('"')){const match=line.trim().match(/^("(?:[^"\\]|\\.)*")\s*=\s*(.+)$/);if(!match)throw new Error('带引号的术语请按「"原词" = "译法"」填写');return {source:JSON.parse(match[1]),target:match[2].startsWith('"')?JSON.parse(match[2]):match[2].trim()};}const index=line.indexOf('=');if(index<1)throw new Error('请按每行「原词 = 统一译法」填写');return {source:line.slice(0,index).trim(),target:line.slice(index+1).trim()};});
  const terms=Coconut.cleanGlossary(entries,true);doc.translation_glossary||=Object.create(null);doc.translation_glossary[$('translation-target').value]=terms;glossaryDrafts.delete(glossaryDocumentSignature);$('translation-glossary').value=savedGlossaryText(doc,$('translation-target').value);
  $('ai-consent').checked=false;if(subscriptionTranslating)stopSubscription=true;const persisted=save();render();notice(persisted?'本篇术语表已保存；受影响的译文需重新生成':'术语表暂留本页，保存失败，请立即备份');
 }catch(error){notice(error.message);}
};
$('translation-view').onchange=()=>{if(active()){active().translation_view=$('translation-view').value;save();render();}};
$('stop-translation').onclick=()=>{stopTranslation=true;$('language-status').textContent='正在完成当前批次；已完成译文会保留，下次可以继续。';};
$('translate-document').onclick=async()=>{
 const doc=active(),source=$('translation-source').value,target=$('translation-target').value;
 if(translating||subscriptionTranslating){notice('已有翻译正在运行，请先停止或等待完成');return;}
 if(!doc||!source||source===target){notice('请选择不同的原文和翻译语言');return;}
 if(!languageReady){notice('当前连接不提供离线模型；请使用本地 CLI 上下文翻译');return;}
 const documentLanguage=doc.language||'';const key=doc.key;const pending=doc.segments.filter(s=>!(Coconut.translationCurrent(s,doc,s.translations?.[target])&&s.translations[target].source_language===source));
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
   for(const item of result.translations){const segment=destination.segments.find(s=>s.id===item.id);if(segment.text!==item.source_text)continue;segment.translations||={};segment.translations[target]={text:item.text,source_text:item.source_text,source_language:source,document_language:documentLanguage,provider:item.provider};completed++;}
   destination.translation_view=target;if(!save())throw new Error('本批译文暂留在此页面，浏览器保存未成功，请立即导出备份；后续请求已停止');if(active()?.key===key)render();
  }
  $('language-status').textContent=`${stopTranslation?'已停止后续批次':'本次翻译完成'}：保存 ${completed} 段离线粗稿。逐段模型不能保证上下文一致，请核对技术术语；原稿、时间戳与已有笔记均保留。`;
 }catch(error){$('language-status').textContent='翻译暂停：'+error.message+'。已完成译文保留，可重试继续。';}
 finally{translating=false;$('stop-translation').hidden=true;if(active()?.key===key)render();renderLanguage();}
};
$('ask-ai').onclick=async()=>{
 const doc=active();if(!doc||asking)return;
 if(!$('ai-consent').checked){notice('请先确认本次把所选文字发送给所选提供商并使用订阅额度');return;}
 const purpose=$('ai-task')?.value==='summary'?'summary':'question';
 const question=purpose==='summary'?'请根据完整原文生成简洁中文摘要，列出核心主旨、关键论点、重要事实或数字、分歧与尚不确定之处。每项结论都必须能由原文支持，并在返回的 citations 中提供相应片段ID。不要虚构主题、事实、人物身份或缺失结论；证据不足时明确说明。':$('ai-question').value.trim();if(!question){notice('请先输入问题');return;}
 const query=$('search').value.trim().toLocaleLowerCase();
 const segments=doc.segments.filter(s=>purpose==='summary'||!$('ai-filtered').checked||Coconut.matchesSegment(s,doc,query,notesOnly,excerptsOnly)).map(s=>({id:s.id,text:s.text}));
 const key=doc.key;asking=true;renderLanguage();$('ai-progress').textContent=`正在让所选 AI 阅读 ${segments.length} 段；不会切换到付费 API。`;
 try{
  const answer=await languageApi('ask',{question,language:purpose==='summary'?'zh':$('translation-target').value,provider:$('ai-provider').value,segments,consent:true});
  const destination=state.documents.find(d=>d.key===key);if(!destination)throw new Error('原文字稿已关闭');
  if(Coconut.answerFreshness({purpose,input_snapshot:{version:1,segments}},destination)!=='current'||purpose==='summary'&&destination.segments.length!==segments.length)throw new Error('请求期间原文已修改，请按新原文重新提问');
  if(typeof answer.answer!=='string'||!Array.isArray(answer.citations)||answer.citations.some(id=>!segments.some(s=>s.id===id)))throw new Error('回答引用无效');
  destination.ai_answers||=[];destination.ai_answers.push({...answer,question,purpose,input_snapshot:{version:1,segments}});destination.ai_answers=Coconut.retainAnswers?Coconut.retainAnswers(destination.ai_answers):destination.ai_answers.slice(-20);const persisted=save();if(typeof renderSummary==='function')renderSummary();
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
 if(glossaryDirty()){notice('术语表有未保存修改，请先保存本篇术语表，再确认翻译');return;}
 const providerName=(provider==='codex'?'chatgpt':'claude')+'_subscription_translation';
 const selectedCues=doc.segments.filter(s=>Coconut.matchesSegment(s,doc,$('search').value,notesOnly,excerptsOnly));
 let plan;
 try{plan=Coconut.subscriptionPlan(doc,selectedCues.map(s=>s.id),source,target,providerName);}catch(error){notice(error.message);return;}
 if(!plan.total){notice('当前筛选没有需要订阅翻译的新片段');return;}
 const documentLanguage=doc.language||'';const key=doc.key;subscriptionScope={key,total:plan.total,selected:plan.selected,requests:plan.windows.length,source,target,provider};subscriptionTranslating=true;stopSubscription=false;$('stop-subscription-translation').hidden=false;renderLanguage();let completed=0;
 try{
  for(const window of plan.windows){
   if(stopSubscription||!$('ai-consent').checked)break;
   const batch=window.segments;const before=state.documents.find(d=>d.key===key);
   if(!Coconut.sameCueSnapshot(before,window.snapshot)||JSON.stringify(Coconut.relevantGlossary(before,target,window.snapshot))!==JSON.stringify(window.glossary))throw new Error('原文或所选上下文已修改，未发出本批模型请求，请重新开始');
   $('ai-progress').textContent=`订阅翻译中：${completed}/${plan.total} 段；上下文仅来自确认的筛选，不购买额度，不回退到API。`;
   const result=await languageApi('translate-subscription',{source,target,provider,segments:batch,context:window.context,glossary:window.glossary,memory:window.memory,consent:true});
   if(!Array.isArray(result.translations)||result.translations.length!==batch.length||result.translations.some((t,i)=>t.id!==batch[i].id||t.source_text!==batch[i].text||typeof t.text!=='string'||!t.text.trim()||t.text.length>12000))throw new Error('订阅结果与目标片段未完整对应，本批不保存');
   const destination=state.documents.find(d=>d.key===key);if(!destination)throw new Error('原文字稿已关闭');
   if(!Coconut.sameCueSnapshot(destination,window.snapshot)||JSON.stringify(Coconut.relevantGlossary(destination,target,window.snapshot))!==JSON.stringify(window.glossary))throw new Error('本批原文或上下文已修改，为避免错配，本批全部不保存');
   const contextId=crypto.randomUUID();destination.translation_contexts||=Object.create(null);destination.translation_contexts[contextId]=window.snapshot;
   for(const item of result.translations){const segment=destination.segments.find(s=>s.id===item.id);segment.translations||={};segment.translations[target]={text:item.text,source_text:item.source_text,source_language:source,document_language:documentLanguage,provider:providerName,context_id:contextId,context_version:2,target_language:target,glossary_snapshot:window.glossary,input_revision:item.input_revision,quality_warnings:Array.isArray(item.quality_warnings)?item.quality_warnings.filter(code=>Coconut.translationQualityMessage({quality_warnings:[code]})):[]};}
   destination.translation_contexts=Coconut.cleanContexts(destination.translation_contexts,destination.segments);
   completed+=batch.length;destination.translation_view=target;if(!save())throw new Error('本批译文暂留在此页面，浏览器保存未成功，请立即导出备份；后续请求已停止');if(active()?.key===key)render();
  }
  $('ai-progress').textContent=`${completed<plan.total?'已停止后续批次':'本次订阅翻译完成'}：保存 ${completed} 段。下次需重新确认发送与额度，才会继续剩余部分。翻译仅关联原字幕时间范围，不是译文逐字对齐。`;

 }catch(error){$('ai-progress').textContent='订阅翻译暂停：'+error.message+'。已完成结果仍在当前页；校验失败的批次不会覆盖旧译文。请检查保存提示并备份。';}
 finally{subscriptionTranslating=false;subscriptionScope=null;$('ai-consent').checked=false;$('stop-subscription-translation').hidden=true;if(active()?.key===key)render();renderLanguage();}
};

$("export-ai-reading").onclick=()=>{
 const doc=active();if(!doc?.ai_answers?.length)return;
 let url,link;
 try{
  url=URL.createObjectURL(new Blob([Coconut.aiReadingMarkdown(doc)],{type:"text/markdown;charset=utf-8"}));
  link=el("a");link.href=url;link.download=doc.title.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,"_")+".ai-reading.md";link.hidden=true;document.body.append(link);link.click();
  notice("已发起全部 "+doc.ai_answers.length+" 则 本地 AI 记录下载，包含历史发送原文及依据状态；请确认文件已保存并核对 AI 判断。");
 }catch{notice("本地 AI 记录导出失败，回答仍在本页，请重试。");}
 finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),60000);}
};
