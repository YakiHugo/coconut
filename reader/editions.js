/* Reading products reference frozen source evidence; edited text is never a cue. */
(function (root) {
 'use strict';
 const LIMITS=Object.freeze({editions:12,cues:30000,characters:1000000,excerpts:1000});
 const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
 const fail=()=>{throw Error('阅读版本或来源依据无效，请保留原始文件。');};
 const id=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f]/.test(value);
 const string=(value,max)=>typeof value==='string'&&value.length<=max;
 const clone=value=>JSON.parse(JSON.stringify(value));
 const stamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value));
 const boundary=(text,n)=>Number.isSafeInteger(n)&&n>=0&&n<=text.length&&!(n>0&&n<text.length&&/[\uD800-\uDBFF]/.test(text[n-1])&&/[\uDC00-\uDFFF]/.test(text[n]));
 function snapshot(doc){
  return {language:doc.language||'',source_url:doc.source_url||'',cues:doc.segments.map(cue=>({id:cue.id,start:cue.start,end:cue.end,text:cue.text,speaker:cue.speaker??null,...(cue.speaker_id?{speaker_id:cue.speaker_id}:{})}))};
 }
 function checkSnapshot(value){
  if(!object(value)||!string(value.language,200)||!string(value.source_url,16384)||!Array.isArray(value.cues)||!value.cues.length||value.cues.length>LIMITS.cues)fail();
  const ids=new Set();let prior=-1,characters=0;
  for(const cue of value.cues){
   if(!object(cue)||!id(cue.id)||ids.has(cue.id)||typeof cue.text!=='string'||!Number.isFinite(cue.start)||!Number.isFinite(cue.end)||cue.start<prior||cue.end<cue.start||cue.start<0||!(cue.speaker===null||string(cue.speaker,10000))||cue.speaker_id!==undefined&&!/^speaker-[0-9]{4,6}$/.test(cue.speaker_id))fail();
   ids.add(cue.id);prior=cue.start;characters+=cue.text.length;
  }
  if(characters>LIMITS.characters)fail();
 }
 function checkRefs(refs,source,positions=new Map(source.cues.map((cue,index)=>[cue.id,index]))){
  if(!Array.isArray(refs)||!refs.length||refs.length>source.cues.length)fail();
  let prior=-1;
  for(const ref of refs){const index=positions.get(ref);if(index===undefined||index<=prior)fail();prior=index;}
 }
 function blockText(block){return block.paragraphs.join('\n\n');}
 function validate(value){
  if(value===undefined)return undefined;
  if(!object(value)||value.version!==1||!Array.isArray(value.snapshots)||!Array.isArray(value.editions)||!Array.isArray(value.excerpts)||value.editions.length>LIMITS.editions||value.snapshots.length>LIMITS.editions||value.excerpts.length>LIMITS.excerpts)fail();
  const sources=new Map(),indexes=new Map(),editions=new Map();let total=0;
  for(const entry of value.snapshots){if(!object(entry)||!id(entry.id)||sources.has(entry.id))fail();checkSnapshot(entry.source);sources.set(entry.id,entry.source);indexes.set(entry.id,new Map(entry.source.cues.map((cue,index)=>[cue.id,index])));total+=entry.source.cues.reduce((n,c)=>n+c.text.length,0);}
  for(const edition of value.editions){
   const source=sources.get(edition?.source_snapshot_id);
   if(!object(edition)||!id(edition.id)||editions.has(edition.id)||edition.kind!=='interview'||!string(edition.title,500)||!edition.title.trim()||!source||!stamp(edition.created_at)||!Number.isSafeInteger(edition.revision)||edition.revision<1||edition.method!=='manual'||edition.coverage!=='full'||!Array.isArray(edition.blocks)||!edition.blocks.length||edition.blocks.length>LIMITS.cues)fail();
   const ids=new Set(),refs=[];
   for(const block of edition.blocks){
    if(!object(block)||!id(block.id)||ids.has(block.id)||!string(block.heading,500)||!Array.isArray(block.paragraphs)||!block.paragraphs.length||block.paragraphs.length>10000||block.paragraphs.some(text=>!string(text,100000)||!text.trim()))fail();
    checkRefs(block.source_refs,source,indexes.get(edition.source_snapshot_id));ids.add(block.id);refs.push(...block.source_refs);total+=blockText(block).length;
   }
   // The first edition contract preserves ordered, complete source coverage.
   // References prove provenance, not the semantic faithfulness of edited prose.
   if(refs.length!==source.cues.length||refs.some((ref,index)=>ref!==source.cues[index].id))fail();
   if(edition.media_identity!==undefined&&(!string(edition.media_identity,16384)||!edition.media_identity))fail();
   editions.set(edition.id,edition);
  }
  const excerptIds=new Set();
  for(const item of value.excerpts){
   const source=sources.get(item?.source_snapshot_id),edition=editions.get(item?.edition_id);
   if(!object(item)||!id(item.id)||excerptIds.has(item.id)||!edition||edition.source_snapshot_id!==item.source_snapshot_id||!source||!id(item.block_id)||!edition.blocks.some(block=>block.id===item.block_id)||!stamp(item.created_at)||!string(item.block_text,1000000)||!boundary(item.block_text,item.from)||!boundary(item.block_text,item.to)||item.to<=item.from||typeof item.text!=='string'||!item.text.trim()||item.text!==item.block_text.slice(item.from,item.to))fail();
   checkRefs(item.source_refs,source,indexes.get(item.source_snapshot_id));excerptIds.add(item.id);total+=item.block_text.length;
  }
  if(value.position!==undefined){const edition=editions.get(value.position?.edition_id);if(!edition||!edition.blocks.some(block=>block.id===value.position.block_id))fail();}
  if(total>LIMITS.characters*4)fail();
  return clone(value);
 }
 function state(doc){return doc.reading_editions||{version:1,snapshots:[],editions:[],excerpts:[]};}
 function freshness(doc,edition){
  const source=state(doc).snapshots.find(item=>item.id===edition.source_snapshot_id)?.source;
  return source&&JSON.stringify(source)===JSON.stringify(snapshot(doc))?'current':'stale';
 }
 function sourceFor(doc,edition){const source=state(doc).snapshots.find(item=>item.id===edition.source_snapshot_id)?.source;if(!source)fail();return source;}
 function passages(cues){return (typeof module!=='undefined'&&module.exports?require('./passages.js'):root.CoconutPassages).build(cues,{source:cues,layout:'reading'});}
 function turns(doc){
  const result=[];
  for(const passage of passages(doc.segments)){
   const previous=result.at(-1),text=passage.cues.reduce((text,cue,i)=>text+(i?(typeof module!=='undefined'&&module.exports?require('./passages.js'):root.CoconutPassages).separator(passage.cues[i-1].text,cue.text):'')+cue.text,'');
   if(previous&&passage.speaker&&previous.speaker===passage.speaker&&passage.start-previous.end<=2&&previous.characters+text.length+2<=60000){previous.paragraphs.push(text);previous.source_refs.push(...passage.cues.map(cue=>cue.id));previous.end=Math.max(previous.end,passage.end);previous.characters+=text.length+2;}
   else result.push({speaker:passage.speaker,start:passage.start,end:passage.end,characters:text.length,paragraphs:[text],source_refs:passage.cues.map(cue=>cue.id)});
  }
  return result;
 }
 function create(doc,{id:editionId,snapshotId,createdAt,title='编辑访谈稿',mediaIdentity}){
  const before=validate(state(doc)),source=snapshot(doc);checkSnapshot(source);
  if(before.editions.some(item=>item.id===editionId)||!id(editionId)||!id(snapshotId))fail();
  const existing=before.snapshots.find(item=>JSON.stringify(item.source)===JSON.stringify(source));
  if(!existing&&before.snapshots.some(item=>item.id===snapshotId))fail();
  const edition={id:editionId,kind:'interview',title,source_snapshot_id:existing?.id||snapshotId,created_at:createdAt,revision:1,method:'manual',coverage:'full',...(mediaIdentity?{media_identity:mediaIdentity}:{}),blocks:turns(doc).map((turn,index)=>({id:'block-'+(index+1),heading:'',paragraphs:turn.paragraphs.map(text=>text.trim()).filter(Boolean),source_refs:turn.source_refs}))};
  const next={...before,snapshots:existing?before.snapshots:[...before.snapshots,{id:snapshotId,source}],editions:[...before.editions,edition]};
  return {...doc,reading_editions:validate(next)};
 }
 function edit(doc,editionId,blockId,{heading,text},expectedRevision){
  const before=validate(state(doc)),edition=before.editions.find(item=>item.id===editionId),block=edition?.blocks.find(item=>item.id===blockId);
  if(!block||edition.revision!==expectedRevision||!string(text,100000)||!text.trim()||!string(heading,500))throw Error('阅读版本已变化或正文为空，请重新打开编辑。');
  block.heading=heading.trim();block.paragraphs=text.split(/\n\s*\n/).map(text=>text.trim()).filter(Boolean);edition.revision++;
  return {...doc,reading_editions:validate(before)};
 }
 function resolver(doc,edition){
  const source=sourceFor(doc,edition),positions=new Map(source.cues.map((cue,index)=>[cue.id,index])),current=freshness(doc,edition)==='current';
  return block=>{
  const cues=block.source_refs.map(ref=>source.cues[positions.get(ref)]),ranges=[];
  let previous=-2;
  for(const cue of cues){
   const i=positions.get(cue.id);
   const last=ranges.at(-1);
   if(last&&previous+1===i&&cue.start-last.end<=2)last.end=Math.max(last.end,cue.end);
   else ranges.push({start:cue.start,end:cue.end});
   previous=i;
  }
  const speakers=[...new Set(cues.map(cue=>cue.speaker))];
  return {cues,ranges,speaker:speakers.length===1?speakers[0]:null,current};
  };
 }
 function resolve(doc,edition,block){return resolver(doc,edition)(block);}
 function bookmark(doc,editionId,blockId){const before=validate(state(doc));before.position={edition_id:editionId,block_id:blockId};return {...doc,reading_editions:validate(before)};}
 function excerpt(doc,editionId,blockId,from,to,{id:excerptId,createdAt,expectedText}){
  const before=validate(state(doc)),edition=before.editions.find(item=>item.id===editionId),block=edition?.blocks.find(item=>item.id===blockId);
  if(!block)fail();const text=blockText(block);
  if(expectedText!==text||!boundary(text,from)||!boundary(text,to)||to<=from)throw Error('所选编辑稿已变化，请重新选择。');
  if(typeof Intl.Segmenter!=='function')throw Error('此环境不支持完整字符摘录。');
  const boundaries=new Set([0,...Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text),part=>part.index+part.segment.length)]);
  if(!boundaries.has(from)||!boundaries.has(to))throw Error('请选择完整字符。');
  before.excerpts.push({id:excerptId,edition_id:editionId,block_id:blockId,source_snapshot_id:edition.source_snapshot_id,created_at:createdAt,from,to,text:text.slice(from,to),block_text:text,source_refs:[...block.source_refs]});
  return {...doc,reading_editions:validate(before)};
 }
 function markdown(doc,editionId){
  const edition=state(doc).editions.find(item=>item.id===editionId);if(!edition)fail();
  const get=resolver(doc,edition);
  return ['# '+doc.title,'','编辑访谈稿 · 人工整理 · '+(freshness(doc,edition)==='current'?'来源依据一致':'历史版本，来源已变化'),'','来源：'+sourceFor(doc,edition).source_url,'',...edition.blocks.flatMap(block=>{const resolved=get(block);return [...(block.heading?['## '+block.heading,'']:[]),(resolved.speaker||'未标注')+'：',...block.paragraphs.flatMap(text=>[text,''])];})].join('\n');
 }
 const api={LIMITS,validate,snapshot,state,freshness,sourceFor,turns,create,edit,resolver,resolve,bookmark,blockText,excerpt,markdown};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CoconutEditions=api;
})(typeof window!=='undefined'?window:globalThis);
