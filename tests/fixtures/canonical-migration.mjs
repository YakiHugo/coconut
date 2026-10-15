/** Authored fixture: no user content. Shared server/client migration contract. */
export const sourceId='11111111-1111-4111-8111-111111111111';
export const mediaLibraryIdentity='22222222-2222-4222-8222-222222222222';
export const migrationId='33333333-3333-4333-8333-333333333333';
export function recoveryFixture(){return {ok:true,format:'coconut-storage-recovery',version:1,database:'authored-browser',stores:{
 meta:[{key:'state',value:{status:'ready',nextOrder:3}},{key:'canonical-source-id',value:sourceId},{key:'desktop-media-library',value:mediaLibraryIdentity}],
 documents:[{key:'live',value:{envelopeVersion:1,key:'live',epoch:2,revision:5,generation:7,mutationId:'browser:7',payload:{key:'live',title:'Authored source',segments:[{id:'cue',text:'Original'}],notes:{cue:'Private authored note'},translations:{en:'Authored translation'},custom:{preserve:true}}}}],
 catalog:[{key:'live',value:{key:'live',epoch:2,revision:5,order:1,title:'Authored source'}}],
 tombstones:[{key:'removed',value:{envelopeVersion:1,key:'removed',epoch:1,revision:2,generation:8,mutationId:'browser:8',deleted:true,order:2}}],
 legacySnapshots:[{key:'legacy-v1',value:{raw:'{"documents":[]}',sourceHash:'authored-retained-snapshot'}}]
}};}
