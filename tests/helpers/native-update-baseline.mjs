/** Receipt-bound setup for the isolated native delayed-write assertion. */
import assert from 'node:assert/strict';

export async function prepareNativeNoteBaseline(page){
 await page.locator('#mode-transcript').click();
 await page.locator('.segment .note-button').first().click();
 // Switching the bilingual sample to source-only is a real content write.
 // Finish that setup generation before capturing what a held note must preserve.
 const prepared=await page.evaluate(async()=>({
  ok:(await libraryStore.flush()).ok,
  unsaved:libraryStore.status().unsaved,
  key:active().key,
 }));
 assert.equal(prepared.ok,true,'native note setup must receive a successful persistence receipt');
 assert.equal(prepared.unsaved,0,'native note setup must have no outstanding content writes');
 const baseline=await page.evaluate(()=>window.readPersistedLibrary());
 assert.equal(baseline.documents.find(doc=>doc.key===prepared.key)?.translation_view,'',
  'the source-only display choice must be persisted before holding note writes');
 return baseline;
}
