/** Open the visible native disclosure before interacting with a secondary cue
 * action. Never force a click on a hidden action in browser acceptance. */
export async function openCueActions(row) {
 const details=row.locator('.cue-more');
 if(await details.count()&&!await details.evaluate(node=>node.open))await details.locator('summary').click();
}
