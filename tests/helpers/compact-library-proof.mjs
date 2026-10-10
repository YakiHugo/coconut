/** Serializable browser predicate: only the rendered result owned by this query counts. */
export function compactShelfResultReady({query,key,count},root=document){
 const host=root.getElementById('library'),input=root.getElementById('library-search');
 if(!host||!input)return false;
 const cards=host.querySelectorAll('.library-entry');
 return input.value===query&&!host.hidden&&host.getAttribute('aria-busy')==='false'&&cards.length===count&&cards[0]?.dataset.documentKey===key;
}
