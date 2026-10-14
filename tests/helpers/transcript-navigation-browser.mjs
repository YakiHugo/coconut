/** Exercise the shipped navigation surface rather than hidden legacy controls. */
export async function navigateReadingTime(page,seconds){
 await page.locator('#open-transcript-navigator').click();
 await page.locator('#navigator-time').fill(String(seconds));
 await page.locator('#navigator-time').press('Enter');
 await page.locator('#transcript-navigator-dialog').waitFor({state:'hidden'});
}
export async function navigateReadingStop(page,id){
 await page.locator('#open-transcript-navigator').click();
 const dialog=page.locator('#transcript-navigator-dialog');
 const previous=dialog.getByRole('button',{name:'前面的原文'}),next=dialog.getByRole('button',{name:'后面的原文'});
 const move=async button=>{
  const before=await dialog.locator('[data-cue-id]').first().getAttribute('data-cue-id');await button.click();
  await page.waitForFunction(before=>document.querySelector('#transcript-navigator-dialog [data-cue-id]')?.dataset.cueId!==before,before);
 };
 // The source IDs are authored test data. Click the exact displayed row rather
 // than rounding its timestamp (multiple cues can share the same second).
 while(!await previous.isDisabled())await move(previous);
 while(true){
  const index=await dialog.locator('[data-cue-id]').evaluateAll((nodes,id)=>nodes.findIndex(node=>node.dataset.cueId===id),id);
  if(index>=0){await dialog.locator('[data-cue-id]').nth(index).click();break;}
  if(await next.isDisabled())throw Error('Missing authored navigation stop: '+id);
  await move(next);
 }
 await dialog.waitFor({state:'hidden'});
}
