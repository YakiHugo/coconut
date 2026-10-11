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
  const origin=demo?'':doc.podcast_source?(core.podcastURL(doc.source_url)||core.podcastURL(doc.podcast_source.feed_url)):'';
  const location=demo?'自写演示内容（无对应音视频）':timed?'来源：'+timed:origin?'来源：'+origin+'（按时间手动定位）':doc.local_media_source||doc.source_media?'本地原始媒体（无原站链接，请按文字稿时间定位）':'未关联原站链接或媒体（仅文字稿时间定位）';
  const corrected=quote.parts.some(({cue})=>cue.original_text!==undefined&&cue.original_text!==cue.text);
  return {title:label(doc.title),range:stamp(quote.start)+'–'+stamp(quote.end),corrected,location};
 }
 function attribution(doc,quote,core){
  const details=attributionDetails(doc,quote,core);
  return quote.text+'\n\n—— '+details.title+' · '+details.range+(details.corrected?' · 已修正文字稿':'')+'\n'+details.location;
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
 function create({isCurrent,saveExcerpt,excerptState,core=root.Coconut,separator=root.CoconutPassages.separator}){
  const $=id=>root.document.getElementById(id),dialog=$('quotation-dialog');let session=null,pointer=null,serial=0,busy=false;
  function current(owner){return owner&&session===owner&&isCurrent(owner.doc)&&owner.paragraph.isConnected&&owner.paragraph.textContent===owner.model.text&&
   owner.metadata===metadata(owner.doc)&&owner.references.every((cue,i)=>owner.doc.segments.indexOf(cue)===owner.doc.segments.indexOf(owner.references[0])+i)&&owner.references.every((cue,i)=>owner.doc.segments.includes(cue)&&snapshot(cue)===owner.snapshots[i]);}
  function metadata(doc){return JSON.stringify([doc.title,doc.source_url,doc.language,doc.provenance,doc.podcast_source,doc.local_media_source,doc.source_media]);}
  function snapshot(cue){return JSON.stringify([cue.id,cue.text,cue.start,cue.end,cue.speaker,cue.original_text]);}
  function guard(owner){if(current(owner))return true;$('quotation-status').textContent='原文或篇目已变化，请关闭后重新选择。预览仍可手动复制。';$('quotation-copy').disabled=true;$('quotation-save').disabled=true;return false;}
  function newlineHint(owner){return owner.quote?.text.includes('\r\n')?' 手动复制采用预览中的换行格式。':'';}
  function selectionView(owner,message='选择同一段中的连续原文，再预览引用。'){
   owner.serial=++serial;owner.quote=null;owner.record=null;$('quotation-preview').value='';$('quotation-result').hidden=true;
   $('quotation-selector').hidden=false;$('quotation-copy').hidden=true;$('quotation-copy').disabled=true;$('quotation-reselect').hidden=true;
   $('quotation-save').hidden=true;$('quotation-save-status').textContent='';$('quotation-status').textContent=message;
  }
  function preview(owner,quote){
   if(!guard(owner))return;owner.serial=++serial;owner.quote=quote;owner.record=null;
   $('quotation-preview').value=attribution(owner.doc,quote,core).replace(/\r\n?/g,'\n');
   $('quotation-selector').hidden=true;$('quotation-result').hidden=false;$('quotation-copy').hidden=false;$('quotation-copy').disabled=busy;$('quotation-reselect').hidden=false;
   $('quotation-status').textContent='时间按文字稿片段定位。'+newlineHint(owner);
   $('quotation-save').hidden=!saveExcerpt;$('quotation-save').disabled=false;$('quotation-save').textContent='保存所选摘录';$('quotation-save-status').textContent='精确保存所选文字、上下文与此刻的出处。整段摘录另行保留。';
   $('quotation-preview').focus({preventScroll:true});$('quotation-preview').scrollTop=0;dialog.scrollTop=0;
  }
  function capture(binding){try{return {quote:domSelection(binding.paragraph,binding.model,root.getSelection())};}catch(error){return {error:error.message};}}
  function open(binding,captured){
   if(!isCurrent(binding.doc)||!binding.paragraph.isConnected)return;
   const owner={...binding,serial:++serial,quote:null};session=owner;
   $('quotation-source').value=owner.model.text.replace(/\r\n?/g,'\n');$('quotation-source').setSelectionRange(0,0);selectionView(owner,captured.error);
   dialog.showModal();
   if(!guard(owner))return;
   if(captured.quote)preview(owner,captured.quote);else{$('quotation-source').focus({preventScroll:true});dialog.scrollTop=0;}
  }
  function close(){const owner=session;session=null;pointer=null;serial++;if(dialog.open)dialog.close();if(owner?.button.isConnected)owner.button.focus({preventScroll:true});else $('main-content')?.focus({preventScroll:true});}
  $('quotation-close').onclick=close;
  $('quotation-reselect').onclick=()=>{const owner=session;if(!guard(owner))return;selectionView(owner);$('quotation-source').focus({preventScroll:true});dialog.scrollTop=0;};
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('close',()=>{if(session&&!dialog.open)close();});
  $('quotation-source').addEventListener('keydown',event=>{
   if(event.defaultPrevented||event.isComposing||event.altKey||$('quotation-selector').hidden)return;
   const horizontal=['ArrowLeft','ArrowRight'].includes(event.key)&&!event.ctrlKey&&!event.metaKey;
   const edge=['Home','End'].includes(event.key)&&(event.ctrlKey||event.metaKey);
   if(!horizontal&&!edge)return;
   const owner=session,field=$('quotation-source');if(!owner||!current(owner))return;
   owner.selectionOffsets??=selectionOffsets(field.value);
   if(!owner.selectionOffsets){$('quotation-status').textContent='此浏览器暂不支持按字选择，请用鼠标选择原文。';return;}
   event.preventDefault();
   const next=moveSelection(owner.selectionOffsets,field.selectionStart,field.selectionEnd,field.selectionDirection,event.key,event.shiftKey);
   field.setSelectionRange(next.start,next.end,next.direction);
  });
  $('quotation-preview-selection').onclick=()=>{const owner=session;if($('quotation-selector').hidden||!guard(owner))return;try{preview(owner,slice(owner.model,inputOffset(owner.model.text,$('quotation-source').selectionStart),inputOffset(owner.model.text,$('quotation-source').selectionEnd)));}catch(error){selectionView(owner,error.message);$('quotation-source').focus({preventScroll:true});}};
  $('quotation-save').onclick=async()=>{
   const owner=session;if(!saveExcerpt||!owner?.quote||owner.saving===owner.serial||!guard(owner))return;
   const operation=owner.serial;
   try{
    const separators=owner.model.spans.slice(1).map((span,i)=>owner.model.text.slice(owner.model.spans[i].to,span.from));
    // Revalidate the live sequence and grapheme endpoints immediately before mutation.
    const candidate=core.exactExcerptSnapshot(owner.doc,owner.references,separators,owner.quote.from,owner.quote.to,{id:root.crypto.randomUUID(),createdAt:new Date().toISOString()});
    owner.record=core.exactExcerptDuplicate(owner.doc,candidate)||candidate;
    owner.saving=operation;$('quotation-save').disabled=true;$('quotation-save-status').textContent='摘录保存中…';
    const result=await saveExcerpt(owner.doc,owner.record);
    if(session!==owner||owner.serial!==operation||serial!==operation||!dialog.open||!current(owner)||!owner.doc.exact_excerpts?.includes(owner.record))return;
    $('quotation-save-status').textContent=result.ok?'所选摘录已保存到本机。':'摘录仅在本页，尚未保存。请重试保存，或导出未保存文档备份。';
    $('quotation-save').textContent=result.ok?'已保存摘录':'重试保存摘录';$('quotation-save').disabled=!!result.ok;
   }catch(error){if(session===owner&&owner.serial===operation&&dialog.open){$('quotation-save-status').textContent=error.message||'无法保存摘录，请重新选择原文。';$('quotation-save').disabled=false;}}
   finally{if(owner.saving===operation)owner.saving=null;}
  };
  root.addEventListener('coconut-persistence-change',()=>{
   const owner=session;if(!owner?.record||owner.saving===owner.serial||!dialog.open||!excerptState)return;
   if(excerptState(owner.doc,owner.record)==='saved'){$('quotation-save-status').textContent='所选摘录已保存到本机。';$('quotation-save').textContent='已保存摘录';$('quotation-save').disabled=true;}
  });
  $('quotation-copy').onclick=async()=>{
   const owner=session;if(busy||!guard(owner)||!owner.quote)return;
   const payload=attribution(owner.doc,owner.quote,core),copySerial=owner.serial;busy=true;$('quotation-copy').disabled=true;
   try{if(!root.navigator.clipboard?.writeText)throw Error('unavailable');await root.navigator.clipboard.writeText(payload);if(session===owner&&owner.serial===copySerial&&copySerial===serial&&guard(owner))$('quotation-status').textContent='已复制完整引用与出处。';}
   catch{if(session===owner&&owner.serial===copySerial&&copySerial===serial){$('quotation-status').textContent='未能自动复制。完整引用已保留，请在预览框中全选后手动复制。'+newlineHint(owner);$('quotation-preview').focus();$('quotation-preview').select();}}
   finally{busy=false;if(session?.quote&&current(session))$('quotation-copy').disabled=false;}
  };
  return {bind(button,paragraph,doc,cues){
   const binding={button,paragraph,doc,references:[...cues],snapshots:cues.map(snapshot),metadata:metadata(doc),model:compose(cues.map(cue=>({...cue})),separator)};
   button.addEventListener('pointerdown',()=>{pointer={button,...capture(binding)};});
   button.addEventListener('pointercancel',()=>{pointer=null;});
   button.addEventListener('keydown',()=>{pointer=null;});
   button.onclick=event=>{const selection=root.getSelection(),live=selection&&selection.rangeCount&&!selection.isCollapsed;const captured=!live&&event.detail>0&&pointer?.button===button?pointer:capture(binding);pointer=null;open(binding,captured);};
  }};
 }
 const api={compose,slice,domSelection,inputOffset,stamp,attribution,attributionDetails,selectionOffsets,moveSelection,create};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CoconutQuotation=api;
})(typeof window!=='undefined'?window:globalThis);
