/* Exact quotation preview; persistence is owned by the receipt-bound application callback. */
(function(root){
 'use strict';
 const invalid='请只选择同一段原文中的连续文字，不包含译文、笔记或其他界面内容。';
 function boundary(text,offset){return Number.isSafeInteger(offset)&&offset>=0&&offset<=text.length&&!(offset>0&&offset<text.length&&/[\uD800-\uDBFF]/.test(text[offset-1])&&/[\uDC00-\uDFFF]/.test(text[offset]));}
 function compose(cues,separator){
  let text='';const spans=[];
  for(const cue of cues){if(spans.length)text+=separator(cues[spans.length-1].text,cue.text);const from=text.length;text+=cue.text;spans.push({cue,from,to:text.length});}
  return {text,spans};
 }
 function slice(model,from,to){
  if(!boundary(model.text,from)||!boundary(model.text,to)||to<=from||!model.text.slice(from,to).trim())throw Error(invalid);
  const parts=model.spans.filter(span=>Math.max(from,span.from)<Math.min(to,span.to)).map(span=>({cue:span.cue,from:Math.max(0,from-span.from),to:Math.min(span.cue.text.length,to-span.from)}));
  if(!parts.length)throw Error(invalid);
  if(/\r(?!\n)/.test(model.text.slice(from,to)))throw Error('所选原文含孤立 CR 换行，自动引用暂不支持。请选择不跨越该换行的文字，避免复制时改变原文。');
  return {text:model.text.slice(from,to),from,to,parts,start:parts[0].cue.start,end:Math.max(...parts.map(part=>part.cue.end))};
 }
 function domSelection(paragraph,model,selection){
  if(!selection||selection.rangeCount===0||selection.isCollapsed)return null;
  if(selection.rangeCount!==1||!paragraph.isConnected)throw Error(invalid);
  const range=selection.getRangeAt(0);
  if(!paragraph.contains(range.startContainer)||!paragraph.contains(range.endContainer)||paragraph.textContent!==model.text)throw Error(invalid);
  // Every child must be a known original cue or its exact display separator.
  const nodes=[...paragraph.childNodes];let at=0;
  for(const [index,span] of model.spans.entries()){
   if(index>0){const node=nodes.shift();if(node?.nodeType!==3||node.textContent!==model.text.slice(at,span.from))throw Error(invalid);}
   const node=nodes.shift();if(node?.nodeType!==1||!node.classList.contains('passage-cue')||node.dataset.cueId!==span.cue.id||node.textContent!==span.cue.text||node.children.length)throw Error(invalid);
   at=span.to;
  }
  if(nodes.length)throw Error(invalid);
  const before=paragraph.ownerDocument.createRange();before.selectNodeContents(paragraph);before.setEnd(range.startContainer,range.startOffset);const from=before.toString().length;
  before.setEnd(range.endContainer,range.endOffset);const to=before.toString().length;
  const result=slice(model,from,to);if(result.text!==range.toString())throw Error(invalid);return result;
 }
 function inputOffset(text,offset){
  let normalized=0,index=0;while(index<text.length&&normalized<offset){if(text[index]==='\r'&&text[index+1]==='\n')index++;index++;normalized++;}
  if(normalized!==offset)throw Error(invalid);return index;
 }
 function stamp(seconds){const ms=Math.round(seconds*1000),hours=Math.floor(ms/3600000),minutes=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;return [hours,minutes,s].map(n=>String(n).padStart(2,'0')).join(':')+'.'+String(ms%1000).padStart(3,'0');}
 function attributionDetails(doc,quote,core){
  const label=value=>String(value??'').replace(/\r/g,'\\r').replace(/\n/g,'\\n');
  const demo=doc.provenance?.kind==='authored_demo';
  const timed=demo?'':core.source(doc.source_url,quote.start);
  const origin=demo?'':doc.podcast_source?(core.podcastURL(doc.source_url)||core.podcastURL(doc.podcast_source.feed_url)||(doc.podcast_source.kind==='direct_media'?core.podcastURL(doc.podcast_source.media_url):'')):'';
  const location=demo?'自写演示内容（无对应音视频）':timed?'来源：'+timed:origin?'来源：'+origin+'（按时间手动定位）':doc.local_media_source||doc.source_media?'本地原始媒体（无原站链接，请按文字稿时间定位）':'未关联原站链接或媒体（仅文字稿时间定位）';
  const corrected=quote.parts.some(({cue})=>cue.original_text!==undefined&&cue.original_text!==cue.text);
  return {title:label(doc.title),range:stamp(quote.start)+'–'+stamp(quote.end),corrected,location};
 }
 function attribution(doc,quote,core){
  const details=attributionDetails(doc,quote,core);
  return quote.text+'\n\n—— '+details.title+' · '+details.range+(details.corrected?' · 已修正文字稿':'')+'\n'+details.location;
 }
 // Saved excerpts own their evidence. Never accept a live document here: title,
 // links, original words and bilingual provenance must all come from the capture.
 function savedAttribution(record,core){
  const parts=core.exactExcerptParts(record),quote={text:record.text,parts,start:parts[0].cue.start,end:Math.max(...parts.map(part=>part.cue.end))};
  let text=attribution(core.exactExcerptSource(record),quote,core)+'\n选取时快照 · 摘录时间：'+record.created_at+'\n时间按文字稿片段定位，并非逐字时间。';
  const paired=core.exactExcerptTranslation(record);
  if(paired){
   const translated=core.exactExcerptTranslationParts(record),labels={'user-authored':'用户自写','human-reviewed':'已有人工核对','machine':'机器生成，需核对'};
   text+='\n\n选取时译文（'+paired.language+'）：\n'+paired.text+'\n译文时间：'+stamp(translated[0].cue.start)+'–'+stamp(Math.max(...translated.map(part=>part.cue.end)))+'（按原片段定位）'+
    '\n初始来源：'+paired.providers.join('、')+' · '+paired.reviewStates.map(value=>labels[value]||value).join('、')+
    '\n译文生成时间：未记录。配对确认时间：'+paired.confirmedAt+'\n原文与译文分别选取；用户确认两段对应，不等于译文人工核对。'+
    (paired.qualityWarnings.length?'\n选取时质量提示：'+core.translationQualityMessage({quality_warnings:paired.qualityWarnings}):'');
  }
  return text;
 }
 // Chromium can focus readonly textareas while leaving native arrow selection
 // inert. Own only the documented horizontal selection and document-edge keys;
 // the control stays readonly and all quotation/source guards remain in force.
 function selectionOffsets(text){
  if(typeof Intl.Segmenter==='function')return [0,...Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text),part=>part.index+part.segment.length)];
  return null; // Do not approximate grapheme boundaries on older engines.
 }
 function moveSelection(offsets,start,end,direction,key,shift){
  const backward=direction==='backward',anchor=backward?end:start,focus=backward?start:end;
  let next;
  if(key==='Home')next=0;
  else if(key==='End')next=offsets.at(-1);
  else if(!shift&&start!==end)next=key==='ArrowLeft'?start:end;
  else if(key==='ArrowLeft')next=offsets.findLast(value=>value<focus)??0;
  else next=offsets.find(value=>value>focus)??offsets.at(-1);
  return shift?{start:Math.min(anchor,next),end:Math.max(anchor,next),direction:next<anchor?'backward':'forward'}:{start:next,end:next,direction:'none'};
 }
 function create({isCurrent,saveExcerpt,excerptState,onDraftChange=()=>{},onSelectionAction,core=root.Coconut,separator=root.CoconutPassages.separator}){
  const $=id=>root.document.getElementById(id),dialog=$('quotation-dialog');let session=null,pointer=null,serial=0,busy=false,compatibilityAcknowledged=false,focusSerial=0,visibilitySerial=0;
  function quotePayload(owner){return attribution(owner.doc,owner.quote,core)+(owner.pair?.quote?'\n\n所选译文（'+owner.pair.run.language+'；'+($('quotation-pair-confirm').checked?'用户确认对应，非翻译质量认证':'尚未确认对应')+'）：\n'+owner.pair.quote.text+'\n初始来源：'+owner.pair.info.providers.join('、')+'；译文生成时间未记录。':'');}
  function hasDraft(){return !!session?.pair&&(session.pair.editing||!session.doc.exact_excerpts?.includes(session.record));}
  function draftChanged(){onDraftChange();notifySelection();}
  function notifySelection(){root.dispatchEvent(new Event('coconut-selection-ready'));}
  function sizeSelections(){for(const id of ['quotation-original-text','quotation-pair-text']){const field=$(id);if(field.closest('[hidden]'))continue;field.style.height='auto';field.style.height=Math.max(44,field.scrollHeight+2)+'px';}}
  function showPairSelection(owner,editing){
   if(!owner?.pair)return;owner.pair.editing=editing;
   $('quotation-pair-selection').hidden=!editing;$('quotation-pair-return').hidden=!owner.pair.quote;
   $('quotation-pair-result').hidden=editing||!owner.pair.quote;$('quotation-pair-confirmations').hidden=editing||!owner.pair.quote;
   $('quotation-pair-evidence').hidden=editing||!owner.pair.quote;sizeSelections();updatePairSave();
  }
  function resetPair(owner){owner.pair=null;dialog.classList.remove('is-pairing');$('quotation-pair-editor').hidden=true;$('quotation-pair-start').hidden=false;$('quotation-pair-result').hidden=true;$('quotation-pair-evidence').hidden=true;$('quotation-pair-confirmations').hidden=true;$('quotation-pair-confirm').checked=false;$('quotation-pair-compatibility').checked=compatibilityAcknowledged;draftChanged();}
  function pairReady(owner){return !owner.pair||!owner.pair.editing&&!!owner.pair.quote&&$('quotation-pair-confirm').checked&&$('quotation-pair-compatibility').checked;}
  function updatePairSave(){const owner=session;if(!owner)return;if(owner.quote)$('quotation-preview').value=quotePayload(owner).replace(/\r\n?/g,'\n');const saved=!owner.pair?.editing&&owner.record&&owner.doc.exact_excerpts?.includes(owner.record)&&excerptState?.(owner.doc,owner.record)==='saved';$('quotation-save').disabled=!pairReady(owner)||!!owner.saving||!!saved;$('quotation-save').textContent=saved?'已保存摘录':owner.pair?'保存双语摘录':'保存所选摘录';draftChanged();}
  function pairRun(){
   const owner=session,pair=owner?.pair;if(!pair)return;owner.serial=++serial;pair.run=pair.runs[Number($('quotation-pair-run').value)]||null;pair.quote=null;owner.record=null;
   $('quotation-pair-confirm').checked=false;$('quotation-pair-result').hidden=true;$('quotation-pair-source').value=(pair.run?.text||'').replace(/\r\n?/g,'\n');$('quotation-pair-source').setSelectionRange(0,0);$('quotation-pair-preview').disabled=!pair.run;
   $('quotation-pair-status').textContent=pair.run?'请选择这一连续范围中对应的译文。缺译或依据过期处已分开，不会跨越拼接。':'这一段落没有可用的当前译文；请先返回阅读，核对或自己写译文。';showPairSelection(owner,true);
  }
  function pairLanguage(){
   const owner=session;if(!owner?.pair||!guard(owner))return;
   try{owner.pair.runs=core.translationSelectionModels(owner.doc,owner.references,$('quotation-pair-language').value);const select=$('quotation-pair-run');select.replaceChildren();owner.pair.runs.forEach((run,i)=>{const option=root.document.createElement('option');option.value=String(i);option.textContent=stamp(run.start)+'–'+stamp(run.end)+' · '+run.cues.length+' 个片段';select.append(option);});$('quotation-pair-run-field').hidden=owner.pair.runs.length<2;pairRun();}
   catch(error){$('quotation-pair-status').textContent=error.message;$('quotation-save').disabled=true;}
  }
  function reopenDraft(){if(!hasDraft())return false;if(!dialog.open)dialog.showModal();$('quotation-status').textContent='保留了未提交的双语配对，请先保存或明确放弃。';(session.pair.quote&&!session.pair.editing?$('quotation-pair-text'):$('quotation-pair-source')).focus({preventScroll:true});sizeSelections();guard(session);return true;}
  $('quotation-pair-start').onclick=()=>{const owner=session;if(!owner?.quote||!guard(owner))return;owner.record=null;owner.pair={runs:[],run:null,quote:null,editing:true};dialog.classList.add('is-pairing');$('quotation-reselect').hidden=true;$('quotation-citation').open=false;$('quotation-pair-editor').hidden=false;$('quotation-pair-start').hidden=true;$('quotation-pair-language').value=owner.doc.translation_view||'zh';$('quotation-pair-compatibility').checked=compatibilityAcknowledged;pairLanguage();$('quotation-pair-source').focus();};
  $('quotation-pair-edit').onclick=()=>{const owner=session;if(!owner?.pair?.quote||!guard(owner))return;owner.serial=++serial;showPairSelection(owner,true);const pair=owner.pair;$('quotation-pair-source').setSelectionRange(pair.run.text.slice(0,pair.quote.from).replace(/\r\n?/g,'\n').length,pair.run.text.slice(0,pair.quote.to).replace(/\r\n?/g,'\n').length);$('quotation-pair-status').textContent='调整选区后预览；返回已选对照可保留原来的选区与确认。';$('quotation-pair-source').focus();};
  $('quotation-pair-return').onclick=()=>{const owner=session;if(!owner?.pair?.quote||!guard(owner))return;owner.serial=++serial;showPairSelection(owner,false);$('quotation-pair-status').textContent='已返回先前选定的原文与译文。';$('quotation-pair-text').focus({preventScroll:true});dialog.scrollTop=0;};
  root.addEventListener('resize',()=>{if(dialog.open)sizeSelections();});
  $('quotation-pair-language').onchange=pairLanguage;$('quotation-pair-run').onchange=pairRun;
  for(const id of ['quotation-pair-confirm','quotation-pair-compatibility'])$(id).onchange=()=>{if(session){session.serial=++serial;session.record=null;}updatePairSave();};
  $('quotation-pair-discard').onclick=()=>{const owner=session;if(!owner)return;resetPair(owner);owner.record=null;preview(owner,owner.quote);};
  $('quotation-pair-preview').onclick=()=>{
   const owner=session,pair=owner?.pair;if(!pair?.run||!pair.editing||!guard(owner))return;owner.serial=++serial;
   try{
    const field=$('quotation-pair-source'),from=inputOffset(pair.run.text,field.selectionStart),to=inputOffset(pair.run.text,field.selectionEnd);
    let offset=0;const spans=pair.run.cues.map((cue,i)=>{if(i)offset+=pair.run.separators[i-1].length;const span={cue,from:offset,to:offset+cue.text.length};offset=span.to;return span;});
    slice({text:pair.run.text,spans},from,to);const info=core.translationSelectionInfo(pair.run,from,to),quote={from,to,text:pair.run.text.slice(from,to)};
    // An invalid replacement must leave the previous pair available to return to.
    pair.info=info;pair.quote=quote;owner.record=null;$('quotation-pair-confirm').checked=false;
    $('quotation-pair-text').value=pair.quote.text.replace(/\r\n?/g,'\n');$('quotation-pair-result').hidden=false;
    $('quotation-pair-origin').textContent='译文语言：'+pair.run.language+' · 初始来源：'+pair.info.providers.join('、')+' · '+pair.info.reviewStates.map(value=>({'user-authored':'用户自写','human-reviewed':'已有人工核对','machine':'机器生成，需核对'}[value])).join('、')+' · 译文生成时间未记录。'+(pair.info.qualityWarnings.length?'含质量提示，请核对。':'');
    $('quotation-pair-origin-summary').textContent=pair.info.reviewStates.map(value=>({'user-authored':'用户自写','human-reviewed':'已有人工核对','machine':'机器生成，需核对'}[value])).join('、')+' · 译文来源'+(pair.info.qualityWarnings.length?' · 有质量提示':'');
    if(pair.info.qualityWarnings.length)$('quotation-pair-origin').textContent+='\n'+core.translationQualityMessage({quality_warnings:pair.info.qualityWarnings});
    $('quotation-pair-status').textContent='请对照原文与译文，确认两段对应。';showPairSelection(owner,false);$('quotation-pair-text').focus({preventScroll:true});dialog.scrollTop=0;
   }catch(error){$('quotation-pair-status').textContent=error.message;}
  };
  function current(owner){return owner&&session===owner&&isCurrent(owner.doc)&&owner.paragraph.isConnected&&owner.paragraph.textContent===owner.model.text&&
   owner.metadata===metadata(owner.doc)&&owner.references.every((cue,i)=>owner.doc.segments.indexOf(cue)===owner.doc.segments.indexOf(owner.references[0])+i)&&owner.references.every((cue,i)=>owner.doc.segments.includes(cue)&&snapshot(cue)===owner.snapshots[i]);}
  function metadata(doc){return JSON.stringify([doc.title,doc.source_url,doc.language,doc.provenance,doc.podcast_source,doc.local_media_source,doc.source_media]);}
  function snapshot(cue){return JSON.stringify([cue.id,cue.text,cue.start,cue.end,cue.speaker,cue.original_text]);}
  function guard(owner){if(current(owner))return true;$('quotation-status').textContent='原文或篇目已变化，请关闭后重新选择。预览仍可手动复制。';$('quotation-copy').disabled=true;$('quotation-save').disabled=true;return false;}
  function newlineHint(owner){return owner.quote?.text.includes('\r\n')?' 手动复制采用预览中的换行格式。':'';}
  function selectionView(owner,message='选择同一段中的连续原文，再预览引用。'){
   resetPair(owner);$('quotation-pair').hidden=true;owner.serial=++serial;owner.quote=null;owner.record=null;$('quotation-preview').value='';$('quotation-original-text').value='';$('quotation-result').hidden=true;$('quotation-citation').hidden=true;$('quotation-citation').open=false;
   $('quotation-selector').hidden=false;$('quotation-copy').hidden=true;$('quotation-copy').disabled=true;$('quotation-reselect').hidden=true;
   $('quotation-save').hidden=true;$('quotation-save-status').textContent='';$('quotation-status').textContent=message;notifySelection();
  }
  function preview(owner,quote){
   if(!guard(owner))return;owner.serial=++serial;owner.quote=quote;owner.record=null;$('quotation-pair').hidden=false;
   $('quotation-preview').value=attribution(owner.doc,quote,core).replace(/\r\n?/g,'\n');$('quotation-original-text').value=quote.text.replace(/\r\n?/g,'\n');$('quotation-citation').hidden=false;$('quotation-citation').open=false;
   $('quotation-selector').hidden=true;$('quotation-result').hidden=false;$('quotation-copy').hidden=false;$('quotation-copy').disabled=busy;$('quotation-reselect').hidden=false;
   $('quotation-status').textContent=newlineHint(owner).trim();
   $('quotation-save').hidden=!saveExcerpt;$('quotation-save').disabled=false;$('quotation-save').textContent='保存所选摘录';$('quotation-save-status').textContent='保存到本机，保留所选文字、上下文与出处。';
   sizeSelections();$('quotation-original-text').focus({preventScroll:true});$('quotation-original-text').scrollTop=0;dialog.scrollTop=0;notifySelection();
  }
  function capture(binding){try{return {quote:domSelection(binding.paragraph,binding.model,root.getSelection())};}catch(error){return {error:error.message};}}
  function open(binding,captured){
   if(reopenDraft())return;if(!isCurrent(binding.doc)||!binding.paragraph.isConnected)return;
   const owner={...binding,serial:++serial,quote:null};session=owner;
   $('quotation-source').value=owner.model.text.replace(/\r\n?/g,'\n');$('quotation-source').setSelectionRange(0,0);selectionView(owner,captured.error);
   dialog.showModal();
   if(!guard(owner))return;
   if(captured.quote)preview(owner,captured.quote);else{$('quotation-source').focus({preventScroll:true});dialog.scrollTop=0;}
  }
  function close(){visibilitySerial++;focusSerial++;const owner=session;if(!hasDraft()){session=null;serial++;}pointer=null;if(dialog.open)dialog.close();if(owner?.button.isConnected)owner.button.focus({preventScroll:true});else $('main-content')?.focus({preventScroll:true});notifySelection();}
  $('quotation-close').onclick=close;
  $('quotation-reselect').onclick=()=>{const owner=session;if(hasDraft()){$('quotation-status').textContent='请先保存或放弃配对，再重新选择原文。';return;}if(!guard(owner))return;selectionView(owner);$('quotation-source').focus({preventScroll:true});dialog.scrollTop=0;};
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('close',()=>{if(session&&!dialog.open)close();});
  for(const fieldId of ['quotation-source','quotation-pair-source'])$(fieldId).addEventListener('keydown',event=>{
   if(event.defaultPrevented||event.isComposing||event.altKey||(fieldId==='quotation-source'?$('quotation-selector').hidden:$('quotation-pair-editor').hidden))return;
   const horizontal=['ArrowLeft','ArrowRight'].includes(event.key)&&!event.ctrlKey&&!event.metaKey;
   const edge=['Home','End'].includes(event.key)&&(event.ctrlKey||event.metaKey);
   if(!horizontal&&!edge)return;
   const owner=session,field=$(fieldId);if(!owner||!current(owner))return;
   owner.selectionFields??=new Map();let saved=owner.selectionFields.get(fieldId);if(saved?.text!==field.value){saved={text:field.value,offsets:selectionOffsets(field.value)};owner.selectionFields.set(fieldId,saved);}const offsets=saved.offsets;
   if(!offsets){$('quotation-status').textContent='此浏览器暂不支持按字选择，请用鼠标选择原文。';return;}
   event.preventDefault();
   const next=moveSelection(offsets,field.selectionStart,field.selectionEnd,field.selectionDirection,event.key,event.shiftKey);
   field.setSelectionRange(next.start,next.end,next.direction);
  });
  $('quotation-preview-selection').onclick=()=>{const owner=session;if($('quotation-selector').hidden||!guard(owner))return;try{preview(owner,slice(owner.model,inputOffset(owner.model.text,$('quotation-source').selectionStart),inputOffset(owner.model.text,$('quotation-source').selectionEnd)));}catch(error){selectionView(owner,error.message);$('quotation-source').focus({preventScroll:true});}};
  $('quotation-save').onclick=async()=>{
   const owner=session;if(!saveExcerpt||!owner?.quote||owner.saving===owner.serial||!pairReady(owner)||!(owner.record&&owner.doc.exact_excerpts?.includes(owner.record)&&isCurrent(owner.doc)||guard(owner)))return;
   const operation=owner.serial;
   try{
    const separators=owner.model.spans.slice(1).map((span,i)=>owner.model.text.slice(owner.model.spans[i].to,span.from));
    // Revalidate the live sequence and grapheme endpoints immediately before mutation.
    const now=new Date().toISOString(),options={id:root.crypto.randomUUID(),createdAt:now,confirmedAt:now};
    const candidate=owner.record&&owner.doc.exact_excerpts?.includes(owner.record)?owner.record:owner.pair?core.pairedExactExcerptSnapshot(owner.doc,owner.references,separators,owner.quote.from,owner.quote.to,owner.pair.run,owner.pair.quote.from,owner.pair.quote.to,options):core.exactExcerptSnapshot(owner.doc,owner.references,separators,owner.quote.from,owner.quote.to,options);
    owner.record=core.exactExcerptDuplicate(owner.doc,candidate)||candidate;
    owner.saving=operation;$('quotation-save').disabled=true;$('quotation-save-status').textContent='摘录保存中…';
    const result=await saveExcerpt(owner.doc,owner.record);if(owner.doc.exact_excerpts?.includes(owner.record)){if(owner.pair)compatibilityAcknowledged=true;draftChanged();}
    if(session!==owner||owner.serial!==operation||serial!==operation||!dialog.open||!current(owner)||!owner.doc.exact_excerpts?.includes(owner.record))return;
    $('quotation-save-status').textContent=result.ok?'所选摘录已保存到本机。':'摘录仅在本页，尚未保存。请重试保存，或导出未保存文档备份。';
    $('quotation-save').textContent=result.ok?'已保存摘录':'重试保存摘录';$('quotation-save').disabled=!!result.ok;
   }catch(error){if(session===owner&&owner.serial===operation&&dialog.open){$('quotation-save-status').textContent=error.message||'无法保存摘录，请重新选择原文。';$('quotation-save').disabled=false;}}
   finally{if(owner.saving===operation){owner.saving=null;if(session===owner&&owner.serial!==operation)updatePairSave();}}
  };
  root.addEventListener('coconut-persistence-change',()=>{
   const owner=session;if(!owner?.record||owner.pair?.editing||owner.saving===owner.serial||!dialog.open||!excerptState)return;
   if(excerptState(owner.doc,owner.record)==='saved'){$('quotation-save-status').textContent='所选摘录已保存到本机。';$('quotation-save').textContent='已保存摘录';$('quotation-save').disabled=true;}
  });
  dialog.addEventListener('pointerdown',()=>{focusSerial++;});
  dialog.addEventListener('keydown',event=>{
   const ticket=++focusSerial;
   if(event.key!=='Tab'||event.defaultPrevented||event.isComposing||event.keyCode===229||event.altKey||event.ctrlKey||event.metaKey||event.target.closest?.('dialog')!==dialog)return;
   const controls=[...dialog.querySelectorAll('button,input,select,textarea,summary,[tabindex]')].filter(node=>{if(node.matches(':disabled')||node.tagName!=='SUMMARY'&&node.tabIndex<0||node.closest('[hidden],[inert]'))return false;for(let disclosure=node.parentElement?.closest('details:not([open])');disclosure;disclosure=disclosure.parentElement?.closest('details:not([open])'))if(!disclosure.querySelector(':scope > summary')?.contains(node))return false;for(let parent=node;parent&&parent!==dialog;parent=parent.parentElement){const style=root.getComputedStyle(parent);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return false;}return true;});
   const first=controls[0],last=controls.at(-1);if(first&&(event.shiftKey&&root.document.activeElement===first||!event.shiftKey&&root.document.activeElement===last)){event.preventDefault();(event.shiftKey?last:first).focus();}
   // Native tab scrolling does not account for the dialog's sticky actions.
   const owner=session,revision=owner?.serial;root.requestAnimationFrame(()=>{
    const node=root.document.activeElement;if(ticket!==focusSerial||session!==owner||owner?.serial!==revision||!dialog.open||!controls.includes(node)||!node.isConnected||node.closest('[hidden],[inert]'))return;
    const target=node.closest('label')||node,rect=target.getBoundingClientRect(),input=node.getBoundingClientRect(),style=root.getComputedStyle(node),ring=(parseFloat(style.outlineWidth)||0)+Math.max(0,parseFloat(style.outlineOffset)||0);
    const box=dialog.getBoundingClientRect(),footer=dialog.querySelector('.quotation-actions'),top=Math.max(0,box.top+dialog.clientTop)+8,bottom=Math.min(root.innerHeight,box.bottom)-8;if(box.height<=0||rect.height<=0)return;
    const ceiling=footer.contains(node)?bottom:Math.min(bottom,footer.getBoundingClientRect().top-8),start=Math.min(rect.top,input.top-ring),end=Math.max(rect.bottom,input.bottom+ring);
    if(end-start>ceiling-top){if(start<top||start>ceiling)dialog.scrollTop+=start-top;}else if(start<top)dialog.scrollTop+=start-top;else if(end>ceiling)dialog.scrollTop+=end-ceiling;
   });
  });
  for(const id of ['quotation-citation','quotation-pair-evidence'])$(id).addEventListener('toggle',()=>{const detail=$(id);if(!detail.open&&detail.contains(root.document.activeElement)&&root.document.activeElement!==detail.firstElementChild)detail.firstElementChild.focus({preventScroll:true});});
  $('quotation-copy').onclick=async()=>{
   const owner=session;if(busy||!guard(owner)||!owner.quote)return;
   const payload=quotePayload(owner),copySerial=owner.serial,copyVisibility=visibilitySerial;busy=true;$('quotation-copy').disabled=true;
   try{if(!root.navigator.clipboard?.writeText)throw Error('unavailable');await root.navigator.clipboard.writeText(payload);if(dialog.open&&copyVisibility===visibilitySerial&&session===owner&&owner.serial===copySerial&&copySerial===serial&&guard(owner))$('quotation-status').textContent='已复制完整引用与出处。';}
   catch{if(dialog.open&&copyVisibility===visibilitySerial&&session===owner&&owner.serial===copySerial&&copySerial===serial){$('quotation-status').textContent='未能自动复制。完整引用已保留，请在预览框中全选后手动复制。'+newlineHint(owner);$('quotation-citation').open=true;$('quotation-preview').focus();$('quotation-preview').select();}}
   finally{busy=false;if(session?.quote&&current(session))$('quotation-copy').disabled=false;}
  };
  const bindings=new WeakMap();
  function bindingCurrent(binding){const first=binding.doc.segments.indexOf(binding.references[0]);return first>=0&&isCurrent(binding.doc)&&binding.paragraph.isConnected&&binding.paragraph.textContent===binding.model.text&&metadata(binding.doc)===binding.metadata&&binding.references.every((cue,i)=>binding.doc.segments[first+i]===cue&&snapshot(cue)===binding.snapshots[i]);}
  function actionSession(binding,quote,previewOwner=null){
   const valid=()=>bindingCurrent(binding)&&(!previewOwner||session===previewOwner&&session.quote===quote&&dialog.open&&!hasDraft());
   return Object.freeze({text:quote.text,isCurrent:valid,
    run(intent){if(!['explain','translate'].includes(intent)||!valid()||!onSelectionAction)return false;
     if(previewOwner)close();
     return onSelectionAction(binding.doc,quote,binding.button,intent)===true;},
    bounds(){const range=root.getSelection()?.rangeCount?root.getSelection().getRangeAt(0):null;const rect=range?.getBoundingClientRect?.();return rect?{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}:null;}
   });
  }
  if(onSelectionAction){
   root.CoconutSelectionActions=Object.freeze({
    capture(){if(dialog.open||root.document.querySelector('dialog[open]')||root.document.activeElement?.matches('input,textarea,[contenteditable="true"]'))return null;const selection=root.getSelection();const anchor=selection?.anchorNode;const paragraph=(anchor?.nodeType===1?anchor:anchor?.parentElement)?.closest?.('.passage-original');const binding=bindings.get(paragraph);if(!binding||!bindingCurrent(binding))return null;const captured=capture(binding);return captured.quote?actionSession(binding,captured.quote):null;},
    preview(){return session?.quote&&dialog.open&&!hasDraft()&&current(session)?actionSession(session,session.quote,session):null;}
   });notifySelection();
  }
  return {hasDraft,reopenDraft,ownsDraft:doc=>hasDraft()&&session.doc===doc,bind(button,paragraph,doc,cues){
   const binding={button,paragraph,doc,references:[...cues],snapshots:cues.map(snapshot),metadata:metadata(doc),model:compose(cues.map(cue=>({...cue})),separator)};
   bindings.set(paragraph,binding);
   button.addEventListener('pointerdown',()=>{pointer={button,...capture(binding)};});
   button.addEventListener('pointercancel',()=>{pointer=null;});
   button.addEventListener('keydown',()=>{pointer=null;});
   button.onclick=event=>{const selection=root.getSelection(),live=selection&&selection.rangeCount&&!selection.isCollapsed;const captured=!live&&event.detail>0&&pointer?.button===button?pointer:capture(binding);pointer=null;open(binding,captured);};
  }};
 }
 const api={compose,slice,domSelection,inputOffset,stamp,attribution,attributionDetails,savedAttribution,selectionOffsets,moveSelection,create};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CoconutQuotation=api;
})(typeof window!=='undefined'?window:globalThis);
