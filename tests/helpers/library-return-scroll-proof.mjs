/** Exact reachable-offset restoration; a shrinking native range has one exception.
 * Only a saved offset above the NEW maximum may clamp, and then both the native
 * maximum and the same visible target anchor must be retained within one pixel.
 */
export function evaluateLibraryReturnScroll({before,after}){
 const valid=sample=>sample&&['scrollTop','maxScrollTop','scrollHeight','clientHeight','targetTop','targetPortOffset'].every(key=>Number.isFinite(sample[key])&&sample[key]>=0)&&sample.clientHeight>0&&sample.scrollHeight>=sample.clientHeight&&sample.maxScrollTop===sample.scrollHeight-sample.clientHeight&&sample.scrollTop<=sample.maxScrollTop;
 const validMetrics=!!valid(before)&&!!valid(after);
 const clamped=validMetrics&&before.scrollTop>after.maxScrollTop;
 const expectedScrollTop=validMetrics?(clamped?after.maxScrollTop:before.scrollTop):null;
 const scrollMatches=validMetrics&&Math.abs(after.scrollTop-expectedScrollTop)<=1;
 const clampedAnchorMatches=validMetrics&&(!clamped||Math.abs(after.targetTop-before.targetTop)<=1&&Math.abs(after.targetPortOffset-before.targetPortOffset)<=1);
 return {validMetrics,clamped,expectedScrollTop,scrollMatches,clampedAnchorMatches,pass:validMetrics&&scrollMatches&&clampedAnchorMatches};
}

/** The range exception cannot excuse a different query, page, hit or focus owner. */
export function evaluateLibraryReturnIdentity({before,after}){
 const fields=['query','scope','page','documentKey','language','hitId','hitIndex'];
 return {...Object.fromEntries(fields.map(key=>[key,typeof before?.[key]==='string'&&typeof after?.[key]==='string'&&(key==='query'||before[key].trim().length>0)&&before[key]===after[key]])),
  focused:before?.focused===true&&after?.focused===true,
  connected:before?.connected===true&&after?.connected===true,
  modalOpen:before?.modalOpen===true&&after?.modalOpen===true};
}
