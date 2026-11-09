/** Desktop composition: same durable task owner as standalone, fixed loopback/data roots. */
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {startBridge} from './server.mjs';
import {transcriptionConfig} from './transcription-config.mjs';
import {sourceTaskRuntime} from './source-task-runtime.mjs';
import {createPodcastSources} from './podcast-sources.mjs';

const allowed=new Set(['COCONUT_ASR_PYTHON','COCONUT_MODEL_DIRECTORY','COCONUT_ASR_BACKEND','COCONUT_ASR_MODEL','COCONUT_ALIGN_MODEL','COCONUT_SPEAKER_SEGMENTATION_MODEL','COCONUT_SPEAKER_EMBEDDING_MODEL','COCONUT_READING_PYTHON','COCONUT_PUNCTUATION_MODEL']);
export async function desktopTranscriptionSettings({userDataDirectory,env=process.env}={}){
 // Finder does not load a project's .env. Only explicit, local-only model settings
 // are read here; never import service binding, ownership or credential settings.
 let saved={};
 try{
  const raw=await readFile(path.join(userDataDirectory,'transcription.json'),'utf8');
  if(Buffer.byteLength(raw)>16384)throw Error('Configuration too large');
  saved=JSON.parse(raw);
  if(!saved||Array.isArray(saved)||typeof saved!=='object'||Object.entries(saved).some(([key,value])=>!allowed.has(key)||typeof value!=='string'))throw Error('Invalid transcription settings');
 }catch(error){if(error.code!=='ENOENT')throw Error('请检查 Coconut 数据目录中的 transcription.json；本地模型配置格式无效。');}
 const settings={...saved,...Object.fromEntries([...allowed].filter(key=>env[key]!==undefined).map(key=>[key,env[key]]))};
 const config=transcriptionConfig(settings);
 for(const key of ['COCONUT_READING_PYTHON','COCONUT_PUNCTUATION_MODEL'])if(settings[key]&&!path.isAbsolute(settings[key]))throw Error('本地模型配置必须使用绝对路径');
 return {...config,readingPython:settings.COCONUT_READING_PYTHON||null,punctuationModel:settings.COCONUT_PUNCTUATION_MODEL||null,
  segmentationModel:config.asrProfile.segmentation,embeddingModel:config.asrProfile.embedding};
}
function unavailableTranscriber(){
 const status=async()=>({available:false,local_only:true,automatic:false,model_download:false,code:'desktop_transcription_config_invalid',message:'请检查 Coconut 数据目录中的 transcription.json；模型配置无效，原声保存与阅读仍可使用。'});
 const fail=()=>{throw Error('本地模型配置无效');};
 return {profile:null,status,alignmentStatus:status,run:fail,align:fail};
}
export async function startDesktopService({userDataDirectory,env=process.env,...options}={}){
 if(!path.isAbsolute(userDataDirectory||''))throw Error('Desktop requires its application data directory');
 let settings,runtime;
 try{settings=await desktopTranscriptionSettings({userDataDirectory,env});runtime=sourceTaskRuntime({...settings,transcriber:options.transcriber});}
 catch{settings={readingPython:null,punctuationModel:null,segmentationModel:null,embeddingModel:null};runtime=sourceTaskRuntime({transcriber:unavailableTranscriber()});}
 // Never accept a public listener/owner profile from a shell environment. The
 // desktop retains its existing library and stable browser origin.
 return startBridge({...options,...settings,...runtime,host:'127.0.0.1',startupMode:'desktop',
  podcastSources:options.podcastSources||createPodcastSources(),reviewProvider:'',reviewModel:''});
}
