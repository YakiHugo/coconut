/** Authored acceptance hook, installed before app/bootstrap create their adapter.
 * The production adapter stays frozen; held writes eventually call its real
 * write method with the original serialized value and cancellation signal. */
export function installSelectedBackupWriteProbe(scope) {
 const api=scope.CoconutLibraryStore,createLegacyAdapter=api.createLegacyAdapter;
 const proof=scope.selectedBackupWriteProof={hold:false,writes:[],created:0,captures:0,releases:0};
 api.createLegacyAdapter=options=>{
  const adapter=createLegacyAdapter(options);proof.created++;proof.originalFrozen=Object.isFrozen(adapter);
  const write=(value,options)=>{
   proof.captures++;
   if(!proof.hold)return adapter.write(value,options);
   return new Promise(resolve=>{let released=false;proof.writes.push({commit(){
    if(released)throw new Error('Held acceptance write already released');
    released=true;proof.releases++;resolve(adapter.write(value,options));
   }});});
  };
  const wrapped=Object.freeze({...adapter,write});proof.write=write;proof.wrapperFrozen=Object.isFrozen(wrapped);return wrapped;
 };
}
