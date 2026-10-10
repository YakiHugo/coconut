/** Authored data only. Document count is independent of the number mounted on the shelf. */
export function largeLibraryFixture(count=1001,{cues=8}={}){
 return Array.from({length:count},(_,i)=>({
  key:'shelf-'+i,schema_version:1,title:'Authored shelf '+String(i).padStart(5,'0')+' · 完整书架标题',language:'en',source_url:'',notes:{},
  segments:Array.from({length:cues},(_,j)=>({id:'shelf-'+i+'-cue-'+j,start:j*2,end:j*2+1,text:'Authored document '+i+', source sentence '+j+'.'})),
 }));
}
