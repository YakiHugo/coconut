/** Use the native search dialog. Never force-click its inert sidebar. */
export async function openLibrarySearch(page,{filters=false}={}){
 const dialog=page.locator('#library-search-dialog');
 if(!await dialog.evaluate(node=>node.open))await page.locator('#open-library-search').click();
 await dialog.waitFor({state:'visible'});
 await page.locator('#library-search').waitFor({state:'visible'});
 await page.locator('#library-scope').waitFor({state:'visible'});
 if(filters){
  const disclosure=page.locator('#library-search-filters');
  if(!await disclosure.evaluate(node=>node.open))await disclosure.locator(':scope > summary').click();
 }
}
export async function closeLibrarySearch(page){
 const dialog=page.locator('#library-search-dialog');
 if(await dialog.evaluate(node=>node.open))await page.locator('#close-library-search').click();
 await dialog.waitFor({state:'hidden'});
}

/** Serializable predicate: CSS can cross the breakpoint before the MQL callback. */
export function libraryToolsLayoutReady(_=null,root=document){
 const mobile=root.defaultView.matchMedia('(max-width: 650px)').matches;
 const tools=root.getElementById('library-tools'),content=root.getElementById('library-tools-content'),home=root.getElementById('library-list');
 const nodes=[root.getElementById('open-library-notebook'),root.querySelector('.library-backup'),root.getElementById('library-options'),root.getElementById('library-pagination')];
 return !!(tools&&content&&home&&tools.hidden===!mobile&&nodes.every(node=>node&&node.parentElement===(mobile?content:home)));
}

/** Close search first, then wait for actual responsive ownership before management. */
export async function openLibraryTools(page){
 await closeLibrarySearch(page);
 await page.waitForFunction(libraryToolsLayoutReady);
 const toggle=page.locator('#toggle-library');
 if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
 const tools=page.locator('#library-tools');
 if(await tools.isVisible()&&!await tools.evaluate(node=>node.open))await tools.locator(':scope > summary').click();
}
