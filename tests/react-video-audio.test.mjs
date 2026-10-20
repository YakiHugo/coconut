import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {createHash} from 'node:crypto';
const built=await build({entryPoints:['frontend/app/video-audio.ts'],bundle:true,format:'esm',write:false,platform:'node'});
const {videoAudioFallback,downloadVideoAudio}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
const url='https://www.bilibili.com/video/BV1xx411c7mD',fallback={endpoint:'/api/videos/audio',url,language:null};
test('public media descriptor cannot authorize arbitrary URLs or routes',()=>{
 assert.deepEqual(videoAudioFallback(fallback),fallback);
 for(const value of [{...fallback,endpoint:'https://evil.example'},{...fallback,url:'http://127.0.0.1/private'},{...fallback,url:url+'?p=2'},{...fallback,language:'invalid text'}])assert.equal(videoAudioFallback(value),null);
});
test('downloaded public audio retains source evidence and truthful file identity',async t=>{
 const body=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypM4A authored fixture')]),sha256=createHash('sha256').update(body).digest('hex');
 const metadata={url,provider:'bilibili',id:'BV1xx411c7mD',title:'A/B 原始标题',duration:4,subtitle_check:'no_matching_captions',sha256};
 let calls=0;const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);
 globalThis.fetch=async(route,init)=>{calls++;assert.equal(route,'api/videos/audio');assert.equal(JSON.parse(init.body).consent,true);return new Response(body,{headers:{'Content-Type':'audio/mp4','X-Coconut-Media-Source':Buffer.from(JSON.stringify(metadata)).toString('base64url')}});};
 const result=await downloadVideoAudio(fallback,new AbortController().signal);
 assert.equal(calls,1);assert.equal(result.file.name,'coconut-A_B 原始标题.m4a');assert.equal(result.project.title,metadata.title);assert.equal(result.project.source_url,url);assert.equal(result.project.project_kind,'audio_only');assert.equal(result.project.media_provenance.sha256,sha256);assert.equal(result.project.local_media_source.fingerprint,result.inspected.source.fingerprint);
 metadata.id='different';await assert.rejects(downloadVideoAudio(fallback,new AbortController().signal),/不一致/);
});
