/** One durable source/transcription queue. Python computes; it owns no task ledger. */
import {mkdir,lstat,open,readFile,writeFile,rename,readdir,unlink} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),Coconut=require('../reader/core.js');
const {project}=require('../reader/canonical-library.js');
const {processingSnapshot,sourceSignature}=require('../shared/transcript-resources.js');
const {mergeAlignmentCandidate}=require('../shared/source-alignment.js');
import {attachTranscript} from '../shared/attach-transcript.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
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
export async function createSourceJobs({directory,libraryStore,mediaStore,podcastSources,videoAudioService=null,captionService=null,cleanReadingJobs=null,transcriber,reviewer=null,reviewProvider='',reviewModel=''}){
 if(reviewProvider&&!['codex','kimi','claude'].includes(reviewProvider))throw fail('转录后校对提供商无效');
 if(!path.isAbsolute(directory)||!libraryStore||!mediaStore)throw fail('Source tasks require an owned library',503);
 await mkdir(directory,{recursive:true,mode:0o700});
 async function privatePath(file,isDirectory=false,allowShared=false){const stat=await lstat(file);if(stat.isSymbolicLink()||!(isDirectory?stat.isDirectory():stat.isFile())||!isDirectory&&!allowShared&&stat.nlink!==1||process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid()))throw fail('Unsafe source task storage',503);}
 await privatePath(directory,true);const filename=path.join(directory,'source-jobs.sqlite');
 try{const handle=await open(filename,'wx',0o600);await handle.close();}catch(error){if(error.code!=='EEXIST')throw error;}
 for(const suffix of ['','-wal','-shm','-journal'])try{await privatePath(filename+suffix);}catch(error){if(error.code!=='ENOENT')throw error;}
 const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(filename);
 try{db.exec("PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, document_key TEXT NOT NULL, binding TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, request TEXT NOT NULL, operation TEXT, ingestion_id TEXT, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL); UPDATE jobs SET state='interrupted' WHERE state IN ('running','queued');");}catch(error){db.close();throw error;}
 for(const [name,definition] of [['phase',"TEXT NOT NULL DEFAULT ''"],['engine',"TEXT NOT NULL DEFAULT 'legacy'"],['error_details','TEXT'],['document_revision','INTEGER']])if(!db.prepare('PRAGMA table_info(jobs)').all().some(column=>column.name===name))db.exec('ALTER TABLE jobs ADD COLUMN '+name+' '+definition);
 // Only private generated attempt audio is disposable after an unclean stop.
 async function cleanAttemptAudio(folder){
  let entries;try{await privatePath(folder,true);entries=await readdir(folder,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
  for(const entry of entries){const file=path.join(folder,entry.name);if(entry.isSymbolicLink())throw fail('Unsafe source task storage',503);if(entry.isDirectory())await cleanAttemptAudio(file);else if(entry.isFile()&&(/\.(wav|partial)$/.test(entry.name)||/^(?:[a-f0-9]{64}|sealed-source)\.media$/.test(entry.name))){
   // A job can retain a private link to the same normalized PCM as other jobs.
   await privatePath(file,false,entry.name==='audio.wav'||entry.name==='audio.cache.partial.wav');await unlink(file);
  }}
 }
 for(const task of db.prepare("SELECT id FROM jobs WHERE kind='download_transcribe' AND state='interrupted'").all())if(uuid(task.id))await cleanAttemptAudio(path.join(directory,task.id,'attempts'));
 db.exec('CREATE TABLE IF NOT EXISTS job_receipts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, request TEXT NOT NULL, binding TEXT NOT NULL)');
 let admissionOwner=null,pendingAdmissions=0;
 let closing=false,creation=Promise.resolve(),shutdownPromise;
 // One I/O worker and one inference worker; never run two models together.
 const lanes=new Map(),listeners=new Set(),handoffs=new Map();
 const emit=(key,type='source-job',details={})=>{for(const listener of listeners)listener({key,type,...details});};
 const lastJob=(binding,kind)=>db.prepare('SELECT * FROM jobs WHERE binding=? AND kind=? ORDER BY created DESC,rowid DESC LIMIT 1').get(binding,kind);
 const publishResult=value=>JSON.parse(value.request).saveResult===true;
 const autoDownload=value=>JSON.parse(value.request).automatic===true;
 const videoTitle=video=>(video.provider==='youtube'?'YouTube':'B 站')+' '+video.mediaId;
 const laneFor=kind=>kind==='download_transcribe'?['download','inference']:[kind==='download'?'download':kind==='captions'?'captions':'inference'];
 const combined=kind=>kind==='download_transcribe';
 const requireMissingTranscript=(kind,document)=>{
  if((kind==='transcribe'||combined(kind))&&document.segments.length)throw fail('此项目已有文字稿，请使用已有稿对齐',409);
 };
 const userSnapshot=document=>({title:document.title,transcription_context:document.transcription_context||null,speaker_identity_evidence:document.speaker_identity_evidence||null,transcription_glossary:document.transcription_glossary||null});
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 async function capabilities(){const status=await transcriber?.incrementalStatus?.();return {protocolVersion:1,downloadTranscribe:{available:Boolean(status?.available),local_only:true,acquisitionMode:'incremental-experimental-v1',backend:'qwen-mlx',fallback:'complete-file'}};}
 function currentCombined(value,operation){const current=libraryStore.get(value.document_key)?.document;return Boolean(current&&mediaStore.owner(value.document_key).binding===value.binding&&same(operation.user_snapshot,userSnapshot(current))&&same(operation.profile,transcriber?.profile));}
 mediaStore.setCommitGuard(record=>{
  if(closing)throw fail('来源任务服务正在停止',503);
  const tasks=db.prepare("SELECT operation FROM jobs WHERE binding=? AND kind IN ('transcribe','align','download_transcribe')").all(record.binding);
  if(tasks.some(value=>JSON.parse(value.operation).fingerprint&&JSON.parse(value.operation).fingerprint!==record.sha256))throw fail('此项目已有绑定原声的转写任务。来源返回了不同音频，未替换旧原声；请另建项目核对新版本。',409);
 });
 const row=id=>{if(!uuid(id))throw fail('任务标识无效');const value=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);if(!value)throw fail('任务不存在',404);return value;};
 function recognitionSnapshot(document,binding){
  const download=db.prepare("SELECT operation FROM jobs WHERE binding=? AND (kind='download' AND state='ready' OR kind='download_transcribe' AND json_extract(operation,'$.fingerprint') IS NOT NULL) ORDER BY updated DESC LIMIT 1").get(binding);
  const supplied=Coconut.transcriptionContext(document.transcription_context),acquired=download?.operation?Coconut.transcriptionContext(JSON.parse(download.operation).transcription_context):null;
  const context=supplied||acquired;
  return {title:document.title,...(context&&context.source_url===document.source_url?{transcription_context:context}:{}),
   ...(document.speaker_identity_evidence?{speaker_identity_evidence:document.speaker_identity_evidence}:{}),
   ...(document.transcription_glossary?{transcription_glossary:document.transcription_glossary}:{})};
 }
 function owned(value){if(mediaStore.owner(value.document_key).binding!==value.binding)throw fail('原项目来源已变化，旧任务不能接入此项目',409);return value;}
 function describe(value){
  const operation=value.operation?JSON.parse(value.operation):null,current=libraryStore.get(value.document_key)?.document;
  const matchingContext=combined(value.kind)?currentCombined(value,operation):value.kind!=='transcribe'||!operation?.recognition_document||current&&JSON.stringify(operation.recognition_document)===JSON.stringify(recognitionSnapshot(current,value.binding));
  const request=JSON.parse(value.request);
  return {automatic:request.automatic===true||request.saveResult===true,documentRevision:value.document_revision,
   ...(value.kind==='captions'?{languages:JSON.parse(value.phase||'{}').languages||[],tracks:JSON.parse(value.phase||'{}').tracks||[],language:operation?.language||''}:{}),
   id:value.id,documentKey:value.document_key,binding:value.binding,source:value.source,kind:value.kind,state:value.state,phase:value.phase,currentProfile:!['transcribe','align','download_transcribe'].includes(value.kind)||value.engine==='direct-v1'&&JSON.stringify(operation.profile)===JSON.stringify(transcriber?.profile)&&Boolean(matchingContext),...(operation?.after_transcription_review?{readingReviewProvider:operation.after_transcription_review}:{}),resultAvailable:['transcribe','align','download_transcribe'].includes(value.kind)&&value.engine==='direct-v1'&&value.state==='ready'&&!value.document_revision&&Boolean(matchingContext),mediaReady:Boolean(operation?.fingerprint),assetSha256:operation?.fingerprint||null,ingestionId:value.ingestion_id||null,error:value.error,error_details:storedErrorDetails(value.error_details),created:value.created,updated:value.updated};
 }
 function update(id,state,error=null,details=null){
  const safeDetails=videoSourceErrorDetails(details);
  db.prepare('UPDATE jobs SET state=?,error=?,error_details=?,updated=? WHERE id=?').run(state,error,safeDetails?JSON.stringify(safeDetails):null,Date.now(),id);
  emit(row(id).document_key,'source-job',{jobId:id,state});
 }
 function trackCommit(value,current,document,{processing=true}={}){
  owned(value);
  const next=processing?{...document,source_workflow_job:value.id}:document;
  Coconut.validate(next);
  const receipt=libraryStore.commit({protocolVersion:1,epoch:current.token.epoch,key:current.key,
   receiptKey:randomUUID(),action:'put',expected:current.token,document:next});
  db.prepare('UPDATE jobs SET document_revision=? WHERE id=?').run(receipt.token.revision,value.id);
  emit(value.document_key,'document',{revision:receipt.token.revision});
  return next;
 }
 function saveTranscript(value,raw){
  owned(value);
  const current=libraryStore.get(value.document_key);
  requireMissingTranscript('transcribe',current.document);
  const video=videoSource(current.document);
  const title=video&&current.document.title===videoTitle(video)&&typeof raw.title==='string'&&raw.title.trim()?raw.title:current.document.title;
  return trackCommit(value,current,attachTranscript({...current.document,title},raw,Coconut,project));
 }
 async function prepareReading(document){
  if(!cleanReadingJobs)return;
  try{await cleanReadingJobs.createAutomatic(document.key);}
  catch(error){if(!closing)process.emitWarning('本地精读任务未能启动: '+String(error?.message||error).slice(0,180));}
 }
 function maybeTranscribe(key,binding){
  if(closing||admissionOwner!==null||handoffs.has(binding))return;
  const caption=lastJob(binding,'captions'),download=lastJob(binding,'download');
  if(caption?.state!=='absent'||download?.state!=='ready'||lastJob(binding,'transcribe')||lastJob(binding,'download_transcribe'))return;
  const task=(async()=>{
   try{
    const current=libraryStore.get(key);
    if(!current||current.deleted||current.document.segments.length||mediaStore.owner(key).binding!==binding)return;
    const owner=mediaStore.owner(key);
    await create({protocolVersion:1,libraryId:current.token.epoch,key,source:owner.source,kind:'transcribe',
     operation_id:randomUUID(),consent:true,saveResult:true,
     after_transcription_review:JSON.parse(caption.operation||'{}').after_transcription_review||false},true);
   }catch(error){
    // An unavailable local profile leaves the two acquisition results intact.
    if(!closing&&error?.status!==503&&error?.status!==409)process.emitWarning('自动转写未能启动: '+String(error?.message||error).slice(0,150));
   }
  })();
  handoffs.set(binding,task);void task.finally(()=>handoffs.delete(binding));
 }
 async function fetchAuthorCaptions(value,signal,setPhase){
  const current=libraryStore.get(value.document_key).document,operation=JSON.parse(value.operation);
  if(current.segments.length){update(value.id,'ready');return;}
  setPhase({phase:'check_captions'});
  let result;
  if(current.podcast_source){
   const source=current.podcast_source;
   if(!source.feed_url){update(value.id,'unverified','直链未提供发布者字幕信息');return;}
   result=await podcastSources.importEpisode({feedUrl:source.feed_url,episodeId:source.episode_id,
    ...(operation.track?{transcriptUrl:operation.track}:{})},{signal,authorOnly:true});
  }else{
   if(!captionService?.available)throw fail('本机字幕获取服务尚未就绪',503);
   result=await captionService.importCaption({url:current.source_url,language:operation.language,authorOnly:true},{signal});
  }
  signal.throwIfAborted();if(closing)return;owned(value);
  if(result.status==='author_captions_absent'){update(value.id,'absent');maybeTranscribe(value.document_key,value.binding);return;}
  if(result.status==='language_required'){
   setPhase({phase:'choose_language',languages:result.languages||[],tracks:result.tracks||[]});
   update(value.id,'language_required',result.message);return;
  }
  if(result.status!=='ready'||!result.document?.segments?.length||
      !['platform_subtitles','publisher_transcript'].includes(result.document.provenance?.kind))
   throw fail(result.message||'作者字幕未通过校验，请重试');
  if(result.diagnostics?.some(item=>['invalid_timestamp','missing_timing','empty_text','malformed_block','no_valid_cues','reversed_range','overlapping_cues','dropped_cue'].includes(item.category)))
   throw fail('作者字幕包含无法导入的片段，请检查来源字幕');
  setPhase({phase:'save'});
  const latest=libraryStore.get(value.document_key).document;
  if(latest.segments.length)throw fail('此项目已有文字稿，未覆盖',409);
  const document=saveTranscript(value,result.document);
  update(value.id,'ready');
  await prepareReading(document);
 }
 function recognitionArguments(ownerDocument){
  const participants=Array.isArray(ownerDocument.speaker_identity_evidence?.speakers)?ownerDocument.speaker_identity_evidence.speakers.filter(s=>typeof s?.name==='string'&&s.name.trim()&&s.name.length<=80).slice(0,64):[];
  const terms=Array.isArray(ownerDocument.transcription_glossary)?ownerDocument.transcription_glossary.filter(t=>typeof t?.term==='string'&&t.term.trim()&&t.term.length<=80&&typeof t.source==='string'&&t.source.trim()).map(t=>t.term):[];
  const hotwords=[...new Set([...participants.map(s=>s.name),...terms])].slice(0,64),aliases=new Map();
  for(const participant of participants)for(const alias of Array.isArray(participant.verified_asr_aliases)?participant.verified_asr_aliases:[]){
   if(typeof alias!=='string'||alias===participant.name||alias.length<2||alias.length!==participant.name.length)continue;
   if(aliases.size>=64&&!aliases.has(alias))continue;
   aliases.set(alias,aliases.has(alias)&&aliases.get(alias)!==participant.name?null:participant.name);
  }
  const nameCorrections=Object.fromEntries([...aliases].filter(([alias,name])=>name&&!hotwords.includes(alias)));
  return {title:ownerDocument.title,context:ownerDocument.transcription_context,hotwords,nameCorrections,speakerCount:ownerDocument.speaker_identity_evidence?.expected_speakers};
 }
 async function perform(value,signal){
  update(value.id,'running');
  let liveSession=null;
  let acceptingProgress=true,progressTimer;
  const setPhase=phase=>{
   if(acceptingProgress&&!closing&&!signal.aborted){
    db.prepare("UPDATE jobs SET phase=?,updated=? WHERE id=? AND state='running'").run(JSON.stringify(phase),Date.now(),value.id);
    const {phase:stage,receivedBytes,totalBytes,chunk,chunks}=phase;
    emit(value.document_key,'source-job',{jobId:value.id,phase:stage,receivedBytes,totalBytes,chunk,chunks});
   }
  };
  try{
   owned(value);
   if(value.kind==='captions'){await fetchAuthorCaptions(value,signal,setPhase);return;}
   requireMissingTranscript(value.kind,libraryStore.get(value.document_key).document);
   let incrementalDone=false;
   if(value.kind==='download'||combined(value.kind)&&!JSON.parse(value.operation).fingerprint){
    setPhase({phase:'resolve'});
    const document=libraryStore.get(value.document_key).document,source=document.podcast_source;
    if(autoDownload(value)&&!JSON.parse(value.operation||'{}').force_download&&await mediaStore.read(value.document_key,value.binding)){
     if(!signal.aborted&&!closing){update(value.id,'ready');emit(value.document_key,'media');maybeTranscribe(value.document_key,value.binding);}return;
    }
    let media,consumed=false,session=null,sessionError=null,attemptDirectory=null;
    const operation=combined(value.kind)?JSON.parse(value.operation):null;
    let frozen=null;
    const rememberError=error=>{sessionError??=error;};
    const consume=async result=>{
     if(consumed)throw fail('原声任务重复提交媒体',409);
     owned(value);
     const type=ALIASES[result.type]||result.type,extension=TYPES[type]||({'audio/aac':'aac','video/ogg':'ogg','video/quicktime':'mov'})[type];
     if(!extension)throw fail('原声格式不受支持');
     const body=Buffer.isBuffer(result.body)?Readable.from([result.body]):result.body;
     let observer;
     if(operation){
      requireMissingTranscript(value.kind,libraryStore.get(value.document_key).document);
      if(!currentCombined(value,operation))throw fail('识别输入已变化，请创建新任务',409);
      const context=Coconut.transcriptionContext(result.source?.transcription_context||result.transcription_context);
      if(context?.source_url===document.source_url&&!operation.recognition_document.transcription_context)operation.recognition_document.transcription_context=context;
      if(context?.source_url===document.source_url)operation.transcription_context=context;
      frozen=recognitionArguments({...document,...operation.recognition_document});
      if(source?.media_url&&!Buffer.isBuffer(result.body)&&['audio/mpeg','audio/flac','audio/mp4'].includes(type)){
       operation.attempt_id=randomUUID();attemptDirectory=path.join(directory,value.id,'attempts',operation.attempt_id);await mkdir(attemptDirectory,{recursive:true,mode:0o700});
       db.prepare('UPDATE jobs SET operation=? WHERE id=?').run(JSON.stringify(operation),value.id);
       observer={opened:({readOnlyFd})=>{try{requireMissingTranscript(value.kind,libraryStore.get(value.document_key).document);session=liveSession=transcriber.startIncremental({attemptId:operation.attempt_id,mediaFd:readOnlyFd,pcmCache:mediaStore.pcmCacheDirectory,workDirectory:attemptDirectory,sourceSnapshot:operation.user_snapshot,...frozen,mediaWaitSeconds:Math.ceil((podcastSources.downloadPolicy?.idleTimeoutMs??120000)/1000)+60,signal,onProgress:setPhase});session.completion.catch(rememberError);}catch(error){rememberError(error);}},appended:({availableBytes})=>{try{session?.appendWatermark(availableBytes);}catch(error){rememberError(error);}},sealed:record=>{try{session?.seal({size:record.size,sha256:record.sha256});}catch(error){rememberError(error);}},aborted:()=>{session?.abort();}};
      }
     }
     const record=await mediaStore.save(value.document_key,value.source,body,{type,name:'source.'+extension,signal,expectedSha256:result.sha256,expectedSize:result.size,observer,onReceived:size=>{receiving=false;if(!operation)setPhase({phase:'save',receivedBytes:size,totalBytes});}});
     if(operation){operation.fingerprint=record.sha256;operation.size=record.size;db.prepare('UPDATE jobs SET operation=? WHERE id=?').run(JSON.stringify(operation),value.id);}

     consumed=true;
    };
    let lastProgress=null,totalBytes=null,receivedBytes=0,receiving=true;
    const publishDownloadProgress=()=>{
     clearTimeout(progressTimer);progressTimer=undefined;
     if(!receiving||!acceptingProgress||closing||signal.aborted)return;
     lastProgress=Date.now();setPhase({phase:'download',receivedBytes,totalBytes});
    };
    const onProgress=progress=>{
     if(!receiving||!acceptingProgress||closing||signal.aborted)return;
     if(!Number.isSafeInteger(progress?.receivedBytes)||progress.receivedBytes<receivedBytes||
        progress.totalBytes!==null&&(!Number.isSafeInteger(progress.totalBytes)||progress.totalBytes<progress.receivedBytes))return;
     receivedBytes=progress.receivedBytes;totalBytes=progress.totalBytes;
     const elapsed=lastProgress===null?1000:Date.now()-lastProgress;
     if(elapsed>=1000)publishDownloadProgress();
     else if(!progressTimer){progressTimer=setTimeout(publishDownloadProgress,1000-elapsed);progressTimer.unref();}
    };
    if(source?.media_url){
     const request=source.feed_url?{feedUrl:source.feed_url,episodeId:source.episode_id,mediaUrl:source.media_url}:{url:source.media_url};
     if(source.feed_url&&typeof document.source_url==='string'&&document.source_url.trim()&&['xiaoyuzhoufm.com','www.xiaoyuzhoufm.com'].includes(new URL(source.feed_url).hostname))request.episodeUrl=document.source_url;
     media=await podcastSources.downloadMedia(request,{signal,consume,onProgress});
    }else{
     const video=videoSource(document);
     if(!video)throw fail('此项目没有可获取的原声');
     media=await videoAudioService.download({url:video.url,language:null,consent:true},{signal,purpose:'source',consume,onProgress,...(autoDownload(value)?{audioOnly:true}:{})});
    }
    // Legacy adapters/test doubles return a Buffer instead of consuming a stream.
    receiving=false;
    if(!consumed)await consume(media);
    owned(value);
    const context=Coconut.transcriptionContext(media.source?.transcription_context||media.transcription_context);
    if(!operation&&context?.source_url===document.source_url&&!signal.aborted&&!closing)db.prepare('UPDATE jobs SET operation=? WHERE id=?').run(JSON.stringify({transcription_context:context}),value.id);
    if(!operation){
     if(!signal.aborted&&!closing){
      const current=libraryStore.get(value.document_key);
      const video=videoSource(current.document);
      if(autoDownload(value)&&video&&current.document.title===videoTitle(video)&&typeof media.source?.title==='string'&&media.source.title.trim()){
       trackCommit(value,current,{...current.document,title:media.source.title,
        ...(media.source.duration?{media_duration:media.source.duration}:{}),
        ...(context?.source_url===current.document.source_url?{transcription_context:context}:{})},{processing:false});
      }
      update(value.id,'ready');emit(value.document_key,'media');maybeTranscribe(value.document_key,value.binding);
     }
     return;
    }
    if(session){await session.completion;}
    if(sessionError)throw sessionError;
    if(session){
     const receipt=JSON.parse(await readFile(path.join(attemptDirectory,'incremental_receipt.json'),'utf8'));
     const expectedContext={title:frozen.title??null,context:frozen.context??null,hotwords:frozen.hotwords??null,name_corrections:frozen.nameCorrections??null,speaker_count:frozen.speakerCount??null};
     if(receipt.protocol_version!==1||receipt.attempt_id!==operation.attempt_id||receipt.source_sha256!==operation.fingerprint||receipt.size!==operation.size||!same(receipt.source_snapshot,operation.user_snapshot)||!same(receipt.profile,operation.profile)||!same(receipt.frozen_context,expectedContext)||!Number.isInteger(receipt.reused_chunks)||receipt.reused_chunks<0||!Number.isInteger(receipt.recomputed_chunks)||receipt.recomputed_chunks<0||![null,'stream_decode_unavailable','canonical_pcm_mismatch'].includes(receipt.fallback_reason))throw fail('增量转录完整性验证失败');
     const raw=await readFile(path.join(attemptDirectory,'result.json'),'utf8');Coconut.validate(JSON.parse(raw));
     const destination=path.join(directory,value.id);await writeFile(path.join(destination,'result.tmp'),raw,{mode:0o600});await rename(path.join(destination,'result.tmp'),path.join(destination,'result.json'));incrementalDone=true;
    }
    value=row(value.id);
   }
   const operation=JSON.parse(value.operation);
   if(value.engine!=='direct-v1')throw fail('旧 Python 队列任务已保留；请明确重试以使用新的转录执行器',409);
   if(JSON.stringify(operation.profile)!==JSON.stringify(transcriber?.profile))throw fail('模型配置已变化，请为当前配置创建新任务',409);
   const input=await mediaStore.localInput(value.document_key,value.binding,operation.fingerprint);
   const workDirectory=path.join(directory,value.id);await mkdir(workDirectory,{recursive:true,mode:0o700});
   if(value.kind==='align'){
    if(sourceSignature(libraryStore.get(value.document_key).document)!==sourceSignature(operation.document))throw fail('原稿已变化，请创建新的对齐任务',409);
    await transcriber.align({inputPath:input.path,sha256:operation.fingerprint,workDirectory,pcmCache:mediaStore.pcmCacheDirectory,document:operation.document,signal,onProgress:setPhase});
    owned(value);await mediaStore.localInput(value.document_key,value.binding,operation.fingerprint);
    if(sourceSignature(libraryStore.get(value.document_key).document)!==sourceSignature(operation.document))throw fail('原稿已变化，对齐候选未应用',409);
    if(signal.aborted||closing)return;
    if(publishResult(value)){
     const raw=JSON.parse(await readFile(path.join(workDirectory,'result.json'),'utf8'));
     signal.throwIfAborted();if(closing)return;owned(value);
     const current=libraryStore.get(value.document_key);
     const merged=mergeAlignmentCandidate(current.document,operation.document,raw.document,raw.alignment_report,operation.fingerprint);
     const document=trackCommit(value,current,{...merged,source_alignment:{...merged.source_alignment,
      asset_sha256:operation.fingerprint,alignment_identity:raw.alignment_identity||null}});
     update(value.id,'ready');await prepareReading(document);
    }else update(value.id,'ready');
    return;
   }
   if(combined(value.kind)&&!currentCombined(value,operation))throw fail('识别输入已变化，请创建新任务',409);
   const currentDocument=libraryStore.get(value.document_key).document;
   requireMissingTranscript(value.kind,currentDocument);
   let ownerDocument={...currentDocument,...(operation.recognition_document||recognitionSnapshot(currentDocument,value.binding))};
   const {hotwords,nameCorrections}=recognitionArguments(ownerDocument);
   if(!incrementalDone)await transcriber.run({inputPath:input.path,sha256:operation.fingerprint,workDirectory,pcmCache:mediaStore.pcmCacheDirectory,title:ownerDocument.title,context:ownerDocument.transcription_context,hotwords,nameCorrections,speakerCount:ownerDocument.speaker_identity_evidence?.expected_speakers,signal,
    onProgress:setPhase});
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
     if(reviewer.prepareContext)try{raw=await reviewer.prepareContext(raw,{directory:path.join(workDirectory,'context'),...operation.review,signal,onProgress:setPhase});}
     catch(error){if(signal.aborted||closing)throw error;raw={...raw,transcription_context_status:'pending'};}
     if(reviewer.identifySpeakers)raw=await reviewer.identifySpeakers(raw,{directory:path.join(workDirectory,'speaker-identity'),...operation.review,signal,onProgress:setPhase});
     const output=await reviewer.review(raw,{directory:path.join(workDirectory,'review'),...operation.review,signal,jobId:value.id,onProgress:setPhase});
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
   if(!signal.aborted&&!closing){
    if(publishResult(value)){
     if(combined(value.kind)&&!currentCombined(value,operation)||
      !combined(value.kind)&&operation.recognition_document&&!same(operation.recognition_document,recognitionSnapshot(libraryStore.get(value.document_key).document,value.binding)))
      throw fail('识别原稿或上下文已变化，旧结果未保存',409);
    }
    const document=publishResult(value)?saveTranscript(value,raw):null;
    update(value.id,'ready');
    if(document)await prepareReading(document);
   }
  }catch(error){
   if(liveSession){try{liveSession.abort();await liveSession.completion;}catch{}}
   if(!closing&&!signal.aborted){
    const videoFailure=value.kind==='download'&&error instanceof VideoSourceError;
    const conflict=error?.status===409&&!videoFailure;
    let message='任务未完成，已保留处理进度。请检查本地环境后明确重试。';
    if(value.kind==='download'){
     message='原声下载未完成，请检查网络或来源后明确重试。';
     if(error instanceof PublicSourceError)message=error.code==='SOURCE_TIMEOUT'?'原声下载超过总时限，请检查网络后重试。':error.message.slice(0,300);
     if(videoFailure)message=error.message;
    }
    if(value.kind==='captions')message=error instanceof Error?error.message.slice(0,300):'作者字幕检查未完成';
    if(conflict)message=localErrors.has(error)||mediaConflicts.has(error?.message)?error.message:'原声或任务绑定发生冲突，请核对来源后明确重试。';
    update(value.id,conflict?'interrupted':'failed',message,videoFailure?error:null);
   }
  }
  finally{acceptingProgress=false;clearTimeout(progressTimer);}
 }
 function pump(){
  if(closing)return;
  for(const value of db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created,id").all()){
   const lane=laneFor(value.kind);
   // Do not replace or re-fetch the same source while its inference is active.
   if(lane.some(key=>lanes.has(key))||value.kind!=='captions'&&[...lanes.values()].some(active=>active.kind!=='captions'&&active.binding===value.binding))continue;
   const active={id:value.id,binding:value.binding,kind:value.kind,controller:new AbortController(),promise:null};
   for(const key of lane)lanes.set(key,active);
   active.promise=perform(value,active.controller.signal).finally(()=>{for(const key of lane)lanes.delete(key);pump();});
  }
 }
 function videoSource(document){
  if(!videoAudioService?.sourceAvailable)return null;
  try{const source=captionSource(document.source_url);return videoAudioService.providers?.includes(source.provider)?source:null;}catch{return null;}
 }
 async function createOne(data,internal=false){
  if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);
  if(data?.protocolVersion!==1||!uuid(data.operation_id)||typeof data.key!=='string'||!data.key||data.key.length>1000||!['download','transcribe','align','download_transcribe',...(internal?['captions']:[])].includes(data.kind)||data.consent!==true)throw fail('请明确确认此来源操作');
  if(data.after_transcription_review!==undefined&&(![false,'codex','kimi','claude'].includes(data.after_transcription_review)||!['transcribe','download_transcribe',...(internal?['captions']:[])].includes(data.kind)))throw fail('转录后精校选项无效');
  if(combined(data.kind)&&(data.localOnly!==true||data.acquisitionMode!=='incremental-experimental-v1'||data.review!==undefined||data.model!==undefined||data.profile!==undefined))throw fail('请明确确认仅本地实验转录');
  const owner=mediaStore.owner(data.key);if(data.libraryId!==libraryStore.describe().epoch)throw fail('所连接的书架已变化，请刷新后核对',409);
  if(data.source!==owner.source)throw fail('原项目来源已变化',409);
  const request=JSON.stringify({key:data.key,source:data.source,kind:data.kind,...(data.after_transcription_review!==undefined?{after_transcription_review:data.after_transcription_review}:{}),
   ...(internal&&data.automatic===true?{automatic:true}:{}),...(data.saveResult===true?{saveResult:true}:{})});
  const alias=db.prepare('SELECT * FROM job_receipts WHERE id=?').get(data.operation_id);
  if(alias){if(alias.request!==request||alias.binding!==owner.binding)throw fail('此操作已绑定另一份来源',409);return {...describe(row(alias.job_id)),requestedOperationId:data.operation_id};}
  const previous=db.prepare('SELECT * FROM jobs WHERE id=?').get(data.operation_id);
  if(previous){if(previous.request!==request||previous.binding!==owner.binding)throw fail('此操作已绑定另一份来源',409);return describe(previous);}
  requireMissingTranscript(data.kind,libraryStore.get(data.key).document);
  // Reuse the original task across browsers, including uncertain upload receipts.
  const existing=lastJob(owner.binding,data.kind);
  if(existing&&(data.kind==='download'||data.kind==='captions'))return describe(existing);
  if(db.prepare('SELECT count(*) AS count FROM jobs').get().count>=256)throw fail('来源任务已达保存上限，请保留书架备份并检查服务存储',409);
  let operation=null;
  if(data.kind==='captions'){operation=JSON.stringify({language:data.language||null,track:data.track||null ,...(data.after_transcription_review?{after_transcription_review:data.after_transcription_review}:{})});}
  else if(combined(data.kind)){
   const document=libraryStore.get(data.key).document;
   if(db.prepare("SELECT id FROM jobs WHERE binding=? AND kind='download' AND state IN ('running','queued')").get(owner.binding))throw fail('原声下载正在进行，请完成后再明确转录',409);
   const record=await mediaStore.read(data.key,owner.binding);
   const unclaimedSaved=existing&&!JSON.parse(existing.operation).fingerprint&&record&&['failed','cancelled','interrupted'].includes(existing.state);
   if(existing&&!unclaimedSaved&&(!data.saveResult||publishResult(existing))&&currentCombined(existing,JSON.parse(existing.operation))&&(JSON.parse(existing.operation).after_transcription_review||false)===(data.after_transcription_review||false)){
    if(db.prepare('SELECT count(*) AS count FROM job_receipts').get().count>=2048)throw fail('任务回执已达保存上限',409);
    db.prepare('INSERT INTO job_receipts (id,job_id,request,binding) VALUES (?,?,?,?)').run(data.operation_id,existing.id,request,owner.binding);
    return {...describe(existing),requestedOperationId:data.operation_id};
   }
   if(existing&&['queued','running'].includes(existing.state))throw fail('旧转录仍在进行，请先取消原任务',409);
   if(!(await capabilities()).downloadTranscribe.available)throw fail('本地增量转录尚未就绪',503);
   if(!record&&!document.podcast_source?.media_url&&!videoSource(document))throw fail('此项目没有可获取的原声');
   operation=JSON.stringify({profile:transcriber.profile,user_snapshot:userSnapshot(document),recognition_document:recognitionSnapshot(document,owner.binding),fingerprint:record?.sha256||null,size:record?.size||null,...(data.after_transcription_review?{after_transcription_review:data.after_transcription_review}:{})});
  }else if(data.kind==='download'){const document=libraryStore.get(data.key).document;if(!document.podcast_source?.media_url&&!videoSource(document))throw fail('此项目没有可获取的原声');}
  else{
   const record=await mediaStore.read(data.key,owner.binding);if(!record)throw fail('请先保存原声',409);
   if(existing){if(existing.engine==='direct-v1'&&(JSON.parse(existing.operation).after_transcription_review||false)===(data.after_transcription_review||false)&&JSON.parse(existing.operation).fingerprint===record.sha256&&JSON.stringify(JSON.parse(existing.operation).profile)===JSON.stringify(transcriber?.profile)&&(data.kind!=='transcribe'||JSON.stringify(JSON.parse(existing.operation).recognition_document)===JSON.stringify(recognitionSnapshot(libraryStore.get(data.key).document,owner.binding)))&&(!data.saveResult||publishResult(existing))&&(data.kind!=='align'||sourceSignature(JSON.parse(existing.operation).document)===sourceSignature(libraryStore.get(data.key).document)))return describe(existing);if(['queued','running'].includes(existing.state))throw fail('旧原声仍有进行中的转写，请先核对原任务',409);}
   const extension=TYPES[record.type];if(!extension)throw fail('此原声格式暂不支持转写，请转换为 MP3/WAV/MP4 后导入',409);
   operation=JSON.stringify({operation_id:data.operation_id,filename:'source.'+extension,size:record.size,fingerprint:record.sha256,last_modified:0,language:'',profile:transcriber?.profile,...(data.kind==='align'?{document:processingSnapshot(libraryStore.get(data.key).document)}:{recognition_document:recognitionSnapshot(libraryStore.get(data.key).document,owner.binding)}),...(data.kind==='transcribe'&&data.after_transcription_review?{after_transcription_review:data.after_transcription_review}:data.kind==='transcribe'&&!data.saveResult&&data.after_transcription_review===undefined&&reviewProvider?{review:{provider:reviewProvider,model:reviewModel}}:{})});
   const status=await (data.kind==='align'?transcriber?.alignmentStatus():transcriber?.status());if(!status?.available||internal&&(status.local_only!==true||status.model_download!==false))throw fail(status?.message||'转写执行器尚未就绪',503);
  }
  if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);if(mediaStore.owner(data.key).binding!==owner.binding)throw fail('原项目来源已变化',409);
  const insert=()=>{const now=Date.now();db.prepare('INSERT INTO jobs (id,document_key,binding,source,kind,state,request,operation,created,updated,ingestion_id,engine) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(data.operation_id,data.key,owner.binding,owner.source,data.kind,'queued',request,operation,now,now,['transcribe','align','download_transcribe'].includes(data.kind)?data.operation_id.replaceAll('-',''):null,'direct-v1');};
  if(operation&&data.kind!=='captions')await mediaStore.exclusive(async()=>{if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);const current=await mediaStore.read(data.key,owner.binding);if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);if((current?.sha256||null)!==JSON.parse(operation).fingerprint)throw fail('原声已变化，请重新确认',409);requireMissingTranscript(data.kind,libraryStore.get(data.key).document);insert();});else insert();
  const receipt=describe(row(data.operation_id));emit(data.key);pump();return receipt;
 }
 function create(data,internal=false){pendingAdmissions++;const next=creation.then(()=>createOne(data,internal));creation=next.catch(()=>{});return next.finally(()=>{pendingAdmissions--;});}
 async function acquire(data){
  if(data?.protocolVersion!==1||data.consent!==true)throw fail('来源请求无效');
  const admission={...data,automatic:true};
  const current=libraryStore.get(data.key);
  const {after_transcription_review,...downloadRequest}=admission;
  if(after_transcription_review!==undefined&&![false,'codex','kimi','claude'].includes(after_transcription_review))throw fail('转录后精校选项无效');
  const download=create({...downloadRequest,kind:'download'},true);
  const captions=current?.document.segments.length?Promise.resolve(null):create({...admission,
   operation_id:randomUUID(),kind:'captions'},true);
  const results=await Promise.allSettled([download,captions]);
  const error=results.find(result=>result.status==='rejected');
  if(error)throw error.reason;
  return results.map(result=>result.value).filter(Boolean);
 }
 async function get(id){const alias=db.prepare('SELECT * FROM job_receipts WHERE id=?').get(id);return alias?{...describe(row(alias.job_id)),requestedOperationId:id}:describe(row(id));}
 async function list(key){if(typeof key!=='string'||key.length>1000)throw fail('项目标识无效');const binding=mediaStore.owner(key).binding;return db.prepare('SELECT * FROM jobs WHERE binding=? ORDER BY created DESC LIMIT 20').all(binding).map(describe);}
 async function action(id,action,data={}){
  if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);
  let value=owned(row(id));
  if(action==='cancel'){
   if(!['queued','running','interrupted'].includes(value.state))throw fail('此任务不能取消',409);
   update(id,'cancelled');
   for(const active of lanes.values())if(active.id===id)active.controller.abort();
  }else if(action==='retry'){
   if(!['failed','interrupted','cancelled','language_required'].includes(value.state)&&!(value.kind==='download'&&value.state==='ready'))throw fail('请查看原任务状态',409);
   requireMissingTranscript(value.kind,libraryStore.get(value.document_key).document);
   if(value.kind==='captions'){
    const operation=JSON.parse(value.operation);
    if(data.language!==undefined){
     if(typeof data.language!=='string'||!JSON.parse(value.phase||'{}').languages?.includes(data.language))throw fail('请选择列出的字幕语言');
     operation.language=data.language;
    }
    if(data.track!==undefined){
     if(typeof data.track!=='string'||!JSON.parse(value.phase||'{}').tracks?.some(track=>track.value===data.track))throw fail('请选择列出的发布者文字稿');
     operation.track=data.track;
    }
    db.prepare("UPDATE jobs SET operation=?,phase='' WHERE id=?").run(JSON.stringify(operation),id);
   }
   if(['transcribe','align','download_transcribe'].includes(value.kind)){
    if(combined(value.kind)&&!currentCombined(value,JSON.parse(value.operation)))throw fail('识别输入已变化，请创建新任务',409);
    const media=await mediaStore.read(value.document_key,value.binding);if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);if((media?.sha256||null)!==JSON.parse(value.operation).fingerprint)throw fail('原声已经替换，请为当前原声明确创建新转写',409);
    const status=await (combined(value.kind)?transcriber?.incrementalStatus():value.kind==='align'?transcriber?.alignmentStatus():transcriber?.status());if(!status?.available)throw fail(status?.message||'本地转录未就绪',503);
    if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);
    const operation={...JSON.parse(value.operation),profile:transcriber.profile};
    if(value.engine==='direct-v1'&&JSON.stringify(JSON.parse(value.operation).profile)!==JSON.stringify(transcriber.profile))throw fail('模型配置已变化，请创建新任务',409);
    db.prepare("UPDATE jobs SET operation=?,engine='direct-v1',ingestion_id=? WHERE id=?").run(JSON.stringify(operation),id.replaceAll('-',''),id);
   }
   if(closing||admissionOwner!==null)throw fail('服务正在停止或等待关闭确认',503);
   if(value.kind==='download'){
    const operation=JSON.parse(value.operation||'{}');
    if(autoDownload(value))operation.force_download=true;
    db.prepare("UPDATE jobs SET phase='',operation=? WHERE id=?").run(JSON.stringify(operation),id);
   }
   update(id,'queued');pump();
  }else throw fail('任务操作无效');return describe(row(id));
 }
 async function result(id){
  const value=owned(row(id));if(!['transcribe','align','download_transcribe'].includes(value.kind)||value.state!=='ready')throw fail('文字稿尚未完成',409);
  if(value.engine!=='direct-v1')throw fail('旧任务结果仍保存在原 Python 数据目录，请从原服务导出文字稿',409);
  const operation=JSON.parse(value.operation);if(combined(value.kind)&&!currentCombined(value,operation))throw fail('识别输入已变化，旧结果不能应用',409);await mediaStore.localInput(value.document_key,value.binding,operation.fingerprint);
  const raw=JSON.parse(await readFile(path.join(directory,id,'result.json'),'utf8'));
  if(value.kind==='align'){
   if(sourceSignature(libraryStore.get(value.document_key).document)!==sourceSignature(operation.document))throw fail('原稿已变化，旧对齐候选未应用',409);
   Coconut.validate(raw.document);owned(value);return {job:describe(value),alignment:{...raw,input:operation.document}};
  }
  const document={...raw,...Coconut.validate(raw)};owned(value);
  return {job:describe(value),ingestion:{id:value.ingestion_id,state:'ready',transcript:{document}}};
 }
 function shutdown(){return shutdownPromise??=(async()=>{closing=true;for(const active of lanes.values())active.controller.abort();await creation;await Promise.all([...lanes.values()].map(active=>active.promise));await Promise.allSettled(handoffs.values());db.prepare("UPDATE jobs SET state='interrupted' WHERE state IN ('running','queued')").run();db.close();})();}
 function activity(){return {active:pendingAdmissions+db.prepare("SELECT count(*) AS count FROM jobs WHERE state IN ('running','queued')").get().count};}
 function pauseAdmission(id){if(admissionOwner!==null&&admissionOwner!==id)return false;admissionOwner=id;return true;}
 function resumeAdmission(id){if(admissionOwner===id)admissionOwner=null;}
 async function trackedAction(id,operation,data){pendingAdmissions++;try{return await action(id,operation,data);}finally{pendingAdmissions--;}}
 for(const task of db.prepare("SELECT * FROM jobs WHERE state IN ('ready','interrupted') AND (kind='captions' OR json_extract(request,'$.saveResult')=1)").all()){
  const current=libraryStore.get(task.document_key);
  if(!current?.deleted&&current?.document?.source_workflow_job===task.id){
   if(task.state==='interrupted')db.prepare("UPDATE jobs SET state='ready',document_revision=? WHERE id=?").run(current.token.revision,task.id);
   await prepareReading(current.document);
  }
 }
 for(const task of db.prepare("SELECT document_key,binding FROM jobs WHERE kind='captions' AND state='absent'").all())
  maybeTranscribe(task.document_key,task.binding);
 pump();return {capabilities,create:data=>create(data),acquire,get,list,action:trackedAction,result,shutdown,activity,pauseAdmission,resumeAdmission,
  subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);}};
}
