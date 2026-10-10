/** Navigate the real mobile disclosure; desktop tool positions are unchanged. */
export async function openLibraryTools(page){
 const toggle=page.locator('#toggle-library');
 if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
 const tools=page.locator('#library-tools');
 if(await tools.isVisible()&&!await tools.evaluate(node=>node.open))await tools.locator(':scope > summary').click();
}
