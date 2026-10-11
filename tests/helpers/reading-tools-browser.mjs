// Follow the actual reading disclosure before interacting with a short phone
// transcript's controls. Wide/long readers and already-open tools stay unchanged.
export async function openTranscriptTools(page){
 const label=page.locator('#transcript-tools-label');
 if(await label.isVisible()&&!await page.locator('#transcript-tools-disclosure').evaluate(node=>node.open))await label.click();
}
