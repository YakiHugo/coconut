import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {createHash} from 'node:crypto';
const built=await build({entryPoints:['frontend/app/video-audio.ts'],bundle:true,format:'esm',write:false,platform:'node'});
const {videoAudioFallback,downloadVideoAudio}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
const url='https://www.bilibili.com/video/BV1xx411c7mD',fallback={endpoint:'/api/videos/media',url,language:null};
test('public media descriptor cannot authorize arbitrary URLs or routes',()=>{
 assert.deepEqual(videoAudioFallback(fallback),fallback);
 for(const value of [{...fallback,endpoint:'https://evil.example'},{...fallback,url:'http://127.0.0.1/private'},{...fallback,url:url+'?p=2'},{...fallback,language:'invalid text'}])assert.equal(videoAudioFallback(value),null);
});
test('downloaded public audio retains source evidence and truthful file identity',async t=>{
 const body=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypM4A authored fixture')]),sha256=createHash('sha256').update(body).digest('hex');
 const metadata={url,provider:'bilibili',id:'BV1xx411c7mD',title:'A/B 原始标题',duration:4,subtitle_check:'no_matching_captions',audio_language:null,audio_language_basis:'provider_single_source',audio_role:'unknown',format:'m4a',format_id:'30216',kind:'audio',type:'audio/mp4',sha256};
 let calls=0;const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);
 globalThis.fetch=async(route,init)=>{calls++;assert.equal(route,'api/videos/media');assert.equal(JSON.parse(init.body).consent,true);return new Response(body,{headers:{'Content-Type':'audio/mp4','X-Coconut-Media-Source':Buffer.from(JSON.stringify(metadata)).toString('base64url')}});};
 const result=await downloadVideoAudio(fallback,new AbortController().signal);
 assert.equal(calls,1);assert.equal(result.file.name,'coconut-A_B 原始标题.m4a');assert.equal(result.project.title,metadata.title);assert.equal(result.project.source_url,url);assert.equal(result.project.project_kind,'audio_only');assert.equal(result.project.media_provenance.sha256,sha256);assert.equal(result.project.local_media_source.fingerprint,result.inspected.source.fingerprint);
 metadata.id='different';await assert.rejects(downloadVideoAudio(fallback,new AbortController().signal),/不一致/);
});

test('combined MP4 receipt creates a truthful video File and unknown-language provenance',async t=>{
 const source='https://www.youtube.com/watch?v=abcdefghijk',body=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom authored fixture')]),sha256=createHash('sha256').update(body).digest('hex');
 const metadata={url:source,provider:'youtube',id:'abcdefghijk',title:'Authored video',duration:2,subtitle_check:'no_matching_captions',audio_language:null,audio_language_basis:'platform_video_stream',audio_role:'unknown',format:'mp4',format_id:'18',kind:'video',type:'video/mp4',sha256};
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);
 globalThis.fetch=async()=>new Response(body,{headers:{'Content-Type':'video/mp4','X-Coconut-Media-Source':Buffer.from(JSON.stringify(metadata)).toString('base64url')}});
 const result=await downloadVideoAudio({endpoint:'/api/videos/media',url:source,language:null},new AbortController().signal);
 assert.equal(result.file.type,'video/mp4');assert.equal(result.file.name,'coconut-Authored video.mp4');assert.equal(result.inspected.kind,'video');assert.equal(result.project.local_media_source.kind,'video');assert.equal(result.project.media_provenance.audio_role,'unknown');assert.equal(result.project.media_provenance.audio_language,null);
 metadata.kind='audio';await assert.rejects(downloadVideoAudio({endpoint:'/api/videos/media',url:source,language:null},new AbortController().signal),/不一致/);
});
