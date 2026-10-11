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
