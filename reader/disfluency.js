/* A disposable reading projection: source text and clocks remain canonical. */
(function (root) {
 'use strict';

 const VERSION=1;
 const DEFAULT_POLICY_VERSION='disfluency-v1';
 const LIMITS=Object.freeze({cues:30000,characters:1000000,decisions:100000,marks:100000,breaks:30000});
 const READING_MARKS=Object.freeze(['，','。','？','！','；','：']);
 const states=new WeakMap();
 const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
 const fail=message=>{throw new Error(message);};
 const validId=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f]/u.test(value);
 const boundary=(text,offset)=>Number.isSafeInteger(offset)&&offset>=0&&offset<=text.length&&
  !(offset>0&&offset<text.length&&/[\uD800-\uDBFF]/u.test(text[offset-1])&&/[\uDC00-\uDFFF]/u.test(text[offset]));
 function freeze(value){if(object(value)||Array.isArray(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}

 // Synchronous SHA-256 keeps browser and Node identities equal without retaining
 // a second serialized copy of all word alignments in the projection.
 const HASH_CONSTANTS=new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
 function digest(text){
  const bytes=new TextEncoder().encode(text),length=Math.ceil((bytes.length+9)/64)*64;
  const padded=new Uint8Array(length);padded.set(bytes);padded[bytes.length]=0x80;
  const view=new DataView(padded.buffer),bits=bytes.length*8;
  view.setUint32(length-8,Math.floor(bits/0x100000000));view.setUint32(length-4,bits>>>0);
  const hash=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const words=new Uint32Array(64),rotate=(n,b)=>(n>>>b)|(n<<(32-b));
  for(let offset=0;offset<length;offset+=64){
   for(let i=0;i<16;i++)words[i]=view.getUint32(offset+i*4);
   for(let i=16;i<64;i++){
    const a=words[i-15],b=words[i-2];
    words[i]=(words[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+words[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))>>>0;
   }
   let [a,b,c,d,e,f,g,h]=hash;
   for(let i=0;i<64;i++){
    const first=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+HASH_CONSTANTS[i]+words[i])>>>0;
    const second=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
    h=g;g=f;f=e;e=(d+first)>>>0;d=c;c=b;b=a;a=(first+second)>>>0;
   }
   [a,b,c,d,e,f,g,h].forEach((value,index)=>{hash[index]=(hash[index]+value)>>>0;});
  }
  return Array.from(hash,n=>n.toString(16).padStart(8,'0')).join('');
 }

 function source(document){
  if(!object(document)||!Array.isArray(document.segments)||document.segments.length>LIMITS.cues)fail('口语阅读需要有效的来源稿。');
  const ids=new Set();let prior=-1,characters=0;
  const cues=document.segments.map(cue=>{
   if(!object(cue)||!validId(cue.id)||ids.has(cue.id)||typeof cue.text!=='string'||
    !Number.isFinite(cue.start)||!Number.isFinite(cue.end)||cue.start<0||cue.start<prior||cue.end<cue.start||
    cue.speaker!=null&&typeof cue.speaker!=='string'||cue.speaker_id!=null&&typeof cue.speaker_id!=='string')fail('口语阅读来源片段无效。');
   ids.add(cue.id);prior=cue.start;characters+=cue.text.length;
   const result={id:cue.id,start:cue.start,end:cue.end,text:cue.text,speaker:cue.speaker??null,speaker_id:cue.speaker_id??null,
    alignment_status:cue.alignment_status??null,timing_basis:cue.timing_basis??null};
   if(cue.words!==undefined){
    if(!Array.isArray(cue.words))fail('口语阅读来源词时钟无效。');
    result.words=cue.words.map(word=>{
     if(!object(word)||typeof word.word!=='string'||!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<0||word.end<word.start)fail('口语阅读来源词时钟无效。');
     return {word:word.word,start:word.start,end:word.end,text_start:word.text_start??null,text_end:word.text_end??null};
    });
   }
   return result;
  });
  if(characters>LIMITS.characters)fail('口语阅读来源稿过长。');
  return {key:typeof document.key==='string'?document.key:'',cues};
 }
 function signature(document){return 'sha256:'+digest(JSON.stringify(source(document)));}
 function state(projection){const value=states.get(projection);if(!value)fail('请从当前来源稿重新生成口语阅读。');return value;}
 function policy(value){if(typeof value!=='string'||!value.trim()||value.length>200)fail('口语阅读策略版本无效。');return value;}
 function checkOptions(options,allowed){if(!object(options)||Object.keys(options).some(key=>!allowed.includes(key)))fail('口语阅读选项无效。');}

 function createProjection(document,options={}){
  checkOptions(options,['decisions','marks','breaks','policyVersion','sourceSignature']);
  const {decisions=[],marks=[],breaks=[],policyVersion=DEFAULT_POLICY_VERSION,sourceSignature}=options;
  policy(policyVersion);
  const input=source(document),currentSignature='sha256:'+digest(JSON.stringify(input));
  if(sourceSignature!==undefined&&sourceSignature!==currentSignature)fail('来源稿已变化，未应用旧的口语阅读建议。');
  if(!Array.isArray(decisions)||decisions.length>LIMITS.decisions)fail('口语阅读建议无效或过多。');
  if(!Array.isArray(marks)||marks.length>LIMITS.marks||!Array.isArray(breaks)||breaks.length>LIMITS.breaks)fail('阅读标点或断句建议无效或过多。');
  const byId=new Map(input.cues.map(cue=>[cue.id,cue])),groups=new Map();
  const marksById=new Map(),breaksById=new Map();
  for(const [entries,group,isMark] of [[marks,marksById,true],[breaks,breaksById,false]]){
   for(const entry of entries){
    if(!object(entry)||Object.keys(entry).some(key=>!(isMark?['cue_id','at','mark','reason','method']:['cue_id','at','reason']).includes(key)))fail('阅读标点和断句只接受原文边界与明确依据。');
    const cue=byId.get(entry.cue_id);
    if(!cue||!boundary(cue.text,entry.at)||entry.at===0||typeof entry.reason!=='string'||!entry.reason.trim()||entry.reason.length>1000||
     isMark&&(!READING_MARKS.includes(entry.mark)||own(entry,'method')&&!['rule','llm'].includes(entry.method)))fail('阅读标点或断句的来源位置无效。');
    if(!group.has(cue.id))group.set(cue.id,[]);
    group.get(cue.id).push({...entry});
   }
  }
  for(const decision of decisions){
   if(!object(decision)||Object.keys(decision).some(key=>!['cue_id','from','to','action','reason','confidence'].includes(key)))fail('口语阅读只接受原文范围的保留或隐藏。');
   const cue=byId.get(decision.cue_id);
   if(!cue||!boundary(cue.text,decision.from)||!boundary(cue.text,decision.to)||decision.to<=decision.from||
    !['hide','keep'].includes(decision.action)||typeof decision.reason!=='string'||!decision.reason.trim()||decision.reason.length>1000||
    own(decision,'confidence')&&(!Number.isFinite(decision.confidence)||decision.confidence<0||decision.confidence>1))fail('口语阅读建议的来源范围或依据无效。');
   if(!groups.has(cue.id))groups.set(cue.id,[]);
   groups.get(cue.id).push({...decision});
  }
  const cues=input.cues.map(cue=>{
   const edits=(groups.get(cue.id)||[]).sort((a,b)=>a.from-b.from||a.to-b.to),spans=[];
   let offset=0,displayOffset=0,text='';
   function append(from,to,decision){
    if(to===from)return;
    const action=decision?.action||'keep',shown=action==='hide'?'':cue.text.slice(from,to);
    spans.push({from,to,displayFrom:displayOffset,displayTo:displayOffset+shown.length,action,
     ...(decision?{reason:decision.reason,...(own(decision,'confidence')?{confidence:decision.confidence}:{})}: {})});
    text+=shown;displayOffset+=shown.length;
   }
   for(const edit of edits){
    if(edit.from<offset)fail('口语阅读建议重复或重叠，未应用。');
    append(offset,edit.from);append(edit.from,edit.to,edit);offset=edit.to;
   }
   append(offset,cue.text.length);
   const firstContent=spans.reduce((first,span)=>{
    if(first!==-1||span.action==='hide')return first;
    const found=cue.text.slice(span.from,span.to).search(/\S/u);return found<0?-1:span.from+found;
   },-1);
   function additions(entries,isMark){
    let prior=-1,priorDisplay=-1,spanIndex=0;
    return (entries||[]).sort((a,b)=>a.at-b.at).map(entry=>{
     while(spanIndex<spans.length-1&&spans[spanIndex].to<entry.at)spanIndex++;
     const span=spans[spanIndex];
     if(entry.at===prior||!span||span.action==='hide'&&span.from<entry.at&&entry.at<span.to||firstContent===-1||entry.at<=firstContent)fail('阅读标点或断句重复，或位于隐藏内容中。');
     const displayAt=span.action==='hide'?span.displayTo:span.displayFrom+entry.at-span.from;
     if(displayAt===priorDisplay)fail('阅读标点或断句投影位置重复。');
     prior=entry.at;priorDisplay=displayAt;
     return {at:entry.at,displayAt,...(isMark?{mark:entry.mark,...(own(entry,'method')?{method:entry.method}:{})}:{}),reason:entry.reason};
    });
   }
   const cueMarks=additions(marksById.get(cue.id),true),cueBreaks=additions(breaksById.get(cue.id),false);
   const events=new Map();
   for(const entry of cueMarks)events.set(entry.displayAt,(events.get(entry.displayAt)||'')+entry.mark);
   for(const entry of cueBreaks)events.set(entry.displayAt,(events.get(entry.displayAt)||'')+'\n\n');
   let readingText='',cursor=0;
   for(const [at,inserted] of [...events].sort((a,b)=>a[0]-b[0])){readingText+=text.slice(cursor,at)+inserted;cursor=at;}
   readingText+=text.slice(cursor);
   return {cue_id:cue.id,start:cue.start,end:cue.end,speaker:cue.speaker,...(cue.speaker_id!==null?{speaker_id:cue.speaker_id}:{}),sourceText:cue.text,text,readingText,spans,marks:cueMarks,breaks:cueBreaks};
  });
  const projection=freeze({version:VERSION,policyVersion,sourceSignature:currentSignature,cues});
  states.set(projection,{cues:new Map(cues.map(cue=>[cue.cue_id,cue])),positions:new Map(cues.map((cue,index)=>[cue.cue_id,index]))});
  return projection;
 }
 function assertCurrent(document,projection,options={}){
  state(projection);checkOptions(options,['policyVersion']);
  if(projection.version!==VERSION||options.policyVersion!==undefined&&policy(options.policyVersion)!==projection.policyVersion||signature(document)!==projection.sourceSignature)fail('来源稿或处理策略已变化，请重新生成口语阅读。');
  return projection;
 }
 // Import may allocate a new project key, but must never bless edited source or
 // an unchecked mask. Verify the original plan first, then allow identity alone
 // to change. Opaque planner metadata remains part of the detached backup.
 function rebindPlan(document,target,plan){
  if(!object(plan)||plan.version!==VERSION||typeof plan.policyVersion!=='string'||typeof plan.sourceSignature!=='string'||
   !Array.isArray(plan.decisions)||plan.marks!==undefined&&!Array.isArray(plan.marks)||plan.breaks!==undefined&&!Array.isArray(plan.breaks))fail('口语阅读建议无效，未导入。');
  const projection=createProjection(document,{policyVersion:plan.policyVersion,sourceSignature:plan.sourceSignature,decisions:plan.decisions,
   ...(plan.marks!==undefined?{marks:plan.marks}:{}),...(plan.breaks!==undefined?{breaks:plan.breaks}:{})});
  if(signature({...target,key:typeof document.key==='string'?document.key:''})!==projection.sourceSignature)fail('导入后的来源稿已变化，未应用口语阅读建议。');
  return {...root.structuredClone(plan),sourceSignature:signature(target)};
 }
 function getCue(projection,cueId){return state(projection).cues.get(cueId)||null;}

 // Ranges use displayed UTF-16 offsets within each projected cue. Returning
 // source pieces individually prevents a hidden gap from becoming a verbatim
 // quotation. Clocks remain coarse cue clocks; no new word clocks are inferred.
 function select(projection,ranges){
  const current=state(projection);
  if(!Array.isArray(ranges)||!ranges.length||ranges.length>LIMITS.decisions)fail('请选择有效的口语阅读范围。');
  const pieces=[],selected=[];let priorPosition=-1,priorTo=-1;
  for(const range of ranges){
   if(!object(range)||Object.keys(range).some(key=>!['cue_id','from','to'].includes(key)))fail('口语阅读选区无效。');
   const cue=current.cues.get(range.cue_id),position=current.positions.get(range.cue_id);
   if(!cue||!boundary(cue.text,range.from)||!boundary(cue.text,range.to)||range.to<=range.from||
    position<priorPosition||position===priorPosition&&range.from<priorTo)fail('口语阅读选区越界、重叠或顺序已变化。');
   priorPosition=position;priorTo=range.to;
   selected.push({cue_id:cue.cue_id,from:range.from,to:range.to,text:cue.text.slice(range.from,range.to)});
   for(const span of cue.spans){
    if(span.action==='hide')continue;
    const from=Math.max(range.from,span.displayFrom),to=Math.min(range.to,span.displayTo);
    if(to<=from)continue;
    const sourceFrom=span.from+from-span.displayFrom,sourceTo=span.from+to-span.displayFrom,last=pieces.at(-1);
    if(last&&last.cue_id===cue.cue_id&&last.to===sourceFrom){last.to=sourceTo;last.text=cue.sourceText.slice(last.from,last.to);}
    else pieces.push({cue_id:cue.cue_id,from:sourceFrom,to:sourceTo,text:cue.sourceText.slice(sourceFrom,sourceTo),start:cue.start,end:cue.end,timing_basis:'cue'});
   }
  }
  return freeze({ranges:selected,pieces,displayText:selected.map(range=>range.text).join(''),continuous:pieces.length===1});
 }

 const api={VERSION,DEFAULT_POLICY_VERSION,LIMITS,READING_MARKS,signature,createProjection,assertCurrent,rebindPlan,getCue,select};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CoconutDisfluency=api;
})(typeof window!=='undefined'?window:globalThis);
