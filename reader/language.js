"use strict";
const languageNames={en:"英语",zh:"中文",ja:"日语",ko:"韩语",fr:"法语",de:"德语",es:"西班牙语"};
function translationLanguage(value){
 // Publisher and caption metadata can retain regional/script tags. Select the
 // supported base language without rewriting that original provenance.
 const tag=typeof value==='string'?value.trim().toLowerCase():'';
 if(!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(tag))return '';
 const base=tag.split('-')[0];return Object.hasOwn(languageNames,base)?base:'';
}
let languageCheckSequence=0;
let subscriptionSelectionSignature="";
let languageDocumentLabel=null;
let glossaryDocumentSignature="";
const glossaryDrafts=new Map();
let summaryScope=null,summaryConsentSignature="";
let offlineTranslationKey=null,questionKey=null,offlineTranslationScope=null,questionScope=null;
const glossarySubmissions=new Map();
// A stopped plan may keep its already-sent result; a retired owner may never
// write or change a newer task, even after removal rollback or native release.
function languageOwnerLive(owner){return !!owner&&!owner.retired&&contentIngressAllowed(owner.doc);}
function retireLanguageOwners(key=null){
 const matches=owner=>owner&&(key===null||owner.key===key);
 const matched=matches(summaryScope)||matches(questionScope)||matches(offlineTranslationScope)||matches(subscriptionScope);
 if(key!==null){
  const message='原文字稿已移除或更换，旧请求已停止；迟到结果不会覆盖恢复后的文档。';
  if(matches(summaryScope)||matches(questionScope)||matches(subscriptionScope))aiProgress(key,message);
  if(matches(offlineTranslationScope))translationProgress(key,message);
 }
 if(matches(summaryScope)){summaryScope.stop=true;summaryScope.retired=true;summaryScope=null;asking=false;}
 if(matches(questionScope)){questionScope.retired=true;questionScope=null;questionKey=null;asking=false;}
 if(matches(offlineTranslationScope)){offlineTranslationScope.retired=true;offlineTranslationScope=null;offlineTranslationKey=null;translating=false;stopTranslation=true;$('stop-translation').hidden=true;}
 if(matches(subscriptionScope)){subscriptionScope.retired=true;subscriptionScope=null;subscriptionTranslating=false;stopSubscription=true;$('stop-subscription-translation').hidden=true;}
 if(key===null||matched)$('ai-consent').checked=false;
}
const aiProgressByDocument=new Map(),translationProgressByDocument=new Map();
let languageAvailabilityMessage=$('language-status').textContent;
function aiProgress(key,text){if(!key)return;aiProgressByDocument.set(key,text);if(active()?.key===key)$('ai-progress').textContent=text;}
function translationProgress(key,text){if(!key)return;translationProgressByDocument.set(key,text);if(active()?.key===key)$('language-status').textContent=text;}
function languageAvailability(text){languageAvailabilityMessage=text;$('language-status').textContent=translationProgressByDocument.get(active()?.key)||text;}
// A canceled plan stays canceled even if the shared consent control is checked
// for a reopened panel or another document while its current request finishes.
function stopLanguageBatches(){
 if(summaryScope)summaryScope.stop=true;
 if(translating)stopTranslation=true;
 if(subscriptionTranslating)stopSubscription=true;
 $('ai-consent').checked=false;
}
function translationSurfaceOpen(){
 return workspace==='read'&&!$('language-panel').hidden&&$('language-panel').open&&($('toggle-demo-tools').hidden||$('toggle-demo-tools').getAttribute('aria-expanded')==='true');
}
function subscriptionReadingControls(){return JSON.stringify([$('search').value.trim().toLocaleLowerCase(),notesOnly,excerptsOnly,speakerFilter]);}
function checkSubscriptionReadingScope(doc=active(),matches=null){
 if(!subscriptionTranslating||stopSubscription)return;
 matches??=doc?.segments.filter(cue=>matchesReadingSegment(cue,doc,$('search').value))||[];
 if(doc?.key!==subscriptionScope.key||subscriptionReadingControls()!==subscriptionScope.readingControls||matches.length!==subscriptionScope.visibleIds.length||matches.some((cue,index)=>cue.id!==subscriptionScope.visibleIds[index])){
  stopSubscription=true;$('ai-consent').checked=false;
  aiProgress(subscriptionScope.key,'读取范围已变化，当前订阅批次结束后停止；重新开始前需再次确认范围与额度。');
 }
}
function renderLanguageProgress(doc){
 const runningKey=summaryScope?.key||subscriptionScope?.key||questionKey||offlineTranslationKey;
 const other=runningKey&&runningKey!==doc.key&&state.documents.find(item=>item.key===runningKey);
 $('ai-progress').textContent=other?`正在完成「${other.title}」已发送的当前请求；完成前不能开始新的 AI 请求。`:aiProgressByDocument.get(doc.key)||'';
 $('language-status').textContent=translationProgressByDocument.get(doc.key)||languageAvailabilityMessage;
}
function savedGlossaryText(doc,target){return Coconut.cleanGlossary(doc?.translation_glossary?.[target]).map(e=>JSON.stringify(e.source)+' = '+JSON.stringify(e.target)).join('\n');}
function glossaryDirty(){return $('translation-glossary')&&$('translation-glossary').value!==savedGlossaryText(active(),$('translation-target').value);}
let aiStatuses={}, languageReady=false, aiReady=false, translating=false, stopTranslation=false, asking=false, subscriptionTranslating=false, stopSubscription=false, subscriptionScope=null, languageDocument=null;
for(const [code,name] of Object.entries(languageNames))for(const id of ["translation-source","translation-target","translation-view"]){const option=document.createElement('option');option.value=code;option.textContent=id==='translation-view'?name+' + 原文':name;document.getElementById(id).append(option);}
document.getElementById('translation-target').value='zh';
async function languageApi(path,data){
 const response=await fetch('api/'+path,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(path==='translate'?600000:200000)});
 const value=await response.json();if(!response.ok)throw new Error(value.error||'请求失败');return value;
}
function questionSources(doc){
 return doc.segments.filter(cue=>!$('ai-filtered').checked||matchesReadingSegment(cue,doc,$('search').value)).map(({id,text})=>({id,text}));
}
function planCounts(id,segments,requests,sent=segments){
 const node=$(id);node.dataset.segmentCount=String(segments);node.dataset.requestCount=String(requests);node.dataset.sentCount=String(sent);
}
function compactSummaryPlan(plan,job,saved){
 const completed=job?.results.length||0;
 return `整篇 ${plan.segments.toLocaleString('en-US')} 段 · ${plan.characters.toLocaleString('en-US')} 字符 · 中文摘要。${plan.chunks.length} 个原文批次${plan.chunks.length>1?' + 1 次汇总':''}；${completed?`${saved?'已保存':'当前页暂存'} ${completed} 批，本次继续 ${plan.requests-completed} 次`:`共 ${plan.requests} 次`}模型请求。`;
}
function renderLanguage(){
 if(!$("language-panel"))return;
 const doc=active();if(summaryScope&&(doc?.key!==summaryScope.key||!CoconutSummary.current(doc?.summary_job,doc)))summaryScope.stop=true;if(!doc)return;
 renderLanguageProgress(doc);
 const hasTranscript=doc.project_kind!=='audio_only'&&doc.segments.length>0;
 if(languageDocument!==doc.key || languageDocumentLabel!==(doc.language||'')){
  const newDocument=languageDocument!==doc.key;
  if(translating)stopTranslation=true;
  if(subscriptionTranslating)stopSubscription=true;
  if(languageDocument!==doc.key)closeSummaryRequest(false);
  languageDocument=doc.key;languageDocumentLabel=doc.language||'';
  const source=translationLanguage(languageDocumentLabel);
  $('translation-source').value=source;
  // Keep a deliberately selected target on ordinary renders and metadata edits.
  // On opening another document, avoid an unusable same-language default.
  if(newDocument&&source&&$('translation-target').value===source)$('translation-target').value=source==='zh'?'en':'zh';
  $('ai-consent').checked=false;
 }
 const task=$('ai-task').value,summarySelected=task==='summary',translationSelected=task==='translation',questionSelected=task==='question';
 $('ai-request-panel').dataset.task=task;
 for(const node of document.querySelectorAll('.ai-translation-only'))node.hidden=!translationSelected;
 for(const node of document.querySelectorAll('.ai-question-only'))node.hidden=!questionSelected;
 for(const node of document.querySelectorAll('.ai-answer-language'))node.hidden=summarySelected;
 $('translation-target-label').textContent=translationSelected?'翻译成':'回答语言';
 $('summary-connection-help').textContent=$('language-prerequisite').textContent;
 $('summary-connection-setup').hidden=$('language-setup').hidden;
 $('ask-ai').hidden=translationSelected;
 $('subscription-translate').hidden=!translationSelected;
 $('ask-ai').textContent=summarySelected?(asking?'正在生成摘要…':doc.summary_job?'继续摘要':'生成摘要'):(asking?'正在回答…':'发送问题');
 $('translation-view').value=doc.translation_view||'';
 $('translate-document').disabled=!translationSelected||!hasTranscript||!languageReady||asking||translating||subscriptionTranslating;
 $('language-status').hidden=!translating&&(!translationSelected||!translationProgressByDocument.has(doc.key));
 const summaryReadiness=summarySelected?Coconut.summaryReadiness(doc):null;
 const summaryBlocked=summaryReadiness?.ready===false;
 const sources=questionSources(doc),questionCharacters=sources.reduce((count,cue)=>count+cue.text.length,0);
 const questionInput=JSON.stringify({question:$('ai-question').value.trim(),answer_language:$('translation-target').value,transcript:sources});
 const questionBlocked=questionSelected&&(!sources.length||sources.length>5000||questionInput.length>250000||$('ai-question').value.trim().length>4000);
 const questionReason=!sources.length?'当前筛选没有原文，换个关键词或清除筛选后再提问。':$('ai-question').value.trim().length>4000?'问题超过 4,000 字符，请缩短后再发送。':'所选原文超过单次提问范围，请筛选较小范围后再提问。';
 $('ask-ai').disabled=translationSelected||!hasTranscript||!aiReady||asking||translating||subscriptionTranslating||summaryBlocked||questionBlocked;
 $('ai-request-readiness').hidden=!summaryBlocked&&!questionBlocked;
 $('ai-request-readiness').textContent=summaryBlocked?summaryReadiness.reason:questionBlocked?questionReason:'';
 $('ai-select-excerpt').hidden=!summaryBlocked;
 const summaryJob=doc.summary_job;
 $('summary-plan').hidden=!summarySelected||!summaryReadiness?.ready;
 $('summary-job-state').hidden=!summarySelected||!summaryJob;
 $('restart-summary').hidden=!summarySelected||!summaryJob||!!summaryScope;
 $('stop-summary').hidden=!summaryScope;
 if(summarySelected&&summaryReadiness?.ready){
  const compatible=summaryJob&&CoconutSummary.current(summaryJob,doc)&&summaryJob.provider===$('ai-provider').value;
  const job=compatible?summaryJob:null,plan=summaryReadiness.plan;
  $('summary-plan').textContent=compactSummaryPlan(plan,job,summaryCheckpointSaved(doc));
  planCounts('summary-plan',plan.segments,plan.requests-(job?.results.length||0));
  $('ai-send-description').textContent=CoconutSummary.notice(plan,job,summaryCheckpointSaved(doc));
  $('summary-job-state').textContent=summaryJob?(compatible?`${summaryCheckpointSaved(doc)?'已保存':'当前页暂存'} ${summaryJob.results.length}/${plan.chunks.length} 批。${!summaryCheckpointSaved(doc)?'最新进度尚未保存，请立即导出 JSON 备份。':''}${summaryJob.status==='interrupted'?'上次请求中断，可能已消耗额度但结果未保存；继续将重发该批。':'再次确认后继续。'}`:'原文或提供商已改变，旧分批进度不能用于当前整篇摘要；请先放弃旧进度。'):'';
  if(summaryJob&&!compatible)$('ask-ai').disabled=true;
  if(!summaryScope){const signature=JSON.stringify([doc.key,$('ai-provider').value,plan.source,summaryJob?.results.length]);if(signature!==summaryConsentSignature){summaryConsentSignature=signature;$('ai-consent').checked=false;}}
 }else if(summarySelected)$('ai-send-description').textContent='整篇摘要仅使用当前文档的完整原文，不发送阅读笔记或音视频。';

 $('subscription-translate').disabled=!translationSelected||!hasTranscript||!aiReady||asking||translating||subscriptionTranslating;
 const matches=doc.segments.filter(s=>matchesReadingSegment(s,doc,$('search').value));
 checkSubscriptionReadingScope(doc,matches);
 $('ai-question').disabled=!questionSelected;$('ai-filtered').disabled=!questionSelected;
 if(summarySelected)$('ai-filtered').checked=false;
 const signature=JSON.stringify([doc.key,$('translation-source').value,$('translation-target').value,$('ai-provider').value,$('ai-filtered').checked,task,doc.translation_glossary,matches.map(s=>[s.id,s.text,s.start,s.end,s.speaker]),questionSelected?sources:null,questionSelected?$('ai-question').value:null]);
 const glossarySignature=JSON.stringify([doc.key,$('translation-target').value]);
 if($('translation-glossary')&&glossaryDocumentSignature!==glossarySignature){glossaryDocumentSignature=glossarySignature;$('translation-glossary').value=glossaryDrafts.get(glossarySignature)??savedGlossaryText(doc,$('translation-target').value);}
 if($('translation-quality')){const warnings=doc.segments.filter(s=>Coconut.translationCurrent(s,doc,s.translations?.[$('translation-target').value])&&Coconut.translationQualityMessage(s.translations[$('translation-target').value]));$('translation-quality').textContent=warnings.length?`当前译文有 ${warnings.length} 段核对提示，请回听检查数字、术语与漏译。`:'重要术语与数字可以点原文回听核对。';}
 if(!subscriptionTranslating&&!summaryScope&&subscriptionSelectionSignature!==signature){subscriptionSelectionSignature=signature;$('ai-consent').checked=false;}
 $('subscription-translation-scope').hidden=!translationSelected;
 $('question-scope').hidden=!questionSelected;
 const providerName=$('ai-provider').value==='codex'?'ChatGPT / Codex':'Claude';
 if(translationSelected){
  try{
   const plan=subscriptionTranslating&&subscriptionScope.key===doc.key?subscriptionScope:Coconut.subscriptionPlan(doc,matches.map(s=>s.id),$('translation-source').value,$('translation-target').value,($('ai-provider').value==='codex'?'chatgpt':'claude')+'_subscription_translation');
   const source=subscriptionTranslating&&subscriptionScope.key===doc.key?plan.source:$('translation-source').value,target=subscriptionTranslating&&subscriptionScope.key===doc.key?plan.target:$('translation-target').value,requests=plan.requests??plan.windows.length,transmissions=plan.transmissions??plan.windows.reduce((count,window)=>count+window.snapshot.length,0);
   const name=subscriptionTranslating&&subscriptionScope.key===doc.key?(plan.provider==='codex'?'ChatGPT/Codex':'Claude'):providerName;
   $('subscription-translation-scope').textContent=`${name} · ${languageNames[source]||'请选择原文语言'} → ${languageNames[target]||''}。当前筛选 ${plan.selected} 段：待翻译 ${plan.total} 段，计划 ${requests} 次请求；涉及 ${plan.sent} 段不同原文，累计发送 ${transmissions} 段次（含重复上下文）。`;
   planCounts('subscription-translation-scope',plan.selected,requests,plan.sent);$('subscription-translation-scope').dataset.transmissionCount=String(transmissions);
   $('subscription-translate').textContent=subscriptionTranslating?'正在翻译…':plan.total?`翻译这 ${plan.total} 段`:'当前筛选已译完';
   if(!plan.total||!source||source===target)$('subscription-translate').disabled=true;
   $('ai-send-description').textContent='按句末、说话人和停顿分批。发送所选原文及说话人标签、匹配术语和已有译文建议；已译的所选片段可能重复发送作上下文。旧译文只是未核对的建议。不发送筛选外原文、阅读笔记或音视频。修改筛选会停止后续批次；中断后需重新确认。';
  }catch(error){$('subscription-translation-scope').textContent=error.message;planCounts('subscription-translation-scope',matches.length,0,0);$('subscription-translation-scope').dataset.transmissionCount='0';$('subscription-translate').disabled=true;$('subscription-translate').textContent='翻译原文';$('ai-send-description').textContent='请先完善翻译语言与原文范围。';}
 }else if(questionSelected){
  $('question-scope').textContent=`${$('ai-filtered').checked?'当前筛选':'整篇原文'} ${sources.length.toLocaleString('en-US')} 段 · ${questionCharacters.toLocaleString('en-US')} 字符 · ${languageNames[$('translation-target').value]}回答。${questionBlocked?'当前不可发送':'共 1 次模型请求'}。`;
  planCounts('question-scope',sources.length,questionBlocked?0:1);
  $('ai-send-description').textContent='发送你的问题和上述范围内的原文。筛选可匹配译文、摘录与笔记，但只发送对应原文，不发送阅读笔记、已有译文或音视频。回答会保存在这篇文字稿中，并保留原文引用。';
 }
 const sentData=summarySelected?(summaryReadiness?.plan?.chunks.length>1?'上述全文，以及汇总所需的分批笔记与引用':'上述全文'):translationSelected?'上述原文、说话人标签、匹配术语与已有译文建议':'问题和上述原文';
 $('ai-consent-copy').textContent=`同意将${sentData}发送给 ${providerName}，按上述请求次数使用我的订阅额度。`;

 renderAIHistory(doc);
}
const AI_HISTORY_PAGE_SIZE=10;
let aiHistoryDocument=null,aiHistoryCount=0,aiHistoryPage=0;
function renderAIHistory(doc){
 const answers=doc.ai_answers||[],total=answers.length;
 if(aiHistoryDocument!==doc||aiHistoryCount!==total){aiHistoryDocument=doc;aiHistoryCount=total;aiHistoryPage=0;}
 const pages=Math.max(1,Math.ceil(total/AI_HISTORY_PAGE_SIZE));
 aiHistoryPage=Math.max(0,Math.min(aiHistoryPage,pages-1));
 const start=aiHistoryPage*AI_HISTORY_PAGE_SIZE,end=Math.min(total,start+AI_HISTORY_PAGE_SIZE);
 const saved=Math.min(total,persistedAIAnswerCounts.get(doc)||0);
 $('ai-history-status').textContent=total?`共 ${total} 则 · 第 ${aiHistoryPage+1} / ${pages} 页 · 最新在前，每页最多 ${AI_HISTORY_PAGE_SIZE} 则`:'还没有 AI 阅读记录。只有确认发送原文后才会请求模型。';
 renderAIHistoryPersistence(doc);
 $('export-ai-reading').disabled=!total;$('export-ai-history-json').disabled=!total;
 $('ai-history-pages').hidden=pages<=1;
 $('ai-history-latest').disabled=$('ai-history-newer').disabled=aiHistoryPage===0;
 $('ai-history-oldest').disabled=$('ai-history-older').disabled=aiHistoryPage===pages-1;
 const host=$('ai-answers');host.replaceChildren();
 // Only inspect/render the visible records, without reversing/copying the full history.
 const segments=new Map(doc.segments.map(cue=>[cue.id,cue]));
 for(let offset=start;offset<end;offset++){
  const index=total-1-offset,answer=answers[index],section=el('section','ai-answer');
  section.dataset.answerNumber=String(index+1);
  const freshness=answer.purpose==='summary'?Coconut.summaryFreshness(answer,doc):Coconut.answerFreshness(answer,doc);
  section.append(el('h4','ai-answer-heading',`第 ${index+1} 则 · ${answer.purpose==='summary'?'整篇摘要':'问答'} · ${answer.provider||'unknown'}`));
  const status=el('p','hint ai-answer-storage','仅在此页，尚未保存到浏览器；请先导出备份。');status.hidden=storageBlocked||index<saved;section.append(status);
  if(freshness==='stale')section.append(el('p','hint','本次发送的原文或全文范围已变化，此回答依据可能过期，请核对历史原文或重新提问。'));
  if(freshness==='unknown')section.append(el('p','hint','此回答缺少完整的发送原文记录，无法确认依据是否仍有效，请核对或重新提问。'));
  if(freshness==='current')section.append(el('p','hint','发送原文仍与当前稿一致，AI 判断仍需核对。'));
  section.append(el('strong','',answer.question),el('p','',answer.answer));
  for(const id of [...new Set(answer.citations)]){
   const segment=segments.get(id);
   if(!segment){
    const historical=answer.input_snapshot?.segments.some(cue=>cue.id===id);
    section.append(el('p','hint','原片段已不存在：'+id+'。'+(historical?'可在导出记录中核对当时发送的原文。':'原记录未提供该片段的历史原文。')));continue;
   }
   const button=el('button','',Coconut.time(segment.start)+' · 原文');button.onclick=()=>goToSegment(id);section.append(button);
  }
  if(!answer.citations.length)section.append(el('p','hint','回答未提供片段引用，请回听核对。'));
  host.append(section);
 }
}
// Receipt notifications update persistence labels in place. They never rebuild
// answer rows or touch an input, current history page, selection or focus.
function renderAIHistoryPersistence(doc=active()){
 if(!doc)return;
 const total=(doc.ai_answers||[]).length,saved=Math.min(total,persistedAIAnswerCounts.get(doc)||0),unsaved=total-saved;
 $('ai-history-storage').textContent=!total?'':storageBlocked?'浏览器自动保存已暂停，无法确认当前持久记录。请导出全部历史或本篇 JSON，暂时不要关闭或刷新。':unsaved?`已保存 ${saved} 则 · ${unsaved} 则仅在此页，尚未保存到浏览器。请立即导出全部历史或本篇 JSON，暂时不要关闭或刷新。`:`${total} 则均已保存在此浏览器。历史不会自动删除，建议定期导出 JSON 备份。`;
 $('ai-history-storage').dataset.state=storageBlocked||unsaved?'unsaved':'saved';
 for(const node of $('ai-answers').querySelectorAll('.ai-answer-storage'))node.hidden=storageBlocked||Number(node.parentElement.dataset.answerNumber)<=saved;
}
window.addEventListener('coconut-persistence-change',()=>renderAIHistoryPersistence());
function turnAIHistory(page){
 const doc=active();if(!doc)return;
 aiHistoryPage=page;renderAIHistory(doc);
 $('ai-history-heading').focus();$('ai-history-heading').scrollIntoView?.({block:'start'});
}
$('ai-history-latest').onclick=()=>turnAIHistory(0);
$('ai-history-newer').onclick=()=>turnAIHistory(aiHistoryPage-1);
$('ai-history-older').onclick=()=>turnAIHistory(aiHistoryPage+1);
$('ai-history-oldest').onclick=()=>turnAIHistory(Math.ceil((active()?.ai_answers?.length||0)/AI_HISTORY_PAGE_SIZE)-1);
$('browse-ai-history').onclick=()=>{
 if(!active()?.ai_answers?.length)return;
 closeSummaryRequest(false);setReadingMode('transcript');
 if(!$('toggle-demo-tools').hidden&&$('toggle-demo-tools').getAttribute('aria-expanded')!=='true')$('toggle-demo-tools').click();
 $('language-panel').open=true;renderAIHistory(active());
 $('ai-history-heading').focus();$('ai-history-heading').scrollIntoView?.({block:'start'});
};
$('export-ai-history-json').onclick=()=>$('export').onclick();

async function checkLanguageTools(){
 const checkButton=$('check-ai');if(!checkButton)return;const sequence=++languageCheckSequence;checkButton.disabled=true;
 try{const status=await languageApi('language-tools');if(!checkButton.isConnected||sequence!==languageCheckSequence)return;languageReady=status.local_translation!==false;aiStatuses=status.ai||{};aiReady=aiStatuses[$('ai-provider').value]?.ready===true;$('ai-status').textContent=aiStatuses[$('ai-provider').value]?.reason||'认证状态未知';languageAvailability(languageReady?'离线模型只提供逐段粗稿，不能理解跨段指代；上下文翻译请使用已连接的本地 CLI。未安装模型仍需你允许下载。':'桌面版不安装重型离线翻译模型；可连接本地 CLI 使用已有订阅做上下文翻译。不会自动发送文字或切换付费 API。');}
 catch{if(!checkButton.isConnected||sequence!==languageCheckSequence)return;languageReady=false;aiReady=false;$('ai-status').textContent='未连接本地处理服务。公开页面不会替你调用订阅账户，请在本机启动 Coconut。';}
 finally{if(sequence===languageCheckSequence){checkButton.disabled=false;renderLanguage();}}
}
$('check-ai').onclick=checkLanguageTools;
$('ai-filtered').onchange=()=>{
 $('ai-consent').checked=false;
 if(subscriptionTranslating){stopSubscription=true;aiProgress(subscriptionScope?.key,'读取范围已变化，当前订阅批次结束后停止；重新开始前需再次确认范围与额度。');}
 renderLanguage();
};
$('ai-provider').onchange=()=>{if(summaryScope)summaryScope.stop=true;if(subscriptionTranslating)stopSubscription=true;aiReady=aiStatuses[$('ai-provider').value]?.ready===true;$('ai-status').textContent=aiStatuses[$('ai-provider').value]?.reason||'请检查本机订阅连接';$('ai-consent').checked=false;renderLanguage();};
$('language-setup').onclick=()=>{showWorkspace('add');$('local-setup').open=true;$('local-setup').scrollIntoView({behavior:'smooth'});$('local-setup').querySelector('summary').focus();};
window.addEventListener('coconut-worker-ready',()=>{
 $('language-prerequisite').textContent='本地连接已就绪。CLI 功能需要官方工具已安装并登录；确认所选文字、匹配术语和已有译文建议及额度后才会发出请求。';
 $('language-setup').hidden=true;
 $('check-ai').disabled=false;
 $('ai-status').textContent='点击「检查本地 CLI 连接」后才会检测已安装工具和订阅登录。打开页面不会启动 CLI 或发送原文。';
 renderLanguage();
});
window.addEventListener('coconut-worker-disconnected',()=>{
 if(summaryScope)summaryScope.stop=true;languageCheckSequence++;$('check-ai').disabled=true;
 $('language-prerequisite').textContent='本地服务未连接：先启动 Coconut 并打开本地地址，再检查已登录的官方 CLI；已有译文与笔记仍可阅读。';
 $('language-setup').hidden=false;
 languageReady=false;aiReady=false;aiStatuses={};stopTranslation=true;stopSubscription=true;
 $('ai-consent').checked=false;
 $('ai-status').textContent='本地服务已断开。连接恢复后重新检查订阅；不会自动重新发送文字。';
 languageAvailability('本地服务未连接；已有译文仍可阅读与备份。');
 renderLanguage();
});
window.addEventListener('coconut-render',renderLanguage);
// Note input saves in place without a full reader render. Check scope after its
// existing input handler has updated the document. Idle plans and consent must
// also follow note-dependent matches before the reader can submit a new request.
$('note').addEventListener('input',()=>{queueMicrotask(()=>renderLanguage());});
for(const id of ['translation-source','translation-target'])$(id).onchange=()=>{stopLanguageBatches();renderLanguage();};
if($('ai-task'))$('ai-task').onchange=()=>{stopLanguageBatches();$('ai-send-details').open=false;renderLanguage();};
$('ai-question').oninput=()=>{$('ai-consent').checked=false;renderLanguage();};
if($('translation-glossary'))$('translation-glossary').oninput=()=>{if(glossaryDirty())glossaryDrafts.set(glossaryDocumentSignature,$('translation-glossary').value);else glossaryDrafts.delete(glossaryDocumentSignature);$('ai-consent').checked=false;if(subscriptionTranslating)stopSubscription=true;};
if($('save-translation-glossary'))$('save-translation-glossary').onclick=async()=>{
 const doc=active();if(!doc||!contentIngressAllowed(doc))return;
 const target=$('translation-target').value,signature=glossaryDocumentSignature,submitted=$('translation-glossary').value,owner={};
 try{
  const entries=submitted.split(/\r?\n/).filter(line=>line.trim()).map(line=>{if(line.trim().startsWith('"')){const match=line.trim().match(/^("(?:[^"\\]|\\.)*")\s*=\s*(.+)$/);if(!match)throw new Error('带引号的术语请按「"原词" = "译法"」填写');return {source:JSON.parse(match[1]),target:match[2].startsWith('"')?JSON.parse(match[2]):match[2].trim()};}const index=line.indexOf('=');if(index<1)throw new Error('请按每行「原词 = 统一译法」填写');return {source:line.slice(0,index).trim(),target:line.slice(index+1).trim()};});
  const terms=Coconut.cleanGlossary(entries,true);doc.translation_glossary||=Object.create(null);doc.translation_glossary[target]=terms;
  glossarySubmissions.set(signature,owner);glossaryDrafts.delete(signature);$('translation-glossary').value=savedGlossaryText(doc,target);
  $('ai-consent').checked=false;if(subscriptionTranslating)stopSubscription=true;
  const pending=commitDocument(doc);render();const receipt=await pending;
  if(!doc||!contentIngressAllowed(doc)||active()!==doc||glossaryDocumentSignature!==signature||glossarySubmissions.get(signature)!==owner||doc.translation_glossary[target]!==terms||glossaryDirty())return;
  notice(receipt.ok?'本篇术语表已保存；受影响的译文需重新生成':'术语表暂留本页，保存失败，请立即备份');
 }catch(error){if(active()===doc&&glossaryDocumentSignature===signature)notice(error.message);}
};
$('translation-view').onchange=()=>{const doc=active();if(doc&&contentIngressAllowed(doc)){const target=$('translation-view').value;if(doc.translation_view!==target){doc.translation_view=target;queueDocument(doc);}render();}};
$('stop-translation').onclick=()=>{stopTranslation=true;translationProgress(offlineTranslationKey,'正在完成当前批次；已完成译文会保留，下次可以继续。');};
$('translate-document').onclick=async()=>{
 if($('ai-task').value!=='translation'){notice('请先选择翻译原文');return;}
 const doc=active(),source=$('translation-source').value,target=$('translation-target').value;
 if(!doc||!contentIngressAllowed(doc))return;
 if(!doc?.segments.length||doc.project_kind==='audio_only'){notice('还没有文字稿，不能翻译');return;}
 if(asking||translating||subscriptionTranslating){notice('已有 AI 阅读或翻译正在运行，请先停止或等待完成');return;}
 if(!doc||!source||source===target){notice('请选择不同的原文和翻译语言');return;}
 if(!languageReady){notice('当前连接不提供离线模型；请使用本地 CLI 上下文翻译');return;}
 const documentLanguage=doc.language||'';const key=doc.key;const pending=doc.segments.filter(s=>!(Coconut.translationCurrent(s,doc,s.translations?.[target])&&(s.translations[target].manual_review||s.translations[target].source_language===source)));
 if(!pending.length){doc.translation_view=target;queueDocument(doc);render();return;}
 const confirmedSource=doc.segments.map((cue,position)=>({id:cue.id,text:cue.text,start:cue.start,end:cue.end,speaker:cue.speaker||null,position}));
 const watchSurface=translationSurfaceOpen(),owner={doc,key,source,target,retired:false};offlineTranslationScope=owner;
 offlineTranslationKey=key;translating=true;stopTranslation=false;$('stop-translation').hidden=false;renderLanguage();let completed=0;
 try{
  for(let index=0;index<pending.length&&!stopTranslation;index+=32){
   if(offlineTranslationScope!==owner||!languageOwnerLive(owner))return;
   if(active()!==doc||(doc.language||'')!==documentLanguage||$('translation-source').value!==source||$('translation-target').value!==target){stopTranslation=true;break;}
   if(!Coconut.sameCueSnapshot(doc,confirmedSource)||doc.segments.length!==confirmedSource.length)throw new Error('原文已修改，后续请求已停止；请按新原文重新翻译');
   if(watchSurface&&!translationSurfaceOpen()){stopTranslation=true;break;}
   const batch=pending.slice(index,index+32).map(s=>({id:s.id,text:s.text}));
   if(pending.slice(index,index+32).some(s=>s.translations?.[target]?.manual_review&&Coconut.translationCurrent(s,doc,s.translations[target])))throw new Error('本批已有新的人工核对译文，未发送请求；请重新确认剩余范围');
   const targetVersions=new Map(batch.map(c=>[c.id,doc.segments.find(s=>s.id===c.id)?.translations?.[target]]));
   translationProgress(key,`本机翻译中：${completed}/${pending.length} 段；可以停止后续批次，已完成内容会保存。`);
   const result=await languageApi('translate',{source,target,segments:batch,allow_download:$('download-model').checked});
   if(!Array.isArray(result.translations)||result.translations.length!==batch.length||new Set(result.translations.map(t=>t.id)).size!==batch.length)throw new Error('翻译批次不完整，未覆盖原文');
   const destination=state.documents.find(d=>d.key===key);if(destination!==doc||!languageOwnerLive(owner))throw new Error('原文字稿已移除或更换，本次结果未保存');
   if(batch.some(c=>destination.segments.find(s=>s.id===c.id)?.translations?.[target]!==targetVersions.get(c.id)))throw new Error('本批译文已被人工修正或替换，返回结果未覆盖，后续请求已停止');
   for(const item of result.translations){const original=batch.find(s=>s.id===item.id);const segment=destination.segments.find(s=>s.id===item.id);if(!original||!segment||item.source_text!==original.text||typeof item.text!=='string'||!item.text.trim())throw new Error('翻译片段对应关系无效');}
   for(const item of result.translations){const segment=destination.segments.find(s=>s.id===item.id);if(segment.text!==item.source_text)continue;segment.translations||={};segment.translations[target]={text:item.text,source_text:item.source_text,source_language:source,document_language:documentLanguage,provider:item.provider};completed++;}
   destination.translation_view=target;const pendingSave=commitDocument(destination);if(active()===doc)render();
   const receipt=await pendingSave;if(offlineTranslationScope!==owner||!languageOwnerLive(owner))return;
   if(!receipt.ok)throw new Error('本批译文暂留在此页面，浏览器保存未成功，请立即导出备份；后续请求已停止');
  }
  if(offlineTranslationScope!==owner||!languageOwnerLive(owner))return;
  translationProgress(key,`${stopTranslation?'已停止后续批次':'本次翻译完成'}：保存 ${completed} 段离线粗稿。逐段模型不能保证上下文一致，请核对技术术语；原稿、时间戳与已有笔记均保留。`);
 }catch(error){if(offlineTranslationScope===owner&&languageOwnerLive(owner))translationProgress(key,'翻译暂停：'+error.message+'。已完成译文保留，可重试继续。');}
 finally{if(offlineTranslationScope===owner){translating=false;offlineTranslationScope=null;offlineTranslationKey=null;$('ai-consent').checked=false;$('stop-translation').hidden=true;renderLanguage();}}
};
window.addEventListener('pagehide',stopLanguageBatches);
window.addEventListener('coconut-document-retiring',event=>{
 const {key,bundle}=event.detail||{};if(!bundle)return;
 retireLanguageOwners(key);
 const drafts=new Map();
 for(const signature of glossarySubmissions.keys())if(JSON.parse(signature)[0]===key)glossarySubmissions.delete(signature);
 if(glossaryDocumentSignature&&JSON.parse(glossaryDocumentSignature)[0]===key&&glossaryDirty())glossaryDrafts.set(glossaryDocumentSignature,$('translation-glossary').value);
 for(const [signature,value] of glossaryDrafts)if(JSON.parse(signature)[0]===key){drafts.set(signature,value);glossaryDrafts.delete(signature);}
 bundle.glossaryDrafts=drafts;
 if(glossaryDocumentSignature&&JSON.parse(glossaryDocumentSignature)[0]===key){glossaryDocumentSignature='';$('translation-glossary').value='';}
});
window.addEventListener('coconut-document-restored',event=>{
 for(const [signature,value] of event.detail?.glossaryDrafts||[])if(JSON.parse(signature)[0]===event.detail.key)glossaryDrafts.set(signature,value);
});
window.addEventListener('coconut-summary-stop',()=>{if(summaryScope)summaryScope.stop=true;if(readingMode==='summary')stopLanguageBatches();});
window.addEventListener('coconut-workspace-change',event=>{if(event.detail?.workspace!=='read')stopLanguageBatches();});
// Native details toggle events are queued. Latch real closing clicks before a
// same-turn response or a quick reopen can admit another batch.
$('language-panel').querySelector('summary').addEventListener('click',()=>{if($('language-panel').open)stopLanguageBatches();});
$('toggle-demo-tools').addEventListener('click',()=>{if($('toggle-demo-tools').getAttribute('aria-expanded')==='true')stopLanguageBatches();},{capture:true});
$('language-panel').addEventListener('toggle',()=>{if(!$('language-panel').open&&$('summary-request').hidden)stopLanguageBatches();});
$('ai-consent').onchange=()=>{if(!$('ai-consent').checked)stopLanguageBatches();};
$('stop-summary').onclick=()=>{if(summaryScope)summaryScope.stop=true;$('ai-consent').checked=false;aiProgress(summaryScope?.key,'当前摘要批次完成后停止；已保存的分批笔记保留，尚不代表整篇摘要。');};
$('restart-summary').onclick=async()=>{const doc=active();if(!doc||!contentIngressAllowed(doc)||summaryScope||asking)return;doc.summary_job=null;$('ai-consent').checked=false;const pending=commitDocument(doc);renderLanguage();const receipt=await pending;if(contentIngressAllowed(doc)&&active()===doc&&doc.summary_job===null&&!summaryScope&&!asking&&!receipt.ok)notice('清除进度未保存，请备份当前文档');};
async function runDocumentSummary(doc){
 if(!doc||!contentIngressAllowed(doc)||asking||summaryScope)return;
 const readiness=Coconut.summaryReadiness(doc);if(!readiness.ready){notice(readiness.reason);return;}
 const plan=readiness.plan,provider=$('ai-provider').value,key=doc.key,watchSurface=!$('summary-request').hidden?'summary':translationSurfaceOpen()?'language':null;
 if(doc.summary_job&&(!CoconutSummary.current(doc.summary_job,doc)||doc.summary_job.provider!==provider)){notice('原文或提供商已改变，请先放弃旧分批进度');$('ai-consent').checked=false;return;}
 if(!aiReady){notice('请先检查本地 CLI 连接');return;}
 const job=doc.summary_job||CoconutSummary.create(plan,provider),owner={doc,key,provider,stop:false,retired:false,language:doc.language};
 // Reserve the owner before the first persistence await. A repeated click
 // cannot start another plan while its first checkpoint is still pending.
 summaryScope=owner;asking=true;doc.summary_job=job;
 const current=()=>summaryScope===owner&&languageOwnerLive(owner);
 const sourceCurrent=()=>current()&&doc.summary_job===job&&CoconutSummary.current(job,doc);
 const surfaceCurrent=()=>watchSurface==='summary'?!$('summary-request').hidden:watchSurface==='language'?translationSurfaceOpen():true;
 const mayRequest=()=>sourceCurrent()&&surfaceCurrent()&&!owner.stop&&active()===doc&&doc.language===owner.language&&$('ai-task').value==='summary'&&$('ai-provider').value===provider&&$('ai-consent').checked&&aiReady;
 let finalAnswer=null,checkpointFailed=false;
 const checkpoint=async message=>{const receipt=await commitDocument(doc);if(!receipt.ok){checkpointFailed=true;throw new Error(message);}return receipt;};
 try{
  renderLanguage();
  await checkpoint('摘要计划尚未保存，未发送请求。请先备份并解决浏览器保存问题');
  if(!sourceCurrent())return;
  while(job.results.length<plan.chunks.length||plan.chunks.length>1){
   if(!mayRequest())break;
   const index=job.results.length;
   job.status='running';job.in_flight=index;
   await checkpoint('请求前保存未成功，本次尚未发送；请导出备份');
   if(!sourceCurrent())return;
   if(!mayRequest())break;
   const request=CoconutSummary.request(plan,job);
   aiProgress(key,index<plan.chunks.length?`正在整理第 ${index+1}/${plan.chunks.length} 批原文；整篇摘要尚未完成。`:'所有原文批次已保存，正在汇总；汇总成功前不产生整篇摘要。');
   const response=await languageApi('ask',request);
   if(!sourceCurrent())throw new Error('请求期间原文已修改，本批结果未保存；旧进度仅供恢复，不能生成当前整篇摘要');
   finalAnswer=CoconutSummary.accept(plan,job,response);
   if(finalAnswer){
    doc.ai_answers||=[];doc.ai_answers.push(finalAnswer);doc.summary_job=null;
    await checkpoint('最终摘要仅在此页，保存失败；请立即导出摘要或 JSON 备份');
    // The final checkpoint intentionally clears summary_job. Validate its exact
    // answer and source instead of requiring the now-finished job to survive.
    if(!current()||!doc.ai_answers.includes(finalAnswer)||Coconut.summaryFreshness(finalAnswer,doc)!=='current')return;
    aiProgress(key,'整篇摘要已保存，点击引用可以继续读原文、核对关键观点。');
    if(active()===doc)window.dispatchEvent(new Event('coconut-summary-updated'));break;
   }
   job.status='paused';
   await checkpoint('本批结果仅在此页，保存失败，后续请求已停止；请立即导出 JSON 备份');
   if(!sourceCurrent())return;
   if(active()===doc)renderLanguage();
  }
  if(!finalAnswer&&sourceCurrent()){
   job.status='paused';job.in_flight=null;const completed=job.results.length;
   await checkpoint('已停止，但暂停状态未保存，请立即备份');
   if(sourceCurrent())aiProgress(key,`已停止后续请求，保存 ${completed}/${plan.chunks.length} 批。还没有完整摘要；下次需重新确认发送与额度后继续。`);
  }
 }catch(error){
  if(!current())return;
  if(!finalAnswer&&!checkpointFailed&&sourceCurrent()){
   job.status=job.in_flight===null?'failed':'interrupted';
   await commitDocument(doc);
   if(!current())return;
  }
  aiProgress(key,finalAnswer?'整篇摘要已生成，但尚未保存到浏览器：'+error.message+'。请先导出备份，勿关闭页面。':'整篇摘要未完成：'+error.message+'。不会自动重试；已保存的分批进度可在再次确认后继续。');
 }finally{if(summaryScope===owner){summaryScope=null;asking=false;$('ai-consent').checked=false;renderLanguage();if(active()===doc&&typeof renderSummary==='function')renderSummary();}}
}
$('ask-ai').onclick=async()=>{
 if(!['question','summary'].includes($('ai-task').value)){notice('请先选择提问或整篇摘要');return;}
 const doc=active();if(!doc||!contentIngressAllowed(doc)||asking||subscriptionTranslating||translating)return;
 if(!doc.segments.length||doc.project_kind==='audio_only'){notice('还没有文字稿，不能发送 AI 请求');return;}
 const purpose=$('ai-task')?.value==='summary'?'summary':'question';
 if(purpose==='summary'){
  const readiness=Coconut.summaryReadiness(doc);
  if(!readiness.ready){$('ai-consent').checked=false;renderLanguage();aiProgress(doc.key,readiness.reason);notice(readiness.reason);return;}
 }
 if(!$('ai-consent').checked){notice('请先确认本次把所选文字发送给所选提供商并使用订阅额度');return;}
 if(purpose==='summary'){await runDocumentSummary(doc);return;}
 if(!aiReady){notice('请先检查本地 CLI 连接');return;}
 const question=purpose==='summary'?Coconut.SUMMARY_QUESTION:$('ai-question').value.trim();if(!question){notice('请先输入问题');return;}
 const segments=questionSources(doc);
 if(!segments.length){notice('当前筛选没有可发送的原文');return;}
 if(segments.length>5000||question.length>4000||JSON.stringify({question,answer_language:$('translation-target').value,transcript:segments}).length>250000){notice('问题或原文超过单次范围，请缩短问题或筛选较小范围');return;}
 const key=doc.key,owner={doc,key,retired:false};questionScope=owner;questionKey=key;asking=true;renderLanguage();aiProgress(key,`正在让所选 AI 阅读 ${segments.length} 段；不会切换到付费 API。`);
 try{
  const answer=await languageApi('ask',{question,language:purpose==='summary'?'zh':$('translation-target').value,provider:$('ai-provider').value,segments,consent:true});
  const destination=state.documents.find(d=>d.key===key);if(destination!==doc||questionScope!==owner||!languageOwnerLive(owner))throw new Error('原文字稿已移除或更换，本次结果未保存');
  if(Coconut.answerFreshness({purpose,input_snapshot:{version:1,segments}},destination)!=='current'||purpose==='summary'&&destination.segments.length!==segments.length)throw new Error('请求期间原文已修改，请按新原文重新提问');
  if(typeof answer.answer!=='string'||!Array.isArray(answer.citations)||answer.citations.some(id=>!segments.some(s=>s.id===id)))throw new Error('回答引用无效');
  destination.ai_answers||=[];const savedAnswer={...answer,question,purpose,input_snapshot:{version:1,segments}};destination.ai_answers.push(savedAnswer);
  const receipt=await commitDocument(destination);
  if(questionScope!==owner||!languageOwnerLive(owner)||!doc.ai_answers.includes(savedAnswer)||Coconut.answerFreshness(savedAnswer,doc)!=='current')return;
  if(active()===doc&&typeof renderSummary==='function')renderSummary();
  aiProgress(key,receipt.ok?'回答已保存在这份文字稿中，可点击引用返回原文；AI 判断仍需核对。':'回答暂留在当前页，浏览器保存未成功；请先导出备份，勿关闭页面。');
 }catch(error){if(questionScope===owner&&languageOwnerLive(owner))aiProgress(key,'AI 阅读未完成：'+error.message);}
 finally{if(questionScope===owner){asking=false;questionScope=null;questionKey=null;$('ai-consent').checked=false;renderLanguage();}}
};
renderLanguage();

$('stop-subscription-translation').onclick=()=>{stopSubscription=true;aiProgress(subscriptionScope?.key,'当前订阅批次结束后停止；已完成内容保留。');};
$('subscription-translate').onclick=async()=>{
 if($('ai-task').value!=='translation'){notice('请先选择翻译原文，再确认发送范围');return;}
 const doc=active(),source=$('translation-source').value,target=$('translation-target').value,provider=$('ai-provider').value;
 if(!doc||!contentIngressAllowed(doc)||subscriptionTranslating||asking||translating)return;
 if(!aiReady){notice('请先检查本地 CLI 连接');return;}
 if(!doc.segments.length||doc.project_kind==='audio_only'){notice('还没有文字稿，不能翻译');return;}
 if(!$('ai-consent').checked){notice('请先确认本次把筛选片段发送给所选AI，并消耗所显示批次的订阅额度');return;}
 if(!source||source===target){notice('请选择不同的原文和翻译语言');return;}
 if(glossaryDirty()){notice('术语表有未保存修改，请先保存本篇术语表，再确认翻译');return;}
 const providerName=(provider==='codex'?'chatgpt':'claude')+'_subscription_translation';
 const selectedCues=doc.segments.filter(s=>matchesReadingSegment(s,doc,$('search').value));
 let plan;
 try{plan=Coconut.subscriptionPlan(doc,selectedCues.map(s=>s.id),source,target,providerName);}catch(error){notice(error.message);return;}
 if(!plan.total){notice('当前筛选没有需要订阅翻译的新片段');return;}
 const positions=new Map(doc.segments.map((cue,index)=>[cue,index]));
 const documentLanguage=doc.language||'',confirmedSource=selectedCues.map(cue=>({id:cue.id,text:cue.text,start:cue.start,end:cue.end,speaker:cue.speaker||null,position:positions.get(cue)}));const key=doc.key,watchSurface=translationSurfaceOpen();const owner=subscriptionScope={doc,key,retired:false,visibleIds:selectedCues.map(cue=>cue.id),readingControls:subscriptionReadingControls(),total:plan.total,selected:plan.selected,sent:plan.sent,transmissions:plan.windows.reduce((count,window)=>count+window.snapshot.length,0),requests:plan.windows.length,source,target,provider};subscriptionTranslating=true;stopSubscription=false;$('stop-subscription-translation').hidden=false;renderLanguage();let completed=0;
 try{
  for(const window of plan.windows){
   if(subscriptionScope!==owner||!languageOwnerLive(owner))return;
   if(active()!==doc||(doc.language||'')!==documentLanguage||$('ai-task').value!=='translation'||$('ai-provider').value!==provider||$('translation-source').value!==source||$('translation-target').value!==target||!aiReady)stopSubscription=true;
   checkSubscriptionReadingScope();
   if(watchSurface&&!translationSurfaceOpen())stopSubscription=true;
   if(stopSubscription||!$('ai-consent').checked)break;
   if(!Coconut.sameCueSnapshot(doc,confirmedSource))throw new Error('原文或所选上下文已修改，未发出本批模型请求，请重新开始');
   const batch=window.segments;const before=state.documents.find(d=>d.key===key);
   if(before!==doc||!Coconut.sameCueSnapshot(before,window.snapshot)||JSON.stringify(Coconut.relevantGlossary(before,target,window.snapshot))!==JSON.stringify(window.glossary))throw new Error('原文或所选上下文已修改，未发出本批模型请求，请重新开始');
   if(batch.some(c=>{const s=before.segments.find(s=>s.id===c.id);return s?.translations?.[target]?.manual_review&&Coconut.translationCurrent(s,before,s.translations[target]);}))throw new Error('本批已有新的人工核对译文，未发送请求；请重新确认剩余范围');
   const targetVersions=new Map(batch.map(c=>[c.id,before.segments.find(s=>s.id===c.id)?.translations?.[target]]));
   aiProgress(key,`订阅翻译中：${completed}/${plan.total} 段；上下文仅来自确认的筛选，不购买额度，不回退到API。`);
   const result=await languageApi('translate-subscription',{source,target,provider,segments:batch,context:window.context,glossary:window.glossary,memory:window.memory,consent:true});
   if(!Array.isArray(result.translations)||result.translations.length!==batch.length||result.translations.some((t,i)=>t.id!==batch[i].id||t.source_text!==batch[i].text||typeof t.text!=='string'||!t.text.trim()||t.text.length>12000))throw new Error('订阅结果与目标片段未完整对应，本批不保存');
   const destination=state.documents.find(d=>d.key===key);if(destination!==doc||subscriptionScope!==owner||!languageOwnerLive(owner))throw new Error('原文字稿已移除或更换，本次结果未保存');
   if(batch.some(c=>destination.segments.find(s=>s.id===c.id)?.translations?.[target]!==targetVersions.get(c.id)))throw new Error('本批译文已被人工修正或替换，返回结果未覆盖，后续请求已停止');
   if(!Coconut.sameCueSnapshot(destination,window.snapshot)||JSON.stringify(Coconut.relevantGlossary(destination,target,window.snapshot))!==JSON.stringify(window.glossary))throw new Error('本批原文或上下文已修改，为避免错配，本批全部不保存');
   checkSubscriptionReadingScope();
   const contextId=crypto.randomUUID();destination.translation_contexts||=Object.create(null);destination.translation_contexts[contextId]=window.snapshot;
   for(const item of result.translations){const segment=destination.segments.find(s=>s.id===item.id);segment.translations||={};segment.translations[target]={text:item.text,source_text:item.source_text,source_language:source,document_language:documentLanguage,provider:providerName,context_id:contextId,context_version:2,target_language:target,glossary_snapshot:window.glossary,input_revision:item.input_revision,quality_warnings:Array.isArray(item.quality_warnings)?item.quality_warnings.filter(code=>Coconut.translationQualityMessage({quality_warnings:[code]})):[]};}
   destination.translation_contexts=Coconut.cleanContexts(destination.translation_contexts,destination.segments);
   destination.translation_view=target;
   // The confirmed request plan is immutable. Our own translated wording can
   // change search matches; adopt that display change without canceling targets
   // the user already approved. Any prior user scope change stays latched.
   if(active()===doc)owner.visibleIds=destination.segments.filter(cue=>matchesReadingSegment(cue,destination,$('search').value)).map(cue=>cue.id);
   completed+=batch.length;const pendingSave=commitDocument(destination);if(active()===doc)render();
   const receipt=await pendingSave;if(subscriptionScope!==owner||!languageOwnerLive(owner))return;
   if(!receipt.ok)throw new Error('本批译文暂留在此页面，浏览器保存未成功，请立即导出备份；后续请求已停止');
  }
  if(subscriptionScope!==owner||!languageOwnerLive(owner))return;
  aiProgress(key,`${completed<plan.total?'已停止后续批次':'本次订阅翻译完成'}：保存 ${completed} 段。${completed<plan.total?'再次确认后可继续剩余部分。':'可在双语对照中继续阅读，点击原文回听。'}`);

 }catch(error){if(subscriptionScope===owner&&languageOwnerLive(owner))aiProgress(key,'订阅翻译暂停：'+error.message+'。已完成结果仍在当前页；校验失败的批次不会覆盖旧译文。请检查保存提示并备份。');}
 finally{if(subscriptionScope===owner){subscriptionTranslating=false;subscriptionScope=null;$('ai-consent').checked=false;$('stop-subscription-translation').hidden=true;renderLanguage();}}
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

// One draft predicate is shared by Web unload and native desktop close. Bind
// after language state initializes because app.js can render before this file.
hasLanguageDrafts=()=>{
 for(const [signature,value] of glossaryDrafts){
  const [key,target]=JSON.parse(signature),doc=state.documents.find(item=>item.key===key);
  if(doc&&value!==savedGlossaryText(doc,target))return true;
 }
 const [key,target]=glossaryDocumentSignature?JSON.parse(glossaryDocumentSignature):[];
 const doc=state.documents.find(item=>item.key===key);
 if(doc&&$('translation-glossary').value!==savedGlossaryText(doc,target))return true;
 const question=$('ai-question').value.trim();
 return !!question&&!active()?.ai_answers?.some(answer=>answer.question===question);
};
$('cancel-translation-glossary').onclick=()=>{
 glossaryDrafts.delete(glossaryDocumentSignature);
 $('translation-glossary').value=savedGlossaryText(active(),$('translation-target').value);
 $('ai-consent').checked=false;$('translation-glossary').focus();
};
if(unloadGuardReady)syncUnsavedUnloadGuard();
