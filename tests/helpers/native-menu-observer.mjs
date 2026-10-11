/** Test-only observation of the real native-menu renderer adapter. Never invokes it. */
export function installNativeMenuObservation(){
 if(window.__coconutNativeMenuObservation)return;
 const original=window.coconutFileCommand;
 if(typeof original!=='function')throw new Error('Native renderer adapter is unavailable');
 const observation={sequence:0,last:null,inputClicks:0,lastInput:null};
 const inputClick=event=>{
  const id=event.target?.id;
  if(!['file','local-media-file'].includes(id))return;
  observation.inputClicks++;
  observation.lastInput={id,userActivation:navigator.userActivation?.isActive===true};
 };
 const observed=function(command,request){
  const target=document.getElementById(command==='import-transcript'?'import':command==='open-local-media'?'open-local-media':command==='backup-library'?'export-library':'search');
  const record={sequence:++observation.sequence,command:['import-transcript','open-local-media','backup-library','find-transcript'].includes(command)?command:'unknown',
   bootstrapReady:window.CoconutStorageBootstrap?.phase==='ready',bodyInert:document.body.inert===true,shellInert:document.querySelector('.shell')?.inert===true,
   openDialogs:document.querySelectorAll('dialog[open]').length,targetDisabled:target?.disabled===true,targetInert:!!target?.closest('[inert]'),
   issuedForThisPage:Number.isFinite(request?.issuedAt)&&request.issuedAt>=performance.timeOrigin,unexpired:Number.isFinite(request?.expiresAt)&&request.expiresAt>Date.now(),
   userActivation:navigator.userActivation?.isActive===true,completed:false};
  observation.last=record;
  try{const result=original.apply(this,arguments);record.result=typeof result==='boolean'?result:null;record.resultType=typeof result;record.completed=true;return result;}
  catch(error){record.threw=true;record.completed=true;throw error;}
 };
 observation.dispose=()=>{
  document.removeEventListener('click',inputClick,true);
  if(window.coconutFileCommand===observed)window.coconutFileCommand=original;
  delete window.__coconutNativeMenuObservation;
 };
 document.addEventListener('click',inputClick,true);
 window.coconutFileCommand=observed;
 window.__coconutNativeMenuObservation=observation;
}

/** Keep the actual Playwright chooser subscription alive for one page lifetime.
 * Register before navigation/bootstrap awaits, not beside a cross-process menu click.
 * It does not supply a chooser: every operation still awaits its own real page event.
 */
export function observePageFileChoosers(page){
 let count=0,disposed=false;
 const onChooser=()=>{if(!disposed&&!page.isClosed())count++;};
 const dispose=()=>{if(disposed)return;disposed=true;page.off('filechooser',onChooser);page.off('close',dispose);};
 page.on('filechooser',onChooser);page.once('close',dispose);
 return {count:()=>count,dispose};
}
