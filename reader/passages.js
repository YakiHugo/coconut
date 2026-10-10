/* Display-only paragraphs. No text, timestamps, IDs, or document state are rewritten. */
(function (root) {
 'use strict';

 const LIMITS=Object.freeze({characters:800,cues:16,seconds:45,targetCharacters:280,targetCues:8,targetSeconds:22});
 const sentenceEnd=/[.!?。！？…][\s"'”’）)\]】」』〉》»]*$/u;

 function validCue(cue) {
  return cue&&typeof cue==='object'&&!Array.isArray(cue)&&typeof cue.id==='string'&&typeof cue.text==='string'&&
   Number.isFinite(cue.start)&&Number.isFinite(cue.end)&&cue.start>=0&&cue.end>=cue.start&&
   (cue.speaker==null||typeof cue.speaker==='string');
 }
 function speaker(cue) {return cue.speaker??null;}

 /**
  * build(segments[, {source}]) -> [{key, start, end, speaker, cues}]
  *
  * Pass the COMPLETE ordered transcript, then filter its passages for display.
  * For a filtered list, also pass the complete original array as `source`;
  * adjacency is then checked by object identity, never guessed from cue IDs.
  * Alternatively, cues carrying original integer `position` values retain those
  * boundaries. Without either, a dense array declares itself the full source:
  * an omitted element cannot be detected from timestamps or arbitrary IDs.
  * Holes and null/undefined slots always break adjacency. Malformed cues,
  * duplicate IDs, invalid positions, and refs absent from `source` are rejected.
  *
  * Speaker changes, gaps over two seconds, and backwards starts break runs.
  * Overlap and zero-duration cues are valid. Passage end is the largest cue end,
  * not necessarily its last cue's end. Prefer a sentence end after reaching a
  * readable target; never split on every short sentence. A hard cap can fall
  * mid-sentence, but never inside a cue. One oversized cue stays whole and alone.
  * Character budgets count the ORIGINAL UTF-16 text, including all whitespace.
  * No joining/spacing, translation, summary, semantic heading, or model work is
  * performed. `cues` contains the exact input references in the original order.
  */
 function drain(iterator){let step;do{step=iterator.next();}while(!step.done);return step.value;}
 function sourceEntries(segments, options={}) {return drain(sourceEntriesSteps(segments,options));}
 function* sourceEntriesSteps(segments, options={}) {
  if(!Array.isArray(segments))throw new TypeError('Passages require an array of source cues');
  let sourcePositions=null;
  if(options.source!==undefined){
   if(!Array.isArray(options.source))throw new TypeError('Passage source must be the original cue array');
   sourcePositions=new Map();
   for(let i=0;i<options.source.length;i++){
    const cue=options.source[i];if(cue==null)continue;
    if(sourcePositions.has(cue))throw new TypeError('Passage source contains a repeated cue reference');
    sourcePositions.set(cue,i);
   }
  }
  const entries=[],ids=new Set();
  for(let i=0;i<segments.length;i++){
   if(!Object.hasOwn(segments,i)||segments[i]==null)continue;
   const cue=segments[i];
   if(!validCue(cue))throw new TypeError('Invalid passage source cue at position '+i);
   if(ids.has(cue.id))throw new TypeError('Repeated passage source cue ID: '+cue.id);
   ids.add(cue.id);
   let position=i;
   if(sourcePositions){
    if(!sourcePositions.has(cue))throw new TypeError('Passage cue is absent from the original source');
    position=sourcePositions.get(cue);
   }else if(Object.hasOwn(cue,'position')){
    if(!Number.isSafeInteger(cue.position)||cue.position<0)throw new TypeError('Invalid original passage position');
    position=cue.position;
   }
   entries.push({cue,position,inputPosition:i});
   if((i+1)%128===0)yield;
  }

  return entries;
 }
 function continuous(previous,cue){return speaker(previous)===speaker(cue)&&cue.start>=previous.start&&cue.start-previous.end<=2;}
 function adjacent(previous,entry){return entry.inputPosition===previous.inputPosition+1&&entry.position===previous.position+1&&continuous(previous.cue,entry.cue);}
 function build(segments,options={}){
  const entries=sourceEntries(segments,options),passages=[];
  for(let first=0;first<entries.length;){
   const initial=entries[first].cue;
   let next=first,characters=0,end=initial.end,lastSentence=-1,sentenceCharacters=0;
   while(next<entries.length){
    const entry=entries[next],cue=entry.cue,previous=entries[next-1];
    const count=next-first+1,nextEnd=Math.max(end,cue.end);
    if(next>first){
     if(!adjacent(previous,entry))break;
     if(characters+cue.text.length>LIMITS.characters||count>LIMITS.cues||nextEnd-initial.start>LIMITS.seconds){
      // Prefer the last substantial sentence instead of stranding its trailing
      // fragment at a hard limit. The bounded look-back never revises a cue.
      if(lastSentence>first&&(sentenceCharacters>=characters/2||lastSentence-first+1>=(next-first)/2))next=lastSentence+1;
      break;
     }
    }
    characters+=cue.text.length;end=nextEnd;next++;
    const atSentenceEnd=sentenceEnd.test(cue.text);
    if(atSentenceEnd){lastSentence=next-1;sentenceCharacters=characters;}
    const target=characters>=LIMITS.targetCharacters||count>=LIMITS.targetCues||end-initial.start>=LIMITS.targetSeconds;
    if((atSentenceEnd&&target)||characters>=LIMITS.characters||count>=LIMITS.cues||end-initial.start>=LIMITS.seconds)break;
   }
   const cues=entries.slice(first,next).map(entry=>entry.cue);
   passages.push({key:'passage:'+initial.id,start:initial.start,end:Math.max(...cues.map(cue=>cue.end)),speaker:speaker(initial),cues});
   first=next;
  }
  return passages;
 }

 /** Find the passage containing this exact source ID, or null. */
 function locate(passages,cueId) {
  return passages.find(passage=>passage.cues.some(cue=>cue.id===cueId))||null;
 }

 /**
  * A display-only separator between two verbatim cue strings. Existing boundary
  * whitespace wins. Han/Kana and CJK punctuation do not acquire artificial word
  * spaces; ordinary words get a space. This is typography, not word repair or
  * language detection: never modify either input string or persist the result.
  */
 function separator(leftText,rightText) {
  if(!leftText||!rightText||/\s$/u.test(leftText)||/^\s/u.test(rightText))return '';
  if(/^[,.;:!?%\)\]\}，。！？；：、…％）］｝」』】〉》”’']/u.test(rightText))return '';
  if(/[\(\[\{（［｛「『【〈《“‘]$/u.test(leftText))return '';
  if(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？；：、…）］｝」』】〉》]$/u.test(leftText)&&
   /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}（［｛「『【〈《]/u.test(rightText))return '';
  return ' ';
 }

 /**
  * Find by REAL cue time, not paragraph index or transcript percentage.
  * Intervals are [start,end); a zero-duration cue is active at its exact start.
  * In overlaps, the active cue with the latest start wins (later source order
  * breaks ties). In silence, choose the next chronological cue; after all cues,
  * choose the most recently ended cue. Invalid/negative times return null.
  */
 function atTime(passages,seconds) {
  if(!Number.isFinite(seconds)||seconds<0)return null;
  let active=null,next=null,previous=null;
  for(const passage of passages)for(const cue of passage.cues){
   const candidate={passage,start:cue.start,end:cue.end};
   if(cue.start<=seconds&&(seconds<cue.end||cue.start===cue.end&&seconds===cue.start)){
    if(!active||cue.start>=active.start)active=candidate;
   }else if(cue.start>seconds){
    if(!next||cue.start<next.start)next=candidate;
   }else if(!previous||cue.end>=previous.end)previous=candidate;
  }
  return (active||next||previous)?.passage||null;
 }

 /** Build once using the reader’s source continuity and separators. Visual
  * paragraph/page caps do not break a phrase; actual source gaps always do.
  * Offsets point into verbatim UTF-16 cue text; separator characters own no cue.
  * The caller owns invalidation when source or translation evidence changes.
  * Only the last reading and original-only query results are retained. No sliding windows or per-cue joins.
  * Steps yield after bounded cue/span/character work; callers may stop by closing
  * the iterator. Only a completed build/query publishes a result. Whole-run
  * join/lowercasing and individual cue access remain atomic; this is not a hard
  * millisecond deadline. Synchronous callers drain exactly the same engine. */
 function searchIndex(segments, translations=new Map()) {return drain(searchIndexSteps(segments,translations));}
 function* searchIndexSteps(segments, translations=new Map()) {
  const runs=[],entries=yield* sourceEntriesSteps(segments);let characters=0,spanCount=0;
  function* add(field,getText,language=''){
   let pieces=[],spans=[],length=0,previous=null,previousEntry=null;
   function* flush(){
    if(spans.length){const text=pieces.join(''),folded=text.toLocaleLowerCase();runs.push({field,language,text,folded,spans,expansions:folded.length===text.length?[]:yield* foldExpansionsSteps(text)});characters+=text.length;spanCount+=spans.length;}
    pieces=[];spans=[];length=0;previous=null;
   };
   let processed=0;
   for(const entry of entries){
    if(++processed%128===0)yield;
    if(previousEntry&&!adjacent(previousEntry,entry))yield* flush();previousEntry=entry;
    const cue=entry.cue,text=getText(cue);
    if(text===null){yield* flush();continue;}
    const space=previous===null?'':separator(previous,text);pieces.push(space,text);length+=space.length;
    if(text.length)spans.push({cue,start:length,end:length+text.length});length+=text.length;previous=text;
   }
   yield* flush();
  };
  yield* add('text',cue=>cue.text);for(const [language,getText] of translations)yield* add('translation',getText,language);
  const results=new Map();
  const index={stats:Object.freeze({runs:runs.length,characters,spans:spanCount}),search(query,scope='all'){return drain(index.searchSteps(query,scope));},*searchSteps(query,scope='all'){
   scope=scope==='text'?'text':'all';const cached=results.get(scope);
   if(query===cached?.input)return cached.result;
   const needle=query.trim().toLocaleLowerCase();
   if(needle===cached?.query){cached.input=query;return cached.result;}
   const byCue=new Map(),previews=new Map(),failure=yield* prefixTableSteps(needle);
   const entryFor=span=>{let entry=byCue.get(span.cue.id);if(!entry){entry={text:[],translations:Object.create(null),phrases:Object.create(null)};byCue.set(span.cue.id,entry);}return entry;};
   let processedRuns=0;
   if(needle)for(const run of runs){
    if(scope==='text'&&run.field!=='text')continue;
    let firstSpan=0,lastSpan=0,nextPhraseSpan=0,highlightSpan=0,unionStart=-1,unionEnd=-1;
    const fieldKey=run.field+(run.language?':'+run.language:'');
    function* flushHighlight(){
     if(unionStart<0)return;
     while(highlightSpan<run.spans.length&&run.spans[highlightSpan].end<=unionStart){highlightSpan++;if(highlightSpan%128===0)yield;}
     for(let position=highlightSpan;position<run.spans.length;position++){
      if((position+1)%128===0)yield;
      const span=run.spans[position];if(span.start>=unionEnd)break;
      const entry=entryFor(span),ranges=run.field==='text'?entry.text:(entry.translations[run.language]??=[]);
      const range={start:Math.max(0,unionStart-span.start),end:Math.min(span.end,unionEnd)-span.start},previous=ranges.at(-1);
      if(previous&&range.start<=previous.end)previous.end=Math.max(previous.end,range.end);else ranges.push(range);
     }
    };
    for(const offset of eachMatchSteps(run.folded,needle,failure)){
     if(offset===null){yield;continue;}
     const start=sourceOffset(run.expansions,offset,false),end=sourceOffset(run.expansions,offset+needle.length,true);
     // Merge overlapping occurrences BEFORE mapping their contributing spans.
     // A repeated long phrase must not revisit thousands of cues per match.
     if(start>unionEnd){yield* flushHighlight();unionStart=start;unionEnd=end;}else unionEnd=Math.max(unionEnd,end);
     while(firstSpan<run.spans.length&&run.spans[firstSpan].end<=start){firstSpan++;if(firstSpan%128===0)yield;}
     lastSpan=Math.max(lastSpan,firstSpan);
     while(lastSpan<run.spans.length&&run.spans[lastSpan].start<end){lastSpan++;if(lastSpan%128===0)yield;}
     const count=lastSpan-firstSpan;if(!count)continue;
     const key=fieldKey+':'+run.spans[firstSpan].cue.id,existing=previews.get(key);
     const needsPreview=!existing||existing.cueCount===1&&count>1;
     const assignFrom=Math.max(nextPhraseSpan,firstSpan);
     if(needsPreview||count>1&&assignFrom<lastSpan){
      const first=firstSpan,last=lastSpan;let ids;
      const hit={field:run.field,language:run.language,id:run.spans[first].cue.id,lastId:run.spans[last-1].cue.id,cueCount:count,
       get ids(){return ids??=run.spans.slice(first,last).map(span=>span.cue.id);},snippet:rangeSnippet(run.text,start,end)};
      if(needsPreview)previews.set(key,hit);
      if(count>1){for(let position=assignFrom;position<last;position++){entryFor(run.spans[position]).phrases[fieldKey]=hit;if((position+1)%128===0)yield;}nextPhraseSpan=last;}
     }
    }
    yield* flushHighlight();
    if(++processedRuns%128===0)yield;
   }
   const result={byCue,previews};results.set(scope,{input:query,query:needle,result});return result;
  }};
  return index;
 }
 // KMP keeps even heavily overlapping, repetitive long queries linear in
 // indexed characters + query length. Resuming never rescans source text.
 function* prefixTableSteps(needle){
  const table=new Uint32Array(needle.length);let matched=0;
  for(let i=1;i<needle.length;i++){while(matched&&needle[i]!==needle[matched])matched=table[matched-1];if(needle[i]===needle[matched])matched++;table[i]=matched;if(i%2048===0)yield;}
  return table;
 }
 function* eachMatchSteps(text,needle,table){
  let matched=0;for(let i=0;i<text.length;i++){
   while(matched&&text[i]!==needle[matched])matched=table[matched-1];
   if(text[i]===needle[matched])matched++;
   if(matched===needle.length){yield i-needle.length+1;matched=table[matched-1];}
   if((i+1)%2048===0)yield null;
  }
 }
 // Locale case folding can expand a code point (İ → i + combining dot). Keep
 // only expansion boundaries, rather than an O(characters) numeric offset map.
 function* foldExpansionsSteps(text){
  const expansions=[];let source=0,folded=0,count=0;
  for(const char of text){const width=char.toLocaleLowerCase().length;if(width!==char.length)expansions.push({start:folded,end:folded+width,source,endSource:source+char.length});source+=char.length;folded+=width;if(++count%2048===0)yield;}
  return expansions;
 }
 function sourceOffset(expansions,offset,end){
  let low=0,high=expansions.length;
  while(low<high){const middle=(low+high)>>>1;if(expansions[middle].start<offset||(!end&&expansions[middle].start===offset))low=middle+1;else high=middle;}
  const expansion=expansions[low-1];if(!expansion)return offset;
  if(offset<expansion.end)return end?expansion.endSource:expansion.source;
  return offset+expansion.endSource-expansion.end;
 }
 function rangeSnippet(text,start,end){
  // Preview slices inspect at most 446 UTF-16 units and retain at most
  // 220 source code points plus ellipses, even for million-character cues.
  const before=Array.from(text.slice(Math.max(0,start-72),start)).slice(-35).join('');
  const match=Array.from(text.slice(start,Math.min(end,start+242))).slice(0,120).join('');
  const after=Array.from(text.slice(end,end+132)).slice(0,65).join('');
  return {before:(start>before.length?'…':'')+before,match:match+(end-start>match.length?'…':''),after:after+(end+after.length<text.length?'…':'')};
 }

 const api=Object.freeze({LIMITS,build,locate,atTime,separator,continuous,searchIndex,searchIndexSteps,rangeSnippet});
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
 else root.CoconutPassages=api;
})(typeof window!=='undefined'?window:globalThis);
