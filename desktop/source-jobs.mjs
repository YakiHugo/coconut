/** Server-owned source acquisition. ASR work stays in the existing import queue. */
import {mkdir,lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const TYPES={'audio/mpeg':'mp3','audio/mp4':'m4a','audio/wav':'wav','audio/ogg':'ogg','audio/flac':'flac','audio/webm':'webm','video/mp4':'mp4','video/webm':'webm'};
const ALIASES={'audio/mp3':'audio/mpeg','audio/x-m4a':'audio/mp4','audio/wave':'audio/wav','audio/x-wav':'audio/wav','audio/x-flac':'audio/flac'};
export async function createSourceJobs({directory,libraryStore,mediaStore,podcastSources,executor}){
 if(!path.isAbsolute(directory)||!libraryStore||!mediaStore)throw fail('Source tasks require an owned library',503);
 await mkdir(directory,{recursive:true,mode:0o700});
 async function privatePath(file,isDirectory=false){const stat=await lstat(file);if(stat.isSymbolicLink()||!(isDirectory?stat.isDirectory():stat.isFile())||!isDirectory&&stat.nlink!==1||process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid()))throw fail('Unsafe source task storage',503);}
 await privatePath(directory,true);const filename=path.join(directory,'source-jobs.sqlite');
 try{const handle=await open(filename,'wx',0o600);await handle.close();}catch(error){if(error.code!=='EEXIST')throw error;}
 for(const suffix of ['','-wal','-shm','-journal'])try{await privatePath(filename+suffix);}catch(error){if(error.code!=='ENOENT')throw error;}
 const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(filename);
 try{db.exec("PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, document_key TEXT NOT NULL, binding TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, request TEXT NOT NULL, operation TEXT, ingestion_id TEXT, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL); UPDATE jobs SET state='interrupted' WHERE state='running';");}catch(error){db.close();throw error;}
 let closing=false,running=null,runningId=null,controller=null,creation=Promise.resolve(),shutdownPromise;
 const row=id=>{if(!uuid(id))throw fail('任务标识无效');const value=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);if(!value)throw fail('任务不存在',404);return value;};
 function owned(value){if(mediaStore.owner(value.document_key).binding!==value.binding)throw fail('原项目来源已变化，旧任务不能接入此项目',409);return value;}
 function describe(value){return {id:value.id,documentKey:value.document_key,binding:value.binding,source:value.source,kind:value.kind,state:value.state,assetSha256:value.operation?JSON.parse(value.operation).fingerprint:null,ingestionId:value.ingestion_id||null,error:value.error,created:value.created,updated:value.updated};}
 function update(id,state,error=null){db.prepare('UPDATE jobs SET state=?,error=?,updated=? WHERE id=?').run(state,error,Date.now(),id);}
 function bindIngestion(id,job){db.prepare('UPDATE jobs SET ingestion_id=?,state=?,error=?,updated=? WHERE id=?').run(job.id,['queued','running'].includes(job.state)?'running':job.state,job.error?.message||null,Date.now(),id);}
 async function perform(value){
  controller=new AbortController();const signal=controller.signal;update(value.id,'running');
  try{
   owned(value);
   if(value.kind==='download'){
    const source=libraryStore.get(value.document_key).document.podcast_source;
    if(!source?.media_url)throw fail('此项目没有可获取的播客原声');
    const request=source.feed_url?{feedUrl:source.feed_url,episodeId:source.episode_id,mediaUrl:source.media_url}:{url:source.media_url};
    const media=await podcastSources.downloadMedia(request,{signal});owned(value);
    const type=ALIASES[media.type]||media.type,extension=TYPES[type]||({'audio/aac':'aac','video/ogg':'ogg','video/quicktime':'mov'})[type];
    if(!extension)throw fail('原声格式不受支持');
    await mediaStore.save(value.document_key,value.source,Readable.from([media.body]),{type,name:'source.'+extension,signal});
    if(!signal.aborted&&!closing)update(value.id,'ready');return;
   }
   const operation=JSON.parse(value.operation);let job;
   try{job=await executor.recover(operation,{signal});}catch(error){if(error.taskCode!=='ingestion_operation_not_found')throw error;}
   if(!job){
    const input=await mediaStore.input(value.document_key,value.binding,operation.fingerprint);
    try{input.body.headers={'content-length':String(operation.size),'content-type':'application/octet-stream'};job=await executor.upload(input.body,{...operation,signal});}finally{input.body.destroy();await input.close();}
   }
   if(!closing&&!signal.aborted)bindIngestion(value.id,job);
  }catch(error){if(!closing&&!signal.aborted)update(value.id,'interrupted',error.status===409?error.message:'任务未完成。已保留原操作，请检查服务后明确重试；不会自动重新下载或识别。');}
  finally{controller=null;}
 }
 function pump(){if(closing||running)return;const value=db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created,id LIMIT 1").get();if(!value)return;runningId=value.id;running=perform(value).finally(()=>{running=null;runningId=null;pump();});}
 async function createOne(data){
  if(closing)throw fail('服务正在停止',503);
  if(data?.protocolVersion!==1||!uuid(data.operation_id)||typeof data.key!=='string'||!data.key||data.key.length>1000||!['download','transcribe'].includes(data.kind)||data.consent!==true)throw fail('请明确确认此来源操作');
  const owner=mediaStore.owner(data.key);if(data.libraryId!==libraryStore.describe().epoch)throw fail('所连接的书架已变化，请刷新后核对',409);
  if(data.source!==owner.source)throw fail('原项目来源已变化',409);
  const request=JSON.stringify({key:data.key,source:data.source,kind:data.kind});
  const previous=db.prepare('SELECT * FROM jobs WHERE id=?').get(data.operation_id);
  if(previous){if(previous.request!==request||previous.binding!==owner.binding)throw fail('此操作已绑定另一份来源',409);return describe(previous);}
  // Reuse the original task across browsers, including uncertain upload receipts.
  const existing=db.prepare('SELECT * FROM jobs WHERE binding=? AND kind=? ORDER BY created DESC,rowid DESC LIMIT 1').get(owner.binding,data.kind);
  if(existing&&data.kind==='download')return describe(existing);
  if(db.prepare('SELECT count(*) AS count FROM jobs').get().count>=256)throw fail('来源任务已达保存上限，请保留书架备份并检查服务存储',409);
  let operation=null;
  if(data.kind==='download'){if(!libraryStore.get(data.key).document.podcast_source?.media_url)throw fail('此项目没有播客原声');}
  else{
   const record=await mediaStore.read(data.key,owner.binding);if(!record)throw fail('请先保存原声',409);
   if(existing){if(JSON.parse(existing.operation).fingerprint===record.sha256)return describe(existing);if(['queued','running'].includes(existing.state))throw fail('旧原声仍有进行中的转写，请先核对原任务',409);}
   const extension=TYPES[record.type];if(!extension)throw fail('此原声格式暂不支持转写，请转换为 MP3/WAV/MP4 后导入',409);
   operation=JSON.stringify({operation_id:data.operation_id,filename:'source.'+extension,size:record.size,fingerprint:record.sha256,last_modified:0,language:''});
   const status=await executor.status();if(!status.available)throw fail(status.message||'转写执行器尚未就绪',503);
  }
  if(closing)throw fail('服务正在停止',503);if(mediaStore.owner(data.key).binding!==owner.binding)throw fail('原项目来源已变化',409);
  const now=Date.now();db.prepare('INSERT INTO jobs (id,document_key,binding,source,kind,state,request,operation,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?)').run(data.operation_id,data.key,owner.binding,owner.source,data.kind,'queued',request,operation,now,now);
  const receipt=describe(row(data.operation_id));pump();return receipt;
 }
 function create(data){const next=creation.then(()=>createOne(data));creation=next.catch(()=>{});return next;}
 async function reconcile(value){
  if(value.kind!=='transcribe'||!['interrupted','queued','running'].includes(value.state)||runningId===value.id)return value;
  try{owned(value);const job=await executor.recover(JSON.parse(value.operation));if(!closing)bindIngestion(value.id,job);}catch{}return row(value.id);
 }
 async function get(id){return describe(await reconcile(row(id)));}
 async function list(key){if(typeof key!=='string'||key.length>1000)throw fail('项目标识无效');const binding=mediaStore.owner(key).binding,values=db.prepare('SELECT * FROM jobs WHERE binding=? ORDER BY created DESC LIMIT 20').all(binding);return Promise.all(values.map(value=>get(value.id)));}
 async function action(id,action){
  let value=owned(await reconcile(row(id)));
  if(action==='cancel'){
   if(!['queued','running','interrupted'].includes(value.state))throw fail('此任务不能取消',409);
   if(value.kind==='transcribe'&&!value.ingestion_id){
    let absent=false;try{const job=await executor.recover(JSON.parse(value.operation));bindIngestion(id,job);}catch(error){if(error.taskCode!=='ingestion_operation_not_found')throw error;absent=true;}
    value=row(id);
    if(!value.ingestion_id&&!(absent&&value.state==='queued'&&runningId!==id))throw fail('正在核对执行器接收回执，请稍后刷新再取消',409);
   }
   if(value.ingestion_id){const job=await executor.action(value.ingestion_id,'cancel');if(!closing)bindIngestion(id,job);}
   else update(id,'cancelled');
   if(runningId===id&&row(id).state==='cancelled')controller?.abort();
  }else if(action==='retry'){
   if(!['failed','interrupted','cancelled'].includes(value.state)&&!(value.kind==='download'&&value.state==='ready'))throw fail('请查看原任务状态',409);
   if(value.kind==='transcribe'){
    const media=await mediaStore.read(value.document_key,value.binding);if(!media||media.sha256!==JSON.parse(value.operation).fingerprint)throw fail('原声已经替换，请为当前原声明确创建新转写',409);
    // Recover the durable upload identity before deciding whether work is absent.
    let job;try{job=await executor.recover(JSON.parse(value.operation));}catch(error){if(error.taskCode!=='ingestion_operation_not_found')throw error;}
    if(job){if(['failed','interrupted','cancelled'].includes(job.state))job=await executor.action(job.id,'retry');bindIngestion(id,job);if(job.state==='ready')return describe(row(id));}
   }
   if(closing)throw fail('服务正在停止',503);update(id,'queued');pump();
  }else throw fail('任务操作无效');return describe(row(id));
 }
 async function result(id){const value=owned(await reconcile(row(id)));if(value.kind!=='transcribe'||value.state!=='ready'||!value.ingestion_id)throw fail('文字稿尚未完成',409);const ingestion=await executor.result(value.ingestion_id);owned(value);const media=await mediaStore.read(value.document_key,value.binding);if(!media||media.sha256!==JSON.parse(value.operation).fingerprint)throw fail('原声已经替换，旧文字稿不能接入当前原声',409);return {job:describe(value),ingestion};}
 function shutdown(){return shutdownPromise??=(async()=>{closing=true;controller?.abort();await creation;if(running)await running;db.prepare("UPDATE jobs SET state='interrupted' WHERE state='running'").run();db.close();})();}
 pump();return {create,get,list,action,result,shutdown};
}
