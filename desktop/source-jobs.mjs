/** One durable source/transcription queue. Python computes; it owns no task ledger. */
import {mkdir,lstat,open,readFile,writeFile,rename} from 'node:fs/promises';
import {createRequire} from 'node:module';
const Coconut=createRequire(import.meta.url)('../reader/core.js');
const {processingSnapshot,sourceSignature}=createRequire(import.meta.url)('../shared/transcript-resources.js');
import path from 'node:path';
import {Readable} from 'node:stream';
import {captionSource} from './caption-service.mjs';
import {PublicSourceError} from './public-http.mjs';
import {VideoSourceError,videoSourceErrorDetails} from './video-audio-service.mjs';
const localErrors=new WeakSet();
const fail=(message,status=400)=>{const error=Object.assign(Error(message),{status});localErrors.add(error);return error;};
const mediaConflicts=new Set(['Source document changed','Saved media changed','Saved media failed integrity check; explicitly download again to repair','Media save cancelled','Saved media was replaced','Saved media failed integrity check','Saved media or source changed']);
function storedErrorDetails(raw){try{return typeof raw==='string'&&raw.length<=2048?videoSourceErrorDetails(JSON.parse(raw)):null;}catch{return null;}}
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const TYPES={'audio/mpeg':'mp3','audio/mp4':'m4a','audio/wav':'wav','audio/ogg':'ogg','audio/flac':'flac','audio/webm':'webm','video/mp4':'mp4','video/webm':'webm'};
const ALIASES={'audio/mp3':'audio/mpeg','audio/x-m4a':'audio/mp4','audio/wave':'audio/wav','audio/x-wav':'audio/wav','audio/x-flac':'audio/flac'};
export async function createSourceJobs({directory,libraryStore,mediaStore,podcastSources,videoAudioService=null,transcriber,reviewer=null,reviewProvider='',reviewModel=''}){
 if(reviewProvider&&!['codex','kimi'].includes(reviewProvider))throw fail('转录后校对提供商无效');
 if(!path.isAbsolute(directory)||!libraryStore||!mediaStore)throw fail('Source tasks require an owned library',503);
 await mkdir(directory,{recursive:true,mode:0o700});
 async function privatePath(file,isDirectory=false){const stat=await lstat(file);if(stat.isSymbolicLink()||!(isDirectory?stat.isDirectory():stat.isFile())||!isDirectory&&stat.nlink!==1||process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid()))throw fail('Unsafe source task storage',503);}
 await privatePath(directory,true);const filename=path.join(directory,'source-jobs.sqlite');
 try{const handle=await open(filename,'wx',0o600);await handle.close();}catch(error){if(error.code!=='EEXIST')throw error;}
 for(const suffix of ['','-wal','-shm','-journal'])try{await privatePath(filename+suffix);}catch(error){if(error.code!=='ENOENT')throw error;}
 const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(filename);
 try{db.exec("PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, document_key TEXT NOT NULL, binding TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, request TEXT NOT NULL, operation TEXT, ingestion_id TEXT, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL); UPDATE jobs SET state='interrupted' WHERE state IN ('running','queued');");}catch(error){db.close();throw error;}
 for(const [name,definition] of [['phase',"TEXT NOT NULL DEFAULT ''"],['engine',"TEXT NOT NULL DEFAULT 'legacy'"],['error_details','TEXT']])if(!db.prepare('PRAGMA table_info(jobs)').all().some(column=>column.name===name))db.exec('ALTER TABLE jobs ADD COLUMN '+name+' '+definition);
 let admissionOwner=null,pendingAdmissions=0;
 let closing=false,creation=Promise.resolve(),shutdownPromise;
 // One I/O worker and one inference worker; never run two models together.
 const lanes=new Map();
 const laneFor=kind=>kind==='download'?'download':'inference';
 mediaStore.setCommitGuard(record=>{
  if(closing)throw fail('来源任务服务正在停止',503);
  const tasks=db.prepare("SELECT operation FROM jobs WHERE binding=? AND kind IN ('transcribe','align')").all(record.binding);
  if(tasks.some(value=>JSON.parse(value.operation).fingerprint!==record.sha256))throw fail('此项目已有绑定原声的转写任务。来源返回了不同音频，未替换旧原声；请另建项目核对新版本。',409);
 });
 const row=id=>{if(!uuid(id))throw fail('任务标识无效');const value=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);if(!value)throw fail('任务不存在',404);return value;};
 function recognitionSnapshot(document,binding){
  const download=db.prepare("SELECT operation FROM jobs WHERE binding=? AND kind='download' AND state='ready' ORDER BY updated DESC LIMIT 1").get(binding);
  const supplied=Coconut.transcriptionContext(document.transcription_context),acquired=download?.operation?Coconut.transcriptionContext(JSON.parse(download.operation).transcription_context):null;
  const context=supplied||acquired;
  return {title:document.title,...(context&&context.source_url===document.source_url?{transcription_context:context}:{}),
   ...(document.speaker_identity_evidence?{speaker_identity_evidence:document.speaker_identity_evidence}:{}),
   ...(document.transcription_glossary?{transcription_glossary:document.transcription_glossary}:{})};
 }
 function owned(value){if(mediaStore.owner(value.document_key).binding!==value.binding)throw fail('原项目来源已变化，旧任务不能接入此项目',409);return value;}
 function describe(value){
  const operation=value.operation?JSON.parse(value.operation):null,current=libraryStore.get(value.document_key)?.document;
  const matchingContext=value.kind!=='transcribe'||!operation?.recognition_document||current&&JSON.stringify(operation.recognition_document)===JSON.stringify(recognitionSnapshot(current,value.binding));
  return {id:value.id,documentKey:value.document_key,binding:value.binding,source:value.source,kind:value.kind,state:value.state,phase:value.phase,currentProfile:!['transcribe','align'].includes(value.kind)||value.engine==='direct-v1'&&JSON.stringify(operation.profile)===JSON.stringify(transcriber?.profile)&&Boolean(matchingContext),resultAvailable:['transcribe','align'].includes(value.kind)&&value.engine==='direct-v1'&&value.state==='ready',assetSha256:operation?.fingerprint||null,ingestionId:value.ingestion_id||null,error:value.error,error_details:storedErrorDetails(value.error_details),created:value.created,updated:value.updated};
 }
 function update(id,state,error=null,details=null){const safeDetails=videoSourceErrorDetails(details);db.prepare('UPDATE jobs SET state=?,error=?,error_details=?,updated=? WHERE id=?').run(state,error,safeDetails?JSON.stringify(safeDetails):null,Date.now(),id);}
 async function perform(value,signal){
  update(value.id,'running');
  try{
   owned(value);
   if(value.kind==='download'){
    const document=libraryStore.get(value.document_key).document,source=document.podcast_source;
    let media,consumed=false;
    const consume=async result=>{
     if(consumed)throw fail('原声任务重复提交媒体',409);
     owned(value);
     const type=ALIASES[result.type]||result.type,extension=TYPES[type]||({'audio/aac':'aac','video/ogg':'ogg','video/quicktime':'mov'})[type];
     if(!extension)throw fail('原声格式不受支持');
     const body=Buffer.isBuffer(result.body)?Readable.from([result.body]):result.body;
     await mediaStore.save(value.document_key,value.source,body,{type,name:'source.'+extension,signal,expectedSha256:result.sha256,expectedSize:result.size});
     consumed=true;
    };
    if(source?.media_url){
     const request=source.feed_url?{feedUrl:source.feed_url,episodeId:source.episode_id,mediaUrl:source.media_url}:{url:source.media_url};
     if(source.feed_url&&typeof document.source_url==='string'&&document.source_url.trim()&&['xiaoyuzhoufm.com','www.xiaoyuzhoufm.com'].includes(new URL(source.feed_url).hostname))request.episodeUrl=document.source_url;
     media=await podcastSources.downloadMedia(request,{signal,consume});
    }else{
     const video=videoSource(document);
     if(!video)throw fail('此项目没有可获取的原声');
     media=await videoAudioService.download({url:video.url,language:null,consent:true},{signal,purpose:'source',consume});
    }
    // Legacy adapters/test doubles return a Buffer instead of consuming a stream.
    if(!consumed)await consume(media);
    owned(value);
    const context=Coconut.transcriptionContext(media.source?.transcription_context||media.transcription_context);
    if(context?.source_url===document.source_url&&!signal.aborted&&!closing)db.prepare('UPDATE jobs SET operation=? WHERE id=?').run(JSON.stringify({transcription_context:context}),value.id);
    if(!signal.aborted&&!closing)update(value.id,'ready');return;
   }
   const operation=JSON.parse(value.operation);
   if(value.engine!=='direct-v1')throw fail('旧 Python 队列任务已保留；请明确重试以使用新的转录执行器',409);
   if(JSON.stringify(operation.profile)!==JSON.stringify(transcriber?.profile))throw fail('模型配置已变化，请为当前配置创建新任务',409);
   const input=await mediaStore.localInput(value.document_key,value.binding,operation.fingerprint);
   const workDirectory=path.join(directory,value.id);await mkdir(workDirectory,{recursive:true,mode:0o700});
   if(value.kind==='align'){
    if(sourceSignature(libraryStore.get(value.document_key).document)!==sourceSignature(operation.document))throw fail('原稿已变化，请创建新的对齐任务',409);
    await transcriber.align({inputPath:input.path,sha256:operation.fingerprint,workDirectory,document:operation.document,signal,onProgress:p=>{if(!closing&&!signal.aborted)db.prepare('UPDATE jobs SET phase=?,updated=? WHERE id=?').run(JSON.stringify(p),Date.now(),value.id);}});
    owned(value);await mediaStore.localInput(value.document_key,value.binding,operation.fingerprint);
    if(sourceSignature(libraryStore.get(value.document_key).document)!==sourceSignature(operation.document))throw fail('原稿已变化，对齐候选未应用',409);
    if(!signal.aborted&&!closing)update(value.id,'ready');return;
   }
   const currentDocument=libraryStore.get(value.document_key).document;
   let ownerDocument={...currentDocument,...(operation.recognition_document||recognitionSnapshot(currentDocument,value.binding))};
   const participants=Array.isArray(ownerDocument.speaker_identity_evidence?.speakers)?ownerDocument.speaker_identity_evidence.speakers.filter(s=>typeof s?.name==='string'&&s.name.trim()&&s.name.length<=80).slice(0,64):[];
   const terms=Array.isArray(ownerDocument.transcription_glossary)?ownerDocument.transcription_glossary.filter(t=>typeof t?.term==='string'&&t.term.trim()&&t.term.length<=80&&typeof t.source==='string'&&t.source.trim()).map(t=>t.term):[];
   const hotwords=[...new Set([...participants.map(s=>s.name),...terms])].slice(0,64),aliases=new Map();
   for(const participant of participants)for(const alias of Array.isArray(participant.verified_asr_aliases)?participant.verified_asr_aliases:[]){
    if(typeof alias!=='string'||alias===participant.name||alias.length<2||alias.length!==participant.name.length)continue;
    if(aliases.size>=64&&!aliases.has(alias))continue;
    aliases.set(alias,aliases.has(alias)&&aliases.get(alias)!==participant.name?null:participant.name);
   }
   const nameCorrections=Object.fromEntries([...aliases].filter(([alias,name])=>name&&!hotwords.includes(alias)));
   await transcriber.run({inputPath:input.path,sha256:operation.fingerprint,workDirectory,title:ownerDocument.title,context:ownerDocument.transcription_context,hotwords,nameCorrections,speakerCount:ownerDocument.speaker_identity_evidence?.expected_speakers,signal,
    onProgress:progress=>{if(!closing&&!signal.aborted)db.prepare("UPDATE jobs SET phase=?,updated=? WHERE id=? AND state='running'").run(JSON.stringify(progress),Date.now(),value.id);}});
   owned(value);await mediaStore.localInput(value.document_key,value.binding,operation.fingerprint);
   let raw=JSON.parse(await readFile(path.join(workDirectory,'result.json'),'utf8'));
   const document=Coconut.validate(raw);
   if(!Array.isArray(document.segments))throw fail('转录没有返回有效文字稿');
   raw={...raw,...(ownerDocument.transcription_context?{transcription_context:ownerDocument.transcription_context}:{})};
   if(operation.review&&reviewer){
    await writeFile(path.join(workDirectory,'original-asr.json'),JSON.stringify(raw),{mode:0o600});
    raw={...raw,title:ownerDocument.title,source_url:ownerDocument.source_url||raw.source_url||'',...(ownerDocument.speaker_identity_evidence?{speaker_identity_evidence:ownerDocument.speaker_identity_evidence}:{}),...(ownerDocument.transcription_glossary?{transcription_glossary:ownerDocument.transcription_glossary}:{}),...(ownerDocument.podcast_source?{podcast_source:ownerDocument.podcast_source}:{})};
    try{
     // Publisher text goes directly to ASR. Optional extraction now only helps
     // downstream name assignment/review, never delays recognition.
     if(reviewer.prepareContext)try{raw=await reviewer.prepareContext(raw,{directory:path.join(workDirectory,'context'),...operation.review,signal,onProgress:p=>{if(!closing&&!signal.aborted)db.prepare("UPDATE jobs SET phase=?,updated=? WHERE id=? AND state='running'").run(JSON.stringify(p),Date.now(),value.id);}});}
     catch(error){if(signal.aborted||closing)throw error;raw={...raw,transcription_context_status:'pending'};}
     if(reviewer.identifySpeakers)raw=await reviewer.identifySpeakers(raw,{directory:path.join(workDirectory,'speaker-identity'),...operation.review,signal,onProgress:p=>{if(!closing&&!signal.aborted)db.prepare('UPDATE jobs SET phase=?,updated=? WHERE id=?').run(JSON.stringify(p),Date.now(),value.id);}});
     const output=await reviewer.review(raw,{directory:path.join(workDirectory,'review'),...operation.review,signal,jobId:value.id,onProgress:p=>{if(!closing&&!signal.aborted)db.prepare('UPDATE jobs SET phase=?,updated=? WHERE id=?').run(JSON.stringify(p),Date.now(),value.id);}});
     raw=output.result;
    }catch(error){
     if(signal.aborted||closing)throw error;
     // Recognition remains usable when a text model is offline. Review can be
     // started separately on the imported document; ASR is never charged again.
     raw={...raw,provenance:{...raw.provenance,review_status:'pending',review_provider:operation.review.provider},transcript_review:{version:1,state:'pending',provider:operation.review.provider,error:String(error.message||'校对未完成').slice(0,300)}};
    }
    signal.throwIfAborted();await writeFile(path.join(workDirectory,'reviewed.tmp'),JSON.stringify(raw),{mode:0o600});await rename(path.join(workDirectory,'reviewed.tmp'),path.join(workDirectory,'result.json'));
   }
   else if(ownerDocument.transcription_context){await writeFile(path.join(workDirectory,'context-result.tmp'),JSON.stringify(raw),{mode:0o600});await rename(path.join(workDirectory,'context-result.tmp'),path.join(workDirectory,'result.json'));}
   if(!signal.aborted&&!closing)update(value.id,'ready');
  }catch(error){
   if(!closing&&!signal.aborted){
    const videoFailure=value.kind==='download'&&error instanceof VideoSourceError;
    const conflict=error?.status===409&&!videoFailure;
    let message='任务未完成，已保留处理进度。请检查本地环境后明确重试。';
    if(value.kind==='download'){
     message='原声下载未完成，请检查网络或来源后明确重试。';
     if(error instanceof PublicSourceError)message=error.code==='SOURCE_TIMEOUT'?'原声下载超过总时限，请检查网络后重试。':error.message.slice(0,300);
     if(videoFailure)message=error.message;
    }
    if(conflict)message=localErrors.has(error)||mediaConflicts.has(error?.message)?error.message:'原声或任务绑定发生冲突，请核对来源后明确重试。';
    update(value.id,conflict?'interrupted':'failed',message,videoFailure?error:null);
   }
  }
 }
 function pump(){
  if(closing)return;
  for(const value of db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created,id").all()){
   const lane=laneFor(value.kind);
   // Do not replace or re-fetch the same source while its inference is active.
   if(lanes.has(lane)||[...lanes.values()].some(active=>active.binding===value.binding))continue;
   const active={id:value.id,binding:value.binding,controller:new AbortController(),promise:null};
   lanes.set(lane,active);
   active.promise=perform(value,active.controller.signal).finally(()=>{lanes.delete(lane);pump();});
  }
 }
 function videoSource(document){
  if(!videoAudioService?.sourceAvailable)return null;
  try{const source=captionSource(document.source_url);return videoAudioService.providers?.includes(source.provider)?source:null;}catch{return null;}
 }
 async function createOne(data){
  if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);
  if(data?.protocolVersion!==1||!uuid(data.operation_id)||typeof data.key!=='string'||!data.key||data.key.length>1000||!['download','transcribe','align'].includes(data.kind)||data.consent!==true)throw fail('请明确确认此来源操作');
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
  if(data.kind==='download'){const document=libraryStore.get(data.key).document;if(!document.podcast_source?.media_url&&!videoSource(document))throw fail('此项目没有可获取的原声');}
  else{
   const record=await mediaStore.read(data.key,owner.binding);if(!record)throw fail('请先保存原声',409);
   if(existing){if(existing.engine==='direct-v1'&&JSON.parse(existing.operation).fingerprint===record.sha256&&JSON.stringify(JSON.parse(existing.operation).profile)===JSON.stringify(transcriber?.profile)&&(data.kind!=='transcribe'||JSON.stringify(JSON.parse(existing.operation).recognition_document)===JSON.stringify(recognitionSnapshot(libraryStore.get(data.key).document,owner.binding)))&&(data.kind!=='align'||sourceSignature(JSON.parse(existing.operation).document)===sourceSignature(libraryStore.get(data.key).document)))return describe(existing);if(['queued','running'].includes(existing.state))throw fail('旧原声仍有进行中的转写，请先核对原任务',409);}
   const extension=TYPES[record.type];if(!extension)throw fail('此原声格式暂不支持转写，请转换为 MP3/WAV/MP4 后导入',409);
   operation=JSON.stringify({operation_id:data.operation_id,filename:'source.'+extension,size:record.size,fingerprint:record.sha256,last_modified:0,language:'',profile:transcriber?.profile,...(data.kind==='align'?{document:processingSnapshot(libraryStore.get(data.key).document)}:{recognition_document:recognitionSnapshot(libraryStore.get(data.key).document,owner.binding)}),...(data.kind==='transcribe'&&reviewProvider?{review:{provider:reviewProvider,model:reviewModel}}:{})});
   const status=await (data.kind==='align'?transcriber?.alignmentStatus():transcriber?.status());if(!status?.available)throw fail(status?.message||'转写执行器尚未就绪',503);
  }
  if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);if(mediaStore.owner(data.key).binding!==owner.binding)throw fail('原项目来源已变化',409);
  const insert=()=>{const now=Date.now();db.prepare('INSERT INTO jobs (id,document_key,binding,source,kind,state,request,operation,created,updated,ingestion_id,engine) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(data.operation_id,data.key,owner.binding,owner.source,data.kind,'queued',request,operation,now,now,['transcribe','align'].includes(data.kind)?data.operation_id.replaceAll('-',''):null,'direct-v1');};
  if(operation)await mediaStore.exclusive(async()=>{if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);const current=await mediaStore.read(data.key,owner.binding);if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);if(!current||current.sha256!==JSON.parse(operation).fingerprint)throw fail('原声已变化，请重新确认',409);insert();});else insert();
  const receipt=describe(row(data.operation_id));pump();return receipt;
 }
 function create(data){pendingAdmissions++;const next=creation.then(()=>createOne(data));creation=next.catch(()=>{});return next.finally(()=>{pendingAdmissions--;});}
 async function get(id){return describe(row(id));}
 async function list(key){if(typeof key!=='string'||key.length>1000)throw fail('项目标识无效');const binding=mediaStore.owner(key).binding;return db.prepare('SELECT * FROM jobs WHERE binding=? ORDER BY created DESC LIMIT 20').all(binding).map(describe);}
 async function action(id,action){
  if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);
  let value=owned(row(id));
  if(action==='cancel'){
   if(!['queued','running','interrupted'].includes(value.state))throw fail('此任务不能取消',409);
   update(id,'cancelled');
   for(const active of lanes.values())if(active.id===id)active.controller.abort();
  }else if(action==='retry'){
   if(!['failed','interrupted','cancelled'].includes(value.state)&&!(value.kind==='download'&&value.state==='ready'))throw fail('请查看原任务状态',409);
   if(['transcribe','align'].includes(value.kind)){
    const media=await mediaStore.read(value.document_key,value.binding);if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);if(!media||media.sha256!==JSON.parse(value.operation).fingerprint)throw fail('原声已经替换，请为当前原声明确创建新转写',409);
    const status=await (value.kind==='align'?transcriber?.alignmentStatus():transcriber?.status());if(!status?.available)throw fail(status?.message||'本地转录未就绪',503);
    if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);
    const operation={...JSON.parse(value.operation),profile:transcriber.profile};
    if(value.engine==='direct-v1'&&JSON.stringify(JSON.parse(value.operation).profile)!==JSON.stringify(transcriber.profile))throw fail('模型配置已变化，请创建新任务',409);
    db.prepare("UPDATE jobs SET operation=?,engine='direct-v1',ingestion_id=? WHERE id=?").run(JSON.stringify(operation),id.replaceAll('-',''),id);
   }
   if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);
   update(id,'queued');pump();
  }else throw fail('任务操作无效');return describe(row(id));
 }
 async function result(id){
  const value=owned(row(id));if(!['transcribe','align'].includes(value.kind)||value.state!=='ready')throw fail('文字稿尚未完成',409);
  if(value.engine!=='direct-v1')throw fail('旧任务结果仍保存在原 Python 数据目录，请从原服务导出文字稿',409);
  const operation=JSON.parse(value.operation);await mediaStore.localInput(value.document_key,value.binding,operation.fingerprint);
  const raw=JSON.parse(await readFile(path.join(directory,id,'result.json'),'utf8'));
  if(value.kind==='align'){
   if(sourceSignature(libraryStore.get(value.document_key).document)!==sourceSignature(operation.document))throw fail('原稿已变化，旧对齐候选未应用',409);
   Coconut.validate(raw.document);owned(value);return {job:describe(value),alignment:{...raw,input:operation.document}};
  }
  const document={...raw,...Coconut.validate(raw)};owned(value);
  return {job:describe(value),ingestion:{id:value.ingestion_id,state:'ready',transcript:{document}}};
 }
 function shutdown(){return shutdownPromise??=(async()=>{closing=true;for(const active of lanes.values())active.controller.abort();await creation;await Promise.all([...lanes.values()].map(active=>active.promise));db.prepare("UPDATE jobs SET state='interrupted' WHERE state IN ('running','queued')").run();db.close();})();}
 function activity(){return {active:pendingAdmissions+db.prepare("SELECT count(*) AS count FROM jobs WHERE state IN ('running','queued')").get().count};}
 function pauseAdmission(id){if(admissionOwner!==null&&admissionOwner!==id)return false;admissionOwner=id;return true;}
 function resumeAdmission(id){if(admissionOwner===id)admissionOwner=null;}
 async function trackedAction(id,operation){pendingAdmissions++;try{return await action(id,operation);}finally{pendingAdmissions--;}}
 pump();return {create,get,list,action:trackedAction,result,shutdown,activity,pauseAdmission,resumeAdmission};
}
