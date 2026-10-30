/** Durable local text/speaker stages. Reuses source cues; never invokes ASR or a network provider. */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,stat,writeFile,readFile,rename,rm,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),Coconut=require('../reader/core.js');
const {processingSnapshot,sourceSignature,inspectResources,mergeProcessingResult}=require('../shared/transcript-resources.js');
const worker=fileURLToPath(new URL('../transcript_readability.py',import.meta.url));
const MAX_INPUT=8*1024*1024,MAX_AUDIO=200*1024*1024;
const TYPES={mp3:'audio/mpeg',m4a:'audio/mp4',wav:'audio/wav',ogg:'audio/ogg',flac:'audio/flac',mp4:'video/mp4',webm:'video/webm'};
const hash=text=>createHash('sha256').update(text).digest('hex');
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const identifier=value=>{if(typeof value!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))throw fail('整理任务标识无效');return value;};
const exists=async filename=>{if(typeof filename!=='string'||!path.isAbsolute(filename))return false;try{return (await stat(filename)).isFile()&&(await stat(filename)).size>0;}catch{return false;}};
export async function createReadabilityJobs({directory,python=process.env.COCONUT_READING_PYTHON,punctuationModel=process.env.COCONUT_PUNCTUATION_MODEL,segmentationModel=process.env.COCONUT_SPEAKER_SEGMENTATION_MODEL,embeddingModel=process.env.COCONUT_SPEAKER_EMBEDDING_MODEL,timeoutMs=2*3600*1000,runWorker}={}){
 if(!path.isAbsolute(directory||''))throw fail('整理任务目录须为绝对路径');
 await mkdir(directory,{recursive:true,mode:0o700});
 const {DatabaseSync}=await import('node:sqlite');
 const db=new DatabaseSync(path.join(directory,'readability.sqlite'));
 try{
  db.exec("PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, request TEXT NOT NULL, digest TEXT NOT NULL, document_key TEXT NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL, media_hash TEXT, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL); COMMIT; CREATE UNIQUE INDEX IF NOT EXISTS one_active_document ON jobs(document_key) WHERE state IN ('awaiting_media','queued','running');");
 }catch(error){db.close();throw error;}
 if(!db.prepare('PRAGMA table_info(jobs)').all().some(column=>column.name==='result_digest'))db.exec('ALTER TABLE jobs ADD COLUMN result_digest TEXT');
 db.prepare("UPDATE jobs SET state='interrupted',phase='interrupted',updated=? WHERE state='running'").run(Date.now());
 let closing=false,running=null,scheduled=false,creation=Promise.resolve();const uploads=new Set();let activeController=null;
 async function capabilities(){const runtime=await exists(python);return {protocolVersion:1,available:runtime,local_only:true,model_download:false,persistent:true,punctuation:runtime&&await exists(punctuationModel),speakers:runtime&&await exists(segmentationModel)&&await exists(embeddingModel),alignment:false,message:runtime?'使用已配置的本地模型；不重新识别已有字幕。':'本地整理运行环境未配置，现有文字稿仍可阅读。'};}
 function row(id){const value=db.prepare('SELECT * FROM jobs WHERE id=?').get(identifier(id));if(!value)throw fail('整理任务不存在',404);return value;}
 function describe(value){const request=JSON.parse(value.request);return {id:value.id,documentKey:value.document_key,state:value.state,phase:value.phase,steps:request.steps,sourceDigest:hash(sourceSignature(request.document)),resultDigest:value.result_digest||null,mediaIdentity:request.media?.identity||null,needsMedia:request.steps.includes('speakers')&&!value.media_hash,error:value.error||null,created:value.created,updated:value.updated,...(value.media_hash?{media:{url:'/api/v1/readability/jobs/'+value.id+'/media',kind:TYPES[request.media.extension].startsWith('video/')?'video':'audio',name:request.media.name,mimeType:TYPES[request.media.extension]}}:{})};}
 function update(id,state,phase,error=null){db.prepare('UPDATE jobs SET state=?,phase=?,error=?,updated=? WHERE id=?').run(state,phase,error,Date.now(),id);}
 const jobDirectory=id=>path.join(directory,identifier(id));
 async function defaultWorker({id,document,steps,media,signal,onPhase}){
  const work=jobDirectory(id),input=path.join(work,'input.json'),output=path.join(work,'result.json');
  await writeFile(input,JSON.stringify(document),{mode:0o600});
  const args=['-I','-B',worker,input,'-o',output,'--work-dir',path.join(work,'voices')];
  if(steps.includes('punctuation'))args.push('--punctuation-model',punctuationModel);
  if(steps.includes('speakers'))args.push('--audio',media,'--segmentation-model',segmentationModel,'--embedding-model',embeddingModel);
  await new Promise((resolve,reject)=>{
   let failure,reason='',phaseBuffer='';const child=spawn(python,args,{shell:false,detached:process.platform!=='win32',env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'},stdio:['ignore','ignore','pipe']});
   const stop=error=>{failure||=error;try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
   const cancel=()=>stop(fail('整理已取消'));signal.addEventListener('abort',cancel,{once:true});
   const timer=setTimeout(()=>stop(fail('本地整理超时；已有检查点保留，可重试')),timeoutMs);
   child.stderr.on('data',chunk=>{phaseBuffer=(phaseBuffer+chunk.toString()).slice(-4000);let end;while((end=phaseBuffer.indexOf('\n'))>=0){const line=phaseBuffer.slice(0,end);phaseBuffer=phaseBuffer.slice(end+1);if(line.includes('Audio duration does not match')||line.includes('Transcript timing extends beyond'))reason='原声时长与文字稿不一致，未采用自动分组';else if(line.includes('ModuleNotFoundError:'))reason='本地整理依赖未就绪，原稿保留';const progress=/^\[speakers\] chunk (\d+)\/(\d+)$/.exec(line);if(progress)onPhase('speakers:'+progress[1]+'/'+progress[2]);else if(line.startsWith('[speakers]'))onPhase('speakers');else if(line.startsWith('[punctuation]'))onPhase('punctuation');}});
   child.once('error',()=>{failure||=fail('无法启动本地整理运行环境');});
   child.once('close',code=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);failure||code!==0?reject(failure||fail(reason||'本地整理失败，请检查模型与原声格式；原稿已保留')):resolve();});
   if(signal.aborted)cancel();
  });
  if((await stat(output)).size>16*1024*1024)throw fail('整理结果过大');
  return JSON.parse(await readFile(output,'utf8'));
 }
 async function perform(value){
  const request=JSON.parse(value.request),controller=new AbortController();activeController=controller;
  update(value.id,'running',request.steps.includes('speakers')?'speakers':'punctuation');
  try{
   const output=await (runWorker||defaultWorker)({id:value.id,document:structuredClone(request.document),steps:request.steps,media:request.media?path.join(jobDirectory(value.id),'source.'+request.media.extension):null,signal:controller.signal,onPhase:phase=>{if(!controller.signal.aborted&&!closing)update(value.id,'running',phase);}});
   if(controller.signal.aborted||closing)return;
   const result=mergeProcessingResult(request.document,request.document,output);Coconut.validate(result);
   await writeFile(path.join(jobDirectory(value.id),'result.tmp'),JSON.stringify(result),{mode:0o600});
   await rename(path.join(jobDirectory(value.id),'result.tmp'),path.join(jobDirectory(value.id),'result.json'));
   if(controller.signal.aborted||closing)return;
   db.prepare('UPDATE jobs SET result_digest=? WHERE id=?').run(hash(sourceSignature(result)),value.id);
   update(value.id,'ready','complete');
  }catch(error){if(!controller.signal.aborted&&!closing)update(value.id,'failed','failed',String(error.message||'整理失败').slice(0,300));}
  finally{activeController=null;}
 }
 function pump(){if(closing||running||scheduled)return;scheduled=true;queueMicrotask(async()=>{scheduled=false;if(closing||running)return;const next=db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created LIMIT 1").get();if(!next)return;running=perform(next);await running;running=null;pump();});}
 async function createOne(data){
  if(closing)throw fail('整理服务已关闭',503);
  if(data?.protocolVersion!==1)throw fail('整理协议版本无效');
  const id=identifier(data.operation_id),raw=data.document;
  if(typeof raw?.key!=='string'||!raw.key||raw.key.length>1024||!Array.isArray(raw.segments)||raw.segments.length>30000||raw.segments.some(cue=>typeof cue?.id!=='string'||!cue.id))throw fail('需要完整的带时间文字稿');
  Coconut.validate(raw);const document=processingSnapshot(raw);
  if(Buffer.byteLength(JSON.stringify(document))>MAX_INPUT)throw fail('文字稿超过 8 MiB',413);
  let media=null;
  if(data.media){
   const m=data.media,extension=typeof m.name==='string'?m.name.split('.').at(-1).toLowerCase():'';
   if(typeof m.name!=='string'||m.name.length>300||/[\\/\u0000-\u001f]/.test(m.name)||!Object.hasOwn(TYPES,extension)||typeof m.identity!=='string'||!m.identity||m.identity.length>16384||!Number.isSafeInteger(m.size)||m.size<1||m.size>MAX_AUDIO)throw fail('原声身份或格式无效');
   media={identity:m.identity,name:m.name,size:m.size,extension};
  }
  const digest=hash(JSON.stringify({document,media})),previous=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if(previous){if(previous.digest!==digest)throw fail('同一操作已绑定另一份原稿或原声',409);return describe(previous);}
  const caps=await capabilities(),plan=inspectResources(document,{audio:!!media,...caps});
  if(!plan.steps.length)throw fail('没有可执行的整理阶段；请检查原声或本地模型配置',409);
  if(db.prepare("SELECT id FROM jobs WHERE document_key=? AND state IN ('queued','running','awaiting_media')").get(document.key))throw fail('此文字稿已有整理任务，请先查看原任务',409);
  if(db.prepare('SELECT count(*) AS count FROM jobs').get().count>=256)throw fail('整理任务已达保存上限，请先保留备份并清理任务目录',409);
  await mkdir(jobDirectory(id),{mode:0o700});
  const request=JSON.stringify({document,media,steps:plan.steps}),now=Date.now(),state=plan.steps.includes('speakers')?'awaiting_media':'queued';
  try{db.prepare('INSERT INTO jobs (id,request,digest,document_key,state,phase,created,updated) VALUES (?,?,?,?,?,?,?,?)').run(id,request,digest,document.key,state,state,now,now);}catch(error){throw fail('此文字稿已有整理任务，请查看原任务',409);}
  pump();return describe(row(id));
 }
 function create(data){const next=creation.then(()=>createOne(data));creation=next.catch(()=>{});return next;}
 async function upload(id,req,{signal}={}){
  const value=row(id),request=JSON.parse(value.request),media=request.media;
  if(!media||!request.steps.includes('speakers'))throw fail('此任务不需要上传原声');
  if(uploads.has(id))throw fail('此任务正在接收原声',409);
  if(['cancelled','interrupted','failed'].includes(value.state))throw fail('请先重试原任务',409);
  if(req.headers['content-type']?.split(';')[0]!=='application/octet-stream'||Number(req.headers['content-length'])!==media.size)throw fail('原声上传长度或类型不符');
  uploads.add(id);let handle;const temporary=path.join(jobDirectory(id),'upload.part');
  try{
   handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
   let bytes=0;const digest=createHash('sha256');
   for await(const chunk of req){if(signal?.aborted||closing)throw fail('原声上传已取消');bytes+=chunk.length;if(bytes>media.size)throw fail('原声上传过大',413);digest.update(chunk);await handle.writeFile(chunk);}
   if(bytes!==media.size||signal?.aborted||closing)throw fail('原声上传不完整');
   await handle.sync();await handle.close();handle=null;const fingerprint=digest.digest('hex'),current=row(id);
   if(current.media_hash){if(current.media_hash!==fingerprint)throw fail('原声字节与原操作不一致',409);return describe(current);}
   if(current.state!=='awaiting_media')throw fail('任务已变化，未接收原声',409);
   await rename(temporary,path.join(jobDirectory(id),'source.'+media.extension));
   if(closing)throw fail('整理服务已关闭',503);
   if(row(id).state==='cancelled'){db.prepare('UPDATE jobs SET media_hash=?,updated=? WHERE id=?').run(fingerprint,Date.now(),id);return describe(row(id));}
   db.prepare("UPDATE jobs SET media_hash=?,state='queued',phase='queued',error=NULL,updated=? WHERE id=?").run(fingerprint,Date.now(),id);pump();return describe(row(id));
  }finally{await handle?.close();await rm(temporary,{force:true});uploads.delete(id);}
 }
 function get(id){return describe(row(id));}
 function list(key){if(typeof key!=='string'||key.length>1024)throw fail('文字稿标识无效');return db.prepare('SELECT * FROM jobs WHERE document_key=? ORDER BY created DESC LIMIT 20').all(key).map(describe);}
 async function result(id){const value=row(id);if(value.state!=='ready')throw fail('整理尚未完成',409);return {...describe(value),input:JSON.parse(value.request).document,result:JSON.parse(await readFile(path.join(jobDirectory(id),'result.json'),'utf8'))};}
 async function streamMedia(id,req,res){
  const value=row(id),request=JSON.parse(value.request);if(!value.media_hash)throw fail('此任务未保存原声',404);
  const handle=await open(path.join(jobDirectory(id),'source.'+request.media.extension),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const info=await handle.stat();if(!info.isFile()||info.size!==request.media.size)throw fail('任务原声已变化，无法播放',409);
   let start=0,end=info.size-1;const range=req.headers.range;
   if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||!match[1]&&!match[2])throw fail('媒体范围无效',416);if(!match[1])start=Math.max(0,info.size-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=info.size)throw fail('媒体范围无效',416);}
   res.writeHead(range?206:200,{'Content-Type':TYPES[request.media.extension],'Content-Length':end-start+1,'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${info.size}`}:{})});
   if(req.method==='HEAD')res.end();else await pipeline(handle.createReadStream({start,end,autoClose:false}),res);
  }finally{await handle.close();}
 }
 async function action(id,action){
  const value=row(id);if(action==='cancel'){
   if(!['queued','running','awaiting_media'].includes(value.state))throw fail('此任务不能取消',409);
   update(id,'cancelled','cancelled');if(running&&value.state==='running')activeController?.abort();
  }else if(action==='retry'){
   if(!['failed','interrupted','cancelled'].includes(value.state))throw fail('此任务无需重试',409);
   const request=JSON.parse(value.request),caps=await capabilities();
   if(request.steps.some(step=>!caps[step]))throw fail('本地整理模型尚未就绪',503);
   update(id,request.steps.includes('speakers')&&!value.media_hash?'awaiting_media':'queued','queued');pump();
  }else throw fail('整理操作无效');
  return get(id);
 }
 async function shutdown(){if(closing)return;closing=true;await creation;if(running){const current=db.prepare("SELECT id FROM jobs WHERE state='running'").get();if(current)update(current.id,'interrupted','interrupted');activeController?.abort();await running;}db.close();}
 pump();return {capabilities,create,upload,get,list,result,streamMedia,action,shutdown};
}
