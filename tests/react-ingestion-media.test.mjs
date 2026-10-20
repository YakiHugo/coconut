import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),core=require('../reader/core.js'),canonical=require('../reader/canonical-library.js');
const output=await build({stdin:{contents:"export * from './frontend/app/ingestion-media'; export * from './frontend/app/ingestion-jobs'; export * from './frontend/app/ingestion-binding'; export * from './frontend/app/attach-transcript'; export {inspectFile} from './frontend/app/ingestion';",resolveDir:process.cwd()},bundle:true,format:'esm',write:false,platform:'node'});
const {downloadedMediaFile,transcriptionFileIssue,createIngestionJobs,ingestionBinding,rememberIngestionFile,attachTranscript,inspectFile}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].contents).toString('base64'));
const make=(name='节目',contentType='audio/mpeg',kind='audio')=>downloadedMediaFile(['authored media fixture'],{name,contentType,kind});
test('downloaded filenames are deterministic, bounded and separate from the episode title',()=>{
 for(const name of ['中文节目','A/B','A\\B','A\0B\u007f','.'.repeat(4),'','长标题'.repeat(200),'😀'.repeat(200)]){
  const file=make(name),again=make(name);
  assert.equal(file.name,again.name);assert.equal(file.lastModified,0);assert.equal(file.type,'audio/mpeg');
  assert.doesNotMatch(file.name,/[\\/\u0000-\u001f\u007f]/);assert.ok(file.name.length<=300);assert.ok(Buffer.byteLength(file.name)<255);
  assert.equal(transcriptionFileIssue(file),null);
 }
});
test('response MIME, filename and executor playback MIME agree for common containers',async()=>{
 for(const [input,type,extension,kind] of [[' Audio/MPEG; charset=binary','audio/mpeg','mp3','audio'],['audio/mp3','audio/mpeg','mp3','audio'],['audio/mp4','audio/mp4','m4a','audio'],['audio/x-m4a','audio/mp4','m4a','audio'],['audio/wave','audio/wav','wav','audio'],['audio/x-wav','audio/wav','wav','audio'],['audio/ogg','audio/ogg','ogg','audio'],['audio/x-flac','audio/flac','flac','audio'],['video/mp4','video/mp4','mp4','video'],['video/webm','video/webm','webm','video']]){
  const file=make('title',input,kind);assert.ok(file.name.endsWith('.'+extension));assert.equal(file.type,type);assert.equal(transcriptionFileIssue(file),null);assert.equal((await inspectFile(file)).kind,kind);
 }
});
test('playable but unsupported ASR containers stay honestly typed and never pretend to be MP3',async()=>{
 for(const [type,extension,kind] of [['audio/aac','aac','audio'],['audio/webm','weba','audio'],['video/ogg','ogv','video'],['video/quicktime','mov','video']]){
  const file=make('episode',type,kind);assert.ok(file.name.endsWith('.'+extension));assert.equal(file.type,type);assert.match(transcriptionFileIssue(file),/不支持/);assert.equal((await inspectFile(file)).kind,kind);
 }
 for(const [type,kind] of [['text/html','audio'],['application/octet-stream','audio'],['video/mp4','audio'],['audio/mpeg','video']])assert.throws(()=>make('episode',type,kind),/响应类型/);
 assert.match(transcriptionFileIssue(new File(['fixture'],'wrong.mp3',{type:'audio/wav'})),/不一致/);
});
test('invalid filenames and types are rejected before persisting an unknown upload operation',async()=>{
 for(const file of [new File(['fixture'],'A/B.mp3',{type:'audio/mpeg'}),new File(['fixture'],'a'.repeat(301)+'.mp3',{type:'audio/mpeg'}),make('AAC','audio/aac'),new File(['fixture'],'wrong.mp3',{type:'audio/wav'})]){
  let saved=null,uploads=0;const controller=createIngestionJobs({request:async(path)=>{if(path.includes('capabilities'))return {protocolVersion:1,transcription:{available:true,model_download:false}};uploads++;throw Error('must not submit');},binding:()=>({key:'one',fingerprint:'a'.repeat(64),revision:0}),accept:async()=>true,journal:{read:()=>saved,write:value=>{saved=value;}},uuid:()=> '12345678-1234-4234-8234-123456789012'});
  await controller.commands.capabilities();await controller.commands.upload('one',file);
  assert.equal(uploads,0);assert.equal(saved,null);assert.equal(controller.getSnapshot().entries.length,0);assert.ok(controller.getSnapshot().message);controller.dispose();
 }
});
test('downloaded podcast media can submit and attach into the original source project, including reload',async()=>{
 const source={feed_url:'https://www.xiaoyuzhoufm.com/episode/65e7c944d602439838b530aa',episode_id:'b'.repeat(64),media_url:'https://cdn.publisher.example/sample.wav',media_kind:'audio'};
 let doc={key:'episode',...core.validate({project_kind:'audio_only',title:'A/B 原始标题',source_url:source.feed_url,podcast_source:source,project_note:'保留笔记',timestamp_bookmarks:[{id:'mark',time:1,note:'保留书签'}],segments:[]})},revision=0,file=make(doc.title,'audio/wave'),saved=null,uploads=0;
 const inspected=await inspectFile(file);rememberIngestionFile(file,inspected.source.fingerprint);
 const store={getDocument:()=>doc,getFile:()=>file,getRevision:()=>revision},operation='12345678-1234-4234-8234-123456789012',id='c'.repeat(32);
 const job={id,state:'ready',persistent:true,source:{kind:'file',name:file.name,operation_id:operation,fingerprint:inspected.source.fingerprint,size:file.size,last_modified:0,language:''},media:{url:'/api/v1/ingestions/jobs/'+id+'/media',kind:'audio',name:file.name}};
 const transcript={schema_version:1,title:'Executor title',source_url:'',language:'zh',segments:[{id:'cue-1',start:0,end:2,text:'自写测试句子。'}],provenance:{kind:'local_asr',caption_method:'asr',backend:'faster-whisper',model:'small',review_status:'unreviewed'}};
 const deps={request:async(path,init)=>{if(path.includes('capabilities'))return {protocolVersion:1,transcription:{available:true,model_download:false}};if(path.startsWith('api/v1/ingestions/upload?')){uploads++;assert.equal(init.body,file);}return {protocolVersion:1,ingestion:{...job,...(path.endsWith('/result')?{transcript:{document:transcript}}:{})}};},binding:(key,expected)=>ingestionBinding(store,key,expected),accept:async(value,binding)=>{assert.equal(binding.key,doc.key);doc=attachTranscript(doc,value,core,canonical.project);revision++;return true;},journal:{read:()=>saved,write:value=>{saved=value;}},uuid:()=>operation};
 let controller=createIngestionJobs(deps);assert.equal(uploads,0);await controller.commands.capabilities();await controller.commands.upload(doc.key,file);assert.equal(uploads,1);assert.equal(controller.getSnapshot().entries[0].unknown,false);
 controller.dispose();file=null;controller=createIngestionJobs(deps);await controller.commands.accept(operation);
 assert.equal(uploads,1);assert.equal(doc.key,'episode');assert.equal(doc.title,'A/B 原始标题');assert.equal(doc.source_url,source.feed_url);assert.deepEqual(doc.podcast_source,source);assert.equal(doc.project_note,'保留笔记');assert.equal(doc.timestamp_bookmarks[0].note,'保留书签');assert.equal(doc.provenance.kind,'local_asr');assert.equal(doc.segments.length,1);assert.equal(doc.local_media_source,undefined);assert.equal(doc.source_media,undefined);controller.dispose();
});
