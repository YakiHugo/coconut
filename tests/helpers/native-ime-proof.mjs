/** Compare an application IME trace with a plain input in the same native browser.
 * The end-event trust flag is engine-owned, never an unconditional exception.
 * All other provenance, ordering, identity and final-value checks remain strict.
 */
export function evaluateNativeIME({baseline,actual,text}){
 const events=trace=>Array.isArray(trace?.events)?trace.events:[];
 const complete=trace=>{
  const list=events(trace),starts=list.filter(e=>e.type==='compositionstart'),ends=list.filter(e=>e.type==='compositionend');
  const start=list.findIndex(e=>e.type==='compositionstart'),end=list.findIndex(e=>e.type==='compositionend');
  return typeof text==='string'&&text.length>0&&starts.length===1&&ends.length===1&&start<end&&ends[0].data===text&&
   list.some(e=>e.type==='compositionupdate')&&list.some(e=>e.type==='beforeinput')&&list.some(e=>e.type==='input')&&
   list.every((e,index)=>['compositionstart','compositionupdate','compositionend','beforeinput','input'].includes(e.type)&&typeof e.trusted==='boolean'&&
    (e.type!=='compositionupdate'||index>start&&index<end&&e.data===text));
 };
 const trusted=trace=>events(trace).every(e=>!['compositionstart','compositionupdate','beforeinput','input'].includes(e.type)||e.trusted===true);
 const projection=trace=>events(trace).map(e=>[e.type,e.data??null,e.trusted,e.inputType??null,e.isComposing??null,e.value,e.selectionStart,e.selectionEnd]);
 const owned=trace=>trace?.same===true&&trace?.focused===true&&events(trace).every(e=>e.same===true&&e.focused===true&&e.currentNodeSame===true&&e.connected===true);
 const exactValue=trace=>trace?.value===text;
 const exactCaret=trace=>trace?.selectionStart===text?.length&&trace?.selectionEnd===text?.length;
 const noSynthetic=trace=>Array.isArray(trace?.manualDispatches)&&trace.manualDispatches.length===0;
 return {
  baselineComplete:complete(baseline),actualComplete:complete(actual),
  trustedStartsAndUpdates:trusted(baseline)&&trusted(actual),
  exactNativeSequence:JSON.stringify(projection(baseline))===JSON.stringify(projection(actual)),
  originalInput:owned(baseline)&&owned(actual),exactValue:exactValue(baseline)&&exactValue(actual),
  exactCaret:exactCaret(baseline)&&exactCaret(actual),
  finishedComposition:baseline?.composing===false&&actual?.composing===false,
  noSyntheticDispatch:noSynthetic(baseline)&&noSynthetic(actual)
 };
}

// The same native pointer action may commit composition on blur or leave it
// active. Compare the observed plain-input behavior, never prescribe an end flag.
export function evaluateNativeIMEPointer({baseline,actual,text}){
 const list=trace=>Array.isArray(trace?.events)?trace.events:[];
 const prefix=trace=>{
  const before=trace?.beforePointer,events=list(before);
  return !!(typeof text==='string'&&text.length&&before?.composing===true&&before.focused===true&&before.same===true&&before.value===text&&
   events.filter(e=>e.type==='compositionstart').length===1&&events.some(e=>e.type==='compositionupdate'&&e.data===text)&&
   events.some(e=>e.type==='beforeinput')&&events.some(e=>e.type==='input')&&!events.some(e=>['compositionend','blur','focusout'].includes(e.type))&&
   events.every(e=>e.trusted===true&&e.same===true&&e.focused===true&&e.currentNodeSame===true&&e.connected===true)&&JSON.stringify(events)===JSON.stringify(list(trace).slice(0,events.length)));
 };
 const owned=trace=>trace?.same===true&&list(trace).every(e=>e.same===true&&e.currentNodeSame===true&&e.connected===true);
 const pointer=trace=>Array.isArray(trace?.pointerEvents)&&trace.pointerEvents.map(e=>e.type).join(',')==='pointerdown,pointerup,click'&&trace.pointerEvents.every(e=>e.trusted===true&&e.same===true&&e.originalSame===true&&e.connected===true);
 const blur=trace=>['blur','focusout'].every(type=>list(trace).filter(e=>e.type===type).length===1)&&list(trace).filter(e=>['blur','focusout'].includes(e.type)).every(e=>e.trusted===true);
 const projection=events=>events.map(e=>[e.type,e.data??null,e.trusted,e.inputType??null,e.isComposing??null,e.value,e.selectionStart,e.selectionEnd,e.selectionDirection,e.focused]);
 const result=trace=>[trace?.value,trace?.selectionStart,trace?.selectionEnd,trace?.selectionDirection,trace?.composing];
 const bounded=trace=>list(trace).every(e=>['compositionstart','compositionupdate','compositionend','beforeinput','input','blur','focusout'].includes(e.type)&&typeof e.trusted==='boolean'&&(e.type==='compositionend'||e.trusted===true))&&list(trace).filter(e=>e.type==='compositionstart').length===1&&list(trace).filter(e=>e.type==='compositionend').length<=1&&typeof trace?.composing==='boolean'&&
  (trace.composing?list(trace).every(e=>e.type!=='compositionend'):list(trace).filter(e=>e.type==='compositionend').length===1);
 const noSynthetic=trace=>Array.isArray(trace?.manualDispatches)&&trace.manualDispatches.length===0;
 return {
  activeCompositionBeforePointer:prefix(baseline)&&prefix(actual),
  sameNativePrefix:JSON.stringify(projection(list(baseline?.beforePointer)))===JSON.stringify(projection(list(actual?.beforePointer))),
  trustedPointerAndBlur:pointer(baseline)&&pointer(actual)&&blur(baseline)&&blur(actual),
  exactNativeSequence:JSON.stringify(projection(list(baseline)))===JSON.stringify(projection(list(actual))),
  exactPointerSequence:JSON.stringify(baseline?.pointerEvents)===JSON.stringify(actual?.pointerEvents),
  sameNativeOutcome:JSON.stringify(result(baseline))===JSON.stringify(result(actual))&&bounded(baseline)&&bounded(actual),
  originalInput:owned(baseline)&&owned(actual),
  exactText:baseline?.value===text&&actual?.value===text,
  intentionalButtonFocus:baseline?.buttonFocused===true&&actual?.buttonFocused===true&&baseline?.focused===false&&actual?.focused===false,
  noSyntheticDispatch:noSynthetic(baseline)&&noSynthetic(actual)
 };
}
