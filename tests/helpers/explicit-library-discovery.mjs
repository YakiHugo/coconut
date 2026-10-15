/** The browser test grants one read only while explicitly opening backup tools.
 * Never a startup/restore allowance, API-prefix allowlist, or write permission.
 */
export function isExplicitLibraryDiscovery({url,method,body},origin,armed){
 const target=new URL(url);
 return armed===true&&method==='GET'&&body===null&&target.origin===origin&&
  target.username===''&&target.password===''&&target.pathname==='/api/v1/library'&&target.search===''&&target.hash==='';
}
