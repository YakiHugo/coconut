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

/** Invoke the real installed MenuItem once and await its observed renderer receipt.
 * MenuItem.click discards the async template result; returning from main is not
 * proof that the target page accepted the command. Never dispatch from the page.
 */
export async function invokeObservedNativeMenuCommand(application,page,id,diagnostic){
 Object.assign(diagnostic,{command:id,menuInvoked:false,rendererReceived:false});
 const before=await page.evaluate(()=>{const state=window.__coconutNativeMenuObservation;return {sequence:state.sequence,inputClicks:state.inputClicks};});
 diagnostic.before=before;
 diagnostic.dispatch=await application.evaluate(({Menu,BrowserWindow},id)=>{
  const item=Menu.getApplicationMenu().getMenuItemById(id),windows=BrowserWindow.getAllWindows(),window=windows[0];
  if(!item?.enabled||!window||window.isDestroyed())throw new Error('Native file item unavailable: '+id);
  const facts={enabled:item.enabled,windowCount:windows.length,windowDestroyed:window.isDestroyed(),loading:window.webContents.isLoadingMainFrame(),
   trustedURL:['http://127.0.0.1:47831/','http://127.0.0.1:47831/index.html','http://127.0.0.1:47831/compatibility.html'].includes(window.webContents.getURL().split('#')[0]),
   visible:window.isVisible(),focused:window.isFocused(),webContentsFocused:window.webContents.isFocused()};
  const result=item.click(item,window,{});return {...facts,wrapperReturnType:typeof result};
 },id);
 diagnostic.menuInvoked=true;
 await page.waitForFunction(({id,before})=>{
  const last=window.__coconutNativeMenuObservation?.last;
  return last?.sequence>before&&last.command===id&&last.completed;
 },{id,before:before.sequence});
 Object.assign(diagnostic,await page.evaluate(()=>{const state=window.__coconutNativeMenuObservation;return {receipt:state.last,inputClicks:state.inputClicks,lastInput:state.lastInput};}));
 diagnostic.rendererReceived=true;
 return diagnostic.receipt;
}
