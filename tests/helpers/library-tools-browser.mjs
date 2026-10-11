/** Serializable predicate: CSS can cross the breakpoint before the MQL callback. */
export function libraryToolsLayoutReady(_=null,root=document){
 const mobile=root.defaultView.matchMedia('(max-width: 650px)').matches;
 const tools=root.getElementById('library-tools'),content=root.getElementById('library-tools-content'),home=root.getElementById('library-list');
 const nodes=[root.getElementById('open-library-notebook'),root.querySelector('.library-backup'),root.getElementById('library-options'),root.getElementById('library-pagination')];
 return !!(tools&&content&&home&&tools.hidden===!mobile&&nodes.every(node=>node&&node.parentElement===(mobile?content:home)));
}

/** Navigate the real mobile disclosure only after its tool ownership is ready. */
export async function openLibraryTools(page){
 await page.waitForFunction(libraryToolsLayoutReady);
 const toggle=page.locator('#toggle-library');
 if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
 const tools=page.locator('#library-tools');
 if(await tools.isVisible()&&!await tools.evaluate(node=>node.open))await tools.locator(':scope > summary').click();
}
