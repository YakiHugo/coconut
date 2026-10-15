import {LIBRARY_BODY_BYTES,libraryError} from './library-store.mjs';
/** Called only after the bridge's host, origin and Fetch Metadata checks. */
export async function handleLibraryRequest({req,pathname,origin,json,store,unavailable}){
  if(!pathname.startsWith('/api/v1/library'))return false;
  const fail=(status,code,message)=>{json(status,{protocolVersion:1,code,error:message});return true;};
  try{
    if(pathname==='/api/v1/library/migration'&&req.method!=='GET')return fail(410,'migration_retired','Browser migration has been retired; preserve and export browser recovery data.');
    if(req.method==='GET'&&pathname==='/api/v1/library'){
      json(200,store?.describe()||{protocolVersion:1,enabled:false,browserMigration:'not_started',...(unavailable?{unavailable}:{})});return true;
    }
    if(!['/api/v1/library/catalog','/api/v1/library/document','/api/v1/library/commit','/api/v1/library/batch','/api/v1/library/migration'].includes(pathname))return fail(404,'not_found','Unknown library endpoint');
    if(!store)return fail(503,unavailable?.code||'library_disabled','Canonical library is unavailable; browser data remains unchanged');
    if(req.method==='GET'&&!['/api/v1/library/commit','/api/v1/library/batch'].includes(pathname)){
      const params=new URL(req.url,origin).searchParams;
      // Reads are explicitly versioned too, so future clients cannot silently downgrade.
      if(params.get('protocolVersion')!=='1')return fail(400,'invalid_request','Library protocolVersion=1 required');
      if(pathname.endsWith('/migration')){if(params.has('index')){json(200,store.migration.readChunk(params.get('migrationId'),Number(params.get('index'))));return true;}const status=store.migration.status(params.get('migrationId'));json(status?200:404,status||{protocolVersion:1,epoch:store.describe().epoch,state:'absent'});return true;}
      if(pathname.endsWith('/document')){const record=store.get(params.get('key'));json(record?200:404,{protocolVersion:1,record});return true;}
      if(params.get('after')&&(!params.has('sequence')||!params.has('epoch')))return fail(400,'invalid_request','Continuation requires epoch and sequence');
      const page=store.list({limit:params.has('limit')?Number(params.get('limit')):50,after:params.get('after')||'',expectedSequence:params.has('sequence')?Number(params.get('sequence')):undefined});
      if(params.has('epoch')&&params.get('epoch')!==page.epoch)throw libraryError('epoch_conflict','Library identity changed',409);
      json(200,{protocolVersion:1,...page});return true;
    }
    if(req.method!=='POST'||!['/api/v1/library/commit','/api/v1/library/batch','/api/v1/library/migration'].includes(pathname))return fail(405,'method_not_allowed','Method not allowed');
    if(req.headers.origin!==origin)return fail(403,'origin_required','Same-origin request required');
    if(req.headers['content-type']?.split(';')[0]!=='application/json')return fail(400,'invalid_request','Use application/json');
    const declared=req.headers['content-length'];
    if(declared&&(!/^\d+$/.test(declared)||Number(declared)>LIBRARY_BODY_BYTES)){req.resume();return fail(413,'request_too_large','Request exceeds library byte budget');}
    const chunks=[];let bytes=0;
    for await(const chunk of req){bytes+=chunk.length;if(bytes>LIBRARY_BODY_BYTES)return fail(413,'request_too_large','Request exceeds library byte budget');chunks.push(chunk);}
    let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{return fail(400,'invalid_request','Invalid JSON');}
    json(200,pathname.endsWith('/migration')?store.migration.request(data):pathname.endsWith('/batch')?store.commitBatch(data):store.commit(data));return true;
  }catch(error){return fail(error.status||503,error.libraryCode||'library_unavailable',error.libraryCode?error.message:'Library operation failed; no save receipt was issued');}
}
