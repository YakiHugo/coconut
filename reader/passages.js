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
 function build(segments, options={}) {
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
  }

  const passages=[];
  for(let first=0;first<entries.length;){
   const initial=entries[first].cue;
   let next=first,characters=0,end=initial.end,lastSentence=-1,sentenceCharacters=0;
   while(next<entries.length){
    const entry=entries[next],cue=entry.cue,previous=entries[next-1];
    const count=next-first+1,nextEnd=Math.max(end,cue.end);
    if(next>first){
     const adjacent=entry.inputPosition===previous.inputPosition+1&&entry.position===previous.position+1;
     if(!adjacent||speaker(cue)!==speaker(initial)||cue.start<previous.cue.start||cue.start-previous.cue.end>2)break;
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

 const api=Object.freeze({LIMITS,build,locate,atTime,separator});
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
 else root.CoconutPassages=api;
})(typeof window!=='undefined'?window:globalThis);
